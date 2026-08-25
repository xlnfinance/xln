import { writable, derived, get } from 'svelte/store';
import { isUnknownRecord, parseJsonUnknown, readJsonUnknown } from '$lib/utils/boundary';
import { errorLog } from './errorLogStore';
import { settings } from './settingsStore';
import { activeEnv, activeRuntimeId, registerRuntimeAdapterSwitcher, runtimes, runtimeOperations } from './runtimeStore';
import { vaultOperations } from './vault/vaultStore';
import { xlnEnvironment, setXlnEnvironment } from './bootstrap/embeddedRuntimeStore';
import { toasts } from './ui/toastStore';
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
import {
  replayRuntimeCommandIntentsInOrder,
  submitRuntimeCommand,
  type RuntimeCommandExecutionOptions,
  type RuntimeCommandProgress,
} from './commands/runtimeCommandBus';
import {
  listUnresolvedRemoteRuntimeCommandIntents,
  withRemoteRuntimeCommandReplayLease,
} from './commands/runtimeCommandIntent';
import {
  isRuntimeCommandJournalUnlocked,
  signRuntimeAdapterOwnerBinding,
} from './commands/runtimeCommandJournalKeyring';
import { findPersistedEmbeddedRuntimeInputHeight } from './commands/embeddedRuntimeCommandCompletion';
import {
  REMOTE_HISTORY_SCAN_CACHE_LIMIT,
  ensureRuntimeHistoryContext,
  resetRuntimeHistoryFrames,
  runtimeHistoryFrameFromViewFrame,
  upsertRuntimeHistoryFrame,
} from './runtimeHistoryStore';
import { clearRuntimeQueryCache } from './runtimeQueryClient';
import {
  assertRuntimeViewIsLive,
  runtimeView,
  resetRuntimeView,
  resetRuntimeViewSelection,
  refreshRuntimeView,
  readRuntimeViewSelection,
  runtimeViewPublicationMatches,
  setRuntimeViewActiveEntityId,
  type RuntimeViewSelection,
} from './runtimeViewStore';
import { assertNetworkMachineIsLive, networkMachineRuntime } from './network/networkMachineRuntimeStore';
import { normalizeWsConnectUrl, normalizeWsUrl, sameWsEndpoint } from '$lib/utils/runtime/wsUrl';
import { createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/runtime/liveRuntimeEnv';
import { registerDebugSurface } from '$lib/utils/runtime/debugSurface';
import {
  decodeProtectedVaultSecrets,
  deleteVaultDeviceKey,
  protectVaultSecrets,
  unprotectVaultSecrets,
  type ProtectedVaultSecrets,
} from '$lib/security/vaultProtection';
import {
  readRemoteRuntimeTokenAccess,
  readRemoteRuntimeTokenAudience,
  resolveStoredRemoteRuntimeAuthKey,
  type RemoteRuntimeHubSummary,
} from '$lib/utils/onboarding/remoteRuntimeImport';
import {
  waitForOpenAccountCounterpartyProfiles,
} from '$lib/utils/runtime/p2pPrefetch';
import { requireTokenDecimals } from '$lib/components/Entity/token-metadata';
import { getXLN, xlnInstance } from './bootstrap/xlnRuntimeLoader';
import { parseProfile } from '@xln/core/entity/profile';
import type {
  XLNModule,
  RuntimeReplica,
  EnvSnapshot,
  RoutedEntityInput,
  RuntimeInput,
  RuntimeAdapter,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
  RuntimeAdapterStatus,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame,
  NumberedRegistrationCommand,
  NumberedRegistrationCommandResult,
  EntityDisplayInfo,
  FinancialConstants,
  CrossJurisdictionSwapRoute,
  Profile as GossipProfile,
} from '@xln/core/api/public/runtime-module';
import { REMOTE_RUNTIME } from '@xln/core/config/constants';
import {
  RUNTIME_ADAPTER_AUTH_KEY,
  RUNTIME_ADAPTER_MODE_KEY,
  RUNTIME_ADAPTER_WS_KEY,
  readRemoteRuntimeAdapterAuth,
  writeRemoteRuntimeAdapterAuth,
} from '../../../packages/browser/src/runtime-adapter-session';

let unregisterEnvChange: (() => void) | null = null;
let unregisterRuntimeControllerChange: (() => void) | null = null;
let unregisterRuntimeControllerStatus: (() => void) | null = null;
type RemoteProjectionRefreshInFlight = {
  key: string;
  promise: Promise<RuntimeReplica | null>;
};

let remoteProjectionRefreshInFlight: RemoteProjectionRefreshInFlight | null = null;
let remoteProjectionRefreshGeneration = 0;
let remoteProjectionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let remoteProjectionRefreshQueued = false;
let lastRemoteProjectionRefreshWarningAt = 0;
const RESET_NOTICE_STORAGE_KEY = 'xln-reset-notice';
const DEFAULT_REMOTE_ADAPTER_PATH = REMOTE_RUNTIME.DEFAULT_ADAPTER_PATH;
export const REMOTE_VIEW_PAGE_SIZE = REMOTE_RUNTIME.VIEW_PAGE_SIZE;
const REMOTE_PROJECTION_REFRESH_WARNING_COOLDOWN_MS = 7_500;
const FRONTEND_REMOTE_REQUEST_TIMEOUT_MS = 5_000;
const FRONTEND_REMOTE_RECONNECT_MAX_MS = 2_000;
const REMOTE_RUNTIME_PROJECTION_WAIT_TIMEOUT_MS = 5_000;
const REMOTE_RUNTIME_PROJECTION_WAIT_POLL_MS = 100;
const PAYMENT_GOSSIP_REFRESH_ATTEMPTS = 3;
const PAYMENT_GOSSIP_REFRESH_WAIT_MS = 100;
const P2P_POLL_WARNING_COOLDOWN_MS = 7_500;

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
  planSwapInboundCapacity: XLNModule['planSwapInboundCapacity'];
  readSwapAccountCapacity: XLNModule['readSwapAccountCapacity'];
  planSwapCommand: XLNModule['planSwapCommand'];
  deriveSwapNetAuthorization: XLNModule['deriveSwapNetAuthorization'];
  formatTokenAmount: (tokenId: number, amount: bigint | null | undefined) => string;
  getTokenInfo: XLNModule['getTokenInfo'];
  getKnownTokenIds: XLNModule['getKnownTokenIds'];
  getTokenIdsForJurisdiction: XLNModule['getTokenIdsForJurisdiction'];
  isLiquidSwapToken: XLNModule['isLiquidSwapToken'];
  getSwapPairOrientation: XLNModule['getSwapPairOrientation'];
  getDefaultSwapTradingPairs: XLNModule['getDefaultSwapTradingPairs'];
  listOpenSwapOffers: XLNModule['listOpenSwapOffers'];
  computeSwapPriceTicks: XLNModule['computeSwapPriceTicks'];
  getSwapLotScale: XLNModule['getSwapLotScale'];
  prepareSwapOrder: XLNModule['prepareSwapOrder'];
  quantizeSwapOrder: XLNModule['quantizeSwapOrder'];
  requantizeRemainingSwapAtPrice: XLNModule['requantizeRemainingSwapAtPrice'];
  getDefaultCreditLimit: XLNModule['getDefaultCreditLimit'];
  safeStringify: XLNModule['safeStringify'];
  parseTokenAmount: XLNModule['parseTokenAmount'];
  convertTokenPrecision: XLNModule['convertTokenPrecision'];
  FINANCIAL_CONSTANTS: FinancialConstants;
  getEntity: (entityId: string) => FrontendEntitySummary;
  getEntityShortId: XLNModule['getEntityShortId'];
  formatEntityDisplay: XLNModule['formatEntityDisplay'];
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

export { xlnEnvironment, setXlnEnvironment } from './bootstrap/embeddedRuntimeStore';

export const isLoading = writable<boolean>(true);
export const error = writable<string | null>(null);

// xlnFunctions is now defined at the end of the file

export function resolveRelayUrls(): string[] {
  if (typeof window === 'undefined') return ['wss://xln.finance/relay'];
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const relay = normalizeWsUrl(`${protocol}//${window.location.host}/relay`);
  const configured = get(settings)?.relayUrl;
  if (configured && !sameWsEndpoint(configured, relay)) {
    errorLog.log(
      `SETTINGS_MISMATCH: forcing single relay ${relay}, ignoring ${configured}`,
      'Relay Settings',
      { relay, configured },
    );
  }
  return [relay];
}

// Derived stores for convenience
export const replicas = derived(xlnEnvironment, $env => ($env ? $env.state.eReplicas : new Map()));

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
let lastP2PPollWarningAt = 0;

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
    } catch (pollError) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (lastP2PPollWarningAt === 0 || now - lastP2PPollWarningAt >= P2P_POLL_WARNING_COOLDOWN_MS) {
        lastP2PPollWarningAt = now;
        errorLog.log('P2P state poll failed', 'P2P State Poll', pollError);
      }
    }
    if (typeof window !== 'undefined' && typeof performance !== 'undefined') {
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= 32) {
        const now = performance.now();
        if (lastP2PPollWarningAt === 0 || now - lastP2PPollWarningAt >= P2P_POLL_WARNING_COOLDOWN_MS) {
          lastP2PPollWarningAt = now;
          errorLog.log(
            `slow timer xlnStore.p2pStatePoll ${elapsedMs.toFixed(1)}ms`,
            'P2P State Poll',
            { elapsedMs },
          );
        }
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

const updateLocalEnvironmentStores = (xln: XLNModule, env: RuntimeReplica): void => {
  const selectedRuntimeId = String(get(activeRuntimeId) || '').toLowerCase();
  const envRuntimeId = String(env.runtimeId || '').toLowerCase();
  if (selectedRuntimeId && selectedRuntimeId !== envRuntimeId) {
    const selected = get(runtimes).get(selectedRuntimeId);
    if (selected?.env) return;
  }

  setXlnEnvironment(env);
  // RuntimeReplica has no resident timeline. Timeline playback is populated
  // only by an explicit browser trace or persisted history query.
  history.set([]);
  currentHeight.set(env.state.height);
  if (envRuntimeId) {
    upsertRuntimeSnapshot(env, { mode: 'embedded', runtimeId: envRuntimeId }, 'connected');
  }
  runtimeOperations.updateLocalEnv(env);

  entityPositions.update(currentPositions => {
    let hasChanges = false;
    for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
      const entityId = xln.extractEntityId(replicaKey);
      if (entityId && replica.position && !currentPositions.has(entityId)) {
        const pos = replica.position;
        const jurisdiction = pos.jurisdiction || env.activeJurisdiction || 'default';
        currentPositions.set(entityId, { x: pos.x, y: pos.y, z: pos.z, jurisdiction });
        hasChanges = true;
      }
    }
    return hasChanges ? new Map(currentPositions) : currentPositions;
  });
};

