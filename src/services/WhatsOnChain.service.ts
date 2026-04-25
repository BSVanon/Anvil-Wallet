import { NetWork } from 'yours-wallet-provider';
import { WOC_BASE_URL, WOC_TESTNET_BASE_URL } from '../utils/constants';
import { ChromeStorageService } from './ChromeStorage.service';
import { UTXO } from './types/bsv.types';
import { ChainInfo } from './types/whatsOnChain.types';

export class WhatsOnChainService {
  apiKey: string;
  config: { headers: { 'woc-api-key': string } };
  constructor(private readonly chromeStorageService: ChromeStorageService) {
    this.apiKey = process.env.REACT_APP_WOC_API_KEY as string;
    this.config = {
      headers: {
        'woc-api-key': this.apiKey,
      },
    };
  }

  getBaseUrl = (network: NetWork) => {
    return network === NetWork.Mainnet ? WOC_BASE_URL : WOC_TESTNET_BASE_URL;
  };

  getExchangeRate = async (): Promise<number | undefined> => {
    const network = this.chromeStorageService.getNetwork();
    const { exchangeRateCache } = this.chromeStorageService.getCurrentAccountObject();
    try {
      if (exchangeRateCache?.rate && Date.now() - exchangeRateCache.timestamp < 5 * 60 * 1000) {
        return Number(exchangeRateCache.rate.toFixed(2));
      } else {
        const res = await fetch(`${this.getBaseUrl(network)}/exchangerate`, { headers: this.config.headers });
        if (!res.ok) throw new Error('Could not fetch exchange rate from WOC!');
        const data = await res.json();

        const rate = Number(data.rate.toFixed(2));
        const currentTime = Date.now();
        await this.chromeStorageService.update({ exchangeRateCache: { rate, timestamp: currentTime } });
        return rate;
      }
    } catch (error) {
      console.log(error);
    }
  };

