/**
 * localStorage-backed registry of txids the wallet just broadcast.
 *
 * Every successful broadcast goes through `broadcastMultiSource`. We
 * record the resulting txid here so the Activity view can render it
 * immediately, even when GorillaPool's indexer hasn't yet caught up
 * to the spend side (GP indexer lag is ~minutes-to-hours for
 * SEND-side `row.spend` updates).
 *
 * Without this, a freshly-sent tx is invisible in Activity until both
 * (a) spv-store sync completes locally OR (b) GP indexes the spend.
 * Both can lag long enough that users see balance change but no
 * record of the action — confusing and trust-corroding.
 *
 * Entries are auto-pruned at 7 days. By that point spv-store and/or
 * GP will have caught up to chain reality, so the local registry is
 * just there to bridge the lag window.
 *
 * Phase 2 P2.2 (Anvil-Wallet audit campaign).
 */

// Codex review 603d74dff0514e8f MEDIUM fix: namespace the broadcast
// tracker by (account, network) so a send from Account A doesn't
// appear in Account B's Activity until GP catches up. Single global
// localStorage bucket was a multi-account privacy bleed.
const STORAGE_KEY_PREFIX = 'anvil_wallet_recent_broadcasts:';
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EVENT = 'anvil_wallet_recent_broadcasts_changed';

export function recentBroadcastsKey(
  selectedAccount: string | undefined | null,
  network: string | undefined | null,
): string | undefined {
  if (!selectedAccount || !network) return undefined;
  return `${STORAGE_KEY_PREFIX}${selectedAccount}:${network}`;
}

export interface RecentBroadcast {
  txid: string;
  /** Unix ms timestamp of broadcast. */
  broadcastAt: number;
  /** Net sats movement at the wallet's perspective (negative = sent). */
  sats: number;
  /** Tag the broadcast surface so the Activity row icon matches. */
  kind?: 'fund' | 'origin' | 'bsv21';
}

type Store = Record<string, RecentBroadcast>;

function read(storeKey: string | undefined): Store {
  if (!storeKey) return {};
  try {
    const raw = localStorage.getItem(storeKey);
    if (!raw) return {};
    return JSON.parse(raw) as Store;
  } catch {
    return {};
  }
}

function write(storeKey: string | undefined, store: Store): void {
  if (!storeKey) return;
  try {
    localStorage.setItem(storeKey, JSON.stringify(store));
  } catch {
    /* quota / disabled storage — silent best-effort */
  }
}

/**
 * Record a freshly-broadcast txid. Idempotent — re-recording the same
 * txid updates `broadcastAt` (useful for retry-as-success cases where
 * `txExistsOnNetwork` flagged a prior attempt's txid).
 *
 * `storeKey` namespaces the bucket by (account, network) so a send
 * from Account A doesn't bleed into Account B's Activity. Caller
 * derives via `recentBroadcastsKey(selectedAccount, network)`.
 */
export function recordRecentBroadcast(
  storeKey: string | undefined,
  b: RecentBroadcast,
): void {
  if (!storeKey) return;
  if (!b.txid || !/^[0-9a-fA-F]{64}$/.test(b.txid)) return;
  const store = read(storeKey);
  // Prune-on-write so the cache doesn't grow unbounded.
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const [txid, entry] of Object.entries(store)) {
    if (entry.broadcastAt < cutoff) delete store[txid];
  }
  store[b.txid] = b;
  write(storeKey, store);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

export function listRecentBroadcasts(storeKey: string | undefined): RecentBroadcast[] {
  const store = read(storeKey);
  return Object.values(store).sort((a, b) => b.broadcastAt - a.broadcastAt);
}

export function deleteRecentBroadcast(storeKey: string | undefined, txid: string): void {
  if (!storeKey) return;
  const store = read(storeKey);
  if (!store[txid]) return;
  delete store[txid];
  write(storeKey, store);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

export const RECENT_BROADCASTS_EVENT = EVENT;
