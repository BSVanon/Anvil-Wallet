/**
 * Fetch and validate a BRC-73 manifest from `https://{origin}/manifest.json`.
 *
 * Returns the parsed `GroupPermissions` if a well-formed manifest is
 * served; null otherwise. Failures are silent — connect flow falls back
 * to the app-passed manifest (if any) or the legacy per-tx-prompt path.
 *
 * Origin is normalized (trailing-slash trimmed; protocol forced https
 * unless the origin is localhost / 127.0.0.1 for dev).
 */

import type { Brc73Manifest, GroupPermissions } from '../types/brc73.types';

const MANIFEST_FETCH_TIMEOUT_MS = 5_000;

/**
 * Build the canonical manifest URL for a given origin string.
 *
 * Accepts:  `anvilswap.com`, `https://anvilswap.com`, `http://localhost:5173`.
 * Returns:  `https://anvilswap.com/manifest.json`,
 *           `http://localhost:5173/manifest.json`.
 */
export const buildManifestUrl = (origin: string): string | null => {
  if (!origin) return null;
  let normalized = origin.trim();
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);

  // If no protocol provided, infer https (or http for loopback dev).
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    const isLoopback = normalized.startsWith('localhost') || normalized.startsWith('127.0.0.1');
    normalized = `${isLoopback ? 'http' : 'https'}://${normalized}`;
  }

  // Strip path/query if caller passed a full URL.
  try {
    const u = new URL(normalized);
    return `${u.origin}/manifest.json`;
  } catch {
    return null;
  }
};

/**
 * Extract the BRC-73 groupPermissions slot from a parsed manifest,
 * preferring the canonical `metanet.groupPermissions` namespace and
 * falling back to the deprecated `babbage.groupPermissions`.
 */
export const extractGroupPermissions = (manifest: Brc73Manifest | null): GroupPermissions | null => {
  if (!manifest || typeof manifest !== 'object') return null;
  const fromMetanet = manifest['metanet.groupPermissions'];
  if (isValidGroupPermissions(fromMetanet)) return fromMetanet;
  const fromBabbage = manifest['babbage.groupPermissions'];
  if (isValidGroupPermissions(fromBabbage)) return fromBabbage;
  return null;
};

/**
 * Shape-validate a candidate groupPermissions object. Permissive — any
 * unknown extra fields are tolerated. Each declared category must be
 * the right kind (array vs object) and individual entries must have
 * the required fields per spec.
 */
export const isValidGroupPermissions = (gp: unknown): gp is GroupPermissions => {
  if (!gp || typeof gp !== 'object') return false;
  const obj = gp as Record<string, unknown>;

  if (obj.protocolPermissions !== undefined) {
    if (!Array.isArray(obj.protocolPermissions)) return false;
    for (const p of obj.protocolPermissions) {
      const pp = p as Record<string, unknown>;
      if (!pp || typeof pp !== 'object') return false;
      if (!Array.isArray(pp.protocolID) || pp.protocolID.length !== 2) return false;
      if (typeof pp.protocolID[0] !== 'number') return false;
      if (typeof pp.protocolID[1] !== 'string') return false;
      if (typeof pp.description !== 'string') return false;
    }
  }

  if (obj.spendingAuthorization !== undefined) {
    const sa = obj.spendingAuthorization as Record<string, unknown>;
    if (!sa || typeof sa !== 'object') return false;
    if (typeof sa.amount !== 'number' || sa.amount < 0) return false;
    if (typeof sa.description !== 'string') return false;
  }

  if (obj.basketAccess !== undefined) {
    if (!Array.isArray(obj.basketAccess)) return false;
    for (const b of obj.basketAccess) {
      const ba = b as Record<string, unknown>;
      if (!ba || typeof ba !== 'object') return false;
      if (typeof ba.basket !== 'string') return false;
      if (typeof ba.description !== 'string') return false;
    }
  }

  if (obj.certificateAccess !== undefined) {
    if (!Array.isArray(obj.certificateAccess)) return false;
    for (const c of obj.certificateAccess) {
      const ca = c as Record<string, unknown>;
      if (!ca || typeof ca !== 'object') return false;
      if (typeof ca.type !== 'string') return false;
      if (!Array.isArray(ca.fields) || ca.fields.some((f) => typeof f !== 'string')) return false;
      if (typeof ca.verifierPublicKey !== 'string') return false;
      if (typeof ca.description !== 'string') return false;
    }
  }

  return true;
};

/**
 * Fetch the manifest at `${origin}/manifest.json` and return its
 * groupPermissions slot. Returns null on any failure (network, non-2xx,
 * malformed JSON, missing/invalid groupPermissions). Caller falls back
 * to app-passed manifest in that case.
 */
export const fetchManifest = async (
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GroupPermissions | null> => {
  const url = buildManifestUrl(origin);
  if (!url) return null;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeoutHandle = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS);
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      // Don't send credentials — manifest is public.
      credentials: 'omit',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Brc73Manifest;
    return extractGroupPermissions(json);
  } catch {
    return null;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
};
