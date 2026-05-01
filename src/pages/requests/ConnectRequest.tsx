import { useContext, useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { Button } from '../../components/Button';
import { HeaderText, Text } from '../../components/Reusable';
import { Show } from '../../components/Show';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import greenCheck from '../../assets/green-check.svg';
import { WhiteLabelTheme } from '../../theme.types';
import { RequestParams, WhitelistedApp } from '../../inject';
import { sendMessage } from '../../utils/chromeHelpers';
import { useServiceContext } from '../../hooks/useServiceContext';
import { ChromeStorageObject } from '../../services/types/chromeStorage.types';
import { sleep } from '../../utils/sleep';
import { fetchManifest, isValidGroupPermissions } from '../../services/manifest/fetchManifest';
import { initBudgetUsage } from '../../services/manifest/budgetTracker';
import type { GroupPermissions, GrantedManifest, ManifestSource } from '../../services/types/brc73.types';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
`;

const Icon = styled.img<{ size: string }>`
  width: ${(props) => props.size};
  height: ${(props) => props.size};
  margin: 0 0 1rem 0;
  border-radius: 0.5rem;
`;

const PermissionsContainer = styled.div<WhiteLabelTheme>`
  display: flex;
  flex-direction: column;
  padding: 1rem;
  width: 75%;
  background-color: ${({ theme }) => theme.color.global.row};
  border-radius: 0.75rem;
  margin: 1rem 0 1.5rem 0;
`;

const Permission = styled.div`
  display: flex;
  align-items: center;
  margin: 0.5rem;
`;

const CheckMark = styled.img`
  width: 1rem;
  height: 1rem;
`;

const GroupPermissionsContainer = styled(PermissionsContainer)`
  border-left: 4px solid ${({ theme }) => theme.color.component.primaryButtonRightGradient};
  margin-top: 0.5rem;
`;

const GroupPermissionDetail = styled.div`
  margin: 0.25rem 0 0.25rem 2.25rem;
  font-size: 0.75rem;
  opacity: 0.7;
  text-align: left;
`;

const TogglePermission = styled.div<{ $checked: boolean }>`
  display: flex;
  align-items: flex-start;
  margin: 0.5rem 0.25rem;
  cursor: pointer;
  opacity: ${({ $checked }) => ($checked ? 1 : 0.4)};
  transition: opacity 0.15s ease;
  &:hover {
    opacity: ${({ $checked }) => ($checked ? 1 : 0.6)};
  }
`;

const ToggleBox = styled.div<{ $checked: boolean }>`
  flex-shrink: 0;
  width: 1.1rem;
  height: 1.1rem;
  margin-right: 0.75rem;
  margin-top: 0.1rem;
  border-radius: 0.25rem;
  border: 1.5px solid
    ${({ theme, $checked }) =>
      $checked ? theme.color.component.primaryButtonRightGradient : theme.color.global.gray};
  background-color: ${({ theme, $checked }) =>
    $checked ? theme.color.component.primaryButtonRightGradient : 'transparent'};
  display: flex;
  align-items: center;
  justify-content: center;
  &::after {
    content: ${({ $checked }) => ($checked ? "'✓'" : "''")};
    color: #000;
    font-size: 0.85rem;
    font-weight: 700;
    line-height: 1;
  }
`;

export type ConnectRequestProps = {
  request: RequestParams | undefined;
  whiteListedApps: WhitelistedApp[];
  popupId: number | undefined;
  onDecision: () => void;
};

export const ConnectRequest = (props: ConnectRequestProps) => {
  const { request, whiteListedApps, onDecision } = props;
  const { theme } = useTheme();
  const context = useContext(BottomMenuContext);
  const { addSnackbar } = useSnackbar();
  const { keysService, chromeStorageService } = useServiceContext();
  const { identityPubKey, bsvPubKey, ordPubKey, identityAddress } = keysService;

  // BRC-73 manifest resolution: tri-state machine.
  //   { phase: 'loading' }                            — fetch in flight, Accept disabled
  //   { phase: 'ready', manifest: null }              — no manifest published; legacy connect
  //   { phase: 'ready', manifest: GP, source: ... }   — manifest available; granted on Accept
  //
  // Closes Codex MEDIUM b0016188b44a3694: prior implementation let the
  // user click Accept while fetch was still in flight, whitelisting
  // the app *without* persisting the granted manifest. Now Accept is
  // disabled until phase === 'ready'.
  type ManifestState =
    | { phase: 'loading' }
    | { phase: 'ready'; manifest: GroupPermissions | null; source: ManifestSource | null };
  const [manifestState, setManifestState] = useState<ManifestState>({ phase: 'loading' });

  useEffect(() => {
    if (!context) return;
    context.hideMenu();

    return () => context.showMenu();
  }, [context]);

  useEffect(() => {
    let cancelled = false;
    if (!request?.domain) {
      // No origin attached (shouldn't happen for app-driven connects,
      // but defensively skip the manifest path entirely).
      setManifestState({ phase: 'ready', manifest: null, source: null });
      return;
    }
    setManifestState({ phase: 'loading' });

    // BRC-73 'both paths' decision (2026-05-01): canonical fetch from
    // `https://{domain}/manifest.json` is preferred; app-passed
    // manifest is the documented fallback for dev/m2m. Validate the
    // app-passed shape so a malicious app can't smuggle arbitrary
    // permission claims into the wallet.
    const appPassedRaw = request.manifest;
    const appPassed = isValidGroupPermissions(appPassedRaw) ? (appPassedRaw as GroupPermissions) : null;

    fetchManifest(request.domain).then((fetched) => {
      if (cancelled) return;
      if (fetched) {
        setManifestState({ phase: 'ready', manifest: fetched, source: 'fetched' });
      } else if (appPassed) {
        setManifestState({ phase: 'ready', manifest: appPassed, source: 'app-passed' });
      } else {
        setManifestState({ phase: 'ready', manifest: null, source: null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [request?.domain, request?.manifest]);

  // Convenience accessor for the JSX below.
  const manifest = manifestState.phase === 'ready' ? manifestState.manifest : null;
  const isManifestLoading = manifestState.phase === 'loading';

  // Per-permission opt-in toggles. User starts with everything checked
  // (matches the "what the app asked for") and can uncheck individual
  // entries before clicking Connect. Filtered manifest is what
  // actually gets persisted as the GrantedManifest.
  const [spendingChecked, setSpendingChecked] = useState(true);
  const [protocolChecks, setProtocolChecks] = useState<boolean[]>([]);
  const [basketChecks, setBasketChecks] = useState<boolean[]>([]);
  const [certChecks, setCertChecks] = useState<boolean[]>([]);

  useEffect(() => {
    if (!manifest) return;
    setSpendingChecked(!!manifest.spendingAuthorization);
    setProtocolChecks((manifest.protocolPermissions ?? []).map(() => true));
    setBasketChecks((manifest.basketAccess ?? []).map(() => true));
    setCertChecks((manifest.certificateAccess ?? []).map(() => true));
  }, [manifest]);

  const toggleAt = (
    setter: React.Dispatch<React.SetStateAction<boolean[]>>,
    index: number,
  ) => {
    setter((prev) => prev.map((v, i) => (i === index ? !v : v)));
  };

  // Build the filtered GroupPermissions from the user's checkbox state.
  // If everything is unchecked we return null so handleAccept stores no
  // groupPermissions at all (legacy connect path).
  const buildFilteredManifest = (): GroupPermissions | null => {
    if (!manifest) return null;
    const filtered: GroupPermissions = {};
    if (manifest.description) filtered.description = manifest.description;
    if (spendingChecked && manifest.spendingAuthorization) {
      filtered.spendingAuthorization = manifest.spendingAuthorization;
    }
    const protos = (manifest.protocolPermissions ?? []).filter((_, i) => protocolChecks[i]);
    if (protos.length > 0) filtered.protocolPermissions = protos;
    const baskets = (manifest.basketAccess ?? []).filter((_, i) => basketChecks[i]);
    if (baskets.length > 0) filtered.basketAccess = baskets;
    const certs = (manifest.certificateAccess ?? []).filter((_, i) => certChecks[i]);
    if (certs.length > 0) filtered.certificateAccess = certs;
    const hasAny =
      filtered.spendingAuthorization ||
      (filtered.protocolPermissions ?? []).length > 0 ||
      (filtered.basketAccess ?? []).length > 0 ||
      (filtered.certificateAccess ?? []).length > 0;
    return hasAny ? filtered : null;
  };

  useEffect(() => {
    if (!request?.isAuthorized) return;
    if (!identityPubKey || !bsvPubKey || !ordPubKey) return;
    if (!window.location.href.includes('localhost')) {
      onDecision();
      sendMessage({
        action: 'userConnectResponse',
        decision: 'approved',
        pubKeys: { identityPubKey, bsvPubKey, ordPubKey },
      });
    }
  }, [request, identityPubKey, bsvPubKey, ordPubKey, onDecision]);

  const handleAccept = async () => {
    const { account } = chromeStorageService.getCurrentAccountObject();
    if (!account) throw Error('No account found');
    const { settings } = account;
    const key: keyof ChromeStorageObject = 'accounts';

    // BRC-73: persist a FILTERED manifest reflecting only what the user
    // left checked. Subsequent request handlers short-circuit their
    // per-tx prompts only for operations the user explicitly accepted.
    // Defensive guard against handleAccept being called mid-fetch
    // (shouldn't happen — Accept button is disabled — but
    // belt-and-braces).
    if (manifestState.phase !== 'ready') return;
    const filtered = buildFilteredManifest();
    const groupPermissions: GrantedManifest | undefined =
      filtered && manifestState.source
        ? {
            permissions: filtered,
            grantedAt: Date.now(),
            source: manifestState.source,
            budgetUsage: initBudgetUsage(),
          }
        : undefined;

    const newWhitelistEntry: WhitelistedApp = {
      domain: request?.domain ?? '',
      icon: request?.appIcon ?? '',
      ...(groupPermissions ? { groupPermissions } : {}),
    };

    const update: Partial<ChromeStorageObject['accounts']> = {
      [identityAddress]: {
        ...account,
        settings: {
          ...settings,
          whitelist: [...whiteListedApps, newWhitelistEntry],
        },
      },
    };
    await chromeStorageService.updateNested(key, update);
    addSnackbar(`Approved`, 'success');
    await sleep(2000);
    onDecision();
    sendMessage({
      action: 'userConnectResponse',
      decision: 'approved',
      pubKeys: { bsvPubKey, ordPubKey, identityPubKey },
    });
  };

  const handleDecline = async () => {
    onDecision();
    sendMessage({
      action: 'userConnectResponse',
      decision: 'declined',
    });
    addSnackbar(`Declined`, 'error');
  };

  return (
    <Show
      when={!request?.isAuthorized}
      whenFalseContent={
        <Container>
          <Text theme={theme} style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            Reconnecting to {request?.appName} ...
          </Text>
        </Container>
      }
    >
      <Container>
        <Icon size="5rem" src={request?.appIcon} />
        <HeaderText theme={theme} style={{ width: '90%' }}>
          {request?.appName}
        </HeaderText>
        <Text theme={theme} style={{ marginBottom: '1rem' }}>
          {request?.domain}
        </Text>
        <PermissionsContainer theme={theme}>
          <Permission>
            <CheckMark style={{ marginRight: '1rem' }} src={greenCheck} />
            <Text
              theme={theme}
              style={{
                color: theme.color.global.contrast,
                margin: 0,
                textAlign: 'left',
              }}
            >
              View your wallet public keys
            </Text>
          </Permission>
          <Permission>
            <CheckMark style={{ marginRight: '1rem' }} src={greenCheck} />
            <Text
              theme={theme}
              style={{
                color: theme.color.global.contrast,
                margin: 0,
                textAlign: 'left',
              }}
            >
              Request approval for transactions
            </Text>
          </Permission>
        </PermissionsContainer>
        <Show when={!!manifest}>
          <GroupPermissionsContainer theme={theme}>
            <Text
              theme={theme}
              style={{
                color: theme.color.global.contrast,
                margin: '0 0 0.25rem 0',
                textAlign: 'left',
                fontWeight: 700,
              }}
            >
              Skip the approval prompt for these
            </Text>
            <Text
              theme={theme}
              style={{
                color: theme.color.global.contrast,
                margin: '0 0 0.75rem 0',
                textAlign: 'left',
                fontSize: '0.75rem',
                opacity: 0.7,
              }}
            >
              Tap any item to opt out. You can revoke these later in Settings → Connected Apps.
            </Text>
            <Show when={!!manifest?.description}>
              <Text
                theme={theme}
                style={{
                  color: theme.color.global.contrast,
                  margin: '0 0 0.5rem 0',
                  textAlign: 'left',
                  fontSize: '0.8rem',
                  opacity: 0.85,
                }}
              >
                {manifest?.description}
              </Text>
            </Show>
            <Show when={!!manifest?.spendingAuthorization}>
              <TogglePermission
                $checked={spendingChecked}
                onClick={() => setSpendingChecked((v) => !v)}
              >
                <ToggleBox theme={theme} $checked={spendingChecked} />
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <Text
                    theme={theme}
                    style={{ color: theme.color.global.contrast, margin: 0, fontSize: '0.85rem' }}
                  >
                    Spend up to {(manifest?.spendingAuthorization?.amount ?? 0).toLocaleString()} sats per 30 days
                  </Text>
                  <Show when={!!manifest?.spendingAuthorization?.description}>
                    <Text
                      theme={theme}
                      style={{
                        color: theme.color.global.contrast,
                        margin: '0.2rem 0 0 0',
                        fontSize: '0.7rem',
                        opacity: 0.7,
                      }}
                    >
                      {manifest?.spendingAuthorization?.description}
                    </Text>
                  </Show>
                </div>
              </TogglePermission>
            </Show>
            {(manifest?.protocolPermissions ?? []).map((p, i) => (
              <TogglePermission
                key={`proto-${i}`}
                $checked={!!protocolChecks[i]}
                onClick={() => toggleAt(setProtocolChecks, i)}
              >
                <ToggleBox theme={theme} $checked={!!protocolChecks[i]} />
                <Text
                  theme={theme}
                  style={{
                    color: theme.color.global.contrast,
                    margin: 0,
                    flex: 1,
                    textAlign: 'left',
                    fontSize: '0.85rem',
                  }}
                >
                  {p.description}
                </Text>
              </TogglePermission>
            ))}
            {(manifest?.basketAccess ?? []).map((b, i) => (
              <TogglePermission
                key={`basket-${i}`}
                $checked={!!basketChecks[i]}
                onClick={() => toggleAt(setBasketChecks, i)}
              >
                <ToggleBox theme={theme} $checked={!!basketChecks[i]} />
                <Text
                  theme={theme}
                  style={{
                    color: theme.color.global.contrast,
                    margin: 0,
                    flex: 1,
                    textAlign: 'left',
                    fontSize: '0.85rem',
                  }}
                >
                  {b.description}
                </Text>
              </TogglePermission>
            ))}
            {(manifest?.certificateAccess ?? []).map((c, i) => (
              <TogglePermission
                key={`cert-${i}`}
                $checked={!!certChecks[i]}
                onClick={() => toggleAt(setCertChecks, i)}
              >
                <ToggleBox theme={theme} $checked={!!certChecks[i]} />
                <Text
                  theme={theme}
                  style={{
                    color: theme.color.global.contrast,
                    margin: 0,
                    flex: 1,
                    textAlign: 'left',
                    fontSize: '0.85rem',
                  }}
                >
                  {c.description}
                </Text>
              </TogglePermission>
            ))}
          </GroupPermissionsContainer>
        </Show>
        <Show when={isManifestLoading}>
          <Text
            theme={theme}
            style={{
              color: theme.color.global.contrast,
              margin: '0.5rem 0',
              fontSize: '0.85rem',
              opacity: 0.7,
            }}
          >
            Checking for group permissions…
          </Text>
        </Show>
        <Button
          theme={theme}
          type="primary"
          label={isManifestLoading ? 'Checking…' : 'Connect'}
          disabled={isManifestLoading}
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            handleAccept();
          }}
        />
        <Button
          theme={theme}
          type="secondary-outline"
          label="Cancel"
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            handleDecline();
          }}
        />
      </Container>
    </Show>
  );
};
