/**
 * Rolling 30-day budget window for BRC-73 spending authorization.
 *
 * Robert's call (2026-05-01): default 500K sats; "re-prompt if/when
 * budget runs out for another batch of same". Implemented as a rolling
 * 30-day window stored per-app under
 * `WhitelistedApp.groupPermissions.budgetUsage`.
 *
 * The pure helpers here just compute new state given current state +
 * input — the calling code is responsible for persisting the updated
 * BudgetUsage back to chrome.storage.
 */

import type { BudgetUsage, GrantedManifest } from '../types/brc73.types';

export const ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const initBudgetUsage = (now: number = Date.now()): BudgetUsage => ({
  windowStartMs: now,
  spentSats: 0,
});

/**
 * If the current window has elapsed, return a fresh window starting
 * `now`. Otherwise return the existing usage unchanged. Used at every
 * read to lazily reset the bucket.
 */
export const refreshWindow = (usage: BudgetUsage, now: number = Date.now()): BudgetUsage => {
  if (now - usage.windowStartMs >= ROLLING_WINDOW_MS) {
    return initBudgetUsage(now);
  }
  return usage;
};

/**
 * Returns whether the requested `addSats` would stay within the granted
 * budget. The budget is the manifest's spendingAuthorization.amount;
 * `usage.spentSats` is what's already been spent in the current window.
 * Returns false if the manifest has no spendingAuthorization slot.
 */
export const canSpend = (
  granted: GrantedManifest | undefined,
  addSats: number,
  now: number = Date.now(),
): boolean => {
  if (!granted) return false;
  const budget = granted.permissions.spendingAuthorization?.amount;
  if (typeof budget !== 'number' || budget <= 0) return false;
  if (addSats < 0) return false;
  const usage = refreshWindow(granted.budgetUsage, now);
  return usage.spentSats + addSats <= budget;
};

/**
 * Record a successful spend. Resets the window first if it has
 * elapsed. Returns the updated BudgetUsage; caller persists.
 */
export const recordSpend = (
  granted: GrantedManifest,
  addSats: number,
  now: number = Date.now(),
): BudgetUsage => {
  if (addSats < 0) throw new Error('recordSpend: addSats must be non-negative');
  const usage = refreshWindow(granted.budgetUsage, now);
  return {
    windowStartMs: usage.windowStartMs,
    spentSats: usage.spentSats + addSats,
  };
};

/**
 * Compute days remaining in the current rolling window. UI helper for
 * the Settings "Connected Apps" panel.
 */
export const daysRemainingInWindow = (usage: BudgetUsage, now: number = Date.now()): number => {
  const elapsed = now - usage.windowStartMs;
  const remaining = ROLLING_WINDOW_MS - elapsed;
  if (remaining <= 0) return 0;
  return remaining / (24 * 60 * 60 * 1000);
};
