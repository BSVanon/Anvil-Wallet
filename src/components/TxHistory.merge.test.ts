/**
 * TxHistory merge-logic regression tests.
 *
 * Targets Codex review fa8341064b38959a's BLOCKING finding: the
 * blockTimes / wocReconciliation maps are written by two independent
 * effects (the height-loader and the WoC reconciliation), and reading
 * either map from closure scope to write back a copy can stomp the
 * other effect's writes — making confirmed rows regress to "Pending"
 * after reconciliation completes.
 *
 * The fix uses functional state updates (`setX(prev => merge(prev, …))`)
 * which always read the latest committed state. We extract the merge
 * helpers so this race-prone path is testable without dragging in
 * @testing-library/dom (the wallet repo opts out of DOM-rendering
 * tests; the merge bug is fundamentally about Map mutation, not
 * about React).
 */

import {
  buildLogFromRecentBroadcast,
  mergeIntoReconciliation,
  mergeReconciliationIntoBlockTimes,
  mergeUniqueByTxid,
  sortActivityLogs,
} from './TxHistory.merge';

describe('mergeReconciliationIntoBlockTimes', () => {
  it('preserves height-loader entries when reconciliation lands later', () => {
    // Scenario from the review: height-loader resolved first and
    // populated [800100 → time1]. Reconciliation now finishes and
    // adds a different height [945980 → time2]. The merge MUST keep
    // both — without functional updates the buggy code copied a stale
    // (empty) snapshot of blockTimes and wiped the 800100 entry.
    const prev = new Map<number, number>([[800100, 1700000000]]);
    const additions: Array<[string, { height: number; time?: number }]> = [
      ['b'.repeat(64), { height: 945980, time: 1776904577 }],
    ];
    const merged = mergeReconciliationIntoBlockTimes(prev, additions);
    expect(merged.get(800100)).toBe(1700000000);
    expect(merged.get(945980)).toBe(1776904577);
  });

  it('does NOT overwrite an existing entry with a reconciliation time for the same height', () => {
    // Edge case: reconciliation reports the same height that the
    // height-loader already populated. Keeping the existing entry is
    // safer (height-loader hits WoC's full /block/height payload;
    // reconciliation hits /tx/hash which sometimes omits blocktime).
    const prev = new Map<number, number>([[800100, 1700000000]]);
    const additions: Array<[string, { height: number; time?: number }]> = [
      ['b'.repeat(64), { height: 800100, time: 9999999999 }],
    ];
    const merged = mergeReconciliationIntoBlockTimes(prev, additions);
    expect(merged.get(800100)).toBe(1700000000);
  });

  it('skips additions whose time is undefined (preserves height-loader path)', () => {
    // WoC's /tx/hash sometimes returns confirmed=true with
    // blocktime missing. We pin the reconciliation entry by txid in
    // the wocReconciliation map (so the row knows its real height),
    // but blockTimes must stay clean of `undefined` because
    // formatBlockTime treats undefined as Pending — we want the
    // height-loader's later resolution to win.
    const prev = new Map<number, number>();
    const additions: Array<[string, { height: number; time?: number }]> = [
      ['b'.repeat(64), { height: 945980, time: undefined }],
    ];
    const merged = mergeReconciliationIntoBlockTimes(prev, additions);
    expect(merged.has(945980)).toBe(false);
  });

  it('returns a new Map instance even when there are no additions', () => {
    // Important for React's referential-equality re-render gating —
    // returning the same map reference on a no-op merge would make
    // the component skip the re-render even when other state updates
    // expected one.
    const prev = new Map<number, number>([[800100, 1700000000]]);
    const merged = mergeReconciliationIntoBlockTimes(prev, []);
    expect(merged).not.toBe(prev);
    expect(Array.from(merged.entries())).toEqual([[800100, 1700000000]]);
  });

  it('merges multiple reconciliation entries in order without clobbering each other', () => {
    const prev = new Map<number, number>([[800100, 1700000000]]);
    const additions: Array<[string, { height: number; time?: number }]> = [
      ['a'.repeat(64), { height: 945980, time: 1776904577 }],
      ['b'.repeat(64), { height: 945981, time: 1776904600 }],
      ['c'.repeat(64), { height: 945982, time: 1776904700 }],
    ];
    const merged = mergeReconciliationIntoBlockTimes(prev, additions);
    expect(merged.size).toBe(4);
    expect(merged.get(800100)).toBe(1700000000);
    expect(merged.get(945980)).toBe(1776904577);
    expect(merged.get(945981)).toBe(1776904600);
    expect(merged.get(945982)).toBe(1776904700);
  });
});

