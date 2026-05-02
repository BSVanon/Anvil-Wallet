/**
 * checkServiceAuth — the BRC-73 service-layer gate.
 *
 * These tests pin the polarity Codex flagged in review
 * `8f1334b1a3c8e21a`. Each shipped bypass (Bsv.sendBsv,
 * Contract.getSignatures, Ordinal.purchase / transferOrdinal /
 * sendBSV20) now delegates to this helper, so a single regression
 * here would trip every service-layer test that calls through.
 */

import { checkServiceAuth, type BrcAuthKeysServiceLike } from './authGate';

const makeKeysService = (opts: {
  brc73Covered: boolean;
  validPassword: string;
}): BrcAuthKeysServiceLike & { verifyCalls: number } => {
  const ks = {
    brc73Covered: opts.brc73Covered,
    verifyCalls: 0,
    verifyPassword: async (password: string) => {
      ks.verifyCalls += 1;
      return password === opts.validPassword;
    },
  };
  return ks;
};

describe('checkServiceAuth — BRC-73 service-layer gate', () => {
  it('passes when brc73Covered is true, regardless of password', async () => {
    const ks = makeKeysService({ brc73Covered: true, validPassword: 'real-pw' });
    // Auto-resolve flow uses an empty password.
    const result = await checkServiceAuth(ks, '');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    // Critical: verifyPassword MUST NOT be called when covered.
    // Calling it with the empty auto-resolve password would always
    // return false and break the bypass.
    expect(ks.verifyCalls).toBe(0);
  });

  it('passes when brc73Covered is true and a wrong password is supplied', async () => {
    // Defensive — if any caller mistakenly passes a non-empty wrong
    // password while brc73Covered is set, coverage still wins.
    const ks = makeKeysService({ brc73Covered: true, validPassword: 'real-pw' });
    const result = await checkServiceAuth(ks, 'wrong-pw');
    expect(result.ok).toBe(true);
    expect(ks.verifyCalls).toBe(0);
  });

  it('passes when brc73Covered is false but password is valid', async () => {
    const ks = makeKeysService({ brc73Covered: false, validPassword: 'real-pw' });
    const result = await checkServiceAuth(ks, 'real-pw');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    // Manual flow MUST exercise verifyPassword.
    expect(ks.verifyCalls).toBe(1);
  });

  it('fails with invalid-password when brc73Covered is false and password is wrong', async () => {
    const ks = makeKeysService({ brc73Covered: false, validPassword: 'real-pw' });
    const result = await checkServiceAuth(ks, 'wrong-pw');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-password');
    expect(ks.verifyCalls).toBe(1);
  });

  it('fails with invalid-password when brc73Covered is false and password is empty', async () => {
    // The exact regression scenario: a popup auto-resolves with empty
    // password, but if it somehow runs without setting brc73Covered
    // first, the verifyPassword check rejects the empty string.
    const ks = makeKeysService({ brc73Covered: false, validPassword: 'real-pw' });
    const result = await checkServiceAuth(ks, '');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-password');
    expect(ks.verifyCalls).toBe(1);
  });

  // Polarity inversion regression — the most important contract.
  it('NEVER passes when brc73Covered=false AND password is wrong (inversion-bug guard)', async () => {
    // If a future refactor flipped the gate's polarity (e.g.
    // `if (keysService.brc73Covered)` instead of `if (!keysService.brc73Covered)`),
    // this case would silently flip from rejecting bad passwords on
    // the manual flow to accepting them. This test pins the polarity.
    const ks = makeKeysService({ brc73Covered: false, validPassword: 'real-pw' });
    const result = await checkServiceAuth(ks, 'wrong-pw');
    expect(result.ok).toBe(false);
  });
});
