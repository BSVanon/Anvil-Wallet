/**
 * Honest sync-status signal shared between the service worker and the
 * popup. Replaces the stuck "Sync Process Initializing..." banner
 * with an accurate picture of what the indexer layer is actually
 * doing. No symptom-masking timers — status only changes in response
 * to observed events (errors, retries, successful syncs).
 *
 * Storage: chrome.storage.session. This is the only key-value store
 * that (a) exists in MV3 service workers (localStorage does not)
 * AND (b) is shared with the popup context. chrome.storage.local
 * would also work but session data is ephemeral to the browser
 * session, which matches the semantics of a transient sync state.
 *
 * States:
 *   initializing — sync started, no success or failure signal yet.
 *     The default state during the first few seconds after SPV init.
 *   healthy      — spv-store registered and is successfully syncing.
 *     Detected by any queueStats / importing / fetchingTx event.
 *   degraded     — spv-store register failed (ordinals.1sat.app
 *     outage being the canonical cause). Caught via an unhandled
 *     rejection listener in the service worker that matches the
 *     'Failed to register account' message.
 *   retrying     — user clicked Retry; background is destroying
 *     and re-initializing the SPV instance. Will flip back to
 *     initializing then healthy or degraded based on outcome.
 *
 * Transitions:
 *   (initial)   → initializing
 *   initializing → healthy | degraded
 *   degraded    → retrying (on user action)
 *   retrying    → initializing (after SPV re-init)
 *   healthy     → degraded (if a later error surfaces)
 */

export type SyncStatus = 'initializing' | 'healthy' | 'degraded' | 'retrying';

const STORAGE_KEY = 'anvil_sync_status';

const DEFAULT_STATUS: SyncStatus = 'initializing';

/**
 * Read the current sync status. Safe in both service worker + popup
 * contexts. Returns DEFAULT_STATUS if storage is unavailable or the
 * key is unset (wallet just installed, never written).
 */
export async function readSyncStatus(): Promise<SyncStatus> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) {
      return DEFAULT_STATUS;
    }
    const out = await chrome.storage.session.get(STORAGE_KEY);
    const val = out[STORAGE_KEY] as SyncStatus | undefined;
    return val ?? DEFAULT_STATUS;
  } catch {
    return DEFAULT_STATUS;
  }
}

/**
 * Write the current sync status. Use from the service worker when
 * errors or success events fire; use from the popup when the user
 * triggers a retry. Writes are observable via
 * chrome.storage.onChanged in both contexts.
 */
export async function writeSyncStatus(status: SyncStatus): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
    await chrome.storage.session.set({ [STORAGE_KEY]: status });
  } catch {
    /* swallow — status write is non-critical */
  }
}

/**
 * Subscribe to sync-status changes. Returns an unsubscribe fn. Fires
 * the initial value immediately via readSyncStatus() so callers can
 * skip the initial load + subscribe pattern.
 */
export function subscribeSyncStatus(cb: (status: SyncStatus) => void): () => void {
  let cancelled = false;

  readSyncStatus().then((initial) => {
    if (!cancelled) cb(initial);
  });

  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
    return () => {
      cancelled = true;
    };
  }

  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: chrome.storage.AreaName,
  ) => {
    if (area !== 'session') return;
    if (!changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue as SyncStatus | undefined;
    cb(next ?? DEFAULT_STATUS);
  };

  chrome.storage.onChanged.addListener(listener);
  return () => {
    cancelled = true;
    chrome.storage.onChanged.removeListener(listener);
  };
}

/**
 * Pattern match used by the service-worker unhandled-rejection
 * listener to decide whether a given error means "register failed."
 * Exported so tests can verify the matcher against real error
 * objects without mocking chrome APIs.
 */
export function isRegisterFailureError(err: unknown): boolean {
  if (!err) return false;
  const msg =
    (err instanceof Error ? err.message : typeof err === 'string' ? err : '') || '';
  return /failed to register account/i.test(msg);
}

/** Used by the banner UI to know what copy + actions to render. */
export interface SyncStatusDisplay {
  show: boolean;
  title: string;
  subtitle: string;
  color: 'blue' | 'orange' | 'red';
  showRetry: boolean;
}

export function displayForStatus(status: SyncStatus): SyncStatusDisplay {
  switch (status) {
    case 'initializing':
      return {
        show: true,
        title: 'Syncing...',
        subtitle: 'Connecting to the indexer. This should only take a moment.',
        color: 'blue',
        showRetry: false,
      };
    case 'retrying':
      return {
        show: true,
        title: 'Retrying sync...',
        subtitle: 'Re-initializing indexer connection.',
        color: 'blue',
        showRetry: false,
      };
    case 'degraded':
      return {
        show: true,
        title: 'Indexer degraded',
        subtitle:
          'Some holdings may be hidden. Balance uses fallback data. Retry to reconnect.',
        color: 'red',
        showRetry: true,
      };
    case 'healthy':
    default:
      return {
        show: false,
        title: '',
        subtitle: '',
        color: 'blue',
        showRetry: false,
      };
  }
}
