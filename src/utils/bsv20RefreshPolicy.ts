/**
 * Decide whether a fresh `ordinalService.getBsv20s()` result should
 * overwrite the BSV-21 state + cache in BsvWallet.
 *
 * History:
 *
 * - **Phase 2.5 (2026-04-25)**: A guard was introduced in BsvWallet
 *   that only updated state + cache when `res.length > 0`. The
 *   stated reason: spv-store's `getBsv20s()` returns `[]` while its
 *   ordinal index sync is incomplete, and overwriting cached state
 *   with that empty stub made tokens (e.g. Pumpkin) silently
 *   disappear from the Coins list mid-sync. The guard preserved the
 *   cache against degraded reads.
 *
 * - **2026-05-02 cucumber regression**: that guard turned into the
 *   opposite bug. `ordinalService.getBsv20s()` no longer goes through
 *   spv-store — it hits GorillaPool's `/api/bsv20/balance` endpoint
 *   directly via `gorillaPoolService.getBsv20Balances`. GP's empty
 *   response IS authoritative: the user truly has zero BSV-21
 *   holdings at the queried addresses. The guard meant that after a
 *   user fully drained a token (Robert's case: deploy tx consumed
 *   the cucumber deploy UTXO), the wallet kept showing the
 *   pre-drain balance forever — the cache was never replaced. See
 *   `LAUNCH_RUNBOOK.md` "A6. UX bugs … wallet stale UTXO cache."
 *
 * Policy: an array result (including empty) is a successful fetch
 * and should overwrite. A non-array (undefined, null, anything that
 * came back from a try/catch shape we don't recognize) is treated
 * as "no fresh data, keep the cache." Network failures throw out of
 * `getBsv20Balances` before this check — those don't reach the
 * cache write at all.
 */
export const shouldOverwriteBsv20sCache = (
  fetchResult: unknown,
): fetchResult is unknown[] => Array.isArray(fetchResult);
