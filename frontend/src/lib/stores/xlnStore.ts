import { writable, derived, get } from 'svelte/store';
import { errorLog } from './errorLogStore';
import { settings } from './settingsStore';
import { activeRuntimeId, runtimes } from './runtimeStore';
import type { XLNModule, Env, EnvSnapshot, EntityId, ReplicaKey } from '@xln/runtime/xln-api';

// Direct import of XLN runtime module (no wrapper boilerplate needed)
let XLN: XLNModule | null = null;
let xlnLoadPromise: Promise<XLNModule> | null = null;
export const xlnInstance = writable<XLNModule | null>(null);
let warnedMissingXLN = false;
let unregisterEnvChange: (() => void) | null = null;
let globalDebugExposed = false;
const REQUIRED_RUNTIME_SCHEMA_VERSION = 2;

async function getXLN(): Promise<XLNModule> {
  if (XLN) return XLN;
  if (xlnLoadPromise) return xlnLoadPromise;

  xlnLoadPromise = (async () => {
    // Always cache-bust runtime module per page load; stale runtime.js caused prod-debug desync.
    const runtimeUrl = new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href;
    const loaded = (await import(/* @vite-ignore */ runtimeUrl)) as XLNModule;
    const runtimeAny = loaded as unknown as Record<string, unknown>;
    const loadedSchema = Number(runtimeAny.RUNTIME_SCHEMA_VERSION ?? NaN);
    if (!Number.isFinite(loadedSchema) || loadedSchema !== REQUIRED_RUNTIME_SCHEMA_VERSION) {
      throw new Error(
        `RUNTIME_VERSION_MISMATCH: expected schema=${REQUIRED_RUNTIME_SCHEMA_VERSION} got=${String(runtimeAny.RUNTIME_SCHEMA_VERSION ?? 'undefined')}`,
      );
    }
    XLN = loaded;
    xlnInstance.set(XLN);
    exposeGlobalDebugObjects();
    return XLN;
  })();

  try {
    return await xlnLoadPromise;
  } catch (err) {
    xlnLoadPromise = null;
    throw err;
  }
}

/**
 * Expose XLN objects globally for console debugging
 */
function exposeGlobalDebugObjects() {
  if (typeof window !== 'undefined' && XLN) {
    // @ts-ignore - Expose XLN runtime instance
    window.XLN = XLN;

    // @ts-ignore - Expose environment directly (avoid naming conflicts)
    window.xlnEnv = xlnEnvironment;

    // @ts-ignore - Expose error logger for runtime logging
    window.xlnErrorLog = (message: string, source: string, details?: any) => {
      errorLog.log(message, source, details);
    };

    if (!globalDebugExposed) {
      globalDebugExposed = true;
      console.log('🌍 GLOBAL DEBUG: XLN objects exposed');
      console.log('  window.XLN - All runtime functions (deriveDelta, isLeft, etc.)');
      console.log('  window.xlnEnv - Reactive environment store');
      console.log('  window.xlnErrorLog - Logs to Settings error panel');
      console.log('  Usage: window.XLN.deriveDelta(delta, true).ascii');
      console.log('  Usage: Get current env value with xlnEnv subscribe pattern');
    }

    // Ensure vault controls are reachable in production E2E/debug sessions
    // even before RuntimeCreation panel imports vaultStore.
    import('./vaultStore')
      .then(({ vaultOperations, runtimesState }) => {
        // @ts-ignore - intentional debug/test surface
        window.vaultOperations = vaultOperations;
        // @ts-ignore - intentional debug/test surface
        window.runtimesState = runtimesState;
      })
      .catch(err => {
        console.warn('[xlnStore] Failed to expose vaultStore globals:', err);
      });
  }
}

