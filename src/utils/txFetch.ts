/**
 * Multi-source source-transaction fetch.
 *
 * Primary: spv-store getTx (local IndexedDB cache → remote 1sat.app v5 API).
 * Fallback: WhatsOnChain raw-tx-by-txid.
 *
 * Rationale: ordinals.1sat.app is a single GorillaPool-operated endpoint.
 * When it degrades, every wallet call site that needs a sourceTransaction
 * for sighash (sending BSV, sending ordinals, contract unlock, MNEE) fails
 * with no fallback. WoC is the only non-GorillaPool public BSV endpoint
 * that exposes raw tx by txid. Fail-open to WoC matches the same "broaden
 * the single point of failure" spirit as patch 5 (fund UTXO) and patch 6
 * (broadcast).
 *
 * Note: this patch does NOT attach a merkle path on the WoC fallback path.
 * Sighash signing works without it. Attaching a TSC-format WoC proof
 * converted to BRC-74 BUMP is a candidate follow-up if BEEF construction
 * (tx.toBEEF) becomes a hard requirement in downstream broadcast.
 *
 * BRC-100 litmus: any BRC-100 wallet needs reliable sourceTransaction
 * lookup for transaction building. Generic wallet plumbing, not DEX-specific.
 *
 * 2026-04-18 wallet patch 8.
 */

import { Transaction } from '@bsv/sdk';
import type { SPVStore } from 'spv-store';
import type { WhatsOnChainService } from '../services/WhatsOnChain.service';

export async function getTxWithFallback(
  oneSatSPV: SPVStore,
  wocService: WhatsOnChainService,
  txid: string,
): Promise<Transaction | undefined> {
  try {
    const primary = await oneSatSPV.getTx(txid);
    if (primary) return primary;
  } catch (err) {
    console.warn(
      `[txFetch] spv-store.getTx threw for ${txid}: ${(err as Error).message} — falling back to WoC`,
    );
  }

  try {
    const rawHex = await wocService.getRawTxById(txid);
    if (!rawHex) return undefined;
    return Transaction.fromHex(rawHex.trim());
  } catch (err) {
    console.warn(`[txFetch] WoC fallback failed for ${txid}: ${(err as Error).message}`);
    return undefined;
  }
}
