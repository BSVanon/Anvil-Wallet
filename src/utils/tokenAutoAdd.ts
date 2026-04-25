/**
 * Auto-add newly-detected BSV-21 tokens to the user's favorites list.
 *
 * Default upstream Yours behavior is to require manual "Manage Tokens
 * List" curation before a held token shows in Coins. That violates the
 * principle "if you hold it, the wallet should show it" — users have
 * been confused (Phase 2 P2.4: Robert's Pumpkin holdings were invisible
 * despite balance reflecting them).
 *
 * Tradeoff: just removing the favorites filter would force-show every
 * scammy / unwanted token. Auto-adding *new* tokens preserves user
 * curation: once you remove something from favorites, the wallet
 * remembers via `seenTokens` and won't re-add it on the next detection
 * cycle.
 *
 * Pure function so it's unit-testable without ChromeStorageService.
 */

export interface AutoAddResult {
  /** Token IDs that should be added to favoriteTokens. */
  toAddToFavorites: string[];
  /** Updated `seenTokens` list — reflects every token we've now considered. */
  nextSeenTokens: string[];
}

/**
 * Decide which detected token IDs are NEW (never auto-considered before)
 * and should therefore be added to favorites. A token already in
 * `seenTokens` but not in `favoriteTokens` was explicitly removed by
 * the user — leave it alone.
 *
 * Inputs are immutable; result is fresh arrays, ready to be persisted.
 */
export function computeTokenAutoAdd(args: {
  detectedTokenIds: string[];
  favoriteTokens: string[];
  seenTokens?: string[];
}): AutoAddResult {
  const { detectedTokenIds, favoriteTokens } = args;
  const seenTokens = args.seenTokens ?? [];
  const seenSet = new Set(seenTokens);
  const favSet = new Set(favoriteTokens);
  const toAddToFavorites: string[] = [];
  const nextSeen = seenTokens.slice();

  for (const id of detectedTokenIds) {
    if (!id) continue;
    if (seenSet.has(id)) continue; // already considered; respect user state
    nextSeen.push(id);
    seenSet.add(id);
    if (!favSet.has(id)) {
      toAddToFavorites.push(id);
      favSet.add(id);
    }
  }

  return { toAddToFavorites, nextSeenTokens: nextSeen };
}
