/**
 * TxidDedupTracker tests.
 *
 * Covers the dedup semantics that prevent double-counting budget on
 * idempotent rebroadcasts in the BRC-73 background flow. If this
 * regresses, the wallet would over-charge the user's spending
 * authorization for txs the network has already accepted.
 *
 * Also covers the 2026-05-02 LAUNCH_RUNBOOK B1 persistence wiring:
 * `initialTxids` seed + `persist` callback round-trip enabling
 * cross-SW-restart dedup, plus the `loadDedupTrackerState` helper.
 */

import {
  TxidDedupTracker,
  DEFAULT_CAPACITY,
  loadDedupTrackerState,
  type DedupStorageReader,
} from './txidDedupTracker';

describe('TxidDedupTracker', () => {
  it('returns wasDuplicate=false for a fresh txid', () => {
    const t = new TxidDedupTracker();
    expect(t.track('abc').wasDuplicate).toBe(false);
    expect(t.size()).toBe(1);
  });

  it('returns wasDuplicate=true for a repeated txid', () => {
    const t = new TxidDedupTracker();
    t.track('abc');
    expect(t.track('abc').wasDuplicate).toBe(true);
    // Size unchanged on duplicate — no double-add.
    expect(t.size()).toBe(1);
  });

  it('treats different txids as distinct', () => {
    const t = new TxidDedupTracker();
    expect(t.track('abc').wasDuplicate).toBe(false);
    expect(t.track('def').wasDuplicate).toBe(false);
    expect(t.size()).toBe(2);
  });

  it('caps at capacity by evicting oldest insertion', () => {
    const t = new TxidDedupTracker(3);
    t.track('a');
    t.track('b');
    t.track('c');
    t.track('d'); // 'a' should be evicted
    expect(t.size()).toBe(3);
    expect(t.has('a')).toBe(false);
    expect(t.has('b')).toBe(true);
    expect(t.has('c')).toBe(true);
    expect(t.has('d')).toBe(true);
  });

  it('after eviction, the evicted txid is treated as fresh again', () => {
    const t = new TxidDedupTracker(2);
    t.track('a');
    t.track('b');
    t.track('c'); // evicts 'a'
    // 'a' is gone, so re-tracking it is "fresh" again. Acceptable
    // trade-off — capacity bounds memory; long-running daemons that
    // exceed capacity will see at most one over-count per evicted
    // txid that gets idempotently rebroadcast.
    expect(t.track('a').wasDuplicate).toBe(false);
  });

  it('rejects capacity < 1', () => {
    expect(() => new TxidDedupTracker(0)).toThrow();
    expect(() => new TxidDedupTracker(-1)).toThrow();
  });

  it('default capacity is 100', () => {
    const t = new TxidDedupTracker();
    for (let i = 0; i < 100; i++) t.track(`tx-${i}`);
    expect(t.size()).toBe(100);
    t.track('tx-101'); // evicts tx-0
    expect(t.size()).toBe(100);
    expect(t.has('tx-0')).toBe(false);
    expect(t.has('tx-101')).toBe(true);
  });
});

