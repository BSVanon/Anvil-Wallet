/**
 * BRC-73 — Group Permissions for App Access.
 *
 * Manifest shape declared at `https://{originator}/manifest.json` under
 * the canonical `metanet.groupPermissions` namespace (or legacy
 * `babbage.groupPermissions` fallback). Apps publish the manifest, the
 * wallet fetches at connect-time and prompts the user once for the
 * whole bundle. Subsequent operations covered by the bundle skip the
 * per-tx approval flow.
 *
 * Spec: https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0073.md
 */

export type ProtocolPermission = {
  /** [securityLevel, protocolName] — BRC-43 scoped key id. */
  protocolID: [number, string];
  /** Required for security-level 2; pubkey hex of the named counterparty. */
  counterparty?: string;
  description: string;
};

export type SpendingAuthorization = {
  /** Monthly limit in satoshis. */
  amount: number;
  description: string;
};

export type BasketAccess = {
  /** BRC-46 basket name. */
  basket: string;
  description: string;
};

export type CertificateAccess = {
  /** BRC-52 certificate type. */
  type: string;
  /** Requested field names. */
  fields: string[];
  /** Compressed public key hex of the verifier the fields are revealed to. */
  verifierPublicKey: string;
  description: string;
};

export type GroupPermissions = {
  description?: string;
  protocolPermissions?: ProtocolPermission[];
  spendingAuthorization?: SpendingAuthorization;
  basketAccess?: BasketAccess[];
  certificateAccess?: CertificateAccess[];
};

/**
 * Top-level manifest JSON. Apps may publish other fields (name,
 * description, icon, etc.) — the wallet only reads the BRC-73
 * groupPermissions slot under the canonical or legacy namespace.
 */
export type Brc73Manifest = {
  'metanet.groupPermissions'?: GroupPermissions;
  'babbage.groupPermissions'?: GroupPermissions;
  // Other arbitrary keys allowed; ignored.
  [otherKey: string]: unknown;
};

/** Where the granted permissions came from. */
export type ManifestSource = 'fetched' | 'app-passed';

/**
 * Rolling 30-day budget window. Resets when the current window expires
 * — at that point the next spend that exceeds the budget triggers a
 * re-prompt for another batch (Robert's call: "re-prompt if/when budget
 * runs out for another batch of same").
 */
export type BudgetUsage = {
  /** Start of the current rolling window (ms epoch). */
  windowStartMs: number;
  /** Sats spent within the current window. */
  spentSats: number;
};

/**
 * What the wallet stores per-app after the user grants the manifest.
 * Lives inside `WhitelistedApp.groupPermissions` in the per-account
 * settings.whitelist[].
 */
export type GrantedManifest = {
  permissions: GroupPermissions;
  grantedAt: number;
  source: ManifestSource;
  budgetUsage: BudgetUsage;
};
