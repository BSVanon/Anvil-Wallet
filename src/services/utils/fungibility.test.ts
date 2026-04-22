import {
  isBareP2PKH,
  hasOrdinalMarker,
  isSpendableFungibleScript,
} from './fungibility';
import { SPENDABLE_UTXO_FIXTURES } from '../__fixtures__/spendable-utxos';

describe('isBareP2PKH', () => {
  it('accepts the canonical 25-byte P2PKH template', () => {
    // `76 a9 14 <20 zero bytes> 88 ac`
    const hex = '76a914' + '00'.repeat(20) + '88ac';
    expect(isBareP2PKH(hex)).toBe(true);
  });

  it('accepts uppercase hex (case-insensitive)', () => {
    const hex = ('76a914' + 'ab'.repeat(20) + '88ac').toUpperCase();
    expect(isBareP2PKH(hex)).toBe(true);
  });

  it('rejects wrong length (one byte short)', () => {
    const hex = '76a914' + '00'.repeat(19) + '88ac';
    expect(isBareP2PKH(hex)).toBe(false);
  });

  it('rejects wrong length (one byte long)', () => {
    const hex = '76a914' + '00'.repeat(21) + '88ac';
    expect(isBareP2PKH(hex)).toBe(false);
  });

  it('rejects missing prefix', () => {
    // correct length + suffix but prefix is 76a915 (non-standard)
    const hex = '76a915' + '00'.repeat(20) + '88ac';
    expect(isBareP2PKH(hex)).toBe(false);
  });

  it('rejects missing suffix', () => {
    const hex = '76a914' + '00'.repeat(20) + '88ad'; // CHECKSIGVERIFY not CHECKSIG
    expect(isBareP2PKH(hex)).toBe(false);
  });

  it('rejects non-hex characters', () => {
    const hex = '76a914' + 'zz'.repeat(20) + '88ac';
    expect(isBareP2PKH(hex)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isBareP2PKH('')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    // @ts-expect-error — defense-in-depth against bad callers
    expect(isBareP2PKH(undefined)).toBe(false);
    // @ts-expect-error
    expect(isBareP2PKH(null)).toBe(false);
    // @ts-expect-error
    expect(isBareP2PKH(12345)).toBe(false);
  });
});

describe('hasOrdinalMarker', () => {
  it("finds the 'ord' push at the script start (MNEE / raw-OP_IF variant)", () => {
    // `OP_IF OP_PUSH3 'ord' ...` — no leading OP_FALSE
    const hex = '63036f7264' + '00'.repeat(20);
    expect(hasOrdinalMarker(hex)).toBe(true);
  });

  it("finds the 'ord' push after OP_FALSE OP_IF (standard 1Sat variant)", () => {
    const hex = '0063036f7264' + '00'.repeat(20);
    expect(hasOrdinalMarker(hex)).toBe(true);
  });

  it("finds the 'ord' push anywhere inside the script", () => {
    const hex = '76a914' + '00'.repeat(10) + '036f7264' + '00'.repeat(10) + '88ac';
    expect(hasOrdinalMarker(hex)).toBe(true);
  });

  it('does NOT fire on random pkhash without the marker', () => {
    const hex = '76a914' + 'ab'.repeat(20) + '88ac';
    expect(hasOrdinalMarker(hex)).toBe(false);
  });

  it('handles empty / short inputs safely', () => {
    expect(hasOrdinalMarker('')).toBe(false);
    expect(hasOrdinalMarker('03')).toBe(false);
    expect(hasOrdinalMarker('036f7264')).toBe(true); // minimal match — boundary
  });
});

describe('real mainnet fixtures — fail-closed fungibility', () => {
  // Table-driven: every fixture must produce its expected classification.
  // If any fixture fails, Phase 1 cannot ship — the filter is unsafe.
  SPENDABLE_UTXO_FIXTURES.forEach((f) => {
    it(`${f.name}: expectedFungible=${f.expectedFungible}`, () => {
      expect(isSpendableFungibleScript(f.scriptHex)).toBe(f.expectedFungible);
    });
  });

  it('MNEE is specifically rejected (Codex-flagged fund-safety case)', () => {
    // Pull the MNEE fixture by name — ensures the suite will break
    // loudly if someone renames / removes it, rather than silently
    // dropping coverage of the most important case.
    const mnee = SPENDABLE_UTXO_FIXTURES.find((f) => f.name === 'mnee-production-transfer');
    expect(mnee).toBeDefined();
    expect(isSpendableFungibleScript(mnee!.scriptHex)).toBe(false);

    // Verify the mechanism: MNEE must fail the primary isBareP2PKH
    // gate (length check) AND also trigger the secondary ordinal
    // marker scan. Defense-in-depth.
    expect(isBareP2PKH(mnee!.scriptHex)).toBe(false); // primary: wrong length
    expect(hasOrdinalMarker(mnee!.scriptHex)).toBe(true); // secondary: ord push present
  });

  it('every fungible fixture passes both gates (isBareP2PKH=true, hasOrdinalMarker=false)', () => {
    const fungible = SPENDABLE_UTXO_FIXTURES.filter((f) => f.expectedFungible);
    expect(fungible.length).toBeGreaterThan(0);
    for (const f of fungible) {
      expect(isBareP2PKH(f.scriptHex)).toBe(true);
      expect(hasOrdinalMarker(f.scriptHex)).toBe(false);
    }
  });

  it('every non-fungible fixture fails at least one gate', () => {
    const nonFungible = SPENDABLE_UTXO_FIXTURES.filter((f) => !f.expectedFungible);
    expect(nonFungible.length).toBeGreaterThan(0);
    for (const f of nonFungible) {
      const passesPrimary = isBareP2PKH(f.scriptHex);
      const marker = hasOrdinalMarker(f.scriptHex);
      // Must fail at least one: either not P2PKH-shaped, or ord-marked.
      expect(passesPrimary && !marker).toBe(false);
    }
  });
});
