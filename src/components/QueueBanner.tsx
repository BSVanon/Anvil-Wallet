/**
 * Honest sync-status banner.
 *
 * Replaces the old "Sync Process Initializing..." / localStorage-driven
 * banner that stayed stuck forever whenever spv-store's register to
 * ordinals.1sat.app failed. Subscribes to the shared SyncStatus signal
 * (chrome.storage.session) which is updated by:
 *   - initSPVStore.ts on real sync events (queueStats / importing /
 *     fetchingTx) → 'healthy' (banner hides).
 *   - background.ts unhandledrejection listener when spv-store's
 *     register fails → 'degraded' (red banner + Retry button).
 *   - QueueBanner's own Retry button → 'retrying' (blue banner
 *     while SPV re-initializes).
 *
 * Still respects the upstream queueStats / importing / fetchingTx
 * signals for the genuine-sync-in-progress case where queue events
 * fire and the user should see "Syncing N transactions..."
 */

import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { useQueueTracker } from '../hooks/useQueueTracker';
import { useServiceContext } from '../hooks/useServiceContext';
import { WhiteLabelTheme } from '../theme.types';
import { formatNumberWithCommasAndDecimals, truncate } from '../utils/format';
import { sendMessage } from '../utils/chromeHelpers';
import { YoursEventName } from '../inject';
import {
  subscribeSyncStatus,
  displayForStatus,
  writeSyncStatus,
  type SyncStatus,
} from '../services/SyncStatus.service';
import { Show } from './Show';

const Banner = styled.div<WhiteLabelTheme & { $color: 'blue' | 'orange' | 'red' }>`
  position: fixed;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  top: 0;
  width: 100%;
  min-height: 3.25rem;
  font-size: 0.9rem;
  font-weight: 700;
  background-color: ${({ theme, $color }) => {
    if ($color === 'red') return '#b91c1c';
    return theme.color.component.queueBannerSyncing;
  }};
  color: ${({ theme, $color }) => {
    if ($color === 'red') return '#ffffff';
    return theme.color.component.queueBannerSyncingText;
  }};
  padding: 1rem 0.5rem;
  text-align: center;
  z-index: 1000;
`;

const RetryButton = styled.button`
  margin-top: 0.5rem;
  padding: 0.4rem 0.9rem;
  font-size: 0.8rem;
  font-weight: 600;
  border-radius: 0.375rem;
  border: 1px solid rgba(255, 255, 255, 0.6);
  background-color: rgba(0, 0, 0, 0.15);
  color: inherit;
  cursor: pointer;
  transition: background-color 0.15s;

  &:hover {
    background-color: rgba(0, 0, 0, 0.3);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

export const QueueBanner = () => {
  const { keysService } = useServiceContext();
  const { isSyncing, showQueueBanner, theme, queueLength, importName, fetchingTxid } =
    useQueueTracker();

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('initializing');
  useEffect(() => {
    const unsubscribe = subscribeSyncStatus(setSyncStatus);
    return unsubscribe;
  }, []);

  const statusDisplay = displayForStatus(syncStatus);

  const handleRetry = async () => {
    // Optimistic local write so the UI flips immediately; background
    // will also write 'retrying' when it processes the message.
    await writeSyncStatus('retrying');
    try {
      sendMessage({ action: YoursEventName.SYNC_RETRY });
    } catch (err) {
      console.error('[QueueBanner] failed to send retry message:', err);
    }
  };

  const walletReady = !!keysService?.bsvAddress;
  // Show the active queue-progress banner only when spv-store is
  // actually firing queue events AND the overall status is healthy.
  // Avoids double-banner when degraded.
  const showQueueProgress =
    walletReady && showQueueBanner && isSyncing && syncStatus === 'healthy';
  const showStatusBanner = walletReady && statusDisplay.show && !showQueueProgress;

  if (!walletReady || !theme) return null;

  if (showQueueProgress) {
    return (
      <Banner theme={theme} $color="orange">
        {importName && importName !== 'Wallet'
          ? `Importing ${importName}...`
          : `SPV Wallet is syncing ${
              queueLength ? formatNumberWithCommasAndDecimals(queueLength, 0) : ''
            } transactions...`}
        <br />
        <span style={{ fontSize: '0.75rem', fontWeight: 400 }}>
          You may safely close the wallet during this process.
        </span>
        <Show when={!!fetchingTxid}>
          <span style={{ fontSize: '0.75rem', fontWeight: 600, marginTop: '0.5rem' }}>
            {fetchingTxid ? truncate(fetchingTxid, 6, 6) : ''}
          </span>
        </Show>
      </Banner>
    );
  }

  if (showStatusBanner) {
    return (
      <Banner theme={theme} $color={statusDisplay.color}>
        {statusDisplay.title}
        <br />
        <span style={{ fontSize: '0.75rem', fontWeight: 400 }}>
          {statusDisplay.subtitle}
        </span>
        {statusDisplay.showRetry && (
          <RetryButton onClick={handleRetry} disabled={syncStatus === 'retrying'}>
            Retry sync
          </RetryButton>
        )}
      </Banner>
    );
  }

  return null;
};