const registerLocalEnvironmentCallback = (xln: XLNModule, env: RuntimeReplica): void => {
  unregisterEnvChange?.();
  unregisterEnvChange = xln.registerRuntimePublishedCallback?.(env, (notice) => {
    currentHeight.set(notice.height);
    scheduleRuntimeProjectionRefresh();
  }) || null;
};

const clearRuntimeAdapterSubscriptions = (): void => {
  unregisterRuntimeControllerChange?.();
  unregisterRuntimeControllerChange = null;
  unregisterRuntimeControllerStatus?.();
  unregisterRuntimeControllerStatus = null;
  remoteProjectionRefreshGeneration += 1;
  remoteProjectionRefreshInFlight = null;
  if (remoteProjectionRefreshTimer) {
    clearTimeout(remoteProjectionRefreshTimer);
    remoteProjectionRefreshTimer = null;
  }
  remoteProjectionRefreshQueued = false;
};

export const handleRuntimeProjectionRefreshError = (refreshError: unknown): void => {
  const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
  const isRemoteProjection = getRuntimeControllerConfig()?.mode === 'remote';
  const logMessage = isRemoteProjection
    ? `Remote runtime projection refresh failed; keeping current runtime view mounted: ${message}`
    : message;
  errorLog.log(logMessage, 'Runtime Projection Refresh', refreshError);
  if (isRemoteProjection) {
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
    if (key === RUNTIME_ADAPTER_AUTH_KEY) {
      return readRemoteRuntimeAdapterAuth({ durable: localStorage, session: sessionStorage });
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

const remoteProjectionRefreshKey = (
  config: RuntimeAdapterConfig,
  selection: RuntimeViewSelection,
): string => {
  if (config.mode !== 'remote') return 'embedded';
  const runtimeId = normalizeRuntimeConfigId(config.runtimeId || remoteRuntimeIdFromConfig(config));
  const wsUrl = normalizeWsConnectUrl(config.wsUrl || defaultRemoteAdapterWsUrl());
  const access = readRemoteRuntimeTokenAccess(config.authKey || '') || 'noauth';
  const selectedHeight = selection.atHeight ?? 'live';
  return `remote:${runtimeId}:${wsUrl}:${access}:${selection.revision}:${selection.entityId}:${selection.accountsPage}:${selection.booksPage}:${selectedHeight}`;
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

const persistEmbeddedRuntimeSeed = async (
  protectedSecrets: ProtectedVaultSecrets,
): Promise<void> => {
  try {
    localStorage.setItem(EMBEDDED_RUNTIME_SEED_STORAGE_KEY, JSON.stringify(protectedSecrets));
  } catch (error) {
    await deleteVaultDeviceKey('embedded-runtime', protectedSecrets);
    throw error;
  }
};

export const readOrCreateEmbeddedRuntimeSeed = async (): Promise<string | undefined> => {
  if (typeof window === 'undefined') return undefined;
  const stored = localStorage.getItem(EMBEDDED_RUNTIME_SEED_STORAGE_KEY)?.trim();
  if (stored) {
    if (stored.startsWith('xln-browser-runtime:')) {
      throw new Error('EMBEDDED_RUNTIME_SEED_PLAINTEXT_REJECTED');
    }
    let parsed: unknown;
    try {
      parsed = parseJsonUnknown(stored, 'EMBEDDED_RUNTIME_SEED_STORAGE_INVALID_JSON');
    } catch {
      throw new Error('EMBEDDED_RUNTIME_SEED_STORAGE_INVALID_JSON');
    }
    const protectedSecrets = decodeProtectedVaultSecrets(parsed);
    const restored = await unprotectVaultSecrets('embedded-runtime', protectedSecrets);
    if (restored?.seed) return restored.seed;
    throw new Error('EMBEDDED_RUNTIME_SEED_AUTHORITY_UNAVAILABLE');
  }
  const seed = generateEmbeddedRuntimeSeed();
  const protectedSecrets = await protectVaultSecrets('embedded-runtime', { seed }, null);
  await persistEmbeddedRuntimeSeed(protectedSecrets);
  return seed;
};

const resolveAppRuntimeAdapterConfig = async (): Promise<RuntimeAdapterConfig> => {
  if (typeof window === 'undefined') return { mode: 'embedded' };
  const remoteRequested = readStoredAdapterValue(RUNTIME_ADAPTER_MODE_KEY) === 'remote';
  if (!remoteRequested) {
    const seed = await readOrCreateEmbeddedRuntimeSeed();
    return seed ? { mode: 'embedded', seed } : { mode: 'embedded' };
  }

  const wsUrl = (readStoredAdapterValue(RUNTIME_ADAPTER_WS_KEY) || defaultRemoteAdapterWsUrl()).trim();
  const normalizedWsUrl = normalizeWsConnectUrl(wsUrl);
  const storedAuthKey = readStoredAdapterValue(RUNTIME_ADAPTER_AUTH_KEY).trim();
  let restoredAuthKey = '';
  try {
    restoredAuthKey = resolveStoredRemoteRuntimeAuthKey(normalizedWsUrl).trim();
  } catch (error) {
    if (!storedAuthKey || readRemoteRuntimeTokenAccess(storedAuthKey) !== 'admin') throw error;
  }
  if (restoredAuthKey) {
    writeRemoteRuntimeAdapterAuth(
      { durable: localStorage, session: sessionStorage },
      restoredAuthKey,
    );
  }
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
  env: RuntimeReplica,
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
    if (config.mode === 'remote' && authLevel !== 'admin') {
      throw new Error(`REMOTE_RUNTIME_ADMIN_REQUIRED:${runtimeId}`);
    }
    const remoteAccess = 'admin';
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
      permissions: 'write',
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
  if (authLevel !== 'admin') throw new Error(`REMOTE_RUNTIME_ADMIN_REQUIRED:${runtimeId}`);
  const remoteAccess = 'admin';
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
  selection: RuntimeViewSelection,
  generation: number,
): Promise<RemoteRuntimeProjectionRefresh | null> => {
  if (adapter.mode !== 'remote' || config.mode !== 'remote') {
    throw new Error('Remote projection refresh requires remote runtime adapter');
  }
  const adapterHeight = Math.max(0, Math.floor(Number(adapter.currentHeight || 0)));
  const requestedEntityId = selection.entityId;
  const runtimeId = normalizeRuntimeConfigId(adapter.runtimeId || config.runtimeId || remoteRuntimeIdFromConfig(config));
  const requestedHistoryContext = ensureRuntimeHistoryContext({
    runtimeId,
    mode: 'remote',
    entityId: selection.entityId,
    accountsPage: selection.accountsPage,
    booksPage: selection.booksPage,
  }, config.wsUrl || '');
  const viewQuery: RuntimeAdapterReadQuery = {
    limit: REMOTE_VIEW_PAGE_SIZE,
    accountsLimit: REMOTE_VIEW_PAGE_SIZE,
    booksLimit: REMOTE_VIEW_PAGE_SIZE,
    accountsPage: selection.accountsPage,
    booksPage: selection.booksPage,
  };
  const refreshView = async (entityId: string): Promise<RuntimeAdapterViewFrame | null> => {
    const view = await refreshRuntimeView(entityId ? { ...viewQuery, entityId } : viewQuery);
    // refreshRuntimeView returns the caller-owned result even when a newer read
    // won the shared store. Secondary publishers may only derive from the result
    // that is still mounted as the canonical RuntimeView.
    if (get(runtimeView) !== view) {
      // A queued height catch-up may replace the just-published object before
      // this caller resumes. Coalesce one fresh projection pass instead of
      // stranding initial remote setup on an identity-only race.
      if (
        isCurrentRuntimeAdapterConfig(config) &&
        runtimeViewPublicationMatches(generation, remoteProjectionRefreshGeneration, selection)
      ) {
        scheduleRuntimeProjectionRefresh();
      }
      return null;
    }
    if (!view.frame) {
      // A disconnect/timeout is already recorded on RuntimeView. Relabeling it as
      // "entity not found" turns adapter-switch races into unhandled pageerrors.
      const viewError = String(view.error || '');
      if (
        view.status !== 'connected' ||
        /not connected|socket closed|timed out/i.test(viewError)
      ) {
        return null;
      }
      if (entityId) {
        throw new Error(`Remote entity summary not found: ${entityId}`);
      }
      throw new Error('REMOTE_RUNTIME_VIEW_FRAME_MISSING');
    }
    return view.frame;
  };

  const publicationStillCurrent = (): boolean =>
    isCurrentRuntimeAdapterConfig(config) &&
    runtimeViewPublicationMatches(
      generation,
      remoteProjectionRefreshGeneration,
      selection,
    );
  const frame = await refreshView(requestedEntityId);
  if (!frame) return null;
  if (!publicationStillCurrent()) return null;

  const historyFrame = runtimeHistoryFrameFromViewFrame({
    runtimeId,
    mode: 'remote',
    frame,
  });
  const historyContext = historyFrame.activeEntityId && !requestedHistoryContext.entityId
    ? ensureRuntimeHistoryContext({
        ...requestedHistoryContext,
        entityId: historyFrame.activeEntityId,
      }, config.wsUrl || '')
    : requestedHistoryContext;
  upsertRuntimeHistoryFrame({
    runtimeId,
    mode: 'remote',
    frame,
    context: historyContext,
  }, REMOTE_HISTORY_SCAN_CACHE_LIMIT);
  if (historyFrame.activeEntityId) setRuntimeViewActiveEntityId(historyFrame.activeEntityId);
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
  _runtimeSeed?: string | null,
  targetEnv?: RuntimeReplica | null,
): Promise<RuntimeAdapter> => {
  let boundEnv = targetEnv ? (unwrapLiveRuntimeEnv(targetEnv) ?? targetEnv) : null;
  if (!boundEnv) {
    const env = getEnv();
    boundEnv = env ? (unwrapLiveRuntimeEnv(env) ?? env) : null;
  }
  if (!boundEnv) {
    // No ad-hoc env construction here: the only way to obtain a correctly
    // restored env (real signer keys, not just the generic index sweep) is
    // the canonical vault restore path in switchAppRuntimeAdapter,
    // which always builds/passes targetEnv before this function is called.
    throw new Error('EMBEDDED_RUNTIME_ADAPTER_ENV_MISSING: caller must restore env via the canonical runtime-selection path before requesting an adapter');
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
    validateRuntimeInputAdmission: (env, input) =>
      xln.validateRuntimeInputAdmission(unwrapLiveRuntimeEnv(env) ?? env, input),
    enqueueRuntimeInput: (env, input) => xln.enqueueRuntimeInput(unwrapLiveRuntimeEnv(env) ?? env, input),
    submitCrossJurisdictionIntent: async (env, route) => {
      await xln.submitCrossJurisdictionIntent(unwrapLiveRuntimeEnv(env) ?? env, route);
      return { delivered: true };
    },
    controlRuntime: (env, action) => {
      if (action !== 'verify-chain') throw new Error(`UNSUPPORTED_RUNTIME_CONTROL:${action}`);
      return xln.verifyLiveRuntimeStorage(env);
    },
    registerRuntimePublishedCallback: (env, cb) => xln.registerRuntimePublishedCallback(env, cb),
    buildReadContext: (env) => ({
      readHead: () => xln.readPersistedStorageHead(env),
      readFrame: (height) => xln.readPersistedStorageFrameRecord(env, height),
      listCheckpoints: () => xln.listPersistedCheckpointHeights(env),
      loadEntityState: (entityId, height) => xln.loadEntityStateFromStorageDb(env, entityId, height),
      loadEntityAccountDoc: (entityId, counterpartyId, height) => xln.loadEntityAccountDocFromStorageDb(env, entityId, counterpartyId, height),
      loadEntityViewPage: (entityId, height, query) => xln.loadEntityViewPageFromStorageDb(env, entityId, height, query),
      listEntityIdsAtHeight: (height) => xln.listPersistedEntityIdsAtHeight(env, height),
      readActivityPage: (opts) => xln.readPersistedRuntimeActivityPage(env, opts),
      readAccountSwapHistoryPage: (entityId, counterpartyId, opts) =>
        xln.readPersistedAccountSwapHistoryPage(env, entityId, counterpartyId, opts),
    }),
  });
};

export const switchAppRuntimeAdapter = async (config: RuntimeAdapterConfig): Promise<RuntimeReplica | null> => {
  const normalizedConfig: RuntimeAdapterConfig = config.mode === 'remote'
    ? {
        mode: 'remote',
        ...(config.runtimeId ? { runtimeId: normalizeRuntimeConfigId(config.runtimeId) } : {}),
        wsUrl: normalizeWsConnectUrl(config.wsUrl || defaultRemoteAdapterWsUrl()),
        ...(config.authKey ? { authKey: config.authKey } : {}),
        ownerBindingSigner: config.ownerBindingSigner ?? (({ runtimeId, challenge, capability }) =>
          isRuntimeCommandJournalUnlocked(runtimeId)
            ? signRuntimeAdapterOwnerBinding(runtimeId, challenge, capability)
            : null),
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
    const authenticatedRemoteAccess = adapter.authLevel;
    if (authenticatedRemoteAccess !== 'admin') {
      throw new Error(`REMOTE_RUNTIME_ADMIN_REQUIRED:${adapter.runtimeId || remoteRuntimeIdFromConfig(normalizedConfig)}`);
    }
    // A transient socket loss clears the adapter's current auth handshake, not
    // the capability that was already authenticated for this runtime session.
    // Keep the projection's admin authority while commandReady independently
    // fail-closes every mutation until reconnect + re-auth completes.
    unregisterRuntimeControllerChange = onRuntimeControllerChange(() => {
      scheduleRuntimeProjectionRefresh();
    });
    unregisterRuntimeControllerStatus = onRuntimeControllerStatus((status) => {
      if (!isCurrentRuntimeAdapterConfig(normalizedConfig)) return;
      upsertRemoteRuntimeProjectionMetadata(normalizedConfig, status, authenticatedRemoteAccess, {
        runtimeId: adapter.runtimeId || remoteRuntimeIdFromConfig(normalizedConfig),
      });
      if (status === 'connected') scheduleRuntimeProjectionRefresh();
    });

    const remoteRuntimeId = normalizeRuntimeConfigId(
      adapter.runtimeId || remoteRuntimeIdFromConfig(normalizedConfig),
    );
    try {
      await refreshCurrentRuntimeProjection();
    } catch (initialRemoteError) {
      const message = initialRemoteError instanceof Error ? initialRemoteError.message : String(initialRemoteError);
      errorLog.log(message, 'Runtime Initial Projection', initialRemoteError);
      error.set(message);
      isLoading.set(false);
      throw initialRemoteError;
    }
    if (isRuntimeCommandJournalUnlocked(remoteRuntimeId)) {
      await resumeRemoteRuntimeCommandIntents(remoteRuntimeId);
    } else {
      console.debug(`[xlnStore] remote command replay deferred until vault unlock: ${remoteRuntimeId}`);
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
  if (!env && selectedRuntimeId) {
    // Canonical restore only: registers the runtime's real signer keys
    // (not just the generic HD-index sweep) before any replay can run.
    // Never construct an env for a known local runtime any other way.
    await vaultOperations.prepareRuntimeForAdapterSwitch(selectedRuntimeId);
    const restored = get(runtimes).get(selectedRuntimeId);
    env = restored?.type === 'local' ? (unwrapLiveRuntimeEnv(restored.env) ?? restored.env) : null;
    if (!env) {
      throw new Error(`EMBEDDED_RUNTIME_ENV_RESTORE_FAILED: selectRuntime completed but no local env is cached for ${selectedRuntimeId}`);
    }
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

export const refreshCurrentRuntimeProjection = async (): Promise<RuntimeReplica | null> => {
  const config = getRuntimeControllerConfig();
  if (config?.mode !== 'remote') return get(xlnEnvironment);
  const selection = readRuntimeViewSelection();
  const refreshKey = remoteProjectionRefreshKey(config, selection);
  if (remoteProjectionRefreshInFlight?.key === refreshKey) {
    return remoteProjectionRefreshInFlight.promise;
  }
  const generation = ++remoteProjectionRefreshGeneration;
  const promise = (async () => {
    // Capture adapter only after the config is still current. An in-flight H1
    // refresh that resumes after H2 connect would otherwise query H2 with H1's
    // entity id and throw `Remote entity summary not found`.
    if (!isCurrentRuntimeAdapterConfig(config)) return null;
    const adapter = getRuntimeControllerAdapter();
    if (!adapter || adapter.mode !== 'remote') return null;
    const projection = await refreshRemoteRuntimeProjection(adapter, config, selection, generation);
    if (
      !projection ||
      generation !== remoteProjectionRefreshGeneration ||
      !isCurrentRuntimeAdapterConfig(config)
    ) return null;
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
export async function initializeXLN(): Promise<RuntimeReplica | null> {
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
      importSource.searchParams.set('access', 'admin');
      void runtimeOperations.hydrateRemoteRuntimeImportSource(importSource.toString(), { optional: true });
    }

    const adapterConfig = await resolveAppRuntimeAdapterConfig();
    if (adapterConfig.mode === 'remote') {
      return await switchAppRuntimeAdapter(adapterConfig);
    }

    // Load from IndexedDB - main() handles DB timeout internally
    let env: RuntimeReplica;
    try {
      const knownRuntimeId = String(get(activeRuntimeId) || '').toLowerCase();
      if (knownRuntimeId) {
        // A real user identity is already selected (vaultOperations.initialize()
        // runs before this in bootApp()): canonical restore only, never the
        // ambient generated-on-demand embedded-seed identity below.
        await vaultOperations.selectRuntime(knownRuntimeId);
        const restored = get(runtimes).get(knownRuntimeId);
        const restoredEnv = restored?.type === 'local'
          ? (unwrapLiveRuntimeEnv(restored.env) ?? restored.env)
          : null;
        if (!restoredEnv) {
          throw new Error(`XLN_INIT_ENV_RESTORE_FAILED: selectRuntime completed but no local env is cached for ${knownRuntimeId}`);
        }
        env = restoredEnv;
      } else {
        env = await xln.main(adapterConfig.seed ?? null);
      }
    } catch (restoreError) {
      if (!isFinancialRestoreFailure(restoreError)) {
        throw restoreError;
      }
      errorLog.log(
        'Financial restore failure; refusing automatic local data reset',
        'XLN Restore',
        restoreError,
      );
      throw restoreError;
    }

    // Register callback for THIS env instance (runtime API is env-scoped)
    registerLocalEnvironmentCallback(xln, env);

    // Set all stores immediately (no derived timing races)
    updateLocalEnvironmentStores(xln, env);

    // Extract positions from initial load as well
    // Positions are RELATIVE to j-machine - store jReplica reference for world position calculation
    const initialPositions = new Map<string, RelativeEntityPosition>();
    for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
      const entityId = xln.extractEntityId(replicaKey); // Uses ids.ts - no split
      if (entityId && replica.position) {
        const pos = replica.position;
        // Store relative position + jReplica reference (defaults to activeJurisdiction)
        const jurisdiction = pos.jurisdiction || env.activeJurisdiction || 'default';
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
      errorLog.log(
        'Embedded runtime adapter failed to connect; local env remains usable',
        'Runtime Adapter Connect',
        adapterError,
      );
    }

    error.set(null);
    isLoading.set(false);

    // P2P is started per-runtime in vaultStore.createRuntime() and initialize()
    // No need to start P2P on xlnStore's env — it's not a runtime env

    isInitialized = true;
    startP2PPoll();
    return env;
  } catch (err) {
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
export function getEnv(): RuntimeReplica | null {
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
  const p2p = env?.infrastructure?.p2p;
  if (typeof p2p?.sendDebugEvent !== 'function') return;
  try {
    p2p.sendDebugEvent(payload);
  } catch (error) {
    errorLog.log('Runtime debug event dispatch failed', 'Runtime Debug Event', error);
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
      const payload = await readJsonUnknown(response);
      if (!isUnknownRecord(payload)) {
        throw new Error(`PAYMENT_GOSSIP_RESPONSE_INVALID: entity=${entityId}`);
      }
      if (payload['profile'] !== undefined && payload['profile'] !== null) {
        profiles.push(parseProfile(payload['profile']));
      }
      if (payload['peers'] !== undefined) {
        if (!Array.isArray(payload['peers'])) {
          throw new Error(`PAYMENT_GOSSIP_PEERS_INVALID: entity=${entityId}`);
        }
        profiles.push(...payload['peers'].map(parseProfile));
      }
    } catch (error) {
      errorLog.log('Payment gossip profile fetch failed', 'Payment Gossip', { entityId, error });
    }
  }
  return profiles;
}

const announcePaymentGossipProfiles = (env: RuntimeReplica, profiles: GossipProfile[]): number => {
  if (typeof env.gossip?.announce !== 'function') return 0;
  let announced = 0;
  for (const profile of profiles) {
    if (!profile?.entityId) continue;
    try {
      env.gossip.announce(profile);
      announced += 1;
    } catch (error) {
      errorLog.log('Payment gossip profile announce failed', 'Payment Gossip', {
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
  runtimeEnv?: RuntimeReplica | null;
  onDebug?: (code: string, message: string, details?: Record<string, unknown>) => void;
}): Promise<{ profiles: GossipProfile[]; announced: number }> {
  // Payment commands may target an explicitly selected embedded Runtime while
  // the global store is publishing a newer projection. Profiles must be
  // installed into the exact live Runtime that will materialize the HTLC.
  const env = options.runtimeEnv ?? getEnv();
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
    await env.infrastructure?.p2p?.syncProfiles?.();
  } catch (error) {
    errorLog.log('Payment gossip p2p sync failed', 'Payment Gossip', error);
  }

  if (targetEntities.length > 0 && typeof xln?.ensureGossipProfiles === 'function') {
    options.onDebug?.('PAYMENT_PREFLIGHT_GOSSIP_FETCH', `Fetching gossip profiles (${options.reason})`, {
      targetEntities,
    });
    try {
      const resolved = await xln.ensureGossipProfiles(env, targetEntities);
      if (resolved) return { profiles: Array.from(mergedProfiles.values()), announced };
    } catch (error) {
      errorLog.log('Payment gossip targeted ensure failed', 'Payment Gossip', { targetEntities, error });
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
      errorLog.log('Payment gossip runtime refresh failed', 'Payment Gossip', error);
    }
    try {
      env.infrastructure?.p2p?.refreshGossip?.();
    } catch (error) {
      errorLog.log('Payment gossip p2p refresh failed', 'Payment Gossip', error);
    }
    await sleep(PAYMENT_GOSSIP_REFRESH_WAIT_MS);
    if (targetEntities.length > 0) {
      mergeProfiles(await fetchPaymentGossipProfiles(targetEntities));
    }
  }

  return { profiles: Array.from(mergedProfiles.values()), announced };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const publishLocalRuntimeEnvIfActive = (env: RuntimeReplica): void => {
  const runtimeId = normalizeRuntimeIdentifier(env.runtimeId);
  if (runtimeId) runtimeOperations.updateRuntimeEnv(runtimeId, env);
  if (!runtimeId || normalizeRuntimeIdentifier(get(activeRuntimeId)) === runtimeId) {
    setXlnEnvironment(env);
  }
};

const drainLocalRuntimeInput = async (
  xln: XLNModule,
  env: RuntimeReplica,
  input: RuntimeInput,
  afterHeight: number,
): Promise<number> => {
  const startedAt = Date.now();
  for (let i = 0; i < 80; i += 1) {
    const persistedHeight = await findPersistedEmbeddedRuntimeInputHeight(
      (height) => xln.readPersistedStorageFrameRecord(env, height),
      input,
      afterHeight,
      Math.max(afterHeight, Math.floor(Number(env.state.height || 0))),
    );
    if (persistedHeight !== null) return persistedHeight;
    // The runtime loop created with this RuntimeReplica is the only owner allowed to call
    // process(). Command submission only enqueues and observes its durable
    // commit; a UI waiter must never become a second transition driver.
    await sleep(25);
    if (Date.now() - startedAt > 4_000) break;
  }
  throw new Error(
    `LOCAL_RUNTIME_INPUT_COMMIT_TIMEOUT: after=${afterHeight} latest=${Math.max(0, Number(env.state.height || 0))}`,
  );
};

const normalizeRuntimeIdentifier = (value: unknown): string => String(value || '').trim().toLowerCase();

const assertLocalRuntimeInputIngressOpen = (env: RuntimeReplica): void => {
  if (env.infrastructure?.persistenceQuiescing && !env.scenarioMode) {
    throw new Error(`LOCAL_RUNTIME_INPUT_INGRESS_QUIESCING:${env.runtimeId || '<unknown>'}`);
  }
};

const embeddedAdapterTargetsRuntimeEnv = (targetEnv: RuntimeReplica): boolean => {
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

const observeRemoteRuntimeCommand = async (
  accepted: Awaited<ReturnType<typeof runtimeAdapterSend>>,
  progress: RuntimeCommandProgress,
): Promise<void> => {
  await progress.accepted(accepted.height);
  // The server returns the committed head before queueing. The command can
  // first affect H+1; observe that real Runtime projection, never a transport
  // receipt that merely says bytes reached an ingress queue.
  const projectedHeight = await waitForRemoteRuntimeProjectionAtHeight(accepted.height + 1);
  await progress.observed(projectedHeight);
};

const routeRemoteRuntimeInput = async (
  input: RuntimeInput,
  commandOptions: RuntimeCommandExecutionOptions = {},
): Promise<null> => {
  const adapter = getRuntimeControllerAdapter();
  const handle = get(runtimeControllerHandle);
  if (!adapter || adapter.mode !== 'remote' || handle.mode !== 'remote') {
    throw new Error('RuntimeController remote adapter is not connected');
  }
  const runtimeId = normalizeRuntimeIdentifier(adapter.runtimeId || handle.runtimeId || handle.id) || 'remote';
  const serverFingerprint = adapter.serverFingerprint;
  if (!serverFingerprint) throw new Error('REMOTE_RUNTIME_SERVER_IDENTITY_REQUIRED');
  const journalUnlocked = isRuntimeCommandJournalUnlocked(runtimeId);
  if (journalUnlocked) {
    await adapter.ensureOwnerCommandLane();
    if (adapter.commandLaneKind !== 'owner') {
      throw new Error(`REMOTE_COMMAND_OWNER_LANE_REQUIRED:${runtimeId}`);
    }
  }
  const submitted = await submitRuntimeCommand({
    input,
    runtimeId,
    mode: 'remote',
    serverFingerprint,
    nextCommandSequence: adapter.nextCommandSequence,
    ...(!journalUnlocked ? { remoteJournalMode: 'one-shot' as const } : {}),
    initialHeight: Number(handle.height || 0),
    ...commandOptions,
  }, async (progress, receipt) => {
    if (receipt.commandSequence === null) throw new Error('RUNTIME_COMMAND_RECEIPT_SEQUENCE_MISSING');
    const accepted = await runtimeAdapterSend(input, {
      commandId: receipt.commandId,
      commandSequence: receipt.commandSequence,
    });
    await observeRemoteRuntimeCommand(accepted, progress);
    return null;
  });
  return submitted.result;
};

export const resumeRemoteRuntimeCommandIntents = async (runtimeId: string): Promise<number> => {
  const normalizedRuntimeId = normalizeRuntimeIdentifier(runtimeId);
  if (!normalizedRuntimeId) throw new Error('RUNTIME_COMMAND_RESUME_RUNTIME_ID_MISSING');
  const adapter = getRuntimeControllerAdapter();
  if (!adapter || adapter.mode !== 'remote') throw new Error('REMOTE_RUNTIME_RECEIPT_ADAPTER_MISSING');
  const serverFingerprint = adapter.serverFingerprint;
  if (!serverFingerprint) throw new Error('REMOTE_RUNTIME_SERVER_IDENTITY_REQUIRED');
  return withRemoteRuntimeCommandReplayLease(normalizedRuntimeId, async () => {
    const intents = await listUnresolvedRemoteRuntimeCommandIntents(normalizedRuntimeId, serverFingerprint);
    await replayRuntimeCommandIntentsInOrder(intents, async (intent) => {
      await routeRemoteRuntimeInput(intent.input, {
        commandId: intent.commandId,
        commandSequence: intent.commandSequence,
      });
    });
    return intents.length;
  });
};

const routeRuntimeInput = async (
  xln: XLNModule,
  env: RuntimeReplica,
  input: RuntimeInput,
  commandOptions: RuntimeCommandExecutionOptions = {},
): Promise<RuntimeReplica | null> => {
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
  if (!usesRemoteAdapter) assertLocalRuntimeInputIngressOpen(runtimeEnv);
  const serverFingerprint = usesRemoteAdapter ? remoteAdapter?.serverFingerprint : null;
  if (usesRemoteAdapter && !serverFingerprint) throw new Error('REMOTE_RUNTIME_SERVER_IDENTITY_REQUIRED');
  const runtimeId = targetRuntimeId || handle.id || 'embedded';
  const remoteJournalUnlocked = usesRemoteAdapter
    ? isRuntimeCommandJournalUnlocked(runtimeId)
    : false;
  if (usesRemoteAdapter && remoteJournalUnlocked) {
    if (!remoteAdapter) throw new Error('RuntimeController remote adapter is not connected');
    await remoteAdapter.ensureOwnerCommandLane();
    if (remoteAdapter.commandLaneKind !== 'owner') {
      throw new Error(`REMOTE_COMMAND_OWNER_LANE_REQUIRED:${runtimeId}`);
    }
  }
  const submitted = await submitRuntimeCommand({
    input,
    runtimeId,
    mode: usesRemoteAdapter ? 'remote' : 'embedded',
    ...(serverFingerprint ? { serverFingerprint } : {}),
    ...(remoteAdapter ? { nextCommandSequence: remoteAdapter.nextCommandSequence } : {}),
    ...(usesRemoteAdapter && !remoteJournalUnlocked ? { remoteJournalMode: 'one-shot' as const } : {}),
    initialHeight: Number(runtimeEnv.state.height || 0),
    ...commandOptions,
  }, async (progress, receipt) => {
    if (usesRemoteAdapter) {
      if (!remoteAdapter) throw new Error('RuntimeController remote adapter is not connected');
      if (receipt.commandSequence === null) throw new Error('RUNTIME_COMMAND_RECEIPT_SEQUENCE_MISSING');
      const accepted = await runtimeAdapterSend(input, {
        commandId: receipt.commandId,
        commandSequence: receipt.commandSequence,
      });
      await observeRemoteRuntimeCommand(accepted, progress);
      return null;
    }
    assertLocalRuntimeInputIngressOpen(runtimeEnv);
    if (input.entityInputs?.length) {
      const ready = await waitForOpenAccountCounterpartyProfiles(runtimeEnv, input.entityInputs);
      if (!ready) {
        throw new Error('OPEN_ACCOUNT_COUNTERPARTY_PROFILE_NOT_READY: counterparty jurisdiction profile is not ready');
      }
    }
    assertLocalRuntimeInputIngressOpen(runtimeEnv);
    let submittedRuntimeEnv = runtimeEnv;
    const submittedAfterHeight = Math.max(0, Math.floor(Number(runtimeEnv.state.height || 0)));
    if (adapter?.mode === 'embedded' && embeddedAdapterTargetsRuntimeEnv(runtimeEnv)) {
      const accepted = await runtimeAdapterSend(input, { commandId: receipt.commandId });
      await progress.accepted(accepted.height);
      const currentEnv = getEnv();
      submittedRuntimeEnv = currentEnv ? (unwrapLiveRuntimeEnv(currentEnv) ?? currentEnv) : runtimeEnv;
    } else {
      xln.enqueueRuntimeInput(runtimeEnv, input);
      await progress.accepted(Number(runtimeEnv.state.height || 0));
    }
    const committedHeight = await drainLocalRuntimeInput(
      xln,
      submittedRuntimeEnv,
      input,
      submittedAfterHeight,
    );
    setXlnEnvironment(submittedRuntimeEnv);
    await progress.committed(committedHeight);
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

const resolveActiveRuntimeCommandEnv = async (_xln: XLNModule): Promise<RuntimeReplica> => {
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

/**
 * Keeps the live RuntimeReplica and registration adapter behind the runtime-controller
 * boundary. Formation UI supplies intent plus the unlocked vault identity; it
 * must never reach into an embedded RuntimeReplica to choose registration authority.
 */
export const registerActiveNumberedEntities = async (
  input: NumberedRegistrationCommand,
  expectedRuntimeId: string,
): Promise<NumberedRegistrationCommandResult> => {
  vaultOperations.assertRuntimeAuthority(expectedRuntimeId);
  const adapter = getRuntimeControllerAdapter();
  if (!adapter) throw new Error('NUMBERED_ENTITY_RUNTIME_ADAPTER_MISSING');
  const expected = String(expectedRuntimeId || '').trim().toLowerCase();
  const actual = String(adapter.runtimeId || '').trim().toLowerCase();
  if (!expected || !actual || expected !== actual) {
    throw new Error(`NUMBERED_ENTITY_RUNTIME_VAULT_MISMATCH:vault=${expected || '<missing>'}:runtime=${actual || '<missing>'}`);
  }
  await adapter.ensureOwnerCommandLane();
  return adapter.registerNumberedEntities(input);
};

export async function submitActiveRuntimeInput(
  input: RuntimeInput,
  commandOptions: RuntimeCommandExecutionOptions = {},
): Promise<RuntimeReplica | null> {
  assertRuntimeViewIsLive(get(runtimeView));
  assertNetworkMachineIsLive(get(networkMachineRuntime));
  const adapter = getRuntimeControllerAdapter();
  const handle = get(runtimeControllerHandle);
  if (adapter?.mode === 'remote' && handle.mode === 'remote') {
    return routeRemoteRuntimeInput(input, commandOptions);
  }
  vaultOperations.assertRuntimeAuthority(handle.runtimeId);
  const xln = await getXLN();
  const env = await resolveActiveRuntimeCommandEnv(xln);
  return routeRuntimeInput(xln, env, input, commandOptions);
}

async function waitForActiveRuntimeDrained(timeoutMs = 1_000): Promise<boolean> {
  const xln = await getXLN();
  const env = await resolveActiveRuntimeCommandEnv(xln);
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  const fatalPayload = (): unknown => runtimeEnv.infrastructure?.fatalDebugPayload ?? null;
  if (runtimeEnv.infrastructure?.halted) {
    throw new Error(`ACTIVE_RUNTIME_HALTED:${xln.safeStringify(fatalPayload())}`);
  }
  xln.startRuntimeLoop(runtimeEnv);
  const drained = await xln.waitForRuntimeWorkDrained(runtimeEnv, timeoutMs);
  if (runtimeEnv.infrastructure?.halted) {
    throw new Error(`ACTIVE_RUNTIME_HALTED:${xln.safeStringify(fatalPayload())}`);
  }
  return drained;
}

async function waitForActiveRuntimeProcessingIdle(timeoutMs = 1_000): Promise<boolean> {
  const xln = await getXLN();
  const env = await resolveActiveRuntimeCommandEnv(xln);
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  const fatalPayload = (): unknown => runtimeEnv.infrastructure?.fatalDebugPayload ?? null;
  if (runtimeEnv.infrastructure?.halted) {
    throw new Error(`ACTIVE_RUNTIME_HALTED:${xln.safeStringify(fatalPayload())}`);
  }
  xln.startRuntimeLoop(runtimeEnv);
  const idle = await xln.waitForRuntimeProcessingIdle(runtimeEnv, timeoutMs);
  if (runtimeEnv.infrastructure?.halted) {
    throw new Error(`ACTIVE_RUNTIME_HALTED:${xln.safeStringify(fatalPayload())}`);
  }
  return idle;
}

export async function dispatchRuntimeInputToRuntimeEnv(env: RuntimeReplica, input: RuntimeInput): Promise<RuntimeReplica | null> {
  assertRuntimeViewIsLive(get(runtimeView));
  assertNetworkMachineIsLive(get(networkMachineRuntime));
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  assertLocalRuntimeInputIngressOpen(runtimeEnv);
  const xln = await getXLN();
  assertLocalRuntimeInputIngressOpen(runtimeEnv);
  if (input.entityInputs?.length) {
    const ready = await waitForOpenAccountCounterpartyProfiles(runtimeEnv, input.entityInputs);
    if (!ready) {
      throw new Error('OPEN_ACCOUNT_COUNTERPARTY_PROFILE_NOT_READY: counterparty jurisdiction profile is not ready');
    }
  }
  assertLocalRuntimeInputIngressOpen(runtimeEnv);
  const submittedAfterHeight = Math.max(0, Math.floor(Number(runtimeEnv.state.height || 0)));
  xln.enqueueRuntimeInput(runtimeEnv, input);
  await drainLocalRuntimeInput(xln, runtimeEnv, input, submittedAfterHeight);
  publishLocalRuntimeEnvIfActive(runtimeEnv);
  return runtimeEnv;
}

export async function submitActiveEntityInputs(inputs: RoutedEntityInput[] = []): Promise<RuntimeReplica | null> {
  logInterestingEntityInputs(inputs);
  return submitActiveRuntimeInput({
    runtimeTxs: [],
    entityInputs: inputs,
  });
}

export async function submitRuntimeInput(
  input: RuntimeInput,
  commandOptions: RuntimeCommandExecutionOptions = {},
): Promise<RuntimeReplica | null> {
  return submitActiveRuntimeInput(input, commandOptions);
}

export async function submitActiveCrossJurisdictionIntent(
  route: CrossJurisdictionSwapRoute,
  options: Readonly<{ waitForTargetReady?: boolean }> = {},
): Promise<void> {
  assertRuntimeViewIsLive(get(runtimeView));
  assertNetworkMachineIsLive(get(networkMachineRuntime));
  const adapter = getRuntimeControllerAdapter();
  const handle = get(runtimeControllerHandle);
  if (adapter?.mode !== 'remote' || handle.mode !== 'remote') {
    vaultOperations.assertRuntimeAuthority(handle.runtimeId);
  }
  if (!adapter || adapter.status !== 'connected') {
    throw new Error('CROSS_J_INTENT_RUNTIME_ADAPTER_NOT_CONNECTED');
  }
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      await adapter.submitCrossJurisdictionIntent(route);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.waitForTargetReady || !message.startsWith('CROSS_J_TARGET_INBOUND_NOT_READY:')) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`CROSS_J_TARGET_READINESS_TIMEOUT:${message}`, { cause: error });
      }
      // Opening an Account is a bilateral proposal/ack exchange. The check
      // above is side-effect free until that Account is committed, so retrying
      // it cannot duplicate an intent or observe an in-flight Runtime frame.
      await sleep(100);
    }
  }
}

export async function submitEntityInputs(inputs: RoutedEntityInput[] = []): Promise<RuntimeReplica | null> {
  logInterestingEntityInputs(inputs);
  return submitActiveEntityInputs(inputs);
}

// Local browser QA must enter through the same command bus as production UI.
// View snapshots are intentionally detached and are never mutation authority.
registerDebugSurface('runtimeIngress', () => ({
  submit: submitActiveRuntimeInput,
  waitForProcessingIdle: waitForActiveRuntimeProcessingIdle,
  waitForDrained: waitForActiveRuntimeDrained,
}));

// === FRONTEND UTILITY FUNCTIONS ===
// Derived store that provides utility functions for components
export const xlnFunctions = derived([xlnInstance, settings], ([$xlnInstance, $settings]): FrontendXlnFunctions => {
  const clampPrecision = (value: number): number => Math.max(2, Math.min(18, Math.floor(Number(value) || 2)));
  const settingPrecision = clampPrecision(Number($settings?.tokenPrecision ?? 4));
  const formatRawAmount = (rawAmount: bigint, decimals: number, precisionLimit: number): string => {
    const safeDecimals = requireTokenDecimals(decimals, 'formatRawAmount');
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
  // No mock math, no fake token/entity formatting, no substitute data.
  if (!$xlnInstance) {
    const fail = (fnName: string): never => {
      throw new Error(`XLN_NOT_READY:${fnName}`);
    };
    const failFn = (fnName: string): (() => never) => () => fail(fnName);

    return {
      deriveDelta: failFn('deriveDelta'),
      planSwapInboundCapacity: failFn('planSwapInboundCapacity'),
      readSwapAccountCapacity: failFn('readSwapAccountCapacity'),
      planSwapCommand: failFn('planSwapCommand'),
      deriveSwapNetAuthorization: failFn('deriveSwapNetAuthorization'),
      formatTokenAmount: failFn('formatTokenAmount'),
      getTokenInfo: failFn('getTokenInfo'),
      getKnownTokenIds: failFn('getKnownTokenIds'),
      getTokenIdsForJurisdiction: failFn('getTokenIdsForJurisdiction'),
      isLiquidSwapToken: failFn('isLiquidSwapToken'),
      getSwapPairOrientation: failFn('getSwapPairOrientation'),
      getDefaultSwapTradingPairs: failFn('getDefaultSwapTradingPairs'),
      listOpenSwapOffers: failFn('listOpenSwapOffers'),
      computeSwapPriceTicks: failFn('computeSwapPriceTicks'),
      getSwapLotScale: failFn('getSwapLotScale'),
      prepareSwapOrder: failFn('prepareSwapOrder'),
      quantizeSwapOrder: failFn('quantizeSwapOrder'),
      requantizeRemainingSwapAtPrice: failFn('requantizeRemainingSwapAtPrice'),
      getDefaultCreditLimit: failFn('getDefaultCreditLimit'),
      safeStringify: failFn('safeStringify'),
      parseTokenAmount: failFn('parseTokenAmount'),
      convertTokenPrecision: failFn('convertTokenPrecision'),
      FINANCIAL_CONSTANTS: {} as FinancialConstants,
      getEntity: failFn('getEntity'),
      getEntityShortId: failFn('getEntityShortId'),
      formatEntityDisplay: failFn('formatEntityDisplay'),
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
    const tokenInfo = $xlnInstance.getTokenInfo(tokenId);
    const decimals = requireTokenDecimals(tokenInfo.decimals, `token:${tokenId}`);
    const numeric = formatRawAmount(amount ?? 0n, decimals, settingPrecision);
    return `${numeric} ${tokenInfo.symbol}`;
  };

  const readyFunctions: FrontendXlnFunctions = {
    // Account utilities
    deriveDelta: $xlnInstance.deriveDelta,
    planSwapInboundCapacity: $xlnInstance.planSwapInboundCapacity,
    readSwapAccountCapacity: $xlnInstance.readSwapAccountCapacity,
    planSwapCommand: $xlnInstance.planSwapCommand,
    deriveSwapNetAuthorization: $xlnInstance.deriveSwapNetAuthorization,
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
    getSwapLotScale: $xlnInstance.getSwapLotScale,
    prepareSwapOrder: $xlnInstance.prepareSwapOrder,
    quantizeSwapOrder: $xlnInstance.quantizeSwapOrder,
    requantizeRemainingSwapAtPrice: $xlnInstance.requantizeRemainingSwapAtPrice,
    getDefaultCreditLimit: $xlnInstance.getDefaultCreditLimit,
    safeStringify: $xlnInstance.safeStringify,

    // Financial utilities (ethers.js-based, precision-safe)
    parseTokenAmount: $xlnInstance.parseTokenAmount,
    convertTokenPrecision: $xlnInstance.convertTokenPrecision,
    FINANCIAL_CONSTANTS: $xlnInstance.FINANCIAL_CONSTANTS,

    // Entity utilities - UNIFIED ENTITY ACCESS
    getEntity: (entityId: string) => {
      try {
        const shortId = $xlnInstance.getEntityShortId(entityId);
        if (!shortId) {
          throw new Error(`FINTECH-SAFETY: getEntityShortId returned empty: ${shortId}`);
        }
        return {
          id: entityId,
          shortId,
          display: entityId,
          avatar: $xlnInstance.generateEntityAvatar(entityId),
          info: $xlnInstance.getEntityDisplayInfo(entityId),
        };
      } catch (error) {
        errorLog.log('FINTECH-SAFETY: Entity access failed', 'Entity Access', error);
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
        errorLog.log('FINTECH-SAFETY: Entity ID extraction failed', 'Entity Access', error);
        throw error; // Fail fast - don't hide errors
      }
    },

    formatEntityDisplay: $xlnInstance.formatEntityDisplay,

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
