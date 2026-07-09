import { writable, derived, get } from 'svelte/store';
import { errorLog } from './errorLogStore';
import { settings } from './settingsStore';
import { activeEnv, activeRuntimeId, registerRuntimeAdapterSwitcher, runtimes, runtimeOperations } from './runtimeStore';
import { xlnEnvironment, setXlnEnvironment } from './embeddedRuntimeStore';
import { toasts } from './toastStore';
import {
  connectRuntimeAdapter,
  disconnectRuntimeAdapter,
  getRuntimeControllerAdapter,
  getRuntimeControllerConfig,
  isRuntimeControllerConfigCurrent,
  onRuntimeControllerChange,
  onRuntimeControllerStatus,
  runtimeAdapterSend,
  runtimeControllerHandle,
} from './runtimeControllerStore';
import { submitRuntimeCommand } from './runtimeCommandBus';
import {
  REMOTE_HISTORY_SCAN_CACHE_LIMIT,
  resetRuntimeHistoryFrames,
  runtimeHistoryFrameFromViewFrame,
  upsertRuntimeHistoryFrame,
} from './runtimeHistoryStore';
import { clearRuntimeQueryCache, runtimeQueryClient, type RuntimeReceiptStatus } from './runtimeQueryClient';
import {
  runtimeView,
  resetRuntimeView,
  resetRuntimeViewSelection,
  refreshRuntimeView,
  runtimeViewAccountsPage,
  runtimeViewActiveEntityId,
  runtimeViewBooksPage,
  runtimeViewPageInfo,
} from './runtimeViewStore';
import { normalizeWsConnectUrl, normalizeWsUrl, sameWsEndpoint } from '$lib/utils/wsUrl';
import { createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
import {
  readRemoteRuntimeTokenAccess,
  readRemoteRuntimeTokenAudience,
  resolveStoredRemoteRuntimeAuthKey,
  type RemoteRuntimeHubSummary,
} from '$lib/utils/remoteRuntimeImport';
import { waitForOpenAccountCounterpartyProfiles } from '$lib/utils/p2pPrefetch';
import { getXLN, xlnInstance } from './xlnRuntimeLoader';
import type {
  XLNModule,
  Env,
  EnvSnapshot,
  EntityId,
  ReplicaKey,
  RoutedEntityInput,
  RuntimeInput,
  RuntimeAdapter,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
  RuntimeAdapterStatus,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame,
  EntityDisplayInfo,
  SignerDisplayInfo,
  BigIntMathUtils,
  FinancialConstants,
  SwapBookEntry,
  Profile as GossipProfile,
} from '@xln/runtime/xln-api';
import { REMOTE_RUNTIME } from '@xln/runtime/constants';

let unregisterEnvChange: (() => void) | null = null;
let unregisterRuntimeControllerChange: (() => void) | null = null;
let unregisterRuntimeControllerStatus: (() => void) | null = null;
type RemoteProjectionRefreshInFlight = {
  key: string;
  promise: Promise<Env | null>;
};

let remoteProjectionRefreshInFlight: RemoteProjectionRefreshInFlight | null = null;
let remoteProjectionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let remoteProjectionRefreshQueued = false;
let lastRemoteProjectionRefreshWarningAt = 0;
const RESET_NOTICE_STORAGE_KEY = 'xln-reset-notice';
const DEFAULT_REMOTE_ADAPTER_PATH = REMOTE_RUNTIME.DEFAULT_ADAPTER_PATH;
export const REMOTE_VIEW_PAGE_SIZE = REMOTE_RUNTIME.VIEW_PAGE_SIZE;
const REMOTE_PROJECTION_REFRESH_WARNING_COOLDOWN_MS = 7_500;
const FRONTEND_REMOTE_REQUEST_TIMEOUT_MS = 5_000;
const FRONTEND_REMOTE_RECONNECT_MAX_MS = 2_000;
const OPEN_ACCOUNT_PROFILE_WAIT_TIMEOUT_MS = 1_200;
const REMOTE_RUNTIME_PROJECTION_WAIT_TIMEOUT_MS = 5_000;
const REMOTE_RUNTIME_PROJECTION_WAIT_POLL_MS = 100;
const PAYMENT_GOSSIP_REFRESH_ATTEMPTS = 3;
const PAYMENT_GOSSIP_REFRESH_WAIT_MS = 100;

type FrontendEntitySummary = {
  id: string;
  shortId: string;
  display: string;
  avatar: string;
  info: EntityDisplayInfo;
};

const normalizeRuntimeConfigId = (value: unknown): string => String(value || '').trim().toLowerCase();

const runtimeIdFromRuntimeAdapterConfig = (config: RuntimeAdapterConfig): string =>
  normalizeRuntimeConfigId(config.runtimeId) || `radapter:${config.wsUrl || 'remote'}`.toLowerCase();

export interface FrontendXlnFunctions {
  deriveDelta: XLNModule['deriveDelta'];
  formatTokenAmount: (tokenId: number, amount: bigint | null | undefined) => string;
  getTokenInfo: XLNModule['getTokenInfo'];
  getKnownTokenIds: XLNModule['getKnownTokenIds'];
  getTokenIdsForJurisdiction: XLNModule['getTokenIdsForJurisdiction'];
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

export { xlnEnvironment, setXlnEnvironment } from './embeddedRuntimeStore';

export const isLoading = writable<boolean>(true);
export const error = writable<string | null>(null);

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
    const xln = get(xlnInstance);
    if (!xln) return;
    const env = get(xlnEnvironment);
    if (!env) return;
    try {
      const state = xln.getP2PState(env);
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
  clearRuntimeAdapterSubscriptions();
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

const remoteRuntimeIdFromConfig = runtimeIdFromRuntimeAdapterConfig;

const shouldResetRuntimeAdapterViewSelection = (
  previousConfig: RuntimeAdapterConfig | null,
  nextConfig: RuntimeAdapterConfig,
): boolean => {
  if (!previousConfig || previousConfig.mode !== nextConfig.mode) return true;
  const previousRuntimeId = normalizeRuntimeConfigId(previousConfig.runtimeId || '');
  const nextRuntimeId = normalizeRuntimeConfigId(nextConfig.runtimeId || '');
  if (previousRuntimeId || nextRuntimeId) return previousRuntimeId !== nextRuntimeId;
  if (previousConfig.mode !== 'remote' || nextConfig.mode !== 'remote') return false;
  return !sameWsEndpoint(previousConfig.wsUrl || '', nextConfig.wsUrl || '');
};

const resetRuntimeAdapterViewSelection = (): void => {
  clearRuntimeQueryCache();
  resetRuntimeView();
  resetRuntimeViewSelection();
  resetRuntimeHistoryFrames();
};

const isStaleRemoteEntitySelectionError = (error: unknown, requestedEntityId: string): boolean => {
  if (!requestedEntityId) return false;
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = String(candidate?.code || '').trim();
  const message = String(candidate?.message || error || '').toLowerCase();
  return (!code || code === 'E_NOT_FOUND') &&
    message.includes(requestedEntityId.toLowerCase()) &&
    (
      message.includes('entity summary not found') ||
      message.includes('entity not found')
    );
};

const updateLocalEnvironmentStores = (xln: XLNModule, env: Env): void => {
  const selectedRuntimeId = String(get(activeRuntimeId) || '').toLowerCase();
  const envRuntimeId = String(env.runtimeId || '').toLowerCase();
  if (selectedRuntimeId && selectedRuntimeId !== envRuntimeId) {
    const selected = get(runtimes).get(selectedRuntimeId);
    if (selected?.env) return;
  }

  setXlnEnvironment(env);
  history.set(env.history);
  currentHeight.set(env.height);
  if (envRuntimeId) {
    upsertRuntimeSnapshot(env, { mode: 'embedded', runtimeId: envRuntimeId }, 'connected');
  }
  runtimeOperations.updateLocalEnv(env);

  entityPositions.update(currentPositions => {
    let hasChanges = false;
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const entityId = xln.extractEntityId(replicaKey);
      if (entityId && replica.position && !currentPositions.has(entityId)) {
        const pos = replica.position;
        const jurisdiction = pos.jurisdiction || pos.xlnomy || env.activeJurisdiction || 'default';
        currentPositions.set(entityId, { x: pos.x, y: pos.y, z: pos.z, jurisdiction });
        hasChanges = true;
      }
    }
    return hasChanges ? new Map(currentPositions) : currentPositions;
  });
};

const registerLocalEnvironmentCallback = (xln: XLNModule, env: Env): void => {
  unregisterEnvChange?.();
  unregisterEnvChange = xln.registerEnvChangeCallback?.(env, (nextEnv) => updateLocalEnvironmentStores(xln, nextEnv)) || null;
};

const clearRuntimeAdapterSubscriptions = (): void => {
  unregisterRuntimeControllerChange?.();
  unregisterRuntimeControllerChange = null;
  unregisterRuntimeControllerStatus?.();
  unregisterRuntimeControllerStatus = null;
  remoteProjectionRefreshInFlight = null;
  if (remoteProjectionRefreshTimer) {
    clearTimeout(remoteProjectionRefreshTimer);
    remoteProjectionRefreshTimer = null;
  }
  remoteProjectionRefreshQueued = false;
};

const handleRuntimeProjectionRefreshError = (refreshError: unknown): void => {
  const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
  errorLog.log(message, 'Runtime Projection Refresh', refreshError);
  if (getRuntimeControllerConfig()?.mode === 'remote') {
    console.warn('[XLN] Remote runtime projection refresh failed; keeping current runtime view mounted', refreshError);
    const now = Date.now();
    if (now - lastRemoteProjectionRefreshWarningAt >= REMOTE_PROJECTION_REFRESH_WARNING_COOLDOWN_MS) {
      lastRemoteProjectionRefreshWarningAt = now;
      toasts.warning(`Remote runtime projection refresh failed: ${message}`, 7000);
    }
    return;
  }
  error.set(message);
};

const scheduleRuntimeProjectionRefresh = (): void => {
  if (remoteProjectionRefreshTimer) {
    remoteProjectionRefreshQueued = true;
    return;
  }
  remoteProjectionRefreshTimer = setTimeout(() => {
    remoteProjectionRefreshTimer = null;
    const shouldRunAgain = remoteProjectionRefreshQueued;
    remoteProjectionRefreshQueued = false;
    void refreshCurrentRuntimeProjection()
      .catch(handleRuntimeProjectionRefreshError)
      .finally(() => {
        if (shouldRunAgain) scheduleRuntimeProjectionRefresh();
      });
  }, 200);
};

const isCurrentRuntimeAdapterConfig = isRuntimeControllerConfigCurrent;

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

const remoteProjectionRefreshKey = (config: RuntimeAdapterConfig): string => {
  if (config.mode !== 'remote') return 'embedded';
  const runtimeId = normalizeRuntimeConfigId(config.runtimeId || remoteRuntimeIdFromConfig(config));
  const wsUrl = normalizeWsConnectUrl(config.wsUrl || defaultRemoteAdapterWsUrl());
  const access = readRemoteRuntimeTokenAccess(config.authKey || '') || 'noauth';
  return `remote:${runtimeId}:${wsUrl}:${access}`;
};

const EMBEDDED_RUNTIME_SEED_STORAGE_KEY = 'xln-embedded-runtime-seed-v1';

const generateEmbeddedRuntimeSeed = (): string => {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('EMBEDDED_RUNTIME_SEED_CRYPTO_UNAVAILABLE');
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `xln-browser-runtime:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const readOrCreateEmbeddedRuntimeSeed = (): string | undefined => {
  if (typeof window === 'undefined') return undefined;
  const stored = localStorage.getItem(EMBEDDED_RUNTIME_SEED_STORAGE_KEY)?.trim();
  if (stored) return stored;
  const seed = generateEmbeddedRuntimeSeed();
  localStorage.setItem(EMBEDDED_RUNTIME_SEED_STORAGE_KEY, seed);
  return seed;
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
    const seed = readOrCreateEmbeddedRuntimeSeed();
    return seed ? { mode: 'embedded', seed } : { mode: 'embedded' };
  }

  const wsUrl = (
    params.get('ws') ||
    params.get('runtimeWs') ||
    readStoredAdapterValue('xln-runtime-adapter-ws') ||
    defaultRemoteAdapterWsUrl()
  ).trim();
  const normalizedWsUrl = normalizeWsConnectUrl(wsUrl);
  const storedAccess = readStoredAdapterValue('xln-runtime-adapter-access').trim().toLowerCase();
  const storedAuthKey = readStoredAdapterValue('xln-runtime-adapter-key').trim();
  let restoredAuthKey = '';
  if (storedAccess === 'admin') {
    try {
      restoredAuthKey = resolveStoredRemoteRuntimeAuthKey(normalizedWsUrl, { requiredAccess: 'admin' }).trim();
    } catch (error) {
      if (!storedAuthKey || readRemoteRuntimeTokenAccess(storedAuthKey) !== 'admin') throw error;
    }
  } else if (!storedAuthKey) {
    restoredAuthKey = resolveStoredRemoteRuntimeAuthKey(normalizedWsUrl).trim();
  }
  if (restoredAuthKey) sessionStorage.setItem('xln-runtime-adapter-key', restoredAuthKey);
  const authKey = restoredAuthKey || storedAuthKey;
  const runtimeId = readRemoteRuntimeTokenAudience(authKey);

  const config: RuntimeAdapterConfig = {
    mode: 'remote',
    ...(runtimeId ? { runtimeId } : {}),
    wsUrl: normalizedWsUrl,
    ...(authKey ? { authKey } : {}),
    requestTimeoutMs: FRONTEND_REMOTE_REQUEST_TIMEOUT_MS,
    reconnectMaxMs: FRONTEND_REMOTE_RECONNECT_MAX_MS,
  };
  return config;
};

const upsertRuntimeSnapshot = (
  env: Env,
  config: RuntimeAdapterConfig,
  status: RuntimeAdapterStatus,
  authLevel: RuntimeAdapterAuthLevel | null = null,
): void => {
  const runtimeId = String(env.runtimeId || '').toLowerCase();
  if (!runtimeId) return;
  const viewEnv = createRuntimeViewEnv(unwrapLiveRuntimeEnv(env) ?? env);
  runtimes.update((map) => {
    const updated = new Map(map);
    const existing = updated.get(runtimeId);
    const remoteAccess = authLevel === 'admin' ? 'admin' : 'read';
    updated.set(runtimeId, {
      ...existing,
      id: runtimeId,
      type: config.mode === 'remote' ? 'remote' : 'local',
      label: existing?.label || (config.mode === 'remote' ? `Remote ${config.wsUrl || 'runtime'}` : 'Embedded runtime'),
      env: viewEnv,
      ...(config.wsUrl ? { wsUrl: config.wsUrl } : {}),
      ...(config.seed ? { seed: config.seed } : {}),
      ...(config.authKey ? { apiKey: config.authKey } : {}),
      ...(config.mode === 'remote' ? { remoteAccess } : {}),
      permissions: config.mode === 'remote' ? (authLevel === 'admin' ? 'write' : 'read') : 'write',
      status: status === 'connected' ? 'connected' : status === 'connecting' ? 'syncing' : status,
      lastSynced: Date.now(),
    });
    return updated;
  });
  runtimeOperations.setActiveRuntimeId(runtimeId);
};

const runtimeStatusFromAdapter = (status: RuntimeAdapterStatus): 'connected' | 'syncing' | 'disconnected' | 'error' => {
  if (status === 'connected') return 'connected';
  if (status === 'connecting') return 'syncing';
  if (status === 'disconnected') return 'disconnected';
  return 'error';
};

const remoteHubSummariesFromEntities = (
  entities: RuntimeAdapterEntitySummary[],
) => entities.flatMap((entity) => {
  if (entity?.isHub !== true) return [];
  const summary = remoteEntitySummaryFromEntity(entity);
  return summary ? [summary] : [];
});

const remoteEntitySummaryFromEntity = (
  entity: RuntimeAdapterEntitySummary,
): RemoteRuntimeHubSummary | null => {
  const entityId = String(entity.entityId || '').trim().toLowerCase();
  if (!entityId) return null;
  const runtimeId = String(entity.runtimeId || '').trim().toLowerCase();
  return {
    entityId,
    ...(runtimeId ? { runtimeId } : {}),
    label: String(entity.label || entityId).trim(),
    height: Math.max(0, Math.floor(Number(entity.height || 0))),
    ...(entity.jurisdiction ? { jurisdiction: entity.jurisdiction } : {}),
  };
};

const remoteEntitySummariesFromEntities = (
  entities: RuntimeAdapterEntitySummary[],
): RemoteRuntimeHubSummary[] => entities.flatMap((entity) => {
  const summary = remoteEntitySummaryFromEntity(entity);
  return summary ? [summary] : [];
});

const normalizeRemoteRuntimeEntityLabel = (value: unknown): string =>
  String(value || '').trim().toLowerCase().replace(/^remote\s+/, '');

const remoteEntityNameMatchesRuntimeLabel = (entityLabel: string, runtimeLabel: string): boolean => {
  const entity = normalizeRemoteRuntimeEntityLabel(entityLabel);
  const runtime = normalizeRemoteRuntimeEntityLabel(runtimeLabel);
  if (!entity || !runtime) return false;
  return entity === runtime || entity.startsWith(`${runtime} `) || entity.startsWith(`${runtime}(`);
};

const selectRemoteRuntimeProjectionPrimary = (
  entities: RemoteRuntimeHubSummary[],
  runtimeLabel: string,
  runtimeId: string,
): RemoteRuntimeHubSummary | null => {
  if (entities.length === 0) return null;
  const scoped = runtimeId
    ? entities.filter((entity) => String(entity.runtimeId || '').trim().toLowerCase() === runtimeId)
    : entities;
  return scoped.find((entity) => remoteEntityNameMatchesRuntimeLabel(entity.label, runtimeLabel))
    ?? entities.find((entity) => remoteEntityNameMatchesRuntimeLabel(entity.label, runtimeLabel))
    ?? (scoped.length === 1 ? scoped[0]! : null)
    ?? (entities.length === 1 ? entities[0]! : null);
};

const upsertRemoteRuntimeProjectionMetadata = (
  config: RuntimeAdapterConfig,
  status: RuntimeAdapterStatus,
  authLevel: RuntimeAdapterAuthLevel | null,
  options: {
    runtimeId?: string | null;
    frame?: RuntimeAdapterViewFrame | null;
  } = {},
): void => {
  if (config.mode !== 'remote') return;
  const runtimeId = normalizeRuntimeConfigId(
    options.runtimeId || config.runtimeId || remoteRuntimeIdFromConfig(config),
  );
  if (!runtimeId) return;
  const remoteAccess = authLevel === 'admin' ? 'admin' : 'read';
  const entities = options.frame?.entities ?? [];
  const entitySummaries = remoteEntitySummariesFromEntities(entities);
  const hubEntities = remoteHubSummariesFromEntities(entities);
  runtimes.update((map) => {
    const updated = new Map(map);
    const existing = updated.get(runtimeId);
    const primaryHub = hubEntities[0] ?? null;
    const primarySummary = selectRemoteRuntimeProjectionPrimary(
      entitySummaries,
      existing?.label || existing?.hubName || '',
      runtimeId,
    ) ?? (existing?.hubEntityId ? null : primaryHub);
    const hubEntityId = primarySummary?.entityId || existing?.hubEntityId || '';
    const hubName = primarySummary?.label || existing?.hubName || '';
    const hubJurisdiction = primarySummary?.jurisdiction ?? existing?.hubJurisdiction;
    updated.set(runtimeId, {
      ...existing,
      id: runtimeId,
      type: 'remote',
      label: existing?.label || primaryHub?.label || `Remote ${config.wsUrl || 'runtime'}`,
      env: null,
      ...(config.wsUrl ? { wsUrl: config.wsUrl } : {}),
      ...(config.authKey ? { apiKey: config.authKey } : {}),
      remoteAccess,
      permissions: remoteAccess === 'admin' ? 'write' : 'read',
      status: runtimeStatusFromAdapter(status),
      entityCount: entities.length > 0
        ? entities.length
        : Math.max(0, Math.floor(Number(existing?.entityCount || 0))),
      ...(hubEntityId ? { hubEntityId } : {}),
      ...(hubName ? { hubName } : {}),
      ...(hubJurisdiction ? { hubJurisdiction } : {}),
      ...(hubEntities.length > 0 ? { hubEntities } : {}),
      ...(existing?.latencyMs !== undefined ? { latencyMs: existing.latencyMs } : {}),
      ...(options.frame ? { lastSynced: Date.now() } : {}),
      ...(!options.frame && existing?.lastSynced !== undefined ? { lastSynced: existing.lastSynced } : {}),
    });
    return updated;
  });
  runtimeOperations.setActiveRuntimeId(runtimeId);
};

type RemoteRuntimeProjectionRefresh = {
  runtimeId: string;
  height: number;
  frame: RuntimeAdapterViewFrame;
};

const refreshRemoteRuntimeProjection = async (
  adapter: RuntimeAdapter,
  config: RuntimeAdapterConfig,
): Promise<RemoteRuntimeProjectionRefresh> => {
  if (adapter.mode !== 'remote' || config.mode !== 'remote') {
    throw new Error('Remote projection refresh requires remote runtime adapter');
  }
  const adapterHeight = Math.max(0, Math.floor(Number(adapter.currentHeight || 0)));
  const requestedEntityId = normalizeEntityIdForView(get(runtimeViewActiveEntityId));
  const accountsPage = Math.max(0, Math.floor(Number(get(runtimeViewAccountsPage) ?? 0)));
  const booksPage = Math.max(0, Math.floor(Number(get(runtimeViewBooksPage) ?? 0)));
  const viewQuery: RuntimeAdapterReadQuery = {
    limit: REMOTE_VIEW_PAGE_SIZE,
    accountsLimit: REMOTE_VIEW_PAGE_SIZE,
    booksLimit: REMOTE_VIEW_PAGE_SIZE,
    accountsPage,
    booksPage,
  };
  const refreshView = async (entityId: string): Promise<RuntimeAdapterViewFrame> => {
    const view = await refreshRuntimeView(entityId ? { ...viewQuery, entityId } : viewQuery);
    if (!view.frame) {
      if (entityId) {
        const staleEntityError = new Error(`Remote entity summary not found: ${entityId}`);
        (staleEntityError as Error & { code?: string }).code = 'E_NOT_FOUND';
        throw staleEntityError;
      }
      throw new Error('REMOTE_RUNTIME_VIEW_FRAME_MISSING');
    }
    return view.frame;
  };

  let frame: RuntimeAdapterViewFrame;
  try {
    frame = await refreshView(requestedEntityId);
  } catch (error) {
    if (!isStaleRemoteEntitySelectionError(error, requestedEntityId)) throw error;
    console.warn(
      `[XLN] Remote active entity ${requestedEntityId} is not available in this runtime view; resetting to default entity.`,
      error,
    );
    runtimeViewActiveEntityId.set('');
    runtimeViewAccountsPage.set(0);
    runtimeViewBooksPage.set(0);
    frame = await refreshView('');
  }

  const runtimeId = normalizeRuntimeConfigId(adapter.runtimeId || config.runtimeId || remoteRuntimeIdFromConfig(config));
  const historyFrame = runtimeHistoryFrameFromViewFrame({
    runtimeId,
    mode: 'remote',
    frame,
  });
  upsertRuntimeHistoryFrame({
    runtimeId,
    mode: 'remote',
    frame,
  }, REMOTE_HISTORY_SCAN_CACHE_LIMIT);
  if (historyFrame.activeEntityId) runtimeViewActiveEntityId.set(historyFrame.activeEntityId);
  runtimeViewPageInfo.set(historyFrame.pageInfo);
  const height = Math.max(
    historyFrame.height,
    Math.max(0, Math.floor(Number(frame.head?.latestHeight || 0))),
    adapterHeight,
  );
  currentHeight.set(height);
  upsertRemoteRuntimeProjectionMetadata(config, adapter.status, adapter.authLevel, {
    runtimeId,
    frame,
  });
  return { runtimeId, height, frame };
};

const createEmbeddedRuntimeAdapter = async (
  xln: XLNModule,
  runtimeSeed?: string | null,
  targetEnv?: Env | null,
): Promise<RuntimeAdapter> => {
  let boundEnv = targetEnv ? (unwrapLiveRuntimeEnv(targetEnv) ?? targetEnv) : null;
  if (!boundEnv && !getEnv()) {
    const env = await xln.main(runtimeSeed ?? null);
    setXlnEnvironment(env);
    boundEnv = env;
  }
  if (!boundEnv) {
    const env = getEnv();
    boundEnv = env ? (unwrapLiveRuntimeEnv(env) ?? env) : null;
  }
  const boundRuntimeId = normalizeRuntimeConfigId(boundEnv?.runtimeId || '');
  const getLiveEnv = () => {
    const current = getEnv();
    const currentEnv = current ? (unwrapLiveRuntimeEnv(current) ?? current) : null;
    if (!boundRuntimeId) return currentEnv ?? boundEnv;
    if (normalizeRuntimeConfigId(currentEnv?.runtimeId || '') === boundRuntimeId) return currentEnv;
    const runtimeEnv = get(runtimes).get(boundRuntimeId)?.env;
    const liveRuntimeEnv = runtimeEnv ? (unwrapLiveRuntimeEnv(runtimeEnv) ?? runtimeEnv) : null;
    if (normalizeRuntimeConfigId(liveRuntimeEnv?.runtimeId || '') === boundRuntimeId) return liveRuntimeEnv;
    return boundEnv;
  };
  return new xln.EmbeddedRuntimeAdapter({
    getEnv: getLiveEnv,
    enqueueRuntimeInput: (env, input) => xln.enqueueRuntimeInput(unwrapLiveRuntimeEnv(env) ?? env, input),
    registerEnvChangeCallback: (env, cb) => xln.registerEnvChangeCallback(env, cb),
    buildReadContext: (env) => ({
      readHead: () => xln.readPersistedStorageHead(env),
      readFrame: (height) => xln.readPersistedStorageFrameRecord(env, height),
      listCheckpoints: () => xln.listPersistedCheckpointHeights(env),
      loadEntityState: (entityId, height) => xln.loadEntityStateFromStorageDb(env, entityId, height),
      loadEntityAccountDoc: (entityId, counterpartyId, height) => xln.loadEntityAccountDocFromStorageDb(env, entityId, counterpartyId, height),
      loadEntityViewPage: (entityId, height, query) => xln.loadEntityViewPageFromStorageDb(env, entityId, height, query),
      listEntityIdsAtHeight: (height) => xln.listPersistedEntityIdsAtHeight(env, height),
      readActivityPage: (opts) => xln.readPersistedRuntimeActivityPage(env, opts),
    }),
  });
};

export const switchAppRuntimeAdapter = async (config: RuntimeAdapterConfig): Promise<Env | null> => {
  const normalizedConfig: RuntimeAdapterConfig = config.mode === 'remote'
    ? {
        mode: 'remote',
        ...(config.runtimeId ? { runtimeId: normalizeRuntimeConfigId(config.runtimeId) } : {}),
        wsUrl: normalizeWsConnectUrl(config.wsUrl || defaultRemoteAdapterWsUrl()),
        ...(config.authKey ? { authKey: config.authKey } : {}),
        reconnectMaxMs: config.reconnectMaxMs ?? FRONTEND_REMOTE_RECONNECT_MAX_MS,
        requestTimeoutMs: config.requestTimeoutMs ?? FRONTEND_REMOTE_REQUEST_TIMEOUT_MS,
      }
    : {
        mode: 'embedded',
        ...(config.runtimeId ? { runtimeId: normalizeRuntimeConfigId(config.runtimeId) } : {}),
        ...(config.seed ? { seed: config.seed } : {}),
      };
  const previousConfig = getRuntimeControllerConfig();
  if (shouldResetRuntimeAdapterViewSelection(previousConfig, normalizedConfig)) {
    resetRuntimeAdapterViewSelection();
  }
  clearRuntimeAdapterSubscriptions();

  const xln = await getXLN();

  if (normalizedConfig.mode === 'remote') {
    unregisterEnvChange?.();
    unregisterEnvChange = null;
    stopP2PPoll();

    const adapter = await connectRuntimeAdapter(normalizedConfig);
    unregisterRuntimeControllerChange = onRuntimeControllerChange(() => {
      scheduleRuntimeProjectionRefresh();
    });
    unregisterRuntimeControllerStatus = onRuntimeControllerStatus((status) => {
      if (!isCurrentRuntimeAdapterConfig(normalizedConfig)) return;
      upsertRemoteRuntimeProjectionMetadata(normalizedConfig, status, adapter.authLevel, {
        runtimeId: adapter.runtimeId || remoteRuntimeIdFromConfig(normalizedConfig),
      });
      if (status === 'connected') scheduleRuntimeProjectionRefresh();
    });

    try {
      await refreshCurrentRuntimeProjection();
    } catch (initialRemoteError) {
      const message = initialRemoteError instanceof Error ? initialRemoteError.message : String(initialRemoteError);
      errorLog.log(message, 'Runtime Initial Projection', initialRemoteError);
      error.set(message);
      isLoading.set(false);
      throw initialRemoteError;
    }
    error.set(null);
    isLoading.set(false);
    isInitialized = true;
    return null;
  }

  const requestedRuntimeId = normalizeRuntimeConfigId(normalizedConfig.runtimeId || '');
  const selectedRuntimeId = requestedRuntimeId || String(get(activeRuntimeId) || '').toLowerCase();
  const selectedRuntime = selectedRuntimeId ? get(runtimes).get(selectedRuntimeId) : null;
  let env = selectedRuntime?.type === 'local'
    ? (unwrapLiveRuntimeEnv(selectedRuntime.env) ?? selectedRuntime.env)
    : null;
  const currentEnv = get(xlnEnvironment);
  const currentRuntimeId = normalizeRuntimeConfigId(currentEnv?.runtimeId || '');
  if (!env && currentEnv && !String(currentEnv.runtimeId || '').startsWith('radapter:')) {
    if (!selectedRuntimeId || currentRuntimeId === selectedRuntimeId) {
      env = unwrapLiveRuntimeEnv(currentEnv) ?? currentEnv;
    }
  }
  if (!env && selectedRuntime?.type === 'local' && selectedRuntime.seed) {
    env = await xln.main(selectedRuntime.seed);
  }
  if (!env) {
    env = await xln.main(normalizedConfig.seed ?? null);
  }
  const envRuntimeId = normalizeRuntimeConfigId(env.runtimeId || selectedRuntimeId);
  if (selectedRuntimeId && envRuntimeId !== selectedRuntimeId) {
    throw new Error(`EMBEDDED_RUNTIME_ENV_MISMATCH: selected ${selectedRuntimeId}, got ${envRuntimeId || '<missing>'}`);
  }
  if (envRuntimeId) runtimeOperations.setActiveRuntimeId(envRuntimeId);

  registerLocalEnvironmentCallback(xln, env);
  updateLocalEnvironmentStores(xln, env);
  await connectRuntimeAdapter(normalizedConfig, {
    createEmbeddedAdapter: () => createEmbeddedRuntimeAdapter(xln, normalizedConfig.seed ?? null, env),
  });
  unregisterRuntimeControllerStatus = onRuntimeControllerStatus(() => {
    if (!isCurrentRuntimeAdapterConfig(normalizedConfig)) return;
  });
  error.set(null);
  isLoading.set(false);
  isInitialized = true;
  startP2PPoll();
  return env;
};

registerRuntimeAdapterSwitcher(async (config) => {
  await switchAppRuntimeAdapter(config);
});

export const refreshCurrentRuntimeProjection = async (): Promise<Env | null> => {
  const config = getRuntimeControllerConfig();
  if (config?.mode !== 'remote') return get(xlnEnvironment);
  const refreshKey = remoteProjectionRefreshKey(config);
  if (remoteProjectionRefreshInFlight?.key === refreshKey) {
    return remoteProjectionRefreshInFlight.promise;
  }
  const promise = (async () => {
    const adapter = getRuntimeControllerAdapter();
    if (!adapter || adapter.mode !== 'remote') return null;
    const projection = await refreshRemoteRuntimeProjection(adapter, config);
    if (!isCurrentRuntimeAdapterConfig(config)) return null;
    currentHeight.set(projection.height);
    return null;
  })();
  remoteProjectionRefreshInFlight = { key: refreshKey, promise };
  try {
    return await promise;
  } finally {
    if (
      remoteProjectionRefreshInFlight?.key === refreshKey &&
      remoteProjectionRefreshInFlight.promise === promise
    ) {
      remoteProjectionRefreshInFlight = null;
    }
  }
};

// Helper functions for common patterns (not wrappers)
export async function initializeXLN(): Promise<Env | null> {
  showPendingResetNotice();
  // CRITICAL: Don't re-initialize if we already have data
  if (isInitialized) {
    const currentEnv = get(xlnEnvironment);
    const selectedRuntimeId = String(get(activeRuntimeId) || '').toLowerCase();
    const currentRuntimeId = String(currentEnv?.runtimeId || '').toLowerCase();
    if (currentEnv && (!selectedRuntimeId || currentRuntimeId === selectedRuntimeId)) {
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
    runtimeOperations.hydrateRemoteRuntimeImports();
    if (typeof window !== 'undefined') {
      const importSource = new URL('/api/runtime-import', resolveConfiguredApiBase(window.location.origin));
      importSource.searchParams.set('access', 'read');
      importSource.searchParams.set('allowPartial', '1');
      void runtimeOperations.hydrateRemoteRuntimeImportSource(importSource.toString(), { optional: true });
    }

    const adapterConfig = resolveAppRuntimeAdapterConfig();
    if (adapterConfig.mode === 'remote') {
      return await switchAppRuntimeAdapter(adapterConfig);
    }

    // Load from IndexedDB - main() handles DB timeout internally
    let env: Env;
    try {
      env = await xln.main(adapterConfig.seed ?? null);
    } catch (restoreError) {
      if (!isFinancialRestoreFailure(restoreError)) {
        throw restoreError;
      }
      console.error('[VaultStore:xlnStore] Financial restore failure; refusing automatic local data reset', restoreError);
      throw restoreError;
    }

    // Register callback for THIS env instance (runtime API is env-scoped)
    registerLocalEnvironmentCallback(xln, env);

    // Set all stores immediately (no derived timing races)
    updateLocalEnvironmentStores(xln, env);

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
      clearRuntimeAdapterSubscriptions();
      await connectRuntimeAdapter(adapterConfig, {
        createEmbeddedAdapter: () => createEmbeddedRuntimeAdapter(xln, adapterConfig.seed ?? null, env),
      });
      unregisterRuntimeControllerStatus = onRuntimeControllerStatus(() => {
        if (!isCurrentRuntimeAdapterConfig(adapterConfig)) return;
      });
    } catch (adapterError) {
      console.warn('[VaultStore:xlnStore] Embedded runtime adapter failed to connect; local env remains usable', adapterError);
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
export { getXLN, xlnInstance };

// Helper to get current environment
export function getEnv(): Env | null {
  return get(xlnEnvironment);
}

const normalizeGossipEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();

type RuntimeDebugPayload = {
  source: string;
  code: string;
  message: string;
  entityId?: string;
  targetEntityId?: string;
  timestamp?: number;
  details?: Record<string, unknown>;
};

export function sendRuntimeDebugEvent(payload: RuntimeDebugPayload): void {
  const env = getEnv();
  const p2p = env?.runtimeState?.p2p;
  if (typeof p2p?.sendDebugEvent !== 'function') return;
  try {
    p2p.sendDebugEvent(payload);
  } catch (error) {
    console.warn('[VaultStore:xlnStore] Runtime debug event dispatch failed:', error);
  }
}

async function fetchPaymentGossipProfiles(entityIds: string[]): Promise<GossipProfile[]> {
  if (typeof fetch === 'undefined') return [];
  const profiles: GossipProfile[] = [];
  for (const rawEntityId of entityIds) {
    const entityId = normalizeGossipEntityId(rawEntityId);
    if (!entityId) continue;
    try {
      const response = await fetch(`/api/gossip/profile?entityId=${encodeURIComponent(entityId)}`);
      if (!response.ok) continue;
      const payload = await response.json().catch(() => null) as {
        profile?: GossipProfile | null;
        peers?: GossipProfile[];
      } | null;
      if (payload?.profile) profiles.push(payload.profile);
      if (Array.isArray(payload?.peers)) profiles.push(...payload.peers);
    } catch (error) {
      console.warn('[VaultStore:xlnStore] Payment gossip profile fetch failed:', { entityId, error });
    }
  }
  return profiles;
}

const announcePaymentGossipProfiles = (env: Env, profiles: GossipProfile[]): number => {
  if (typeof env.gossip?.announce !== 'function') return 0;
  let announced = 0;
  for (const profile of profiles) {
    if (!profile?.entityId) continue;
    try {
      env.gossip.announce(profile);
      announced += 1;
    } catch (error) {
      console.warn('[VaultStore:xlnStore] Payment gossip profile announce failed:', {
        entityId: String(profile.entityId || ''),
        error,
      });
    }
  }
  return announced;
};

export async function refreshPaymentRuntimeGossip(options: {
  reason: string;
  targetEntities: string[];
  onDebug?: (code: string, message: string, details?: Record<string, unknown>) => void;
}): Promise<{ profiles: GossipProfile[]; announced: number }> {
  const env = getEnv();
  const xln = env ? await getXLN() : null;
  const targetEntities = Array.from(new Set((options.targetEntities || []).map(normalizeGossipEntityId).filter(Boolean)));
  const mergedProfiles = new Map<string, GossipProfile>();
  let announced = 0;

  const mergeProfiles = (profiles: GossipProfile[]): void => {
    for (const profile of profiles) {
      const entityId = normalizeGossipEntityId(profile?.entityId);
      if (!entityId) continue;
      mergedProfiles.set(entityId, profile);
    }
    if (env) announced += announcePaymentGossipProfiles(env, profiles);
  };

  if (targetEntities.length > 0) {
    mergeProfiles(await fetchPaymentGossipProfiles(targetEntities));
  }

  if (!env) {
    options.onDebug?.('PAYMENT_PREFLIGHT_GOSSIP_PROJECTION_ONLY', `Fetched projection gossip profiles (${options.reason})`, {
      targetEntities,
      profiles: mergedProfiles.size,
    });
    return { profiles: Array.from(mergedProfiles.values()), announced };
  }

  try {
    await env.runtimeState?.p2p?.syncProfiles?.();
  } catch (error) {
    console.warn('[VaultStore:xlnStore] Payment gossip p2p sync failed:', error);
  }

  if (targetEntities.length > 0 && typeof xln?.ensureGossipProfiles === 'function') {
    options.onDebug?.('PAYMENT_PREFLIGHT_GOSSIP_FETCH', `Fetching gossip profiles (${options.reason})`, {
      targetEntities,
    });
    try {
      const resolved = await xln.ensureGossipProfiles(env, targetEntities);
      if (resolved) return { profiles: Array.from(mergedProfiles.values()), announced };
    } catch (error) {
      console.warn('[VaultStore:xlnStore] Payment gossip targeted ensure failed:', { targetEntities, error });
    }
  }

  for (let attempt = 1; attempt <= PAYMENT_GOSSIP_REFRESH_ATTEMPTS; attempt += 1) {
    options.onDebug?.('PAYMENT_PREFLIGHT_GOSSIP_REFRESH', `Refreshing gossip (${options.reason})`, {
      attempt,
      targetEntities,
    });
    try {
      xln?.refreshGossip?.(env);
    } catch (error) {
      console.warn('[VaultStore:xlnStore] Payment gossip runtime refresh failed:', error);
    }
    try {
      env.runtimeState?.p2p?.refreshGossip?.();
    } catch (error) {
      console.warn('[VaultStore:xlnStore] Payment gossip p2p refresh failed:', error);
    }
    await sleep(PAYMENT_GOSSIP_REFRESH_WAIT_MS);
    if (targetEntities.length > 0) {
      mergeProfiles(await fetchPaymentGossipProfiles(targetEntities));
    }
  }

  return { profiles: Array.from(mergedProfiles.values()), announced };
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
  (env.networkInbox ?? []).some(hasMeaningfulEntityInput) ||
  (env.pendingNetworkOutputs ?? []).some(hasMeaningfulEntityInput) ||
  Array.from(env.eReplicas?.values?.() ?? []).some((replica) =>
    Array.from(replica?.state?.accounts?.values?.() ?? []).some((account) =>
      (account?.mempool?.length ?? 0) > 0 && !account?.pendingFrame
    )
  )
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const hasQueuedLocalRuntimeWork = (xln: XLNModule, env: Env): boolean => (
  typeof xln.hasRuntimeWork === 'function'
    ? xln.hasRuntimeWork(env)
    : hasMeaningfulQueuedLocalRuntimeWork(env)
);

const publishLocalRuntimeEnvIfActive = (env: Env): void => {
  const runtimeId = normalizeRuntimeIdentifier(env.runtimeId);
  if (runtimeId) runtimeOperations.updateRuntimeEnv(runtimeId, env);
  if (!runtimeId || normalizeRuntimeIdentifier(get(activeRuntimeId)) === runtimeId) {
    setXlnEnvironment(env);
  }
};

const drainLocalRuntimeInput = async (xln: XLNModule, env: Env, _label = 'runtime'): Promise<void> => {
  const startedAt = Date.now();
  for (let i = 0; i < 80 && hasQueuedLocalRuntimeWork(xln, env); i += 1) {
    const beforeHeight = Number(env.height || 0);
    await xln.process(env, undefined, 0);
    publishLocalRuntimeEnvIfActive(env);
    if (!hasQueuedLocalRuntimeWork(xln, env)) return;
    if (Number(env.height || 0) === beforeHeight) {
      await sleep(25);
    }
    if (Date.now() - startedAt > 4_000) break;
  }
  if (hasQueuedLocalRuntimeWork(xln, env)) {
    throw new Error('LOCAL_RUNTIME_DRAIN_TIMEOUT: submitted runtime input did not commit within 4s');
  }
};

const normalizeRuntimeIdentifier = (value: unknown): string => String(value || '').trim().toLowerCase();

const embeddedAdapterTargetsRuntimeEnv = (targetEnv: Env): boolean => {
  const current = getEnv();
  const currentEnv = current ? (unwrapLiveRuntimeEnv(current) ?? current) : null;
  if (!currentEnv) return false;
  if (currentEnv === targetEnv) return true;
  const currentRuntimeId = normalizeRuntimeIdentifier(currentEnv.runtimeId);
  const targetRuntimeId = normalizeRuntimeIdentifier(targetEnv.runtimeId);
  return Boolean(currentRuntimeId && targetRuntimeId && currentRuntimeId === targetRuntimeId);
};

const waitForRemoteRuntimeProjectionAtHeight = async (
  targetHeight: number | null | undefined,
): Promise<number> => {
  const target = Math.max(0, Math.floor(Number(targetHeight || 0)));
  const startedAt = Date.now();
  let latestHeight = Math.max(
    0,
    Math.floor(Number(get(runtimeView).height || get(runtimeControllerHandle).height || get(currentHeight) || 0)),
  );
  while (Date.now() - startedAt <= REMOTE_RUNTIME_PROJECTION_WAIT_TIMEOUT_MS) {
    await refreshCurrentRuntimeProjection();
    latestHeight = Math.max(
      Math.max(0, Math.floor(Number(get(runtimeView).height || 0))),
      Math.max(0, Math.floor(Number(get(runtimeControllerHandle).height || 0))),
      Math.max(0, Math.floor(Number(get(currentHeight) || 0))),
    );
    if (target <= 0 || latestHeight >= target) return latestHeight;
    await sleep(REMOTE_RUNTIME_PROJECTION_WAIT_POLL_MS);
  }
  throw new Error(`REMOTE_RUNTIME_PROJECTION_TIMEOUT: target=${target} latest=${latestHeight}`);
};

const readRemoteRuntimeReceiptStatus = async (
  receiptId: string | null | undefined,
): Promise<RuntimeReceiptStatus> => {
  const id = String(receiptId || '').trim();
  if (!id) throw new Error('REMOTE_RUNTIME_RECEIPT_ID_MISSING');
  const adapter = getRuntimeControllerAdapter();
  if (!adapter || adapter.mode !== 'remote') throw new Error('REMOTE_RUNTIME_RECEIPT_ADAPTER_MISSING');
  const receipt = await runtimeQueryClient.readReceiptStatus(id);
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('REMOTE_RUNTIME_RECEIPT_STATUS_INVALID');
  }
  return receipt;
};

const waitForRemoteRuntimeReceiptObserved = async (
  receiptId: string | null | undefined,
): Promise<RuntimeReceiptStatus | null> => {
  if (!receiptId) throw new Error('REMOTE_RUNTIME_RECEIPT_ID_MISSING');
  const startedAt = Date.now();
  let latest: RuntimeReceiptStatus | null = null;
  while (Date.now() - startedAt <= REMOTE_RUNTIME_PROJECTION_WAIT_TIMEOUT_MS) {
    latest = await readRemoteRuntimeReceiptStatus(receiptId);
    const status = String(latest.status || '').toLowerCase();
    if (status === 'observed') return latest;
    if (status === 'expired') {
      throw new Error(latest.note || 'REMOTE_RUNTIME_RECEIPT_EXPIRED');
    }
    await sleep(REMOTE_RUNTIME_PROJECTION_WAIT_POLL_MS);
  }
  throw new Error(`REMOTE_RUNTIME_RECEIPT_STATUS_TIMEOUT: status=${String(latest?.status || 'unknown')}`);
};

const routeRemoteRuntimeInput = async (input: RuntimeInput): Promise<null> => {
  const adapter = getRuntimeControllerAdapter();
  const handle = get(runtimeControllerHandle);
  if (!adapter || adapter.mode !== 'remote' || handle.mode !== 'remote') {
    throw new Error('RuntimeController remote adapter is not connected');
  }
  const runtimeId = normalizeRuntimeIdentifier(adapter.runtimeId || handle.runtimeId || handle.id) || 'remote';
  const submitted = await submitRuntimeCommand({
    input,
    runtimeId,
    mode: 'remote',
    initialHeight: Number(handle.height || 0),
  }, async (progress) => {
    const accepted = await runtimeAdapterSend(input);
    progress.accepted(accepted.height, {
      receiptId: accepted.receipt?.id ?? null,
      statusUrl: accepted.statusUrl ?? null,
    });
    const observed = await waitForRemoteRuntimeReceiptObserved(accepted.receipt?.id ?? null);
    const projectedHeight = await waitForRemoteRuntimeProjectionAtHeight(observed?.observedHeight ?? accepted.height);
    if (observed) progress.observed(Number(observed.observedHeight ?? projectedHeight));
    return null;
  });
  return submitted.result;
};

const routeRuntimeInput = async (xln: XLNModule, env: Env, input: RuntimeInput): Promise<Env | null> => {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  const adapter = getRuntimeControllerAdapter();
  const handle = get(runtimeControllerHandle);
  const targetRuntimeId = normalizeRuntimeIdentifier(runtimeEnv.runtimeId);
  const handleRuntimeId = normalizeRuntimeIdentifier(handle.id);
  const remoteAdapter = adapter?.mode === 'remote' ? adapter : null;
  const remoteControllerActive = Boolean(remoteAdapter && handle.mode === 'remote');
  if (remoteControllerActive && targetRuntimeId && handleRuntimeId && targetRuntimeId !== handleRuntimeId) {
    throw new Error(`REMOTE_RUNTIME_ENV_MISMATCH: active=${handleRuntimeId} input=${targetRuntimeId}`);
  }
  const usesRemoteAdapter = Boolean(
    remoteControllerActive &&
    remoteAdapter &&
    (!targetRuntimeId || !handleRuntimeId || targetRuntimeId === handleRuntimeId),
  );
  const submitted = await submitRuntimeCommand({
    input,
    runtimeId: targetRuntimeId || handle.id || 'embedded',
    mode: usesRemoteAdapter ? 'remote' : 'embedded',
    initialHeight: Number(runtimeEnv.height || 0),
  }, async (progress) => {
    if (usesRemoteAdapter) {
      if (!remoteAdapter) throw new Error('RuntimeController remote adapter is not connected');
      const accepted = await runtimeAdapterSend(input);
      progress.accepted(accepted.height, {
        receiptId: accepted.receipt?.id ?? null,
        statusUrl: accepted.statusUrl ?? null,
      });
      const observed = await waitForRemoteRuntimeReceiptObserved(accepted.receipt?.id ?? null);
      const projectedHeight = await waitForRemoteRuntimeProjectionAtHeight(observed?.observedHeight ?? accepted.height);
      if (observed) progress.observed(Number(observed.observedHeight ?? projectedHeight));
      return null;
    }
    if (!runtimeEnv.scenarioMode && typeof xln.startRuntimeLoop === 'function') {
      xln.startRuntimeLoop(runtimeEnv);
    }
    if (input.entityInputs?.length) {
      const ready = await waitForOpenAccountCounterpartyProfiles(runtimeEnv, input.entityInputs, OPEN_ACCOUNT_PROFILE_WAIT_TIMEOUT_MS);
      if (!ready) {
        throw new Error('OPEN_ACCOUNT_COUNTERPARTY_PROFILE_NOT_READY: counterparty jurisdiction profile is not ready');
      }
    }
    let submittedRuntimeEnv = runtimeEnv;
    if (adapter?.mode === 'embedded' && embeddedAdapterTargetsRuntimeEnv(runtimeEnv)) {
      const accepted = await runtimeAdapterSend(input);
      progress.accepted(accepted.height);
      const currentEnv = getEnv();
      submittedRuntimeEnv = currentEnv ? (unwrapLiveRuntimeEnv(currentEnv) ?? currentEnv) : runtimeEnv;
    } else {
      xln.enqueueRuntimeInput(runtimeEnv, input);
      progress.accepted(Number(runtimeEnv.height || 0));
    }
    await drainLocalRuntimeInput(xln, submittedRuntimeEnv, 'route');
    setXlnEnvironment(submittedRuntimeEnv);
    progress.committed(Number(submittedRuntimeEnv.height || 0));
    return submittedRuntimeEnv;
  });
  return submitted.result;
};

const logInterestingEntityInputs = (inputs: RoutedEntityInput[]): void => {
  const interesting = inputs
    .map((input) => ({
      entityId: String(input?.entityId || ''),
      signerId: String(input?.signerId || ''),
      txTypes: Array.isArray(input?.entityTxs) ? input.entityTxs.map((tx) => String(tx?.type || '')) : [],
  }))
    .filter((entry) => entry.txTypes.some((type) => type.startsWith('j_') || type.startsWith('dispute')));
  if (interesting.length > 0) {
    console.debug(`[xlnStore.submitEntityInputs] ${JSON.stringify(interesting)}`);
  }
};

const resolveActiveRuntimeCommandEnv = async (xln: XLNModule): Promise<Env> => {
  const selectedEnv = get(activeEnv) ?? get(xlnEnvironment);
  const runtimeEnv = selectedEnv ? (unwrapLiveRuntimeEnv(selectedEnv) ?? selectedEnv) : null;
  if (runtimeEnv) return runtimeEnv;

  const adapter = getRuntimeControllerAdapter();
  const config = getRuntimeControllerConfig();
  if (adapter?.mode === 'remote' && config?.mode === 'remote') {
    throw new Error('ACTIVE_RUNTIME_ENV_NOT_READY: remote runtime has no projected RuntimeView');
  }

  throw new Error('ACTIVE_RUNTIME_ENV_NOT_READY: RuntimeController has no active runtime env');
};

export async function submitActiveRuntimeInput(input: RuntimeInput): Promise<Env | null> {
  const adapter = getRuntimeControllerAdapter();
  const handle = get(runtimeControllerHandle);
  if (adapter?.mode === 'remote' && handle.mode === 'remote') {
    return routeRemoteRuntimeInput(input);
  }
  const xln = await getXLN();
  const env = await resolveActiveRuntimeCommandEnv(xln);
  return routeRuntimeInput(xln, env, input);
}

export async function dispatchRuntimeInputToRuntimeEnv(env: Env, input: RuntimeInput): Promise<Env | null> {
  const xln = await getXLN();
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  if (input.entityInputs?.length) {
    const ready = await waitForOpenAccountCounterpartyProfiles(runtimeEnv, input.entityInputs, OPEN_ACCOUNT_PROFILE_WAIT_TIMEOUT_MS);
    if (!ready) {
      throw new Error('OPEN_ACCOUNT_COUNTERPARTY_PROFILE_NOT_READY: counterparty jurisdiction profile is not ready');
    }
  }
  xln.enqueueRuntimeInput(runtimeEnv, input);
  await drainLocalRuntimeInput(xln, runtimeEnv, 'explicit');
  publishLocalRuntimeEnvIfActive(runtimeEnv);
  return runtimeEnv;
}

export async function submitActiveEntityInputs(inputs: RoutedEntityInput[] = []): Promise<Env | null> {
  logInterestingEntityInputs(inputs);
  return submitActiveRuntimeInput({
    runtimeTxs: [],
    entityInputs: inputs,
  });
}

export async function submitRuntimeInput(input: RuntimeInput): Promise<Env | null> {
  return submitActiveRuntimeInput(input);
}

export async function submitEntityInputs(inputs: RoutedEntityInput[] = []): Promise<Env | null> {
  logInterestingEntityInputs(inputs);
  return submitActiveEntityInputs(inputs);
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
      getKnownTokenIds: failFn('getKnownTokenIds'),
      getTokenIdsForJurisdiction: failFn('getTokenIdsForJurisdiction'),
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
    getKnownTokenIds: $xlnInstance.getKnownTokenIds,
    getTokenIdsForJurisdiction: $xlnInstance.getTokenIdsForJurisdiction,
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
