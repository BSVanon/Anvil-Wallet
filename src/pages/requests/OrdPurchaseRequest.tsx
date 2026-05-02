import validate from 'bitcoin-address-validation';
import { useEffect, useState } from 'react';
import { Ordinal as OrdinalType, PurchaseOrdinal } from 'yours-wallet-provider';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Ordinal } from '../../components/Ordinal';
import { PageLoader } from '../../components/PageLoader';
import { ConfirmContent, FormContainer, HeaderText, Text } from '../../components/Reusable';
import { Show } from '../../components/Show';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useGroupCoverage } from '../../hooks/useGroupCoverage';
import { removeWindow, sendMessage } from '../../utils/chromeHelpers';
import {
  BSV20_INDEX_FEE,
  BSV_DECIMAL_CONVERSION,
  GENERIC_TOKEN_ICON,
  GLOBAL_ORDERBOOK_MARKET_RATE,
  YOURS_DEV_WALLET,
} from '../../utils/constants';
import { sleep } from '../../utils/sleep';
import { resolveIconUrl } from '../../utils/tokenIcon';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { styled } from 'styled-components';
import { Token } from '../../services/types/gorillaPool.types';
import { getErrorMessage } from '../../utils/tools';

const TokenIcon = styled.img`
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 50%;
`;

export type OrdPurchaseRequestProps = {
  request: PurchaseOrdinal & { password?: string };
  popupId: number | undefined;
  onResponse: () => void;
};

