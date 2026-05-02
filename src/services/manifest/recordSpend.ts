/**
 * Persist a successful BRC-73-covered spend back to chrome.storage —
 * incrementing the budget usage on the WhitelistedApp's GrantedManifest
 * so subsequent operations within the same window see the updated
 * spentSats.
 *
 * Called from the popup-side request handlers (BsvSendRequest etc.)
 * after a covered transaction has actually broadcast successfully.
 * Failure to persist is logged but not surfaced — the spend already
 * happened on-chain, and the worst case is one extra prompt next time.
 */

import type { ChromeStorageService } from '../ChromeStorage.service';
import type { ChromeStorageObject } from '../types/chromeStorage.types';
import type { WhitelistedApp } from '../../inject';
import { recordSpend as computeRecordSpend } from './budgetTracker';

export const persistCoveredSpend = async (
  chromeStorageService: ChromeStorageService,
  identityAddress: string,
  domain: string | undefined,
  sats: number,
): Promise<void> => {
  if (!domain || sats <= 0) return;
  const { account } = chromeStorageService.getCurrentAccountObject();
  if (!account) return;

  const whitelist = account.settings.whitelist ?? [];
  const idx = whitelist.findIndex((w: WhitelistedApp) => w.domain === domain);
  if (idx < 0) return;
  const entry = whitelist[idx];
  if (!entry.groupPermissions) return;

  const updatedUsage = computeRecordSpend(entry.groupPermissions, sats);
  const updatedEntry: WhitelistedApp = {
    ...entry,
    groupPermissions: {
      ...entry.groupPermissions,
      budgetUsage: updatedUsage,
    },
  };
  const newWhitelist = [...whitelist];
  newWhitelist[idx] = updatedEntry;

  const key: keyof ChromeStorageObject = 'accounts';
  const update: Partial<ChromeStorageObject['accounts']> = {
    [identityAddress]: {
      ...account,
      settings: {
        ...account.settings,
        whitelist: newWhitelist,
      },
    },
  };
  try {
    await chromeStorageService.updateNested(key, update);
  } catch (err) {
    console.warn('[BRC-73] failed to persist covered-spend budget update', err);
  }
};
