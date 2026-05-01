/**
 * checkGroupCoverage — per-request-kind coverage check tests.
 *
 * Covers each of the four BRC-73 permission categories (spending,
 * protocol, basket, certificate) plus the `findGrantedManifest`
 * whitelist lookup. All tests pass an explicit `now` so the rolling
 * window stays deterministic.
 */

import { checkGroupCoverage, findGrantedManifest } from './checkGroupCoverage';
import type { GrantedManifest, GroupPermissions } from '../types/brc73.types';

const T0 = 1_000_000_000_000;

const buildGranted = (perms: GroupPermissions, spentSats = 0): GrantedManifest => ({
  permissions: perms,
  grantedAt: T0,
  source: 'fetched',
  budgetUsage: { windowStartMs: T0, spentSats },
});

describe('checkGroupCoverage — no manifest', () => {
  it('returns covered=false when granted is undefined', () => {
    const r = checkGroupCoverage(undefined, { kind: 'spending', sats: 1 }, T0);
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/no manifest/);
  });
});

describe('checkGroupCoverage — spending', () => {
  it('covers a spend within the granted budget', () => {
    const g = buildGranted({ spendingAuthorization: { amount: 500_000, description: '' } });
    expect(checkGroupCoverage(g, { kind: 'spending', sats: 100_000 }, T0 + 1).covered).toBe(true);
  });

  it('falls through when manifest has no spendingAuthorization', () => {
    const g = buildGranted({});
    const r = checkGroupCoverage(g, { kind: 'spending', sats: 100 }, T0 + 1);
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/no spendingAuthorization/);
  });

  it('falls through when spend would exceed budget', () => {
    const g = buildGranted({ spendingAuthorization: { amount: 100, description: '' } }, 50);
    const r = checkGroupCoverage(g, { kind: 'spending', sats: 75 }, T0 + 1);
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/budget exhausted/);
  });
});

describe('checkGroupCoverage — protocol', () => {
  it('covers a level-1 protocol matching name', () => {
    const g = buildGranted({
      protocolPermissions: [{ protocolID: [0, 'avos-mnee-buy-vault'], description: '' }],
    });
    expect(
      checkGroupCoverage(g, { kind: 'protocol', protocolID: [0, 'avos-mnee-buy-vault'] }, T0).covered,
    ).toBe(true);
  });

  it('falls through when level mismatches', () => {
    const g = buildGranted({
      protocolPermissions: [{ protocolID: [0, 'name'], description: '' }],
    });
    expect(checkGroupCoverage(g, { kind: 'protocol', protocolID: [2, 'name'] }, T0).covered).toBe(false);
  });

  it('falls through when name mismatches', () => {
    const g = buildGranted({
      protocolPermissions: [{ protocolID: [0, 'a'], description: '' }],
    });
    expect(checkGroupCoverage(g, { kind: 'protocol', protocolID: [0, 'b'] }, T0).covered).toBe(false);
  });

  it('level-2 protocols require counterparty match', () => {
    const g = buildGranted({
      protocolPermissions: [{ protocolID: [2, 'p'], counterparty: '02aa', description: '' }],
    });
    expect(
      checkGroupCoverage(g, { kind: 'protocol', protocolID: [2, 'p'], counterparty: '02aa' }, T0).covered,
    ).toBe(true);
    expect(
      checkGroupCoverage(g, { kind: 'protocol', protocolID: [2, 'p'], counterparty: '02bb' }, T0).covered,
    ).toBe(false);
    // Counterparty omitted on a level-2 grant should not match.
    expect(checkGroupCoverage(g, { kind: 'protocol', protocolID: [2, 'p'] }, T0).covered).toBe(false);
  });
});

describe('checkGroupCoverage — basket', () => {
  it('covers a granted basket name', () => {
    const g = buildGranted({ basketAccess: [{ basket: 'mnee-vaults', description: '' }] });
    expect(checkGroupCoverage(g, { kind: 'basket', basket: 'mnee-vaults' }, T0).covered).toBe(true);
  });

  it('falls through when basket name not in granted list', () => {
    const g = buildGranted({ basketAccess: [{ basket: 'mnee-vaults', description: '' }] });
    expect(checkGroupCoverage(g, { kind: 'basket', basket: 'other' }, T0).covered).toBe(false);
  });
});

describe('checkGroupCoverage — certificate', () => {
  it('covers when type, verifier, and all requested fields match', () => {
    const g = buildGranted({
      certificateAccess: [
        { type: 'kyc', fields: ['email', 'name'], verifierPublicKey: '02aa', description: '' },
      ],
    });
    expect(
      checkGroupCoverage(
        g,
        { kind: 'certificate', type: 'kyc', fields: ['email'], verifierPublicKey: '02aa' },
        T0,
      ).covered,
    ).toBe(true);
  });

  it('falls through when a requested field is not in the granted set', () => {
    const g = buildGranted({
      certificateAccess: [
        { type: 'kyc', fields: ['email'], verifierPublicKey: '02aa', description: '' },
      ],
    });
    expect(
      checkGroupCoverage(
        g,
        { kind: 'certificate', type: 'kyc', fields: ['email', 'ssn'], verifierPublicKey: '02aa' },
        T0,
      ).covered,
    ).toBe(false);
  });

  it('falls through when verifier mismatches', () => {
    const g = buildGranted({
      certificateAccess: [
        { type: 'kyc', fields: ['email'], verifierPublicKey: '02aa', description: '' },
      ],
    });
    expect(
      checkGroupCoverage(
        g,
        { kind: 'certificate', type: 'kyc', fields: ['email'], verifierPublicKey: '02bb' },
        T0,
      ).covered,
    ).toBe(false);
  });
});

describe('findGrantedManifest', () => {
  it('returns the matching whitelist entrys groupPermissions', () => {
    const g = buildGranted({ spendingAuthorization: { amount: 1, description: '' } });
    const wl = [{ domain: 'anvilswap.com', icon: '', groupPermissions: g }];
    expect(findGrantedManifest(wl, 'anvilswap.com')).toBe(g);
  });

  it('returns undefined for unmatched domain', () => {
    const wl = [{ domain: 'a.com', icon: '' }];
    expect(findGrantedManifest(wl, 'b.com')).toBeUndefined();
  });

  it('returns undefined when whitelist or domain is missing', () => {
    expect(findGrantedManifest(undefined, 'a.com')).toBeUndefined();
    expect(findGrantedManifest([], undefined)).toBeUndefined();
  });
});
