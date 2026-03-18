import { writable, derived, get } from 'svelte/store';
import { errorLog } from './errorLogStore';
import { settings } from './settingsStore';
import { activeRuntimeId, runtimes, runtimeOperations } from './runtimeStore';
import { toasts } from './toastStore';
import { resetEverything } from '$lib/utils/resetEverything';
import type {
  XLNModule,
  Env,
  EnvSnapshot,
  EntityId,
  ReplicaKey,
  RoutedEntityInput,
  RuntimeInput,
  EntityDisplayInfo,
  SignerDisplayInfo,
  BigIntMathUtils,
  FinancialConstants,
} from '@xln/runtime/xln-api';

// Direct import of XLN runtime module (no wrapper boilerplate needed)
let XLN: XLNModule | null = null;
let xlnLoadPromise: Promise<XLNModule> | null = null;
export const xlnInstance = writable<XLNModule | null>(null);
let unregisterEnvChange: (() => void) | null = null;
const REQUIRED_RUNTIME_SCHEMA_VERSION = 3;
const DEV_SESSION_STORAGE_KEY = 'xln-dev-session-id';
const RESET_NOTICE_STORAGE_KEY = 'xln-reset-notice';
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
let devSessionMonitor: ReturnType<typeof setInterval> | null = null;

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
  getEntityNumber: (entityId: string) => string;
  formatEntityDisplay: XLNModule['formatEntityDisplay'];
  formatShortEntityId: XLNModule['formatShortEntityId'];
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
    if (!Number.isFinite(loadedSchema) || loadedSchema !== REQUIRED_RUNTIME_SCHEMA_VERSION) {
      throw new Error(
        `RUNTIME_VERSION_MISMATCH: expected schema=${REQUIRED_RUNTIME_SCHEMA_VERSION} got=${String(runtimeMeta.RUNTIME_SCHEMA_VERSION ?? 'undefined')}`,
      );
    }
    XLN = loaded;
    xlnInstance.set(XLN);
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
  bootstrapEnvironment.set(env);
  if (!env) return;

  const selectedRuntimeId = String(get(activeRuntimeId) || '').toLowerCase();
  const envRuntimeId = String(env.runtimeId || '').toLowerCase();
  const targetRuntimeId = envRuntimeId || selectedRuntimeId;
  if (!targetRuntimeId) return;

  runtimes.update((map) => {
    const runtimeEntry = map.get(targetRuntimeId);
    if (!runtimeEntry) return map;
    runtimeEntry.env = env;
    runtimeEntry.lastSynced = Date.now();
    return map;
  });
}

export const isLoading = writable<boolean>(true);
export const error = writable<string | null>(null);

// xlnFunctions is now defined at the end of the file

export function resolveRelayUrls(): string[] {
  if (typeof window === 'undefined') return ['wss://xln.finance/relay'];
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const relay = `${protocol}//${window.location.host}/relay`;
  const configured = get(settings)?.relayUrl;
  if (configured && configured !== relay) {
    console.error(`[relay] SETTINGS_MISMATCH: forcing single relay ${relay}, ignoring ${configured}`);
  }
  return [relay];
}

const isLocalDevOrigin = (): boolean =>
  typeof window !== 'undefined' && LOCAL_DEV_HOSTS.has(window.location.hostname);

type HealthResponse = {
  devSessionId?: string | null;
  system?: {
    runtime?: boolean;
  };
};

const fetchHealthResponse = async (): Promise<HealthResponse | null> => {
  if (typeof window === 'undefined') return null;
  const baseOrigin = window.location.origin;
  const url = new URL('/api/health', resolveConfiguredApiBase(baseOrigin)).toString();
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as HealthResponse;
  } catch {
    return null;
  }
};

const startDevSessionMonitor = (initialSessionId: string): void => {
  if (!isLocalDevOrigin() || !initialSessionId || devSessionMonitor) return;
  let knownSessionId = initialSessionId;
  devSessionMonitor = setInterval(() => {
    void (async () => {
      const health = await fetchHealthResponse();
      const nextSessionId = String(health?.devSessionId || '').trim();
      if (!nextSessionId || nextSessionId === knownSessionId) return;
      knownSessionId = nextSessionId;
      try {
        localStorage.setItem(DEV_SESSION_STORAGE_KEY, nextSessionId);
      } catch {
        // ignore storage errors
      }
      console.warn('[xlnStore] Dev session changed; preserving local runtimes and refreshing only');
    })();
  }, 1500);
};

