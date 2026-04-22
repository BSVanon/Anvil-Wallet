import {
  Bsv20Indexer,
  Bsv21Indexer,
  FundIndexer,
  Indexer,
  IndexMode,
  InscriptionIndexer,
  LockIndexer,
  MapIndexer,
  // OneSatIndexer,
  OneSatWebSPV,
  OrdLockIndexer,
  OriginIndexer,
  ParseMode,
  SigmaIndexer,
  CosignIndexer,
} from 'spv-store';
import { NetWork } from 'yours-wallet-provider';
import { BlockHeightTrackerMessage } from './hooks/useBlockHeightTracker';
import { FetchingMessage, ImportTrackerMessage, QueueTrackerMessage } from './hooks/useQueueTracker';
import { YoursEventName } from './inject';
import { ChromeStorageService } from './services/ChromeStorage.service';
import { sendMessage } from './utils/chromeHelpers';
import { writeSyncStatus } from './services/SyncStatus.service';
import { theme } from './theme';
import { MNEE_DECIMALS, MNEE_ICON_ID, MNEE_SYM, MNEE_TOKEN_ID } from './utils/constants';
import { MNEEIndexer } from './utils/mneeIndexer';

export const getIndexers = (owners: Set<string>, network: NetWork) => {
  const SYNC_HISTORY = false;
  const indexers: Indexer[] = [new FundIndexer(owners, network, SYNC_HISTORY), new CosignIndexer(owners, network)];
  const lockIndexer = new LockIndexer(owners, network, SYNC_HISTORY);
  const bsv20Indexers = [
    new Bsv21Indexer(
      owners,
      IndexMode.Trust,
      [
        {
          id: MNEE_TOKEN_ID,
          icon: MNEE_ICON_ID,
          sym: MNEE_SYM,
          dec: MNEE_DECIMALS,
          op: 'deploy+mint',
          amt: 0n,
          fundAddress: '',
          status: 1,
        },
      ],
      network,
    ),
    new Bsv20Indexer(owners, IndexMode.Trust, network),
  ];

  const mneeIndexer = new MNEEIndexer(owners, network);

  const ordIndexers = [
    // new OneSatIndexer(owners, network, SYNC_HISTORY),
    new OrdLockIndexer(owners, network),
    new InscriptionIndexer(owners, network),
    new MapIndexer(owners, network),
    new SigmaIndexer(owners, network),
    new OriginIndexer(owners, network, SYNC_HISTORY),
  ];

  if (theme.settings.services.locks) indexers.push(lockIndexer);
  if (theme.settings.services.ordinals) {
    indexers.push(...ordIndexers);
  }
  if (theme.settings.services.bsv20) indexers.push(...bsv20Indexers);
  if (theme.settings.services.mnee) {
    indexers.push(mneeIndexer);
  }
  return indexers;
};

export const getOwners = (chromeStorageService: ChromeStorageService) => {
  const { account } = chromeStorageService.getCurrentAccountObject();
  let { bsvAddress, identityAddress, ordAddress } = account?.addresses || {};
  if (!bsvAddress) bsvAddress = '';
  if (!identityAddress) identityAddress = '';
  if (!ordAddress) ordAddress = '';
  return new Set<string>([bsvAddress, identityAddress, ordAddress]);
};

export const initOneSatSPV = async (chromeStorageService: ChromeStorageService, startSync = false) => {
  const { selectedAccount, account } = chromeStorageService.getCurrentAccountObject();
  const network = chromeStorageService.getNetwork();
  const syncSources = new Set<string>(['fund', 'lock']);

  // Set true to sync full history of transactions.
  const owners = getOwners(chromeStorageService);
  const indexers = getIndexers(owners, network);

  if (theme.settings.services.ordinals) {
    syncSources.add('origin');
  }

  if (theme.settings.services.mnee) {
    syncSources.add('mnee');
  }

  // Seed the sync-status flag so the popup sees "initializing" on
  // first open (before any event has fired). If sync has nothing to
  // do, the banner will stay on "initializing" briefly; the unhandled
  // rejection handler in background.ts flips it to 'degraded' if
  // register fails, and registerEventListeners below flips it to
  // 'healthy' on the first real sync event.
  if (startSync && !!account) {
    void writeSyncStatus('initializing');
  }

  const oneSatSPV = await OneSatWebSPV.init(
    selectedAccount || '',
    indexers,
    owners,
    network == NetWork.Mainnet ? NetWork.Mainnet : NetWork.Testnet,
    startSync && !!account,
    syncSources,
    ParseMode.Persist,
  );

  if (!oneSatSPV) throw Error('SPV not initialized!');

  await registerEventListeners(oneSatSPV, selectedAccount || '', startSync);

  return oneSatSPV;
};

const registerEventListeners = async (oneSatSPV: OneSatWebSPV, selectedAccount: string, startSync: boolean) => {
  // Any real sync event = spv-store is working. Flip the shared sync
  // status to 'healthy' so the popup banner clears. The unhandled-
  // rejection listener in background.ts handles the opposite case
  // (flip to 'degraded' when register throws).
  const markHealthy = () => {
    void writeSyncStatus('healthy');
  };

  oneSatSPV.events.on('queueStats', (data: { length: number }) => {
    markHealthy();
    const message: QueueTrackerMessage = { action: YoursEventName.QUEUE_STATUS_UPDATE, data };
    try {
      sendMessage(message);
      // eslint-disable-next-line no-empty
    } catch (e) {}
  });

  oneSatSPV.events.on('importing', (data: { tag: string; name: string }) => {
    markHealthy();
    const message: ImportTrackerMessage = { action: YoursEventName.IMPORT_STATUS_UPDATE, data };
    // NOTE: the old upstream line `localStorage.setItem('walletImporting',
    // 'true')` was removed. localStorage is not defined in MV3 service
    // workers, and the value was anyway redundant with the SyncStatus
    // signal above. Removing it also fixes the "Error in event handler:
    // ReferenceError: localStorage is not defined" warning in the SW log.
    try {
      sendMessage(message);
      // eslint-disable-next-line no-empty
    } catch (e) {}
  });

  oneSatSPV.events.on('fetchingTx', (data: { txid: string }) => {
    markHealthy();
    const message: FetchingMessage = { action: YoursEventName.FETCHING_TX_STATUS_UPDATE, data };
    try {
      sendMessage(message);
      // eslint-disable-next-line no-empty
    } catch (e) {}
  });

  if (startSync) {
    const tip = await oneSatSPV.getChaintip();
    oneSatSPV.events.on('syncedBlockHeight', (lastHeight: number) => {
      try {
        const message: BlockHeightTrackerMessage = {
          action: YoursEventName.BLOCK_HEIGHT_UPDATE,
          data: { currentHeight: tip?.height || 0, lastHeight },
        };
        selectedAccount && sendMessage(message);
        // eslint-disable-next-line no-empty
      } catch (error) {}
    });
  }
};