describe('mergeIntoReconciliation', () => {
  it('adds a new txid → height/time entry without disturbing existing ones', () => {
    const prev = new Map<string, { height: number; time?: number }>([
      ['a'.repeat(64), { height: 800100, time: 1700000000 }],
    ]);
    const additions: Array<[string, { height: number; time?: number }]> = [
      ['b'.repeat(64), { height: 945980, time: 1776904577 }],
    ];
    const merged = mergeIntoReconciliation(prev, additions);
    expect(merged.size).toBe(2);
    expect(merged.get('a'.repeat(64))).toEqual({ height: 800100, time: 1700000000 });
    expect(merged.get('b'.repeat(64))).toEqual({ height: 945980, time: 1776904577 });
  });

  it('replaces an existing txid entry when a fresher status comes in', () => {
    // Different from blockTimes: reconciliation MAY refresh — e.g. a
    // re-mine after a chain reorg gives a new blockheight. Same-txid
    // additions are intended to overwrite.
    const prev = new Map<string, { height: number; time?: number }>([
      ['a'.repeat(64), { height: 800100, time: 1700000000 }],
    ]);
    const additions: Array<[string, { height: number; time?: number }]> = [
      ['a'.repeat(64), { height: 800200, time: 1700000500 }],
    ];
    const merged = mergeIntoReconciliation(prev, additions);
    expect(merged.size).toBe(1);
    expect(merged.get('a'.repeat(64))).toEqual({ height: 800200, time: 1700000500 });
  });

  it('returns a new Map instance even when there are no additions', () => {
    const prev = new Map<string, { height: number; time?: number }>([
      ['a'.repeat(64), { height: 800100, time: 1700000000 }],
    ]);
    const merged = mergeIntoReconciliation(prev, []);
    expect(merged).not.toBe(prev);
    expect(merged.size).toBe(1);
  });
});

describe('buildLogFromRecentBroadcast (P2.2)', () => {
  it('produces a Pending TxLog with negative-amount fund summary', () => {
    const log = buildLogFromRecentBroadcast({
      txid: 'a'.repeat(64),
      broadcastAt: 1_700_000_000_000,
      sats: -100_000,
    });
    expect(log.txid).toBe('a'.repeat(64));
    expect(log.height).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((log.summary as any)?.fund?.amount).toBe(-100_000);
  });
});

