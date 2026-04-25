import { Bsv20, BSV20Txo, NetWork, Ordinal } from 'yours-wallet-provider';
import { GP_BASE_URL, GP_TESTNET_BASE_URL } from '../utils/constants';
import { MarketResponse, Token } from './types/gorillaPool.types';
import { GpOrdinalRow } from './types/gorillaPool.ordinal';
import { ChromeStorageService } from './ChromeStorage.service';
import type { SPVStore } from 'spv-store';
import type { WhatsOnChainService } from './WhatsOnChain.service';
import { isBSV20v2 } from '../utils/ordi';
import { getBsv20DetailsLocal } from '../utils/bsv20Local';

export class GorillaPoolService {
  private oneSatSPV: SPVStore | null = null;
  private wocService: WhatsOnChainService | null = null;

  constructor(private readonly chromeStorageService: ChromeStorageService) {}

  // Wired post-construction to avoid a circular-dep in the service graph
  // (GorillaPool is instantiated before oneSatSPV finishes initializing).
  setLocalFallbackDeps = (oneSatSPV: SPVStore, wocService: WhatsOnChainService) => {
    this.oneSatSPV = oneSatSPV;
    this.wocService = wocService;
  };
  getBaseUrl(network: NetWork) {
    return network === NetWork.Mainnet ? GP_BASE_URL : GP_TESTNET_BASE_URL;
  }

  getUtxoByOutpoint = async (outpoint: string): Promise<Ordinal> => {
    try {
      const network = this.chromeStorageService.getNetwork();
      const res = await fetch(`${this.getBaseUrl(network)}/api/txos/${outpoint}?script=true`);
      if (!res.ok) throw new Error(`Failed to fetch outpoint: ${res.status}`);
      const ordUtxo: Ordinal = await res.json();
      if (!ordUtxo.script) throw Error('No script when fetching by outpoint');
      return ordUtxo;
    } catch (e) {
      throw new Error(JSON.stringify(e));
    }
  };

  /**
   * Fetch address-level tx history (spent + unspent outputs) from
   * GorillaPool. Used by the TxHistory fallback path when spv-store's
   * local tx log is empty because sync was aborted (ordinals.1sat.app
   * outage). Display-only — no spending depends on this data.
   *
   * `/api/txos/address/{addr}/history` returns one row per output
   * ever seen at the address. Callers aggregate by txid to form
   * TxLog-compatible records.
   */
  getTxHistoryByAddress = async (
    address: string,
    limit = 100,
  ): Promise<Array<GpOrdinalRow>> => {
    const network = this.chromeStorageService.getNetwork();
    const res = await fetch(
      `${this.getBaseUrl(network)}/api/txos/address/${address}/history?limit=${limit}`,
    );
    if (!res.ok) throw new Error(`GP address history: HTTP ${res.status}`);
    const rows = (await res.json()) as GpOrdinalRow[];
    return Array.isArray(rows) ? rows : [];
  };

  /**
   * Fetch inscription-bearing (ordinal) UTXOs at an address. Used as
   * the fallback source for OrdinalService.getOrdinals when spv-store
   * is degraded and can't surface the user's NFTs locally.
   *
   * GP's `/api/txos/address/{addr}/unspent` returns all UTXOs; filter
   * for `origin != null` on the client to isolate ordinal-bearing
   * outputs. The response shape is directly compatible with the
   * Ordinal type via a small mapping (see mapGpOrdinalRow below).
   *
   * Returns the raw GP rows — caller is expected to normalize via the
   * wallet's Ordinal shape. We keep the raw shape here to avoid
   * circular deps with yours-wallet-provider types.
   */
  getOrdinalUtxosByAddress = async (
    address: string,
  ): Promise<Array<GpOrdinalRow>> => {
    const network = this.chromeStorageService.getNetwork();
    const res = await fetch(
      `${this.getBaseUrl(network)}/api/txos/address/${address}/unspent?limit=200`,
    );
    if (!res.ok) {
      throw new Error(`GP address unspent (ord): HTTP ${res.status}`);
    }
    const rows = (await res.json()) as GpOrdinalRow[];
    if (!Array.isArray(rows)) return [];
    // Only outputs with an inscription origin — that's what "ordinal"
    // means here. Fund UTXOs have origin=null and are handled by the
    // SpendableUtxos resolver via a different endpoint.
    return rows.filter((r) => r && r.origin != null);
  };

