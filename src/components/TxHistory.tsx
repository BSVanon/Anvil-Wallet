import { styled } from 'styled-components';
import { Theme, WhiteLabelTheme } from '../theme.types';
import { useServiceContext } from '../hooks/useServiceContext';
import { useEffect, useMemo, useState } from 'react';
import { HeaderText, Text } from './Reusable';
import {
  BSV_DECIMAL_CONVERSION,
  GENERIC_NFT_ICON,
  GENERIC_TOKEN_ICON,
  MNEE_DECIMALS,
  MNEE_SYM,
  URL_WHATSONCHAIN,
  URL_WHATSONCHAIN_TESTNET,
} from '../utils/constants';
import { FaTimes, FaChevronDown, FaChevronUp, FaLink, FaTag } from 'react-icons/fa'; // Import FaTag
import { TxLog } from 'spv-store';
import { mapGpHistoryToTxLogs } from '../utils/providerHelper';
import { getBlockTimestamps, formatBlockTime } from '../utils/blockTime';
import { Button } from './Button';
import bsvCoin from '../assets/bsv-coin.svg';
import lock from '../assets/lock.svg';
import { Show } from './Show';
import { NetWork } from 'yours-wallet-provider';
import { formatNumberWithCommasAndDecimals } from '../utils/format';
import {
  mergeReconciliationIntoBlockTimes,
  mergeIntoReconciliation,
  buildLogFromRecentBroadcast,
  mergeUniqueByTxid,
  sortActivityLogs,
} from './TxHistory.merge';
import {
  listRecentBroadcasts,
  recentBroadcastsKey,
  RECENT_BROADCASTS_EVENT,
} from '../utils/recentBroadcasts';
import {
  readDisplayCache,
  writeActivityCache,
  writeReconciliationCache,
  keyFromAccount,
} from '../services/DisplayCache.service';

const Container = styled.div<WhiteLabelTheme>`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  height: 100vh;
  overflow-y: auto;
  background-color: ${({ theme }) => theme.color.global.walletBackground};
  z-index: 1000;
  position: absolute;
`;

const HistoryRow = styled.div<WhiteLabelTheme>`
  display: flex;
  justify-content: space-between;
  align-items: center;
  background-color: ${({ theme }) => theme.color.global.row};
  width: 95%;
  padding: 0.5rem 1rem;
  border: 1px solid ${({ theme }) => theme.color.global.gray + '50'};
  border-radius: 0.5rem;
  transition: transform 0.3s ease-in-out;

  &:hover {
    transform: scale(1.02);
  }
`;

const Icon = styled.img<{ $isNFT?: boolean }>`
  width: 2.25rem;
  height: 2.25rem;
  border-radius: ${({ $isNFT }) => ($isNFT ? '0.25rem' : '50%')};
`;

const TickerWrapper = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`;

const ButtonsWrapper = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 40%;
  margin: 1rem 0;
`;

const TickerTextWrapper = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-left: 1rem;
`;

const ContentWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const BackWrapper = styled.div`
  position: absolute;
  top: 3rem;
  left: 2rem;
`;

const RowWrapper = styled.div`
  width: 95%;
  display: flex;
  justify-content: center;
  align-items: center;
  margin: 0.15rem 0;
`;

const BoundedContent = styled.div`
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
  width: 100%;
`;

const IconNameWrapper = styled.div`
  display: flex;
  gap: 0.5rem;
`;

const IconContent = styled.div`
  display: flex;
  gap: 0.5rem;
  position: relative;
  width: 2.5rem;
`;

const ListIconWrapper = styled.div<WhiteLabelTheme>`
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background-color: ${({ theme }) => theme.color.global.contrast};
  width: 2.25rem;
  height: 2.25rem;
