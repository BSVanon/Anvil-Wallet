/**
 * Pure merge helpers used by TxHistory's blockTimes / wocReconciliation
 * effects + Phase 2 P2.2 recent-broadcast merging. Extracted into their
 * own module so unit tests don't have to import the React component
 * (which transitively pulls in styled-components and the service-context
 * graph). The bugs these address (Codex review fa8341064b38959a's
 * concurrent-state race + the broadcast-vs-Activity invisibility gap)
 * are fundamentally about Map mutation, not React rendering — so a
 * pure surface is the right level to test.
 */

import type { TxLog } from 'spv-store';
import type { RecentBroadcast } from '../utils/recentBroadcasts';

/**
 * Merge a list of (txid, {height, time}) reconciliation results into
 * the existing blockTimes cache. Invariants:
 *   - Existing entries in `prev` are NEVER overwritten — they reflect
 *     the height-loader's confirmed times and may be richer than what
 *     reconciliation supplies for the same height.
 *   - Reconciliation entries with `time === undefined` are skipped so
 *     the height-loader's later resolution can win cleanly.
 */
export function mergeReconciliationIntoBlockTimes(
  prev: Map<number, number>,
  additions: Array<[string, { height: number; time?: number }]>,
): Map<number, number> {
  const next = new Map(prev);
  for (const [, { height, time }] of additions) {
    if (time !== undefined && !next.has(height)) {
      next.set(height, time);
    }
  }
  return next;
}

/**
 * Merge reconciliation results into the txid-keyed wocReconciliation
 * map. Same-txid additions overwrite existing entries deliberately —
 * a chain reorg could legitimately give a tx a new blockheight, and
 * we want the latest WoC view.
 */
export function mergeIntoReconciliation(
  prev: Map<string, { height: number; time?: number }>,
  additions: Array<[string, { height: number; time?: number }]>,
): Map<string, { height: number; time?: number }> {
  const next = new Map(prev);
  for (const [txid, value] of additions) next.set(txid, value);
  return next;
}

/**
 * Build a synthetic TxLog row from a RecentBroadcast cache entry, so
 * the Activity view can render the user's just-sent tx before
 * spv-store / GP catches up to chain state.
 *
 * Height stays at 0 (Pending) until the WoC reconciliation effect
 * resolves the actual block height for the txid. The amount is
 * negative because every recent-broadcast entry is from THE WALLET'S
 * perspective sending a tx (the wallet doesn't broadcast inbound).
 *
 * Phase 2 P2.2.
 */
export function buildLogFromRecentBroadcast(b: RecentBroadcast): TxLog {
  return {
    txid: b.txid,
    height: 0,
    idx: 0,
    source: 'recent-broadcast',
    summary: { fund: { amount: b.sats } },
    // TxLog has more optional fields; spv-store's TxLog type is
    // permissive enough that the unset fields are fine for display.
  } as unknown as TxLog;
}

/**
 * Merge two TxLog lists, keying by txid. For duplicate txids, prefer
 * the row with the **higher confirmed height** — this matters for the
 * Phase 2.5 cache + refresh interplay: when the popup re-mounts, the
 * cache may hold a confirmed row (height=800100) while a fresh
 * spv-store call (sync still incomplete) returns the same txid with
 * height=0. Old "primary wins" semantics let height=0 stomp the
 * confirmed view, flipping the row back to Pending. Picking the
 * higher height keeps confirmed status sticky once known.
 *
 * Tie-breaker on equal height: PRIMARY wins (preserves spv-store's
 * richer summary — token type, ordinal envelope, etc — over a
 * synthetic recent-broadcast row's bare 'fund' summary).
 *
 * Phase 2 P2.2 + Phase 2.5 height-aware fix.
 */
/**
 * Sort TxLog list newest-first with STABLE tie-breakers so the same
 * input set always renders in the same order across popup opens.
 *
 * Order rules:
 *   1. Pending (height=0) sorts above confirmed (newest-first stays
 *      consistent with what users expect: "fresh activity at top").
 *   2. Within confirmed, higher height = newer = above lower.
 *   3. Tie on height: higher idx first.
 *   4. Tie on idx: lexicographic txid (deterministic — without this,
 *      JS Array.sort is engine-dependent for equal keys, making the
 *      Activity tab visibly shuffle between identical mounts).
 *
 * Phase 2.5 hotfix #7 (Robert click-test 2026-04-25: "order shuffles
 * between popup opens").
 */
export function sortActivityLogs(logs: TxLog[]): TxLog[] {
  return logs.slice().sort((a, b) => {
    const aH = Number(a.height ?? 0);
    const bH = Number(b.height ?? 0);
    // Coalesce Pending to top via MAX_SAFE_INTEGER.
    const aRank = aH > 0 ? aH : Number.MAX_SAFE_INTEGER;
    const bRank = bH > 0 ? bH : Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return bRank - aRank;
    const aIdx = Number(a.idx ?? 0);
    const bIdx = Number(b.idx ?? 0);
    if (aIdx !== bIdx) return bIdx - aIdx;
    // Final stable tie-breaker.
    return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
  });
}

export function mergeUniqueByTxid(primary: TxLog[], additions: TxLog[]): TxLog[] {
  if (!additions.length) return primary;
  // Index primary by txid so we can in-place upgrade any row whose
  // duplicate in additions has a higher height.
  const primaryIndex = new Map<string, number>();
  for (let i = 0; i < primary.length; i++) {
    primaryIndex.set(primary[i].txid, i);
  }
  const out = primary.slice();
  for (const log of additions) {
    const i = primaryIndex.get(log.txid);
    if (i === undefined) {
      // Net-new row — append.
      out.push(log);
      continue;
    }
    // Duplicate. Keep whichever has the higher (=more confirmed) height.
    const existing = out[i];
    const exHeight = Number(existing.height ?? 0);
    const newHeight = Number(log.height ?? 0);
    if (newHeight > exHeight) {
      out[i] = log;
    }
    // else: existing wins (equal-height tie or existing is more
    // confirmed; either way, do not regress).
  }
  return out;
}
