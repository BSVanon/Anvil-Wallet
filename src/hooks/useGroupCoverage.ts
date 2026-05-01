/**
 * BRC-73 coverage hook — drop-in for the popup-side request pages.
 *
 * One-shot lookup at mount: returns the requestingDomain (set by
 * background.ts on every typed request), the granted manifest from
 * the current account's whitelist, a `check` callback that runs
 * `checkGroupCoverage` against any CoverageRequest the caller
 * supplies, and a `recordCoveredSpend` callback for budget updates.
 *
 * Why `check` is a callback, not a precomputed `result`:
 * some handlers (OrdPurchase, MNEESend) depend on async-loaded data
 * (price, basket name, etc.) that isn't available at mount. Returning
 * a callable lets the auto-resolve effect re-evaluate coverage when
 * the dependent data settles, without re-running the storage lookup.
 */

import { useEffect, useState, useCallback } from 'react';
import { useServiceContext } from './useServiceContext';
import {
  checkGroupCoverage,
  findGrantedManifest,
  type CoverageRequest,
  type CoverageResult,
} from '../services/manifest/checkGroupCoverage';
import { persistCoveredSpend } from '../services/manifest/recordSpend';
import type { GrantedManifest } from '../services/types/brc73.types';

export type UseGroupCoverageOutput = {
  /**
   * `false` until the storage lookup completes. Auto-resolve effects
   * should wait for `loaded === true` before deciding what to do.
   */
  loaded: boolean;
  granted: GrantedManifest | undefined;
  domain: string | undefined;
  /**
   * Run a coverage check against the granted manifest using the
   * caller-supplied CoverageRequest. Always returns a CoverageResult;
   * pre-load the function returns `{covered: false, reason: 'not loaded'}`.
   */
  check: (request: CoverageRequest) => CoverageResult;
  /**
   * Update the rolling-window budget after a successful covered spend.
   * No-op if domain is missing or amount is zero.
   */
  recordCoveredSpend: (sats: number) => Promise<void>;
};

export const useGroupCoverage = (): UseGroupCoverageOutput => {
  const { chromeStorageService, keysService } = useServiceContext();
  const [loaded, setLoaded] = useState(false);
  const [granted, setGranted] = useState<GrantedManifest | undefined>(undefined);
  const [domain, setDomain] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const lookup = async () => {
      const storage = await chromeStorageService.getAndSetStorage();
      const requestingDomain = storage?.requestingDomain;
      const { account } = chromeStorageService.getCurrentAccountObject();
      const whitelist = account?.settings.whitelist;
      const grantedManifest = findGrantedManifest(whitelist, requestingDomain);
      if (cancelled) return;
      setDomain(requestingDomain);
      setGranted(grantedManifest);
      setLoaded(true);
    };
    lookup().catch((err) => {
      console.warn('[BRC-73] coverage lookup failed', err);
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [chromeStorageService]);

  const check = useCallback(
    (request: CoverageRequest): CoverageResult => {
      if (!loaded) return { covered: false, reason: 'not loaded' };
      return checkGroupCoverage(granted, request);
    },
    [loaded, granted],
  );

  const recordCoveredSpend = useCallback(
    async (sats: number) => {
      const identityAddress = keysService.identityAddress;
      if (!identityAddress) return;
      await persistCoveredSpend(chromeStorageService, identityAddress, domain, sats);
    },
    [chromeStorageService, keysService.identityAddress, domain],
  );

  return { loaded, granted, domain, check, recordCoveredSpend };
};
