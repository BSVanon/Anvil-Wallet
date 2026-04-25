/**
 * DisplayCache.service tests — confirms the chrome.storage.local
 * round-trip works as a popup-mount → render-from-cache pipeline.
 *
 * Tests run in node (no jsdom-style chrome global), so we mock
 * chrome.storage.local minimally. The point is to verify the
 * caching shape + freshness logic, not to integration-test
 * chrome.storage itself.
 */

import {
  DISPLAY_CACHE_FRESH_MS,
  isFresh,
  keyFromAccount,
  readDisplayCache,
  writeActivityCache,
  writeBsv20sCache,
  clearDisplayCache,
} from './DisplayCache.service';

// Single-account fixture used by most tests below. Account-isolation
// tests use distinct keys to assert no bleed.
const K = keyFromAccount('1Test', 'mainnet')!;

interface MockSession {
  store: Map<string, unknown>;
}

function installChromeMock(): MockSession {
  const store = new Map<string, unknown>();
  const local = {
    store,
    get: async (key: string) => {
      if (store.has(key)) return { [key]: store.get(key) };
      return {};
    },
    set: async (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    },
    remove: async (key: string) => {
      store.delete(key);
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local },
  };
  return { store };
}

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('DisplayCache', () => {
  it('round-trips bsv20s cache', async () => {
    installChromeMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokens = [
      // Real Bsv20 shape includes BigInt fields — see regression
      // test below. Use plain shape here.
      { id: 'aa_0', all: { confirmed: 0n, pending: 0n }, listed: { confirmed: 0n, pending: 0n } } as any,
      { id: 'bb_0', all: { confirmed: 0n, pending: 0n }, listed: { confirmed: 0n, pending: 0n } } as any,
    ];
    await writeBsv20sCache(K, tokens);
    const cache = await readDisplayCache(K);
    expect(cache.bsv20s?.entries).toHaveLength(2);
    expect(cache.bsv20s?.entries[0].id).toBe('aa_0');
    expect(typeof cache.bsv20s?.cachedAt).toBe('number');
  });

  it('round-trips BigInt balance fields (Phase 2.5 hotfix — Robert click-test 2026-04-25)', async () => {
    // The bug we fixed: chrome.storage.local.set throws on BigInt
    // values, so writeBsv20sCache silently failed and the cache
    // never persisted. Pumpkin "appeared after long wait, vanished
    // on next open" — exact symptom. This test would have caught
    // the regression before shipping.
    installChromeMock();
    const tokens = [
      {
        id: 'aa_0',
        sym: 'TEST',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dec: 2 as any,
        all: { confirmed: 3100n, pending: 0n },
        listed: { confirmed: 500n, pending: 100n },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ];
    await writeBsv20sCache(K, tokens);
    const cache = await readDisplayCache(K);
    expect(cache.bsv20s?.entries).toHaveLength(1);
    const entry = cache.bsv20s!.entries[0];
    // BigInts come back AS BigInts, not strings — caller-transparent.
    expect(entry.all.confirmed).toBe(3100n);
    expect(entry.all.pending).toBe(0n);
    expect(entry.listed.confirmed).toBe(500n);
    expect(entry.listed.pending).toBe(100n);
    expect(typeof entry.all.confirmed).toBe('bigint');
    expect(typeof entry.listed.confirmed).toBe('bigint');
  });

  it('round-trips activity cache', async () => {
    installChromeMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logs = [{ txid: 'a'.repeat(64), height: 800100, idx: 0, summary: {} } as any];
    await writeActivityCache(K, logs);
    const cache = await readDisplayCache(K);
    expect(cache.activity?.logs).toHaveLength(1);
    expect(cache.activity?.logs[0].txid).toBe('a'.repeat(64));
  });

  it('sanitizes IndexSummary.data on write so non-cloneable values cannot blow up cache write', async () => {
    // Phase 2.5 hotfix #9: spv-store's indexer chain populates
    // IndexSummary.data with whatever it indexes — BigInts, class
    // instances, etc. structured-clone rejects those, silently
    // failing the entire cache write (Robert click-test reported
    // Activity flicker that was traced to cache writes failing on
    // some rows). The sanitizer drops .data and keeps only
    // display-needed fields (id/icon/amount).
    installChromeMock();
    const logs = [
      {
        txid: 'a'.repeat(64),
        height: 800_100,
        idx: 0,
        summary: {
          fund: {
            id: 'fund-id',
            icon: 'icon-url',
            amount: 12345,
            // BigInt directly — chrome.storage.local.set would throw
            // on this. The sanitizer must drop it before write.
            data: { hidden: 100n, deep: { nested: { fn: () => {} } } },
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ];
    await writeActivityCache(K, logs);
    const cache = await readDisplayCache(K);
    expect(cache.activity?.logs).toHaveLength(1);
    const entry = cache.activity!.logs[0];
    expect(entry.txid).toBe('a'.repeat(64));
    expect(entry.height).toBe(800_100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fund = (entry.summary as any).fund;
    expect(fund.id).toBe('fund-id');
    expect(fund.icon).toBe('icon-url');
    expect(fund.amount).toBe(12345);
    // The non-cloneable .data is gone.
    expect(fund.data).toBeUndefined();
  });

  it('caps activity cache at 100 entries to bound storage', async () => {
    installChromeMock();
    const logs = Array.from({ length: 250 }, (_, i) => ({
      txid: i.toString(16).padStart(64, '0'),
      height: 800_000 + i,
      idx: 0,
      summary: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any[];
    await writeActivityCache(K, logs);
    const cache = await readDisplayCache(K);
    expect(cache.activity?.logs).toHaveLength(100);
  });

  it('writes do not clobber other sub-caches', async () => {
    installChromeMock();
    await writeBsv20sCache(K, [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'aa_0', all: { confirmed: 0n, pending: 0n }, listed: { confirmed: 0n, pending: 0n } } as any,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await writeActivityCache(K, [{ txid: 'a'.repeat(64), height: 1, idx: 0, summary: {} } as any]);
    const cache = await readDisplayCache(K);
    expect(cache.bsv20s?.entries).toHaveLength(1);
    expect(cache.activity?.logs).toHaveLength(1);
  });

  it('readDisplayCache returns empty object when chrome.storage.local is unavailable', async () => {
    // No chrome global installed.
    const cache = await readDisplayCache(K);
    expect(cache).toEqual({});
  });

  it('writes are silent no-ops when chrome.storage.local is unavailable', async () => {
    // No chrome global installed.
    await expect(
      writeBsv20sCache(K, [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'aa_0', all: { confirmed: 0n, pending: 0n }, listed: { confirmed: 0n, pending: 0n } } as any,
      ]),
    ).resolves.toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(writeActivityCache(K, [{ txid: 'a'.repeat(64), height: 1, idx: 0, summary: {} } as any])).resolves.toBeUndefined();
  });

  it('writes are no-ops with undefined cacheKey (caller couldn\'t derive account+network)', async () => {
    // Codex 603d74df: when wallet is in a half-loaded state and
    // selectedAccount/network aren't available, keyFromAccount
    // returns undefined. All cache helpers must no-op cleanly
    // rather than write under a malformed key.
    installChromeMock();
    await writeBsv20sCache(undefined, [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'aa_0', all: { confirmed: 0n, pending: 0n }, listed: { confirmed: 0n, pending: 0n } } as any,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await writeActivityCache(undefined, [{ txid: 'a'.repeat(64), height: 1, idx: 0, summary: {} } as any]);
    const cache = await readDisplayCache(undefined);
    expect(cache).toEqual({});
  });

  it('isolates writes between accounts (Codex 603d74df BLOCKING regression)', async () => {
    // Account A and Account B are distinct (selectedAccount, network)
    // pairs. Writes under A must not appear when reading under B.
    installChromeMock();
    const KA = keyFromAccount('1AccountA', 'mainnet')!;
    const KB = keyFromAccount('1AccountB', 'mainnet')!;
    expect(KA).not.toBe(KB);
    await writeBsv20sCache(KA, [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'tokenA_0', all: { confirmed: 100n, pending: 0n }, listed: { confirmed: 0n, pending: 0n } } as any,
    ]);
    await writeBsv20sCache(KB, [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'tokenB_0', all: { confirmed: 200n, pending: 0n }, listed: { confirmed: 0n, pending: 0n } } as any,
    ]);
    const ca = await readDisplayCache(KA);
    const cb = await readDisplayCache(KB);
    expect(ca.bsv20s?.entries.map((e) => e.id)).toEqual(['tokenA_0']);
    expect(cb.bsv20s?.entries.map((e) => e.id)).toEqual(['tokenB_0']);
    expect(ca.bsv20s?.entries[0].all.confirmed).toBe(100n);
    expect(cb.bsv20s?.entries[0].all.confirmed).toBe(200n);
  });

  it('isolates network mainnet vs testnet for the same account', async () => {
    installChromeMock();
    const main = keyFromAccount('1SameAcct', 'mainnet')!;
    const test = keyFromAccount('1SameAcct', 'testnet')!;
    expect(main).not.toBe(test);
    await writeBsv20sCache(main, [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'mainTok_0', all: { confirmed: 1n, pending: 0n }, listed: { confirmed: 0n, pending: 0n } } as any,
    ]);
    const cMain = await readDisplayCache(main);
    const cTest = await readDisplayCache(test);
    expect(cMain.bsv20s?.entries).toHaveLength(1);
    expect(cTest.bsv20s).toBeUndefined();
  });

  it('keyFromAccount returns undefined when either input is missing', () => {
    expect(keyFromAccount(undefined, 'mainnet')).toBeUndefined();
    expect(keyFromAccount('1Acct', undefined)).toBeUndefined();
    expect(keyFromAccount('', 'mainnet')).toBeUndefined();
    expect(keyFromAccount('1Acct', '')).toBeUndefined();
  });

  it('round-trips reconciliation cache (Maps survive serialize/deserialize)', async () => {
    // Phase 2.5 hotfix #10: persist WoC reconciliation lookups so
    // the next popup open doesn't refetch every Pending row.
    installChromeMock();
    const { writeReconciliationCache } = await import('./DisplayCache.service');
    await writeReconciliationCache(K, {
      wocByTxid: new Map([
        ['a'.repeat(64), { height: 945980, time: 1776904577 }],
        ['b'.repeat(64), { height: 945981 }],
      ]),
      blockTimes: new Map([
        [945980, 1776904577],
        [945981, 1776904600],
      ]),
    });
    const cache = await readDisplayCache(K);
    expect(cache.reconciliation).toBeDefined();
    expect(cache.reconciliation!.wocByTxid.size).toBe(2);
    expect(cache.reconciliation!.wocByTxid.get('a'.repeat(64))).toEqual({
      height: 945980,
      time: 1776904577,
    });
    expect(cache.reconciliation!.blockTimes.size).toBe(2);
    expect(cache.reconciliation!.blockTimes.get(945981)).toBe(1776904600);
  });

  it('clearDisplayCache removes the stored key', async () => {
    const { store } = installChromeMock();
    await writeBsv20sCache(K, [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'aa_0', all: { confirmed: 0n, pending: 0n }, listed: { confirmed: 0n, pending: 0n } } as any,
    ]);
    expect(store.has(K)).toBe(true);
    await clearDisplayCache(K);
    expect(store.has(K)).toBe(false);
  });
});

describe('DisplayCache.isFresh', () => {
  it('treats undefined as not-fresh', () => {
    expect(isFresh(undefined)).toBe(false);
  });
  it('returns true when cache is within TTL', () => {
    expect(isFresh(Date.now() - 1000)).toBe(true);
  });
  it('returns false when cache exceeds TTL', () => {
    expect(isFresh(Date.now() - DISPLAY_CACHE_FRESH_MS - 5000)).toBe(false);
  });
});
