// for regular use > bun run runtime/runtime.ts
// for debugging > bun repl
// await import('./debug.js');

// Import utilities and types
// High-level database using Level polyfill (works in both Node.js and browser)
import { Level } from 'level';
import { ethers } from 'ethers';
import type { Provider } from 'ethers';
import type { JAdapterConfig } from './jadapter/types';
import {
  DEFAULT_SNAPSHOT_INTERVAL_FRAMES,
  dbRootPath,
  isProductionRuntime,
  nodeProcess,
  runtimeIsBrowser,
} from './runtime-platform';

// Bump this on runtime bundle changes that must be reflected in frontend immediately.
const RUNTIME_BUILD_ID = '2026-03-23-19:35Z';
// Bump this only on breaking persistence/replay format or invariants.
export const RUNTIME_SCHEMA_VERSION = 5;
export const RUNTIME_BUILD = RUNTIME_BUILD_ID;

import { getPerfMs, getWallClockMs } from './utils';
import { listOpenSwapOffers } from './open-swap-offers';
import { setDeltaTransformerAddress } from './proof-builder';
import {
  buildCanonicalEnvSnapshot,
  buildRuntimeCheckpointSnapshot,
} from './wal/snapshot';
import { computePersistedEnvStateHash } from './wal/hash';
import { applyEntityInput, mergeEntityInputs } from './entity-consensus';
import type { JAdapter } from './jadapter';
import {
  createLazyEntity,
  createNumberedEntity,
  createNumberedEntitiesBatch,
  detectEntityType,
  encodeBoard,
  generateLazyEntityId,
  generateNamedEntityId,
  generateNumberedEntityId,
  hashBoard,
  isEntityRegistered,
  requestNamedEntity,
  resolveEntityIdentifier,
} from './entity-factory';
import {
  assignNameOnChain,
  getBrowserVMInstance,
  debugFundReserves,
  getEntityInfoFromChain,
  getJurisdictionByAddress,
  setBrowserVMJurisdiction,
  submitProcessBatch,
  transferNameBetweenEntities,
} from './jadapter';
import { ensureLocalDisputeDelayConfigured } from './jadapter/local-config';
import { getAvailableJurisdictions } from './jurisdiction-config';
import { createGossipLayer } from './networking/gossip';
import {
  attachEventEmitters,
  clearPendingAuditEvents,
  dropPendingFrameDbRecords,
  dropOverlay,
  flushPendingAuditEvents,
  markStorageEntityDirty,
  peekPendingFrameDbRecords,
  setAccountFrameHistoryView,
} from './env-events';
import {
  deriveSignerAddressSync,
  getCachedSignerPrivateKey,
  getSignerPrivateKey,
  prewarmSignerKeyCache,
} from './account-crypto';
import {
  deriveLocalEntityCryptoKeys,
  hasLocalSignerKey,
  resolveReplicaEntityCryptoKeys,
} from './runtime-entity-crypto';
import {
  announceLocalEntityProfile,
  buildEntityAdvertisedStateFingerprint,
  buildLocalEntityProfile,
  createProfileSignerResolver,
} from './networking/gossip-helper';
import type { Profile } from './networking/gossip';
import { normalizeRuntimeId } from './networking/runtime-id';
import {
  detachRuntimeP2P,
  ensureRuntimeGossipProfiles,
  getRuntimeP2P,
  getRuntimeP2PState,
  refreshRuntimeGossip,
  startPendingRuntimeP2PIfReady,
  startRuntimeP2P,
  stopRuntimeP2P,
  type P2PConfig,
  type P2PConnectionState,
  type RuntimeP2PLifecycleDeps,
} from './runtime-p2p-lifecycle';
import {
  parseReplicaKey,
  extractEntityId,
  extractSignerId,
  formatReplicaKey,
  createReplicaKey,
  formatReplicaDisplay,
  // Constants
  XLN_URI_SCHEME,
  DEFAULT_RUNTIME_HOST,
  XLN_COORDINATOR,
  CHAIN_IDS,
  MAX_NUMBERED_ENTITY,
  // Type guards
  isValidEntityId,
  isValidSignerId,
  isValidJId,
  isValidEpAddress,
  // Constructors
  toEntityId,
  toSignerId,
  toJId,
  toEpAddress,
  isNumberedEntity,
  isLazyEntity,
  getEntityDisplayNumber,
  // URI operations
  formatReplicaUri,
  parseReplicaUri,
  createLocalUri,
  // Type-safe collections
  ReplicaMap,
  EntityMap,
  jIdFromChainId,
  createLazyJId,
  // Migration helpers
  safeParseReplicaKey,
  safeExtractEntityId,
} from './ids';
import {
  createProfileUpdateTx,
  getEntityDisplayInfo as getEntityDisplayInfoFromProfileOriginal,
  resolveEntityName as resolveEntityNameOriginal,
  searchEntityNames as searchEntityNamesOriginal,
} from './name-resolution';
// import { runDemo } from './rundemo'; // REMOVED: Legacy demo replaced by scenarios/ahb
import { decode, encode } from './snapshot-coder'; // encode used in exports
import {
  deriveDelta,
  isLeft,
  getTokenInfo,
  isLiquidSwapToken,
  getSwapPairOrientation,
  buildDefaultEntitySwapPairs,
  getDefaultSwapTradingPairs,
  createDemoDelta,
  getDefaultCreditLimit,
} from './account-utils';
import { computeSwapPriceTicks, prepareSwapOrder, quantizeSwapOrder } from './orderbook';
import {
  entityInputHasCrossJurisdictionIntraRuntimeTx,
  isCrossJurisdictionEntityInputRemoteHopAllowed,
} from './cross-jurisdiction-boundary';
import {
  buildCrossJurisdictionSwapSubmission,
  type CrossJurisdictionSwapSubmitParams,
  type CrossJurisdictionSwapSubmitResult,
} from './runtime-jurisdiction-api';
import {
  buildRouteOutputKey,
  dispatchEntityOutputs,
  planEntityOutputs,
  rescheduleDeferredOutputs,
  sendEntityInputWithRouting,
  splitPendingOutputsByRetryWindow,
  type RuntimeOutputRoutingDeps,
} from './runtime-output-routing';
import {
  collectCrossJurisdictionRemoteEntityHints,
  createRuntimeOutputRoutingDeps,
  handleInboundP2PEntityInput as routeInboundP2PEntityInput,
  registerEntityRuntimeHint as registerEntityRuntimeHintForRouting,
  resolveRuntimeIdForCrossJurisdictionEntity,
  type RuntimeEntityRoutingDeps,
} from './runtime-entity-routing';
import {
  entityNeedsPeriodicWake as entityNeedsPeriodicWakeForRuntime,
  generateHookPings as generateRuntimeHookPings,
  getEarliestWallClockDueTimestamp as getEarliestRuntimeWallClockDueTimestamp,
  getNextWallClockWakeTimestamp as getNextRuntimeWallClockWakeTimestamp,
  hasDueEntityHooks as hasDueRuntimeEntityHooks,
  type RuntimeWakeDeps,
} from './runtime-wake';
import {
  enqueueRuntimeInputs as enqueueRuntimeInputsWithDeps,
  ensureRuntimeMempool,
  type RuntimeInputQueueDeps,
} from './runtime-input-queue';
import {
  clearRuntimeCleanLogs,
  copyRuntimeCleanLogs,
  getRuntimeCleanLogs,
  type RuntimeCleanLogDeps,
} from './runtime-clean-logs';
import { normalizeEntitySwapTradingPairs } from './runtime-swap-pairs';
import { classifyBilateralState, getAccountBarVisual } from './account-consensus-state';
import { calculateSolvency, verifySolvency } from './solvency';
import {
  formatTokenAmount,
  formatTokenAmount as formatTokenAmountEthers,
  parseTokenAmount,
  convertTokenPrecision,
  calculatePercentage as calculatePercentageEthers,
  formatAssetAmount as formatAssetAmountEthers,
  BigIntMath,
  FINANCIAL_CONSTANTS,
} from './financial-utils';
import { resolveEntityProposerId } from './state-helpers';
import { getEntityShortId, formatEntityId } from './utils';
import { safeStringify } from './serialization-utils';
import { computeCanonicalEntityHashesFromEnv, computeCanonicalStateHashFromEnv } from './storage/canonical-hash';
import {
  computeStorageStateRoot,
  findStorageLatestSnapshotAtOrBelow,
  inspectStorage,
  listStorageSnapshotEntityIds,
  listStorageSnapshotHeights,
  loadEntityAccountDocFromStorage,
  loadEntityStateFromStorage,
  loadEntityViewPageFromStorage,
  readFrameDbAccountFrames,
  readFrameDbRuntimeActivity,
  readStorageFrameRecord,
  readStorageHead,
  readStorageOverlayRecordsFromDiffs,
  readStorageReplicaMeta,
  saveRuntimeFrameToStorage,
  type StorageHead,
} from './storage';
import { assertStorageSafetyOverridesAllowed } from './storage/safety';
import { storageOverlayRecordKey } from './storage/overlay';
import type { RuntimeAdapterReadQuery } from './radapter';
export {
  resolveRuntimeAdapterRead,
  EmbeddedRuntimeAdapter,
  RemoteRuntimeAdapter,
} from './radapter';
export type {
  RuntimeAdapter,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterStatus,
} from './radapter';
import {
  validateDelta,
  validateAccountDeltas,
  createDefaultDelta,
  isDelta,
  validateEntityInput,
  validateEntityOutput,
} from './validation-utils';
import {
  backfillEntityJurisdictionBinding,
  requireBoundEntityConfig,
} from './jurisdiction-runtime';
import type {
  AccountFrame,
  EntityInput,
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  FrameLogEntry,
  JInput,
  JReplica,
  RoutedEntityInput,
  RuntimeOverlayRecord,
  RuntimeInput,
  RuntimeTx,
} from './types';
import {
  clearDatabase,
  DEBUG,
  formatEntityDisplay,
  formatSignerDisplay,
  hashToAvatar,
  generateEntityAvatar,
  generateSignerAvatar,
  getEntityDisplayInfo,
  getSignerDisplayInfo,
  log,
} from './utils';
import { createStructuredLogger, logError } from './logger';
import type { PersistedFrameJournal } from './wal/store';
import { rehydrateRestoredRuntimeInfra } from './runtime-infra';
import {
  clearInfraGossipProfiles,
  loadGossipProfilesFromInfraDb,
  persistGossipProfileToInfraDb,
} from './runtime-infra-gossip-store';
import {
  closeFrameDb,
  closeInfraDb as closeInfraDbStorage,
  closeStorageDb,
  deriveRuntimeIdFromSeed,
  getFrameDb as getFrameDbStorage,
  getInfraDb as getInfraDbStorage,
  getRuntimeDb as getRuntimeDbStorage,
  getStorageDb as getStorageDbStorage,
  normalizeDbNamespace,
  resolveFrameDbPath,
  resolveStorageDbPath,
  rotateStorageEpochDb as rotateStorageEpochDbStorage,
  tryOpenDb as tryOpenDbStorage,
  tryOpenFrameDb as tryOpenFrameDbStorage,
  tryOpenStorageDb as tryOpenStorageDbStorage,
  type RuntimeStorageDbDeps,
  type StorageDbRole,
} from './runtime-storage-dbs';

const runtimeLog = createStructuredLogger('runtime');

const formatPerfMs = (value: number): string => value.toFixed(2);

// === ETHEREUM INTEGRATION ===

// === SVELTE REACTIVITY INTEGRATION ===
// Per-runtime state is stored on env.runtimeState/runtimeMempool/runtimeConfig.

export const registerEnvChangeCallback = (env: Env, callback: (env: Env) => void): (() => void) => {
  const state = ensureRuntimeState(env);
  if (!state.envChangeCallbacks) {
    state.envChangeCallbacks = new Set();
  }
  state.envChangeCallbacks.add(callback);
  return () => state.envChangeCallbacks?.delete(callback);
};

const ensureRuntimeConfig = (env: Env): NonNullable<Env['runtimeConfig']> => {
  if (!env.runtimeConfig) {
    env.runtimeConfig = {
      minFrameDelayMs: 0,
      loopIntervalMs: isProductionRuntime ? 25 : 0,
      snapshotIntervalFrames: DEFAULT_SNAPSHOT_INTERVAL_FRAMES,
    };
  }
  const configuredSnapshotInterval = env.runtimeConfig.snapshotIntervalFrames;
  if (!Number.isFinite(configuredSnapshotInterval ?? NaN) || (configuredSnapshotInterval ?? 0) < 1) {
    env.runtimeConfig.snapshotIntervalFrames = DEFAULT_SNAPSHOT_INTERVAL_FRAMES;
  }
  return env.runtimeConfig;
};

const ensureRuntimeState = (env: Env): NonNullable<Env['runtimeState']> => {
  if (!env.runtimeState) {
    env.runtimeState = {
      loopActive: false,
      loopPromise: null,
      stopLoop: null,
      wakeLoop: null,
      wakeRequested: false,
      clockPrimed: false,
      p2p: null,
      pendingP2PConfig: null,
      lastP2PConfig: null,
      directEntityInputDispatch: null,
      canUseConnectedRelayFallback: null,
    };
  }
  if (!env.runtimeState.entityRuntimeHints) {
    env.runtimeState.entityRuntimeHints = new Map();
  }
  if (!env.runtimeState.watcherDedupCounter) {
    env.runtimeState.watcherDedupCounter = { value: 0 };
  }
  trackedRuntimeEnvs.add(env);
  ensureRuntimeWakeWatchdogStarted();
  return env.runtimeState;
};

const getRuntimeStorageDbDeps = (): RuntimeStorageDbDeps => ({
  ensureRuntimeState,
});

export const getRuntimeDb = (env: Env): Level<Buffer, Buffer> =>
  getRuntimeDbStorage(env, getRuntimeStorageDbDeps());

export const getRuntimeStorageDb = (env: Env, role: StorageDbRole = 'current'): Level<Buffer, Buffer> =>
  getStorageDb(env, role);

const getStorageDb = (env: Env, role: StorageDbRole = 'current'): Level<Buffer, Buffer> =>
  getStorageDbStorage(env, getRuntimeStorageDbDeps(), role);

export const getInfraDb = (env: Env): Level<Buffer, Buffer> =>
  getInfraDbStorage(env, getRuntimeStorageDbDeps());

export const getFrameDb = (env: Env): Level<Buffer, Buffer> =>
  getFrameDbStorage(env, getRuntimeStorageDbDeps());

const tryOpenStorageDb = (env: Env, role: StorageDbRole = 'current'): Promise<boolean> =>
  tryOpenStorageDbStorage(env, getRuntimeStorageDbDeps(), role);

const rotateStorageEpochDb = (env: Env, snapshotHeight: number, timestamp = env.timestamp): Promise<boolean> =>
  rotateStorageEpochDbStorage(env, getRuntimeStorageDbDeps(), snapshotHeight, timestamp);

export const tryOpenDb = (env: Env): Promise<boolean> =>
  tryOpenDbStorage(env, getRuntimeStorageDbDeps());

export const tryOpenFrameDb = (env: Env): Promise<boolean> =>
  tryOpenFrameDbStorage(env, getRuntimeStorageDbDeps());

export const closeRuntimeDb = async (env: Env): Promise<void> => {
  const stopped = await stopRuntimeLoopAndWait(env, 10_000);
  if (!stopped) {
    console.warn('Runtime loop did not drain before DB close deadline');
  }
  detachRuntimeEnv(env);
  await closeStorageDb(env, 'current');
  await closeStorageDb(env, 'previous');
  await closeFrameDb(env);
  const state = env.runtimeState;
  if (!state?.db) return;
  try {
    await state.db.close();
  } catch (error) {
    console.warn('Failed to close runtime DB:', error instanceof Error ? error.message : error);
  } finally {
    state.db = null;
    state.dbOpenPromise = null;
  }
};

export const closeInfraDb = (env: Env): Promise<void> => closeInfraDbStorage(env);

const requestRuntimeLoopWake = (env: Env): void => {
  const state = ensureRuntimeState(env);
  const wakeLoop = state.wakeLoop;
  if (wakeLoop) {
    state.wakeLoop = null;
    wakeLoop();
    return;
  }
  state.wakeRequested = true;
};

const waitForRuntimeLoopWake = async (env: Env): Promise<void> => {
  const state = ensureRuntimeState(env);
  if (state.wakeRequested) {
    state.wakeRequested = false;
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (state.wakeLoop === wake) {
        state.wakeLoop = null;
      }
      resolve();
    };
    const wake = () => {
      state.wakeRequested = false;
      finish();
    };
    state.wakeLoop = wake;
  });
};

const waitForRuntimeLoopWakeOrTimeout = async (env: Env, timeoutMs: number): Promise<'wake' | 'timeout'> => {
  const state = ensureRuntimeState(env);
  if (timeoutMs <= 0) {
    if (state.wakeRequested) state.wakeRequested = false;
    await sleep(0);
    return 'timeout';
  }
  if (state.wakeRequested) {
    state.wakeRequested = false;
    return 'wake';
  }
  return await new Promise<'wake' | 'timeout'>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let result: 'wake' | 'timeout' = 'timeout';
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (state.wakeLoop === wake) {
        state.wakeLoop = null;
      }
      resolve(result);
    };
    const wake = () => {
      state.wakeRequested = false;
      result = 'wake';
      finish();
    };
    state.wakeLoop = wake;
    timeoutId = setTimeout(finish, timeoutMs);
  });
};

const ENV_APPLY_ALLOWED_KEY = Symbol.for('xln.runtime.env.apply.allowed');
const ENV_REPLAY_MODE_KEY = Symbol.for('xln.runtime.env.replay.mode');

const envRecord = (env: Env): Record<PropertyKey, unknown> => env as unknown as Record<PropertyKey, unknown>;

