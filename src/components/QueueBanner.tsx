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
  min-height: 2.25rem;
  font-size: 0.75rem;
  font-weight: 600;
  background-color: ${({ theme, $color }) => {
    if ($color === 'red') return '#b91c1c';
    return theme.color.component.queueBannerSyncing;
  }};
  color: ${({ theme, $color }) => {
    if ($color === 'red') return '#ffffff';
    return theme.color.component.queueBannerSyncingText;
  }};
  padding: 0.5rem 2rem 0.5rem 0.5rem;
  text-align: center;
  z-index: 1000;
`;

const DismissX = styled.button`
  position: absolute;
  top: 0.25rem;
  right: 0.4rem;
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1;
  border-radius: 0.25rem;
  border: none;
  background-color: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.7;

  &:hover {
    opacity: 1;
    background-color: rgba(0, 0, 0, 0.15);
  }
`;

const RetryButton = styled.button`
  margin-top: 0.25rem;
  padding: 0.25rem 0.6rem;
  font-size: 0.7rem;
  font-weight: 600;
  border-radius: 0.25rem;
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

  // Dismiss tracking (per-popup-session, resets on reopen so the
  // signal isn't permanently hidden). We track two separate dismiss
  // flags — one for the queue-progress (orange) banner and one for
  // the SyncStatus (red/blue) banner — so dismissing one doesn't
  // hide the other.
  const [queueDismissed, setQueueDismissed] = useState(false);
  const [statusDismissed, setStatusDismissed] = useState(false);
  // Reset the dismiss flag when status transitions — a new problem
  // state deserves a fresh banner the user hasn't seen yet.
  useEffect(() => {
    setStatusDismissed(false);
  }, [syncStatus]);

  // Cooldown seconds remaining after a retry click. Blocks button
  // spam when the underlying service is still down — a failed retry
  // still destroys + re-inits SPV, and doing that repeatedly is
  // expensive and makes the wallet feel broken. 30s is the minimum
  // time a realistic indexer recovery takes.
  const RETRY_COOLDOWN_SECONDS = 30;
  const [cooldownLeft, setCooldownLeft] = useState(0);
  useEffect(() => {
    if (cooldownLeft <= 0) return;
    const id = window.setTimeout(() => setCooldownLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldownLeft]);

  const statusDisplay = displayForStatus(syncStatus);

  const handleRetry = async () => {
    setCooldownLeft(RETRY_COOLDOWN_SECONDS);
    await writeSyncStatus('retrying');
    try {
      sendMessage({ action: YoursEventName.SYNC_RETRY });
    } catch (err) {
      console.error('[QueueBanner] failed to send retry message:', err);
    }
  };

  const retryLabel =
    cooldownLeft > 0
      ? `Retry in ${cooldownLeft}s`
      : syncStatus === 'retrying'
        ? 'Retrying…'
        : 'Retry sync';
  const retryDisabled = syncStatus === 'retrying' || cooldownLeft > 0;

  const walletReady = !!keysService?.bsvAddress;
  const showQueueProgress =
    walletReady &&
    showQueueBanner &&
    isSyncing &&
    syncStatus === 'healthy' &&
    !queueDismissed;
  const showStatusBanner =
    walletReady && statusDisplay.show && !showQueueProgress && !statusDismissed;

  if (!walletReady || !theme) return null;

  if (showQueueProgress) {
    return (
      <Banner theme={theme} $color="orange">
        <DismissX onClick={() => setQueueDismissed(true)} aria-label="Dismiss">
          ×
        </DismissX>
        <span>
          {importName && importName !== 'Wallet'
            ? `Importing ${importName}...`
            : `Syncing ${
                queueLength ? formatNumberWithCommasAndDecimals(queueLength, 0) : ''
              } transactions`}
        </span>
        <span style={{ fontSize: '0.65rem', fontWeight: 400, opacity: 0.8 }}>
          You can close the wallet during this process.
        </span>
        <Show when={!!fetchingTxid}>
          <span style={{ fontSize: '0.65rem', fontWeight: 500, opacity: 0.9 }}>
            {fetchingTxid ? truncate(fetchingTxid, 6, 6) : ''}
          </span>
        </Show>
      </Banner>
    );
  }

  if (showStatusBanner) {
    return (
      <Banner theme={theme} $color={statusDisplay.color}>
        <DismissX onClick={() => setStatusDismissed(true)} aria-label="Dismiss">
          ×
        </DismissX>
        <span>{statusDisplay.title}</span>
        <span style={{ fontSize: '0.65rem', fontWeight: 400, opacity: 0.85 }}>
          {statusDisplay.subtitle}
        </span>
        {statusDisplay.showRetry && (
          <RetryButton onClick={handleRetry} disabled={retryDisabled}>
            {retryLabel}
          </RetryButton>
        )}
      </Banner>
    );
  }

  return null;
};
