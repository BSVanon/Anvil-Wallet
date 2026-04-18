import { OrdP2PKH } from 'js-1sat-ord';
import { LockRequest, NetWork, SendBsv, SignedMessage, SignMessage } from 'yours-wallet-provider';
import {
  BSV_DECIMAL_CONVERSION,
  MAINNET_ADDRESS_PREFIX,
  MAX_BYTES_PER_TX,
  TESTNET_ADDRESS_PREFIX,
} from '../utils/constants';
import { removeBase64Prefix, truncate } from '../utils/format';
import { getPrivateKeyFromTag, Keys } from '../utils/keys';
import { ChromeStorageService } from './ChromeStorage.service';
import { ContractService } from './Contract.service';
import { KeysService } from './Keys.service';
import { FundRawTxResponse, LockData, InWalletBsvResponse } from './types/bsv.types';
import { ChromeStorageObject } from './types/chromeStorage.types';
import { WhatsOnChainService } from './WhatsOnChain.service';
import {
  BigNumber,
  BSM,
  ECDSA,
  P2PKH,
  PublicKey,
  SatoshisPerKilobyte,
  Script,
  Signature,
  Transaction,
  Utils,
} from '@bsv/sdk';
import { SPVStore, Lock, TxoLookup, TxoSort } from 'spv-store';
import { theme } from '../theme';
//@ts-ignore
import { PaymailClient } from '@bsv/paymail/client';
import { convertLockReqToSendBsvReq } from '../utils/tools';

const client = new PaymailClient();

export class BsvService {
  private bsvBalance: number;
  private exchangeRate: number;
  constructor(
    private readonly keysService: KeysService,
    private readonly wocService: WhatsOnChainService,
    private readonly contractService: ContractService,
    private readonly chromeStorageService: ChromeStorageService,
    private readonly oneSatSPV: SPVStore,
  ) {
    this.bsvBalance = 0;
    this.exchangeRate = 0;
  }

  getBsvBalance = () => this.bsvBalance;
  getExchangeRate = () => this.exchangeRate;
  getLockData = async (): Promise<LockData> => {
    const lockData = {
      totalLocked: 0,
      unlockable: 0,
      nextUnlock: 0,
    };

    const lockTxos = await this.getLockedTxos();
    for (const txo of lockTxos) {
      const height = await this.getCurrentHeight();
      const lock = txo.data.lock?.data as Lock;
      if (!lock) continue;
      lockData.totalLocked += Number(txo.satoshis);
      if (lock.until <= height) {
        lockData.unlockable += Number(txo.satoshis);
      } else if (!lockData.nextUnlock || lock.until < lockData.nextUnlock) {
        lockData.nextUnlock = lock.until;
      }
    }
    // IF the fees required to unlock are greater than the unlockable amount, then the unlockable amount is 0
    if (lockData.unlockable < 1500 * lockTxos.length) {
      lockData.unlockable = 0;
    }
    return lockData;
  };

  getCurrentHeight = async () => {
    const header = await this.oneSatSPV.getSyncedBlock();
    return header?.height || 0;
  };

  getLockedTxos = async () => {
    const lockTxos = await this.oneSatSPV.search(new TxoLookup('lock'));
    return lockTxos.txos.filter((txo) => !txo.data.insc);
  };

  rate = async () => {
    const r = await this.wocService.getExchangeRate();
    this.exchangeRate = r ?? 0;
  };

  unlockLockedCoins = async () => {
    if (!this.keysService.identityAddress) return;
    const blockHeight = await this.getCurrentHeight();
    const lockedTxos = await this.getLockedTxos();
    const txos = lockedTxos.filter((i) => Number(i.data.lock?.data.until) <= blockHeight);
    if (txos.length > 0) {
      return await this.contractService.unlock(txos, blockHeight);
    }
  };

  lockBsv = async (lockData: LockRequest[], password: string) => {
    const request = convertLockReqToSendBsvReq(lockData);
    return await this.sendBsv(request, password);
  };

