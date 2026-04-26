/**
 * broadcastMultiSource fail-closed contract tests.
 *
 * The contract being tested: a returned `{ status: 'success', txid }`
 * means at least one upstream broadcaster (Mesh / spv-store / WoC) or
 * the idempotency check confirmed the tx is on-network. Anything else
 * MUST return `{ status: 'error' }`. User-funds safety depends on this
 * — silent-success is the bug class this module exists to prevent.
 *
 * Mocks: fetch (Mesh, WoC POST, WoC tx-exists GET), readSyncStatus,
 * getMeshBroadcastHealth, oneSatSPV.broadcast. Tx is a thin stub
 * exposing only what broadcast.ts touches: toBEEF / toHex / id /
 * outputs.
 */

import type { Transaction } from '@bsv/sdk';
import type { SPVStore } from 'spv-store';
import type { ChromeStorageService } from '../services/ChromeStorage.service';
import { broadcastMultiSource } from './broadcast';
import { listRecentBroadcasts, recentBroadcastsKey } from './recentBroadcasts';

jest.mock('./meshHealth', () => ({
  getMeshBroadcastHealth: jest.fn(),
}));
jest.mock('../services/SyncStatus.service', () => ({
  readSyncStatus: jest.fn(),
}));

import { getMeshBroadcastHealth } from './meshHealth';
import { readSyncStatus } from '../services/SyncStatus.service';

const mockMeshHealth = getMeshBroadcastHealth as jest.MockedFunction<typeof getMeshBroadcastHealth>;
const mockSyncStatus = readSyncStatus as jest.MockedFunction<typeof readSyncStatus>;

const TXID = 'a'.repeat(64);

function makeTx(): Transaction {
  return {
    toBEEF: () => [0, 1, 2, 3],
    toHex: () => 'deadbeef',
    id: (_fmt: string) => TXID,
    outputs: [{ satoshis: 1000 }, { satoshis: 500 }],
  } as unknown as Transaction;
}

function makeSpv(broadcast: jest.Mock): SPVStore {
  return { broadcast } as unknown as SPVStore;
}

function makeChromeStorage(account = '1TestAccount', network = 'mainnet'): ChromeStorageService {
  return {
    getCurrentAccountObject: () => ({ selectedAccount: account }),
    getNetwork: () => network,
  } as unknown as ChromeStorageService;
}

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  mockMeshHealth.mockResolvedValue('healthy');
  mockSyncStatus.mockResolvedValue('healthy');
  // Default: no Mesh configured
  localStorage.removeItem('anvil_node_url');
  localStorage.removeItem('anvil_auth_token');
  // Default fetch: 404 (used for txExistsOnNetwork idempotency check)
  global.fetch = jest.fn(async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) })) as unknown as typeof fetch;
});

