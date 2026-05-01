import { Utils } from '@bsv/sdk';
import { Txo, TxLog } from 'spv-store';
import { BSV20Txo, Ordinal } from 'yours-wallet-provider';
import { GpOrdinalRow } from '../services/types/gorillaPool.ordinal';

export function mapOrdinal(t: Txo): Ordinal {
  let originJson: string | undefined;
  let inscriptionJson: string | undefined;
  try {
    originJson =
      t.data.origin?.data?.insc?.file?.type.startsWith('application/json') &&
      t.data.origin?.data?.insc?.file?.content &&
      JSON.parse(Utils.toUTF8(t.data.origin.data.insc.file.content));
  } catch (e) {
    console.warn('Error parsing origin json', e);
  }

  try {
    inscriptionJson =
      t.data.insc?.data?.file?.type.startsWith('application/json') &&
      t.data.insc?.data?.file?.content &&
      JSON.parse(Utils.toUTF8(t.data.insc.data.file.content));
  } catch (error) {
    console.warn('Error parsing inscription json', error);
  }

  return {
    txid: t.outpoint.txid,
    vout: t.outpoint.vout,
    outpoint: t.outpoint.toString(),
    satoshis: Number(t.satoshis),
    script: Utils.toBase64(t.script),
    owner: t.owner,
    spend: '',
    origin: t.data.origin && {
      outpoint: t.data.origin.data.outpoint,
      nonce: Number(t.data.origin.data.nonce),
      num: t.block.height < 50000000 ? `${t.block.height}:${t.block.idx}:${t.outpoint.vout}` : undefined,
      data: {
        insc: {
          file: t.data?.origin?.data?.insc?.file && {
            type: t.data.origin.data.insc.file.type,
            size: Number(t.data.origin.data.insc.file.size),
            hash: t.data.origin.data.insc.file.hash,
            text:
              (t.data.origin?.data?.insc?.file?.type.startsWith('text') ||
                t.data.origin?.data?.insc?.file?.type.startsWith('application/op-ns')) &&
              t.data.origin.data.insc?.file?.content &&
              Utils.toUTF8(t.data.origin.data.insc.file.content),
            json: originJson,
          },
        },
        map: t.data.origin.data?.map,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sigma: (t.data.origin.data?.sigma?.data || []).map((s: any) => ({
          ...s,
          signature: Utils.toBase64(s.signature),
        })),
      },
    },
    height: t.block?.height,
    idx: Number(t.block?.idx),
    data: {
      insc: {
        file: t.data?.insc?.data?.file && {
          type: t.data.insc.data.file.type,
          size: t.data.insc.data.file.size,
          hash: t.data.insc.data.file.hash,
          text:
            t.data.insc?.data?.file?.type.startsWith('text') &&
            t.data.insc.data.file.content &&
            Utils.toUTF8(t.data.insc.data.file.content),
          json: inscriptionJson,
        },
      },
      list: t.data.list && {
        payout: Utils.toBase58(t.data.list.data.payout),
        price: Number(t.data.list.data.price),
      },
      lock: t.data.lock?.data,
      map: t.data.map?.data,
      bsv20: (t.data.bsv20?.data || t.data.bsv21?.data) && {
        ...(t.data.bsv20?.data || t.data.bsv21?.data),
        amt: Number(t.data.bsv20?.data?.amt || t.data.bsv21?.data?.amt),
      },
      // TODO (DAVID CASE): add sigma
    },
  };
}

/**
 * Convert a GorillaPool `/api/txos/address/.../unspent` row that has
 * `origin != null` into an Ordinal compatible with the display UI.
 *
 * Used as the fallback path in OrdinalService.getOrdinals when
 * spv-store is degraded. Only fields the UI actually reads are
 * populated; spend-path fields (`script`, full `origin.num`) may be
 * blank when the source is GP — spending an ordinal still requires
 * spv-store being healthy, which is tracked separately via
 * SyncStatus.
 */
/**
 * Group GorillaPool address-history rows by txid and synthesize
 * TxLog entries the TxHistory UI can render. Display-only fallback
 * when spv-store's local tx log is empty.
 *
 * Emits TWO classes of events per row:
 *   1. Receive: the row's own txid created an output at the user's
 *      address → positive-amount fund|origin summary.
 *   2. Send: the row's `spend` field names the tx that consumed
 *      that output → negative-amount fund summary (user sent).
 *
 * Net per-tx amount is the sum across all applicable outputs at
 * the queried addresses. For multi-input sends the displayed
 * "sent" amount is the total the user's addresses contributed —
 * not the final delta after change (that would require fetching
 * each spender tx). Close enough for display; precise accounting
 * comes back when spv-store is healthy.
 */
