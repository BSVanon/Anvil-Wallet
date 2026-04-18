type MNEEFee = {
  min: number;
  max: number;
  fee: number;
};

export type MNEEConfig = {
  approver: string;
  feeAddress: string;
  burnAddress: string;
  mintAddress: string;
  fees: MNEEFee[];
  decimals: number;
  tokenId: string;
};

export type MNEEOperation = 'transfer' | 'burn' | 'deploy+mint';

/**
 * Extended MNEE transfer request — Yours Wallet provider extension.
 *
 * Unlike the standard `SendMNEE[]` flow which always broadcasts, this request
 * lets a connected dApp build a user-half-signed MNEE transfer with optional
 * extra OP_RETURN data and control over the broadcast step. Primary use case:
 * AVOS (Anvil Verified Oracle Swap) where the oracle — not the wallet — is
 * responsible for submitting the MNEE tx to `/v2/transfer`, and Alice's wallet
 * must produce the rawtx with her swap's `orderId` as `extraData`.
 *
 * Wallet behavior:
 *   - Opens an explicit confirmation popup showing recipients + amounts +
 *     "Will broadcast now" vs "Will NOT broadcast (handed to dApp)".
 *   - On approve: calls `mneeService.transfer(recipients, wif, { broadcast,
 *     extraData: [{ type: 'hex', data: extraDataHex }] })`.
 *   - Returns `{ rawtx }` when `broadcast === false`; otherwise `{ ticketId }`
 *     and the dApp may poll `getTxStatus` separately (wallet does not).
 */
export type SendMNEEWithData = {
  /** Recipient + decimal-MNEE amount pairs, same shape as `SendMNEE[]` */
  recipients: Array<{ address: string; amount: number }>;
  /** Hex string embedded as an MNEE extraData OP_RETURN output */
  extraDataHex: string;
  /** When false, wallet returns the rawtx to the dApp without broadcasting */
  broadcast: boolean;
};

export type SendMNEEWithDataResponse = {
  /** Present when request's broadcast=false */
  rawtx?: string;
  /** Present when request's broadcast=true */
  ticketId?: string;
  /** Local reference txid computed from the returned rawtx (pre-mutation) */
  localTxid?: string;
  /** Human-readable error when wallet refused or failed */
  error?: string;
};

export type MNEEUtxo = {
  data: {
    bsv21: {
      amt: number;
      dec: number;
      icon: string;
      id: string;
      op: string;
      sym: string;
    };
    cosign: {
      address: string;
      cosigner: string;
    };
  };
  height: number;
  idx: number;
  outpoint: string;
  owners: string[];
  satoshis: number;
  score: number;
  script: string;
  txid: string;
  vout: number;
};