describe('broadcastMultiSource fail-closed contract', () => {
  describe('all paths fail', () => {
    it('returns error when spv-store rejects, WoC errors, and tx is not on network', async () => {
      const spvBroadcast = jest.fn().mockRejectedValue(new Error('spv down'));
      // WoC POST returns non-ok; WoC GET (idempotency) also returns non-ok
      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/tx/raw')) return { ok: false, status: 500, text: async () => 'rejected', json: async () => ({}) };
        if (url.includes('/tx/hash/')) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
      }) as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('error');
      expect(result.description).toContain('all broadcast paths failed');
    });

    it('returns error when sync degraded AND woc fails AND tx not on network', async () => {
      mockSyncStatus.mockResolvedValue('degraded');
      const spvBroadcast = jest.fn(); // should never be called
      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/tx/raw')) return { ok: false, status: 500, text: async () => 'rejected', json: async () => ({}) };
        if (url.includes('/tx/hash/')) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
      }) as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('error');
      expect(spvBroadcast).not.toHaveBeenCalled();
    });
  });

  describe('per-tier success', () => {
    it('Mesh success short-circuits — spv-store + WoC never called', async () => {
      localStorage.setItem('anvil_node_url', 'https://mesh.example');
      localStorage.setItem('anvil_auth_token', 'token123');

      const meshTxid = 'b'.repeat(64);
      const spvBroadcast = jest.fn();
      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('mesh.example')) {
          return {
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ txid: meshTxid, status: 'propagated' }),
          };
        }
        throw new Error('should not reach woc');
      }) as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      expect(result.txid).toBe(meshTxid);
      expect(result.description).toContain('anvil-mesh');
      expect(spvBroadcast).not.toHaveBeenCalled();
    });

    it('spv-store success short-circuits — WoC POST never called', async () => {
      const spvBroadcast = jest.fn().mockResolvedValue({ status: 'success', description: 'ok' });
      const fetchMock = jest.fn(async (url: string) => {
        if (url.includes('/tx/raw')) throw new Error('woc should not be reached');
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      expect(result.txid).toBe(TXID);
      expect(spvBroadcast).toHaveBeenCalledTimes(1);
      // No POST to /tx/raw was attempted
      const wocPosts = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/tx/raw'));
      expect(wocPosts).toHaveLength(0);
    });

    it('WoC succeeds after spv-store rejects', async () => {
      const wocTxid = 'c'.repeat(64);
      const spvBroadcast = jest.fn().mockRejectedValue(new Error('spv down'));
      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/tx/raw')) return { ok: true, status: 200, text: async () => `"${wocTxid}"`, json: async () => ({}) };
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      }) as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      expect(result.txid).toBe(wocTxid);
      expect(result.description).toContain('woc-direct');
      expect(spvBroadcast).toHaveBeenCalledTimes(1);
    });
  });

  describe('idempotency check', () => {
    it('treats "tx already on network" as success via the post-spv-store check when spv-store rejects', async () => {
      // Same scenario as the original "all rungs fail" test, but the
      // post-spv-store idempotency short-circuit fires BEFORE WoC is
      // called, so the success description carries the early-check
      // string rather than the end-of-function "prior attempt" one.
      // Behavior contract is the same: idempotent retries return
      // success, never error.
      const spvBroadcast = jest.fn().mockRejectedValue(new Error('duplicate'));
      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/tx/raw')) return { ok: false, status: 500, text: async () => 'duplicate', json: async () => ({}) };
        if (url.includes('/tx/hash/')) return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      }) as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      expect(result.txid).toBe(TXID);
      // Post-spv-store idempotency catches it before the end-of-function check
      expect(result.description).toContain('post-error idempotency');
    });

    it('treats "tx already on network" as success via the END-OF-FUNCTION check when sync is degraded (spv-store skipped) and WoC fails', async () => {
      // When sync='degraded', the spv-store rung is skipped entirely
      // — no post-spv-store idempotency check fires. WoC then fails.
      // The end-of-function safety net catches the on-network state
      // and returns success with the "prior attempt" description.
      // This is the case the end-of-function check was originally
      // designed for; preserved as a regression test so it doesn't
      // get accidentally removed.
      mockSyncStatus.mockResolvedValue('degraded');
      const spvBroadcast = jest.fn();
      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/tx/raw')) return { ok: false, status: 500, text: async () => 'duplicate', json: async () => ({}) };
        if (url.includes('/tx/hash/')) return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      }) as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      expect(result.txid).toBe(TXID);
      expect(result.description).toContain('prior attempt');
      expect(spvBroadcast).not.toHaveBeenCalled();
    });

    it('returns success without WoC fallback when spv-store rejects but tx is already on-network (degraded indexer false-failure)', async () => {
      // Robert click-test 2026-04-25: Pumpkin OrdLock listing tx
      // 3bf1fc63... confirmed at block 946418 even though the wallet
      // surfaced "broadcast failed". ARC under spv-store accepted the
      // tx; spv-store's degraded indexer rejected the post-broadcast
      // ingest. Without this short-circuit, broadcastMultiSource
      // would waste a WoC roundtrip + still return failure.
      const spvBroadcast = jest.fn().mockRejectedValue(new Error('register-failed (1Sat indexer degraded)'));
      const wocPostMock = jest.fn();
      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/tx/hash/')) {
          return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
        }
        if (url.includes('/tx/raw')) {
          wocPostMock(url);
          return { ok: false, status: 500, text: async () => 'should not reach woc', json: async () => ({}) };
        }
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      }) as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      expect(result.txid).toBe(TXID);
      expect(result.description).toContain('post-error idempotency');
      // WoC post-broadcast was NOT called — we caught the success early.
      expect(wocPostMock).not.toHaveBeenCalled();
    });
  });

  describe('sync-degraded path', () => {
    it('skips spv-store and goes straight to WoC when sync degraded', async () => {
      mockSyncStatus.mockResolvedValue('degraded');
      const wocTxid = 'd'.repeat(64);
      const spvBroadcast = jest.fn();
      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/tx/raw')) return { ok: true, status: 200, text: async () => `"${wocTxid}"`, json: async () => ({}) };
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      }) as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      expect(result.txid).toBe(wocTxid);
      expect(spvBroadcast).not.toHaveBeenCalled();
    });
  });

  describe('Mesh tier behavior', () => {
    it('skipped when not configured (no anvil_node_url) — falls through to spv-store', async () => {
      // Default beforeEach state: localStorage empty. spv-store handles it.
      const spvBroadcast = jest.fn().mockResolvedValue({ status: 'success', description: 'ok' });

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      expect(spvBroadcast).toHaveBeenCalled();
    });

    it('Mesh "down" health → skip Mesh fetch, fall through to spv-store', async () => {
      localStorage.setItem('anvil_node_url', 'https://mesh.example');
      localStorage.setItem('anvil_auth_token', 'token123');
      mockMeshHealth.mockResolvedValue('down');

      const spvBroadcast = jest.fn().mockResolvedValue({ status: 'success', description: 'ok' });
      const fetchMock = jest.fn(async (_url: string) => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) }));
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      // No fetch was made to mesh.example
      const meshCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('mesh.example'));
      expect(meshCalls).toHaveLength(0);
      expect(spvBroadcast).toHaveBeenCalled();
    });

    it('Mesh response status="rejected" falls through to spv-store', async () => {
      localStorage.setItem('anvil_node_url', 'https://mesh.example');
      localStorage.setItem('anvil_auth_token', 'token123');

      const spvBroadcast = jest.fn().mockResolvedValue({ status: 'success', description: 'ok' });
      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('mesh.example')) {
          return { ok: true, status: 200, text: async () => '', json: async () => ({ status: 'rejected', message: 'bad sig' }) };
        }
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      }) as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      expect(spvBroadcast).toHaveBeenCalled();
    });
  });

  describe('account-namespace threading', () => {
    it('records broadcast under (account, network) key when chromeStorageService passed', async () => {
      const chromeStorageService = makeChromeStorage('1Alice', 'mainnet');
      const spvBroadcast = jest.fn().mockResolvedValue({ status: 'success', description: 'ok' });

      const result = await broadcastMultiSource(makeTx(), {
        oneSatSPV: makeSpv(spvBroadcast),
        chromeStorageService,
      });

      expect(result.status).toBe('success');
      const aliceKey = recentBroadcastsKey('1Alice', 'mainnet')!;
      const aliceList = listRecentBroadcasts(aliceKey);
      expect(aliceList).toHaveLength(1);
      expect(aliceList[0].txid).toBe(TXID);

      // Bob's namespace stays empty — no cross-account bleed
      const bobKey = recentBroadcastsKey('1Bob', 'mainnet')!;
      expect(listRecentBroadcasts(bobKey)).toHaveLength(0);

      // Different network for same account also stays empty
      const aliceTestnetKey = recentBroadcastsKey('1Alice', 'testnet')!;
      expect(listRecentBroadcasts(aliceTestnetKey)).toHaveLength(0);
    });

    it('broadcasts succeed even when chromeStorageService is omitted (no namespacing)', async () => {
      const spvBroadcast = jest.fn().mockResolvedValue({ status: 'success', description: 'ok' });

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      expect(result.txid).toBe(TXID);
    });

    it('broadcast still returns success even when getCurrentAccountObject throws', async () => {
      const brokenSvc = {
        getCurrentAccountObject: () => {
          throw new Error('storage half-loaded');
        },
        getNetwork: () => 'mainnet',
      } as unknown as ChromeStorageService;
      const spvBroadcast = jest.fn().mockResolvedValue({ status: 'success', description: 'ok' });

      const result = await broadcastMultiSource(makeTx(), {
        oneSatSPV: makeSpv(spvBroadcast),
        chromeStorageService: brokenSvc,
      });

      expect(result.status).toBe('success');
      expect(result.txid).toBe(TXID);
    });
  });

  describe('spv-store timeout branch', () => {
    // Real-timer test of the 10s spv-store hang escape. Takes ~10s wall-time.
    // The contract: when spv-store never resolves and never rejects (e.g.
    // 1Sat indexer half-hangs), broadcastMultiSource must time out and
    // fall through to WoC-direct rather than the user waiting forever.
    it('falls through to WoC when spv-store hangs past 10s', async () => {
      const spvBroadcast = jest.fn(() => new Promise(() => {})); // never resolves
      const wocTxid = 'e'.repeat(64);
      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/tx/raw')) return { ok: true, status: 200, text: async () => `"${wocTxid}"`, json: async () => ({}) };
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      }) as unknown as typeof fetch;

      const result = await broadcastMultiSource(makeTx(), { oneSatSPV: makeSpv(spvBroadcast) });

      expect(result.status).toBe('success');
      expect(result.txid).toBe(wocTxid);
      expect(result.description).toContain('woc-direct');
      expect(spvBroadcast).toHaveBeenCalledTimes(1);
    }, 15_000);
  });

  describe('cache-write isolation', () => {
    it('broadcast still returns success when localStorage is unavailable', async () => {
      // Simulate quota-exceeded by stubbing setItem to throw
      const originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = jest.fn(() => {
        throw new Error('QuotaExceededError');
      });

      try {
        const spvBroadcast = jest.fn().mockResolvedValue({ status: 'success', description: 'ok' });
        const result = await broadcastMultiSource(makeTx(), {
          oneSatSPV: makeSpv(spvBroadcast),
          chromeStorageService: makeChromeStorage(),
        });

        expect(result.status).toBe('success');
        expect(result.txid).toBe(TXID);
      } finally {
        Storage.prototype.setItem = originalSet;
      }
    });
  });
});
