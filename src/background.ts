/* global chrome */
import {
  EncryptRequest,
  GetSignatures,
  PubKeys,
  SendBsv,
  SendBsvResponse,
  SignedMessage,
  TransferOrdinal,
  DecryptRequest,
  PurchaseOrdinal,
  SignatureResponse,
  TaggedDerivationRequest,
  TaggedDerivationResponse,
  GetTaggedKeysRequest,
  Broadcast,
  InscribeRequest,
  SignMessage,
  NetWork,
  SendBsv20Response,
  SendBsv20,
  GetPaginatedOrdinals,
  SendMNEEResponse,
  SendMNEE,
  LockRequest,
  Ordinal,
} from 'yours-wallet-provider';
import {
  CustomListenerName,
  Decision,
  RequestParams,
  ResponseEventDetail,
  SerializedBsv20,
  WhitelistedApp,
  YoursEventName,
} from './inject';
import { EncryptResponse } from './pages/requests/EncryptRequest';
import { DecryptResponse } from './pages/requests/DecryptRequest';
import { removeWindow, sendTransactionNotification } from './utils/chromeHelpers';
import { GetSignaturesResponse } from './pages/requests/GetSignaturesRequest';
import { ChromeStorageObject, ConnectRequest } from './services/types/chromeStorage.types';
import { ChromeStorageService } from './services/ChromeStorage.service';
import { GorillaPoolService } from './services/GorillaPool.service';
import { WhatsOnChainService } from './services/WhatsOnChain.service';
import { KeysService } from './services/Keys.service';
import { ContractService } from './services/Contract.service';
import { BsvService } from './services/Bsv.service';
import { checkGroupCoverage, findGrantedManifest } from './services/manifest/checkGroupCoverage';
import { persistCoveredSpend } from './services/manifest/recordSpend';
import {
  TxidDedupTracker,
  loadDedupTrackerState,
  type DedupStorageReader,
} from './utils/txidDedupTracker';
import { mapOrdinal, mapGpOrdinal, mapBsv20TxoToOrdinal } from './utils/providerHelper';
import { TxoLookup, TxoSort } from 'spv-store';
import { initOneSatSPV } from './initSPVStore';
import { CHROME_STORAGE_OBJECT_VERSION, HOSTED_YOURS_IMAGE, MNEE_API_TOKEN } from './utils/constants';
import { convertLockReqToSendBsvReq } from './utils/tools';
import { getSpendableFundUtxos } from './services/SpendableUtxos.service';
import {
  writeSyncStatus,
  isRegisterFailureError,
} from './services/SyncStatus.service';
import Mnee from '@mnee/ts-sdk';
import type { SendMNEEWithData, SendMNEEWithDataResponse } from './services/types/mnee.types';

// mnee instance for balance check
const mnee = new Mnee({ environment: 'production', apiKey: MNEE_API_TOKEN });

let chromeStorageService = new ChromeStorageService();
const isInServiceWorker = self?.document === undefined;
const gorillaPoolService = new GorillaPoolService(chromeStorageService);
const wocService = new WhatsOnChainService(chromeStorageService);

export let oneSatSPVPromise = chromeStorageService.getAndSetStorage().then(async (storage) => {
  const version = storage?.version;
  if (version && version < 3) {
    // At version three we're forcing a full resync
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
        console.log(`Deleted database: ${db.name}`);
      }
    }
    await chromeStorageService.update({ version: CHROME_STORAGE_OBJECT_VERSION });
  } else if (version && version < 4) {
    // At version four we're deleting the txos-db to fix origin index issue.
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name && db.name.startsWith('txos-')) {
        indexedDB.deleteDatabase(db.name);
        console.log(`Deleted database: ${db.name}`);
      }
    }
    await chromeStorageService.update({ version: CHROME_STORAGE_OBJECT_VERSION });
  }

  return initOneSatSPV(chromeStorageService, isInServiceWorker);
});

/**
 * BRC-73 background-side service stack.
 *
 * Lazily wired once `oneSatSPVPromise` resolves so the background can
 * sign + broadcast covered requests directly without ever opening the
 * popup. The popup-side ServiceContext continues to instantiate its
 * own copy for the legacy (uncovered) flow — both stacks share the
 * same chrome.storage.local state, so they stay coherent.
 */
export const bgServicesPromise = (async () => {
  const oneSatSPV = await oneSatSPVPromise;
  const keysService = new KeysService(chromeStorageService, oneSatSPV, wocService);
  const contractService = new ContractService(keysService, oneSatSPV, wocService, chromeStorageService);
  const bsvService = new BsvService(
    keysService,
    wocService,
    contractService,
    chromeStorageService,
    oneSatSPV,
    gorillaPoolService,
  );
  return { keysService, contractService, bsvService };
})();

console.log('Anvil Wallet Background Script Running!');

const WOC_BASE_URL = 'https://api.whatsonchain.com/v1/bsv';

type CallbackResponse = (response: ResponseEventDetail) => void;

let responseCallbackForConnectRequest: CallbackResponse | null = null;
let responseCallbackForSendBsvRequest: CallbackResponse | null = null;
let responseCallbackForSendBsv20Request: CallbackResponse | null = null;
let responseCallbackForSendMNEERequest: CallbackResponse | null = null;
let responseCallbackForSendMNEEWithDataRequest: CallbackResponse | null = null;
let responseCallbackForTransferOrdinalRequest: CallbackResponse | null = null;
let responseCallbackForPurchaseOrdinalRequest: CallbackResponse | null = null;
let responseCallbackForSignMessageRequest: CallbackResponse | null = null;
let responseCallbackForBroadcastRequest: CallbackResponse | null = null;
let responseCallbackForGetSignaturesRequest: CallbackResponse | null = null;
let responseCallbackForGenerateTaggedKeysRequest: CallbackResponse | null = null;
let responseCallbackForEncryptRequest: CallbackResponse | null = null;
let responseCallbackForDecryptRequest: CallbackResponse | null = null;
let popupWindowId: number | undefined;

const INACTIVITY_LIMIT = 10 * 60 * 1000; // 10 minutes