export async function prepareDevSession(): Promise<void> {
  if (!isLocalDevOrigin()) return;
  const health = await fetchHealthResponse();
  const sessionId = String(health?.devSessionId || '').trim();
  if (!sessionId) return;
  const storedSessionId = (() => {
    try {
      return localStorage.getItem(DEV_SESSION_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  })();
  if (storedSessionId && storedSessionId !== sessionId) {
    try {
      localStorage.setItem(DEV_SESSION_STORAGE_KEY, sessionId);
    } catch {
      // ignore storage errors
    }
  } else if (!storedSessionId) {
    try {
      localStorage.setItem(DEV_SESSION_STORAGE_KEY, sessionId);
    } catch {
      // ignore storage errors
    }
  }
  startDevSessionMonitor(sessionId);
}

// Derived stores for convenience
export const replicas = derived(xlnEnvironment, $env => $env?.eReplicas || new Map());

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

function startP2PPoll() {
  if (p2pPollTimer) return;
  const poll = () => {
    if (!XLN) return;
    const env = get(xlnEnvironment);
    if (!env) return;
    try {
      const state = XLN.getP2PState(env);
      if (state) p2pState.set(state);
    } catch {
      /* ignore if not available */
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
  if (devSessionMonitor) {
    clearInterval(devSessionMonitor);
    devSessionMonitor = null;
  }
}

export async function suspendClientActivity(): Promise<void> {
  stopP2PPoll();
  try {
    const env = get(xlnEnvironment);
    if (!env) return;
    for (const jReplica of env.jReplicas?.values?.() || []) {
      try {
        jReplica.jadapter?.stopWatching?.();
      } catch (watchError) {
        console.warn(`[xlnStore] Failed to stop J-watcher for ${jReplica.name}:`, watchError);
      }
    }
    const xln = await getXLN();
    if (typeof xln.stopP2P === 'function') {
      xln.stopP2P(env);
    }
    env.runtimeState?.stopLoop?.();
    if (env.runtimeState) {
      env.runtimeState.loopActive = false;
      env.runtimeState.stopLoop = null;
    }
  } catch (error) {
    console.warn('[xlnStore] Failed to suspend client activity:', error);
  }
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
  try {
    const fromStorage = localStorage.getItem('xln-api-base-url');
    if (typeof fromStorage === 'string' && fromStorage.trim().length > 0) return fromStorage.trim();
  } catch {
    // ignore storage errors
  }
  return baseOrigin;
};

// Helper functions for common patterns (not wrappers)
export async function initializeXLN(): Promise<Env> {
  showPendingResetNotice();
  // CRITICAL: Don't re-initialize if we already have data
  if (isInitialized) {
    const currentEnv = get(xlnEnvironment);
    if (currentEnv && currentEnv.eReplicas?.size > 0) {
      console.log('🛑 PREVENTED RE-INITIALIZATION: XLN already has data, keeping existing state');
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
      history.set(env?.history || []);
      currentHeight.set(env?.height || 0);

      // Sync to runtimeStore (local runtime)
      runtimeOperations.updateLocalEnv(env);

      // Extract and persist entity positions from eReplicas (positions are immutable)
      // Positions are RELATIVE to j-machine - store jReplica reference for world position calculation
      if (env?.eReplicas) {
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
              console.log(
                `[xlnStore] 📍 Captured relative position for ${entityId.slice(0, 10)}: (${pos.x}, ${pos.y}, ${pos.z}) in jurisdiction=${jurisdiction}`,
              );
            }
          }
          return hasChanges ? new Map(currentPositions) : currentPositions;
        });
      }

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

    // Sync to runtimeStore (local runtime)
    runtimeOperations.updateLocalEnv(env);

    // Extract positions from initial load as well
    // Positions are RELATIVE to j-machine - store jReplica reference for world position calculation
    if (env?.eReplicas) {
      const initialPositions = new Map<string, RelativeEntityPosition>();
      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        const entityId = xln.extractEntityId(replicaKey); // Uses ids.ts - no split
        if (entityId && replica.position) {
          const pos = replica.position;
          // Store relative position + jReplica reference (defaults to activeJurisdiction)
          const jurisdiction = pos.jurisdiction || pos.xlnomy || env.activeJurisdiction || 'default';
          initialPositions.set(entityId, { x: pos.x, y: pos.y, z: pos.z, jurisdiction });
          console.log(
            `[xlnStore] 📍 Initial relative position for ${entityId.slice(0, 10)}: (${pos.x}, ${pos.y}, ${pos.z}) in jurisdiction=${jurisdiction}`,
          );
        }
      }
      if (initialPositions.size > 0) {
        entityPositions.set(initialPositions);
      }
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

// Export XLN for direct use in components (like legacy index.html)
export { getXLN };

// Helper to get current environment
export function getEnv(): Env | null {
  return get(xlnEnvironment);
}

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
  xln.enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: inputs,
  });
  return env;
}

export async function enqueueAndProcess(env: Env, input: RuntimeInput): Promise<Env> {
  const xln = await getXLN();
  xln.enqueueRuntimeInput(env, input);
  return env;
}

// === FRONTEND UTILITY FUNCTIONS ===
// Derived store that provides utility functions for components
export const xlnFunctions = derived([xlnEnvironment, xlnInstance, settings], ([, $xlnInstance, $settings]): FrontendXlnFunctions => {
  const clampPrecision = (value: number): number => Math.max(2, Math.min(18, Math.floor(Number(value) || 2)));
  const settingPrecision = clampPrecision(Number($settings?.tokenPrecision ?? 6));
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
    const failFn = <T extends (...args: any[]) => any>(fnName: string): T =>
      (((..._args: unknown[]) => fail(fnName)) as unknown as T);

    return {
      deriveDelta: failFn('deriveDelta'),
      formatTokenAmount: failFn('formatTokenAmount'),
      getTokenInfo: failFn('getTokenInfo'),
      isLiquidSwapToken: failFn('isLiquidSwapToken'),
      getSwapPairOrientation: failFn('getSwapPairOrientation'),
      getDefaultSwapTradingPairs: failFn('getDefaultSwapTradingPairs'),
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
      getEntityNumber: failFn('getEntityNumber'),
      formatEntityDisplay: failFn('formatEntityDisplay'),
      formatShortEntityId: failFn('formatShortEntityId'),
      // Display-only helpers must not crash early boot paths like /app#pay deep links.
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

    // Legacy function (use getEntityShortId instead)
    getEntityNumber: (entityId: string): string => {
      return $xlnInstance.getEntityShortId(entityId);
    },
    formatEntityDisplay: $xlnInstance.formatEntityDisplay,
    formatShortEntityId: $xlnInstance.formatShortEntityId,

    // Avatar generation (using XLN instance functions)
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
