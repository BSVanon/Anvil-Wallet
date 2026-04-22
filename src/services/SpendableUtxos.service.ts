/**
 * Shared spendable-UTXO resolver for fund-UTXO reads.
 *
 * Single source of truth for "what UTXOs at this address are safe to
 * spend as fungible BSV?" Replaces the duplicated spv-store→WoC
 * logic that lived inline in Bsv.service.fundingTxos and
 * background.ts processGetPaymentUtxosRequest.
 *
 * Ordered failover (NOT race, NOT merge):
 *
 *   1. spv-store fund basket — ordinal-aware via indexer baskets.
 *      Non-empty + on-time → trusted, returned.
 *
 *   2. GorillaPool address unspent with `bsv20=false` — ordinal-
 *      aware via server-side filter. Non-empty → trusted, returned.
 *
 *   3. WhatsOnChain address unspent — independent operator. Every
 *      result filtered through isSpendableFungibleScript
 *      (bare P2PKH whitelist + relaxed "ord" marker scan). Fail-
 *      closed: unknown script → excluded.
 *
 * Each tier has an 8-second timeout before failing through. Empty
 * results at tier 1 or 2 fall through to the next tier (a "truly
 * empty" wallet only appears once WoC also returns zero).
 *
 * See docs/WALLET_PROVIDER_AUDIT.md for the design rationale + the
 * real-MNEE fixture that validates the filter composition.
 */

import type { SPVStore } from 'spv-store';
import { TxoLookup, TxoSort } from 'spv-store';
import type { GorillaPoolService } from './GorillaPool.service';
import type { WhatsOnChainService } from './WhatsOnChain.service';
import { isSpendableFungibleScript } from './utils/fungibility';

export interface FundUtxo {
  txid: string;
  vout: number;
  satoshis: bigint;
  /** Lowercase hex. */
  scriptHex: string;
  /** Which tier produced this UTXO — useful for diagnostics. */
  source: 'spv-store' | 'gorillapool' | 'woc';
}

export interface SpendableUtxoDeps {
  spv: SPVStore;
  gorilla: GorillaPoolService;
  woc: WhatsOnChainService;
}

const TIER_TIMEOUT_MS = 8_000;

type RaceResult<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' | 'error'; message?: string };

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<RaceResult<T>> {
  try {
    const timeout = new Promise<'__timeout__'>((resolve) =>
      setTimeout(() => resolve('__timeout__'), ms),
    );
    const result = await Promise.race([p, timeout]);
    if (result === '__timeout__') return { ok: false, reason: 'timeout' };
    return { ok: true, value: result as T };
  } catch (e) {
    return { ok: false, reason: 'error', message: (e as Error).message };
  }
}

function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Tier 1: spv-store's local fund basket. Ordinal-aware because
 * indexers segregate outputs into baskets at sync time.
 */
async function trySpvStore(
  spv: SPVStore,
): Promise<FundUtxo[] | null> {
  const result = await withTimeout(
    spv.search(new TxoLookup('fund'), TxoSort.ASC, 0),
    TIER_TIMEOUT_MS,
  );
  if (!result.ok) {
    if (result.reason === 'timeout') {
      console.warn('[SpendableUtxos] spv-store tier timed out after', TIER_TIMEOUT_MS, 'ms');
    } else {
      console.warn('[SpendableUtxos] spv-store tier threw:', result.message);
    }
    return null;
  }
  const txos = result.value.txos;
  if (txos.length === 0) {
    console.warn('[SpendableUtxos] spv-store returned empty — falling through to GorillaPool');
    return null;
  }
  return txos.map((t) => ({
    txid: t.outpoint.txid,
    vout: t.outpoint.vout,
    satoshis: BigInt(t.satoshis),
    scriptHex: bytesToHex(t.script as unknown as number[]),
    source: 'spv-store' as const,
  }));
}

/**
 * Tier 2: GorillaPool's address-unspent with server-side ordinal
 * exclusion (`bsv20=false`). Still applies the local fail-closed
 * filter as defense-in-depth in case GP's classification misses
 * something.
 */
