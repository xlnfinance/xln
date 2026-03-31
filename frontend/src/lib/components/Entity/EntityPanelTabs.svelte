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
    AccountTx,
    Env,
    EnvSnapshot,
    JAdapter,
    JBatch,
    Profile as GossipProfile,
    RoutedEntityInput,
    EntityTx,
  } from '@xln/runtime/xln-api';
  import {
    getDraftBatchReserveDelta,
    simulateDraftBatchReserveAvailability,
    type DraftBatchReserveIssue,
  } from '@xln/runtime/j-batch';
  import type { Tab, EntityReplica } from '$lib/types/ui';
  import { getXLN, resolveConfiguredApiBase } from '../../stores/xlnStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import { amountToUsd, getAssetUsdPrice } from '$lib/utils/assetPricing';
  import { activeVault, vaultOperations } from '$lib/stores/vaultStore';
  import { xlnFunctions, entityPositions, enqueueEntityInputs, p2pState } from '../../stores/xlnStore';
  import { toasts } from '../../stores/toastStore';
  import { getOpenAccountRebalancePolicyData } from '$lib/utils/onboardingPreferences';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import { getEntityDisplayName, resolveEntityName } from '$lib/utils/entityNaming';
  import { entityAvatar as resolveEntityAvatar } from '$lib/utils/avatar';
  import { formatEntityId } from '$lib/utils/format';
  import { resetEverything } from '$lib/utils/resetEverything';

  // Icons
  import {
    ArrowUpRight, ArrowDownLeft, Repeat, Landmark, Users, Activity,
    Settings as SettingsIcon,
    ChevronDown, Wallet, AlertTriangle, PlusCircle, Copy, Check, Trash2, SlidersHorizontal
  } from 'lucide-svelte';

  // Child components
  import EntityDropdown from './EntityDropdown.svelte';
  import AccountDropdown from './AccountDropdown.svelte';
  import AccountPanel from './AccountPanel.svelte';
  import AccountList from './AccountList.svelte';
  import AccountWorkspaceRail from './AccountWorkspaceRail.svelte';
  import PaymentPanel from './PaymentPanel.svelte';
  import ReceivePanel from './ReceivePanel.svelte';
  import SwapPanel from './SwapPanel.svelte';
  import SettlementPanel from './SettlementPanel.svelte';
  import MoveWorkspace from './MoveWorkspace.svelte';
  import DebtPanel from './DebtPanel.svelte';
  import CreditForm from './CreditForm.svelte';
  import CollateralForm from './CollateralForm.svelte';
  import JurisdictionDropdown from '$lib/components/Jurisdiction/JurisdictionDropdown.svelte';
  import HubDiscoveryPanel from './HubDiscoveryPanel.svelte';
  import EntityInput from '../shared/EntityInput.svelte';
  import EntitySettingsPanel from '$lib/components/Settings/EntitySettingsPanel.svelte';
  import RuntimeDropdown from '$lib/components/Runtime/RuntimeDropdown.svelte';
  import ContextSwitcher from './ContextSwitcher.svelte';

  export let tab: Tab;
  export let hideHeader: boolean = false;
  export let showJurisdiction: boolean = true;
  export let userModeHeader: boolean = false;
  export let selectedJurisdiction: string | null = null;
  export let allowHeaderAddRuntime: boolean = false;
  export let allowHeaderDeleteRuntime: boolean = false;
  export let headerRuntimeAddLabel: string = '+ Add Runtime';
  export let initialAction: 'r2r' | 'r2c' | undefined = undefined;
  export let env: Env | EnvSnapshot;
  export let history: EnvSnapshot[];
  export let timeIndex: number;
  export let isLive: boolean;
  export let onGoToLive: () => void;

  const dispatch = createEventDispatcher();

  // Tab types
  type ViewTab = 'assets' | 'accounts' | 'settings';
  type SettingsSubview = 'wallet' | 'display' | 'network' | 'data' | 'log' | 'entity';
  type AccountWorkspaceTab = 'send' | 'receive' | 'swap' | 'open' | 'activity' | 'move' | 'history' | 'configure' | 'appearance';
  type AssetWorkspaceTab = 'move' | 'history';
  type ConfigureWorkspaceTab = 'extend-credit' | 'request-credit' | 'collateral' | 'token' | 'dispute';

  // Set initial tab based on action
  function getInitialTab(): ViewTab {
    return 'accounts';
  }
  function getInitialAccountWorkspaceTab(): AccountWorkspaceTab {
    if (initialAction === 'r2r') return 'send';
    if (initialAction === 'r2c') return 'move';
    return 'open';
  }
  let activeTab: ViewTab = getInitialTab();
  let settingsSubview: SettingsSubview = 'wallet';
  let accountWorkspaceTab: AccountWorkspaceTab = getInitialAccountWorkspaceTab();
  let assetWorkspaceTab: AssetWorkspaceTab = 'move';
  let configureWorkspaceTab: ConfigureWorkspaceTab = 'extend-credit';
  let workspaceAccountId = '';
  let configureTokenId = 1;
  let pendingBatchSubmitting = false;
  let debtEnforcingTokenId: number | null = null;

  // State
  let replica: EntityReplica | null = null;
  let selectedAccountId: string | null = null;
  let selectedJurisdictionName: string | null = null;
  let copiedMetaField = '';
  let resettingEverything = false;
  let openAccountEntityId = '';
  let currentEntityValue = '';
  let currentExternalEoaValue = '';
  let entityActivityAccountFilter = 'all';
  let firstFaucetAccountId = '';
  let hasAnyAccounts = false;

  function materializeReplicaView(candidate: EntityReplica | null | undefined): EntityReplica | null {
    if (!candidate) return null;
    const materialized: EntityReplica = { ...candidate };
    if (candidate.state) materialized.state = { ...candidate.state };
    if (candidate.position) materialized.position = { ...candidate.position };
    return materialized;
  }

  function materializeAccountView(candidate: AccountMachine | null | undefined): AccountMachine | null {
    if (!candidate) return null;
    const materialized: AccountMachine = {
      ...candidate,
      deltas: candidate.deltas instanceof Map ? new Map(candidate.deltas) : candidate.deltas,
    };
    if (candidate.settlementWorkspace) materialized.settlementWorkspace = { ...candidate.settlementWorkspace };
    if (candidate.activeDispute) materialized.activeDispute = { ...candidate.activeDispute };
    return materialized;
  }

  function materializeReplicaMap(
    source: Map<string, EntityReplica> | null | undefined,
  ): Map<string, EntityReplica> | null {
    if (!(source instanceof Map)) return null;
    return new Map(source);
  }

  function getEnvReplicaMap(sourceEnv: Env | EnvSnapshot | null | undefined): Map<string, EntityReplica> | null {
    if (!sourceEnv) return null;
    return materializeReplicaMap(sourceEnv.eReplicas as Map<string, EntityReplica>);
  }

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

  function canonicalizeHashRoute(routeRaw: string | null): string | null {
    const route = String(routeRaw || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
    if (!route) return null;
    if (route.startsWith('pay/')) return 'accounts/send';
    switch (route) {
      case 'assets':
      case 'assets/move':
      case 'external':
      case 'reserves':
        return 'assets';
      case 'assets/history':
        return 'assets/history';
      case 'accounts':
      case 'accounts/open':
      case 'open':
        return 'accounts/open';
      case 'accounts/send':
      case 'pay':
      case 'send':
        return 'accounts/send';
      case 'accounts/receive':
      case 'receive':
        return 'accounts/receive';
      case 'accounts/swap':
      case 'swap':
        return 'accounts/swap';
      case 'accounts/move':
      case 'move':
        return 'accounts/move';
      case 'accounts/history':
      case 'history':
        return 'accounts/history';
      case 'accounts/configure':
      case 'configure':
        return 'accounts/configure';
      case 'accounts/activity':
      case 'activity':
        return 'accounts/activity';
      case 'accounts/appearance':
      case 'appearance':
        return 'accounts/appearance';
      case 'settings':
      case 'settings/wallet':
      case 'wallet':
        return 'settings';
      case 'settings/display':
      case 'display':
        return 'settings/display';
      case 'settings/network':
      case 'network':
      case 'gossip':
        return 'settings/network';
      case 'settings/data':
      case 'data':
        return 'settings/data';
      case 'settings/log':
      case 'log':
      case 'chat':
        return 'settings/log';
      case 'settings/entity':
      case 'entity':
      case 'governance':
      case 'create':
        return 'settings/entity';
      default:
        return null;
    }
  }

  function buildHashRouteFromState(): string {
    if (activeTab === 'assets') {
      return assetWorkspaceTab === 'history' ? 'assets/history' : 'assets';
    }
    if (activeTab === 'settings') {
      return settingsSubview === 'wallet' ? 'settings' : `settings/${settingsSubview}`;
    }
    if (accountWorkspaceTab === 'open') return 'accounts';
    return `accounts/${accountWorkspaceTab}`;
  }

  function applyDeepLinkViewFromUrl(): void {
    if (typeof window === 'undefined') return;

    const hashRoute = canonicalizeHashRoute(getUrlHashRoute());
    const view = String(getUrlParamValue(['view']) || hashRoute || '').trim().toLowerCase();
    const subview = String(getUrlParamValue(['subview', 'sub']) || '').trim().toLowerCase();
    const jurisdiction = String(getUrlParamValue(['jId', 'jurisdiction', 'j']) || '').trim();

    switch (view) {
      case 'assets':
        activeTab = 'assets';
        assetWorkspaceTab = 'move';
        break;
      case 'assets/history':
        activeTab = 'assets';
        assetWorkspaceTab = 'history';
        break;
      case 'accounts':
      case 'accounts/open':
        activeTab = 'accounts';
        accountWorkspaceTab = 'open';
        break;
      case 'accounts/send':
        activeTab = 'accounts';
        accountWorkspaceTab = 'send';
        break;
      case 'accounts/receive':
        activeTab = 'accounts';
        accountWorkspaceTab = 'receive';
        break;
      case 'accounts/swap':
        activeTab = 'accounts';
        accountWorkspaceTab = 'swap';
        break;
      case 'accounts/move':
        activeTab = 'accounts';
        accountWorkspaceTab = 'move';
        break;
      case 'accounts/history':
        activeTab = 'accounts';
        accountWorkspaceTab = 'history';
        break;
      case 'accounts/configure':
        activeTab = 'accounts';
        accountWorkspaceTab = 'configure';
        break;
      case 'accounts/activity':
        activeTab = 'accounts';
        accountWorkspaceTab = 'activity';
        break;
      case 'accounts/appearance':
        activeTab = 'accounts';
        accountWorkspaceTab = 'appearance';
        break;
      case 'settings':
        activeTab = 'settings';
        settingsSubview = 'wallet';
        break;
      case 'settings/display':
        activeTab = 'settings';
        settingsSubview = 'display';
        break;
      case 'settings/network':
        activeTab = 'settings';
        settingsSubview = 'network';
        break;
      case 'settings/data':
        activeTab = 'settings';
        settingsSubview = 'data';
        break;
      case 'settings/log':
        activeTab = 'settings';
        settingsSubview = 'log';
        break;
      case 'settings/entity':
        activeTab = 'settings';
        settingsSubview = 'entity';
        break;
      default:
        break;
    }

    if (view === 'settings' && subview) {
      const nextSettingsSubview = ['wallet', 'display', 'network', 'data', 'log', 'entity'].includes(subview)
        ? subview as SettingsSubview
        : null;
      if (nextSettingsSubview) settingsSubview = nextSettingsSubview;
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

  function syncHashToCurrentView(): void {
    if (typeof window === 'undefined') return;
    const nextRoute = buildHashRouteFromState();
    const currentRoute = getUrlHashRoute();
    const currentCanonical = canonicalizeHashRoute(currentRoute);
    if (typeof currentRoute === 'string' && currentRoute.toLowerCase().startsWith('pay/') && nextRoute === 'accounts/send') {
      return;
    }
    const params = getUrlHashParams();
    const preserveParams = currentCanonical === nextRoute && params && params.toString().length > 0;
    const nextHash = preserveParams ? `${nextRoute}?${params.toString()}` : nextRoute;
    const currentHash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (currentHash === nextHash) return;
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${nextHash}`);
  }


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

  function isRuntimeEnv(value: unknown): value is Env {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
  }

  function getRuntimeEnv(env: Env | EnvSnapshot | null | undefined): Env | null {
    return isRuntimeEnv(env) ? env : null;
  }

  function requireRuntimeEnv(env: Env | EnvSnapshot | null | undefined, context: string): Env {
    const runtimeEnv = getRuntimeEnv(env);
    if (!runtimeEnv) throw new Error(`${context} requires live runtime environment`);
    return runtimeEnv;
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

  function getRuntimeId(env: Env | EnvSnapshot | null | undefined): string | null {
    const runtimeId = env?.runtimeId;
    return typeof runtimeId === 'string' && runtimeId.length > 0 ? runtimeId : null;
  }

  function getActiveJurisdictionName(env: Env | EnvSnapshot | null | undefined): string | null {
    if (!env || !('activeJurisdiction' in env)) return null;
    return typeof env.activeJurisdiction === 'string' && env.activeJurisdiction.length > 0
      ? env.activeJurisdiction
      : null;
  }

  function getGossipProfiles(env: Env | EnvSnapshot | null | undefined): GossipProfile[] {
    if (!env?.gossip) return [];
    if ('getProfiles' in env.gossip && typeof env.gossip.getProfiles === 'function') {
      return env.gossip.getProfiles();
    }
    return Array.isArray(env.gossip.profiles) ? env.gossip.profiles : [];
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

  function isAccountLeftPerspective(entityId: string, account: AccountMachine): boolean {
    const owner = String(entityId || '').trim().toLowerCase();
    const left = String(account.leftEntity || '').trim().toLowerCase();
    const right = String(account.rightEntity || '').trim().toLowerCase();
    if (owner === left) return true;
    if (owner === right) return false;
    throw new Error(`Account perspective mismatch: owner=${entityId} left=${account.leftEntity} right=${account.rightEntity}`);
  }

  function buildEntityInput(entityId: string, signerId: string, entityTxs: EntityTx[]): RoutedEntityInput {
    return { entityId, signerId, entityTxs };
  }

  const MOVE_ENDPOINT_LABEL: Record<MoveEndpoint, string> = {
    external: 'External',
    reserve: 'Reserve',
    account: 'Account',
  };
  const MOVE_ENDPOINTS: MoveEndpoint[] = ['external', 'reserve', 'account'];
  let moveNodeLayoutVersion = 0;
  let moveNodeLayoutRaf: number | null = null;
  let moveNodeLayoutSettleRaf: number | null = null;
  let moveVisualResizeObserver: ResizeObserver | null = null;
  let moveLineReady = false;
  let moveCommittedLineReady = false;
  let moveCommittedLinePrimed = false;
  let moveCommittedLineTimeout: ReturnType<typeof setTimeout> | null = null;
  let moveHubEntityOptions: string[] = [];
  let moveValidationSignature = '';

  function resetMoveLineMeasurement(): void {
    moveLineReady = false;
    moveCommittedLineReady = false;
    moveCommittedLinePrimed = false;
    if (moveNodeLayoutRaf !== null) {
      cancelAnimationFrame(moveNodeLayoutRaf);
      moveNodeLayoutRaf = null;
    }
    if (moveNodeLayoutSettleRaf !== null) {
      cancelAnimationFrame(moveNodeLayoutSettleRaf);
      moveNodeLayoutSettleRaf = null;
    }
    if (moveCommittedLineTimeout) {
      clearTimeout(moveCommittedLineTimeout);
      moveCommittedLineTimeout = null;
    }
  }

  function scheduleMoveCommittedLineReady(): void {
    if (moveCommittedLineTimeout) clearTimeout(moveCommittedLineTimeout);
    if (moveDragSource) return;
    if (moveCommittedLinePrimed) {
      moveNodeLayoutVersion += 1;
      moveCommittedLineReady = true;
      return;
    }
    moveCommittedLineReady = false;
    moveCommittedLineTimeout = setTimeout(() => {
      moveCommittedLineTimeout = null;
      moveNodeLayoutVersion += 1;
      moveCommittedLineReady = true;
      moveCommittedLinePrimed = true;
    }, 200);
  }

  function bumpMoveNodeLayout(): void {
    moveNodeLayoutVersion += 1;
    if (typeof requestAnimationFrame !== 'function') {
      const hasAnchors =
        !!getMoveNodeAnchor('from', moveFromEndpoint)
        && !!getMoveNodeAnchor('to', moveToEndpoint);
      moveLineReady = hasAnchors;
      if (hasAnchors) scheduleMoveCommittedLineReady();
      return;
    }
    moveLineReady = false;
    moveCommittedLineReady = false;
    if (moveNodeLayoutRaf !== null) cancelAnimationFrame(moveNodeLayoutRaf);
    if (moveNodeLayoutSettleRaf !== null) cancelAnimationFrame(moveNodeLayoutSettleRaf);
    if (moveCommittedLineTimeout) {
      clearTimeout(moveCommittedLineTimeout);
      moveCommittedLineTimeout = null;
    }

    // Wait for child node refs to be available before measuring.
    // First RAF: layout pass. Second RAF: paint pass.
    // Third RAF: guarantees all Svelte action bindings (setMoveNodeRef) have fired.
    moveNodeLayoutRaf = requestAnimationFrame(() => {
      moveNodeLayoutRaf = null;
      moveNodeLayoutSettleRaf = requestAnimationFrame(() => {
        moveNodeLayoutSettleRaf = null;
        const fromAnchor = getMoveNodeAnchor('from', moveFromEndpoint);
        const toAnchor = getMoveNodeAnchor('to', moveToEndpoint);
        if (fromAnchor && toAnchor) {
          moveNodeLayoutVersion += 1;
          moveLineReady = true;
          scheduleMoveCommittedLineReady();
        } else {
          requestAnimationFrame(() => {
            const retryFromAnchor = getMoveNodeAnchor('from', moveFromEndpoint);
            const retryToAnchor = getMoveNodeAnchor('to', moveToEndpoint);
            if (!retryFromAnchor || !retryToAnchor) return;
            moveNodeLayoutVersion += 1;
            moveLineReady = true;
            scheduleMoveCommittedLineReady();
          });
        }
      });
    });
  }

  function setMoveNodeRef(side: 'from' | 'to', endpoint: MoveEndpoint, node: HTMLButtonElement | null): void {
    const key = `${side}:${endpoint}`;
    if (node) {
      moveNodeRefs.set(key, node);
    } else {
      moveNodeRefs.delete(key);
    }
    bumpMoveNodeLayout();
  }

  function moveNodeAction(
    node: HTMLButtonElement,
    params: { side: 'from' | 'to'; endpoint: MoveEndpoint },
  ): { update: (next: { side: 'from' | 'to'; endpoint: MoveEndpoint }) => void; destroy: () => void } {
    setMoveNodeRef(params.side, params.endpoint, node);
    return {
      update(next) {
        setMoveNodeRef(params.side, params.endpoint, null);
        setMoveNodeRef(next.side, next.endpoint, node);
        params = next;
      },
      destroy() {
        setMoveNodeRef(params.side, params.endpoint, null);
      },
    };
  }

  function getMoveNodeAnchor(side: 'from' | 'to', endpoint: MoveEndpoint): { x: number; y: number } | null {
    const rootRect = moveVisualRoot?.getBoundingClientRect();
    const node = moveNodeRefs.get(`${side}:${endpoint}`)
      || moveVisualRoot?.querySelector<HTMLButtonElement>(`[data-move-side="${side}"][data-move-endpoint="${endpoint}"]`)
      || null;
    const nodeRect = node?.getBoundingClientRect();
    if (
      !rootRect
      || !nodeRect
      || rootRect.width <= 0
      || rootRect.height <= 0
      || nodeRect.width <= 0
      || nodeRect.height <= 0
    ) {
      return null;
    }
    return {
      x: side === 'from'
        ? nodeRect.right - rootRect.left
        : nodeRect.left - rootRect.left,
      y: nodeRect.top - rootRect.top + (nodeRect.height / 2),
    };
  }

  function buildMoveArrowPath(
    start: { x: number; y: number } | null,
    end: { x: number; y: number } | null,
  ): string {
    if (!start || !end) return '';
    const distance = Math.abs(end.x - start.x);
    const curve = Math.max(22, Math.min(68, distance * 0.2));
    const control1X = start.x + curve;
    const control2X = end.x - curve;
    return `M ${start.x} ${start.y} C ${control1X} ${start.y} ${control2X} ${end.y} ${end.x} ${end.y}`;
  }

  function beginMoveDrag(endpoint: MoveEndpoint, event: PointerEvent | MouseEvent): void {
    event.preventDefault();
    moveDragSource = endpoint;
    moveDragHoverTarget = null;
    moveSelectedSource = endpoint;
    moveCommittedLineReady = false;
    if (moveCommittedLineTimeout) {
      clearTimeout(moveCommittedLineTimeout);
      moveCommittedLineTimeout = null;
    }
  }

  function applyMoveRoute(from: MoveEndpoint, to: MoveEndpoint): void {
    const selfEntityId = resolveSelfEntityId();
    const selfEoa = resolveSelfEoaAddress();
    moveFromEndpoint = from;
    moveToEndpoint = to;
    if (to === 'reserve' && !moveReserveRecipientEntityId.trim()) {
      moveReserveRecipientEntityId = selfEntityId;
    }
    if (to === 'account' && !moveTargetEntityId.trim()) {
      moveTargetEntityId = selfEntityId;
    }
    if (to === 'external' && !moveExternalRecipient.trim() && selfEoa) {
      moveExternalRecipient = selfEoa;
    }
    moveSelectedSource = null;
    moveSelectedTarget = null;
    clearMoveDrag();
    bumpMoveNodeLayout();
  }

  function setMoveSource(endpoint: MoveEndpoint): void {
    if (moveSelectedTarget) {
      if (isMoveRouteSupported(endpoint, moveSelectedTarget)) {
        applyMoveRoute(endpoint, moveSelectedTarget);
        return;
      }
      moveToEndpoint = moveSelectedTarget;
    }
    moveFromEndpoint = endpoint;
    moveSelectedSource = endpoint;
  }

  function completeMoveSelection(target: MoveEndpoint): void {
    const source = moveDragSource ?? moveSelectedSource;
    if (!source) return;
    moveToEndpoint = target;
    if (isMoveRouteSupported(source, target)) {
      applyMoveRoute(source, target);
      return;
    }
    moveSelectedSource = source;
    moveSelectedTarget = target;
    clearMoveDrag();
  }

  function setMoveTarget(endpoint: MoveEndpoint): void {
    if (moveDragSource) {
      completeMoveSelection(endpoint);
      return;
    }
    if (moveSelectedSource && isMoveRouteSupported(moveSelectedSource, endpoint)) {
      applyMoveRoute(moveSelectedSource, endpoint);
      return;
    }
    moveToEndpoint = endpoint;
    moveSelectedTarget = endpoint;
  }

  function clearMoveDrag(): void {
    moveDragSource = null;
    moveDragHoverTarget = null;
    if (moveLineReady) scheduleMoveCommittedLineReady();
  }

  function resetMoveRoute(): void {
    moveFromEndpoint = 'external';
    moveToEndpoint = 'reserve';
    moveSelectedSource = null;
    moveSelectedTarget = null;
    moveExternalRecipient = '';
    moveReserveRecipientEntityId = resolveSelfEntityId();
    moveSourceAccountId = workspaceAccountId || workspaceAccountIds[0] || '';
    moveTargetEntityId = resolveSelfEntityId();
    moveTargetHubEntityId = workspaceAccountId || moveHubEntityOptions[0] || '';
    moveProgressLabel = '';
    clearMoveDrag();
    bumpMoveNodeLayout();
  }

  function getMoveRouteKey(from: MoveEndpoint, to: MoveEndpoint): string {
    return `${from}->${to}`;
  }

  function isMoveRouteSupported(from: MoveEndpoint, to: MoveEndpoint): boolean {
    switch (getMoveRouteKey(from, to)) {
      case 'external->external':
      case 'external->reserve':
      case 'external->account':
      case 'reserve->external':
      case 'reserve->reserve':
      case 'reserve->account':
      case 'account->external':
      case 'account->reserve':
      case 'account->account':
        return true;
      default:
        return false;
    }
  }

  function moveRouteSteps(from: MoveEndpoint, to: MoveEndpoint): string[] {
    const targetEntity = getCurrentMoveTargetEntityId();
    const targetHub = getCurrentMoveTargetHubId();
    const targetEntityLabel = targetEntity ? formatAddress(targetEntity) : 'recipient';
    const targetHubLabel = targetHub ? formatAddress(targetHub) : 'hub';
    const reserveRecipientLabel = moveReserveRecipientEntityId
      ? formatAddress(moveReserveRecipientEntityId)
      : 'recipient reserve';
    switch (getMoveRouteKey(from, to)) {
      case 'external->reserve':
        return moveReserveRecipientEntityId && moveReserveRecipientEntityId !== resolveSelfEntityId()
          ? [
            '1. Approve Depository from your wallet if needed',
            '2. Deposit from your wallet into reserve',
            `3. Forward reserve to ${reserveRecipientLabel}`,
          ]
          : [
            '1. Approve Depository from your wallet if needed',
            '2. Deposit from your wallet into reserve',
          ];
      case 'reserve->reserve':
        return [`1. Send reserve batch to ${reserveRecipientLabel}`];
      case 'reserve->account':
        return [`1. Fund ${targetEntityLabel} through ${targetHubLabel}`];
      case 'account->reserve':
        return moveReserveRecipientEntityId && moveReserveRecipientEntityId !== resolveSelfEntityId()
          ? [
            '1. Settle funds back into your reserve',
            `2. Forward reserve to ${reserveRecipientLabel}`,
          ]
          : ['1. Settle funds back into your reserve'];
      case 'reserve->external':
        return ['1. Withdraw reserve to recipient wallet'];
      case 'external->external':
        return ['1. Send directly from wallet to wallet'];
      case 'external->account':
        return [
          '1. Approve Depository from your wallet if needed',
          '2. Deposit from your wallet into reserve',
          `3. Fund ${targetEntityLabel} through ${targetHubLabel}`,
        ];
      case 'account->external':
        return [
          '1. Settle funds back into your reserve',
          '2. Withdraw reserve to recipient wallet',
        ];
      case 'account->account':
        return [
          '1. Settle funds back into your reserve',
          `2. Fund ${targetEntityLabel} through ${targetHubLabel}`,
        ];
      default:
        return ['Route not available'];
    }
  }

  function moveRouteExecutionLabel(from: MoveEndpoint, to: MoveEndpoint): string {
    switch (getMoveRouteKey(from, to)) {
      case 'external->reserve':
        return 'Deposit into reserve';
      case 'reserve->external':
        return 'Withdraw to wallet';
      case 'reserve->account':
        return 'Fund account';
      case 'external->external':
        return 'Send to wallet';
      case 'external->account':
        return 'Deposit and fund account';
      case 'reserve->reserve':
        return 'Move between reserves';
      case 'account->reserve':
        return 'Return funds to reserve';
      case 'account->external':
        return 'Withdraw from account';
      case 'account->account':
        return 'Move between accounts';
      default:
        return 'Unavailable';
    }
  }

  function moveRouteMeta(from: MoveEndpoint, to: MoveEndpoint): string {
    const reserveRemote = moveNeedsReserveRecipient(from, to) && moveReserveRecipientEntityId.trim() && moveReserveRecipientEntityId !== resolveSelfEntityId();
    switch (getMoveRouteKey(from, to)) {
      case 'external->reserve':
        return reserveRemote ? '2 steps • ~300k gas' : 'On-chain batch • ~140k gas';
      case 'reserve->reserve':
        return '1 batch • ~160k gas';
      case 'reserve->account':
        return '1 batch • ~180k gas';
      case 'account->reserve':
        return reserveRemote ? '2 steps • ~200k gas' : '2 steps • ~120k gas';
      case 'reserve->external':
        return '1 batch • ~140k gas';
      case 'external->external':
        return '1 wallet transfer';
      case 'external->account':
        return '2 steps • ~320k gas';
      case 'account->external':
        return '2 steps • ~260k gas';
      case 'account->account':
        return '2 steps • ~300k gas';
      default:
        return '';
    }
  }

  function moveNeedsExternalRecipient(from: MoveEndpoint, to: MoveEndpoint): boolean {
    return to === 'external';
  }

  function moveNeedsReserveRecipient(from: MoveEndpoint, to: MoveEndpoint): boolean {
    return to === 'reserve';
  }

  function isMoveAwaitingCounterparty(): boolean {
    return pendingAssetAutoC2Rs.length > 0 || resolvingAssetAutoC2R;
  }

  function refreshPendingCollateralFundingToken(): void {
    collateralFundingToken = pendingAssetAutoC2Rs[0]?.symbol ?? null;
  }

  function getMoveDraftReserveDelta(tokenId: number): bigint {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const batch = replica?.state?.jBatchState?.batch;
    if (!entityId || !batch) return 0n;
    return getDraftBatchReserveDelta(entityId, batch, tokenId);
  }

  function getOpenOutgoingDebtForToken(tokenId: number): bigint {
    const bucket = replica?.state?.outDebtsByToken?.get?.(tokenId);
    if (!bucket) return 0n;
    let total = 0n;
    for (const debt of bucket.values()) {
      if (debt.status === 'open') {
        total += BigInt(debt.remainingAmount || 0);
      }
    }
    return total;
  }

  function getMoveMaxAmount(
    from: MoveEndpoint,
    reserveToken: ReserveTransferAsset | null,
    externalToken: ExternalToken | null,
    sourceAccountId: string,
  ): bigint | null {
    switch (from) {
      case 'external':
        return externalToken?.balance ?? 0n;
      case 'reserve':
        if (!reserveToken) return 0n;
        return (() => {
          const effective = (onchainReserves.get(reserveToken.tokenId) ?? 0n) + getMoveDraftReserveDelta(reserveToken.tokenId);
          const outgoingDebt = getOpenOutgoingDebtForToken(reserveToken.tokenId);
          return effective > outgoingDebt ? effective - outgoingDebt : 0n;
        })();
      case 'account':
        return reserveToken && sourceAccountId
          ? getAccountSpendableCapacity(sourceAccountId, reserveToken.tokenId)
          : 0n;
      default:
        return null;
    }
  }

  function getMoveValidationError(mode: 'draft' | 'broadcast'): string | null {
    const routeKey = getMoveRouteKey(moveFromEndpoint, moveToEndpoint);
    if (!isMoveRouteSupported(moveFromEndpoint, moveToEndpoint)) {
      return 'Selected route is not available';
    }
    if (moveExecuting) return 'Move already in progress';
    if (!activeIsLive && routeKey !== 'external->external') {
      return mode === 'draft'
        ? 'Switch to LIVE mode to add this route to batch'
        : 'Switch to LIVE mode to submit this route';
    }
    if ((moveFromEndpoint === 'account' || moveToEndpoint === 'account') && isMoveAwaitingCounterparty()) {
      return 'Wait for the current account settlement to finish';
    }
    if (!moveAmount.trim()) return 'Enter amount first';
    if (mode === 'draft' && hasSentBatch) {
      return 'Wait for current batch confirmation or clear it before adding a new move';
    }
    if (mode === 'draft' && !canAddMoveToExistingBatch()) {
      return 'Add to batch is not available for this route';
    }

    const sourceAccountId = getCurrentMoveSourceAccountId();
    const targetEntityId = getCurrentMoveTargetEntityId();
    const targetHubId = getCurrentMoveTargetHubId();
    const selfEntityId = resolveSelfEntityId();
    const selfEoa = resolveSelfEoaAddress().toLowerCase();
    const reserveRecipient = String(moveReserveRecipientEntityId || '').trim().toLowerCase();
    const externalRecipient = String(moveExternalRecipient || '').trim().toLowerCase();

    if (moveFromEndpoint === 'account' && !sourceAccountId) return 'Select source account';
    if (moveToEndpoint === 'account' && (!targetEntityId || !targetHubId)) return 'Select recipient and counterparty';
    if (moveNeedsReserveRecipient(moveFromEndpoint, moveToEndpoint) && !reserveRecipient) return 'Select recipient entity';
    if (moveNeedsExternalRecipient(moveFromEndpoint, moveToEndpoint) && !externalRecipient) return 'Enter recipient EOA';
    if (moveNeedsExternalRecipient(moveFromEndpoint, moveToEndpoint) && !isAddress(externalRecipient)) {
      return 'Recipient must be a valid EOA address';
    }
    if (
      moveFromEndpoint === 'account' &&
      moveToEndpoint === 'account' &&
      sourceAccountId &&
      targetEntityId === selfEntityId &&
      targetHubId.toLowerCase() === sourceAccountId.toLowerCase()
    ) {
      return 'Cannot transfer to same account';
    }
    if (moveFromEndpoint === 'reserve' && moveToEndpoint === 'reserve' && reserveRecipient === selfEntityId) {
      return 'Reserve → Reserve to self is meaningless';
    }
    if (moveFromEndpoint === 'external' && moveToEndpoint === 'external' && externalRecipient === selfEoa) {
      return 'External → External to self is meaningless';
    }

    const reserveToken = findReserveTransferTokenBySymbol(moveAssetSymbol);
    const externalToken = findExternalTokenBySymbol(moveAssetSymbol);
    if (moveFromEndpoint === 'external' && moveToEndpoint === 'external') {
      if (!externalToken) return 'Select external asset first';
    } else if (!reserveToken) {
      return 'Select reserve-compatible asset first';
    }

    try {
      const maxAmount = getCurrentMoveSourceAvailableBalance();
      parsePositiveAssetAmount(moveAmount, moveFromEndpoint === 'external' && moveToEndpoint === 'external'
        ? (externalToken as { decimals: number })
        : (reserveToken as { decimals: number }), maxAmount ?? undefined);
    } catch (error) {
      return toErrorMessage(error, 'Invalid move amount');
    }

    return null;
  }

  $: moveValidationSignature = [
    moveFromEndpoint,
    moveToEndpoint,
    moveAmount,
    moveAssetSymbol,
    moveExternalRecipient,
    moveReserveRecipientEntityId,
    moveSourceAccountId,
    moveTargetEntityId,
    moveTargetHubEntityId,
    moveExecuting ? '1' : '0',
    pendingAssetAutoC2Rs.length > 0 ? String(pendingAssetAutoC2Rs.length) : '0',
    resolvingAssetAutoC2R ? '1' : '0',
    workspaceAccountId,
    selectedAccountId || '',
    selectedMoveTransferToken ? String(selectedMoveTransferToken.tokenId) : '',
    selectedMoveExternalToken ? selectedMoveExternalToken.address : '',
    moveUiState.ledgerRow ? moveUiState.ledgerRow.externalBalance.toString() : '0',
    moveUiState.ledgerRow ? moveUiState.ledgerRow.reserveBalance.toString() : '0',
    moveUiState.ledgerRow ? moveUiState.ledgerRow.accountBalance.toString() : '0',
    moveUiState.sourceAvailableBalance.toString(),
  ].join('|');
  $: {
    void moveValidationSignature;
    moveDraftError = getMoveValidationError('draft');
    moveBroadcastError = getMoveValidationError('broadcast');
  }

  function resolveSelfEoaAddress(): string {
    const signerId = String(currentSignerId || '').trim();
    if (isAddress(signerId)) return signerId;
    const vaultId = String($activeVault?.id || '').trim();
    if (isAddress(vaultId)) return vaultId;
    return '';
  }

  function resolveSelfEntityId(): string {
    return String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
  }

  function handleMoveReserveRecipientChange(event: CustomEvent<{ value?: string }>) {
    moveReserveRecipientEntityId = String(event.detail?.value || '').trim().toLowerCase();
  }

  function normalizeMoveAccountId(raw: string): string {
    const nextRaw = String(raw || '').trim();
    const matched = workspaceAccountIds.find((id) => String(id).toLowerCase() === nextRaw.toLowerCase());
    return matched || nextRaw;
  }

  function handleMoveSourceAccountChange(event: CustomEvent<{ value?: string }>) {
    moveSourceAccountId = normalizeMoveAccountId(String(event.detail?.value || ''));
  }

  function handleMoveTargetEntityChange(event: CustomEvent<{ value?: string }>) {
    const next = String(event.detail?.value || '').trim().toLowerCase();
    if (next !== moveTargetEntityId) {
      moveTargetCounterpartyManualOverride = false;
      moveTargetHubEntityId = '';
    }
    moveTargetEntityId = next;
  }

  function handleMoveTargetHubChange(event: CustomEvent<{ value?: string }>) {
    const next = String(event.detail?.value || '').trim().toLowerCase();
    if (!next) {
      moveTargetHubEntityId = '';
      moveTargetCounterpartyManualOverride = false;
      return;
    }
    const supported = moveHubEntityOptions.map((id) => String(id).trim().toLowerCase());
    if (!supported.includes(next)) {
      const confirmed = typeof window === 'undefined'
        ? true
        : window.confirm('This counterparty is not listed in the recipient profile. Funds may be lost if they do not support this account. Continue?');
      if (!confirmed) return;
      moveTargetCounterpartyManualOverride = true;
    } else {
      moveTargetCounterpartyManualOverride = false;
    }
    moveTargetHubEntityId = next;
  }

  function getCurrentMoveSourceAccountId(): string {
    const current = String(moveSourceAccountId || workspaceAccountId || selectedAccountId || '').trim();
    if (moveFromEndpoint !== 'account') return current;
    const token = selectedMoveTransferToken;
    if (!token) return current;
    return getPreferredMoveSourceAccountId(token.tokenId, getRequestedMoveAmount(token));
  }

  function getCurrentMoveTargetEntityId(): string {
    return String(moveTargetEntityId || resolveSelfEntityId() || '').trim().toLowerCase();
  }

  function getCurrentMoveTargetHubId(): string {
    return String(moveTargetHubEntityId || workspaceAccountId || selectedAccountId || '').trim().toLowerCase();
  }

  function getMoveAccountBalance(counterpartyEntityId: string): bigint {
    if (!selectedMoveTransferToken || !counterpartyEntityId) return 0n;
    return getAccountSpendableCapacity(counterpartyEntityId, selectedMoveTransferToken.tokenId);
  }

  function getMoveAggregateAccountBalance(): bigint {
    const tokenId = selectedMoveTransferToken?.tokenId;
    if (!tokenId) return 0n;
    return workspaceAccountIds.reduce((total, accountId) => (
      total + getAccountSpendableCapacity(accountId, tokenId)
    ), 0n);
  }

  function getRequestedMoveAmount(token: { decimals: number }): bigint {
    try {
      return moveAmount.trim() ? parsePositiveAssetAmount(moveAmount, token) : 0n;
    } catch {
      return 0n;
    }
  }

  function getPreferredMoveSourceAccountId(tokenId: number, requestedAmount: bigint): string {
    const current = String(moveSourceAccountId || workspaceAccountId || selectedAccountId || '').trim();
    const currentAvailable = current ? getAccountSpendableCapacity(current, tokenId) : 0n;
    if (current && workspaceAccountIds.includes(current)) {
      if (requestedAmount > 0n && currentAvailable >= requestedAmount) return current;
      if (requestedAmount <= 0n && currentAvailable > 0n) return current;
    }
    const preferred =
      (requestedAmount > 0n
        ? workspaceAccountIds.find((id) => getAccountSpendableCapacity(id, tokenId) >= requestedAmount)
        : '')
      || workspaceAccountIds.find((id) => getAccountSpendableCapacity(id, tokenId) > 0n)
      || current
      || workspaceAccountIds[0]
      || '';
    return preferred;
  }

  function getMoveDisplayDecimals(): number {
    const row = moveUiState.ledgerRow;
    if (row && typeof row.decimals === 'number' && row.decimals >= 0) return row.decimals;
    const liveExternalToken = findExternalTokenBySymbol(moveAssetSymbol);
    const liveTransferToken = findReserveTransferTokenBySymbol(moveAssetSymbol);
    if (liveExternalToken && typeof liveExternalToken.decimals === 'number') return liveExternalToken.decimals;
    if (liveTransferToken && typeof liveTransferToken.decimals === 'number') return liveTransferToken.decimals;
    return 18;
  }

  function computeMoveSourceAvailableBalance(
    row: AssetLedgerRow | null,
    liveTransferToken: ReserveTransferAsset | null,
  ): bigint {
    switch (moveFromEndpoint) {
      case 'external':
        return row?.externalBalance ?? findExternalTokenBySymbol(moveAssetSymbol)?.balance ?? 0n;
      case 'reserve':
        if (!liveTransferToken) return row?.reserveBalance ?? 0n;
        return (() => {
          const baseReserve = row?.reserveBalance ?? (onchainReserves.get(liveTransferToken.tokenId) ?? 0n);
          const effective = baseReserve + getMoveDraftReserveDelta(liveTransferToken.tokenId);
          const outgoingDebt = getOpenOutgoingDebtForToken(liveTransferToken.tokenId);
          return effective > outgoingDebt ? effective - outgoingDebt : 0n;
        })();
      case 'account':
        return liveTransferToken && getCurrentMoveSourceAccountId()
          ? getAccountSpendableCapacity(getCurrentMoveSourceAccountId(), liveTransferToken.tokenId)
          : row?.accountBalance ?? 0n;
      default:
        return 0n;
    }
  }

  function getCurrentMoveSourceAvailableBalance(): bigint {
    return computeMoveSourceAvailableBalance(moveUiState.ledgerRow, selectedMoveTransferToken);
  }

  function choosePreferredMoveAssetSymbol(): string {
    const candidates = moveAssetOptions;
    const preferredUsdc = candidates.find((token) => String(token.symbol || '').trim().toUpperCase() === 'USDC');
    if (preferredUsdc) return preferredUsdc.symbol;
    const sourceAccountId = getCurrentMoveSourceAccountId();
    const preferredWithBalance = candidates.find((token) => {
      const externalToken = findExternalTokenBySymbol(token.symbol);
      const reserveToken = findReserveTransferTokenBySymbol(token.symbol);
      return (
        getMoveMaxAmount(
          moveFromEndpoint,
          reserveToken,
          externalToken,
          sourceAccountId,
        ) ?? 0n
      ) > 0n;
    });
    return preferredWithBalance?.symbol ?? candidates[0]?.symbol ?? '';
  }

  function getP2PRelayUrls(env: Env | EnvSnapshot | null | undefined): string[] {
    const p2p = isRuntimeEnv(env)
      ? (env.runtimeState?.p2p as { relayUrls?: string[] } | null | undefined)
      : null;
    const relayUrls = p2p?.relayUrls;
    return Array.isArray(relayUrls) ? relayUrls : [];
  }

  function toErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    return fallback;
  }

  function notifyUserActionError(context: string, message: string): void {
    console.error(`[EntityPanel] ${context}: ${message}`);
    toasts.error(message);
  }

  async function copyMetaValue(value: string, field: 'entity' | 'external'): Promise<void> {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) return;
    try {
      await navigator.clipboard.writeText(normalizedValue);
      copiedMetaField = field;
      setTimeout(() => {
        if (copiedMetaField === field) copiedMetaField = '';
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  // Get avatar URL without tripping early boot fail-fast guards.
  $: avatar = resolveEntityAvatar(activeXlnFunctions, tab.entityId);
  $: currentEntityValue = String(replica && replica.state ? (replica.state.entityId || tab.entityId || '') : (tab.entityId || '')).trim();
  $: currentSignerId = (() => {
    const entityId = String(replica && replica.state ? (replica.state.entityId || '') : (tab.entityId || '')).trim().toLowerCase();
    if (!entityId) return String(tab.signerId || '').trim();
    const env = getRuntimeEnv(activeEnv);
    if (!env) return String(tab.signerId || '').trim();
    return requireSignerIdForEntity(env, entityId, 'entity-panel-current-signer');
  })();
  $: currentExternalEoaValue = String(currentSignerId || '').trim();

  // Resolve entity name from gossip profiles
  $: gossipName = (() => {
    const entityId = (replica?.state?.entityId || tab.entityId || '').toLowerCase();
    if (!entityId) return '';
    const profiles = getGossipProfiles(activeEnv);
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

  $: activeReplicas = getEnvReplicaMap(activeEnv);
  $: activeXlnFunctions = $xlnFunctions;
  $: activeHistory = history;
  $: activeTimeIndex = timeIndex;
  $: activeEnv = env;
  $: activeIsLive = isLive;
  $: liveRuntimeEnv = getRuntimeEnv(activeEnv);

  function resolveEntitySigner(entityId: string, reason: string): string {
    const env = getRuntimeEnv(activeEnv);
    if (env && activeXlnFunctions?.resolveEntityProposerId) {
      return activeXlnFunctions.resolveEntityProposerId(env, entityId, reason);
    }
    return requireSignerIdForEntity(requireRuntimeEnv(activeEnv, reason), entityId, reason);
  }

  function findReplicaForTab(
    replicas: Map<string, EntityReplica> | null | undefined,
    entityId: string,
    signerId: string,
  ): EntityReplica | null {
    if (!replicas || !entityId) return null;

    const exactKey = signerId ? `${entityId}:${signerId}` : '';
    const exact = exactKey ? materializeReplicaView(replicas.get(exactKey) ?? null) : null;
    if (exact) return exact;

    const normalizedEntityId = String(entityId || '').trim().toLowerCase();
    for (const [replicaKey, candidate] of replicas.entries()) {
      const [replicaEntityId] = String(replicaKey).split(':');
      if (String(replicaEntityId || '').trim().toLowerCase() === normalizedEntityId) {
        return materializeReplicaView(candidate);
      }
    }

    return null;
  }

  function findLiveReplicaForEntity(entityId: string, signerId: string): EntityReplica | null {
    const env = getRuntimeEnv(activeEnv);
    if (!env?.eReplicas) return null;
    const replicas = env.eReplicas instanceof Map
      ? materializeReplicaMap(env.eReplicas as Map<string, EntityReplica>)
      : materializeReplicaMap(null);
    return findReplicaForTab(replicas, entityId, signerId);
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
    ? materializeAccountView(replica.state.accounts.get(selectedAccountId)) : null;
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
  $: firstFaucetAccountId = workspaceAccountIds[0] || accountIds[0] || '';
  $: if (assetWorkspaceTab === 'move' && workspaceAccountIds.length > 0) {
    const token = selectedMoveTransferToken;
    if (moveFromEndpoint === 'account' && token) {
      const preferred = getPreferredMoveSourceAccountId(token.tokenId, getRequestedMoveAmount(token));
      if (preferred && moveSourceAccountId !== preferred) {
        moveSourceAccountId = preferred;
      }
    }
  }
  $: if (assetWorkspaceTab === 'move' && moveNeedsExternalRecipient(moveFromEndpoint, moveToEndpoint) && !moveExternalRecipient.trim()) {
    moveExternalRecipient = resolveSelfEoaAddress();
  }
  $: if (assetWorkspaceTab === 'move' && moveNeedsReserveRecipient(moveFromEndpoint, moveToEndpoint) && !moveReserveRecipientEntityId.trim()) {
    moveReserveRecipientEntityId = resolveSelfEntityId();
  }
  $: if (assetWorkspaceTab === 'move' && moveToEndpoint === 'account' && !moveTargetEntityId.trim()) {
    moveTargetEntityId = resolveSelfEntityId();
  }
  $: moveHubEntityOptions = (() => {
    const ids = new Map<string, string>();
    const add = (candidate: unknown) => {
      const raw = String(candidate || '').trim();
      if (!isFullEntityId(raw)) return;
      const normalized = raw.toLowerCase();
      if (!ids.has(normalized)) ids.set(normalized, normalized);
    };
    const recipientEntityId = String(moveTargetEntityId || resolveSelfEntityId() || '').trim().toLowerCase();
    const recipientProfile = getGossipProfiles(activeEnv).find(
      (profile: GossipProfile) => String(profile.entityId || '').trim().toLowerCase() === recipientEntityId,
    );
    for (const account of Array.isArray(recipientProfile?.accounts) ? recipientProfile!.accounts : []) {
      add(account?.counterpartyId);
    }
    if (recipientEntityId === resolveSelfEntityId()) {
      for (const id of workspaceAccountIds) add(id);
    }
    return Array.from(ids.values()).sort();
  })();
  $: if (assetWorkspaceTab === 'move' && moveToEndpoint === 'account') {
    const normalizedTargetHub = String(moveTargetHubEntityId || '').trim().toLowerCase();
    if (!normalizedTargetHub) {
      moveTargetHubEntityId = workspaceAccountId || moveHubEntityOptions[0] || '';
    } else if (!moveTargetCounterpartyManualOverride && moveHubEntityOptions.length > 0 && !moveHubEntityOptions.includes(normalizedTargetHub)) {
      moveTargetHubEntityId = workspaceAccountId && moveHubEntityOptions.includes(workspaceAccountId)
        ? workspaceAccountId
        : moveHubEntityOptions[0] || '';
    }
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
    return Array.from(env.jReplicas.values());
  })() as Array<{ name?: string }>;

  $: {
    if (showJurisdiction && availableJurisdictions.length > 0 && !selectedJurisdictionName) {
      selectedJurisdictionName = getActiveJurisdictionName(activeEnv) ?? availableJurisdictions[0]?.name ?? null;
    }
  }

  let openAccountEntityOptions: string[] = [];
  let moveEntityOptions: string[] = [];
  let moveSourceAccountOptions: string[] = [];

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
    for (const profile of getGossipProfiles(activeEnv)) add(profile.entityId);
    return Array.from(ids.values()).sort();
  })();

  $: moveEntityOptions = (() => {
    const ids = new Map<string, string>();
    const selfId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const add = (candidate: unknown) => {
      const raw = String(candidate || '').trim();
      if (!isFullEntityId(raw)) return;
      const normalized = raw.toLowerCase();
      if (!ids.has(normalized)) ids.set(normalized, normalized);
    };

    if (selfId) add(selfId);
    for (const id of accountIds) add(id);
    for (const id of openAccountEntityOptions) add(id);
    for (const key of activeReplicas?.keys?.() || []) add(String(key).split(':')[0]);
    for (const profile of getGossipProfiles(activeEnv)) add(profile.entityId);
    return Array.from(ids.values());
  })();
  $: moveSourceAccountOptions = (() => {
    const ordered = new Map<string, string>();
    for (const id of workspaceAccountIds) {
      const normalized = String(id || '').trim().toLowerCase();
      if (normalized && !ordered.has(normalized)) ordered.set(normalized, normalized);
    }
    for (const id of accountIds) {
      const normalized = String(id || '').trim().toLowerCase();
      if (normalized && !ordered.has(normalized)) ordered.set(normalized, normalized);
    }
    return Array.from(ordered.values());
  })();

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

  interface ReserveTransferAsset {
    symbol: string;
    address: string;
    balance: bigint;
    decimals: number;
    tokenId: number;
  }

  function normalizeOptionalTokenId(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'bigint') {
      const numeric = Number(value);
      return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const numeric = Number(value.trim());
      return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
    }
    return undefined;
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
  type MoveEndpoint = 'external' | 'reserve' | 'account';
  let moveFromEndpoint: MoveEndpoint = 'external';
  let moveToEndpoint: MoveEndpoint = 'reserve';
  let moveAssetSymbol = 'USDC';
  let moveAmount = '';
  let moveExternalRecipient = '';
  let moveReserveRecipientEntityId = '';
  let moveSourceAccountId = '';
  let moveTargetEntityId = '';
  let moveTargetHubEntityId = '';
  let moveTargetCounterpartyManualOverride = false;
  let moveExecuting = false;
  let moveProgressLabel = '';
  let moveLayoutSignature = '';
  let moveDraftError: string | null = null;
  let moveBroadcastError: string | null = null;
  let moveSelectedSource: MoveEndpoint | null = null;
  let moveSelectedTarget: MoveEndpoint | null = null;
  let moveDragSource: MoveEndpoint | null = null;
  let moveDragHoverTarget: MoveEndpoint | null = null;
  let moveVisualRoot: HTMLDivElement | null = null;
  let previousMoveVisualRoot: HTMLDivElement | null = null;
  const moveNodeRefs = new Map<string, HTMLButtonElement>();
  let externalToReserveAmount = '';
  let reserveToCollateralAmount = '';
  let collateralToReserveAmount = '';
  let reserveToExternalAmount = '';
  let sendingExternalToken: string | null = null;
  let transferableAssetOptions: ReserveTransferAsset[] = [];
  let assetLedgerRows: AssetLedgerRow[] = [];
  let moveUiState: MoveUiState = {
    ledgerRow: null,
    displayBalances: { external: 0n, reserve: 0n, account: 0n },
    displayDecimals: 18,
    sourceAvailableBalance: 0n,
  };
  let lastMoveAmountContextKey = '';
  let accountSpendableByToken = new Map<number, bigint>();
  let pendingAssetBridgeSync: {
    tokenId: number;
    symbol: string;
    direction: 'deposit' | 'withdraw';
    baselineReserve: bigint;
  } | null = null;
  let resolvingAssetBridgeSync = false;
  type MovePostSettleOp =
    | { type: 'none' }
    | { type: 'r2r'; recipientEntityId: string }
    | { type: 'r2e'; recipientEoa: string }
    | { type: 'reserve_to_collateral'; targetEntityId: string; counterpartyEntityId: string };
  type PendingAssetAutoC2R = {
    counterpartyEntityId: string;
    tokenId: number;
    symbol: string;
    amount: bigint;
    postSettleOp: MovePostSettleOp;
    broadcast: boolean;
    phase: 'awaiting_settlement_execute' | 'awaiting_follow_up';
  };
  let pendingAssetAutoC2Rs: PendingAssetAutoC2R[] = [];
  let resolvingAssetAutoC2R = false;
  let externalFetchInFlight: Promise<void> | null = null;
  let cachedExternalTokenRegistry: ExternalToken[] | null = null;
  let cachedExternalTokenRegistryKey = '';
  let selectedExternalToReserveToken: ReserveTransferAsset | null = null;
  let selectedReserveToCollateralToken: ReserveTransferAsset | null = null;
  let selectedCollateralToReserveToken: ReserveTransferAsset | null = null;
  let selectedReserveToExternalToken: ReserveTransferAsset | null = null;
  let selectedSendAssetToken: ExternalToken | null = null;
  let moveAssetOptions: Array<{ symbol: string }> = [];
  let selectedMoveExternalToken: ExternalToken | null = null;
  let selectedMoveTransferToken: ReserveTransferAsset | null = null;

  $: if (moveVisualRoot !== previousMoveVisualRoot) {
    moveVisualResizeObserver?.disconnect();
    moveVisualResizeObserver = null;
    resetMoveLineMeasurement();
    previousMoveVisualRoot = moveVisualRoot;
    if (moveVisualRoot && typeof ResizeObserver === 'function') {
      moveVisualResizeObserver = new ResizeObserver(() => {
        bumpMoveNodeLayout();
      });
      moveVisualResizeObserver.observe(moveVisualRoot);
    }
    bumpMoveNodeLayout();
  }
  $: moveLayoutSignature = [
    assetWorkspaceTab,
    moveFromEndpoint,
    moveToEndpoint,
    moveSelectedSource || '',
    moveSelectedTarget || '',
    moveNeedsReserveRecipient(moveFromEndpoint, moveToEndpoint) ? 'reserve-recipient' : '',
    moveNeedsExternalRecipient(moveFromEndpoint, moveToEndpoint) ? 'external-recipient' : '',
    moveToEndpoint === 'account' ? 'target-account' : '',
  ].join('|');
  $: if (assetWorkspaceTab === 'move') {
    void moveLayoutSignature;
    bumpMoveNodeLayout();
  }

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

  type MoveUiState = {
    ledgerRow: AssetLedgerRow | null;
    displayBalances: Record<MoveEndpoint, bigint>;
    displayDecimals: number;
    sourceAvailableBalance: bigint;
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

  function compareText(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function compareTokenSymbols(left: string, right: string): number {
    const leftRank = getTokenUiRank(left);
    const rightRank = getTokenUiRank(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return compareText(left, right);
  }

  function sortExternalTokens(tokens: ExternalToken[]): ExternalToken[] {
    const deduped = new Map<string, ExternalToken>();
    for (const token of tokens) {
      const key = String(token.symbol || '').trim().toUpperCase();
      if (!key) continue;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, token);
        continue;
      }
      deduped.set(key, {
        ...existing,
        address: existing.address || token.address,
        decimals: existing.decimals ?? token.decimals,
        tokenId: existing.tokenId ?? token.tokenId,
        balance: existing.balance > token.balance ? existing.balance : token.balance,
      });
    }
    return [...deduped.values()].sort((left, right) => compareTokenSymbols(left.symbol, right.symbol));
  }

  function choosePreferredAssetSymbol(tokens: ExternalToken[]): string {
    const ordered = sortExternalTokens(tokens);
    return ordered[0]?.symbol ?? 'USDC';
  }

  function findExternalTokenBySymbol(symbol: string): ExternalToken | null {
    const normalized = symbol.trim().toUpperCase();
    return externalTokens.find((token) => token.symbol.toUpperCase() === normalized) ?? null;
  }

  function findAssetLedgerRowBySymbol(symbol: string): AssetLedgerRow | null {
    const normalized = String(symbol || '').trim().toUpperCase();
    if (!normalized) return null;
    return assetLedgerRows.find((row) => String(row.symbol || '').trim().toUpperCase() === normalized) ?? null;
  }

  function findReserveTransferTokenBySymbol(symbol: string): ReserveTransferAsset | null {
    const token = findExternalTokenBySymbol(symbol);
    if (token && isReserveTransferToken(token)) {
      return token;
    }
    const row = findAssetLedgerRowBySymbol(symbol);
    if (!row || row.isNative || typeof row.tokenId !== 'number' || row.tokenId <= 0) return null;
    const meta = resolveReserveTokenMeta(row.tokenId, row.symbol);
    return {
      symbol: row.symbol,
      address: row.address || '',
      balance: row.externalBalance ?? 0n,
      decimals: row.decimals ?? meta.decimals,
      tokenId: row.tokenId,
    };
  }

  function getFaucetReserveTokenMeta(symbol: string): { tokenId: number; symbol: string } | null {
    const row = findAssetLedgerRowBySymbol(symbol);
    if (!row || row.isNative || typeof row.tokenId !== 'number' || row.tokenId <= 0) return null;
    return {
      tokenId: row.tokenId,
      symbol: row.symbol,
    };
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

  function getDerivedDeltaForAccount(counterpartyEntityId: string, tokenId: number) {
    const account = counterpartyEntityId ? findLocalAccountByCounterparty(String(replica?.state?.entityId || tab.entityId || ''), replica?.state?.accounts, counterpartyEntityId) : null;
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const counterpartyId = String(counterpartyEntityId || '').trim().toLowerCase();
    if (!account || !entityId || !counterpartyId || !activeXlnFunctions?.deriveDelta) return null;
    const delta = account.deltas?.get?.(tokenId);
    if (!delta) return null;
    return activeXlnFunctions.deriveDelta(delta, isAccountLeftPerspective(entityId, account));
  }

  function getWorkspaceDerivedDelta(tokenId: number) {
    return getDerivedDeltaForAccount(workspaceAccountId, tokenId);
  }

  function getWorkspaceWithdrawableCollateral(tokenId: number): bigint {
    const derived = getWorkspaceDerivedDelta(tokenId);
    if (!derived) return 0n;
    const hold = derived.outTotalHold ?? 0n;
    return derived.outCollateral > hold ? derived.outCollateral - hold : 0n;
  }

  function getAccountWithdrawableCollateral(counterpartyEntityId: string, tokenId: number): bigint {
    const derived = getDerivedDeltaForAccount(counterpartyEntityId, tokenId);
    if (!derived) return 0n;
    const hold = derived.outTotalHold ?? 0n;
    return derived.outCollateral > hold ? derived.outCollateral - hold : 0n;
  }

  function getAccountSpendableCapacity(counterpartyEntityId: string, tokenId: number): bigint {
    const derived = getDerivedDeltaForAccount(counterpartyEntityId, tokenId);
    if (!derived) return 0n;
    return derived.outCapacity;
  }

  function isLocalExecutorForWorkspace(counterpartyEntityId: string, account: AccountMachine | null): boolean {
    const workspace = account?.settlementWorkspace;
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const counterparty = String(counterpartyEntityId || '').trim().toLowerCase();
    if (!workspace || workspace.status !== 'ready_to_submit' || !entityId || !counterparty) return false;
    return workspace.executorIsLeft === isAccountLeftPerspective(entityId, account);
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

  function formatInlineFillAmount(amount: bigint, decimals?: number): string {
    if (amount <= 0n) return '0';
    return formatTokenInputAmount(amount, Math.max(0, Math.floor(Number(decimals ?? getMoveDisplayDecimals()) || 0)));
  }

  async function resolveCurrentExternalAddress(): Promise<string> {
    const signerId = String(currentSignerId || '').trim();
    if (isAddress(signerId)) return signerId;

    const xln = await getXLN();
    const getCachedSignerPrivateKey = xln.getCachedSignerPrivateKey;
    if (!getCachedSignerPrivateKey) throw new Error('Cached signer key reader unavailable');
    const privKey = getCachedSignerPrivateKey(signerId);
    if (!privKey) throw new Error(`No registered signer key for ${signerId}`);
    return new EthersWallet(hexlify(privKey)).address;
  }

  async function withdrawReserveToExternal(tokenId: number, amountOverride?: bigint, recipientEoaOverride?: string): Promise<void> {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) {
      notifyUserActionError('reserve-to-external', 'Active entity missing for reserve withdrawal');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Withdraw requires LIVE mode');
      return;
    }

    const info = resolveReserveTokenMeta(tokenId);
    withdrawingExternalToken = info.symbol;
    try {
      const env = requireRuntimeEnv(activeEnv, 'reserve-to-external');
      const signerId = requireSignerIdForEntity(env, entityId, 'reserve-to-external');
      const amount = amountOverride ?? parsePositiveAssetAmount(
        reserveToExternalAmount,
        info,
        onchainReserves.get(tokenId) ?? 0n,
      );
      const externalAddress = recipientEoaOverride || await resolveCurrentExternalAddress();
      const receivingEntity = zeroPadValue(externalAddress, 32).toLowerCase();

      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [
          {
            type: 'r2e',
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

  async function reserveToReserve(tokenId: number, amount: bigint, recipientEntityIdOverride?: string): Promise<void> {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Active entity missing for reserve transfer');
    if (!activeIsLive) throw new Error('Reserve transfer requires LIVE mode');
    const recipientEntityId = String(recipientEntityIdOverride || moveReserveRecipientEntityId || '').trim().toLowerCase();
    if (!recipientEntityId) throw new Error('Select recipient entity');
    if (recipientEntityId === entityId) throw new Error('Recipient entity must be different from self');
    const env = requireRuntimeEnv(activeEnv, 'reserve-to-reserve');
    const signerId = requireSignerIdForEntity(env, entityId, 'reserve-to-reserve');
    await enqueueEntityInputs(env, [{
      entityId,
      signerId,
      entityTxs: [
        {
          type: 'r2r',
          data: {
            toEntityId: recipientEntityId,
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
  }

  async function faucetReserves(tokenId: number = 1, symbolHint?: string) {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) {
      notifyUserActionError('reserve-faucet', 'Active entity missing for reserve faucet');
      return;
    }
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
    if (!entityId) {
      notifyUserActionError('offchain-faucet', 'Active entity missing for offchain faucet');
      return;
    }
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
    if (!entityId) {
      notifyUserActionError('quick-settle-approve', 'Active entity missing for settlement approval');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Settlement signature requires LIVE mode');
      return;
    }

    try {
      const env = requireRuntimeEnv(activeEnv, 'quick-settle-approve');
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
    const signerId = String(currentSignerId || '').trim().toLowerCase();
    const runtimeId = getRuntimeId(activeEnv);
    const jurisdiction = String(getActiveJurisdictionName(activeEnv) || '').trim().toLowerCase();
    const cacheKey = `${signerId}|${runtimeId}|${jurisdiction}`;
    if (cachedExternalTokenRegistry && cachedExternalTokenRegistryKey === cacheKey) {
      return cachedExternalTokenRegistry.map((token) => ({ ...token, balance: 0n }));
    }

    let tokens: ExternalToken[] = [];
    if (jadapter?.getTokenRegistry) {
      const registry = await jadapter.getTokenRegistry();
      if (registry?.length) {
        tokens = registry.map((t: JTokenRegistryItem) => ({
          symbol: t.symbol,
          address: t.address,
          balance: 0n,
          decimals: typeof t.decimals === 'number' ? t.decimals : 18,
          tokenId: normalizeOptionalTokenId(t.tokenId),
        }));
      }
    }

    if (tokens.length === 0) {
      const apiTokens = await fetchTokenCatalog();
      tokens = apiTokens.length > 0
        ? apiTokens.map(t => ({ ...t, balance: 0n }))
        : [];
    }

    cachedExternalTokenRegistryKey = cacheKey;
    cachedExternalTokenRegistry = tokens.map((token) => ({ ...token, balance: 0n }));
    return cachedExternalTokenRegistry.map((token) => ({ ...token, balance: 0n }));
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
    const pending = pendingAssetAutoC2Rs[0];
    if (!pending || resolvingAssetAutoC2R) {
      // no-op
    } else {
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
        pendingAssetAutoC2Rs = pendingAssetAutoC2Rs.filter((entry) => entry !== pending);
        resolvingAssetAutoC2R = false;
        refreshPendingCollateralFundingToken();
      } else if (!sentBatchPending && isLocalExecutorForWorkspace(pending.counterpartyEntityId, currentAccount)) {
        resolvingAssetAutoC2R = true;
        void (async () => {
          try {
            const env = requireRuntimeEnv(activeEnv, 'asset-c2r-auto-execute');
            const entityId = replica?.state?.entityId || tab.entityId;
            if (!entityId) throw new Error('Environment not ready');
            const signerId = resolveEntitySigner(entityId, 'asset-c2r-auto-execute');
            await enqueueEntityInputs(env, [
              buildEntityInput(entityId, signerId, buildMovePostSettleTxs(entityId, pending)),
            ]);
            collateralToReserveAmount = '';
            toasts.info(
              pending.broadcast
                ? `Collateral → Reserve pending on-chain confirmation for ${pending.symbol}.`
                : `Collateral → Reserve added to draft batch for ${pending.symbol}.`,
            );
          } catch (err) {
            console.error('[EntityPanel] Asset C→R auto-execute failed:', err);
            toasts.error(`Collateral → Reserve failed: ${toErrorMessage(err, 'Unknown error')}`);
          } finally {
            pendingAssetAutoC2Rs = pendingAssetAutoC2Rs.filter((entry) => entry !== pending);
            resolvingAssetAutoC2R = false;
            refreshPendingCollateralFundingToken();
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
  $: moveAssetOptions = assetLedgerRows
    .filter((row) => {
      const symbol = String(row.symbol || '').trim();
      if (!symbol) return false;
      const externalToken = findExternalTokenBySymbol(symbol);
      const reserveToken = findReserveTransferTokenBySymbol(symbol);
      if (moveFromEndpoint === 'external') {
        if (!externalToken) return false;
        if (moveToEndpoint === 'external') return true;
        return !!reserveToken;
      }
      return !!reserveToken;
    })
    .map((row) => ({ symbol: row.symbol }));
  $: selectedMoveExternalToken = findExternalTokenBySymbol(moveAssetSymbol);
  $: selectedMoveTransferToken = findReserveTransferTokenBySymbol(moveAssetSymbol);
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
    for (const [tokenId, accountBalance] of accountSpendableByToken.entries()) {
      const numericId = Number(tokenId);
      if (!Number.isFinite(numericId) || numericId <= 0) continue;
      const existing = Array.from(rows.values()).find((row) => row.tokenId === numericId);
      if (existing) continue;
      const info = resolveReserveTokenMeta(numericId);
      const accountUsd = getAssetValue(numericId, accountBalance, info.symbol);
      rows.set(info.symbol, {
        symbol: info.symbol,
        address: '',
        decimals: info.decimals,
        tokenId: numericId,
        isNative: false,
        externalBalance: 0n,
        reserveBalance: 0n,
        accountBalance,
        externalUsd: 0,
        reserveUsd: 0,
        accountUsd,
        totalUsd: accountUsd,
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
    const symbol = String(moveAssetSymbol || '').trim().toUpperCase();
    const row = symbol
      ? assetLedgerRows.find((candidate) => String(candidate.symbol || '').trim().toUpperCase() === symbol) ?? null
      : null;
    const nextState: MoveUiState = {
      ledgerRow: row,
      displayBalances: row
        ? {
            external: row.externalBalance,
            reserve: row.reserveBalance,
            account: row.accountBalance,
          }
        : { external: 0n, reserve: 0n, account: 0n },
      displayDecimals: row?.decimals
        ?? selectedMoveExternalToken?.decimals
        ?? selectedMoveTransferToken?.decimals
        ?? 18,
      sourceAvailableBalance: computeMoveSourceAvailableBalance(row, selectedMoveTransferToken),
    };
    moveUiState = nextState;
  }

  $: {
    const preferred = choosePreferredAssetSymbol(externalTokens);
    const preferredFaucetSymbol =
      assetLedgerRows.find((row) => !row.isNative && typeof row.tokenId === 'number' && row.tokenId > 0)?.symbol
      ?? preferred;
    if (!findAssetLedgerRowBySymbol(faucetAssetSymbol)) faucetAssetSymbol = preferredFaucetSymbol;
    if (!findExternalTokenBySymbol(sendAssetSymbol)) sendAssetSymbol = preferred;
    if (!findReserveTransferTokenBySymbol(externalToReserveSymbol)) externalToReserveSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    if (!findReserveTransferTokenBySymbol(reserveToCollateralSymbol)) reserveToCollateralSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    if (!findReserveTransferTokenBySymbol(collateralToReserveSymbol)) collateralToReserveSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    if (!findReserveTransferTokenBySymbol(reserveToExternalSymbol)) reserveToExternalSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    const movePreferred = choosePreferredMoveAssetSymbol();
    if (
      !moveAssetOptions.some((token) => token.symbol.toUpperCase() === String(moveAssetSymbol || '').trim().toUpperCase())
    ) {
      moveAssetSymbol = movePreferred;
    }
  }

  $: {
    const moveAmountContextKey = [
      assetWorkspaceTab,
      accountWorkspaceTab,
      moveFromEndpoint,
      moveToEndpoint,
      moveAssetSymbol,
      getCurrentMoveSourceAccountId(),
    ].join('|');
    if (moveAmountContextKey !== lastMoveAmountContextKey) {
      lastMoveAmountContextKey = moveAmountContextKey;
    }
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
        tokenId: normalizeOptionalTokenId(t.tokenId),
      }));
    } catch {
      return [];
    }
  }

  // Fetch external tokens (ERC20 balances for signer) - works for both BrowserVM and RPC modes
  async function fetchExternalTokens() {
    if (externalFetchInFlight) {
      return await externalFetchInFlight;
    }
    externalFetchInFlight = (async () => {
      const signerId = String(currentSignerId || '').trim();
      const runtimeId = getRuntimeId(activeEnv);
      const jurisdiction = String(getActiveJurisdictionName(activeEnv) || '');
      const fetchKey = `${signerId}|${runtimeId}|${jurisdiction}`;
      externalTokensLoading = true;
      if (!signerId) {
        externalTokensLoading = false;
        return;
      }

      try {
        const xln = await getXLN();
        const envAtStart = getRuntimeEnv(activeEnv);
        const jadapter = xln.getActiveJAdapter?.(envAtStart ?? null);
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
        if (!jadapter?.getErc20Balances) {
          externalTokens = sortExternalTokens(tokenList);
          externalTokensLoading = false;
          return;
        }

        const balances = await jadapter.getErc20Balances(tokenList.map(t => t.address), signerId);
        balances.forEach((balance: bigint, idx: number) => {
          if (tokenList[idx]) tokenList[idx].balance = balance;
        });

        const runtimeIdNow = getRuntimeId(activeEnv);
        const jurisdictionNow = String(getActiveJurisdictionName(activeEnv) || '');
        const currentKey = `${String(currentSignerId || '').trim()}|${runtimeIdNow}|${jurisdictionNow}`;
        if (currentKey === fetchKey) {
          externalTokens = sortExternalTokens(nativeToken ? [nativeToken, ...tokenList] : tokenList);
          externalTokensLoading = false;
        }
      } catch (err) {
        console.error('[EntityPanel] Failed to fetch external tokens:', err);
        externalTokensLoading = false;
      }
    })().finally(() => {
      externalFetchInFlight = null;
    });
    return await externalFetchInFlight;
  }

  async function getActiveSignerPrivateKey(): Promise<Uint8Array> {
    const signerId = String(currentSignerId || '').trim();
    if (!signerId) throw new Error('No active signer selected');
    const xln = await getXLN();
    const getCachedSignerPrivateKey = xln.getCachedSignerPrivateKey;
    if (!getCachedSignerPrivateKey) throw new Error('Cached signer key reader unavailable');
    const privKey = getCachedSignerPrivateKey(signerId);
    if (!privKey) throw new Error(`No registered signer key for ${signerId}`);
    return privKey;
  }

  async function sendExternalAsset(): Promise<void> {
    const token = requireExternalTokenBySymbol(sendAssetSymbol);
    const recipient = sendAssetRecipient.trim();
    if (!isAddress(recipient)) throw new Error('Recipient must be a valid EOA address');
    const amount = parsePositiveAssetAmount(sendAssetAmount, token, token.balance);
    const xln = await getXLN();
    const jadapter = xln.getActiveJAdapter?.(requireRuntimeEnv(activeEnv, 'send-external-asset'));
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

  async function collateralToReserve(
    tokenId: number,
    amount: bigint,
    counterpartyEntityIdOverride?: string,
    postSettleOp: MovePostSettleOp = { type: 'none' },
    broadcast = true,
  ): Promise<void> {
    const entityId = replica?.state?.entityId || tab.entityId;
    const counterpartyEntityId = String(counterpartyEntityIdOverride || workspaceAccountId || '').trim();
    if (!entityId) {
      notifyUserActionError('collateral-to-reserve', 'Active entity missing for account withdrawal');
      return;
    }
    if (!counterpartyEntityId) {
      toasts.error('Select an account first');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Collateral → Reserve requires LIVE mode');
      return;
    }
    try {
      const env = requireRuntimeEnv(activeEnv, 'collateral-to-reserve');
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

      pendingAssetAutoC2Rs = [...pendingAssetAutoC2Rs, {
        counterpartyEntityId,
        tokenId,
        symbol: info.symbol,
        amount,
        postSettleOp,
        broadcast,
        phase: 'awaiting_settlement_execute',
      }];
      refreshPendingCollateralFundingToken();
      toasts.info(`Collateral → Reserve proposed for ${info.symbol}. Waiting for counterparty signature...`);
    } catch (err) {
      console.error('[EntityPanel] Collateral → Reserve failed:', err);
      toasts.error(`Collateral → Reserve failed: ${(err as Error).message}`);
    }
  }

  function fillMoveMax(): void {
    const decimals = getMoveDisplayDecimals();
    moveAmount = formatTokenInputAmount(getCurrentMoveSourceAvailableBalance(), decimals);
  }

  function clearMoveComposer(): void {
    resetMoveRoute();
  }

  function openAssetMoveWorkspace(): void {
    assetWorkspaceTab = 'move';
    moveFromEndpoint = 'external';
    moveToEndpoint = 'reserve';
    if (!moveExternalRecipient.trim()) moveExternalRecipient = resolveSelfEoaAddress();
    if (!moveReserveRecipientEntityId.trim()) moveReserveRecipientEntityId = resolveSelfEntityId();
    moveAssetSymbol = choosePreferredMoveAssetSymbol();
    resetMoveLineMeasurement();
    bumpMoveNodeLayout();
  }

  function openAccountMoveWorkspace(): void {
    accountWorkspaceTab = 'move';
    moveFromEndpoint = 'account';
    moveToEndpoint = 'account';
    if (!moveSourceAccountId || !workspaceAccountIds.includes(moveSourceAccountId)) {
      moveSourceAccountId = workspaceAccountId || workspaceAccountIds[0] || '';
    }
    if (!moveTargetEntityId.trim()) moveTargetEntityId = resolveSelfEntityId();
    if (!moveTargetCounterpartyManualOverride || !moveTargetHubEntityId.trim()) {
      moveTargetHubEntityId = workspaceAccountId || moveHubEntityOptions[0] || '';
    }
    moveAssetSymbol = choosePreferredMoveAssetSymbol();
    resetMoveLineMeasurement();
    bumpMoveNodeLayout();
  }

  function openAssetHistoryWorkspace(): void {
    assetWorkspaceTab = 'history';
  }

  function openAccountHistoryWorkspace(): void {
    accountWorkspaceTab = 'history';
  }

  function handleMoveWorkspaceError(err: unknown): void {
    toasts.error(`Move failed: ${toErrorMessage(err, 'Unknown error')}`);
  }

  function setMoveProgress(label: string): void {
    moveProgressLabel = label;
  }

  async function waitForMoveCondition(
    predicate: () => boolean,
    label: string,
    timeoutMs = 20_000,
    pollMs = 100,
  ): Promise<void> {
    setMoveProgress(label);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(pollMs);
    }
    throw new Error(`${label} did not complete in time`);
  }

  function buildMovePostSettleTxs(entityId: string, pending: PendingAssetAutoC2R): EntityTx[] {
    const needsFollowUpReserveOp = pending.postSettleOp.type !== 'none';
    const entityTxs: EntityTx[] = [
      {
        type: 'settle_execute' as const,
        data: {
          counterpartyEntityId: pending.counterpartyEntityId,
          ...(needsFollowUpReserveOp ? { disableC2RShortcut: true } : {}),
        },
      },
    ];
    if (pending.postSettleOp.type === 'r2r') {
      entityTxs.push({
        type: 'r2r' as const,
        data: {
          toEntityId: pending.postSettleOp.recipientEntityId,
          tokenId: pending.tokenId,
          amount: pending.amount,
        },
      });
    }
    if (pending.postSettleOp.type === 'r2e') {
      entityTxs.push({
        type: 'r2e' as const,
        data: {
          receivingEntity: zeroPadValue(pending.postSettleOp.recipientEoa, 32).toLowerCase(),
          tokenId: pending.tokenId,
          amount: pending.amount,
        },
      });
    }
    if (pending.postSettleOp.type === 'reserve_to_collateral') {
      entityTxs.push({
        type: 'r2c' as const,
        data: {
          counterpartyId: pending.postSettleOp.counterpartyEntityId,
          ...(pending.postSettleOp.targetEntityId !== String(entityId).trim().toLowerCase()
            ? { receivingEntityId: pending.postSettleOp.targetEntityId }
            : {}),
          tokenId: pending.tokenId,
          amount: pending.amount,
        },
      });
    }
    if (pending.broadcast) {
      entityTxs.push({
        type: 'j_broadcast' as const,
        data: {},
      });
    }
    return entityTxs;
  }

  function canAddMoveToExistingBatch(): boolean {
    const routeKey = getMoveRouteKey(moveFromEndpoint, moveToEndpoint);
    return routeKey === 'external->reserve'
      || routeKey === 'external->account'
      || routeKey === 'reserve->reserve'
      || routeKey === 'reserve->external'
      || routeKey === 'reserve->account'
      || routeKey === 'account->reserve'
      || routeKey === 'account->external'
      || routeKey === 'account->account';
  }

  async function queueReserveToReserveDraft(
    tokenId: number,
    amount: bigint,
    recipientEntityIdOverride?: string,
  ): Promise<void> {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Active entity missing for reserve batch');
    if (!activeIsLive) throw new Error('Add to batch requires LIVE mode');
    const recipientEntityId = String(recipientEntityIdOverride || moveReserveRecipientEntityId || '').trim().toLowerCase();
    if (!recipientEntityId) throw new Error('Select recipient entity');
    if (recipientEntityId === entityId) throw new Error('Recipient entity must be different from self');
    const env = requireRuntimeEnv(activeEnv, 'move-reserve-to-reserve-draft');
    const signerId = requireSignerIdForEntity(env, entityId, 'move-reserve-to-reserve-draft');
    await enqueueEntityInputs(env, [{
      entityId,
      signerId,
      entityTxs: [{
        type: 'r2r' as const,
        data: {
          toEntityId: recipientEntityId,
          tokenId,
          amount,
        },
      }],
    }]);
  }

  async function queueReserveToExternalDraft(
    tokenId: number,
    amount: bigint,
    recipientEoaOverride?: string,
  ): Promise<void> {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Active entity missing for reserve withdrawal');
    if (!activeIsLive) throw new Error('Add to batch requires LIVE mode');
    const env = requireRuntimeEnv(activeEnv, 'move-reserve-to-external-draft');
    const signerId = requireSignerIdForEntity(env, entityId, 'move-reserve-to-external-draft');
    const externalAddress = recipientEoaOverride || await resolveCurrentExternalAddress();
    if (!isAddress(externalAddress)) throw new Error('Recipient must be a valid EOA address');
    const receivingEntity = zeroPadValue(externalAddress, 32).toLowerCase();
    await enqueueEntityInputs(env, [{
      entityId,
      signerId,
      entityTxs: [{
        type: 'r2e' as const,
        data: {
          receivingEntity,
          tokenId,
          amount,
        },
      }],
    }]);
    await waitForMoveCondition(
      () => {
        const batch = findLiveReplicaForEntity(entityId, signerId)?.state?.jBatchState?.batch;
        return Array.isArray(batch?.reserveToExternalToken)
          && batch.reserveToExternalToken.some((op) =>
            Number(op?.tokenId) === tokenId
            && BigInt(op?.amount || 0n) === amount
            && String(op?.receivingEntity || '').toLowerCase() === receivingEntity,
          );
      },
      'Waiting for reserve withdrawal to appear in draft batch',
    );
  }

  async function queueReserveToCollateralDraft(
    tokenId: number,
    amount: bigint,
    counterpartyEntityIdOverride?: string,
    receivingEntityIdOverride?: string,
  ): Promise<void> {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const signerId = resolveEntitySigner(entityId, 'move-reserve-to-account-draft');
    const counterpartyEntityId = String(counterpartyEntityIdOverride || getCurrentMoveTargetHubId() || workspaceAccountId || selectedAccountId || '').trim();
    const receivingEntityId = String(receivingEntityIdOverride || entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Active entity missing for account funding');
    if (!signerId) throw new Error('Active signer missing for account funding');
    if (!counterpartyEntityId) throw new Error('Select account first');
    if (!activeIsLive) throw new Error('Add to batch requires LIVE mode');

    const accounts = replica?.state?.accounts;
    if (receivingEntityId === String(entityId).trim().toLowerCase() && (!accounts || !findLocalAccountByCounterparty(entityId, accounts, counterpartyEntityId))) {
      throw new Error('No account found for selected counterparty');
    }

    const env = requireRuntimeEnv(activeEnv, 'move-reserve-to-account-draft');
    await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [{
      type: 'r2c' as const,
      data: {
        counterpartyId: counterpartyEntityId,
        ...(receivingEntityId !== String(entityId).trim().toLowerCase() ? { receivingEntityId } : {}),
        tokenId,
        amount,
      },
    }])]);
  }

  async function queueExternalToReserveDraft(
    tokenAddress: string,
    amount: bigint,
    internalTokenId?: number,
  ): Promise<void> {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Active entity missing for external deposit');
    if (!activeIsLive) throw new Error('Add to batch requires LIVE mode');
    if (!isAddress(tokenAddress) || tokenAddress === ZeroAddress) {
      throw new Error('Select ERC20 asset first');
    }
    setMoveProgress('Queuing external deposit into draft batch');
    const env = requireRuntimeEnv(activeEnv, 'move-external-to-reserve-draft');
    const signerId = requireSignerIdForEntity(env, entityId, 'move-external-to-reserve-draft');
    await enqueueEntityInputs(env, [{
      entityId,
      signerId,
      entityTxs: [{
        type: 'e2r' as const,
        data: {
          contractAddress: tokenAddress,
          amount,
          ...(typeof internalTokenId === 'number' ? { internalTokenId } : {}),
        },
      }],
    }]);
  }

  async function addMoveToExistingBatch(skipValidation = false): Promise<void> {
    if (!skipValidation) {
      const validationError = getMoveValidationError('draft');
      if (validationError) throw new Error(validationError);
    }
    if (hasSentBatch) {
      throw new Error('Wait for current batch confirmation or clear it before adding a new move');
    }
    const moveSourceAccount = getCurrentMoveSourceAccountId();
    const moveTargetAccount = getCurrentMoveTargetHubId();
    const moveTargetEntity = getCurrentMoveTargetEntityId();
    const routeKey = getMoveRouteKey(moveFromEndpoint, moveToEndpoint);
    const externalToken = findExternalTokenBySymbol(moveAssetSymbol);
    const reserveToken = findReserveTransferTokenBySymbol(moveAssetSymbol);
    const maxSourceAmount = getCurrentMoveSourceAvailableBalance();
    if (routeKey === 'external->reserve') {
      if (!externalToken || !isAddress(externalToken.address) || externalToken.address === ZeroAddress) {
        throw new Error('Select ERC20 asset first');
      }
      const amount = parsePositiveAssetAmount(moveAmount, externalToken, maxSourceAmount);
      await queueExternalToReserveDraft(externalToken.address, amount, externalToken.tokenId);
      moveAmount = '';
      toasts.success('Added to existing draft batch');
      return;
    }
    if (routeKey === 'external->account') {
      if (!externalToken || !isAddress(externalToken.address) || externalToken.address === ZeroAddress) {
        throw new Error('Select ERC20 asset first');
      }
      if (!reserveToken) throw new Error('Select reserve-compatible asset first');
      const amount = parsePositiveAssetAmount(moveAmount, externalToken, maxSourceAmount);
      await queueExternalToReserveDraft(externalToken.address, amount, reserveToken.tokenId);
      await queueReserveToCollateralDraft(reserveToken.tokenId, amount, moveTargetAccount, moveTargetEntity);
      moveAmount = '';
      toasts.success('Added to existing draft batch');
      return;
    }
    const token = reserveToken;
    if (!token) throw new Error('Select reserve-compatible asset first');
    if (routeKey === 'reserve->reserve') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      await queueReserveToReserveDraft(token.tokenId, amount, moveReserveRecipientEntityId);
      moveAmount = '';
      toasts.success('Added to existing draft batch');
      return;
    }
    if (routeKey === 'reserve->external') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      const recipient = moveExternalRecipient.trim();
      if (!isAddress(recipient)) throw new Error('Recipient must be a valid EOA address');
      await queueReserveToExternalDraft(token.tokenId, amount, recipient);
      moveAmount = '';
      toasts.success('Added to existing draft batch');
      return;
    }
    if (routeKey === 'reserve->account') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      await queueReserveToCollateralDraft(token.tokenId, amount, moveTargetAccount, moveTargetEntity);
      moveAmount = '';
      toasts.success('Added to existing draft batch');
      return;
    }
    if (routeKey === 'account->reserve') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      await collateralToReserve(token.tokenId, amount, moveSourceAccount, { type: 'none' }, false);
      moveAmount = '';
      toasts.info('Queued for counterparty signature, then added to draft batch');
      return;
    }
    if (routeKey === 'account->external') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      const recipient = moveExternalRecipient.trim();
      if (!isAddress(recipient)) throw new Error('Recipient must be a valid EOA address');
      await collateralToReserve(
        token.tokenId,
        amount,
        moveSourceAccount,
        { type: 'r2e', recipientEoa: recipient },
        false,
      );
      moveAmount = '';
      toasts.info('Queued for counterparty signature, then added to draft batch');
      return;
    }
    if (routeKey === 'account->account') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      await collateralToReserve(
        token.tokenId,
        amount,
        moveSourceAccount,
        {
          type: 'reserve_to_collateral',
          targetEntityId: moveTargetEntity,
          counterpartyEntityId: moveTargetAccount,
        },
        false,
      );
      moveAmount = '';
      toasts.info('Queued for counterparty signature, then added to draft batch');
      return;
    }
  }

  function isExternalTransferMoveRoute(from: MoveEndpoint, to: MoveEndpoint): boolean {
    return getMoveRouteKey(from, to) === 'external->external';
  }

  function isImmediateMoveExecutionRoute(from: MoveEndpoint, to: MoveEndpoint): boolean {
    return getMoveRouteKey(from, to) === 'external->external';
  }

  function getMovePrimaryActionLabel(): string {
    if (isExternalTransferMoveRoute(moveFromEndpoint, moveToEndpoint)) return 'Send Direct';
    return 'Add to Batch';
  }

  async function submitMovePrimaryAction(): Promise<void> {
    if (isImmediateMoveExecutionRoute(moveFromEndpoint, moveToEndpoint)) {
      await executeMovePlan();
      return;
    }
    const validationError = getMoveValidationError('draft');
    if (validationError) throw new Error(validationError);
    moveExecuting = true;
    moveProgressLabel = '';
    try {
      await addMoveToExistingBatch(true);
      moveProgressLabel = '';
    } catch (err) {
      moveProgressLabel = '';
      throw err;
    } finally {
      moveExecuting = false;
    }
  }

  async function executeMovePlan(): Promise<void> {
    const validationError = getMoveValidationError('broadcast');
    if (validationError) throw new Error(validationError);

    const moveSourceAccount = getCurrentMoveSourceAccountId();
    const moveTargetAccount = getCurrentMoveTargetHubId();
    const moveTargetEntity = getCurrentMoveTargetEntityId();
    const moveReserveRecipient = String(moveReserveRecipientEntityId || '').trim().toLowerCase();

    moveExecuting = true;
    moveProgressLabel = '';
    try {
      const routeKey = getMoveRouteKey(moveFromEndpoint, moveToEndpoint);
      if (routeKey === 'external->external') {
        const token = requireExternalTokenBySymbol(moveAssetSymbol);
        const recipient = moveExternalRecipient.trim();
        if (!isAddress(recipient)) throw new Error('Recipient must be a valid EOA address');
        setMoveProgress('Signing external transfer');
        sendAssetSymbol = moveAssetSymbol;
        sendAssetAmount = moveAmount;
        sendAssetRecipient = recipient;
        await sendExternalAsset();
        moveAmount = '';
        return;
      }

      const token = findReserveTransferTokenBySymbol(moveAssetSymbol);
      if (!token) {
        throw new Error('Select reserve-compatible asset first');
      }
      const maxAmount = moveUiState.sourceAvailableBalance;
      const amount = parsePositiveAssetAmount(moveAmount, token, maxAmount ?? undefined);
      const reserveBefore = onchainReserves.get(token.tokenId) ?? 0n;
      const selfEntityId = resolveSelfEntityId();
      const reserveRecipientIsSelf = !moveReserveRecipient || moveReserveRecipient === selfEntityId;

      switch (routeKey) {
        case 'reserve->reserve':
          setMoveProgress(`Transferring reserve balance to ${formatAddress(moveReserveRecipient)}`);
          await reserveToReserve(token.tokenId, amount, moveReserveRecipient);
          break;
        case 'reserve->account':
          setMoveProgress(`Funding ${formatAddress(moveTargetEntity)} via hub ${formatAddress(moveTargetAccount)}`);
          await reserveToCollateral(token.tokenId, amount, moveTargetAccount, moveTargetEntity);
          break;
        case 'account->reserve':
          setMoveProgress('Requesting hub proof and settling account back to your reserve');
          await collateralToReserve(
            token.tokenId,
            amount,
            moveSourceAccount,
            reserveRecipientIsSelf
              ? { type: 'none' }
              : { type: 'r2r', recipientEntityId: moveReserveRecipient },
          );
          break;
        case 'reserve->external':
          setMoveProgress('Withdrawing from your reserve to recipient EOA');
          await withdrawReserveToExternal(token.tokenId, amount, moveExternalRecipient.trim());
          break;
        case 'account->external':
          setMoveProgress('Requesting hub proof and settling account back to your reserve');
          await collateralToReserve(
            token.tokenId,
            amount,
            moveSourceAccount,
            { type: 'r2e', recipientEoa: moveExternalRecipient.trim() },
          );
          break;
        case 'account->account':
          setMoveProgress('Requesting hub proof and settling account back to your reserve');
          await collateralToReserve(
            token.tokenId,
            amount,
            moveSourceAccount,
            {
              type: 'reserve_to_collateral',
              targetEntityId: moveTargetEntity,
              counterpartyEntityId: moveTargetAccount,
            },
          );
          break;
        default:
          throw new Error('Route not implemented');
      }

      moveAmount = '';
      moveProgressLabel = '';
      toasts.success(`Queued ${MOVE_ENDPOINT_LABEL[moveFromEndpoint]} → ${MOVE_ENDPOINT_LABEL[moveToEndpoint]}`);
    } catch (err) {
      moveProgressLabel = '';
      throw err;
    } finally {
      moveExecuting = false;
    }
  }

  // Reserve → Collateral (deposit reserves into selected bilateral account)
  async function reserveToCollateral(
    tokenId: number,
    amountOverride?: bigint,
    counterpartyEntityIdOverride?: string,
    receivingEntityIdOverride?: string,
  ) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'reserve-to-collateral');
    const counterpartyEntityId = String(counterpartyEntityIdOverride || workspaceAccountId || selectedAccountId || '').trim();
    const receivingEntityId = String(receivingEntityIdOverride || entityId || '').trim().toLowerCase();
    if (!entityId) {
      notifyUserActionError('reserve-to-collateral', 'Active entity missing for account funding');
      return;
    }
    if (!signerId) {
      notifyUserActionError('reserve-to-collateral', 'Active signer missing for account funding');
      return;
    }

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
    if (receivingEntityId === String(entityId).trim().toLowerCase() && (!accounts || !findLocalAccountByCounterparty(entityId, accounts, counterpartyEntityId))) {
      toasts.error('No account found for selected counterparty');
      return;
    }

    const info = getTokenInfo(tokenId);
    collateralFundingToken = info.symbol;
    try {
      const env = requireRuntimeEnv(activeEnv, 'reserve-to-collateral');

      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [
          {
            type: 'r2c' as const,
            data: {
              counterpartyId: counterpartyEntityId,
              ...(receivingEntityId !== String(entityId).trim().toLowerCase() ? { receivingEntityId } : {}),
              tokenId,
              amount,
            },
          },
          {
            type: 'j_broadcast',
            data: {},
          },
        ])]);

      toasts.info(`R→C pending on-chain confirmation for ${info.symbol}.`);
    } catch (err) {
      console.error('[EntityPanel] Reserve → Collateral failed:', err);
      toasts.error(`Reserve → Collateral failed: ${(err as Error).message}`);
    } finally {
      collateralFundingToken = null;
    }
  }

  async function openAccountWithFullId(targetEntityId: string) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'open-account');
    const trimmed = targetEntityId.trim().toLowerCase();
    if (!entityId) {
      notifyUserActionError('open-account', 'Active entity missing for open-account');
      return;
    }
    if (!signerId) {
      notifyUserActionError('open-account', 'Active signer missing for open-account');
      return;
    }
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
      const env = requireRuntimeEnv(activeEnv, 'open-account');
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

  function confirmDisputeAction(
    kind: 'start' | 'finalize',
    counterpartyEntityId: string,
  ): boolean {
    const label = pendingBatchEntityLabel(counterpartyEntityId);
    if (kind === 'start') {
      return confirm(
        `Start on-chain dispute with ${label}?\n\nThis adds Dispute Start to the pending batch and freezes normal use of this account until resolved.`,
      );
    }
    return confirm(
      `Finalize on-chain dispute with ${label}?\n\nThis adds Dispute Finalize to the pending batch. Only do this after the dispute timeout has passed.`,
    );
  }

  async function confirmAndQueueDisputeStart(counterpartyEntityId: string, description = 'dispute-from-configure') {
    if (!confirmDisputeAction('start', counterpartyEntityId)) return;
    await queueDisputeStart(counterpartyEntityId, description);
  }

  async function confirmAndQueueDisputeFinalize(counterpartyEntityId: string, description = 'dispute-finalize-from-configure') {
    if (!confirmDisputeAction('finalize', counterpartyEntityId)) return;
    await queueDisputeFinalize(counterpartyEntityId, description);
  }

  async function queueDisputeStart(counterpartyEntityId: string, description = 'dispute-from-configure') {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'dispute-start');
    if (!entityId) {
      notifyUserActionError('dispute-start', 'Active entity missing for dispute start');
      return;
    }
    if (!signerId) {
      notifyUserActionError('dispute-start', 'Active signer missing for dispute start');
      return;
    }
    if (!activeIsLive) { toasts.error('Dispute requires LIVE mode'); return; }
    try {
      const env = requireRuntimeEnv(activeEnv, 'dispute-start');
      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [{
        type: 'disputeStart' as const,
        data: { counterpartyEntityId, description },
      }])]);
      toasts.success('Dispute queued — will be submitted on next batch broadcast');
    } catch (err) {
      console.error('[EntityPanel] Dispute start failed:', err);
      toasts.error(`Dispute failed: ${(err as Error).message}`);
    }
  }

  async function queueDisputeFinalize(counterpartyEntityId: string, description = 'dispute-finalize-from-configure') {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'dispute-finalize');
    if (!entityId) {
      notifyUserActionError('dispute-finalize', 'Active entity missing for dispute finalize');
      return;
    }
    if (!signerId) {
      notifyUserActionError('dispute-finalize', 'Active signer missing for dispute finalize');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Dispute finalize requires LIVE mode');
      return;
    }
    try {
      const env = requireRuntimeEnv(activeEnv, 'dispute-finalize');
      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [{
        type: 'disputeFinalize' as const,
        data: { counterpartyEntityId, description },
      }])]);
      toasts.success('Dispute finalize queued — will be submitted on next batch broadcast');
    } catch (err) {
      console.error('[EntityPanel] Dispute finalize failed:', err);
      toasts.error(`Dispute finalize failed: ${(err as Error).message}`);
    }
  }

  async function reopenDisputedAccount(counterpartyEntityId: string) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'reopen-disputed-account');
    if (!entityId) {
      notifyUserActionError('reopen-disputed-account', 'Active entity missing for reopen');
      return;
    }
    if (!signerId) {
      notifyUserActionError('reopen-disputed-account', 'Active signer missing for reopen');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Reopen account requires LIVE mode');
      return;
    }
    try {
      const env = requireRuntimeEnv(activeEnv, 'reopen-disputed-account');
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

  async function enforceOutstandingDebt(tokenId: number): Promise<void> {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim();
    if (!entityId) {
      notifyUserActionError('debt-enforcement', 'Active entity missing for debt enforcement');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Debt enforcement requires LIVE mode');
      return;
    }
    debtEnforcingTokenId = tokenId;
    try {
      const xln = await getXLN();
      await xln.submitDebtEnforcement(requireRuntimeEnv(activeEnv, 'debt-enforcement'), entityId, tokenId);
      const tokenLabel = getTokenInfo(tokenId).symbol || `Token #${tokenId}`;
      toasts.success(`Debt enforcement submitted for ${tokenLabel}.`);
    } catch (err) {
      console.error('[EntityPanel] Enforce debt failed:', err);
      toasts.error(`Debt enforcement failed: ${(err as Error).message}`);
    } finally {
      debtEnforcingTokenId = null;
    }
  }

  async function addTokenToAccount() {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'add-token-to-account');
    const counterpartyEntityId = String(workspaceAccountId || '').trim();
    if (!entityId) {
      notifyUserActionError('add-token-to-account', 'Active entity missing for add-token');
      return;
    }
    if (!signerId) {
      notifyUserActionError('add-token-to-account', 'Active signer missing for add-token');
      return;
    }
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
      const env = requireRuntimeEnv(activeEnv, 'add-token-to-account');
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
    const signerId = currentSignerId;
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
      toasts.success(`Received ${amount} ${tokenSymbol} in external!`);

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
    const token = getFaucetReserveTokenMeta(faucetAssetSymbol);
    if (!token) {
      toasts.error('Reserve faucet supports ERC20 assets only');
      return;
    }
    if (target === 'account') {
      const firstAccountId = firstFaucetAccountId;
      if (!firstAccountId) {
        toasts.error('Open an account first');
        return;
      }
      await faucetOffchain(firstAccountId, token.tokenId);
      return;
    }
    await faucetReserves(token.tokenId, token.symbol);
  }

  function refreshBalances(): void {
    void fetchExternalTokens();
  }

  async function handleResetEverything(): Promise<void> {
    if (resettingEverything) return;
    const confirmed = window.confirm('Reset ALL local XLN data? Wallets, runtimes, settings, and IndexedDB databases will be deleted.');
    if (!confirmed) return;
    resettingEverything = true;
    try {
      await resetEverything('entity-empty-state');
    } finally {
      resettingEverything = false;
    }
  }

  let externalBalancePollTimer: ReturnType<typeof window.setInterval> | null = null;
  let externalBalancePollKey = '';

  function clearExternalBalancePoller(): void {
    if (externalBalancePollTimer !== null) {
      window.clearInterval(externalBalancePollTimer);
      externalBalancePollTimer = null;
    }
  }

  $: {
    if (typeof window === 'undefined') {
      externalBalancePollKey = '';
    } else {
      const signerId = String(currentSignerId || '').trim();
      const runtimeId = String(getRuntimeId(activeEnv) || '').trim();
      const jurisdiction = String(getActiveJurisdictionName(activeEnv) || '').trim();
      const refreshMs = Math.max(1_000, Math.floor(Number($settings.balanceRefreshMs || 1_000)));
      const nextKey = `${signerId}|${runtimeId}|${jurisdiction}|${activeIsLive ? 'live' : 'history'}|${refreshMs}`;
      if (nextKey !== externalBalancePollKey) {
        externalBalancePollKey = nextKey;
        clearExternalBalancePoller();
        if (signerId) {
          void fetchExternalTokens();
          if (activeIsLive) {
            externalBalancePollTimer = window.setInterval(() => {
              void fetchExternalTokens();
            }, refreshMs);
          }
        } else {
          externalTokens = [];
          externalTokensLoading = false;
        }
      }
    }
  }

  onDestroy(() => {
    clearExternalBalancePoller();
    resetMoveLineMeasurement();
    moveVisualResizeObserver?.disconnect();
  });

  onMount(() => {
    applyDeepLinkViewFromUrl();

    const handleMovePointer = (event: PointerEvent | MouseEvent) => {
      if (!moveDragSource) return;
      const hovered = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-move-side="to"]');
      const endpoint = hovered?.getAttribute?.('data-move-endpoint');
      moveDragHoverTarget = endpoint === 'external' || endpoint === 'reserve' || endpoint === 'account'
        ? endpoint
        : null;
    };
    const handleMovePointerUp = () => {
      if (moveDragSource && moveDragHoverTarget) {
        completeMoveSelection(moveDragHoverTarget);
      } else {
        clearMoveDrag();
      }
    };
    const handleUrlNavigation = () => applyDeepLinkViewFromUrl();
    window.addEventListener('pointermove', handleMovePointer);
    window.addEventListener('pointerup', handleMovePointerUp);
    window.addEventListener('mousemove', handleMovePointer);
    window.addEventListener('mouseup', handleMovePointerUp);
    window.addEventListener('hashchange', handleUrlNavigation);
    window.addEventListener('popstate', handleUrlNavigation);
    return () => {
      window.removeEventListener('pointermove', handleMovePointer);
      window.removeEventListener('pointerup', handleMovePointerUp);
      window.removeEventListener('mousemove', handleMovePointer);
      window.removeEventListener('mouseup', handleMovePointerUp);
      window.removeEventListener('hashchange', handleUrlNavigation);
      window.removeEventListener('popstate', handleUrlNavigation);
    };
  });

  // Formatting
  function getTokenInfo(tokenId: number) {
    return activeXlnFunctions?.getTokenInfo(tokenId) ?? { symbol: 'UNK', decimals: 18 };
  }

  function formatAmount(amount: bigint, decimals = 18): string {
    const precision = Math.max(0, Math.min(18, Math.floor(Number($settings?.tokenPrecision ?? 4))));
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

  function formatUsdExact(value: number): string {
    return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    return out.sort((a, b) => compareText(a.counterpartyId, b.counterpartyId));
  })();

  $: netWorth = externalTotal + reservesTotal + accountsData.total;

  type EntityActivityChip = {
    label: string;
    tone?: 'neutral' | 'good' | 'warn' | 'danger';
  };

  type EntityActivityRow = {
    id: string;
    height: number;
    timestamp: number;
    source: 'frame' | 'batch';
    accountId: string;
    accountLabel: string;
    kind: 'pending' | 'mempool' | 'confirmed' | 'batch';
    actor: 'you' | 'peer' | 'system';
    actorSide: 'L' | 'R' | '';
    actorLabel: string;
    actorEntityId: string;
    actorName: string;
    actorAvatar: string;
    actorInitials: string;
    headline: string;
    bodyLines: string[];
    chips: EntityActivityChip[];
    footerLeft: string;
    footerRight: string;
  };

  function formatTime(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '-';
    return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions);
  }

  function entityTxTypeLabel(type: string): string {
    const known: Record<string, string> = {
      htlcPayment: 'HTLC Payment',
      directPayment: 'Direct Payment',
      openAccount: 'Open Account',
      extendCredit: 'Extend Credit',
      requestCollateral: 'Request Collateral',
      set_rebalance_policy: 'Set Rebalance Policy',
      r2c: 'Deposit Collateral',
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
    actorEntityId: string;
    actorName: string;
    actorAvatar: string;
    actorInitials: string;
  } {
    const localEntityId = String(replica?.state?.entityId || tab.entityId || '').trim();
    const localEntity = localEntityId.toLowerCase();
    const leftEntityId = String(account?.leftEntity || '').trim();
    const rightEntityId = String(account?.rightEntity || '').trim();
    const leftEntity = leftEntityId.toLowerCase();
    const localIsLeft = Boolean(localEntity && leftEntity && localEntity === leftEntity);
    const actorEntityId = typeof byLeft === 'boolean'
      ? (byLeft ? leftEntityId : rightEntityId)
      : '';
    const actorName = actorEntityId
      ? getEntityDisplayName(actorEntityId, {
          source: activeEnv,
          selfEntityId: localEntityId,
          fallback: actorEntityId,
        })
      : 'System';
    const actorAvatar = actorEntityId ? resolveEntityAvatar(activeXlnFunctions, actorEntityId) : '';
    const actorInitials = actorName
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || '')
      .join('') || 'SY';
    if (typeof byLeft !== 'boolean') {
      return {
        actor: 'system',
        actorSide: '',
        actorLabel: 'System',
        actorEntityId: '',
        actorName,
        actorAvatar,
        actorInitials,
      };
    }
    const actorSide = byLeft ? 'L' : 'R';
    const actor = byLeft === localIsLeft ? 'you' : 'peer';
    return {
      actor,
      actorSide,
      actorLabel: `${actor === 'you' ? 'You' : 'Counterparty'} · ${actorSide}`,
      actorEntityId,
      actorName,
      actorAvatar,
      actorInitials,
    };
  }

  function activityTokenAmount(tokenIdRaw: unknown, amountRaw: unknown): string {
    const tokenId = Number(tokenIdRaw || 0);
    const amount = (() => {
      if (typeof amountRaw === 'bigint') return amountRaw;
      try {
        return BigInt(String(amountRaw ?? 0));
      } catch {
        return 0n;
      }
    })();
    if (tokenId > 0 && activeXlnFunctions?.formatTokenAmount) {
      return activeXlnFunctions.formatTokenAmount(tokenId, amount);
    }
    const token = tokenId > 0 ? getTokenInfo(tokenId) : { symbol: 'TOKEN', decimals: 18 };
    return `${formatAmount(amount, Number(token.decimals ?? 18))} ${token.symbol || `#${tokenId}`}`;
  }

  function activityEntityName(entityIdRaw: unknown, fallback: string): string {
    const entityId = String(entityIdRaw || '').trim();
    if (!entityId) return fallback;
    return getEntityDisplayName(entityId, {
      source: activeEnv,
      selfEntityId: replica?.state?.entityId || tab.entityId,
      fallback,
    });
  }

  function shortHash(value: unknown): string {
    const text = String(value || '').trim();
    if (!text) return '-';
    return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-6)}` : text;
  }

  function describeClaimedEvents(eventsRaw: unknown): string {
    if (!Array.isArray(eventsRaw) || eventsRaw.length === 0) return 'no events';
    const grouped = new Map<string, number>();
    for (const event of eventsRaw) {
      const type = String((event as { type?: unknown })?.type || 'event');
      grouped.set(type, (grouped.get(type) || 0) + 1);
    }
    return Array.from(grouped.entries())
      .map(([type, count]) => `${entityTxTypeLabel(type)}${count > 1 ? ` ×${count}` : ''}`)
      .join(' · ');
  }

  function summarizeAccountTx(
    tx: AccountTx,
    accountId: string,
    accountLabel: string,
    actor: 'you' | 'peer' | 'system',
  ): string {
    const data = tx?.data && typeof tx.data === 'object'
      ? tx.data as Record<string, unknown>
      : {};

    switch (tx.type) {
      case 'direct_payment':
      case 'account_payment': {
        const amount = activityTokenAmount(data['tokenId'], data['amount']);
        const description = String(data['description'] || '').trim();
        const route = Array.isArray(data['route'])
          ? data['route'].map((hop) => activityEntityName(hop, formatEntityId(String(hop || '')))).join(' → ')
          : '';
        let line = `${actor === 'peer' ? 'Received payment' : 'Sent payment'} ${amount}`;
        line += actor === 'peer' ? ` from ${accountLabel}` : ` to ${accountLabel}`;
        if (route) line += ` via ${route}`;
        if (description) line += ` · ${description}`;
        return line;
      }
      case 'swap_offer':
        return `Created order · sell ${activityTokenAmount(data['giveTokenId'], data['giveAmount'])} for ${activityTokenAmount(data['wantTokenId'], data['wantAmount'])}`;
      case 'swap_cancel':
      case 'swap_cancel_request':
        return `Cancelled order · ${String(data['offerId'] || 'unknown')}`;
      case 'swap_resolve': {
        const offerId = String(data['offerId'] || 'unknown');
        const cancelRemainder = Boolean(data['cancelRemainder']);
        const executionGive = data['executionGiveAmount'];
        const executionWant = data['executionWantAmount'];
        const giveToken = data['restingGiveTokenId'] ?? data['giveTokenId'];
        const wantToken = data['restingWantTokenId'] ?? data['wantTokenId'];
        const filled = executionGive !== undefined && executionWant !== undefined
          ? `${activityTokenAmount(giveToken, executionGive)} ↔ ${activityTokenAmount(wantToken, executionWant)}`
          : offerId;
        if (cancelRemainder && executionGive !== undefined && executionWant !== undefined) return `Resolved order · ${filled} and closed remainder`;
        if (cancelRemainder) return `Closed order · ${offerId}`;
        return `Resolved order · ${filled}`;
      }
      case 'request_collateral': {
        const amount = activityTokenAmount(data['tokenId'], data['amount']);
        const fee = typeof data['feeAmount'] !== 'undefined'
          ? activityTokenAmount(data['feeTokenId'] ?? data['tokenId'], data['feeAmount'])
          : '';
        return fee ? `Requested collateral · ${amount} (+ fee ${fee})` : `Requested collateral · ${amount}`;
      }
      case 'set_rebalance_policy':
        return `Updated rebalance policy · soft ${activityTokenAmount(data['tokenId'], data['r2cRequestSoftLimit'])} / hard ${activityTokenAmount(data['tokenId'], data['hardLimit'])}`;
      case 'set_credit_limit':
        return `Set credit limit · ${activityTokenAmount(data['tokenId'], data['amount'])}`;
      case 'add_delta':
        return `Opened token lane · ${activityEntityName(accountId, accountLabel)} / ${getTokenInfo(Number(data['tokenId'] || 0)).symbol}`;
      case 'account_settle':
        return `Claimed on-chain settlement · ${getTokenInfo(Number(data['tokenId'] || 0)).symbol}`;
      case 'reserve_to_collateral':
        return `Claimed reserve → collateral move · ${getTokenInfo(Number(data['tokenId'] || 0)).symbol}`;
      case 'htlc_lock':
        return `Opened HTLC · ${activityTokenAmount(data['tokenId'], data['amount'])}`;
      case 'htlc_resolve':
        return `Resolved HTLC · ${String(data['outcome'] || 'unknown')}`;
      case 'settle_hold': {
        const diffs = Array.isArray(data['diffs']) ? data['diffs'].length : 0;
        return `Placed settlement hold · ${diffs || 1} token${diffs === 1 ? '' : 's'}`;
      }
      case 'settle_release': {
        const diffs = Array.isArray(data['diffs']) ? data['diffs'].length : 0;
        return `Released settlement hold · ${diffs || 1} token${diffs === 1 ? '' : 's'}`;
      }
      case 'reopen_disputed':
        return 'Reopened disputed account';
      case 'j_event_claim':
        return `Claimed J#${Number(data['jHeight'] || 0)} · ${describeClaimedEvents(data['events'])}`;
      default:
        return entityTxTypeLabel(String(tx.type || 'unknown'));
    }
  }

  function batchCounterpartyId(entry: NonNullable<NonNullable<EntityReplica['state']['batchHistory']>[number]>): string {
    const batch = entry.batch;
    if (!batch) return '';
    const fromStart = String(batch.disputeStarts?.[0]?.counterentity || '').trim();
    if (fromStart) return fromStart;
    const fromFinalize = String(batch.disputeFinalizations?.[0]?.counterentity || '').trim();
    if (fromFinalize) return fromFinalize;
    const fromR2C = String(batch.reserveToCollateral?.[0]?.receivingEntity || '').trim();
    if (fromR2C) return fromR2C;
    return '';
  }

  function batchActorMeta(entry: NonNullable<NonNullable<EntityReplica['state']['batchHistory']>[number]>) {
    if (entry.source === 'self-batch') {
      const selfId = String(replica?.state?.entityId || tab.entityId || '').trim();
      const selfName = activityEntityName(selfId, 'You');
      return {
        actor: 'you' as const,
        actorSide: '' as const,
        actorLabel: 'You · on-chain',
        actorEntityId: selfId,
        actorName: selfName,
        actorAvatar: resolveEntityAvatar(activeXlnFunctions, selfId),
        actorInitials: selfName
          .split(/[\s_-]+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0]?.toUpperCase() || '')
          .join('') || 'YO',
      };
    }
    const counterpartyId = batchCounterpartyId(entry);
    const actorName = activityEntityName(counterpartyId, counterpartyId ? formatEntityId(counterpartyId) : 'Counterparty');
    return {
      actor: counterpartyId ? 'peer' as const : 'system' as const,
      actorSide: '' as const,
      actorLabel: counterpartyId ? 'Counterparty · on-chain' : 'System',
      actorEntityId: counterpartyId,
      actorName,
      actorAvatar: counterpartyId ? resolveEntityAvatar(activeXlnFunctions, counterpartyId) : '',
      actorInitials: actorName
        .split(/[\s_-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || '')
        .join('') || 'CP',
    };
  }

  function summarizeBatchOperations(entry: NonNullable<NonNullable<EntityReplica['state']['batchHistory']>[number]>): string[] {
    const ops = entry.operations;
    if (!ops) {
      return entry.opCount > 0 ? [`${entry.opCount} on-chain op${entry.opCount === 1 ? '' : 's'}`] : [];
    }
    const lines: string[] = [];
    const push = (count: number | undefined, label: string) => {
      const normalized = Number(count || 0);
      if (normalized > 0) lines.push(`${normalized} ${label}${normalized === 1 ? '' : 's'}`);
    };
    push(ops.settlements, 'settlement');
    push(ops.reserveToCollateral, 'reserve → collateral move');
    push(ops.collateralToReserve, 'collateral → reserve move');
    push(ops.reserveToReserve, 'reserve transfer');
    push(ops.disputeStarts, 'dispute start');
    push(ops.disputeFinalizations, 'dispute finalize');
    push(ops.externalTokenToReserve, 'external deposit');
    push(ops.reserveToExternalToken, 'reserve withdrawal');
    push(ops.revealSecrets, 'secret reveal');
    push(ops.flashloans, 'flashloan');
    return lines;
  }

  $: entityActivityRows = (() => {
    const rows: EntityActivityRow[] = [];
    const accounts = replica?.state?.accounts;
    if (accounts instanceof Map && accounts.size > 0) {
      for (const [counterpartyId, account] of accounts.entries()) {
        const accountId = String(counterpartyId || '');
        const accountLabel = activityAccountLabel(accountId);
        const pushFrameRow = (
          kind: 'pending' | 'mempool' | 'confirmed',
          frameLabel: string,
          statusLabel: string,
          height: number,
          timestamp: number,
          txs: AccountTx[],
          byLeft?: boolean,
        ) => {
          if (!Array.isArray(txs) || txs.length === 0) return;
          const actorMeta = frameActorMeta(account, byLeft);
          const allLines = txs.map((tx) => summarizeAccountTx(tx, accountId, accountLabel, actorMeta.actor));
          const headline = allLines.length === 1 ? allLines[0] : `${txs.length} actions in account frame`;
          const bodyLines = allLines.length <= 1
            ? []
            : (allLines.length > 4 ? [...allLines.slice(0, 4), `+${allLines.length - 4} more actions`] : allLines);
          rows.push({
            id: `entity-activity-frame-${accountId}-${kind}-${height}-${timestamp}`,
            height,
            timestamp,
            source: 'frame',
            accountId,
            accountLabel,
            kind,
            actor: actorMeta.actor,
            actorSide: actorMeta.actorSide,
            actorLabel: actorMeta.actorLabel,
            actorEntityId: actorMeta.actorEntityId,
            actorName: actorMeta.actorName,
            actorAvatar: actorMeta.actorAvatar,
            actorInitials: actorMeta.actorInitials || '',
            headline,
            bodyLines,
            chips: [
              { label: frameLabel },
              { label: `${actorMeta.actor === 'peer' ? accountLabel : activityEntityName(tab.entityId, 'You')} → ${actorMeta.actor === 'peer' ? activityEntityName(tab.entityId, 'You') : accountLabel}` },
              { label: statusLabel, tone: kind === 'confirmed' ? 'good' : (kind === 'mempool' ? 'warn' : 'neutral') },
              { label: `${txs.length} tx` },
            ],
            footerLeft: formatEntityId(accountId),
            footerRight: height > 0 ? `E#${height}` : statusLabel,
          });
        };

        if (account.pendingFrame) {
          pushFrameRow(
            'pending',
            'Pending frame',
            'Awaiting consensus',
            Number(account.pendingFrame.height || 0),
            Number(account.pendingFrame.timestamp || 0),
            Array.isArray(account.pendingFrame.accountTxs) ? account.pendingFrame.accountTxs : [],
            account.pendingFrame.byLeft,
          );
        }

        if (Array.isArray(account.mempool) && account.mempool.length > 0) {
          pushFrameRow(
            'mempool',
            'Queued broadcast',
            `${account.mempool.length} queued`,
            Number(account.pendingFrame?.height || account.currentHeight || 0),
            Number(account.pendingFrame?.timestamp || account.currentFrame?.timestamp || 0),
            account.mempool,
            account.leftEntity === (replica?.state?.entityId || tab.entityId),
          );
        }

        const frames = Array.isArray(account.frameHistory) ? account.frameHistory.slice(-12) : [];
        for (const frame of frames) {
          pushFrameRow(
            'confirmed',
            'Confirmed frame',
            'Confirmed',
            Number(frame.height || 0),
            Number(frame.timestamp || 0),
            Array.isArray(frame.accountTxs) ? frame.accountTxs : [],
            frame.byLeft,
          );
        }
      }
    }

    const history = Array.isArray(replica?.state?.batchHistory) ? replica.state.batchHistory : [];
    for (let index = 0; index < history.length; index += 1) {
      const entry = history[index];
      if (!entry) continue;
      const actorMeta = batchActorMeta(entry);
      const accountId = batchCounterpartyId(entry);
      const accountLabel = accountId ? activityAccountLabel(accountId) : 'On-chain';
      rows.push({
        id: `entity-activity-batch-${entry.txHash || entry.batchHash || index}`,
        height: Number(entry.entityNonce || 0),
        timestamp: Number(entry.confirmedAt || entry.broadcastedAt || 0),
        source: 'batch',
        accountId,
        accountLabel,
        kind: 'batch',
        actor: actorMeta.actor,
        actorSide: actorMeta.actorSide,
        actorLabel: actorMeta.actorLabel,
        actorEntityId: actorMeta.actorEntityId,
        actorName: actorMeta.actorName,
        actorAvatar: actorMeta.actorAvatar,
        actorInitials: actorMeta.actorInitials,
        headline: entry.eventType === 'DisputeStarted'
          ? 'Dispute started on-chain'
          : entry.eventType === 'DisputeFinalized'
            ? 'Dispute finalized on-chain'
            : entry.status === 'confirmed'
              ? 'On-chain batch confirmed'
              : 'On-chain batch failed',
        bodyLines: [
          ...(entry.note ? [entry.note] : []),
          ...summarizeBatchOperations(entry),
        ],
        chips: [
          { label: entry.status === 'confirmed' ? 'On-chain' : 'Failed', tone: entry.status === 'confirmed' ? 'good' : 'danger' },
          ...(accountId ? [{ label: accountLabel }] : []),
          { label: `Nonce ${Number(entry.entityNonce || 0)}` },
          ...(entry.jBlockNumber ? [{ label: `J#${Number(entry.jBlockNumber)}` }] : []),
        ],
        footerLeft: shortHash(entry.txHash || entry.batchHash),
        footerRight: `Batch ${Number(entry.opCount || 0)} op${Number(entry.opCount || 0) === 1 ? '' : 's'}`,
      });
    }

    return rows.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
      if (a.height !== b.height) return b.height - a.height;
      return compareText(a.accountLabel, b.accountLabel);
    });
  })();

  $: entityActivityAccounts = (() => {
    const labels = new Map<string, string>();
    for (const row of entityActivityRows) {
      if (!row.accountId) continue;
      labels.set(row.accountId, row.accountLabel);
    }
    return Array.from(labels.entries())
      .map(([accountId, accountLabel]) => ({ accountId, accountLabel }))
      .sort((a, b) => compareText(a.accountLabel, b.accountLabel));
  })();

  $: filteredEntityActivityRows = entityActivityAccountFilter === 'all'
    ? entityActivityRows
    : entityActivityRows.filter((row) => row.accountId === entityActivityAccountFilter);
  $: if (entityActivityAccountFilter !== 'all' && !entityActivityAccounts.some((row) => row.accountId === entityActivityAccountFilter)) {
    entityActivityAccountFilter = 'all';
  }

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
    const next = event.detail?.selected ?? null;
    dispatch('jurisdictionSelect', next ? { name: next } : { name: null });
    if (next) selectedJurisdictionName = next;
  }

  function handleBackToAccounts() {
    const nextWorkspaceId = String(selectedAccountId || '').trim();
    if (nextWorkspaceId) {
      const matched = workspaceAccountIds.find((id) => String(id).toLowerCase() === nextWorkspaceId.toLowerCase());
      workspaceAccountId = matched || nextWorkspaceId;
    }
    selectedAccountId = null;
    activeTab = 'accounts';
    accountWorkspaceTab = 'activity';
  }

  function selectTopLevelTab(nextTab: ViewTab) {
    if (nextTab === 'accounts' && selectedAccountId) {
      handleBackToAccounts();
      return;
    }
    if (selectedAccountId) {
      selectedAccountId = null;
    }
    activeTab = nextTab;
  }

  function handleAccountPanelGoToOpenAccounts() {
    const nextWorkspaceId = String(selectedAccountId || '').trim();
    if (nextWorkspaceId) {
      const matched = workspaceAccountIds.find((id) => String(id).toLowerCase() === nextWorkspaceId.toLowerCase());
      workspaceAccountId = matched || nextWorkspaceId;
    }
    selectedAccountId = null;
    activeTab = 'accounts';
    accountWorkspaceTab = 'open';
  }

  function goToLive() {
    onGoToLive();
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

  type PendingBatchPreviewItem = {
    key: string;
    title: string;
    subtitle: string;
  };

  function pendingBatchEntityLabel(entityId: string): string {
    const raw = String(entityId || '').trim();
    return getEntityDisplayName(raw, {
      source: activeEnv,
      selfEntityId: replica?.state?.entityId || tab.entityId,
      fallback: 'Unknown',
    });
  }

  function pendingBatchTokenAmountLabel(tokenIdRaw: unknown, amountRaw: unknown): string {
    const tokenId = Number(tokenIdRaw || 0);
    const amount = typeof amountRaw === 'bigint'
      ? amountRaw
      : (() => {
          try {
            return BigInt(String(amountRaw ?? 0));
          } catch {
            return 0n;
          }
        })();
    if (tokenId > 0 && activeXlnFunctions?.formatTokenAmount) {
      return activeXlnFunctions.formatTokenAmount(tokenId, amount);
    }
    return `${amount.toString()} ${tokenId > 0 ? `Token #${tokenId}` : 'token'}`;
  }

  function pendingBatchShortHex(value: unknown): string {
    const text = String(value || '');
    if (!text) return '—';
    if (text.length <= 18) return text;
    return `${text.slice(0, 10)}...${text.slice(-6)}`;
  }

  function pendingBatchToBigInt(value: unknown): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === 'string' && value.trim()) {
      try {
        return BigInt(value);
      } catch {
        return 0n;
      }
    }
    return 0n;
  }

  function pendingBatchIsSelfEntity(value: unknown): boolean {
    const selfEntityId = String(resolveSelfEntityId() || '').trim().toLowerCase();
    const candidate = String(value || '').trim().toLowerCase();
    return !!selfEntityId && !!candidate && selfEntityId === candidate;
  }

  type PendingBatchSettlementLike = {
    leftEntity?: unknown;
    rightEntity?: unknown;
    diffs?: Array<{ leftDiff?: unknown; rightDiff?: unknown }>;
  };

  function pendingBatchSettlementReserveDelta(settlement: PendingBatchSettlementLike | null | undefined): bigint {
    const leftIsSelf = pendingBatchIsSelfEntity(settlement?.leftEntity);
    const rightIsSelf = pendingBatchIsSelfEntity(settlement?.rightEntity);
    if (!leftIsSelf && !rightIsSelf) return 0n;

    let delta = 0n;
    for (const diff of Array.isArray(settlement?.diffs) ? settlement.diffs : []) {
      if (leftIsSelf) {
        delta += pendingBatchToBigInt(diff?.leftDiff);
      } else if (rightIsSelf) {
        delta += pendingBatchToBigInt(diff?.rightDiff);
      }
    }
    return delta;
  }

  function buildPendingBatchPreview(batch: JBatch | null | undefined): PendingBatchPreviewItem[] {
    if (!batch) return [];
    const reserveIncreaseItems: PendingBatchPreviewItem[] = [];
    const reserveDecreaseItems: PendingBatchPreviewItem[] = [];
    const neutralItems: PendingBatchPreviewItem[] = [];
    const pushItem = (phase: 'increase' | 'decrease' | 'neutral', item: PendingBatchPreviewItem): void => {
      if (phase === 'increase') reserveIncreaseItems.push(item);
      else if (phase === 'decrease') reserveDecreaseItems.push(item);
      else neutralItems.push(item);
    };

    for (const [index, op] of (batch.flashloans || []).entries()) {
      pushItem('increase', {
        key: `flash-${index}`,
        title: 'Flashloan',
        subtitle: `${pendingBatchTokenAmountLabel(op.tokenId, op.amount)} temporary reserve liquidity`,
      });
    }

    for (const [index, op] of (batch.externalTokenToReserve || []).entries()) {
      pushItem('increase', {
        key: `e2r-${index}`,
        title: 'External → Reserve',
        subtitle: `${pendingBatchTokenAmountLabel(op.internalTokenId, op.amount)} to ${pendingBatchEntityLabel(String(op.entity || resolveSelfEntityId()))}`,
      });
    }

    for (const [index, op] of (batch.reserveToReserve || []).entries()) {
      const isIncrease = pendingBatchIsSelfEntity(op.receivingEntity);
      pushItem(isIncrease ? 'increase' : 'decrease', {
        key: `r2r-${index}`,
        title: isIncrease ? 'Reserve ← Reserve' : 'Reserve → Reserve',
        subtitle: `${pendingBatchTokenAmountLabel(op.tokenId, op.amount)} to ${pendingBatchEntityLabel(String(op.receivingEntity || ''))}`,
      });
    }

    for (const [index, op] of (batch.collateralToReserve || []).entries()) {
      pushItem('increase', {
        key: `c2r-${index}`,
        title: 'Account → Reserve',
        subtitle: `${pendingBatchTokenAmountLabel(op.tokenId, op.amount)} from ${pendingBatchEntityLabel(String(op.counterparty || ''))}`,
      });
    }

    for (const [index, op] of (batch.settlements || []).entries()) {
      const reserveDelta = pendingBatchSettlementReserveDelta(op);
      const phase = reserveDelta > 0n ? 'increase' : reserveDelta < 0n ? 'decrease' : 'neutral';
      const reserveLabel = reserveDelta > 0n ? 'Settlement (+Reserve)' : reserveDelta < 0n ? 'Settlement (-Reserve)' : 'Settlement';
      pushItem(phase, {
        key: `settle-${index}`,
        title: reserveLabel,
        subtitle: `${pendingBatchEntityLabel(String(op.leftEntity || ''))} ↔ ${pendingBatchEntityLabel(String(op.rightEntity || ''))}`,
      });
    }

    for (const [index, op] of (batch.reserveToCollateral || []).entries()) {
      for (const [pairIndex, pair] of (op.pairs || []).entries()) {
        pushItem('decrease', {
          key: `r2c-${index}-${pairIndex}`,
          title: 'Reserve → Account',
          subtitle: `${pendingBatchTokenAmountLabel(op.tokenId, pair.amount)} to ${pendingBatchEntityLabel(String(op.receivingEntity || ''))} via ${pendingBatchEntityLabel(String(pair.entity || ''))}`,
        });
      }
    }

    for (const [index, op] of (batch.reserveToExternalToken || []).entries()) {
      pushItem('decrease', {
        key: `r2e-${index}`,
        title: 'Reserve → External',
        subtitle: `${pendingBatchTokenAmountLabel(op.tokenId, op.amount)} to ${pendingBatchEntityLabel(String(op.receivingEntity || resolveSelfEntityId()))}`,
      });
    }

    for (const [index, op] of (batch.disputeStarts || []).entries()) {
      pushItem('neutral', {
        key: `dstart-${index}`,
        title: 'Dispute Start',
        subtitle: `Lock account with ${pendingBatchEntityLabel(String(op.counterentity || ''))}`,
      });
    }

    for (const [index, op] of (batch.disputeFinalizations || []).entries()) {
      pushItem('neutral', {
        key: `dfinal-${index}`,
        title: 'Dispute Finalize',
        subtitle: `Finalize against ${pendingBatchEntityLabel(String(op.counterentity || ''))}`,
      });
    }

    for (const [index, op] of (batch.revealSecrets || []).entries()) {
      pushItem('neutral', {
        key: `secret-${index}`,
        title: 'Reveal Secret',
        subtitle: pendingBatchShortHex(op.secret),
      });
    }

    return [...reserveIncreaseItems, ...reserveDecreaseItems, ...neutralItems];
  }

  function buildOpenOutgoingDebtTotals(): {
    count: number;
    usdTotal: number;
    byToken: Map<number, bigint>;
  } {
    const byToken = new Map<number, bigint>();
    let count = 0;
    let usdTotal = 0;
    for (const [tokenId, bucket] of replica?.state?.outDebtsByToken?.entries?.() || []) {
      let tokenTotal = 0n;
      for (const debt of bucket.values()) {
        if (debt.status !== 'open') continue;
        count += 1;
        tokenTotal += BigInt(debt.remainingAmount || 0);
        const tokenInfo = activeXlnFunctions?.getTokenInfo?.(tokenId);
        usdTotal += amountToUsd(
          BigInt(debt.remainingAmount || 0),
          Number(tokenInfo?.decimals ?? 18),
          String(tokenInfo?.symbol || `Token #${tokenId}`),
        );
      }
      if (tokenTotal > 0n) byToken.set(tokenId, tokenTotal);
    }
    return { count, usdTotal, byToken };
  }

  function formatBatchReserveIssue(issue: DraftBatchReserveIssue | null): string | null {
    if (!issue) return null;
    const tokenLabel = pendingBatchTokenAmountLabel(issue.tokenId, issue.requiredAmount).replace(/^[\d.,\s]+/, '').trim();
    const spendable = pendingBatchTokenAmountLabel(issue.tokenId, issue.availableAfterDebt);
    const debtClaim = pendingBatchTokenAmountLabel(issue.tokenId, issue.debtClaimPaid);
    if (issue.opType === 'reserveToExternalToken') {
      return `Reserve withdrawal will fail: debt sweep consumes ${debtClaim} first, leaving only ${spendable} spendable.`;
    }
    if (issue.opType === 'reserveToCollateral') {
      return `Reserve → Account will fail for ${tokenLabel}: debt sweep consumes ${debtClaim} first, leaving only ${spendable}.`;
    }
    return `Reserve → Reserve will fail for ${tokenLabel}: debt sweep consumes ${debtClaim} first, leaving only ${spendable}.`;
  }

  function getPendingBatchReserveIssue(batch: JBatch | null | undefined): DraftBatchReserveIssue | null {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    if (!entityId || !batch) return null;
    const simulation = simulateDraftBatchReserveAvailability(
      entityId,
      onchainReserves,
      batch,
      openOutgoingDebtSummary.byToken,
    );
    return simulation.issues[0] ?? null;
  }

  $: openOutgoingDebtSummary = buildOpenOutgoingDebtTotals();
  $: hasDraftBatch = !!(replica?.state?.jBatchState?.batch && countBatchOps(replica.state.jBatchState.batch) > 0);
  $: hasSentBatch = !!(replica?.state?.jBatchState?.sentBatch?.batch && countBatchOps(replica.state.jBatchState.sentBatch.batch) > 0);
  $: pendingBatchReserveIssue = getPendingBatchReserveIssue(replica?.state?.jBatchState?.batch);
  $: pendingBatchReserveIssueText = formatBatchReserveIssue(pendingBatchReserveIssue);
  $: canBroadcastPendingBatch = hasDraftBatch && !hasSentBatch && !pendingBatchReserveIssue;

  async function clearPendingBatch(): Promise<void> {
    if (!pendingBatchCount || pendingBatchSubmitting) return;
    if (!confirm('Clear current draft and any sent batch state?')) return;
    pendingBatchSubmitting = true;
    try {
      const entityId = replica?.state?.entityId || tab.entityId;
      const env = requireRuntimeEnv(activeEnv, 'global-clear-batch');
      if (!activeIsLive) throw new Error('Batch actions require LIVE mode');
      const signerId = resolveEntitySigner(entityId, 'global-clear-batch');
      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [{
        type: 'j_clear_batch',
        data: { reason: 'global-batch-bar-clear' },
      }])]);
      toasts.success('Batch cleared');
    } catch (error) {
      toasts.error(`Batch clear failed: ${toErrorMessage(error, 'Unknown error')}`);
    } finally {
      pendingBatchSubmitting = false;
    }
  }

  async function broadcastPendingBatch(): Promise<void> {
    if (pendingBatchReserveIssueText) {
      toasts.error(pendingBatchReserveIssueText);
      return;
    }
    if (!canBroadcastPendingBatch || pendingBatchSubmitting) return;
    pendingBatchSubmitting = true;
    try {
      const entityId = replica?.state?.entityId || tab.entityId;
      const env = requireRuntimeEnv(activeEnv, 'global-batch-broadcast');
      if (!activeIsLive) throw new Error('Batch actions require LIVE mode');
      const signerId = resolveEntitySigner(entityId, 'global-batch-broadcast');
      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [{
        type: 'j_broadcast',
        data: {},
      }])]);
      toasts.success('Broadcast queued');
    } catch (error) {
      toasts.error(`Batch broadcast failed: ${toErrorMessage(error, 'Unknown error')}`);
    } finally {
      pendingBatchSubmitting = false;
    }
  }

  async function rebroadcastPendingBatch(): Promise<void> {
    if (!hasSentBatch || pendingBatchSubmitting) return;
    pendingBatchSubmitting = true;
    try {
      const entityId = replica?.state?.entityId || tab.entityId;
      const env = requireRuntimeEnv(activeEnv, 'global-batch-rebroadcast');
      if (!activeIsLive) throw new Error('Batch actions require LIVE mode');
      const signerId = resolveEntitySigner(entityId, 'global-batch-rebroadcast');
      await enqueueEntityInputs(env, [buildEntityInput(entityId, signerId, [{
        type: 'j_rebroadcast',
        data: { gasBumpBps: 1000 },
      }])]);
      toasts.success('Sent batch queued for rebroadcast');
    } catch (error) {
      toasts.error(`Rebroadcast failed: ${toErrorMessage(error, 'Unknown error')}`);
    } finally {
      pendingBatchSubmitting = false;
    }
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
  $: pendingBatchMode = replica?.state?.jBatchState?.batch && countBatchOps(replica.state.jBatchState.batch) > 0
    ? 'draft'
    : (replica?.state?.jBatchState?.sentBatch?.batch && countBatchOps(replica.state.jBatchState.sentBatch.batch) > 0 ? 'sent' : null);
  $: pendingBatchPreview = buildPendingBatchPreview(
    pendingBatchMode === 'draft'
      ? (replica?.state?.jBatchState?.batch || null)
      : (replica?.state?.jBatchState?.sentBatch?.batch || null),
  );

  const tabs: IconBadgeTabConfig<ViewTab>[] = [
    { id: 'assets', icon: Landmark, label: 'Assets' },
    { id: 'accounts', icon: Users, label: 'Accounts' },
    { id: 'settings', icon: SettingsIcon, label: 'Settings' },
  ];

  const accountWorkspaceTabs: IconPendingTabConfig<AccountWorkspaceTab>[] = [
    { id: 'open', icon: PlusCircle, label: 'Open Account' },
    { id: 'send', icon: ArrowUpRight, label: 'Pay' },
    { id: 'receive', icon: ArrowDownLeft, label: 'Receive' },
    { id: 'swap', icon: Repeat, label: 'Swap' },
    { id: 'move', icon: Landmark, label: 'Move' },
    { id: 'history', icon: Activity, label: 'History' },
    { id: 'configure', icon: SettingsIcon, label: 'Manage' },
    { id: 'activity', icon: Activity, label: 'Activity' },
    { id: 'appearance', icon: SlidersHorizontal, label: 'Appearance' },
  ];
  const accountWorkspacePrimaryTabIds: AccountWorkspaceTab[] = ['open', 'send', 'receive', 'swap', 'move'];
  $: hasWorkspaceAccounts = workspaceAccountIds.length > 0;
  $: hasAnyAccounts = accountIds.length > 0;
  $: faucetSupportsReserve = !!getFaucetReserveTokenMeta(faucetAssetSymbol);
  $: canShowAccountFaucet = faucetSupportsReserve && hasAnyAccounts;
  $: visibleAccountWorkspaceTabs = hasWorkspaceAccounts
    ? accountWorkspaceTabs
    : accountWorkspaceTabs.filter((tabConfig) => tabConfig.id === 'open');
  $: if (!hasWorkspaceAccounts && accountWorkspaceTab !== 'open') {
    accountWorkspaceTab = 'open';
  }

  function selectAccountWorkspaceTab(next: string): void {
    const target = next as AccountWorkspaceTab;
    if (target === 'move') {
      openAccountMoveWorkspace();
      return;
    }
    if (target === 'history') {
      openAccountHistoryWorkspace();
      return;
    }
    accountWorkspaceTab = target;
  }
  let lastDeepLinkWorkspaceSignature = '';
  $: {
    const signature = `${getUrlHashRoute() || ''}|${workspaceAccountIds.length}|${accountIds.length}`;
    if (signature !== lastDeepLinkWorkspaceSignature) {
      lastDeepLinkWorkspaceSignature = signature;
      applyDeepLinkViewFromUrl();
    }
  }
  $: if (typeof window !== 'undefined') {
    syncHashToCurrentView();
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
    <button type="button" class="history-warning" on:click={goToLive}>
      <AlertTriangle size={14} />
      <span>Viewing historical state. Click to go LIVE.</span>
    </button>
  {/if}

  <!-- Main Content - SINGLE SCROLL -->
  <main class="main-scroll">
    {#if !tab.entityId || !tab.signerId}
      <div class="empty-state">
        <Wallet size={40} />
        <h3>Select Entity</h3>
        <p>{userModeHeader ? 'Choose from the context pill above' : 'Choose from the dropdown above'}</p>
        <button class="empty-state-reset" type="button" on:click={handleResetEverything} disabled={resettingEverything}>
          {resettingEverything ? 'Resetting...' : 'Reset Everything'}
        </button>
      </div>

    {:else if activeEnv && isAccountFocused && selectedAccount && selectedAccountId}
      <div class="focused-view">
        {#key selectedAccountId}
        <AccountPanel
          account={selectedAccount}
          counterpartyId={selectedAccountId}
          entityId={tab.entityId}
          {replica}
          env={activeEnv}
          on:back={handleBackToAccounts}
          on:faucet={handleAccountFaucet}
          on:goToOpenAccounts={handleAccountPanelGoToOpenAccounts}
        />
        {/key}
      </div>

    {:else if activeEnv && replica}
      <!-- Hero: Entity + Net Worth -->
      <section class="hero">
        <div class="hero-left" class:user-mode={userModeHeader}>
          {#if !userModeHeader}
            {#if avatar}
              <img src={avatar} alt="Entity avatar" class="hero-avatar" />
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
            <div class="wallet-meta-block hero-meta-block">
              <p class="muted wallet-label">Entity</p>
              <button
                class="wallet-meta-copy"
                type="button"
                title="Copy entity id"
                on:click={() => copyMetaValue(currentEntityValue, 'entity')}
              >
                <span class="wallet-meta-value">{currentEntityValue}</span>
                {#if copiedMetaField === 'entity'}
                  <Check size={12} />
                {:else}
                  <Copy size={12} />
                {/if}
              </button>
            </div>
          </div>
        </div>
        <div class="hero-right">
          <div class="hero-networth">{formatUsdExact(netWorth)}</div>
          <div class="hero-label">Net Worth</div>
        </div>
      </section>

      <!-- Tab Bar -->
      <nav class="tabs">
        {#each tabs as t}
          <button
            class="tab"
            class:active={activeTab === t.id}
            data-testid={`tab-${t.id}`}
            on:click={() => selectTopLevelTab(t.id)}
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
              <p class="muted asset-ledger-note">External, reserve, and account balances.</p>
            </div>
            <div class="header-actions">
              <button class="btn-refresh-small" data-testid="asset-ledger-refresh" on:click={() => refreshBalances()} disabled={externalTokensLoading}>
                {externalTokensLoading ? '...' : 'Refresh'}
              </button>
            </div>
          </div>
          <section class="faucet-inline-card">
            <div class="faucet-inline-row">
              <span class="faucet-inline-label">Faucet</span>
              <select class="faucet-inline-token" bind:value={faucetAssetSymbol} data-testid="asset-faucet-symbol">
                {#each assetLedgerRows as row}
                  <option value={row.symbol}>{row.symbol}</option>
                {/each}
              </select>
              <button class="btn-table-action faucet" data-testid={`external-faucet-${faucetAssetSymbol}`} on:click={() => submitAssetFaucet('external')}>
                External
              </button>
              {#if faucetSupportsReserve}
                <button
                  class="btn-table-action deposit"
                  data-testid={`reserve-faucet-${faucetAssetSymbol}`}
                  on:click={() => submitAssetFaucet('reserve')}
                  title="Faucet reserve"
                >
                  Reserve
                </button>
              {/if}
              {#if canShowAccountFaucet}
                <button
                  class="btn-table-action faucet"
                  data-testid={`account-faucet-${faucetAssetSymbol}`}
                  on:click={() => submitAssetFaucet('account')}
                  title="Faucet first account"
                >
                  Account
                </button>
              {/if}
            </div>
          </section>
          <div class="asset-ledger-meta">
            <div class="wallet-meta-block">
              <p class="muted wallet-label">External EOA</p>
              <button
                class="wallet-meta-copy"
                type="button"
                title="Copy external EOA"
                on:click={() => copyMetaValue(currentExternalEoaValue, 'external')}
              >
                <span class="wallet-meta-value">{currentExternalEoaValue || '-'}</span>
                {#if copiedMetaField === 'external'}
                  <Check size={12} />
                {:else}
                  <Copy size={12} />
                {/if}
              </button>
              <p class="muted wallet-meta-help">External ETH and ERC20 endpoint.</p>
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
                  </div>
                </div>
                <div class="col-balance asset-balance-block">
                  <span
                    class="balance-text"
                    class:zero={row.externalBalance === 0n}
                    data-testid={`external-balance-${row.symbol}`}
                    data-raw-amount={row.externalBalance.toString()}
                  >
                    {formatAmount(row.externalBalance, row.decimals)}
                  </span>
                  <span class="value-text subtle">{formatApproxUsd(row.externalUsd)}</span>
                </div>
                <div class="col-balance asset-balance-block">
                  <span
                    class="balance-text"
                    class:zero={row.reserveBalance === 0n}
                    data-testid={`reserve-balance-${row.symbol}`}
                    data-raw-amount={row.reserveBalance.toString()}
                  >
                    {row.tokenId && row.tokenId > 0 ? formatAmount(row.reserveBalance, row.decimals) : '—'}
                  </span>
                  <span class="value-text subtle">{row.tokenId && row.tokenId > 0 ? formatApproxUsd(row.reserveUsd) : '—'}</span>
                </div>
                <div class="col-balance asset-balance-block">
                  <span
                    class="balance-text"
                    class:zero={row.accountBalance === 0n}
                    data-testid={`account-spendable-${row.symbol}`}
                    data-raw-amount={row.accountBalance.toString()}
                  >
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

          <DebtPanel
            entityId={replica.state?.entityId || tab.entityId}
            signerId={currentSignerId}
            sourceEnv={activeEnv}
            canEnforce={activeIsLive}
            enforcingTokenId={debtEnforcingTokenId}
            on:enforce={(event) => enforceOutstandingDebt(event.detail.tokenId)}
          />

          <section class="asset-action-card">
            {#if openOutgoingDebtSummary.count > 0}
              <div class="workspace-debt-warning" data-testid="workspace-debt-warning">
                <div class="workspace-debt-warning-copy">
                  <span class="workspace-debt-warning-kicker">Open debts across all tokens</span>
                  <strong>{openOutgoingDebtSummary.count} open · {formatApproxUsd(openOutgoingDebtSummary.usdTotal)}</strong>
                </div>
                <span class="workspace-debt-warning-note">Reserve spends sweep debts first. Enforce or refill before broadcasting risky reserve moves.</span>
              </div>
            {/if}

            {#if pendingBatchCount > 0}
              <div
                class="workspace-pending-banner"
                data-testid="workspace-pending-banner"
                data-pending-count={pendingBatchCount}
              >
                <div class="workspace-pending-copy">
                  <div class="workspace-pending-head">
                    <span class="workspace-pending-kicker">{pendingBatchMode === 'sent' ? 'Sent Batch' : 'Draft Batch'}</span>
                    <span class="workspace-pending-note">What will go on-chain next</span>
                  </div>
                  {#if pendingBatchReserveIssueText}
                    <div class="workspace-pending-alert">{pendingBatchReserveIssueText}</div>
                  {/if}
                  <div class="workspace-pending-list">
                    {#each pendingBatchPreview as item (item.key)}
                      <div class="workspace-pending-chip">
                        <strong>{item.title}</strong>
                        <span>{item.subtitle}</span>
                      </div>
                    {/each}
                  </div>
                </div>
                <div class="workspace-pending-actions">
                  <button class="btn-table-action" type="button" on:click={openAssetHistoryWorkspace}>History</button>
                  <button class="btn-table-action" type="button" data-testid="settle-clear-batch" on:click={clearPendingBatch} disabled={pendingBatchSubmitting}>Clear Batch</button>
                  {#if hasSentBatch}
                    <button class="btn-table-action deposit" type="button" data-testid="settle-rebroadcast" on:click={rebroadcastPendingBatch} disabled={pendingBatchSubmitting}>
                      {pendingBatchSubmitting ? 'Working...' : 'Rebroadcast'}
                    </button>
                  {:else}
                    <button class="btn-table-action deposit" type="button" data-testid="settle-sign-broadcast" on:click={broadcastPendingBatch} disabled={!canBroadcastPendingBatch || pendingBatchSubmitting}>
                      {pendingBatchSubmitting ? 'Working...' : 'Sign & Broadcast'}
                    </button>
                  {/if}
                </div>
              </div>
            {/if}

            <nav class="account-workspace-tabs asset-workspace-tabs" aria-label="Asset workspace">
              <button class="account-workspace-tab" data-testid="asset-tab-move" class:active={assetWorkspaceTab === 'move'} on:click={openAssetMoveWorkspace}>
                <span>Move</span>
              </button>
              <button class="account-workspace-tab" data-testid="asset-tab-history" class:active={assetWorkspaceTab === 'history'} on:click={openAssetHistoryWorkspace}>
                <span>History</span>
              </button>
            </nav>

            {#if assetWorkspaceTab === 'move'}
              <MoveWorkspace
                mode="assets"
                bind:moveAmount
                bind:moveAssetSymbol
                bind:moveFromEndpoint
                bind:moveToEndpoint
                bind:moveExternalRecipient
                bind:moveReserveRecipientEntityId
                bind:moveSourceAccountId
                bind:moveTargetEntityId
                bind:moveTargetHubEntityId
                {moveExecuting}
                {moveProgressLabel}
                {moveDraftError}
                {moveBroadcastError}
                {moveSelectedSource}
                {moveSelectedTarget}
                {moveDragSource}
                {moveDragHoverTarget}
                {moveLineReady}
                {moveCommittedLineReady}
                {moveNodeLayoutVersion}
                {moveNeedsReserveRecipient}
                {moveNeedsExternalRecipient}
                {isMoveRouteSupported}
                moveDisplayBalances={moveUiState.displayBalances}
                moveDisplayDecimals={moveUiState.displayDecimals}
                moveSourceAvailableBalance={moveUiState.sourceAvailableBalance}
                {fillMoveMax}
                {setMoveSource}
                {setMoveTarget}
                {beginMoveDrag}
                {getMoveNodeAnchor}
                {buildMoveArrowPath}
                {moveRouteExecutionLabel}
                {moveRouteMeta}
                {moveRouteSteps}
                {canAddMoveToExistingBatch}
                {submitMovePrimaryAction}
                {handleMoveSourceAccountChange}
                {handleMoveReserveRecipientChange}
                {handleMoveTargetEntityChange}
                {handleMoveTargetHubChange}
                {moveNodeAction}
                {moveEntityOptions}
                {moveHubEntityOptions}
                {moveSourceAccountOptions}
                reserveRecipientPreferredId={resolveSelfEntityId()}
                targetEntityPreferredId={resolveSelfEntityId()}
                entityId={replica?.state?.entityId || tab.entityId}
                moveAssetOptions={moveAssetOptions}
                moveEndpointLabels={MOVE_ENDPOINT_LABEL}
                moveEndpoints={MOVE_ENDPOINTS}
                {formatAmount}
                {formatInlineFillAmount}
                movePrimaryActionLabel={getMovePrimaryActionLabel()}
                onMoveVisualRoot={(node) => moveVisualRoot = node}
                toastMoveError={handleMoveWorkspaceError}
              />
            {:else}
              <SettlementPanel
                entityId={replica.state?.entityId || tab.entityId}
                {replica}
                env={activeEnv}
                isLive={activeIsLive}
                historyOnly={true}
              />
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
            {selectedAccountId}
            on:select={handleAccountSelect}
            on:faucet={handleAccountFaucet}
            on:settleApprove={handleQuickSettleApprove}
          />

          {#if openOutgoingDebtSummary.count > 0}
            <div class="workspace-debt-warning" data-testid="workspace-debt-warning">
              <div class="workspace-debt-warning-copy">
                <span class="workspace-debt-warning-kicker">Open debts across all tokens</span>
                <strong>{openOutgoingDebtSummary.count} open · {formatApproxUsd(openOutgoingDebtSummary.usdTotal)}</strong>
              </div>
              <span class="workspace-debt-warning-note">Reserve spends sweep debts first. Sign & Broadcast stays locked while the draft still overspends after debt collection.</span>
            </div>
          {/if}

          {#if pendingBatchCount > 0}
            <div
              class="workspace-pending-banner"
              data-testid="workspace-pending-banner"
              data-pending-count={pendingBatchCount}
            >
              <div class="workspace-pending-copy">
                <div class="workspace-pending-head">
                  <span class="workspace-pending-kicker">{pendingBatchMode === 'sent' ? 'Sent Batch' : 'Draft Batch'}</span>
                  <span class="workspace-pending-note">What will go on-chain next</span>
                </div>
                {#if pendingBatchReserveIssueText}
                  <div class="workspace-pending-alert">{pendingBatchReserveIssueText}</div>
                {/if}
                <div class="workspace-pending-list">
                  {#each pendingBatchPreview as item (item.key)}
                    <div class="workspace-pending-chip">
                      <strong>{item.title}</strong>
                      <span>{item.subtitle}</span>
                    </div>
                  {/each}
                </div>
              </div>
              <div class="workspace-pending-actions">
                <button class="btn-table-action" type="button" on:click={openAccountHistoryWorkspace}>History</button>
                <button class="btn-table-action" type="button" data-testid="settle-clear-batch" on:click={clearPendingBatch} disabled={pendingBatchSubmitting}>Clear Batch</button>
                {#if hasSentBatch}
                  <button class="btn-table-action deposit" type="button" data-testid="settle-rebroadcast" on:click={rebroadcastPendingBatch} disabled={pendingBatchSubmitting}>
                    {pendingBatchSubmitting ? 'Working...' : 'Rebroadcast'}
                  </button>
                {:else}
                  <button class="btn-table-action deposit" type="button" data-testid="settle-sign-broadcast" on:click={broadcastPendingBatch} disabled={!canBroadcastPendingBatch || pendingBatchSubmitting}>
                    {pendingBatchSubmitting ? 'Working...' : 'Sign & Broadcast'}
                  </button>
                {/if}
              </div>
            </div>
          {/if}

          <AccountWorkspaceRail
            tabs={visibleAccountWorkspaceTabs}
            activeTab={accountWorkspaceTab}
            primaryTabIds={accountWorkspacePrimaryTabIds}
            ariaLabel="Account workspace"
            on:select={(event) => selectAccountWorkspaceTab(event.detail)}
          />

          <section class="account-workspace-content">
            {#if accountWorkspaceTab === 'send'}
              {#if liveRuntimeEnv && activeIsLive}
                <PaymentPanel
                  entityId={replica.state?.entityId || tab.entityId}
                  env={liveRuntimeEnv}
                  isLive={activeIsLive}
                />
              {:else}
                <div class="live-required configure-empty">
                  <AlertTriangle size={18} />
                  <p>Payments are only available in LIVE mode.</p>
                </div>
              {/if}

            {:else if accountWorkspaceTab === 'receive'}
              <ReceivePanel entityId={replica.state?.entityId || tab.entityId} />

            {:else if accountWorkspaceTab === 'swap'}
              <SwapPanel
                {replica}
                {tab}
                env={activeEnv}
                isLive={activeIsLive}
              />

            {:else if accountWorkspaceTab === 'move'}
              <MoveWorkspace
                mode="accounts"
                bind:moveAmount
                bind:moveAssetSymbol
                bind:moveFromEndpoint
                bind:moveToEndpoint
                bind:moveExternalRecipient
                bind:moveReserveRecipientEntityId
                bind:moveSourceAccountId
                bind:moveTargetEntityId
                bind:moveTargetHubEntityId
                {moveExecuting}
                {moveProgressLabel}
                {moveDraftError}
                {moveBroadcastError}
                {moveSelectedSource}
                {moveSelectedTarget}
                {moveDragSource}
                {moveDragHoverTarget}
                {moveLineReady}
                {moveCommittedLineReady}
                {moveNodeLayoutVersion}
                {moveNeedsReserveRecipient}
                {moveNeedsExternalRecipient}
                {isMoveRouteSupported}
                moveDisplayBalances={moveUiState.displayBalances}
                moveDisplayDecimals={moveUiState.displayDecimals}
                moveSourceAvailableBalance={moveUiState.sourceAvailableBalance}
                {fillMoveMax}
                {setMoveSource}
                {setMoveTarget}
                {beginMoveDrag}
                {getMoveNodeAnchor}
                {buildMoveArrowPath}
                {moveRouteExecutionLabel}
                {moveRouteMeta}
                {moveRouteSteps}
                {canAddMoveToExistingBatch}
                {submitMovePrimaryAction}
                {handleMoveSourceAccountChange}
                {handleMoveReserveRecipientChange}
                {handleMoveTargetEntityChange}
                {handleMoveTargetHubChange}
                {moveNodeAction}
                {moveEntityOptions}
                {moveHubEntityOptions}
                {moveSourceAccountOptions}
                reserveRecipientPreferredId={resolveSelfEntityId()}
                targetEntityPreferredId={resolveSelfEntityId()}
                entityId={replica?.state?.entityId || tab.entityId}
                moveAssetOptions={moveAssetOptions}
                moveEndpointLabels={MOVE_ENDPOINT_LABEL}
                moveEndpoints={MOVE_ENDPOINTS}
                {formatAmount}
                {formatInlineFillAmount}
                movePrimaryActionLabel={getMovePrimaryActionLabel()}
                onMoveVisualRoot={(node) => moveVisualRoot = node}
                toastMoveError={handleMoveWorkspaceError}
              />

            {:else if accountWorkspaceTab === 'history'}
              <SettlementPanel
                entityId={replica.state?.entityId || tab.entityId}
                {replica}
                env={activeEnv}
                isLive={activeIsLive}
                historyOnly={true}
              />

            {:else if accountWorkspaceTab === 'configure'}
              <div class="configure-panel">
                <div class="workspace-inline-selector">
                  <EntityInput
                    label="Manage Account"
                    value={workspaceAccountId}
                    entities={workspaceAccountIds}
                    testId="configure-account-selector"
                    excludeId={replica?.state?.entityId || tab.entityId}
                    placeholder="Select account for manage..."
                    disabled={!activeIsLive || workspaceAccountIds.length === 0}
                    on:change={handleWorkspaceAccountChange}
                  />
                </div>
                <nav class="configure-tabs" aria-label="Account manage workspace">
                  <button
                    class="configure-tab"
                    data-testid="configure-tab-extend-credit"
                    class:active={configureWorkspaceTab === 'extend-credit'}
                    on:click={() => configureWorkspaceTab = 'extend-credit'}
                  >
                    Extend Credit
                  </button>
                  <button
                    class="configure-tab"
                    data-testid="configure-tab-request-credit"
                    class:active={configureWorkspaceTab === 'request-credit'}
                    on:click={() => configureWorkspaceTab = 'request-credit'}
                  >
                    Request Credit
                  </button>
                  <button
                    class="configure-tab"
                    data-testid="configure-tab-collateral"
                    class:active={configureWorkspaceTab === 'collateral'}
                    on:click={() => configureWorkspaceTab = 'collateral'}
                  >
                    Request Collateral
                  </button>
                  <button
                    class="configure-tab"
                    data-testid="configure-tab-token"
                    class:active={configureWorkspaceTab === 'token'}
                    on:click={() => configureWorkspaceTab = 'token'}
                  >
                    Add Token
                  </button>
                  <button
                    class="configure-tab danger"
                    data-testid="configure-tab-dispute"
                    class:active={configureWorkspaceTab === 'dispute'}
                    on:click={() => configureWorkspaceTab = 'dispute'}
                  >
                    Dispute
                  </button>
                </nav>

                {#if !workspaceAccountId}
                  <div class="live-required configure-empty">
                    <AlertTriangle size={18} />
                    <p>Select workspace account above first.</p>
                  </div>
                {:else if !liveRuntimeEnv || !activeIsLive}
                  <div class="live-required configure-empty">
                    <AlertTriangle size={18} />
                    <p>Account actions are only available in LIVE mode.</p>
                  </div>
                {:else if configureWorkspaceTab === 'extend-credit'}
                  <CreditForm
                    entityId={replica.state?.entityId || tab.entityId}
                    env={liveRuntimeEnv}
                    isLive={activeIsLive}
                    signerId={tab.signerId || null}
                    counterpartyId={workspaceAccountId}
                    accountIds={workspaceAccountIds}
                    mode="extend"
                  />
                {:else if configureWorkspaceTab === 'request-credit'}
                  <CreditForm
                    entityId={replica.state?.entityId || tab.entityId}
                    env={liveRuntimeEnv}
                    isLive={activeIsLive}
                    signerId={tab.signerId || null}
                    counterpartyId={workspaceAccountId}
                    accountIds={workspaceAccountIds}
                    mode="request"
                  />
                {:else if configureWorkspaceTab === 'collateral'}
                  <CollateralForm
                    entityId={replica.state?.entityId || tab.entityId}
                    env={liveRuntimeEnv}
                    isLive={activeIsLive}
                    signerId={tab.signerId || null}
                    counterpartyId={workspaceAccountId}
                    accountIds={workspaceAccountIds}
                  />
                {:else if configureWorkspaceTab === 'dispute'}
                  {@const configureAccount = replica?.state?.accounts?.get?.(workspaceAccountId)}
                  <div class="configure-token-card danger-card">
                    <h4 class="section-head">Dispute Account</h4>
                    <p class="muted">
                      This queues a dispute operation into the pending batch. Once broadcast and finalized, this account becomes unusable until reopened.
                    </p>
                    {#if configureAccount?.activeDispute}
                      <p class="danger-note">
                        Active dispute in progress. Finalize only after the timeout passes on-chain.
                      </p>
                      <button
                        class="btn-danger-batch"
                        data-testid="configure-dispute-finalize"
                        on:click={() => confirmAndQueueDisputeFinalize(workspaceAccountId, 'dispute-finalize-from-configure')}
                        disabled={!activeIsLive}
                      >
                        Add Dispute Finalize To Batch
                      </button>
                    {:else}
                      <p class="danger-note">
                        Starting a dispute freezes normal use of this account and should only be used for recovery or adversarial settlement.
                      </p>
                      <button
                        class="btn-danger-batch"
                        data-testid="configure-dispute-start"
                        on:click={() => confirmAndQueueDisputeStart(workspaceAccountId, 'dispute-start-from-configure')}
                        disabled={!activeIsLive}
                      >
                        Add Dispute Start To Batch
                      </button>
                    {/if}
                  </div>
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
                      <button
                        class="btn-add-token"
                        data-testid="configure-token-add"
                        on:click={addTokenToAccount}
                        disabled={!activeIsLive || !workspaceAccountId}
                      >
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
                      <p class="muted">Layout and scale for capacity bars.</p>
                    </div>
                  </div>

                  <div class="appearance-block">
                    <span class="appearance-label">Layout</span>
                    <div class="appearance-pill-group" role="tablist" aria-label="Account bar layout">
                      <button
                        class="appearance-pill"
                        class:active={$settings.barLayout === 'center'}
                        on:click={() => settingsOperations.setBarLayout('center')}
                      >
                        <span class="pill-icon">&#9646;&#9646;</span> Center
                      </button>
                      <button
                        class="appearance-pill"
                        class:active={$settings.barLayout === 'sides'}
                        on:click={() => settingsOperations.setBarLayout('sides')}
                      >
                        <span class="pill-icon">&#9664;&#9654;</span> Sides
                      </button>
                    </div>
                  </div>

                  <div class="appearance-block">
                    <div class="appearance-scale-row">
                      <span class="appearance-label">Scale</span>
                      <div class="appearance-scale-meta">
                        <span class="appearance-scale-bound">$10</span>
                        <strong class="appearance-scale-value">100px = ${accountBarUsdPer100Px.toLocaleString('en-US')}</strong>
                        <span class="appearance-scale-bound">$10k</span>
                      </div>
                    </div>
                    <div class="slider-container">
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
                </div>

                <div class="appearance-card">
                  <div class="appearance-head">
                    <div>
                      <h4 class="section-head">Bar Effects</h4>
                      <p class="muted">Toggle visual effects on capacity bars.</p>
                    </div>
                  </div>

                  <label class="appearance-switch-row">
                    <span class="appearance-label">Credit Gradient</span>
                    <span class="appearance-hint">Cap credit segments with fade-out</span>
                    <input type="checkbox" class="appearance-checkbox" checked={$settings.barCreditGradient}
                      on:change={(e) => settingsOperations.update({ barCreditGradient: e.currentTarget.checked })} />
                  </label>

                  <label class="appearance-switch-row">
                    <span class="appearance-label">Smooth Resize</span>
                    <span class="appearance-hint">Animate bar width changes</span>
                    <input type="checkbox" class="appearance-checkbox" checked={$settings.barAnimTransition}
                      on:change={(e) => settingsOperations.update({ barAnimTransition: e.currentTarget.checked })} />
                  </label>

                  <label class="appearance-switch-row">
                    <span class="appearance-label">Sweep</span>
                    <span class="appearance-hint">Light beam sweeps right-to-left on update</span>
                    <input type="checkbox" class="appearance-checkbox" checked={$settings.barAnimSweep}
                      on:change={(e) => settingsOperations.update({ barAnimSweep: e.currentTarget.checked })} />
                  </label>

                  <label class="appearance-switch-row">
                    <span class="appearance-label">Glow</span>
                    <span class="appearance-hint">Brightness pulse on bar change</span>
                    <input type="checkbox" class="appearance-checkbox" checked={$settings.barAnimGlow}
                      on:change={(e) => settingsOperations.update({ barAnimGlow: e.currentTarget.checked })} />
                  </label>

                  <label class="appearance-switch-row">
                    <span class="appearance-label">Delta Flash</span>
                    <span class="appearance-hint">Show +/- amount text overlay</span>
                    <input type="checkbox" class="appearance-checkbox" checked={$settings.barAnimDeltaFlash}
                      on:change={(e) => settingsOperations.update({ barAnimDeltaFlash: e.currentTarget.checked })} />
                  </label>

                  <label class="appearance-switch-row">
                    <span class="appearance-label">Ripple</span>
                    <span class="appearance-hint">Expanding ring from bar center</span>
                    <input type="checkbox" class="appearance-checkbox" checked={$settings.barAnimRipple}
                      on:change={(e) => settingsOperations.update({ barAnimRipple: e.currentTarget.checked })} />
                  </label>
                </div>
              </section>

            {:else if accountWorkspaceTab === 'open'}
              <div class="account-open-sections">
                <div class="open-section">
                  <div class="open-section-head">
                    <div class="open-section-copy">
                      <span class="open-section-kicker">Network</span>
                      <h4 class="section-head">Open Account</h4>
                    </div>
                  </div>
                  {#if liveRuntimeEnv}
                    <HubDiscoveryPanel
                      entityId={replica?.state?.entityId || tab.entityId}
                      env={liveRuntimeEnv}
                      isLive={activeIsLive}
                    />
                  {/if}
                </div>
                <div class="open-section">
                  <div class="open-section-head compact">
                    <div class="open-section-copy">
                      <span class="open-section-kicker">Direct</span>
                      <h4 class="section-head">Open by ID</h4>
                    </div>
                  </div>
                  <div class="open-private-form">
                    <EntityInput
                      variant="move"
                      label="Recipient"
                      value={openAccountEntityId}
                      entities={openAccountEntityOptions}
                      excludeId={replica?.state?.entityId || tab.entityId}
                      placeholder="Select or paste entity ID"
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
                    <p class="muted" style="margin-top: 0;">Hidden from the main list. Reopen after finalize.</p>
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
                <div class="entity-activity-toolbar">
                  <label class="entity-activity-filter">
                    <span>Account</span>
                    <select bind:value={entityActivityAccountFilter}>
                      <option value="all">All accounts</option>
                      {#each entityActivityAccounts as accountOption}
                        <option value={accountOption.accountId}>{accountOption.accountLabel}</option>
                      {/each}
                    </select>
                  </label>
                </div>
                <div class="entity-activity-list">
                  {#if filteredEntityActivityRows.length === 0}
                    <p class="muted">No activity for this account yet.</p>
                  {:else}
                    {#each filteredEntityActivityRows as row (row.id)}
                      <article
                        class="entity-activity-row"
                        class:ours={row.actor === 'you'}
                        class:peer={row.actor === 'peer'}
                        class:system={row.actor === 'system'}
                        class:queue={row.kind === 'pending' || row.kind === 'mempool'}
                      >
                        <div class="entity-activity-actor">
                          {#if row.actorAvatar}
                            <img class="entity-activity-avatar" src={row.actorAvatar} alt="" />
                          {:else}
                            <div class="entity-activity-avatar entity-activity-avatar-fallback">{row.actorInitials}</div>
                          {/if}
                          <div class="entity-activity-author-meta">
                            <div class="entity-activity-author-name">{row.actorName}</div>
                            <div class="entity-activity-author-badge">{row.actorLabel}</div>
                          </div>
                        </div>
                        <div class="entity-activity-bubble">
                          <div class="entity-activity-bubble-head">
                            <div class="entity-activity-headline">{row.headline}</div>
                            <div class="entity-activity-time">{formatTime(row.timestamp)}</div>
                          </div>
                          {#if row.bodyLines.length > 0}
                            <div class="entity-activity-lines">
                              {#each row.bodyLines as line}
                                <div class="entity-activity-line">{line}</div>
                              {/each}
                            </div>
                          {/if}
                          <div class="entity-activity-chips">
                            {#each row.chips as chip}
                              <span class="entity-activity-chip tone-{chip.tone || 'neutral'}">{chip.label}</span>
                            {/each}
                          </div>
                          <div class="entity-activity-footer">
                            <span>{row.footerLeft}</span>
                            <span>{row.footerRight}</span>
                          </div>
                        </div>
                      </article>
                    {/each}
                  {/if}
                </div>
              {/if}

            {/if}
          </section>

        {:else if activeTab === 'settings'}
          <EntitySettingsPanel
            embedded={true}
            {replica}
            {activeIsLive}
            currentTimeIndex={activeTimeIndex}
            jurisdictionLabel={selectedJurisdictionName || ''}
            requestedTab={settingsSubview}
            tab={tab}
          />
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
    width: 100%;
    max-width: 1220px;
    min-height: 0;
    height: auto;
    margin: 0 auto;
    padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
    background: transparent;
    color: var(--theme-text-primary, #e4e4e7);
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 13px;
    box-sizing: border-box;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-header-bg, #151316)) 96%, var(--theme-background, #09090b));
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 88%, transparent);
    box-shadow: 0 8px 20px color-mix(in srgb, var(--theme-background, #09090b) 5%, transparent);
    flex-shrink: 0;
  }

  .header.user-mode-header {
    gap: 10px;
    padding: 10px var(--panel-gutter-x);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--theme-card-bg, var(--theme-header-bg, #151316)) 98%, var(--theme-background, #09090b)) 0%,
      color-mix(in srgb, var(--theme-background, #09090b) 100%, transparent) 100%
    );
  }

  .header :global(select),
  .header :global(button),
  .header :global(.dropdown-trigger) {
    background: color-mix(in srgb, var(--theme-input-bg, var(--theme-card-bg, #18181b)) 96%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-input-border, var(--theme-card-border, #27272a)) 86%, transparent);
    border-radius: 6px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
    padding: 6px 10px;
    cursor: pointer;
  }

  /* History Warning */
  .history-warning {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px;
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 14%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 34%, transparent);
    color: var(--theme-accent, #fbbf24);
    font-size: 12px;
    flex-shrink: 0;
    border: 0;
    width: 100%;
    cursor: pointer;
  }

  .history-warning:hover {
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 18%, transparent);
  }

  .faucet-inline-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    padding: 10px 14px;
    border: 1px solid rgba(120, 113, 108, 0.22);
    border-radius: 14px;
    background: rgba(23, 20, 18, 0.58);
  }

  .faucet-inline-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    width: 100%;
  }

  .faucet-inline-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #fbbf24;
    white-space: nowrap;
  }

  .faucet-inline-token {
    min-width: 112px;
    max-width: 144px;
    min-height: 34px;
    padding: 6px 28px 6px 10px;
    border-radius: 10px;
    background: rgba(17, 13, 11, 0.92);
    border: 1px solid rgba(120, 113, 108, 0.32);
    color: #f5f5f4;
  }

  .workspace-pending-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    margin-bottom: 12px;
    border-radius: 14px;
    border: 1px solid rgba(236, 179, 55, 0.35);
    background: rgba(236, 179, 55, 0.08);
    color: rgba(255, 242, 213, 0.96);
  }

  .workspace-debt-warning {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 14px;
    margin-bottom: 12px;
    border-radius: 14px;
    border: 1px solid rgba(248, 113, 113, 0.26);
    background: rgba(127, 29, 29, 0.16);
    color: #fee2e2;
  }

  .workspace-debt-warning-copy {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px;
  }

  .workspace-debt-warning-kicker {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #fca5a5;
  }

  .workspace-debt-warning-note {
    font-size: 12px;
    color: rgba(254, 226, 226, 0.84);
  }

  .workspace-pending-copy {
    display: grid;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }

  .workspace-pending-head {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: baseline;
  }

  .workspace-pending-kicker {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #ffd56a;
  }

  .workspace-pending-note {
    font-size: 12px;
    color: rgba(255, 242, 213, 0.82);
  }

  .workspace-pending-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .workspace-pending-alert {
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(127, 29, 29, 0.28);
    border: 1px solid rgba(248, 113, 113, 0.22);
    color: #fecaca;
    font-size: 12px;
    line-height: 1.4;
  }

  .workspace-pending-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
  }

  .workspace-pending-chip {
    display: grid;
    gap: 3px;
    min-width: 160px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(8, 10, 14, 0.36);
    border: 1px solid rgba(236, 179, 55, 0.18);
  }

  .workspace-pending-chip strong {
    font-size: 12px;
    color: #fff5d9;
  }

  .workspace-pending-chip span {
    font-size: 11px;
    line-height: 1.35;
    color: rgba(255, 242, 213, 0.74);
  }

  /* Main content - NO own scrollbar, parent .panel-content scrolls */
  .main-scroll {
    display: contents;
  }

  /* Empty State */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 300px;
    color: var(--theme-text-muted, #71717a);
    gap: 12px;
  }

  .empty-state h3 {
    margin: 0;
    font-size: 16px;
    color: var(--theme-text-primary, #e4e4e7);
  }

  .empty-state p {
    margin: 0;
    font-size: 12px;
  }

  .empty-state-reset {
    margin-top: 8px;
    padding: 10px 14px;
    border-radius: 10px;
    border: 1px solid rgba(239, 68, 68, 0.28);
    background: linear-gradient(180deg, rgba(69, 10, 10, 0.94), rgba(31, 12, 12, 0.96));
    color: #fca5a5;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
  }

  .empty-state-reset:hover:not(:disabled) {
    border-color: rgba(248, 113, 113, 0.52);
    color: #fecaca;
    transform: translateY(-1px);
  }

  .empty-state-reset:disabled {
    opacity: 0.55;
    cursor: wait;
  }

  /* Focused Account View */
  .focused-view {
    min-height: 0;
  }

  /* Hero Section - Entity + Net Worth */
  .hero {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) var(--panel-gutter-x);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, var(--theme-background, #09090b)) 0%,
      color-mix(in srgb, var(--theme-background, #09090b) 100%, transparent) 100%
    );
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 86%, transparent);
    box-shadow: 0 8px 20px color-mix(in srgb, var(--theme-background, #09090b) 5%, transparent);
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

  .hero-meta-block {
    margin-top: 2px;
    max-width: min(820px, 100%);
  }

  .hero-context-switcher {
    max-width: min(360px, 100%);
    width: fit-content;
  }

  .hero-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--theme-text-primary, #e4e4e7);
    letter-spacing: -0.01em;
    word-break: break-word;
  }

  .hero-right {
    text-align: right;
    min-width: 0;
  }

  .hero-networth {
    font-family: 'JetBrains Mono', monospace;
    font-size: 24px;
    font-weight: 700;
    color: var(--theme-text-primary, #e4e4e7);
    letter-spacing: -0.3px;
    line-height: 1;
  }

  .hero-label {
    font-size: 9px;
    color: var(--theme-text-muted, #71717a);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-top: 3px;
    font-weight: 500;
  }

  /* Tabs */
  .tabs {
    display: flex;
    padding: 0 var(--panel-gutter-x);
    background: transparent;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 58%, transparent);
    overflow-x: auto;
    flex-shrink: 0;
    gap: 4px;
    -webkit-overflow-scrolling: touch;
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
    color: var(--theme-text-muted, #71717a);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
    border-radius: 6px 6px 0 0;
  }

  .tab:hover {
    color: var(--theme-text-secondary, #a1a1aa);
  }

  .tab.active {
    color: var(--theme-text-primary, #e4e4e7);
    border-bottom-color: transparent;
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 9%, transparent);
    box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--theme-accent, #fbbf24) 82%, transparent);
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
    min-width: 0;
  }

  .accounts-selector-row {
    margin-bottom: 10px;
    padding: 10px;
    border: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 64%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 94%, transparent);
    box-shadow: 0 8px 18px color-mix(in srgb, var(--theme-background, #09090b) 4%, transparent);
  }

  .accounts-selector-row :global(.dropdown-trigger) {
    width: 100%;
    min-height: 42px;
    border: 1px solid color-mix(in srgb, var(--theme-input-border, var(--theme-card-border, #27272a)) 86%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 96%, transparent);
    color: var(--theme-text-primary, #e4e4e7);
  }

  .accounts-selector-row :global(.trigger-text) {
    font-size: 13px;
  }

  .account-workspace-tabs {
    display: flex;
    gap: 4px;
    margin-top: var(--space-3);
    padding: 0 0 2px;
    border: none;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 56%, transparent);
    border-radius: 0;
    background: transparent;
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
    min-height: 40px;
    padding: 8px 12px;
    border: 1px solid transparent;
    border-radius: 10px 10px 0 0;
    background: transparent;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    white-space: nowrap;
    cursor: pointer;
    transition: all 0.15s ease;
    touch-action: manipulation;
  }

  .account-workspace-tab:hover {
    color: var(--theme-text-primary, #e4e4e7);
    border-color: transparent;
    background: color-mix(in srgb, var(--theme-surface-hover, var(--theme-card-bg, #1c1c20)) 58%, transparent);
  }

  .account-workspace-tab.active {
    color: var(--theme-text-primary, #e4e4e7);
    border-color: color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 50%, transparent);
    border-bottom-color: transparent;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--theme-accent, #fbbf24) 8%, transparent), transparent),
      color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 94%, transparent);
    box-shadow: inset 0 2px 0 color-mix(in srgb, var(--theme-accent, #fbbf24) 78%, transparent);
  }

  .account-workspace-content {
    margin-top: var(--space-3);
  }

  .workspace-inline-selector {
    margin-bottom: 10px;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 86%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent);
    box-shadow: 0 10px 24px color-mix(in srgb, var(--theme-background, #09090b) 6%, transparent);
  }

  .configure-panel {
    border: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 86%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent);
    padding: 10px;
    box-shadow: 0 10px 24px color-mix(in srgb, var(--theme-background, #09090b) 6%, transparent);
  }

  .configure-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  .configure-tab {
    padding: 8px 12px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 75%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 88%, transparent);
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .configure-tab:hover {
    color: var(--theme-text-primary, #e4e4e7);
    border-color: color-mix(in srgb, var(--theme-border, #27272a) 85%, white 15%);
  }

  .configure-tab.active {
    color: var(--theme-accent, #fbbf24);
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 65%, transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 10%, transparent);
  }

  .configure-tab.danger {
    color: #fca5a5;
    border-color: rgba(239, 68, 68, 0.4);
  }

  .configure-tab.danger:hover,
  .configure-tab.danger.active {
    color: #fecaca;
    border-color: rgba(239, 68, 68, 0.8);
    background: rgba(127, 29, 29, 0.25);
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

  .danger-card {
    border-color: rgba(239, 68, 68, 0.35);
    background: linear-gradient(180deg, rgba(60, 15, 18, 0.92), rgba(24, 10, 12, 0.96));
  }

  .danger-note {
    margin: 10px 0 14px;
    font-size: 12px;
    line-height: 1.45;
    color: #fecaca;
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

  .appearance-pill-group {
    display: inline-flex;
    align-items: center;
    gap: 0;
    padding: 3px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
    width: fit-content;
  }

  .appearance-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 100px;
    padding: 7px 14px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: #71717a;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .pill-icon {
    font-size: 10px;
    letter-spacing: -2px;
    opacity: 0.6;
  }

  .appearance-pill:hover {
    color: #d4d4d8;
    background: rgba(255, 255, 255, 0.04);
  }

  .appearance-pill.active {
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.12);
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.2) inset;
  }

  .appearance-pill.active .pill-icon {
    opacity: 1;
  }

  .appearance-scale-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }

  .appearance-scale-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: flex-end;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
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

  .slider-container {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    padding: 0;
    box-sizing: border-box;
  }

  .appearance-switch-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    cursor: pointer;
    user-select: none;
  }

  .appearance-switch-row .appearance-label {
    flex: 0 0 auto;
    min-width: 110px;
  }

  .appearance-hint {
    flex: 1;
    font-size: 11px;
    color: #71717a;
  }

  .appearance-checkbox {
    flex: 0 0 auto;
    cursor: pointer;
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

  .btn-danger-batch {
    padding: 10px 14px;
    border-radius: 9px;
    border: 1px solid rgba(248, 113, 113, 0.6);
    background: linear-gradient(180deg, rgba(185, 28, 28, 0.34), rgba(127, 29, 29, 0.22));
    color: #fee2e2;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-danger-batch:hover:not(:disabled) {
    border-color: rgba(252, 165, 165, 0.95);
    color: #fff1f2;
  }

  .btn-danger-batch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .section-head {
    font-size: 12px;
    font-weight: 600;
    color: #71717a;
    text-transform: none;
    letter-spacing: 0.01em;
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

  .entity-activity-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .entity-activity-toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 12px;
  }

  .entity-activity-filter {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: #a1a1aa;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .entity-activity-filter select {
    min-height: 36px;
    min-width: 220px;
    padding: 0 12px;
    border-radius: 12px;
    border: 1px solid #2f333b;
    background: #111315;
    color: #f5f5f5;
    font-size: 13px;
  }

  .entity-activity-row {
    display: flex;
    align-items: flex-end;
    gap: 12px;
  }

  .entity-activity-row.ours {
    flex-direction: row-reverse;
  }

  .entity-activity-row.system {
    align-items: flex-start;
  }

  .entity-activity-actor {
    width: 108px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .entity-activity-row.ours .entity-activity-actor {
    flex-direction: row-reverse;
    text-align: right;
  }

  .entity-activity-avatar {
    width: 40px;
    height: 40px;
    border-radius: 14px;
    border: 1px solid #2c3139;
    background: #121416;
    flex-shrink: 0;
  }

  .entity-activity-avatar-fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #f5f5f5;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .entity-activity-author-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .entity-activity-author-name {
    color: #f5f5f5;
    font-size: 13px;
    font-weight: 700;
    line-height: 1.2;
  }

  .entity-activity-author-badge {
    color: #a1a1aa;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .entity-activity-bubble {
    flex: 1;
    max-width: min(760px, calc(100% - 132px));
    border-radius: 18px;
    border: 1px solid #2a2d31;
    background: linear-gradient(180deg, rgba(19, 21, 24, 0.98), rgba(13, 14, 16, 0.98));
    padding: 14px 16px;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.22);
  }

  .entity-activity-row.ours .entity-activity-bubble {
    border-color: #454545;
    background: linear-gradient(180deg, rgba(23, 23, 23, 0.98), rgba(15, 15, 15, 0.98));
  }

  .entity-activity-row.peer .entity-activity-bubble {
    border-color: #303030;
  }

  .entity-activity-row.queue .entity-activity-bubble {
    border-style: dashed;
  }

  .entity-activity-bubble-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 8px;
  }

  .entity-activity-headline {
    color: #fafafa;
    font-size: 15px;
    font-weight: 700;
    line-height: 1.35;
  }

  .entity-activity-time {
    font-size: 11px;
    color: #8b8b8b;
    font-family: 'JetBrains Mono', monospace;
    white-space: nowrap;
  }

  .entity-activity-lines {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }

  .entity-activity-line {
    color: #d4d4d4;
    font-size: 13px;
    line-height: 1.45;
  }

  .entity-activity-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }

  .entity-activity-chip {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid #353535;
    background: #121212;
    color: #d4d4d4;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }

  .entity-activity-chip.tone-good {
    border-color: #27543a;
    color: #b7f7c6;
  }

  .entity-activity-chip.tone-warn {
    border-color: #61491c;
    color: #f3d089;
  }

  .entity-activity-chip.tone-danger {
    border-color: #633131;
    color: #f0b4b4;
  }

  .entity-activity-footer {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: #7a7a7a;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
  }

  @media (max-width: 720px) {
    .entity-activity-toolbar {
      justify-content: stretch;
    }

    .entity-activity-filter,
    .entity-activity-filter select {
      width: 100%;
    }

    .entity-activity-row,
    .entity-activity-row.ours {
      flex-direction: column;
      align-items: stretch;
    }

    .entity-activity-actor,
    .entity-activity-row.ours .entity-activity-actor {
      width: 100%;
      flex-direction: row;
      text-align: left;
    }

    .entity-activity-bubble {
      max-width: 100%;
    }

    .entity-activity-bubble-head,
    .entity-activity-footer {
      flex-direction: column;
      align-items: flex-start;
    }
  }

  .btn-add {
    min-height: 48px;
    padding: 0 16px;
    background: linear-gradient(135deg, #b45309, #92400e);
    border: 1px solid rgba(251, 191, 36, 0.22);
    border-radius: 12px;
    color: #fef3c7;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    box-shadow: 0 18px 34px rgba(180, 83, 9, 0.18);
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

  .content :global(input:not([type="range"]):not([type="checkbox"]):not(.entity-input-field):not(.move-amount-input):not(.move-external-input)),
  .content :global(select:not(.move-token-select)) {
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 88%, transparent) !important;
    border: 1px solid color-mix(in srgb, var(--theme-input-border, #27272a) 82%, transparent) !important;
    border-radius: 6px !important;
    color: var(--theme-text-primary, #e4e4e7) !important;
    padding: 10px 12px !important;
    font-size: 13px !important;
  }

  .content :global(input:not([type="range"]):not([type="checkbox"]):focus),
  .content :global(select:focus) {
    outline: none !important;
    border-color: var(--theme-input-focus, #fbbf24) !important;
  }

  .content :global(input::placeholder) {
    color: var(--theme-text-muted, #71717a) !important;
  }

  .content :global(button:not(.tab):not(.toggle):not(.back-btn):not(.btn-add):not(.btn-live):not(.c-delete):not(.account-workspace-tab):not(.configure-tab):not(.btn-add-token):not(.scope-btn):not(.primary-btn):not(.cancel-btn):not(.summary-action):not(.summary-action-inline):not(.delta-faucet):not(.delta-expand):not(.step-btn):not(.step-auto-btn):not(.move-node):not(.move-primary-cta):not(.move-max-chip):not(.refresh-btn):not(.hub-primary):not(.btn-connect):not(.expand-toggle):not(.closed-trigger):not(.dropdown-toggle):not(.dropdown-item):not(.settings-tab):not(.compact-btn):not(.pill):not(.theme-swatch):not(.icon-btn):not(.danger-icon):not(.close-btn):not(.file-btn):not(.danger-btn)) {
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent) !important;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent) !important;
    border-radius: 6px !important;
    color: var(--theme-text-secondary, #a1a1aa) !important;
    padding: 10px 14px !important;
    font-size: 12px !important;
    cursor: pointer !important;
  }

  .content :global(h3),
  .content :global(h4),
  .content :global(label) {
    color: var(--theme-text-secondary, #a1a1aa) !important;
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

  .btn-refresh-small {
    padding: 5px 10px;
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent);
    border-radius: 6px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-refresh-small:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--theme-border, #27272a) 85%, white 15%);
    color: var(--theme-text-primary, #e4e4e7);
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 92%, transparent);
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

  .wallet-meta-copy {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
    max-width: 100%;
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    min-width: 0;
  }

  .wallet-meta-copy:hover .wallet-meta-value {
    color: #f5f5f4;
  }

  .wallet-meta-value {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #e7e5e4;
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .wallet-meta-help {
    margin: 0;
    max-width: 40ch;
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
    font-size: 11px;
    font-weight: 600;
    color: #57534e;
    text-transform: none;
    letter-spacing: 0.01em;
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

  .asset-ledger-header,
  .asset-ledger-row {
    grid-template-columns: minmax(90px, 140px) repeat(3, minmax(0, 1fr));
  }

  @media (max-width: 520px) {
    .asset-ledger-header,
    .asset-ledger-row {
      grid-template-columns: minmax(70px, 1fr) repeat(3, minmax(60px, 1fr));
      font-size: 11px;
    }
  }

  .asset-ledger-table {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
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
    text-transform: none;
    letter-spacing: 0.01em;
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
    flex-wrap: wrap;
  }

  .asset-action-card {
    margin-top: 12px;
    padding: 16px;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--theme-surface, #18181b) 92%, transparent),
      color-mix(in srgb, var(--theme-background, #09090b) 94%, transparent)
    );
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 54%, transparent);
    border-radius: 10px;
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

  .btn-table-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .account-open-sections {
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(300px, 0.95fr);
    gap: 14px;
    margin-top: 8px;
    align-items: start;
  }

  .open-section {
    padding: 15px 16px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 56%, transparent);
    border-radius: 14px;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--theme-accent, #fbbf24) 2%, transparent), transparent 24%),
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent),
        color-mix(in srgb, var(--theme-input-bg, #09090b) 100%, transparent)
      );
    box-shadow: 0 6px 16px color-mix(in srgb, var(--theme-background, #09090b) 4%, transparent);
    min-width: 0;
  }

  .open-section-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }

  .open-section-head.compact {
    margin-bottom: 12px;
  }

  .open-section-copy {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }

  .open-section-kicker {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.01em;
    text-transform: none;
    color: var(--theme-accent, #fbbf24);
  }

  .open-section-note {
    margin: 0;
    font-size: 11px;
    line-height: 1.4;
    color: var(--theme-text-muted, #71717a);
  }

  .open-private-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .disputed-section {
    grid-column: 1 / -1;
    padding: 16px 18px;
    border-color: rgba(244, 63, 94, 0.25);
    background: linear-gradient(
      180deg,
      rgba(244, 63, 94, 0.08),
      rgba(15, 23, 42, 0.16)
    );
    border: 1px solid rgba(244, 63, 94, 0.25);
    border-radius: 16px;
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
    padding: 12px 14px;
    border: 1px solid rgba(244, 63, 94, 0.2);
    border-radius: 14px;
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
    min-height: 38px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid rgba(251, 191, 36, 0.35);
    background: rgba(251, 191, 36, 0.12);
    color: #fde68a;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
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
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
    }

    .hero-right {
      width: 100%;
      min-width: 0;
      text-align: left;
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
      min-width: 0;
    }

    .account-workspace-tabs {
      gap: 4px;
    }

    .account-workspace-tab {
      min-height: 38px;
      padding: 8px 10px;
      font-size: 10px;
    }

    .header.user-mode-header {
      flex-direction: column;
      align-items: stretch;
    }

    .account-open-sections {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 760px) {
    .entity-panel {
      --panel-gutter-x: 8px;
      --space-1: 6px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      max-width: 100%;
      overflow-x: clip;
    }

    .header {
      padding: 8px 10px;
    }

    .header.user-mode-header {
      padding: 8px var(--panel-gutter-x);
      gap: 8px;
    }

    .hero {
      padding: 12px var(--panel-gutter-x);
      gap: 10px;
    }

    .hero-left {
      gap: 10px;
      align-items: flex-start;
    }

    .hero-avatar,
    .hero-avatar.placeholder {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      font-size: 12px;
    }

    .hero-identity {
      gap: 5px;
    }

    .hero-context-switcher {
      max-width: 100%;
      width: 100%;
    }

    .hero-name {
      font-size: 14px;
      line-height: 1.15;
      overflow-wrap: anywhere;
    }

    .hero-networth {
      font-size: 24px;
    }

    .hero-label {
      margin-top: 2px;
    }

    .tabs {
      padding: 4px var(--panel-gutter-x) 0;
      gap: 4px;
      flex-wrap: nowrap;
      overflow: visible;
      border-bottom: none;
      box-sizing: border-box;
    }

    .tab {
      flex: 1 1 0;
      justify-content: center;
      min-width: 0;
      min-height: 34px;
      padding: 7px 9px;
      font-size: 9.5px;
      border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 40%, transparent);
      border-radius: 11px;
      background: color-mix(in srgb, var(--theme-surface, var(--theme-card-bg, #18181b)) 66%, transparent);
      box-shadow: none;
    }

    .badge {
      font-size: 8px;
      padding: 2px 5px;
    }

    .content {
      padding: 12px var(--panel-gutter-x);
      max-width: 100%;
      overflow-x: clip;
    }

    .header,
    .hero,
    .tabs,
    .content,
    .content > *,
    .asset-ledger-meta,
    .wallet-meta-block,
    .accounts-selector-row,
    .asset-action-card,
    .account-workspace-content,
    .workspace-pending-banner,
    .workspace-pending-copy,
    .workspace-pending-list,
    .workspace-pending-actions,
    .workspace-pending-chip,
    .asset-ledger-table,
    .asset-ledger-row {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    .tab-header-row,
    .workspace-pending-banner,
    .workspace-debt-warning,
    .faucet-inline-card {
      flex-direction: column;
      align-items: stretch;
    }

    .header-actions,
    .workspace-pending-actions,
    .workspace-debt-warning-copy {
      width: 100%;
      justify-content: flex-start;
    }

    .workspace-pending-chip {
      min-width: 0;
      width: 100%;
    }

    .btn-refresh-small {
      width: 100%;
      min-height: 38px;
    }

    .faucet-inline-row {
      gap: 8px;
    }

    .faucet-inline-token {
      min-width: 0;
      max-width: none;
      flex: 1 1 120px;
    }

    .wallet-meta-copy {
      width: 100%;
      justify-content: space-between;
      align-items: flex-start;
    }

    .wallet-meta-value {
      font-size: 11px;
      max-width: calc(100% - 24px);
    }

    .token-table-header.asset-ledger-header {
      display: none;
    }

    .asset-ledger-table {
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow: visible;
      background: transparent;
      align-self: stretch;
    }

    .asset-ledger-row {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      padding: 12px;
      border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 72%, transparent);
      border-radius: 14px;
      background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent);
      overflow: hidden;
    }

    .asset-ledger-row:last-child {
      border-radius: 14px;
    }

    .asset-ledger-row .col-token {
      grid-column: 1 / -1;
      padding-bottom: 2px;
    }

    .asset-ledger-row .asset-balance-block {
      align-items: flex-start;
      text-align: left;
      min-width: 0;
      width: 100%;
      padding: 8px 10px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--theme-input-bg, #09090b) 62%, transparent);
      box-sizing: border-box;
    }

    .asset-ledger-row .asset-balance-block::before {
      display: block;
      margin-bottom: 4px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--theme-text-muted, #71717a);
    }

    .asset-ledger-row .asset-balance-block:nth-child(2)::before {
      content: 'External';
    }

    .asset-ledger-row .asset-balance-block:nth-child(3)::before {
      content: 'Reserve';
    }

    .asset-ledger-row .asset-balance-block:nth-child(4)::before {
      content: 'Accounts';
    }

    .asset-ledger-row .balance-text {
      font-size: 15px;
      line-height: 1.15;
    }

    .asset-ledger-row .value-text {
      font-size: 10px;
      line-height: 1.2;
    }

    .account-open-sections {
      gap: 8px;
    }

    .open-section,
    .disputed-section {
      padding: 12px;
    }

    .open-section-head,
    .open-section-head.compact {
      margin-bottom: 10px;
      gap: 4px;
    }

    .open-section-copy {
      gap: 6px;
    }

    .open-section-kicker {
      font-size: 8.5px;
    }

    .open-section-note {
      font-size: 10.5px;
    }
  }

  @media (max-width: 460px) {
    .asset-ledger-row {
      grid-template-columns: 1fr;
    }

    .asset-ledger-row .asset-balance-block {
      width: 100%;
    }

    .tab {
      min-height: 32px;
      padding: 6px 8px;
    }

    .hero-networth {
      font-size: 20px;
    }
  }
</style>
