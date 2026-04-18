/**
 * MNEE-send-with-data confirmation popup.
 *
 * Extension to the standard `sendMNEE` flow: a connected dApp requests the
 * wallet to build a user-half-signed MNEE transfer with an `extraData`
 * OP_RETURN, and optionally NOT broadcast it. Primary use case: AVOS swap
 * where the oracle — not the wallet — submits the MNEE tx.
 *
 * This popup is visually distinct from the normal MNEE send so the user can
 * see "will broadcast" vs "will NOT broadcast (handed to dApp)" before
 * approving. Labels are intentionally loud.
 */

import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { validate } from 'bitcoin-address-validation';
import { Transaction } from '@bsv/sdk';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { PageLoader } from '../../components/PageLoader';
import { ConfirmContent, FormContainer, HeaderText, Text } from '../../components/Reusable';
import { Show } from '../../components/Show';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { formatNumberWithCommasAndDecimals, truncate } from '../../utils/format';
import { sleep } from '../../utils/sleep';
import { sendMessage, removeWindow } from '../../utils/chromeHelpers';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getErrorMessage } from '../../utils/tools';
import { MNEE_DECIMALS, MNEE_ICON_URL } from '../../utils/constants';
import type { SendMNEEWithData } from '../../services/types/mnee.types';

const Icon = styled.img`
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 50%;
`;

const Badge = styled.span<{ $warn?: boolean }>`
  display: inline-block;
  padding: 0.2rem 0.5rem;
  border-radius: 0.3rem;
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  background: ${(p) => (p.$warn ? '#ffb84d' : '#7cd97c')};
  color: #111;
`;

export type MNEESendWithDataRequestProps = {
  request: SendMNEEWithData;
  popupId: number | undefined;
  onResponse: () => void;
};

export const MNEESendWithDataRequest = (props: MNEESendWithDataRequestProps) => {
  const { request, popupId, onResponse } = props;
  const { theme } = useTheme();
  const { handleSelect, hideMenu } = useBottomMenu();
  const { addSnackbar } = useSnackbar();
  const { mneeService, keysService, chromeStorageService } = useServiceContext();
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    handleSelect('bsv');
    hideMenu();
  }, [handleSelect, hideMenu]);

  const clearRequest = async () => {
    sendMessage({
      action: 'sendMNEEWithDataResponse',
      error: 'User cancelled the request',
    });
    await chromeStorageService.remove('sendMNEEWithDataRequest');
    if (popupId) removeWindow(popupId);
    window.location.reload();
  };

  const processSend = async (password: string) => {
    try {
      // Basic validation
      for (const r of request.recipients) {
        if (!r.address || !validate(r.address)) {
          addSnackbar('Recipient address invalid', 'error');
          setIsProcessing(false);
          return;
        }
        if (!r.amount || r.amount <= 0) {
          addSnackbar('Amount must be > 0', 'error');
          setIsProcessing(false);
          return;
        }
      }
      if (!/^[0-9a-f]+$/i.test(request.extraDataHex) || request.extraDataHex.length % 2 !== 0) {
        addSnackbar('extraDataHex must be even-length hex', 'error');
        setIsProcessing(false);
        return;
      }

      const keys = await keysService.retrieveKeys(password);
      if (!keys?.walletWif) {
        addSnackbar('Invalid password!', 'error');
        setIsProcessing(false);
        return;
      }

      const response = await mneeService.transfer(request.recipients, keys.walletWif, {
        broadcast: request.broadcast,
        extraData: [{ type: 'hex', data: request.extraDataHex }],
      });

      let localTxid: string | undefined;
      if (response.rawtx) {
        try {
          localTxid = Transaction.fromHex(response.rawtx).id('hex') as string;
        } catch {
          /* leave undefined */
        }
      }

      addSnackbar(
        request.broadcast ? 'MNEE broadcast initiated' : 'MNEE draft built (not broadcast)',
        'success',
      );
      onResponse();
      sendMessage({
        action: 'sendMNEEWithDataResponse',
        rawtx: response.rawtx,
        ticketId: response.ticketId,
        localTxid,
      });
    } catch (error) {
      console.error('[sendMNEEWithData] error:', error);
      const msg = error instanceof Error ? error.message : String(error);
      addSnackbar(getErrorMessage(msg) || 'MNEE transfer failed', 'error');
      sendMessage({
        action: 'sendMNEEWithDataResponse',
        error: msg,
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsProcessing(true);
    await sleep(25);
    if (!passwordConfirm) {
      addSnackbar('You must enter a password!', 'error');
      setIsProcessing(false);
      return;
    }
    processSend(passwordConfirm);
  };

  const totalAmount = request.recipients.reduce((acc, r) => acc + r.amount, 0);

  return (
    <>
      <Show when={isProcessing}>
        <PageLoader theme={theme} message={request.broadcast ? 'Sending MNEE…' : 'Building MNEE draft…'} />
      </Show>
      <Show when={!isProcessing && !!request}>
        <ConfirmContent>
          <Icon src={MNEE_ICON_URL} />
          <HeaderText theme={theme}>Approve MNEE Request</HeaderText>
          <div style={{ margin: '0.5rem 0' }}>
            {request.broadcast ? (
              <Badge>WILL BROADCAST</Badge>
            ) : (
              <Badge $warn>WILL NOT BROADCAST — dApp will submit</Badge>
            )}
          </div>
          <Text theme={theme} style={{ margin: '0.5rem 0', color: theme.color.global.gray }}>
            {request.recipients.length === 1
              ? `Send to: ${truncate(request.recipients[0].address, 5, 5)}`
              : `Send to ${request.recipients.length} recipients.`}
          </Text>
          <Text theme={theme} style={{ fontSize: '0.7rem', color: theme.color.global.gray }}>
            extraData: {truncate(request.extraDataHex, 8, 6)} ({request.extraDataHex.length / 2} bytes)
          </Text>
          <FormContainer noValidate onSubmit={handleSubmit}>
            <Input
              theme={theme}
              placeholder="Enter Wallet Password"
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
            />
            <Text theme={theme} style={{ margin: '1rem' }}>
              Double check before approving.
            </Text>
            <Button
              theme={theme}
              type="primary"
              label={`Approve ${formatNumberWithCommasAndDecimals(totalAmount, MNEE_DECIMALS)} MNEE`}
              disabled={isProcessing}
              isSubmit
            />
            <Button theme={theme} type="secondary" label="Cancel" onClick={clearRequest} disabled={isProcessing} />
          </FormContainer>
        </ConfirmContent>
      </Show>
    </>
  );
};
