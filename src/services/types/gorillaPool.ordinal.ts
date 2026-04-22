/**
 * Raw GorillaPool row type for `/api/txos/address/{addr}/unspent`
 * responses. Separated from yours-wallet-provider's Ordinal type so
 * we can import from both the GP service (no provider dep) and the
 * OrdinalService mapper (which translates raw → Ordinal).
 *
 * Fields we don't use are typed as `unknown` / optional rather than
 * omitted, so unexpected extras in a response don't break parsing.
 */

export interface GpInscriptionFile {
  hash?: string;
  size?: number;
  type: string;
  json?: unknown;
}

export interface GpBsv20Data {
  id?: string;
  tick?: string;
  op?: string;
  amt?: number | string;
  icon?: string;
  listing?: boolean;
  dec?: number;
  sym?: string;
}

export interface GpInscriptionData {
  insc?: { file?: GpInscriptionFile };
  map?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sigma?: Array<any>;
  bsv20?: GpBsv20Data;
}

export interface GpOrdinalRow {
  txid: string;
  vout: number;
  outpoint: string;
  satoshis: number;
  height?: number;
  idx?: string;
  owner: string | null;
  spend: string;
  origin: {
    outpoint: string;
    num?: string;
    data: GpInscriptionData;
    nonce?: number;
  } | null;
  data: GpInscriptionData | null;
}
