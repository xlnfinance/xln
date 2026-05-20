import { writable, derived, get } from 'svelte/store';
import { errorLog } from './errorLogStore';
import { settings } from './settingsStore';
import { activeRuntimeId, runtimes, runtimeOperations } from './runtimeStore';
import { toasts } from './toastStore';
import { resetEverything } from '$lib/utils/resetEverything';
import { normalizeWsUrl, sameWsEndpoint } from '$lib/utils/wsUrl';
import { createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
import type {
  XLNModule,
  Env,
  EnvSnapshot,
  EntityId,
  ReplicaKey,
  RoutedEntityInput,
  RuntimeInput,
  RuntimeAdapter,
  RuntimeAdapterConfig,
  RuntimeAdapterStatus,
  RuntimeAdapterViewFrame,
  AccountMachine,
  BookState,
  EntityDisplayInfo,
  EntityReplica,
  EntityState,
  SignerDisplayInfo,
  BigIntMathUtils,
  FinancialConstants,
  SwapBookEntry,
} from '@xln/runtime/xln-api';
import type { StorageAccountDoc, StorageEntityCoreDoc } from '@xln/runtime/storage/types';

// Direct import of XLN runtime module (no wrapper boilerplate needed)
let XLN: XLNModule | null = null;
let xlnLoadPromise: Promise<XLNModule> | null = null;
export const xlnInstance = writable<XLNModule | null>(null);
let unregisterEnvChange: (() => void) | null = null;
let unregisterRuntimeAdapterChange: (() => void) | null = null;
let remoteAdapterRefreshPromise: Promise<Env | null> | null = null;
let activeRuntimeAdapterConfig: RuntimeAdapterConfig | null = null;
const RESET_NOTICE_STORAGE_KEY = 'xln-reset-notice';
const DEFAULT_REMOTE_ADAPTER_PATH = '/rpc';
const REMOTE_VIEW_PAGE_SIZE = 10;

type FrontendEntitySummary = {
  id: string;
  shortId: string;
  display: string;
  avatar: string;
  info: EntityDisplayInfo;
};

export interface FrontendXlnFunctions {
  deriveDelta: XLNModule['deriveDelta'];
  formatTokenAmount: (tokenId: number, amount: bigint | null | undefined) => string;
  getTokenInfo: XLNModule['getTokenInfo'];
  isLiquidSwapToken: XLNModule['isLiquidSwapToken'];
  getSwapPairOrientation: XLNModule['getSwapPairOrientation'];
  getDefaultSwapTradingPairs: XLNModule['getDefaultSwapTradingPairs'];
  listOpenSwapOffers: XLNModule['listOpenSwapOffers'];
  computeSwapPriceTicks: XLNModule['computeSwapPriceTicks'];
  prepareSwapOrder: XLNModule['prepareSwapOrder'];
  quantizeSwapOrder: XLNModule['quantizeSwapOrder'];
  isLeft: XLNModule['isLeft'];
  createDemoDelta: XLNModule['createDemoDelta'];
  getDefaultCreditLimit: XLNModule['getDefaultCreditLimit'];
  safeStringify: XLNModule['safeStringify'];
  formatTokenAmountEthers: XLNModule['formatTokenAmountEthers'];
  parseTokenAmount: XLNModule['parseTokenAmount'];
  convertTokenPrecision: XLNModule['convertTokenPrecision'];
  calculatePercentageEthers: XLNModule['calculatePercentageEthers'];
  formatAssetAmountEthers: XLNModule['formatAssetAmountEthers'];
  BigIntMath: BigIntMathUtils;
  FINANCIAL_CONSTANTS: FinancialConstants;
  getEntity: (entityId: string) => FrontendEntitySummary;
  getEntityShortId: XLNModule['getEntityShortId'];
  formatEntityId: XLNModule['formatEntityId'];
  formatEntityDisplay: XLNModule['formatEntityDisplay'];
  formatShortEntityId: XLNModule['formatShortEntityId'];
  hashToAvatar: XLNModule['hashToAvatar'];
  generateEntityAvatar: XLNModule['generateEntityAvatar'];
  generateSignerAvatar: XLNModule['generateSignerAvatar'];
  getEntityDisplayInfo: XLNModule['getEntityDisplayInfo'];
  getSignerDisplayInfo: XLNModule['getSignerDisplayInfo'];
  extractEntityId: XLNModule['extractEntityId'];
  extractSignerId: XLNModule['extractSignerId'];
  parseReplicaKey: XLNModule['parseReplicaKey'];
  formatReplicaKey: XLNModule['formatReplicaKey'];
  createReplicaKey: XLNModule['createReplicaKey'];
  classifyBilateralState: XLNModule['classifyBilateralState'];
  getAccountBarVisual: XLNModule['getAccountBarVisual'];
  sendEntityInput: XLNModule['sendEntityInput'];
  resolveEntityProposerId: XLNModule['resolveEntityProposerId'];
  ensureGossipProfiles?: XLNModule['ensureGossipProfiles'];
  isReady: boolean;
}

async function getXLN(): Promise<XLNModule> {
  if (XLN) return XLN;
  if (xlnLoadPromise) return xlnLoadPromise;

  xlnLoadPromise = (async () => {
    // Always cache-bust runtime module per page load; stale runtime.js caused prod-debug desync.
    const runtimeUrl = new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href;
    const loaded = (await import(/* @vite-ignore */ runtimeUrl)) as XLNModule;
    const runtimeMeta = loaded as XLNModule & { RUNTIME_SCHEMA_VERSION?: number };
    const loadedSchema = Number(runtimeMeta.RUNTIME_SCHEMA_VERSION ?? NaN);
    if (!Number.isFinite(loadedSchema) || loadedSchema < 1) {
      throw new Error(
        `RUNTIME_VERSION_MISMATCH: invalid runtime schema=${String(runtimeMeta.RUNTIME_SCHEMA_VERSION ?? 'undefined')}`,
      );
    }
    XLN = loaded;
    xlnInstance.set(XLN);
    if (typeof window !== 'undefined') {
      window.__xln_instance = XLN;
    }
    return XLN;
  })();

  try {
    return await xlnLoadPromise;
  } catch (err) {
    xlnLoadPromise = null;
    throw err;
  }
}

export function isFinancialRestoreFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('FINANCIAL-SAFETY VIOLATION')
    || message.includes('FinancialDataCorruptionError')
    || message.includes('TypeSafetyViolationError')
    || message.includes('loadEnvFromDB failed');
}

