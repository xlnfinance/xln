<!--
  EntityPanelTabs.svelte - Rabby-style tabbed Entity interface

  Single scroll container, no nested scrollbars.
  Clean fintech design with proper form inputs.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { onDestroy, onMount } from 'svelte';
  import type { ComponentType } from 'svelte';
  import { get } from 'svelte/store';
  import { Wallet as EthersWallet, hexlify, isAddress, ZeroAddress, zeroPadValue } from 'ethers';
  import type {
    AccountMachine,
    Env,
    EnvSnapshot,
    JAdapter,
    JBatch,
    Profile as GossipProfile,
    RoutedEntityInput,
    EntityTx,
  } from '@xln/runtime/xln-api';
  import type { Tab, EntityReplica } from '$lib/types/ui';
  import { getXLN, history, resolveConfiguredApiBase, xlnEnvironment } from '../../stores/xlnStore';
  import { visibleReplicas, currentTimeIndex, isLive, timeOperations } from '../../stores/timeStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import { getAvailableThemes, THEME_DEFINITIONS } from '../../utils/themes';
  import { amountToUsd, getAssetUsdPrice } from '$lib/utils/assetPricing';
  import type { ThemeName } from '$lib/types/ui';
  import { activeVault, vaultOperations } from '$lib/stores/vaultStore';
  import { xlnFunctions, entityPositions, enqueueEntityInputs, p2pState } from '../../stores/xlnStore';
  import { toasts } from '../../stores/toastStore';
  import { getOpenAccountRebalancePolicyData } from '$lib/utils/onboardingPreferences';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import { resolveEntityName } from '$lib/utils/entityNaming';

  // Icons
  import {
    ArrowUpRight, ArrowDownLeft, Repeat, Landmark, Users, Activity,
    MessageCircle, Settings as SettingsIcon, BookUser,
    ChevronDown, Wallet, AlertTriangle, PlusCircle, Copy, Check, Scale, Globe, Trash2, MoreHorizontal, SlidersHorizontal
  } from 'lucide-svelte';

  // Child components
  import EntityDropdown from './EntityDropdown.svelte';
  import AccountDropdown from './AccountDropdown.svelte';
  import AccountPanel from './AccountPanel.svelte';
  import AccountList from './AccountList.svelte';
  import PaymentPanel from './PaymentPanel.svelte';
  import ReceivePanel from './ReceivePanel.svelte';
  import SwapPanel from './SwapPanel.svelte';
  import SettlementPanel from './SettlementPanel.svelte';
  import CreditForm from './CreditForm.svelte';
  import CollateralForm from './CollateralForm.svelte';
  import ChatMessages from './ChatMessages.svelte';
  import ConsensusState from './ConsensusState.svelte';
  import ProposalsList from './ProposalsList.svelte';
  import JurisdictionDropdown from '$lib/components/Jurisdiction/JurisdictionDropdown.svelte';
  import FormationPanel from './FormationPanel.svelte';
  import HubDiscoveryPanel from './HubDiscoveryPanel.svelte';
  import GossipPanel from './GossipPanel.svelte';
  import EntityInput from '../shared/EntityInput.svelte';
  import WalletSettings from '$lib/components/Settings/WalletSettings.svelte';
  import RuntimeDropdown from '$lib/components/Runtime/RuntimeDropdown.svelte';
  import ContextSwitcher from './ContextSwitcher.svelte';

  export let tab: Tab;
  export let isLast: boolean = false;
  export let hideHeader: boolean = false;
  export let showJurisdiction: boolean = true;
  export let userModeHeader: boolean = false;
  export let selectedJurisdiction: string | null = null;
  export let jurisdictionFilter: string | null = null;
  export let allowHeaderAddEntity: boolean = false;
  export let allowHeaderAddJurisdiction: boolean = false;
  export let allowHeaderAddRuntime: boolean = false;
  export let allowHeaderDeleteRuntime: boolean = false;
  export let headerRuntimeAddLabel: string = '+ Add Runtime';
  export let initialAction: 'r2r' | 'r2c' | undefined = undefined;
  export let replicasOverride: Map<string, EntityReplica> | null = null;
  export let envOverride: Env | EnvSnapshot | null = null;
  export let historyOverride: EnvSnapshot[] | null = null;
  export let timeIndexOverride: number | null = null;
  export let isLiveOverride: boolean | null = null;

  const dispatch = createEventDispatcher();

  // Tab types
  type ViewTab = 'assets' | 'accounts' | 'more' | 'settings';
  type MoreTab = 'consensus' | 'chat' | 'contacts' | 'create' | 'gossip' | 'governance';
  type AccountWorkspaceTab = 'send' | 'receive' | 'swap' | 'open' | 'activity' | 'settle' | 'configure' | 'appearance';
  type AssetWorkspaceTab = 'faucet' | 'e2r' | 'r2c' | 'c2r' | 'r2e' | 'send' | 'allow';
  type ConfigureWorkspaceTab = 'extend-credit' | 'request-credit' | 'collateral' | 'token';

  // Set initial tab based on action
  function getInitialTab(): ViewTab {
    return 'accounts';
  }
  function getInitialAccountWorkspaceTab(): AccountWorkspaceTab {
    if (initialAction === 'r2r') return 'send';
    if (initialAction === 'r2c') return 'settle';
    return 'open';
  }
  let activeTab: ViewTab = getInitialTab();
  let moreTab: MoreTab = 'consensus';
  let accountWorkspaceTab: AccountWorkspaceTab = getInitialAccountWorkspaceTab();
  let assetWorkspaceTab: AssetWorkspaceTab = 'faucet';
  let configureWorkspaceTab: ConfigureWorkspaceTab = 'extend-credit';
  let workspaceAccountId = '';
  let configureTokenId = 1;

  // State
  let replica: EntityReplica | null = null;
  let selectedAccountId: string | null = null;
  let selectedJurisdictionName: string | null = null;
  let addressCopied = false;
  let openAccountEntityId = '';

  $: if (userModeHeader) {
    selectedJurisdictionName = selectedJurisdiction;
  }

  function resolveApiBase(): string {
    if (typeof window === 'undefined') return 'https://xln.finance';
    return resolveConfiguredApiBase(window.location.origin);
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function getUrlHashRoute(): string | null {
    if (typeof window === 'undefined') return null;
    const hashRaw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (!hashRaw) return null;
    const queryIndex = hashRaw.indexOf('?');
    const routePart = queryIndex >= 0 ? hashRaw.slice(0, queryIndex) : hashRaw;
    if (!routePart || routePart.includes('=')) return null;
    return routePart.trim().toLowerCase() || null;
  }

  function getUrlHashParams(): URLSearchParams | null {
    if (typeof window === 'undefined') return null;
    const hashRaw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (!hashRaw) return null;
    const queryIndex = hashRaw.indexOf('?');
    if (queryIndex >= 0) {
      const routePart = hashRaw.slice(0, queryIndex);
      if (!routePart.includes('=')) {
        return new URLSearchParams(hashRaw.slice(queryIndex + 1));
      }
    }
    return hashRaw.includes('=') ? new URLSearchParams(hashRaw) : null;
  }

  function getUrlParamValue(keys: string[]): string | null {
    if (typeof window === 'undefined') return null;
    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = getUrlHashParams();
    for (const key of keys) {
      const hashValue = hashParams?.get(key);
      if (typeof hashValue === 'string' && hashValue.length > 0) return hashValue;
      const queryValue = searchParams.get(key);
      if (typeof queryValue === 'string' && queryValue.length > 0) return queryValue;
    }
    return null;
  }

  function applyDeepLinkViewFromUrl(): void {
    if (typeof window === 'undefined') return;

    const view = String(getUrlParamValue(['view']) || getUrlHashRoute() || '').trim().toLowerCase();
    const subview = String(getUrlParamValue(['subview', 'sub']) || '').trim().toLowerCase();
    const jurisdiction = String(getUrlParamValue(['jId', 'jurisdiction', 'j']) || '').trim();

    switch (view) {
      case 'assets':
      case 'external':
      case 'reserves':
      case 'accounts':
      case 'more':
      case 'settings':
        activeTab = (view === 'external' || view === 'reserves') ? 'assets' : view;
        break;
      case 'pay':
      case 'send':
        activeTab = 'accounts';
        accountWorkspaceTab = 'send';
        break;
      case 'receive':
        activeTab = 'accounts';
        accountWorkspaceTab = 'receive';
        break;
      case 'swap':
        activeTab = 'accounts';
        accountWorkspaceTab = 'swap';
        break;
      case 'open':
        activeTab = 'accounts';
        accountWorkspaceTab = 'open';
        break;
      case 'activity':
        activeTab = 'accounts';
        accountWorkspaceTab = 'activity';
        break;
      case 'settle':
        activeTab = 'accounts';
        accountWorkspaceTab = 'settle';
        break;
      case 'configure':
        activeTab = 'accounts';
        accountWorkspaceTab = 'configure';
        break;
      case 'appearance':
        activeTab = 'accounts';
        accountWorkspaceTab = 'appearance';
        break;
      case 'consensus':
      case 'chat':
      case 'contacts':
      case 'create':
      case 'gossip':
      case 'governance':
        activeTab = 'more';
        moreTab = view as MoreTab;
        break;
      default:
        break;
    }

    if (view === 'more' && subview) {
      const nextMoreTab = ['consensus', 'chat', 'contacts', 'create', 'gossip', 'governance'].includes(subview)
        ? subview as MoreTab
        : null;
      if (nextMoreTab) moreTab = nextMoreTab;
    }

    if (view === 'configure' && subview) {
      const nextConfigureTab =
        subview === 'credit'
          ? 'extend-credit'
          : ['extend-credit', 'request-credit', 'collateral', 'token'].includes(subview)
            ? subview as ConfigureWorkspaceTab
            : null;
      if (nextConfigureTab) configureWorkspaceTab = nextConfigureTab;
    }

    if (jurisdiction) {
      const matched = availableJurisdictions.find((candidate) =>
        String(candidate?.name || '').trim().toLowerCase() === jurisdiction.toLowerCase(),
      );
      selectedJurisdictionName = matched?.name ?? jurisdiction;
    }
  }

  const REFRESH_OPTIONS = [
    { label: 'Off', value: 0 },
    { label: '1s', value: 1000 },
    { label: '5s', value: 5000 },
    { label: '15s', value: 15000 },
    { label: '30s', value: 30000 },
    { label: '60s', value: 60000 },
  ];

  const ACCOUNT_BAR_USD_PER_100PX_MIN = 10;
  const ACCOUNT_BAR_USD_PER_100PX_MAX = 10_000;

  function clampAccountBarUsdPer100Px(raw: unknown): number {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return 10_000;
    return Math.max(
      ACCOUNT_BAR_USD_PER_100PX_MIN,
      Math.min(ACCOUNT_BAR_USD_PER_100PX_MAX, Math.round(numeric)),
    );
  }

  $: accountBarUsdPer100Px = clampAccountBarUsdPer100Px(($settings.accountBarUsdPerPx ?? 100) * 100);

  function setAccountBarScale(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    settingsOperations.setAccountBarUsdPer100Px(clampAccountBarUsdPer100Px(target.value));
  }

  function updateBalanceRefresh(event: Event) {
    const target = event.target as HTMLSelectElement;
    settingsOperations.setBalanceRefreshMs(Math.max(1000, Number(target.value)));
  }

  function isRuntimeEnv(value: unknown): value is Env {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
  }

  async function readJsonResponse<T = unknown>(response: Response): Promise<T | null> {
    const raw = await response.text();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  type ApiResult = {
    success?: boolean;
    error?: string;
    code?: string;
    details?: unknown;
  };

  type TokenCatalogItem = {
    symbol: string;
    address: string;
    decimals?: number;
    tokenId?: number;
  };

  type TokenCatalogResponse = {
    tokens?: TokenCatalogItem[];
  };

  type IconTabConfig<T extends string> = {
    id: T;
    icon: ComponentType;
    label: string;
  };

  type IconBadgeTabConfig<T extends string> = IconTabConfig<T> & {
    showBadge?: boolean;
    badgeType?: 'pending';
  };

  type IconPendingTabConfig<T extends string> = IconTabConfig<T> & {
    showPendingBatch?: boolean;
  };

  type IndexedDbWithDatabases = IDBFactory & {
    databases?: () => Promise<IDBDatabaseInfo[]>;
  };

  type JTokenRegistryItem = Awaited<ReturnType<JAdapter['getTokenRegistry']>>[number];

  function getRuntimeId(env: Env | null | undefined): string | null {
    const runtimeId = env?.runtimeId;
    return typeof runtimeId === 'string' && runtimeId.length > 0 ? runtimeId : null;
  }

  function getGossipProfiles(env: Env | null | undefined): GossipProfile[] {
    return env?.gossip?.getProfiles?.() ?? [];
  }

  function isHubProfile(profile: GossipProfile | undefined): boolean {
    return profile ? profile.metadata.isHub === true : false;
  }

  function resolveAccountCounterparty(entityId: string, account: AccountMachine): string {
    return account.leftEntity.toLowerCase() === entityId.toLowerCase()
      ? account.rightEntity
      : account.leftEntity;
  }

  function findLocalAccountByCounterparty(
    entityId: string,
    accounts: Map<string, AccountMachine> | undefined,
    counterpartyId: string | undefined,
  ): AccountMachine | null {
    if (!counterpartyId || !accounts) return null;
    const needle = counterpartyId.toLowerCase();
    for (const [accountKey, account] of accounts.entries()) {
      if (accountKey.toLowerCase() === needle) return account;
      if (resolveAccountCounterparty(entityId, account).toLowerCase() === needle) return account;
    }
    return null;
  }

  function buildEntityInput(entityId: string, signerId: string, entityTxs: EntityTx[]): RoutedEntityInput {
    return { entityId, signerId, entityTxs };
  }

  function getP2PRelayUrls(env: Env | null | undefined): string[] {
    const relayUrls = env?.runtimeState?.p2p?.relayUrls;
    return Array.isArray(relayUrls) ? relayUrls : [];
  }

  function toErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    return fallback;
  }

  // Copy address to clipboard
  async function copyAddress() {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;
    try {
      await navigator.clipboard.writeText(entityId);
      addressCopied = true;
      setTimeout(() => addressCopied = false, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  // Get avatar URL without tripping early boot fail-fast guards.
  $: avatarUrl = (() => {
    if (!activeXlnFunctions?.isReady) return '';
    try {
      return activeXlnFunctions.generateEntityAvatar?.(tab.entityId) || '';
    } catch {
      return '';
    }
  })();

  // Resolve entity name from gossip profiles
  $: gossipName = (() => {
    const entityId = (replica?.state?.entityId || tab.entityId || '').toLowerCase();
    if (!entityId) return '';
    const profiles = activeEnv?.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p: GossipProfile) => p.entityId.toLowerCase() === entityId);
    return profile?.name || '';
  })();

  function isPlaceholderName(value: string): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return true;
    if (/^signer\s+\d+$/i.test(normalized)) return true;
    if (/^entity\s+[0-9a-f]{4,}$/i.test(normalized)) return true;
    return false;
  }

  $: heroDisplayName = (() => {
    const fallbackId = replica?.state?.entityId || tab.entityId || '';
    const gossip = (gossipName ?? '').trim();
    return gossip && !isPlaceholderName(gossip) ? gossip : fallbackId;
  })();

  // Format short address for display
  function formatAddress(addr: string): string {
    if (!addr) return '';
    if (addr.length <= 18) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
  }

  $: activeReplicas = replicasOverride
    || (isRuntimeEnv(activeEnv) && activeEnv.eReplicas instanceof Map ? activeEnv.eReplicas as Map<string, EntityReplica> : null)
    || $visibleReplicas;
  $: activeXlnFunctions = $xlnFunctions;
  $: activeHistory = historyOverride ?? $history;
  $: activeTimeIndex = timeIndexOverride ?? $currentTimeIndex;
  $: activeEnv = envOverride || $xlnEnvironment;
  $: activeIsLive = isLiveOverride ?? $isLive;

  function resolveEntitySigner(entityId: string, reason: string): string {
    const env = activeEnv;
    if (env && activeXlnFunctions?.resolveEntityProposerId) {
      return activeXlnFunctions.resolveEntityProposerId(env, entityId, reason);
    }
    return requireSignerIdForEntity(env, entityId, reason);
  }

  function findReplicaForTab(
    replicas: Map<string, EntityReplica> | null | undefined,
    entityId: string,
    signerId: string,
  ): EntityReplica | null {
    if (!replicas || !entityId) return null;

    const exactKey = signerId ? `${entityId}:${signerId}` : '';
    const exact = exactKey ? replicas.get(exactKey) ?? null : null;
    if (exact) return exact;

    const normalizedEntityId = String(entityId || '').trim().toLowerCase();
    for (const [replicaKey, candidate] of replicas.entries()) {
      const [replicaEntityId] = String(replicaKey).split(':');
      if (String(replicaEntityId || '').trim().toLowerCase() === normalizedEntityId) {
        return candidate;
      }
    }

    return null;
  }

  // Get replica
  $: {
    if (tab.entityId && tab.signerId) {
      replica = findReplicaForTab(activeReplicas, tab.entityId, tab.signerId);
    } else {
      replica = null;
    }
  }

  // Navigation
  $: isAccountFocused = selectedAccountId !== null;
  $: selectedAccount = isAccountFocused && replica?.state?.accounts && selectedAccountId
    ? replica.state.accounts.get(selectedAccountId) : null;
  $: accountIds = replica?.state?.accounts
    ? Array.from(replica.state.accounts.keys()).map((id) => String(id))
    : [];
  $: workspaceAccountIds = accountIds.filter((id) => {
    const account = replica?.state?.accounts?.get?.(id) as AccountMachine | undefined;
    if (!account) return false;
    const isFinalizedDisputed = String(account.status || '') === 'disputed' && !account.activeDispute;
    return !isFinalizedDisputed;
  });
  let lastAccountReplicaSignature = '';
  $: {
    const signature = [
      String(tab.entityId || ''),
      String(tab.signerId || ''),
      String(activeEnv && 'runtimeId' in activeEnv ? activeEnv.runtimeId || '' : ''),
      String(replica?.state?.entityId || ''),
      String(accountIds.length),
      String(workspaceAccountIds.length),
      accountIds.join(','),
    ].join('|');
    if (signature !== lastAccountReplicaSignature) {
      lastAccountReplicaSignature = signature;
    }
  }
  $: if (!workspaceAccountId || !workspaceAccountIds.includes(workspaceAccountId)) {
    workspaceAccountId = workspaceAccountIds[0] || '';
  }
  $: configureTokenOptions = (() => {
    const ids = new Set<number>([1, 2, 3]);
    for (const tokenId of replica?.state?.reserves?.keys?.() || []) {
      const numericId = Number(tokenId);
      if (Number.isFinite(numericId) && numericId > 0) ids.add(numericId);
    }
    return Array.from(ids).sort((leftId, rightId) => {
      const leftInfo = getTokenInfo(leftId);
      const rightInfo = getTokenInfo(rightId);
      return compareTokenSymbols(leftInfo.symbol || `TKN${leftId}`, rightInfo.symbol || `TKN${rightId}`);
    }).map((id) => {
      const info = getTokenInfo(id);
      return { id, symbol: info.symbol || `TKN${id}` };
    });
  })();
  $: {
    if (!configureTokenOptions.some((opt) => opt.id === configureTokenId)) {
      configureTokenId = configureTokenOptions[0]?.id ?? 1;
    }
  }

  // Jurisdictions
  $: availableJurisdictions = (() => {
    const env = activeEnv;
    if (!env?.jReplicas) return [];
    if (env.jReplicas instanceof Map) return Array.from(env.jReplicas.values());
    if (Array.isArray(env.jReplicas)) return env.jReplicas;
    return Object.values(env.jReplicas || {});
  })() as Array<{ name?: string }>;

  $: {
    if (showJurisdiction && availableJurisdictions.length > 0 && !selectedJurisdictionName) {
      selectedJurisdictionName = activeEnv?.activeJurisdiction ?? availableJurisdictions[0]?.name ?? null;
    }
  }

  // Contacts (persisted in localStorage)
  let contacts: Array<{ name: string; entityId: string }> = [];
  let newContactName = '';
  let newContactId = '';
  let openAccountEntityOptions: string[] = [];

  function isFullEntityId(value: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(String(value || '').trim());
  }

  function handleOpenAccountTargetChange(event: CustomEvent<{ value?: string }>) {
    openAccountEntityId = String(event.detail?.value || '').trim();
  }

  function handleWorkspaceAccountChange(event: CustomEvent<{ value?: string }>) {
    const nextRaw = String(event.detail?.value || '').trim();
    const matched = workspaceAccountIds.find((id) => String(id).toLowerCase() === nextRaw.toLowerCase());
    workspaceAccountId = matched || nextRaw;
  }

  $: openAccountEntityOptions = (() => {
    const ids = new Map<string, string>();
    const selfId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const existingAccountIds = new Set(accountIds.map((id) => String(id || '').trim().toLowerCase()));
    const add = (candidate: unknown) => {
      const raw = String(candidate || '').trim();
      if (!isFullEntityId(raw)) return;
      const normalized = raw.toLowerCase();
      if (!normalized || normalized === selfId || existingAccountIds.has(normalized)) return;
      if (!ids.has(normalized)) ids.set(normalized, normalized);
    };

    for (const key of activeReplicas?.keys?.() || []) add(String(key).split(':')[0]);
    for (const profile of activeEnv?.gossip?.getProfiles?.() || []) add(profile.entityId);
    for (const contact of contacts) add(contact.entityId);
    return Array.from(ids.values()).sort();
  })();

  // Governance/Profile settings (REA flow: profile-update entityTx)
  let governanceName = '';
  let governanceBio = '';
  let governanceWebsite = '';
  let governanceSaving = false;
  let governanceLoadedForEntity = '';

  // Hub config settings (setHubConfig entityTx)
  let hubConfigLoadedForEntity = '';
  let hubConfigSaving = false;
  let hubMatchingStrategy: 'amount' | 'time' | 'fee' = 'amount';
  let hubRoutingFeePPM = '1';
  let hubBaseFee = '0';
  let hubMinCollateralThreshold = '0';
  let hubRebalanceBaseFee = '0.1';
  let hubRebalanceLiquidityFeeBps = '1';
  let hubRebalanceGasFee = '0';
  let hubRebalanceTimeoutSeconds = '600';
  let hubPolicyVersion = '';

  // On-chain reserves are derived directly from replica.state.reserves.
  let onchainReserves: Map<number, bigint> = new Map();
  let pendingReserveFaucets: Array<{
    tokenId: number;
    amount: bigint;
    expectedBalance: bigint;
    startedAt: number;
    symbol: string;
  }> = [];
  const RESERVE_FAUCET_TIMEOUT_MS = 15000;

  // External tokens (ERC20 balances held by signer EOA)
  interface ExternalToken {
    symbol: string;
    address: string;
    balance: bigint;
    decimals: number;
    tokenId: number | undefined;
  }
  let externalTokens: ExternalToken[] = [];
  let externalTokensLoading = true;
  let depositingToken: string | null = null; // symbol of token being deposited
  let withdrawingExternalToken: string | null = null; // symbol of token being withdrawn back to EOA
  let collateralFundingToken: string | null = null; // symbol of token being moved to collateral
  let faucetAssetSymbol = 'USDC';
  let externalToReserveSymbol = 'USDC';
  let reserveToCollateralSymbol = 'USDC';
  let collateralToReserveSymbol = 'USDC';
  let reserveToExternalSymbol = 'USDC';
  let sendAssetSymbol = 'USDC';
  let sendAssetAmount = '';
  let sendAssetRecipient = '';
  let allowAssetSymbol = 'USDC';
  let allowAssetAmount = '';
  let allowAssetSpender = '';
  let externalToReserveAmount = '';
  let reserveToCollateralAmount = '';
  let collateralToReserveAmount = '';
  let reserveToExternalAmount = '';
  let sendingExternalToken: string | null = null;
  let approvingExternalToken: string | null = null;
  let transferableAssetOptions: Array<ExternalToken & { tokenId: number }> = [];
  let assetLedgerRows: AssetLedgerRow[] = [];
  let accountSpendableByToken = new Map<number, bigint>();
  let pendingAssetBridgeSync: {
    tokenId: number;
    symbol: string;
    direction: 'deposit' | 'withdraw';
    baselineReserve: bigint;
  } | null = null;
  let resolvingAssetBridgeSync = false;
  let pendingAssetAutoC2R: {
    counterpartyEntityId: string;
    tokenId: number;
    symbol: string;
  } | null = null;
  let resolvingAssetAutoC2R = false;
  let externalFetchSeq = 0;
  let externalFetchStartedAt = 0;
  let externalFetchInFlight: Promise<void> | null = null;
  let selectedExternalToReserveToken: (ExternalToken & { tokenId: number }) | null = null;
  let selectedReserveToCollateralToken: (ExternalToken & { tokenId: number }) | null = null;
  let selectedCollateralToReserveToken: (ExternalToken & { tokenId: number }) | null = null;
  let selectedReserveToExternalToken: (ExternalToken & { tokenId: number }) | null = null;
  let selectedSendAssetToken: ExternalToken | null = null;
  let selectedAllowAssetToken: ExternalToken | null = null;

  type AssetLedgerRow = {
    symbol: string;
    address: string;
    decimals: number;
    tokenId: number | undefined;
    isNative: boolean;
    externalBalance: bigint;
    reserveBalance: bigint;
    accountBalance: bigint;
    externalUsd: number;
    reserveUsd: number;
    accountUsd: number;
    totalUsd: number;
  };

  function isReserveTransferToken(token: ExternalToken): token is ExternalToken & { tokenId: number } {
    return typeof token.tokenId === 'number' && token.tokenId > 0;
  }

  const TOKEN_UI_ORDER = ['ETH', 'WETH', 'USDT', 'USDC'];

  function getTokenUiRank(symbol: string): number {
    const normalized = String(symbol || '').trim().toUpperCase();
    const index = TOKEN_UI_ORDER.indexOf(normalized);
    return index >= 0 ? index : TOKEN_UI_ORDER.length + 100;
  }

  function compareTokenSymbols(left: string, right: string): number {
    const leftRank = getTokenUiRank(left);
    const rightRank = getTokenUiRank(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  }

  function sortExternalTokens(tokens: ExternalToken[]): ExternalToken[] {
    return [...tokens].sort((left, right) => compareTokenSymbols(left.symbol, right.symbol));
  }

  function choosePreferredAssetSymbol(tokens: ExternalToken[]): string {
    const ordered = sortExternalTokens(tokens);
    return ordered[0]?.symbol ?? 'USDC';
  }

  function findExternalTokenBySymbol(symbol: string): ExternalToken | null {
    const normalized = symbol.trim().toUpperCase();
    return externalTokens.find((token) => token.symbol.toUpperCase() === normalized) ?? null;
  }

  function findReserveTransferTokenBySymbol(symbol: string): (ExternalToken & { tokenId: number }) | null {
    const token = findExternalTokenBySymbol(symbol);
    if (!token || !isReserveTransferToken(token)) return null;
    return token;
  }

  function requireExternalTokenBySymbol(symbol: string): ExternalToken {
    const token = findExternalTokenBySymbol(symbol);
    if (!token) throw new Error(`Unknown asset ${symbol}`);
    return token;
  }

  function parsePositiveAssetAmount(raw: string, token: { decimals: number }, maxAmount?: bigint): bigint {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error('Amount is required');
    if (!/^(?:\d+|\d+\.\d*|\.\d+)$/.test(trimmed)) throw new Error('Invalid amount format');
    const parsed = parseTokenAmount(trimmed, token.decimals);
    if (parsed <= 0n) throw new Error('Amount must be greater than zero');
    if (typeof maxAmount === 'bigint' && parsed > maxAmount) throw new Error('Amount exceeds available balance');
    return parsed;
  }

  function getWorkspaceDerivedDelta(tokenId: number) {
    const account = workspaceAccount;
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const counterpartyId = String(workspaceAccountId || '').trim().toLowerCase();
    if (!account || !entityId || !counterpartyId || !activeXlnFunctions?.deriveDelta) return null;
    const delta = account.deltas?.get?.(tokenId);
    if (!delta) return null;
    return activeXlnFunctions.deriveDelta(delta, entityId < counterpartyId);
  }

  function getWorkspaceWithdrawableCollateral(tokenId: number): bigint {
    const derived = getWorkspaceDerivedDelta(tokenId);
    if (!derived) return 0n;
    const hold = derived.outTotalHold ?? 0n;
    return derived.outCollateral > hold ? derived.outCollateral - hold : 0n;
  }

  function isLocalExecutorForWorkspace(counterpartyEntityId: string, account: AccountMachine | null): boolean {
    const workspace = account?.settlementWorkspace;
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const counterparty = String(counterpartyEntityId || '').trim().toLowerCase();
    if (!workspace || workspace.status !== 'ready_to_submit' || !entityId || !counterparty) return false;
    return workspace.executorIsLeft === (entityId < counterparty);
  }

  // Faucet: fund entity reserves with test tokens
  function resolveReserveTokenMeta(tokenId: number, symbolHint?: string): { tokenId: number; symbol: string; decimals: number } {
    const byId = externalTokens.find(t => typeof t.tokenId === 'number' && t.tokenId === tokenId);
    if (byId) {
      return { tokenId: byId.tokenId as number, symbol: byId.symbol, decimals: byId.decimals ?? 18 };
    }
    if (symbolHint) {
      const bySymbol = externalTokens.find(t => t.symbol?.toUpperCase?.() === symbolHint.toUpperCase());
      if (bySymbol && typeof bySymbol.tokenId === 'number') {
        return { tokenId: bySymbol.tokenId, symbol: bySymbol.symbol, decimals: bySymbol.decimals ?? 18 };
      }
    }
    const info = getTokenInfo(tokenId);
    return { tokenId, symbol: info.symbol ?? 'UNK', decimals: info.decimals ?? 18 };
  }

  function parseTokenAmount(amount: string, decimals: number): bigint {
    const [wholeRaw, fracRaw = ''] = amount.split('.');
    const whole = wholeRaw && wholeRaw.length > 0 ? BigInt(wholeRaw) : 0n;
    const fracPadded = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
    const frac = fracPadded.length > 0 ? BigInt(fracPadded) : 0n;
    return whole * 10n ** BigInt(decimals) + frac;
  }

  function formatTokenInputAmount(amount: bigint, decimals: number): string {
    if (amount <= 0n) return '';
    const divisor = 10n ** BigInt(decimals);
    const whole = amount / divisor;
    const frac = amount % divisor;
    if (frac === 0n) return whole.toString();
    return `${whole.toString()}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
  }

  function formatInlineFillAmount(amount: bigint, decimals: number): string {
    if (amount <= 0n) return '0';
    return formatTokenInputAmount(amount, decimals);
  }

  async function resolveCurrentExternalAddress(): Promise<string> {
    const signerId = String(tab.signerId || '').trim();
    if (isAddress(signerId)) return signerId;

    const xln = await getXLN();
    const privKey = xln.getCachedSignerPrivateKey?.(signerId);
    if (!privKey) throw new Error(`No registered signer key for ${signerId}`);
    return new EthersWallet(hexlify(privKey)).address;
  }

  async function withdrawReserveToExternal(tokenId: number, amountOverride?: bigint): Promise<void> {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;
    if (!activeIsLive) {
      toasts.error('Withdraw requires LIVE mode');
      return;
    }

    const info = resolveReserveTokenMeta(tokenId);
    withdrawingExternalToken = info.symbol;
    try {
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');
      const signerId = requireSignerIdForEntity(env, entityId, 'reserve-to-external');
      const amount = amountOverride ?? parsePositiveReserveExternalAmount(tokenId);
      const externalAddress = await resolveCurrentExternalAddress();
      const receivingEntity = zeroPadValue(externalAddress, 32).toLowerCase();

      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [
          {
            type: 'reserve_to_external',
            data: {
              receivingEntity,
              tokenId,
              amount,
            },
          },
          {
            type: 'j_broadcast',
            data: {},
          },
        ],
      }]);

      pendingAssetBridgeSync = {
        tokenId,
        symbol: info.symbol,
        direction: 'withdraw',
        baselineReserve: onchainReserves.get(tokenId) ?? 0n,
      };
    } catch (err) {
      console.error('[EntityPanel] Reserve withdraw failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      toasts.error(`Reserve withdraw failed: ${message}`);
      withdrawingExternalToken = null;
    } finally {
    }
  }

  async function faucetReserves(tokenId: number = 1, symbolHint?: string) {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;
    try {
      const requestApiBase = resolveApiBase();
      const tokenMeta = resolveReserveTokenMeta(tokenId, symbolHint);
      const amountStr = tokenMeta.symbol === 'WETH' || tokenMeta.symbol === 'ETH' ? '0.1' : '100';
      const amountWei = parseTokenAmount(amountStr, tokenMeta.decimals);
      const currentBalance = onchainReserves.get(tokenMeta.tokenId) ?? 0n;
      const existingForToken = pendingReserveFaucets
        .filter((req) => req.tokenId === tokenMeta.tokenId)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      const baseExpected = existingForToken ? existingForToken.expectedBalance : currentBalance;
      const expectedBalance = baseExpected + amountWei;
      // Faucet B: Reserve transfer (ALWAYS use prod API, no BrowserVM fake)
      const response = await fetch(`${requestApiBase}/api/faucet/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userEntityId: entityId,
          tokenId: tokenMeta.tokenId,
          tokenSymbol: tokenMeta.symbol,
          amount: amountStr
        })
      });

      const result = await readJsonResponse<ApiResult>(response);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || `Faucet failed (${response.status})`);
      }

      console.log('[EntityPanel] Reserve faucet request queued:', result);
      pendingReserveFaucets = [...pendingReserveFaucets, {
        tokenId: tokenMeta.tokenId,
        amount: amountWei,
        expectedBalance,
        startedAt: Date.now(),
        symbol: tokenMeta.symbol,
      }];
      toasts.info(`Reserve faucet requested for ${tokenMeta.symbol}. Waiting for on-chain update...`);
    } catch (err) {
      console.error('[EntityPanel] Reserve faucet failed:', err);
      toasts.error(`Reserve faucet failed: ${(err as Error).message}`);
    }
  }

  async function faucetOffchain(hubEntityId: string, tokenId: number = 1) {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;
    try {
      const requestApiBase = resolveApiBase();
      const tokenMeta = resolveReserveTokenMeta(tokenId);
      const amountStr = tokenMeta.symbol === 'WETH' || tokenMeta.symbol === 'ETH' ? '0.2' : '100';
      const runtimeId = getRuntimeId(activeEnv);
      if (!runtimeId) {
        throw new Error('Runtime is not ready yet (missing runtimeId). Re-open runtime and retry.');
      }
      if (!hubEntityId) {
        throw new Error('Offchain faucet requires a target hub account.');
      }

      const requestTimeoutMs = 12000;
      let response: Response | null = null;
      let result: ApiResult | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        const p2p = get(p2pState);
        const relayUrl = getP2PRelayUrls(activeEnv)[0] || $settings?.relayUrl || 'n/a';
        const visibility =
          typeof document !== 'undefined' ? document.visibilityState : 'server';
        console.log('[EntityPanel] Offchain faucet request:', {
          hubEntityId,
          tokenId,
          runtimeId,
          relayUrl,
          visibility,
          p2pConnected: !!p2p?.connected,
          p2pReconnect: p2p?.reconnect || null,
          p2pQueue: p2p?.queue || null,
        });
        response = await fetch(`${requestApiBase}/api/faucet/offchain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            userEntityId: entityId,
            userRuntimeId: runtimeId,
            hubEntityId,
            tokenId,
            amount: amountStr,
          })
        });
        result = await readJsonResponse<ApiResult>(response);
      } catch (error: unknown) {
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        const message = aborted
          ? `Faucet request timed out after ${requestTimeoutMs}ms`
          : toErrorMessage(error, 'Faucet request failed');
        throw new Error(message);
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      if (!response?.ok || !result?.success) {
        const status = response ? response.status : 'fetch-error';
        const code = typeof result?.code === 'string' ? result.code : '';
        console.error('[EntityPanel] Offchain faucet rejected:', {
          status,
          code,
          error: result?.error || null,
          details: result?.details || null,
        });
        throw new Error(result?.error || `Faucet failed (${status})`);
      }

      console.log('[EntityPanel] Offchain faucet success:', result);
      toasts.info('Offchain faucet request accepted.');
    } catch (err) {
      console.error('[EntityPanel] Offchain faucet failed:', err);
      toasts.error(`Offchain faucet failed: ${(err as Error).message}`);
    }
  }

  function handleAccountFaucet(event: CustomEvent<{ counterpartyId: string; tokenId: number }>) {
    faucetOffchain(event.detail.counterpartyId, event.detail.tokenId);
  }

  async function handleQuickSettleApprove(event: CustomEvent<{ counterpartyId: string }>) {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;
    if (!activeIsLive) {
      toasts.error('Settlement signature requires LIVE mode');
      return;
    }

    try {
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');
      const signerId = resolveEntitySigner(entityId, 'quick-settle-approve');
      if (!signerId) throw new Error('No signer available');

      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [{
          type: 'settle_approve',
          data: { counterpartyEntityId: event.detail.counterpartyId },
        }])]);
      toasts.info('Withdrawal signature sent');
    } catch (err) {
      console.error('[EntityPanel] Quick settle approve failed:', err);
      toasts.error(`Settlement signature failed: ${(err as Error).message}`);
    }
  }

  async function getTokenList(jadapter: JAdapter | null | undefined): Promise<ExternalToken[]> {
    let tokens: ExternalToken[] = [];
    if (jadapter?.getTokenRegistry) {
      const registry = await jadapter.getTokenRegistry();
      if (registry?.length) {
        tokens = registry.map((t: JTokenRegistryItem) => ({
          symbol: t.symbol,
          address: t.address,
          balance: 0n,
          decimals: typeof t.decimals === 'number' ? t.decimals : 18,
          tokenId: typeof t.tokenId === 'number' ? t.tokenId : undefined,
        }));
      }
    }

    if (tokens.length === 0) {
      const apiTokens = await fetchTokenCatalog();
      tokens = apiTokens.length > 0
        ? apiTokens.map(t => ({ ...t, balance: 0n }))
        : [];
    }

    return tokens.map(t => ({ ...t, balance: 0n }));
  }

  function buildOnchainReserves(
    reserves: Map<number | string, bigint> | undefined,
    tokens: ExternalToken[],
  ): Map<number, bigint> {
    const next = new Map<number, bigint>();
    const catalogTokenIds = tokens
      .map(t => t.tokenId)
      .filter((id): id is number => typeof id === 'number' && id > 0);
    const defaultTokenIds = catalogTokenIds.length > 0 ? catalogTokenIds : [1, 2, 3];
    for (const tokenId of defaultTokenIds) {
      next.set(tokenId, 0n);
    }

    if (reserves && typeof reserves.entries === 'function') {
      for (const [tokenId, amount] of reserves.entries()) {
        const numericId = Number(tokenId);
        if (!Number.isNaN(numericId)) next.set(numericId, amount);
      }
    }
    return next;
  }

  $: onchainReserves = buildOnchainReserves(replica?.state?.reserves, externalTokens);
  $: {
    if (!pendingAssetBridgeSync || resolvingAssetBridgeSync) {
      // no-op
    } else {
      const currentReserve = onchainReserves.get(pendingAssetBridgeSync.tokenId) ?? 0n;
      const reserveMoved = pendingAssetBridgeSync.direction === 'deposit'
        ? currentReserve > pendingAssetBridgeSync.baselineReserve
        : currentReserve < pendingAssetBridgeSync.baselineReserve;
      if (reserveMoved) {
        resolvingAssetBridgeSync = true;
        const sync = pendingAssetBridgeSync;
        void (async () => {
          try {
            await fetchExternalTokens();
          } finally {
            if (sync.direction === 'deposit' && depositingToken === sync.symbol) depositingToken = null;
            if (sync.direction === 'withdraw' && withdrawingExternalToken === sync.symbol) withdrawingExternalToken = null;
            pendingAssetBridgeSync = null;
            resolvingAssetBridgeSync = false;
          }
        })();
      }
    }
  }
  $: {
    if (!pendingAssetAutoC2R || resolvingAssetAutoC2R) {
      // no-op
    } else {
      const pending = pendingAssetAutoC2R;
      const currentAccount =
        workspaceAccountId &&
        workspaceAccountId.toLowerCase() === pending.counterpartyEntityId.toLowerCase()
          ? workspaceAccount
          : findLocalAccountByCounterparty(
              String(replica?.state?.entityId || tab.entityId || ''),
              replica?.state?.accounts,
              pending.counterpartyEntityId,
            );
      const sentBatchPending = !!replica?.state?.jBatchState?.sentBatch;
      if (currentAccount?.settlementWorkspace?.status === 'submitted') {
        pendingAssetAutoC2R = null;
        resolvingAssetAutoC2R = false;
        collateralFundingToken = null;
      } else if (!sentBatchPending && isLocalExecutorForWorkspace(pending.counterpartyEntityId, currentAccount)) {
        resolvingAssetAutoC2R = true;
        void (async () => {
          try {
            const env = activeEnv;
            const entityId = replica?.state?.entityId || tab.entityId;
            if (!env || !entityId) throw new Error('Environment not ready');
            const signerId = resolveEntitySigner(entityId, 'asset-c2r-auto-execute');
            await enqueueEntityInputs(env, [
              buildEntityInput(entityId, signerId, [
                {
                  type: 'settle_execute' as const,
                  data: { counterpartyEntityId: pending.counterpartyEntityId },
                },
                {
                  type: 'j_broadcast' as const,
                  data: {},
                },
              ]),
            ]);
            collateralToReserveAmount = '';
            toasts.info(`Collateral → Reserve submitted for ${pending.symbol}. Waiting for on-chain update...`);
          } catch (err) {
            console.error('[EntityPanel] Asset C→R auto-execute failed:', err);
            toasts.error(`Collateral → Reserve failed: ${toErrorMessage(err, 'Unknown error')}`);
          } finally {
            pendingAssetAutoC2R = null;
            resolvingAssetAutoC2R = false;
            collateralFundingToken = null;
          }
        })();
      }
    }
  }

  $: transferableAssetOptions = externalTokens.filter(isReserveTransferToken);
  $: selectedExternalToReserveToken = findReserveTransferTokenBySymbol(externalToReserveSymbol);
  $: selectedReserveToCollateralToken = findReserveTransferTokenBySymbol(reserveToCollateralSymbol);
  $: selectedCollateralToReserveToken = findReserveTransferTokenBySymbol(collateralToReserveSymbol);
  $: selectedReserveToExternalToken = findReserveTransferTokenBySymbol(reserveToExternalSymbol);
  $: selectedSendAssetToken = findExternalTokenBySymbol(sendAssetSymbol);
  $: selectedAllowAssetToken = findExternalTokenBySymbol(allowAssetSymbol);
  $: workspaceAccount = (() => {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim();
    if (!entityId || !workspaceAccountId || !replica?.state?.accounts) return null;
    return findLocalAccountByCounterparty(entityId, replica.state.accounts, workspaceAccountId);
  })();
  $: accountSpendableByToken = (() => {
    const totals = new Map<number, bigint>();
    const accounts = replica?.state?.accounts;
    const entityId = String(replica?.state?.entityId || tab.entityId || '').toLowerCase();
    if (!accounts || !entityId || !activeXlnFunctions?.deriveDelta) return totals;
    for (const [counterpartyId, account] of accounts.entries()) {
      if (!(account?.deltas instanceof Map)) continue;
      const isLeftEntity = entityId < String(counterpartyId || '').toLowerCase();
      for (const [tokenId, delta] of account.deltas.entries()) {
        const numericTokenId = Number(tokenId);
        if (!Number.isFinite(numericTokenId) || numericTokenId <= 0) continue;
        const derived = activeXlnFunctions.deriveDelta(delta, isLeftEntity);
        const spendable = derived?.outCapacity ?? 0n;
        if (spendable <= 0n) continue;
        totals.set(numericTokenId, (totals.get(numericTokenId) ?? 0n) + spendable);
      }
    }
    return totals;
  })();
  $: assetLedgerRows = (() => {
    const rows = new Map<string, AssetLedgerRow>();
    for (const token of externalTokens) {
      const reserveBalance = isReserveTransferToken(token)
        ? (onchainReserves.get(token.tokenId) ?? 0n)
        : 0n;
      const accountBalance = isReserveTransferToken(token)
        ? (accountSpendableByToken.get(token.tokenId) ?? 0n)
        : 0n;
      const externalUsd = getExternalValue(token);
      const reserveUsd = isReserveTransferToken(token)
        ? getAssetValue(token.tokenId, reserveBalance, token.symbol)
        : 0;
      const accountUsd = isReserveTransferToken(token)
        ? getAssetValue(token.tokenId, accountBalance, token.symbol)
        : 0;
      rows.set(token.symbol, {
        symbol: token.symbol,
        address: token.address,
        decimals: token.decimals,
        tokenId: token.tokenId,
        isNative: token.symbol === 'ETH' || token.address === ZeroAddress,
        externalBalance: token.balance,
        reserveBalance,
        accountBalance,
        externalUsd,
        reserveUsd,
        accountUsd,
        totalUsd: externalUsd + reserveUsd + accountUsd,
      });
    }
    for (const [tokenId, reserveBalance] of onchainReserves.entries()) {
      const numericId = Number(tokenId);
      if (!Number.isFinite(numericId) || numericId <= 0) continue;
      const existing = Array.from(rows.values()).find((row) => row.tokenId === numericId);
      if (existing) continue;
      const info = resolveReserveTokenMeta(numericId);
      const reserveUsd = getAssetValue(numericId, reserveBalance, info.symbol);
      rows.set(info.symbol, {
        symbol: info.symbol,
        address: '',
        decimals: info.decimals,
        tokenId: numericId,
        isNative: false,
        externalBalance: 0n,
        reserveBalance,
        accountBalance: accountSpendableByToken.get(numericId) ?? 0n,
        externalUsd: 0,
        reserveUsd,
        accountUsd: getAssetValue(numericId, accountSpendableByToken.get(numericId) ?? 0n, info.symbol),
        totalUsd: reserveUsd + getAssetValue(numericId, accountSpendableByToken.get(numericId) ?? 0n, info.symbol),
      });
    }
    if (!rows.has('ETH')) {
      rows.set('ETH', {
        symbol: 'ETH',
        address: ZeroAddress,
        decimals: 18,
        tokenId: undefined,
        isNative: true,
        externalBalance: 0n,
        reserveBalance: 0n,
        accountBalance: 0n,
        externalUsd: 0,
        reserveUsd: 0,
        accountUsd: 0,
        totalUsd: 0,
      });
    }
    return Array.from(rows.values()).sort((left, right) => compareTokenSymbols(left.symbol, right.symbol));
  })();
  $: assetLedgerTotals = assetLedgerRows.reduce(
    (totals, row) => {
      totals.externalUsd += row.externalUsd;
      totals.reserveUsd += row.reserveUsd;
      totals.accountUsd += row.accountUsd;
      return totals;
    },
    { externalUsd: 0, reserveUsd: 0, accountUsd: 0 },
  );
  $: assetLedgerGrandTotal = assetLedgerTotals.externalUsd + assetLedgerTotals.reserveUsd + assetLedgerTotals.accountUsd;

  $: {
    const preferred = choosePreferredAssetSymbol(externalTokens);
    if (!findExternalTokenBySymbol(faucetAssetSymbol)) faucetAssetSymbol = preferred;
    if (!findExternalTokenBySymbol(sendAssetSymbol)) sendAssetSymbol = preferred;
    if (!findReserveTransferTokenBySymbol(externalToReserveSymbol)) externalToReserveSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    if (!findReserveTransferTokenBySymbol(reserveToCollateralSymbol)) reserveToCollateralSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    if (!findReserveTransferTokenBySymbol(collateralToReserveSymbol)) collateralToReserveSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    if (!findReserveTransferTokenBySymbol(reserveToExternalSymbol)) reserveToExternalSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    const approvePreferred = transferableAssetOptions.find((token) => token.symbol === 'USDC')?.symbol
      ?? transferableAssetOptions[0]?.symbol
      ?? preferred;
    if (!findReserveTransferTokenBySymbol(allowAssetSymbol)) allowAssetSymbol = approvePreferred;
  }

  $: if (pendingReserveFaucets.length > 0) {
    const now = Date.now();
    const remaining: typeof pendingReserveFaucets = [];
    for (const req of pendingReserveFaucets) {
      const current = onchainReserves.get(req.tokenId) ?? 0n;
      if (current >= req.expectedBalance) {
        toasts.success(`Received ${formatAmount(req.amount, getTokenInfo(req.tokenId).decimals)} ${req.symbol} in reserves!`);
      } else if (now - req.startedAt > RESERVE_FAUCET_TIMEOUT_MS) {
        toasts.error(`Reserve faucet timed out for ${req.symbol}. Check server logs.`);
      } else {
        remaining.push(req);
      }
    }
    if (remaining.length !== pendingReserveFaucets.length) {
      pendingReserveFaucets = remaining;
    }
  }

  // Known token addresses for RPC mode (from deploy-tokens.cjs on anvil)
  async function fetchTokenCatalog(): Promise<ExternalToken[]> {
    try {
      const requestApiBase = resolveApiBase();
      const response = await fetch(`${requestApiBase}/api/tokens`);
      if (!response.ok) return [];
      const data = await readJsonResponse<TokenCatalogResponse>(response);
      const tokens = Array.isArray(data?.tokens) ? data.tokens : [];
      if (tokens.length === 0) return [];
      return tokens.map((t: TokenCatalogItem) => ({
        symbol: t.symbol,
        address: t.address,
        balance: 0n,
        decimals: typeof t.decimals === 'number' ? t.decimals : 18,
        tokenId: typeof t.tokenId === 'number' ? t.tokenId : undefined,
      }));
    } catch {
      return [];
    }
  }

  // Fetch external tokens (ERC20 balances for signer) - works for both BrowserVM and RPC modes
  async function fetchExternalTokens() {
    if (externalFetchInFlight) return externalFetchInFlight;
    const waitMs = Math.max(0, 100 - (Date.now() - externalFetchStartedAt));
    externalFetchInFlight = (async () => {
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      externalFetchStartedAt = Date.now();
      const signerId = tab.signerId;
      const fetchSeq = ++externalFetchSeq;
      externalTokensLoading = true;
      if (!signerId) {
        if (fetchSeq === externalFetchSeq) externalTokensLoading = false;
        return;
      }

      try {
        const xln = await getXLN();
        // External balances are read directly from the active J-adapter/provider.
        // Never derive them from cached UI state; the wallet EOA is the source of truth.
        const jadapter = xln.getActiveJAdapter?.(activeEnv ?? null);

        const tokenList = await getTokenList(jadapter);
        let nativeToken: ExternalToken | null = null;
        if (jadapter?.provider && typeof jadapter.provider.getBalance === 'function' && isAddress(signerId)) {
          try {
            const nativeBalance = await jadapter.provider.getBalance(signerId);
            nativeToken = {
              symbol: 'ETH',
              address: ZeroAddress,
              balance: nativeBalance,
              decimals: 18,
              tokenId: 0,
            };
          } catch (err) {
            console.warn('[EntityPanel] Failed to fetch native ETH balance:', err);
          }
        }
        if (!jadapter?.getErc20Balance) {
          if (fetchSeq === externalFetchSeq) {
            externalTokens = sortExternalTokens(tokenList);
            externalTokensLoading = false;
          }
          return;
        }

        if (jadapter.getErc20Balances) {
          try {
            const balances = await jadapter.getErc20Balances(tokenList.map(t => t.address), signerId);
            balances.forEach((balance: bigint, idx: number) => {
              if (tokenList[idx]) tokenList[idx].balance = balance;
            });
          } catch (err) {
            console.warn('[EntityPanel] Batch balance fetch failed, falling back to per-token:', err);
            for (const token of tokenList) {
              try {
                token.balance = await jadapter.getErc20Balance(token.address, signerId);
              } catch (innerErr) {
                console.warn(`[EntityPanel] Failed to fetch ${token.symbol} balance:`, innerErr);
              }
            }
          }
        } else {
          for (const token of tokenList) {
            try {
              token.balance = await jadapter.getErc20Balance(token.address, signerId);
            } catch (err) {
              console.warn(`[EntityPanel] Failed to fetch ${token.symbol} balance:`, err);
            }
          }
        }

        if (fetchSeq === externalFetchSeq) {
          externalTokens = sortExternalTokens(nativeToken ? [nativeToken, ...tokenList] : tokenList);
          externalTokensLoading = false;
        }
      } catch (err) {
        console.error('[EntityPanel] Failed to fetch external tokens:', err);
        if (fetchSeq === externalFetchSeq) externalTokensLoading = false;
      }
    })().finally(() => {
      externalFetchInFlight = null;
    });
    return externalFetchInFlight;
  }

  // Deposit ERC20 token to entity reserve
  async function depositToReserve(token: ExternalToken, amountOverride?: bigint) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = tab.signerId;
    const amount = amountOverride ?? token.balance;
    if (!entityId || !signerId || amount <= 0n) return;
    if (!activeIsLive) {
      toasts.error('Deposit requires LIVE mode');
      return;
    }

    depositingToken = token.symbol;
    try {
      const xln = await getXLN();
      // CRITICAL: Use activeEnv from context, NOT xln.getEnv() which returns wrong module-level env
      const jadapter = xln.getActiveJAdapter?.(activeEnv ?? null);
      if (!jadapter?.externalTokenToReserve) {
        throw new Error('J-adapter deposit not available');
      }

      // Reserve deposits must use the exact registered signer key for this runtime signer.
      // Never derive a new key by signerId here: signerId is already the canonical EOA address.
      const privKey = xln.getCachedSignerPrivateKey?.(signerId);
      if (!privKey) throw new Error(`No registered signer key for ${signerId}`);

      // Deposit all available balance
      await jadapter.externalTokenToReserve(privKey, entityId, token.address, amount);

      console.log(`[EntityPanel] Deposited ${token.symbol} to entity reserves`);
      if (typeof token.tokenId === 'number' && token.tokenId > 0) {
        pendingAssetBridgeSync = {
          tokenId: token.tokenId,
          symbol: token.symbol,
          direction: 'deposit',
          baselineReserve: onchainReserves.get(token.tokenId) ?? 0n,
        };
      } else {
        depositingToken = null;
        await fetchExternalTokens();
      }
    } catch (err) {
      console.error('[EntityPanel] Deposit failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      toasts.error(`Deposit failed: ${message}`);
      depositingToken = null;
    } finally {
    }
  }

  async function getActiveSignerPrivateKey(): Promise<Uint8Array> {
    const signerId = String(tab.signerId || '').trim();
    if (!signerId) throw new Error('No active signer selected');
    const xln = await getXLN();
    const privKey = xln.getCachedSignerPrivateKey?.(signerId);
    if (!privKey) throw new Error(`No registered signer key for ${signerId}`);
    return privKey;
  }

  async function sendExternalAsset(): Promise<void> {
    const token = requireExternalTokenBySymbol(sendAssetSymbol);
    const recipient = sendAssetRecipient.trim();
    if (!isAddress(recipient)) throw new Error('Recipient must be a valid EOA address');
    const amount = parsePositiveAssetAmount(sendAssetAmount, token, token.balance);
    const xln = await getXLN();
    const jadapter = xln.getActiveJAdapter?.(activeEnv ?? null);
    if (!jadapter) throw new Error('J-adapter not available');
    const privKey = await getActiveSignerPrivateKey();
    sendingExternalToken = token.symbol;
    try {
      if (token.address === ZeroAddress) {
        await jadapter.transferNative(privKey, recipient, amount);
      } else {
        await jadapter.transferErc20(privKey, token.address, recipient, amount);
      }
      sendAssetAmount = '';
      toasts.success(`Sent ${token.symbol}`);
      await fetchExternalTokens();
    } finally {
      sendingExternalToken = null;
    }
  }

  async function approveExternalAsset(): Promise<void> {
    const token = requireExternalTokenBySymbol(allowAssetSymbol);
    if (token.address === ZeroAddress) throw new Error('Native ETH cannot be approved');
    const spender = allowAssetSpender.trim();
    if (!isAddress(spender)) throw new Error('Spender must be a valid address');
    const amount = parsePositiveAssetAmount(allowAssetAmount, token);
    const xln = await getXLN();
    const jadapter = xln.getActiveJAdapter?.(activeEnv ?? null);
    if (!jadapter) throw new Error('J-adapter not available');
    const privKey = await getActiveSignerPrivateKey();
    approvingExternalToken = token.symbol;
    try {
      await jadapter.approveErc20(privKey, token.address, spender, amount);
      allowAssetAmount = '';
      toasts.success(`Approved ${token.symbol}`);
    } finally {
      approvingExternalToken = null;
    }
  }

  async function submitExternalToReserve(): Promise<void> {
    const token = findReserveTransferTokenBySymbol(externalToReserveSymbol);
    if (!token) {
      toasts.error('Select ERC20 asset first');
      return;
    }
    try {
      const amount = parsePositiveAssetAmount(externalToReserveAmount, token, token.balance);
      await depositToReserve(token, amount);
      externalToReserveAmount = '';
    } catch (err) {
      toasts.error(`Deposit failed: ${toErrorMessage(err, 'Unknown error')}`);
    }
  }

  async function submitReserveToExternal(): Promise<void> {
    const token = findReserveTransferTokenBySymbol(reserveToExternalSymbol);
    if (!token) {
      toasts.error('Select reserve asset first');
      return;
    }
    try {
      const reserveAmount = onchainReserves.get(token.tokenId) ?? 0n;
      const amount = parsePositiveAssetAmount(reserveToExternalAmount, token, reserveAmount);
      await withdrawReserveToExternal(token.tokenId, amount);
      reserveToExternalAmount = '';
    } catch (err) {
      toasts.error(`Withdraw failed: ${toErrorMessage(err, 'Unknown error')}`);
    }
  }

  async function submitReserveToCollateral(): Promise<void> {
    const token = findReserveTransferTokenBySymbol(reserveToCollateralSymbol);
    if (!token) {
      toasts.error('Select reserve asset first');
      return;
    }
    try {
      const reserveAmount = onchainReserves.get(token.tokenId) ?? 0n;
      const amount = parsePositiveAssetAmount(reserveToCollateralAmount, token, reserveAmount);
      await reserveToCollateral(token.tokenId, amount);
      reserveToCollateralAmount = '';
    } catch (err) {
      toasts.error(`Reserve → Collateral failed: ${toErrorMessage(err, 'Unknown error')}`);
    }
  }

  async function collateralToReserve(tokenId: number, amount: bigint): Promise<void> {
    const entityId = replica?.state?.entityId || tab.entityId;
    const counterpartyEntityId = String(workspaceAccountId || '').trim();
    if (!entityId) return;
    if (!counterpartyEntityId) {
      toasts.error('Select an account first');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Collateral → Reserve requires LIVE mode');
      return;
    }

    try {
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');
      const signerId = resolveEntitySigner(entityId, 'collateral-to-reserve');
      const info = getTokenInfo(tokenId);

      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [
        {
          type: 'settle_propose' as const,
          data: {
            counterpartyEntityId,
            executorIsLeft: String(entityId).trim().toLowerCase() < counterpartyEntityId.toLowerCase(),
            memo: 'asset-c2r',
            ops: [
              {
                type: 'c2r',
                tokenId,
                amount,
              },
            ],
          },
        },
      ])]);

      pendingAssetAutoC2R = {
        counterpartyEntityId,
        tokenId,
        symbol: info.symbol,
      };
      collateralFundingToken = info.symbol;
      toasts.info(`Collateral → Reserve proposed for ${info.symbol}. Waiting for counterparty signature...`);
    } catch (err) {
      console.error('[EntityPanel] Collateral → Reserve failed:', err);
      toasts.error(`Collateral → Reserve failed: ${(err as Error).message}`);
    }
  }

  async function submitCollateralToReserve(): Promise<void> {
    const token = findReserveTransferTokenBySymbol(collateralToReserveSymbol);
    if (!token) {
      toasts.error('Select collateral asset first');
      return;
    }
    try {
      const withdrawable = getWorkspaceWithdrawableCollateral(token.tokenId);
      const amount = parsePositiveAssetAmount(collateralToReserveAmount, token, withdrawable);
      await collateralToReserve(token.tokenId, amount);
      collateralToReserveAmount = '';
    } catch (err) {
      toasts.error(`Collateral → Reserve failed: ${toErrorMessage(err, 'Unknown error')}`);
    }
  }

  // Reserve → Collateral (deposit reserves into selected bilateral account)
  async function reserveToCollateral(tokenId: number, amountOverride?: bigint) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'reserve-to-collateral');
    const counterpartyEntityId = String(workspaceAccountId || selectedAccountId || '').trim();
    if (!entityId || !signerId) return;

    if (!counterpartyEntityId) {
      toasts.error('Select an account to deposit collateral');
      return;
    }

    if (!activeIsLive) {
      toasts.error('Deposit requires LIVE mode');
      return;
    }

    const amount = amountOverride ?? (onchainReserves.get(tokenId) ?? 0n);
    if (amount <= 0n) {
      toasts.error('No reserve balance for this token');
      return;
    }

    const accounts = replica?.state?.accounts;
    if (!accounts || !findLocalAccountByCounterparty(entityId, accounts, counterpartyEntityId)) {
      toasts.error('No account found for selected counterparty');
      return;
    }

    const info = getTokenInfo(tokenId);
    collateralFundingToken = info.symbol;
    try {
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');

      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [
          {
            type: 'deposit_collateral' as const,
            data: {
              counterpartyId: counterpartyEntityId,
              tokenId,
              amount,
            },
          },
          {
            type: 'j_broadcast',
            data: {},
          },
        ])]);

      toasts.info(`R→C queued for ${info.symbol}. Waiting for on-chain update...`);
    } catch (err) {
      console.error('[EntityPanel] Reserve → Collateral failed:', err);
      toasts.error(`Reserve → Collateral failed: ${(err as Error).message}`);
    } finally {
      collateralFundingToken = null;
    }
  }

  async function openAccountWithFullId(targetEntityId: string) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const env = activeEnv;
    const signerId = resolveEntitySigner(entityId, 'open-account');
    const trimmed = targetEntityId.trim().toLowerCase();
    if (!entityId || !signerId) return;
    if (!isFullEntityId(trimmed)) {
      toasts.error('Full entity ID required (0x + 64 hex chars)');
      return;
    }
    if (trimmed === String(entityId).toLowerCase()) {
      toasts.error('Cannot open account with yourself');
      return;
    }
    if (accountIds.some((id) => String(id).toLowerCase() === trimmed)) {
      toasts.info('Account with this entity already exists');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Open account requires LIVE mode');
      return;
    }
    try {
      if (!env) throw new Error('Environment not ready');
      const rebalancePolicy = getOpenAccountRebalancePolicyData();
      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [{
          type: 'openAccount' as const,
          data: {
            targetEntityId: trimmed,
            ...(rebalancePolicy ? { rebalancePolicy } : {}),
          },
        }])]);
      openAccountEntityId = '';
      toasts.success('Account request sent');
    } catch (err) {
      console.error('[EntityPanel] Open account failed:', err);
      toasts.error(`Open account failed: ${(err as Error).message}`);
    }
  }

  async function reopenDisputedAccount(counterpartyEntityId: string) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const env = activeEnv;
    const signerId = resolveEntitySigner(entityId, 'reopen-disputed-account');
    if (!entityId || !signerId) return;
    if (!activeIsLive) {
      toasts.error('Reopen account requires LIVE mode');
      return;
    }
    try {
      if (!env) throw new Error('Environment not ready');
      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [{
          type: 'reopenDisputedAccount' as const,
          data: { counterpartyEntityId },
        }])]);
      toasts.success('Reopen disputed account queued');
    } catch (err) {
      console.error('[EntityPanel] Reopen disputed account failed:', err);
      toasts.error(`Reopen failed: ${(err as Error).message}`);
    }
  }

  async function addTokenToAccount() {
    const entityId = replica?.state?.entityId || tab.entityId;
    const env = activeEnv;
    const signerId = resolveEntitySigner(entityId, 'add-token-to-account');
    const counterpartyEntityId = String(workspaceAccountId || '').trim();
    if (!entityId || !signerId) return;
    if (!counterpartyEntityId) {
      toasts.error('Select account first');
      return;
    }
    if (!Number.isFinite(configureTokenId) || configureTokenId <= 0) {
      toasts.error('Select valid token');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Add token requires LIVE mode');
      return;
    }
    try {
      if (!env) throw new Error('Environment not ready');
      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [{
          type: 'extendCredit' as const,
          data: {
            counterpartyEntityId,
            tokenId: configureTokenId,
            amount: 0n,
          },
        }])]);
      const symbol = getTokenInfo(configureTokenId).symbol || `TKN${configureTokenId}`;
      toasts.success(`Token ${symbol} added to account`);
    } catch (err) {
      console.error('[EntityPanel] Add token failed:', err);
      toasts.error(`Add token failed: ${(err as Error).message}`);
    }
  }

  // Faucet external tokens (ERC20 to signer EOA)
  async function faucetExternalTokens(tokenSymbol: string = 'USDC') {
    const signerId = tab.signerId;
    if (!signerId) return;

    try {
      const requestApiBase = resolveApiBase();
      const amount = tokenSymbol === 'ETH' ? '0.1' : '100';
      const isEth = tokenSymbol === 'ETH';
      const endpoint = isEth ? `${requestApiBase}/api/faucet/gas` : `${requestApiBase}/api/faucet/erc20`;
      const payload = isEth
        ? { userAddress: signerId, amount }
        : { userAddress: signerId, tokenSymbol, amount };
      // Faucet A: ERC20 to wallet (or native ETH gas faucet)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await readJsonResponse<ApiResult>(response);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || `Faucet failed (${response.status})`);
      }

      console.log('[EntityPanel] External faucet success:', result);
      toasts.success(`Received ${amount} ${tokenSymbol} in wallet!`);

      void fetchExternalTokens();
    } catch (err) {
      console.error('[EntityPanel] External faucet failed:', err);
      toasts.error(`External faucet failed: ${(err as Error).message}`);
    }
  }

  async function submitAssetFaucet(target: 'external' | 'reserve' | 'account'): Promise<void> {
    if (target === 'external') {
      await faucetExternalTokens(faucetAssetSymbol);
      return;
    }
    const token = findReserveTransferTokenBySymbol(faucetAssetSymbol);
    if (!token) {
      toasts.error('Reserve faucet supports ERC20 assets only');
      return;
    }
    if (target === 'account') {
      const firstAccountId = workspaceAccountIds[0];
      if (!firstAccountId) {
        toasts.error('Open an account first');
        return;
      }
      await faucetOffchain(firstAccountId, token.tokenId);
      return;
    }
    await faucetReserves(token.tokenId, token.symbol);
  }

  function refreshBalances() {
    fetchExternalTokens();
  }

  let lastEntityId = '';
  let lastSignerId = '';
  $: if (tab.entityId !== lastEntityId || tab.signerId !== lastSignerId) {
    lastEntityId = tab.entityId || '';
    lastSignerId = tab.signerId || '';
    refreshBalances();
  }

  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  $: {
    if (refreshTimer) clearInterval(refreshTimer);
    const refreshMs = $settings.balanceRefreshMs ?? 15000;
    if (refreshMs > 0) {
      refreshTimer = setInterval(() => refreshBalances(), refreshMs);
    }
  }

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });

  onMount(() => {
    const saved = localStorage.getItem('xln-contacts');
    if (saved) contacts = JSON.parse(saved);

    // Fetch reserves and external tokens on mount
    refreshBalances();
    applyDeepLinkViewFromUrl();

    const handleUrlNavigation = () => applyDeepLinkViewFromUrl();
    window.addEventListener('hashchange', handleUrlNavigation);
    window.addEventListener('popstate', handleUrlNavigation);
    return () => {
      window.removeEventListener('hashchange', handleUrlNavigation);
      window.removeEventListener('popstate', handleUrlNavigation);
    };
  });

  $: if (activeTab === 'more' && moreTab === 'governance') {
    loadGovernanceProfileFromGossip();
  }
  $: if (activeTab === 'settings') {
    loadHubConfigFromState();
  }

  function saveContact() {
    if (!newContactName.trim() || !newContactId.trim()) return;
    contacts = [...contacts, { name: newContactName.trim(), entityId: newContactId.trim() }];
    localStorage.setItem('xln-contacts', JSON.stringify(contacts));
    newContactName = '';
    newContactId = '';
  }

  function deleteContact(idx: number) {
    contacts = contacts.filter((_, i) => i !== idx);
    localStorage.setItem('xln-contacts', JSON.stringify(contacts));
  }

  function loadGovernanceProfileFromGossip() {
    const currentEntityId = (replica?.state?.entityId || tab.entityId || '').toLowerCase();
    if (!currentEntityId || governanceLoadedForEntity === currentEntityId) return;
    governanceLoadedForEntity = currentEntityId;
    const profiles = (activeEnv?.gossip?.getProfiles?.() || []) as Array<{
      entityId?: string;
      name?: string;
      bio?: string;
      website?: string;
    }>;
    const profile = profiles.find((p) => String(p?.entityId || '').toLowerCase() === currentEntityId);
    governanceName = String(profile?.name || '');
    governanceBio = String(profile?.bio || '');
    governanceWebsite = String(profile?.website || '');
  }

  async function saveGovernanceProfile() {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'governance-profile-update');
    const env = activeEnv;
    if (!entityId || !signerId) {
      toasts.error('Entity/signer is required for governance profile update');
      return;
    }
    if (!isRuntimeEnv(env) || !activeIsLive) {
      toasts.error('Governance profile updates require LIVE mode');
      return;
    }

    governanceSaving = true;
    try {
      const profileUpdateInput = {
        entityId,
        signerId,
        entityTxs: [{
          type: 'profile-update' as const,
          data: {
            profile: {
              entityId,
              name: governanceName.trim(),
              bio: governanceBio.trim(),
              website: governanceWebsite.trim(),
              hankoSignature: '',
            },
          },
        }],
      };
      await enqueueEntityInputs(env, [profileUpdateInput]);
      toasts.success('Governance profile update submitted');
      governanceLoadedForEntity = '';
      loadGovernanceProfileFromGossip();
    } catch (err) {
      toasts.error(`Governance profile update failed: ${(err as Error).message}`);
    } finally {
      governanceSaving = false;
    }
  }

  function formatFixed18(value: bigint): string {
    const base = 10n ** 18n;
    const whole = value / base;
    const frac = value % base;
    if (frac === 0n) return whole.toString();
    const fracRaw = frac.toString().padStart(18, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fracRaw}`;
  }

  function parseFixed18(raw: string): bigint | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!/^\d+(\.\d{0,18})?$/.test(trimmed)) return null;
    const [wholePart, fracPartRaw = ''] = trimmed.split('.');
    const whole = BigInt(wholePart || '0');
    const frac = BigInt((fracPartRaw + '0'.repeat(18)).slice(0, 18));
    return whole * (10n ** 18n) + frac;
  }

  function loadHubConfigFromState() {
    const currentEntityId = (replica?.state?.entityId || tab.entityId || '').toLowerCase();
    if (!currentEntityId || hubConfigLoadedForEntity === currentEntityId) return;
    hubConfigLoadedForEntity = currentEntityId;

    const config = replica?.state?.hubRebalanceConfig;
    hubMatchingStrategy = (config?.matchingStrategy === 'time' || config?.matchingStrategy === 'fee')
      ? config.matchingStrategy
      : 'amount';
    hubRoutingFeePPM = String(config?.routingFeePPM ?? 1);
    hubBaseFee = formatFixed18(config?.baseFee ?? 0n);
    hubMinCollateralThreshold = formatFixed18(config?.minCollateralThreshold ?? 0n);
    hubRebalanceBaseFee = formatFixed18(config?.rebalanceBaseFee ?? (10n ** 17n));
    hubRebalanceLiquidityFeeBps = String(config?.rebalanceLiquidityFeeBps ?? config?.minFeeBps ?? 1n);
    hubRebalanceGasFee = formatFixed18(config?.rebalanceGasFee ?? 0n);
    hubRebalanceTimeoutSeconds = String(Math.floor((config?.rebalanceTimeoutMs ?? (10 * 60 * 1000)) / 1000));
    hubPolicyVersion = config?.policyVersion ? String(config.policyVersion) : '';
  }

  async function saveHubConfig() {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'hub-config-update');
    const env = activeEnv;
    if (!entityId || !signerId) {
      toasts.error('Entity/signer is required for hub config update');
      return;
    }
    if (!isRuntimeEnv(env) || !activeIsLive) {
      toasts.error('Hub config updates require LIVE mode');
      return;
    }

    const routingFeePPM = Number(hubRoutingFeePPM);
    if (!Number.isFinite(routingFeePPM) || routingFeePPM < 0) {
      toasts.error('Routing fee PPM must be a non-negative number');
      return;
    }
    const rebalanceTimeoutSeconds = Number(hubRebalanceTimeoutSeconds);
    if (!Number.isFinite(rebalanceTimeoutSeconds) || rebalanceTimeoutSeconds < 1) {
      toasts.error('Timeout must be at least 1 second');
      return;
    }

    const baseFee = parseFixed18(hubBaseFee);
    const minCollateralThreshold = parseFixed18(hubMinCollateralThreshold);
    const rebalanceBaseFee = parseFixed18(hubRebalanceBaseFee);
    const rebalanceGasFee = parseFixed18(hubRebalanceGasFee);
    let rebalanceLiquidityFeeBps: bigint;
    try {
      rebalanceLiquidityFeeBps = BigInt(hubRebalanceLiquidityFeeBps.trim());
    } catch {
      toasts.error('Liquidity fee bps must be an integer');
      return;
    }
    if (
      baseFee === null ||
      minCollateralThreshold === null ||
      rebalanceBaseFee === null ||
      rebalanceGasFee === null
    ) {
      toasts.error('Fee/threshold fields must be valid decimal numbers');
      return;
    }

    let explicitPolicyVersion: number | undefined;
    if (hubPolicyVersion.trim()) {
      const n = Number(hubPolicyVersion.trim());
      if (!Number.isFinite(n) || n < 1) {
        toasts.error('Policy version must be a positive integer');
        return;
      }
      explicitPolicyVersion = Math.floor(n);
    }

    hubConfigSaving = true;
    try {
      const txData: Extract<EntityTx, { type: 'setHubConfig' }>['data'] = {
        matchingStrategy: hubMatchingStrategy,
        routingFeePPM: Math.floor(routingFeePPM),
        baseFee,
        minCollateralThreshold,
        rebalanceBaseFee,
        rebalanceLiquidityFeeBps,
        rebalanceGasFee,
        rebalanceTimeoutMs: Math.floor(rebalanceTimeoutSeconds * 1000),
      };
      if (explicitPolicyVersion !== undefined) {
        txData.policyVersion = explicitPolicyVersion;
      }

      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'setHubConfig' as const,
          data: txData,
        }],
      }]);

      toasts.success('Hub config update submitted');
      hubConfigLoadedForEntity = '';
      loadHubConfigFromState();
    } catch (err) {
      toasts.error(`Hub config update failed: ${(err as Error).message}`);
    } finally {
      hubConfigSaving = false;
    }
  }

  // Formatting
  function getTokenInfo(tokenId: number) {
    return activeXlnFunctions?.getTokenInfo(tokenId) ?? { symbol: 'UNK', decimals: 18 };
  }

  function formatAmount(amount: bigint, decimals: number): string {
    const precision = Math.max(0, Math.min(18, Math.floor(Number($settings?.tokenPrecision ?? 6))));
    const negative = amount < 0n;
    const abs = negative ? -amount : amount;
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = abs / divisor;
    const frac = abs % divisor;
    let text = whole.toLocaleString('en-US');
    if (precision > 0 && frac > 0n) {
      const fracStr = frac
        .toString()
        .padStart(decimals, '0')
        .slice(0, Math.min(decimals, precision))
        .replace(/0+$/, '');
      if (fracStr.length > 0) text = `${text}.${fracStr}`;
    }
    return `${negative ? '-' : ''}${text}`;
  }

  function formatCompact(value: number): string {
    if (!$settings.compactNumbers) {
      return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (value >= 1_000_000) return '$' + (value / 1_000_000).toFixed(2) + 'M';
    if (value >= 1_000) return '$' + (value / 1_000).toFixed(2) + 'K';
    return '$' + value.toFixed(2);
  }

  function formatApproxUsd(value: number): string {
    return `~${formatCompact(value)}`;
  }

  function fillExternalToReserveMax(): void {
    if (!selectedExternalToReserveToken) return;
    externalToReserveAmount = formatTokenInputAmount(
      selectedExternalToReserveToken.balance,
      selectedExternalToReserveToken.decimals,
    );
  }

  function fillReserveToCollateralMax(): void {
    if (!selectedReserveToCollateralToken) return;
    const reserveAmount = onchainReserves.get(selectedReserveToCollateralToken.tokenId) ?? 0n;
    reserveToCollateralAmount = formatTokenInputAmount(reserveAmount, selectedReserveToCollateralToken.decimals);
  }

  function fillCollateralToReserveMax(): void {
    if (!selectedCollateralToReserveToken) return;
    const withdrawable = getWorkspaceWithdrawableCollateral(selectedCollateralToReserveToken.tokenId);
    collateralToReserveAmount = formatTokenInputAmount(withdrawable, selectedCollateralToReserveToken.decimals);
  }

  function fillReserveToExternalMax(): void {
    if (!selectedReserveToExternalToken) return;
    const reserveAmount = onchainReserves.get(selectedReserveToExternalToken.tokenId) ?? 0n;
    reserveToExternalAmount = formatTokenInputAmount(reserveAmount, selectedReserveToExternalToken.decimals);
  }

  function fillSendAssetMax(): void {
    if (!selectedSendAssetToken) return;
    sendAssetAmount = formatTokenInputAmount(selectedSendAssetToken.balance, selectedSendAssetToken.decimals);
  }

  function fillAllowAssetMax(): void {
    if (!selectedAllowAssetToken) return;
    allowAssetAmount = formatTokenInputAmount(selectedAllowAssetToken.balance, selectedAllowAssetToken.decimals);
  }

  function getAssetPrice(symbol: string): number {
    return getAssetUsdPrice(symbol);
  }

  function getAssetValue(tokenId: number, amount: bigint, symbolOverride?: string): number {
    const info = getTokenInfo(tokenId);
    const symbol = symbolOverride ?? info.symbol ?? 'UNK';
    return amountToUsd(amount, info.decimals, symbol);
  }

  function getExternalValue(token: ExternalToken): number {
    return amountToUsd(token.balance, token.decimals ?? 18, token.symbol);
  }

  function calculatePortfolioValue(reserves: Map<number | string, bigint>): number {
    let total = 0;
    for (const [tokenId, amount] of reserves.entries()) {
      total += getAssetValue(Number(tokenId), amount);
    }
    return total;
  }

  // Calculate totals for the three buckets
  $: externalTotal = (() => {
    let total = 0;
    for (const token of externalTokens) {
      if (token.balance > 0n) {
        total += getExternalValue(token);
      }
    }
    return total;
  })();

  $: reservesTotal = calculatePortfolioValue(onchainReserves);

  $: accountsData = (() => {
    let outbound = 0;
    let inbound = 0;
    let outCollateral = 0; // collateral on our out side
    let outOurCredit = 0;  // unused credit we set (our risk)
    let count = 0;
    if (replica?.state?.accounts) {
      for (const [counterpartyId, account] of replica.state.accounts.entries()) {
        count++;
        if (account.deltas) {
          for (const [tokenId, delta] of account.deltas.entries()) {
            const info = getTokenInfo(Number(tokenId));
            const divisor = BigInt(10) ** BigInt(info.decimals);
            const price = getAssetPrice(info.symbol ?? 'UNK');
            const valueOf = (amount: bigint) => (Number(amount) / Number(divisor)) * price;
            const isLeftEntity = String(tab.entityId || '').toLowerCase() < String(counterpartyId || '').toLowerCase();
            const derived = activeXlnFunctions?.deriveDelta?.(delta, isLeftEntity);
            if (!derived) continue;

            if (derived.outCapacity > 0n) outbound += valueOf(derived.outCapacity);
            if (derived.inCapacity > 0n) inbound += valueOf(derived.inCapacity);
            // outCapacity = outPeerCredit + outCollateral + outOwnCredit
            if (derived.outCollateral > 0n) outCollateral += valueOf(derived.outCollateral);
            if (derived.outOwnCredit > 0n) outOurCredit += valueOf(derived.outOwnCredit);
          }
        }
      }
    }
    return {
      outbound,
      inbound,
      outCollateral,
      outOurCredit,
      count,
      total: outbound,
    };
  })();

  $: disputedAccounts = (() => {
    const out: Array<{ counterpartyId: string; status: string }> = [];
    const accounts = replica?.state?.accounts;
    if (!(accounts instanceof Map)) return out;
    for (const [counterpartyId, account] of accounts.entries()) {
      const activeDispute = account.activeDispute;
      const status = String(account.status || '');
      const isFinalizedDisputed = status === 'disputed' && !activeDispute;
      if (!isFinalizedDisputed) continue;
      out.push({ counterpartyId: String(counterpartyId), status: 'disputed' });
    }
    return out.sort((a, b) => a.counterpartyId.localeCompare(b.counterpartyId));
  })();

  $: netWorth = externalTotal + reservesTotal + accountsData.total;

  type EntityFrameActivityRow = {
    id: string;
    height: number;
    timestamp: number;
    accountId: string;
    accountLabel: string;
    kind: 'pending' | 'mempool' | 'confirmed';
    actor: 'you' | 'peer' | 'system';
    actorSide: 'L' | 'R' | '';
    actorLabel: string;
    frameLabel: string;
    statusLabel: string;
    txCount: number;
    types: Array<{ type: string; count: number }>;
  };

  function formatTime(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '-';
    return new Date(ms).toLocaleTimeString();
  }

  function entityTxTypeLabel(type: string): string {
    const known: Record<string, string> = {
      htlcPayment: 'HTLC Payment',
      directPayment: 'Direct Payment',
      openAccount: 'Open Account',
      extendCredit: 'Extend Credit',
      requestCollateral: 'Request Collateral',
      set_rebalance_policy: 'Set Rebalance Policy',
      deposit_collateral: 'Deposit Collateral',
      settle_approve: 'Settle Approve',
      settle_finalize: 'Settle Finalize',
      disputeStart: 'Dispute Start',
      disputeFinalize: 'Dispute Finalize',
      reopenDisputedAccount: 'Reopen Disputed',
      placeSwapOffer: 'Swap Offer',
      requestSwapCancel: 'Swap Cancel Request',
      j_broadcast: 'J Broadcast',
      j_rebroadcast: 'J Rebroadcast',
      j_clear_batch: 'J Clear Batch',
      j_abort_sent_batch: 'J Abort Sent Batch',
      'profile-update': 'Profile Update',
      setHubConfig: 'Hub Config',
    };
    if (known[type]) return known[type];
    return String(type || 'unknown')
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  $: entityHeightBadge = Number(replica?.state?.height ?? 0);
  $: finalizedJHeightBadge = Number(replica?.state?.lastFinalizedJHeight ?? 0);
  function activityAccountLabel(counterpartyId: string): string {
    const raw = String(counterpartyId || '');
    if (!raw) return 'Unknown account';
    return resolveEntityName(raw, activeEnv) || formatEntityId(raw);
  }

  function frameActorMeta(account: AccountMachine, byLeft: boolean | undefined): {
    actor: 'you' | 'peer' | 'system';
    actorSide: 'L' | 'R' | '';
    actorLabel: string;
  } {
    const localEntity = String(replica?.state?.entityId || tab.entityId || '').toLowerCase();
    const leftEntity = String(account?.leftEntity || '').toLowerCase();
    const localIsLeft = Boolean(localEntity && leftEntity && localEntity === leftEntity);
    if (typeof byLeft !== 'boolean') {
      return { actor: 'system', actorSide: '', actorLabel: 'System' };
    }
    const actorSide = byLeft ? 'L' : 'R';
    const actor = byLeft === localIsLeft ? 'you' : 'peer';
    return {
      actor,
      actorSide,
      actorLabel: `${actor === 'you' ? 'You' : 'Peer'} (${actorSide})`,
    };
  }

  $: entityActivityRows = (() => {
    const rows: EntityFrameActivityRow[] = [];
    const accounts = replica?.state?.accounts;
    if (!(accounts instanceof Map) || accounts.size === 0) return rows;

    for (const [counterpartyId, account] of accounts.entries()) {
      const accountId = String(counterpartyId || '');
      const accountLabel = activityAccountLabel(accountId);
      const pushRow = (
        kind: 'pending' | 'mempool' | 'confirmed',
        frameLabel: string,
        statusLabel: string,
        height: number,
        timestamp: number,
        txs: Array<{ type?: string }>,
        byLeft?: boolean,
      ) => {
        if (!Array.isArray(txs) || txs.length === 0) return;
        const grouped = new Map<string, number>();
        for (const tx of txs) {
          const type = String(tx?.type || 'unknown');
          grouped.set(type, (grouped.get(type) || 0) + 1);
        }
        const actorMeta = frameActorMeta(account, byLeft);
        rows.push({
          id: `entity-activity-${accountId}-${kind}-${height}-${timestamp}`,
          height,
          timestamp,
          accountId,
          accountLabel,
          kind,
          actor: actorMeta.actor,
          actorSide: actorMeta.actorSide,
          actorLabel: actorMeta.actorLabel,
          frameLabel,
          statusLabel,
          txCount: txs.length,
          types: Array.from(grouped.entries()).map(([type, count]) => ({ type, count })),
        });
      };

      if (account.pendingFrame) {
        pushRow(
          'pending',
          `Pending Frame #${Number(account.pendingFrame.height || 0)}`,
          'Awaiting Consensus',
          Number(account.pendingFrame.height || 0),
          Number(account.pendingFrame.timestamp || 0),
          Array.isArray(account.pendingFrame.accountTxs) ? account.pendingFrame.accountTxs : [],
          account.pendingFrame.byLeft,
        );
      }

      if (Array.isArray(account.mempool) && account.mempool.length > 0) {
        const pendingHeight = Number(account.pendingFrame?.height || 0);
        pushRow(
          'mempool',
          'Mempool Queue',
          `${account.mempool.length} queued`,
          pendingHeight > 0 ? pendingHeight : Number(account.currentHeight || 0),
          Number(account.pendingFrame?.timestamp || account.currentFrame?.timestamp || 0),
          account.mempool,
          account.leftEntity === (replica?.state?.entityId || tab.entityId),
        );
      }

      const frames = Array.isArray(account.frameHistory) ? account.frameHistory.slice(-12) : [];
      for (const frame of frames) {
        pushRow(
          'confirmed',
          `Frame #${Number(frame.height || 0)}`,
          'Confirmed',
          Number(frame.height || 0),
          Number(frame.timestamp || 0),
          Array.isArray(frame.accountTxs) ? frame.accountTxs : [],
          frame.byLeft,
        );
      }
    }
    return rows.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
      if (a.height !== b.height) return b.height - a.height;
      return a.accountLabel.localeCompare(b.accountLabel);
    });
  })();

  // Handlers
  function handleEntitySelect(event: CustomEvent) {
    const { jurisdiction, signerId, entityId } = event.detail;
    selectedAccountId = null;
    dispatch('entitySelect', event.detail);
    if (userModeHeader) return;
    tab = { ...tab, jurisdiction, signerId, entityId };
  }

  function handleSignerSelect(event: CustomEvent<{ signerId: string }>) {
    selectedAccountId = null;
    dispatch('signerSelect', event.detail);
    if (userModeHeader) return;
    tab = { ...tab, signerId: event.detail.signerId, entityId: '' };
  }

  function handleHeaderAddSigner() {
    dispatch('addSigner');
  }

  function handleHeaderAddEntity() {
    dispatch('addEntity');
  }

  function handleHeaderAddJurisdiction() {
    dispatch('addJurisdiction');
  }

  function handleHeaderAddRuntime() {
    dispatch('addRuntime');
  }

  function handleHeaderDeleteRuntime(event: CustomEvent<{ runtimeId: string }>) {
    dispatch('deleteRuntime', event.detail);
  }

  function handleAccountSelect(event: CustomEvent) {
    const nextRaw = String(event.detail?.accountId || '').trim();
    selectedAccountId = nextRaw || null;
    if (!nextRaw) return;
    const matched = workspaceAccountIds.find((id) => String(id).toLowerCase() === nextRaw.toLowerCase());
    if (matched) workspaceAccountId = matched;
  }

  function handleJurisdictionSelect(event: CustomEvent<{ selected: string | null }>) {
    const next = event.detail?.selected ?? event.detail?.name ?? null;
    dispatch('jurisdictionSelect', next ? { name: next } : { name: null });
    if (next) selectedJurisdictionName = next;
  }

  function handleBackToAccounts() {
    selectedAccountId = null;
    activeTab = 'accounts';
    accountWorkspaceTab = 'activity';
  }

  function handleAccountPanelGoToOpenAccounts() {
    selectedAccountId = null;
    activeTab = 'accounts';
    accountWorkspaceTab = 'open';
  }

  function goToLive() {
    // Jump to live frame
    timeOperations.goToLive();
  }

  function countBatchOps(batch: JBatch | null | undefined): number {
    if (!batch) return 0;
    return (batch.reserveToCollateral?.length || 0) +
           (batch.collateralToReserve?.length || 0) +
           (batch.settlements?.length || 0) +
           (batch.reserveToReserve?.length || 0) +
           (batch.disputeStarts?.length || 0) +
           (batch.disputeFinalizations?.length || 0) +
           (batch.externalTokenToReserve?.length || 0) +
           (batch.reserveToExternalToken?.length || 0) +
           (batch.revealSecrets?.length || 0);
  }

  // Tab config
  // Pending batch count for Accounts tab badge
  $: pendingBatchCount = (() => {
    if (!replica?.state) return 0;
    const jBatchState = replica.state.jBatchState;
    const draft = countBatchOps(jBatchState?.batch);
    const sent = countBatchOps(jBatchState?.sentBatch?.batch);
    return draft > 0 ? draft : sent;
  })();

  const tabs: IconBadgeTabConfig<ViewTab>[] = [
    { id: 'assets', icon: Landmark, label: 'Assets' },
    { id: 'accounts', icon: Users, label: 'Accounts', showBadge: true, badgeType: 'pending' },
    { id: 'more', icon: MoreHorizontal, label: 'More' },
    { id: 'settings', icon: SettingsIcon, label: 'Settings' },
  ];

  const moreTabs: IconTabConfig<MoreTab>[] = [
    { id: 'consensus', icon: Activity, label: 'Consensus' },
    { id: 'chat', icon: MessageCircle, label: 'Chat' },
    { id: 'contacts', icon: BookUser, label: 'Contacts' },
    { id: 'create', icon: PlusCircle, label: 'Create' },
    { id: 'gossip', icon: Globe, label: 'Gossip' },
    { id: 'governance', icon: Scale, label: 'Governance' },
  ];

  const accountWorkspaceTabs: IconPendingTabConfig<AccountWorkspaceTab>[] = [
    { id: 'open', icon: PlusCircle, label: 'Open Account' },
    { id: 'send', icon: ArrowUpRight, label: 'Pay' },
    { id: 'receive', icon: ArrowDownLeft, label: 'Receive' },
    { id: 'swap', icon: Repeat, label: 'Swap' },
    { id: 'configure', icon: SettingsIcon, label: 'Configure' },
    { id: 'appearance', icon: SlidersHorizontal, label: 'Appearance' },
    { id: 'activity', icon: Activity, label: 'Activity' },
    { id: 'settle', icon: Landmark, label: 'Settle', showPendingBatch: true },
  ];
  $: hasWorkspaceAccounts = workspaceAccountIds.length > 0;
  $: visibleAccountWorkspaceTabs = hasWorkspaceAccounts
    ? accountWorkspaceTabs
    : accountWorkspaceTabs.filter((tabConfig) => tabConfig.id === 'open');
  $: if (!hasWorkspaceAccounts && accountWorkspaceTab !== 'open') {
    accountWorkspaceTab = 'open';
  }
  let lastDeepLinkWorkspaceSignature = '';
  $: {
    const signature = `${getUrlHashRoute() || ''}|${workspaceAccountIds.length}|${accountIds.length}`;
    if (signature !== lastDeepLinkWorkspaceSignature) {
      lastDeepLinkWorkspaceSignature = signature;
      applyDeepLinkViewFromUrl();
    }
  }