  /**
   * Cross-check a txid's confirmation status directly against WoC.
   * Used to reconcile stale `TxLog.height = 0` rows whose spv-store
   * local view missed the confirmation event. WoC's `/tx/hash/{txid}`
   * returns `blockheight` + `blocktime` for mined txs; mempool txs
   * omit those fields.
   *
   * Phase 2.5 final-polish extension: also returns `userOutputSats`
   * — the sum of vout values that pay the caller's `userAddresses`.
   * For a self-send this equals the full tx value (all outputs are
   * the user's). For pure receives, it's the receive amount. For
   * sends to others it's the change amount only (input lookup would
   * be needed for a true net-delta but that's per-input WoC fetches —
   * deferred). Robert click-test 2026-04-25: WoC tier-3 rows showed
   * $0 placeholder; this extension lets the Activity tab display a
   * useful approximation for at least receives + self-sends.
   *
   * Returns:
   *   - `{ confirmed: true, blockHeight, blockTime, userOutputSats? }`
   *     when the tx is mined and WoC knows about it.
   *   - `{ confirmed: false, userOutputSats? }` when WoC knows the tx
   *     but it's unconfirmed.
   *   - `undefined` when WoC couldn't be reached or the tx is
   *     genuinely unknown (don't show stale-sync banner in that case).
   */
  getTxStatus = async (
    txid: string,
    userAddresses?: string[],
  ): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    blockTime?: number;
    userOutputSats?: number;
  } | undefined> => {
    if (!txid || !/^[0-9a-fA-F]{64}$/.test(txid)) return undefined;
    try {
      const network = this.chromeStorageService.getNetwork();
      const res = await fetch(`${this.getBaseUrl(network)}/tx/hash/${txid}`, {
        headers: this.config.headers,
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as {
        blockheight?: number;
        blocktime?: number;
        vout?: Array<{
          value?: number;
          scriptPubKey?: { addresses?: string[] };
        }>;
      };
      // Sum vout values whose scriptPubKey.addresses includes any of
      // the caller's userAddresses. WoC's `value` is BSV (decimal),
      // convert to sats. Skip if userAddresses not provided.
      let userOutputSats: number | undefined;
      if (userAddresses && userAddresses.length > 0 && Array.isArray(data.vout)) {
        const addrSet = new Set(userAddresses);
        let sumBsv = 0;
        for (const vout of data.vout) {
          const addrs = vout?.scriptPubKey?.addresses ?? [];
          if (addrs.some((a) => addrSet.has(a))) {
            sumBsv += Number(vout.value ?? 0);
          }
        }
        if (sumBsv > 0) userOutputSats = Math.round(sumBsv * 1e8);
      }
      if (typeof data.blockheight === 'number' && data.blockheight > 0) {
        return {
          confirmed: true,
          blockHeight: data.blockheight,
          blockTime: typeof data.blocktime === 'number' ? data.blocktime : undefined,
          userOutputSats,
        };
      }
      return { confirmed: false, userOutputSats };
    } catch {
      return undefined;
    }
  };

  /**
   * Tier-3 fallback for Activity history. spv-store register failure
   * (1sat.app degraded) breaks ordinal/tx-log sync; GP's
   * /api/txos/address/.../history endpoint lags on incoming receives.
   * WoC's `/address/{addr}/history` returns confirmed (txid, height)
   * pairs and is independently operated, so it catches what the other
   * two miss (Robert click-test 2026-04-25: BSV self-send missing
   * from Activity even though balance reflected it).
   *
   * Returns just txid + height — amount accounting is left to
   * subsequent enrichment via `getTxStatus` + the WoC reconciliation
   * effect. UI shows "(amount unknown)" for these rows until
   * spv-store catches up.
   */
  getAddressHistory = async (
    address: string,
  ): Promise<Array<{ tx_hash: string; height?: number }>> => {
    if (!address) return [];
    try {
      const network = this.chromeStorageService.getNetwork();
      const res = await fetch(
        `${this.getBaseUrl(network)}/address/${address}/history`,
        { headers: this.config.headers },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as Array<{ tx_hash: string; height?: number }>;
      if (!Array.isArray(data)) return [];
      return data;
    } catch {
      return [];
    }
  };

  getRawTxById = async (txid: string): Promise<string | undefined> => {
    try {
      const network = this.chromeStorageService.getNetwork();
      const res = await fetch(`${this.getBaseUrl(network)}/tx/${txid}/hex`, { headers: this.config.headers });
      if (!res.ok) throw new Error(`Failed to get raw tx: ${res.status}`);
      return res.text();
    } catch (error) {
      console.log(error);
    }
  };

  broadcastRawTx = async (txhex: string): Promise<string | undefined> => {
    try {
      const network = this.chromeStorageService.getNetwork();
      const res = await fetch(`${this.getBaseUrl(network)}/tx/raw`, {
        method: 'POST',
        headers: { ...this.config.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ txhex }),
      });
      if (!res.ok) {
        const errorBody = await res.text().catch(() => 'unknown');
        console.error('broadcast rawtx failed:', errorBody);
        return;
      }
      return res.json();
    } catch (error) {
      console.error('broadcast rawtx failed:', error);
    }
  };

  getSuitableUtxo = (utxos: UTXO[], minimum: number) => {
    const suitableUtxos = utxos.filter((utxo) => utxo.satoshis > minimum);

    if (suitableUtxos.length === 0) {
      throw new Error('No UTXO large enough for this transaction');
    }
    // Select a random UTXO from the suitable ones
    const randomIndex = Math.floor(Math.random() * suitableUtxos.length);
    return suitableUtxos[randomIndex];
  };

  getInputs = (utxos: UTXO[], satsOut: number, isSendAll: boolean) => {
    if (isSendAll) return utxos;
    let sum = 0;
    let index = 0;
    const inputs: UTXO[] = [];

    while (sum <= satsOut) {
      const utxo = utxos[index];
      sum += utxo.satoshis;
      inputs.push(utxo);
      index++;
    }
    return inputs;
  };

  getChainInfo = async (): Promise<ChainInfo | undefined> => {
    try {
      const network = this.chromeStorageService.getNetwork();
      const res = await fetch(`${this.getBaseUrl(network)}/chain/info`, { headers: this.config.headers });
      if (!res.ok) throw new Error(`Failed to get chain info: ${res.status}`);
      return await res.json() as ChainInfo;
    } catch (error) {
      console.log(error);
    }
  };

  /**
   * Fallback UTXO-by-address query. Used when the primary spv-store index
   * is unreachable / degraded. Returns raw WoC unspent outputs enriched
   * with the per-output locking-script hex (fetched from the source tx).
   *
   * Callers that need ordinal-safe filtering must apply an inscription-
   * envelope check on each scriptHex before treating the output as
   * fungible (see isLikelyInscription in Bsv.service). WoC does NOT tag
   * ordinal status — callers are responsible for fail-closed handling.
   */
  getUtxosByAddress = async (
    address: string,
  ): Promise<Array<{ txid: string; vout: number; satoshis: number; scriptHex: string }>> => {
    const network = this.chromeStorageService.getNetwork();
    const unspentRes = await fetch(`${this.getBaseUrl(network)}/address/${address}/unspent`, {
      headers: this.config.headers,
    });
    if (!unspentRes.ok) throw new Error(`WoC unspent ${address}: ${unspentRes.status}`);
    const unspent = (await unspentRes.json()) as Array<{ tx_hash: string; tx_pos: number; value: number }>;
    const out: Array<{ txid: string; vout: number; satoshis: number; scriptHex: string }> = [];
    for (const u of unspent) {
      // Fetch raw hex so we can extract the locking script bytes for
      // inscription-envelope inspection. Caching happens at the browser /
      // spv-store layer on successful paths; this is the fallback so a
      // per-item fetch is acceptable.
      const hexRes = await fetch(`${this.getBaseUrl(network)}/tx/${u.tx_hash}/hex`, { headers: this.config.headers });
      if (!hexRes.ok) throw new Error(`WoC tx hex ${u.tx_hash}: ${hexRes.status}`);
      const rawHex = (await hexRes.text()).trim();
      // Lightweight script extraction: parse the tx and grab the vout's locking script.
      const tx = (await import('@bsv/sdk')).Transaction.fromHex(rawHex);
      const output = tx.outputs[u.tx_pos];
      if (!output) continue;
      out.push({
        txid: u.tx_hash,
        vout: u.tx_pos,
        satoshis: u.value,
        scriptHex: (output.lockingScript as unknown as { toHex: () => string }).toHex(),
      });
    }
    return out;
  };
}
