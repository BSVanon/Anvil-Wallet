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
}