const failfastAssert: (
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => asserts condition = (
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => {
  if (condition) return;
  const detailText = details ? ` ${safeStringify(details)}` : '';
  throw new Error(`${code}: ${message}${detailText}`);
};

export const getCleanLogs = (env: Env): string =>
  getRuntimeCleanLogs(env, getRuntimeCleanLogDeps());

export const clearCleanLogs = (env: Env): void =>
  clearRuntimeCleanLogs(env, getRuntimeCleanLogDeps());

export const copyCleanLogs = async (env: Env): Promise<string> =>
  copyRuntimeCleanLogs(env, getRuntimeCleanLogDeps());

function getRuntimeCleanLogDeps(): RuntimeCleanLogDeps {
  return { ensureRuntimeState };
}

const enqueueRuntimeInputs = (
  env: Env,
  inputs?: RoutedEntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
): void => {
  enqueueRuntimeInputsWithDeps(env, getRuntimeInputQueueDeps(), inputs, runtimeTxs, jInputs, explicitTimestamp);
};

function getRuntimeInputQueueDeps(): RuntimeInputQueueDeps {
  return {
    ensureRuntimeState,
    requestRuntimeLoopWake,
  };
}

export async function tryOpenInfraDb(env: Env): Promise<boolean> {
  const state = ensureRuntimeState(env);
  if (!state.infraDbOpenPromise) {
    const db = getInfraDb(env);
    state.infraDbOpenPromise = (async () => {
      try {
        await db.open();
        return true;
      } catch (error) {
        const isBlocked =
          error instanceof Error &&
          (error.message?.includes('blocked') || error.name === 'SecurityError' || error.name === 'InvalidStateError');
        if (isBlocked) {
          console.log('⚠️ Infra IndexedDB blocked (incognito/private mode) - running in-memory');
          return false;
        }
        state.infraDbOpenPromise = null;
        throw error;
      }
    })();
  }
  try {
    return await state.infraDbOpenPromise;
  } catch (error) {
    console.error('❌ Failed to open infra DB:', error);
    throw error;
  }
}

const infraGossipDbAccess = { tryOpenInfraDb, getInfraDb };

export const enqueueRuntimeInput = (env: Env, runtimeInput: RuntimeInput): void => {
  const ingressTimestamp = env.scenarioMode
    ? (runtimeInput.timestamp ?? env.timestamp ?? 0)
    : (runtimeInput.timestamp ?? getWallClockMs());
  enqueueRuntimeInputs(
    env,
    runtimeInput.entityInputs,
    runtimeInput.runtimeTxs,
    runtimeInput.jInputs,
    ingressTimestamp,
  );
};

const hasRuntimeWork = (env: Env): boolean => {
  const mempool = ensureRuntimeMempool(env);
  if (mempool.runtimeTxs.length > 0 || mempool.entityInputs.length > 0) return true;
  if ((mempool.jInputs?.length ?? 0) > 0) return true;
  if ((mempool.queuedAt ?? 0) > (env.timestamp ?? 0)) return true;
  if (env.pendingOutputs && env.pendingOutputs.length > 0) return true;
  if (env.networkInbox && env.networkInbox.length > 0) return true;
  if (env.pendingNetworkOutputs && env.pendingNetworkOutputs.length > 0) {
    const nowMs = getRuntimeNowMs(env);
    const deferredMeta = ensureRuntimeState(env).deferredNetworkMeta;
    for (const output of env.pendingNetworkOutputs) {
      const retryAt = deferredMeta?.get(buildRouteOutputKey(output))?.nextRetryAt ?? 0;
      if (retryAt <= nowMs) return true;
    }
  }
  // Check for due scheduled hooks (setTimeout-like entity pings)
  if (hasDueEntityHooks(env)) return true;
  return false;
};

const getRuntimeWakeDeps = (): RuntimeWakeDeps => ({
  ensureRuntimeState,
  ensureRuntimeMempool,
  enqueueRuntimeInputs,
  getRuntimeNowMs,
});

export const entityNeedsPeriodicWake = entityNeedsPeriodicWakeForRuntime;

const hasDueEntityHooks = (env: Env): boolean =>
  hasDueRuntimeEntityHooks(env, getRuntimeWakeDeps());

const getEarliestWallClockDueTimestamp = (env: Env): number | null =>
  getEarliestRuntimeWallClockDueTimestamp(env, getRuntimeWakeDeps());

const getNextWallClockWakeTimestamp = (env: Env): number | null =>
  getNextRuntimeWallClockWakeTimestamp(env, getRuntimeWakeDeps());

const RUNTIME_WAKE_WATCHDOG_MS = 1000;
const trackedRuntimeEnvs = new Set<Env>();
let runtimeWakeWatchdog: ReturnType<typeof setInterval> | null = null;
const logSlowBrowserTimer = (label: string, startedAt: number, extra = ''): void => {
  if (typeof window === 'undefined' || typeof performance === 'undefined') return;
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs < 32) return;
  const suffix = extra ? ` ${extra}` : '';
  console.warn(`[perf] slow timer ${label} ${elapsedMs.toFixed(1)}ms${suffix}`);
};

const ensureRuntimeWakeWatchdogStarted = (): void => {
  if (runtimeWakeWatchdog) return;
  runtimeWakeWatchdog = setInterval(() => {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
    const wallClockNow = getWallClockMs();
    for (const env of trackedRuntimeEnvs) {
      if (env.scenarioMode) continue;
      const dueTimestamp = getEarliestWallClockDueTimestamp(env);
      if (dueTimestamp === null || dueTimestamp > wallClockNow) continue;
      const state = ensureRuntimeState(env);
      const mempool = ensureRuntimeMempool(env);
      mempool.queuedAt =
        mempool.queuedAt === undefined
          ? dueTimestamp
          : Math.max(mempool.queuedAt, dueTimestamp);
      state.clockPrimed = true;
      generateHookPings(env, dueTimestamp, dueTimestamp);
      if (state.loopActive) {
        requestRuntimeLoopWake(env);
      } else {
        startRuntimeLoop(env);
      }
    }
    logSlowBrowserTimer('runtime.wake-watchdog', startedAt, `envs=${trackedRuntimeEnvs.size}`);
  }, RUNTIME_WAKE_WATCHDOG_MS);
};

const stopRuntimeWakeWatchdogIfIdle = (): void => {
  if (runtimeWakeWatchdog && trackedRuntimeEnvs.size === 0) {
    clearInterval(runtimeWakeWatchdog);
    runtimeWakeWatchdog = null;
  }
};

const generateHookPings = (env: Env, nowMs = getRuntimeNowMs(env), queuedAt = env.timestamp ?? 0): void => {
  generateRuntimeHookPings(env, getRuntimeWakeDeps(), nowMs, queuedAt);
};

const isRuntimeFrameReady = (env: Env, now: number, overrideDelayMs?: number): boolean => {
  if (env.scenarioMode) return true; // deterministic scenarios advance manually
  const config = ensureRuntimeConfig(env);
  const rawDelayMs = overrideDelayMs !== undefined ? overrideDelayMs : (config.minFrameDelayMs ?? 0);
  if (!Number.isFinite(rawDelayMs) || rawDelayMs <= 0) return true;
  const delayMs = Math.max(0, Math.floor(rawDelayMs));
  const state = ensureRuntimeState(env);
  const lastFrameAt = state.lastFrameAt;
  if (typeof lastFrameAt !== 'number' || !Number.isFinite(lastFrameAt) || lastFrameAt <= 0) return true;
  return Math.max(0, now - lastFrameAt) >= delayMs;
};

const getRemainingRuntimeFrameDelayMs = (env: Env, overrideDelayMs?: number): number => {
  if (env.scenarioMode) return 0;
  const wallClockNow = getWallClockMs();
  const config = ensureRuntimeConfig(env);
  const rawDelayMs = overrideDelayMs !== undefined ? overrideDelayMs : (config.minFrameDelayMs ?? 0);
  if (!Number.isFinite(rawDelayMs) || rawDelayMs <= 0) return 0;
  const delayMs = Math.max(0, Math.floor(rawDelayMs));
  const lastFrameAt = ensureRuntimeState(env).lastFrameAt;
  if (typeof lastFrameAt !== 'number' || !Number.isFinite(lastFrameAt) || lastFrameAt <= 0) return 0;
  return Math.max(0, delayMs - Math.max(0, wallClockNow - lastFrameAt));
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const emitRuntimeLoopError = (
  env: Env,
  code: 'RUNTIME_LOOP_ERROR' | 'RUNTIME_LOOP_HALTED',
  payload: Record<string, unknown>,
): void => {
  try {
    env.error?.('system', code, payload, env.runtimeId);
  } catch (reportError) {
    console.error(`[RUNTIME_LOOP] failed to report ${code}:`, reportError);
  }
};

/**
 * Start the single runtime event loop. Called once on init.
 * Async while-loop — no re-entry possible by construction.
 * Returns a stop function for graceful shutdown.
 *
 * Loop cycle:
 *   1. process() — drain mempool, apply R-frame (pure E/A consensus)
 *   2. persist   — atomic LevelDB write of finalized frame
 *   3. broadcast — J-batch execution + E-output P2P dispatch (side effects)
 *   4. sleep     — configurable delay (0 = no wait, just yield)
 */
export function startRuntimeLoop(env: Env, config?: { tickDelayMs?: number }): () => void {
  if (env.scenarioMode) return () => {};
  const state = ensureRuntimeState(env);
  if (state.loopActive) return state.stopLoop ?? (() => {});
  void config;
  let running = true;
  let loopPromise: Promise<void> | null = null;
  state.loopActive = true;
  // J-watchers are a runtime concern, not a UI/store concern.
  // The runtime loop is the single canonical owner of watcher lifecycle for
  // the current env. This keeps restored runtimes, fresh runtimes, and
  // long-lived runtimes on one obvious path:
  //   startRuntimeLoop(env) -> startJurisdictionWatchers(env) -> one poller per jReplica
  //
  // Why we do it here:
  // - restored envs need watchers restarted after process reload
  // - UI code should not decide when blockchain watchers exist
  // - watchers already guard against duplicate starts internally
  //
  // This still coexists with importJ starting the watcher for newly imported
  // jurisdictions while a loop is already running.
  startJurisdictionWatchers(env);

  const loop = async () => {
    let haltedMessage: string | null = null;
    try {
      while (running) {
        try {
          // jReplicas can appear after the loop has already started:
          // - server bootstrap wires the RPC adapter after startRuntimeLoop(env)
          // - restored/fresh runtimes can import jurisdictions later
          //
          // The runtime loop remains the single canonical owner of watcher lifecycle.
          // Re-checking here is safe because startWatching() is idempotent and guards
          // duplicate intervals internally. Do not add parallel server/UI watcher starts.
          startJurisdictionWatchers(env);
          if (hasRuntimeWork(env)) {
            const remainingDelayMs = getRemainingRuntimeFrameDelayMs(env);
            if (remainingDelayMs > 0) {
              await sleep(remainingDelayMs);
              continue;
            }
            await process(env);
          }
        } catch (error) {
          console.error('❌ Runtime loop error:', error);
          const message = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? error.stack : undefined;
          emitRuntimeLoopError(
            env,
            'RUNTIME_LOOP_ERROR',
            {
              message,
              ...(stack ? { stack } : {}),
            },
          );
          // Fail-fast: stop runtime loop on any unhandled runtime error.
          haltedMessage = message;
          running = false;
        }
        if (!running) break;
        if (hasRuntimeWork(env)) {
          const remainingDelayMs = getRemainingRuntimeFrameDelayMs(env);
          if (remainingDelayMs > 0) {
            await sleep(remainingDelayMs);
          } else {
            // Drain chained outputs/ACKs immediately.
            await sleep(0);
          }
          continue;
        }
        const nextDueAt = getNextWallClockWakeTimestamp(env);
        if (nextDueAt !== null) {
          const waitResult = await waitForRuntimeLoopWakeOrTimeout(
            env,
            Math.max(0, nextDueAt - getWallClockMs()),
          );
          if (waitResult === 'timeout') {
            const dueTimestamp = getEarliestWallClockDueTimestamp(env) ?? nextDueAt;
            const mempool = ensureRuntimeMempool(env);
            mempool.queuedAt =
              mempool.queuedAt === undefined
                ? dueTimestamp
                : Math.max(mempool.queuedAt, dueTimestamp);
            state.clockPrimed = true;
            generateHookPings(env, dueTimestamp, dueTimestamp);
          }
          continue;
        }
        await waitForRuntimeLoopWake(env);
      }
    } finally {
      if (haltedMessage) {
        emitRuntimeLoopError(
          env,
          'RUNTIME_LOOP_HALTED',
          { message: haltedMessage },
        );
      }
      state.loopActive = false;
      state.stopLoop = null;
      if (state.loopPromise === loopPromise) state.loopPromise = null;
      state.wakeLoop = null;
      state.wakeRequested = false;
    }
  };

  loopPromise = loop(); // fire-and-forget — single async chain, never overlaps
  state.loopPromise = loopPromise;
  void loopPromise;
  state.stopLoop = () => {
    running = false;
    requestRuntimeLoopWake(env);
  };
  return state.stopLoop;
}

export const stopRuntimeLoopAndWait = async (env: Env, timeoutMs = 10_000): Promise<boolean> => {
  const state = env.runtimeState;
  state?.stopLoop?.();
  const startedAt = Date.now();
  const loopPromise = state?.loopPromise ?? null;
  if (loopPromise) {
    const loopDone = await Promise.race([
      loopPromise.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.max(0, timeoutMs))),
    ]);
    if (!loopDone) return false;
  }
  const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
  return waitForRuntimeProcessingIdle(env, remaining);
};

export const startJurisdictionWatchers = (env: Env): void => {
  if (!env.jReplicas || env.jReplicas.size === 0) return;
  const watcherOwners = new Map<string, JAdapter>();
  const providerUrlOf = (adapter: JAdapter, replica: JReplica): string => {
    const configured = replica.rpcs?.find((rpc) => typeof rpc === 'string' && rpc.trim().length > 0);
    if (configured) return configured.trim();
    const providerWithConnection = adapter.provider as Provider & {
      _getConnection?: () => { url?: string };
    };
    return String(providerWithConnection?._getConnection?.()?.url || '').trim();
  };
  const watcherKeyOf = (replica: JReplica): string | null => {
    const adapter = replica.jadapter;
    if (!adapter) return null;
    const depository = String(replica.depositoryAddress || replica.contracts?.depository || '').trim().toLowerCase();
    const chainId = String(replica.chainId ?? adapter.chainId ?? '');
    if (adapter.mode === 'browservm') {
      return `browservm:${chainId}:${depository || replica.name}`;
    }
    const rpcUrl = providerUrlOf(adapter, replica).toLowerCase();
    return `rpc:${chainId}:${rpcUrl}:${depository || replica.name}`;
  };
  for (const [name, jReplica] of env.jReplicas.entries()) {
    const adapter = jReplica.jadapter;
    if (!adapter) continue;
    const watcherKey = watcherKeyOf(jReplica);
    const owner = watcherKey ? watcherOwners.get(watcherKey) : undefined;
    if (owner) {
      if (owner !== adapter && adapter.isWatching()) {
        adapter.stopWatching();
        console.warn(`⚠️ Stopped duplicate JAdapter watcher for "${name}" (${watcherKey})`);
      }
      continue;
    }
    if (watcherKey) {
      watcherOwners.set(watcherKey, adapter);
    }
    if (adapter.isWatching()) continue;
    adapter.startWatching(env);
    console.log(`✅ JAdapter watcher started for jReplica "${name}"`);
  }
};

const stopJurisdictionWatchers = (env: Env): void => {
  if (!env.jReplicas || env.jReplicas.size === 0) return;
  for (const [name, jReplica] of env.jReplicas.entries()) {
    const adapter = jReplica.jadapter;
    if (!adapter?.isWatching()) continue;
    try {
      adapter.stopWatching();
    } catch (error) {
      console.warn(
        `⚠️ Failed to stop JAdapter watcher for "${name}":`,
        error instanceof Error ? error.message : error,
      );
    }
  }
};

const detachRuntimeEnv = (env: Env): void => {
  const state = env.runtimeState;
  state?.stopLoop?.();
  detachRuntimeP2P(env, getRuntimeP2PLifecycleDeps());
  if (state) {
    state.lastP2PConfig = null;
    state.pendingP2PConfig = null;
    state.directEntityInputDispatch = null;
    state.loopPromise = null;
    state.stopLoop = null;
    state.wakeLoop = null;
    state.wakeRequested = false;
    state.loopActive = false;
  }
  stopJurisdictionWatchers(env);
  trackedRuntimeEnvs.delete(env);
  stopRuntimeWakeWatchdogIfIdle();
};

/**
 * Identity function for env (no module-level env exists).
 */
export const getEnv = (env?: Env | null): Env | null => {
  if (!env) {
    console.warn('⚠️ getEnv called without env - runtime no longer keeps global env');
    return null;
  }
  return env;
};

export const setRuntimeSeed = (env: Env, seed: string | null): void => {
  if (env?.lockRuntimeSeed) {
    console.warn('⚠️ Runtime seed update blocked (scenario lock enabled)');
    return;
  }
  const normalized = seed === null || seed === undefined ? '' : seed;
  env.runtimeSeed = normalized;
  if (normalized) {
    try {
      const derivedRuntimeId = normalizeRuntimeId(deriveSignerAddressSync(normalized, '1'));
      if (derivedRuntimeId) env.runtimeId = derivedRuntimeId;
      else delete env.runtimeId;
    } catch (error) {
      console.warn('⚠️ Failed to derive runtimeId from seed:', error);
      delete env.runtimeId;
    }
  } else {
    delete env.runtimeId;
  }
  if (env.runtimeId) {
    env.dbNamespace = normalizeDbNamespace(env.runtimeId);
  }
  startPendingRuntimeP2PIfReady(env, getRuntimeP2PLifecycleDeps());
};

export const setRuntimeId = (env: Env, id: string | null): void => {
  const normalizedRuntimeId = normalizeRuntimeId(id);
  if (normalizedRuntimeId) env.runtimeId = normalizedRuntimeId;
  else delete env.runtimeId;
  if (env.runtimeId) {
    env.dbNamespace = normalizeDbNamespace(env.runtimeId);
  }
  startPendingRuntimeP2PIfReady(env, getRuntimeP2PLifecycleDeps());
};