  /**
   * Fetch unspent fund UTXOs (non-ordinal BSV) at an address, with
   * locking-script hex included. Used by the SpendableUtxos resolver
   * as the second tier of the failover chain (primary is spv-store's
   * local fund basket; this is hit when spv-store is degraded).
   *
   * GorillaPool exposes ordinal-aware filtering server-side via
   * `bsv20=false`: outputs bearing BSV-20/21 inscriptions are
   * excluded at the indexer. That plus the resolver's local
   * fail-closed filter makes this a safe ordinal-aware source.
   *
   * Two-stage fetch:
   *   1) GET /api/txos/address/{addr}/unspent?bsv20=false → outpoints
   *      + satoshis (no script in this response).
   *   2) For each outpoint: GET /api/txos/{outpoint}?script=true →
   *      base64-encoded script, decode to hex. Parallel, bounded by
   *      the address-list length.
   *
   * Per-call timeouts are the caller's responsibility — wrap this in
   * a Promise.race() with a timeout sentinel in the resolver.
   */
  getFundUtxosByAddress = async (
    address: string,
  ): Promise<Array<{ txid: string; vout: number; satoshis: number; scriptHex: string }>> => {
    const network = this.chromeStorageService.getNetwork();
    const listRes = await fetch(
      `${this.getBaseUrl(network)}/api/txos/address/${address}/unspent?bsv20=false&limit=200`,
    );
    if (!listRes.ok) {
      throw new Error(`GP address unspent: HTTP ${listRes.status}`);
    }
    const rows = (await listRes.json()) as Array<{
      txid: string;
      vout: number;
      outpoint: string;
      satoshis: number;
    }>;
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const fetched = await Promise.all(
      rows.map(async (row) => {
        try {
          const r = await fetch(
            `${this.getBaseUrl(network)}/api/txos/${row.outpoint}?script=true`,
          );
          if (!r.ok) return null;
          const data = (await r.json()) as { script?: string };
          if (!data.script) return null;
          // GorillaPool returns base64; our filter + wallet primitives work in hex.
          const scriptHex = Buffer.from(data.script, 'base64').toString('hex');
          return {
            txid: row.txid,
            vout: row.vout,
            satoshis: Number(row.satoshis),
            scriptHex,
          };
        } catch {
          return null;
        }
      }),
    );
    return fetched.filter((x): x is NonNullable<typeof x> => x !== null);
  };

  getTokenPriceInSats = async (tokenIds: string[]) => {
    const network = this.chromeStorageService.getNetwork();
    const result: { id: string; satPrice: number }[] = [];
    for (const tokenId of tokenIds) {
      const res = await fetch(
        `${this.getBaseUrl(network)}/api/bsv20/market?sort=price_per_token&dir=asc&limit=1&offset=0&${
          tokenId.length > 30 ? 'id' : 'tick'
        }=${tokenId}`,
      );
      if (!res.ok) throw new Error(`Failed to fetch token price: ${res.status}`);
      const data = await res.json() as MarketResponse[];
      if (data.length > 0) {
        result.push({ id: tokenId, satPrice: data[0].pricePer });
      }
    }
    return result;
  };

