/**
 * Persistent display cache for popup-side render state.
 *
 * Phase 2.5 (Anvil-Wallet audit campaign).
 *
 * Why: Chrome MV3 popups are a fresh JS context every time the user
 * opens them (focus-loss closes the popup; reopen = new mount). Each
 * mount races spv-store / GP / WoC reconciliation in different orders,
 * so the same Activity list can render in a different sort + with
 * different rows showing as Pending across opens. Robert observed:
 *   - Pumpkin auto-detect only fires after long expansion (multi-minute
 *     spv-store ordinal index) because brief popup opens never let the
 *     async detect-and-add cycle complete.
 *   - Activity tab order changes between opens; Pending flickers as
 *     reconciliation lands at different times.
 *
 * Fix: persist the last known render state in `chrome.storage.local`
 * (shared between service worker + popup; persists across browser
 * restarts AND extension reloads). Popup-mount reads the cache
 * instantly and renders it; live refresh runs in parallel and updates
 * both state + cache when it completes.
 *
 * Storage choice: chrome.storage.session was the original pick but
 * gets WIPED on extension reload (per Chrome MV3 semantics). That
 * killed Pumpkin auto-detect every time Robert reloaded the
 * extension because the cache went empty and the next popup-blink
 * couldn't keep getBsv20s alive long enough to re-populate.
 * chrome.storage.local persists; ~10MB quota is plenty for our
 * ≤100-entry cache.
 *
 * If the popup closes mid-refresh, the cache holds the last successful
 * snapshot so the next open shows that — not empty UI.
 *
 * Storage layout: keyed by `display_cache:<account>:<network>` so that
 * switching account or toggling mainnet/testnet never cross-contaminates
 * cached state. Each key holds an object with sub-fields per concern
 * (bsv20s, activity, blockTimes, wocReconciliation). Sub-fields can be
 * updated independently. Callers derive the key via `keyFromAccount`;
 * a missing account or network short-circuits to a no-op so we never
 * write under an ambiguous key.
 */

import type { Bsv20 } from 'yours-wallet-provider';
import type { TxLog } from 'spv-store';

/**
 * Codex review 603d74dff0514e8f BLOCKING fix: namespace cache by
 * (account, network) so account-switch + multi-network configurations
 * don't bleed bsv20s, Activity rows, or reconciliation lookups across
 * accounts. Each (identityAddress, network) pair gets its own
 * top-level chrome.storage.local key.
 *
 * accountKey shape: `<identityAddress>:<network>` — e.g.
 * `1Dw1VtZvdTXt…:mainnet`. Caller derives via
 * `keyFromAccount(selectedAccount, network)`. If caller can't compute
 * a key (wallet not yet initialized), reads/writes are no-ops, same
 * as the no-chrome-API path.
 */
const STORAGE_KEY_PREFIX = 'display_cache:';

export function keyFromAccount(
  selectedAccount: string | undefined | null,
  network: string | undefined | null,
): string | undefined {
  if (!selectedAccount || !network) return undefined;
  return `${STORAGE_KEY_PREFIX}${selectedAccount}:${network}`;
}

/**
 * On-disk shape — BigInt fields (Bsv20.all.{confirmed,pending} +
 * Bsv20.listed.{confirmed,pending}) are stringified on write because
 * `chrome.storage.local.set()` uses structured cloning that REJECTS
 * BigInt values. Without this serialization the cache write silently
 * fails (Robert click-test 2026-04-25: Pumpkin disappeared after
 * every popup close even though detection succeeded — the cache was
 * never persisting).
 *
 * We rehydrate on read so callers always get the canonical Bsv20[]
 * shape with BigInt back. The serialized intermediate type is
 * private to this module.
 */
interface SerializedBsv20 extends Omit<Bsv20, 'all' | 'listed'> {
  all: { confirmed: string; pending: string };
  listed: { confirmed: string; pending: string };
}

interface SerializedDisplayCache {
  bsv20s?: { entries: SerializedBsv20[]; cachedAt: number };
  activity?: { logs: TxLog[]; cachedAt: number };
  /** Reconciliation lookups — see writeReconciliationCache JSDoc. */
  reconciliation?: {
    wocByTxid: Array<[string, { height: number; time?: number }]>;
    blockTimes: Array<[number, number]>;
    cachedAt: number;
  };
}

export interface DisplayCacheShape {
  bsv20s?: { entries: Bsv20[]; cachedAt: number };
  activity?: { logs: TxLog[]; cachedAt: number };
  reconciliation?: {
    wocByTxid: Map<string, { height: number; time?: number }>;
    blockTimes: Map<number, number>;
    cachedAt: number;
  };
}

const EMPTY: DisplayCacheShape = {};