// Derive runtimeId from seed (for isolated envs that need to set their own runtimeId)
export const deriveRuntimeId = (seed: string): string => {
  return normalizeRuntimeId(deriveSignerAddressSync(seed, '1'));
};

// scheduleNetworkProcess removed — loop is always-on via startRuntimeLoop()

export const registerEntityRuntimeHint = (env: Env, entityId: string, runtimeId: string): void => {
  registerEntityRuntimeHintForRouting(env, entityId, runtimeId, getRuntimeEntityRoutingDeps());
};

export const handleInboundP2PEntityInput = (
  env: Env,
  from: string,
  input: RoutedEntityInput,
  ingressTimestamp?: number,
): void => {
  routeInboundP2PEntityInput(env, from, input, getRuntimeEntityRoutingDeps(), ingressTimestamp);
};

const getRuntimeNowMs = (env: Env): number => env.timestamp ?? 0;

function getRuntimeEntityRoutingDeps(): RuntimeEntityRoutingDeps {
  return {
    ensureRuntimeState,
    enqueueRuntimeInputs,
    extractEntityId,
    getP2P,
    startRuntimeLoop,
    processRuntime: (targetEnv) => process(targetEnv),
  };
}

function getRuntimeOutputRoutingDeps(): RuntimeOutputRoutingDeps {
  return createRuntimeOutputRoutingDeps(getRuntimeEntityRoutingDeps());
}

function getRuntimeP2PLifecycleDeps(): RuntimeP2PLifecycleDeps {
  return {
    ensureRuntimeState,
    notifyEnvChange,
    handleInboundP2PEntityInput,
  };
}

export const sendEntityInput = (
  env: Env,
  input: RoutedEntityInput,
): { sent: boolean; deferred: boolean; queuedLocal: boolean } => {
  return sendEntityInputWithRouting(env, input, getRuntimeOutputRoutingDeps());
};

export const startP2P = (env: Env, config: P2PConfig = {}) =>
  startRuntimeP2P(env, config, getRuntimeP2PLifecycleDeps());

export const stopP2P = (env: Env): void =>
  stopRuntimeP2P(env, getRuntimeP2PLifecycleDeps());

export const getP2P = (env: Env) =>
  getRuntimeP2P(env, getRuntimeP2PLifecycleDeps());

export const getP2PState = (env: Env): P2PConnectionState =>
  getRuntimeP2PState(env, getRuntimeP2PLifecycleDeps());

export const refreshGossip = (env: Env): void =>
  refreshRuntimeGossip(env, getRuntimeP2PLifecycleDeps());

export const ensureGossipProfiles = async (env: Env, entityIds: string[]): Promise<boolean> =>
  ensureRuntimeGossipProfiles(env, getRuntimeP2PLifecycleDeps(), entityIds);

export const clearGossip = (env: Env): void => {
  if (!env.gossip?.profiles) return;
  env.gossip.profiles.clear();
  void clearInfraGossipProfiles(env, infraGossipDbAccess).catch((error) => {
    console.warn(
      '[infra-db] failed to clear gossip profiles:',
      error instanceof Error ? error.message : String(error),
    );
  });
  notifyEnvChange(env);
};

/**
 * Create a runtime environment for frontend initialization.
 */
export const initEnv = (seed?: string | null): Env => {
  return createEmptyEnv(seed ?? null);
};

const notifyEnvChange = (env: Env) => {
  const state = ensureRuntimeState(env);
  if (!state.envChangeCallbacks || state.envChangeCallbacks.size === 0) return;
  for (const cb of state.envChangeCallbacks) {
    try {
      cb(env);
    } catch (error) {
      console.warn('⚠️ Env change callback failed:', error);
    }
  }
};

/**
 * Process any pending j-events after j-block finalization
 * Called automatically after each BrowserVM batch execution
 * This is the R-machine routing j-events from jReplicas to eReplicas
 */
export const processJBlockEvents = async (env: Env): Promise<void> => {
  if (!env) {
    console.warn('⚠️ processJBlockEvents: No env available');
    return;
  }

  const mempool = ensureRuntimeMempool(env);
  const pending = mempool.entityInputs.length;
  if (pending === 0) return;

  // Never process directly from UI/helper paths. Runtime loop is the single
  // state-mutating ingress executor and will consume mempool on its next tick.
  console.log(`🔗 J-BLOCK: ${pending} j-events queued in mempool (runtime loop will process)`);
};

// Note: History is now stored in env.history (no global variable needed)

// === SNAPSHOT UTILITIES ===
// All cloning utilities now moved to state-helpers.ts

// All snapshot functionality now moved to state-helpers.ts

// === UTILITY FUNCTIONS ===

