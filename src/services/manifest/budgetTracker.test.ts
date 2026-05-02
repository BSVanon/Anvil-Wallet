/**
 * Budget tracker tests — rolling 30-day window for BRC-73 spending
 * authorization. Verifies window expiry, cumulative spend, and the
 * `canSpend` boolean against the manifest's monthly limit.
 *
 * All tests pass an explicit `now` value to keep the rolling window
 * deterministic and avoid Date.now() drift relative to the fixtures.
 */

import {
  ROLLING_WINDOW_MS,
  initBudgetUsage,
  refreshWindow,
  canSpend,
  recordSpend,
  daysRemainingInWindow,
} from './budgetTracker';
import type { GrantedManifest } from '../types/brc73.types';

const T0 = 1_000_000_000_000; // arbitrary fixed epoch

const buildGranted = (
  amount: number | null,
  spentSats = 0,
  windowStartMs = T0,
): GrantedManifest => ({
  permissions: amount === null ? {} : { spendingAuthorization: { amount, description: 'test' } },
  grantedAt: T0,
  source: 'fetched',
  budgetUsage: { windowStartMs, spentSats },
});

describe('initBudgetUsage', () => {
  it('starts with windowStartMs=now and zero spent', () => {
    const u = initBudgetUsage(1234);
    expect(u.windowStartMs).toBe(1234);
    expect(u.spentSats).toBe(0);
  });
});

describe('refreshWindow', () => {
  it('returns the same usage if window has not elapsed', () => {
    const u = { windowStartMs: T0, spentSats: 100_000 };
    const out = refreshWindow(u, T0 + ROLLING_WINDOW_MS - 1);
    expect(out).toBe(u);
  });

  it('resets to a fresh window when elapsed', () => {
    const u = { windowStartMs: T0, spentSats: 100_000 };
    const now = T0 + ROLLING_WINDOW_MS;
    const out = refreshWindow(u, now);
    expect(out.windowStartMs).toBe(now);
    expect(out.spentSats).toBe(0);
  });
});

describe('canSpend', () => {
  it('returns false when no manifest is granted', () => {
    expect(canSpend(undefined, 1, T0)).toBe(false);
  });

  it('returns false when manifest has no spendingAuthorization', () => {
    const g = buildGranted(null);
    expect(canSpend(g, 1, T0)).toBe(false);
  });

  it('returns true when within budget', () => {
    const g = buildGranted(500_000, 100_000);
    expect(canSpend(g, 200_000, T0 + 1000)).toBe(true);
  });

  it('returns false when spend would exceed budget', () => {
    const g = buildGranted(500_000, 400_000);
    expect(canSpend(g, 200_000, T0 + 1000)).toBe(false);
  });

  it('exact-fit at budget edge is allowed', () => {
    const g = buildGranted(500_000, 0);
    expect(canSpend(g, 500_000, T0 + 1000)).toBe(true);
    expect(canSpend(g, 500_001, T0 + 1000)).toBe(false);
  });

  it('rolling window reset re-allows spending after expiry', () => {
    const g = buildGranted(500_000, 500_000, T0);
    expect(canSpend(g, 100_000, T0 + ROLLING_WINDOW_MS / 2)).toBe(false);
    // After window expires, the bucket resets implicitly.
    expect(canSpend(g, 100_000, T0 + ROLLING_WINDOW_MS)).toBe(true);
  });

  it('rejects negative addSats', () => {
    const g = buildGranted(500_000, 0);
    expect(canSpend(g, -1, T0)).toBe(false);
  });
});

describe('recordSpend', () => {
  it('increments spentSats within the same window', () => {
    const g = buildGranted(500_000, 100_000, T0);
    const u = recordSpend(g, 50_000, T0 + 2000);
    expect(u.windowStartMs).toBe(T0);
    expect(u.spentSats).toBe(150_000);
  });

  it('resets the window first if it has elapsed', () => {
    const g = buildGranted(500_000, 400_000, T0);
    const now = T0 + ROLLING_WINDOW_MS + 1;
    const u = recordSpend(g, 50_000, now);
    expect(u.windowStartMs).toBe(now);
    expect(u.spentSats).toBe(50_000);
  });

  it('throws on negative addSats', () => {
    const g = buildGranted(500_000, 0);
    expect(() => recordSpend(g, -1, T0)).toThrow();
  });
});

describe('daysRemainingInWindow', () => {
  it('returns 30 at the start of a window', () => {
    const u = { windowStartMs: T0, spentSats: 0 };
    const days = daysRemainingInWindow(u, T0);
    expect(days).toBeCloseTo(30, 1);
  });

  it('returns 0 once the window has fully elapsed', () => {
    const u = { windowStartMs: T0, spentSats: 0 };
    expect(daysRemainingInWindow(u, T0 + ROLLING_WINDOW_MS)).toBe(0);
    expect(daysRemainingInWindow(u, T0 + ROLLING_WINDOW_MS + 999)).toBe(0);
  });
});
