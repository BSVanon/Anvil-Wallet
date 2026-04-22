/**
 * Fail-closed fungibility helpers for the spendable-UTXO resolver.
 *
 * The wallet's fund pool must NEVER include a UTXO that holds an
 * ordinal (including MNEE, which is a BSV-21 under a Cosign wrapper
 * built on the same 1Sat ordinal substrate) — spending an ordinal
 * output as fungible BSV destroys it permanently. Per the
 * feedback_ordinal_safety_directive, the wallet's filter must be
 * fail-closed: only accept what we positively recognize as bare
 * fungible P2PKH.
 *
 * Primary gate: `isBareP2PKH(scriptHex)` — exact 25-byte P2PKH
 * pattern, no extensions, no prefix/suffix data.
 *
 * Secondary gate (belt-and-braces): `hasOrdinalMarker(scriptHex)` —
 * scans for the 4-byte "ord" push `03 6f 72 64` anywhere in the
 * script, tolerating both `OP_FALSE OP_IF ...` (standard 1Sat) and
 * raw-`OP_IF ...` (MNEE's Cosign variant, verified empirically from
 * real mainnet tx `02ba121709bbba0da7a4313d3e984836077c4b4abc2a448e1de4361086e4869e`
 * on 2026-04-22 — see project_mnee_script_shape memory).
 *
 * Resolver rule: accept UTXO iff
 *   isBareP2PKH(script) === true AND hasOrdinalMarker(script) === false
 *
 * Everything else: excluded. Unknown script shape: excluded.
 */

/**
 * Bare P2PKH = 25 bytes, exact opcode pattern:
 *   OP_DUP (0x76) OP_HASH160 (0xa9) OP_PUSH20 (0x14) <20 bytes> OP_EQUALVERIFY (0x88) OP_CHECKSIG (0xac)
 *
 * Hex: `76 a9 14 <40 hex chars> 88 ac` = 50 hex chars total.
 *
 * Rejects: Cosign (MNEE), OrdLock, AMM covenants, HODL locks,
 * OP_RETURN, multisig, anything with inscription envelopes. These
 * are all ≠ 25 bytes or don't match the exact prefix/suffix.
 */
export function isBareP2PKH(scriptHex: string): boolean {
  if (typeof scriptHex !== 'string') return false;
  const hex = scriptHex.toLowerCase();
  // Exactly 50 hex chars (25 bytes), starts with 76a914 (DUP HASH160 PUSH20),
  // ends with 88ac (EQUALVERIFY CHECKSIG).
  return (
    hex.length === 50 &&
    hex.startsWith('76a914') &&
    hex.endsWith('88ac') &&
    /^[0-9a-f]+$/.test(hex)
  );
}

/**
 * Scan for the 4-byte push of "ord" (`03 6f 72 64`) anywhere in the
 * script. Present in every known ordinal-bearing envelope on BSV:
 * 1Sat inscriptions, BSV-20, BSV-21, BSV-21+Cosign (MNEE), OrdLock.
 *
 * Why this sequence and not the longer `00 63 03 6f 72 64` pattern:
 * MNEE's Cosign-wrapped BSV-21 scripts start with raw `OP_IF` (0x63)
 * without the leading `OP_FALSE` (0x00). A strict 6-byte match would
 * miss real mainnet MNEE (verified from tx 02ba1217... 2026-04-22).
 * The 4-byte "ord" push is the canonical ordinal marker per 1Sat
 * spec and appears in every variant.
 *
 * False-positive risk: `03 6f 72 64` appearing by coincidence in a
 * non-ordinal script. In a bare P2PKH the only arbitrary bytes are
 * the 20-byte pkhash, so the probability of a random pkhash
 * containing this exact 4-byte sequence is (20 - 4 + 1) × 2^-32 ≈
 * 4 × 10^-9. Effectively zero. For non-bare scripts (covenants,
 * multisig) the resolver already rejects via isBareP2PKH, so this
 * scan is a defense-in-depth second layer that only runs against
 * already-P2PKH-shaped candidates from WoC.
 */
export function hasOrdinalMarker(scriptHex: string): boolean {
  if (typeof scriptHex !== 'string' || scriptHex.length < 8) return false;
  return scriptHex.toLowerCase().includes('036f7264');
}

/**
 * Combined fail-closed fungibility check. Both gates must pass.
 *
 * Use this as the filter for any WoC-tier fallback UTXO source — i.e.
 * any provider that doesn't segregate ordinals server-side. For
 * ordinal-aware providers (spv-store's fund basket, GorillaPool's
 * `bsv20=false` endpoint), trust the provider's classification
 * directly and skip this filter — the provider has richer context
 * than local byte inspection.
 */
export function isSpendableFungibleScript(scriptHex: string): boolean {
  return isBareP2PKH(scriptHex) && !hasOrdinalMarker(scriptHex);
}
