/**
 * Tests for the BSV-21 refresh-policy gate. The 2026-05-02 cucumber
 * regression hinged on the wrong policy here (skipping cache writes
 * on empty results); these tests pin the corrected behavior so it
 * can't drift again.
 */

import { shouldOverwriteBsv20sCache } from './bsv20RefreshPolicy';

describe('shouldOverwriteBsv20sCache', () => {
  it('returns true for an empty array (legitimate zero-holdings result from GP)', () => {
    // The cucumber regression: after the deploy UTXO was consumed,
    // GP correctly returned [], but the wallet ignored it and kept
    // showing the pre-drain 21M balance. This case must overwrite.
    expect(shouldOverwriteBsv20sCache([])).toBe(true);
  });

  it('returns true for a non-empty array', () => {
    expect(
      shouldOverwriteBsv20sCache([
        { id: 'tokenA', tick: 'TICKA', sym: 'A' },
      ]),
    ).toBe(true);
  });

  it('returns false for undefined (no fetch result yet)', () => {
    expect(shouldOverwriteBsv20sCache(undefined)).toBe(false);
  });

  it('returns false for null (defensive against legacy shapes)', () => {
    expect(shouldOverwriteBsv20sCache(null)).toBe(false);
  });

  it('returns false for non-array values (defensive against malformed responses)', () => {
    expect(shouldOverwriteBsv20sCache('error')).toBe(false);
    expect(shouldOverwriteBsv20sCache({ entries: [] })).toBe(false);
    expect(shouldOverwriteBsv20sCache(0)).toBe(false);
  });
});
