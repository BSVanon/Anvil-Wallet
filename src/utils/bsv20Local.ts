/**
 * Local BSV-21 deploy-metadata parser.
 *
 * For BSV-21 tokens the `id` is the deploy outpoint `<txid>_<vout>`, so
 * we can derive the static fields (sym, dec, icon, deploy amt) by
 * fetching the deploy tx itself and parsing its 1Sat inscription
 * envelope — no indexer call required. Used as a fallback when
 * ordinals.gorillapool.io is degraded.
 *
 * Scope: BSV-21 only. BSV-20 v1 `tick` is a ticker string with no
 * on-chain-derivable deploy txid; the indexer is the only source for
 * those, so this helper returns undefined for non-v2 ids.
 *
 * Dynamic fields (current supply, holders, pctMinted, available mint
 * cap) still require the indexer — this helper deliberately omits them
 * rather than returning a stale or invented value. Callers should treat
 * the returned Token as "static fields only".
 *
 * 2026-04-18 wallet patch 9.
 */

import type { SPVStore } from 'spv-store';
import { Transaction } from '@bsv/sdk';
import type { Token } from '../services/types/gorillaPool.types';
import type { WhatsOnChainService } from '../services/WhatsOnChain.service';
import { getTxWithFallback } from './txFetch';
import { getBsv20v2, isBSV20v2 } from './ordi';

export async function getBsv20DetailsLocal(
  oneSatSPV: SPVStore,
  wocService: WhatsOnChainService,
  idOrTick: string,
): Promise<Partial<Token> | undefined> {
  if (!isBSV20v2(idOrTick)) return undefined;

  const [txid, voutStr] = idOrTick.split('_');
  const vout = Number(voutStr);
  if (!txid || Number.isNaN(vout)) return undefined;

  const deployTx: Transaction | undefined = await getTxWithFallback(oneSatSPV, wocService, txid);
  if (!deployTx || !deployTx.outputs[vout]) return undefined;

  try {
    const script = deployTx.outputs[vout].lockingScript;
    const deploy = getBsv20v2(script) as { op: string; amt?: string; dec?: string; sym?: string; icon?: string };
    if (deploy.op !== 'deploy+mint') return undefined;

    const decNum = deploy.dec !== undefined ? Number(deploy.dec) : 0;
    return {
      id: idOrTick,
      txid,
      vout,
      sym: deploy.sym,
      dec: Number.isFinite(decNum) ? decNum : 0,
      icon: deploy.icon,
      amt: deploy.amt,
      max: deploy.amt,
      supply: deploy.amt,
    };
  } catch {
    return undefined;
  }
}