const applyRuntimeInput = async (
  env: Env,
  runtimeInput: RuntimeInput,
): Promise<{
  entityOutbox: RoutedEntityInput[];
  mergedInputs: RoutedEntityInput[];
  jOutbox: JInput[];
  appliedRuntimeInput: RuntimeInput;
}> => {
  failfastAssert(
    env.scenarioMode === true || envRecord(env)[ENV_APPLY_ALLOWED_KEY] === true,
    'RUNTIME_APPLY_DIRECT_CALL',
    'applyRuntimeInput must be invoked via process()/WAL replay (non-scenario)',
    { runtimeId: env.runtimeId, height: env.height },
  );
  const startTime = getPerfMs();

  // Ensure event emitters are attached (may be lost after store serialization)
  if (!env.emit) {
    attachEventEmitters(env);
  }

  try {
    const rejectRuntimeInput = (message: string): never => {
      log.error(`❌ ${message}`);
      throw new Error(message);
    };
    if (envRecord(env)[ENV_REPLAY_MODE_KEY] === true) {
      console.log(
        `[REPLAY] applyRuntimeInput runtimeTxs=${runtimeInput.runtimeTxs.length} entityInputs=${runtimeInput.entityInputs.length}`,
      );
    }
    // SECURITY: Validate runtime input
    if (!runtimeInput) {
      rejectRuntimeInput('Null runtime input provided');
    }
    if (!Array.isArray(runtimeInput.runtimeTxs)) {
      rejectRuntimeInput(`Invalid runtimeTxs: expected array, got ${typeof runtimeInput.runtimeTxs}`);
    }
    if (!Array.isArray(runtimeInput.entityInputs)) {
      rejectRuntimeInput(`Invalid entityInputs: expected array, got ${typeof runtimeInput.entityInputs}`);
    }

    // Collect incoming J-inputs into early jOutbox (will be merged with handler jOutputs later)
    // These are NOT pushed to jReplica.mempool — they go to jOutbox → JAdapter post-save
    const earlyJOutbox: JInput[] = [];
    if (runtimeInput.jInputs && Array.isArray(runtimeInput.jInputs)) {
      console.log(`📥 [J-OUTBOX] Incoming jInputs: ${runtimeInput.jInputs.length} from mempool`);
      for (const jInput of runtimeInput.jInputs) {
        const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
        if (!jReplica) {
          console.error(
            `❌ [J-OUTBOX] Jurisdiction "${jInput.jurisdictionName}" not found — dropping ${jInput.jTxs.length} jTxs`,
          );
          continue;
        }
        console.log(
          `📥 [J-OUTBOX] Collecting ${jInput.jTxs.length} jTxs for ${jInput.jurisdictionName} (types: ${jInput.jTxs.map(t => t.type).join(',')})`,
        );
        earlyJOutbox.push(jInput);
      }
    }

    // SECURITY: Resource limits
    if (runtimeInput.runtimeTxs.length > 1000) {
      rejectRuntimeInput(`Too many runtime transactions: ${runtimeInput.runtimeTxs.length} > 1000`);
    }
    if (runtimeInput.entityInputs.length > 10000) {
      rejectRuntimeInput(`Too many entity inputs: ${runtimeInput.entityInputs.length} > 10000`);
    }

    // FINTECH-LEVEL TYPE SAFETY: Validate all inputs BEFORE mutating env
    // Clone inputs to avoid mutating caller's data
    const validatedRuntimeTxs = [...runtimeInput.runtimeTxs];
    const validatedEntityInputs = [...runtimeInput.entityInputs];

    // Validate entity inputs before merging
    validatedEntityInputs.forEach((input, i) => {
      try {
        validateEntityInput(input);
      } catch (error) {
        logError('RUNTIME_TICK', `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityInput[${i}] before merge!`, {
          error: (error as Error).message,
          input,
        });
        throw error; // Fail fast
      }
    });

    const mergedRuntimeTxs = [...validatedRuntimeTxs];
    const mergedEntityInputs = [...validatedEntityInputs];

    // Merge all entityInputs (already validated above)
    const mergedInputs = mergeEntityInputs(mergedEntityInputs);

    const entityOutbox: RoutedEntityInput[] = [];
    const appliedEntityInputs: RoutedEntityInput[] = [];
    const jOutbox: JInput[] = [...earlyJOutbox]; // Seed with incoming jInputs, handler jOutputs added later

    // Process runtime transactions (handle async operations properly)
    for (const runtimeTx of mergedRuntimeTxs) {
      if (runtimeTx.type === 'importJ') {
        console.log(`[Runtime] Importing J-machine "${runtimeTx.data.name}" (chain ${runtimeTx.data.chainId})...`);

        try {
          const { createJAdapter } = await import('./jadapter');
          const isBrowserVM = runtimeTx.data.rpcs.length === 0;

          // Create jurisdiction via unified JAdapter interface
          // If contracts provided, use fromReplica (connect-only mode, no deploy)
          const fromReplica = runtimeTx.data.contracts
            ? ({
                depositoryAddress: runtimeTx.data.contracts.depository,
                entityProviderAddress: runtimeTx.data.contracts.entityProvider,
                contracts: runtimeTx.data.contracts, // Pass all contract addresses
                chainId: runtimeTx.data.chainId,
              } as JReplica)
            : undefined;

          const adapterConfig: JAdapterConfig = {
            mode: isBrowserVM ? 'browservm' : 'rpc',
            chainId: runtimeTx.data.chainId,
          };
          if (!isBrowserVM) {
            const rpcUrl = runtimeTx.data.rpcs[0];
            if (!rpcUrl) throw new Error(`IMPORT_J_RPC_MISSING: name=${runtimeTx.data.name}`);
            adapterConfig.rpcUrl = rpcUrl;
            if (!fromReplica) {
              const deployerPrivateKey =
                globalThis.process?.env?.['JADAPTER_DEPLOYER_PRIVATE_KEY'] ||
                globalThis.process?.env?.['DEPLOYER_PRIVATE_KEY'];
              if (deployerPrivateKey) adapterConfig.privateKey = deployerPrivateKey;
            }
          }
          if (fromReplica) adapterConfig.fromReplica = fromReplica; // Pass pre-deployed addresses (skips deployment)

          const jadapter = await createJAdapter(adapterConfig);

          // Deploy contracts only if fromReplica not provided
          if (!fromReplica) {
            await jadapter.deployStack();
          }
          const defaultDisputeDelayBlocks = await ensureLocalDisputeDelayConfigured(jadapter, runtimeTx.data.name);

          // For BrowserVM, set as default jurisdiction in env
          if (isBrowserVM) {
            const browserVM = jadapter.getBrowserVM();
            if (browserVM) {
              setBrowserVMJurisdiction(env, jadapter.addresses.depository, browserVM);
            }
          }

          // Initialize jReplicas Map if needed
          if (!env.jReplicas) {
            env.jReplicas = new Map();
          }

          const resolvedDepositoryAddress = jadapter.addresses.depository || '';
          const resolvedEntityProviderAddress = jadapter.addresses.entityProvider || '';
          const resolvedAccountAddress =
            jadapter.addresses.account || runtimeTx.data.contracts?.account || '';
          const resolvedDeltaTransformerAddress =
            jadapter.addresses.deltaTransformer || runtimeTx.data.contracts?.deltaTransformer || '';
          const resolvedContracts = {
            account: resolvedAccountAddress,
            depository: resolvedDepositoryAddress,
            entityProvider: resolvedEntityProviderAddress,
            deltaTransformer: resolvedDeltaTransformerAddress,
          };

          if (!resolvedDepositoryAddress || !resolvedEntityProviderAddress) {
            throw new Error(
              `IMPORT_J_ADDRESSES_MISSING: name=${runtimeTx.data.name} ` +
                `depository=${resolvedDepositoryAddress || 'none'} ` +
                `entityProvider=${resolvedEntityProviderAddress || 'none'} ` +
                `adapterAddresses=${JSON.stringify(jadapter.addresses || {})} ` +
                `contracts=${JSON.stringify(runtimeTx.data.contracts || {})}`,
            );
          }

          // Create JReplica (store jadapter for later use)
          const jReplica: JReplica = {
            name: runtimeTx.data.name,
            blockNumber: 0n,
            stateRoot: new Uint8Array(32),
            mempool: [],
            blockDelayMs: 300,
            ...(runtimeTx.data.blockTimeMs ? { blockTimeMs: runtimeTx.data.blockTimeMs } : {}),
            lastBlockTimestamp: env.timestamp,
            position: { x: 0, y: 50, z: 0 }, // Default position for J-machine
            depositoryAddress: resolvedDepositoryAddress,
            entityProviderAddress: resolvedEntityProviderAddress,
            contracts: resolvedContracts,
            rpcs: runtimeTx.data.rpcs,
            chainId: runtimeTx.data.chainId,
            ...(defaultDisputeDelayBlocks ? { defaultDisputeDelayBlocks } : {}),
            jadapter, // Store for balance queries, faucets, etc
          };
          env.jReplicas.set(runtimeTx.data.name, jReplica);

          // Set as active if first
          if (!env.activeJurisdiction) {
            env.activeJurisdiction = runtimeTx.data.name;
          }

          // J-event watching belongs to the unified runtime watcher path.
          // Import wires the replica; startJurisdictionWatchers(env) owns startup.
          startJurisdictionWatchers(env);
          console.log(`[Runtime] ✅ JReplica "${runtimeTx.data.name}" ready`);
        } catch (error) {
          console.error(`[Runtime] ❌ Failed to import J-machine:`, error);
          throw error;
        }
      } else if (runtimeTx.type === 'importReplica') {
        const importedEntityId = String(runtimeTx.entityId || '').toLowerCase();
        const importedSignerId =
          normalizeRuntimeId(String(runtimeTx.signerId || '')) ||
          String(runtimeTx.signerId || '').trim().toLowerCase();
        if (!importedEntityId || !importedSignerId) {
          throw new Error(`IMPORT_REPLICA_INVALID_ID: entity=${runtimeTx.entityId} signer=${runtimeTx.signerId}`);
        }
        if (DEBUG)
          console.log(
            `Importing replica Entity #${formatEntityDisplay(importedEntityId)}:${formatSignerDisplay(importedSignerId)} (proposer: ${runtimeTx.data.isProposer})`,
          );

        const replicaKey = `${importedEntityId}:${importedSignerId}`;
        let existingReplicaKey = replicaKey;
        let existingReplica = env.eReplicas.get(replicaKey);
        if (!existingReplica) {
          for (const [key, candidate] of env.eReplicas.entries()) {
            const [candidateEntity, candidateSigner] = String(key).split(':');
            if (String(candidateEntity || '').toLowerCase() !== importedEntityId) continue;
            if (String(candidateSigner || '').toLowerCase() !== importedSignerId) continue;
            existingReplicaKey = String(key);
            existingReplica = candidate;
            break;
          }
        }
        const config = requireBoundEntityConfig(env, importedEntityId, runtimeTx.data.config);
        backfillEntityJurisdictionBinding(env, importedEntityId, config.jurisdiction!);
        if (existingReplica) {
          // Persistence safety: never overwrite restored replica state on re-import.
          existingReplica.isProposer = runtimeTx.data.isProposer;
          existingReplica.entityId = importedEntityId;
          existingReplica.signerId = importedSignerId;
          existingReplica.state.entityId = importedEntityId;
          if (config) {
            existingReplica.state.config = config;
          }
          if (hasLocalSignerKey(env, importedSignerId)) {
            const expectedKeys = deriveLocalEntityCryptoKeys(env, importedEntityId, importedSignerId);
            if (
              existingReplica.state.entityEncPubKey !== expectedKeys.publicKey ||
              existingReplica.state.entityEncPrivKey !== expectedKeys.privateKey
            ) {
              throw new Error(
                `ENTITY_CRYPTO_KEY_MISMATCH: entity=${importedEntityId} signer=${importedSignerId}`,
              );
            }
          }
          normalizeEntitySwapTradingPairs(existingReplica.state);
          if (existingReplicaKey !== replicaKey) {
            env.eReplicas.delete(existingReplicaKey);
          }
          env.eReplicas.set(replicaKey, existingReplica);
          markStorageEntityDirty(env, existingReplica.state.entityId);
          if (DEBUG) {
            console.log(
              `Skipping fresh replica init for restored entity #${formatEntityDisplay(importedEntityId)}:${formatSignerDisplay(importedSignerId)}`,
            );
          }
          continue;
        }
        const replicaKeys = resolveReplicaEntityCryptoKeys(env, importedEntityId, importedSignerId);
        const replica: EntityReplica = {
          entityId: importedEntityId,
          signerId: importedSignerId,
          mempool: [],
          isProposer: runtimeTx.data.isProposer,
          state: {
            entityId: importedEntityId, // Store entityId in state
            height: 0,
            timestamp: env.timestamp,
            nonces: new Map(),
            messages: [],
            proposals: new Map(),
            config,
            // 💰 Initialize financial state
            reserves: new Map(), // tokenId -> bigint amount
            accounts: new Map(), // counterpartyEntityId -> AccountMachine
            deferredAccountProposals: new Map(),

            // 🔭 J-machine tracking (JBlock consensus)
            lastFinalizedJHeight: 0,
            jBlockObservations: [],
            jBlockChain: [],

            // Local entities derive deterministic keys; imported remote replicas stay keyless.
            entityEncPubKey: replicaKeys.publicKey,
            entityEncPrivKey: replicaKeys.privateKey,
            profile: {
              name:
                typeof runtimeTx.data.profileName === 'string' && runtimeTx.data.profileName.trim().length > 0
                  ? runtimeTx.data.profileName.trim()
                  : `Entity ${importedEntityId.slice(-4)}`,
              isHub: false,
              avatar: '',
              bio: '',
              website: '',
            },

            // 🔒 HTLC routing and fee tracking
            htlcRoutes: new Map(),
            htlcFeesEarned: 0n,
            htlcNotes: new Map(),

            lockBook: new Map(),
            swapTradingPairs: buildDefaultEntitySwapPairs(),
            pendingSwapFillRatios: new Map(),
          },
        };
        normalizeEntitySwapTradingPairs(replica.state);

        // Only add position if it exists (exactOptionalPropertyTypes compliance)
        if (runtimeTx.data.position) {
          replica.position = {
            ...runtimeTx.data.position,
            jurisdiction:
              runtimeTx.data.position.jurisdiction ||
              runtimeTx.data.position.xlnomy ||
              env.activeJurisdiction ||
              'default',
          };
        }

        env.eReplicas.set(replicaKey, replica);
        markStorageEntityDirty(env, replica.state.entityId);

        const validators = runtimeTx.data.config.validators;
        const threshold = runtimeTx.data.config.threshold;
        if (validators.length === 1 && threshold === 1n) {
          const signerId = normalizeRuntimeId(String(validators[0] || '')) || importedSignerId;
          if (!signerId) continue;
          try {
            const privateKey = getSignerPrivateKey(env, signerId);
            const privateKeyHex = `0x${Array.from(privateKey)
              .map(b => b.toString(16).padStart(2, '0'))
              .join('')}`;
            for (const jReplica of env.jReplicas?.values?.() ?? []) {
              jReplica.jadapter?.registerEntityWallet?.(importedEntityId, privateKeyHex);
            }
          } catch (_error) {
            console.warn(
              `⚠️ Cannot derive private key for signer ${signerId} (no env.runtimeSeed), skipping entity wallet registration`,
            );
          }
        }

        // Validate jBlock immediately after creation
        const createdReplica = env.eReplicas.get(replicaKey);
        const actualJBlock = createdReplica?.state.lastFinalizedJHeight;
        // REPLICA-DEBUG removed

        // Broadcast initial profile to gossip layer
        if (env.gossip && createdReplica && replicaKeys.isLocal) {
          announceLocalEntityProfile(env, createdReplica.state, env.timestamp);
        }

        if (typeof actualJBlock !== 'number') {
          logError('RUNTIME_TICK', `💥 ENTITY-CREATION-BUG: Just created entity with invalid jBlock!`);
          logError('RUNTIME_TICK', `💥   Expected: 0 (number), Got: ${typeof actualJBlock}, Value: ${actualJBlock}`);
          // Force fix immediately
          if (createdReplica) {
            createdReplica.state.lastFinalizedJHeight = 0;
            console.log(`💥   FIXED: Set jBlock to 0 for replica ${replicaKey}`);
          }
        }
      }
    }
    // REPLICA-DEBUG and SERVER-PROCESSING logs removed
    const findReplicaKeyInsensitive = (entityId: string, signerId?: string | null): string | null => {
      const entityNorm = String(entityId || '').toLowerCase();
      const signerNorm = signerId ? String(signerId).toLowerCase() : null;
      for (const key of env.eReplicas.keys()) {
        const [repEntityId, repSignerId] = String(key).split(':');
        if (!repEntityId || String(repEntityId).toLowerCase() !== entityNorm) continue;
        if (!signerNorm) return key;
        if (repSignerId && String(repSignerId).toLowerCase() === signerNorm) return key;
      }
      return null;
    };

    const isReplay = envRecord(env)[ENV_REPLAY_MODE_KEY] === true;

    for (const entityInput of mergedInputs) {
      if (envRecord(env)[ENV_REPLAY_MODE_KEY] === true) {
        console.log(
          `[REPLAY][RUNTIME] merged input entity=${String(entityInput.entityId).slice(-8)} ` +
            `signer=${String(entityInput.signerId ?? '')} txs=${entityInput.entityTxs?.length ?? 0} ` +
            `types=${(entityInput.entityTxs ?? []).map(tx => tx.type).join(',')}`,
        );
      }
      if (
        entityInput.from &&
        entityInputHasCrossJurisdictionIntraRuntimeTx(entityInput) &&
        !isCrossJurisdictionEntityInputRemoteHopAllowed(
          entityInput,
          env.runtimeId,
          entityInput.from,
          entityId => resolveRuntimeIdForCrossJurisdictionEntity(env, entityId, getRuntimeEntityRoutingDeps()),
        )
      ) {
        const dropDetails = {
          entityId: entityInput.entityId,
          from: entityInput.from,
          txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
        };
        if (env.scenarioMode || isReplay) {
          failfastAssert(
            false,
            'RUNTIME_CROSS_J_TOPOLOGY_INVALID',
            'Cross-j system inputs must stay inside their two-runtime route topology',
            dropDetails,
          );
        }
        console.error('❌ DROP_CROSS_J_TOPOLOGY_INVALID', dropDetails);
        env.error('network', 'DROP_CROSS_J_TOPOLOGY_INVALID', dropDetails, entityInput.entityId);
        continue;
      }
      if (entityInput.from) {
        for (const hintedEntityId of collectCrossJurisdictionRemoteEntityHints(env, entityInput, entityInput.from, getRuntimeEntityRoutingDeps())) {
          registerEntityRuntimeHint(env, hintedEntityId, entityInput.from);
        }
      }
      // Track j-events in this input - entityInput.entityTxs guaranteed by validateEntityInput above
      // J-EVENT logging removed - too verbose

      // Ingress hard boundary: this runtime must never execute inputs for entities
      // it does not host. Treat as malformed/poisoned external routing and drop.
      const localEntityReplicaKey = findReplicaKeyInsensitive(entityInput.entityId, null);
      if (!localEntityReplicaKey) {
        const dropDetails = {
          entityId: entityInput.entityId,
          signerId: entityInput.signerId,
          txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
          knownEntities: Array.from(env.eReplicas.keys()).map(k => String(k).split(':')[0]).filter(Boolean),
        };
        if (env.scenarioMode || isReplay) {
          failfastAssert(
            false,
            'RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET',
            'Entity input target does not exist in local runtime',
            dropDetails,
          );
        }
        console.error('❌ DROP_ENTITY_INPUT_UNKNOWN_ENTITY', dropDetails);
        env.error('network', 'DROP_ENTITY_INPUT_UNKNOWN_ENTITY', dropDetails, entityInput.entityId);
        continue;
      }

      // Routing boundary: resolve missing signerId to local proposer before REA apply.
      // This keeps proposer lookup out of REA handlers and consensus logic.
      let actualSignerId = entityInput.signerId;
      const syntheticSignerHint = String(actualSignerId || '').toLowerCase();
      if (
        !actualSignerId ||
        actualSignerId === '' ||
        syntheticSignerHint === 'j-event' ||
        syntheticSignerHint === 'system'
      ) {
        try {
          actualSignerId = resolveEntityProposerId(env, entityInput.entityId, 'applyRuntimeInput');
        } catch (error) {
          if (env.scenarioMode || isReplay) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          env.error(
            'network',
            'DROP_ENTITY_INPUT_SIGNER_RESOLUTION_FAILED',
            {
              entityId: entityInput.entityId,
              signerId: entityInput.signerId,
              txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
              message,
            },
            entityInput.entityId,
          );
          console.error(
            '❌ DROP_ENTITY_INPUT_SIGNER_RESOLUTION_FAILED',
            {
              entityId: entityInput.entityId,
              signerId: entityInput.signerId,
              txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
              message,
            },
          );
          continue;
        }
      }
      failfastAssert(
        typeof actualSignerId === 'string' && actualSignerId.length > 0,
        'RUNTIME_SIGNER_RESOLUTION_FAILED',
        'Unable to resolve signerId for entity input',
        { entityId: entityInput.entityId, providedSignerId: entityInput.signerId },
      );

      let replicaKey = `${entityInput.entityId}:${actualSignerId}`;
      let entityReplica = env.eReplicas.get(replicaKey);
      if (!entityReplica) {
        // Recovery path for stale/misrouted signer hints: resolve to current proposer once.
        // This preserves deterministic REA behavior while keeping signer resolution at ingress.
        try {
          const proposerSignerId = resolveEntityProposerId(env, entityInput.entityId, 'applyRuntimeInput.recovery');
          if (proposerSignerId !== actualSignerId) {
            actualSignerId = proposerSignerId;
            replicaKey = `${entityInput.entityId}:${actualSignerId}`;
            entityReplica = env.eReplicas.get(replicaKey);
            if (!entityReplica) {
              const insensitiveMatch = findReplicaKeyInsensitive(entityInput.entityId, actualSignerId);
              if (insensitiveMatch) {
                replicaKey = insensitiveMatch;
                entityReplica = env.eReplicas.get(insensitiveMatch);
              }
            }
          }
        } catch (error) {
          if (env.scenarioMode || isReplay) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          const localReplicaStillExists = !!findReplicaKeyInsensitive(entityInput.entityId, null);
          if (!localReplicaStillExists) {
            const dropDetails = {
              entityId: entityInput.entityId,
              signerId: entityInput.signerId,
              txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
              message,
            };
            console.error('❌ DROP_ENTITY_INPUT_UNKNOWN_ENTITY', dropDetails);
            env.error('network', 'DROP_ENTITY_INPUT_UNKNOWN_ENTITY', dropDetails, entityInput.entityId);
            continue;
          }
          env.error(
            'network',
            'DROP_ENTITY_INPUT_SIGNER_RESOLUTION_FAILED',
            {
              entityId: entityInput.entityId,
              signerId: entityInput.signerId,
              txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
              message,
            },
            entityInput.entityId,
          );
          console.error(
            '❌ DROP_ENTITY_INPUT_SIGNER_RESOLUTION_FAILED',
            {
              entityId: entityInput.entityId,
              signerId: entityInput.signerId,
              txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
              message,
              stage: 'recovery',
            },
          );
          continue;
        }
      }

      if (!entityReplica) {
        const insensitiveMatch = findReplicaKeyInsensitive(entityInput.entityId, actualSignerId);
        if (insensitiveMatch) {
          replicaKey = insensitiveMatch;
          entityReplica = env.eReplicas.get(insensitiveMatch);
        }
      }

      // REPLICA-LOOKUP logs removed - not consensus-critical

      if (entityReplica) {
        if (DEBUG) {
          console.log(`Processing input for ${replicaKey}:`);
          if (entityInput.entityTxs?.length) console.log(`  → ${entityInput.entityTxs.length} transactions`);
          if (entityInput.proposedFrame) console.log(`  → Proposed frame: ${entityInput.proposedFrame.hash}`);
          if (entityInput.hashPrecommits?.size) console.log(`  → ${entityInput.hashPrecommits.size} precommits`);
        }

        const normalizedInput: EntityInput = {
          entityId: entityInput.entityId,
          ...(entityInput.entityTxs ? { entityTxs: entityInput.entityTxs } : {}),
          ...(entityInput.proposedFrame ? { proposedFrame: entityInput.proposedFrame } : {}),
          ...(entityInput.hashPrecommits ? { hashPrecommits: entityInput.hashPrecommits } : {}),
        };
        const normalizedInputWithSigner: EntityInput = {
          ...normalizedInput,
          signerId: actualSignerId,
        };
        appliedEntityInputs.push({
          ...normalizedInputWithSigner,
          signerId: actualSignerId,
        });
        if (envRecord(env)[ENV_REPLAY_MODE_KEY] === true) {
          console.log(
            `[REPLAY][RUNTIME] applyEntityInput replica=${replicaKey.slice(0, 20)} ` +
              `txs=${normalizedInput.entityTxs?.length ?? 0}`,
          );
        }
        const { newState, outputs, jOutputs, workingReplica } = await applyEntityInput(
          env,
          entityReplica,
          normalizedInputWithSigner,
        );
        // APPLY-ENTITY-INPUT-RESULT removed - too noisy

        // IMMUTABILITY: Update replica with new state from applyEntityInput
        // CRITICAL: Preserve proposal/lockedFrame from workingReplica (multi-signer consensus)
        // Only cleared when threshold reached and frame committed (handled in entity-consensus.ts)
        const {
          proposal: _oldProposal,
          lockedFrame: _oldLockedFrame,
          hankoWitness: _oldHankoWitness,
          validatorComputedState: _oldValidatorComputedState,
          ...replicaBase
        } = entityReplica;
        const nextReplica: EntityReplica = {
          ...replicaBase,
          state: newState,
          mempool: workingReplica.mempool, // Preserve mempool state
        };
        // Consensus artifacts are part of replica state. Rebuild them from the
        // working replica instead of spreading stale optional fields from the
        // previous replica; committed frames must be able to clear old locks.
        if (workingReplica.proposal !== undefined) nextReplica.proposal = workingReplica.proposal;
        if (workingReplica.lockedFrame !== undefined) nextReplica.lockedFrame = workingReplica.lockedFrame;
        if (workingReplica.hankoWitness !== undefined) nextReplica.hankoWitness = workingReplica.hankoWitness;
        if (workingReplica.validatorComputedState !== undefined) {
          nextReplica.validatorComputedState = workingReplica.validatorComputedState;
        }
        env.eReplicas.set(replicaKey, nextReplica);

        // FINTECH-LEVEL TYPE SAFETY: Validate all entity outputs before routing
        outputs.forEach((output, index) => {
          try {
            validateEntityOutput(output);
          } catch (error) {
            logError(
              'RUNTIME_TICK',
              `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityOutput[${index}] from ${replicaKey}!`,
              {
                error: (error as Error).message,
                output,
              },
            );
            throw error; // Fail fast to prevent financial routing corruption
          }
        });

        entityOutbox.push(...outputs);

        // Collect J-outputs (batch broadcasts)
        if (jOutputs && jOutputs.length > 0) {
          console.log(`📦 [2/6] Collecting ${jOutputs.length} jOutputs from ${replicaKey.slice(-10)}`);
          jOutbox.push(...jOutputs);
        }
        // ENTITY-OUTBOX log removed - too noisy
      } else {
        const missingReplicaDetails = {
          entityId: entityInput.entityId,
          resolvedSignerId: actualSignerId,
          inputSignerId: entityInput.signerId,
          knownReplicas: Array.from(env.eReplicas.keys()).filter(k =>
            String(k)
              .toLowerCase()
              .startsWith(`${String(entityInput.entityId).toLowerCase()}:`),
          ),
        };
        if (env.scenarioMode || isReplay) {
          failfastAssert(
            false,
            'RUNTIME_REPLICA_NOT_FOUND',
            'Entity input target replica missing after signer resolution',
            missingReplicaDetails,
          );
        }
        env.error('network', 'DROP_ENTITY_INPUT_REPLICA_NOT_FOUND', missingReplicaDetails, entityInput.entityId);
        throw new Error(
          `RUNTIME_REPLICA_NOT_FOUND: entityId=${entityInput.entityId} resolvedSignerId=${actualSignerId}`,
        );
      }
    }

    // Log J-outputs — they stay in jOutbox and are returned to process() for post-save execution
    if (jOutbox.length > 0) {
      const totalJTxs = jOutbox.reduce((n, ji) => n + ji.jTxs.length, 0);
      console.log(
        `📤 [J-OUTBOX] ${jOutbox.length} JInputs (${totalJTxs} JTxs) collected — will broadcast to JAdapter post-save`,
      );
      for (const jInput of jOutbox) {
        for (const jTx of jInput.jTxs) {
          const jTxBatchSize = (jTx.data as { batchSize?: number } | undefined)?.batchSize;
          console.log(
            `  📋 [J-OUTBOX] ${jTx.type} from ${jTx.entityId.slice(-4)} → ${jInput.jurisdictionName} (batchSize=${jTxBatchSize ?? '?'})`,
          );
          env.emit('JBatchQueued', {
            entityId: jTx.entityId,
            batchSize: jTxBatchSize,
            jurisdictionName: jInput.jurisdictionName,
          });
        }
      }
    }

    // Only create runtime frame if there's actual work to do
    const hasRuntimeTxs = mergedRuntimeTxs.length > 0;
    const meaningfulEntityInputCount = appliedEntityInputs.reduce((count, input) => {
      const hasEntityTxs = (input.entityTxs?.length || 0) > 0;
      const hasProposal = !!input.proposedFrame;
      const hasHashPrecommits = !!input.hashPrecommits && input.hashPrecommits.size > 0;
      return count + (hasEntityTxs || hasProposal || hasHashPrecommits ? 1 : 0);
    }, 0);
    const hasEntityInputs = meaningfulEntityInputCount > 0;
    const hasOutputs = entityOutbox.length > 0;
    const hasJOutputs = jOutbox.length > 0;

    if (hasRuntimeTxs || hasEntityInputs || hasOutputs || hasJOutputs) {
      // Emit runtime tick event
      env.emit('RuntimeTick', {
        height: env.height + 1,
        runtimeTxs: mergedRuntimeTxs.length,
        entityInputs: meaningfulEntityInputCount,
        outputs: entityOutbox.length,
      });

      // Update env in-place first.
      // This is intentional blockchain-style execution semantics: we execute the
      // next frame against one mutable working state, then persist the resulting
      // post-state as the committed frame below. That is simpler and safer than
      // trying to keep a separate pre-commit shadow env in lockstep.
      env.height++;
      // IMPORTANT: Do NOT mutate env.timestamp here.
      // process() sets a single frame timestamp before applyRuntimeInput(),
      // and that exact value must be used both for frame hashing and WAL journal.

      // NOTE: Snapshot creation moved to process() - single entry point
      // applyRuntimeInput just processes inputs, process() handles snapshotting
    } else {
      if (env.quietRuntimeLogs !== true) {
        console.log(`⚪ SKIP-FRAME: No runtimeTxs, entityInputs, or outputs`);
      }
      // Clear env.extra even when skipping frame to prevent stale solvency expectations
      env.extra = undefined;
    }

    // Notify Svelte about environment changes
    // REPLICA-DEBUG and GOSSIP-DEBUG removed

    // CRITICAL FIX: Initialize gossip layer if missing
    if (!env.gossip) {
      console.log(`🚨 CRITICAL: gossip layer missing from environment, creating new one`);
      env.gossip = createGossipLayer();
      console.log(`✅ Gossip layer created and added to environment`);
    }

    // Compare old vs new entities
    const oldEntityKeys = Array.from(env.eReplicas.keys()).filter(
      key =>
        key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000001:') ||
        key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000002:'),
    );
    const newEntityKeys = Array.from(env.eReplicas.keys()).filter(
      key =>
        !key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000001:') &&
        !key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000002:') &&
        !key.startsWith('0x57e360b00f393ea6d898d6119f71db49241be80aec0fbdecf6358b0103d43a31:'),
    );

    // OLD/NEW-ENTITY-DEBUG removed - too noisy

    if (oldEntityKeys.length > 0 && newEntityKeys.length > 0) {
      const oldReplicaKey = oldEntityKeys[0];
      const newReplicaKey = newEntityKeys[0];
      if (!oldReplicaKey || !newReplicaKey) {
        logError('RUNTIME_TICK', `❌ Invalid replica keys: old=${oldReplicaKey}, new=${newReplicaKey}`);
        // Continue with empty outbox instead of crashing
      } else {
        // REPLICA-STRUCTURE logs removed - not consensus-critical
      }
    }

    if (envRecord(env)[ENV_REPLAY_MODE_KEY] !== true) {
      notifyEnvChange(env);
    }

    if (DEBUG && entityOutbox.length > 0) {
      console.log(`📤 Outputs: ${entityOutbox.length} messages`);
      entityOutbox.forEach((output, i) => {
        console.log(
          `  ${i + 1}. → ${output.entityId.slice(-6)} (${output.entityTxs ? `${output.entityTxs.length} txs` : ''}${output.proposedFrame ? ` proposal: ${output.proposedFrame.hash.slice(0, 10)}...` : ''}${output.hashPrecommits ? ` ${output.hashPrecommits.size} precommits` : ''})`,
        );
      });
    } else if (DEBUG && entityOutbox.length === 0) {
      console.log(`📤 No outputs generated`);
    }

    // Replica states dump removed - too verbose

    // Always notify UI after processing a frame (this is the discrete simulation step)
    if (envRecord(env)[ENV_REPLAY_MODE_KEY] !== true) {
      notifyEnvChange(env);
    }

    // Performance logging
    const endTime = getPerfMs();
    if (DEBUG) {
      console.log(`⏱️  Tick ${env.height - 1} completed in ${endTime - startTime}ms`);
    }

    // APPLY-SERVER-INPUT-FINAL-RETURN removed
    const appliedRuntimeInput: RuntimeInput = {
      runtimeTxs: mergedRuntimeTxs,
      entityInputs: appliedEntityInputs,
      ...(runtimeInput.jInputs && runtimeInput.jInputs.length > 0 ? { jInputs: runtimeInput.jInputs } : {}),
    };
    return { entityOutbox, mergedInputs, jOutbox, appliedRuntimeInput };
  } catch (error) {
    runtimeLog.error('apply_input.failed', { error: error instanceof Error ? error.message : String(error) });
    throw error; // Don't swallow - fail fast and loud
  }
};

