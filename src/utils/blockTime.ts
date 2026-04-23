/**
 * Block-height → Unix timestamp lookup with a per-session memory
 * cache. Used by TxHistory to show an approximate date/time next to
 * each activity row when the spv-store local data isn't available
 * (it carries block.time natively; the GorillaPool fallback only
 * carries height).
 *
 * Fetches from WhatsOnChain `/block/height/{height}/header` which
 * returns the compact header including `time` (seconds). We cache
 * per-height inside the service-worker / popup context for as long
 * as the JS lives.
 *
 * Never throws — on error returns undefined so the UI just omits the
 * timestamp for that row rather than breaking the Activity render.
 */

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main';
const cache = new Map<number, number>();
const pending = new Map<number, Promise<number | undefined>>();

export async function getBlockTimestamp(height: number): Promise<number | undefined> {
  if (!height || !Number.isFinite(height) || height <= 0) return undefined;
  const cached = cache.get(height);
  if (cached !== undefined) return cached;
  const existing = pending.get(height);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await fetch(`${WOC_BASE}/block/height/${height}/header`);
      if (!res.ok) return undefined;
      const data = (await res.json()) as { time?: number };
      if (typeof data?.time !== 'number') return undefined;
      cache.set(height, data.time);
      return data.time;
    } catch {
      return undefined;
    } finally {
      pending.delete(height);
    }
  })();
  pending.set(height, p);
  return p;
}

/**
 * Batched variant — fetch block times for a list of heights in
 * parallel with deduplication. Non-blocking per-height: each promise
 * resolves with its own timestamp or undefined. Used by TxHistory to
 * kick off all needed lookups when the tx list loads, so the dates
 * appear a beat after the rows.
 */
export async function getBlockTimestamps(
  heights: number[],
): Promise<Map<number, number>> {
  const unique = Array.from(new Set(heights.filter((h) => Number.isFinite(h) && h > 0)));
  const results = await Promise.all(
    unique.map(async (h) => [h, await getBlockTimestamp(h)] as const),
  );
  const out = new Map<number, number>();
  for (const [h, t] of results) {
    if (t !== undefined) out.set(h, t);
  }
  return out;
}

/**
 * Format a Unix timestamp (seconds) into a relative-time string like
 * "5 min ago" / "3 hr ago" / "Apr 22". Returns "Pending" for
 * undefined (mempool / unknown) heights.
 */
export function formatBlockTime(seconds: number | undefined): string {
  if (seconds === undefined) return 'Pending';
  const now = Math.floor(Date.now() / 1000);
  const delta = now - seconds;
  if (delta < 0) return 'Just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 604800) return `${Math.floor(delta / 86400)}d ago`;
  // Older than a week — show absolute date.
  const d = new Date(seconds * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
