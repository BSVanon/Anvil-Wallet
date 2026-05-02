/**
 * Bounded LRU-ish set for deduping recently-seen txids.
 *
 * Used by the BRC-73 background-side auto-resolve to avoid double-
 * counting the spending budget when the wallet's UTXO selector
 * rebuilds the same tx (stale spv-store state → same inputs → same
 * signed bytes → same txid). `broadcastMultiSource` treats "already
 * on network" as a successful broadcast, so without dedup the budget
 * tracker would over-count idempotent rebroadcasts.
 *
 * **Persistence (2026-05-02 — LAUNCH_RUNBOOK B1 fix):** the tracker
 * supports an optional `persist` callback fired (fire-and-forget)
 * after every successful `track()` of a NEW txid. Combined with an
 * optional `initialTxids` seed at construction time, this lets the
 * caller round-trip the dedup state through chrome.storage.local
 * across service-worker restarts. Without persistence, an SW
 * eviction within seconds of a sendBsv broadcast would let an
 * idempotent rebroadcast (same inputs → same signed bytes → same
 * txid) double-count against the rolling-window spending budget.
 * `loadDedupTrackerState` below is the canonical async helper for
 * the chrome.storage.local read path; pure callers (tests + the
 * existing positional-capacity constructor signature) get the
 * legacy in-memory-only behavior unchanged.
 */

export const DEFAULT_CAPACITY = 100;

/**
 * Fire-and-forget callback to persist the current insertion order.
 * Implementations typically schedule a chrome.storage.local.set;
 * called after every `track()` that records a NEW txid. Errors are
 * the implementation's concern (log + drop) — track() is sync.
 */
export type DedupPersistFn = (txids: ReadonlyArray<string>) => void;

export class TxidDedupTracker {
  private readonly seen = new Set<string>();
  private readonly insertionOrder: string[] = [];
  private readonly capacity: number;
  private readonly persist: DedupPersistFn | undefined;

  /**
   * Construct with positional capacity for backward compatibility
   * (existing tests + callers that don't need persistence). To enable
   * persistence + initial-state seeding, pass an options object.
   */
  constructor(
    capacityOrOpts:
      | number
      | {
          capacity?: number;
          initialTxids?: ReadonlyArray<string>;
          persist?: DedupPersistFn;
        } = DEFAULT_CAPACITY,
  ) {
    const opts =
      typeof capacityOrOpts === 'number' ? { capacity: capacityOrOpts } : capacityOrOpts;
    const capacity = opts.capacity ?? DEFAULT_CAPACITY;
    if (capacity < 1) throw new Error('TxidDedupTracker capacity must be >= 1');
    this.capacity = capacity;
    this.persist = opts.persist;

    // Honor capacity on load — silently trim from the front if storage
    // had more entries than the configured capacity. Order preserved
    // (chronological, oldest-first per insertionOrder semantics).
    const initial = opts.initialTxids ?? [];
    const trimmed = initial.length > capacity ? initial.slice(initial.length - capacity) : initial;
    for (const txid of trimmed) {
      if (typeof txid !== 'string' || txid.length === 0) continue;
      if (this.seen.has(txid)) continue; // dedupe within the loaded snapshot
      this.seen.add(txid);
      this.insertionOrder.push(txid);
    }
  }