`;

type Tag = 'bsv21' | 'bsv20' | 'origin' | 'list' | 'lock' | 'fund';

export type TxHistoryProps = {
  theme: Theme;
  onBack: () => void;
};

export const TxHistory = (props: TxHistoryProps) => {
  const { theme, onBack } = props;
  const [data, setData] = useState<TxLog[]>();
  const { oneSatSPV } = useServiceContext();
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 25;
  const { gorillaPoolService, chromeStorageService, keysService, wocService } = useServiceContext();
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [blockTimes, setBlockTimes] = useState<Map<number, number>>(new Map());
  // Reconciliation map: txid → WoC-confirmed {height, time} for rows
  // whose spv-store local TxLog has a stale height=0. Without this,
  // confirmed txs render as "Pending" forever — the user's natural
  // reaction is to retry-send, risking a double-spend. See project
  // memory `project_wallet_stale_pending_bug.md`.
  const [wocReconciliation, setWocReconciliation] = useState<
    Map<string, { height: number; time?: number }>
  >(new Map());
  const [isReconciling, setIsReconciling] = useState(false);
  const isTestnet = chromeStorageService.getNetwork() === NetWork.Testnet;

  // Codex 603d74df fix: namespace cache keys by (account, network).
  // Recompute per call site rather than memoize — chromeStorageService
  // is a stable singleton and the read is synchronous + cheap, while
  // memoization would risk staleness across account-switch.
  const deriveKeys = (): { cacheKey: string | undefined; broadcastsKey: string | undefined } => {
    try {
      const obj = chromeStorageService.getCurrentAccountObject();
      const network = chromeStorageService.getNetwork();
      return {
        cacheKey: keyFromAccount(obj?.selectedAccount, network),
        broadcastsKey: recentBroadcastsKey(obj?.selectedAccount, network),
      };
    } catch {
      return { cacheKey: undefined, broadcastsKey: undefined };
    }
  };

  const tagPriorityOrder: Tag[] = ['list', 'bsv21', 'bsv20', 'origin', 'lock', 'fund']; // The order of these tags will determine the order of the icons and which is prioritized

  // Re-trigger fetchData when local broadcast cache changes (e.g. user
  // just sent a tx — see Phase 2 P2.2). Bumping this counter is the
  // signal; the actual cache read happens inside fetchData.
  const [recentBroadcastsTick, setRecentBroadcastsTick] = useState(0);
  useEffect(() => {
    const handler = () => setRecentBroadcastsTick((n) => n + 1);
    window.addEventListener(RECENT_BROADCASTS_EVENT, handler);
    return () => window.removeEventListener(RECENT_BROADCASTS_EVENT, handler);
  }, []);

  // Phase 2.5: seed the Activity list from the persistent display
  // cache on mount so reopening the popup doesn't blank the list
  // while spv-store / GP / WoC reconcile in the background. This
  // closes the "order changes / Pending flickers between opens"
  // bug Robert reported on 2026-04-25.
  //
  // Also seed wocReconciliation + blockTimes from cache (Phase 2.5
  // hotfix #10): without these, every popup mount re-runs WoC
  // tx-status lookups for every Pending row, causing visible
  // Pending → date flicker as each fetch resolves. Cached lookups
  // mean known confirmed rows render with their resolved height
  // instantly — no per-mount per-tx network round-trip.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { cacheKey } = deriveKeys();
      const cache = await readDisplayCache(cacheKey);
      if (cancelled) return;
      if (cache.activity?.logs?.length) {
        // Sort on seed too — older cache writes may have used the
        // pre-stable-sort path. Always render in deterministic order.
        setData(sortActivityLogs(cache.activity.logs));
      }
      if (cache.reconciliation) {
        if (cache.reconciliation.wocByTxid.size > 0) {
          setWocReconciliation(cache.reconciliation.wocByTxid);
        }
        if (cache.reconciliation.blockTimes.size > 0) {
          setBlockTimes(cache.reconciliation.blockTimes);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      if (!oneSatSPV) return;

      const { cacheKey, broadcastsKey } = deriveKeys();

      // Local recent-broadcast cache — anything the wallet itself
      // broadcast in the last 7 days. Used to bridge the GP-indexer
      // lag window between broadcast success and the SPENT side
      // appearing in GP's address-history rows.
      const recents = listRecentBroadcasts(broadcastsKey);
      const recentLogs = recents.map(buildLogFromRecentBroadcast);

      // Read the persistent cache so it can be part of the merge.
      // This is critical: without it, a fresh fetch that returns
      // FEWER rows or rows with LOWER heights than the cache had
      // would lose data — exactly the "order shuffles + Pending
      // flicker + rows disappear" pattern Robert reported in
      // 2026-04-25 click-test. The merge below uses height-aware
      // semantics so cached confirmed rows are never regressed.
      const cache = await readDisplayCache(cacheKey);
      const cachedLogs = cache.activity?.logs ?? [];

      // Tier 1: spv-store local tx log.
      try {
        const tsx = await oneSatSPV.getRecentTxs();
        if (tsx && tsx.length > 0) {
          // 3-way union: spv-store fresh ∪ recent broadcasts ∪ cache.
          // mergeUniqueByTxid is height-aware: for any duplicate
          // txid, keep the row with the higher height.
          let merged = mergeUniqueByTxid(tsx, recentLogs);
          merged = mergeUniqueByTxid(merged, cachedLogs);
          merged = sortActivityLogs(merged);
          setData(merged);
          void writeActivityCache(cacheKey, merged);
          return;
        }
      } catch (error) {
        console.warn('[TxHistory] spv-store getRecentTxs failed, falling back to GorillaPool:', error);
      }

      // Tier 2: GorillaPool address history. Display-only —
      // shows receive events across the user's three addresses.
      if (!keysService || !gorillaPoolService) {
        // No GP either — at least serve cache + recents so user
        // doesn't see blank UI when both indexers fail.
        const fallback = sortActivityLogs(mergeUniqueByTxid(cachedLogs, recentLogs));
        if (fallback.length > 0) setData(fallback);
        else setData(sortActivityLogs(recentLogs));
        return;
      }
      try {
        const addresses = [
          keysService.bsvAddress,
          keysService.ordAddress,
          keysService.identityAddress,
        ].filter(Boolean);
        const allRows = (
          await Promise.all(
            addresses.map((addr) => gorillaPoolService.getTxHistoryByAddress(addr).catch(() => [])),
          )
        ).flat();
        const logs = mapGpHistoryToTxLogs(allRows);
        if (logs.length > 0) {
          console.warn(`[TxHistory] GorillaPool fallback returned ${logs.length} tx(s)`);
        }

        // Phase 2.5 hotfix #11: WoC tier-3 history fallback. GP's
        // address-history endpoint lags on incoming receives; WoC
        // catches what GP misses (Robert click-test 2026-04-25: a
        // BSV self-send didn't appear in Activity until this fix).
        // We only fetch the txid+height pairs; reconciliation
        // resolves block-time, and recent-broadcasts contributes
        // amount info for sends. Receives without amount info show
        // as $0 placeholder until spv-store catches up — better
        // than not appearing at all.
        const wocLogs: TxLog[] = [];
        if (wocService) {
          const allWocRows = (
            await Promise.all(addresses.map((addr) => wocService.getAddressHistory(addr)))
          ).flat();
          // Dedup by txid; build a minimal TxLog per entry.
          const seen = new Set<string>();
          for (const row of allWocRows) {
            if (!row?.tx_hash || seen.has(row.tx_hash)) continue;
            seen.add(row.tx_hash);
            wocLogs.push({
              txid: row.tx_hash,
              height: typeof row.height === 'number' ? row.height : 0,
              idx: 0,
              source: 'woc-fallback',
              summary: { fund: { amount: 0 } },
            } as unknown as TxLog);
          }
          if (wocLogs.length > 0) {
            console.warn(
              `[TxHistory] WoC tier-3 fallback returned ${wocLogs.length} tx(s)`,
            );
          }
        }

        // 4-way union: GP ∪ recent broadcasts ∪ cache ∪ WoC.
        // Order of merges matters only for tie-break on equal height
        // (primary wins). GP first because its summary is richest.
        let merged = mergeUniqueByTxid(logs, recentLogs);
        merged = mergeUniqueByTxid(merged, cachedLogs);
        merged = mergeUniqueByTxid(merged, wocLogs);
        merged = sortActivityLogs(merged);
        setData(merged);
        void writeActivityCache(cacheKey, merged);
      } catch (error) {
        console.error('[TxHistory] GorillaPool fallback error:', error);
        // Same fail-safe as the no-GP branch — show cache + recents
        // so user isn't left blank when fetching errors out.
        const fallback = sortActivityLogs(mergeUniqueByTxid(cachedLogs, recentLogs));
        if (fallback.length > 0) setData(fallback);
        else setData(sortActivityLogs(recentLogs));
      }
    };

    fetchData();
    // Codex 603d74df drift fix: include wocService in deps so the
    // exhaustive-deps lint warning clears AND so account-switch
    // (which re-binds the service) triggers a fresh fetch with the
    // correct cache key. `deriveKeys` is a stable closure over
    // chromeStorageService (also stable for the component lifetime),
    // so omitting it from deps is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oneSatSPV, keysService, gorillaPoolService, wocService, recentBroadcastsTick]);

  // Resolve block timestamps for every unique height in the data
  // set. Lazy + cached per-session by blockTime.ts. Merges into the
  // latest committed map via a functional updater so it doesn't
  // clobber entries the reconciliation effect (below) may have
  // committed first (Codex review fa8341064b38959a).
  useEffect(() => {
    if (!data || data.length === 0) return;
    const heights = data
      .map((t) => Number(t.height ?? 0))
      .filter((h) => h > 0);
    if (heights.length === 0) return;
    let cancelled = false;
    getBlockTimestamps(heights).then((fetched) => {
      if (cancelled) return;
      setBlockTimes((prev) => {
        const next = new Map(prev);
        for (const [h, t] of fetched) next.set(h, t);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [data]);

  // Reconcile stale-Pending rows against WoC. Triggers on every data
  // set where any row has `height <= 0`; queries WoC /tx/hash/{txid}
  // in parallel and caches confirmed heights/times per-txid per-session.
  // Re-running on the same data set is idempotent — we skip txids
  // already in the reconciliation map.
  useEffect(() => {
    if (!data || data.length === 0 || !wocService) return;
    const stale = data
      .filter((t) => !t.height || t.height <= 0)
      .filter((t) => !wocReconciliation.has(t.txid));
    // Phase 2.5 final-polish: also reconcile WoC tier-3 rows that
    // came in with summary {fund:{amount:0}} placeholder, so we can
    // populate a real amount via WoC tx-vout sum at user's addresses.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tier3NoAmount = data.filter((t: any) =>
      t.source === 'woc-fallback' &&
      ((t.summary?.fund?.amount ?? 0) === 0) &&
      !wocReconciliation.has(t.txid),
    );
    const toReconcile = [...stale, ...tier3NoAmount.filter((t) => !stale.includes(t))];
    if (toReconcile.length === 0) return;
    let cancelled = false;
    setIsReconciling(true);
    (async () => {
      // Fetch in parallel but bounded — a fresh visit to a page with
      // 25 "Pending" rows would otherwise hammer WoC. 6-at-a-time is
      // conservative and matches WoC's public rate limits.
      const BATCH = 6;
      const additions: Array<[string, { height: number; time?: number }]> = [];
      const amountAdditions: Array<[string, number]> = [];
      const userAddresses = [
        keysService?.bsvAddress,
        keysService?.ordAddress,
        keysService?.identityAddress,
      ].filter(Boolean) as string[];
      for (let i = 0; i < toReconcile.length; i += BATCH) {
        if (cancelled) return;
        const chunk = toReconcile.slice(i, i + BATCH);
        const results = await Promise.all(
          chunk.map((t) => wocService.getTxStatus(t.txid, userAddresses)),
        );
        for (let j = 0; j < chunk.length; j++) {
          const status = results[j];
          if (status?.confirmed && status.blockHeight) {
            additions.push([
              chunk[j].txid,
              { height: status.blockHeight, time: status.blockTime },
            ]);
          }
          if (status?.userOutputSats !== undefined && status.userOutputSats > 0) {
            amountAdditions.push([chunk[j].txid, status.userOutputSats]);
          }
        }
      }
      if (cancelled) return;
      if (additions.length > 0) {
        // Functional updates only — the height-loader effect can resolve
        // either before or after this batch finishes, and reading either
        // map from closure scope risks stomping the other effect's writes
        // (Codex review fa8341064b38959a). Always merge into the latest
        // committed state.
        setWocReconciliation((prev) => mergeIntoReconciliation(prev, additions));
        // Prime the blockTimes cache so reconciled rows use the same
        // formatBlockTime path as natively-confirmed rows. Same race
        // sensitivity — go through the functional updater.
        setBlockTimes((prev) => mergeReconciliationIntoBlockTimes(prev, additions));
      }
      // Patch each row's summary.fund.amount in-place for tier-3 rows
      // that we just enriched. setData with the same array reference
      // wouldn't re-render, so we rebuild and re-sort.
      if (amountAdditions.length > 0) {
        const amountByTxid = new Map(amountAdditions);
        setData((prev) => {
          if (!prev) return prev;
          let mutated = false;
          const next = prev.map((row) => {
            const sats = amountByTxid.get(row.txid);
            if (sats === undefined) return row;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fund = (row.summary as any)?.fund;
            if (!fund || fund.amount !== 0) return row;
            mutated = true;
            return {
              ...row,
              summary: {
                ...row.summary,
                fund: { ...fund, amount: sats },
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any;
          });
          return mutated ? next : prev;
        });
      }
    })()
      .catch(() => {
        /* WoC unreachable — rows just stay as "Pending" until next open */
      })
      .finally(() => {
        if (!cancelled) setIsReconciling(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, wocService]);

  // Phase 2.5 hotfix #10: persist reconciliation state whenever it
  // changes so the next popup mount renders confirmed rows without
  // re-fetching WoC for each one. Debounce-friendly via the natural
  // useEffect coalescing — React batches rapid state changes.
  useEffect(() => {
    if (wocReconciliation.size === 0 && blockTimes.size === 0) return;
    const { cacheKey } = deriveKeys();
    void writeReconciliationCache(cacheKey, { wocByTxid: wocReconciliation, blockTimes });
    // deriveKeys is a stable closure over chromeStorageService (also
    // stable). Intentional omission — same rationale as fetchData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wocReconciliation, blockTimes]);

  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return data?.slice(startIndex, endIndex);
  }, [currentPage, data]);

  const handleNextPage = () => {
    if (currentPage * itemsPerPage < (data?.length ?? 0)) {
      setCurrentPage(currentPage + 1);
    }
  };

  const handlePreviousPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
    }
  };

  const handleOpenLink = (txid: string) => {
    const url = isTestnet ? `${URL_WHATSONCHAIN_TESTNET}${txid}` : `${URL_WHATSONCHAIN}${txid}`;
    window.open(url, '_blank');
  };

  const getIconForSummary = (tag: Tag, icon?: string) => {
    switch (tag) {
      case 'fund':
        return <Icon src={bsvCoin} alt="Fund Icon" />;
      case 'lock':
        return <Icon src={lock} alt="Lock Icon" />;
      case 'list':
        return (
          <ListIconWrapper theme={theme}>
            <FaTag style={{ width: '1rem', height: '1rem', color: theme.color.global.neutral }} />
          </ListIconWrapper>
        );
      default:
        return icon ? (
          <Icon
            src={`${gorillaPoolService.getBaseUrl(chromeStorageService.getNetwork())}/content/${icon}`}
            alt="Summary Icon"
            $isNFT={tag === 'origin'}
          />
        ) : tag === ('origin' as Tag) ? (
          <Icon src={GENERIC_NFT_ICON} alt="Generic NFT Icon" />
        ) : (
          <Icon src={GENERIC_TOKEN_ICON} alt="Generic Token Icon" />
        );
    }
  };

  const sortEntriesByPriority = (entries: [Tag, { id?: string; icon?: string; amount?: number }][]) => {
    return entries.sort((a, b) => {
      const aPriority = tagPriorityOrder.indexOf(a[0]);
      const bPriority = tagPriorityOrder.indexOf(b[0]);
      return (aPriority === -1 ? Infinity : aPriority) - (bPriority === -1 ? Infinity : bPriority);
    });
  };

  const toggleRowExpansion = (uniqueId: string) => {
    setExpandedRows((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(uniqueId)) newSet.delete(uniqueId);
      else newSet.add(uniqueId);
      return newSet;
    });
  };

  const getHeaderText = (tag: Tag, tokenName?: string) => {
    switch (tag) {
      case 'bsv21':
      case 'bsv20':
        return tokenName || 'Token';
      case 'origin':
        return 'NFT';
      case 'list':
        return 'Listing';
      case 'lock':
        return 'Lock';
      case 'fund':
        return 'BSV';
      default:
        return 'Unknown';
    }
  };

  const getDescriptionText = (tag: Tag, amount: number) => {
    switch (tag) {
      case 'list':
        return amount === -1 ? 'Listed for sale' : amount === 0 ? 'Cancelled listing' : 'Purchased listing';
      case 'lock':
        return 'Lock contract';
      default:
        return amount === 0 ? 'Transfer' : amount > 0 ? 'Received' : 'Sent';
    }
  };

  const getAmountText = (tag: Tag, amount: number) => {
    switch (tag) {
      case 'fund':
        return amount / BSV_DECIMAL_CONVERSION;
      case 'bsv21':
      case 'bsv20':
        return amount;
      case 'lock':
        return amount / BSV_DECIMAL_CONVERSION + ' BSV';
      default:
        return amount.toLocaleString() + ' sats';
    }
  };

  const formatMNEEAmount = (amount: number) => {
    return formatNumberWithCommasAndDecimals(
      getAmountText('bsv21', amount) as number,
      Math.abs(amount) >= 0.01 ? 2 : MNEE_DECIMALS,
    );
  };

  return (
    <Container theme={theme}>
      <BackWrapper>
        <FaTimes size={'1.5rem'} color={theme.color.global.contrast} cursor="pointer" onClick={onBack} />
      </BackWrapper>
      <Text style={{ marginTop: '3rem', fontSize: '1.25rem', fontWeight: 700 }} theme={theme}>
        Recent Activity
      </Text>
      <Show when={isReconciling}>
        <Text
          theme={theme}
          style={{
            fontSize: '0.7rem',
            color: theme.color.global.gray,
            margin: '0.25rem 0 0.25rem 0',
          }}
        >
          Reconciling confirmation status against WhatsOnChain…
        </Text>
      </Show>
      {(paginatedData || []).length > 0 ? (
        paginatedData?.map((t) => {
          const summaryEntries = sortEntriesByPriority(
            Object.entries(t.summary || {}).filter(([key]) => tagPriorityOrder.includes(key as Tag)) as [
              Tag,
              { id?: string; icon?: string; amount?: number },
            ][],
          );
          const uniqueId = `${t.txid}-${t.idx}`;
          const isExpanded = expandedRows.has(uniqueId);
          return (
            <RowWrapper key={uniqueId}>
              <HistoryRow
                theme={theme}
                onClick={summaryEntries.length > 1 ? () => toggleRowExpansion(uniqueId) : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  cursor: summaryEntries.length > 1 ? 'pointer' : 'default',
                  color: theme.color.global.gray,
                }}
              >
                <TickerWrapper style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {summaryEntries.slice(0, isExpanded ? summaryEntries.length : 1).map(([key, value], idx) => (
                    <BoundedContent key={idx}>
                      <IconNameWrapper>
                        <IconContent>
                          {isExpanded
                            ? getIconForSummary(key, value.icon)
                            : summaryEntries.slice(0, 3).map(([key, value], iconIdx) => (
                                <div
                                  key={iconIdx}
                                  style={{
                                    position: 'absolute',
                                    left: `${iconIdx * 0.75}rem`,
                                    zIndex: 3 - iconIdx,
                                  }}
                                >
                                  {getIconForSummary(key, value.icon)}
                                </div>
                              ))}
                        </IconContent>
                        <TickerTextWrapper>
                          <HeaderText style={{ fontSize: '0.85rem', marginTop: 0, fontWeight: 700 }} theme={theme}>
                            {getHeaderText(key, value.id)}
                          </HeaderText>
                          <Text
                            theme={theme}
                            style={{
                              color: theme.color.global.gray,
                              fontSize: '0.75rem',
                              margin: 0,
                              textAlign: 'left',
                              width: '100%',
                            }}
                          >
                            {getDescriptionText(key, value.amount ?? 0)}
                            {' · '}
                            {(() => {
                              // Prefer spv-store's local height when present;
                              // fall back to WoC reconciliation for rows
                              // whose local TxLog is stale at height=0.
                              const localHeight = t.height > 0 ? t.height : 0;
                              const reconciled = wocReconciliation.get(t.txid);
                              const effectiveHeight = localHeight > 0 ? localHeight : (reconciled?.height ?? 0);
                              const effectiveTime =
                                effectiveHeight > 0 ? blockTimes.get(effectiveHeight) : undefined;
                              return formatBlockTime(effectiveTime);
                            })()}
                          </Text>
                        </TickerTextWrapper>
                      </IconNameWrapper>
                      <ContentWrapper>
                        <HeaderText
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 900,
                            margin: 0,
                            color: value?.amount
                              ? value.amount >= 1
                                ? theme.color.component.primaryButtonLeftGradient
                                : key === 'origin' && value.amount === -1 // If an NFT is sent
                                  ? 'transparent'
                                  : theme.color.global.contrast
                              : 'transparent',
                            textAlign: 'right',
                          }}
                          theme={theme}
                        >
                          {value.amount && value.amount > 0 ? '+' : ''}
                          {value.id === MNEE_SYM
                            ? formatMNEEAmount(value.amount ?? 0)
                            : getAmountText(key, value.amount ?? 0)}
                        </HeaderText>
                        <Show when={idx === 0}>
                          <FaLink
                            onClick={() => handleOpenLink(t.txid)}
                            style={{ cursor: 'pointer', color: theme.color.component.primaryButtonLeftGradient }}
                            title="See transaction in Whatsonchain"
                          />
                        </Show>
                        {idx === 0 && summaryEntries.length > 1 ? (
                          isExpanded ? (
                            <FaChevronUp />
                          ) : (
                            <FaChevronDown />
                          )
                        ) : (
                          <span style={{ display: 'inline-block', width: '12px', height: '16px' }} />
                        )}
                      </ContentWrapper>
                    </BoundedContent>
                  ))}
                </TickerWrapper>
              </HistoryRow>
            </RowWrapper>
          );
        })
      ) : (
        <Text theme={theme}>No transaction records found.</Text>
      )}
      <ButtonsWrapper>
        <Button
          theme={theme}
          type="secondary"
          label="Previous"
          style={{ marginTop: '0.5rem' }}
          disabled={currentPage === 1}
          onClick={handlePreviousPage}
        />
        <Button
          theme={theme}
          type="secondary"
          label="Next"
          onClick={handleNextPage}
          disabled={currentPage * itemsPerPage >= (data?.length ?? 0)}
        />
      </ButtonsWrapper>
    </Container>
  );
};
