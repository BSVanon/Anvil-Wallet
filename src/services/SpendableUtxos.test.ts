import { getSpendableFundUtxos } from './SpendableUtxos.service';
import { SPENDABLE_UTXO_FIXTURES } from './__fixtures__/spendable-utxos';

// Minimum-shape mocks. We don't import the real service classes —
// only the fields the resolver touches.
const TEST_ADDR = '1EJaD8hu5PmBkqdrg6FWegQScm9hhUeYd6';

const bareP2PKH = SPENDABLE_UTXO_FIXTURES.find((f) => f.name === 'bob-bare-p2pkh')!;
const v1eP2PKH = SPENDABLE_UTXO_FIXTURES.find((f) => f.name === 'v1e-claim-p2pkh')!;
const mnee = SPENDABLE_UTXO_FIXTURES.find((f) => f.name === 'mnee-production-transfer')!;
const covenant = SPENDABLE_UTXO_FIXTURES.find((f) => f.name === 'phase3b-pool-covenant')!;
const opReturn = SPENDABLE_UTXO_FIXTURES.find((f) => f.name === 'v1e-claim-op-return')!;

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function makeSpvResult(fixtures: { scriptHex: string; txid: string; vout: number; satoshis: number }[]) {
  return {
    txos: fixtures.map((f) => ({
      outpoint: { txid: f.txid, vout: f.vout },
      satoshis: BigInt(f.satoshis),
      script: hexToBytes(f.scriptHex),
    })),
  };
}

