import type { Bsv20 } from 'yours-wallet-provider';

/**
 * Map from icon-outpoint -> { sym, id } for every BSV-21 token the
 * wallet currently knows about. Lets us label NFT inscriptions whose
 * outpoint shows up as another token's icon — otherwise the wallet
 * shows "Unknown Name", which is wrong because the inscription DOES
 * have a name (it's the icon for some token in the user's holdings).
 *
 * The canonical mint pipeline is two-tx: tx1 inscribes the icon as a
 * 1-sat ordinal, tx2 deploys the BSV-21 referencing that outpoint.
 * The user holds both — the deploy/balance shows up as a Bsv20 entry,
 * the icon shows up as an NFT in the ordinals list. This index lets
 * the NFT path point back at the token name.
 */
export type IconOf = { sym: string; id: string };

const OUTPOINT_RE = /^[0-9a-fA-F]{64}_\d+$/;

export function buildIconOfIndex(bsv20s: ReadonlyArray<Bsv20> | undefined): Map<string, IconOf> {
  const out = new Map<string, IconOf>();
  if (!bsv20s) return out;
  for (const t of bsv20s) {
    const icon = t.icon;
    if (typeof icon !== 'string' || !OUTPOINT_RE.test(icon)) continue;
    const sym = t.sym || t.tick || (t.id ? `${t.id.slice(0, 8)}…` : 'token');
    if (!t.id) continue;
    if (!out.has(icon)) out.set(icon, { sym, id: t.id });
  }
  return out;
}

export function lookupIconOf(
  index: Map<string, IconOf>,
  originOutpoint: string | undefined,
): IconOf | undefined {
  if (!originOutpoint) return undefined;
  return index.get(originOutpoint);
}