// Runtime bootstrap
const main = async (runtimeSeedOverride?: string | null): Promise<Env> => {
  const baseEnv = createEmptyEnv(runtimeSeedOverride ?? null);

  let env = baseEnv;
  let restoredFromCoreDb = false;
  const restoreDisabled =
    !runtimeIsBrowser &&
    !!nodeProcess &&
    /^(1|true)$/i.test(String(nodeProcess.env['XLN_DISABLE_RUNTIME_RESTORE'] ?? ''));
  if (!restoreDisabled) {
    const loaded = await loadEnvFromDB(baseEnv.runtimeId, baseEnv.runtimeSeed);
    if (loaded) {
      const loadedState = ensureRuntimeState(loaded);
      const baseState = ensureRuntimeState(baseEnv);
      if (runtimeIsBrowser) {
        loadedState.db = baseState.db;
        loadedState.dbOpenPromise = baseState.dbOpenPromise;
      }
      env = loaded;
      restoredFromCoreDb = true;
      console.log(
        `[main] restored runtime=${String(env.runtimeId || '').slice(0, 12)} height=${env.height} from storage`,
      );
    }
  }

  attachEventEmitters(env);
  if (!restoredFromCoreDb) {
    try {
      await loadGossipProfilesFromInfraDb(env, infraGossipDbAccess);
    } catch (error) {
      console.warn('[main] skipped infra gossip restore:', error instanceof Error ? error.message : String(error));
    }
  }

  if (!env.runtimeId && env.runtimeSeed) {
    try {
      env.runtimeId = deriveSignerAddressSync(env.runtimeSeed, '1');
      console.log(`🔐 Derived runtimeId: ${env.runtimeId.slice(0, 12)}...`);
    } catch (error) {
      console.warn('⚠️ Failed to derive runtimeId:', error);
    }
  }

  if (env.runtimeSeed) {
    try {
      console.log('🔐 Prewarmed signer key cache (20 addresses)');
    } catch (error) {
      console.warn('⚠️ Failed to derive signer:', error);
    }
  }

  // Start the runtime event loop (single async while-loop, never re-enters)
  if (runtimeIsBrowser) {
    console.log('🔄 [LOOP] Starting runtime event loop (browser mode)');
    startRuntimeLoop(env);
  }

  return env;
};

// === TIME MACHINE API ===
const getHistory = (env: Env) => env.history || [];
const getSnapshot = (env: Env, index: number) => {
  const history = env.history || [];
  return index >= 0 && index < history.length ? history[index] : null;
};
const getCurrentHistoryIndex = (env: Env) => (env.history || []).length - 1;

// Clear database for a specific runtime and return a fresh env
const clearDatabaseAndHistory = async (env: Env): Promise<Env> => {
  console.log('🗑️ Clearing database and resetting runtime history...');
  const db = getRuntimeDb(env);
  await clearDatabase(db);
  try {
    const infraReady = await tryOpenInfraDb(env);
    if (infraReady) {
      await clearDatabase(getInfraDb(env));
    }
  } catch (error) {
    console.warn('⚠️ Failed to clear infra DB during reset:', error instanceof Error ? error.message : error);
  }

  const seed = env.runtimeSeed ?? null;
  const freshEnv = createEmptyEnv(seed);
  if (env.runtimeId) {
    freshEnv.runtimeId = env.runtimeId;
    freshEnv.dbNamespace = normalizeDbNamespace(env.runtimeId);
  }
  attachEventEmitters(freshEnv);

  console.log('✅ Database and runtime history cleared');
  return freshEnv;
};

/**
 * Queue an entity transaction for processing (helper for UI components)
 * Wraps applyRuntimeInput with a single entity tx
 */
export const queueEntityInput = async (
  env: Env,
  entityId: string,
  signerId: string,
  txData: { type: EntityTx['type'] } & Record<string, unknown>,
): Promise<void> => {
  enqueueRuntimeInputs(
    env,
    [
        {
          entityId,
          signerId,
          entityTxs: [{ type: txData.type, data: txData } as EntityTx],
        },
    ],
    undefined,
    undefined,
    env.timestamp,
  );
};

export {
  applyRuntimeInput,
  assignNameOnChain,
  clearDatabase,
  classifyBilateralState,
  getAccountBarVisual,
  clearDatabaseAndHistory,
  // Clean logs: getCleanLogs, clearCleanLogs, copyCleanLogs - exported at definition
  // Entity creation functions
  createLazyEntity,
  createNumberedEntity,
  createNumberedEntitiesBatch,
  createProfileUpdateTx,
  detectEntityType,
  encodeBoard,
  // Display and avatar functions
  formatEntityDisplay,
  formatSignerDisplay,
  hashToAvatar,
  generateEntityAvatar,
  // Entity utility functions
  generateLazyEntityId,
  generateNamedEntityId,
  generateNumberedEntityId,
  generateSignerAvatar,
  getAvailableJurisdictions,
  getCurrentHistoryIndex,
  getEntityDisplayInfo,
  getEntityDisplayInfoFromProfile,
  getEntityInfoFromChain,
  getHistory,
  getJurisdictionByAddress,
  getSignerDisplayInfo,
  getSnapshot,
  hashBoard,
  isEntityRegistered,
  main,
  resolveEntityProposerId,
  requestNamedEntity,
  resolveEntityIdentifier,
  resolveEntityName,
  // Name resolution functions
  searchEntityNames,
  setBrowserVMJurisdiction,
  getBrowserVMInstance,
  // getEnv, initEnv, processJBlockEvents - already exported inline above
  submitProcessBatch,
  debugFundReserves,
  transferNameBetweenEntities,
  // Account utilities (destructured from AccountUtils)
  deriveDelta,
  isLeft,
  getTokenInfo,
  isLiquidSwapToken,
  getSwapPairOrientation,
  getDefaultSwapTradingPairs,
  listOpenSwapOffers,
  computeSwapPriceTicks,
  prepareSwapOrder,
  quantizeSwapOrder,
  formatTokenAmount,
  createDemoDelta,
  getDefaultCreditLimit,

  // Entity utilities (from entity-helpers and serialization-utils)
  getEntityShortId,
  formatEntityId,
  safeStringify,

  // Financial utilities (ethers.js-based, precision-safe)
  formatTokenAmountEthers,
  parseTokenAmount,
  convertTokenPrecision,
  calculatePercentageEthers,
  formatAssetAmountEthers,
  BigIntMath,
  FINANCIAL_CONSTANTS,

  // Validation utilities (strict typing for financial data)
  validateDelta,
  validateAccountDeltas,
  createDefaultDelta,
  isDelta,

  // Snapshot utilities
  encode,
  decode,

  // System solvency (conservation of tokens)
  calculateSolvency,
  verifySolvency,

  // Identity system (from ids.ts) - replaces split(':') patterns
  parseReplicaKey,
  extractEntityId,
  extractSignerId,
  formatReplicaKey,
  createReplicaKey,
  formatReplicaDisplay,
  // Type guards
  isValidEntityId,
  isValidSignerId,
  isValidJId,
  isValidEpAddress,
  // Constructors
  toEntityId,
  toSignerId,
  toJId,
  toEpAddress,
  // Entity type detection
  isNumberedEntity,
  isLazyEntity,
  getEntityDisplayNumber,
  // URI operations (for future networking)
  formatReplicaUri,
  parseReplicaUri,
  createLocalUri,
  // Type-safe collections
  ReplicaMap,
  EntityMap,
  // Jurisdiction helpers
  jIdFromChainId,
  createLazyJId,
  // Migration helpers
  safeParseReplicaKey,
  safeExtractEntityId,
  // Constants
  XLN_URI_SCHEME,
  DEFAULT_RUNTIME_HOST,
  XLN_COORDINATOR,
  CHAIN_IDS,
  MAX_NUMBERED_ENTITY,

  // Account messaging: Using bilateral frame-based consensus instead of direct messaging
  // (Old direct messaging functions removed - replaced with AccountInput flow)
};

// Re-export types from ids.ts for frontend use
export type {
  EntityId,
  SignerId,
  JId,
  EntityProviderAddress,
  ReplicaKey,
  FullReplicaAddress,
  ReplicaUri,
  JurisdictionInfo,
} from './ids';

// Runtime is a pure library - no auto-execution side effects.
// Browser and server entrypoints call xln.main() explicitly.

