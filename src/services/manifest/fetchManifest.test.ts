/**
 * BRC-73 manifest fetch + validation tests.
 *
 * Covers:
 *   - URL construction (https default, http for loopback dev,
 *     trailing-slash trim, full-URL strip)
 *   - manifest extraction (canonical metanet namespace, legacy babbage
 *     fallback, both missing)
 *   - shape validation (each permission category)
 *   - fetch happy path + failure modes (network, non-2xx, bad JSON,
 *     missing groupPermissions)
 */

import {
  buildManifestUrl,
  extractGroupPermissions,
  isValidGroupPermissions,
  fetchManifest,
} from './fetchManifest';
import type { Brc73Manifest } from '../types/brc73.types';

describe('buildManifestUrl', () => {
  it('returns https://{origin}/manifest.json for a bare domain', () => {
    expect(buildManifestUrl('anvilswap.com')).toBe('https://anvilswap.com/manifest.json');
  });

  it('preserves a provided https origin', () => {
    expect(buildManifestUrl('https://anvilswap.com')).toBe('https://anvilswap.com/manifest.json');
  });

  it('uses http for localhost loopback', () => {
    expect(buildManifestUrl('localhost:5173')).toBe('http://localhost:5173/manifest.json');
    expect(buildManifestUrl('127.0.0.1:5173')).toBe('http://127.0.0.1:5173/manifest.json');
  });

  it('trims trailing slash', () => {
    expect(buildManifestUrl('https://anvilswap.com/')).toBe('https://anvilswap.com/manifest.json');
  });

  it('strips path/query when caller passes a full URL', () => {
    expect(buildManifestUrl('https://anvilswap.com/some/page?x=1')).toBe(
      'https://anvilswap.com/manifest.json',
    );
  });

  it('returns null for empty input', () => {
    expect(buildManifestUrl('')).toBeNull();
  });
});

describe('extractGroupPermissions', () => {
  it('prefers metanet namespace over babbage', () => {
    const m: Brc73Manifest = {
      'metanet.groupPermissions': { description: 'new' },
      'babbage.groupPermissions': { description: 'old' },
    };
    expect(extractGroupPermissions(m)?.description).toBe('new');
  });

  it('falls back to babbage namespace if metanet absent', () => {
    const m: Brc73Manifest = {
      'babbage.groupPermissions': { description: 'old' },
    };
    expect(extractGroupPermissions(m)?.description).toBe('old');
  });

  it('returns null if both namespaces are missing', () => {
    expect(extractGroupPermissions({})).toBeNull();
    expect(extractGroupPermissions(null)).toBeNull();
  });

  it('skips invalid metanet slot and falls back to a valid babbage slot', () => {
    const m: Brc73Manifest = {
      'metanet.groupPermissions': { protocolPermissions: 'not an array' as unknown as never },
      'babbage.groupPermissions': { description: 'fallback' },
    };
    expect(extractGroupPermissions(m)?.description).toBe('fallback');
  });
});

describe('isValidGroupPermissions', () => {
  it('accepts an empty object (all categories optional)', () => {
    expect(isValidGroupPermissions({})).toBe(true);
  });

  it('accepts a fully-populated manifest', () => {
    expect(
      isValidGroupPermissions({
        description: 'DEX trading flows',
        protocolPermissions: [{ protocolID: [0, 'avos-mnee-buy-vault'], description: 'create vaults' }],
        spendingAuthorization: { amount: 500_000, description: '500K sats / month' },
        basketAccess: [{ basket: 'mnee-vaults', description: 'recover BSV outputs' }],
        certificateAccess: [
          {
            type: 'kyc',
            fields: ['email'],
            verifierPublicKey: '02abcd',
            description: 'identity verification',
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects malformed protocolPermissions', () => {
    expect(
      isValidGroupPermissions({ protocolPermissions: [{ protocolID: 'bad' as unknown as never, description: 'x' }] }),
    ).toBe(false);
    expect(
      isValidGroupPermissions({
        protocolPermissions: [{ protocolID: [0, 'p'] /* missing description */ } as unknown as never],
      }),
    ).toBe(false);
  });

  it('rejects malformed spendingAuthorization', () => {
    expect(isValidGroupPermissions({ spendingAuthorization: { amount: -1, description: 'x' } })).toBe(false);
    expect(
      isValidGroupPermissions({ spendingAuthorization: { amount: 'lots' as unknown as never, description: 'x' } }),
    ).toBe(false);
  });

  it('rejects malformed basketAccess / certificateAccess', () => {
    expect(isValidGroupPermissions({ basketAccess: [{ basket: 1 as unknown as never, description: 'x' }] })).toBe(
      false,
    );
    expect(
      isValidGroupPermissions({
        certificateAccess: [{ type: 'kyc', fields: [1] as unknown as never, verifierPublicKey: '02', description: 'x' }],
      }),
    ).toBe(false);
  });

  it('rejects null/undefined/non-object input', () => {
    expect(isValidGroupPermissions(null)).toBe(false);
    expect(isValidGroupPermissions(undefined)).toBe(false);
    expect(isValidGroupPermissions('string')).toBe(false);
  });
});

describe('fetchManifest', () => {
  const makeFetch = (impl: () => Promise<unknown>) =>
    (async () => impl()) as unknown as typeof fetch;

  it('returns the groupPermissions slot on a 200 with valid JSON', async () => {
    const fakeFetch = makeFetch(async () => ({
      ok: true,
      json: async () => ({
        'metanet.groupPermissions': {
          spendingAuthorization: { amount: 500_000, description: 'monthly limit' },
        },
      }),
    }));
    const gp = await fetchManifest('anvilswap.com', fakeFetch);
    expect(gp?.spendingAuthorization?.amount).toBe(500_000);
  });

  it('returns null on non-2xx', async () => {
    const fakeFetch = makeFetch(async () => ({ ok: false }));
    expect(await fetchManifest('anvilswap.com', fakeFetch)).toBeNull();
  });

  it('returns null on parse failure', async () => {
    const fakeFetch = makeFetch(async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      },
    }));
    expect(await fetchManifest('anvilswap.com', fakeFetch)).toBeNull();
  });

  it('returns null on network failure', async () => {
    const fakeFetch = makeFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await fetchManifest('anvilswap.com', fakeFetch)).toBeNull();
  });

  it('returns null when manifest is valid JSON but lacks groupPermissions', async () => {
    const fakeFetch = makeFetch(async () => ({
      ok: true,
      json: async () => ({ name: 'Some App', icon: 'icon.png' }),
    }));
    expect(await fetchManifest('anvilswap.com', fakeFetch)).toBeNull();
  });

  it('returns null for unbuildable origin', async () => {
    const fakeFetch = makeFetch(async () => ({ ok: true, json: async () => ({}) }));
    expect(await fetchManifest('', fakeFetch)).toBeNull();
  });
});
