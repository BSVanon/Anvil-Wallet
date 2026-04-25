/**
 * recentBroadcasts unit tests. Runs under react-app-rewired (jsdom),
 * so window + localStorage + CustomEvent are real DOM globals; no
 * polyfill needed. Just clear localStorage between tests.
 */

import {
  deleteRecentBroadcast,
  listRecentBroadcasts,
  recentBroadcastsKey,
  RECENT_BROADCASTS_EVENT,
  recordRecentBroadcast,
} from './recentBroadcasts';

// Namespaced cache key — same shape as production
// (selectedAccount + network).
const K = recentBroadcastsKey('1Test', 'mainnet')!;

beforeEach(() => {
  localStorage.clear();
});

const VALID_TXID = 'a'.repeat(64);

describe('recentBroadcasts', () => {
  it('round-trips a broadcast record via record + list', () => {
    recordRecentBroadcast(K, { txid: VALID_TXID, broadcastAt: 1000, sats: -500 });
    const list = listRecentBroadcasts(K);
    expect(list).toHaveLength(1);
    expect(list[0].txid).toBe(VALID_TXID);
    expect(list[0].sats).toBe(-500);
  });

  it('listRecentBroadcasts returns newest-first', () => {
    // Use recent timestamps (> 7d cutoff) so prune-on-write doesn't drop them.
    const now = Date.now();
    recordRecentBroadcast(K, { txid: 'a'.repeat(64), broadcastAt: now - 1000, sats: -1 });
    recordRecentBroadcast(K, { txid: 'b'.repeat(64), broadcastAt: now, sats: -2 });
    expect(listRecentBroadcasts(K).map((r) => r.txid)).toEqual([
      'b'.repeat(64),
      'a'.repeat(64),
    ]);
  });

  it('rejects malformed txids without storing', () => {
    recordRecentBroadcast(K, { txid: 'not-a-txid', broadcastAt: 1000, sats: 0 });
    recordRecentBroadcast(K, { txid: 'a'.repeat(63), broadcastAt: 1000, sats: 0 });
    recordRecentBroadcast(K, { txid: '', broadcastAt: 1000, sats: 0 });
    expect(listRecentBroadcasts(K)).toHaveLength(0);
  });

  it('re-recording the same txid updates the entry (idempotent retry)', () => {
    recordRecentBroadcast(K, { txid: VALID_TXID, broadcastAt: 1000, sats: -100 });
    recordRecentBroadcast(K, { txid: VALID_TXID, broadcastAt: 2000, sats: -200 });
    const list = listRecentBroadcasts(K);
    expect(list).toHaveLength(1);
    expect(list[0].broadcastAt).toBe(2000);
    expect(list[0].sats).toBe(-200);
  });

  it('deleteRecentBroadcast removes the entry', () => {
    recordRecentBroadcast(K, { txid: VALID_TXID, broadcastAt: 1000, sats: -500 });
    deleteRecentBroadcast(K, VALID_TXID);
    expect(listRecentBroadcasts(K)).toHaveLength(0);
  });

  it('emits RECENT_BROADCASTS_EVENT on save and delete', () => {
    let count = 0;
    const handler = () => count++;
    window.addEventListener(RECENT_BROADCASTS_EVENT, handler);
    try {
      recordRecentBroadcast(K, { txid: VALID_TXID, broadcastAt: 1000, sats: -500 });
      deleteRecentBroadcast(K, VALID_TXID);
      expect(count).toBe(2);
    } finally {
      window.removeEventListener(RECENT_BROADCASTS_EVENT, handler);
    }
  });

  it('prunes entries older than 7 days on next write', () => {
    const veryOld = Date.now() - 8 * 24 * 60 * 60 * 1000;
    recordRecentBroadcast(K, { txid: 'a'.repeat(64), broadcastAt: veryOld, sats: -1 });
    expect(listRecentBroadcasts(K)).toHaveLength(1);
    // Next write triggers prune-on-write.
    recordRecentBroadcast(K, { txid: 'b'.repeat(64), broadcastAt: Date.now(), sats: -2 });
    const list = listRecentBroadcasts(K);
    expect(list).toHaveLength(1);
    expect(list[0].txid).toBe('b'.repeat(64));
  });

  it('survives malformed localStorage JSON by returning empty store', () => {
    localStorage.setItem(K, 'not-json');
    expect(listRecentBroadcasts(K)).toEqual([]);
    // Re-save still works after corruption.
    recordRecentBroadcast(K, { txid: VALID_TXID, broadcastAt: 1000, sats: -1 });
    expect(listRecentBroadcasts(K)).toHaveLength(1);
  });

  it('isolates broadcasts between accounts (Codex 603d74df MEDIUM regression)', () => {
    // Send from Account A must not appear in Account B's list.
    const KA = recentBroadcastsKey('1AccountA', 'mainnet')!;
    const KB = recentBroadcastsKey('1AccountB', 'mainnet')!;
    expect(KA).not.toBe(KB);
    recordRecentBroadcast(KA, {
      txid: 'a'.repeat(64),
      broadcastAt: Date.now(),
      sats: -100,
    });
    recordRecentBroadcast(KB, {
      txid: 'b'.repeat(64),
      broadcastAt: Date.now(),
      sats: -200,
    });
    expect(listRecentBroadcasts(KA).map((r) => r.txid)).toEqual(['a'.repeat(64)]);
    expect(listRecentBroadcasts(KB).map((r) => r.txid)).toEqual(['b'.repeat(64)]);
  });

  it('isolates mainnet from testnet under the same account', () => {
    const main = recentBroadcastsKey('1SameAcct', 'mainnet')!;
    const test = recentBroadcastsKey('1SameAcct', 'testnet')!;
    expect(main).not.toBe(test);
    recordRecentBroadcast(main, {
      txid: 'a'.repeat(64),
      broadcastAt: Date.now(),
      sats: -1,
    });
    expect(listRecentBroadcasts(main)).toHaveLength(1);
    expect(listRecentBroadcasts(test)).toHaveLength(0);
  });

  it('no-ops on undefined storeKey (caller couldn\'t derive identity)', () => {
    recordRecentBroadcast(undefined, {
      txid: 'a'.repeat(64),
      broadcastAt: Date.now(),
      sats: -1,
    });
    expect(listRecentBroadcasts(undefined)).toEqual([]);
    expect(listRecentBroadcasts(K)).toHaveLength(0);
  });

  it('recentBroadcastsKey returns undefined when either input is missing', () => {
    expect(recentBroadcastsKey(undefined, 'mainnet')).toBeUndefined();
    expect(recentBroadcastsKey('1Acct', undefined)).toBeUndefined();
    expect(recentBroadcastsKey('', 'mainnet')).toBeUndefined();
    expect(recentBroadcastsKey('1Acct', '')).toBeUndefined();
  });
});