describe('TxidDedupTracker — persistence (LAUNCH_RUNBOOK B1)', () => {
  it('seeds in-memory state from initialTxids', () => {
    const t = new TxidDedupTracker({ capacity: 5, initialTxids: ['a', 'b', 'c'] });
    expect(t.size()).toBe(3);
    expect(t.has('a')).toBe(true);
    expect(t.has('b')).toBe(true);
    expect(t.has('c')).toBe(true);
    // Subsequent track on a seeded txid is a duplicate.
    expect(t.track('b').wasDuplicate).toBe(true);
  });

  it('trims initialTxids to capacity, keeping the most-recent entries', () => {
    // Storage had 6 entries but tracker capacity is 3. Oldest 3 dropped.
    const t = new TxidDedupTracker({
      capacity: 3,
      initialTxids: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(t.size()).toBe(3);
    expect(t.has('a')).toBe(false);
    expect(t.has('b')).toBe(false);
    expect(t.has('c')).toBe(false);
    expect(t.has('d')).toBe(true);
    expect(t.has('e')).toBe(true);
    expect(t.has('f')).toBe(true);
  });

  it('skips invalid entries in initialTxids (non-strings, empty strings, dupes)', () => {
    const t = new TxidDedupTracker({
      capacity: 5,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      initialTxids: ['a', '', 'b', 'a', null as any, 'c', undefined as any],
    });
    expect(t.size()).toBe(3);
    expect(t.has('a')).toBe(true);
    expect(t.has('b')).toBe(true);
    expect(t.has('c')).toBe(true);
  });

  it('fires persist callback only when a NEW txid is recorded', () => {
    const persisted: string[][] = [];
    const t = new TxidDedupTracker({
      capacity: 3,
      persist: (txids) => persisted.push([...txids]),
    });
    t.track('a');
    t.track('b');
    expect(persisted).toEqual([['a'], ['a', 'b']]);

    // Duplicate — must NOT trigger persist.
    t.track('a');
    expect(persisted).toEqual([['a'], ['a', 'b']]);
  });

  it('persist callback reflects the post-eviction state', () => {
    const persisted: string[][] = [];
    const t = new TxidDedupTracker({
      capacity: 2,
      persist: (txids) => persisted.push([...txids]),
    });
    t.track('a');
    t.track('b');
    t.track('c'); // evicts 'a'
    // Last persist call is the post-eviction snapshot.
    expect(persisted[persisted.length - 1]).toEqual(['b', 'c']);
  });

  it('persist callback failure does NOT throw out of track()', () => {
    const t = new TxidDedupTracker({
      capacity: 3,
      persist: () => {
        throw new Error('boom');
      },
    });
    // track must not propagate the persist failure — in-memory state
    // is authoritative for this SW lifetime.
    expect(() => t.track('a')).not.toThrow();
    expect(t.has('a')).toBe(true);
  });

  it('positional capacity argument still works (backward-compat with existing tests)', () => {
    const t = new TxidDedupTracker(5);
    t.track('a');
    expect(t.has('a')).toBe(true);
  });

  it('default capacity matches DEFAULT_CAPACITY constant', () => {
    expect(DEFAULT_CAPACITY).toBe(100);
    const t = new TxidDedupTracker({ capacity: DEFAULT_CAPACITY });
    for (let i = 0; i < DEFAULT_CAPACITY; i++) t.track(`tx-${i}`);
    expect(t.size()).toBe(DEFAULT_CAPACITY);
  });
});

describe('TxidDedupTracker.mergeSeed — atomic seed (Codex review 2d78f6a startup-race fix)', () => {
  it('installs seed when tracker is empty', () => {
    const t = new TxidDedupTracker({ capacity: 5 });
    t.mergeSeed(['a', 'b', 'c']);
    expect(t.size()).toBe(3);
    expect(t.has('a')).toBe(true);
    expect(t.has('b')).toBe(true);
    expect(t.has('c')).toBe(true);
  });

  it('preserves a fresh post-construction track when seed arrives later (race scenario)', () => {
    // The exact bug Codex caught: tx broadcast before async seed
    // resolves. Pre-fix, the seed replay through track() could push
    // fresh_tx out of capacity. Post-fix, mergeSeed merges the seed
    // UNDER fresh_tx, which is treated as the NEWEST insertion.
    const t = new TxidDedupTracker({ capacity: 3 });
    t.track('fresh_tx');
    expect(t.has('fresh_tx')).toBe(true);

    // Async seed resolves now, replaying 3 stale txids (== capacity).
    // Without the fix, the third seed track would evict 'fresh_tx';
    // with the fix, mergeSeed trims the OLDEST seed entry instead.
    t.mergeSeed(['old_a', 'old_b', 'old_c']);

    // fresh_tx must STILL be in the tracker so a retry is recognized
    // as a duplicate and the budget isn't double-counted.
    expect(t.has('fresh_tx')).toBe(true);
    // Capacity still respected.
    expect(t.size()).toBeLessThanOrEqual(3);
    // The OLDEST seed entry should be the one dropped (capacity 3,
    // 4 candidates: 3 seed + 1 fresh → drop oldest seed = 'old_a').
    expect(t.has('old_a')).toBe(false);
    expect(t.has('old_b')).toBe(true);
    expect(t.has('old_c')).toBe(true);
  });

  it('leaves a retry of fresh_tx as a duplicate after seed merges', () => {
    // Direct assertion on the bug's user-visible symptom.
    const persisted: string[][] = [];
    const t = new TxidDedupTracker({
      capacity: 3,
      persist: (txids) => persisted.push([...txids]),
    });
    t.track('fresh_tx'); // persist fires once
    t.mergeSeed(['stale_a', 'stale_b', 'stale_c']);
    // Retry of fresh_tx must be wasDuplicate=true.
    expect(t.track('fresh_tx').wasDuplicate).toBe(true);
    // mergeSeed itself must NOT have triggered the persist callback —
    // it's a load operation, not a new spend record.
    expect(persisted.length).toBe(1); // only the first fresh track
  });

  it('skips seed entries already present from post-construction tracks', () => {
    const t = new TxidDedupTracker({ capacity: 5 });
    t.track('shared');
    // Seed contains 'shared' too — must not be re-inserted.
    t.mergeSeed(['shared', 'old_a']);
    expect(t.size()).toBe(2);
    expect(t.has('shared')).toBe(true);
    expect(t.has('old_a')).toBe(true);
  });

  it('dedupes within the seed itself', () => {
    const t = new TxidDedupTracker({ capacity: 5 });
    t.mergeSeed(['a', 'b', 'a', 'c', 'b']);
    expect(t.size()).toBe(3);
  });

  it('filters non-strings and empty strings out of the seed', () => {
    const t = new TxidDedupTracker({ capacity: 5 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    t.mergeSeed(['a', '', null as any, 'b', undefined as any]);
    expect(t.size()).toBe(2);
    expect(t.has('a')).toBe(true);
    expect(t.has('b')).toBe(true);
  });

  it('is idempotent — calling twice with the same seed produces the same state', () => {
    const t1 = new TxidDedupTracker({ capacity: 5 });
    t1.mergeSeed(['a', 'b', 'c']);

    const t2 = new TxidDedupTracker({ capacity: 5 });
    t2.mergeSeed(['a', 'b', 'c']);
    t2.mergeSeed(['a', 'b', 'c']);

    expect(t2.size()).toBe(t1.size());
    expect(t2.has('a')).toBe(true);
    expect(t2.has('b')).toBe(true);
    expect(t2.has('c')).toBe(true);
  });

  it('survives a stale seed that is larger than capacity (drops oldest first)', () => {
    const t = new TxidDedupTracker({ capacity: 3 });
    // Storage previously held 5 entries; capacity is 3.
    t.mergeSeed(['old_a', 'old_b', 'old_c', 'old_d', 'old_e']);
    expect(t.size()).toBe(3);
    // Oldest two ('old_a', 'old_b') dropped.
    expect(t.has('old_a')).toBe(false);
    expect(t.has('old_b')).toBe(false);
    expect(t.has('old_c')).toBe(true);
    expect(t.has('old_d')).toBe(true);
    expect(t.has('old_e')).toBe(true);
  });
});

describe('loadDedupTrackerState', () => {
  const makeStorage = (data: Record<string, unknown>): DedupStorageReader => ({
    get: async (key: string) => data[key],
  });

  it('returns the stored array verbatim when within capacity', async () => {
    const out = await loadDedupTrackerState(makeStorage({ k: ['a', 'b', 'c'] }), 'k', 5);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('trims to capacity from the front when storage has more', async () => {
    const out = await loadDedupTrackerState(
      makeStorage({ k: ['a', 'b', 'c', 'd', 'e'] }),
      'k',
      3,
    );
    expect(out).toEqual(['c', 'd', 'e']);
  });

  it('returns [] when key is missing', async () => {
    const out = await loadDedupTrackerState(makeStorage({}), 'k', 5);
    expect(out).toEqual([]);
  });

  it('returns [] when stored value is not an array', async () => {
    const out = await loadDedupTrackerState(makeStorage({ k: 'not-an-array' }), 'k', 5);
    expect(out).toEqual([]);
  });

  it('filters out non-string entries (defensive against schema drift)', async () => {
    const out = await loadDedupTrackerState(
      makeStorage({ k: ['a', 1, 'b', null, 'c', undefined, ''] }),
      'k',
      5,
    );
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('returns [] on storage.get error (advisory failure)', async () => {
    const storage: DedupStorageReader = {
      get: async () => {
        throw new Error('storage offline');
      },
    };
    const out = await loadDedupTrackerState(storage, 'k', 5);
    expect(out).toEqual([]);
  });
});