async function tryGorillaPool(
  gorilla: GorillaPoolService,
  address: string,
): Promise<FundUtxo[] | null> {
  const result = await withTimeout(
    gorilla.getFundUtxosByAddress(address),
    TIER_TIMEOUT_MS,
  );
  if (!result.ok) {
    if (result.reason === 'timeout') {
      console.warn('[SpendableUtxos] GorillaPool tier timed out after', TIER_TIMEOUT_MS, 'ms');
    } else {
      console.warn('[SpendableUtxos] GorillaPool tier threw:', result.message);
    }
    return null;
  }
  const rows = result.value;
  if (rows.length === 0) {
    console.warn('[SpendableUtxos] GorillaPool returned empty — falling through to WoC');
    return null;
  }
  // Apply local filter as defense-in-depth even though GP already
  // excluded bsv20=true outputs server-side. Costs nothing if GP is
  // doing its job; catches everything if it isn't.
  const filtered = rows.filter((r) => isSpendableFungibleScript(r.scriptHex));
  if (filtered.length !== rows.length) {
    console.warn(
      `[SpendableUtxos] GorillaPool: local filter dropped ${rows.length - filtered.length} of ${rows.length} outputs`,
    );
  }
  if (filtered.length === 0) return null;
  return filtered.map((r) => ({
    txid: r.txid,
    vout: r.vout,
    satoshis: BigInt(r.satoshis),
    scriptHex: r.scriptHex.toLowerCase(),
    source: 'gorillapool' as const,
  }));
}

/**
 * Tier 3: WhatsOnChain. Independent operator, no ordinal awareness.
 * Every result MUST pass the local fail-closed filter
 * (isSpendableFungibleScript). Unknown script → excluded.
 */
async function tryWoC(
  woc: WhatsOnChainService,
  address: string,
): Promise<FundUtxo[]> {
  const result = await withTimeout(
    woc.getUtxosByAddress(address),
    TIER_TIMEOUT_MS,
  );
  if (!result.ok) {
    if (result.reason === 'timeout') {
      console.warn('[SpendableUtxos] WoC tier timed out after', TIER_TIMEOUT_MS, 'ms');
    } else {
      console.warn('[SpendableUtxos] WoC tier threw:', result.message);
    }
    return [];
  }
  const rows = result.value;
  const filtered = rows.filter((r) => isSpendableFungibleScript(r.scriptHex));
  if (filtered.length !== rows.length) {
    console.warn(
      `[SpendableUtxos] WoC: fail-closed filter dropped ${rows.length - filtered.length} of ${rows.length} outputs`,
    );
  }
  return filtered.map((r) => ({
    txid: r.txid,
    vout: r.vout,
    satoshis: BigInt(r.satoshis),
    scriptHex: r.scriptHex.toLowerCase(),
    source: 'woc' as const,
  }));
}

/**
 * Resolve spendable fund UTXOs for `address` via the 3-tier chain.
 * Ordered failover: tier N is only consulted if tier N-1 returned
 * null (empty / timeout / error). Tier 3 (WoC) is the last tier;
 * its result is returned even if empty (truly empty wallet).
 *
 * Filter invariants (fail-closed):
 *   - spv-store results are trusted (indexer basket segregation).
 *   - GorillaPool results pass through isSpendableFungibleScript.
 *   - WoC results pass through isSpendableFungibleScript.
 *
 * Never includes a UTXO whose script fails the bare-P2PKH whitelist
 * OR contains the "ord" push (the 1Sat / MNEE ordinal marker).
 */
export async function getSpendableFundUtxos(
  address: string,
  deps: SpendableUtxoDeps,
): Promise<FundUtxo[]> {
  // Tier 1 — spv-store
  const tier1 = await trySpvStore(deps.spv);
  if (tier1 !== null) return tier1;

  // Tier 2 — GorillaPool (ordinal-aware)
  const tier2 = await tryGorillaPool(deps.gorilla, address);
  if (tier2 !== null) return tier2;

  // Tier 3 — WhatsOnChain + fail-closed filter. Last resort; result
  // is returned even if empty (truly empty wallet).
  return tryWoC(deps.woc, address);
}
