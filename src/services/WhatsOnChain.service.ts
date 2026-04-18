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
