import { WhatsOnChainService } from './WhatsOnChain.service';
import { NetWork } from 'yours-wallet-provider';

type JsonResult = { ok: boolean; json?: () => Promise<unknown>; text?: () => Promise<string> };

function makeChromeMock(): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    getNetwork: () => NetWork.Mainnet,
    getCurrentAccountObject: () => ({}),
    update: jest.fn(),
  };
}

function stubFetch(routes: Record<string, JsonResult>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = url.toString();
    for (const [prefix, result] of Object.entries(routes)) {
      if (u.includes(prefix)) return result as unknown as Response;
    }
    throw new Error(`unstubbed fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe('WhatsOnChainService.getTxStatus', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const TXID = 'a'.repeat(64);
  const makeService = () => new WhatsOnChainService(makeChromeMock());

  it('returns confirmed with blockHeight + blockTime when WoC reports a mined tx', async () => {
    global.fetch = stubFetch({
      [`tx/hash/${TXID}`]: {
        ok: true,
        async json() {
          return { blockheight: 945980, blocktime: 1776904577 };
        },
      },
    });
    const svc = makeService();
    const result = await svc.getTxStatus(TXID);
    expect(result).toEqual({ confirmed: true, blockHeight: 945980, blockTime: 1776904577 });
  });

  it('returns confirmed without blockTime when WoC omits blocktime', async () => {
    global.fetch = stubFetch({
      [`tx/hash/${TXID}`]: {
        ok: true,
        async json() {
          return { blockheight: 500000 };
        },
      },
    });
    const svc = makeService();
    const result = await svc.getTxStatus(TXID);
    expect(result).toEqual({ confirmed: true, blockHeight: 500000, blockTime: undefined });
  });

  it('returns confirmed=false when WoC returns the tx without blockheight (mempool)', async () => {
    global.fetch = stubFetch({
      [`tx/hash/${TXID}`]: {
        ok: true,
        async json() {
          return { txid: TXID }; // no blockheight means unconfirmed
        },
      },
    });
    const svc = makeService();
    const result = await svc.getTxStatus(TXID);
    expect(result).toEqual({ confirmed: false });
  });

  it('returns undefined on non-OK HTTP response', async () => {
    global.fetch = stubFetch({
      [`tx/hash/${TXID}`]: { ok: false },
    });
    const svc = makeService();
    expect(await svc.getTxStatus(TXID)).toBeUndefined();
  });

  it('returns undefined on network error (fetch throws)', async () => {
    global.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const svc = makeService();
    expect(await svc.getTxStatus(TXID)).toBeUndefined();
  });

  it('returns undefined for malformed txid without hitting the network', async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return { ok: true, async json() { return {}; } } as unknown as Response;
    }) as unknown as typeof fetch;
    const svc = makeService();
    expect(await svc.getTxStatus('not-a-txid')).toBeUndefined();
    expect(await svc.getTxStatus('')).toBeUndefined();
    expect(await svc.getTxStatus('a'.repeat(63))).toBeUndefined();
    expect(called).toBe(false);
  });

  it('rejects blockheight = 0 as unconfirmed (WoC quirk on edge cases)', async () => {
    global.fetch = stubFetch({
      [`tx/hash/${TXID}`]: {
        ok: true,
        async json() {
          return { blockheight: 0 };
        },
      },
    });
    const svc = makeService();
    expect(await svc.getTxStatus(TXID)).toEqual({ confirmed: false });
  });
});
