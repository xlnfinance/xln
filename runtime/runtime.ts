// for regular use > bun run runtime/runtime.ts
// for debugging > bun repl
// await import('./debug.js');
// FORCE AUTO-REBUILD: Fixed signerId consistency and fintech type safety

// Import utilities and types
// High-level database using Level polyfill (works in both Node.js and browser)
import { Level } from 'level';

// Bump this on runtime bundle changes that must be reflected in frontend immediately.
const RUNTIME_BUILD_ID = '2026-02-09-22:10Z';
// Bump this only on breaking persistence/replay format or invariants.
export const RUNTIME_SCHEMA_VERSION = 2;
export const RUNTIME_BUILD = RUNTIME_BUILD_ID;
console.log(`🚀 RUNTIME.JS BUILD: ${RUNTIME_BUILD_ID}`);

import { getPerfMs, getWallClockMs } from './utils';
import { applyEntityInput, mergeEntityInputs } from './entity-consensus';
import { isLeftEntity } from './entity-id-utils';
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
  connectToEthereum,
  debugFundReserves,
  getAvailableJurisdictions,
  getEntityInfoFromChain,
  getJurisdictionByAddress,
  getNextEntityNumber,
  registerNumberedEntityOnChain,
  setBrowserVMJurisdiction,
  getBrowserVMInstance,
  submitProcessBatch,
  submitPrefundAccount,
  submitSettle,
  submitReserveToReserve,
  transferNameBetweenEntities,
} from './evm';
import { createGossipLayer } from './networking/gossip';
import { attachEventEmitters } from './env-events';
import { deriveSignerAddressSync, getCachedSignerPrivateKey, getSignerPrivateKey, getSignerPublicKey, prewarmSignerKeyCache, setRuntimeSeed as setCryptoRuntimeSeed } from './account-crypto';
import { buildEntityProfile, mergeProfileWithExisting } from './networking/gossip-helper';
import { RuntimeP2P, type P2PConfig } from './networking/p2p';
import { deriveEncryptionKeyPair, pubKeyToHex } from './networking/p2p-crypto';
import {
  parseReplicaKey,
  extractEntityId,
  extractSignerId,
  formatReplicaKey,
  createReplicaKey,
  formatEntityDisplay as formatEntityDisplayIds,
  formatSignerDisplay as formatSignerDisplayIds,
  formatReplicaDisplay,
  // Types for re-export
  type EntityId,
  type SignerId,
  type JId,
  type EntityProviderAddress,
  type ReplicaKey,
  type FullReplicaAddress,
  type ReplicaUri,
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
  // Entity type detection (re-export from ids.ts)
  detectEntityType as detectEntityTypeIds,
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
  // Jurisdiction helpers
  type JurisdictionInfo,
  jIdFromChainId,
  createLazyJId,
  // Migration helpers
  safeParseReplicaKey,
  safeExtractEntityId,
} from './ids';
import { type Profile, loadPersistedProfiles } from './networking/gossip';
import {
  createProfileUpdateTx,
  getEntityDisplayInfo as getEntityDisplayInfoFromProfileOriginal,
  resolveEntityName as resolveEntityNameOriginal,
  searchEntityNames as searchEntityNamesOriginal,
} from './name-resolution';
// import { runDemo } from './rundemo'; // REMOVED: Legacy demo replaced by scenarios/ahb
import { decode, encode } from './snapshot-coder'; // encode used in exports
import { deriveDelta, isLeft, getTokenInfo, formatTokenAmount, createDemoDelta, getDefaultCreditLimit } from './account-utils';
import { classifyBilateralState, getAccountBarVisual } from './account-consensus-state';
import {
  formatTokenAmount as formatTokenAmountEthers,
  parseTokenAmount,
  convertTokenPrecision,
  calculatePercentage as calculatePercentageEthers,
  formatAssetAmount as formatAssetAmountEthers,
  BigIntMath,
  FINANCIAL_CONSTANTS
} from './financial-utils';
import { captureSnapshot, cloneEntityReplica, resolveEntityProposerId } from './state-helpers';
import { getEntityShortId, getEntityNumber, formatEntityId, HEAVY_LOGS } from './utils';
import { deserializeTaggedJson, serializeTaggedJson, safeStringify } from './serialization-utils';
import { validateDelta, validateAccountDeltas, createDefaultDelta, isDelta, validateEntityInput, validateEntityOutput } from './validation-utils';
import type { EntityInput, EntityReplica, Env, JInput, JReplica, RoutedEntityInput, RuntimeInput } from './types';
import {
  clearDatabase,
  DEBUG,
  formatEntityDisplay,
  formatSignerDisplay,
  generateEntityAvatar,
  generateSignerAvatar,
  getEntityDisplayInfo,
  getSignerDisplayInfo,
  isBrowser,
  log,
} from './utils';
import { logError } from './logger';

if (isBrowser && typeof globalThis.process === 'undefined') {
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const hrtime = (prev?: [number, number]) => {
    const ms = nowMs();
    const sec = Math.floor(ms / 1000);
    const ns = Math.floor((ms - sec * 1000) * 1e6);
    if (prev) {
      let secDiff = sec - prev[0];
      let nsDiff = ns - prev[1];
      if (nsDiff < 0) {
        secDiff -= 1;
        nsDiff += 1e9;
      }
      return [secDiff, nsDiff] as [number, number];
    }
    return [sec, ns] as [number, number];
  };
  globalThis.process = {
    env: {},
    browser: true,
    version: '0',
    versions: { node: '0' },
    nextTick: (cb: (...args: any[]) => void, ...args: any[]) => {
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(() => cb(...args));
      } else {
        Promise.resolve().then(() => cb(...args));
      }
    },
    hrtime,
    uptime: () => nowMs() / 1000,
    cwd: () => '/',
  } as any;
}

// --- Database Setup ---
// Level polyfill: Node.js uses filesystem, Browser uses IndexedDB
const nodeProcess =
  !isBrowser && typeof globalThis.process !== 'undefined'
    ? globalThis.process
    : undefined;
const defaultDbPath = nodeProcess ? 'db-tmp/runtime' : 'db';
const dbRootPath = nodeProcess?.env?.XLN_DB_PATH || defaultDbPath;

const DEFAULT_DB_NAMESPACE = 'default';
const PERSISTENCE_SCHEMA_VERSION = 2;

const normalizeDbNamespace = (value: string): string => value.trim().toLowerCase();

const deriveRuntimeIdFromSeed = (seed?: string | null): string | null => {
  if (!seed) return null;
  try {
    return deriveSignerAddressSync(seed, '1').toLowerCase();
  } catch (error) {
    console.warn('⚠️ Failed to derive runtimeId for DB namespace:', error);
    return null;
  }
};

const resolveDbNamespace = (options: { env?: Env | null; runtimeId?: string | null; runtimeSeed?: string | null } = {}): string => {
  const explicit = options.env?.dbNamespace;
  if (explicit) return normalizeDbNamespace(explicit);
  const runtimeId = options.runtimeId ?? options.env?.runtimeId;
  if (runtimeId) return normalizeDbNamespace(runtimeId);
  const seed = options.runtimeSeed ?? options.env?.runtimeSeed;
  const derived = deriveRuntimeIdFromSeed(seed ?? null);
  if (derived) return derived;
  return DEFAULT_DB_NAMESPACE;
};

const makeDbKey = (namespace: string, key: string): Buffer =>
  Buffer.from(`${namespace}:${key}`);

const captureEntityJHeights = (env: Env): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const entityId = String(replica?.entityId || safeExtractEntityId(replicaKey) || '').toLowerCase();
    if (!entityId) continue;
    result[entityId] = Number(replica?.state?.lastFinalizedJHeight ?? 0);
  }
  return result;
};

// Helper: Race promise with timeout
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), ms)
    )
  ]);
}

const resolveDbPath = (env: Env): string => {
  const namespace = resolveDbNamespace({ env });
  if (nodeProcess) {
    return `${dbRootPath}/${namespace}`;
  }
  return `${dbRootPath}-${namespace}`;
};

export const getRuntimeDb = (env: Env): Level<Buffer, Buffer> => {
  const state = ensureRuntimeState(env);
  if (!state.db) {
    const path = resolveDbPath(env);
    state.db = new Level(path, { valueEncoding: 'buffer', keyEncoding: 'binary' });
  }
  return state.db;
};

export const closeRuntimeDb = async (env: Env): Promise<void> => {
  const state = ensureRuntimeState(env);
  if (!state.db) return;
  try {
    await state.db.close();
  } catch (error) {
    console.warn('⚠️ Failed to close runtime DB:', error instanceof Error ? error.message : error);
  } finally {
    state.db = null;
    state.dbOpenPromise = null;
  }
};

export async function tryOpenDb(env: Env): Promise<boolean> {
  const state = ensureRuntimeState(env);
  if (!state.dbOpenPromise) {
    const db = getRuntimeDb(env);
    state.dbOpenPromise = (async () => {
      try {
        await db.open();
        console.log('✅ Database opened');
        return true;
      } catch (error) {
        const isBlocked = error instanceof Error &&
          (error.message?.includes('blocked') ||
           error.name === 'SecurityError' ||
           error.name === 'InvalidStateError');
        if (isBlocked) {
          console.log('⚠️ IndexedDB blocked (incognito/private mode) - running in-memory');
          return false;
        }
        // Non-blocked open errors are fatal for persistence.
        state.dbOpenPromise = null;
        throw error;
      }
    })();
  }
  try {
    return await state.dbOpenPromise;
  } catch (error) {
    console.error('❌ Failed to open runtime DB:', error);
    throw error;
  }
}

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
      loopIntervalMs: 25,
      snapshotIntervalFrames: 100,
    };
  }
  const configuredSnapshotInterval = env.runtimeConfig.snapshotIntervalFrames;
  if (!Number.isFinite(configuredSnapshotInterval ?? NaN) || (configuredSnapshotInterval ?? 0) < 1) {
    env.runtimeConfig.snapshotIntervalFrames = 100;
  }
  return env.runtimeConfig;
};

const ensureRuntimeState = (env: Env): NonNullable<Env['runtimeState']> => {
  if (!env.runtimeState) {
    env.runtimeState = {
      loopActive: false,
      stopLoop: null,
      lastFrameAt: undefined,
      p2p: null,
      pendingP2PConfig: null,
      lastP2PConfig: null,
      directEntityInputDispatch: null,
    };
  }
  if (!env.runtimeState.entityRuntimeHints) {
    env.runtimeState.entityRuntimeHints = new Map();
  }
  return env.runtimeState;
};

const ENV_P2P_SINGLETON_KEY = Symbol.for('xln.runtime.env.p2p.singleton');
const ENV_APPLY_ALLOWED_KEY = Symbol.for('xln.runtime.env.apply.allowed');
const ENV_REPLAY_MODE_KEY = Symbol.for('xln.runtime.env.replay.mode');

const failfastAssert = (
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): asserts condition => {
  if (condition) return;
  const detailText = details ? ` ${safeStringify(details)}` : '';
  throw new Error(`${code}: ${message}${detailText}`);
};

type P2Pish = {
  matchesIdentity?: (runtimeId: string, signerId?: string) => boolean;
  updateConfig?: (config: P2PConfig) => void;
  close?: () => void;
};

// --- Clean Log Capture (per-runtime, stored on env.runtimeState.cleanLogs) ---
const getCleanLogBuffer = (env: Env): string[] => {
  const state = ensureRuntimeState(env);
  if (!state.cleanLogs) state.cleanLogs = [];
  return state.cleanLogs;
};

/** Get all clean logs as text (no file:line references) */
export const getCleanLogs = (env: Env): string => getCleanLogBuffer(env).join('\n');

/** Clear clean logs buffer */
export const clearCleanLogs = (env: Env): void => {
  const buffer = getCleanLogBuffer(env);
  buffer.length = 0;
};

/** Copy clean logs to clipboard (returns text if clipboard fails) */
export const copyCleanLogs = async (env: Env): Promise<string> => {
  const text = getCleanLogs(env);
  if (isBrowser && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      console.log(`✅ Copied ${getCleanLogBuffer(env).length} log entries to clipboard`);
    } catch {
      // Clipboard fails when devtools focused - just return text
    }
  }
  return text;
};

const ensureRuntimeMempool = (env: Env): RuntimeInput => {
  if (!env.runtimeMempool) {
    const base = env.runtimeInput ?? { runtimeTxs: [], entityInputs: [] };
    env.runtimeMempool = base;
    env.runtimeInput = base;
  } else if (env.runtimeInput !== env.runtimeMempool) {
    env.runtimeInput = env.runtimeMempool;
  }
  return env.runtimeMempool;
};

const enqueueRuntimeInputs = (env: Env, inputs?: RoutedEntityInput[], runtimeTxs?: RuntimeTx[]): void => {
  const mempool = ensureRuntimeMempool(env);
  if (runtimeTxs && runtimeTxs.length > 0) {
    mempool.runtimeTxs.push(...runtimeTxs);
  }
  if (inputs && inputs.length > 0) {
    mempool.entityInputs.push(...inputs);
  }
  if (inputs?.length || runtimeTxs?.length) {
    if (mempool.queuedAt === undefined) {
      mempool.queuedAt = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
    }
  }
};

export const enqueueRuntimeInput = (env: Env, runtimeInput: RuntimeInput): void => {
  enqueueRuntimeInputs(env, runtimeInput.entityInputs, runtimeInput.runtimeTxs);
};

const buildRouteOutputKey = (output: RoutedEntityInput): string => {
  const txPart = (output.entityTxs || [])
    .map((tx) => {
      const data = tx.data as Record<string, unknown> | undefined;
      const height = typeof data?.height === 'number' ? data.height : '';
      const from = typeof data?.fromEntityId === 'string' ? data.fromEntityId : '';
      const to = typeof data?.toEntityId === 'string' ? data.toEntityId : '';
      // Handles both field names: settle_propose uses counterpartyEntityId,
      // deposit_collateral uses counterpartyId — both must produce unique keys.
      const cp = typeof data?.counterpartyEntityId === 'string' ? data.counterpartyEntityId
        : typeof data?.counterpartyId === 'string' ? data.counterpartyId : '';
      return `${tx.type}:${height}:${from}:${to}:${cp}`;
    })
    .join('|');
  return `${output.entityId}:${output.signerId || ''}:${txPart}`;
};