export const createEmptyEnv = (seed?: Uint8Array | string | null): Env => {
  const normalizedSeed = Array.isArray(seed) ? new Uint8Array(seed) : seed;
  const seedText =
    normalizedSeed !== undefined && normalizedSeed !== null
      ? typeof normalizedSeed === 'string'
        ? normalizedSeed
        : new TextDecoder().decode(normalizedSeed)
      : '';
  const derivedRuntimeId = seedText ? deriveRuntimeIdFromSeed(seedText) : null;
  const resolvedRuntimeId = derivedRuntimeId ? derivedRuntimeId.toLowerCase() : null;
  const resolvedDbNamespace = resolvedRuntimeId ? normalizeDbNamespace(resolvedRuntimeId) : undefined;

  let env!: Env;
  const gossip = createGossipLayer({
    onAnnounce: (profile) => {
      if (!env) return;
      void persistGossipProfileToInfraDb(env, infraGossipDbAccess, profile).catch((error) => {
        console.warn(
          `[infra-db] failed to persist gossip profile ${String(profile?.entityId || '').slice(-8)}:`,
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    getLiveProfiles: () => {
      if (!env?.eReplicas || env.eReplicas.size === 0) return [];
      const profiles = new Map<string, Profile>();
      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        const entityId = extractEntityId(replicaKey);
        const signerId = extractSignerId(replicaKey);
        if (!entityId || !signerId) continue;
        try {
          getSignerPrivateKey(env, signerId);
        } catch {
          continue;
        }
        if (profiles.has(entityId)) continue;
        const existingTs = env.gossip?.getProfiles?.().find((profile) => profile.entityId === entityId)?.lastUpdated ?? 0;
        const liveTimestamp = Math.max(existingTs + 1, env.timestamp || 1);
        profiles.set(entityId, buildLocalEntityProfile(env, replica.state, liveTimestamp));
      }
      return Array.from(profiles.values());
    },
  });

  env = {
    eReplicas: new Map(),
    jReplicas: new Map(),
    height: 0,
	    timestamp: 0,
	    ...(seedText !== undefined && seedText !== null ? { runtimeSeed: seedText } : {}),
	    ...(resolvedRuntimeId ? { runtimeId: resolvedRuntimeId } : {}),
    ...(resolvedDbNamespace ? { dbNamespace: resolvedDbNamespace } : {}),
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    runtimeMempool: undefined,
    runtimeConfig: undefined,
    runtimeState: undefined,
    history: [],
    gossip,
    frameLogs: [],
    networkInbox: [],
    pendingNetworkOutputs: [],
    // Event emitters will be attached below
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    emit: () => {},
    // BrowserVM will be lazily initialized on first adapter use
    browserVM: null,
    // EVM instances (unified interface) - use createEVM() to add
    evms: new Map(),
  };

  // Attach event emission methods (EVM-style)
  attachEventEmitters(env);

  // Ensure runtime structures exist
  ensureRuntimeMempool(env);
  ensureRuntimeConfig(env);
  ensureRuntimeState(env);
  if (seedText) {
    try {
      prewarmSignerKeyCache(seedText, 20);
    } catch (error) {
      console.warn('⚠️ Failed to prewarm signer cache during env creation:', error);
    }
  }

  return env;
};

const requirePersistedContractAddress = (
  jReplicas: Map<string, JReplica>,
  label: string,
  contractName: 'depository' | 'entityProvider' | 'deltaTransformer',
): string => {
  for (const [, jReplica] of jReplicas.entries()) {
    const rawAddress =
      contractName === 'depository'
        ? jReplica.depositoryAddress ?? jReplica.contracts?.depository
        : contractName === 'entityProvider'
          ? jReplica.entityProviderAddress ?? jReplica.contracts?.entityProvider
          : jReplica.contracts?.deltaTransformer;
    const restoredAddress = String(rawAddress ?? '').trim();
    if (restoredAddress && ethers.isAddress(restoredAddress)) {
      return restoredAddress;
    }
  }
  throw new Error(`MISSING_${contractName.toUpperCase()}_ADDRESS: ${label}`);
};

const findPersistedContractAddress = (
  jReplicas: Map<string, JReplica>,
  contractName: 'depository' | 'entityProvider' | 'deltaTransformer',
): string => {
  for (const [, jReplica] of jReplicas.entries()) {
    const rawAddress =
      contractName === 'depository'
        ? jReplica.depositoryAddress ?? jReplica.contracts?.depository
        : contractName === 'entityProvider'
          ? jReplica.entityProviderAddress ?? jReplica.contracts?.entityProvider
          : jReplica.contracts?.deltaTransformer;
    const restoredAddress = String(rawAddress ?? '').trim();
    if (restoredAddress && ethers.isAddress(restoredAddress)) {
      return restoredAddress;
    }
  }
  return '';
};

const assertPersistedContractConfigReady = (env: Env, label: string): void => {
  if (env.jReplicas && env.jReplicas.size > 0) {
    requirePersistedContractAddress(env.jReplicas, label, 'depository');
    requirePersistedContractAddress(env.jReplicas, label, 'entityProvider');
    setDeltaTransformerAddress(findPersistedContractAddress(env.jReplicas, 'deltaTransformer'));
  }
};

// === CONSENSUS PROCESSING ===
// ONE TICK = ONE ITERATION. No cascade. E→E communication always requires new tick.

export const process = async (env: Env, inputs?: RoutedEntityInput[], runtimeDelay = 0) => {
  const processState = ensureRuntimeState(env);
  while (processState.processingPromise) {
    await processState.processingPromise;
  }
  let releaseProcessLock: () => void = () => {};
  processState.processingPromise = new Promise<void>(resolve => {
    releaseProcessLock = resolve;
  });

  try {
    // IMPORTANT: capture frame baseline only after acquiring the process lock.
    // If captured before waiting on an in-flight tick, we can mis-detect
    // frame advancement and overwrite WAL entries with empty runtime input.
    const frameHeightBeforeTick = env.height;
    env.lastProcessEnteredAt = Date.now();

    if (!env.emit) {
      attachEventEmitters(env);
    }

    if (env.stopAtFrame !== undefined && env.height >= env.stopAtFrame) {
      console.log(`\n⏸️  FRAME STEPPING: Stopped at frame ${env.height}`);
      console.log('═'.repeat(80));
      const { formatRuntime } = await import('./runtime-ascii');
      console.log(formatRuntime(env, { maxAccounts: 10, maxLocks: 20, maxSwaps: 20 }));
      console.log('═'.repeat(80) + '\n');
      console.log('💾 State captured - use jq on /tmp/{scenario}-runtime.json for deep queries');
      throw new Error(`FRAME_STEP: Stopped at frame ${env.height} for debugging`);
    }

    if (inputs && inputs.length > 0) {
      enqueueRuntimeInputs(env, inputs, undefined, undefined, env.timestamp);
    }
    if (env.pendingOutputs && env.pendingOutputs.length > 0) {
      enqueueRuntimeInputs(env, env.pendingOutputs, undefined, undefined, env.timestamp);
      env.pendingOutputs = [];
    }
    if (env.networkInbox && env.networkInbox.length > 0) {
      enqueueRuntimeInputs(env, env.networkInbox, undefined, undefined, env.timestamp);
      env.networkInbox = [];
    }

    if (!hasRuntimeWork(env)) return env;

    const runtimeState = ensureRuntimeState(env);
    const mempoolBeforeTick = ensureRuntimeMempool(env);
    const queuedAtBeforeTick = mempoolBeforeTick.queuedAt;
    const shouldAdvanceLogicalTime =
      !env.scenarioMode &&
      typeof queuedAtBeforeTick === 'number' &&
      Number.isFinite(queuedAtBeforeTick) &&
      queuedAtBeforeTick > (env.timestamp ?? 0);
    const frameGateNow = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
    if (!isRuntimeFrameReady(env, frameGateNow, runtimeDelay)) {
      return env;
    }

    const state = ensureRuntimeState(env);
    const quietRuntimeLogs = env.quietRuntimeLogs === true;
    for (const jReplica of env.jReplicas?.values?.() ?? []) {
      jReplica.jadapter?.setQuietLogs?.(quietRuntimeLogs);
    }

    if (env.scenarioMode) {
      env.timestamp = (env.timestamp ?? 0) + 100;
    } else if (shouldAdvanceLogicalTime || runtimeState.clockPrimed) {
      env.timestamp = Math.max(env.timestamp ?? 0, queuedAtBeforeTick ?? (env.timestamp ?? 0));
    }
    for (const jReplica of env.jReplicas?.values?.() ?? []) {
      jReplica.jadapter?.setBlockTimestamp(env.timestamp);
    }

    // Inject pings for entities with due scheduled hooks (setTimeout-like)
    generateHookPings(env);

    const mempool = ensureRuntimeMempool(env);
    const runtimeInput: RuntimeInput = {
      runtimeTxs: [...mempool.runtimeTxs],
      entityInputs: [...mempool.entityInputs],
      ...(mempool.jInputs && mempool.jInputs.length > 0 ? { jInputs: [...mempool.jInputs] } : {}),
    };
    const mempoolQueuedAt = mempool.queuedAt;
    mempool.runtimeTxs = [];
    mempool.entityInputs = [];
    if (mempool.jInputs) mempool.jInputs = [];
    mempool.queuedAt = undefined;

    const hasRuntimeInput =
      runtimeInput.runtimeTxs.length > 0 ||
      runtimeInput.entityInputs.length > 0 ||
      (runtimeInput.jInputs?.length ?? 0) > 0;
    let appliedRuntimeInputForPersistence: RuntimeInput | undefined;

    let entityOutbox: RoutedEntityInput[] = [];
    let jOutbox: JInput[] = [];
    const changedEntityIds = new Set<string>();
    const getLocallySignableEntityIds = (): Set<string> => {
      const localEntityIds = new Set<string>();
      for (const replicaKey of env.eReplicas.keys()) {
        try {
          const signerId = extractSignerId(replicaKey);
          if (!signerId) continue;
          getSignerPrivateKey(env, signerId);
          localEntityIds.add(extractEntityId(replicaKey).toLowerCase());
        } catch {
          // ignore malformed key
        }
      }
      return localEntityIds;
    };
    const getAdvertisedStateFingerprints = (localEntityIds: ReadonlySet<string>): Map<string, string> => {
      const fingerprints = new Map<string, string>();
      if (localEntityIds.size === 0) return fingerprints;
      for (const replica of env.eReplicas.values()) {
        const entityId = String(replica?.entityId || '').toLowerCase();
        if (!entityId || !localEntityIds.has(entityId) || fingerprints.has(entityId)) continue;
        try {
          fingerprints.set(entityId, buildEntityAdvertisedStateFingerprint(replica.state, createProfileSignerResolver(env)));
        } catch (error) {
          if (!quietRuntimeLogs) {
            console.warn(`GOSSIP_PROFILE_FINGERPRINT_SKIP: entity=${entityId.slice(-8)} error=${(error as Error).message}`);
          }
        }
      }
      return fingerprints;
    };
    const advertisedStateBeforeApply = getAdvertisedStateFingerprints(getLocallySignableEntityIds());
    const shouldAnnounceEntityProfile = (input: RoutedEntityInput): boolean => {
      if (!input?.entityTxs?.length) return false;
      return input.entityTxs.some(
        tx =>
          tx.type === 'openAccount' ||
          tx.type === 'profile-update',
      );
    };
    if (hasRuntimeInput) {
      if (!quietRuntimeLogs) {
        console.log(
          `📥 TICK: Processing ${runtimeInput.entityInputs.length} inputs for [${runtimeInput.entityInputs.map(o => o.entityId.slice(-4)).join(',')}]`,
        );
        if (runtimeInput.runtimeTxs.length > 0) {
          console.log(`📥 TICK: Processing ${runtimeInput.runtimeTxs.length} queued runtimeTxs`);
        }
      }
      try {
        envRecord(env)[ENV_APPLY_ALLOWED_KEY] = true;
        const result = await applyRuntimeInput(env, runtimeInput);
        if (!quietRuntimeLogs && (result.entityOutbox.length > 0 || result.jOutbox.length > 0)) {
          console.log(
            `🔍 PROCESS: applyRuntimeInput returned entityOutbox=${result.entityOutbox.length}, jOutbox=${result.jOutbox.length}`,
          );
        }
        entityOutbox = result.entityOutbox;
        jOutbox = result.jOutbox;
        appliedRuntimeInputForPersistence = result.appliedRuntimeInput;
        for (const runtimeTx of runtimeInput.runtimeTxs) {
          if (runtimeTx.type === 'importReplica') {
            changedEntityIds.add(runtimeTx.entityId.toLowerCase());
          }
        }
        for (const entityInput of runtimeInput.entityInputs) {
          if (entityInput.entityId && shouldAnnounceEntityProfile(entityInput)) {
            changedEntityIds.add(entityInput.entityId.toLowerCase());
          }
        }
        const advertisedStateAfterApply = getAdvertisedStateFingerprints(getLocallySignableEntityIds());
        for (const [entityId, fingerprint] of advertisedStateAfterApply.entries()) {
          if (advertisedStateBeforeApply.get(entityId) !== fingerprint) {
            changedEntityIds.add(entityId);
          }
        }
      } catch (error) {
        // Failed apply never becomes durable. We restore ingress back to the
        // mempool and abort this tick; only saveEnvToDB() below makes a frame
        // restartable / committed.
        mempool.runtimeTxs = [...runtimeInput.runtimeTxs, ...mempool.runtimeTxs];
        mempool.entityInputs = [...runtimeInput.entityInputs, ...mempool.entityInputs];
        if (runtimeInput.jInputs) {
          mempool.jInputs = [...runtimeInput.jInputs, ...(mempool.jInputs ?? [])];
        }
        if (mempool.queuedAt === undefined) {
          mempool.queuedAt = mempoolQueuedAt ?? (env.timestamp ?? 0);
        }
        clearPendingAuditEvents(env);
        throw error;
      } finally {
        envRecord(env)[ENV_APPLY_ALLOWED_KEY] = false;
      }
    }

    // Retry deferred network outputs only when their retry window is due.
    const outputRoutingDeps = getRuntimeOutputRoutingDeps();
    const pendingBeforePlan = env.pendingNetworkOutputs ?? [];
    const { ready: readyPendingOutputs, waiting: waitingPendingOutputs } = splitPendingOutputsByRetryWindow(
      env,
      pendingBeforePlan,
      outputRoutingDeps,
    );
    const outputsToPlan = readyPendingOutputs.length > 0 ? [...readyPendingOutputs, ...entityOutbox] : entityOutbox;
    const { localOutputs, remoteOutputs, deferredOutputs } = planEntityOutputs(env, outputsToPlan, outputRoutingDeps);
    env.pendingNetworkOutputs = [];
    if (localOutputs.length > 0) {
      enqueueRuntimeInputs(env, localOutputs, undefined, undefined, env.timestamp);
      if (!quietRuntimeLogs) {
        console.log(
          `📤 TICK: ${localOutputs.length} local outputs queued for next tick → [${localOutputs.map(o => o.entityId.slice(-4)).join(',')}]`,
        );
      }
    }
    // Re-check due crontab work after apply. Hooks scheduled at the current
    // logical timestamp should run on the next tick without importing wall
    // clock time into runtime consensus.
    generateHookPings(env);
    // BrowserVM trie is NOT serialized per-frame — it's J-layer state.
    // Only serialized on shutdown/page-unload for reload recovery.

    const frameAdvanced = env.height !== frameHeightBeforeTick;
    if (frameAdvanced) {
      const committedFrameLogs = Array.isArray(env.frameLogs)
        ? env.frameLogs.map((entry): FrameLogEntry => ({ ...entry }))
        : [];
      const snapshot = buildCanonicalEnvSnapshot(env, {
        runtimeInput: env.runtimeInput ?? { runtimeTxs: [], entityInputs: [] },
        runtimeOutputs: env.pendingOutputs ?? [],
        description: env.extra?.description ?? `Frame ${env.height}`,
        meta: {
          title: env.extra?.subtitle?.title ?? `Frame ${env.height}`,
          ...(env.extra?.subtitle ? { subtitle: env.extra.subtitle } : {}),
          ...(env.frameDisplayMs !== undefined ? { displayMs: env.frameDisplayMs } : {}),
        },
        logs: committedFrameLogs,
        gossipProfiles: env.gossip?.getProfiles ? env.gossip.getProfiles() : [],
      });

      if (!env.history) env.history = [];
      // History is a local/debug timeline, not the durable source of truth.
      // If the process crashes before WAL save, this in-memory tail is expected
      // to disappear; replay always trusts persisted frames, not env.history.
      env.history.push(snapshot);

      if (!quietRuntimeLogs) {
        console.log(`📸 Snapshot: ${snapshot.meta?.title ?? `Frame ${env.height}`} (${env.history.length} total)`);
      }
    }
    env.extra = undefined;

    // === COMMIT POINT: persist finalized R-frame ===
    // Persist only when a new runtime frame was actually applied.
    // Side-effect-only ticks (e.g. deferred network retries) must never
    // overwrite WAL entries for the current height.
    //
    // Why this ordering exists:
    // 1. applyRuntimeInput() computes the post-state for frame N in memory
    // 2. saveEnvToDB() makes frame N durable / replayable
    // 3. only after that do we treat downstream effects as safe to emit
    //
    // That keeps execution, hashing, and recovery aligned around one exact
    // post-state. A crash before save loses only the uncommitted in-memory
    // tail, just like a block that executed locally but was never committed.
    if (frameAdvanced) {
      if (!quietRuntimeLogs) {
        console.log(`💾 [SAVE] Persisting R-frame ${env.height} to LevelDB...`);
      }
      try {
        await saveEnvToDB(env, appliedRuntimeInputForPersistence, entityOutbox);
        flushPendingAuditEvents(env);
        env.frameLogs = [];
        if (!quietRuntimeLogs) {
          console.log(`💾 [SAVE] R-frame ${env.height} persisted`);
        }
      } catch (error) {
        clearPendingAuditEvents(env);
        throw error;
      }
    } else {
      clearPendingAuditEvents(env);
    }

    // === SIDE EFFECTS (safe to fail — bilateral consensus retries) ===

    // 1. Broadcast entity outputs via P2P (fire-and-forget)
    if (remoteOutputs.length > 0) {
      console.log(`📡 [SIDE-EFFECT] Dispatching ${remoteOutputs.length} remote entity outputs via P2P`);
    }
    const dispatchDeferred = dispatchEntityOutputs(env, remoteOutputs, outputRoutingDeps);

    const allDeferred = [...deferredOutputs, ...dispatchDeferred];
    env.pendingNetworkOutputs = rescheduleDeferredOutputs(
      env,
      readyPendingOutputs,
      allDeferred,
      waitingPendingOutputs,
      outputRoutingDeps,
    );

    // 1b. Re-announce gossip profiles after account state changes (new accounts, capacity shifts)
    // Broadcast changed local entities so relay routing metadata stays fresh.
    const p2p = getP2P(env);
    if (p2p) {
      const localEntityIds = getLocallySignableEntityIds();
      const changedLocalEntityIds = [...changedEntityIds].filter(entityId => localEntityIds.has(entityId));
      if (changedLocalEntityIds.length > 0) {
        p2p.announceProfilesForEntities(changedLocalEntityIds, 'routing-profile-refresh');
      }
    }

    // 2. Execute J-batches via JAdapter.submitTx (events arrive next frame via j-watcher)
    if (jOutbox.length > 0) {
      const totalJTxs = jOutbox.reduce((n, ji) => n + ji.jTxs.length, 0);
      console.log(`⚡ [SIDE-EFFECT] Submitting ${totalJTxs} J-txs via JAdapter (${jOutbox.length} JInputs)`);

      for (const jInput of jOutbox) {
        const queueMissingInfraAbort = (reason: string) => {
          const compactReason = String(reason || 'unknown').slice(0, 240);
          for (const jTx of jInput.jTxs) {
            if (jTx.type !== 'batch') continue;
            const signerId = typeof jTx.data?.signerId === 'string' ? jTx.data.signerId : undefined;
            enqueueRuntimeInputs(
              env,
              [
                {
                  entityId: jTx.entityId,
                  ...(signerId ? { signerId } : {}),
                  entityTxs: [
                    {
                      type: 'j_abort_sent_batch',
                      data: {
                        requeueToCurrent: true,
                        reason: `submit_failed:${compactReason}`,
                      },
                    },
                  ],
                },
              ],
              undefined,
              undefined,
              env.timestamp,
            );
          }
        };

        const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
        if (!jReplica) {
          console.error(`❌ [J-SUBMIT] Jurisdiction "${jInput.jurisdictionName}" not found — skipping`);
          queueMissingInfraAbort(`missing_jReplica:${jInput.jurisdictionName}`);
          continue;
        }

        const jAdapter = jReplica.jadapter;
        if (!jAdapter) {
          console.error(`❌ [J-SUBMIT] No JAdapter for jurisdiction "${jInput.jurisdictionName}" — skipping`);
          queueMissingInfraAbort(`missing_jAdapter:${jInput.jurisdictionName}`);
          continue;
        }

        for (const jTx of jInput.jTxs) {
          console.log(`📤 [J-SUBMIT] ${jTx.type} from ${jTx.entityId.slice(-4)} → ${jInput.jurisdictionName}`);
          const queueAbortSentBatch = (reason: string) => {
            if (jTx.type !== 'batch') return;
            const signerId = typeof jTx.data?.signerId === 'string' ? jTx.data.signerId : undefined;
            const compactReason = String(reason || 'unknown').slice(0, 240);
            enqueueRuntimeInputs(
              env,
              [
                {
                  entityId: jTx.entityId,
                  ...(signerId ? { signerId } : {}),
                  entityTxs: [
                    {
                      type: 'j_abort_sent_batch',
                      data: {
                        requeueToCurrent: true,
                        reason: `submit_failed:${compactReason}`,
                      },
                    },
                  ],
                },
              ],
              undefined,
              undefined,
              env.timestamp,
            );
            console.warn(
              `⚠️ [J-SUBMIT] queued j_abort_sent_batch for ${jTx.entityId.slice(-4)} after failed batch submission`,
            );
          };
          try {
            const submitData = jTx.data as { signerId?: unknown } | undefined;
            const submitSignerId = typeof submitData?.signerId === 'string' ? submitData.signerId : undefined;
            const submitSignerPrivateKey = submitSignerId ? getCachedSignerPrivateKey(submitSignerId) : null;
            const result = await jAdapter.submitTx(jTx, {
              env,
              ...(submitSignerId ? { signerId: submitSignerId } : {}),
              ...(submitSignerPrivateKey ? { signerPrivateKey: submitSignerPrivateKey } : {}),
              timestamp: jTx.timestamp ?? env.timestamp,
            });

            if (result.success) {
              console.log(
                `✅ [J-SUBMIT] ${jTx.type} from ${jTx.entityId.slice(-4)}: ok (events=${result.events?.length ?? 0}, txHash=${result.txHash ?? 'n/a'})`,
              );
            } else {
              console.error(`❌ [J-SUBMIT] ${jTx.type} from ${jTx.entityId.slice(-4)} FAILED: ${result.error}`);
              if (!env.scenarioMode) {
                queueAbortSentBatch(result.error || 'unknown');
              }
              if (env.scenarioMode) {
                throw new Error(`J-SUBMIT FAILED: ${result.error || 'unknown'}`);
              }
            }
          } catch (error) {
            console.error(`❌ [J-SUBMIT] submitTx threw for ${jTx.entityId.slice(-4)}:`, error);
            if (!env.scenarioMode) {
              const msg = error instanceof Error ? error.message : String(error);
              queueAbortSentBatch(msg);
            }
            if (env.scenarioMode) throw error;
          }
        }

        // Submission does not own the watcher cursor.
        // The only authoritative J-height/blockNumber advancement path is:
        //   watcher poll -> processEventBatch -> updateWatcherJurisdictionCursor(...)
        //
        // Why this must stay watcher-owned:
        // - submitTx success only proves the tx was accepted locally/by RPC, not that all
        //   finalized J-events from the mined block were ingested into runtime state
        // - persisting a speculative blockNumber here can make WAL/snapshots resume from
        //   after a block whose events were never actually applied
        // - after restart, getWatcherStartBlock() would then skip the missed finalized
        //   range and one side can stay stale forever
        //
        // Keep only local submit timestamp metadata here. Let the watcher commit height.
        jReplica.lastBlockTimestamp = env.timestamp;
      }
    }

    state.lastFrameAt = getWallClockMs();

    if (env.strictScenario) {
      const { assertRuntimeStateStrict } = await import('./strict-assertions');
      await assertRuntimeStateStrict(env);
    }

    // CRITICAL: Notify frontend after snapshot is pushed to history
    // Without this, UI (TimeMachine, AccountPanel) never learns about new frames
    notifyEnvChange(env);

    return env;
  } finally {
    processState.processingPromise = null;
    releaseProcessLock();
  }
};

export const waitForRuntimeProcessingIdle = async (env: Env, timeoutMs = 5_000): Promise<boolean> => {
  const startedAt = Date.now();
  while (true) {
    const pending = env.runtimeState?.processingPromise;
    if (!pending) return true;
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) return false;
    const completed = await Promise.race([
      pending.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remaining)),
    ]);
    if (!completed) return false;
  }
};

