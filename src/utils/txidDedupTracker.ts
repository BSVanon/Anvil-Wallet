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
 * In-memory only; resets on service-worker restart. That's fine —
 * service-worker restart triggers a fresh SPV sync which resolves
 * the stale-UTXO root cause anyway.
 */

const DEFAULT_CAPACITY = 100;

export class TxidDedupTracker {
  private readonly seen = new Set<string>();
  private readonly insertionOrder: string[] = [];

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {
    if (capacity < 1) throw new Error('TxidDedupTracker capacity must be >= 1');
  }

  /**
   * Record a txid. Returns true if the txid was already present (a
   * duplicate); returns false if it's new. Trims to capacity by
   * dropping the oldest insertion.
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
    return { wasDuplicate: false };
  }

  size(): number {
    return this.seen.size;
  }

  has(txid: string): boolean {
    return this.seen.has(txid);
  }
}
