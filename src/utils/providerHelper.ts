import { Utils } from '@bsv/sdk';
import { Txo, TxLog } from 'spv-store';
import { Ordinal } from 'yours-wallet-provider';
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
 * Simplification for launch: we only surface RECEIVED events (rows
 * where the output credited the user's address). Outbound sends
 * would require fetching each spent output's full tx to compute
 * deltas, which is costly + out of scope for the display fallback.
 * When spv-store is healthy again its getRecentTxs() returns full
 * bi-directional history; the fallback is for visibility during
 * degraded periods, not completeness.
 *
 * Each resulting TxLog carries a single `fund` summary entry with
 * the net satoshis received in that tx at the queried addresses.
 */
export function mapGpHistoryToTxLogs(rows: GpOrdinalRow[]): TxLog[] {
  // Aggregate by txid, summing satoshis across all outputs at the
  // user's addresses in that tx. Track height / idx (min idx for
  // deterministic ordering within a block).
  const byTxid = new Map<
    string,
    { txid: string; height: number; idx: number; totalSats: number; hasOrdinal: boolean }
  >();
  for (const row of rows) {
    if (!row?.txid) continue;
    const existing = byTxid.get(row.txid);
    const sats = Number(row.satoshis ?? 0);
    const height = Number(row.height ?? 0);
    const idx = Number(row.idx ?? 0);
    const isOrdinal = row.origin != null;
    if (!existing) {
      byTxid.set(row.txid, {
        txid: row.txid,
        height,
        idx,
        totalSats: sats,
        hasOrdinal: isOrdinal,
      });
    } else {
      existing.totalSats += sats;
      if (height && (!existing.height || height < existing.height)) existing.height = height;
      if (idx && (!existing.idx || idx < existing.idx)) existing.idx = idx;
      if (isOrdinal) existing.hasOrdinal = true;
    }
  }

  // Produce TxLog entries. Sorted descending by height then idx so
  // the most recent txs appear first (matching spv-store's
  // getRecentTxs convention).
  const logs: TxLog[] = [];
  for (const agg of byTxid.values()) {
    const log = {
      txid: agg.txid,
      height: agg.height,
      idx: agg.idx,
      source: 'gorillapool-fallback',
      summary: {
        // Use `fund` tag for BSV receives, `origin` tag if any
        // output in the tx was inscribed (best-effort icon hint).
        ...(agg.hasOrdinal
          ? { origin: { amount: agg.totalSats } }
          : { fund: { amount: agg.totalSats } }),
      },
    } as unknown as TxLog;
    logs.push(log);
  }
  logs.sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    return b.idx - a.idx;
  });
  return logs;
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
