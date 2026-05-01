import React, { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { SignedMessage, SignMessage } from 'yours-wallet-provider';
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
import { WhiteLabelTheme } from '../../theme.types';
import { sleep } from '../../utils/sleep';
import { sendMessage, removeWindow } from '../../utils/chromeHelpers';
import { getErrorMessage } from '../../utils/tools';

const RequestDetailsContainer = styled.div<WhiteLabelTheme>`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-height: 10rem;
  overflow-y: auto;
  overflow-x: hidden;
  background: ${({ theme }) => theme.color.global.row + '80'};
  margin: 0.5rem;
`;

const TagText = styled(Text)`
  margin: 0.25rem;
`;

export type SignMessageRequestProps = {
  request: SignMessage;
  popupId: number | undefined;
  onSignature: () => void;
};

export const SignMessageRequest = (props: SignMessageRequestProps) => {
  const { request, onSignature, popupId } = props;
  const { theme } = useTheme();
  const { handleSelect, hideMenu } = useBottomMenu();
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [signature, setSignature] = useState<string | undefined>(undefined);
  const { addSnackbar, message } = useSnackbar();
  const { chromeStorageService, bsvService, keysService } = useServiceContext();
  const { withBrc73Coverage } = keysService;
  const isPasswordRequired = chromeStorageService.isPasswordRequired();
  const [isProcessing, setIsProcessing] = useState(false);
  const [hasSent, setHasSent] = useState(false);

  // BRC-73: protocol coverage. Yours `request.tag.label` maps to the
  // BRC-43 protocolName slot; default 'identity' when unset (matches
  // the wallet's existing fallback in the JSX below).
  const protocolName = request?.tag?.label ?? 'identity';
  const { loaded: brc73Loaded, check: brc73Check } = useGroupCoverage();
  const coverage = brc73Loaded
    ? brc73Check({ kind: 'protocol', protocolID: [0, protocolName] })
    : null;

  useEffect(() => {
    handleSelect('bsv');
    hideMenu();
  }, [handleSelect, hideMenu]);

  const resetSendState = () => {
    setPasswordConfirm('');
    setIsProcessing(false);
  };

  useEffect(() => {
    if (!signature) return;
    if (!message && signature) {
      resetSendState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, signature]);

  const runSign = async (password: string): Promise<void> => {
    setIsProcessing(true);
    await sleep(25);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signRes = (await bsvService.signMessage(request, password)) as SignedMessage & { error?: string };
    if (!signRes?.sig || signRes.error) {
      addSnackbar(getErrorMessage(signRes.error), 'error');
      setIsProcessing(false);
      return;
    }

    addSnackbar('Successfully Signed!', 'success');
    await sleep(2000);
    setSignature(signRes.sig);
    sendMessage({
      action: 'signMessageResponse',
      ...signRes,
    });
    onSignature();
  };

  const handleSigning = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!passwordConfirm && isPasswordRequired) {
      addSnackbar('You must enter a password!', 'error');
      return;
    }
    await runSign(passwordConfirm);
  };

  // BRC-73 auto-resolve: covered protocol-permission grants fire
  // runSign with empty password under withBrc73Coverage.
  useEffect(() => {
    if (hasSent || !coverage?.covered || !request) return;
    setHasSent(true);
    setTimeout(async () => {
      await withBrc73Coverage(async () => {
        await runSign('');
      });
    }, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverage?.covered, hasSent]);

  const clearRequest = async () => {
    sendMessage({
      action: 'signMessageResponse',
      error: 'User cancelled the request',
    });
    await chromeStorageService.remove('signMessageRequest');
    if (popupId) removeWindow(popupId);
    window.location.reload();
  };

  return (
    <>
      <Show when={isProcessing}>
        <PageLoader theme={theme} message="Signing Transaction..." />
      </Show>
      <Show when={!isProcessing && !!request}>
        <ConfirmContent>
          <HeaderText theme={theme}>Sign Message</HeaderText>
          <Text theme={theme} style={{ margin: '0.75rem 0' }}>
            {'The app is requesting a signature using derivation tag:'}
          </Text>
          <Show
            when={!!request.tag?.label}
            whenFalseContent={
              <>
                <TagText theme={theme}>{`Label: yours`}</TagText>
                <TagText theme={theme}>{`Id: identity`}</TagText>
              </>
            }
          >
            <TagText theme={theme}>{`Label: ${request.tag?.label}`}</TagText>
            <TagText theme={theme}>{`Id: ${request.tag?.id}`}</TagText>
          </Show>
          <FormContainer noValidate onSubmit={(e) => handleSigning(e)}>
            <RequestDetailsContainer theme={theme}>
              {
                <Text
                  theme={theme}
                  style={{
                    color: theme.color.global.contrast,
                  }}
                >{`Message: ${request.message}`}</Text>
              }
            </RequestDetailsContainer>
            <Show when={isPasswordRequired}>
              <Input
                theme={theme}
                placeholder="Enter Wallet Password"
                type="password"
                autoFocus
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
              />
            </Show>
            <Button theme={theme} type="primary" label="Sign Message" disabled={isProcessing} isSubmit />
            <Button theme={theme} type="secondary" label="Cancel" onClick={clearRequest} disabled={isProcessing} />
          </FormContainer>
        </ConfirmContent>
      </Show>
    </>
  );
};