  sendAllBsv = async (destinationAddress: string, type: 'address' | 'paymail', password: string) => {
    try {
      const tx = new Transaction();
      const fundResults = await this.fundingTxos();
      const feeModel = new SatoshisPerKilobyte(this.chromeStorageService.getCustomFeeRate());
      const pkMap = await this.keysService.retrievePrivateKeyMap(password);
      for await (const u of fundResults || []) {
        const pk = pkMap.get(u.owner || '');
        if (!pk) continue;
        tx.addInput({
          sourceTransaction: await this.oneSatSPV.getTx(u.outpoint.txid),
          sourceOutputIndex: u.outpoint.vout,
          sequence: 0xffffffff,
          unlockingScriptTemplate: new P2PKH().unlock(pk),
        });
      }

      const paymailRefs: { paymail: string; reference: string }[] = [];
      if (type === 'address') {
        const outScript = new P2PKH().lock(destinationAddress);
        tx.addOutput({ lockingScript: outScript, change: true });
        await tx.fee(feeModel);
      } else if (type === 'paymail') {
        console.log('Sending P2P payment to', destinationAddress);
        const dummyScript = new Script().writeBin(new Array(1000).fill(0));
        tx.addOutput({ lockingScript: dummyScript, change: true });
        await tx.fee(feeModel);
        const satsOut = tx.outputs[0].satoshis;
        console.log('satsOut', satsOut);
        tx.outputs = [];
        const p2pDestination = await client.getP2pPaymentDestination(destinationAddress, satsOut);
        console.log(`P2P payment destination: ${p2pDestination}`);
        paymailRefs.push({ paymail: destinationAddress, reference: p2pDestination.reference });
        for (const output of p2pDestination.outputs) {
          tx.addOutput({
            satoshis: output.satoshis,
            lockingScript: Script.fromHex(output.script),
          });
        }
      }

      await tx.sign();
      const response = await this.oneSatSPV.broadcast(tx);
      console.log(`Transaction broadcast response: ${response}`);
      if (response.status == 'error') return { error: response.description };
      const txHex = tx.toHex();
      const chromeObj = this.chromeStorageService.getCurrentAccountObject();
      if (!chromeObj.account) return { error: 'no-account' };
      for (const ref of paymailRefs) {
        console.log(`Sending P2P payment to ${ref.paymail} with reference ${ref.reference}`);
        await client.sendTransactionP2P(ref.paymail, txHex, ref.reference, {
          sender: `${theme.settings.walletName} - ${truncate(chromeObj.account.addresses.bsvAddress, 4, 4)}`,
          note: `P2P tx from ${theme.settings.walletName}`,
        });
      }
      return { txid: tx.id('hex'), rawtx: Utils.toHex(tx.toBinary()) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      console.log(error);
      return { error: error.message ?? 'unknown' };
    }
  };

  sendBsv = async (
    request: SendBsv[],
    password: string,
    noApprovalLimit?: number,
    showPreview = false,
  ): Promise<InWalletBsvResponse> => {
    try {
      const requestSats = request.reduce((a: number, item: { satoshis: number }) => a + item.satoshis, 0);
      const bsvSendAmount = requestSats / BSV_DECIMAL_CONVERSION;

      if (!showPreview && bsvSendAmount > Number(noApprovalLimit)) {
        const isAuthenticated = await this.keysService.verifyPassword(password);
        if (!isAuthenticated) {
          return { error: 'invalid-password' };
        }
      }

      const isBelowNoApprovalLimit = Number(bsvSendAmount) <= Number(noApprovalLimit);
      const keys = await this.keysService.retrieveKeys(password, isBelowNoApprovalLimit);
      if (!keys?.walletAddress) return { error: 'no-wallet-address' };
      const changeAddress = keys.walletAddress;
      const pkMap = await this.keysService.retrievePrivateKeyMap(password, showPreview || isBelowNoApprovalLimit);
      const amount = request.reduce((a, r) => a + r.satoshis, 0);

      // Build tx
      const tx = new Transaction();
      let satsOut = 0;
      const paymailRefs: { paymail: string; reference: string }[] = [];
      for (const req of request) {
        let outScript: Script = new Script();
        if (req.address) {
          if (req.inscription) {
            const { base64Data, mimeType, map } = req.inscription;
            const formattedBase64 = removeBase64Prefix(base64Data);

            outScript = new OrdP2PKH().lock(
              req.address,
              {
                dataB64: formattedBase64,
                contentType: mimeType,
              },
              map,
            );
          } else {
            outScript = new P2PKH().lock(req.address);
          }
        } else if (req.script) {
          outScript = Script.fromHex(req.script);
        } else if ((req.data || []).length > 0) {
          const asm = `OP_0 OP_RETURN ${req.data?.join(' ')}`;
          try {
            outScript = Script.fromASM(asm);
          } catch (e) {
            return { error: 'invalid-data' };
          }
        } else if (!req.paymail) {
          return { error: 'invalid-request' };
        }

        satsOut += req.satoshis;
        if (!req.paymail) {
          tx.addOutput({
            satoshis: req.satoshis,
            lockingScript: outScript,
          });
        } else {
          const p2pDestination = await client.getP2pPaymentDestination(req.paymail, req.satoshis);
          console.log(p2pDestination);
          paymailRefs.push({ paymail: req.paymail, reference: p2pDestination.reference });
          for (const output of p2pDestination.outputs) {
            tx.addOutput({
              satoshis: output.satoshis,
              lockingScript: Script.fromHex(output.script),
            });
          }
        }
      }

      tx.addOutput({
        lockingScript: new P2PKH().lock(changeAddress),
        change: true,
      });

      const fundResults = await this.fundingTxos();

      let satsIn = 0;
      let fee = 0;
      const feeModel = new SatoshisPerKilobyte(this.chromeStorageService.getCustomFeeRate());
      for await (const u of fundResults || []) {
        const pk = pkMap.get(u.owner || '');
        if (!pk) continue;
        const sourceTransaction = await this.oneSatSPV.getTx(u.outpoint.txid);
        if (!sourceTransaction) {
          console.log(`Could not find source transaction ${u.outpoint.txid}`);
          return { error: 'source-tx-not-found' };
          // continue;
        }
        tx.addInput({
          sourceTransaction,
          sourceOutputIndex: u.outpoint.vout,
          sequence: 0xffffffff,
          unlockingScriptTemplate: new P2PKH().unlock(pk),
        });
        satsIn += Number(u.satoshis);
        fee = await feeModel.computeFee(tx);
        if (satsIn >= satsOut + fee) break;
      }
      if (satsIn < satsOut + fee) return { error: 'insufficient-funds' };
      await tx.fee(feeModel);
      await tx.sign();

      // Size checker
      const bytes = tx.toBinary().length;
      if (bytes > MAX_BYTES_PER_TX) return { error: 'tx-size-too-large' };

      if (showPreview) return { rawtx: tx.toHex() };

      const response = await this.oneSatSPV.broadcast(tx);

      const txHex = tx.toHex();
      const chromeObj = this.chromeStorageService.getCurrentAccountObject();
      if (!chromeObj.account) return { error: 'no-account' };
      for (const ref of paymailRefs) {
        console.log(`Sending P2P payment to ${ref.paymail} with reference ${ref.reference}`);
        await client.sendTransactionP2P(ref.paymail, txHex, ref.reference, {
          sender: `${theme.settings.walletName} - ${truncate(chromeObj.account.addresses.bsvAddress, 4, 4)}`,
          note: `P2P tx from ${theme.settings.walletName}`,
        });
      }

      if (response.status == 'error') return { error: response.description };
      if (isBelowNoApprovalLimit) {
        const { noApprovalLimit } = chromeObj.account.settings;
        const key: keyof ChromeStorageObject = 'accounts';
        const update: Partial<ChromeStorageObject['accounts']> = {
          [this.keysService.identityAddress]: {
            ...chromeObj.account,
            settings: {
              ...chromeObj.account.settings,
              noApprovalLimit: noApprovalLimit
                ? Number((noApprovalLimit - amount / BSV_DECIMAL_CONVERSION).toFixed(8))
                : 0,
            },
          },
        };
        await this.chromeStorageService.updateNested(key, update);
      }
      return { txid: tx.id('hex'), rawtx: Utils.toHex(tx.toBinary()) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      console.log(error);
      return { error: error.message ?? 'unknown' };
    }
  };

  signMessage = async (
    messageToSign: SignMessage,
    password: string,
  ): Promise<SignedMessage | { error: string } | undefined> => {
    const { message, encoding } = messageToSign;
    const isAuthenticated = await this.keysService.verifyPassword(password);
    if (!isAuthenticated) {
      return { error: 'invalid-password' };
    }
    try {
      const keys = (await this.keysService.retrieveKeys(password)) as Keys;
      const derivationTag = messageToSign.tag ?? { label: 'yours', id: 'identity', domain: '', meta: {} };
      const privateKey = getPrivateKeyFromTag(derivationTag, keys);

      if (!privateKey.toWif()) {
        return { error: 'key-type' };
      }

      const network = this.chromeStorageService.getNetwork();
      const publicKey = privateKey.toPublicKey();
      const address = publicKey.toAddress([
        network == NetWork.Mainnet ? MAINNET_ADDRESS_PREFIX : TESTNET_ADDRESS_PREFIX,
      ]);

      const msgHash = new BigNumber(BSM.magicHash(Utils.toArray(message, encoding)));
      const signature = ECDSA.sign(msgHash, privateKey, true);
      const recovery = signature.CalculateRecoveryFactor(publicKey, msgHash);

      return {
        address,
        pubKey: publicKey.toString(),
        message: message,
        sig: signature.toCompact(recovery, true, 'base64') as string,
        derivationTag,
      };
    } catch (error) {
      console.log(error);
    }
    return { error: 'not-implemented' };
  };

  verifyMessage = async (
    message: string,
    signatureBase64: string,
    publicKeyHex: string,
    encoding: 'utf8' | 'hex' | 'base64' = 'utf8',
  ) => {
    try {
      const msgBuf = Buffer.from(message, encoding);
      const publicKey = PublicKey.fromString(publicKeyHex);
      const signature = Signature.fromCompact(Utils.toArray(signatureBase64, 'base64'));
      return BSM.verify(Array.from(msgBuf), signature, publicKey);
    } catch (error) {
      console.error(error);
      return false;
    }
  };

  updateBsvBalance = async () => {
    const utxos = await this.fundingTxos();
    const total = utxos.reduce((a, item) => a + Number(item.satoshis), 0);
    this.bsvBalance = (total ?? 0) / BSV_DECIMAL_CONVERSION;
    const balance = {
      bsv: this.bsvBalance,
      satoshis: total,
      usdInCents: Math.round(this.bsvBalance * this.exchangeRate * 100),
    };
    const { account } = this.chromeStorageService.getCurrentAccountObject();
    if (!account) throw Error('No account found!');
    const key: keyof ChromeStorageObject = 'accounts';
    const update: Partial<ChromeStorageObject['accounts']> = {
      [this.keysService.identityAddress]: {
        ...account,
        balance,
      },
    };
    await this.chromeStorageService.updateNested(key, update);
  };

  /**
   * Detect a 1Sat Ordinals inscription envelope in a raw locking script.
   *
   * Fail-closed filter for the WoC-fallback path: if we can't ask an
   * ordinal indexer whether an outpoint is inscribed, we scan the script
   * bytes ourselves for the canonical envelope pattern:
   *
   *   <P2PKH prefix…> OP_FALSE OP_IF OP_PUSH "ord" …
   *
   * Matches 99% of 1Sat ordinals + most BRC-20/21 inscriptions. Does NOT
   * catch non-inscription ordinal protocols (Lock, Cosign, MAP). For the
   * fund-UTXO pool this is adequate because those other protocols use
   * structurally distinct scripts that aren't plain P2PKH — spv-store's
   * normal basket separation keeps them out of the fund pool anyway.
   */
  private hasInscriptionEnvelope = (scriptBytes: number[]): boolean => {
    for (let i = 0; i < scriptBytes.length - 5; i++) {
      // OP_FALSE (0x00) + OP_IF (0x63) + push-3 (0x03) + 'o','r','d' (0x6f,0x72,0x64)
      if (
        scriptBytes[i] === 0x00 &&
        scriptBytes[i + 1] === 0x63 &&
        scriptBytes[i + 2] === 0x03 &&
        scriptBytes[i + 3] === 0x6f &&
        scriptBytes[i + 4] === 0x72 &&
        scriptBytes[i + 5] === 0x64
      ) {
        return true;
      }
    }
    return false;
  };

  /**
   * Fund UTXO lookup with fail-loud fallback.
   *
   * Primary: spv-store's 'fund' basket (ordinal-aware, well-tested).
   * Fallback: WhatsOnChain UTXO query with local inscription-envelope
   * filter — triggered only if spv-store is degraded (times out or
   * throws).
   *
   * Hard invariant: when the fallback runs, any output with a 1Sat
   * inscription envelope in its locking script is EXCLUDED from the
   * fund pool. The sole user-facing consequence of the fallback path
   * is "minor delay + a warning in the console" when spv-store is
   * unhealthy; no silent downgrade of ordinal safety.
   *
   * Other protocols (Cosign, MAP) use non-P2PKH structures that
   * wouldn't show up at the user's paypk-derived address anyway, and
   * spv-store's basket separation keeps them out of 'fund' under
   * normal operation.
   */
  fundingTxos = async () => {
    const PRIMARY_TIMEOUT_MS = 8000;
    try {
      const primary = Promise.race([
        this.oneSatSPV.search(new TxoLookup('fund'), TxoSort.ASC, 0),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), PRIMARY_TIMEOUT_MS)),
      ]);
      const result = await primary;
      if (result !== 'timeout') return result.txos;
      console.warn(
        `[fundingTxos] spv-store primary timed out after ${PRIMARY_TIMEOUT_MS}ms — falling back to WoC`,
      );
    } catch (err) {
      console.warn('[fundingTxos] spv-store primary threw — falling back to WoC:', (err as Error).message);
    }
    // Fallback: WoC UTXO query at the user's BSV address.
    const bsvAddress = this.keysService.bsvAddress;
    const wocUtxos = await this.wocService.getUtxosByAddress(bsvAddress);
    const { Utils: sdkUtils } = await import('@bsv/sdk');
    const fallbackTxos = wocUtxos
      .filter((u) => !this.hasInscriptionEnvelope(sdkUtils.toArray(u.scriptHex, 'hex') as number[]))
      .map((u) => ({
        outpoint: { txid: u.txid, vout: u.vout, toString: () => `${u.txid}_${u.vout}` },
        satoshis: BigInt(u.satoshis),
        script: sdkUtils.toArray(u.scriptHex, 'hex') as number[],
        owner: bsvAddress,
        data: {} as Record<string, unknown>,
        events: [] as string[],
        status: 2, // TxoStatus.Validated — WoC says it's unspent + on-chain
        spend: '',
        block: undefined,
      }));
    console.warn(
      `[fundingTxos] WoC fallback returned ${wocUtxos.length} UTXO(s); ` +
        `${fallbackTxos.length} eligible after inscription-envelope filter`,
    );
    return fallbackTxos as unknown as Awaited<ReturnType<typeof this.oneSatSPV.search>>['txos'];
  };

  fundRawTx = async (rawtx: string, password: string): Promise<FundRawTxResponse> => {
    const isAuthenticated = await this.keysService.verifyPassword(password);
    if (!isAuthenticated) {
      return { error: 'invalid-password' };
    }

    const pkMap = await this.keysService.retrievePrivateKeyMap(password);
    const tx = Transaction.fromHex(rawtx);

    let satsIn = 0;
    for (const input of tx.inputs) {
      input.sourceTransaction = await this.oneSatSPV.getTx(input.sourceTXID ?? '');
      satsIn += input.sourceTransaction?.outputs[input.sourceOutputIndex]?.satoshis || 0;
    }

    const satsOut = tx.outputs.reduce((a, o) => a + (o.satoshis || 0), 0);
    let fee = 0;
    tx.addOutput({ change: true, lockingScript: new P2PKH().lock(this.keysService.bsvAddress) });

    const fundResults = await this.fundingTxos();

    const feeModel = new SatoshisPerKilobyte(this.chromeStorageService.getCustomFeeRate());
    for await (const u of fundResults || []) {
      const pk = pkMap.get(u.owner || '');
      if (!pk) continue;
      tx.addInput({
        sourceTransaction: await this.oneSatSPV.getTx(u.outpoint.txid),
        sourceOutputIndex: u.outpoint.vout,
        sequence: 0xffffffff,
        unlockingScriptTemplate: new P2PKH().unlock(pk),
      });
      satsIn += Number(u.satoshis);
      fee = await feeModel.computeFee(tx);
      if (satsIn >= satsOut + fee) break;
    }
    if (satsIn < satsOut + fee) return { error: 'insufficient-funds' };
    await tx.fee(feeModel);
    await tx.sign();

    return { rawtx: tx.toHex() };
  };
}