function hasLocal(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

function serializeBsv20(b: Bsv20): SerializedBsv20 {
  return {
    ...b,
    all: { confirmed: b.all.confirmed.toString(), pending: b.all.pending.toString() },
    listed: { confirmed: b.listed.confirmed.toString(), pending: b.listed.pending.toString() },
  };
}

function deserializeBsv20(s: SerializedBsv20): Bsv20 {
  return {
    ...s,
    all: { confirmed: BigInt(s.all.confirmed), pending: BigInt(s.all.pending) },
    listed: { confirmed: BigInt(s.listed.confirmed), pending: BigInt(s.listed.pending) },
  } as Bsv20;
}

async function readSerializedCache(
  cacheKey: string | undefined,
): Promise<SerializedDisplayCache> {
  if (!hasLocal() || !cacheKey) return {};
  try {
    const out = await chrome.storage.local.get(cacheKey);
    return (out[cacheKey] as SerializedDisplayCache | undefined) ?? {};
  } catch {
    return {};
  }
}

export async function readDisplayCache(
  cacheKey: string | undefined,
): Promise<DisplayCacheShape> {
  const raw = await readSerializedCache(cacheKey);
  if (!raw) return EMPTY;
  return {
    bsv20s: raw.bsv20s
      ? { entries: raw.bsv20s.entries.map(deserializeBsv20), cachedAt: raw.bsv20s.cachedAt }
      : undefined,
    activity: raw.activity,
    reconciliation: raw.reconciliation
      ? {
          wocByTxid: new Map(raw.reconciliation.wocByTxid),
          blockTimes: new Map(raw.reconciliation.blockTimes),
          cachedAt: raw.reconciliation.cachedAt,
        }
      : undefined,
  };
}

export async function writeBsv20sCache(
  cacheKey: string | undefined,
  entries: Bsv20[],
): Promise<void> {
  if (!hasLocal() || !cacheKey) return;
  try {
    const current = await readSerializedCache(cacheKey);
    await chrome.storage.local.set({
      [cacheKey]: {
        ...current,
        bsv20s: {
          entries: entries.map(serializeBsv20),
          cachedAt: Date.now(),
        },
      },
    });
  } catch (err) {
    // Surface the failure so future diagnostics aren't a guessing
    // game — the cause that bit us originally (BigInt non-serializable)
    // would have shown up in the console immediately if we'd looked.
    console.warn('[DisplayCache] writeBsv20sCache failed:', err);
  }
}

/**
 * Strip non-display fields from a TxLog summary before caching.
 * IndexSummary has a `data?: any` field that spv-store's indexer
 * chain populates with whatever internal structures it generates —
 * may contain BigInts, class instances, or other values that
 * structured cloning rejects, causing the entire cache write to
 * silently fail. The Activity render only uses `id`, `icon`,
 * `amount` from each summary, so dropping `.data` is safe and
 * eliminates a whole class of "cache stays empty for unknown
 * reason" failures (Robert click-test 2026-04-25).
 */
function sanitizeTxLogForCache(log: TxLog): TxLog {
  const summary = log.summary;
  if (!summary) return log;
  const cleanSummary: { [tag: string]: { id?: string; icon?: string; amount?: number } } = {};
  for (const [tag, value] of Object.entries(summary)) {
    if (!value) continue;
    cleanSummary[tag] = {
      id: value.id,
      icon: value.icon,
      amount: typeof value.amount === 'number' ? value.amount : undefined,
    };
  }
  return {
    txid: log.txid,
    height: log.height,
    idx: log.idx,
    source: log.source,
    summary: cleanSummary,
  } as unknown as TxLog;
}

export async function writeActivityCache(
  cacheKey: string | undefined,
  logs: TxLog[],
): Promise<void> {
  if (!hasLocal() || !cacheKey) return;
  try {
    // Bound storage: cap at 100 entries (display only ever shows
    // ~25/page, so this is generous and keeps storage from growing
    // unbounded on heavy users). Sanitize each entry so non-cloneable
    // values in IndexSummary.data don't blow up the entire write.
    const capped = logs.slice(0, 100).map(sanitizeTxLogForCache);
    const current = await readSerializedCache(cacheKey);
    await chrome.storage.local.set({
      [cacheKey]: {
        ...current,
        activity: { logs: capped, cachedAt: Date.now() },
      },
    });
  } catch (err) {
    console.warn('[DisplayCache] writeActivityCache failed:', err);
  }
}

/**
 * Persist the WoC reconciliation lookup tables (txid→height/time +
 * height→time) so the next popup open doesn't have to re-roundtrip
 * to WoC for every Pending row.
 *
 * Phase 2.5 hotfix #10: Robert click-test 2026-04-25 reported the
 * Activity tab flickering between Pending and resolved dates on
 * every popup open. Trace: wocReconciliation + blockTimes were
 * React state only, wiped on every popup mount. Reconciliation
 * had to re-run from scratch each time, with the visible delay
 * being the per-tx WoC fetch. Persisting the lookups eliminates
 * the per-mount re-resolution: known txids render confirmed
 * instantly.
 */
export async function writeReconciliationCache(
  cacheKey: string | undefined,
  args: {
    wocByTxid: Map<string, { height: number; time?: number }>;
    blockTimes: Map<number, number>;
  },
): Promise<void> {
  if (!hasLocal() || !cacheKey) return;
  try {
    const current = await readSerializedCache(cacheKey);
    await chrome.storage.local.set({
      [cacheKey]: {
        ...current,
        reconciliation: {
          wocByTxid: Array.from(args.wocByTxid.entries()),
          blockTimes: Array.from(args.blockTimes.entries()),
          cachedAt: Date.now(),
        },
      },
    });
  } catch (err) {
    console.warn('[DisplayCache] writeReconciliationCache failed:', err);
  }
}

export async function clearDisplayCache(cacheKey: string | undefined): Promise<void> {
  if (!hasLocal() || !cacheKey) return;
  try {
    await chrome.storage.local.remove(cacheKey);
  } catch {
    /* swallow */
  }
}

/** TTL beyond which we don't trust the cache (still render it but
 *  fire a refresh more eagerly). 30s is generous — tx confirmation
 *  happens at ~10min cadence on chain, so a 30s display lag is fine. */
export const DISPLAY_CACHE_FRESH_MS = 30_000;

export function isFresh(cachedAt: number | undefined): boolean {
  if (!cachedAt) return false;
  return Date.now() - cachedAt < DISPLAY_CACHE_FRESH_MS;
}