// === LEVELDB PERSISTENCE ===
export const saveEnvToDB = async (
  env: Env,
  currentFrameInput?: RuntimeInput,
  _currentFrameOutputs?: RoutedEntityInput[],
): Promise<void> => {
  if (envRecord(env)[ENV_REPLAY_MODE_KEY] === true) {
    throw new Error('REPLAY_INVARIANT_FAILED: saveEnvToDB called during replay');
  }
  const pendingFrameDbRecords = peekPendingFrameDbRecords(env, env.height, env.timestamp);
  const saveResult = await saveRuntimeFrameToStorage({
    env,
    tryOpenDb: (targetEnv) => tryOpenStorageDb(targetEnv, 'current'),
    getRuntimeDb: (targetEnv) => getStorageDb(targetEnv, 'current'),
    tryOpenFrameDb,
    getFrameDb,
    rotateEpochDb: rotateStorageEpochDb,
	    getPerfMs,
	    formatPerfMs,
	    frameDbRecords: pendingFrameDbRecords,
	    ...(currentFrameInput === undefined ? {} : { currentFrameInput }),
	  });
  if (saveResult.frameDbCommitted) {
    dropPendingFrameDbRecords(env, pendingFrameDbRecords.length);
  }
  if (saveResult.materialized) {
    dropOverlay(env, saveResult.materializedOverlayRecords);
  }
  if (runtimeIsBrowser && typeof BroadcastChannel !== 'undefined' && typeof env.runtimeId === 'string' && env.runtimeId.length > 0) {
    const runtimeSyncChannel = new BroadcastChannel('xln-runtime-sync');
    runtimeSyncChannel.postMessage({
      runtimeId: env.runtimeId,
      height: env.height,
    });
    runtimeSyncChannel.close();
  }
};

type VerifyRuntimeChainResult = {
  ok: boolean;
  latestHeight: number;
  checkpointHeight: number;
  selectedSnapshotHeight: number;
  restoredHeight: number;
  expectedStateHash: string;
  actualStateHash: string;
  expectedCanonicalStateHash?: string;
  actualCanonicalStateHash?: string;
};

type PersistedStorageHandle = {
  role: 'history';
  db: Level<Buffer, Buffer>;
  head: StorageHead;
  latestHeight: number;
  latestMaterializedHeight: number;
  latestSnapshotHeight: number;
  snapshotHeights: number[];
};

const createPersistedStorageEnv = (runtimeId?: string | null, runtimeSeed?: string | null): Env => {
  const env = createEmptyEnv(runtimeSeed ?? null);
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId ?? env.runtimeId ?? null);
  if (normalizedRuntimeId) {
    env.runtimeId = normalizedRuntimeId;
    env.dbNamespace = normalizeDbNamespace(normalizedRuntimeId);
  }
  return env;
};

const listPersistedStorageHandles = async (env: Env): Promise<PersistedStorageHandle[]> => {
  const opened = await tryOpenFrameDb(env);
  if (!opened) return [];
  const db = getFrameDb(env);
  const head = await readStorageHead(db);
  if (!head || head.latestHeight <= 0) return [];
  return [{
    role: 'history',
    db,
    head,
    latestHeight: head.latestHeight,
    latestMaterializedHeight: Math.max(
      0,
      Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
    ),
    latestSnapshotHeight: head.latestSnapshotHeight,
    snapshotHeights: await listStorageSnapshotHeights(db),
  }];
};

const restoreOverlayFromFrameLog = async (
  env: Env,
  targetHeight: number,
): Promise<void> => {
  for (const handle of await listPersistedStorageHandles(env)) {
    if (targetHeight > handle.latestHeight) continue;

    const targetFrame = await readStorageFrameRecord(handle.db, targetHeight);
    if (targetFrame?.materializedState !== false) {
      env.overlay = [];
      return;
    }

    const startHeight = Math.max(1, handle.latestMaterializedHeight + 1);
    if (startHeight > targetHeight) {
      env.overlay = [];
      return;
    }

    const records = new Map<string, RuntimeOverlayRecord>();
    for (const record of await readStorageOverlayRecordsFromDiffs(handle.db, startHeight, targetHeight)) {
      records.set(storageOverlayRecordKey(record), { ...record });
    }
    if (records.size === 0 && Array.isArray(targetFrame?.overlayRecords)) {
      for (const record of targetFrame.overlayRecords) {
        records.set(storageOverlayRecordKey(record), { ...record });
      }
    }
    env.overlay = Array.from(records.values());
    return;
  }
  env.overlay = [];
};

const resolvePersistedLatestHeight = async (env: Env): Promise<number> => {
  const handles = await listPersistedStorageHandles(env);
  return handles.reduce((max, handle) => Math.max(max, handle.latestHeight), 0);
};

const resolvePersistedCheckpointHeights = async (env: Env): Promise<number[]> => {
  const handles = await listPersistedStorageHandles(env);
  return Array.from(new Set(handles.flatMap((handle) => handle.snapshotHeights))).sort((left, right) => left - right);
};

export const readPersistedStorageFrameRecord = async (
  env: Env,
  height: number,
): Promise<ReturnType<typeof readStorageFrameRecord> extends Promise<infer T> ? T : never> => {
  const targetHeight = Number.isFinite(height) ? Math.floor(height) : 0;
  if (targetHeight <= 0) return null;
  for (const handle of await listPersistedStorageHandles(env)) {
    if (targetHeight > handle.latestHeight) continue;
    const frame = await readStorageFrameRecord(handle.db, targetHeight);
    if (frame) return frame;
  }
  return null;
};

const readPersistedStorageReplicaMeta = async (
  env: Env,
  entityId: string,
): Promise<ReturnType<typeof readStorageReplicaMeta> extends Promise<infer T> ? T : never> => {
  const normalizedEntityId = String(entityId || '').toLowerCase();
  if (!normalizedEntityId) return null;
  if (!(await tryOpenStorageDb(env, 'current'))) return null;
  return readStorageReplicaMeta(getStorageDb(env, 'current'), normalizedEntityId);
};

const resolvePersistedSnapshotHeight = async (env: Env, targetHeight: number): Promise<number> => {
  let best = 0;
  for (const handle of await listPersistedStorageHandles(env)) {
    if (targetHeight > handle.latestHeight) continue;
    const candidate = await findStorageLatestSnapshotAtOrBelow(handle.db, targetHeight);
    if (candidate > best) best = candidate;
  }
  return best;
};

export const listPersistedEntityIdsAtHeight = async (env: Env, targetHeight: number): Promise<string[]> => {
  const entityIds = new Set<string>();
  for (const handle of await listPersistedStorageHandles(env)) {
    const snapshotHeight = await findStorageLatestSnapshotAtOrBelow(handle.db, targetHeight);
    if (snapshotHeight > 0) {
      for (const entityId of await listStorageSnapshotEntityIds(handle.db, snapshotHeight)) {
        entityIds.add(entityId);
      }
    }
    const replayStartHeight = Math.max(1, snapshotHeight + 1);
    const replayEndHeight = Math.min(targetHeight, handle.latestHeight);
    for (let height = replayStartHeight; height <= replayEndHeight; height += 1) {
      const frame = await readStorageFrameRecord(handle.db, height);
      for (const entityId of frame?.touchedEntities ?? []) {
        const normalized = String(entityId || '').toLowerCase();
        if (normalized) entityIds.add(normalized);
      }
      for (const account of frame?.touchedAccounts ?? []) {
        const entityId = String(account?.entityId || '').toLowerCase();
        const counterpartyId = String(account?.counterpartyId || '').toLowerCase();
        if (entityId) entityIds.add(entityId);
        if (counterpartyId) entityIds.add(counterpartyId);
      }
      for (const entry of frame?.entityHashes ?? []) {
        const entityId = String(entry?.entityId || '').toLowerCase();
        if (entityId) entityIds.add(entityId);
      }
    }
  }
  return Array.from(entityIds).sort();
};

const derivePersistedReplicaSignerId = (state: EntityState): string => {
  const validator = Array.isArray(state.config?.validators) && state.config.validators.length > 0
    ? state.config.validators[0]
    : undefined;
  const fallback = typeof validator === 'string' && validator.length > 0 ? validator : state.entityId;
  return String(fallback || state.entityId).toLowerCase();
};

const rebuildPersistedJurisdictions = (env: Env): void => {
  env.jReplicas = new Map();
  for (const replica of env.eReplicas.values()) {
    const jurisdiction = replica.state.config?.jurisdiction as Record<string, unknown> | undefined;
    const name = typeof jurisdiction?.['name'] === 'string' ? jurisdiction['name'] : '';
    if (!name || env.jReplicas.has(name)) continue;
    const depositoryAddress = String(jurisdiction?.['depositoryAddress'] || '').trim();
    const entityProviderAddress = String(jurisdiction?.['entityProviderAddress'] || '').trim();
    const deltaTransformerAddress = String(
      jurisdiction?.['deltaTransformerAddress'] ?? jurisdiction?.['deltaTransformer'] ?? '',
    ).trim();
    const chainId = Number.isFinite(Number(jurisdiction?.['chainId'])) ? Number(jurisdiction?.['chainId']) : 31337;
    env.jReplicas.set(name, {
      name,
      depositoryAddress,
      entityProviderAddress,
      chainId,
      contracts: {
        ...(depositoryAddress ? { depository: depositoryAddress } : {}),
        ...(entityProviderAddress ? { entityProvider: entityProviderAddress } : {}),
        ...(deltaTransformerAddress ? { deltaTransformer: deltaTransformerAddress } : {}),
      },
    } as never);
    if (!env.activeJurisdiction) env.activeJurisdiction = name;
  }
};

const loadEnvFromStorage = async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  targetHeightOverride?: number,
): Promise<{
  env: Env;
  latestHeight: number;
  checkpointHeight: number;
  selectedSnapshotHeight: number;
	} | null> => {
  const env = createPersistedStorageEnv(runtimeId, runtimeSeed);
  assertStorageSafetyOverridesAllowed();
  let returningEnv = false;
  try {
    const latestHeight = await resolvePersistedLatestHeight(env);
    if (latestHeight <= 0) return null;
    const targetHeight = Math.max(
      1,
      Math.min(
        latestHeight,
        Number.isFinite(Number(targetHeightOverride)) ? Math.floor(Number(targetHeightOverride)) : latestHeight,
      ),
    );
    const selectedSnapshotHeight = await resolvePersistedSnapshotHeight(env, targetHeight);
    const entityIds = await listPersistedEntityIdsAtHeight(env, targetHeight);
    const restoredStates = new Map<string, EntityState>();

    for (const entityId of entityIds) {
      const state = await loadEntityStateFromStorageDb(env, entityId, targetHeight);
      if (state) restoredStates.set(entityId, state);
    }
    if (restoredStates.size === 0) return null;

    env.eReplicas = new Map();
    env.activeJurisdiction = undefined;
    for (const [entityId, state] of restoredStates.entries()) {
      const meta = targetHeight === latestHeight ? await readPersistedStorageReplicaMeta(env, entityId) : null;
      const signerId = String(meta?.signerId || derivePersistedReplicaSignerId(state)).toLowerCase();
      const hankoWitness = meta?.hankoWitness instanceof Map ? meta.hankoWitness : new Map();
      env.eReplicas.set(formatReplicaKey(createReplicaKey(entityId, signerId)), {
        entityId,
        signerId,
        state,
        mempool: [],
        isProposer: typeof meta?.isProposer === 'boolean' ? meta.isProposer : true,
        hankoWitness,
        ...(meta?.proposal ? { proposal: meta.proposal } : {}),
        ...(meta?.lockedFrame ? { lockedFrame: meta.lockedFrame } : {}),
        ...(meta?.validatorComputedState ? { validatorComputedState: meta.validatorComputedState } : {}),
      });
    }

    const frame = await readPersistedStorageFrameRecord(env, targetHeight);
    if (!frame) {
      throw new Error(`STORAGE_RESTORE_FRAME_MISSING: height=${targetHeight}`);
    }
    env.height = targetHeight;
	    env.timestamp = frame?.timestamp ?? Math.max(...Array.from(restoredStates.values()).map((state) => Number(state.timestamp ?? 0)), 0);
    env.runtimeInput = { runtimeTxs: [], entityInputs: [] };
	    env.runtimeMempool = undefined;
    await restoreOverlayFromFrameLog(env, targetHeight);
	    await hydrateAccountFrameHistoryViews(env);
	    let restoredFrameLogs: FrameLogEntry[] = [];
    try {
      if (await tryOpenFrameDb(env)) {
        const activity = await readFrameDbRuntimeActivity(getFrameDb(env), targetHeight);
        if (activity?.logs) restoredFrameLogs = activity.logs.map((entry) => ({ ...entry }));
      }
    } catch {
      // Activity logs are secondary; state restore must not depend on them.
    }
    env.frameLogs = restoredFrameLogs;
    rebuildPersistedJurisdictions(env);
    if (!frame.canonicalStateHash) {
      throw new Error(`STORAGE_RESTORE_CANONICAL_HASH_MISSING: height=${targetHeight}`);
    }
    if (frame.canonicalStateHash) {
      const restoredCanonicalStateHash = computeCanonicalStateHashFromEnv(env);
      if (restoredCanonicalStateHash !== frame.canonicalStateHash) {
        const expectedEntities = new Map((frame.canonicalEntityHashes || []).map((entry) => [entry.entityId, entry.hash]));
        const actualEntities = computeCanonicalEntityHashesFromEnv(env);
        const mismatch = actualEntities.find((entry) => expectedEntities.get(entry.entityId) !== entry.hash);
        const missing = (frame.canonicalEntityHashes || []).find(
          (entry) => !actualEntities.some((actual) => actual.entityId === entry.entityId),
        );
        const mismatchDetail = mismatch
          ? ` entity=${mismatch.entityId} expectedEntity=${expectedEntities.get(mismatch.entityId) || 'missing'} actualEntity=${mismatch.hash}`
          : missing
            ? ` entity=${missing.entityId} expectedEntity=${missing.hash} actualEntity=missing`
            : '';
        throw new Error(
          `STORAGE_RESTORE_CANONICAL_HASH_MISMATCH: height=${targetHeight} ` +
            `expected=${frame.canonicalStateHash} actual=${restoredCanonicalStateHash}${mismatchDetail}`,
        );
      }
    }
    envRecord(env)['__replayMeta'] = {
      checkpointHeight: selectedSnapshotHeight,
      selectedSnapshotHeight,
      selectedSnapshotLabel:
        selectedSnapshotHeight <= 1
          ? 'genesis:1'
          : selectedSnapshotHeight === targetHeight
            ? `checkpoint:${selectedSnapshotHeight}`
            : `snapshot:${selectedSnapshotHeight}`,
      latestHeight,
    };
    env.history = [
      buildCanonicalEnvSnapshot(env, {
        runtimeInput: frame?.runtimeInput ?? { runtimeTxs: [], entityInputs: [] },
        runtimeOutputs: [],
        description: `Persisted restore @ ${targetHeight}`,
        logs: env.frameLogs,
        gossipProfiles: env.gossip.getProfiles?.() ?? [],
      }),
    ];

    returningEnv = true;
    return {
      env,
      latestHeight,
      checkpointHeight: selectedSnapshotHeight,
      selectedSnapshotHeight,
    };
  } finally {
    // loadEnvFromDB probes storage on fresh starts. If there is nothing to
    // restore, the probe env must release LevelDB locks before the real runtime
    // opens the same storage path for frame 1.
    if (!returningEnv) {
      await closeRuntimeDb(env);
      await closeInfraDb(env);
    }
  }
};

const hydrateAccountFrameHistoryViews = async (env: Env, limit = 50): Promise<void> => {
  try {
    if (!(await tryOpenFrameDb(env))) return;
    const db = getFrameDb(env);
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const entityId = String(replica?.entityId || String(replicaKey).split(':')[0] || '').toLowerCase();
      if (!entityId || !replica?.state?.accounts) continue;
      for (const [counterpartyId, account] of replica.state.accounts.entries()) {
        const accountCurrentHeight = Math.max(0, Math.floor(Number(account.currentHeight ?? 0)));
        const records = (await readFrameDbAccountFrames(db, entityId, String(counterpartyId).toLowerCase()))
          .filter((record) =>
            Math.max(0, Math.floor(Number(record.runtimeHeight ?? 0))) <= env.height &&
            Math.max(0, Math.floor(Number(record.accountHeight ?? 0))) <= accountCurrentHeight
          );
        setAccountFrameHistoryView(account, records.map((record) => record.frame), limit);
      }
    }
  } catch (error) {
    console.warn('⚠️ Failed to hydrate account frame history view:', error instanceof Error ? error.message : error);
  }
};

export const getPersistedLatestHeight = async (env: Env): Promise<number> => {
  return resolvePersistedLatestHeight(env);
};

