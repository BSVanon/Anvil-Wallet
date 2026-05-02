/**
 * TxidDedupTracker tests.
 *
 * Covers the dedup semantics that prevent double-counting budget on
 * idempotent rebroadcasts in the BRC-73 background flow. If this
 * regresses, the wallet would over-charge the user's spending
 * authorization for txs the network has already accepted.
 */

import { TxidDedupTracker } from './txidDedupTracker';

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
