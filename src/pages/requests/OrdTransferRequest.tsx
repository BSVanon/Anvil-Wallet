import validate from 'bitcoin-address-validation';
import { useEffect, useState } from 'react';
import { TransferOrdinal } from 'yours-wallet-provider';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Ordinal } from '../../components/Ordinal';
import { Ordinal as OrdType } from 'yours-wallet-provider';
import { PageLoader } from '../../components/PageLoader';
import { ConfirmContent, FormContainer, HeaderText, Text } from '../../components/Reusable';
import { Show } from '../../components/Show';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useGroupCoverage } from '../../hooks/useGroupCoverage';
import { removeWindow, sendMessage } from '../../utils/chromeHelpers';
import { truncate } from '../../utils/format';
import { sleep } from '../../utils/sleep';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { getErrorMessage } from '../../utils/tools';

/**
 * BRC-46-style basket name for native (non-BSV-20) ordinals. Apps
 * declaring `basketAccess: [{ basket: 'ordinals' }]` in their manifest
 * grant the wallet permission to auto-resolve ordinal-transfer requests
 * without per-tx prompts.
 */
const ORDINAL_BASKET = 'ordinals';

export type OrdTransferRequestProps = {
  request: TransferOrdinal;
  popupId: number | undefined;
  onResponse: () => void;
};

export const OrdTransferRequest = (props: OrdTransferRequestProps) => {
  const { request, popupId, onResponse } = props;
  const { theme } = useTheme();
  const { hideMenu } = useBottomMenu();
  const [isProcessing, setIsProcessing] = useState(false);
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const { addSnackbar } = useSnackbar();
  const { chromeStorageService, ordinalService, gorillaPoolService, keysService } = useServiceContext();
  const { withBrc73Coverage } = keysService;
  const isPasswordRequired = chromeStorageService.isPasswordRequired();
  const network = chromeStorageService.getNetwork();
  const [ordinal, setOrdinal] = useState<OrdType | undefined>();
  const [hasSent, setHasSent] = useState(false);

  // BRC-73: ordinal transfers require basket access for the
  // 'ordinals' BRC-46 basket.
  const { loaded: brc73Loaded, check: brc73Check } = useGroupCoverage();
  const coverage = brc73Loaded ? brc73Check({ kind: 'basket', basket: ORDINAL_BASKET }) : null;

  useEffect(() => {
    hideMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ordinalService || !request?.outpoint) return;
    ordinalService.getOrdinal(request.outpoint).then((ord) => {
      setOrdinal(ord);
    });
  }, [ordinalService, request.outpoint]);

  const runTransfer = async (password: string): Promise<void> => {
    setIsProcessing(true);
    await sleep(25);
    if (!validate(request.address)) {
      addSnackbar('Invalid address detected!', 'info');
      setIsProcessing(false);
      return;
    }

    const transferRes = await ordinalService.transferOrdinal(request.address, request.outpoint, password);

    if (!transferRes.txid || transferRes.error) {
      addSnackbar(getErrorMessage(transferRes.error), 'error');
      setIsProcessing(false);
      return;
    }

    addSnackbar('Transfer Successful!', 'success');
    await sleep(2000);

    sendMessage({
      action: 'transferOrdinalResponse',
      txid: transferRes.txid,
    });
    onResponse();
  };

  const handleTransferOrdinal = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!passwordConfirm && isPasswordRequired) {
      addSnackbar('You must enter a password!', 'error');
      return;
    }
    await runTransfer(passwordConfirm);
  };

  // BRC-73 auto-resolve: covered ordinal transfers fire runTransfer
  // under withBrc73Coverage so retrieveKeys bypasses the password gate.
  useEffect(() => {
    if (hasSent || !coverage?.covered) return;
    setHasSent(true);
    setTimeout(async () => {
      await withBrc73Coverage(async () => {
        await runTransfer('');
      });
    }, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverage?.covered, hasSent]);

  const clearRequest = async () => {
    sendMessage({
      action: 'transferOrdinalResponse',
      error: 'User cancelled the request',
    });
    await chromeStorageService.remove('transferOrdinalRequest');
    if (popupId) removeWindow(popupId);
    window.location.reload();
  };

  return (
    <>
      <Show when={isProcessing}>
        <PageLoader theme={theme} message="Processing request..." />
      </Show>

      <Show when={!isProcessing && !!request}>
        <ConfirmContent>
          <HeaderText theme={theme}>Approve Request</HeaderText>
          {ordinal && (
            <Ordinal
              inscription={ordinal}
              theme={theme}
              url={`${gorillaPoolService.getBaseUrl(network)}/content/${request.origin}`}
              selected={true}
            />
          )}
          <FormContainer noValidate onSubmit={(e) => handleTransferOrdinal(e)}>
            <Text theme={theme} style={{ margin: '1rem 0' }}>
              {`Transfer to: ${truncate(request.address, 5, 5)}`}
            </Text>
            <Show when={isPasswordRequired}>
              <Input
                theme={theme}
                placeholder="Password"
                type="password"
                autoFocus
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                style={{ margin: '0.25rem' }}
              />
            </Show>
            <Text theme={theme} style={{ margin: '0.5rem 0' }}>
              Double check details before sending.
            </Text>
            <Button theme={theme} type="primary" label="Approve" disabled={isProcessing} isSubmit />
            <Button theme={theme} type="secondary" label="Cancel" onClick={clearRequest} disabled={isProcessing} />
          </FormContainer>
        </ConfirmContent>
      </Show>
    </>
  );
};