  /**
   * Fetch BSV-21 token metadata for a single token id and extract any
   * icon URL from the deploy tx's inscription JSON. GP's
   * `/api/bsv20/balance` endpoint returns `icon: null` for many tokens
   * even when the deploy tx's inscription includes one — the icon
   * lives at `data.insc.json.icon` in the `/api/bsv20/id/{id}`
   * response.
   *
   * Returns undefined on any network error or absent icon. Robert
   * click-test 2026-04-25: Pumpkin's icon URL was inscribed in the
   * deploy tx but never surfaced in Coins because of this gap.
   */
  getBsv21IconUrl = async (id: string): Promise<string | undefined> => {
    if (!id || !/^[0-9a-fA-F]{64}_\d+$/.test(id)) return undefined;
    try {
      const network = this.chromeStorageService.getNetwork();
      const res = await fetch(`${this.getBaseUrl(network)}/api/bsv20/id/${id}`);
      if (!res.ok) return undefined;
      const data = (await res.json()) as {
        icon?: string | null;
        data?: { insc?: { json?: { icon?: string } } };
      };
      const direct = data.icon ?? undefined;
      if (typeof direct === 'string' && direct.length > 0) return direct;
      const inscIcon = data.data?.insc?.json?.icon;
      if (typeof inscIcon === 'string' && inscIcon.length > 0) return inscIcon;
      return undefined;
    } catch {
      return undefined;
    }
  };

  getBsv20Balances = async (addresses: string[]) => {
    const network = this.chromeStorageService.getNetwork();
    const url = `${this.getBaseUrl(network)}/api/bsv20/balance?addresses=${addresses.join('&addresses=')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch BSV20 balances: ${res.status}`);
    const resData = await res.json();

    const bsv20List: Array<Bsv20> = resData.map(
      (b: {
        all: {
          confirmed: string;
          pending: string;
        };
        listed: {
          confirmed: string;
          pending: string;
        };
        tick?: string;
        sym?: string;
        id?: string;
        icon?: string;
        dec: number;
      }) => {
        const id = (b.tick || b.id) as string;
        return {
          id: id,
          tick: b.tick,
          sym: b.sym || null,
          icon: b.icon || null,
          dec: b.dec,
          all: {
            confirmed: BigInt(b.all.confirmed),
            pending: BigInt(b.all.pending),
          },
          listed: {
            confirmed: BigInt(b.all.confirmed),
            pending: BigInt(b.all.pending),
          },
        };
      },
    );

    return bsv20List;
  };

  getBSV20Utxos = async (tick: string, addresses: string[] = []): Promise<BSV20Txo[] | undefined> => {
    try {
      const network = this.chromeStorageService.getNetwork();

      const utxos: BSV20Txo[] = [];
      await Promise.all(
        addresses.map(async (address) => {
          const url = isBSV20v2(tick)
            ? `${this.getBaseUrl(network)}/api/bsv20/${address}/id/${tick}?limit=10000`
            : `${this.getBaseUrl(network)}/api/bsv20/${address}/tick/${tick}?limit=10000`;

          const r = await fetch(url);
          if (!r.ok) throw new Error(`Failed to fetch BSV20 UTXOs: ${r.status}`);
          const rData = await r.json();
          (rData as BSV20Txo[]).forEach((utxo) => {
            if (utxo.status === 1 && !utxo.listing) utxos.push(utxo);
          });
        }),
      );

      return utxos;
    } catch (error) {
      console.error('getBSV20Utxos', error);
      return [];
    }
  };

  getBsv20Details = async (tick: string): Promise<Token | Partial<Token> | undefined> => {
    try {
      const network = this.chromeStorageService.getNetwork();
      const url = isBSV20v2(tick)
        ? `${this.getBaseUrl(network)}/api/bsv20/id/${tick}`
        : `${this.getBaseUrl(network)}/api/bsv20/tick/${tick}`;

      const r = await fetch(url);
      if (!r.ok) throw new Error(`Failed to fetch BSV20 details: ${r.status}`);
      return await r.json() as Token;
    } catch (error) {
      console.warn('getBsv20Details indexer failed, trying local parse:', error);
      // Local fallback: for BSV-21 (v2) tokens, parse the deploy tx's
      // inscription envelope directly. Gives us the static fields
      // (sym, dec, icon, amt/max/supply) without the indexer. Dynamic
      // fields (pctMinted, holders, available) are omitted on this
      // path — callers must treat the returned Token as partial.
      if (this.oneSatSPV && this.wocService) {
        const local = await getBsv20DetailsLocal(this.oneSatSPV, this.wocService, tick);
        if (local) return local;
      }
      return undefined;
    }
  };
}