function showPendingResetNotice(): void {
  if (typeof window === 'undefined') return;
  let notice = '';
  try {
    notice = sessionStorage.getItem(RESET_NOTICE_STORAGE_KEY) || '';
  } catch {
    notice = '';
  }
  if (!notice) return;
  try {
    sessionStorage.removeItem(RESET_NOTICE_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
  toasts.warning(notice, 8000);
}

// Bootstrap env (used before runtime selection or when no runtime env exists)
const bootstrapEnvironment = writable<Env | null>(null);

// Active env is derived from selected runtime in dropdown, with bootstrap fallback.
export const xlnEnvironment = derived(
  [bootstrapEnvironment, runtimes, activeRuntimeId],
  ([$bootstrapEnvironment, $runtimes, $activeRuntimeId]) => {
    const selectedRuntimeId = String($activeRuntimeId || '').toLowerCase();
    if (selectedRuntimeId) {
      const runtimeEntry = $runtimes.get(selectedRuntimeId);
      if (runtimeEntry?.env) {
        return runtimeEntry.env;
      }
    }
    return $bootstrapEnvironment;
  },
);

export function setXlnEnvironment(env: Env | null): void {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  const viewEnv = runtimeEnv ? createRuntimeViewEnv(runtimeEnv) : null;
  bootstrapEnvironment.set(viewEnv);
  if (typeof window !== 'undefined') {
    window.__xln_env = runtimeEnv;
  }
  if (!runtimeEnv || !viewEnv) return;

  const selectedRuntimeId = String(get(activeRuntimeId) || '').toLowerCase();
  const envRuntimeId = String(runtimeEnv.runtimeId || '').toLowerCase();
  const targetRuntimeId = envRuntimeId || selectedRuntimeId;
  if (!targetRuntimeId) return;

  runtimes.update((map) => {
    const runtimeEntry = map.get(targetRuntimeId);
    if (!runtimeEntry) return map;
    const updated = new Map(map);
    updated.set(targetRuntimeId, {
      ...runtimeEntry,
      env: viewEnv,
      lastSynced: Date.now(),
    });
    return updated;
  });
}

export const isLoading = writable<boolean>(true);
export const error = writable<string | null>(null);
export const appRuntimeAdapterMode = writable<RuntimeAdapterConfig['mode']>('embedded');
export const appRuntimeAdapterStatus = writable<RuntimeAdapterStatus>('disconnected');
export const appRuntimeAdapterEndpoint = writable<string>('');
export const appRuntimeAdapterActiveEntityId = writable<string>('');
export const appRuntimeAdapterAccountsPage = writable<number>(0);
export const appRuntimeAdapterBooksPage = writable<number>(0);
export const appRuntimeAdapterPageInfo = writable<{
  entityId: string;
  accountsShown: number;
  accountsTotal: number;
  accountsPageIndex: number;
  accountsPageCount: number;
  accountsPrevCursor: string | null;
  accountsNextCursor: string | null;
  accountsHasMore: boolean;
  booksShown: number;
  booksTotal: number;
  booksPageIndex: number;
  booksPageCount: number;
  booksPrevCursor: string | null;
  booksNextCursor: string | null;
  booksHasMore: boolean;
} | null>(null);

export const setRuntimeAdapterActiveEntityId = (entityId: string): void => {
  appRuntimeAdapterActiveEntityId.set(normalizeEntityIdForView(entityId));
  appRuntimeAdapterAccountsPage.set(0);
  appRuntimeAdapterBooksPage.set(0);
};

export const setRuntimeAdapterPage = (kind: 'accounts' | 'books', pageIndex: number): void => {
  const safePage = Math.max(0, Math.floor(Number(pageIndex) || 0));
  if (kind === 'accounts') appRuntimeAdapterAccountsPage.set(safePage);
  else appRuntimeAdapterBooksPage.set(safePage);
};

// xlnFunctions is now defined at the end of the file

export function resolveRelayUrls(): string[] {
  if (typeof window === 'undefined') return ['wss://xln.finance/relay'];
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const relay = normalizeWsUrl(`${protocol}//${window.location.host}/relay`);
  const configured = get(settings)?.relayUrl;
  if (configured && !sameWsEndpoint(configured, relay)) {
    console.error(`[relay] SETTINGS_MISMATCH: forcing single relay ${relay}, ignoring ${configured}`);
  }
  return [relay];
}

// Derived stores for convenience
export const replicas = derived(xlnEnvironment, $env => ($env ? $env.eReplicas : new Map()));

// P2P connection state (polled from runtime)
export type P2PState = {
  connected: boolean;
  reconnect: { attempt: number; nextAt: number } | null;
  queue: { targetCount: number; totalMessages: number; oldestEntryAge: number; perTarget: Record<string, number> };
};
export const p2pState = writable<P2PState>({
  connected: false,
  reconnect: null,
  queue: { targetCount: 0, totalMessages: 0, oldestEntryAge: 0, perTarget: {} },
});

let p2pPollTimer: ReturnType<typeof setInterval> | null = null;

const areP2PQueuesEqual = (
  left: P2PState['queue'],
  right: P2PState['queue'],
): boolean => {
  if (
    left.targetCount !== right.targetCount ||
    left.totalMessages !== right.totalMessages ||
    left.oldestEntryAge !== right.oldestEntryAge
  ) {
    return false;
  }
  const leftKeys = Object.keys(left.perTarget);
  const rightKeys = Object.keys(right.perTarget);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left.perTarget[key] !== right.perTarget[key]) return false;
  }
  return true;
};

const areP2PStatesEqual = (left: P2PState, right: P2PState): boolean => {
  const reconnectEqual =
    left.reconnect === right.reconnect ||
    (
      left.reconnect !== null &&
      right.reconnect !== null &&
      left.reconnect.attempt === right.reconnect.attempt &&
      left.reconnect.nextAt === right.reconnect.nextAt
    );
  return left.connected === right.connected && reconnectEqual && areP2PQueuesEqual(left.queue, right.queue);
};

function startP2PPoll() {
  if (p2pPollTimer) return;
  const poll = () => {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
    if (!XLN) return;
    const env = get(xlnEnvironment);
    if (!env) return;
    try {
      const state = XLN.getP2PState(env);
      if (state) {
        const previous = get(p2pState);
        if (!areP2PStatesEqual(previous, state)) {
          p2pState.set(state);
        }
      }
    } catch {
      /* ignore if not available */
    }
    if (typeof window !== 'undefined' && typeof performance !== 'undefined') {
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= 32) {
        console.warn(`[perf] slow timer xlnStore.p2pStatePoll ${elapsedMs.toFixed(1)}ms`);
      }
    }
  };
  poll();
  p2pPollTimer = setInterval(poll, 1000);
}

function stopP2PPoll() {
  if (p2pPollTimer) {
    clearInterval(p2pPollTimer);
    p2pPollTimer = null;
  }
}

export async function suspendClientActivity(): Promise<void> {
  stopP2PPoll();
  unregisterRuntimeAdapterChange?.();
  unregisterRuntimeAdapterChange = null;
  const { disconnectRuntimeAdapter } = await import('./runtimeAdapterStore');
  disconnectRuntimeAdapter();
}

