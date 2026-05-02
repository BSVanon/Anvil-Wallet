/**
 * BRC-73 service-layer auth gate.
 *
 * The shape of the bypass that lives in service methods that the
 * popup-side BRC-73 auto-resolve invokes with an empty password:
 *
 *   if (!keysService.brc73Covered) {
 *     const ok = await keysService.verifyPassword(password);
 *     if (!ok) return { error: 'invalid-password' };
 *   }
 *
 * Each open instance of this pattern (Bsv.service.sendBsv,
 * Contract.service.getSignatures, Ordinal.service × 3) is a chance
 * for a future refactor to invert the condition and silently break
 * either auth (caller without coverage gets through with bad password)
 * or auto-resolve (caller WITH coverage falls into verifyPassword
 * and returns invalid-password). Codex review `8f1334b1a3c8e21a`
 * called out the test-shape gap: the upstream BRC-73 pipeline tests
 * exercise the popup → coverage → service flow but don't pin the
 * service-layer guard's polarity directly.
 *
 * Centralizing here gives:
 *   - One place to assert the gate's contract via unit tests.
 *   - One place to update if the bypass policy changes (e.g.,
 *     adding `noApprovalLimit` parity beyond the current sendBsv
 *     special case).
 *   - A type-checked seam — call sites can't drift from the canonical
 *     pattern without changing the helper signature.
 */

export interface BrcAuthKeysServiceLike {
  /** When true, the caller is acting under a granted BRC-73 manifest
   *  + coverage check; the popup-side handler set this flag before
   *  invoking the service. retrieveKeys + retrievePrivateKeyMap
   *  honor it downstream. */
  brc73Covered: boolean;
  /** Returns true iff the supplied password matches the wallet's
   *  stored hash. */
  verifyPassword: (password: string) => Promise<boolean>;
}

export interface AuthGateResult {
  ok: boolean;
  /** Why the gate failed. Always undefined on success. Callers
   *  typically map this onto `{ error: 'invalid-password' }`. */
  reason?: 'invalid-password';
}

/**
 * The single source of truth for "is this service-layer call
 * authorized?" Returns `{ok: true}` on either:
 *   1. BRC-73 covered — popup auto-resolved under a granted manifest.
 *   2. Password verified — manual approval flow with correct password.
 * Otherwise `{ok: false, reason: 'invalid-password'}`.
 *
 * Service methods use it as a one-line check at the top of their
 * try block, replacing the inlined `if (!brc73Covered) verifyPassword`
 * pattern that was previously copy-pasted across 5 service entry
 * points (Bsv.sendBsv, Contract.getSignatures, Ordinal × 3).
 */
export async function checkServiceAuth(
  keysService: BrcAuthKeysServiceLike,
  password: string,
): Promise<AuthGateResult> {
  if (keysService.brc73Covered) return { ok: true };
  const verified = await keysService.verifyPassword(password);
  if (!verified) return { ok: false, reason: 'invalid-password' };
  return { ok: true };
}
