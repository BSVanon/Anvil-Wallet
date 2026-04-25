<p align="center">
  <img src="public/readme-banner.png" alt="Anvil Wallet" width="400">
</p>

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

# Anvil Wallet

A hardening fork of [Yours Wallet](https://github.com/yours-org/yours-wallet).
Non-custodial BSV / 1Sat Ordinals / MNEE wallet. BRC-100 compatible.

## What's the same as upstream Yours Wallet

All cryptography, key management, seed format, BIP32 derivation paths,
BRC-100 provider surface (`window.yours.*`), 1Sat Ordinals support,
MNEE integration, multi-account, UI screens. See [LICENSE.md](LICENSE.md) —
MIT, preserved from upstream; copyright for the base wallet remains
with Daniel Wagner and David Case.

## What Anvil Wallet adds

The fork is scoped to display, broadcast, and multi-source resilience.
Cryptography, key handling, and signing paths are unchanged.

### Funds-safety hardening

- **Fail-closed broadcast** — `broadcastMultiSource` chains
  Anvil-Mesh → spv-store → WhatsOnChain, with an idempotency check
  for retries (a tx already on-network is treated as success). If
  every path fails, the call returns `{ status: 'error' }`; no
  silent-success.
- **Ordinal-safe UTXO selection** — fund-UTXO lookups failover
  spv-store → GorillaPool → WhatsOnChain with a local 1Sat
  inscription-envelope filter at every tier. Inscribed outputs can
  never be spent as fungible BSV change.
- **Per-account + per-network cache namespacing** — display cache
  and recent-broadcast tracker are keyed by
  `<address>:<network>`, so account-switching or mainnet/testnet
  toggling never cross-contaminates state.
- **Mesh health pre-flight** — skips Anvil-Mesh quickly when it
  self-reports its broadcast upstream as down.
- **`axios` removed** — all HTTP calls use native `fetch`.
  (Also merged upstream via
  [yours-org PR #300](https://github.com/yours-org/yours-wallet/pull/300);
  Anvil Wallet inherits this fix rather than originating it.)

### Activity + display reliability

- **Persistent display cache** in `chrome.storage.local` so the
  popup renders the last known balance + activity instantly on
  re-open, while live refresh runs in parallel.
- **4-way Activity merge** — recent broadcasts, GorillaPool history,
  WhatsOnChain history fallback, and persistent cache combined with
  height-aware deduplication. Confirmed transactions stay confirmed
  across reloads; recently-sent transactions appear immediately.
- **Block-height reconciliation** — Pending rows resolve to their
  real confirmation height on the next refresh, even when the
  primary indexer is degraded.
- **BSV-21 token auto-detection** — new tokens received in the
  user's BSV-21 inventory are surfaced automatically; user-removed
  tokens stay removed (sticky `seenTokens` curation).
- **Self-contained icons** — generic token / NFT placeholders
  shipped as inline SVG. No third-party CDN dependency.

### Provider + UX

- **`sendMNEEWithData` provider extension** — connected dApps can
  request a user-half-signed MNEE transfer with optional OP_RETURN
  data, useful for oracle-attested swap flows. Additive; existing
  `sendMNEE` flow unchanged.
- **`GetSignaturesRequest` timeout** — the sign popup no longer
  deadlocks when the 1Sat indexer is degraded (6-second timeout
  with minimal preview fallback).
- **Theme** — renamed from "Yours" to "Anvil" in the manifest +
  theme file.

All Anvil-specific behavior is opt-out by default — without
Anvil-Mesh configuration the broadcast chain falls through to
spv-store + WhatsOnChain, identical in shape to upstream.

## Install

### Developer / unpacked

```bash
git clone https://github.com/BSVanon/Anvil-Wallet.git
cd Anvil-Wallet
npm install --legacy-peer-deps
npm run build
```

Load unpacked extension from `./build/` in `chrome://extensions`
(Developer mode on).

### Chrome Web Store

*Coming soon.*

## Upstream sync

To pull updates from `yours-org/yours-wallet` when upstream ships:

```bash
git fetch upstream
git rebase upstream/main    # replays Anvil's hardening commits on top of new upstream
```

Or use the "Sync fork" button in the GitHub UI.

## License

[MIT](LICENSE.md). Copyright for the base wallet remains with Daniel
Wagner and David Case. Anvil-specific additions are dedicated to the
same MIT terms; see commit history for authorship.

## Credits

Forked from [yours-org/yours-wallet](https://github.com/yours-org/yours-wallet)
at commit `75b18b1`.