</script>

<div class="entity-panel" data-panel-id={tab.id}>
  <!-- Header -->
  {#if !hideHeader && !userModeHeader}
    <header class="header" class:user-mode-header={userModeHeader}>
      {#if showJurisdiction}
        <JurisdictionDropdown
          bind:selected={selectedJurisdictionName}
          on:select={handleJurisdictionSelect}
        />
      {/if}
      <EntityDropdown
        {tab}
        on:entitySelect={handleEntitySelect}
      />
    </header>
  {/if}

  <!-- Historical Mode Warning -->
  {#if !activeIsLive}
    <div class="history-warning" on:click={goToLive}>
      <AlertTriangle size={14} />
      <span>Viewing historical state. Click to go LIVE.</span>
    </div>
  {/if}

  <!-- Main Content - SINGLE SCROLL -->
  <main class="main-scroll">
    {#if !tab.entityId || !tab.signerId}
      <div class="empty-state">
        <Wallet size={40} />
        <h3>Select Entity</h3>
        <p>{userModeHeader ? 'Choose from the context pill above' : 'Choose from the dropdown above'}</p>
      </div>

    {:else if isAccountFocused && selectedAccount && selectedAccountId}
      <div class="focused-view">
        {#key selectedAccountId}
        <AccountPanel
          account={selectedAccount}
          counterpartyId={selectedAccountId}
          entityId={tab.entityId}
          {replica}
          {tab}
          on:back={handleBackToAccounts}
          on:faucet={handleAccountFaucet}
          on:goToOpenAccounts={handleAccountPanelGoToOpenAccounts}
        />
        {/key}
      </div>

    {:else if replica}
      <!-- Hero: Entity + Net Worth -->
      <section class="hero">
        <div class="hero-left" class:user-mode={userModeHeader}>
          {#if !userModeHeader}
            {#if avatarUrl}
              <img src={avatarUrl} alt="Entity avatar" class="hero-avatar" />
            {:else}
              <div class="hero-avatar placeholder">
                {activeXlnFunctions?.getEntityShortId?.(tab.entityId)?.slice(0,2) || '??'}
              </div>
            {/if}
          {/if}
          <div class="hero-identity" class:user-mode={userModeHeader}>
            {#if userModeHeader}
              <div class="hero-context-switcher">
                <ContextSwitcher
                  {tab}
                  allowAddRuntime={allowHeaderAddRuntime}
                  allowDeleteRuntime={allowHeaderDeleteRuntime}
                  addRuntimeLabel={headerRuntimeAddLabel}
                  on:addRuntime={handleHeaderAddRuntime}
                  on:deleteRuntime={handleHeaderDeleteRuntime}
                  on:entitySelect={handleEntitySelect}
                />
              </div>
            {:else}
              <span class="hero-name">{heroDisplayName}</span>
            {/if}
            <button class="hero-address" on:click={copyAddress} title="Copy full address">
              <span>{replica?.state?.entityId || tab.entityId}</span>
              {#if addressCopied}
                <Check size={10} />
              {:else}
                <Copy size={10} />
              {/if}
            </button>
          </div>
        </div>
        <div class="hero-right">
          <div class="hero-networth">{formatCompact(netWorth)}</div>
          <div class="hero-label">Net Worth</div>
          <div class="hero-breakdown">
            <span>External {formatCompact(externalTotal)}</span>
            <span>+</span>
            <span>Reserve {formatCompact(reservesTotal)}</span>
            <span>+</span>
            <span>Accounts {formatCompact(accountsData.total)}</span>
          </div>
        </div>
      </section>

      <!-- Tab Bar -->
      <nav class="tabs">
        {#each tabs as t}
          <button
            class="tab"
            class:active={activeTab === t.id}
            data-testid={`tab-${t.id}`}
            on:click={() => activeTab = t.id}
          >
            <svelte:component this={t.icon} size={14} />
            <span>{t.label}</span>
            {#if t.showBadge && t.badgeType === 'pending' && pendingBatchCount > 0}
              <span class="badge pending">{pendingBatchCount}</span>
            {/if}
          </button>
        {/each}
      </nav>

      <!-- Tab Content -->
      <section class="content">
        {#if activeTab === 'assets'}
          <div class="tab-header-row">
            <div class="asset-title-block">
              <h4 class="section-head" style="margin: 0;">Assets</h4>
              <p class="muted asset-ledger-note">External wallet, reserves, and spendable account capacity in one ledger.</p>
            </div>
            <div class="header-actions">
              <select class="auto-refresh-select" value={$settings.balanceRefreshMs ?? 15000} on:change={updateBalanceRefresh}>
                {#each REFRESH_OPTIONS as opt}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
              <button class="btn-refresh-small" data-testid="asset-ledger-refresh" on:click={() => refreshBalances()} disabled={externalTokensLoading}>
                {externalTokensLoading ? '...' : 'Refresh'}
              </button>
            </div>
          </div>
          <div class="asset-ledger-meta">
            <div class="wallet-meta-block">
              <p class="muted wallet-label">EOA</p>
              <p class="wallet-meta-value">{tab.signerId || '-'}</p>
              <p class="muted wallet-meta-help">Native ETH and ERC20 wallet address.</p>
            </div>
            <div class="wallet-meta-block">
              <p class="muted wallet-label">Entity</p>
              <p class="wallet-meta-value">{replica?.state?.entityId || tab.entityId}</p>
              <p class="muted wallet-meta-help">XLN identity for reserves, accounts, and consensus.</p>
            </div>
          </div>

          <div class="token-table-header asset-ledger-header">
            <span class="col-token">Asset</span>
            <span class="col-balance">External</span>
            <span class="col-balance">Reserve</span>
            <span class="col-balance">Accounts</span>
          </div>
          <div class="token-table asset-ledger-table" class:is-refreshing={externalTokensLoading}>
            {#each assetLedgerRows as row}
              <div class="token-table-row asset-ledger-row" class:has-balance={row.externalBalance > 0n || row.reserveBalance > 0n} data-testid={`asset-row-${row.symbol}`}>
                <div class="col-token">
                  <span class="token-icon-small" class:usdc={row.symbol === 'USDC'} class:weth={row.symbol === 'WETH' || row.symbol === 'ETH'} class:usdt={row.symbol === 'USDT'}>
                    {row.symbol.slice(0, 1)}
                  </span>
                  <div class="asset-name-block">
                    <span class="token-name">{row.symbol}</span>
                    <span class="asset-kind">{row.isNative ? 'Native gas' : 'ERC20 / reserve'}</span>
                  </div>
                </div>
                <div class="col-balance asset-balance-block">
                  <span class="balance-text" class:zero={row.externalBalance === 0n} data-testid={`external-balance-${row.symbol}`}>
                    {formatAmount(row.externalBalance, row.decimals)}
                  </span>
                  <span class="value-text subtle">{formatApproxUsd(row.externalUsd)}</span>
                </div>
                <div class="col-balance asset-balance-block">
                  <span class="balance-text" class:zero={row.reserveBalance === 0n} data-testid={`reserve-balance-${row.symbol}`}>
                    {row.tokenId && row.tokenId > 0 ? formatAmount(row.reserveBalance, row.decimals) : '—'}
                  </span>
                  <span class="value-text subtle">{row.tokenId && row.tokenId > 0 ? formatApproxUsd(row.reserveUsd) : '—'}</span>
                </div>
                <div class="col-balance asset-balance-block">
                  <span class="balance-text" class:zero={row.accountBalance === 0n} data-testid={`account-spendable-${row.symbol}`}>
                    {row.tokenId && row.tokenId > 0 ? formatAmount(row.accountBalance, row.decimals) : '—'}
                  </span>
                  <span class="value-text subtle">{row.tokenId && row.tokenId > 0 ? formatApproxUsd(row.accountUsd) : '—'}</span>
                </div>
              </div>
            {/each}
            <div class="token-table-row asset-ledger-row asset-ledger-total" data-testid="asset-ledger-total">
              <div class="col-token asset-ledger-total-label">
                <div class="asset-name-block">
                  <span class="token-name">Net Worth</span>
                  <span class="asset-kind">Total {formatApproxUsd(assetLedgerGrandTotal)}</span>
                </div>
              </div>
              <div class="col-balance asset-balance-block">
                <span class="balance-text">{formatApproxUsd(assetLedgerTotals.externalUsd)}</span>
                <span class="value-text subtle">External</span>
              </div>
              <div class="col-balance asset-balance-block">
                <span class="balance-text">{formatApproxUsd(assetLedgerTotals.reserveUsd)}</span>
                <span class="value-text subtle">Reserve</span>
              </div>
              <div class="col-balance asset-balance-block">
                <span class="balance-text">{formatApproxUsd(assetLedgerTotals.accountUsd)}</span>
                <span class="value-text subtle">Accounts</span>
              </div>
            </div>
          </div>
          <nav class="account-workspace-tabs asset-workspace-tabs" aria-label="Asset workspace">
              <button class="account-workspace-tab" data-testid="asset-tab-faucet" class:active={assetWorkspaceTab === 'faucet'} on:click={() => assetWorkspaceTab = 'faucet'}>
                <span>Faucet</span>
              </button>
              <button class="account-workspace-tab" data-testid="asset-tab-deposit" class:active={assetWorkspaceTab === 'e2r'} on:click={() => assetWorkspaceTab = 'e2r'}>
                <span>External → Reserve</span>
              </button>
              <button class="account-workspace-tab" data-testid="asset-tab-r2c" class:active={assetWorkspaceTab === 'r2c'} on:click={() => assetWorkspaceTab = 'r2c'}>
                <span>Reserve → Collateral</span>
              </button>
              <button class="account-workspace-tab" data-testid="asset-tab-c2r" class:active={assetWorkspaceTab === 'c2r'} on:click={() => assetWorkspaceTab = 'c2r'}>
                <span>Collateral → Reserve</span>
              </button>
              <button class="account-workspace-tab" data-testid="asset-tab-withdraw" class:active={assetWorkspaceTab === 'r2e'} on:click={() => assetWorkspaceTab = 'r2e'}>
                <span>Reserve → External</span>
              </button>
              <button class="account-workspace-tab" data-testid="asset-tab-send" class:active={assetWorkspaceTab === 'send'} on:click={() => assetWorkspaceTab = 'send'}>
                <span>External Send</span>
              </button>
              <button class="account-workspace-tab" data-testid="asset-tab-allow" class:active={assetWorkspaceTab === 'allow'} on:click={() => assetWorkspaceTab = 'allow'}>
                <span>External Allow</span>
              </button>
          </nav>

            <section class="asset-action-card">
              {#if assetWorkspaceTab === 'faucet'}
                <h4 class="section-head">Faucet</h4>
                <p class="muted">Top up your EOA, reserve, or first available account for fast testing.</p>
                <div class="asset-form-grid">
                  <label class="asset-field">
                    <span>Asset</span>
                    <select bind:value={faucetAssetSymbol} data-testid="asset-faucet-symbol">
                      {#each externalTokens as token}
                        <option value={token.symbol}>{token.symbol}</option>
                      {/each}
                    </select>
                  </label>
                </div>
                <div class="asset-action-row">
                  <button class="btn-table-action faucet" data-testid={`external-faucet-${faucetAssetSymbol}`} on:click={() => submitAssetFaucet('external')}>
                    Faucet External
                  </button>
                  <button
                    class="btn-table-action deposit"
                    data-testid={`reserve-faucet-${faucetAssetSymbol}`}
                    on:click={() => submitAssetFaucet('reserve')}
                    disabled={!findReserveTransferTokenBySymbol(faucetAssetSymbol)}
                    title={!findReserveTransferTokenBySymbol(faucetAssetSymbol) ? 'Reserve faucet supports ERC20 assets only' : 'Faucet reserve'}
                  >
                    Faucet Reserve
                  </button>
                  <button
                    class="btn-table-action faucet"
                    data-testid={`account-faucet-${faucetAssetSymbol}`}
                    on:click={() => submitAssetFaucet('account')}
                    disabled={!findReserveTransferTokenBySymbol(faucetAssetSymbol) || workspaceAccountIds.length === 0}
                    title={workspaceAccountIds.length === 0 ? 'Open an account first' : 'Faucet first available account'}
                  >
                    Faucet Account
                  </button>
                </div>
              {:else if assetWorkspaceTab === 'e2r'}
                <h4 class="section-head">External → Reserve</h4>
                <p class="muted">Deposit ERC20 from your signer wallet into entity reserves.</p>
                <label class="asset-field asset-field-wide">
                  <span>Amount</span>
                  <div class="asset-amount-shell combined">
                    <input
                      type="text"
                      bind:value={externalToReserveAmount}
                      placeholder="0.00"
                      data-testid="external-to-reserve-amount"
                    />
                    <div class="asset-inline-controls">
                      <button
                        type="button"
                        class="asset-max-hint text-link"
                        on:click={fillExternalToReserveMax}
                        disabled={!selectedExternalToReserveToken || selectedExternalToReserveToken.balance <= 0n}
                      >
                        {selectedExternalToReserveToken ? formatInlineFillAmount(selectedExternalToReserveToken.balance, selectedExternalToReserveToken.decimals) : '0'}
                      </button>
                      <select class="asset-token-select-inline compact" bind:value={externalToReserveSymbol} data-testid="external-to-reserve-symbol">
                        {#each transferableAssetOptions as token}
                          <option value={token.symbol}>{token.symbol}</option>
                        {/each}
                      </select>
                    </div>
                  </div>
                </label>
                <div class="asset-action-row">
                  <button
                    class="btn-table-action deposit"
                    data-testid={`external-deposit-${externalToReserveSymbol}`}
                    on:click={submitExternalToReserve}
                    disabled={depositingToken === externalToReserveSymbol || !externalToReserveAmount.trim()}
                  >
                    {depositingToken === externalToReserveSymbol ? 'Moving...' : 'Move To Reserve'}
                  </button>
                </div>
              {:else if assetWorkspaceTab === 'r2c'}
                <h4 class="section-head">Reserve → Collateral</h4>
                <p class="muted">Move reserve balance into one selected bilateral account.</p>
                <div class="asset-form-grid">
                  <div class="asset-field asset-field-wide">
                    <EntityInput
                      label="Account"
                      value={workspaceAccountId}
                      entities={workspaceAccountIds}
                      {contacts}
                      excludeId={replica?.state?.entityId || tab.entityId}
                      placeholder="Select account..."
                      disabled={!activeIsLive || workspaceAccountIds.length === 0}
                      on:change={handleWorkspaceAccountChange}
                    />
                  </div>
                </div>
                <label class="asset-field asset-field-wide">
                  <span>Amount</span>
                  <div class="asset-amount-shell combined">
                    <input
                      type="text"
                      bind:value={reserveToCollateralAmount}
                      placeholder="0.00"
                      data-testid="reserve-to-collateral-amount"
                    />
                    <div class="asset-inline-controls">
                      <button
                        type="button"
                        class="asset-max-hint text-link"
                        on:click={fillReserveToCollateralMax}
                        disabled={!selectedReserveToCollateralToken || (onchainReserves.get(selectedReserveToCollateralToken.tokenId) ?? 0n) <= 0n}
                      >
                        {#if selectedReserveToCollateralToken}{formatInlineFillAmount(onchainReserves.get(selectedReserveToCollateralToken.tokenId) ?? 0n, selectedReserveToCollateralToken.decimals)}{:else}0{/if}
                      </button>
                      <select class="asset-token-select-inline compact" bind:value={reserveToCollateralSymbol} data-testid="reserve-to-collateral-symbol">
                        {#each transferableAssetOptions as token}
                          <option value={token.symbol}>{token.symbol}</option>
                        {/each}
                      </select>
                    </div>
                  </div>
                </label>
                <div class="asset-action-row">
                  <button
                    class="btn-table-action deposit"
                    data-testid={`reserve-to-collateral-${reserveToCollateralSymbol}`}
                    on:click={submitReserveToCollateral}
                    disabled={collateralFundingToken === reserveToCollateralSymbol || !workspaceAccountId || !reserveToCollateralAmount.trim()}
                  >
                    {collateralFundingToken === reserveToCollateralSymbol ? 'Moving...' : 'Move To Collateral'}
                  </button>
                </div>
              {:else if assetWorkspaceTab === 'c2r'}
                <h4 class="section-head">Collateral → Reserve</h4>
                <p class="muted">Move settled collateral from one selected bilateral account back into reserve.</p>
                <div class="asset-form-grid">
                  <div class="asset-field asset-field-wide">
                    <EntityInput
                      label="Account"
                      value={workspaceAccountId}
                      entities={workspaceAccountIds}
                      {contacts}
                      excludeId={replica?.state?.entityId || tab.entityId}
                      placeholder="Select account..."
                      disabled={!activeIsLive || workspaceAccountIds.length === 0}
                      on:change={handleWorkspaceAccountChange}
                    />
                  </div>
                </div>
                <label class="asset-field asset-field-wide">
                  <span>Amount</span>
                  <div class="asset-amount-shell combined">
                    <input
                      type="text"
                      bind:value={collateralToReserveAmount}
                      placeholder="0.00"
                      data-testid="collateral-to-reserve-amount"
                    />
                    <div class="asset-inline-controls">
                      <button
                        type="button"
                        class="asset-max-hint text-link"
                        on:click={fillCollateralToReserveMax}
                        disabled={!selectedCollateralToReserveToken || getWorkspaceWithdrawableCollateral(selectedCollateralToReserveToken.tokenId) <= 0n}
                      >
                        {#if selectedCollateralToReserveToken}{formatInlineFillAmount(getWorkspaceWithdrawableCollateral(selectedCollateralToReserveToken.tokenId), selectedCollateralToReserveToken.decimals)}{:else}0{/if}
                      </button>
                      <select class="asset-token-select-inline compact" bind:value={collateralToReserveSymbol} data-testid="collateral-to-reserve-symbol">
                        {#each transferableAssetOptions as token}
                          <option value={token.symbol}>{token.symbol}</option>
                        {/each}
                      </select>
                    </div>
                  </div>
                </label>
                <div class="asset-action-row">
                  <button
                    class="btn-table-action deposit"
                    data-testid={`collateral-to-reserve-${collateralToReserveSymbol}`}
                    on:click={submitCollateralToReserve}
                    disabled={!workspaceAccountId || !collateralToReserveAmount.trim()}
                  >
                    Move To Reserve
                  </button>
                </div>
              {:else if assetWorkspaceTab === 'r2e'}
                <h4 class="section-head">Reserve → External</h4>
                <p class="muted">Withdraw ERC20 from reserve back to your signer wallet.</p>
                <label class="asset-field asset-field-wide">
                  <span>Amount</span>
                  <div class="asset-amount-shell combined">
                    <input
                      type="text"
                      bind:value={reserveToExternalAmount}
                      placeholder="0.00"
                      data-testid={`reserve-withdraw-input-${reserveToExternalSymbol}`}
                    />
                    <div class="asset-inline-controls">
                      <button
                        type="button"
                        class="asset-max-hint text-link"
                        on:click={fillReserveToExternalMax}
                        disabled={!selectedReserveToExternalToken || (onchainReserves.get(selectedReserveToExternalToken.tokenId) ?? 0n) <= 0n}
                      >
                        {#if selectedReserveToExternalToken}{formatInlineFillAmount(onchainReserves.get(selectedReserveToExternalToken.tokenId) ?? 0n, selectedReserveToExternalToken.decimals)}{:else}0{/if}
                      </button>
                      <select class="asset-token-select-inline compact" bind:value={reserveToExternalSymbol} data-testid="reserve-to-external-symbol">
                        {#each transferableAssetOptions as token}
                          <option value={token.symbol}>{token.symbol}</option>
                        {/each}
                      </select>
                    </div>
                  </div>
                </label>
                <div class="asset-action-row">
                  <button
                    class="btn-table-action deposit"
                    data-testid={`reserve-withdraw-${reserveToExternalSymbol}`}
                    on:click={submitReserveToExternal}
                    disabled={withdrawingExternalToken === reserveToExternalSymbol || !reserveToExternalAmount.trim()}
                  >
                    {withdrawingExternalToken === reserveToExternalSymbol ? 'Moving...' : 'Move To External'}
                  </button>
                </div>
              {:else if assetWorkspaceTab === 'send'}
                <h4 class="section-head">External Send</h4>
                <p class="muted">Transfer native ETH or ERC20 directly from your signer EOA.</p>
                <label class="asset-field asset-field-wide">
                  <span>Amount</span>
                  <div class="asset-amount-shell combined">
                    <input type="text" bind:value={sendAssetAmount} placeholder="0.00" data-testid="asset-send-amount" />
                    <div class="asset-inline-controls">
                      <button
                        type="button"
                        class="asset-max-hint text-link"
                        on:click={fillSendAssetMax}
                        disabled={!selectedSendAssetToken || selectedSendAssetToken.balance <= 0n}
                      >
                        {selectedSendAssetToken ? formatInlineFillAmount(selectedSendAssetToken.balance, selectedSendAssetToken.decimals) : '0'}
                      </button>
                      <select class="asset-token-select-inline compact" bind:value={sendAssetSymbol} data-testid="asset-send-symbol">
                        {#each externalTokens as token}
                          <option value={token.symbol}>{token.symbol}</option>
                        {/each}
                      </select>
                    </div>
                  </div>
                </label>
                <div class="asset-form-grid">
                  <label class="asset-field asset-field-wide">
                    <span>Recipient EOA</span>
                    <input type="text" bind:value={sendAssetRecipient} placeholder="0x..." data-testid="asset-send-recipient" />
                  </label>
                </div>
                <div class="asset-action-row">
                  <button
                    class="btn-table-action deposit"
                    data-testid={`asset-send-${sendAssetSymbol}`}
                    on:click={async () => {
                      try {
                        await sendExternalAsset();
                      } catch (err) {
                        toasts.error(`Send failed: ${toErrorMessage(err, 'Unknown error')}`);
                      }
                    }}
                    disabled={sendingExternalToken === sendAssetSymbol || !sendAssetAmount.trim() || !sendAssetRecipient.trim()}
                  >
                    {sendingExternalToken === sendAssetSymbol ? 'Sending...' : 'Send Asset'}
                  </button>
                </div>
              {:else}
                <h4 class="section-head">External Allow</h4>
                <p class="muted">Approve an ERC20 allowance for another contract or protocol.</p>
                <div class="asset-form-grid">
                  <label class="asset-field asset-field-wide">
                    <span>Amount</span>
                    <div class="asset-amount-shell combined">
                      <input type="text" bind:value={allowAssetAmount} placeholder="0.00" data-testid="asset-allow-amount" />
                      <div class="asset-inline-controls">
                        <button
                          type="button"
                          class="asset-max-hint text-link"
                          on:click={fillAllowAssetMax}
                          disabled={!selectedAllowAssetToken || selectedAllowAssetToken.balance <= 0n}
                        >
                          {selectedAllowAssetToken ? formatInlineFillAmount(selectedAllowAssetToken.balance, selectedAllowAssetToken.decimals) : '0'}
                        </button>
                        <select bind:value={allowAssetSymbol} class="asset-token-select-inline compact" data-testid="asset-allow-symbol">
                          {#each transferableAssetOptions as token}
                            <option value={token.symbol}>{token.symbol}</option>
                          {/each}
                        </select>
                      </div>
                    </div>
                  </label>
                </div>
                <div class="asset-form-grid">
                  <label class="asset-field asset-field-wide">
                    <span>Spender</span>
                    <input type="text" bind:value={allowAssetSpender} placeholder="0x..." data-testid="asset-allow-spender" />
                  </label>
                </div>
                <div class="asset-action-row">
                  <button
                    class="btn-table-action deposit"
                    data-testid={`asset-allow-${allowAssetSymbol}`}
                    on:click={async () => {
                      try {
                        await approveExternalAsset();
                      } catch (err) {
                        toasts.error(`Approve failed: ${toErrorMessage(err, 'Unknown error')}`);
                      }
                    }}
                    disabled={approvingExternalToken === allowAssetSymbol || !allowAssetAmount.trim() || !allowAssetSpender.trim()}
                  >
                    {approvingExternalToken === allowAssetSymbol ? 'Approving...' : 'Approve Allowance'}
                  </button>
                </div>
              {/if}
            </section>
        {:else if activeTab === 'accounts'}
          {#if accountIds.length > 5}
            <div class="accounts-selector-row">
              <AccountDropdown
                {replica}
                {selectedAccountId}
                on:accountSelect={handleAccountSelect}
              />
            </div>
          {/if}

          <AccountList
            {replica}
            on:select={handleAccountSelect}
            on:faucet={handleAccountFaucet}
            on:settleApprove={handleQuickSettleApprove}
          />

          <nav class="account-workspace-tabs" aria-label="Account workspace">
            {#each visibleAccountWorkspaceTabs as t}
              <button
                class="account-workspace-tab"
                class:active={accountWorkspaceTab === t.id}
                on:click={() => accountWorkspaceTab = t.id}
              >
                <svelte:component this={t.icon} size={14} />
                <span>{t.label}</span>
                {#if t.showPendingBatch && pendingBatchCount > 0}
                  <span class="workspace-badge pending">{pendingBatchCount}</span>
                {/if}
              </button>
            {/each}
          </nav>

          <section class="account-workspace-content">
            {#if accountWorkspaceTab === 'send'}
              <PaymentPanel entityId={replica.state?.entityId || tab.entityId} {contacts} />

            {:else if accountWorkspaceTab === 'receive'}
              <ReceivePanel entityId={replica.state?.entityId || tab.entityId} />

            {:else if accountWorkspaceTab === 'swap'}
              <SwapPanel
                {replica}
                {tab}
              />

            {:else if accountWorkspaceTab === 'configure'}
              <div class="configure-panel">
                <div class="workspace-inline-selector">
                  <EntityInput
                    label="Configure Account"
                    value={workspaceAccountId}
                    entities={workspaceAccountIds}
                    {contacts}
                    excludeId={replica?.state?.entityId || tab.entityId}
                    placeholder="Select account for configure..."
                    disabled={!activeIsLive || workspaceAccountIds.length === 0}
                    on:change={handleWorkspaceAccountChange}
                  />
                </div>
                <nav class="configure-tabs" aria-label="Account configure workspace">
                  <button
                    class="configure-tab"
                    class:active={configureWorkspaceTab === 'extend-credit'}
                    on:click={() => configureWorkspaceTab = 'extend-credit'}
                  >
                    Extend Credit
                  </button>
                  <button
                    class="configure-tab"
                    class:active={configureWorkspaceTab === 'request-credit'}
                    on:click={() => configureWorkspaceTab = 'request-credit'}
                  >
                    Request Credit
                  </button>
                  <button
                    class="configure-tab"
                    class:active={configureWorkspaceTab === 'collateral'}
                    on:click={() => configureWorkspaceTab = 'collateral'}
                  >
                    Request Collateral
                  </button>
                  <button
                    class="configure-tab"
                    class:active={configureWorkspaceTab === 'token'}
                    on:click={() => configureWorkspaceTab = 'token'}
                  >
                    Add Token
                  </button>
                </nav>

                {#if !workspaceAccountId}
                  <div class="live-required configure-empty">
                    <AlertTriangle size={18} />
                    <p>Select workspace account above first.</p>
                  </div>
                {:else if configureWorkspaceTab === 'extend-credit'}
                  <CreditForm
                    entityId={replica.state?.entityId || tab.entityId}
                    signerId={tab.signerId || null}
                    counterpartyId={workspaceAccountId}
                    accountIds={workspaceAccountIds}
                    mode="extend"
                  />
                {:else if configureWorkspaceTab === 'request-credit'}
                  <CreditForm
                    entityId={replica.state?.entityId || tab.entityId}
                    signerId={tab.signerId || null}
                    counterpartyId={workspaceAccountId}
                    accountIds={workspaceAccountIds}
                    mode="request"
                  />
                {:else if configureWorkspaceTab === 'collateral'}
                  <CollateralForm
                    entityId={replica.state?.entityId || tab.entityId}
                    signerId={tab.signerId || null}
                    counterpartyId={workspaceAccountId}
                    accountIds={workspaceAccountIds}
                  />
                {:else}
                  <div class="configure-token-card">
                    <h4 class="section-head">Add Token To Account</h4>
                    <p class="muted">
                      Adds token delta to selected account (zero credit). Use Extend Credit next to set limit.
                    </p>
                    <div class="configure-token-row">
                      <select class="configure-token-select" bind:value={configureTokenId}>
                        {#each configureTokenOptions as token}
                          <option value={token.id}>{token.symbol}</option>
                        {/each}
                      </select>
                      <button class="btn-add-token" on:click={addTokenToAccount} disabled={!activeIsLive || !workspaceAccountId}>
                        Add Token
                      </button>
                    </div>
                  </div>
                {/if}
              </div>

            {:else if accountWorkspaceTab === 'appearance'}
              <section class="account-appearance-panel">
                <div class="appearance-card">
                  <div class="appearance-head">
                    <div>
                      <h4 class="section-head">Account Bars</h4>
                      <p class="muted">Control how account capacity bars are laid out and scaled inside Accounts.</p>
                    </div>
                  </div>

                  <div class="appearance-block">
                    <span class="appearance-label">Layout</span>
                    <div class="appearance-toggle-group" role="tablist" aria-label="Account bar layout">
                      <button
                        class="appearance-toggle"
                        class:active={$settings.barLayout === 'center'}
                        on:click={() => settingsOperations.setBarLayout('center')}
                      >
                        Center
                      </button>
                      <button
                        class="appearance-toggle"
                        class:active={$settings.barLayout === 'sides'}
                        on:click={() => settingsOperations.setBarLayout('sides')}
                      >
                        Sides
                      </button>
                    </div>
                  </div>

                  <div class="appearance-block">
                    <div class="appearance-scale-row">
                      <span class="appearance-label">Scale</span>
                      <div class="appearance-scale-meta">
                        <span class="appearance-scale-bound">$10</span>
                        <strong class="appearance-scale-value">100px = ${accountBarUsdPer100Px.toLocaleString('en-US')}</strong>
                        <span class="appearance-scale-bound">$10,000</span>
                      </div>
                    </div>
                    <input
                      class="appearance-slider"
                      type="range"
                      min={ACCOUNT_BAR_USD_PER_100PX_MIN}
                      max={ACCOUNT_BAR_USD_PER_100PX_MAX}
                      step="10"
                      value={accountBarUsdPer100Px}
                      on:input={setAccountBarScale}
                    />
                  </div>
                </div>
              </section>

            {:else if accountWorkspaceTab === 'open'}
              <div class="account-open-sections">
                <div class="open-section">
                  <h4 class="section-head">Open Account</h4>
                  <HubDiscoveryPanel
                    entityId={replica?.state?.entityId || tab.entityId}
                    envOverride={isRuntimeEnv(activeEnv) ? activeEnv : null}
                  />
                </div>
                <div class="open-section">
                  <h4 class="section-head">Enter Entity ID</h4>
                  <div class="open-private-form">
                    <EntityInput
                      label="Entity"
                      value={openAccountEntityId}
                      entities={openAccountEntityOptions}
                      {contacts}
                      excludeId={replica?.state?.entityId || tab.entityId}
                      placeholder="Select entity or paste full ID..."
                      disabled={!activeIsLive}
                      on:change={handleOpenAccountTargetChange}
                    />
                    <button class="btn-add" on:click={() => openAccountWithFullId(openAccountEntityId)} disabled={!activeIsLive || !openAccountEntityId.trim()}>
                      Open
                    </button>
                  </div>
                </div>

                {#if disputedAccounts.length > 0}
                  <div class="open-section disputed-section">
                    <h4 class="section-head">Disputed Accounts</h4>
                    <p class="muted" style="margin-top: 0;">Disputed accounts are hidden from the main list. Reopen here after finalize.</p>
                    <div class="disputed-list">
                      {#each disputedAccounts as item (item.counterpartyId)}
                        <div class="disputed-row">
                          <div class="disputed-meta">
                            <div class="disputed-id">{item.counterpartyId}</div>
                            <div class="disputed-state">
                              Finalized disputed account (hidden from main list)
                            </div>
                          </div>
                          <button
                            class="btn-reopen-disputed"
                            on:click={() => reopenDisputedAccount(item.counterpartyId)}
                            disabled={!activeIsLive}
                          >
                            Reopen
                          </button>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>

            {:else if accountWorkspaceTab === 'activity'}
              <h4 class="section-head">Entity Activity</h4>
              {#if entityActivityRows.length === 0}
                <p class="muted">No entity frames with activity yet.</p>
              {:else}
                <div class="entity-activity-list">
                  {#each entityActivityRows as row (row.id)}
                    <article
                      class="entity-frame-row"
                      class:ours={row.actor === 'you'}
                      class:peer={row.actor === 'peer'}
                      class:system={row.actor === 'system'}
                      class:queue={row.kind !== 'confirmed'}
                    >
                      <div class="entity-frame-row-head">
                        <div class="entity-frame-row-left">
                          <span class="entity-height-badge">E#{row.height}</span>
                          <span class="entity-frame-actor">{row.actorLabel}</span>
                          <span class="entity-frame-account">{row.accountLabel}</span>
                          <span class="entity-frame-time">{formatTime(row.timestamp)}</span>
                        </div>
                        <div class="entity-frame-row-meta">
                          <span class="entity-frame-status">{row.statusLabel}</span>
                          <span class="entity-frame-count">{row.txCount} tx</span>
                        </div>
                      </div>
                      <div class="entity-frame-row-subhead">
                        <span>{row.frameLabel}</span>
                        <span>{formatEntityId(row.accountId)}</span>
                      </div>
                      <div class="entity-frame-types">
                        {#each row.types as txType}
                          <span class="entity-frame-chip">
                            {entityTxTypeLabel(txType.type)}{#if txType.count > 1} ×{txType.count}{/if}
                          </span>
                        {/each}
                      </div>
                    </article>
                  {/each}
                </div>
              {/if}

            {:else if accountWorkspaceTab === 'settle'}
              {#if !activeIsLive}
                <div class="live-required">
                  <AlertTriangle size={20} />
                  <p>On-chain actions require LIVE mode</p>
                  <button class="btn-live" on:click={goToLive}>Go to LIVE</button>
                </div>
              {:else}
                {#if !replica?.state?.accounts || replica.state.accounts.size === 0}
                  <div class="live-required" style="margin-bottom: 12px;">
                    <AlertTriangle size={20} />
                    <p>No accounts yet. Open one in Accounts.</p>
                    <button class="btn-live" on:click={() => accountWorkspaceTab = 'open'}>Open Accounts</button>
                  </div>
                {/if}
                <SettlementPanel
                  entityId={replica.state?.entityId || tab.entityId}
                  {replica}
                  {contacts}
                />
              {/if}
            {/if}
          </section>

        {:else if activeTab === 'more'}
          <nav class="more-tabs" aria-label="More tools">
            {#each moreTabs as m}
              <button
                class="more-tab"
                class:active={moreTab === m.id}
                on:click={() => moreTab = m.id}
              >
                <svelte:component this={m.icon} size={14} />
                <span>{m.label}</span>
              </button>
            {/each}
          </nav>

          {#if moreTab === 'consensus'}
            <div class="consensus-summary">
              <h4 class="section-head" style="margin-top: 0;">Consensus</h4>
              <div class="consensus-height-badges">
                <span class="consensus-height-badge">E#{entityHeightBadge}</span>
                <span class="consensus-height-badge">J#{finalizedJHeightBadge}</span>
              </div>
            </div>
            <ConsensusState {replica} />
            <h4 class="section-head">Proposals</h4>
            <ProposalsList {replica} {tab} />

          {:else if moreTab === 'chat'}
            <ChatMessages {replica} {tab} currentTimeIndex={activeTimeIndex ?? -1} />

          {:else if moreTab === 'contacts'}
            <h4 class="section-head">Saved Contacts</h4>
            {#if contacts.length === 0}
              <p class="muted">No contacts saved yet</p>
            {:else}
              {#each contacts as contact, idx}
                <div class="contact-row">
                  <div class="c-info">
                    <span class="c-name">{contact.name}</span>
                    <span class="c-id">{contact.entityId}</span>
                  </div>
                  <button class="c-delete" on:click={() => deleteContact(idx)}>x</button>
                </div>
              {/each}
            {/if}

            <h4 class="section-head">Add Contact</h4>
            <div class="add-contact">
              <input type="text" placeholder="Name" bind:value={newContactName} />
              <input type="text" placeholder="Full Entity ID (0x...)" bind:value={newContactId} />
              <button class="btn-add" on:click={saveContact}>Add</button>
            </div>

          {:else if moreTab === 'create'}
            <FormationPanel />

          {:else if moreTab === 'gossip'}
            <GossipPanel />

          {:else if moreTab === 'governance'}
            <h4 class="section-head">Entity Governance Profile</h4>
            <p class="muted">Updates are submitted through REA as `profile-update` entity transactions.</p>
            <div class="setting-block">
              <label>Display Name</label>
              <input
                type="text"
                bind:value={governanceName}
                placeholder="Entity name"
                maxlength="64"
              />
            </div>
            <div class="setting-block">
              <label>Bio</label>
              <input
                type="text"
                bind:value={governanceBio}
                placeholder="Short description"
                maxlength="180"
              />
            </div>
            <div class="setting-block">
              <label>Website</label>
              <input
                type="url"
                bind:value={governanceWebsite}
                placeholder="https://"
                maxlength="160"
              />
            </div>
            <button class="btn-add" on:click={saveGovernanceProfile} disabled={governanceSaving}>
              {governanceSaving ? 'Submitting...' : 'Save Governance Profile'}
            </button>
          {/if}

        {:else if activeTab === 'settings'}
          <h4 class="section-head">Wallet</h4>
          <WalletSettings embedded={true} />

          <h4 class="section-head">Appearance</h4>
          <div class="theme-grid">
            {#each getAvailableThemes() as theme}
              {@const colors = THEME_DEFINITIONS[theme.id]}
              <button
                class="theme-swatch"
                class:active={$settings.theme === theme.id}
                on:click={() => settingsOperations.setTheme(theme.id)}
                title={theme.name}
              >
                <div class="swatch-preview" style="background: {colors.background}; border-color: {colors.surfaceBorder};">
                  <div class="swatch-bar" style="background: {colors.barCollateral}; width: 60%;"></div>
                  <div class="swatch-bar" style="background: {colors.barDebt}; width: 30%;"></div>
                  <div class="swatch-text" style="color: {colors.textPrimary};">Aa</div>
                  <div class="swatch-accent" style="background: {colors.accentColor};"></div>
                </div>
                <span class="swatch-label" class:active={$settings.theme === theme.id}>{theme.name}</span>
              </button>
            {/each}
          </div>

          <h4 class="section-head">Display</h4>
          <div class="setting-row">
            <span>Compact Numbers</span>
            <button class="toggle" class:on={$settings.compactNumbers}
              on:click={() => settingsOperations.setCompactNumbers(!$settings.compactNumbers)}>
              {$settings.compactNumbers ? 'On' : 'Off'}
            </button>
          </div>
          <div class="setting-row">
            <span>Verbose Logging</span>
            <button class="toggle" class:on={$settings.verboseLogging}
              on:click={() => settingsOperations.setVerboseLogging(!$settings.verboseLogging)}>
              {$settings.verboseLogging ? 'On' : 'Off'}
            </button>
          </div>
          <div class="setting-row">
            <span>Time Machine</span>
            <button
              class="toggle"
              class:on={$settings.showTimeMachine}
              on:click={() => settingsOperations.setShowTimeMachine(!$settings.showTimeMachine)}
            >
              {$settings.showTimeMachine ? 'On' : 'Off'}
            </button>
          </div>
          <div class="setting-row">
            <span>Frame Delay</span>
            <input
              type="number"
              min="0"
              max="10000"
              step="1"
              value={$settings.runtimeDelay}
              on:input={(e) => {
                const val = Math.max(0, Math.min(10000, Number(e.currentTarget.value) || 0));
                settingsOperations.setRuntimeDelay(val);
                const env = activeEnv;
                if (env) {
                  if (!env.runtimeConfig) env.runtimeConfig = { minFrameDelayMs: val, loopIntervalMs: 25 };
                  else env.runtimeConfig.minFrameDelayMs = val;
                }
              }}
              style="width:72px"
            />
            <span class="muted">ms</span>
          </div>

          <h4 class="section-head">Hub Rebalance</h4>
          <div class="setting-block">
            <label>Policy Version (optional override)</label>
            <input type="number" min="1" bind:value={hubPolicyVersion} placeholder="Auto if empty" />
            <div class="muted" style="margin-top: 4px;">
              Leave empty to auto-bump only when rebalance fee policy changes.
            </div>
          </div>
          <div class="setting-block">
            <label>Matching Strategy</label>
            <select bind:value={hubMatchingStrategy}>
              <option value="amount">amount</option>
              <option value="time">time</option>
              <option value="fee">fee</option>
            </select>
          </div>
          <div class="setting-block">
            <label>Routing Fee (PPM)</label>
            <input type="number" min="0" bind:value={hubRoutingFeePPM} />
          </div>
          <div class="setting-block">
            <label>Base Fee (token units)</label>
            <input type="text" bind:value={hubBaseFee} placeholder="e.g. 0.0" />
          </div>
          <div class="setting-block">
            <label>Min Collateral Threshold (token units)</label>
            <input type="text" bind:value={hubMinCollateralThreshold} placeholder="e.g. 0" />
          </div>
          <div class="setting-block">
            <label>Rebalance Base Fee (token units)</label>
            <input type="text" bind:value={hubRebalanceBaseFee} placeholder="e.g. 0.1" />
          </div>
          <div class="setting-block">
            <label>Rebalance Liquidity Fee (bps)</label>
            <input type="number" min="0" bind:value={hubRebalanceLiquidityFeeBps} />
          </div>
          <div class="setting-block">
            <label>Rebalance Gas Fee (token units)</label>
            <input type="text" bind:value={hubRebalanceGasFee} placeholder="e.g. 0.0" />
          </div>
          <div class="setting-block">
            <label>Rebalance Timeout (seconds)</label>
            <input type="number" min="1" bind:value={hubRebalanceTimeoutSeconds} />
          </div>
          <button class="btn-add" on:click={saveHubConfig} disabled={hubConfigSaving || !activeIsLive}>
            {hubConfigSaving ? 'Submitting...' : 'Save Hub Config'}
          </button>
          {#if !activeIsLive}
            <div class="muted" style="margin-top: 6px;">Hub config updates require LIVE mode.</div>
          {/if}

          <h4 class="section-head">Identity</h4>
          <div class="setting-block">
            <label>Entity ID</label>
            <code>{tab.entityId}</code>
          </div>
          <div class="setting-block">
            <label>Signer ID</label>
            <code>{tab.signerId}</code>
          </div>
          <div class="setting-block">
            <label>Jurisdiction</label>
            <code>{selectedJurisdictionName || 'None'}</code>
          </div>
        {/if}
      </section>
    {/if}
  </main>
</div>

<style>
  .entity-panel {
    --space-1: 8px;
    --space-2: 12px;
    --space-3: 16px;
    --space-4: 20px;
    --panel-gutter-x: 16px;
    display: flex;
    flex-direction: column;
    width: min(100%, 1220px);
    height: 100%;
    margin: 0 auto;
    background: #0a0a0a;
    color: #e5e5e5;
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 13px;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: #171412;
    border-bottom: 1px solid #292524;
    flex-shrink: 0;
  }

  .header.user-mode-header {
    gap: 10px;
    padding: 10px var(--panel-gutter-x);
    background: linear-gradient(180deg, #171412 0%, #12100f 100%);
  }

  .header :global(select),
  .header :global(button),
  .header :global(.dropdown-trigger) {
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #a8a29e;
    font-size: 12px;
    padding: 6px 10px;
    cursor: pointer;
  }

  .header-slot {
    min-width: 0;
  }

  .header-slot-runtime {
    flex: 0 1 260px;
  }

  .header-slot-entity {
    flex: 1 1 auto;
  }

  .header-slot-context {
    flex: 1 1 420px;
    max-width: 720px;
  }

  /* History Warning */
  .history-warning {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px;
    background: #422006;
    border-bottom: 1px solid #713f12;
    color: #fbbf24;
    font-size: 12px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .history-warning:hover {
    background: #4a2408;
  }

  /* Main Scroll - SINGLE SCROLLBAR */
  .main-scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
  }

  .main-scroll::-webkit-scrollbar {
    width: 5px;
  }

  .main-scroll::-webkit-scrollbar-track {
    background: transparent;
  }

  .main-scroll::-webkit-scrollbar-thumb {
    background: #27272a;
    border-radius: 3px;
  }

  /* Empty State */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 300px;
    color: #78716c;
    gap: 12px;
  }

  .empty-state h3 {
    margin: 0;
    font-size: 16px;
    color: #a8a29e;
  }

  .empty-state p {
    margin: 0;
    font-size: 12px;
  }

  /* Focused Account View */
  .focused-view {
    min-height: 100%;
  }

  /* Hero Section - Entity + Net Worth */
  .hero {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) var(--panel-gutter-x);
    background: linear-gradient(180deg, #18181b 0%, #09090b 100%);
    border-bottom: 1px solid #27272a;
  }

  .hero-left {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }

  .hero-left.user-mode {
    align-items: flex-start;
  }

  .hero-avatar {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    flex-shrink: 0;
  }

  .hero-avatar.placeholder {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    box-shadow: 0 2px 8px rgba(251, 191, 36, 0.2);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 700;
    color: #0c0a09;
  }

  .hero-identity {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .hero-identity.user-mode {
    gap: 8px;
  }

  .hero-context-switcher {
    max-width: min(360px, 100%);
    width: fit-content;
  }

  .hero-name {
    font-size: 15px;
    font-weight: 600;
    color: #fafaf9;
    letter-spacing: -0.01em;
    word-break: break-all;
  }

  .hero-address {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    width: fit-content;
    max-width: 100%;
    padding: 3px 0;
    margin-left: 0;
    background: transparent;
    border: none;
    border-radius: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #71717a;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
  }

  .hero-address span {
    word-break: break-all;
  }

  .hero-address:hover {
    background: #27272a;
    color: #a1a1aa;
  }

  .hero-right {
    text-align: right;
  }

  .hero-networth {
    font-family: 'JetBrains Mono', monospace;
    font-size: 30px;
    font-weight: 700;
    color: #fafaf9;
    letter-spacing: -0.5px;
    line-height: 1;
  }

  .hero-label {
    font-size: 10px;
    color: #71717a;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-top: 4px;
    font-weight: 500;
  }

  .hero-breakdown {
    display: flex;
    justify-content: flex-end;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 8px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #a1a1aa;
  }

  .hero-breakdown span {
    white-space: nowrap;
  }

  /* Portfolio - legacy, keep btn-faucet for tab content */
  .portfolio {
    padding: 20px 16px;
    text-align: center;
    border-bottom: 1px solid #1c1917;
  }

  .total-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 32px;
    font-weight: 600;
    color: #fafaf9;
  }

  .total-value.dim {
    color: #57534e;
  }

  .total-label {
    font-size: 11px;
    color: #78716c;
    margin-top: 2px;
    margin-bottom: 16px;
  }

  .btn-faucet {
    margin: 8px 8px 0;
    padding: 10px 16px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #a8a29e;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
  }

  .btn-faucet:hover:not(:disabled) {
    border-color: #fbbf24;
    color: #fbbf24;
  }

  .btn-faucet:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* External Tokens */
  .external-tokens {
    padding: 12px 16px;
    border-bottom: 1px solid #1c1917;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }

  .section-header h4 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .signer-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #57534e;
  }

  .ext-loading {
    font-size: 12px;
    color: #57534e;
    text-align: center;
    padding: 12px;
  }

  .ext-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .ext-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: #1c1917;
    border-radius: 6px;
  }

  .ext-symbol {
    font-weight: 600;
    font-size: 12px;
    width: 50px;
  }

  .ext-symbol.eth { color: #627eea; }
  .ext-symbol.usd { color: #2775ca; }

  .ext-amount {
    flex: 1;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #a8a29e;
  }

  .btn-deposit {
    padding: 4px 10px;
    background: linear-gradient(135deg, #16a34a, #15803d);
    border: none;
    border-radius: 4px;
    color: #f0fdf4;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-deposit:hover:not(:disabled) {
    background: linear-gradient(135deg, #22c55e, #16a34a);
  }

  .btn-deposit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .ext-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: #1c1917;
    border-radius: 6px;
    font-size: 12px;
    color: #57534e;
  }

  .btn-faucet-small {
    padding: 4px 10px;
    background: linear-gradient(135deg, #0ea5e9, #0284c7);
    border: none;
    border-radius: 4px;
    color: #f0f9ff;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-faucet-small:hover:not(:disabled) {
    background: linear-gradient(135deg, #38bdf8, #0ea5e9);
  }

  .btn-faucet-small:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .token-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 400px;
    margin: 0 auto;
  }

  .token-row {
    display: grid;
    grid-template-columns: 50px 1fr 80px 60px;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .t-symbol {
    font-weight: 600;
    text-align: left;
  }

  .t-symbol.eth { color: #627eea; }
  .t-symbol.usd { color: #2775ca; }

  .t-amount {
    font-family: 'JetBrains Mono', monospace;
    color: #a8a29e;
    text-align: right;
  }

  .t-bar {
    height: 4px;
    background: #1c1917;
    border-radius: 2px;
    overflow: hidden;
  }

  .t-fill {
    height: 100%;
    background: #fbbf24;
    border-radius: 2px;
  }

  .t-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #57534e;
    text-align: right;
  }

  /* Token List Grid - Beautiful card layout */
  .wallet-address {
    margin-bottom: 16px;
  }

  .token-list-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 40px 20px;
    color: #78716c;
  }

  .loading-spinner {
    width: 20px;
    height: 20px;
    border: 2px solid #292524;
    border-top-color: #fbbf24;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .token-list-grid {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .token-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 12px;
    transition: all 0.15s;
  }

  .token-card:hover {
    border-color: #44403c;
  }

  .token-card.has-balance {
    border-color: #365314;
    background: linear-gradient(135deg, #1c1917 0%, #1a2e05 100%);
  }

  .token-header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .token-icon {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-weight: 700;
    font-size: 16px;
    color: white;
    background: #44403c;
  }

  .token-icon.usdc {
    background: linear-gradient(135deg, #2775ca, #1e5aa8);
  }

  .token-icon.weth {
    background: linear-gradient(135deg, #627eea, #4c62c7);
  }

  .token-icon.usdt {
    background: linear-gradient(135deg, #26a17b, #1e8a69);
  }

  .token-symbol {
    font-weight: 600;
    font-size: 15px;
    color: #fafaf9;
  }

  .token-balance {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .balance-amount {
    font-family: 'JetBrains Mono', monospace;
    font-size: 22px;
    font-weight: 600;
    color: #fafaf9;
  }

  .balance-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #78716c;
  }

  .balance-zero {
    font-family: 'JetBrains Mono', monospace;
    font-size: 22px;
    font-weight: 600;
    color: #44403c;
  }

  .token-actions {
    margin-top: 4px;
  }

  .btn-token-action {
    width: 100%;
    padding: 10px 16px;
    border: none;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-token-action.deposit {
    background: linear-gradient(135deg, #16a34a, #15803d);
    color: #f0fdf4;
  }

  .btn-token-action.deposit:hover:not(:disabled) {
    background: linear-gradient(135deg, #22c55e, #16a34a);
  }

  .btn-token-action.faucet {
    background: linear-gradient(135deg, #0ea5e9, #0284c7);
    color: #f0f9ff;
  }

  .btn-token-action.faucet:hover:not(:disabled) {
    background: linear-gradient(135deg, #38bdf8, #0ea5e9);
  }

  .btn-token-action:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .token-status {
    font-size: 11px;
    color: #57534e;
    font-style: italic;
  }

  .hint-text {
    text-align: center;
    font-size: 12px;
    color: #57534e;
    margin-top: 16px;
    padding: 12px;
    background: #1c1917;
    border-radius: 8px;
  }

  /* Theme picker */
  .theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
    gap: 10px;
    margin-bottom: 16px;
  }

  .theme-swatch {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 0;
    background: none;
    border: 2px solid transparent;
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .theme-swatch:hover {
    transform: translateY(-1px);
  }

  .theme-swatch.active {
    border-color: var(--theme-accent, #fbbf24);
  }

  .swatch-preview {
    width: 100%;
    aspect-ratio: 1.4;
    border-radius: 8px;
    border: 1px solid;
    padding: 6px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
    position: relative;
  }

  .swatch-bar {
    height: 3px;
    border-radius: 2px;
    opacity: 0.9;
  }

  .swatch-text {
    font-size: 11px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1;
  }

  .swatch-accent {
    position: absolute;
    bottom: 6px;
    right: 6px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .swatch-label {
    font-size: 9px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .swatch-label.active {
    color: var(--theme-accent, #fbbf24);
    font-weight: 600;
  }

  /* Tabs */
  .tabs {
    display: flex;
    padding: 0 var(--panel-gutter-x);
    background: #09090b;
    border-bottom: 1px solid #18181b;
    overflow-x: auto;
    flex-shrink: 0;
    gap: 4px;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 10px 14px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: #52525b;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
    border-radius: 6px 6px 0 0;
  }

  .tab:hover {
    color: #a1a1aa;
  }

  .tab.active {
    color: #fbbf24;
    border-bottom-color: #fbbf24;
    background: rgba(251, 191, 36, 0.04);
  }

  .tab-clear {
    margin-left: auto;
    color: #52525b;
    border-bottom-color: transparent;
  }
  .tab-clear:hover {
    color: #fca5a5;
    background: rgba(127, 29, 29, 0.15);
  }

  .badge {
    background: #dc2626;
    color: white;
    font-size: 9px;
    padding: 2px 6px;
    border-radius: 10px;
    font-weight: 600;
    min-width: 16px;
    text-align: center;
    line-height: 1;
    box-shadow: 0 1px 3px rgba(220, 38, 38, 0.3);
  }

  .badge.pending {
    background: #b91c1c;
    color: #fee2e2;
    box-shadow: 0 1px 3px rgba(185, 28, 28, 0.35);
  }

  /* Content */
  .content {
    padding: var(--space-3) var(--panel-gutter-x);
  }

  .accounts-selector-row {
    margin-bottom: 10px;
    padding: 10px;
    border: 1px solid #27272a;
    border-radius: 10px;
    background: #0f1014;
  }

  .accounts-selector-row :global(.dropdown-trigger) {
    width: 100%;
    min-height: 42px;
    border: 1px solid #2f3138;
    border-radius: 8px;
    background: #111216;
    color: #d4d4d8;
  }

  .accounts-selector-row :global(.trigger-text) {
    font-size: 13px;
  }

  .more-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    padding: 8px;
    border: 1px solid #27272a;
    border-radius: 10px;
    background: #101114;
    overflow-x: auto;
  }

  .more-tabs::-webkit-scrollbar {
    display: none;
  }

  .more-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 38px;
    padding: 8px 12px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: #71717a;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .more-tab:hover {
    color: #d4d4d8;
    border-color: #3f3f46;
    background: #18181b;
  }

  .more-tab.active {
    color: #fbbf24;
    border-color: #fbbf24;
    background: rgba(251, 191, 36, 0.08);
  }

  .account-workspace-tabs {
    display: flex;
    gap: 8px;
    margin-top: var(--space-3);
    padding: 10px;
    border: 1px solid #27272a;
    border-radius: 10px;
    background: #111114;
    overflow-x: auto;
  }

  .account-workspace-tabs::-webkit-scrollbar {
    display: none;
  }

  .account-workspace-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 44px;
    padding: 10px 16px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: #71717a;
    font-size: 12px;
    font-weight: 650;
    white-space: nowrap;
    cursor: pointer;
    transition: all 0.15s ease;
    touch-action: manipulation;
  }

  .account-workspace-tab:hover {
    color: #d4d4d8;
    border-color: #3f3f46;
    background: #18181b;
  }

  .account-workspace-tab.active {
    color: #fbbf24;
    border-color: #fbbf24;
    background: rgba(251, 191, 36, 0.08);
  }

  .workspace-badge {
    margin-left: 4px;
    min-width: 18px;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    line-height: 1.4;
    text-align: center;
    color: #fee2e2;
    background: #b91c1c;
    box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.4) inset;
  }

  .account-workspace-content {
    margin-top: var(--space-3);
  }

  .consensus-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }

  .consensus-height-badges {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .consensus-height-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    border: 1px solid #2f3138;
    background: #121318;
    color: #d4d4d8;
    font-size: 11px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
  }

  .workspace-inline-selector {
    margin-bottom: 10px;
    padding: 12px;
    border: 1px solid #27272a;
    border-radius: 10px;
    background: #0f1014;
  }

  .configure-panel {
    border: 1px solid #27272a;
    border-radius: 10px;
    background: #101114;
    padding: 10px;
  }

  .configure-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  .configure-tab {
    padding: 8px 12px;
    border: 1px solid #2f3138;
    border-radius: 8px;
    background: #111216;
    color: #9ca3af;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .configure-tab:hover {
    color: #d1d5db;
    border-color: #4b5563;
  }

  .configure-tab.active {
    color: #fbbf24;
    border-color: #fbbf24;
    background: rgba(251, 191, 36, 0.08);
  }

  .configure-empty {
    margin: 0;
  }

  .configure-token-card {
    border: 1px solid #27272a;
    border-radius: 10px;
    padding: 14px;
    background: #16171c;
  }

  .account-appearance-panel {
    border: 1px solid #27272a;
    border-radius: 10px;
    background: #101114;
    padding: 14px;
  }

  .appearance-card {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .appearance-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
  }

  .appearance-block {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 2px;
  }

  .appearance-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #a1a1aa;
  }

  .appearance-toggle-group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(12px);
    width: fit-content;
  }

  .appearance-toggle {
    min-width: 88px;
    padding: 8px 12px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: #9ca3af;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .appearance-toggle:hover {
    color: #e5e7eb;
  }

  .appearance-toggle.active {
    color: #f5f5f4;
    border-color: rgba(255, 255, 255, 0.08);
    background: linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0.08));
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 6px 18px rgba(0,0,0,0.18);
  }

  .appearance-scale-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }

  .appearance-scale-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .appearance-scale-value {
    color: #f3f4f6;
    font-size: 13px;
    font-weight: 600;
  }

  .appearance-scale-bound {
    color: #71717a;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
  }

  .appearance-slider {
    width: 100%;
    -webkit-appearance: none;
    appearance: none;
    height: 18px;
    background: transparent;
  }

  .appearance-slider::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(251, 191, 36, 0.9), rgba(113, 113, 122, 0.45));
  }

  .appearance-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: #fbbf24;
    box-shadow: 0 4px 14px rgba(251, 191, 36, 0.35);
    margin-top: -6px;
  }

  .appearance-slider::-moz-range-track {
    height: 6px;
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(251, 191, 36, 0.9), rgba(113, 113, 122, 0.45));
  }

  .appearance-slider::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: #fbbf24;
    box-shadow: 0 4px 14px rgba(251, 191, 36, 0.35);
  }

  .configure-token-row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }

  .configure-token-select {
    min-width: 140px;
    padding: 9px 10px;
    border-radius: 8px;
    border: 1px solid #2f3138;
    background: #0d0e11;
    color: #e5e7eb;
    font-size: 12px;
  }

  .btn-add-token {
    padding: 9px 14px;
    border-radius: 8px;
    border: 1px solid #3b82f6;
    background: linear-gradient(180deg, rgba(59, 130, 246, 0.24), rgba(37, 99, 235, 0.16));
    color: #dbeafe;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-add-token:hover:not(:disabled) {
    border-color: #60a5fa;
    color: #eff6ff;
  }

  .btn-add-token:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .section-head {
    font-size: 10px;
    font-weight: 600;
    color: #71717a;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 18px 0 10px;
  }

  .section-head:first-child {
    margin-top: 2px;
  }

  .muted {
    font-size: 11px;
    color: #52525b;
    line-height: 1.5;
    margin: 0 0 12px;
  }

  /* Activity */
  .activity-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 6px;
  }

  .a-icon {
    font-size: 10px;
    padding: 4px 6px;
    background: #292524;
    border-radius: 4px;
    color: #78716c;
  }

  .a-info {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .a-title {
    font-size: 12px;
    color: #e7e5e4;
  }

  .a-sub {
    font-size: 10px;
    color: #57534e;
  }

  .a-amt {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #a8a29e;
  }

  .entity-activity-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .entity-frame-row {
    border: 1px solid #2a2d35;
    border-radius: 10px;
    background: #12141a;
    padding: 10px;
    max-width: calc(100% - 28px);
  }

  .entity-frame-row.ours {
    margin-left: auto;
    background: linear-gradient(180deg, rgba(22, 27, 34, 0.98), rgba(16, 20, 28, 0.98));
    border-color: #2d435b;
  }

  .entity-frame-row.peer {
    margin-right: auto;
    background: linear-gradient(180deg, rgba(28, 20, 14, 0.96), rgba(21, 16, 12, 0.96));
    border-color: #473324;
  }

  .entity-frame-row.system {
    margin-right: auto;
    max-width: 100%;
    background: #12141a;
  }

  .entity-frame-row.queue {
    border-style: dashed;
  }

  .entity-frame-row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }

  .entity-frame-row-left {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .entity-height-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 24px;
    padding: 0 8px;
    border-radius: 999px;
    background: #0f1116;
    border: 1px solid #343742;
    color: #e4e4e7;
    font-size: 11px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
  }

  .entity-frame-actor,
  .entity-frame-account,
  .entity-frame-status {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .entity-frame-actor {
    background: #181b22;
    border: 1px solid #333844;
    color: #fbbf24;
  }

  .entity-frame-account {
    background: #101217;
    border: 1px solid #2d3139;
    color: #d4d4d8;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entity-frame-row-meta {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .entity-frame-status {
    background: #151922;
    border: 1px solid #313645;
    color: #a1a1aa;
  }

  .entity-frame-row-subhead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin: -2px 0 8px;
    color: #71717a;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
  }

  .entity-frame-time {
    font-size: 11px;
    color: #9ca3af;
    font-family: 'JetBrains Mono', monospace;
  }

  .entity-frame-count {
    font-size: 11px;
    color: #a1a1aa;
  }

  .entity-frame-types {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .entity-frame-chip {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    border: 1px solid #353844;
    background: #0f1116;
    color: #d4d4d8;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .entity-frame-row {
      max-width: 100%;
    }

    .entity-frame-row-head,
    .entity-frame-row-subhead {
      flex-direction: column;
      align-items: flex-start;
    }

    .entity-frame-row-meta {
      justify-content: flex-start;
    }
  }

  /* Contacts */
  .contact-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 6px;
  }

  .c-info {
    display: flex;
    flex-direction: column;
  }

  .c-name {
    font-size: 13px;
    color: #e7e5e4;
  }

  .c-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #57534e;
  }

  .c-delete {
    width: 24px;
    height: 24px;
    background: #292524;
    border: none;
    border-radius: 4px;
    color: #78716c;
    cursor: pointer;
  }

  .add-contact {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .add-contact input {
    padding: 10px 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #e7e5e4;
    font-size: 13px;
  }

  .add-contact input::placeholder {
    color: #57534e;
  }

  .add-contact input:focus {
    outline: none;
    border-color: #fbbf24;
  }

  .btn-add {
    padding: 10px;
    background: linear-gradient(135deg, #92400e, #78350f);
    border: none;
    border-radius: 6px;
    color: #fef3c7;
    font-weight: 500;
    cursor: pointer;
  }

  /* Settings */
  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 8px;
  }

  .toggle {
    padding: 4px 12px;
    background: #292524;
    border: none;
    border-radius: 4px;
    color: #78716c;
    font-size: 11px;
    cursor: pointer;
  }

  .toggle.on {
    background: #422006;
    color: #fbbf24;
  }

  .setting-block {
    padding: 12px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 8px;
  }

  .setting-block label {
    display: block;
    font-size: 10px;
    color: #57534e;
    margin-bottom: 6px;
  }

  .setting-block code {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #a8a29e;
    background: #0c0a09;
    padding: 8px;
    border-radius: 4px;
    word-break: break-all;
  }

  .setting-block input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px;
    border-radius: 6px;
    border: 1px solid #292524;
    background: #0c0a09;
    color: #e7e5e4;
    font-size: 13px;
  }

  .setting-block input:focus {
    outline: none;
    border-color: #fbbf24;
  }

  /* Live Required */
  .live-required {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    text-align: center;
    color: #78716c;
    gap: 12px;
  }

  .live-required p {
    margin: 0;
    font-size: 13px;
  }

  .btn-live {
    padding: 10px 20px;
    background: #422006;
    border: 1px solid #713f12;
    border-radius: 6px;
    color: #fbbf24;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-live:hover {
    background: #4a2408;
  }

  /* Override child component styling */
  .content :global(.payment-panel),
  .content :global(.swap-panel),
  .content :global(.settlement-panel),
  .content :global(.account-list) {
    background: transparent !important;
    border: none !important;
    padding: 0 !important;
    height: auto !important;
    overflow: visible !important;
  }

  .content :global(input),
  .content :global(select) {
    background: #1c1917 !important;
    border: 1px solid #292524 !important;
    border-radius: 6px !important;
    color: #e7e5e4 !important;
    padding: 10px 12px !important;
    font-size: 13px !important;
  }

  .content :global(input:focus),
  .content :global(select:focus) {
    outline: none !important;
    border-color: #fbbf24 !important;
  }

  .content :global(input::placeholder) {
    color: #57534e !important;
  }

  .content :global(button:not(.tab):not(.toggle):not(.back-btn):not(.btn-add):not(.btn-live):not(.c-delete):not(.account-workspace-tab):not(.configure-tab):not(.btn-add-token):not(.scope-btn):not(.primary-btn):not(.cancel-btn)) {
    background: #1c1917 !important;
    border: 1px solid #292524 !important;
    border-radius: 6px !important;
    color: #a8a29e !important;
    padding: 10px 14px !important;
    font-size: 12px !important;
    cursor: pointer !important;
  }

  .content :global(h3),
  .content :global(h4),
  .content :global(label) {
    color: #a8a29e !important;
  }

  /* ============================================
     HORIZONTAL TABLE LAYOUT (External/Reserves)
     ============================================ */

  .tab-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
  }

  .asset-title-block {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .asset-ledger-note {
    margin: 0;
    max-width: 520px;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .auto-refresh-select {
    padding: 5px 8px;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 6px;
    color: #71717a;
    font-size: 10px;
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .auto-refresh-select:focus {
    border-color: #fbbf24;
    outline: none;
  }

  .btn-refresh-small {
    padding: 5px 10px;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 6px;
    color: #71717a;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-refresh-small:hover:not(:disabled) {
    border-color: #3f3f46;
    color: #a1a1aa;
    background: #1c1c20;
  }

  .btn-refresh-small:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .wallet-label {
    margin-bottom: 0;
    font-family: 'JetBrains Mono', monospace;
    overflow-wrap: anywhere;
  }

  .asset-ledger-meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 16px;
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid #1f1f23;
  }

  .wallet-meta-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .wallet-meta-value {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #e7e5e4;
    overflow-wrap: anywhere;
  }

  .wallet-meta-help {
    margin: 0;
    max-width: 40ch;
  }

  .loading-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 20px;
    color: #57534e;
    font-size: 12px;
  }

  /* Table Header */
  .token-table-header {
    display: grid;
    grid-template-columns: 100px 1fr 90px 200px;
    gap: 8px;
    padding: 8px 12px;
    background: #1c1917;
    border-radius: 6px 6px 0 0;
    border-bottom: 1px solid #292524;
    font-size: 10px;
    font-weight: 600;
    color: #57534e;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Table Body */
  .token-table {
    display: flex;
    flex-direction: column;
    background: #1c1917;
    border-radius: 0 0 6px 6px;
  }

  /* Table Row */
  .token-table-row {
    display: grid;
    grid-template-columns: 100px 1fr 90px 200px;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid #292524;
    align-items: center;
    transition: background 0.1s;
  }

  .token-table-row:last-child {
    border-bottom: none;
    border-radius: 0 0 6px 6px;
  }

  .token-table-row:hover {
    background: #292524;
  }

  .token-table-row.has-balance {
    background: linear-gradient(90deg, rgba(22, 163, 74, 0.1) 0%, transparent 100%);
  }

  .token-table-row.has-balance:hover {
    background: linear-gradient(90deg, rgba(22, 163, 74, 0.15) 0%, #292524 100%);
  }

  /* Columns */
  .col-token {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .col-balance {
    text-align: right;
  }

  .col-value {
    text-align: right;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }

  .asset-ledger-header,
  .asset-ledger-row {
    grid-template-columns: minmax(120px, 180px) repeat(3, minmax(0, 1fr));
  }

  .asset-ledger-table {
    overflow-x: auto;
  }

  .asset-ledger-total {
    background: rgba(245, 158, 11, 0.05);
  }

  .asset-ledger-total .token-name {
    color: #f5f5f4;
  }

  .asset-name-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .asset-kind {
    font-size: 10px;
    color: #57534e;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .asset-balance-block {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
  }

  .subtle {
    color: #78716c;
  }

  .asset-workspace-tabs {
    margin-top: 16px;
  }

  .asset-action-card {
    margin-top: 12px;
    padding: 16px;
    background: linear-gradient(180deg, rgba(28, 25, 23, 0.96), rgba(20, 18, 16, 0.96));
    border: 1px solid #292524;
    border-radius: 10px;
  }

  .asset-form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-top: 12px;
  }

  .asset-amount-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 188px;
    gap: 12px;
    margin-top: 12px;
    align-items: end;
  }

  .asset-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .asset-field-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .asset-field-wide {
    grid-column: 1 / -1;
  }

  .asset-amount-field,
  .asset-token-field {
    min-width: 0;
  }

  .asset-field span {
    font-size: 10px;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .asset-amount-shell {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 48px;
    padding: 0 8px 0 12px;
    border: 1px solid #322821;
    border-radius: 12px;
    background: #110d0b;
  }

  .asset-amount-shell:focus-within {
    border-color: #fbbf24;
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.12);
  }

  .asset-amount-shell input {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: #f5f5f4;
    font-size: 15px;
  }

  .asset-amount-shell input:focus {
    outline: none;
  }

  .asset-inline-controls {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    min-width: 0;
    flex: 0 0 auto;
    padding-left: 8px;
    align-self: stretch;
  }

  .asset-max-hint {
    border: none;
    background: transparent;
    padding: 0 2px;
    color: #8d857d;
    font-size: 11px;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
    cursor: pointer;
    white-space: nowrap;
    text-align: right;
    max-width: 72px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: inline-flex;
    align-items: center;
    min-height: 32px;
  }

  .asset-max-hint.text-link {
    min-width: 0;
  }

  .asset-max-hint:hover:not(:disabled) {
    color: #f5f5f4;
  }

  .asset-max-hint:disabled {
    color: #57534e;
    cursor: default;
  }

  .asset-token-select-inline {
    min-height: 36px;
    min-width: 94px;
  }

  .asset-token-select-inline.compact {
    min-height: 36px;
    padding: 0 18px 0 2px;
    border-radius: 0;
    background: transparent;
    border: none;
    color: #e7e5e4;
    align-self: stretch;
  }

  .asset-action-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 14px;
  }

  .col-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
  }

  .reserve-collateral-editor {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    width: 100%;
  }

  /* Token Icon (small) */
  .token-icon-small {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-weight: 600;
    font-size: 11px;
    color: white;
    background: #44403c;
    flex-shrink: 0;
  }

  .token-icon-small.usdc {
    background: linear-gradient(135deg, #2775ca, #1e5aa8);
  }

  .token-icon-small.weth {
    background: linear-gradient(135deg, #627eea, #4c62c7);
  }

  .token-icon-small.usdt {
    background: linear-gradient(135deg, #26a17b, #1e8a69);
  }

  .token-name {
    font-weight: 600;
    font-size: 13px;
    color: #fafaf9;
  }

  .balance-text {
    font-size: 13px;
    color: #e7e5e4;
  }

  .balance-text.zero {
    color: #57534e;
  }

  .value-text {
    font-size: 11px;
    color: #78716c;
  }

  /* Table Action Buttons */
  .btn-table-action {
    padding: 5px 10px;
    border: none;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .btn-table-action.faucet {
    background: linear-gradient(135deg, #0ea5e9, #0284c7);
    color: #f0f9ff;
  }

  .btn-table-action.faucet:hover:not(:disabled) {
    background: linear-gradient(135deg, #38bdf8, #0ea5e9);
  }

  .btn-table-action.deposit {
    background: linear-gradient(135deg, #16a34a, #15803d);
    color: #f0fdf4;
  }

  .btn-table-action.deposit:hover:not(:disabled) {
    background: linear-gradient(135deg, #22c55e, #16a34a);
  }

  .btn-table-action.collateral {
    background: linear-gradient(135deg, #f59e0b, #d97706);
    color: #fffbeb;
  }

  .btn-table-action.collateral:hover:not(:disabled) {
    background: linear-gradient(135deg, #fbbf24, #f59e0b);
  }

  .btn-table-action.collateral.partial {
    background: linear-gradient(135deg, #f97316, #ea580c);
  }

  .btn-table-action.collateral.partial:hover:not(:disabled) {
    background: linear-gradient(135deg, #fb923c, #f97316);
  }

  .btn-table-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .quick-actions-section {
    margin-bottom: 16px;
    padding: 12px;
    background: rgba(251, 191, 36, 0.02);
    border: 1px solid rgba(251, 191, 36, 0.1);
    border-radius: 10px;
  }

  .account-open-sections {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
  }

  .open-section {
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
  }

  .open-private-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .disputed-section {
    padding: 10px;
    border-color: rgba(244, 63, 94, 0.25);
    background: rgba(244, 63, 94, 0.06);
    border: 1px solid rgba(244, 63, 94, 0.25);
    border-radius: 8px;
  }

  .disputed-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .disputed-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid rgba(244, 63, 94, 0.2);
    border-radius: 8px;
    background: rgba(15, 23, 42, 0.5);
  }

  .disputed-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .disputed-id {
    color: #e2e8f0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    word-break: break-all;
  }

  .disputed-state {
    color: #fda4af;
    font-size: 11px;
  }

  .btn-reopen-disputed {
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid rgba(251, 191, 36, 0.35);
    background: rgba(251, 191, 36, 0.12);
    color: #fde68a;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  .btn-reopen-disputed:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 900px) {
    .entity-panel {
      --panel-gutter-x: 10px;
      --space-2: 10px;
      --space-3: 12px;
    }

    .hero {
      align-items: flex-start;
      gap: 12px;
    }

    .hero-right {
      min-width: 0;
    }

    .hero-inline-metrics {
      justify-content: flex-start;
    }

    .tab-header-row {
      flex-direction: column;
      align-items: stretch;
    }

    .asset-ledger-note {
      max-width: none;
    }

    .header-actions {
      justify-content: space-between;
      flex-wrap: wrap;
    }

    .asset-ledger-meta {
      grid-template-columns: 1fr;
      gap: 4px;
    }

    .asset-ledger-header,
    .asset-ledger-row {
      min-width: 620px;
    }

    .asset-form-grid {
      grid-template-columns: 1fr;
    }

    .asset-amount-row {
      grid-template-columns: 1fr;
    }

    .account-workspace-tabs {
      padding: 8px;
      gap: 6px;
    }

    .account-workspace-tab {
      min-height: 42px;
      padding: 9px 12px;
      font-size: 11px;
    }

    .header.user-mode-header {
      flex-direction: column;
      align-items: stretch;
    }

    .header-slot-runtime,
    .header-slot-entity,
    .header-slot-context {
      flex: 1 1 auto;
    }
  }
</style>
