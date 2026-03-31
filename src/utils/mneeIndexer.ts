import { Indexer, Ingest, ParseMode, TxoStore } from 'spv-store';
import { MNEE_API, MNEE_API_TOKEN } from './constants';

type TxResult = {
  txid: string;
  outputs: number[];
  height?: number;
  idx?: number;
  time?: number;
  hash?: string;
  score?: number;
  rawtx?: string;
  senders: string[];
  receivers: string[];
};

export class MNEEIndexer extends Indexer {
  tag = 'mnee';
  name = 'MNEE';

  async sync(txoStore: TxoStore, ingestQueue: { [txid: string]: Ingest }): Promise<number> {
    if (this.network !== 'mainnet') return 0;
    const response = await fetch(`${MNEE_API}/v1/sync?auth_token=${MNEE_API_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([...this.owners]),
    });
    if (!response.ok) throw new Error(`MNEE sync failed: ${response.status}`);
    const data = await response.json() as TxResult[];
    console.log('Syncing', data.length, 'mnee for ', [...txoStore.owners]);
    let maxScore = 0;
    for (const d of data) {
      const ingest = ingestQueue[d.txid] || {
        txid: d.txid,
        height: d.height || Date.now(),
        source: 'mnee',
        idx: d.idx || 0,
        parseMode: ParseMode.PersistSummary,
      };
      ingestQueue[d.txid] = ingest;

      if (d.height && d.height < 50000000) {
        maxScore = Math.max(maxScore, d.height * 1e9 + (d.idx || 0));
      }
    }
    return maxScore;
  }
}