function makeSpvMock(impl: () => Promise<unknown> | unknown) {
  return { search: jest.fn().mockImplementation(impl) } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeGorillaMock(impl: () => Promise<unknown> | unknown) {
  return { getFundUtxosByAddress: jest.fn().mockImplementation(impl) } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeWocMock(impl: () => Promise<unknown> | unknown) {
  return { getUtxosByAddress: jest.fn().mockImplementation(impl) } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('getSpendableFundUtxos — ordered failover', () => {
  it('tier 1: returns spv-store result immediately when non-empty', async () => {
    const spv = makeSpvMock(async () =>
      makeSpvResult([{ ...bareP2PKH, satoshis: 1500 }]),
    );
    const gorilla = makeGorillaMock(async () => {
      throw new Error('should not be called');
    });
    const woc = makeWocMock(async () => {
      throw new Error('should not be called');
    });

    const result = await getSpendableFundUtxos(TEST_ADDR, { spv, gorilla, woc });

    expect(result.length).toBe(1);
    expect(result[0].source).toBe('spv-store');
    expect(result[0].satoshis).toBe(1500n);
    expect(spv.search).toHaveBeenCalledTimes(1);
    expect(gorilla.getFundUtxosByAddress).not.toHaveBeenCalled();
    expect(woc.getUtxosByAddress).not.toHaveBeenCalled();
  });

  it('tier 1 empty → tier 2 GorillaPool consulted', async () => {
    const spv = makeSpvMock(async () => ({ txos: [] }));
    const gorilla = makeGorillaMock(async () => [
      { txid: bareP2PKH.txid, vout: bareP2PKH.vout, satoshis: 2000, scriptHex: bareP2PKH.scriptHex },
    ]);
    const woc = makeWocMock(async () => {
      throw new Error('should not be called');
    });

    const result = await getSpendableFundUtxos(TEST_ADDR, { spv, gorilla, woc });

    expect(result.length).toBe(1);
    expect(result[0].source).toBe('gorillapool');
    expect(result[0].satoshis).toBe(2000n);
    expect(woc.getUtxosByAddress).not.toHaveBeenCalled();
  });

  it('tier 1 throw → tier 2 GorillaPool consulted', async () => {
    const spv = makeSpvMock(async () => {
      throw new Error('spv-store sync broken');
    });
    const gorilla = makeGorillaMock(async () => [
      { txid: v1eP2PKH.txid, vout: v1eP2PKH.vout, satoshis: 500, scriptHex: v1eP2PKH.scriptHex },
    ]);
    const woc = makeWocMock(async () => {
      throw new Error('should not be called');
    });

    const result = await getSpendableFundUtxos(TEST_ADDR, { spv, gorilla, woc });

    expect(result.length).toBe(1);
    expect(result[0].source).toBe('gorillapool');
    expect(woc.getUtxosByAddress).not.toHaveBeenCalled();
  });

  it('tier 1 + tier 2 both empty → tier 3 WoC consulted, filter applied', async () => {
    const spv = makeSpvMock(async () => ({ txos: [] }));
    const gorilla = makeGorillaMock(async () => []);
    const woc = makeWocMock(async () => [
      { txid: bareP2PKH.txid, vout: bareP2PKH.vout, satoshis: 1500, scriptHex: bareP2PKH.scriptHex },
      // An ordinal that WoC can't detect — filter must exclude it.
      { txid: mnee.txid, vout: mnee.vout, satoshis: 1, scriptHex: mnee.scriptHex },
    ]);

    const result = await getSpendableFundUtxos(TEST_ADDR, { spv, gorilla, woc });

    expect(result.length).toBe(1);
    expect(result[0].source).toBe('woc');
    expect(result[0].txid).toBe(bareP2PKH.txid);
    // MNEE must not be in the result — fund-safety invariant.
    expect(result.some((u) => u.txid === mnee.txid)).toBe(false);
  });

  it('all three tiers empty → empty result (truly empty wallet)', async () => {
    const spv = makeSpvMock(async () => ({ txos: [] }));
    const gorilla = makeGorillaMock(async () => []);
    const woc = makeWocMock(async () => []);

    const result = await getSpendableFundUtxos(TEST_ADDR, { spv, gorilla, woc });

    expect(result).toEqual([]);
    expect(spv.search).toHaveBeenCalledTimes(1);
    expect(gorilla.getFundUtxosByAddress).toHaveBeenCalledTimes(1);
    expect(woc.getUtxosByAddress).toHaveBeenCalledTimes(1);
  });

  it('tier 3 fail-closed: only WoC returns MNEE / covenant / OP_RETURN → all excluded', async () => {
    const spv = makeSpvMock(async () => ({ txos: [] }));
    const gorilla = makeGorillaMock(async () => []);
    const woc = makeWocMock(async () => [
      { txid: mnee.txid, vout: mnee.vout, satoshis: 1, scriptHex: mnee.scriptHex },
      { txid: covenant.txid, vout: covenant.vout, satoshis: 200, scriptHex: covenant.scriptHex },
      { txid: opReturn.txid, vout: opReturn.vout, satoshis: 0, scriptHex: opReturn.scriptHex },
    ]);

    const result = await getSpendableFundUtxos(TEST_ADDR, { spv, gorilla, woc });

    expect(result).toEqual([]); // Every entry fails fail-closed.
  });

  it('tier 2 GorillaPool throws → tier 3 WoC consulted', async () => {
    const spv = makeSpvMock(async () => ({ txos: [] }));
    const gorilla = makeGorillaMock(async () => {
      throw new Error('GorillaPool HTTP 503');
    });
    const woc = makeWocMock(async () => [
      { txid: bareP2PKH.txid, vout: bareP2PKH.vout, satoshis: 1500, scriptHex: bareP2PKH.scriptHex },
    ]);

    const result = await getSpendableFundUtxos(TEST_ADDR, { spv, gorilla, woc });

    expect(result.length).toBe(1);
    expect(result[0].source).toBe('woc');
  });

  it('tier 2 returns all-non-fungible → filtered to empty → falls through to tier 3', async () => {
    // GorillaPool claims bsv20=false but returns an ordinal-containing
    // script anyway (indexer bug). Defense-in-depth filter catches it.
    const spv = makeSpvMock(async () => ({ txos: [] }));
    const gorilla = makeGorillaMock(async () => [
      { txid: mnee.txid, vout: mnee.vout, satoshis: 1, scriptHex: mnee.scriptHex },
    ]);
    const woc = makeWocMock(async () => [
      { txid: bareP2PKH.txid, vout: bareP2PKH.vout, satoshis: 1500, scriptHex: bareP2PKH.scriptHex },
    ]);

    const result = await getSpendableFundUtxos(TEST_ADDR, { spv, gorilla, woc });

    expect(result.length).toBe(1);
    expect(result[0].source).toBe('woc');
    expect(result[0].txid).toBe(bareP2PKH.txid);
  });

  it('returned satoshis are bigint (callers expect bigint)', async () => {
    const spv = makeSpvMock(async () => ({ txos: [] }));
    const gorilla = makeGorillaMock(async () => [
      { txid: bareP2PKH.txid, vout: bareP2PKH.vout, satoshis: 500, scriptHex: bareP2PKH.scriptHex },
    ]);
    const woc = makeWocMock(async () => []);

    const result = await getSpendableFundUtxos(TEST_ADDR, { spv, gorilla, woc });

    expect(typeof result[0].satoshis).toBe('bigint');
  });

  it('scriptHex is lowercase in output regardless of input case', async () => {
    const spv = makeSpvMock(async () => ({ txos: [] }));
    const gorilla = makeGorillaMock(async () => [
      { txid: bareP2PKH.txid, vout: bareP2PKH.vout, satoshis: 500, scriptHex: bareP2PKH.scriptHex.toUpperCase() },
    ]);
    const woc = makeWocMock(async () => []);

    const result = await getSpendableFundUtxos(TEST_ADDR, { spv, gorilla, woc });

    expect(result[0].scriptHex).toBe(bareP2PKH.scriptHex.toLowerCase());
  });
});
