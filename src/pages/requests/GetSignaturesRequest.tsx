import React, { useEffect, useState } from 'react';
import { GetSignatures, SignatureResponse } from 'yours-wallet-provider';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { PageLoader } from '../../components/PageLoader';
import { ConfirmContent, FormContainer, HeaderText, Text } from '../../components/Reusable';
import { Show } from '../../components/Show';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useGroupCoverage } from '../../hooks/useGroupCoverage';
import { removeWindow, sendMessage } from '../../utils/chromeHelpers';
import { sleep } from '../../utils/sleep';
import TxPreview from '../../components/TxPreview';
import { IndexContext } from 'spv-store';
import { getErrorMessage, getTxFromRawTxFormat } from '../../utils/tools';
import { styled } from 'styled-components';
import { BSV_DECIMAL_CONVERSION } from '../../utils/constants';

const Wrapper = styled(ConfirmContent)`
  max-height: calc(100vh - 8rem);
  overflow-y: auto;
`;

export type GetSignaturesResponse = {
  sigResponses?: SignatureResponse[];
  error?: string;
};

export type GetSignaturesRequestProps = {
  request: GetSignatures;
  popupId: number | undefined;
  onSignature: () => void;
};

export const GetSignaturesRequest = (props: GetSignaturesRequestProps) => {
  const { theme } = useTheme();
  const { handleSelect, hideMenu } = useBottomMenu();
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const { addSnackbar, message } = useSnackbar();
  const { chromeStorageService, contractService, oneSatSPV, keysService } = useServiceContext();
  const { withBrc73Coverage } = keysService;
  const isPasswordRequired = chromeStorageService.isPasswordRequired();
  const [txData, setTxData] = useState<IndexContext>();
  const [hasSent, setHasSent] = useState(false);
  const { bsvAddress, ordAddress, identityAddress } = keysService;
  const { request, onSignature, popupId } = props;

  // BRC-73: every sig request must be covered. If any requested
  // protocolID isn't in the granted manifest, fall through to the
  // per-tx prompt (signing is all-or-nothing — partial coverage isn't
  // safe).
  const { loaded: brc73Loaded, check: brc73Check } = useGroupCoverage();
  const sigCoverages = brc73Loaded
    ? request.sigRequests.map((r) => {
        const protocolName =
          // SignatureRequest may carry an explicit protocolID; fall
          // back to a generic 'yours-tx-sig' name when absent.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((r as any).protocolID as string | undefined) ?? 'yours-tx-sig';
        return brc73Check({
          kind: 'protocol',
          protocolID: [0, protocolName],
        });
      })
    : null;
  const allSigsCovered =
    !!sigCoverages && sigCoverages.length > 0 && sigCoverages.every((c) => c.covered);
  const [satsOut, setSatsOut] = useState(0);
  const [getSigsResponse, setGetSigsResponse] = useState<{
    sigResponses?: SignatureResponse[] | undefined;
    error?:
      | {
          message: string;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cause?: any;
        }
      | undefined;
  }>();
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!bsvAddress || !ordAddress || !identityAddress || !oneSatSPV || !txData) return;
    (async () => {
      console.log(bsvAddress, ordAddress, identityAddress);
      // how much did the user put in to the tx
      let userSatsOut = txData.spends.reduce((acc, spend) => {
        if (spend.owner && [bsvAddress, ordAddress, identityAddress].includes(spend.owner)) {
          return acc + spend.satoshis;
        }
        return acc;
      }, 0n);

      // how much did the user get back from the tx
      userSatsOut = txData.txos.reduce((acc, txo) => {
        if (txo.owner && [bsvAddress, ordAddress, identityAddress].includes(txo.owner)) {
          return acc - txo.satoshis;
        }
        return acc;
      }, userSatsOut);

      setSatsOut(Number(userSatsOut));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txData]);

  useEffect(() => {
    (async () => {
      if (!request.rawtx || !oneSatSPV) return;
      setIsLoading(true);
      const tx = getTxFromRawTxFormat(request.rawtx, request.format || 'tx');
      // parseTx calls populateTx → fetchProof against the 1sat.app indexer
      // for the tx itself, which hangs indefinitely when the indexer is
      // degraded AND for any unbroadcast tx (no proof exists yet). Race
      // against a short timeout so the sign popup never deadlocks: if
      // parseTx hasn't returned in 6s, proceed with a minimal local
      // preview built from tx.outputs/inputs directly. The user still
      // sees the full tx details and can approve/reject.
      const timeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 6000),
      );
      const parsed = await Promise.race([oneSatSPV.parseTx(tx).catch(() => 'error' as const), timeout]);
      if (parsed === 'timeout' || parsed === 'error') {
        // Build a degraded-but-safe IndexContext from the tx alone. No
        // ordinal metadata enrichment — caller is responsible for having
        // vetted inputs before requesting the signature (the DEX does
        // this via its own ordinal preflight before calling getSignatures).
        const fallback: IndexContext = {
          tx,
          txid: tx.id('hex') as string,
          spends: [],
          txos: [],
        } as unknown as IndexContext;
        setTxData(fallback);
        console.warn(
          '[GetSignaturesRequest] oneSatSPV.parseTx ' +
            (parsed === 'timeout' ? 'timed out after 6s' : 'errored') +
            ' — rendering sign popup with minimal preview. SPV indexer degraded?',
        );
      } else {
        setTxData(parsed);
      }
      setIsLoading(false);
    })();
  }, [oneSatSPV, request]);

  useEffect(() => {
    handleSelect('bsv');
    hideMenu();
  }, [handleSelect, hideMenu]);

  const resetSendState = () => {
    setPasswordConfirm('');
    setGetSigsResponse(undefined);
    setIsProcessing(false);
  };

  useEffect(() => {
    if (!getSigsResponse) return;
    if (!message && getSigsResponse) {
      resetSendState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, getSigsResponse]);

  const runSigning = async (password: string): Promise<void> => {
    setIsProcessing(true);
    await sleep(25);

    const getSigsRes = await contractService.getSignatures(request, password);

    if (getSigsRes?.error) {
      sendMessage({
        action: 'getSignaturesResponse',
        ...getSigsRes,
      });

      addSnackbar(getErrorMessage(getSigsRes.error.message), 'error', 3000);
      setIsProcessing(false);
      return;
    }

    setGetSigsResponse(getSigsRes);
    sendMessage({
      action: 'getSignaturesResponse',
      ...getSigsRes,
    });

    addSnackbar('Successfully Signed!', 'success');
    await sleep(2000);
    onSignature();
  };

  const handleSigning = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!passwordConfirm && isPasswordRequired) {
      addSnackbar('You must enter a password!', 'error', 3000);
      return;
    }
    await runSigning(passwordConfirm);
  };

  // BRC-73 auto-resolve: covered tx-signing requests fire runSigning
  // under withBrc73Coverage. All sig requests must be covered.
  useEffect(() => {
    if (hasSent || !allSigsCovered || !txData) return;
    setHasSent(true);
    setTimeout(async () => {
      await withBrc73Coverage(async () => {
        await runSigning('');
      });
    }, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSigsCovered, hasSent, txData]);

  const clearRequest = async () => {
    sendMessage({
      action: 'getSignaturesResponse',
      error: 'User cancelled the request',
    });
    await chromeStorageService.remove('getSignaturesRequest');
    if (popupId) removeWindow(popupId);
    window.location.reload();
  };

  return (
    <>
      <Show when={isProcessing || isLoading}>
        <PageLoader theme={theme} message={isLoading ? 'Loading transaction...' : 'Signing Transaction...'} />
      </Show>
      <Show when={!isProcessing && !!request && !!txData}>
        <Wrapper>
          <HeaderText theme={theme}>Sign Transaction</HeaderText>
          <Text theme={theme} style={{ margin: '0.75rem 0' }}>
            The app is requesting signatures for a transaction.
          </Text>
          <FormContainer noValidate onSubmit={(e) => handleSigning(e)}>
            {txData && <TxPreview txData={txData} inputsToSign={request.sigRequests.map((r) => r.inputIndex)} />}
            <Show when={isPasswordRequired}>
              <Input
                theme={theme}
                placeholder="Enter Wallet Password"
                type="password"
                autoFocus
                onChange={(e) => setPasswordConfirm(e.target.value)}
              />
            </Show>
            <Button
              theme={theme}
              type="primary"
              label={`Sign Tx - ${satsOut > 0 ? satsOut / BSV_DECIMAL_CONVERSION : 0} BSV`}
              isSubmit
              disabled={isProcessing}
            />
            <Button theme={theme} type="secondary" label="Cancel" onClick={clearRequest} disabled={isProcessing} />
          </FormContainer>
        </Wrapper>
      </Show>
    </>
  );
};
