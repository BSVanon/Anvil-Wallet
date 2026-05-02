import {
  Addresses,
  Balance,
  NetWork,
  Ordinal,
  PubKeys,
  TaggedDerivationResponse,
  SendBsv,
  TransferOrdinal,
  PurchaseOrdinal,
  SignMessage,
  Broadcast,
  GetSignatures,
  TaggedDerivationRequest,
  EncryptRequest,
  DecryptRequest,
  SocialProfile,
  SendBsv20,
  SendMNEE,
  MNEEBalance,
} from 'yours-wallet-provider';
import { WhitelistedApp } from '../../inject';
import { Theme } from '../../theme.types';
import { StoredUtxo } from './bsv.types';
import type { SendMNEEWithData } from './mnee.types';

export type Dispatch<T> = (value: T) => void;

export type Settings = {
  noApprovalLimit: number;
  whitelist: WhitelistedApp[];
  isPasswordRequired: boolean;
  socialProfile: SocialProfile;
  favoriteTokens: string[];
  /**
   * Tokens the wallet has already considered for auto-add to
   * `favoriteTokens`. Used so that removing a token from favorites
   * doesn't cause it to be re-added on the next detection cycle. Phase
   * 2 P2.4 — auto-discover holdings while respecting user curation.
   * Optional for backward compatibility with pre-P2.4 storage.
   */
  seenTokens?: string[];
  customFeeRate: number;
};

export interface Account {
  name: string;
  icon: string;
  network: NetWork;
  encryptedKeys: string; // See Keys type
  derivationTags: TaggedDerivationResponse[];
  settings: Settings;
  addresses: Addresses;
  balance: Balance;
  mneeBalance: MNEEBalance;
  pubKeys: PubKeys;
}

export type ExchangeRateCache = {
  rate: number;
  timestamp: number;
};

export type ConnectRequest = {
  appIcon: string;
  appName: string;
  domain: string;
  isAuthorized: boolean;
  /**
   * BRC-73: optional app-passed group-permissions manifest. Used as a
   * fallback when the canonical `https://{domain}/manifest.json` fetch
   * fails (e.g., local dev, m2m scenarios). ConnectRequest popup
   * validates the shape before treating it as a real grant.
   */
  manifest?: import('./brc73.types').GroupPermissions;
};

export interface ChromeStorageObject {
  accounts: { [identityAddress: string]: Account };
  selectedAccount: string;
  accountNumber: number;
  exchangeRateCache: ExchangeRateCache;
  lastActiveTime: number;
  popupWindowId: number;
  passKey: string;
  salt: string;
  isLocked: boolean;
  colorTheme: Theme;
  version?: number;
  hasUpgradedToSPV?: boolean;
  connectRequest?: ConnectRequest;
  sendBsvRequest?: SendBsv[];
  sendBsv20Request?: SendBsv20;
  sendMNEERequest?: SendMNEE[];
  sendMNEEWithDataRequest?: SendMNEEWithData;
  transferOrdinalRequest?: TransferOrdinal;
  purchaseOrdinalRequest?: PurchaseOrdinal;
  signMessageRequest?: SignMessage;
  broadcastRequest?: Broadcast;
  getSignaturesRequest?: GetSignatures;
  generateTaggedKeysRequest?: TaggedDerivationRequest;
  encryptRequest?: EncryptRequest;
  decryptRequest?: DecryptRequest;
  /**
   * Origin (window.location.hostname) of the app that issued the
   * currently-pending request. Set by background.ts alongside any
   * request slot above; cleared when the request resolves. Used by
   * BRC-73 coverage checks to look up the granted manifest in the
   * current account's whitelist.
   */
  requestingDomain?: string;
}

export type CurrentAccountObject = Omit<
  ChromeStorageObject,
  | 'accounts'
  | 'popupWindowId'
  | 'connectRequest'
  | 'sendBsvRequest'
  | 'sendBsv20Request'
  | 'sendMNEERequest'
  | 'sendMNEEWithDataRequest'
  | 'transferOrdinalRequest'
  | 'purchaseOrdinalRequest'
  | 'signMessageRequest'
  | 'broadcastRequest'
  | 'getSignaturesRequest'
  | 'generateTaggedKeysRequest'
  | 'encryptRequest'
  | 'decryptRequest'
  | 'requestingDomain'
> & { account: Account };

type AppState = {
  addresses: Addresses;
  balance: Balance;
  isLocked: boolean;
  isPasswordRequired: boolean;
  network: NetWork;
  ordinals: Ordinal[];
  pubKeys: PubKeys;
};

export type DeprecatedStorage = {
  appState: AppState;
  derivationTags: TaggedDerivationResponse[];
  encryptedKeys: string;
  exchangeRateCache: ExchangeRateCache;
  socialProfile: SocialProfile;
  noApprovalLimit: number;
  lastActiveTime: number;
  passKey: string;
  network: NetWork;
  paymentUtxos: StoredUtxo[];
  salt: string;
  whitelist: WhitelistedApp[];
  colorTheme: Theme;
  popupWindowId: number;
};
