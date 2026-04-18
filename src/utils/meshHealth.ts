/**
 * Anvil-Mesh health-check cache.
 *
 * Consumes the `upstream_status.broadcast` field from the configured
 * Anvil-Mesh node's `/mesh/status` endpoint (Node-Agent Path C
 * Deliverable 4). When `broadcast: "down"`, skip the Mesh path in
 * broadcastMultiSource() rather than waste a 5s timeout on a known-
 * degraded node.
 *
 * Cached for 30s — prevents a check-per-broadcast; a degraded node has
 * a few tens of seconds to recover before we retry it.
 *
 * Returns `null` when the Mesh is not configured or the status endpoint
 * is itself unreachable — broadcastMultiSource treats null as "try
 * Mesh anyway" so this is never the reason a broadcast fails.
 *
 * 2026-04-17 wallet re-fork patch 7/7.
 */

interface MeshStatusResponse {
  upstream_status?: {
    broadcast?: 'healthy' | 'degraded' | 'down';
    headers_sync_lag_secs?: number;
  };
}

let cache: {
  at: number;
  broadcast: 'healthy' | 'degraded' | 'down' | null;
} | null = null;

const CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 3_000;

export async function getMeshBroadcastHealth(): Promise<'healthy' | 'degraded' | 'down' | null> {
  // Cache hit?
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.broadcast;

  const nodeUrl = (typeof localStorage !== 'undefined' && localStorage.getItem('anvil_node_url')) || '';
  if (!nodeUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${nodeUrl.replace(/\/$/, '')}/mesh/status`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      cache = { at: Date.now(), broadcast: null };
      return null;
    }
    const data = (await res.json()) as MeshStatusResponse;
    const broadcast = data.upstream_status?.broadcast ?? null;
    cache = { at: Date.now(), broadcast };
    return broadcast;
  } catch {
    clearTimeout(timer);
    cache = { at: Date.now(), broadcast: null };
    return null;
  }
}

/** Test helper / manual reset. Primarily for unit tests. */
export function resetMeshHealthCache(): void {
  cache = null;
}
