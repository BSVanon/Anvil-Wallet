/**
 * BRC-73 coverage decision for `sendMNEEWithData` requests.
 *
 * MNEE-with-data is the AVOS swap path — the dApp gives the wallet a
 * MNEE recipient + extraData (orderId / vaultIdentifier) and asks for
 * a user-half-signed transfer (broadcast or not). Two callers in
 * production today:
 *   - SPV-MNEE buy taker (`TakeMneeBuyOrderCard`) — covered by
 *     [0, 'avos-mnee-buy-vault']
 *   - AVOS swap maker MNEE leg (`maker-mnee.ts`) — covered by either
 *     [0, 'tm-dex-swap'] or [0, 'avos-pushtx-magic']
 *
 * We can't introspect WHICH AVOS flow initiated the call from the
 * popup side (the request payload is just recipients + extraData),
 * so we accept any of the three AVOS protocol grants as sufficient
 * coverage. The user already explicitly granted the bundle at
 * connect-time; this routes the call to auto-resolve instead of
 * re-prompting per-tx.
 *
 * Note: spendingAuthorization does NOT cover MNEE — that budget is
 * BSV satoshis (per BRC-73 spec, see types/brc73.types.ts:23).
 * basketAccess doesn't help either; it's about user-owned outputs,
 * not delivery recipients.
 */

import type { CoverageRequest, CoverageResult } from './checkGroupCoverage';

const AVOS_MNEE_PROTOCOLS: Array<[number, string]> = [
  [0, 'avos-mnee-buy-vault'],
  [0, 'tm-dex-swap'],
  [0, 'avos-pushtx-magic'],
];

export type CheckFn = (request: CoverageRequest) => CoverageResult;

/**
 * Returns `{covered: true}` when ANY of the AVOS protocol scopes is
 * granted in the manifest. Otherwise returns a NOT_COVERED result
 * citing the last-checked scope (purely diagnostic).
 */
export const isMneeWithDataCovered = (check: CheckFn): CoverageResult => {
  for (const protocolID of AVOS_MNEE_PROTOCOLS) {
    const r = check({ kind: 'protocol', protocolID });
    if (r.covered) return r;
  }
  return { covered: false, reason: 'no AVOS protocol grant' };
};
