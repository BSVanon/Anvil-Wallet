/**
 * mneeWithDataCoverage — coverage decision for sendMNEEWithData popups.
 *
 * Pins the three AVOS protocol scopes the popup accepts as sufficient
 * cover for auto-resolve, and that absence of all three falls through.
 */

import { isMneeWithDataCovered } from './mneeWithDataCoverage';
import type { CoverageRequest, CoverageResult } from './checkGroupCoverage';

const COVERED: CoverageResult = { covered: true };
const notCovered = (reason: string): CoverageResult => ({ covered: false, reason });

const checkerFor = (granted: Array<[number, string]>) => (req: CoverageRequest): CoverageResult => {
  if (req.kind !== 'protocol') return notCovered('only protocol scopes simulated');
  const [reqLevel, reqName] = req.protocolID;
  const ok = granted.some(([l, n]) => l === reqLevel && n === reqName);
  return ok ? COVERED : notCovered(`protocol ${reqLevel}/${reqName} not granted`);
};

describe('isMneeWithDataCovered', () => {
  it('covers when avos-mnee-buy-vault is granted', () => {
    const r = isMneeWithDataCovered(checkerFor([[0, 'avos-mnee-buy-vault']]));
    expect(r.covered).toBe(true);
  });

  it('covers when tm-dex-swap is granted', () => {
    const r = isMneeWithDataCovered(checkerFor([[0, 'tm-dex-swap']]));
    expect(r.covered).toBe(true);
  });

  it('covers when avos-pushtx-magic is granted', () => {
    const r = isMneeWithDataCovered(checkerFor([[0, 'avos-pushtx-magic']]));
    expect(r.covered).toBe(true);
  });

  it('covers when multiple AVOS scopes are granted', () => {
    const r = isMneeWithDataCovered(
      checkerFor([
        [0, 'avos-mnee-buy-vault'],
        [0, 'tm-dex-swap'],
      ]),
    );
    expect(r.covered).toBe(true);
  });

  it('falls through when no AVOS scope is granted', () => {
    const r = isMneeWithDataCovered(checkerFor([[0, 'unrelated-protocol']]));
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/AVOS/);
  });

  it('falls through when manifest is empty', () => {
    const r = isMneeWithDataCovered(checkerFor([]));
    expect(r.covered).toBe(false);
  });

  it('falls through when wrong security level even with matching name', () => {
    // Security-level-2 grant should NOT auto-resolve a level-0 request,
    // and vice versa. The popup uses level 0 universally for AVOS scopes.
    const r = isMneeWithDataCovered(checkerFor([[2, 'avos-mnee-buy-vault']]));
    expect(r.covered).toBe(false);
  });
});