export function mapGpHistoryToTxLogs(rows: GpOrdinalRow[]): TxLog[] {
  // Aggregate by txid. `totalSats` is positive for receives,
  // negative for sends.
  const byTxid = new Map<
    string,
    { txid: string; height: number; idx: number; totalSats: number; hasOrdinal: boolean }
  >();

  const upsert = (
    txid: string,
    sats: number,
    height: number,
    idx: number,
    isOrdinal: boolean,
  ) => {
    if (!txid) return;
    const existing = byTxid.get(txid);
    if (!existing) {
      byTxid.set(txid, { txid, height, idx, totalSats: sats, hasOrdinal: isOrdinal });
    } else {
      existing.totalSats += sats;
      if (height && (!existing.height || height < existing.height)) existing.height = height;
      if (idx && (!existing.idx || idx < existing.idx)) existing.idx = idx;
      if (isOrdinal) existing.hasOrdinal = true;
    }
  };

  for (const row of rows) {
    if (!row?.txid) continue;
    const sats = Number(row.satoshis ?? 0);
    const receiveHeight = Number(row.height ?? 0);
    const receiveIdx = Number(row.idx ?? 0);
    const isOrdinal = row.origin != null;

    // Receive event for the tx that created this output.
    upsert(row.txid, sats, receiveHeight, receiveIdx, isOrdinal);

    // Send event for the tx that spent this output (if any).
    // `spend` is a txid string when spent, "" when still unspent.
    // GP also sometimes returns spend_height / spend_idx — use them
    // when present for ordering, else fall back to 0 (shows at top
    // of history as a fresh-mempool tx).
    const spendTxid = row.spend;
    if (spendTxid && typeof spendTxid === 'string') {
      const spendHeight = Number(
        (row as unknown as { spend_height?: number }).spend_height ?? 0,
      );
      const spendIdx = Number((row as unknown as { spend_idx?: string }).spend_idx ?? 0);
      upsert(spendTxid, -sats, spendHeight, spendIdx, isOrdinal);
    }
  }

  // Produce TxLog entries. Sorted descending by height then idx.
  // Zero-height txs (mempool / unknown) sort to the top — fresh
  // sends show up immediately after broadcast.
  //
  // Re-walk the rows one more time to pick up bsv20 / bsv21 token
  // metadata per tx — needed so MNEE (and any BSV-21 transfer)
  // shows with the token icon / name instead of a generic BSV
  // entry. GP surfaces token info on both the receive side
  // (row.data.bsv20) and the origin side (row.origin.data.bsv20);
  // either is good enough for the tag.
  const tokenByTxid = new Map<string, { id?: string; icon?: string; sym?: string }>();
  for (const row of rows) {
    if (!row?.txid) continue;
    const bsv20 = row.data?.bsv20 || row.origin?.data?.bsv20;
    if (bsv20?.id) {
      tokenByTxid.set(row.txid, { id: bsv20.id, icon: bsv20.icon, sym: bsv20.sym });
    }
    if (row.spend && bsv20?.id) {
      tokenByTxid.set(row.spend, { id: bsv20.id, icon: bsv20.icon, sym: bsv20.sym });
    }
  }

  const logs: TxLog[] = [];
  for (const agg of byTxid.values()) {
    const token = tokenByTxid.get(agg.txid);
    let summary: Record<string, unknown>;
    if (token) {
      // BSV-21 token transfer (MNEE + other cosigned / plain BSV-21).
      // The UI's tagPriorityOrder includes 'bsv21' ahead of 'origin'
      // so this takes precedence in the icon/header selection.
      summary = {
        bsv21: {
          id: token.id,
          icon: token.icon,
          // amount = net sats moved; for tokens the "satoshis" value
          // is the 1-sat ordinal output, so amt displayed here is
          // just the number of inscription outputs the user received/sent
          // (roughly a count of token-transfer events at the address).
          amount: agg.totalSats,
        },
      };
    } else if (agg.hasOrdinal) {
      summary = { origin: { amount: agg.totalSats } };
    } else {
      summary = { fund: { amount: agg.totalSats } };
    }
    const log = {
      txid: agg.txid,
      height: agg.height,
      idx: agg.idx,
      source: 'gorillapool-fallback',
      summary,
    } as unknown as TxLog;
    logs.push(log);
  }
  logs.sort((a, b) => {
    // Mempool (height=0) sorts above confirmed; within confirmed,
    // higher blocks first; tie-break on idx descending.
    const aH = a.height || Number.MAX_SAFE_INTEGER;
    const bH = b.height || Number.MAX_SAFE_INTEGER;
    if (bH !== aH) return bH - aH;
    return b.idx - a.idx;
  });
  return logs;
}