// Direct stores for immediate updates (no derived timing races)
export const history = writable<EnvSnapshot[]>([]);
export const currentHeight = writable<number>(0);

// Entity positions store - persists across time-travel (positions are static per entity)
// Stores RELATIVE positions + jurisdiction reference for proper multi-jurisdiction support
// Frontend computes: worldPos = jMachine.position + relativePosition
export interface RelativeEntityPosition {
  x: number; // Relative X offset from j-machine center
  y: number; // Relative Y offset from j-machine center
  z: number; // Relative Z offset from j-machine center
  jurisdiction: string; // Which j-machine this entity belongs to
}
export const entityPositions = writable<Map<string, RelativeEntityPosition>>(new Map());

// Track if XLN is already initialized to prevent data loss
let isInitialized = false;

export const resolveConfiguredApiBase = (baseOrigin: string): string => {
  if (typeof window === 'undefined') return baseOrigin;
  const fromWindow = (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__;
  if (typeof fromWindow === 'string' && fromWindow.trim().length > 0) return fromWindow.trim();
  return baseOrigin;
};

const normalizeEntityIdForView = (value: string): string => String(value || '').trim().toLowerCase();

const readStoredAdapterValue = (key: string): string => {
  if (typeof window === 'undefined') return '';
  try {
    if (key === 'xln-runtime-adapter-key') {
      localStorage.removeItem(key);
      return sessionStorage.getItem(key)?.trim() || '';
    }
    const sessionValue = sessionStorage.getItem(key)?.trim();
    if (sessionValue) return sessionValue;
    return localStorage.getItem(key)?.trim() || '';
  } catch {
    return '';
  }
};

const defaultRemoteAdapterWsUrl = (): string => {
  if (typeof window === 'undefined') return `ws://127.0.0.1:8080${DEFAULT_REMOTE_ADAPTER_PATH}`;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${DEFAULT_REMOTE_ADAPTER_PATH}`;
};

const resolveAppRuntimeAdapterConfig = (): RuntimeAdapterConfig => {
  if (typeof window === 'undefined') return { mode: 'embedded' };
  const params = new URLSearchParams(window.location.search);
  const rawMode = (
    params.get('runtime') ||
    params.get('adapter') ||
    readStoredAdapterValue('xln-runtime-adapter-mode') ||
    ''
  ).trim().toLowerCase();
  const remoteRequested = rawMode === 'remote' || rawMode === 'ws' || params.has('ws') || params.has('runtimeWs');
  if (!remoteRequested) {
    appRuntimeAdapterMode.set('embedded');
    appRuntimeAdapterEndpoint.set('embedded');
    appRuntimeAdapterPageInfo.set(null);
    return { mode: 'embedded' };
  }

  const wsUrl = (
    params.get('ws') ||
    params.get('runtimeWs') ||
    readStoredAdapterValue('xln-runtime-adapter-ws') ||
    defaultRemoteAdapterWsUrl()
  ).trim();
  const normalizedWsUrl = normalizeWsUrl(wsUrl);
  const authKey = (
    readStoredAdapterValue('xln-runtime-adapter-key') ||
    ''
  ).trim();

  appRuntimeAdapterMode.set('remote');
  appRuntimeAdapterEndpoint.set(normalizedWsUrl);
  return {
    mode: 'remote',
    wsUrl: normalizedWsUrl,
    ...(authKey ? { authKey } : {}),
  };
};

const accountCounterpartyId = (entityId: string, doc: StorageAccountDoc): string => {
  const normalizedEntityId = normalizeEntityIdForView(entityId);
  const left = normalizeEntityIdForView(doc.leftEntity);
  const right = normalizeEntityIdForView(doc.rightEntity);
  return left === normalizedEntityId ? right : left;
};

const withDefinedProp = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

type RemoteJurisdictionSummary = {
  name?: string;
  address?: string;
  chainId?: number | string;
  depositoryAddress?: string;
  entityProviderAddress?: string;
};

const buildRemotePlaceholderCore = (
  entityId: string,
  label: string,
  height: number,
  isHub = false,
  jurisdiction?: RemoteJurisdictionSummary,
): StorageEntityCoreDoc => {
  const signerId = normalizeEntityIdForView(entityId);
  const chainId = Number(jurisdiction?.chainId);
  const configJurisdiction = jurisdiction?.name && jurisdiction.depositoryAddress && jurisdiction.entityProviderAddress
    ? {
        name: jurisdiction.name,
        address: jurisdiction.address || 'remote://runtime-adapter',
        entityProviderAddress: jurisdiction.entityProviderAddress,
        depositoryAddress: jurisdiction.depositoryAddress,
        ...(Number.isFinite(chainId) ? { chainId } : {}),
      }
    : undefined;
  return {
    entityId,
    signerId,
    isProposer: false,
    height,
    timestamp: Date.now(),
    messages: [],
    nonces: new Map(),
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [signerId],
      shares: { [signerId]: 1n },
      ...(configJurisdiction ? { jurisdiction: configJurisdiction } : {}),
    },
    reserves: new Map(),
    lastFinalizedJHeight: 0,
    jBlockObservations: [],
    jBlockChain: [],
    entityEncPubKey: '',
    entityEncPrivKey: '',
    profile: { name: label, isHub, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
  };
};

const addRemoteReplicaFromCore = (
  xln: XLNModule,
  env: Env,
  core: StorageEntityCoreDoc,
  accounts: Map<string, StorageAccountDoc>,
  books: Map<string, BookState>,
): void => {
  const entityId = normalizeEntityIdForView(core.entityId);
  const state = hydrateRemoteEntityState({ core: { ...core, entityId }, accounts, books });
  const signerId = normalizeEntityIdForView(core.signerId || entityId);
  const replica: EntityReplica = {
    entityId,
    signerId,
    isProposer: core.isProposer ?? true,
    state,
    hankoWitness: new Map(),
  } as EntityReplica;
  env.eReplicas.set(xln.formatReplicaKey(xln.createReplicaKey(entityId, signerId)), replica);
};

const hydrateRemoteAccountDoc = (doc: StorageAccountDoc): AccountMachine => ({
  leftEntity: doc.leftEntity,
  rightEntity: doc.rightEntity,
  status: doc.status,
  mempool: doc.mempool,
  currentFrame: doc.currentFrame,
  deltas: doc.deltas,
  locks: doc.locks,
  swapOffers: doc.swapOffers,
  globalCreditLimits: doc.globalCreditLimits,
  currentHeight: doc.currentHeight,
  pendingSignatures: doc.pendingSignatures,
  rollbackCount: doc.rollbackCount,
  leftJObservations: doc.leftJObservations ?? [],
  rightJObservations: doc.rightJObservations ?? [],
  jEventChain: doc.jEventChain ?? [],
  lastFinalizedJHeight: doc.lastFinalizedJHeight,
  proofHeader: doc.proofHeader,
  proofBody: doc.proofBody,
  disputeConfig: doc.disputeConfig,
  onChainSettlementNonce: doc.onChainSettlementNonce,
  pendingWithdrawals: doc.pendingWithdrawals ?? new Map(),
  requestedRebalance: doc.requestedRebalance ?? new Map(),
  requestedRebalanceFeeState: doc.requestedRebalanceFeeState ?? new Map(),
  rebalancePolicy: doc.rebalancePolicy ?? new Map(),
  swapOrderHistory: doc.swapOrderHistory ?? new Map(),
  swapClosedOrders: doc.swapClosedOrders ?? new Map(),
  ...withDefinedProp('pendingFrame', doc.pendingFrame),
  ...withDefinedProp('pendingAccountInput', doc.pendingAccountInput),
  ...withDefinedProp('lastOutboundFrameAck', doc.lastOutboundFrameAck),
  ...withDefinedProp('lastRollbackFrameHash', doc.lastRollbackFrameHash),
  ...withDefinedProp('abiProofBody', doc.abiProofBody),
  ...withDefinedProp('currentFrameHanko', doc.currentFrameHanko),
  ...withDefinedProp('counterpartyFrameHanko', doc.counterpartyFrameHanko),
  ...withDefinedProp('currentDisputeProofHanko', doc.currentDisputeProofHanko),
  ...withDefinedProp('currentDisputeProofNonce', doc.currentDisputeProofNonce),
  ...withDefinedProp('currentDisputeProofBodyHash', doc.currentDisputeProofBodyHash),
  ...withDefinedProp('currentDisputeHash', doc.currentDisputeHash),
  ...withDefinedProp('counterpartyDisputeProofHanko', doc.counterpartyDisputeProofHanko),
  ...withDefinedProp('counterpartyDisputeProofNonce', doc.counterpartyDisputeProofNonce),
  ...withDefinedProp('counterpartyDisputeProofBodyHash', doc.counterpartyDisputeProofBodyHash),
  ...withDefinedProp('counterpartyDisputeHash', doc.counterpartyDisputeHash),
  ...withDefinedProp('counterpartySettlementHanko', doc.counterpartySettlementHanko),
  ...withDefinedProp('disputeProofNoncesByHash', doc.disputeProofNoncesByHash),
  ...withDefinedProp('disputeProofBodiesByHash', doc.disputeProofBodiesByHash),
  ...withDefinedProp('settlementWorkspace', doc.settlementWorkspace),
  ...withDefinedProp('activeDispute', doc.activeDispute),
  ...withDefinedProp('counterpartyRebalanceFeePolicy', doc.counterpartyRebalanceFeePolicy),
  ...withDefinedProp('activeRebalanceQuote', doc.activeRebalanceQuote),
  ...withDefinedProp('pendingRebalanceRequest', doc.pendingRebalanceRequest),
});

const hydrateRemoteEntityState = (options: {
  core: StorageEntityCoreDoc;
  accounts: Map<string, StorageAccountDoc>;
  books: Map<string, BookState>;
}): EntityState => {
  const { core, accounts, books } = options;
  const orderbookExt = books.size > 0 || core.orderbookHubProfile || core.orderbookReferrals
    ? {
        books,
        orderPairs: new Map(),
        referrals: core.orderbookReferrals ?? new Map(),
        hubProfile: core.orderbookHubProfile ?? {
          entityId: core.entityId,
          name: core.profile.name || core.entityId.slice(-8),
          spreadDistribution: { makerBps: 0, takerBps: 10000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
          referenceTokenId: 1,
          minTradeSize: 0n,
          supportedPairs: [],
        },
      }
    : undefined;

  return {
    entityId: core.entityId,
    height: core.height,
    timestamp: core.timestamp,
    nonces: core.nonces ?? new Map(),
    messages: core.messages ?? [],
    proposals: core.proposals ?? new Map(),
    config: core.config,
    reserves: core.reserves ?? new Map(),
    accounts: new Map(Array.from(accounts.entries()).map(([key, value]) => [key, hydrateRemoteAccountDoc(value)])),
    lastFinalizedJHeight: core.lastFinalizedJHeight,
    jBlockObservations: core.jBlockObservations ?? [],
    jBlockChain: core.jBlockChain ?? [],
    entityEncPubKey: core.entityEncPubKey,
    entityEncPrivKey: core.entityEncPrivKey,
    profile: core.profile,
    htlcRoutes: core.htlcRoutes ?? new Map(),
    htlcFeesEarned: core.htlcFeesEarned,
    lockBook: core.lockBook ?? new Map(),
    ...withDefinedProp('prevFrameHash', core.prevFrameHash),
    ...withDefinedProp('deferredAccountProposals', core.deferredAccountProposals),
    ...withDefinedProp('accountInputQueue', core.accountInputQueue),
    ...withDefinedProp('crontabState', core.crontabState),
    ...withDefinedProp('batchHistory', core.batchHistory),
    ...withDefinedProp('jBatchState', core.jBatchState),
    ...withDefinedProp('htlcNotes', core.htlcNotes),
    ...withDefinedProp('outDebtsByToken', core.outDebtsByToken),
    ...withDefinedProp('inDebtsByToken', core.inDebtsByToken),
    ...withDefinedProp('orderbookExt', orderbookExt),
    ...withDefinedProp('swapTradingPairs', core.swapTradingPairs),
    ...withDefinedProp('pendingSwapFillRatios', core.pendingSwapFillRatios),
    ...withDefinedProp('hubRebalanceConfig', core.hubRebalanceConfig),
  };
};

const upsertRuntimeSnapshot = (
  env: Env,
  config: RuntimeAdapterConfig,
  status: RuntimeAdapterStatus,
): void => {
  const runtimeId = String(env.runtimeId || '').toLowerCase();
  if (!runtimeId) return;
  const viewEnv = createRuntimeViewEnv(unwrapLiveRuntimeEnv(env) ?? env);
  runtimes.update((map) => {
    const updated = new Map(map);
    updated.set(runtimeId, {
      id: runtimeId,
      type: config.mode === 'remote' ? 'remote' : 'local',
      label: config.mode === 'remote' ? `Remote ${config.wsUrl || 'runtime'}` : 'Embedded runtime',
      env: viewEnv,
      ...(config.seed ? { seed: config.seed } : {}),
      ...(config.authKey ? { apiKey: config.authKey } : {}),
      permissions: config.mode === 'remote' && !config.authKey ? 'read' : 'write',
      status: status === 'connected' ? 'connected' : status === 'connecting' ? 'syncing' : status,
      lastSynced: Date.now(),
    });
    return updated;
  });
  activeRuntimeId.set(runtimeId);
};

const buildRemoteAdapterEnvSnapshot = async (
  xln: XLNModule,
  adapter: RuntimeAdapter,
  config: RuntimeAdapterConfig,
): Promise<Env> => {
  const pinnedHeight = Math.max(0, Math.floor(Number(adapter.currentHeight || 0)));
  const requestedEntityId = normalizeEntityIdForView(get(appRuntimeAdapterActiveEntityId));
  const viewFrame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', {
    limit: REMOTE_VIEW_PAGE_SIZE,
    accountsLimit: REMOTE_VIEW_PAGE_SIZE,
    booksLimit: REMOTE_VIEW_PAGE_SIZE,
    accountsPage: get(appRuntimeAdapterAccountsPage),
    booksPage: get(appRuntimeAdapterBooksPage),
    ...(pinnedHeight > 0 ? { atHeight: pinnedHeight } : {}),
    ...(requestedEntityId ? { entityId: requestedEntityId } : {}),
  });
  const atHeight = Math.max(0, Math.floor(Number(viewFrame.height ?? viewFrame.head.latestHeight ?? adapter.currentHeight ?? 0)));
  const env = xln.createEmptyEnv(config.seed ?? null);
  env.runtimeId = `radapter:${config.wsUrl || 'remote'}`;
  env.height = atHeight;
  env.timestamp = Date.now();
  env.history = [];
  env.eReplicas = new Map();
  env.quietRuntimeLogs = true;

  const active = viewFrame.activeEntity;
  const activeEntityId = active
    ? normalizeEntityIdForView(active.core.entityId || active.summary.entityId)
    : '';
  if (!active) appRuntimeAdapterPageInfo.set(null);

  for (const summary of viewFrame.entities || []) {
    const entityId = normalizeEntityIdForView(summary.entityId);
    if (!entityId) continue;
    if (activeEntityId && entityId === activeEntityId) continue;
    const core = buildRemotePlaceholderCore(
      entityId,
      summary.label || entityId,
      Math.max(0, Math.floor(Number(summary.height ?? atHeight))),
      summary.isHub === true,
      summary.jurisdiction,
    );
    addRemoteReplicaFromCore(xln, env, core, new Map(), new Map());
  }

  if (active) {
    const entityId = activeEntityId;
    appRuntimeAdapterActiveEntityId.set(entityId);
    appRuntimeAdapterPageInfo.set({
      entityId,
      accountsShown: active.accounts.items.length,
      accountsTotal: active.accounts.totalItems ?? active.accounts.items.length,
      accountsPageIndex: active.accounts.pageIndex ?? 0,
      accountsPageCount: active.accounts.pageCount ?? 1,
      accountsPrevCursor: active.accounts.prevCursor ?? null,
      accountsNextCursor: active.accounts.nextCursor ?? null,
      accountsHasMore: !!active.accounts.nextCursor,
      booksShown: active.books.items.length,
      booksTotal: active.books.totalItems ?? active.books.items.length,
      booksPageIndex: active.books.pageIndex ?? 0,
      booksPageCount: active.books.pageCount ?? 1,
      booksPrevCursor: active.books.prevCursor ?? null,
      booksNextCursor: active.books.nextCursor ?? null,
      booksHasMore: !!active.books.nextCursor,
    });
    const accounts = new Map<string, StorageAccountDoc>();
    for (const doc of active.accounts.items) {
      accounts.set(accountCounterpartyId(entityId, doc), doc);
    }
    const books = new Map<string, BookState>();
    for (const item of active.books.items) {
      books.set(String(item.pairId), item.book);
    }
    const activeIsHub = active.summary?.isHub === true ||
      active.core.profile?.isHub === true ||
      Boolean(active.core.orderbookHubProfile);
    addRemoteReplicaFromCore(
      xln,
      env,
      {
        ...active.core,
        entityId,
        profile: {
          ...active.core.profile,
          isHub: activeIsHub,
        },
      },
      accounts,
      books,
    );
  }

  return env;
};

const buildRemoteAdapterPlaceholderEnv = (
  xln: XLNModule,
  config: RuntimeAdapterConfig,
): Env => {
  const env = xln.createEmptyEnv(config.seed ?? null);
  env.runtimeId = `radapter:${config.wsUrl || 'remote'}`;
  env.height = 0;
  env.timestamp = Date.now();
  env.history = [];
  env.eReplicas = new Map();
  env.quietRuntimeLogs = true;
  appRuntimeAdapterPageInfo.set(null);
  return env;
};

export const refreshRuntimeAdapterEnvironment = async (): Promise<Env | null> => {
  if (activeRuntimeAdapterConfig?.mode !== 'remote') return get(xlnEnvironment);
  if (remoteAdapterRefreshPromise) return remoteAdapterRefreshPromise;
  remoteAdapterRefreshPromise = (async () => {
    const xln = await getXLN();
    const { runtimeAdapter } = await import('./runtimeAdapterStore');
    const adapter = get(runtimeAdapter);
    if (!adapter || adapter.mode !== 'remote') return get(xlnEnvironment);
    const env = await buildRemoteAdapterEnvSnapshot(xln, adapter, activeRuntimeAdapterConfig);
    setXlnEnvironment(env);
    history.set(env.history || []);
    currentHeight.set(env.height);
    upsertRuntimeSnapshot(env, activeRuntimeAdapterConfig, adapter.status);
    appRuntimeAdapterStatus.set(adapter.status);
    return env;
  })();
  try {
    return await remoteAdapterRefreshPromise;
  } finally {
    remoteAdapterRefreshPromise = null;
  }
};

// Helper functions for common patterns (not wrappers)
export async function initializeXLN(): Promise<Env> {
  showPendingResetNotice();
  // CRITICAL: Don't re-initialize if we already have data
  if (isInitialized) {
    const currentEnv = get(xlnEnvironment);
    if (currentEnv && currentEnv.eReplicas.size > 0) {
      error.set(null);
      isLoading.set(false);
      return currentEnv;
    }
  }

  try {
    isLoading.set(true);
    error.set(null);

    const xln = await getXLN();

    // Store XLN instance separately for function access
    xlnInstance.set(xln);

    const adapterConfig = resolveAppRuntimeAdapterConfig();
    activeRuntimeAdapterConfig = adapterConfig;
    if (adapterConfig.mode === 'remote') {
      const { connectRuntimeAdapter } = await import('./runtimeAdapterStore');
      const adapter = await connectRuntimeAdapter(adapterConfig);
      unregisterEnvChange?.();
      unregisterEnvChange = null;
      unregisterRuntimeAdapterChange?.();
      unregisterRuntimeAdapterChange = adapter.onChange(() => {
        void refreshRuntimeAdapterEnvironment().catch((refreshError) => {
          const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
          error.set(message);
          errorLog.log(message, 'Runtime Adapter Refresh', refreshError);
        });
      });
      adapter.onStatus((status) => {
        appRuntimeAdapterStatus.set(status);
        const currentEnv = get(xlnEnvironment);
        if (currentEnv && activeRuntimeAdapterConfig) {
          upsertRuntimeSnapshot(currentEnv, activeRuntimeAdapterConfig, status);
        }
        if (status === 'connected') {
          void refreshRuntimeAdapterEnvironment().catch((refreshError) => {
            const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
            error.set(message);
            errorLog.log(message, 'Runtime Adapter Refresh', refreshError);
          });
        }
      });

      let env: Env | null = null;
      try {
        env = await refreshRuntimeAdapterEnvironment();
      } catch (initialRemoteError) {
        env = buildRemoteAdapterPlaceholderEnv(xln, adapterConfig);
        setXlnEnvironment(env);
        history.set(env.history || []);
        currentHeight.set(env.height);
        appRuntimeAdapterStatus.set(adapter.status);
        upsertRuntimeSnapshot(env, adapterConfig, adapter.status);
        const message = initialRemoteError instanceof Error ? initialRemoteError.message : String(initialRemoteError);
        console.warn('[XLN] Remote runtime adapter is not ready yet; will reconnect', message);
      }
      if (!env) env = buildRemoteAdapterPlaceholderEnv(xln, adapterConfig);
      error.set(null);
      isLoading.set(false);
      isInitialized = true;
      stopP2PPoll();
      return env;
    }

    // Shared callback for automatic reactivity (fires on every process())
    const onEnvChange = (env: Env) => {
      const selectedRuntimeId = String(get(activeRuntimeId) || '').toLowerCase();
      const envRuntimeId = String(env.runtimeId || '').toLowerCase();
      if (selectedRuntimeId && selectedRuntimeId !== envRuntimeId) {
        const selected = get(runtimes).get(selectedRuntimeId);
        if (selected?.env) {
          // Keep UI pinned to selected runtime env; ignore unrelated env callbacks.
          return;
        }
      }

      setXlnEnvironment(env);
      history.set(env.history);
      currentHeight.set(env.height);

      // Sync to runtimeStore (local runtime)
      runtimeOperations.updateLocalEnv(env);

      // Extract and persist entity positions from eReplicas (positions are immutable)
      // Positions are RELATIVE to j-machine - store jReplica reference for world position calculation
      entityPositions.update(currentPositions => {
        let hasChanges = false;
        for (const [replicaKey, replica] of env.eReplicas.entries()) {
          const entityId = xln.extractEntityId(replicaKey); // Uses ids.ts - no split
          if (entityId && replica.position && !currentPositions.has(entityId)) {
            const pos = replica.position;
            // Store relative position + jReplica reference (defaults to activeJurisdiction)
            const jurisdiction = pos.jurisdiction || pos.xlnomy || env.activeJurisdiction || 'default';
            currentPositions.set(entityId, { x: pos.x, y: pos.y, z: pos.z, jurisdiction });
            hasChanges = true;
          }
        }
        return hasChanges ? new Map(currentPositions) : currentPositions;
      });

      // Update window for e2e testing
    };

    // Load from IndexedDB - main() handles DB timeout internally
    let env: Env;
    try {
      env = await xln.main();
    } catch (restoreError) {
      if (!isFinancialRestoreFailure(restoreError) || typeof xln.clearDB !== 'function') {
        throw restoreError;
      }
      console.error('[xlnStore] Financial restore failure; clearing local client storage and reloading', restoreError);
      await resetEverything(restoreError);
      throw restoreError;
    }

    // Register callback for THIS env instance (runtime API is env-scoped)
    if (unregisterEnvChange) {
      unregisterEnvChange();
      unregisterEnvChange = null;
    }
    unregisterEnvChange = xln.registerEnvChangeCallback?.(env, onEnvChange) || null;

    // Set all stores immediately (no derived timing races)
    onEnvChange(env);

    // Extract positions from initial load as well
    // Positions are RELATIVE to j-machine - store jReplica reference for world position calculation
    const initialPositions = new Map<string, RelativeEntityPosition>();
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const entityId = xln.extractEntityId(replicaKey); // Uses ids.ts - no split
      if (entityId && replica.position) {
        const pos = replica.position;
        // Store relative position + jReplica reference (defaults to activeJurisdiction)
        const jurisdiction = pos.jurisdiction || pos.xlnomy || env.activeJurisdiction || 'default';
        initialPositions.set(entityId, { x: pos.x, y: pos.y, z: pos.z, jurisdiction });
      }
    }
    if (initialPositions.size > 0) {
      entityPositions.set(initialPositions);
    }

    try {
      const { connectRuntimeAdapter } = await import('./runtimeAdapterStore');
      const adapter = await connectRuntimeAdapter(adapterConfig);
      appRuntimeAdapterStatus.set(adapter.status);
      appRuntimeAdapterEndpoint.set('embedded');
      adapter.onStatus((status) => appRuntimeAdapterStatus.set(status));
    } catch (adapterError) {
      console.warn('[xlnStore] Embedded runtime adapter failed to connect; local env remains usable', adapterError);
      appRuntimeAdapterStatus.set('error');
    }

    error.set(null);
    isLoading.set(false);

    // P2P is started per-runtime in vaultStore.createRuntime() and initialize()
    // No need to start P2P on xlnStore's env — it's not a runtime env

    isInitialized = true;
    startP2PPoll();
    return env;
  } catch (err) {
    console.error('🚨 XLN initialization failed:', err);

    // Log to persistent error store
    const errorMessage = err instanceof Error ? err.message : 'Critical system failure during initialization';
    errorLog.log(errorMessage, 'XLN Initialization', err);

    error.set(errorMessage);
    isLoading.set(false);

    // Don't mark as initialized on failure
    throw err;
  }
}

// Export XLN for direct component access.
export { getXLN };

// Helper to get current environment
export function getEnv(): Env | null {
  return get(xlnEnvironment);
}

const hasMeaningfulEntityInput = (input: RoutedEntityInput | null | undefined): boolean => Boolean(
  input &&
  (
    (input.entityTxs?.length ?? 0) > 0 ||
    Boolean(input.proposedFrame) ||
    ((input.hashPrecommits as Map<unknown, unknown> | undefined)?.size ?? 0) > 0
  ),
);

const hasMeaningfulRuntimeInputItems = (input: RuntimeInput | null | undefined): boolean => Boolean(
  input &&
  (
    (input.runtimeTxs?.length ?? 0) > 0 ||
    (input.jInputs?.length ?? 0) > 0 ||
    (input.entityInputs ?? []).some(hasMeaningfulEntityInput)
  ),
);

const hasMeaningfulQueuedLocalRuntimeWork = (env: Env): boolean => Boolean(
  hasMeaningfulRuntimeInputItems(env.runtimeMempool) ||
  (env.pendingOutputs ?? []).some(hasMeaningfulEntityInput) ||
  (env.networkInbox ?? []).some(hasMeaningfulEntityInput)
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const drainLocalRuntimeInput = async (xln: XLNModule, env: Env): Promise<void> => {
  const startedAt = Date.now();
  for (let i = 0; i < 80 && hasMeaningfulQueuedLocalRuntimeWork(env); i += 1) {
    const beforeHeight = Number(env.height || 0);
    await xln.process(env, undefined, 0);
    setXlnEnvironment(env);
    if (!hasMeaningfulQueuedLocalRuntimeWork(env)) return;
    if (Number(env.height || 0) === beforeHeight) {
      await sleep(25);
    }
    if (Date.now() - startedAt > 4_000) break;
  }
  if (hasMeaningfulQueuedLocalRuntimeWork(env)) {
    throw new Error('LOCAL_RUNTIME_DRAIN_TIMEOUT: submitted runtime input did not commit within 4s');
  }
};

const routeRuntimeInput = async (xln: XLNModule, env: Env, input: RuntimeInput): Promise<Env> => {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  const { runtimeAdapter } = await import('./runtimeAdapterStore');
  const adapter = get(runtimeAdapter);
  if (adapter?.mode === 'remote') {
    await adapter.send(input);
    return (await refreshRuntimeAdapterEnvironment()) ?? runtimeEnv;
  }
  if (!runtimeEnv.scenarioMode && typeof xln.startRuntimeLoop === 'function') {
    xln.startRuntimeLoop(runtimeEnv);
  }
  xln.enqueueRuntimeInput(runtimeEnv, input);
  await drainLocalRuntimeInput(xln, runtimeEnv);
  setXlnEnvironment(runtimeEnv);
  return runtimeEnv;
};

// Enqueue entity inputs into runtime mempool (processed on next tick)
export async function enqueueEntityInputs(env: Env, inputs: RoutedEntityInput[] = []): Promise<Env> {
  const xln = await getXLN();
  const interesting = inputs
    .map((input) => ({
      entityId: String(input?.entityId || ''),
      signerId: String(input?.signerId || ''),
      txTypes: Array.isArray(input?.entityTxs) ? input.entityTxs.map((tx) => String(tx?.type || '')) : [],
    }))
    .filter((entry) => entry.txTypes.some((type) => type.startsWith('j_') || type.startsWith('dispute')));
  if (interesting.length > 0) {
    console.error(`[xlnStore.enqueueEntityInputs] ${JSON.stringify(interesting)}`);
  }
  const input: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: inputs,
  };
  return routeRuntimeInput(xln, env, input);
}

export async function enqueueAndProcess(env: Env, input: RuntimeInput): Promise<Env> {
  const xln = await getXLN();
  return routeRuntimeInput(xln, env, input);
}

// === FRONTEND UTILITY FUNCTIONS ===
// Derived store that provides utility functions for components
export const xlnFunctions = derived([xlnInstance, settings], ([$xlnInstance, $settings]): FrontendXlnFunctions => {
  const clampPrecision = (value: number): number => Math.max(2, Math.min(18, Math.floor(Number(value) || 2)));
  const settingPrecision = clampPrecision(Number($settings?.tokenPrecision ?? 4));
  const formatRawAmount = (rawAmount: bigint, decimals: number, precisionLimit: number): string => {
    const safeDecimals = Math.max(0, Math.floor(Number(decimals) || 18));
    const negative = rawAmount < 0n;
    const abs = negative ? -rawAmount : rawAmount;
    const divisor = 10n ** BigInt(safeDecimals);
    const whole = abs / divisor;
    const frac = abs % divisor;
    let body = whole.toLocaleString('en-US');
    if (precisionLimit > 0 && frac > 0n) {
      const fullFrac = frac.toString().padStart(safeDecimals, '0');
      const sliced = fullFrac.slice(0, Math.min(safeDecimals, precisionLimit)).replace(/0+$/, '');
      if (sliced.length > 0) body = `${body}.${sliced}`;
    }
    return `${negative ? '-' : ''}${body}`;
  };

  // XLN is full in-memory snapshots - NO LOADING STATE NEEDED

  // Strict mode: if runtime is not ready, expose only fail-fast guards.
  // No mock math, no fake token/entity formatting, no fallback data.
  if (!$xlnInstance) {
    const fail = (fnName: string): never => {
      throw new Error(`XLN_NOT_READY:${fnName}`);
    };
    const failFn = <T extends (...args: unknown[]) => unknown>(fnName: string): T =>
      (((..._args: unknown[]) => fail(fnName)) as unknown as T);

    return {
      deriveDelta: failFn('deriveDelta'),
      formatTokenAmount: failFn('formatTokenAmount'),
      getTokenInfo: failFn('getTokenInfo'),
      isLiquidSwapToken: failFn('isLiquidSwapToken'),
      getSwapPairOrientation: failFn('getSwapPairOrientation'),
      getDefaultSwapTradingPairs: failFn('getDefaultSwapTradingPairs'),
      listOpenSwapOffers: failFn('listOpenSwapOffers'),
      computeSwapPriceTicks: failFn('computeSwapPriceTicks'),
      prepareSwapOrder: failFn('prepareSwapOrder'),
      quantizeSwapOrder: failFn('quantizeSwapOrder'),
      isLeft: failFn('isLeft'),
      createDemoDelta: failFn('createDemoDelta'),
      getDefaultCreditLimit: failFn('getDefaultCreditLimit'),
      safeStringify: failFn('safeStringify'),
      formatTokenAmountEthers: failFn('formatTokenAmountEthers'),
      parseTokenAmount: failFn('parseTokenAmount'),
      convertTokenPrecision: failFn('convertTokenPrecision'),
      calculatePercentageEthers: failFn('calculatePercentageEthers'),
      formatAssetAmountEthers: failFn('formatAssetAmountEthers'),
      BigIntMath: {} as BigIntMathUtils,
      FINANCIAL_CONSTANTS: {} as FinancialConstants,
      getEntity: failFn('getEntity'),
      getEntityShortId: failFn('getEntityShortId'),
      formatEntityId: failFn('formatEntityId'),
      formatEntityDisplay: failFn('formatEntityDisplay'),
      formatShortEntityId: failFn('formatShortEntityId'),
      // Display-only helpers must not crash early boot paths like /app#pay deep links.
      hashToAvatar: (() => '') as FrontendXlnFunctions['hashToAvatar'],
      generateEntityAvatar: (() => '') as FrontendXlnFunctions['generateEntityAvatar'],
      generateSignerAvatar: (() => '') as FrontendXlnFunctions['generateSignerAvatar'],
      getEntityDisplayInfo: failFn('getEntityDisplayInfo'),
      getSignerDisplayInfo: failFn('getSignerDisplayInfo'),
      extractEntityId: failFn('extractEntityId'),
      extractSignerId: failFn('extractSignerId'),
      parseReplicaKey: failFn('parseReplicaKey'),
      formatReplicaKey: failFn('formatReplicaKey'),
      createReplicaKey: failFn('createReplicaKey'),
      classifyBilateralState: failFn('classifyBilateralState'),
      getAccountBarVisual: failFn('getAccountBarVisual'),
      sendEntityInput: failFn('sendEntityInput'),
      resolveEntityProposerId: failFn('resolveEntityProposerId'),
      ensureGossipProfiles: failFn('ensureGossipProfiles'),
      isReady: false,
    } as FrontendXlnFunctions;
  }

  const formatTokenAmountUi = (tokenId: number, amount: bigint | null | undefined): string => {
    const tokenInfo = $xlnInstance.getTokenInfo(tokenId) ?? { symbol: `T${tokenId}`, decimals: 18 };
    const decimals = Number.isFinite(tokenInfo.decimals) ? tokenInfo.decimals : 18;
    const numeric = formatRawAmount(amount ?? 0n, decimals, settingPrecision);
    return `${numeric} ${tokenInfo.symbol}`;
  };

  const readyFunctions: FrontendXlnFunctions = {
    // Account utilities
    deriveDelta: $xlnInstance.deriveDelta,
    // Frontend display formatter with configurable precision from Settings.
    // Signature used across UI: formatTokenAmount(tokenId, amount).
    formatTokenAmount: formatTokenAmountUi,
    getTokenInfo: $xlnInstance.getTokenInfo,
    isLiquidSwapToken: $xlnInstance.isLiquidSwapToken,
    getSwapPairOrientation: $xlnInstance.getSwapPairOrientation,
    getDefaultSwapTradingPairs: $xlnInstance.getDefaultSwapTradingPairs,
    listOpenSwapOffers: $xlnInstance.listOpenSwapOffers,
    computeSwapPriceTicks: $xlnInstance.computeSwapPriceTicks,
    prepareSwapOrder: $xlnInstance.prepareSwapOrder,
    quantizeSwapOrder: $xlnInstance.quantizeSwapOrder,
    isLeft: $xlnInstance.isLeft,
    createDemoDelta: $xlnInstance.createDemoDelta,
    getDefaultCreditLimit: $xlnInstance.getDefaultCreditLimit,
    safeStringify: $xlnInstance.safeStringify,

    // Financial utilities (ethers.js-based, precision-safe)
    formatTokenAmountEthers: $xlnInstance.formatTokenAmountEthers,
    parseTokenAmount: $xlnInstance.parseTokenAmount,
    convertTokenPrecision: $xlnInstance.convertTokenPrecision,
    calculatePercentageEthers: $xlnInstance.calculatePercentageEthers,
    formatAssetAmountEthers: $xlnInstance.formatAssetAmountEthers,
    BigIntMath: $xlnInstance.BigIntMath,
    FINANCIAL_CONSTANTS: $xlnInstance.FINANCIAL_CONSTANTS,

    // Entity utilities - UNIFIED ENTITY ACCESS
    getEntity: (entityId: string) => {
      try {
        const shortId = $xlnInstance.getEntityShortId(entityId);
        if (!shortId) {
          throw new Error(`FINTECH-SAFETY: getEntityShortId returned empty: ${shortId}`);
        }
        const display = $xlnInstance.formatEntityId(entityId);
        return {
          id: entityId,
          shortId,
          display,
          avatar: $xlnInstance.generateEntityAvatar(entityId),
          info: $xlnInstance.getEntityDisplayInfo(entityId),
        };
      } catch (error) {
        console.error('FINTECH-SAFETY: Entity access failed:', error);
        throw error; // Fail fast - don't hide errors
      }
    },

    // Entity helper functions
    getEntityShortId: (entityId: string): string => {
      try {
        const result = $xlnInstance.getEntityShortId(entityId);
        if (!result) {
          throw new Error(`FINTECH-SAFETY: getEntityShortId returned empty: ${result}`);
        }
        return result;
      } catch (error) {
        console.error('FINTECH-SAFETY: Entity ID extraction failed:', error);
        throw error; // Fail fast - don't hide errors
      }
    },

    formatEntityId: $xlnInstance.formatEntityId,
    formatEntityDisplay: $xlnInstance.formatEntityDisplay,
    formatShortEntityId: $xlnInstance.formatShortEntityId,

    // Avatar generation (using XLN instance functions)
    hashToAvatar: (seed: string, size: number = 40): string => {
      if (typeof $xlnInstance.hashToAvatar !== 'function') {
        throw new Error('XLN_RUNTIME_MISSING_FN:hashToAvatar');
      }
      return $xlnInstance.hashToAvatar(seed, size);
    },

    generateEntityAvatar: (entityId: string): string => {
      if (typeof $xlnInstance.generateEntityAvatar !== 'function') {
        throw new Error('XLN_RUNTIME_MISSING_FN:generateEntityAvatar');
      }
      return $xlnInstance.generateEntityAvatar(entityId);
    },

    generateSignerAvatar: (signerId: string): string => {
      if (typeof $xlnInstance.generateSignerAvatar !== 'function') {
        throw new Error('XLN_RUNTIME_MISSING_FN:generateSignerAvatar');
      }
      return $xlnInstance.generateSignerAvatar(signerId);
    },

    // Entity display helpers
    getEntityDisplayInfo: (entityId: string) => {
      if (typeof $xlnInstance.getEntityDisplayInfo !== 'function') {
        throw new Error('XLN_RUNTIME_MISSING_FN:getEntityDisplayInfo');
      }
      return $xlnInstance.getEntityDisplayInfo(entityId);
    },

    // Signer display helpers
    getSignerDisplayInfo: (signerId: string) => {
      if (typeof $xlnInstance.getSignerDisplayInfo !== 'function') {
        throw new Error('XLN_RUNTIME_MISSING_FN:getSignerDisplayInfo');
      }
      return $xlnInstance.getSignerDisplayInfo(signerId);
    },

    // Identity system (from ids.ts) - replaces split(':') patterns
    extractEntityId: $xlnInstance.extractEntityId,
    extractSignerId: $xlnInstance.extractSignerId,
    parseReplicaKey: $xlnInstance.parseReplicaKey,
    formatReplicaKey: $xlnInstance.formatReplicaKey,
    createReplicaKey: $xlnInstance.createReplicaKey,
    classifyBilateralState: $xlnInstance.classifyBilateralState,
    getAccountBarVisual: $xlnInstance.getAccountBarVisual,
    sendEntityInput: $xlnInstance.sendEntityInput,
    resolveEntityProposerId: $xlnInstance.resolveEntityProposerId,
    ensureGossipProfiles: $xlnInstance.ensureGossipProfiles,

    // State management - indicates functions are fully loaded
    isReady: true,
  };

  return readyFunctions;
});