describe('mergeUniqueByTxid (P2.2)', () => {
  function row(txid: string, height: number) {
    return {
      txid,
      height,
      idx: 0,
      summary: { fund: { amount: 1 } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('appends recent-broadcast entries that are not yet in the primary list', () => {
    const primary = [row('a'.repeat(64), 800_100)];
    const recents = [row('b'.repeat(64), 0)];
    const merged = mergeUniqueByTxid(primary, recents);
    expect(merged).toHaveLength(2);
    expect(merged[0].txid).toBe('a'.repeat(64));
    expect(merged[1].txid).toBe('b'.repeat(64));
  });

  it('higher-height row wins for duplicate txids (Phase 2.5 — confirmed sticks)', () => {
    // spv-store has the row with real height; recent-broadcast has it
    // with height 0. Merging must NOT regress the entry to height 0.
    const primary = [row('a'.repeat(64), 800_100)];
    const recents = [row('a'.repeat(64), 0)];
    const merged = mergeUniqueByTxid(primary, recents);
    expect(merged).toHaveLength(1);
    expect(merged[0].height).toBe(800_100);
  });

  it('REVERSE direction also keeps higher height: cache=confirmed + refresh=Pending → confirmed wins', () => {
    // Phase 2.5 regression test (Robert click-test 2026-04-25): a
    // popup mounted from cache had confirmed rows. The fresh refresh
    // tier-1 spv-store call returned the same txid with height=0
    // because spv-store sync was incomplete. Old "primary wins"
    // logic let the height=0 row stomp the cached confirmed view,
    // flipping the user's Activity tab back to Pending. The
    // height-aware merge keeps the higher height regardless of
    // primary/additions ordering.
    const cached = [row('a'.repeat(64), 800_100)];
    const refreshLogs = [row('a'.repeat(64), 0)];
    // Real call site uses refresh as primary, cache as additions.
    // Height-aware merge keeps the confirmed row.
    const merged = mergeUniqueByTxid(refreshLogs, cached);
    expect(merged).toHaveLength(1);
    expect(merged[0].height).toBe(800_100);
  });

  it('returns primary unchanged when there are no additions', () => {
    const primary = [row('a'.repeat(64), 800_100)];
    const merged = mergeUniqueByTxid(primary, []);
    expect(merged).toBe(primary); // referential equality is fine for empty additions
  });

  it('handles fully-disjoint sets', () => {
    const primary = [row('a'.repeat(64), 800_100), row('b'.repeat(64), 800_101)];
    const recents = [row('c'.repeat(64), 0), row('d'.repeat(64), 0)];
    const merged = mergeUniqueByTxid(primary, recents);
    expect(merged).toHaveLength(4);
    expect(merged.map((r) => r.txid)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
    ]);
  });
});

describe('sortActivityLogs (Phase 2.5 hotfix #7)', () => {
  function row(txid: string, height: number, idx = 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { txid, height, idx, summary: { fund: { amount: 1 } } } as any;
  }

  it('Pending (height=0) sorts above confirmed', () => {
    const sorted = sortActivityLogs([row('a'.repeat(64), 800_100), row('b'.repeat(64), 0)]);
    expect(sorted[0].txid).toBe('b'.repeat(64));
    expect(sorted[1].txid).toBe('a'.repeat(64));
  });

  it('within confirmed: higher height first', () => {
    const sorted = sortActivityLogs([row('a'.repeat(64), 800_100), row('b'.repeat(64), 800_200)]);
    expect(sorted[0].height).toBe(800_200);
    expect(sorted[1].height).toBe(800_100);
  });

  it('tie on height: higher idx first', () => {
    const sorted = sortActivityLogs([row('a'.repeat(64), 800_100, 5), row('b'.repeat(64), 800_100, 7)]);
    expect(sorted[0].idx).toBe(7);
    expect(sorted[1].idx).toBe(5);
  });

  it('tie on idx: lex txid (deterministic across mounts)', () => {
    // Robert click-test 2026-04-25: order shuffled between popup
    // opens because two equal-height/equal-idx rows could swap
    // depending on JS engine sort stability. Lex tie-breaker pins
    // ordering.
    const a = row('aa'.repeat(32), 0, 0);
    const b = row('bb'.repeat(32), 0, 0);
    const c = row('cc'.repeat(32), 0, 0);
    expect(sortActivityLogs([c, a, b]).map((r) => r.txid)).toEqual([
      'aa'.repeat(32),
      'bb'.repeat(32),
      'cc'.repeat(32),
    ]);
    expect(sortActivityLogs([b, c, a]).map((r) => r.txid)).toEqual([
      'aa'.repeat(32),
      'bb'.repeat(32),
      'cc'.repeat(32),
    ]);
  });

  it('returns a new array (does not mutate input)', () => {
    const input = [row('a'.repeat(64), 0), row('b'.repeat(64), 800_100)];
    const sorted = sortActivityLogs(input);
    expect(sorted).not.toBe(input);
    expect(input[0].txid).toBe('a'.repeat(64));
  });
});

describe('functional-update simulation: blockTimes survives reconciliation race', () => {
  it('reconciliation arriving AFTER height-loader does not overwrite height-loader entries', () => {
    // Step 1: initial state — both empty.
    let blockTimes: Map<number, number> = new Map();

    // Step 2: height-loader effect resolves first, commits its entry.
    blockTimes = new Map(blockTimes);
    blockTimes.set(800100, 1700000000);

    // Step 3: reconciliation effect resolves and uses the FUNCTIONAL
    // updater pattern (reads `prev` from React's latest state, not
    // closure scope).
    const additions: Array<[string, { height: number; time?: number }]> = [
      ['b'.repeat(64), { height: 945980, time: 1776904577 }],
    ];
    blockTimes = mergeReconciliationIntoBlockTimes(blockTimes, additions);

    // Final invariant: BOTH heights present.
    expect(blockTimes.get(800100)).toBe(1700000000);
    expect(blockTimes.get(945980)).toBe(1776904577);
  });

  it('reconciliation arriving BEFORE height-loader does not overwrite reconciliation entries', () => {
    // Symmetric case — closure-snapshot reads on either effect would
    // be wrong. Both writers now use functional updates: reconciliation
    // via mergeReconciliationIntoBlockTimes, and the height-loader via
    // a `setBlockTimes(prev => ...merge...)` form that mirrors what
    // we're simulating below.
    let blockTimes: Map<number, number> = new Map();

    // Step 1: reconciliation commits.
    const additions: Array<[string, { height: number; time?: number }]> = [
      ['b'.repeat(64), { height: 945980, time: 1776904577 }],
    ];
    blockTimes = mergeReconciliationIntoBlockTimes(blockTimes, additions);

    // Step 2: height-loader commits AFTER, via the same merge-into-prev
    // pattern (in TxHistory.tsx the effect does:
    //   setBlockTimes(prev => { const next = new Map(prev); for (...) next.set(h,t); return next; })
    // — we simulate that here).
    const fetched = new Map<number, number>([[800100, 1700000000]]);
    {
      const next = new Map(blockTimes);
      for (const [h, t] of fetched) next.set(h, t);
      blockTimes = next;
    }

    expect(blockTimes.get(800100)).toBe(1700000000);
    expect(blockTimes.get(945980)).toBe(1776904577);
  });
});