export const loadEntityStateFromStorageDb = async (
  env: Env,
  entityId: string,
  height?: number,
): Promise<EntityState | null> => {
  return loadEntityStateFromStorage({
    env,
    tryOpenDb: tryOpenFrameDb,
    getRuntimeDb: getFrameDb,
    entityId,
    ...(height === undefined ? {} : { height }),
    liveStateReadable: false,
  });
};

export const loadEntityAccountDocFromStorageDb = async (
  env: Env,
  entityId: string,
  counterpartyId: string,
  height?: number,
) => {
  return loadEntityAccountDocFromStorage({
    env,
    tryOpenDb: tryOpenFrameDb,
    getRuntimeDb: getFrameDb,
    entityId,
    counterpartyId,
    ...(height === undefined ? {} : { height }),
    liveStateReadable: false,
  });
};

export const loadEntityViewPageFromStorageDb = async (
  env: Env,
  entityId: string,
  height: number,
  query?: RuntimeAdapterReadQuery,
) => {
  const accountQuery = {
    ...(query?.cursor ? { cursor: query.cursor } : {}),
    ...(query?.accountsCursor ? { cursor: query.accountsCursor } : {}),
    ...(query?.accountsLimit !== undefined ? { limit: query.accountsLimit } : query?.limit !== undefined ? { limit: query.limit } : {}),
    ...(query?.sortDir ? { sortDir: query.sortDir } : {}),
  };
  const bookCursor = query?.booksCursor ?? (query?.accountsCursor ? undefined : query?.cursor);
  const bookQuery = {
    ...(bookCursor ? { cursor: bookCursor } : {}),
    ...(query?.booksLimit !== undefined ? { limit: query.booksLimit } : query?.limit !== undefined ? { limit: query.limit } : {}),
  };
  return loadEntityViewPageFromStorage({
    env,
    tryOpenDb: tryOpenFrameDb,
    getRuntimeDb: getFrameDb,
    entityId,
    height,
    accountQuery,
    bookQuery,
    liveStateReadable: false,
  });
};

export const inspectStorageDb = async (env: Env) => {
  const current = await inspectStorage({
    env,
    tryOpenDb: (targetEnv) => tryOpenStorageDb(targetEnv, 'current'),
    getRuntimeDb: (targetEnv) => getStorageDb(targetEnv, 'current'),
  });
  const history = await inspectStorage({
    env,
    tryOpenDb: tryOpenFrameDb,
    getRuntimeDb: getFrameDb,
  });
  if (!current && !history) return null;

  const epochs = [
    current
      ? {
          role: 'current' as const,
          path: resolveStorageDbPath(env, 'current'),
          latestHeight: current.head?.latestHeight ?? 0,
          latestSnapshotHeight: current.head?.latestSnapshotHeight ?? 0,
          frameCount: current.frameCount,
          diffCount: current.diffCount,
          snapshotCount: current.snapshotHeights.length,
          liveBytes: current.liveBytes,
          historyBytes: current.historyBytes,
          totalBytes: current.totalBytes,
        }
      : null,
    history
      ? {
          role: 'history' as const,
          path: resolveFrameDbPath(env),
          latestHeight: history.head?.latestHeight ?? 0,
          latestSnapshotHeight: history.head?.latestSnapshotHeight ?? 0,
          frameCount: history.frameCount,
          diffCount: history.diffCount,
          snapshotCount: history.snapshotHeights.length,
          liveBytes: history.liveBytes,
          historyBytes: history.historyBytes,
          totalBytes: history.totalBytes,
        }
      : null,
  ].filter(Boolean);

  const snapshotHeights = Array.from(
    new Set([...(history?.snapshotHeights ?? [])]),
  ).sort((left, right) => left - right);

  return {
    head: history?.head ?? current?.head ?? null,
    frameCount: history?.frameCount ?? 0,
    diffCount: history?.diffCount ?? 0,
    snapshotHeights,
    liveEntityCount: current?.liveEntityCount ?? 0,
    liveAccountCount: current?.liveAccountCount ?? 0,
    liveBookCount: current?.liveBookCount ?? 0,
    frameBytes: history?.frameBytes ?? 0,
    diffBytes: history?.diffBytes ?? 0,
    snapshotBytes: history?.snapshotBytes ?? 0,
    liveBytes: current?.liveBytes ?? 0,
    historyBytes: history?.historyBytes ?? 0,
    totalBytes: (current?.liveBytes ?? 0) + (history?.historyBytes ?? 0),
    maxFrameBytes: history?.maxFrameBytes ?? 0,
    maxDiffBytes: history?.maxDiffBytes ?? 0,
    maxSnapshotBytes: history?.maxSnapshotBytes ?? 0,
    epochDbs: epochs,
  };
};

export const listPersistedCheckpointHeights = async (env: Env): Promise<number[]> => {
  return resolvePersistedCheckpointHeights(env);
};

export const readPersistedStorageHead = async (env: Env): Promise<StorageHead | null> => {
  if (!(await tryOpenFrameDb(env))) return null;
  return readStorageHead(getFrameDb(env));
};

export const verifyRuntimeChain = async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  options?: { fromSnapshotHeight?: number },
): Promise<VerifyRuntimeChainResult> => {
  const bootstrapEnv = createPersistedStorageEnv(runtimeId, runtimeSeed);
  const latestHeight = await resolvePersistedLatestHeight(bootstrapEnv);
  if (latestHeight <= 0) {
    throw new Error('REPLAY_INVARIANT_FAILED: no persisted runtime state');
  }
  const requestedFromHeight = Number.isFinite(Number(options?.fromSnapshotHeight))
    ? Math.max(1, Math.floor(Number(options?.fromSnapshotHeight)))
    : latestHeight;
  const selectedSnapshotHeight = await resolvePersistedSnapshotHeight(bootstrapEnv, requestedFromHeight);
  const checkpointHeight = await resolvePersistedSnapshotHeight(bootstrapEnv, latestHeight);
  let expectedStateHash = '';
  let actualStateHash = '';
  let expectedCanonicalStateHash = '';
  let actualCanonicalStateHash = '';
  let restoredHeight = selectedSnapshotHeight;
  try {
    await closeRuntimeDb(bootstrapEnv);
    await closeInfraDb(bootstrapEnv);
    for (let height = Math.max(1, requestedFromHeight); height <= latestHeight; height += 1) {
      const replayed = await loadEnvFromStorage(runtimeId, runtimeSeed, height);
      if (!replayed) {
        throw new Error(`REPLAY_INVARIANT_FAILED: failed to restore persisted runtime at height ${height}`);
      }
      try {
        const persistedFrame = await readPersistedStorageFrameRecord(replayed.env, height);
        if (!persistedFrame) {
          throw new Error(`REPLAY_INVARIANT_FAILED: missing persisted frame at height ${height}`);
        }
        expectedStateHash = persistedFrame.stateHash;
        const storageHashMode = persistedFrame.hashMode === 'storage-merkle-v1';
        if (storageHashMode && persistedFrame.materializedState === false) {
          actualStateHash = expectedStateHash;
          expectedCanonicalStateHash = '';
          actualCanonicalStateHash = '';
          restoredHeight = height;
          continue;
        }
        actualStateHash =
          storageHashMode && Array.isArray(persistedFrame.entityHashes)
            ? computeStorageStateRoot(persistedFrame.entityHashes)
            : computePersistedEnvStateHash(buildRuntimeCheckpointSnapshot(replayed.env));
        if (storageHashMode) {
          if (persistedFrame.canonicalStateHash) {
            expectedCanonicalStateHash = String(persistedFrame.canonicalStateHash);
            actualCanonicalStateHash = computeCanonicalStateHashFromEnv(replayed.env);
            if (expectedCanonicalStateHash !== actualCanonicalStateHash) {
              return {
                ok: false,
                latestHeight,
                checkpointHeight,
                selectedSnapshotHeight,
                restoredHeight: height,
                expectedStateHash,
                actualStateHash,
                expectedCanonicalStateHash,
                actualCanonicalStateHash,
              };
            }
          } else {
            expectedCanonicalStateHash = '';
            actualCanonicalStateHash = '';
          }
        } else {
          expectedCanonicalStateHash = expectedStateHash;
          actualCanonicalStateHash = actualStateHash;
        }
        restoredHeight = height;
        if (expectedStateHash !== actualStateHash) {
          return {
            ok: false,
            latestHeight,
            checkpointHeight,
            selectedSnapshotHeight,
            restoredHeight,
            expectedStateHash,
            actualStateHash,
            expectedCanonicalStateHash,
            actualCanonicalStateHash,
          };
        }
      } finally {
        await closeRuntimeDb(replayed.env);
        await closeInfraDb(replayed.env);
      }
    }
  } finally {
    await closeRuntimeDb(bootstrapEnv);
    await closeInfraDb(bootstrapEnv);
  }

  return {
    ok: true,
    latestHeight,
    checkpointHeight,
    selectedSnapshotHeight,
    restoredHeight,
    expectedStateHash,
    actualStateHash,
    expectedCanonicalStateHash,
    actualCanonicalStateHash,
  };
};

export const readPersistedFrameJournal = async (env: Env, height: number): Promise<PersistedFrameJournal | null> => {
  const frame = await readPersistedStorageFrameRecord(env, height);
  if (!frame) return null;
  let logs: FrameLogEntry[] = [];
  try {
    if (await tryOpenFrameDb(env)) {
      const activity = await readFrameDbRuntimeActivity(getFrameDb(env), height);
      if (activity?.logs) logs = activity.logs;
    }
  } catch {
    // Frame DB is a secondary activity index. Keep state replay independent
    // from activity history availability.
  }
  return {
    height: frame.height,
    timestamp: frame.timestamp,
    runtimeInput: frame.runtimeInput,
    logs,
  };
};

export const readPersistedAccountFrameHistory = async (
  env: Env,
  entityId: string,
  counterpartyId: string,
  limit = 50,
  opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
): Promise<AccountFrame[]> => {
  if (!(await tryOpenFrameDb(env))) return [];
  const maxRuntimeHeight = Number.isFinite(Number(opts?.maxRuntimeHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxRuntimeHeight)))
    : Number.POSITIVE_INFINITY;
  const maxAccountHeight = Number.isFinite(Number(opts?.maxAccountHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxAccountHeight)))
    : Number.POSITIVE_INFINITY;
  const records = (await readFrameDbAccountFrames(getFrameDb(env), entityId, counterpartyId))
    .filter((record) =>
      Math.max(0, Math.floor(Number(record.runtimeHeight ?? 0))) <= maxRuntimeHeight &&
      Math.max(0, Math.floor(Number(record.accountHeight ?? 0))) <= maxAccountHeight
    );
  const boundedLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit || 50))));
  return records.slice(-boundedLimit).map((record) => structuredClone(record.frame));
};

export const readPersistedFrameJournals = async (
  env: Env,
  opts?: {
    fromHeight?: number;
    toHeight?: number;
    limit?: number;
  },
): Promise<PersistedFrameJournal[]> => {
  const latestHeight = await resolvePersistedLatestHeight(env);
  if (latestHeight <= 0) return [];
  const fromHeight = Math.max(1, Math.floor(opts?.fromHeight ?? 1));
  const boundedToHeight = Math.max(fromHeight, Math.floor(opts?.toHeight ?? latestHeight));
  const toHeight = Math.min(latestHeight, boundedToHeight);
  const limit = Math.max(1, Math.min(1000, Math.floor(opts?.limit ?? 200)));
  const pageToHeight = Math.min(toHeight, fromHeight + limit - 1);
  const receipts: PersistedFrameJournal[] = [];
  for (let height = fromHeight; height <= pageToHeight; height += 1) {
    const receipt = await readPersistedFrameJournal(env, height);
    if (receipt) receipts.push(receipt);
  }
  return receipts;
};

export const readPersistedCheckpointSnapshot = async (
  env: Env,
  height: number,
): Promise<Record<string, unknown> | null> => {
  const targetHeight = Number.isFinite(height) ? Math.floor(height) : 0;
  if (targetHeight <= 0) return null;
  const restored = await loadEnvFromStorage(env.runtimeId, env.runtimeSeed, targetHeight);
  if (!restored || restored.env.height !== targetHeight) {
    if (restored?.env) await closeRuntimeDb(restored.env);
    return null;
  }
  try {
    return buildRuntimeCheckpointSnapshot(restored.env);
  } finally {
    await closeRuntimeDb(restored.env);
  }
};

export const loadEnvFromDB = async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  options?: { fromSnapshotHeight?: number },
): Promise<Env | null> => {
  try {
    const restored = await loadEnvFromStorage(
      runtimeId,
      runtimeSeed,
      Number.isFinite(options?.fromSnapshotHeight) ? Math.floor(Number(options?.fromSnapshotHeight)) : undefined,
    );
    const latestEnv = restored?.env ?? null;

    if (latestEnv) {
      await rehydrateRestoredRuntimeInfra(latestEnv, {
        isBrowser: runtimeIsBrowser,
        loadGossipProfiles: (targetEnv) => loadGossipProfilesFromInfraDb(targetEnv, infraGossipDbAccess),
        assertPersistedContractConfigReady,
        setBrowserVMJurisdiction,
      });
    }

    return latestEnv;
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`❌ loadEnvFromDB failed: ${message}`);
    throw err;
  }
};

export const clearDB = async (env?: Env): Promise<void> => {
  const targetEnv = env ?? createEmptyEnv(null);

  if (!runtimeIsBrowser && nodeProcess) {
    try {
      await closeRuntimeDb(targetEnv);
      await closeInfraDb(targetEnv);
      const fs = await import('fs/promises');
      await fs.rm(dbRootPath, { recursive: true, force: true });
      await fs.mkdir(dbRootPath, { recursive: true });
      console.log(`✅ Runtime DB root cleared (core + infra): ${dbRootPath}`);
    } catch (err) {
      console.error(`❌ Failed to clear runtime DB root (${dbRootPath}):`, err);
    }
    return;
  }

  if (!runtimeIsBrowser) return;

  try {
    const dbReady = await tryOpenDb(targetEnv);
    const infraReady = await tryOpenInfraDb(targetEnv);
    const storageReady = await tryOpenStorageDb(targetEnv, 'current');
    const storagePreviousReady = await tryOpenStorageDb(targetEnv, 'previous');
    const frameReady = await tryOpenFrameDb(targetEnv);
    if (dbReady) {
      const db = getRuntimeDb(targetEnv);
      await db.clear();
    }
    if (infraReady) {
      const infraDb = getInfraDb(targetEnv);
      await infraDb.clear();
    }
    if (storageReady) {
      const storageDb = getStorageDb(targetEnv, 'current');
      await storageDb.clear();
    }
    if (storagePreviousReady) {
      const previousStorageDb = getStorageDb(targetEnv, 'previous');
      await previousStorageDb.clear();
    }
    if (frameReady) {
      const frameDb = getFrameDb(targetEnv);
      await frameDb.clear();
    }
    console.log('✅ LevelDB cleared (core + infra)');
  } catch (err) {
    console.error('❌ Failed to clear LevelDB:', err);
  }
};

// === SCENARIO SYSTEM ===
export { scenarios } from './runtime-scenarios';
export { parseScenario, mergeAndSortEvents } from './scenarios/parser.js';
export { executeScenario } from './scenarios/executor.js';
// NOTE: loadScenarioFromFile uses fs/promises - import directly from './scenarios/loader.js' in CLI only
export { SCENARIOS, getScenario, getScenariosByTag, type ScenarioMetadata } from './scenarios/index.js';

// === CRYPTOGRAPHIC SIGNATURES ===
export {
  deriveSignerKey,
  deriveSignerKeySync,
  getCachedSignerPrivateKey,
  registerSignerKey,
  registerSignerPublicKey,
  registerTestKeys,
  clearSignerKeys,
  signAccountFrame,
  verifyAccountSignature,
  getSignerPublicKey,
} from './account-crypto.js';
export {
  buildJEventObservationDigest,
  canonicalJurisdictionEventsHash,
} from './j-event-observation';
export {
  buildCrossJurisdictionPullReveal,
  getCrossJurisdictionPrivateSeed,
} from './cross-jurisdiction';

// === NAME RESOLUTION WRAPPERS (override imports) ===
// Runtime no longer keeps a module-global env/db; these pure wrappers expose
// deterministic name formatting for callers that do not own an Env.
const searchEntityNames = (query: string, limit?: number) => searchEntityNamesOriginal(null, query, limit);
const resolveEntityName = (entityId: string) => resolveEntityNameOriginal(null, entityId);
const getEntityDisplayInfoFromProfile = (entityId: string) => getEntityDisplayInfoFromProfileOriginal(null, entityId);

// Avatar functions are already imported and exported above

// JAdapter - Unified J-Machine interface (replaces old evms/ and jurisdiction/)
export { createJAdapter } from './jadapter';
export type { JAdapter, JAdapterConfig, JAdapterMode, JEvent } from './jadapter';
export {
  getActiveJAdapter,
  getEntityJAdapter,
  submitDebtEnforcement,
} from './runtime-jurisdiction-api';
export type {
  CrossJurisdictionSwapSubmitParams,
  CrossJurisdictionSwapSubmitResult,
} from './runtime-jurisdiction-api';

export async function submitCrossJurisdictionSwap(
  env: Env,
  params: CrossJurisdictionSwapSubmitParams,
): Promise<CrossJurisdictionSwapSubmitResult> {
  const { route, input } = buildCrossJurisdictionSwapSubmission(env, params);
  enqueueRuntimeInput(env, input);
  return { route };
}

export { setDeltaTransformerAddress } from './proof-builder';

// Entity ID utilities - universal parsing, provider-scoping, comparison
export {
  normalizeEntityId,
  compareEntityIds,
  isLeftEntity,
  parseUniversalEntityId,
  createProviderScopedEntityId,
  getShortId,
  formatEntityIdDisplay,
  entityIdsEqual,
  extractProvider,
} from './entity-id-utils';
export type { ParsedEntityId } from './entity-id-utils';

// ASCII visualization exports
export { formatRuntime, formatEntity, formatAccount, formatOrderbook, formatSummary } from './runtime-ascii';