  /**
   * Atomically merge a persisted snapshot UNDER any post-construction
   * tracks. Use this instead of replaying the snapshot through
   * `track()` after the tracker is already in use — replay-via-track
   * would treat each seed entry as the NEWEST insertion, pushing
   * fresh post-construction tracks past the capacity boundary and
   * evicting them out of the insertion order. The retry of an
   * evicted-fresh tx would then look unseen and double-count the
   * budget — the exact race scenario B1 was meant to close.
   *
   * Codex review `2d78f6a85bb7d33c` (2026-05-02) caught the original
   * track-replay implementation; this method is the atomic-merge
   * fix. Ordering preserved as
   *   insertionOrder = [seed_chronological..., post_construction_tracks...]
   * with capacity enforced by dropping the OLDEST entries first
   * (i.e. seed entries get dropped before post-construction tracks
   * when capacity-bound, matching the dedup tracker's "fresh activity
   * matters more than stale" semantics).
   *
   * Does NOT call `persist`; the caller is loading state, not adding
   * new spend records. The next `track()` of a NEW txid will persist
   * a fresh snapshot reflecting the merged state.
   */
  mergeSeed(seed: ReadonlyArray<string>): void {
    // 1) Sanitize: drop non-strings, empty strings, and entries
    //    already present from post-construction tracks. Dedupe within
    //    the seed itself.
    const seedSeen = new Set<string>();
    const cleanSeed: string[] = [];
    for (const txid of seed) {
      if (typeof txid !== 'string' || txid.length === 0) continue;
      if (this.seen.has(txid)) continue; // post-construction track wins
      if (seedSeen.has(txid)) continue;
      seedSeen.add(txid);
      cleanSeed.push(txid);
    }

    // 2) Compose: seed (oldest) followed by existing post-construction
    //    tracks (newer). Trim to capacity from the FRONT so the newest
    //    entries — i.e. the ones a retry might rebroadcast — survive.
    const merged = [...cleanSeed, ...this.insertionOrder];
    const trimmed =
      merged.length > this.capacity ? merged.slice(merged.length - this.capacity) : merged;

    // 3) Rebuild internal state from the trimmed merged list.
    this.seen.clear();
    this.insertionOrder.length = 0;
    for (const txid of trimmed) {
      this.seen.add(txid);
      this.insertionOrder.push(txid);
    }
  }

  /**
   * Record a txid. Returns true if the txid was already present (a
   * duplicate); returns false if it's new. Trims to capacity by
   * dropping the oldest insertion. Fires the persist callback only
   * when a NEW txid is recorded (no-ops on duplicate).
   */
  track(txid: string): { wasDuplicate: boolean } {
    if (this.seen.has(txid)) {
      return { wasDuplicate: true };
    }
    this.seen.add(txid);
    this.insertionOrder.push(txid);
    if (this.insertionOrder.length > this.capacity) {
      const oldest = this.insertionOrder.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    if (this.persist) {
      // Snapshot the array — callers shouldn't see post-track mutations.
      try {
        this.persist([...this.insertionOrder]);
      } catch (err) {
        // Persist failures are advisory only; the in-memory state is
        // still authoritative for this SW lifetime.
        console.warn('[TxidDedupTracker] persist failed:', err);
      }
    }
    return { wasDuplicate: false };
  }

  size(): number {
    return this.seen.size;
  }

  has(txid: string): boolean {
    return this.seen.has(txid);
  }
}

/**
 * Async helper: load a previously-persisted txid list from a chrome
 * storage area. Tolerates missing keys + malformed values + entries
 * that exceed the requested capacity (oldest entries trimmed).
 *
 * Returns an empty array on any failure — the wallet still works
 * correctly without the prior state, just with a tiny window where
 * an idempotent rebroadcast within ~seconds of an SW restart could
 * double-count the budget. Capacity-trimmed values match
 * TxidDedupTracker's internal trim behavior.
 *
 * Pulled into its own helper so unit tests can mock the storage area
 * without depending on the chrome.* globals.
 */
export interface DedupStorageReader {
  get(key: string): Promise<unknown>;
}

export async function loadDedupTrackerState(
  storage: DedupStorageReader,
  storageKey: string,
  capacity: number = DEFAULT_CAPACITY,
): Promise<string[]> {
  try {
    const raw = await storage.get(storageKey);
    if (!Array.isArray(raw)) return [];
    const filtered = raw.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
    if (filtered.length <= capacity) return filtered;
    return filtered.slice(filtered.length - capacity);
  } catch (err) {
    console.warn('[TxidDedupTracker] loadDedupTrackerState failed:', err);
    return [];
  }
}
