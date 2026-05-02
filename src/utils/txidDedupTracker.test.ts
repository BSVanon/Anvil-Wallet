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