// only run in background worker
if (isInServiceWorker) {
  const initNewTxsListener = async () => {
    const oneSatSPV = await oneSatSPVPromise;
    oneSatSPV.events.on('newTxs', (data: number) => {
      sendTransactionNotification(data);
    });
  };
  initNewTxsListener();

  const processSyncUtxos = async () => {
    try {
      const oneSatSPV = await oneSatSPVPromise;
      if (!oneSatSPV) throw Error('SPV not initialized!');
      await chromeStorageService.update({ hasUpgradedToSPV: true });
      await oneSatSPV.sync();
      console.log('done importing');
    } catch (error) {
      console.error('Error during sync:', error);
    }
  };

  const deleteAllIDBDatabases = async () => {
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name?.startsWith('block')) continue;
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
        console.log(`Deleted database: ${db.name}`);
      }
    }

    console.log('All IndexedDB databases deleted.');
  };

  const signOut = async () => {
    await (await oneSatSPVPromise).destroy();
    await deleteAllIDBDatabases();
  };

  const switchAccount = async () => {
    await (await oneSatSPVPromise).destroy();
    chromeStorageService = new ChromeStorageService();
    await chromeStorageService.getAndSetStorage();
    oneSatSPVPromise = initOneSatSPV(chromeStorageService, isInServiceWorker);
    await oneSatSPVPromise;
    initNewTxsListener();
  };

  /**
   * Retry SPV init after a sync-degraded event. Invoked via
   * SYNC_RETRY message from the popup's Retry button.
   *
   * Flow:
   *   1. Probe the canonical indexer endpoint with a 3s timeout.
   *      If the service is still unavailable, flip straight back to
   *      'degraded' without destroying the SPV instance — a destroy
   *      + reinit against a still-down service is expensive and
   *      pointless.
   *   2. If the probe succeeds, destroy the current SPV and re-init.
   *      The unhandledrejection listener will flip status to
   *      'degraded' if register() still fails; queue events will
   *      flip it to 'healthy' if sync starts.
   *   3. Cap the whole operation at 15 seconds — after that the
   *      'retrying' state would feel broken to the user.
   */
  const RETRY_TIMEOUT_MS = 15_000;
  const PROBE_TIMEOUT_MS = 3_000;

  const probeIndexerHealth = async (): Promise<boolean> => {
    // Probe the ACCOUNT-SCOPED path that spv-store actually calls
    // (/v5/acct/{accountId}/utxos), not the root /v5/acct. The root
    // returns 404 when healthy — that's why the previous "status<500"
    // check false-positived: 404-from-healthy-service looked the
    // same as 504-from-degraded-service. Query the same endpoint
    // spv-store will hit on re-register, so a passing probe is a
    // real "register will succeed" signal.
    //
    // Uses the current selectedAccount as the probe address. If no
    // account is loaded yet, return false — there's nothing to
    // register against, so a retry is meaningless.
    try {
      const { selectedAccount } = chromeStorageService.getCurrentAccountObject();
      if (!selectedAccount) return false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const res = await fetch(
        `https://ordinals.1sat.app/v5/acct/${selectedAccount}/utxos?txo=true&limit=0&tags=*`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      // 504 (the failure mode we observed) is the one we care about.
      // Anything <500 means the account-scoped path is actually
      // responding — register has a real chance of working.
      return res.status < 500;
    } catch {
      return false;
    }
  };

  const retrySync = async () => {
    await writeSyncStatus('retrying');

    // Cap the whole operation so the banner never stays in 'retrying'
    // longer than the timeout — a long hang is worse than a quick
    // honest failure.
    const timeoutP = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), RETRY_TIMEOUT_MS),
    );

    const retryP = (async () => {
      const healthy = await probeIndexerHealth();
      if (!healthy) {
        console.warn('[SyncStatus] retry probe: indexer still unavailable');
        return 'still-down' as const;
      }
      await (await oneSatSPVPromise).destroy();
      oneSatSPVPromise = initOneSatSPV(chromeStorageService, isInServiceWorker);
      await oneSatSPVPromise;
      initNewTxsListener();
      return 'ok' as const;
    })();

    const outcome = await Promise.race([retryP, timeoutP]);
    if (outcome === 'timeout') {
      console.warn('[SyncStatus] retry timed out after', RETRY_TIMEOUT_MS, 'ms');
      await writeSyncStatus('degraded');
    } else if (outcome === 'still-down') {
      await writeSyncStatus('degraded');
    } else {
      // 'ok' — init resolved cleanly. The unhandledrejection listener
      // will flip to 'degraded' if register still fails; a queueStats
      // event will flip to 'healthy' if sync is progressing. Seed
      // with 'initializing' for the transitional state.
      await writeSyncStatus('initializing');
    }
  };

  /**
   * Service-worker-global unhandled-rejection listener. spv-store's
   * 1sat-provider throws "Failed to register account" deep inside
   * Z.sync when the account-scoped indexer endpoint is degraded
   * (observed 2026-04-22). The throw doesn't surface through any
   * API we await, so we catch it at the global level and flip the
   * shared sync-status flag to 'degraded' so the popup can show an
   * honest banner + retry button.
   */
  self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    if (isRegisterFailureError(event.reason)) {
      console.warn('[SyncStatus] detected register-failed error; flagging degraded');
      void writeSyncStatus('degraded');
    }
  });

  const launchPopUp = () => {
    chrome.windows.create(
      {
        url: chrome.runtime.getURL('index.html'),
        type: 'popup',
        width: 392,
        height: 567,
      },
      (window) => {
        popupWindowId = window?.id;
        if (popupWindowId) {
          chrome.storage.local.set({
            popupWindowId,
          });
        }
      },
    );
  };

  const verifyAccess = async (requestingDomain: string): Promise<boolean> => {
    const { accounts, selectedAccount } = (await chromeStorageService.getAndSetStorage()) as ChromeStorageObject;
    if (!accounts || !selectedAccount) return false;
    const whitelist = accounts[selectedAccount].settings.whitelist;
    if (!whitelist) return false;
    return whitelist.map((i: WhitelistedApp) => i.domain).includes(requestingDomain);
  };

  const authorizeRequest = async (message: {
    action: YoursEventName;
    params: { domain: string };
  }): Promise<boolean> => {
    if (
      message.action === YoursEventName.QUEUE_STATUS_UPDATE ||
      message.action === YoursEventName.IMPORT_STATUS_UPDATE ||
      message.action === YoursEventName.FETCHING_TX_STATUS_UPDATE
    ) {
      return true;
    }
    const { params } = message;
    return await verifyAccess(params.domain);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chrome.runtime.onMessage.addListener((message: any, sender, sendResponse: CallbackResponse) => {
    if ([YoursEventName.SIGNED_OUT, YoursEventName.SWITCH_ACCOUNT].includes(message.action)) {
      emitEventToActiveTabs(message);
    }

    const noAuthRequired = [
      YoursEventName.IS_CONNECTED,
      YoursEventName.USER_CONNECT_RESPONSE,
      YoursEventName.SEND_BSV_RESPONSE,
      YoursEventName.SEND_BSV20_RESPONSE,
      YoursEventName.SEND_MNEE_RESPONSE,
      YoursEventName.SEND_MNEE_WITH_DATA_RESPONSE,
      YoursEventName.TRANSFER_ORDINAL_RESPONSE,
      YoursEventName.PURCHASE_ORDINAL_RESPONSE,
      YoursEventName.SIGN_MESSAGE_RESPONSE,
      YoursEventName.BROADCAST_RESPONSE,
      YoursEventName.GET_SIGNATURES_RESPONSE,
      YoursEventName.GENERATE_TAGGED_KEYS_RESPONSE,
      YoursEventName.ENCRYPT_RESPONSE,
      YoursEventName.DECRYPT_RESPONSE,
      YoursEventName.SYNC_UTXOS,
      YoursEventName.SWITCH_ACCOUNT,
      YoursEventName.SYNC_RETRY,
      YoursEventName.SIGNED_OUT,
    ];

    if (noAuthRequired.includes(message.action)) {
      switch (message.action) {
        case YoursEventName.IS_CONNECTED:
          return processIsConnectedRequest(message.params as { domain: string }, sendResponse);
        case YoursEventName.USER_CONNECT_RESPONSE:
          return processConnectResponse(message as { decision: Decision; pubKeys: PubKeys });
        case YoursEventName.SEND_BSV_RESPONSE:
          return processSendBsvResponse(message as SendBsvResponse);
        case YoursEventName.SEND_BSV20_RESPONSE:
          return processSendBsv20Response(message as SendBsv20Response);
        case YoursEventName.SEND_MNEE_RESPONSE:
          return processSendMNEEResponse(message as SendMNEEResponse);
        case YoursEventName.SEND_MNEE_WITH_DATA_RESPONSE:
          return processSendMNEEWithDataResponse(message as SendMNEEWithDataResponse);
        case YoursEventName.TRANSFER_ORDINAL_RESPONSE:
          return processTransferOrdinalResponse(message as { txid: string });
        case YoursEventName.PURCHASE_ORDINAL_RESPONSE:
          return processPurchaseOrdinalResponse(message as { txid: string });
        case YoursEventName.SIGN_MESSAGE_RESPONSE:
          return processSignMessageResponse(message as SignedMessage);
        case YoursEventName.BROADCAST_RESPONSE:
          return processBroadcastResponse(message as { txid: string });
        case YoursEventName.GET_SIGNATURES_RESPONSE:
          return processGetSignaturesResponse(message as GetSignaturesResponse);
        case YoursEventName.GENERATE_TAGGED_KEYS_RESPONSE:
          return processGenerateTaggedKeysResponse(message as TaggedDerivationResponse);
        case YoursEventName.ENCRYPT_RESPONSE:
          return processEncryptResponse(message as EncryptResponse);
        case YoursEventName.DECRYPT_RESPONSE:
          return processDecryptResponse(message as DecryptResponse);
        case YoursEventName.SYNC_UTXOS:
          return processSyncUtxos();
        case YoursEventName.SWITCH_ACCOUNT:
          return switchAccount();
        case YoursEventName.SYNC_RETRY:
          return retrySync();
        case YoursEventName.SIGNED_OUT:
          return signOut();
        default:
          break;
      }

      return;
    }

    authorizeRequest(message).then(async (isAuthorized) => {
      if (message.action === YoursEventName.CONNECT) {
        return processConnectRequest(message, sendResponse, isAuthorized);
      }

      if (!isAuthorized) {
        sendResponse({
          type: message.action,
          success: false,
          error: 'Unauthorized!',
        });
        return;
      }

      // BRC-73: stamp the originating domain on storage before
      // dispatching to the per-action handler. Popup-side request pages
      // read `requestingDomain` to look up the granted manifest in the
      // current account's whitelist and short-circuit per-tx prompts.
      // Cleared in cleanup() when the response resolves.
      //
      // Codex review 30589f1733be5351 (MEDIUM): the write MUST be
      // awaited before the typed-request handler runs its own
      // `chromeStorageService.update()`. `update()` is a
      // read-merge-write helper (`get(null) → deepMerge → set`); if
      // the second write's `get(null)` races ahead of the first
      // write's `set()`, the typed slot write reads stale storage and
      // its merged object never gets `requestingDomain`, leaving
      // `useGroupCoverage` to look up an empty domain and the
      // request to nondeterministically fall back to a manual prompt.
      const requestingDomain = (message.params as { domain?: string } | undefined)?.domain;
      if (requestingDomain) {
        await chromeStorageService.update({ requestingDomain });
      }

      switch (message.action) {
        case YoursEventName.DISCONNECT:
          return processDisconnectRequest(message, sendResponse);
        case YoursEventName.GET_PUB_KEYS:
          return processGetPubKeysRequest(sendResponse);
        case YoursEventName.GET_BALANCE:
          return processGetBalanceRequest(sendResponse);
        case YoursEventName.GET_MNEE_BALANCE:
          return processGetMNEEBalanceRequest(sendResponse);
        case YoursEventName.GET_ADDRESSES:
          return processGetAddressesRequest(sendResponse);
        case YoursEventName.GET_NETWORK:
          return processGetNetworkRequest(sendResponse);
        case YoursEventName.GET_ORDINALS:
          return processGetOrdinalsRequest(message, sendResponse);
        case YoursEventName.GET_BSV20S:
          return processGetBsv20sRequest(sendResponse);
        case YoursEventName.SEND_BSV:
        case YoursEventName.INSCRIBE: // We use the sendBsv functionality here
        case YoursEventName.LOCK_BSV: // We use the sendBsv functionality here
          return processSendBsvRequest(message, sendResponse);
        case YoursEventName.SEND_BSV20:
          return processSendBsv20Request(message, sendResponse);
        case YoursEventName.SEND_MNEE:
          return processSendMNEERequest(message, sendResponse);
        case YoursEventName.SEND_MNEE_WITH_DATA:
          return processSendMNEEWithDataRequest(message, sendResponse);
        case YoursEventName.TRANSFER_ORDINAL:
          return processTransferOrdinalRequest(message, sendResponse);
        case YoursEventName.PURCHASE_ORDINAL:
        case YoursEventName.PURCHASE_BSV20:
          return processPurchaseOrdinalRequest(message, sendResponse);
        case YoursEventName.SIGN_MESSAGE:
          return processSignMessageRequest(message, sendResponse);
        case YoursEventName.BROADCAST:
          return processBroadcastRequest(message, sendResponse);
        case YoursEventName.GET_SIGNATURES:
          return processGetSignaturesRequest(message, sendResponse);
        case YoursEventName.GET_SOCIAL_PROFILE:
          return processGetSocialProfileRequest(sendResponse);
        case YoursEventName.GET_PAYMENT_UTXOS:
          return processGetPaymentUtxos(sendResponse);
        case YoursEventName.GET_EXCHANGE_RATE:
          return processGetExchangeRate(sendResponse);
        case YoursEventName.GENERATE_TAGGED_KEYS:
          return processGenerateTaggedKeysRequest(message, sendResponse);
        case YoursEventName.GET_TAGGED_KEYS:
          return processGetTaggedKeys(message, sendResponse);
        case YoursEventName.ENCRYPT:
          return processEncryptRequest(message, sendResponse);
        case YoursEventName.DECRYPT:
          return processDecryptRequest(message, sendResponse);
        default:
          break;
      }
    });

    return true;
  });

  // EMIT EVENTS ********************************

  const emitEventToActiveTabs = (message: { action: YoursEventName; params: RequestParams }) => {
    const { action, params } = message;
    chrome.tabs.query({}, function (tabs) {
      tabs.forEach(function (tab: chrome.tabs.Tab) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: CustomListenerName.YOURS_EMIT_EVENT, action, params });
        }
      });
    });
    return true;
  };

  // REQUESTS ***************************************

  const processConnectRequest = (
    message: { params: RequestParams },
    sendResponse: CallbackResponse,
    isAuthorized: boolean,
  ) => {
    responseCallbackForConnectRequest = sendResponse;
    chromeStorageService
      .update({
        connectRequest: { ...message.params, isAuthorized } as ConnectRequest,
      })
      .then(() => {
        launchPopUp();
      });

    return true;
  };

  const processDisconnectRequest = (message: { params: { domain: string } }, sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(() => {
        const { account } = chromeStorageService.getCurrentAccountObject();
        if (!account) throw Error('No account found!');
        const { whitelist } = account.settings;
        if (!whitelist) throw Error('Already disconnected!');
        const { params } = message;
        const updatedWhitelist = whitelist.filter((i: { domain: string }) => i.domain !== params.domain);
        const key: keyof ChromeStorageObject = 'accounts';
        const update: Partial<ChromeStorageObject['accounts']> = {
          [account.addresses.identityAddress]: {
            ...account,
            settings: {
              ...account.settings,
              whitelist: updatedWhitelist,
            },
          },
        };
        chromeStorageService.updateNested(key, update).then(() => {
          sendResponse({
            type: YoursEventName.DISCONNECT,
            success: true,
            data: true,
          });
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.DISCONNECT,
        success: true, // This is true in the catch because we want to return a boolean
        data: false,
      });
    }
  };

  const processIsConnectedRequest = (params: { domain: string }, sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(() => {
        const result = chromeStorageService.getCurrentAccountObject();
        if (!result?.account) throw Error('No account found!');
        const currentTime = Date.now();
        const lastActiveTime = result.lastActiveTime;

        sendResponse({
          type: YoursEventName.IS_CONNECTED,
          success: true,
          data:
            !result.isLocked &&
            currentTime - Number(lastActiveTime) < INACTIVITY_LIMIT &&
            result.account.settings.whitelist?.map((i: { domain: string }) => i.domain).includes(params.domain),
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.IS_CONNECTED,
        success: true, // This is true in the catch because we want to return a boolean
        error: false,
      });
    }

    return true;
  };

  const processGetBalanceRequest = (sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(() => {
        const { account } = chromeStorageService.getCurrentAccountObject();
        if (!account) throw Error('No account found!');
        sendResponse({
          type: YoursEventName.GET_BALANCE,
          success: true,
          data: account.balance,
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_BALANCE,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGetMNEEBalanceRequest = (sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(() => {
        const { account } = chromeStorageService.getCurrentAccountObject();
        if (!account) throw Error('No account found!');
        mnee.balance(account.addresses.bsvAddress).then(({ amount, decimalAmount }) => {
          sendResponse({
            type: YoursEventName.GET_MNEE_BALANCE,
            success: true,
            data: { amount, decimalAmount },
          });
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_MNEE_BALANCE,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGetPubKeysRequest = (sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(() => {
        const { account } = chromeStorageService.getCurrentAccountObject();
        if (!account) throw Error('No account found!');
        sendResponse({
          type: YoursEventName.GET_PUB_KEYS,
          success: true,
          data: account.pubKeys,
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_PUB_KEYS,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGetAddressesRequest = (sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(() => {
        const { account } = chromeStorageService.getCurrentAccountObject();
        if (!account) throw Error('No account found!');
        sendResponse({
          type: YoursEventName.GET_ADDRESSES,
          success: true,
          data: account.addresses,
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_ADDRESSES,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGetNetworkRequest = (sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(() => {
        const { account } = chromeStorageService.getCurrentAccountObject();
        if (!account) throw Error('No account found!');
        sendResponse({
          type: YoursEventName.GET_NETWORK,
          success: true,
          data: account?.network ?? NetWork.Mainnet,
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_NETWORK,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGetOrdinalsRequest = (message: { params: GetPaginatedOrdinals }, sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(async () => {
        const oneSatSPV = await oneSatSPVPromise;
        if (!oneSatSPV) throw Error('SPV not initialized!');
        const lookup = message?.params?.mimeType
          ? new TxoLookup('origin', 'type', message.params.mimeType)
          : new TxoLookup('origin');
        const isFirstPage = message.params.from === undefined || message.params.from === null;
        const limit = message.params.limit || 50;

        // Tier 1: spv-store. Same query as before.
        let primary;
        try {
          primary = await oneSatSPV.search(
            lookup,
            TxoSort.DESC,
            isFirstPage ? 0 : limit,
            isFirstPage ? '' : message.params.from || '',
          );
        } catch (err) {
          console.warn(
            '[provider getOrdinals] spv-store tier threw — falling back to GorillaPool:',
            (err as Error).message,
          );
          primary = undefined;
        }

        const primaryMapped = (primary?.txos ?? []).map(mapOrdinal);

        // If spv-store returned anything (mapped or unmapped), trust
        // it. Only fall through when it's TRULY empty.
        if (primaryMapped.length > 0 || (primary?.txos.length ?? 0) > 0) {
          if (isFirstPage) {
            sendResponse({
              type: YoursEventName.GET_ORDINALS,
              success: true,
              data: primaryMapped,
            });
          } else {
            sendResponse({
              type: YoursEventName.GET_ORDINALS,
              success: true,
              data: { ordinals: primaryMapped, from: primary?.nextPage },
            });
          }
          return;
        }

        // Tier 2: GorillaPool fallback. Mirrors the existing pattern
        // in `OrdinalService.getOrdinals` (popup-side display path),
        // applied here so app-side providers (DEX, etc.) calling
        // `window.yours.getOrdinals()` work even when spv-store is
        // degraded (e.g., 1sat-provider register-failed). Without
        // this, every provider-driven flow that walks the user's
        // ordinals list breaks the moment spv-store has an empty
        // index — the wallet's own UI worked because it had a
        // fallback; provider callers didn't.
        //
        // Pagination caveat: GP's address-unspent endpoint returns
        // unpaginated; if `from` is set we return empty rather than
        // re-serving everything. Same trade-off as OrdinalService.
        if (!isFirstPage) {
          sendResponse({
            type: YoursEventName.GET_ORDINALS,
            success: true,
            data: { ordinals: [], from: undefined },
          });
          return;
        }
        try {
          const { account } = chromeStorageService.getCurrentAccountObject();
          const addresses = [account?.addresses?.ordAddress, account?.addresses?.bsvAddress].filter(
            (a): a is string => typeof a === 'string' && a.length > 0,
          );

          // Tier 2a: plain inscription UTXOs (NFTs, content inscriptions).
          // GP's `/api/txos/address/{addr}/unspent` filters out BSV-20/21
          // fungible-token UTXOs server-side, so the cucumber UTXOs the
          // user holds will NOT appear here even though they're 1-sat
          // origin-bearing outputs in spv-store's view of the world.
          const inscriptionRows = (
            await Promise.all(
              addresses.map((addr) =>
                gorillaPoolService.getOrdinalUtxosByAddress(addr).catch(() => []),
              ),
            )
          ).flat();
          const inscriptionMapped = inscriptionRows
            .filter(
              (r) =>
                r.origin?.data?.insc?.file?.type !== 'panda/tag' &&
                r.origin?.data?.insc?.file?.type !== 'yours/tag',
            )
            .map((r) => mapGpOrdinal(r, r.owner ?? ''));

          // Tier 2b: BSV-21 fungible token UTXOs. Enumerate the user's
          // token balances via `/api/bsv20/balance`, then for each
          // tick/id with confirmed balance call the BSV-21-specific
          // unspent endpoint and shape each row into an Ordinal so
          // caller code (`useCreatePool`'s `findTokenUtxo` etc.) finds
          // it via `origin.data.bsv20.id` / `data.bsv20.id`.
          let tokenMapped: Ordinal[] = [];
          try {
            const balances = await gorillaPoolService.getBsv20Balances(addresses);
            const heldTokens = balances.filter(
              (b) => (b.all?.confirmed ?? 0n) + (b.all?.pending ?? 0n) > 0n,
            );
            const tokenUtxoArrays = await Promise.all(
              heldTokens.map(async (b) => {
                const tick = b.id ?? b.tick;
                if (!tick) return [];
                const utxos = (await gorillaPoolService.getBSV20Utxos(tick, addresses).catch(() => [])) ?? [];
                return utxos.map((u) => mapBsv20TxoToOrdinal(u));
              }),
            );
            tokenMapped = tokenUtxoArrays.flat();
          } catch (err) {
            console.warn(
              '[provider getOrdinals] BSV-21 enumeration failed (tier 2b):',
              (err as Error).message,
            );
          }

          const fallbackMapped = [...inscriptionMapped, ...tokenMapped];
          if (fallbackMapped.length > 0) {
            console.warn(
              `[provider getOrdinals] GorillaPool fallback returned ${inscriptionMapped.length} inscription(s) + ${tokenMapped.length} BSV-21 token UTXO(s)`,
            );
          }
          sendResponse({
            type: YoursEventName.GET_ORDINALS,
            success: true,
            data: fallbackMapped,
          });
        } catch (err) {
          console.warn('[provider getOrdinals] GorillaPool fallback failed:', (err as Error).message);
          sendResponse({
            type: YoursEventName.GET_ORDINALS,
            success: true,
            data: [],
          });
        }
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_ORDINALS,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGetBsv20sRequest = (sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(async () => {
        let data: SerializedBsv20[] = [];
        const obj = chromeStorageService.getCurrentAccountObject();
        if (obj.account?.addresses?.bsvAddress && obj.account?.addresses?.ordAddress) {
          const rawData = await gorillaPoolService.getBsv20Balances([
            obj.account?.addresses.bsvAddress,
            obj.account?.addresses.ordAddress,
          ]);

          data = rawData.map((d) => {
            return {
              ...d,
              listed: { confirmed: d.listed.confirmed.toString(), pending: d.listed.pending.toString() },
              all: { confirmed: d.all.confirmed.toString(), pending: d.all.pending.toString() },
            };
          });
        }

        sendResponse({
          type: YoursEventName.GET_BSV20S,
          success: true,
          data,
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_BSV20S,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGetExchangeRate = (sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(async (res) => {
        if (!res) throw Error('Could not get storage!');
        const { exchangeRateCache } = res;
        if (exchangeRateCache?.rate && Date.now() - exchangeRateCache.timestamp < 5 * 60 * 1000) {
          sendResponse({
            type: YoursEventName.GET_EXCHANGE_RATE,
            success: true,
            data: Number(exchangeRateCache.rate.toFixed(2)),
          });
        } else {
          const res = await fetch(`${WOC_BASE_URL}/main/exchangerate`);
          if (!res.ok) {
            throw new Error(`Fetch error: ${res.status} - ${res.statusText}`);
          }
          const data = await res.json();
          const rate = data.rate;
          const currentTime = Date.now();
          chromeStorageService.update({
            exchangeRateCache: { rate, timestamp: currentTime },
          });
          sendResponse({
            type: YoursEventName.GET_EXCHANGE_RATE,
            success: true,
            data: Number(rate.toFixed(2)),
          });
        }
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_EXCHANGE_RATE,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  /**
   * Provider-facing fund UTXO listing. Thin wrapper over the shared
   * SpendableUtxos resolver (services/SpendableUtxos.service.ts).
   * Ordered 3-tier failover: spv-store → GorillaPool → WoC+filter.
   * See docs/WALLET_PROVIDER_AUDIT.md for the full rationale.
   */
  const processGetPaymentUtxos = (sendResponse: CallbackResponse) => {
    chromeStorageService
      .getAndSetStorage()
      .then(async () => {
        const oneSatSPV = await oneSatSPVPromise;
        if (!oneSatSPV) throw Error('SPV not initialized!');

        const acct = chromeStorageService.getCurrentAccountObject();
        const bsvAddress = acct?.account?.addresses?.bsvAddress;
        if (!bsvAddress) throw new Error('no bsvAddress in current account');

        const utxos = await getSpendableFundUtxos(bsvAddress, {
          spv: oneSatSPV,
          gorilla: gorillaPoolService,
          woc: wocService,
        });

        const data = utxos.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          satoshis: Number(u.satoshis),
          script: u.scriptHex,
        }));
        sendResponse({ type: YoursEventName.GET_PAYMENT_UTXOS, success: true, data });
      })
      .catch((error) => {
        sendResponse({
          type: YoursEventName.GET_PAYMENT_UTXOS,
          success: false,
          error: (error as Error).message || JSON.stringify(error),
        });
      });
  };

  /**
   * Recently broadcasted txids from BRC-73 auto-resolve flows. Used to
   * dedupe budget increments when the wallet's UTXO selector rebuilds
   * the same tx (same inputs → same signed bytes → same txid) and
   * re-broadcasts it idempotently. Bounded.
   *
   * **Persisted across service-worker restarts** (LAUNCH_RUNBOOK B1):
   * pre-2026-05-02 this was in-memory only, which left a window where
   * an SW eviction within seconds of a sendBsv broadcast could let
   * the immediately-retried request double-count against the rolling-
   * window spending budget (re-broadcast hits "already on network",
   * dedup state is empty after restart so it looks fresh, and
   * recordSpend fires twice for one on-chain tx).
   *
   * Storage key `brc73DedupTxids` lives under chrome.storage.local;
   * load is fire-and-forget (the tracker constructs immediately with
   * empty state and seeds itself once the read resolves). Persist is
   * fire-and-forget per `track()` of a NEW txid. Failures are
   * advisory — in-memory state is authoritative for the current SW
   * lifetime even if persistence is broken.
   */
  const BRC73_DEDUP_STORAGE_KEY = 'brc73DedupTxids';
  const dedupStorageReader: DedupStorageReader = {
    get: async (key) => {
      const result = await chrome.storage.local.get(key);
      return (result as Record<string, unknown>)[key];
    },
  };
  const broadcastDedupTracker = new TxidDedupTracker({
    persist: (txids) => {
      // Fire-and-forget; chrome.storage.local writes are async + queued
      // internally. Errors are surfaced by chrome at the runtime.lastError
      // boundary which we don't read here — the next track() will try
      // again, and the in-memory state is authoritative anyway.
      void chrome.storage.local.set({ [BRC73_DEDUP_STORAGE_KEY]: [...txids] });
    },
  });
  // Async seed from prior SW lifetime — installed via mergeSeed (NOT
  // replayed through track) so a fresh post-construction track is
  // never evicted by stale seed entries filling the capacity. Codex
  // review `2d78f6a85bb7d33c` caught the original track-replay
  // implementation racing in exactly this way.
  void loadDedupTrackerState(dedupStorageReader, BRC73_DEDUP_STORAGE_KEY).then((seed) => {
    if (seed.length === 0) return;
    broadcastDedupTracker.mergeSeed(seed);
  });

  /**
   * BRC-73 background-side auto-resolve for sendBsv. Returns true if
   * the request was fully processed (signed + broadcast + response
   * sent + budget updated) — caller skips the popup launch entirely.
   * Returns false if anything is missing or fails (no manifest, budget
   * exceeded, sign/broadcast error) — caller falls through to the
   * legacy popup-launch flow so the user can manually approve, see
   * the error, etc.
   *
   * Closing the "popup flashes black with an ephemeral snackbar" UX
   * gap: when this returns true, no chrome window is ever created.
   * The DEX page just sees the response resolve directly.
   */
  const tryAutoResolveSendBsv = async (
    requestingDomain: string | undefined,
    sendBsvRequest: SendBsv[],
    sendResponse: CallbackResponse,
  ): Promise<boolean> => {
    if (!requestingDomain) return false;
    try {
      // The background's chromeStorageService has its own in-memory
      // `this.storage` cache, separate from the popup's instance.
      // When the user clicks Revoke in the popup's Settings page, the
      // popup writes to chrome.storage.local (durable) and refreshes
      // ITS cache, but the background's cache stays stale. Force a
      // re-read here so revoke takes effect on the next request.
      await chromeStorageService.getAndSetStorage();

      const { account } = chromeStorageService.getCurrentAccountObject();
      const granted = findGrantedManifest(account?.settings.whitelist, requestingDomain);
      if (!granted) return false;

      const requestSats = sendBsvRequest.reduce((a, r) => a + (r.satoshis ?? 0), 0);
      const coverage = checkGroupCoverage(granted, { kind: 'spending', sats: requestSats });
      if (!coverage.covered) return false;

      const { keysService, bsvService } = await bgServicesPromise;
      const noApprovalLimit = account?.settings.noApprovalLimit ?? 0;

      // Set the per-request brc73Covered flag so retrieveKeys +
      // sendBsv's early verifyPassword gate both bypass the password
      // requirement, mirroring the popup-side withBrc73Coverage flow.
      keysService.brc73Covered = true;
      let sendRes;
      try {
        sendRes = await bsvService.sendBsv(sendBsvRequest, '', noApprovalLimit, false);
      } finally {
        keysService.brc73Covered = false;
      }

      if (!sendRes?.txid || sendRes?.error) {
        // Fall through — popup will surface the actual error.
        console.warn('[BRC-73] background auto-resolve failed; falling back to popup', sendRes?.error);
        return false;
      }

      // Idempotent-rebroadcast guard: if bsvService returned a txid we
      // already spent against this manifest, the wallet's UTXO
      // selector rebuilt the same tx (stale spv-store state).
      // broadcastMultiSource detects "already on network" and treats
      // it as success, but we should NOT double-count against the
      // user's budget. The on-chain tx is still the original spend.
      const { wasDuplicate } = broadcastDedupTracker.track(sendRes.txid);

      // Persist the spend on the granted manifest so the rolling-
      // window budget reflects what's been used. Skip on idempotent
      // rebroadcast — the budget already covered this txid.
      if (!wasDuplicate && account?.addresses?.identityAddress) {
        await persistCoveredSpend(
          chromeStorageService,
          account.addresses.identityAddress,
          requestingDomain,
          requestSats,
        );
      }
      if (wasDuplicate) {
        console.warn(
          `[BRC-73] tx ${sendRes.txid} already broadcast in this session; budget not double-counted`,
        );
      }

      sendResponse({
        type: YoursEventName.SEND_BSV,
        success: true,
        data: { txid: sendRes.txid, rawtx: sendRes.rawtx },
      });
      // Clear the requestingDomain slot so subsequent uncovered
      // requests don't see it carry over.
      chromeStorageService.remove('requestingDomain');
      return true;
    } catch (error) {
      console.warn('[BRC-73] background auto-resolve threw; falling back to popup', error);
      return false;
    }
  };

  // Important note: We process the InscribeRequest as a SendBsv request.
  const processSendBsvRequest = async (
    message: { params: { data: SendBsv[] | InscribeRequest[] | LockRequest[]; domain?: string } },
    sendResponse: CallbackResponse,
  ) => {
    if (!message.params.data) {
      sendResponse({
        type: YoursEventName.SEND_BSV,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      let sendBsvRequest = message.params.data as SendBsv[];

      // If in this if block, it's an inscribe() request.
      const inscribeRequest = message.params.data as InscribeRequest[];
      if (inscribeRequest[0].base64Data) {
        sendBsvRequest = inscribeRequest.map((d: InscribeRequest) => {
          return {
            address: d.address,
            inscription: {
              base64Data: d.base64Data,
              mimeType: d.mimeType,
              map: d.map,
            },
            satoshis: d.satoshis ?? 1,
          } as SendBsv;
        });
      }

      // If in this if block, it's a lock() request.
      const lockRequest = message.params.data as LockRequest[];
      if (lockRequest[0].blockHeight) {
        sendBsvRequest = convertLockReqToSendBsvReq(lockRequest);
      }

      // BRC-73: try background auto-resolve first. If covered, the
      // request is fully processed without ever opening the popup.
      // Only fall through to the legacy popup flow when not covered.
      const autoResolved = await tryAutoResolveSendBsv(
        message.params.domain,
        sendBsvRequest,
        sendResponse,
      );
      if (autoResolved) return;

      responseCallbackForSendBsvRequest = sendResponse;
      chromeStorageService.update({ sendBsvRequest }).then(() => {
        launchPopUp();
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.SEND_BSV,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processSendBsv20Request = (message: { params: SendBsv20 }, sendResponse: CallbackResponse) => {
    if (!message.params) {
      sendResponse({
        type: YoursEventName.SEND_BSV20,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      responseCallbackForSendBsv20Request = sendResponse;
      const sendBsv20Request = message.params;
      chromeStorageService.update({ sendBsv20Request }).then(() => {
        launchPopUp();
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.SEND_BSV20,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processSendMNEERequest = (message: { params: { data: SendMNEE[] } }, sendResponse: CallbackResponse) => {
    if (!message.params.data) {
      sendResponse({
        type: YoursEventName.SEND_MNEE,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      responseCallbackForSendMNEERequest = sendResponse;
      const sendMNEERequest = message.params.data;
      chromeStorageService.update({ sendMNEERequest }).then(() => {
        launchPopUp();
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.SEND_MNEE,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processSendMNEEWithDataRequest = (
    message: { params: { data: SendMNEEWithData } },
    sendResponse: CallbackResponse,
  ) => {
    if (!message.params.data) {
      sendResponse({
        type: YoursEventName.SEND_MNEE_WITH_DATA,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      responseCallbackForSendMNEEWithDataRequest = sendResponse;
      const sendMNEEWithDataRequest = message.params.data;
      chromeStorageService.update({ sendMNEEWithDataRequest }).then(() => {
        launchPopUp();
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.SEND_MNEE_WITH_DATA,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processTransferOrdinalRequest = (message: { params: TransferOrdinal }, sendResponse: CallbackResponse) => {
    if (!message.params) {
      sendResponse({
        type: YoursEventName.TRANSFER_ORDINAL,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      responseCallbackForTransferOrdinalRequest = sendResponse;
      chromeStorageService
        .update({
          transferOrdinalRequest: message.params,
        })
        .then(() => {
          launchPopUp();
        });
    } catch (error) {
      sendResponse({
        type: YoursEventName.TRANSFER_ORDINAL,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processPurchaseOrdinalRequest = (message: { params: PurchaseOrdinal }, sendResponse: CallbackResponse) => {
    if (!message.params) {
      sendResponse({
        type: YoursEventName.PURCHASE_ORDINAL,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      responseCallbackForPurchaseOrdinalRequest = sendResponse;
      chromeStorageService
        .update({
          purchaseOrdinalRequest: message.params,
        })
        .then(() => {
          launchPopUp();
        });
    } catch (error) {
      sendResponse({
        type: YoursEventName.PURCHASE_ORDINAL,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processBroadcastRequest = (message: { params: Broadcast }, sendResponse: CallbackResponse) => {
    if (!message.params) {
      sendResponse({
        type: YoursEventName.BROADCAST,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      responseCallbackForBroadcastRequest = sendResponse;
      chromeStorageService
        .update({
          broadcastRequest: message.params,
        })
        .then(() => {
          launchPopUp();
        });
    } catch (error) {
      sendResponse({
        type: YoursEventName.BROADCAST,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processSignMessageRequest = (message: { params: SignMessage }, sendResponse: CallbackResponse) => {
    if (!message.params) {
      sendResponse({
        type: YoursEventName.SIGN_MESSAGE,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      responseCallbackForSignMessageRequest = sendResponse;
      chromeStorageService
        .update({
          signMessageRequest: message.params,
        })
        .then(() => {
          launchPopUp();
        });
    } catch (error) {
      sendResponse({
        type: YoursEventName.SIGN_MESSAGE,
        success: false,
        error: JSON.stringify(error),
      });
    }

    return true;
  };

  const processGetSignaturesRequest = (message: { params: GetSignatures }, sendResponse: CallbackResponse) => {
    if (!message.params) {
      sendResponse({
        type: YoursEventName.GET_SIGNATURES,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      responseCallbackForGetSignaturesRequest = sendResponse;
      chromeStorageService
        .update({
          getSignaturesRequest: {
            rawtx: message.params.rawtx,
            sigRequests: message.params.sigRequests,
          },
        })
        .then(() => {
          launchPopUp();
        });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_SIGNATURES,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGetSocialProfileRequest = (sendResponse: CallbackResponse) => {
    try {
      chromeStorageService.getAndSetStorage().then(() => {
        const { account } = chromeStorageService.getCurrentAccountObject();
        if (!account) throw Error('No account found!');
        const displayName = account.settings?.socialProfile?.displayName ?? 'Anonymous';
        const avatar = account.settings?.socialProfile?.avatar ?? HOSTED_YOURS_IMAGE;
        sendResponse({
          type: YoursEventName.GET_SOCIAL_PROFILE,
          success: true,
          data: { displayName, avatar },
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_SOCIAL_PROFILE,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGenerateTaggedKeysRequest = (
    message: { params: TaggedDerivationRequest },
    sendResponse: CallbackResponse,
  ) => {
    if (!message.params) {
      sendResponse({
        type: YoursEventName.GENERATE_TAGGED_KEYS,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      responseCallbackForGenerateTaggedKeysRequest = sendResponse;
      chromeStorageService
        .update({
          generateTaggedKeysRequest: message.params,
        })
        .then(() => {
          launchPopUp();
        });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GENERATE_TAGGED_KEYS,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processGetTaggedKeys = async (
    message: { params: GetTaggedKeysRequest & { domain: string } },
    sendResponse: CallbackResponse,
  ) => {
    if (!message.params.label) {
      sendResponse({
        type: YoursEventName.GET_TAGGED_KEYS,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      chromeStorageService.getAndSetStorage().then((res) => {
        const { account } = chromeStorageService.getCurrentAccountObject();
        if (!res || !account) throw Error('No account found!');
        const { lastActiveTime, isLocked } = res;
        const { derivationTags } = account;
        const currentTime = Date.now();
        if (isLocked || currentTime - Number(lastActiveTime) > INACTIVITY_LIMIT) {
          sendResponse({
            type: YoursEventName.GET_TAGGED_KEYS,
            success: false,
            error: 'Unauthorized! Wallet is locked.',
          });
        }

        let returnData =
          derivationTags.length > 0
            ? derivationTags?.filter(
                (res: TaggedDerivationResponse) =>
                  res.tag.label === message.params.label && res.tag.domain === message.params.domain,
              )
            : [];

        if (returnData.length > 0 && (message?.params?.ids?.length ?? 0 > 0)) {
          returnData = returnData?.filter((d: TaggedDerivationResponse) => message?.params?.ids?.includes(d.tag.id));
        }

        sendResponse({
          type: YoursEventName.GET_TAGGED_KEYS,
          success: true,
          data: returnData,
        });
      });
    } catch (error) {
      sendResponse({
        type: YoursEventName.GET_TAGGED_KEYS,
        success: false,
        error: JSON.stringify(error),
      });
    }
  };

  const processEncryptRequest = (message: { params: EncryptRequest }, sendResponse: CallbackResponse) => {
    if (!message.params) {
      sendResponse({
        type: YoursEventName.ENCRYPT,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      responseCallbackForEncryptRequest = sendResponse;
      chromeStorageService
        .update({
          encryptRequest: message.params,
        })
        .then(() => {
          launchPopUp();
        });
    } catch (error) {
      sendResponse({
        type: YoursEventName.ENCRYPT,
        success: false,
        error: JSON.stringify(error),
      });
    }

    return true;
  };

  const processDecryptRequest = (message: { params: DecryptRequest }, sendResponse: CallbackResponse) => {
    if (!message.params) {
      sendResponse({
        type: YoursEventName.DECRYPT,
        success: false,
        error: 'Must provide valid params!',
      });
      return;
    }
    try {
      responseCallbackForDecryptRequest = sendResponse;
      chromeStorageService
        .update({
          decryptRequest: message.params,
        })
        .then(() => {
          launchPopUp();
        });
    } catch (error) {
      sendResponse({
        type: YoursEventName.DECRYPT,
        success: false,
        error: JSON.stringify(error),
      });
    }

    return true;
  };

  // RESPONSES ********************************

  const cleanup = (types: YoursEventName[]) => {
    chromeStorageService.getAndSetStorage().then((res) => {
      if (res?.popupWindowId) {
        removeWindow(res.popupWindowId);
        // Always clear `requestingDomain` alongside the typed request
        // slot so the next request starts with a fresh BRC-73 lookup.
        chromeStorageService.remove([...types, 'popupWindowId', 'requestingDomain']);
      }
    });
  };

  const processConnectResponse = (response: { decision: Decision; pubKeys: PubKeys }) => {
    if (!responseCallbackForConnectRequest) throw Error('Missing callback!');
    try {
      if (response.decision === 'approved') {
        responseCallbackForConnectRequest({
          type: YoursEventName.CONNECT,
          success: true,
          data: response.pubKeys.identityPubKey,
        });
      } else {
        responseCallbackForConnectRequest({
          type: YoursEventName.CONNECT,
          success: false,
          error: 'User declined the connection request',
        });
      }
    } catch (error) {
      responseCallbackForConnectRequest?.({
        type: YoursEventName.CONNECT,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.CONNECT]);
    }

    return true;
  };

  const processSendBsvResponse = (response: SendBsvResponse) => {
    if (!responseCallbackForSendBsvRequest) throw Error('Missing callback!');
    try {
      responseCallbackForSendBsvRequest({
        type: YoursEventName.SEND_BSV,
        success: true,
        data: { txid: response.txid, rawtx: response.rawtx },
      });
    } catch (error) {
      responseCallbackForSendBsvRequest?.({
        type: YoursEventName.SEND_BSV,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.SEND_BSV]);
    }

    return true;
  };

  const processSendBsv20Response = (response: SendBsv20Response) => {
    if (!responseCallbackForSendBsv20Request) throw Error('Missing callback!');
    try {
      responseCallbackForSendBsv20Request({
        type: YoursEventName.SEND_BSV20,
        success: true,
        data: { txid: response.txid, rawtx: response.rawtx },
      });
    } catch (error) {
      responseCallbackForSendBsv20Request?.({
        type: YoursEventName.SEND_BSV20,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.SEND_BSV20]);
    }

    return true;
  };

  const processSendMNEEResponse = (response: SendMNEEResponse) => {
    if (!responseCallbackForSendMNEERequest) throw Error('Missing callback!');
    try {
      responseCallbackForSendMNEERequest({
        type: YoursEventName.SEND_MNEE,
        success: true,
        data: { txid: response.txid, rawtx: response.rawtx },
      });
    } catch (error) {
      responseCallbackForSendMNEERequest?.({
        type: YoursEventName.SEND_MNEE,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.SEND_MNEE]);
    }

    return true;
  };

  const processSendMNEEWithDataResponse = (response: SendMNEEWithDataResponse) => {
    if (!responseCallbackForSendMNEEWithDataRequest) throw Error('Missing callback!');
    try {
      if (response.error) {
        responseCallbackForSendMNEEWithDataRequest({
          type: YoursEventName.SEND_MNEE_WITH_DATA,
          success: false,
          error: response.error,
        });
      } else {
        responseCallbackForSendMNEEWithDataRequest({
          type: YoursEventName.SEND_MNEE_WITH_DATA,
          success: true,
          data: {
            rawtx: response.rawtx,
            ticketId: response.ticketId,
            localTxid: response.localTxid,
          },
        });
      }
    } catch (error) {
      responseCallbackForSendMNEEWithDataRequest?.({
        type: YoursEventName.SEND_MNEE_WITH_DATA,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.SEND_MNEE_WITH_DATA]);
    }

    return true;
  };

  const processTransferOrdinalResponse = (response: { txid: string }) => {
    if (!responseCallbackForTransferOrdinalRequest) throw Error('Missing callback!');
    try {
      responseCallbackForTransferOrdinalRequest({
        type: YoursEventName.TRANSFER_ORDINAL,
        success: true,
        data: response?.txid,
      });
    } catch (error) {
      responseCallbackForTransferOrdinalRequest?.({
        type: YoursEventName.TRANSFER_ORDINAL,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.TRANSFER_ORDINAL]);
    }

    return true;
  };

  const processGenerateTaggedKeysResponse = (response: TaggedDerivationResponse) => {
    if (!responseCallbackForGenerateTaggedKeysRequest) throw Error('Missing callback!');
    try {
      responseCallbackForGenerateTaggedKeysRequest({
        type: YoursEventName.GENERATE_TAGGED_KEYS,
        success: true,
        data: {
          address: response?.address,
          pubKey: response?.pubKey,
          tag: response?.tag,
        },
      });
    } catch (error) {
      responseCallbackForGenerateTaggedKeysRequest?.({
        type: YoursEventName.GENERATE_TAGGED_KEYS,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.GENERATE_TAGGED_KEYS]);
    }

    return true;
  };

  const processPurchaseOrdinalResponse = (response: { txid: string }) => {
    if (!responseCallbackForPurchaseOrdinalRequest) throw Error('Missing callback!');
    try {
      responseCallbackForPurchaseOrdinalRequest({
        type: YoursEventName.PURCHASE_ORDINAL,
        success: true,
        data: response?.txid,
      });
    } catch (error) {
      responseCallbackForPurchaseOrdinalRequest?.({
        type: YoursEventName.PURCHASE_ORDINAL,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.PURCHASE_ORDINAL]);
    }

    return true;
  };

  const processSignMessageResponse = (response: SignedMessage) => {
    if (!responseCallbackForSignMessageRequest) throw Error('Missing callback!');
    try {
      responseCallbackForSignMessageRequest({
        type: YoursEventName.SIGN_MESSAGE,
        success: true,
        data: {
          address: response?.address,
          pubKey: response?.pubKey,
          message: response?.message,
          sig: response?.sig,
          derivationTag: response?.derivationTag,
        },
      });
    } catch (error) {
      responseCallbackForSignMessageRequest?.({
        type: YoursEventName.SIGN_MESSAGE,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.SIGN_MESSAGE]);
    }

    return true;
  };

  const processBroadcastResponse = (response: { error?: string; txid?: string }) => {
    if (!responseCallbackForBroadcastRequest) throw Error('Missing callback!');
    try {
      if (response?.error) {
        responseCallbackForBroadcastRequest({
          type: YoursEventName.BROADCAST,
          success: false,
          error: response?.error,
        });
        return;
      }
      responseCallbackForBroadcastRequest({
        type: YoursEventName.BROADCAST,
        success: true,
        data: response?.txid,
      });
    } catch (error) {
      responseCallbackForBroadcastRequest?.({
        type: YoursEventName.BROADCAST,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.BROADCAST]);
    }

    return true;
  };

  const processGetSignaturesResponse = (response: { error?: string; sigResponses?: SignatureResponse[] }) => {
    if (!responseCallbackForGetSignaturesRequest) throw Error('Missing callback!');
    try {
      responseCallbackForGetSignaturesRequest({
        type: YoursEventName.GET_SIGNATURES,
        success: !response?.error,
        data: response?.sigResponses ?? [],
        error: response?.error,
      });
    } catch (error) {
      responseCallbackForGetSignaturesRequest?.({
        type: YoursEventName.GET_SIGNATURES,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.GET_SIGNATURES]);
    }

    return true;
  };

  const processEncryptResponse = (response: { encryptedMessages: string[] }) => {
    if (!responseCallbackForEncryptRequest) throw Error('Missing callback!');
    try {
      responseCallbackForEncryptRequest({
        type: YoursEventName.ENCRYPT,
        success: true,
        data: response.encryptedMessages,
      });
    } catch (error) {
      responseCallbackForEncryptRequest?.({
        type: YoursEventName.ENCRYPT,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.ENCRYPT]);
    }

    return true;
  };

  const processDecryptResponse = (response: { decryptedMessages: string[] }) => {
    if (!responseCallbackForDecryptRequest) throw Error('Missing callback!');
    try {
      responseCallbackForDecryptRequest({
        type: YoursEventName.DECRYPT,
        success: true,
        data: response.decryptedMessages,
      });
    } catch (error) {
      responseCallbackForDecryptRequest?.({
        type: YoursEventName.DECRYPT,
        success: false,
        error: JSON.stringify(error),
      });
    } finally {
      cleanup([YoursEventName.DECRYPT]);
    }

    return true;
  };

  // HANDLE WINDOW CLOSE *****************************************
  chrome.windows.onRemoved.addListener((closedWindowId) => {
    console.log('Window closed: ', closedWindowId);
    // Upstream had `localStorage.removeItem('walletImporting')` here —
    // removed 2026-04-22. localStorage is undefined in MV3 service
    // workers, so the call was throwing "ReferenceError:
    // localStorage is not defined" on every popup close. The flag
    // it was clearing is now managed by SyncStatus (see
    // services/SyncStatus.service.ts).

    if (closedWindowId === popupWindowId) {
      if (responseCallbackForConnectRequest) {
        responseCallbackForConnectRequest({
          type: YoursEventName.CONNECT,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForConnectRequest = null;
        chromeStorageService.remove('connectRequest');
      }

      if (responseCallbackForSendBsvRequest) {
        responseCallbackForSendBsvRequest({
          type: YoursEventName.SEND_BSV,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForSendBsvRequest = null;
        chromeStorageService.remove('sendBsvRequest');
      }

      if (responseCallbackForSendBsv20Request) {
        responseCallbackForSendBsv20Request({
          type: YoursEventName.SEND_BSV20,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForSendBsvRequest = null;
        chromeStorageService.remove('sendBsv20Request');
      }

      if (responseCallbackForSendMNEERequest) {
        responseCallbackForSendMNEERequest({
          type: YoursEventName.SEND_MNEE,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForSendBsvRequest = null;
        chromeStorageService.remove('sendMNEERequest');
      }

      if (responseCallbackForSendMNEEWithDataRequest) {
        responseCallbackForSendMNEEWithDataRequest({
          type: YoursEventName.SEND_MNEE_WITH_DATA,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForSendMNEEWithDataRequest = null;
        chromeStorageService.remove('sendMNEEWithDataRequest');
      }

      if (responseCallbackForSignMessageRequest) {
        responseCallbackForSignMessageRequest({
          type: YoursEventName.SIGN_MESSAGE,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForSignMessageRequest = null;
        chromeStorageService.remove('signMessageRequest');
      }

      if (responseCallbackForTransferOrdinalRequest) {
        responseCallbackForTransferOrdinalRequest({
          type: YoursEventName.TRANSFER_ORDINAL,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForTransferOrdinalRequest = null;
        chromeStorageService.remove('transferOrdinalRequest');
      }

      if (responseCallbackForPurchaseOrdinalRequest) {
        responseCallbackForPurchaseOrdinalRequest({
          type: YoursEventName.PURCHASE_ORDINAL,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForPurchaseOrdinalRequest = null;
        chromeStorageService.remove('purchaseOrdinalRequest');
      }

      if (responseCallbackForBroadcastRequest) {
        responseCallbackForBroadcastRequest({
          type: YoursEventName.BROADCAST,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForBroadcastRequest = null;
        chromeStorageService.remove('broadcastRequest');
      }

      if (responseCallbackForGetSignaturesRequest) {
        responseCallbackForGetSignaturesRequest({
          type: YoursEventName.GET_SIGNATURES,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForGetSignaturesRequest = null;
        chromeStorageService.remove('getSignaturesRequest');
      }

      if (responseCallbackForGenerateTaggedKeysRequest) {
        responseCallbackForGenerateTaggedKeysRequest({
          type: YoursEventName.GENERATE_TAGGED_KEYS,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForGenerateTaggedKeysRequest = null;
        chromeStorageService.remove('generateTaggedKeysRequest');
      }

      if (responseCallbackForEncryptRequest) {
        responseCallbackForEncryptRequest({
          type: YoursEventName.ENCRYPT,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForEncryptRequest = null;
        chromeStorageService.remove('encryptRequest');
      }

      if (responseCallbackForDecryptRequest) {
        responseCallbackForDecryptRequest({
          type: YoursEventName.DECRYPT,
          success: false,
          error: 'User dismissed the request!',
        });
        responseCallbackForDecryptRequest = null;
        chromeStorageService.remove('decryptRequest');
      }

      popupWindowId = undefined;
      chromeStorageService.remove('popupWindowId');
    }
  });
}