/**
 * Shape a BSV-21 token UTXO (returned by GorillaPool's
 * `/api/bsv20/{address}/id/{tokenId}` endpoint) into the Ordinal
 * shape expected by `provider.getOrdinals` consumers. The id +
 * amount land in BOTH `origin.data.bsv20` and `data.bsv20` so
 * caller code that checks either path resolves correctly.
 *
 * Used by the background `processGetOrdinalsRequest` fallback when
 * spv-store is degraded — without this, BSV-21 token UTXOs are
 * invisible to provider callers (they'd see only plain inscriptions
 * via the address-unspent endpoint, which filters BSV-20/21 out).
 */
export function mapBsv20TxoToOrdinal(utxo: BSV20Txo): Ordinal {
  const id = utxo.id ?? utxo.tick ?? '';
  const amt = Number(utxo.amt ?? 0);
  const bsv20 = { id, amt, p: 'bsv-20' as never, op: utxo.op ?? 'transfer', tick: utxo.tick };
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    outpoint: utxo.outpoint,
    satoshis: 1, // BSV-21 token UTXOs are always 1 sat
    script: utxo.script ?? '',
    owner: utxo.owner ?? '',
    spend: utxo.spend ?? '',
    origin: {
      outpoint: id, // BSV-21 deploy outpoint is the canonical id
      nonce: 0,
      data: {
        bsv20: bsv20 as never,
      },
    } as never,
    height: utxo.height,
    idx: utxo.idx,
    data: {
      bsv20: bsv20 as never,
    },
  } as Ordinal;
}

export function mapGpOrdinal(row: GpOrdinalRow, ownerAddress: string): Ordinal {
  // Parse JSON-typed inscription content if GP already provided it.
  const originInscType = row.origin?.data?.insc?.file?.type;
  const originJson =
    originInscType?.startsWith('application/json') || originInscType?.startsWith('application/bsv-20')
      ? row.origin?.data?.insc?.file?.json
      : undefined;

  return {
    txid: row.txid,
    vout: row.vout,
    outpoint: row.outpoint,
    satoshis: Number(row.satoshis),
    script: '', // not returned by GP's address-unspent endpoint — fetch per-outpoint if needed for a spend
    owner: row.owner ?? ownerAddress,
    spend: row.spend || '',
    origin: row.origin && {
      outpoint: row.origin.outpoint,
      nonce: Number(row.origin.nonce ?? 0),
      num: row.origin.num,
      data: {
        insc: {
          file: row.origin.data?.insc?.file && {
            type: row.origin.data.insc.file.type,
            size: Number(row.origin.data.insc.file.size ?? 0),
            hash: row.origin.data.insc.file.hash,
            text:
              row.origin.data.insc.file.type?.startsWith('text') ||
              row.origin.data.insc.file.type?.startsWith('application/op-ns')
                ? undefined // GP doesn't inline text content in this endpoint
                : undefined,
            json: originJson as never,
          },
        },
        map: row.origin.data?.map as never,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sigma: (row.origin.data?.sigma || []) as any,
      },
    },
    height: row.height,
    idx: row.idx ? Number(row.idx) : undefined,
    data: row.data && {
      insc: {
        file: row.data.insc?.file && {
          type: row.data.insc.file.type,
          size: Number(row.data.insc.file.size ?? 0),
          hash: row.data.insc.file.hash,
          text: undefined,
          json: row.data.insc.file.json as never,
        },
      },
      bsv20: row.data.bsv20 && {
        ...row.data.bsv20,
        amt: Number(row.data.bsv20.amt ?? 0),
      },
    },
  } as Ordinal;
}
