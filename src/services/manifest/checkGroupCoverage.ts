/**
 * BRC-73 coverage check — given a granted manifest and a candidate
 * operation, returns whether the operation can skip the per-tx prompt.
 *
 * Used by every page in `src/pages/requests/` (except ConnectRequest,
 * which is what grants the manifest in the first place, and
 * BroadcastRequest, which is excluded — see notes below). When the
 * helper returns `covered: true`, the request page auto-resolves
 * without showing the approval UI.
 *
 * Coverage by request kind:
 *   - spending     — checked against spendingAuthorization budget +
 *                    rolling-window usage
 *   - protocol     — requested protocolID + counterparty must match an
 *                    entry in protocolPermissions[]
 *   - basket       — requested basket name must match an entry in
 *                    basketAccess[]
 *   - certificate  — type + verifierPublicKey + every requested field
 *                    must be covered by an entry in certificateAccess[]
 *
 * BroadcastRequest is intentionally NOT covered — the wallet relays a
 * raw tx that the user hasn't reviewed, and BRC-73 has no category for
 * it. Path 1 daemon flows go through createAction (sign + broadcast in
 * one call, covered by spending), not a standalone broadcast.
 */

import type { GrantedManifest } from '../types/brc73.types';
import { canSpend } from './budgetTracker';

export type CoverageRequest =
  | { kind: 'spending'; sats: number }
  | { kind: 'protocol'; protocolID: [number, string]; counterparty?: string }
  | { kind: 'basket'; basket: string }
  | { kind: 'certificate'; type: string; fields: string[]; verifierPublicKey: string };

export type CoverageResult = {
  covered: boolean;
  /**
   * Why the request fell through to the per-tx prompt. Empty when
   * `covered` is true. Used for diagnostic logging only — not shown
   * to the user (the prompt itself is the user-visible feedback).
   */
  reason?: string;
};

const NOT_COVERED = (reason: string): CoverageResult => ({ covered: false, reason });
const COVERED: CoverageResult = { covered: true };

export const checkGroupCoverage = (
  granted: GrantedManifest | undefined,
  request: CoverageRequest,
  now: number = Date.now(),
): CoverageResult => {
  if (!granted) return NOT_COVERED('no manifest granted');
  const perms = granted.permissions;

  switch (request.kind) {
    case 'spending': {
      if (!perms.spendingAuthorization) return NOT_COVERED('no spendingAuthorization granted');
      if (!canSpend(granted, request.sats, now)) return NOT_COVERED('budget exhausted');
      return COVERED;
    }

    case 'protocol': {
      const list = perms.protocolPermissions ?? [];
      const [reqLevel, reqName] = request.protocolID;
      for (const p of list) {
        const [pLevel, pName] = p.protocolID;
        if (pLevel !== reqLevel) continue;
        if (pName !== reqName) continue;
        // Level 2 protocols require counterparty to match exactly.
        if (reqLevel === 2) {
          if (!p.counterparty || !request.counterparty) continue;
          if (p.counterparty !== request.counterparty) continue;
        }
        return COVERED;
      }
      return NOT_COVERED(`protocol ${reqLevel}/${reqName} not in granted set`);
    }

    case 'basket': {
      const list = perms.basketAccess ?? [];
      if (list.some((b) => b.basket === request.basket)) return COVERED;
      return NOT_COVERED(`basket "${request.basket}" not in granted set`);
    }

    case 'certificate': {
      const list = perms.certificateAccess ?? [];
      for (const c of list) {
        if (c.type !== request.type) continue;
        if (c.verifierPublicKey !== request.verifierPublicKey) continue;
        // Every requested field must be in the granted field list.
        const granted = new Set(c.fields);
        if (request.fields.every((f) => granted.has(f))) return COVERED;
      }
      return NOT_COVERED('certificate type/verifier/fields not fully covered');
    }
  }
};

/**
 * Look up a granted manifest for a given app domain in the current
 * account's whitelist. Returns undefined if the app isn't whitelisted
 * or hasn't granted any group permissions.
 */
export const findGrantedManifest = <T extends { domain: string; groupPermissions?: GrantedManifest }>(
  whitelist: T[] | undefined,
  domain: string | undefined,
): GrantedManifest | undefined => {
  if (!whitelist || !domain) return undefined;
  const entry = whitelist.find((w) => w.domain === domain);
  return entry?.groupPermissions;
};
