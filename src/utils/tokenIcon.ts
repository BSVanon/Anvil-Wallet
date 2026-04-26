/**
 * Resolve a Bsv20.icon value to a usable image URL. Two formats in
 * the wild:
 *   - GP `/content/{outpoint}`-style: icon is a content-id outpoint
 *     and we prepend the GorillaPool base. Original Yours behavior.
 *   - Full URL: BSV-21 deploy inscription icon field (Phase 2.5
 *     hotfix #15 enrichment populates this for tokens whose icon
 *     lives in the deploy JSON, e.g. Pumpkin's image2url URL). Use
 *     as-is. Robert click-test 2026-04-25: previous code prepended
 *     the GP base unconditionally, producing a malformed URL like
 *     `ordinals.gorillapool.io/content/https://...` that 404'd and
 *     fell back to the generic icon.
 *
 * Extracted from Bsv20TokensList.tsx so the Send token detail view
 * (and any other consumer) renders BSV-21 icons identically.
 */
export function resolveIconUrl(icon: string | null | undefined, gpBase: string): string | null {
  if (!icon) return null;
  if (/^https?:\/\//i.test(icon) || icon.startsWith('data:')) return icon;
  return `${gpBase}/content/${icon}`;
}