// Eager load XLN for console debugging (non-blocking)
if (typeof window !== 'undefined') {
  getXLN().catch(e => console.warn('XLN eager load failed:', e));
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
  const envRuntimeId = String((env as any)?.runtimeId || '').toLowerCase();
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
      const state = (XLN as any).getP2PState(env);
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

// Helper functions for common patterns (not wrappers)
export async function initializeXLN(): Promise<Env> {
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

  // Slow-start warning only; do not force error-screen while initialization is still progressing.
  const loadingWarningTimeout = setTimeout(() => {
    console.warn('⚠️ XLN initialization still running after 10s...');
  }, 10000);

  try {
    isLoading.set(true);
    error.set(null);

    const xln = await getXLN();

    // Store XLN instance separately for function access
    xlnInstance.set(xln);

    // Shared callback for automatic reactivity (fires on every process())
    const onEnvChange = (env: Env) => {
      const selectedRuntimeId = String(get(activeRuntimeId) || '').toLowerCase();
      const envRuntimeId = String((env as any)?.runtimeId || '').toLowerCase();
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
      import('./runtimeStore').then(({ runtimeOperations }) => {
        runtimeOperations.updateLocalEnv(env);
      });

      // Extract and persist entity positions from eReplicas (positions are immutable)
      // Positions are RELATIVE to j-machine - store jReplica reference for world position calculation
      if (env?.eReplicas) {
        entityPositions.update(currentPositions => {
          let hasChanges = false;
          for (const [replicaKey, replica] of env.eReplicas.entries()) {
            const entityId = xln.extractEntityId(replicaKey); // Uses ids.ts - no split
            if (entityId && (replica as any).position && !currentPositions.has(entityId)) {
              const pos = (replica as any).position;
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
      if (typeof window !== 'undefined') {
        (window as any).xlnEnv = env;
      }
    };

    // Load from IndexedDB - main() handles DB timeout internally
    const env = await xln.main();

    // Register callback for THIS env instance (runtime API is env-scoped)
    if (unregisterEnvChange) {
      unregisterEnvChange();
      unregisterEnvChange = null;
    }
    unregisterEnvChange = xln.registerEnvChangeCallback?.(env, onEnvChange) || null;

    // Set all stores immediately (no derived timing races)
    onEnvChange(env);

    // Sync to runtimeStore (local runtime)
    import('./runtimeStore').then(({ runtimeOperations }) => {
      runtimeOperations.updateLocalEnv(env);
    });

    // Extract positions from initial load as well
    // Positions are RELATIVE to j-machine - store jReplica reference for world position calculation
    if (env?.eReplicas) {
      const initialPositions = new Map<string, RelativeEntityPosition>();
      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        const entityId = xln.extractEntityId(replicaKey); // Uses ids.ts - no split
        if (entityId && (replica as any).position) {
          const pos = (replica as any).position;
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

    // Expose to window for e2e testing
    if (typeof window !== 'undefined') {
      (window as any).xlnEnv = env;
    }

    console.log('✅ XLN Environment initialized');
    isInitialized = true;
    startP2PPoll();

    clearTimeout(loadingWarningTimeout);
    return env;
  } catch (err) {
    clearTimeout(loadingWarningTimeout);
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

// Wrapper for process() that auto-injects runtimeDelay from settings
export async function enqueueEntityInputs(env: Env, inputs?: unknown[]): Promise<Env> {
  const xln = await getXLN();
  xln.enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: (inputs as any[]) ?? [],
  });
  return env;
}

export async function enqueueAndProcess(env: Env, input: { runtimeTxs: any[]; entityInputs: any[] }): Promise<Env> {
  const xln = await getXLN();
  xln.enqueueRuntimeInput(env, input as any);
  return env;
}

// === FRONTEND UTILITY FUNCTIONS ===
// Derived store that provides utility functions for components
export const xlnFunctions = derived([xlnEnvironment, xlnInstance, settings], ([, $xlnInstance, $settings]) => {
  const clampPrecision = (value: number): number => Math.max(0, Math.min(18, Math.floor(Number(value) || 0)));
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

  // If xlnInstance is missing, return empty functions that throw clear errors
  if (!$xlnInstance) {
    const warnMissingXLN = () => {
      if (warnedMissingXLN) return;
      warnedMissingXLN = true;
      console.warn('XLN not initialized yet - showing safe fallbacks until runtime loads');
    };

    const safe =
      <T>(fn: (...args: any[]) => T) =>
      (...args: any[]) => {
        warnMissingXLN();
        return fn(...args);
      };

    // Match runtime getEntityShortId: numbered entities = decimal, hash entities = first 4 chars
    const fallbackShortId = (id: string | undefined) => {
      if (!id || id === '0x' || id === '0x0') return '0';
      const hex = id.startsWith('0x') ? id.slice(2) : id;
      try {
        const value = BigInt('0x' + hex);
        const NUMERIC_THRESHOLD = BigInt(256 ** 6); // 281474976710656
        if (value >= 0n && value < NUMERIC_THRESHOLD) {
          return value.toString();
        }
      } catch {
        /* Fall through to hash mode */
      }
      return hex.slice(0, 4).toUpperCase();
    };
    const fallbackFormatEntityId = (id: string | undefined) =>
      id && id.length > 10 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id || 'N/A';
    const fallbackTokenInfo = (tokenId: number) => ({ symbol: `T${tokenId}`, decimals: 18 });
    const fallbackDerived = {
      delta: 0,
      totalCapacity: 0,
      ownCreditLimit: 0,
      peerCreditLimit: 0,
      inCapacity: 0,
      outCapacity: 0,
      collateral: 0,
      outOwnCredit: 0,
      inCollateral: 0,
      outPeerCredit: 0,
      inOwnCredit: 0,
      outCollateral: 0,
      inPeerCredit: 0,
    };

    const fallbackTokenAmount = (tokenId: number, amount: bigint | null | undefined): string => {
      const tokenInfo = fallbackTokenInfo(tokenId);
      const raw = amount ?? 0n;
      const numeric = formatRawAmount(raw, tokenInfo.decimals ?? 18, settingPrecision);
      return `${numeric} ${tokenInfo.symbol}`;
    };

    return {
      // Account utilities
      deriveDelta: safe(() => fallbackDerived) as any,
      formatTokenAmount: safe((tokenId: number, amount: bigint | null | undefined) => fallbackTokenAmount(tokenId, amount)) as any,
      getTokenInfo: safe((tokenId: number) => fallbackTokenInfo(tokenId)) as any,
      isLeft: safe((entityId: string, counterpartyId: string) => entityId < counterpartyId) as any,
      createDemoDelta: safe(() => ({})) as any,
      getDefaultCreditLimit: safe(() => 0n) as any,
      safeStringify: safe((value: any) => {
        try {
          return JSON.stringify(value);
        } catch {
          return '';
        }
      }) as any,

      // Financial utilities
      formatTokenAmountEthers: safe((amount: bigint) => amount.toString()) as any,
      parseTokenAmount: safe((amount: string) => {
        const parsed = Number(amount);
        return Number.isFinite(parsed) ? BigInt(Math.floor(parsed)) : 0n;
      }) as any,
      convertTokenPrecision: safe((amount: bigint) => amount) as any,
      calculatePercentageEthers: safe(() => '0') as any,
      formatAssetAmountEthers: safe((amount: bigint) => amount.toString()) as any,
      BigIntMath: {} as any,
      FINANCIAL_CONSTANTS: {} as any,

      // Entity utilities
      getEntity: safe(() => null) as any,
      getEntityShortId: safe((entityId: string) => fallbackShortId(entityId)) as any,
      formatEntityId: safe((entityId: string) => fallbackFormatEntityId(entityId)) as any,
      getEntityNumber: safe((entityId: string) => fallbackShortId(entityId)) as any,
      formatEntityDisplay: safe((entityId: string) => `Entity #${fallbackShortId(entityId)}`) as any,
      formatShortEntityId: safe((entityId: string) => fallbackShortId(entityId)) as any,

      // Avatar generation
      generateEntityAvatar: safe(() => '') as any,
      generateSignerAvatar: safe(() => '') as any,
      getEntityDisplayInfo: safe((entityId: string) => ({
        id: entityId,
        shortId: fallbackShortId(entityId),
        label: `Entity #${fallbackShortId(entityId)}`,
      })) as any,

      // Identity system (from ids.ts)
      extractEntityId: safe((key: string) => key.split(':')[0] || '') as any,
      extractSignerId: safe((key: string) => key.split(':')[1] || '') as any,
      parseReplicaKey: safe((key: string) => {
        const [entityId = '', signerId = ''] = key.split(':');
        return { entityId, signerId };
      }) as any,
      formatReplicaKey: safe((entityId: string, signerId: string) => `${entityId}:${signerId}`) as any,
      createReplicaKey: safe((entityId: string, signerId: string) => `${entityId}:${signerId}`) as any,
      classifyBilateralState: safe((_account: any, _peerHeight: number | undefined, isLeftEntity: boolean) => ({
        state: 'unknown',
        isLeftEntity,
        shouldRollback: false,
        pendingHeight: null,
        mempoolCount: 0,
      })) as any,
      getAccountBarVisual: safe(() => ({
        glowColor: null,
        glowSide: null,
        glowIntensity: 0,
        isDashed: false,
        pulseSpeed: 1,
      })) as any,
      sendEntityInput: safe(() => ({ sent: false, deferred: true, queuedLocal: false })) as any,
      resolveEntityProposerId: safe(() => '') as any,

      isReady: false,
    };
  }

  const formatTokenAmountUi = (tokenId: number, amount: bigint | null | undefined): string => {
    const tokenInfo = $xlnInstance.getTokenInfo(tokenId) ?? { symbol: `T${tokenId}`, decimals: 18 };
    const decimals = Number.isFinite(tokenInfo.decimals) ? tokenInfo.decimals : 18;
    const numeric = formatRawAmount(amount ?? 0n, decimals, settingPrecision);
    return `${numeric} ${tokenInfo.symbol}`;
  };

  return {
    // Account utilities
    deriveDelta: $xlnInstance.deriveDelta,
    // Frontend display formatter with configurable precision from Settings.
    // Signature used across UI: formatTokenAmount(tokenId, amount).
    formatTokenAmount: formatTokenAmountUi as any,
    getTokenInfo: $xlnInstance.getTokenInfo,
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
          avatar: $xlnInstance.generateEntityAvatar?.(entityId) || '',
          info: $xlnInstance.getEntityDisplayInfo?.(entityId) || { name: entityId, avatar: '', type: 'numbered' },
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
      try {
        return $xlnInstance.generateEntityAvatar?.(entityId) || '';
      } catch (error) {
        console.error('Error generating entity avatar:', error);
        return '';
      }
    },

    generateSignerAvatar: (signerId: string): string => {
      try {
        const result = $xlnInstance.generateSignerAvatar?.(signerId) || '';
        return result;
      } catch (error) {
        console.error('Error generating signer avatar:', error);
        return '';
      }
    },

    // Entity display helpers
    getEntityDisplayInfo: (entityId: string) => {
      try {
        return $xlnInstance.getEntityDisplayInfo?.(entityId) || { name: entityId, avatar: '', type: 'lazy' };
      } catch {
        return { name: entityId, avatar: '', type: 'lazy' };
      }
    },

    // Signer display helpers
    getSignerDisplayInfo: (signerId: string) => {
      try {
        return $xlnInstance.getSignerDisplayInfo?.(signerId) || { name: signerId, address: signerId, avatar: '' };
      } catch {
        return { name: signerId, address: signerId, avatar: '' };
      }
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

    // State management - indicates functions are fully loaded
    isReady: true,
  };
});