export const OrdPurchaseRequest = (props: OrdPurchaseRequestProps) => {
  const { request, popupId, onResponse } = props;
  const { theme } = useTheme();
  const { hideMenu } = useBottomMenu();
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const { addSnackbar } = useSnackbar();
  const { gorillaPoolService, ordinalService, chromeStorageService, keysService } = useServiceContext();
  const { withBrc73Coverage } = keysService;
  const [inscription, setInscription] = useState<OrdinalType | undefined>();
  const [isProcessing, setIsProcessing] = useState(false);
  const [hasSent, setHasSent] = useState(false);
  const [tokenDetails, setTokenDetails] = useState<Partial<Token>>();
  const [isLoaded, setIsLoaded] = useState(false);
  const marketplaceAddress = request.marketplaceAddress ?? YOURS_DEV_WALLET;
  const marketplaceRate = request.marketplaceRate ?? GLOBAL_ORDERBOOK_MARKET_RATE;
  const outpoint = request.outpoint;
  const isPasswordRequired = chromeStorageService.isPasswordRequired();
  const network = chromeStorageService.getNetwork();

  // BRC-73: spending coverage check sized to the full settlement
  // amount (price + marketplace fee + BSV20 index fee where
  // applicable). Computed from inscription.data.list.price which
  // populates after the async getOrigin() effect; the auto-resolve
  // effect below waits for both `coverage?.covered` AND `isLoaded`.
  const purchaseSats = inscription?.data?.list?.price
    ? Math.ceil(
        Number(inscription.data.list.price) * (1 + marketplaceRate) +
          (tokenDetails ? BSV20_INDEX_FEE : 0),
      )
    : 0;
  const { loaded: brc73Loaded, check: brc73Check, recordCoveredSpend } = useGroupCoverage();
  const coverage =
    brc73Loaded && purchaseSats > 0 ? brc73Check({ kind: 'spending', sats: purchaseSats }) : null;

  useEffect(() => {
    hideMenu();
    if (!request.outpoint) return;
    const getOrigin = async () => {
      setIsProcessing(true);
      const res = await gorillaPoolService.getUtxoByOutpoint(request.outpoint);
      setInscription(res);
      if (res?.data?.bsv20) {
        const tokenDetails = await gorillaPoolService.getBsv20Details(
          res?.data.bsv20?.id || res.data.bsv20?.tick || '',
        );
        setTokenDetails(tokenDetails);
      }
      setIsProcessing(false);
      setIsLoaded(true);
    };

    getOrigin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.outpoint]);

  const runPurchase = async (password: string): Promise<void> => {
    if (!inscription) {
      addSnackbar('Could not locate the ordinal!', 'error');
      return;
    }
    setIsProcessing(true);

    await sleep(25);
    if (!validate(marketplaceAddress)) {
      addSnackbar('Invalid address detected!', 'info');
      setIsProcessing(false);
      return;
    }

    const purchaseListing: PurchaseOrdinal & { password: string } = {
      marketplaceAddress,
      marketplaceRate,
      outpoint,
      password,
    };
    const purchaseRes = await ordinalService.purchaseGlobalOrderbookListing(
      purchaseListing,
      inscription,
      tokenDetails as Token | undefined,
    );

    if (!purchaseRes.txid || purchaseRes.error) {
      addSnackbar(getErrorMessage(purchaseRes.error), 'error');
      setIsProcessing(false);
      return;
    }

    addSnackbar('Purchase Successful!', 'success');

    if (coverage?.covered) {
      await recordCoveredSpend(purchaseSats);
    }

    await sleep(2000);
    sendMessage({
      action: 'purchaseOrdinalResponse',
      txid: purchaseRes.txid,
    });
    onResponse();
  };

  const handlePurchaseOrdinal = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!passwordConfirm && isPasswordRequired) {
      addSnackbar('You must enter a password!', 'error');
      return;
    }
    await runPurchase(passwordConfirm);
  };

  // BRC-73 auto-resolve: when the requesting app's manifest covers the
  // purchase amount, fire `runPurchase` with empty password under
  // withBrc73Coverage so keysService.retrieveKeys bypasses the
  // password gate. Waits for inscription load (so price is known) +
  // !hasSent guard.
  useEffect(() => {
    if (hasSent || !coverage?.covered || !inscription) return;
    setHasSent(true);
    setTimeout(async () => {
      await withBrc73Coverage(async () => {
        await runPurchase('');
      });
    }, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverage?.covered, hasSent, inscription]);

  const clearRequest = async () => {
    sendMessage({
      action: 'purchaseOrdinalResponse',
      error: 'User cancelled the request',
    });
    await chromeStorageService.remove('purchaseOrdinalRequest');
    if (popupId) removeWindow(popupId);
    window.location.reload();
  };

  return (
    <>
      <Show when={isProcessing}>
        <PageLoader theme={theme} message={isLoaded ? 'Purchasing Ordinal...' : 'Processing...'} />
      </Show>

      <Show when={!isProcessing && !!request && !!inscription}>
        <ConfirmContent>
          <Show
            when={!tokenDetails}
            whenFalseContent={
              <TokenIcon
                src={
                  // resolveIconUrl handles full URLs vs content-id
                  // outpoints. See commit 2a2fc06 for the H17 bug.
                  resolveIconUrl(
                    tokenDetails?.icon ?? null,
                    gorillaPoolService.getBaseUrl(chromeStorageService.getNetwork()),
                  ) ?? GENERIC_TOKEN_ICON
                }
              />
            }
          >
            <Ordinal
              inscription={inscription as OrdinalType}
              theme={theme}
              url={`${gorillaPoolService.getBaseUrl(network)}/content/${inscription?.origin?.outpoint}`}
              selected={true}
            />
          </Show>
          <HeaderText theme={theme}>Purchase Request</HeaderText>
          <Show when={!!tokenDetails}>
            <Text theme={theme} style={{ color: theme.color.global.gray }}>
              {tokenDetails?.sym || tokenDetails?.tick || inscription?.origin?.data?.map?.name || 'Unknown Token'}
            </Text>
          </Show>
          <FormContainer noValidate onSubmit={(e) => handlePurchaseOrdinal(e)}>
            <Show when={isPasswordRequired}>
              <Input
                theme={theme}
                placeholder="Password"
                type="password"
                autoFocus
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
              />
            </Show>
            <Text theme={theme} style={{ margin: '1rem 0 1rem' }}>
              Double check details before sending.
            </Text>
            <Button
              theme={theme}
              type="primary"
              label={`Pay ${(
                (Number(inscription?.data?.list?.price) * (1 + marketplaceRate) +
                  (tokenDetails ? BSV20_INDEX_FEE : 0)) /
                BSV_DECIMAL_CONVERSION
              ).toFixed(8)} BSV`}
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
