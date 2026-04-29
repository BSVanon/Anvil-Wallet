import type { Bsv20 } from 'yours-wallet-provider';
import { buildIconOfIndex, lookupIconOf } from './iconOf';

const ZERO_BAL = { confirmed: 0n, pending: 0n };

function token(over: Partial<Bsv20>): Bsv20 {
  return {
    p: 'bsv-20',
    op: 'deploy+mint',
    dec: 0,
    amt: '0',
    all: { ...ZERO_BAL },
    listed: { ...ZERO_BAL },
    ...over,
  };
}

const CUCUMBER_ICON = 'f0992b75e72e1113eede168d20e8efcdc94fc05358043c9820acef831fdf414b_0';
const CUCUMBER_ID = '3a74d0ecd058ffd1c4621b29a2a67cd6c518ad5ba3123ec46220dfd4b2cc6f09_0';

describe('buildIconOfIndex', () => {
  it('returns empty map for undefined / empty input', () => {
    expect(buildIconOfIndex(undefined).size).toBe(0);
    expect(buildIconOfIndex([]).size).toBe(0);
  });

  it('maps outpoint-form icon back to the token sym + id', () => {
    const idx = buildIconOfIndex([
      token({ id: CUCUMBER_ID, sym: 'Cucumber', icon: CUCUMBER_ICON }),
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get(CUCUMBER_ICON)).toEqual({ sym: 'Cucumber', id: CUCUMBER_ID });
  });

  it('skips tokens whose icon is a full URL (BSV-21 deploys with off-chain icons)', () => {
    const idx = buildIconOfIndex([
      token({
        id: '3c5de613b36aadad51dac34a0472a878a42c4125b448504810927a377d5162c4_0',
        sym: 'Pumpkin',
        icon: 'https://www.image2url.com/r2/default/images/abc.png',
      }),
    ]);
    expect(idx.size).toBe(0);
  });

  it('skips tokens with no icon', () => {
    const idx = buildIconOfIndex([
      token({ id: CUCUMBER_ID, sym: 'Cucumber' }),
    ]);
    expect(idx.size).toBe(0);
  });

  it('skips tokens with no id (cant key the result)', () => {
    const idx = buildIconOfIndex([
      token({ sym: 'Floating', icon: CUCUMBER_ICON }),
    ]);
    expect(idx.size).toBe(0);
  });

  it('falls back to tick when sym is absent (BSV-20 v1 case)', () => {
    const idx = buildIconOfIndex([
      token({ id: CUCUMBER_ID, tick: 'CUCM', icon: CUCUMBER_ICON }),
    ]);
    expect(idx.get(CUCUMBER_ICON)?.sym).toBe('CUCM');
  });

  it('keeps the first token to claim a given icon outpoint (deterministic on duplicate)', () => {
    const idx = buildIconOfIndex([
      token({ id: CUCUMBER_ID, sym: 'Cucumber', icon: CUCUMBER_ICON }),
      token({
        id: '0000000000000000000000000000000000000000000000000000000000000000_0',
        sym: 'Imposter',
        icon: CUCUMBER_ICON,
      }),
    ]);
    expect(idx.get(CUCUMBER_ICON)?.sym).toBe('Cucumber');
  });

  it('rejects malformed icon strings (not <txid>_<vout> shape)', () => {
    const idx = buildIconOfIndex([
      token({ id: CUCUMBER_ID, sym: 'X', icon: 'not-an-outpoint' }),
      token({ id: CUCUMBER_ID, sym: 'X', icon: 'abcd_0' }),
      token({ id: CUCUMBER_ID, sym: 'X', icon: `${'g'.repeat(64)}_0` }),
    ]);
    expect(idx.size).toBe(0);
  });
});

describe('lookupIconOf', () => {
  const idx = buildIconOfIndex([
    token({ id: CUCUMBER_ID, sym: 'Cucumber', icon: CUCUMBER_ICON }),
  ]);

  it('returns the iconOf for a matching outpoint', () => {
    expect(lookupIconOf(idx, CUCUMBER_ICON)).toEqual({ sym: 'Cucumber', id: CUCUMBER_ID });
  });

  it('returns undefined for a non-matching outpoint', () => {
    expect(lookupIconOf(idx, 'aaaa_0')).toBeUndefined();
  });

  it('returns undefined for an undefined outpoint', () => {
    expect(lookupIconOf(idx, undefined)).toBeUndefined();
  });
});