const hasRuntimeWork = (env: Env): boolean => {
  const mempool = ensureRuntimeMempool(env);
  if (mempool.runtimeTxs.length > 0 || mempool.entityInputs.length > 0) return true;
  if (env.pendingOutputs && env.pendingOutputs.length > 0) return true;
  if (env.networkInbox && env.networkInbox.length > 0) return true;
  if (env.pendingNetworkOutputs && env.pendingNetworkOutputs.length > 0) {
    const nowMs = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
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

/**
 * Check if any entity has scheduled hooks that are due to fire.
 * Used by the runtime loop to wake up idle entities at the right time.
 */
const hasDueEntityHooks = (env: Env): boolean => {
  if (!env.eReplicas || env.eReplicas.size === 0) return false;
  const nowMs = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
  for (const [, replica] of env.eReplicas) {
    const hooks = (replica as any).state?.crontabState?.hooks;
    if (hooks && hooks.size > 0) {
      for (const hook of hooks.values()) {
        if ((hook as any).triggerAt <= nowMs) return true;
      }
    }
  }
  return false;
};

/**
 * Generate entity input pings for entities with due hooks.
 * Injects empty entityInputs so applyEntityInput runs → crontab fires → hooks execute.
 */
const generateHookPings = (env: Env): void => {
  if (!env.eReplicas || env.eReplicas.size === 0) return;
  const nowMs = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
  const mempool = ensureRuntimeMempool(env);

  for (const [key, replica] of env.eReplicas) {
    const hooks = (replica as any).state?.crontabState?.hooks;
    if (!hooks || hooks.size === 0) continue;

    let hasDue = false;
    for (const hook of hooks.values()) {
      if ((hook as any).triggerAt <= nowMs) { hasDue = true; break; }
    }
    if (!hasDue) continue;

    // Extract entityId and signerId from replica key (format: "entityId:signerId")
    const entityId = (replica as any).entityId ?? String(key).split(':')[0];
    const signerId = (replica as any).state?.config?.validators?.[0] ?? String(key).split(':')[1];
    if (!entityId || !signerId) continue;

    // Check if there's already a pending entityInput for this entity
    const alreadyQueued = mempool.entityInputs.some(
      ei => ei.entityId === entityId
    );
    if (alreadyQueued) continue;

    // Inject empty entityInput ping — just enough to trigger crontab
    mempool.entityInputs.push({ entityId, signerId, entityTxs: [] });
    console.log(`⏰ HOOK-PING: Waking entity ${entityId.slice(-4)} (due hooks)`);
  }
};

const isRuntimeFrameReady = (env: Env, now: number, overrideDelayMs?: number): boolean => {
  if (env.scenarioMode) return true; // deterministic scenarios advance manually
  const config = ensureRuntimeConfig(env);
  const delayMs = overrideDelayMs !== undefined ? overrideDelayMs : (config.minFrameDelayMs ?? 0);
  const state = ensureRuntimeState(env);
  if (!state.lastFrameAt) return true;
  return now - state.lastFrameAt >= delayMs;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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

  const tickDelayMs = config?.tickDelayMs ?? ensureRuntimeConfig(env).loopIntervalMs ?? 25;
  let running = true;
  state.loopActive = true;

  const loop = async () => {
    while (running) {
      try {
        if (hasRuntimeWork(env)) {
          await process(env);
        }
      } catch (error) {
        console.error('❌ Runtime loop error:', error);
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('PERSISTENCE_FATAL')) {
          running = false;
          try {
            env.error?.('RUNTIME_PERSISTENCE_FATAL', { message });
          } catch {
            // best-effort diagnostics
          }
        }
      }
      if (tickDelayMs > 0) {
        await sleep(tickDelayMs);
      } else {
        // yield to event loop even with 0 delay (let network/UI callbacks run)
        await sleep(0);
      }
    }
    state.loopActive = false;
  };

  loop(); // fire-and-forget — single async chain, never overlaps
  state.stopLoop = () => { running = false; };
  return state.stopLoop;
}

/**
 * Identity function for env (no module-level env exists).
 * Use to preserve legacy call sites that expected getEnv().
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
      env.runtimeId = deriveSignerAddressSync(normalized, '1');
    } catch (error) {
      console.warn('⚠️ Failed to derive runtimeId from seed:', error);
      env.runtimeId = undefined;
    }
  } else {
    env.runtimeId = undefined;
  }
  if (env.runtimeId) {
    env.dbNamespace = normalizeDbNamespace(env.runtimeId);
  }
  const state = ensureRuntimeState(env);
  if (state.pendingP2PConfig && env.runtimeId) {
    console.log(`[P2P] pendingP2PConfig triggered, relayUrls=${state.pendingP2PConfig.relayUrls?.join(',')}`);
    const config = state.pendingP2PConfig;
    state.pendingP2PConfig = null;
    startP2P(env, config);
  }
};

export const setRuntimeId = (env: Env, id: string | null): void => {
  env.runtimeId = id && id.length > 0 ? id : undefined;
  if (env.runtimeId) {
    env.dbNamespace = normalizeDbNamespace(env.runtimeId);
  }
  const state = ensureRuntimeState(env);
  if (state.pendingP2PConfig && env.runtimeId) {
    console.log(`[P2P] pendingP2PConfig triggered, relayUrls=${state.pendingP2PConfig.relayUrls?.join(',')}`);
    const config = state.pendingP2PConfig;
    state.pendingP2PConfig = null;
    startP2P(env, config);
  }
};

// Derive runtimeId from seed (for isolated envs that need to set their own runtimeId)
export const deriveRuntimeId = (seed: string): string => {
  return deriveSignerAddressSync(seed, '1');
};

// scheduleNetworkProcess removed — loop is always-on via startRuntimeLoop()

const outputDeferKey = (output: RoutedEntityInput): string => buildRouteOutputKey(output);

const normalizeEntityKey = (value: string): string => value.toLowerCase();
const bytesToHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;

const deriveEntityCryptoKeyPairHex = (material: Uint8Array | string): { publicKey: string; privateKey: string } => {
  const pair = deriveEncryptionKeyPair(material);
  return {
    publicKey: pubKeyToHex(pair.publicKey),
    privateKey: bytesToHex(pair.privateKey),
  };
};

const hasLocalSignerKey = (env: Env, signerId: string): boolean => {
  try {
    getSignerPrivateKey(env, signerId);
    return true;
  } catch {
    return false;
  }
};

const deriveLocalEntityCryptoKeys = (env: Env, entityId: string, signerId: string): { publicKey: string; privateKey: string } | null => {
  try {
    const signerPriv = getSignerPrivateKey(env, signerId);
    const signerMaterial = `${bytesToHex(signerPriv)}:${entityId}:htlc-v1`;
    return deriveEntityCryptoKeyPairHex(signerMaterial);
  } catch {
    return null;
  }
};

const ensureLocalEntityCryptoKeys = (env: Env): void => {
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const signerId = extractSignerId(replicaKey);
    if (!hasLocalSignerKey(env, signerId)) continue;
    const keys = deriveLocalEntityCryptoKeys(env, replica.entityId, signerId);
    if (!keys) continue;
    const { publicKey, privateKey } = keys;
    if (replica.state.cryptoPublicKey !== publicKey || replica.state.cryptoPrivateKey !== privateKey) {
      replica.state.cryptoPublicKey = publicKey;
      replica.state.cryptoPrivateKey = privateKey;
    }
  }
};

const resolveRuntimeIdFromProfile = (profile: Profile | undefined): string | null => {
  if (!profile) return null;
  const direct = typeof profile.runtimeId === 'string' && profile.runtimeId.length > 0
    ? profile.runtimeId
    : null;
  if (direct) return direct;

  const metaRuntimeId = (profile.metadata as Record<string, unknown> | undefined)?.runtimeId;
  if (typeof metaRuntimeId === 'string' && metaRuntimeId.length > 0) {
    return metaRuntimeId;
  }

  const board = profile.metadata?.board;
  if (board && typeof board === 'object' && 'validators' in board && Array.isArray(board.validators)) {
    const firstSigner = board.validators[0]?.signer;
    if (typeof firstSigner === 'string' && firstSigner.startsWith('0x') && firstSigner.length === 42) {
      return firstSigner;
    }
  }

  return null;
};

const RUNTIME_HINT_TTL_MS = 60_000;

const resolveRuntimeIdForEntity = (env: Env, entityId: string): string | null => {
  if (!entityId) return null;
  const hints = ensureRuntimeState(env).entityRuntimeHints;
  const target = normalizeEntityKey(entityId);
  const now = Date.now();

  const hinted = hints?.get(target);
  if (
    hinted &&
    typeof hinted.runtimeId === 'string' &&
    hinted.runtimeId.length > 0 &&
    Number.isFinite(hinted.seenAt) &&
    now - hinted.seenAt <= RUNTIME_HINT_TTL_MS
  ) {
    return hinted.runtimeId;
  }

  // Fallback to gossip profile runtimeId when we don't have a fresh inbound hint.
  if (env.gossip?.getProfiles) {
    const profiles = env.gossip.getProfiles() as Profile[];
    const profile = profiles.find((p: Profile) => normalizeEntityKey(String(p.entityId || '')) === target);
    const resolved = resolveRuntimeIdFromProfile(profile);
    if (resolved && hints) {
      hints.set(target, { runtimeId: resolved.toLowerCase(), seenAt: now });
      return resolved.toLowerCase();
    }
  }
  return null;
};

export const registerEntityRuntimeHint = (env: Env, entityId: string, runtimeId: string): void => {
  if (!entityId || !runtimeId) return;
  const state = ensureRuntimeState(env);
  const hints = state.entityRuntimeHints!;
  hints.set(normalizeEntityKey(entityId), {
    runtimeId: runtimeId.toLowerCase(),
    seenAt: Date.now(),
  });
};

const collectSenderEntityHints = (input: RoutedEntityInput): string[] => {
  const hints = new Set<string>();
  for (const tx of input.entityTxs || []) {
    const data = tx.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object') continue;
    const fromEntityId = data.fromEntityId;
    if (typeof fromEntityId === 'string' && fromEntityId.length > 0) {
      hints.add(fromEntityId);
    }
  }
  return [...hints];
};

type PlannedRemoteOutput = {
  output: RoutedEntityInput;
  targetRuntimeId: string;
};

const DEFER_RETRY_DELAY_MS = 5_000;
const DEFER_MAX_ATTEMPTS = 3;

const getDeferredNetworkMeta = (
  env: Env,
): Map<string, { attempts: number; nextRetryAt: number }> => {
  const state = ensureRuntimeState(env);
  if (!state.deferredNetworkMeta) {
    state.deferredNetworkMeta = new Map();
  }
  return state.deferredNetworkMeta;
};

const getRuntimeNowMs = (env: Env): number =>
  env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();

const splitPendingOutputsByRetryWindow = (
  env: Env,
  pending: RoutedEntityInput[],
): { ready: RoutedEntityInput[]; waiting: RoutedEntityInput[] } => {
  if (pending.length === 0) return { ready: [], waiting: [] };
  const nowMs = getRuntimeNowMs(env);
  const meta = getDeferredNetworkMeta(env);
  const ready: RoutedEntityInput[] = [];
  const waiting: RoutedEntityInput[] = [];

  for (const output of pending) {
    const key = outputDeferKey(output);
    const entry = meta.get(key);
    if (!entry || entry.nextRetryAt <= nowMs) {
      ready.push(output);
      continue;
    }
    waiting.push(output);
  }
  return { ready, waiting };
};

const rescheduleDeferredOutputs = (
  env: Env,
  attemptedPending: RoutedEntityInput[],
  failed: RoutedEntityInput[],
  waiting: RoutedEntityInput[],
): RoutedEntityInput[] => {
  const nowMs = getRuntimeNowMs(env);
  const meta = getDeferredNetworkMeta(env);
  const next = new Map<string, RoutedEntityInput>();

  // Keep outputs still waiting for their retry window.
  for (const output of waiting) {
    next.set(outputDeferKey(output), output);
  }

  const failedKeys = new Set(failed.map((output) => outputDeferKey(output)));

  // Pending outputs that were retried and delivered can clear retry metadata.
  for (const output of attemptedPending) {
    const key = outputDeferKey(output);
    if (!failedKeys.has(key)) {
      meta.delete(key);
    }
  }

  // Failed attempts get bounded retry with fixed 5s delay.
  for (const output of failed) {
    const key = outputDeferKey(output);
    const entry = meta.get(key);
    const attempts = (entry?.attempts ?? 0) + 1;
    if (attempts >= DEFER_MAX_ATTEMPTS) {
      meta.delete(key);
      env.warn('network', 'ROUTE_DROP_MAX_RETRIES', {
        entityId: output.entityId,
        attempts,
      });
      continue;
    }

    meta.set(key, {
      attempts,
      nextRetryAt: nowMs + DEFER_RETRY_DELAY_MS,
    });
    next.set(key, output);

    if (attempts === 1) {
      env.warn('network', 'ROUTE_DEFER_RETRY', {
        entityId: output.entityId,
        retryInMs: DEFER_RETRY_DELAY_MS,
        attemptsRemaining: DEFER_MAX_ATTEMPTS - attempts,
      });
    }
  }

  return [...next.values()];
};

const planEntityOutputs = (env: Env, outputs: RoutedEntityInput[]): {
  localOutputs: RoutedEntityInput[];
  remoteOutputs: PlannedRemoteOutput[];
  deferredOutputs: RoutedEntityInput[];
} => {
  const localEntityIds = new Set<string>();
  for (const replicaKey of env.eReplicas.keys()) {
    try {
      localEntityIds.add(extractEntityId(replicaKey));
    } catch {
      // Skip malformed replica keys
    }
  }

  const localOutputs: RoutedEntityInput[] = [];
  const remoteOutputs: PlannedRemoteOutput[] = [];
  const deduped = new Map<string, RoutedEntityInput>();
  for (const output of outputs) {
    deduped.set(outputDeferKey(output), output);
  }
  const allOutputs = [...deduped.values()];
  const deferredOutputs: RoutedEntityInput[] = [];

  for (const output of allOutputs) {
    if (localEntityIds.has(output.entityId)) {
      localOutputs.push(output);
      continue;
    }
    const targetRuntimeId = resolveRuntimeIdForEntity(env, output.entityId);
    console.log(`🔀 ROUTE: Output for entity ${output.entityId.slice(-4)} → runtimeId=${targetRuntimeId?.slice(0,10) || 'UNKNOWN'}`);
    if (!targetRuntimeId) {
      deferredOutputs.push(output);
      continue;
    }
    remoteOutputs.push({ output, targetRuntimeId });
  }

  return { localOutputs, remoteOutputs, deferredOutputs };
};

// Batch multiple outputs to same entityId:signerId into one EntityInput
const batchOutputsByTarget = (outputs: RoutedEntityInput[]): RoutedEntityInput[] => {
  const batched = new Map<string, RoutedEntityInput>();

  for (const output of outputs) {
    const key = `${output.entityId}:${output.signerId || ''}`;
    const existing = batched.get(key);

    if (existing) {
      // Merge entityTxs
      if (output.entityTxs?.length) {
        existing.entityTxs = [...(existing.entityTxs || []), ...output.entityTxs];
      }
      // Keep latest proposedFrame (or first if only one has it)
      if (output.proposedFrame) {
        existing.proposedFrame = output.proposedFrame;
      }
      // Merge hashPrecommits
      if (output.hashPrecommits) {
        existing.hashPrecommits = existing.hashPrecommits || new Map();
        output.hashPrecommits.forEach((sigs, signerId) => {
          existing.hashPrecommits!.set(signerId, sigs);
        });
      }
      console.log(`📦 BATCH: Merged output into ${key} (now ${existing.entityTxs?.length || 0} txs)`);
    } else {
      batched.set(key, { ...output });
    }
  }

  return Array.from(batched.values());
};

const dispatchEntityOutputs = (env: Env, outputs: PlannedRemoteOutput[]): RoutedEntityInput[] => {
  const state = ensureRuntimeState(env);
  const directDispatch = state.directEntityInputDispatch;
  const p2p = getP2P(env);

  // CRITICAL: Batch outputs to same target before sending
  const groupedByRuntime = new Map<string, RoutedEntityInput[]>();
  for (const { output, targetRuntimeId } of outputs) {
    const list = groupedByRuntime.get(targetRuntimeId) || [];
    list.push(output);
    groupedByRuntime.set(targetRuntimeId, list);
  }

  const batchedOutputs: PlannedRemoteOutput[] = [];
  for (const [targetRuntimeId, grouped] of groupedByRuntime.entries()) {
    const batchedGrouped = batchOutputsByTarget(grouped);
    for (const output of batchedGrouped) {
      batchedOutputs.push({ output, targetRuntimeId });
    }
  }
  if (batchedOutputs.length < outputs.length) {
    console.log(`📦 BATCH: Reduced ${outputs.length} outputs → ${batchedOutputs.length} batched messages`);
  }

  const deferredOutputs: RoutedEntityInput[] = [];
  for (const { output, targetRuntimeId } of batchedOutputs) {
    if (directDispatch) {
      const deliveredDirect = directDispatch(targetRuntimeId, output);
      if (deliveredDirect) {
        continue;
      }
    }
    if (!p2p) {
      env.warn('network', 'ROUTE_DROP_NO_P2P', {
        entityId: output.entityId,
        runtimeId: targetRuntimeId,
      });
      deferredOutputs.push(output);
      continue;
    }
    console.log(`📤 P2P-SEND: Enqueueing to runtimeId ${targetRuntimeId.slice(0, 10)} for entity ${output.entityId.slice(-4)} (${output.entityTxs?.length || 0} txs)`);
    try {
      p2p.enqueueEntityInput(targetRuntimeId, output);
    } catch (error) {
      env.warn('network', 'ROUTE_DEFER_SEND_FAILED', {
        entityId: output.entityId,
        runtimeId: targetRuntimeId,
        error: (error as Error).message,
      });
      deferredOutputs.push(output);
    }
  }
  return deferredOutputs;
};

export const sendEntityInput = (env: Env, input: RoutedEntityInput): { sent: boolean; deferred: boolean; queuedLocal: boolean } => {
  const pendingBeforePlan = env.pendingNetworkOutputs ?? [];
  const { ready: readyPendingOutputs, waiting: waitingPendingOutputs } =
    splitPendingOutputsByRetryWindow(env, pendingBeforePlan);
  const outputsToPlan = [...readyPendingOutputs, input];
  const { localOutputs, remoteOutputs, deferredOutputs } = planEntityOutputs(env, outputsToPlan);
  env.pendingNetworkOutputs = [];
  if (localOutputs.length > 0) {
    enqueueRuntimeInputs(env, localOutputs);
  }
  const deferred = dispatchEntityOutputs(env, remoteOutputs);
  const remainingDeferred = [...deferredOutputs, ...deferred];
  env.pendingNetworkOutputs = rescheduleDeferredOutputs(
    env,
    readyPendingOutputs,
    remainingDeferred,
    waitingPendingOutputs,
  );

  return {
    sent: remoteOutputs.length > 0 && deferred.length === 0,
    deferred: env.pendingNetworkOutputs.length > 0,
    queuedLocal: localOutputs.length > 0,
  };
};

export const startP2P = (env: Env, config: P2PConfig = {}): RuntimeP2P | null => {
  console.log(`[P2P] startP2P called, relayUrls=${config.relayUrls?.join(',')}, env.runtimeId=${env.runtimeId?.slice(0,10) || 'NONE'}`);
  const state = ensureRuntimeState(env);
  state.lastP2PConfig = config;
  ensureLocalEntityCryptoKeys(env);
  const resolvedRuntimeId = config.runtimeId || env.runtimeId;
  if (!resolvedRuntimeId) {
    console.log(`[P2P] No runtimeId, storing as pendingP2PConfig`);
    state.pendingP2PConfig = config;
    return null;
  }

  const existingGlobalP2P = (env as Record<PropertyKey, unknown>)[ENV_P2P_SINGLETON_KEY] as P2Pish | undefined;
  if (existingGlobalP2P && existingGlobalP2P !== state.p2p) {
    const canReuse =
      typeof existingGlobalP2P.matchesIdentity === 'function' &&
      existingGlobalP2P.matchesIdentity(resolvedRuntimeId, config.signerId);
    if (!canReuse) {
      throw new Error(`P2P_SINGLETON_VIOLATION: attempted second p2p attachment for env runtimeId=${resolvedRuntimeId}`);
    }
    if (typeof existingGlobalP2P.updateConfig === 'function') {
      existingGlobalP2P.updateConfig(config);
    }
    state.p2p = existingGlobalP2P as RuntimeP2P;
    return state.p2p;
  }

  if (state.p2p) {
    if (state.p2p.matchesIdentity(resolvedRuntimeId, config.signerId)) {
      state.p2p.updateConfig(config);
      return state.p2p;
    }
    state.p2p.close();
  }

  state.p2p = new RuntimeP2P({
    env,
    runtimeId: resolvedRuntimeId,
    signerId: config.signerId,
    relayUrls: config.relayUrls,
    seedRuntimeIds: config.seedRuntimeIds,
    advertiseEntityIds: config.advertiseEntityIds,
    isHub: config.isHub,
    profileName: config.profileName,
    gossipPollMs: config.gossipPollMs,
    onEntityInput: (from, input) => {
      const txTypes = input.entityTxs?.map(tx => tx.type).join(',') || 'none';
      console.log(`📨 P2P-RECEIVE: from=${from.slice(0,10)} entity=${input.entityId.slice(-4)} txTypes=[${txTypes}]`);
      const targetEntityId = String(input.entityId || '').toLowerCase();
      const localReplicaExists = Array.from(env.eReplicas.keys()).some((key) => {
        const [entityKey] = String(key).split(':');
        return String(entityKey || '').toLowerCase() === targetEntityId;
      });
      if (!localReplicaExists) {
        // Drop poison ingress early: this runtime has no local replica for target entity.
        // Enqueuing would trigger failfast in applyRuntimeInput and loop forever.
        env.warn('network', 'INBOUND_ENTITY_UNKNOWN_TARGET', {
          fromRuntimeId: from,
          entityId: input.entityId,
          txTypes,
        }, input.entityId);
        return;
      }
      for (const hintedEntityId of collectSenderEntityHints(input)) {
        registerEntityRuntimeHint(env, hintedEntityId, from);
      }
      enqueueRuntimeInputs(env, [input]);
      console.log(`📥 RUNTIME-MEMPOOL: Added inbound, size=${ensureRuntimeMempool(env).entityInputs.length}`);
      env.info('network', 'INBOUND_ENTITY_INPUT', { fromRuntimeId: from, entityId: input.entityId }, input.entityId);
    
    },
    onGossipProfiles: (_from, profiles) => {
      if (!env.gossip?.announce) return;
      // Store profiles in local gossip cache (silently)
      for (const profile of profiles) {
        env.gossip.announce(profile);
      }
    },
  });

  (env as Record<PropertyKey, unknown>)[ENV_P2P_SINGLETON_KEY] = state.p2p;
  state.p2p.connect();
  return state.p2p;
};

export const stopP2P = (env: Env): void => {
  const state = ensureRuntimeState(env);
  if (state.p2p) {
    state.p2p.close();
    const singleton = (env as Record<PropertyKey, unknown>)[ENV_P2P_SINGLETON_KEY];
    if (singleton === state.p2p) {
      delete (env as Record<PropertyKey, unknown>)[ENV_P2P_SINGLETON_KEY];
    }
    state.p2p = null;
  }
  state.lastP2PConfig = null;
};

export const getP2P = (env: Env): RuntimeP2P | null => ensureRuntimeState(env).p2p ?? null;

export type P2PConnectionState = {
  connected: boolean;
  reconnect: { attempt: number; nextAt: number } | null;
  queue: { targetCount: number; totalMessages: number; oldestEntryAge: number; perTarget: Record<string, number> };
};

export const getP2PState = (env: Env): P2PConnectionState => {
  const p2p = getP2P(env);
  if (!p2p) {
    return { connected: false, reconnect: null, queue: { targetCount: 0, totalMessages: 0, oldestEntryAge: 0, perTarget: {} } };
  }
  return {
    connected: p2p.isConnected(),
    reconnect: p2p.getReconnectState(),
    queue: p2p.getQueueState(),
  };
};

export const refreshGossip = (env: Env): void => {
  const state = ensureRuntimeState(env);
  if (state.p2p) {
    state.p2p.refreshGossip();
  }
};

export const clearGossip = (env: Env): void => {
  if (!env.gossip?.profiles) return;
  env.gossip.profiles.clear();
  notifyEnvChange(env);
};

/**
 * Initialize module-level env if not already set
 * Call this early in frontend initialization before prepopulate
 */
export const initEnv = (seed?: string | null): Env => {
  const env = createEmptyEnv(seed ?? null);
  if (env.runtimeSeed !== undefined && env.runtimeSeed !== null) {
    setCryptoRuntimeSeed(env.runtimeSeed);
  }
  return env;
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
    env.scenarioMode === true || (env as Record<PropertyKey, unknown>)[ENV_APPLY_ALLOWED_KEY] === true,
    'RUNTIME_APPLY_DIRECT_CALL',
    'applyRuntimeInput must be invoked via process()/WAL replay (non-scenario)',
    { runtimeId: env.runtimeId, height: env.height }
  );
  const startTime = getPerfMs();

  // Ensure event emitters are attached (may be lost after store serialization)
  if (!env.emit) {
    attachEventEmitters(env);
  }

  try {
    if ((env as Record<PropertyKey, unknown>)[ENV_REPLAY_MODE_KEY] === true) {
      console.log(
        `[REPLAY] applyRuntimeInput runtimeTxs=${runtimeInput.runtimeTxs.length} entityInputs=${runtimeInput.entityInputs.length}`
      );
    }
    // SECURITY: Validate runtime input
    if (!runtimeInput) {
      log.error('❌ Null runtime input provided');
      return { entityOutbox: [], mergedInputs: [], jOutbox: [], appliedRuntimeInput: { runtimeTxs: [], entityInputs: [] } };
    }
    if (!Array.isArray(runtimeInput.runtimeTxs)) {
      log.error(`❌ Invalid runtimeTxs: expected array, got ${typeof runtimeInput.runtimeTxs}`);
      return { entityOutbox: [], mergedInputs: [], jOutbox: [], appliedRuntimeInput: { runtimeTxs: [], entityInputs: [] } };
    }
    if (!Array.isArray(runtimeInput.entityInputs)) {
      log.error(`❌ Invalid entityInputs: expected array, got ${typeof runtimeInput.entityInputs}`);
      return { entityOutbox: [], mergedInputs: [], jOutbox: [], appliedRuntimeInput: { runtimeTxs: [], entityInputs: [] } };
    }

    // Collect incoming J-inputs into early jOutbox (will be merged with handler jOutputs later)
    // These are NOT pushed to jReplica.mempool — they go to jOutbox → JAdapter post-save
    const earlyJOutbox: JInput[] = [];
    if (runtimeInput.jInputs && Array.isArray(runtimeInput.jInputs)) {
      console.log(`📥 [J-OUTBOX] Incoming jInputs: ${runtimeInput.jInputs.length} from mempool`);
      for (const jInput of runtimeInput.jInputs) {
        const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
        if (!jReplica) {
          console.error(`❌ [J-OUTBOX] Jurisdiction "${jInput.jurisdictionName}" not found — dropping ${jInput.jTxs.length} jTxs`);
          continue;
        }
        console.log(`📥 [J-OUTBOX] Collecting ${jInput.jTxs.length} jTxs for ${jInput.jurisdictionName} (types: ${jInput.jTxs.map(t => t.type).join(',')})`);
        earlyJOutbox.push(jInput);
      }
    }

    // SECURITY: Resource limits
    if (runtimeInput.runtimeTxs.length > 1000) {
      log.error(`❌ Too many runtime transactions: ${runtimeInput.runtimeTxs.length} > 1000`);
      return { entityOutbox: [], mergedInputs: [], jOutbox: [], appliedRuntimeInput: { runtimeTxs: [], entityInputs: [] } };
    }
    if (runtimeInput.entityInputs.length > 10000) {
      log.error(`❌ Too many entity inputs: ${runtimeInput.entityInputs.length} > 10000`);
      return { entityOutbox: [], mergedInputs: [], jOutbox: [] };
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
        logError("RUNTIME_TICK", `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityInput[${i}] before merge!`, {
          error: (error as Error).message,
          input
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
          const fromReplica = runtimeTx.data.contracts ? {
            depositoryAddress: runtimeTx.data.contracts.depository,
            entityProviderAddress: runtimeTx.data.contracts.entityProvider,
            contracts: runtimeTx.data.contracts, // Pass all contract addresses
            chainId: runtimeTx.data.chainId,
          } as JReplica : undefined;

          const jadapter = await createJAdapter({
            mode: isBrowserVM ? 'browservm' : 'rpc',
            chainId: runtimeTx.data.chainId,
            rpcUrl: isBrowserVM ? undefined : runtimeTx.data.rpcs[0],
            fromReplica, // Pass pre-deployed addresses (skips deployment)
            // TODO: Pass all rpcs for failover: rpcs: runtimeTx.data.rpcs
          });

          // Deploy contracts only if fromReplica not provided
          if (!fromReplica) {
            await jadapter.deployStack();
          }

          // For BrowserVM, set as default jurisdiction in env
          if (isBrowserVM) {
            const browserVM = (jadapter as any).browserVM;
            if (browserVM) {
              setBrowserVMJurisdiction(env, jadapter.addresses.depository, browserVM);
            }
          }

          // Initialize jReplicas Map if needed
          if (!env.jReplicas) {
            env.jReplicas = new Map();
          }

          // Create JReplica (store jadapter for later use)
          const jReplica: JReplica = {
            name: runtimeTx.data.name,
            blockNumber: 0n,
            stateRoot: new Uint8Array(32),
            mempool: [],
            blockDelayMs: 300,
            lastBlockTimestamp: env.timestamp,
            position: { x: 0, y: 50, z: 0 }, // Default position for J-machine
            depositoryAddress: jadapter.addresses.depository,
            entityProviderAddress: jadapter.addresses.entityProvider,
            rpcs: runtimeTx.data.rpcs,
            chainId: runtimeTx.data.chainId,
            jadapter, // Store for balance queries, faucets, etc
          };
          env.jReplicas.set(runtimeTx.data.name, jReplica);

          // Set as active if first
          if (!env.activeJurisdiction) {
            env.activeJurisdiction = runtimeTx.data.name;
          }

          // Start JAdapter's integrated watcher (feeds J-events → runtime mempool)
          jadapter.startWatching(env);
          console.log(`[Runtime] ✅ JReplica "${runtimeTx.data.name}" ready (watching)`);
        } catch (error) {
          console.error(`[Runtime] ❌ Failed to import J-machine:`, error);
        }
      } else if (runtimeTx.type === 'importReplica') {
        if (DEBUG)
          console.log(
            `Importing replica Entity #${formatEntityDisplay(runtimeTx.entityId)}:${formatSignerDisplay(runtimeTx.signerId)} (proposer: ${runtimeTx.data.isProposer})`,
          );

        const replicaKey = `${runtimeTx.entityId}:${runtimeTx.signerId}`;
        const existingReplica = env.eReplicas.get(replicaKey);
        if (existingReplica) {
          // Persistence safety: never overwrite restored replica state on re-import.
          existingReplica.isProposer = runtimeTx.data.isProposer;
          if (runtimeTx.data.config) {
            existingReplica.state.config = runtimeTx.data.config;
          }
          env.eReplicas.set(replicaKey, existingReplica);
          if (DEBUG) {
            console.log(
              `Skipping fresh replica init for restored entity #${formatEntityDisplay(runtimeTx.entityId)}:${formatSignerDisplay(runtimeTx.signerId)}`
            );
          }
          continue;
        }
        const replica: EntityReplica = {
          entityId: runtimeTx.entityId,
          signerId: runtimeTx.signerId,
          mempool: [],
          isProposer: runtimeTx.data.isProposer,
          state: {
            entityId: runtimeTx.entityId, // Store entityId in state
            height: 0,
            timestamp: env.timestamp,
            nonces: new Map(),
            messages: [],
            proposals: new Map(),
            config: runtimeTx.data.config,
            // 💰 Initialize financial state
            reserves: new Map(), // tokenId -> bigint amount
            accounts: new Map(), // counterpartyEntityId -> AccountMachine
            deferredAccountProposals: new Map(),

            // 🔭 J-machine tracking (JBlock consensus)
            lastFinalizedJHeight: 0,
            jBlockObservations: [],
            jBlockChain: [],

            // ⏰ Crontab system - will be initialized on first use
            crontabState: undefined,

            // 📦 J-Batch system - will be initialized on first use
            jBatchState: undefined,

            // 🔒 HTLC routing and fee tracking
            htlcRoutes: new Map(),
            htlcFeesEarned: 0n,

            // 📖 Aggregated books (E-Machine view of A-Machine positions)
            swapBook: new Map(),
            lockBook: new Map(),
            pendingSwapFillRatios: new Map(),
          },
        };

        // 🔐 Deterministic HTLC envelope keys (stable across reloads)
        const localKeys = deriveLocalEntityCryptoKeys(env, runtimeTx.entityId, runtimeTx.signerId);
        if (localKeys) {
          const { publicKey, privateKey } = localKeys;
          replica.state.cryptoPublicKey = publicKey;
          replica.state.cryptoPrivateKey = privateKey;
        }

        // Only add position if it exists (exactOptionalPropertyTypes compliance)
        if (runtimeTx.data.position) {
          replica.position = {
            ...runtimeTx.data.position,
            jurisdiction: runtimeTx.data.position.jurisdiction || runtimeTx.data.position.xlnomy || env.activeJurisdiction || 'default',
          };
        }

        env.eReplicas.set(replicaKey, replica);

        const browserVM = getBrowserVMInstance(env);
        if (browserVM) {
          const validators = runtimeTx.data.config.validators;
          const threshold = runtimeTx.data.config.threshold;
          if (validators.length === 1 && threshold === 1n) {
            const signerId = validators[0];
            try {
              const privateKey = getSignerPrivateKey(env, signerId);
              const privateKeyHex = `0x${Array.from(privateKey).map(b => b.toString(16).padStart(2, '0')).join('')}`;
              if (typeof browserVM.registerEntityWallet === 'function') {
                browserVM.registerEntityWallet(runtimeTx.entityId, privateKeyHex);
              } else {
                console.warn(`⚠️ BrowserVM missing registerEntityWallet - skipping wallet registration for ${runtimeTx.entityId.slice(0, 10)}...`);
              }
            } catch (error) {
              console.warn(`⚠️ Cannot derive private key for signer ${signerId} (no env.runtimeSeed), skipping BrowserVM wallet registration`);
            }
          }
        }

        // Validate jBlock immediately after creation
        const createdReplica = env.eReplicas.get(replicaKey);
        const actualJBlock = createdReplica?.state.lastFinalizedJHeight;
        // REPLICA-DEBUG removed

        // Broadcast initial profile to gossip layer
        if (env.gossip && createdReplica) {
          const primarySignerId = runtimeTx.data.config.validators?.[0];
          const entityPublicKey = primarySignerId ? getSignerPublicKey(env, primarySignerId) : null;
          const publicKeyHex = entityPublicKey ? `0x${Buffer.from(entityPublicKey).toString('hex')}` : undefined;
          const existingProfile = env.gossip?.getProfiles?.().find((p: any) => p.entityId === runtimeTx.entityId);
          const existingName = existingProfile?.metadata?.name;
          const profile = buildEntityProfile(createdReplica.state, existingName, env.timestamp);
          const mergedProfile = mergeProfileWithExisting(profile, existingProfile);
          mergedProfile.runtimeId = env.runtimeId;
          if (publicKeyHex) {
            mergedProfile.metadata = { ...(mergedProfile.metadata || {}), entityPublicKey: publicKeyHex };
          }
          env.gossip.announce(mergedProfile);
        }

        if (typeof actualJBlock !== 'number') {
          logError("RUNTIME_TICK", `💥 ENTITY-CREATION-BUG: Just created entity with invalid jBlock!`);
          logError("RUNTIME_TICK", `💥   Expected: 0 (number), Got: ${typeof actualJBlock}, Value: ${actualJBlock}`);
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

    for (const entityInput of mergedInputs) {
      if ((env as Record<PropertyKey, unknown>)[ENV_REPLAY_MODE_KEY] === true) {
        console.log(
          `[REPLAY][RUNTIME] merged input entity=${String(entityInput.entityId).slice(-8)} ` +
          `signer=${String(entityInput.signerId ?? '')} txs=${entityInput.entityTxs?.length ?? 0} ` +
          `types=${(entityInput.entityTxs ?? []).map((tx) => tx.type).join(',')}`
        );
      }
      // Track j-events in this input - entityInput.entityTxs guaranteed by validateEntityInput above
      // J-EVENT logging removed - too verbose

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
        actualSignerId = resolveEntityProposerId(env, entityInput.entityId, 'applyRuntimeInput');
      }
      failfastAssert(
        typeof actualSignerId === 'string' && actualSignerId.length > 0,
        'RUNTIME_SIGNER_RESOLUTION_FAILED',
        'Unable to resolve signerId for entity input',
        { entityId: entityInput.entityId, providedSignerId: entityInput.signerId }
      );

      let replicaKey = `${entityInput.entityId}:${actualSignerId}`;
      let entityReplica = env.eReplicas.get(replicaKey);
      if (!entityReplica) {
        // Recovery path for stale/misrouted signer hints: resolve to current proposer once.
        // This preserves deterministic REA behavior while keeping signer resolution at ingress.
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
        if ((env as Record<PropertyKey, unknown>)[ENV_REPLAY_MODE_KEY] === true) {
          console.log(
            `[REPLAY][RUNTIME] applyEntityInput replica=${replicaKey.slice(0, 20)} ` +
            `txs=${normalizedInput.entityTxs?.length ?? 0}`
          );
        }
        const { newState, outputs, jOutputs, workingReplica } = await applyEntityInput(env, entityReplica, normalizedInputWithSigner);
        // APPLY-ENTITY-INPUT-RESULT removed - too noisy

        // IMMUTABILITY: Update replica with new state from applyEntityInput
        // CRITICAL: Preserve proposal/lockedFrame from workingReplica (multi-signer consensus)
        // Only cleared when threshold reached and frame committed (handled in entity-consensus.ts)
        env.eReplicas.set(replicaKey, {
          ...entityReplica,
          state: newState,
          mempool: workingReplica.mempool, // Preserve mempool state
          proposal: workingReplica.proposal, // CRITICAL: Preserve for multi-signer threshold
          lockedFrame: workingReplica.lockedFrame, // CRITICAL: Preserve validator locks
          // Preserve multi-signer consensus artifacts across ticks.
          hankoWitness: workingReplica.hankoWitness,
          validatorComputedState: workingReplica.validatorComputedState,
        });

        // FINTECH-LEVEL TYPE SAFETY: Validate all entity outputs before routing
        outputs.forEach((output, index) => {
          try {
            validateEntityOutput(output);
          } catch (error) {
            logError("RUNTIME_TICK", `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityOutput[${index}] from ${replicaKey}!`, {
              error: (error as Error).message,
              output
            });
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
        failfastAssert(
          false,
          'RUNTIME_REPLICA_NOT_FOUND',
          'Entity input target replica missing after signer resolution',
          {
            entityId: entityInput.entityId,
            resolvedSignerId: actualSignerId,
            inputSignerId: entityInput.signerId,
            knownReplicas: Array.from(env.eReplicas.keys()).filter((k) =>
              String(k).toLowerCase().startsWith(`${String(entityInput.entityId).toLowerCase()}:`)
            ),
          }
        );
      }
    }

    // Log J-outputs — they stay in jOutbox and are returned to process() for post-save execution
    if (jOutbox.length > 0) {
      const totalJTxs = jOutbox.reduce((n, ji) => n + ji.jTxs.length, 0);
      console.log(`📤 [J-OUTBOX] ${jOutbox.length} JInputs (${totalJTxs} JTxs) collected — will broadcast to JAdapter post-save`);
      for (const jInput of jOutbox) {
        for (const jTx of jInput.jTxs) {
          console.log(`  📋 [J-OUTBOX] ${jTx.type} from ${jTx.entityId.slice(-4)} → ${jInput.jurisdictionName} (batchSize=${jTx.data?.batchSize ?? '?'})`);
          env.emit('JBatchQueued', {
            entityId: jTx.entityId,
            batchSize: jTx.data?.batchSize,
            jurisdictionName: jInput.jurisdictionName,
          });
        }
      }
    }

    // Only create runtime frame if there's actual work to do
    const hasRuntimeTxs = mergedRuntimeTxs.length > 0;
    const hasEntityInputs = mergedInputs.length > 0;
    const hasOutputs = entityOutbox.length > 0;
    const hasJOutputs = jOutbox.length > 0;

    if (hasRuntimeTxs || hasEntityInputs || hasOutputs || hasJOutputs) {
      // Emit runtime tick event
      env.emit('RuntimeTick', {
        height: env.height + 1,
        runtimeTxs: mergedRuntimeTxs.length,
        entityInputs: mergedInputs.length,
        outputs: entityOutbox.length,
      });

      // Update env (mutable)
      env.height++;
      // IMPORTANT: Do NOT mutate env.timestamp here.
      // process() sets a single frame timestamp before applyRuntimeInput(),
      // and that exact value must be used both for frame hashing and WAL journal.

      // Capture snapshot BEFORE clearing (to show what was actually processed)
      const inputDescription = `Tick ${env.height - 1}: ${mergedRuntimeTxs.length} runtimeTxs, ${mergedInputs.length} merged entityInputs → ${entityOutbox.length} outputs`;
      const processedInput = {
        runtimeTxs: [...mergedRuntimeTxs],
        entityInputs: [...mergedInputs], // Use merged inputs instead of raw inputs
      };

      // CRITICAL: Update JReplica stateRoots from BrowserVM BEFORE snapshot
      // Without this, time-travel shows stale EVM state from xlnomy creation
      const browserVM = getBrowserVMInstance(env);
      if (browserVM?.captureStateRoot && env.jReplicas) {
        try {
          const freshStateRoot = await browserVM.captureStateRoot();
          for (const [name, jReplica] of env.jReplicas.entries()) {
            jReplica.stateRoot = freshStateRoot;
          }
        } catch (e) {
          // Silent fail - stateRoot capture is optional for time-travel
        }
      }

      // CRITICAL: Sync collaterals and blockNumber from BrowserVM BEFORE snapshot
      if (browserVM?.syncAllCollaterals && env.jReplicas && env.eReplicas) {
        try {
          // Collect all account pairs from all entities
          const accountPairs: Array<{ entityId: string; counterpartyId: string }> = [];
          for (const [replicaKey, replica] of env.eReplicas.entries()) {
            if (replica.state.accounts) {
              for (const [counterpartyId, _account] of replica.state.accounts) {
                const entityId = replicaKey.split(':')[0];
                accountPairs.push({ entityId, counterpartyId });
              }
            }
          }

          // Sync all collaterals from BrowserVM (for now, just tokenId 1 = USDC)
          const collaterals = await browserVM.syncAllCollaterals(accountPairs, 1);

          // Get current block height from BrowserVM
          const blockHeight = browserVM.getBlockHeight ? browserVM.getBlockHeight() : 0;

          // Update JReplica with synced data
          for (const [name, jReplica] of env.jReplicas.entries()) {
            jReplica.collaterals = collaterals;
            jReplica.blockNumber = BigInt(blockHeight);
          }

          // Sync on-chain collateral/ondelta into account deltas (authoritative for on-chain state)
          for (const [replicaKey, replica] of env.eReplicas.entries()) {
            const entityId = replicaKey.split(':')[0];
            for (const [counterpartyId, account] of replica.state.accounts) {
              // Avoid mutating live consensus state mid-flight.
              if (account.pendingFrame || account.mempool.length > 0) {
                continue;
              }
              const key = `${entityId}:${counterpartyId}`;
              const tokenMap = collaterals.get(key);
              for (const [tokenId, delta] of account.deltas) {
                const chain = tokenMap?.get(tokenId);
                const chainCollateral = chain?.collateral ?? 0n;
                const chainOndelta = chain?.ondelta ?? 0n;
                if (delta.collateral !== chainCollateral || delta.ondelta !== chainOndelta) {
                  delta.collateral = chainCollateral;
                  delta.ondelta = chainOndelta;
                }
              }
            }
          }
        } catch (e) {
          // Silent fail - collaterals sync is optional for debugging
          console.warn('[Runtime] Failed to sync BrowserVM state:', e);
        }
      }

      // NOTE: Snapshot creation moved to process() - single entry point
      // applyRuntimeInput just processes inputs, process() handles snapshotting
    } else {
      console.log(`⚪ SKIP-FRAME: No runtimeTxs, entityInputs, or outputs`);
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
        logError("RUNTIME_TICK", `❌ Invalid replica keys: old=${oldReplicaKey}, new=${newReplicaKey}`);
        // Continue with empty outbox instead of crashing
      } else {
      // REPLICA-STRUCTURE logs removed - not consensus-critical
      }
    }

    if ((env as Record<PropertyKey, unknown>)[ENV_REPLAY_MODE_KEY] !== true) {
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
    if ((env as Record<PropertyKey, unknown>)[ENV_REPLAY_MODE_KEY] !== true) {
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
    console.error(`❌ CRITICAL: applyRuntimeInput failed!`, error);
    throw error; // Don't swallow - fail fast and loud
  }
};

// Runtime bootstrap
const main = async (runtimeSeedOverride?: string | null): Promise<Env> => {
  console.log(`🚀 RUNTIME.JS VERSION: ${RUNTIME_BUILD_ID}`);

  const baseEnv = createEmptyEnv(runtimeSeedOverride ?? null);
  if (baseEnv.runtimeSeed !== undefined && baseEnv.runtimeSeed !== null) {
    setCryptoRuntimeSeed(baseEnv.runtimeSeed);
    try {
      prewarmSignerKeyCache(baseEnv.runtimeSeed, 20);
    } catch (error) {
      console.warn('⚠️ Failed to prewarm signer cache before restore:', error);
    }
  }

  const dbReady = await tryOpenDb(baseEnv);
  if (dbReady) {
    console.log('📡 Loading persisted profiles from database...');
    await loadPersistedProfiles(getRuntimeDb(baseEnv), baseEnv.gossip);
  }

  let env = baseEnv;
  if (isBrowser) {
    const loaded = await loadEnvFromDB(baseEnv.runtimeId, baseEnv.runtimeSeed);
    if (loaded) {
      const loadedState = ensureRuntimeState(loaded);
      const baseState = ensureRuntimeState(baseEnv);
      loadedState.db = baseState.db;
      loadedState.dbOpenPromise = baseState.dbOpenPromise;
      if (baseEnv.gossip?.profiles) {
        for (const [k, v] of baseEnv.gossip.profiles.entries()) {
          loaded.gossip.profiles.set(k, v);
        }
      }
      env = loaded;
    }
  }

  attachEventEmitters(env);

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
      prewarmSignerKeyCache(env.runtimeSeed, 20);
      env.signers = [{ address: deriveSignerAddressSync(env.runtimeSeed, '1'), name: 'signer1' }];
      console.log('🔐 Prewarmed signer key cache (20 addresses)');
    } catch (error) {
      console.warn('⚠️ Failed to derive signer:', error);
    }
  }

  // J-event watching is handled by JAdapter.startWatching() per-jReplica

  // Start the runtime event loop (single async while-loop, never re-enters)
  if (isBrowser) {
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

// === SYSTEM SOLVENCY CHECK ===
// Total tokens in system: reserves + collateral must equal minted supply
interface Solvency {
  reserves: bigint;
  collateral: bigint;
  total: bigint;
  byToken: Map<number, { reserves: bigint; collateral: bigint; total: bigint }>;
}

const calculateSolvency = (env: Env, snapshot?: Env): Solvency => {
  const targetEnv = snapshot || env;
  const byToken = new Map<number, { reserves: bigint; collateral: bigint; total: bigint }>();

  let reserves = 0n;
  let collateral = 0n;

  for (const [_replicaKey, replica] of targetEnv.eReplicas) {
    // Sum reserves
    for (const [tokenId, amount] of replica.state.reserves) {
      reserves += amount;
      const existing = byToken.get(tokenId) || { reserves: 0n, collateral: 0n, total: 0n };
      existing.reserves += amount;
      existing.total = existing.reserves + existing.collateral;
      byToken.set(tokenId, existing);
    }

    // Sum collateral (left entity only to avoid double-counting)
    for (const [counterpartyId, account] of replica.state.accounts) {
      if (isLeftEntity(replica.state.entityId, counterpartyId)) {
        for (const [tokenId, delta] of account.deltas) {
          collateral += delta.collateral;
          const existing = byToken.get(tokenId) || { reserves: 0n, collateral: 0n, total: 0n };
          existing.collateral += delta.collateral;
          existing.total = existing.reserves + existing.collateral;
          byToken.set(tokenId, existing);
        }
      }
    }
  }

  return { reserves, collateral, total: reserves + collateral, byToken };
};

const verifySolvency = (env: Env, expected?: bigint, label?: string): boolean => {
  const s = calculateSolvency(env);
  const prefix = label ? `[${label}] ` : '';

  if (expected !== undefined && s.total !== expected) {
    console.error(`❌ ${prefix}SOLVENCY VIOLATION: Expected ${expected}, got ${s.total}`);
    console.error(`   Reserves: ${s.reserves}, Collateral: ${s.collateral}`);
    throw new Error(`Solvency check failed: ${s.total} !== ${expected}`);
  }

  console.log(`✅ ${prefix}Solvency: ${s.total} (R:${s.reserves} + C:${s.collateral})`);
  return true;
};

// Clear database for a specific runtime and return a fresh env
const clearDatabaseAndHistory = async (env: Env): Promise<Env> => {
  console.log('🗑️ Clearing database and resetting runtime history...');
  const db = getRuntimeDb(env);
  await clearDatabase(db);

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
  txData: { type: string; [key: string]: any }
): Promise<void> => {
  enqueueRuntimeInputs(env, [{
    entityId,
    signerId,
    entityTxs: [{ type: txData.type, data: txData }]
  }]);

};

export {
  applyRuntimeInput,
  assignNameOnChain,
  clearDatabase,
  classifyBilateralState,
  getAccountBarVisual,
  clearDatabaseAndHistory,
  // Clean logs: getCleanLogs, clearCleanLogs, copyCleanLogs - exported at definition
  connectToEthereum,
  // Entity creation functions
  createLazyEntity,
  createNumberedEntity,
  createNumberedEntitiesBatch,
  createProfileUpdateTx,
  demoCompleteHanko,
  detectEntityType,
  encodeBoard,
  // Display and avatar functions
  formatEntityDisplay,
  formatSignerDisplay,
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
  getNextEntityNumber,
  getSignerDisplayInfo,
  getSnapshot,
  hashBoard,
  isEntityRegistered,
  main,
  resolveEntityProposerId,
  // Blockchain registration functions
  registerNumberedEntityOnChain,
  requestNamedEntity,
  resolveEntityIdentifier,
  resolveEntityName,
  // Name resolution functions
  searchEntityNames,
  setBrowserVMJurisdiction,
  getBrowserVMInstance,
  // getEnv, initEnv, processJBlockEvents - already exported inline above
  submitProcessBatch,
  submitPrefundAccount,
  submitSettle,
  submitReserveToReserve,
  debugFundReserves,
  transferNameBetweenEntities,
  // Account utilities (destructured from AccountUtils)
  deriveDelta,
  isLeft,
  getTokenInfo,
  formatTokenAmount,
  createDemoDelta,
  getDefaultCreditLimit,

  // Entity utilities (from entity-helpers and serialization-utils)
  getEntityShortId,
  getEntityNumber, // deprecated, use getEntityShortId
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
// Use xln.ts as CLI entry point: `bun run xln.ts`
// Browser: index.html calls xln.main() explicitly

// === HANKO DEMO FUNCTION ===

const demoCompleteHanko = async (): Promise<void> => {
  try {
    // Check if running in browser environment
    const isBrowser = typeof window !== 'undefined';

    if (isBrowser) {
      console.log('🎯 Browser environment detected - running simplified Hanko demo...');
      console.log('✅ Basic signature verification available');
      console.log('💡 Full test suite available in Node.js environment');
      console.log('✅ Hanko browser demo completed!');
      return;
    }

    console.log('🎯 Complete Hanko test suite disabled during strict TypeScript mode');
    // await runCompleteHankoTests();
    console.log('✅ Complete Hanko tests skipped!');
  } catch (error) {
    logError("RUNTIME_TICK", '❌ Complete Hanko tests failed:', error);
    throw error;
  }
};

// Demo wrapper removed - use scenarios.ahb(env) or scenarios.grid(env) instead

// === ENVIRONMENT UTILITIES ===

const isEntryArray = (value: unknown): value is Array<[unknown, unknown]> =>
  Array.isArray(value) && value.length > 0 && Array.isArray(value[0]) && value[0].length === 2;

const normalizeReplicaMap = (raw: unknown): Map<string, EntityReplica> => {
  let map: Map<string, EntityReplica>;
  if (raw instanceof Map) {
    map = raw as Map<string, EntityReplica>;
  } else if (Array.isArray(raw)) {
    if (raw.length === 0) return new Map();
    if (isEntryArray(raw)) {
      map = new Map(raw as Array<[string, EntityReplica]>);
    } else {
      throw new Error('Invalid eReplicas array format in snapshot');
    }
  } else if (raw && typeof raw === 'object') {
    map = new Map(Object.entries(raw as Record<string, EntityReplica>));
  } else {
    throw new Error('Invalid eReplicas format in snapshot');
  }

  // Recovery safety: ensure signer/entity identity fields exist even if older
  // snapshots only had them in the replica map key ("entityId:signerId").
  for (const [key, replica] of map.entries()) {
    if (!replica || typeof replica !== 'object') continue;
    const [entityIdFromKey, signerIdFromKey] = String(key).split(':');
    if (!replica.entityId && entityIdFromKey) {
      (replica as EntityReplica).entityId = entityIdFromKey;
    }
    if (!replica.signerId && signerIdFromKey) {
      (replica as EntityReplica).signerId = signerIdFromKey;
    }
    map.set(key, replica);
  }
  return map;
};

const normalizeContractAddress = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const maybeAddress = (value as { address?: unknown }).address;
    if (typeof maybeAddress === 'string') return maybeAddress;
    if (typeof (value as { toString?: () => string }).toString === 'function') {
      return (value as { toString: () => string }).toString();
    }
  }
  return undefined;
};

const normalizeJReplica = (jr: JReplica): JReplica => {
  if (!jr?.contracts) return jr;
  const depository = normalizeContractAddress(
    jr.contracts.depository || (jr.contracts as { depositoryAddress?: unknown }).depositoryAddress
  );
  const entityProvider = normalizeContractAddress(
    jr.contracts.entityProvider || (jr.contracts as { entityProviderAddress?: unknown }).entityProviderAddress
  );
  return {
    ...jr,
    contracts: {
      ...jr.contracts,
      ...(depository ? { depository } : {}),
      ...(entityProvider ? { entityProvider } : {}),
    },
  };
};

const normalizeJReplicaMap = (raw: unknown): Map<string, JReplica> => {
  if (raw instanceof Map) return raw as Map<string, JReplica>;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return new Map();
    if (isEntryArray(raw)) {
      const map = new Map(raw as Array<[string, JReplica]>);
      for (const [name, jr] of map.entries()) {
        map.set(name, normalizeJReplica(jr));
      }
      return map;
    }
    const first = raw[0] as any;
    if (first && typeof first === 'object' && typeof first.name === 'string') {
      return new Map((raw as JReplica[]).map(jr => [jr.name, normalizeJReplica(jr)]));
    }
  }
  if (raw && typeof raw === 'object') {
    const map = new Map(Object.entries(raw as Record<string, JReplica>));
    for (const [name, jr] of map.entries()) {
      map.set(name, normalizeJReplica(jr));
    }
    return map;
  }
  return new Map();
};

const normalizeSnapshotInPlace = (snapshot: any): void => {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (snapshot.eReplicas) {
    snapshot.eReplicas = normalizeReplicaMap(snapshot.eReplicas);
  }
  if (snapshot.jReplicas) {
    const jMap = normalizeJReplicaMap(snapshot.jReplicas);
    snapshot.jReplicas = Array.from(jMap.values()).map(jr => ({
      ...jr,
      stateRoot: jr.stateRoot ? new Uint8Array(jr.stateRoot as any) : jr.stateRoot,
    }));
  }
};

export const createEmptyEnv = (seed?: Uint8Array | string | null): Env => {
  const normalizedSeed = Array.isArray(seed) ? new Uint8Array(seed) : seed;
  const seedText = normalizedSeed !== undefined && normalizedSeed !== null
    ? (typeof normalizedSeed === 'string' ? normalizedSeed : new TextDecoder().decode(normalizedSeed))
    : '';
  const derivedRuntimeId = seedText ? deriveRuntimeIdFromSeed(seedText) : null;
  const resolvedRuntimeId = derivedRuntimeId ? derivedRuntimeId.toLowerCase() : null;
  const resolvedDbNamespace = resolvedRuntimeId ? normalizeDbNamespace(resolvedRuntimeId) : undefined;

  const env: Env = {
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
    gossip: createGossipLayer(),
    frameLogs: [],
    networkInbox: [],
    pendingNetworkOutputs: [],
    // Event emitters will be attached below
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    emit: () => {},
    // BrowserVM will be lazily initialized on first use (see evm.ts)
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

  return env;
};

const buildRuntimeHistorySnapshot = (env: Env, title?: string): any => {
  return {
    height: env.height,
    frame: env.height,
    timestamp: env.timestamp,
    ...(env.runtimeSeed !== undefined && env.runtimeSeed !== null ? { runtimeSeed: env.runtimeSeed } : {}),
    ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
    eReplicas: new Map(env.eReplicas),
    jReplicas: env.jReplicas
      ? Array.from(env.jReplicas.values()).map((jr) => ({
          ...jr,
          mempool: [...jr.mempool],
          stateRoot: new Uint8Array(jr.stateRoot),
        }))
      : [],
    runtimeInput: env.runtimeInput,
    runtimeOutputs: env.pendingOutputs || [],
    frameLogs: env.frameLogs || [],
    title: title ?? `Frame ${env.height}`,
  };
};

// === CONSENSUS PROCESSING ===
// ONE TICK = ONE ITERATION. No cascade. E→E communication always requires new tick.

export const process = async (
  env: Env,
  inputs?: RoutedEntityInput[],
  runtimeDelay = 0
) => {
  const processState = ensureRuntimeState(env);
  while (processState.processingPromise) {
    await processState.processingPromise;
  }
  let releaseProcessLock: (() => void) | null = null;
  processState.processingPromise = new Promise<void>((resolve) => {
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
      enqueueRuntimeInputs(env, inputs);
    }
    if (env.pendingOutputs && env.pendingOutputs.length > 0) {
      enqueueRuntimeInputs(env, env.pendingOutputs);
      env.pendingOutputs = [];
    }
    if (env.networkInbox && env.networkInbox.length > 0) {
      enqueueRuntimeInputs(env, env.networkInbox);
      env.networkInbox = [];
    }

    if (!hasRuntimeWork(env)) return env;

    const now = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
    if (!isRuntimeFrameReady(env, now, runtimeDelay)) {
    
      return env;
    }

    const state = ensureRuntimeState(env);
    const quietRuntimeLogs = env.quietRuntimeLogs === true;
    getBrowserVMInstance(env)?.setQuietLogs?.(quietRuntimeLogs);

    if (env.scenarioMode) {
      env.timestamp = (env.timestamp ?? 0) + 100;
    } else {
      env.timestamp = getWallClockMs();
    }
    getBrowserVMInstance(env)?.setBlockTimestamp?.(env.timestamp);

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

    runtimeInput.entityInputs.forEach(o => {
      try {
        validateEntityInput(o);
      } catch (error) {
        logError("RUNTIME_TICK", `🚨 CRITICAL: Invalid EntityInput!`, {
          error: (error as Error).message,
          entityId: o.entityId.slice(0, 10),
          signerId: o.signerId,
        });
        throw error;
      }
    });

    const hasRuntimeInput =
      runtimeInput.runtimeTxs.length > 0 ||
      runtimeInput.entityInputs.length > 0 ||
      (runtimeInput.jInputs?.length ?? 0) > 0;
    (env as Env & { __lastProcessedRuntimeInput?: RuntimeInput }).__lastProcessedRuntimeInput = undefined;

    let entityOutbox: RoutedEntityInput[] = [];
    let jOutbox: JInput[] = [];
    const changedEntityIds = new Set<string>();
    const shouldAnnounceEntityProfile = (input: RoutedEntityInput): boolean => {
      if (!input?.entityTxs?.length) return false;
      return input.entityTxs.some((tx) =>
        tx.type === 'openAccount' ||
        tx.type === 'closeAccount' ||
        tx.type === 'governance_profile_update' ||
        tx.type === 'governanceUpdateProfile' ||
        tx.type === 'updateProfile'
      );
    };
    if (hasRuntimeInput) {
      if (!quietRuntimeLogs) {
        console.log(`📥 TICK: Processing ${runtimeInput.entityInputs.length} inputs for [${runtimeInput.entityInputs.map(o => o.entityId.slice(-4)).join(',')}]`);
        if (runtimeInput.runtimeTxs.length > 0) {
          console.log(`📥 TICK: Processing ${runtimeInput.runtimeTxs.length} queued runtimeTxs`);
        }
      }
      try {
        (env as Record<PropertyKey, unknown>)[ENV_APPLY_ALLOWED_KEY] = true;
        const result = await applyRuntimeInput(env, runtimeInput);
        console.log(`🔍 PROCESS: applyRuntimeInput returned entityOutbox=${result.entityOutbox.length}, jOutbox=${result.jOutbox.length}`);
        entityOutbox = result.entityOutbox;
        jOutbox = result.jOutbox;
        (env as Env & { __lastProcessedRuntimeInput?: RuntimeInput }).__lastProcessedRuntimeInput = result.appliedRuntimeInput;
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
      } catch (error) {
        // Restore runtime mempool on failure (WAL safety)
        mempool.runtimeTxs = [...runtimeInput.runtimeTxs, ...mempool.runtimeTxs];
        mempool.entityInputs = [...runtimeInput.entityInputs, ...mempool.entityInputs];
        if (runtimeInput.jInputs) {
          mempool.jInputs = [...runtimeInput.jInputs, ...(mempool.jInputs ?? [])];
        }
        if (mempool.queuedAt === undefined) {
          mempool.queuedAt = mempoolQueuedAt ?? (env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs());
        }
        throw error;
      } finally {
        (env as Record<PropertyKey, unknown>)[ENV_APPLY_ALLOWED_KEY] = false;
      }
    }

    // Retry deferred network outputs only when their retry window is due.
    const pendingBeforePlan = env.pendingNetworkOutputs ?? [];
    const { ready: readyPendingOutputs, waiting: waitingPendingOutputs } =
      splitPendingOutputsByRetryWindow(env, pendingBeforePlan);
    const outputsToPlan = readyPendingOutputs.length > 0
      ? [...readyPendingOutputs, ...entityOutbox]
      : entityOutbox;
    const { localOutputs, remoteOutputs, deferredOutputs } = planEntityOutputs(env, outputsToPlan);
    env.pendingNetworkOutputs = [];
    if (localOutputs.length > 0) {
      enqueueRuntimeInputs(env, localOutputs);
      if (!quietRuntimeLogs) {
        console.log(`📤 TICK: ${localOutputs.length} local outputs queued for next tick → [${localOutputs.map(o => o.entityId.slice(-4)).join(',')}]`);
      }
    }
    // BrowserVM trie is NOT serialized per-frame — it's J-layer state.
    // Only serialized on shutdown/page-unload for reload recovery.

    const frameAdvanced = env.height !== frameHeightBeforeTick;
    if (frameAdvanced) {
      const snapshot: any = buildRuntimeHistorySnapshot(env, `Frame ${env.height}`);

      if (env.extra) {
        const { subtitle, description } = env.extra;
        if (subtitle) {
          snapshot.subtitle = subtitle;
          snapshot.title = subtitle.title || snapshot.title;
        }
        if (description) snapshot.description = description;
      }

      if (!env.history) env.history = [];
      env.history.push(snapshot);

      if (!quietRuntimeLogs) {
        console.log(`📸 Snapshot: ${snapshot.title} (${env.history.length} total)`);
      }
    }
    env.extra = undefined;

    // === COMMIT POINT: persist finalized R-frame ===
    console.log(`💾 [SAVE] Persisting R-frame ${env.height} to LevelDB...`);
    // Persist only when a new runtime frame was actually applied.
    // Side-effect-only ticks (e.g. deferred network retries) must never
    // overwrite WAL entries for the current height.
    if (frameAdvanced) {
      await saveEnvToDB(env);
      (env as Env & { __lastProcessedRuntimeInput?: RuntimeInput }).__lastProcessedRuntimeInput = undefined;
    }
    console.log(`💾 [SAVE] R-frame ${env.height} persisted`);

    // === SIDE EFFECTS (safe to fail — bilateral consensus retries) ===

    // 1. Broadcast entity outputs via P2P (fire-and-forget)
    if (remoteOutputs.length > 0) {
      console.log(`📡 [SIDE-EFFECT] Dispatching ${remoteOutputs.length} remote entity outputs via P2P`);
    }
    const dispatchDeferred = dispatchEntityOutputs(env, remoteOutputs);

    const allDeferred = [...deferredOutputs, ...dispatchDeferred];
    env.pendingNetworkOutputs = rescheduleDeferredOutputs(
      env,
      readyPendingOutputs,
      allDeferred,
      waitingPendingOutputs,
    );

    // 1b. Re-announce gossip profiles after account state changes (new accounts, capacity shifts)
    // Broadcast changed local entities so relay routing metadata stays fresh.
    const p2p = getP2P(env);
    if (p2p) {
      const localEntityIds = new Set<string>();
      for (const replicaKey of env.eReplicas.keys()) {
        try {
          const signerId = extractSignerId(replicaKey);
          if (!signerId || !getCachedSignerPrivateKey(signerId)) continue;
          localEntityIds.add(extractEntityId(replicaKey).toLowerCase());
        } catch {
          // ignore malformed key
        }
      }
      const changedLocalEntityIds = [...changedEntityIds].filter(entityId => localEntityIds.has(entityId));
      if (changedLocalEntityIds.length > 0) {
        p2p.announceProfilesForEntities(changedLocalEntityIds, 'major-entity-change');
      }
    }

    // 2. Execute J-batches via JAdapter.submitTx (events arrive next frame via j-watcher)
    if (jOutbox.length > 0) {
      const totalJTxs = jOutbox.reduce((n, ji) => n + ji.jTxs.length, 0);
      console.log(`⚡ [SIDE-EFFECT] Submitting ${totalJTxs} J-txs via JAdapter (${jOutbox.length} JInputs)`);

      for (const jInput of jOutbox) {
        const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
        if (!jReplica) {
          console.error(`❌ [J-SUBMIT] Jurisdiction "${jInput.jurisdictionName}" not found — skipping`);
          continue;
        }

        const jAdapter = jReplica.jadapter;
        if (!jAdapter) {
          console.error(`❌ [J-SUBMIT] No JAdapter for jurisdiction "${jInput.jurisdictionName}" — skipping`);
          continue;
        }

        for (const jTx of jInput.jTxs) {
          console.log(`📤 [J-SUBMIT] ${jTx.type} from ${jTx.entityId.slice(-4)} → ${jInput.jurisdictionName}`);
          try {
            const result = await jAdapter.submitTx(jTx, {
              env,
              signerId: jTx.data?.signerId,
              timestamp: jTx.timestamp ?? env.timestamp,
            });

            if (result.success) {
              console.log(`✅ [J-SUBMIT] ${jTx.type} from ${jTx.entityId.slice(-4)}: ok (events=${result.events?.length ?? 0}, txHash=${result.txHash ?? 'n/a'})`);
            } else {
              console.error(`❌ [J-SUBMIT] ${jTx.type} from ${jTx.entityId.slice(-4)} FAILED: ${result.error}`);
              if (env.scenarioMode) {
                throw new Error(`J-SUBMIT FAILED: ${result.error || 'unknown'}`);
              }
            }
          } catch (error) {
            console.error(`❌ [J-SUBMIT] submitTx threw for ${jTx.entityId.slice(-4)}:`, error);
            if (env.scenarioMode) throw error;
          }
        }

        // Update jReplica metadata
        jReplica.lastBlockTimestamp = env.timestamp;
        jReplica.blockNumber = jReplica.blockNumber + 1n;
        console.log(`📊 [J-SUBMIT] ${jReplica.name} block #${jReplica.blockNumber}`);
      }
    }

    state.lastFrameAt = env.timestamp;

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
    releaseProcessLock?.();
  }
};

// === LEVELDB PERSISTENCE ===
export const saveEnvToDB = async (env: Env): Promise<void> => {
  if ((env as Record<PropertyKey, unknown>)[ENV_REPLAY_MODE_KEY] === true) {
    throw new Error('REPLAY_INVARIANT_FAILED: saveEnvToDB called during replay');
  }
  try {
    const dbReady = await tryOpenDb(env);
    if (!dbReady) return;
    const dbNamespace = resolveDbNamespace({ env });
    const db = getRuntimeDb(env);

    // Persist compact per-frame runtime input for replay from checkpoint.
    const currentFrameInput = (env as Env & { __lastProcessedRuntimeInput?: RuntimeInput }).__lastProcessedRuntimeInput;
    const frameJournal = serializeTaggedJson({
      height: env.height,
      timestamp: env.timestamp,
      // Always persist a frame record so replay has a contiguous frame timeline.
      runtimeInput: currentFrameInput ?? { runtimeTxs: [], entityInputs: [] },
      // Replay can deterministically require routing/encryption metadata
      // (e.g. HTLC onion key lookup), so persist gossip snapshot per frame.
      persistedGossipProfiles:
        typeof env.gossip?.getProfiles === 'function'
          ? env.gossip.getProfiles()
          : [],
    });
    const ops: Array<{ key: Buffer; value: Buffer }> = [
      { key: makeDbKey(dbNamespace, 'persistence_schema_version'), value: Buffer.from(String(PERSISTENCE_SCHEMA_VERSION)) },
      { key: makeDbKey(dbNamespace, `frame_input:${env.height}`), value: Buffer.from(frameJournal) },
    ];

    const persistedGossipProfiles =
      typeof env.gossip?.getProfiles === 'function'
        ? env.gossip.getProfiles()
        : [];
    const snapshotPayload = {
      ...env,
      persistedGossipProfiles,
    };
    const snapshot = serializeTaggedJson(snapshotPayload, new Set([
      'history',
      'browserVM',
      'gossip',
      'log',
      'info',
      'warn',
      'error',
      'emit',
    ]));
    // Persist a durable checkpoint snapshot every N runtime frames.
    // Restore is always: checkpoint snapshot + contiguous WAL replay on top.
    const CHECKPOINT_INTERVAL = ensureRuntimeConfig(env).snapshotIntervalFrames ?? 100;
    const shouldCheckpoint =
      env.height <= 1 || (env.height % CHECKPOINT_INTERVAL === 0);
    if (shouldCheckpoint) {
      ops.push(
        { key: makeDbKey(dbNamespace, `snapshot:${env.height}`), value: Buffer.from(snapshot) },
        { key: makeDbKey(dbNamespace, 'latest_checkpoint_height'), value: Buffer.from(String(env.height)) },
      );
    }

    // Write pointer last so latest_height is only advanced after all frame data is durable.
    ops.push({ key: makeDbKey(dbNamespace, 'latest_height'), value: Buffer.from(String(env.height)) });

    // NOTE: Browser Level polyfill has shown flaky behavior with db.batch(ops[]) on binary keys.
    // Use chained batch API first, then fail over to sequential puts if needed.
    let wrote = false;
    try {
      const batch = db.batch();
      for (const op of ops) {
        batch.put(op.key, op.value);
      }
      await batch.write();
      wrote = true;
    } catch (batchError) {
      console.warn('⚠️ db.batch().write() failed, falling back to sequential put:', batchError);
    }
    if (!wrote) {
      for (const op of ops) {
        await db.put(op.key, op.value);
      }
    }

    // Fail-fast: if we just persisted frame N, frame_input:N and latest_height must be readable now.
    try {
      await db.get(makeDbKey(dbNamespace, `frame_input:${env.height}`));
      const latestHeightBuffer = await db.get(makeDbKey(dbNamespace, 'latest_height'));
      const latestHeight = Number.parseInt(latestHeightBuffer.toString(), 10);
      if (!Number.isFinite(latestHeight) || latestHeight !== env.height) {
        throw new Error(`latest_height mismatch: expected=${env.height} actual=${String(latestHeightBuffer.toString())}`);
      }
    } catch (verifyError) {
      throw new Error(`PERSISTENCE_FATAL: write verification failed at frame ${env.height}: ${String(verifyError)}`);
    }
  } catch (err) {
    console.error('❌ Failed to save to LevelDB:', err);
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new Error(`PERSISTENCE_FATAL: ${reason}`);
  }
};

export const loadEnvFromDB = async (runtimeId?: string | null, runtimeSeed?: string | null): Promise<Env | null> => {
  const isDbNotFound = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const code = String((error as { code?: unknown }).code ?? '');
    const name = String((error as { name?: unknown }).name ?? '');
    return code === 'LEVEL_NOT_FOUND' || name === 'NotFoundError';
  };
  try {
    const tempEnv = createEmptyEnv(runtimeSeed ?? null);
    if (runtimeId) {
      tempEnv.runtimeId = runtimeId;
      tempEnv.dbNamespace = normalizeDbNamespace(runtimeId);
    }
    const dbReady = await tryOpenDb(tempEnv);
    if (!dbReady) return null;

    const dbNamespace = resolveDbNamespace({ runtimeId, runtimeSeed, env: tempEnv });
    const db = getRuntimeDb(tempEnv);
    let latestHeightBuffer: Buffer;
    try {
      const schemaVersionBuffer = await db.get(makeDbKey(dbNamespace, 'persistence_schema_version'));
      const schemaVersion = Number.parseInt(schemaVersionBuffer.toString(), 10);
      if (!Number.isFinite(schemaVersion) || schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
        throw new Error(
          `REPLAY_INVARIANT_FAILED: frame=n/a checkpoint=n/a latest=n/a restored=n/a reason=Unsupported persistence schema (${schemaVersion})`
        );
      }
      latestHeightBuffer = await db.get(makeDbKey(dbNamespace, 'latest_height'));
    } catch (error) {
      if (isDbNotFound(error)) {
        return null;
      }
      throw error;
    }
    const latestHeight = parseInt(latestHeightBuffer.toString());
    let checkpointHeight = 0;
    let checkpointBuffer: Buffer;
    try {
      const checkpointHeightBuffer = await db.get(makeDbKey(dbNamespace, 'latest_checkpoint_height'));
      checkpointHeight = parseInt(checkpointHeightBuffer.toString());
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(
        `REPLAY_INVARIANT_FAILED: frame=n/a checkpoint=n/a latest=${latestHeight} restored=n/a reason=Missing latest_checkpoint_height pointer (${message})`
      );
    }
    if (!Number.isFinite(checkpointHeight) || checkpointHeight < 0 || checkpointHeight > latestHeight) {
      throw new Error(
        `REPLAY_INVARIANT_FAILED: frame=n/a checkpoint=${String(checkpointHeight)} latest=${latestHeight} restored=n/a reason=Invalid checkpoint pointer`
      );
    }
    if (latestHeight > 0 && checkpointHeight < 1) {
      throw new Error(
        `REPLAY_INVARIANT_FAILED: frame=n/a checkpoint=${String(checkpointHeight)} latest=${latestHeight} restored=n/a reason=Missing durable checkpoint`
      );
    }
    console.log(`[loadEnvFromDB] namespace=${dbNamespace} latest=${latestHeight} checkpoint=${checkpointHeight}`);
    try {
      checkpointBuffer = await db.get(makeDbKey(dbNamespace, `snapshot:${checkpointHeight}`));
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(
        `REPLAY_INVARIANT_FAILED: frame=${checkpointHeight} checkpoint=${checkpointHeight} latest=${latestHeight} restored=n/a reason=Missing checkpoint snapshot (${message})`
      );
    }

    // Time-machine requirement: always rebuild full frame history on reload.
    // Use genesis checkpoint (frame 1) as replay base when runtime has frames.
    let selectedSnapshotHeight = checkpointHeight;
    let selectedSnapshotLabel = `checkpoint:${checkpointHeight}`;
    let snapshotBufferToUse = checkpointBuffer;
    if (latestHeight > 0) {
      try {
        const genesisSnapshotBuffer = await db.get(makeDbKey(dbNamespace, 'snapshot:1'));
        selectedSnapshotHeight = 1;
        selectedSnapshotLabel = 'checkpoint:1';
        snapshotBufferToUse = genesisSnapshotBuffer;
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw new Error(
          `REPLAY_INVARIANT_FAILED: frame=1 checkpoint=${checkpointHeight} latest=${latestHeight} restored=n/a reason=Missing genesis checkpoint snapshot (${message})`
        );
      }
    }
    console.log(
      `[loadEnvFromDB] snapshot selection checkpoint=${checkpointHeight} selected=${selectedSnapshotHeight} source=${selectedSnapshotLabel}`
    );

    const data = deserializeTaggedJson<any>(snapshotBufferToUse.toString());

      // Hydrate Maps/BigInts
      const runtimeSeedRaw = Array.isArray(data.runtimeSeed)
        ? new TextDecoder().decode(new Uint8Array(data.runtimeSeed))
        : data.runtimeSeed;
      const env = createEmptyEnv(runtimeSeedRaw ?? null);
      env.height = Number(data.height || 0);
      env.timestamp = Number(data.timestamp || 0);
      env.dbNamespace = data.dbNamespace ?? dbNamespace;
      env.activeJurisdiction = typeof data.activeJurisdiction === 'string' ? data.activeJurisdiction : undefined;
      if (data.browserVMState) {
        env.browserVMState = data.browserVMState;
      }
      if (data.runtimeId) {
        env.runtimeId = data.runtimeId;
      } else if (runtimeSeedRaw !== undefined && runtimeSeedRaw !== null) {
        try {
          env.runtimeId = deriveSignerAddressSync(runtimeSeedRaw, '1');
        } catch (error) {
          console.warn('⚠️ Failed to derive runtimeId from DB snapshot:', error);
        }
      }
      // Support both old (replicas) and new (eReplicas) format
      env.eReplicas = normalizeReplicaMap(data.eReplicas || data.replicas || []);
      env.jReplicas = normalizeJReplicaMap(data.jReplicas || []);
      env.history = [];
      if (selectedSnapshotHeight > 0) {
        env.history.push(buildRuntimeHistorySnapshot(env, `Frame ${selectedSnapshotHeight}`));
      }
      if (env.jReplicas.size > 0) {
        for (const [name, jr] of env.jReplicas.entries()) {
          if ((jr as any).stateRoot) {
            env.jReplicas.set(name, {
              ...jr,
              stateRoot: new Uint8Array((jr as any).stateRoot),
            });
          }
        }
      }
      const snapshotProfiles = Array.isArray(data.persistedGossipProfiles)
        ? data.persistedGossipProfiles
        : [];
      if (snapshotProfiles.length > 0) {
        if (typeof env.gossip?.setProfiles === 'function') {
          env.gossip.setProfiles(snapshotProfiles);
        } else if (typeof env.gossip?.announce === 'function') {
          for (const profile of snapshotProfiles) env.gossip.announce(profile);
        }
      }
    const envState = ensureRuntimeState(env);
    const tempState = ensureRuntimeState(tempEnv);
    envState.db = tempState.db;
    envState.dbOpenPromise = tempState.dbOpenPromise;

    // Replay frame journal from checkpoint+1 to latest.
    // STRICT MODE: any missing/corrupt frame is fatal (deterministic replay invariant).
    if (latestHeight > checkpointHeight) {
      const missingFrames: number[] = [];
      for (let h = checkpointHeight + 1; h <= latestHeight; h++) {
        try {
          await db.get(makeDbKey(dbNamespace, `frame_input:${h}`));
        } catch (error) {
          if (isDbNotFound(error)) {
            missingFrames.push(h);
            continue;
          }
          throw error;
        }
      }
      if (missingFrames.length > 0) {
        const sample = missingFrames.slice(0, 8).join(',');
        throw new Error(
          `REPLAY_INVARIANT_FAILED: frame=${missingFrames[0]} checkpoint=${checkpointHeight} latest=${latestHeight} restored=${checkpointHeight} reason=Missing WAL frames (${sample}${missingFrames.length > 8 ? ',…' : ''})`
        );
      }
    }
    let lastGoodHeight = selectedSnapshotHeight;
    const runtimeEnv = env as Record<PropertyKey, unknown>;
    const originalLog = env.log;
    const originalInfo = env.info;
    const originalWarn = env.warn;
    const originalError = env.error;
    const originalEmit = env.emit;
    const replayNoop = () => {};
    const assertReplayNoSideEffects = (frame: number): void => {
      const pendingOutputs = env.pendingOutputs?.length ?? 0;
      const pendingNetworkOutputs = env.pendingNetworkOutputs?.length ?? 0;
      const networkInbox = env.networkInbox?.length ?? 0;
      if (pendingOutputs > 0 || pendingNetworkOutputs > 0 || networkInbox > 0) {
        throw new Error(
          `REPLAY_SIDE_EFFECT_DETECTED: frame=${frame} pendingOutputs=${pendingOutputs} pendingNetworkOutputs=${pendingNetworkOutputs} networkInbox=${networkInbox}`
        );
      }
    };

    runtimeEnv[ENV_REPLAY_MODE_KEY] = true;
    env.log = replayNoop;
    env.info = replayNoop;
    env.warn = replayNoop;
    env.error = replayNoop;
    env.emit = replayNoop;
    try {
      for (let h = selectedSnapshotHeight + 1; h <= latestHeight; h++) {
        try {
        const frameBuffer = await db.get(makeDbKey(dbNamespace, `frame_input:${h}`));
        const frame = deserializeTaggedJson<{
          height: number;
          timestamp: number;
          runtimeInput: RuntimeInput;
          persistedGossipProfiles?: unknown[];
        }>(
          frameBuffer.toString()
        );
        if (Array.isArray(frame?.persistedGossipProfiles) && frame.persistedGossipProfiles.length > 0) {
          if (typeof env.gossip?.setProfiles === 'function') {
            env.gossip.setProfiles(frame.persistedGossipProfiles);
          } else if (typeof env.gossip?.announce === 'function') {
            for (const profile of frame.persistedGossipProfiles) env.gossip.announce(profile);
          }
        }
        const replayRuntimeTxs = frame?.runtimeInput?.runtimeTxs?.length ?? 0;
        const replayEntityInputs = frame?.runtimeInput?.entityInputs?.length ?? 0;
        const replayJInputs = frame?.runtimeInput?.jInputs?.length ?? 0;
        console.log(
          `[loadEnvFromDB] replay frame=${h} runtimeTxs=${replayRuntimeTxs} entityInputs=${replayEntityInputs} jInputs=${replayJInputs}`
        );
        if (Number(frame?.height) !== h) {
          throw new Error(`Frame height mismatch: key=${h} payload=${String(frame?.height)}`);
        }
        if (!frame?.runtimeInput) {
          throw new Error(`Missing runtimeInput at frame ${h}`);
        }
        for (const entityInput of frame.runtimeInput.entityInputs ?? []) {
          for (const tx of entityInput.entityTxs ?? []) {
            if (tx.type !== 'accountInput') continue;
            const data = tx.data as Record<string, unknown> | undefined;
            const inputHeight = Number(data?.height ?? 0);
            const newFrameHeight = Number((data?.newAccountFrame as { height?: number } | undefined)?.height ?? 0);
            const hasPrev = Boolean(data?.prevHanko);
            const fromEntityId = typeof data?.fromEntityId === 'string' ? data.fromEntityId : '';
            console.log(
              `[loadEnvFromDB] frame=${h} accountInput from=${fromEntityId.slice(-8)} ` +
              `height=${inputHeight} hasPrev=${hasPrev} newFrame=${newFrameHeight || 'none'}`
            );
          }
        }
        // Keep replay semantics identical to process():
        // applyRuntimeInput increments env.height once per applied frame.
        // Therefore env.height must be h-1 before applying frame h.
        env.height = h - 1;
        env.timestamp = Number(frame.timestamp ?? env.timestamp);
          runtimeEnv[ENV_APPLY_ALLOWED_KEY] = true;
          await applyRuntimeInput(env, frame.runtimeInput);
          runtimeEnv[ENV_APPLY_ALLOWED_KEY] = false;
          assertReplayNoSideEffects(h);
          // Replay diagnostics: show bilateral account heights after each frame
          // for all accountInput txs seen in this frame.
          for (const entityInput of frame.runtimeInput.entityInputs ?? []) {
            const entityIdNorm = String(entityInput.entityId || '').toLowerCase();
            for (const tx of entityInput.entityTxs ?? []) {
              if (tx.type !== 'accountInput') continue;
              const data = tx.data as Record<string, unknown> | undefined;
              const fromEntityId = typeof data?.fromEntityId === 'string' ? data.fromEntityId : '';
              if (!fromEntityId) continue;
              for (const replica of env.eReplicas.values()) {
                if (String(replica?.entityId || '').toLowerCase() !== entityIdNorm) continue;
                const accountMachine = replica?.state?.accounts?.get?.(fromEntityId);
                console.log(
                  `[loadEnvFromDB] frame=${h} POST-APPLY entity=${String(entityInput.entityId).slice(-8)} ` +
                  `from=${fromEntityId.slice(-8)} current=${Number(accountMachine?.currentHeight ?? 0)} ` +
                  `pending=${Number(accountMachine?.pendingFrame?.height ?? 0)} mempool=${Number(accountMachine?.mempool?.length ?? 0)}`
                );
              }
            }
          }
        if (env.height !== h) {
          throw new Error(`Replay height mismatch after apply: expected=${h} actual=${env.height}`);
        }
        // Fail-fast replay invariant: if frame carries accountInput(newAccountFrame),
        // replay MUST materialize that account frame in restored state.
        for (const entityInput of frame.runtimeInput.entityInputs ?? []) {
          for (const tx of entityInput.entityTxs ?? []) {
            if (tx.type !== 'accountInput') continue;
            const data = tx.data as Record<string, unknown> | undefined;
            const fromEntityId = typeof data?.fromEntityId === 'string' ? data.fromEntityId : '';
            const newAccountFrame = data?.newAccountFrame as Record<string, unknown> | undefined;
            const hasPrevHanko = Boolean(data?.prevHanko);
            const inputHeightRaw = data?.height;
            const inputHeight = Number(inputHeightRaw ?? 0);
            if (hasPrevHanko && !newAccountFrame && fromEntityId && Number.isFinite(inputHeight) && inputHeight > 0) {
              const entityIdNorm = String(entityInput.entityId || '').toLowerCase();
              for (const replica of env.eReplicas.values()) {
                if (String(replica?.entityId || '').toLowerCase() !== entityIdNorm) continue;
                const accountMachine = replica?.state?.accounts?.get?.(fromEntityId);
                const currentHeight = Number(accountMachine?.currentHeight ?? 0);
                const pendingHeight = Number(accountMachine?.pendingFrame?.height ?? 0);
                console.log(
                  `[loadEnvFromDB] frame=${h} ACK-check entity=${String(entityInput.entityId).slice(-8)} ` +
                  `from=${fromEntityId.slice(-8)} current=${currentHeight} pending=${pendingHeight} inputHeight=${inputHeight}`
                );
                if (currentHeight < inputHeight || pendingHeight === inputHeight) {
                  throw new Error(
                    `REPLAY_ACK_NOT_APPLIED: frame=${h} ackHeight=${inputHeight} currentHeight=${currentHeight} pendingHeight=${pendingHeight} ` +
                    `entity=${String(entityInput.entityId).slice(0, 12)} from=${fromEntityId.slice(0, 12)}`
                  );
                }
              }
            }
            const expectedHeight = Number(newAccountFrame?.height ?? 0);
            if (!fromEntityId || !Number.isFinite(expectedHeight) || expectedHeight <= 0) continue;
            const entityIdNorm = String(entityInput.entityId || '').toLowerCase();
            let applied = false;
            for (const replica of env.eReplicas.values()) {
              if (String(replica?.entityId || '').toLowerCase() !== entityIdNorm) continue;
              const accountMachine = replica?.state?.accounts?.get?.(fromEntityId);
              const currentHeight = Number(accountMachine?.currentHeight ?? 0);
              const pendingHeight = Number(accountMachine?.pendingFrame?.height ?? 0);
              console.log(
                `[loadEnvFromDB] frame=${h} NEWFRAME-check entity=${String(entityInput.entityId).slice(-8)} ` +
                `from=${fromEntityId.slice(-8)} current=${currentHeight} pending=${pendingHeight} expected=${expectedHeight}`
              );
              if (currentHeight >= expectedHeight) {
                applied = true;
                break;
              }
            }
            if (!applied) {
              const replayDebug = Array.from(env.eReplicas.values())
                .filter((replica) => String(replica?.entityId || '').toLowerCase() === entityIdNorm)
                .map((replica) => {
                  const am = replica?.state?.accounts?.get?.(fromEntityId);
                  return {
                    replicaKey: `${String(replica.entityId).slice(0, 10)}...:${String(replica.signerId).slice(0, 10)}...`,
                    currentHeight: Number(am?.currentHeight ?? 0),
                    pendingFrame: Number(am?.pendingFrame?.height ?? 0),
                    mempoolSize: Number(am?.mempool?.length ?? 0),
                    frameHistorySize: Number(am?.frameHistory?.length ?? 0),
                  };
                });
              throw new Error(
                `REPLAY_ACCOUNT_FRAME_NOT_APPLIED: frame=${h} expected=${expectedHeight} actual=${JSON.stringify(replayDebug)}`
              );
            }
          }
        }
        env.history.push(buildRuntimeHistorySnapshot(env, `Frame ${h}`));
        lastGoodHeight = h;
        } catch (error) {
          runtimeEnv[ENV_APPLY_ALLOWED_KEY] = false;
          const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          throw new Error(
            `REPLAY_INVARIANT_FAILED: frame=${h} checkpoint=${checkpointHeight} latest=${latestHeight} restored=${lastGoodHeight} reason=${message}`
          );
        }
      }
    } finally {
      runtimeEnv[ENV_APPLY_ALLOWED_KEY] = false;
      runtimeEnv[ENV_REPLAY_MODE_KEY] = false;
      env.log = originalLog;
      env.info = originalInfo;
      env.warn = originalWarn;
      env.error = originalError;
      env.emit = originalEmit;
    }
    env.height = lastGoodHeight;
    if (lastGoodHeight !== latestHeight) {
      throw new Error(
        `REPLAY_INVARIANT_FAILED: replay completed at ${lastGoodHeight}, expected latest ${latestHeight}`
      );
    }
    console.log(
      `[loadEnvFromDB] replay complete latest=${latestHeight} restored=${lastGoodHeight} history=${env.history?.length ?? 0}`
    );

    const latestEnv = env;
    (latestEnv as any).__replayMeta = {
      namespace: dbNamespace,
      latestHeight,
      checkpointHeight,
      restoredHeight: lastGoodHeight,
      recoveredHistoryFrames: latestEnv.history?.length ?? 0,
    };
    if (latestEnv) {
      (latestEnv as any).__replayMeta.recoveredHistoryFrames = latestEnv.history?.length ?? 0;

      // Restore BrowserVM if state was persisted
      let restoredBrowserVM: any = null;
      if (latestEnv.browserVMState && isBrowser) {
        try {
          const { BrowserVMProvider } = await import('./jadapter');
          const browserVM = new BrowserVMProvider();
          await browserVM.init();
          await browserVM.restoreState(latestEnv.browserVMState);
          latestEnv.browserVM = browserVM;
          restoredBrowserVM = browserVM;
          setBrowserVMJurisdiction(latestEnv, browserVM.getDepositoryAddress(), browserVM);
          if (typeof window !== 'undefined') {
            (window as any).__xlnBrowserVM = browserVM;
          }
          console.log('✅ BrowserVM restored from loadEnvFromDB');
        } catch (error) {
          console.warn('⚠️ Failed to restore BrowserVM state (loadEnvFromDB):', error);
        }
      }

      // Derive JAdapters for all jReplicas (they are not serialized — runtime objects)
      if (latestEnv.jReplicas && latestEnv.jReplicas.size > 0) {
        const { createJAdapter } = await import('./jadapter');
        const { createBrowserVMAdapter } = await import('./jadapter/browservm');

        for (const [name, jReplica] of latestEnv.jReplicas.entries()) {
          if (jReplica.jadapter) continue; // Already has adapter (shouldn't happen on restore)

          try {
            const hasRpcs = jReplica.rpcs && jReplica.rpcs.length > 0 && jReplica.rpcs[0] !== '';
            const chainId = jReplica.chainId ?? 31337;

            if (!hasRpcs && restoredBrowserVM) {
              // BrowserVM mode: wrap restored VM in JAdapter
              const jadapter = await createJAdapter({
                mode: 'browservm',
                chainId,
                browserVMState: undefined, // VM already restored above
              });
              // Replace the inner browserVM with the already-restored one
              const inner = jadapter.getBrowserVM();
              if (inner && restoredBrowserVM) {
                // The VM was already initialized fresh in createJAdapter.
                // We need to use the restored VM instead. Re-create with it.
                const { BrowserVMEthersProvider } = await import('./jadapter/browservm-ethers-provider');
                const provider = new BrowserVMEthersProvider(restoredBrowserVM);
                const { ethers } = await import('ethers');
                const { DEFAULT_PRIVATE_KEY } = await import('./jadapter/helpers');
                const signer = new ethers.Wallet(DEFAULT_PRIVATE_KEY, provider);
                const adapter = await createBrowserVMAdapter(
                  { mode: 'browservm', chainId },
                  provider,
                  signer,
                  restoredBrowserVM,
                );
                jReplica.jadapter = adapter;
              } else {
                jReplica.jadapter = jadapter;
              }
            } else if (hasRpcs) {
              // RPC mode: connect using stored rpcs + addresses
              const jadapter = await createJAdapter({
                mode: 'rpc',
                chainId,
                rpcUrl: jReplica.rpcs![0],
                fromReplica: jReplica as any, // Pass addresses for connect-only mode
              });
              jReplica.jadapter = jadapter;
            }

            if (jReplica.jadapter) {
              jReplica.jadapter.startWatching(latestEnv);
              console.log(`✅ JAdapter derived for jReplica "${name}" (${hasRpcs ? 'rpc' : 'browservm'})`);
            }
          } catch (error) {
            console.warn(`⚠️ Failed to derive JAdapter for jReplica "${name}":`, error);
          }
        }
      }
    }

    return latestEnv;
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`❌ loadEnvFromDB failed: ${message}`);
    throw err;
  }
};

export const clearDB = async (env?: Env): Promise<void> => {
  if (!isBrowser) return;
  const targetEnv = env ?? createEmptyEnv(null);

  try {
    const dbReady = await tryOpenDb(targetEnv);
    if (!dbReady) return;

    const db = getRuntimeDb(targetEnv);
    await db.clear();
    console.log('✅ LevelDB cleared');
  } catch (err) {
    console.error('❌ Failed to clear LevelDB:', err);
  }
};

// === PREPOPULATE FUNCTION ===
// REMOVED: Legacy prepopulate functions replaced by scenarios namespace below

// Scenarios namespace for better organization
export const scenarios = {
  ahb: async (env: Env): Promise<Env> => {
    const { ahb } = await import('./scenarios/ahb');
    await ahb(env);
    return env;
  },
  lockAhb: async (env: Env): Promise<Env> => {
    const { lockAhb } = await import('./scenarios/lock-ahb');
    await lockAhb(env);
    return env;
  },
  swap: async (env: Env): Promise<Env> => {
    const { swap, swapWithOrderbook, multiPartyTrading } = await import('./scenarios/swap');
    // Run all 3 phases for complete swap demo (Alice, Hub, Bob, Carol, Dave)
    await swap(env);             // Phase 1: Alice + Hub basic bilateral swaps
    await swapWithOrderbook(env); // Phase 2: Add Bob, orderbook matching
    await multiPartyTrading(env); // Phase 3: Add Carol + Dave, multi-party
    return env;
  },
  swapMarket: async (env: Env): Promise<Env> => {
    const { swapMarket } = await import('./scenarios/swap-market');
    await swapMarket(env);
    return env;
  },
  rapidFire: async (env: Env): Promise<Env> => {
    const { rapidFire } = await import('./scenarios/rapid-fire');
    await rapidFire(env);
    return env;
  },
  grid: async (env: Env): Promise<Env> => {
    const { grid } = await import('./scenarios/grid');
    await grid(env);
    return env;
  },
  settle: async (env: Env): Promise<Env> => {
    const { runSettleScenario } = await import('./scenarios/settle');
    await runSettleScenario(env);
    return env;
  },
  fullMechanics: async (env: Env): Promise<Env> => {
    await prepopulateFullMechanicsImpl(env);
    return env;
  },
};

// Deprecated aliases (backwards compatibility - will be removed)
export const prepopulateAHB = scenarios.ahb;
export const prepopulateFullMechanics = scenarios.fullMechanics;

// === SCENARIO SYSTEM ===
export { parseScenario, mergeAndSortEvents } from './scenarios/parser.js';
export { executeScenario } from './scenarios/executor.js';
// NOTE: loadScenarioFromFile uses fs/promises - import directly from './scenarios/loader.js' in CLI only
export { SCENARIOS, getScenario, getScenariosByTag, type ScenarioMetadata } from './scenarios/index.js';

// === CRYPTOGRAPHIC SIGNATURES ===
export { deriveSignerKey, deriveSignerKeySync, registerSignerKey, registerSignerPublicKey, registerTestKeys, clearSignerKeys, signAccountFrame, verifyAccountSignature, getSignerPublicKey } from './account-crypto.js';

// === NAME RESOLUTION WRAPPERS (override imports) ===
const searchEntityNames = (query: string, limit?: number) => searchEntityNamesOriginal(db, query, limit);
const resolveEntityName = (entityId: string) => resolveEntityNameOriginal(db, entityId);
const getEntityDisplayInfoFromProfile = (entityId: string) => getEntityDisplayInfoFromProfileOriginal(db, entityId);

// Avatar functions are already imported and exported above

// JAdapter - Unified J-Machine interface (replaces old evms/ and jurisdiction/)
export { createJAdapter, BrowserVMProvider } from './jadapter';
export type { JAdapter, JAdapterConfig, JAdapterMode, JEvent } from './jadapter';

// Get active J-adapter from environment
export function getActiveJAdapter(env: Env): JAdapter | null {
  if (!env.activeJurisdiction) return null;
  const jReplica = env.jReplicas?.get(env.activeJurisdiction);
  return jReplica?.jadapter || null;
}

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
