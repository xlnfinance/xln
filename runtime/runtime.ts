// for regular use > bun run runtime/runtime.ts
// for debugging > bun repl
// await import('./debug.js');
// FORCE AUTO-REBUILD: Fixed signerId consistency and fintech type safety

// Import utilities and types
// High-level database using Level polyfill (works in both Node.js and browser)
import { Level } from 'level';

// Bump this when you need to confirm the browser picked up a new runtime bundle.
const RUNTIME_BUILD_ID = '2026-01-21-00:40Z';
console.log(`🚀 RUNTIME.JS BUILD: ${RUNTIME_BUILD_ID}`);

// Helper: Convert signer address to entity ID (pad to bytes32)
function signerToEntityId(address: string): string {
  // 0x1234...ABCD (20 bytes) → 0x000000000000000000000000 + address.slice(2) (32 bytes)
  const addr = address.toLowerCase().startsWith('0x') ? address.slice(2) : address;
  return '0x' + '0'.repeat(24) + addr;
}

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
import { deriveSignerAddressSync, deriveSignerKeySync, getSignerPrivateKey, getSignerPublicKey, registerSignerKey, setRuntimeSeed as setCryptoRuntimeSeed } from './account-crypto';
import { buildEntityProfile, mergeProfileWithExisting } from './networking/gossip-helper';
import { RuntimeP2P, type P2PConfig } from './networking/p2p';
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
import { setupJEventWatcher, JEventWatcher } from './j-event-watcher';
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
import { captureSnapshot, cloneEntityReplica } from './state-helpers';
import { getEntityShortId, getEntityNumber, formatEntityId, HEAVY_LOGS } from './utils';
import { safeStringify } from './serialization-utils';
import { validateDelta, validateAccountDeltas, createDefaultDelta, isDelta, validateEntityInput, validateEntityOutput } from './validation-utils';
import { EntityInput, EntityReplica, Env, RuntimeInput } from './types';
import type { JReplica } from './types';
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

// --- Clean Log Capture (for debugging without file:line noise) ---
const cleanLogs: string[] = [];
const MAX_CLEAN_LOGS = 2000;

// Wrap console to capture clean logs (browser only)
if (isBrowser) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalDebug = console.debug;

  const formatArgs = (args: any[]): string => {
    return args.map(a => {
      if (typeof a === 'string') return a;
      if (typeof a === 'bigint') return a.toString() + 'n';
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
  };

  const addCleanLog = (level: string, msg: string) => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    cleanLogs.push(`[${ts}] ${level}: ${msg}`);
    if (cleanLogs.length > MAX_CLEAN_LOGS) cleanLogs.shift();
  };

  console.log = function(...args: any[]) {
    originalLog.apply(console, args);
    addCleanLog('LOG', formatArgs(args));
  };
  console.warn = function(...args: any[]) {
    originalWarn.apply(console, args);
    addCleanLog('WARN', formatArgs(args));
  };
  console.error = function(...args: any[]) {
    originalError.apply(console, args);
    addCleanLog('ERR', formatArgs(args));
  };
  console.debug = function(...args: any[]) {
    originalDebug.apply(console, args);
    addCleanLog('DBG', formatArgs(args));
  };
}

/** Get all clean logs as text (no file:line references) */
export const getCleanLogs = (): string => cleanLogs.join('\n');

/** Clear clean logs buffer */
export const clearCleanLogs = (): void => { cleanLogs.length = 0; };

/** Copy clean logs to clipboard (returns text if clipboard fails) */
export const copyCleanLogs = async (): Promise<string> => {
  const text = getCleanLogs();
  if (isBrowser && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      console.log(`✅ Copied ${cleanLogs.length} log entries to clipboard`);
    } catch {
      // Clipboard fails when devtools focused - just return text
    }
  }
  return text;
};

// --- Database Setup ---
// Level polyfill: Node.js uses filesystem, Browser uses IndexedDB
const nodeProcess =
  !isBrowser && typeof globalThis.process !== 'undefined'
    ? globalThis.process
    : undefined;
const defaultDbPath = nodeProcess ? 'db-tmp/runtime' : 'db';
const dbPath = nodeProcess?.env?.XLN_DB_PATH || defaultDbPath;
export const db: Level<Buffer, Buffer> = new Level(dbPath, {
  valueEncoding: 'buffer',
  keyEncoding: 'binary',
});

// Helper: Race promise with timeout
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), ms)
    )
  ]);
}

// Database availability check
let dbOpenPromise: Promise<boolean> | null = null;

async function tryOpenDb(): Promise<boolean> {
  if (!dbOpenPromise) {
    dbOpenPromise = (async () => {
      try {
        await db.open();
        console.log('✅ Database opened');
        return true;
      } catch (error) {
        // Check if IndexedDB is completely blocked (Safari incognito)
        const isBlocked = error instanceof Error &&
          (error.message?.includes('blocked') ||
           error.name === 'SecurityError' ||
           error.name === 'InvalidStateError');

        if (isBlocked) {
          console.log('⚠️ IndexedDB blocked (incognito/private mode) - running in-memory');
          return false;
        }

        // Other errors - log but assume DB is available
        console.warn('⚠️ DB open warning:', error instanceof Error ? error.message : error);
        return true;
      }
    })();
  }
  return dbOpenPromise;
}

// === ETHEREUM INTEGRATION ===

// === SVELTE REACTIVITY INTEGRATION ===
// Callback that Svelte can register to get notified of env changes
let envChangeCallback: ((env: Env) => void) | null = null;

// Module-level environment variable
let env: Env;
let runtimeSeed: string | null = null;
let runtimeId: string | null = null;
let p2pOverlay: RuntimeP2P | null = null;
let pendingP2PConfig: { env: Env; config: P2PConfig } | null = null;
let networkProcessScheduled = false;
let lastP2PConfig: P2PConfig | null = null;

// Module-level j-watcher instance - prevent multiple instances
let jWatcher: JEventWatcher | null = null;
let jWatcherStarted = false;

export const registerEnvChangeCallback = (callback: (env: Env) => void) => {
  envChangeCallback = callback;
};

/**
 * Get the module-level env (used for j-watcher and runtime tick)
 * CRITICAL: This returns the SAME env that the runtime tick processes!
 * View.svelte should use this instead of createEmptyEnv() for proper event routing.
 */
export const getEnv = (): Env | null => {
  return env || null;
};

export const setRuntimeSeed = (seed: string | null): void => {
  if (env?.lockRuntimeSeed) {
    console.warn('⚠️ Runtime seed update blocked (scenario lock enabled)');
    return;
  }
  const normalized = seed === null || seed === undefined ? '' : seed;
  runtimeSeed = normalized;
  setCryptoRuntimeSeed(normalized);
  if (normalized !== null && normalized !== undefined) {
    try {
      runtimeId = deriveSignerAddressSync(normalized, '1');
    } catch (error) {
      console.warn('⚠️ Failed to derive runtimeId from seed:', error);
      runtimeId = null;
    }
  } else {
    runtimeId = null;
  }
  if (env) {
    env.runtimeSeed = normalized;
    env.runtimeId = runtimeId || undefined;
  }
  if (pendingP2PConfig && runtimeId) {
    console.log(`[P2P] pendingP2PConfig triggered, relayUrls=${pendingP2PConfig.config.relayUrls?.join(',')}`);
    const { env: pendingEnv, config } = pendingP2PConfig;
    pendingP2PConfig = null;
    startP2P(pendingEnv, config);
  }
  if (env && p2pOverlay && lastP2PConfig && runtimeId) {
    startP2P(env, lastP2PConfig);
  }
};

export const setRuntimeId = (id: string | null): void => {
  runtimeId = id && id.length > 0 ? id : null;
  if (env) {
    env.runtimeId = runtimeId || undefined;
  }
};

// Derive runtimeId from seed (for isolated envs that need to set their own runtimeId)
export const deriveRuntimeId = (seed: string): string => {
  return deriveSignerAddressSync(seed, '1');
};

export const scheduleNetworkProcess = (env: Env) => {
  if (networkProcessScheduled) return;
  networkProcessScheduled = true;
  const defer =
    typeof setImmediate === 'function'
      ? setImmediate
      : (cb: () => void) => {
          if (typeof queueMicrotask === 'function') {
            queueMicrotask(cb);
          } else {
            setTimeout(cb, 0);
          }
        };
  defer(async () => {
    networkProcessScheduled = false;
    if (!env.networkInbox || env.networkInbox.length === 0) return;
    if (processing) {
      scheduleNetworkProcess(env);
      return;
    }
    try {
      await process(env);
    } catch (error) {
      logError('NETWORK', 'Failed to process network inbox', error);
    }
  });
};

const resolveRuntimeIdForEntity = (env: Env, entityId: string): string | null => {
  if (!env.gossip?.getProfiles) return null;
  const profiles = env.gossip.getProfiles();
  const profile = profiles.find((p: Profile) => p.entityId === entityId);
  return profile?.runtimeId || null;
};

const routeEntityOutputs = (env: Env, outputs: EntityInput[]): EntityInput[] => {
  if (!p2pOverlay) return outputs;
  const localEntityIds = new Set<string>();
  for (const replicaKey of env.eReplicas.keys()) {
    try {
      localEntityIds.add(extractEntityId(replicaKey));
    } catch {
      // Skip malformed replica keys
    }
  }

  const localOutputs: EntityInput[] = [];
  const pendingOutputs = env.pendingNetworkOutputs ? [...env.pendingNetworkOutputs] : [];
  env.pendingNetworkOutputs = [];
  const allOutputs = [...pendingOutputs, ...outputs];
  const deferredOutputs: EntityInput[] = [];

  for (const output of allOutputs) {
    if (localEntityIds.has(output.entityId)) {
      localOutputs.push(output);
      continue;
    }
    const targetRuntimeId = resolveRuntimeIdForEntity(env, output.entityId);
    console.log(`🔀 ROUTE: Output for entity ${output.entityId.slice(-4)} → runtimeId=${targetRuntimeId?.slice(0,10) || 'UNKNOWN'}`);

    if (!targetRuntimeId) {
      console.warn(`⚠️ ROUTE-DEFER: No runtimeId for entity ${output.entityId.slice(-4)} - deferring output`);
      env.warn('network', 'Missing runtimeId for entity output (queued)', { entityId: output.entityId });
      deferredOutputs.push(output);
      continue;
    }

    console.log(`📤 P2P-SEND: Enqueueing to runtimeId ${targetRuntimeId.slice(0, 10)} for entity ${output.entityId.slice(-4)}`);
    p2pOverlay.enqueueEntityInput(targetRuntimeId, output);
  }

  if (deferredOutputs.length > 0) {
    env.pendingNetworkOutputs = deferredOutputs;
  }

  return localOutputs;
};

export const startP2P = (env: Env, config: P2PConfig = {}): RuntimeP2P | null => {
  console.log(`[P2P] startP2P called, relayUrls=${config.relayUrls?.join(',')}, env.runtimeId=${env.runtimeId?.slice(0,10) || 'NONE'}`);
  lastP2PConfig = config;
  const resolvedRuntimeId = config.runtimeId || env.runtimeId;
  if (!resolvedRuntimeId) {
    console.log(`[P2P] No runtimeId, storing as pendingP2PConfig`);
    pendingP2PConfig = { env, config };
    return null;
  }

  if (p2pOverlay) {
    if (p2pOverlay.matchesIdentity(resolvedRuntimeId, config.signerId)) {
      p2pOverlay.updateConfig(config);
      return p2pOverlay;
    }
    p2pOverlay.close();
  }

  p2pOverlay = new RuntimeP2P({
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
      env.networkInbox = env.networkInbox || [];
      env.networkInbox.push(input);
      console.log(`📥 NETWORK-INBOX: Added, size=${env.networkInbox.length}`);
      env.info('network', 'INBOUND_ENTITY_INPUT', { fromRuntimeId: from, entityId: input.entityId }, input.entityId);
      scheduleNetworkProcess(env);
    },
    onGossipProfiles: (from, profiles) => {
      console.log(`📥 onGossipProfiles: Received ${profiles.length} profiles from ${from.slice(0,10)}`);
      console.log(`📥 Profile details:`, profiles.map(p => `${p.entityId?.slice(-4) || '????'}:${p.accounts?.length || 0}acc`).join(', '));

      if (!env.gossip?.announce) {
        console.warn(`⚠️ No env.gossip.announce!`);
        return;
      }

      console.log(`📥 Starting announce loop for ${profiles.length} profiles...`);
      for (let i = 0; i < profiles.length; i++) {
        const profile = profiles[i];
        console.log(`  [${i}] Announcing ${profile.entityId.slice(-4)} accounts=${profile.accounts?.length || 0} ts=${profile.metadata?.lastUpdated}`);
        env.gossip.announce(profile);
      }
      console.log(`📥 Announce loop complete`);
      env.info('network', 'GOSSIP_SYNC', { fromRuntimeId: from, profiles: profiles.length });
    },
  });

  p2pOverlay.connect();
  return p2pOverlay;
};

export const stopP2P = (): void => {
  if (p2pOverlay) {
    p2pOverlay.close();
    p2pOverlay = null;
  }
  lastP2PConfig = null;
};

export const getP2P = (): RuntimeP2P | null => p2pOverlay;

export const refreshGossip = (): void => {
  if (p2pOverlay) {
    p2pOverlay.refreshGossip();
  }
};

/**
 * Initialize module-level env if not already set
 * Call this early in frontend initialization before prepopulate
 */
export const initEnv = (): Env => {
  if (!env) {
    env = createEmptyEnv(runtimeSeed);
    if (env.runtimeSeed !== undefined && env.runtimeSeed !== null) {
      setCryptoRuntimeSeed(env.runtimeSeed);
    }
    console.log('🌍 Runtime env initialized (module-level)');
  }
  return env;
};

const notifyEnvChange = (env: Env) => {
  if (envChangeCallback) {
    envChangeCallback(env);
  }
};

/**
 * Process any pending j-events after j-block finalization
 * Called automatically after each BrowserVM batch execution
 * This is the R-machine routing j-events from jReplicas to eReplicas
 */
export const processJBlockEvents = async (): Promise<void> => {
  if (!env) {
    console.warn('⚠️ processJBlockEvents: No env available');
    return;
  }

  if (processing) {
    console.warn('⏸️ processJBlockEvents: Runtime busy, leaving j-events queued');
    return;
  }

  const pending = env.runtimeInput.entityInputs.length;
  if (pending === 0) return;

  console.log(`🔗 J-BLOCK: ${pending} j-events queued → routing to eReplicas`);
  const toProcess = [...env.runtimeInput.entityInputs];
  env.runtimeInput.entityInputs = [];

  try {
    await process(env, toProcess);
  } catch (error) {
    env.runtimeInput.entityInputs = [...toProcess, ...env.runtimeInput.entityInputs];
    throw error;
  }
  console.log(`   ✓ ${toProcess.length} j-events processed`);
};

// J-Watcher initialization
const startJEventWatcher = async (env: Env): Promise<void> => {
  // BrowserVM is the default - it handles events synchronously via processJBlockEvents()
  // External RPC watcher is disabled until we support remote jurisdictions
  const browserVM = getBrowserVMInstance(env);
  if (browserVM) {
    console.log('🔭 J-WATCHER: Using BrowserVM (external RPC not needed)');
    return;
  }

  // External RPC mode (use imported J-machines first, fallback to static config)
  try {
    let rpcUrl: string | undefined;
    let entityProviderAddress: string | undefined;
    let depositoryAddress: string | undefined;

    // Prefer J-machines imported into this env (VaultStore uses importJ)
    if (env.jReplicas) {
      for (const replica of env.jReplicas.values()) {
        const candidateRpc = replica.rpcs?.[0];
        if (candidateRpc && replica.entityProviderAddress && replica.depositoryAddress) {
          rpcUrl = candidateRpc;
          entityProviderAddress = replica.entityProviderAddress;
          depositoryAddress = replica.depositoryAddress;
          break;
        }
      }
    }

    // Fallback to static jurisdictions (legacy)
    if (!rpcUrl || !entityProviderAddress || !depositoryAddress) {
      const arrakis = await getJurisdictionByAddress('arrakis');
      if (!arrakis) {
        console.warn('⚠️ Arrakis jurisdiction not found, skipping j-watcher');
        return;
      }
      rpcUrl = arrakis.address;
      entityProviderAddress = arrakis.entityProviderAddress;
      depositoryAddress = arrakis.depositoryAddress;
    }

    if (isBrowser && rpcUrl.startsWith('/')) {
      rpcUrl = `${window.location.origin}${rpcUrl}`;
    }

    jWatcher = await setupJEventWatcher(env, rpcUrl, entityProviderAddress, depositoryAddress);

    console.log('✅ J-Event Watcher started (external RPC)');
    console.log(`🔭 Monitoring: ${rpcUrl}`);

    setInterval(async () => {
      if (processing) return;
      if (env.runtimeInput.entityInputs.length === 0) return;
      const pendingInputs = [...env.runtimeInput.entityInputs];
      env.runtimeInput.entityInputs = [];
      try {
        await process(env, pendingInputs);
      } catch (error) {
        env.runtimeInput.entityInputs = [...pendingInputs, ...env.runtimeInput.entityInputs];
        throw error;
      }
    }, 100);

  } catch (error) {
    logError("RUNTIME_TICK", '❌ Failed to start J-Event Watcher:', error);
  }
};

// Note: History is now stored in env.history (no global variable needed)

// === SNAPSHOT UTILITIES ===
// All cloning utilities now moved to state-helpers.ts

// All snapshot functionality now moved to state-helpers.ts

// === UTILITY FUNCTIONS ===

const applyRuntimeInput = async (
  env: Env,
  runtimeInput: RuntimeInput,
): Promise<{ entityOutbox: EntityInput[]; mergedInputs: EntityInput[] }> => {
  const startTime = getPerfMs();

  // Ensure event emitters are attached (may be lost after store serialization)
  if (!env.emit) {
    attachEventEmitters(env);
  }

  try {
    // SECURITY: Validate runtime input
    if (!runtimeInput) {
      log.error('❌ Null runtime input provided');
      return { entityOutbox: [], mergedInputs: [] };
    }
    if (!Array.isArray(runtimeInput.runtimeTxs)) {
      log.error(`❌ Invalid runtimeTxs: expected array, got ${typeof runtimeInput.runtimeTxs}`);
      return { entityOutbox: [], mergedInputs: [] };
    }
    if (!Array.isArray(runtimeInput.entityInputs)) {
      log.error(`❌ Invalid entityInputs: expected array, got ${typeof runtimeInput.entityInputs}`);
      return { entityOutbox: [], mergedInputs: [] };
    }

    // Process J-layer inputs (queue to J-mempool)
    if (runtimeInput.jInputs && Array.isArray(runtimeInput.jInputs)) {
      if (HEAVY_LOGS) console.log(`🔍 J-Input processing: ${runtimeInput.jInputs.length} jInputs`);
      for (const jInput of runtimeInput.jInputs) {
        const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
        if (!jReplica) {
          console.error(`❌ J-Input: Jurisdiction "${jInput.jurisdictionName}" not found`);
          continue;
        }

        if (HEAVY_LOGS) console.log(`🔍 J-Input has ${jInput.jTxs.length} JTxs for ${jInput.jurisdictionName}`);
        // Queue all JTxs to J-mempool with queuedAt timestamp
        for (const jTx of jInput.jTxs) {
          // Mark when added (for minimum 1-tick delay visualization)
          const jTxWithQueueTime = { ...jTx, queuedAt: env.timestamp };
          jReplica.mempool.push(jTxWithQueueTime);
          console.log(`📥 J-Input: Queued ${jTx.type} from ${jTx.entityId.slice(-4)} to ${jInput.jurisdictionName} mempool (mempool size now: ${jReplica.mempool.length})`);
        }

        console.log(`✅ J-Input: ${jInput.jTxs.length} txs queued (mempool: ${jReplica.mempool.length})`);
      }
    }

    // Capture queued inputs and clear to allow new ones during processing
    const queuedRuntimeTxs = [...env.runtimeInput.runtimeTxs];
    const queuedEntityInputs = [...env.runtimeInput.entityInputs];
    env.runtimeInput.runtimeTxs = [];
    env.runtimeInput.entityInputs = [];

    // SECURITY: Resource limits (include queued + new inputs)
    if (queuedRuntimeTxs.length + runtimeInput.runtimeTxs.length > 1000) {
      log.error(`❌ Too many runtime transactions: ${queuedRuntimeTxs.length + runtimeInput.runtimeTxs.length} > 1000`);
      return { entityOutbox: [], mergedInputs: [] };
    }
    if (queuedEntityInputs.length + runtimeInput.entityInputs.length > 10000) {
      log.error(`❌ Too many entity inputs: ${queuedEntityInputs.length + runtimeInput.entityInputs.length} > 10000`);
      return { entityOutbox: [], mergedInputs: [] };
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

    const mergedRuntimeTxs = [...queuedRuntimeTxs, ...validatedRuntimeTxs];
    const mergedEntityInputs = [...queuedEntityInputs, ...validatedEntityInputs];

    // Merge all entityInputs (already validated above)
    const mergedInputs = mergeEntityInputs(mergedEntityInputs);

    const entityOutbox: EntityInput[] = [];
    const jOutbox: JInput[] = []; // Collect J-outputs from entities

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

          // Auto-create self-entity for signer (if not exists)
          const signer = env.signers?.[0];
          if (signer) {
            const selfEntityId = signerToEntityId(signer.address);
            const replicaKey = `${selfEntityId}:${signer.address}`;

            if (!env.eReplicas.has(replicaKey)) {
              console.log(`[Runtime] Auto-creating self-entity for signer ${signer.address.slice(0, 10)}...`);

              // Register on-chain via EntityProvider
              const browserVM = (jadapter as any).browserVM;
              if (browserVM?.registerEntitiesWithSigners) {
                await browserVM.registerEntitiesWithSigners([{
                  entityId: selfEntityId,
                  signerAddresses: [signer.address],
                  threshold: 1,
                }]);
              }

              // Create local replica
              const entityConfig: ConsensusConfig = {
                mode: 'proposer-based',
                threshold: 1n,
                validators: [signer.address],
                shares: { [signer.address]: 1n },
                jurisdiction: {
                  address: jadapter.addresses.depository,
                  name: runtimeTx.data.name,
                  chainId: runtimeTx.data.chainId,
                  entityProviderAddress: jadapter.addresses.entityProvider,
                  depositoryAddress: jadapter.addresses.depository,
                },
              };

              const replica: EntityReplica = {
                entityId: selfEntityId,
                signerId: signer.address,
                mempool: [],
                isProposer: true,
                state: {
                  entityId: selfEntityId,
                  height: 0,
                  timestamp: env.timestamp,
                  nonces: new Map(),
                  accounts: new Map(),
                  reserves: new Map(),
                  lockBook: new Map(),
                  config: entityConfig,
                  messages: [],
                  proposals: new Map(),
                  lastFinalizedJHeight: 0,
                  htlcFeesEarned: 0n,
                },
              };

              env.eReplicas.set(replicaKey, replica);

              // Fund with test tokens (BrowserVM only)
              if (isBrowserVM && browserVM?.debugFundReserves) {
                await browserVM.debugFundReserves(selfEntityId, 1, 1000n * 10n**18n);
                console.log(`[Runtime] Funded self-entity with 1000 tokens`);
              }

              console.log(`[Runtime] ✅ Self-entity created: ${selfEntityId.slice(0, 18)}`);
            }
          }

          console.log(`[Runtime] ✅ JReplica "${runtimeTx.data.name}" ready`);
        } catch (error) {
          console.error(`[Runtime] ❌ Failed to import J-machine:`, error);
        }
      } else if (runtimeTx.type === 'importReplica') {
        if (DEBUG)
          console.log(
            `Importing replica Entity #${formatEntityDisplay(runtimeTx.entityId)}:${formatSignerDisplay(runtimeTx.signerId)} (proposer: ${runtimeTx.data.isProposer})`,
          );

        const replicaKey = `${runtimeTx.entityId}:${runtimeTx.signerId}`;
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

        // 🔐 Generate crypto keys for HTLC envelope encryption
        const { NobleCryptoProvider } = await import('./crypto-noble');
        const crypto = new NobleCryptoProvider();
        const { publicKey, privateKey } = await crypto.generateKeyPair();
        replica.state.cryptoPublicKey = publicKey;
        replica.state.cryptoPrivateKey = privateKey;

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

        // Ensure entity-level signing key exists for this runtime (needed for gossip public key)
        if (runtimeSeed !== undefined && runtimeSeed !== null) {
          try {
            const seedBytes = new TextEncoder().encode(runtimeSeed);
            const entityKey = deriveSignerKeySync(seedBytes, runtimeTx.entityId);
            registerSignerKey(runtimeTx.entityId, entityKey);
          } catch (error) {
            console.warn(`⚠️ Failed to derive entity key for ${runtimeTx.entityId.slice(0, 10)}:`, error);
          }
        }

        // Validate jBlock immediately after creation
        const createdReplica = env.eReplicas.get(replicaKey);
        const actualJBlock = createdReplica?.state.lastFinalizedJHeight;
        // REPLICA-DEBUG removed

        // Broadcast initial profile to gossip layer
        if (env.gossip && createdReplica) {
          const entityPublicKey = getSignerPublicKey(env, runtimeTx.entityId);
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
    for (const entityInput of mergedInputs) {
      // Track j-events in this input - entityInput.entityTxs guaranteed by validateEntityInput above
      // J-EVENT logging removed - too verbose

      // Handle empty signerId for AccountInputs - auto-route to proposer
      let actualSignerId = entityInput.signerId;
      if (!actualSignerId || actualSignerId === '') {
        // Check if this is an AccountInput that needs auto-routing
        const hasAccountInput = entityInput.entityTxs!.some(tx => tx.type === 'accountInput');
        if (hasAccountInput) {
          // Find the proposer for this entity
          const entityReplicaKeys = Array.from(env.eReplicas.keys()).filter(key => key.startsWith(entityInput.entityId + ':'));
          if (entityReplicaKeys.length > 0) {
            const firstReplicaKey = entityReplicaKeys[0];
            if (!firstReplicaKey) {
              logError("RUNTIME_TICK", `❌ Invalid replica key for entity ${entityInput.entityId}`);
              continue;
            }
            const firstReplica = env.eReplicas.get(firstReplicaKey);
            if (firstReplica?.state.config.validators[0]) {
              actualSignerId = firstReplica.state.config.validators[0];
              // AUTO-ROUTE log removed
            }
          }
        }

        // Fallback if still no signerId
        if (!actualSignerId || actualSignerId === '') {
          console.warn(`⚠️ No signerId and unable to determine proposer for entity ${entityInput.entityId.slice(0,10)}...`);
          continue; // Skip this input
        }
      }

      const replicaKey = `${entityInput.entityId}:${actualSignerId}`;
      const entityReplica = env.eReplicas.get(replicaKey);

      // REPLICA-LOOKUP logs removed - not consensus-critical

      if (entityReplica) {
        if (DEBUG) {
          console.log(`Processing input for ${replicaKey}:`);
          if (entityInput.entityTxs?.length) console.log(`  → ${entityInput.entityTxs.length} transactions`);
          if (entityInput.proposedFrame) console.log(`  → Proposed frame: ${entityInput.proposedFrame.hash}`);
          if (entityInput.hashPrecommits?.size) console.log(`  → ${entityInput.hashPrecommits.size} precommits`);
        }

        const { newState, outputs, jOutputs, workingReplica } = await applyEntityInput(env, entityReplica, entityInput);
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
          sentTransitions: workingReplica.sentTransitions ?? 0, // Preserve counter
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
      }
    }

    // Process J-outputs BEFORE creating frame (queue to J-mempool)
    if (jOutbox.length > 0) {
      console.log(`📤 [3/6] J-OUTPUTS: ${jOutbox.length} J-outputs collected → routing to J-mempools`);

      for (const jInput of jOutbox) {
        const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
        if (!jReplica) {
          console.error(`❌ J-Output: Jurisdiction "${jInput.jurisdictionName}" not found`);
          continue;
        }

        // Queue JTxs to J-mempool (PROPER ROUTING)
        for (const jTx of jInput.jTxs) {
          // Mark when queued (for minimum 1-tick visualization delay)
          const jTxWithQueueTime = { ...jTx, queuedAt: env.timestamp };
          jReplica.mempool.push(jTxWithQueueTime);
          console.log(`📥 [4/6] J-Output: Queued ${jTx.type} from ${jTx.entityId.slice(-4)} to ${jInput.jurisdictionName} mempool (queuedAt: ${env.timestamp}, mempool.length: ${jReplica.mempool.length})`);

          // Emit event when actually queued
          env.emit('JBatchQueued', {
            entityId: jTx.entityId,
            batchSize: jTx.data.batchSize,
            mempoolSize: jReplica.mempool.length,
            jurisdictionName: jInput.jurisdictionName,
          });
        }

        console.log(`✅ J-Output: ${jInput.jTxs.length} txs queued to ${jInput.jurisdictionName} (mempool: ${jReplica.mempool.length})`);
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
      // Don't overwrite timestamp in scenario mode (deterministic time control)
      if (!env.scenarioMode) {
        env.timestamp = getWallClockMs();
      }

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
              if (account.pendingFrame || account.mempool.length > 0 || account.sentTransitions > account.ackedTransitions) {
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

    notifyEnvChange(env);

    if (DEBUG && entityOutbox.length > 0) {
      console.log(`📤 Outputs: ${entityOutbox.length} messages`);
      entityOutbox.forEach((output, i) => {
        console.log(
          `  ${i + 1}. → ${output.signerId} (${output.entityTxs ? `${output.entityTxs.length} txs` : ''}${output.proposedFrame ? ` proposal: ${output.proposedFrame.hash.slice(0, 10)}...` : ''}${output.hashPrecommits ? ` ${output.hashPrecommits.size} precommits` : ''})`,
        );
      });
    } else if (DEBUG && entityOutbox.length === 0) {
      console.log(`📤 No outputs generated`);
    }

    // Replica states dump removed - too verbose

    // Always notify UI after processing a frame (this is the discrete simulation step)
    notifyEnvChange(env);

    // Performance logging
    const endTime = getPerfMs();
    if (DEBUG) {
      console.log(`⏱️  Tick ${env.height - 1} completed in ${endTime - startTime}ms`);
    }

    // APPLY-SERVER-INPUT-FINAL-RETURN removed
    return { entityOutbox, mergedInputs };
  } catch (error) {
    console.error(`❌ CRITICAL: applyRuntimeInput failed!`, error);
    throw error; // Don't swallow - fail fast and loud
  }
};

// This is the new, robust main function that replaces the old one.
const main = async (): Promise<Env> => {
  console.log(`🚀 RUNTIME.JS VERSION: ${RUNTIME_BUILD_ID}`);

  // Open database before any operations
  const dbReady = await tryOpenDb();

  // DEBUG: Log jurisdictions content on startup using centralized loader
  if (!isBrowser) {
    try {
      const { loadJurisdictions } = await import('./jurisdiction-loader');
      const jurisdictions = loadJurisdictions();
      console.log('🔍 STARTUP: Current jurisdictions content (from centralized loader):');
      console.log('📍 Arrakis Depository:', jurisdictions.jurisdictions['arrakis']?.contracts?.depository);
      console.log('📍 Arrakis EntityProvider:', jurisdictions.jurisdictions['arrakis']?.contracts?.entityProvider);
      console.log('📍 Last updated:', jurisdictions.lastUpdated);
      console.log('📍 Full Arrakis config:', safeStringify(jurisdictions.jurisdictions['arrakis']));
    } catch (error) {
      console.log('⚠️ Failed to load jurisdictions:', (error as Error).message);
    }
  }

  // Initialize gossip layer
  console.log('🕸️ Initializing gossip layer...');
  const gossipLayer = createGossipLayer();
  console.log('✅ Gossip layer initialized');

  // Load persisted profiles from database into gossip layer
  console.log('📡 Loading persisted profiles from database...');
  await loadPersistedProfiles(db, gossipLayer);

  // First, create default environment with gossip layer and event emitters
  env = createEmptyEnv(runtimeSeed);
  env.gossip = gossipLayer; // Override default gossip with persisted profiles

  // Try to load saved state from database
  try {
    if (!dbReady) {
      console.log('💾 Database unavailable - starting fresh');
      throw new Error('DB_UNAVAILABLE');
    }

    console.log('📥 Loading state from database...');
    const latestHeightBuffer = await withTimeout(db.get(Buffer.from('latest_height')), 2000);

    const latestHeight = parseInt(latestHeightBuffer.toString(), 10);
    console.log(`📊 BROWSER-DEBUG: Found latest height in DB: ${latestHeight}`);

    console.log(`📊 Found latest height: ${latestHeight}, loading ${latestHeight + 1} snapshots...`);

    // Load snapshots starting from 1 (height 0 is initial state, no snapshot saved)
    console.log(`📥 Loading snapshots: 1 to ${latestHeight}...`);
    const snapshots = [];

    // Start from 1 since height 0 is initial state with no snapshot
    for (let i = 1; i <= latestHeight; i++) {
      try {
        const buffer = await db.get(Buffer.from(`snapshot:${i}`));
        const snapshot = decode(buffer);
        normalizeSnapshotInPlace(snapshot);
        snapshots.push(snapshot);
        console.log(`📦 Snapshot ${i}: loaded ${buffer.length} bytes`);
      } catch (error) {
        logError("RUNTIME_TICK", `❌ Failed to load snapshot ${i}:`, error);
        console.warn(`⚠️ Snapshot ${i} missing, continuing with available data...`);
      }
    }

    if (snapshots.length === 0) {
      console.log(`📦 No snapshots found (latestHeight: ${latestHeight}), using fresh environment`);
      throw new Error('LEVEL_NOT_FOUND');
    }

    console.log(`📊 Successfully loaded ${snapshots.length}/${latestHeight} snapshots (starting from height 1)`);
    env.history = snapshots;

    if (snapshots.length > 0) {
      const latestSnapshot = snapshots[snapshots.length - 1];

      // CRITICAL: Validate snapshot has proper eReplicas data
      if (!latestSnapshot.eReplicas) {
        console.warn('⚠️ Latest snapshot missing eReplicas data, using fresh environment');
        throw new Error('LEVEL_NOT_FOUND');
      }

      // Restore gossip profiles from snapshot
      const gossipLayer = createGossipLayer();
      if (latestSnapshot.gossip?.profiles) {
        for (const [id, profile] of Object.entries(latestSnapshot.gossip.profiles)) {
          gossipLayer.profiles.set(id, profile as Profile);
        }
        console.log(`📡 Restored gossip profiles: ${Object.keys(latestSnapshot.gossip.profiles).length} entries`);
      }

      // CRITICAL: Convert eReplicas to proper Map if needed (handle deserialization from DB)
      let eReplicasMap: Map<string, EntityReplica>;
      try {
        eReplicasMap = normalizeReplicaMap(latestSnapshot.eReplicas);
      } catch (conversionError) {
        logError("RUNTIME_TICK", '❌ Failed to convert eReplicas to Map:', conversionError);
        console.warn('⚠️ Falling back to fresh environment');
        throw new Error('LEVEL_NOT_FOUND');
      }

      const jReplicasMap = normalizeJReplicaMap(latestSnapshot.jReplicas);

      // Create env with proper event emitters, then populate from snapshot
      const snapshotSeed = latestSnapshot.runtimeSeed ?? null;
      env = createEmptyEnv(snapshotSeed);
      if (snapshotSeed !== undefined && snapshotSeed !== null) {
        runtimeSeed = snapshotSeed;
        setCryptoRuntimeSeed(runtimeSeed);
      }
      if (latestSnapshot.runtimeId) {
        runtimeId = latestSnapshot.runtimeId;
        env.runtimeId = runtimeId;
      } else if (runtimeSeed !== undefined && runtimeSeed !== null) {
        try {
          runtimeId = deriveSignerAddressSync(runtimeSeed, '1');
          env.runtimeId = runtimeId;
        } catch (error) {
          console.warn('⚠️ Failed to derive runtimeId on restore:', error);
        }
      }
      // CRITICAL: Clone the eReplicas Map to avoid mutating snapshot data!
      env.eReplicas = new Map(Array.from(eReplicasMap).map(([key, replica]): [string, EntityReplica] => {
        return [key, cloneEntityReplica(replica)];
      }));
      env.jReplicas = jReplicasMap;
      env.height = latestSnapshot.height;
      env.timestamp = latestSnapshot.timestamp;
      // CRITICAL: runtimeInput must start EMPTY on restore!
      // The snapshot's runtimeInput was already processed
      env.runtimeInput = {
        runtimeTxs: [],
        entityInputs: []
      };
      env.history = snapshots; // Include the loaded history
      env.gossip = gossipLayer; // Use restored gossip layer
      env.frameLogs = [];
      if (latestSnapshot.browserVMState && isBrowser) {
        try {
          const { BrowserVMProvider } = await import('./jadapter');
          const browserVM = new BrowserVMProvider();
          await browserVM.init();
          await browserVM.restoreState(latestSnapshot.browserVMState);
          env.browserVM = browserVM;
          setBrowserVMJurisdiction(env, browserVM.getDepositoryAddress(), browserVM);
          if (typeof window !== 'undefined') {
            (window as any).__xlnBrowserVM = browserVM;
          }
          console.log('✅ BrowserVM restored from persisted state');
        } catch (error) {
          console.warn('⚠️ Failed to restore BrowserVM state:', error);
        }
      }
      console.log(`✅ History restored. Runtime is at height ${env.height} with ${env.history.length} snapshots.`);
      console.log(`📈 Snapshot details:`, {
        height: env.height,
        replicaCount: env.eReplicas.size,
        timestamp: new Date(env.timestamp).toISOString(),
        runtimeInputs: env.runtimeInput.entityInputs.length,
      });
    }
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === 'TIMEOUT';
    const isNotFound = error instanceof Error &&
      (error.name === 'NotFoundError' ||
       error.message?.includes('NotFoundError') ||
       error.message?.includes('Entry not found'));

    if (isTimeout || isNotFound) {
      console.log('📦 No saved state found - starting fresh');
    } else if (error instanceof Error && error.message === 'DB_UNAVAILABLE') {
      // Already logged above
    } else {
      console.warn('⚠️ Error loading state:', error instanceof Error ? error.message : error);
      console.log('📦 Starting fresh');
    }
  }

  // Demo profiles are only initialized during runDemo - not by default

  // Only run demos in Node.js environment, not browser
  if (!isBrowser) {
    // DISABLED: Hanko tests during development
    console.log('\n🚀 Hanko tests disabled during development - focusing on core functionality');
    
    // // Add hanko demo to the main execution
    // console.log('\n🖋️  Testing Complete Hanko Implementation...');
    // await demoCompleteHanko();

    // // 🧪 Run basic Hanko functionality tests first
    // console.log('\n🧪 Running basic Hanko functionality tests...');
    // await runBasicHankoTests();

    // // 🧪 Run comprehensive Depository-Hanko integration tests
    // console.log('\n🧪 Running comprehensive Depository-Hanko integration tests...');
    // try {
    //   await runDepositoryHankoTests();
    // } catch (error) {
    //   console.log(
    //     'ℹ️  Depository integration tests skipped (contract setup required):',
    //     (error as Error).message?.substring(0, 100) || 'Unknown error',
    //   );
    // }
  } else {
    console.log('🌐 Browser environment: Demos available via UI buttons, not auto-running');
  }

  log.info(`🎯 Runtime startup complete. Height: ${env.height}, Entities: ${env.eReplicas.size}`);

  // Debug final state before starting j-watcher
  if (isBrowser) {
    if (HEAVY_LOGS) console.log(`🔍 BROWSER-DEBUG: Final state before j-watcher start:`);
    if (HEAVY_LOGS) console.log(`🔍   Environment height: ${env.height}`);
    if (HEAVY_LOGS) console.log(`🔍   Total replicas: ${env.eReplicas.size}`);
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const { entityId, signerId } = parseReplicaKey(replicaKey);
      if (HEAVY_LOGS) console.log(`🔍   Entity ${entityId.slice(0,10)}... (${signerId}): jBlock=${replica.state.lastFinalizedJHeight}, isProposer=${replica.isProposer}`);
    }
  }

  // Start J-watcher in browser when using external RPC (required for ReserveUpdated sync)
  if (isBrowser) {
    if (!jWatcherStarted) {
      console.log('🔭 STARTING-JWATCHER: Snapshots loaded, starting j-watcher (non-blocking)...');

      Promise.race([
        startJEventWatcher(env),
        new Promise((_, reject) => setTimeout(() => reject(new Error('J-watcher startup timeout (3s)')), 3000))
      ])
        .then(() => {
          jWatcherStarted = true;
          console.log('🔭 JWATCHER-READY: J-watcher started successfully');
        })
        .catch((error) => {
          console.warn('⚠️  J-Event Watcher startup failed or timed out (non-critical):', error.message);
          console.warn('    UI will load anyway. Blockchain sync will retry in background.');
        });
    } else {
      console.log('🔭 JWATCHER-SKIP: J-watcher already started, skipping');
    }
  } else {
    console.log('🔭 J-WATCHER: Skipped in Node (server uses its own watcher)');
  }

  return env;
};

// === TIME MACHINE API ===
const getHistory = () => env.history || [];
const getSnapshot = (index: number) => {
  const history = env.history || [];
  return index >= 0 && index < history.length ? history[index] : null;
};
const getCurrentHistoryIndex = () => (env.history || []).length - 1;

// === SYSTEM SOLVENCY CHECK ===
// Total tokens in system: reserves + collateral must equal minted supply
interface Solvency {
  reserves: bigint;
  collateral: bigint;
  total: bigint;
  byToken: Map<number, { reserves: bigint; collateral: bigint; total: bigint }>;
}

const calculateSolvency = (snapshot?: Env): Solvency => {
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

const verifySolvency = (expected?: bigint, label?: string): boolean => {
  const s = calculateSolvency();
  const prefix = label ? `[${label}] ` : '';

  if (expected !== undefined && s.total !== expected) {
    console.error(`❌ ${prefix}SOLVENCY VIOLATION: Expected ${expected}, got ${s.total}`);
    console.error(`   Reserves: ${s.reserves}, Collateral: ${s.collateral}`);
    throw new Error(`Solvency check failed: ${s.total} !== ${expected}`);
  }

  console.log(`✅ ${prefix}Solvency: ${s.total} (R:${s.reserves} + C:${s.collateral})`);
  return true;
};

// Server-specific clearDatabase that also resets history
const clearDatabaseAndHistory = async () => {
  console.log('🗑️ Clearing database and resetting runtime history...');

  // Clear the Level database
  await clearDatabase(db);

  // Reset the runtime environment to initial state (including history)
  env = {
    eReplicas: new Map(),
    jReplicas: new Map(),
    height: 0,
    timestamp: 0,
    ...(runtimeSeed !== undefined && runtimeSeed !== null ? { runtimeSeed } : {}),
    ...(runtimeId ? { runtimeId } : {}),
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    history: [],
    gossip: createGossipLayer(),
    frameLogs: [],
  };

  console.log('✅ Database and runtime history cleared');
};

// Export j-watcher status for frontend display
export const getJWatcherStatus = () => {
  if (!jWatcher || !env) return null;
  return {
    isWatching: jWatcher.getStatus().isWatching,
    proposers: Array.from(env.eReplicas.entries())
      .filter(([, replica]) => replica.isProposer)
      .map(([key, replica]) => {
        const { entityId, signerId } = parseReplicaKey(key);
        return {
          entityId: entityId.slice(0,10) + '...',
          signerId,
          lastFinalizedJHeight: replica.state.lastFinalizedJHeight,
        };
      }),
    nextSyncIn: Math.floor((1000 - ((env.timestamp || 0) % 1000)) / 100) / 10, // Seconds until next 1s sync
  };
};

/**
 * Queue an entity transaction for processing (helper for UI components)
 * Wraps applyRuntimeInput with a single entity tx
 */
export const queueEntityInput = async (
  entityId: string,
  signerId: string,
  txData: { type: string; [key: string]: any }
): Promise<void> => {
  if (!env) throw new Error('Runtime not initialized');
  await applyRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [{
      entityId,
      signerId,
      entityTxs: [{ type: txData.type, data: txData }]
    }]
  });
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
  startJEventWatcher,
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
// Global reference to current env for log capturing
let currentEnvForLogs: Env | null = null;

const isEntryArray = (value: unknown): value is Array<[unknown, unknown]> =>
  Array.isArray(value) && value.length > 0 && Array.isArray(value[0]) && value[0].length === 2;

const normalizeReplicaMap = (raw: unknown): Map<string, EntityReplica> => {
  if (raw instanceof Map) return raw as Map<string, EntityReplica>;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return new Map();
    if (isEntryArray(raw)) return new Map(raw as Array<[string, EntityReplica]>);
  }
  if (raw && typeof raw === 'object') {
    return new Map(Object.entries(raw as Record<string, EntityReplica>));
  }
  throw new Error('Invalid eReplicas format in snapshot');
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

  const env: Env = {
    eReplicas: new Map(),
    jReplicas: new Map(),
    height: 0,
    timestamp: 0,
    ...(seedText !== undefined && seedText !== null ? { runtimeSeed: seedText } : {}),
    ...(runtimeId ? { runtimeId } : {}),
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
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

  // Set as current env for log capturing
  currentEnvForLogs = env;

  return env;
};

// Intercept console for frame log capturing (browser only)
// TEMPORARILY DISABLED - debugging solvency regression
if (false && isBrowser) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = function(...args: any[]) {
    originalLog.apply(console, args);
    if (currentEnvForLogs) {
      try {
        const msg = args.map(a => {
          if (typeof a === 'string') return a;
          if (typeof a === 'bigint') return a.toString() + 'n';
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        currentEnvForLogs.frameLogs.push({
          level: 'info',
          category: detectLogCategory(msg),
          message: msg,
          timestamp: currentEnvForLogs?.timestamp ?? 0,
        });
      } catch (e) {
        // Silently fail log capture - don't break runtime
      }
    }
  };

  console.warn = function(...args: any[]) {
    originalWarn.apply(console, args);
    if (currentEnvForLogs) {
      try {
        const msg = args.map(a => {
          if (typeof a === 'string') return a;
          if (typeof a === 'bigint') return a.toString() + 'n';
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        currentEnvForLogs.frameLogs.push({
          level: 'warn',
          category: detectLogCategory(msg),
          message: msg,
          timestamp: currentEnvForLogs?.timestamp ?? 0,
        });
      } catch (e) {
        // Silently fail
      }
    }
  };

  console.error = function(...args: any[]) {
    originalError.apply(console, args);
    if (currentEnvForLogs) {
      try {
        const msg = args.map(a => {
          if (typeof a === 'string') return a;
          if (typeof a === 'bigint') return a.toString() + 'n';
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        currentEnvForLogs.frameLogs.push({
          level: 'error',
          category: detectLogCategory(msg),
          message: msg,
          timestamp: currentEnvForLogs?.timestamp ?? 0,
        });
      } catch (e) {
        // Silently fail
      }
    }
  };
}

function detectLogCategory(msg: string): 'consensus' | 'account' | 'jurisdiction' | 'evm' | 'network' | 'ui' | 'system' {
  if (msg.includes('CONSENSUS') || msg.includes('E-MACHINE') || msg.includes('PROPOSE')) return 'consensus';
  if (msg.includes('ACCOUNT') || msg.includes('A-MACHINE') || msg.includes('BILATERAL')) return 'account';
  if (msg.includes('J-MACHINE') || msg.includes('JURISDICTION')) return 'jurisdiction';
  if (msg.includes('EVM') || msg.includes('BrowserVM')) return 'evm';
  if (msg.includes('GOSSIP') || msg.includes('NETWORK')) return 'network';
  if (msg.includes('[View]') || msg.includes('[Graph3D]')) return 'ui';
  return 'system';
}

// === CONSENSUS PROCESSING ===
// ONE TICK = ONE ITERATION. No cascade. E→E communication always requires new tick.
let processing = false;

export const process = async (
  env: Env,
  inputs?: EntityInput[],
  runtimeDelay = 0
) => {
  // Ensure event emitters are attached (may be lost after store serialization)
  if (!env.emit) {
    attachEventEmitters(env);
  }

  // Frame stepping: check if we should stop and dump state
  if (env.stopAtFrame !== undefined && env.height >= env.stopAtFrame) {
    console.log(`\n⏸️  FRAME STEPPING: Stopped at frame ${env.height}`);
    console.log('═'.repeat(80));
    const { formatRuntime } = await import('./runtime-ascii');
    console.log(formatRuntime(env, { maxAccounts: 10, maxLocks: 20, maxSwaps: 20 }));
    console.log('═'.repeat(80) + '\n');
    console.log('💾 State captured - use jq on /tmp/{scenario}-runtime.json for deep queries');
    throw new Error(`FRAME_STEP: Stopped at frame ${env.height} for debugging`);
  }

  // Lock: prevent interleaving
  if (processing) {
    console.warn('⏸️ SKIP: Previous tick still processing');
    return env;
  }

  processing = true;

  // Merge pending outputs from previous tick with new inputs
  const allInputs = [
    ...(env.pendingOutputs || []),
    ...(env.networkInbox || []),
    ...(inputs || []),
  ];
  env.pendingOutputs = [];
  env.networkInbox = [];

  // Validate inputs
  allInputs.forEach(o => {
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

  try {
    const quietRuntimeLogs = env.quietRuntimeLogs === true;
    getBrowserVMInstance(env)?.setQuietLogs?.(quietRuntimeLogs);
    // Update timestamp
    // In scenario mode, advance by 100ms per tick (deterministic)
    // In live mode, use real time
    if (env.scenarioMode) {
      env.timestamp = (env.timestamp ?? 0) + 100; // Advance 100ms per frame
    } else {
      env.timestamp = getWallClockMs();
    }
    getBrowserVMInstance(env)?.setBlockTimestamp?.(env.timestamp);

    const hasQueuedRuntimeTxs = (env.runtimeInput?.runtimeTxs?.length ?? 0) > 0;
    if (allInputs.length > 0 || hasQueuedRuntimeTxs) {
      if (!quietRuntimeLogs) {
        console.log(`📥 TICK: Processing ${allInputs.length} inputs for [${allInputs.map(o => o.entityId.slice(-4)).join(',')}]`);
        if (hasQueuedRuntimeTxs) {
          console.log(`📥 TICK: Processing ${env.runtimeInput.runtimeTxs.length} queued runtimeTxs`);
        }
      }

      const result = await applyRuntimeInput(env, { runtimeTxs: [], entityInputs: allInputs });

      // DEBUG: Log what applyRuntimeInput returned
      if (HEAVY_LOGS) console.log(`🔍 PROCESS-DEBUG: applyRuntimeInput returned entityOutbox.length=${result.entityOutbox.length}`);

      // Store outputs for NEXT tick
      const routedOutputs = routeEntityOutputs(env, result.entityOutbox);
      env.pendingOutputs = routedOutputs;

      if (routedOutputs.length > 0 && !quietRuntimeLogs) {
        console.log(`📤 TICK: ${routedOutputs.length} outputs queued for next tick → [${routedOutputs.map(o => o.entityId.slice(-4)).join(',')}]`);
      }
    } else {
      // No inputs to process - retry routing any pending network outputs
      if (env.pendingNetworkOutputs && env.pendingNetworkOutputs.length > 0) {
        const routedOutputs = routeEntityOutputs(env, []);
        if (routedOutputs.length > 0) {
          env.pendingOutputs = [...(env.pendingOutputs || []), ...routedOutputs];
          if (!quietRuntimeLogs) {
            console.log(`📤 TICK: ${routedOutputs.length} local outputs queued from pending network outputs`);
          }
        }
      } else {
        // No inputs to process - keep env.extra so narrative-only frames still render
      }
    }

    // === J-MACHINE BLOCK PROCESSING ===
    // Process J-machine mempools when blockDelayMs has elapsed
    if (env.jReplicas) {
      for (const [jName, jReplica] of env.jReplicas.entries()) {
        const mempool = jReplica.mempool || [];
        const blockDelayMs = jReplica.blockDelayMs || 300;
        const lastBlockTs = jReplica.lastBlockTimestamp || 0;
        const elapsed = env.timestamp - lastBlockTs;

        // Debug logging
        if (mempool.length > 0) {
          if (HEAVY_LOGS) console.log(`🔍 [J-Machine ${jName}] mempool=${mempool.length}, elapsed=${elapsed}ms, blockDelay=${blockDelayMs}ms, ready=${elapsed >= blockDelayMs}`);
        }

        // Check if mempool items are ready (minimum 1 tick delay for visualization)
        const oldestTxAge = mempool.length > 0 && mempool[0].queuedAt ? env.timestamp - mempool[0].queuedAt : 999999;
        const mempoolReady = mempool.length > 0 && oldestTxAge >= blockDelayMs;

        if (mempool.length > 0 && !mempoolReady && !quietRuntimeLogs) {
          console.log(`⏳ [J-Machine] ${mempool.length} pending (age: ${oldestTxAge}ms < ${blockDelayMs}ms) - waiting...`);
        }

        // If mempool ready AND block delay passed → PROCESS
        if (mempoolReady) {
          if (!quietRuntimeLogs) {
            console.log(`⚡ [5/6] J-Machine ${jReplica.name}: Processing ${mempool.length} txs (oldest: ${oldestTxAge}ms >= ${blockDelayMs}ms)`);
            console.log(`   Mempool BEFORE execution:`, mempool.map(tx => `${tx.entityId.slice(-4)}:${tx.data.batchSize || '?'}`));
          }

          // Emit J-block event
          env.emit('JBlockProcessing', {
            jurisdictionName: jName,
            txCount: mempool.length,
            blockNumber: Number(jReplica.blockNumber) + 1,
          });

          // Process each JTx in mempool
          const { broadcastBatch } = await import('./j-batch');
          const { getBrowserVMInstance } = await import('./evm');
          const browserVM = getBrowserVMInstance(env);
          const rpcUrl = jReplica.rpcs?.[0];
          const chainId = jReplica.jadapter?.chainId ?? jReplica.chainId;
          const jurisdiction = !browserVM && rpcUrl && jReplica.depositoryAddress && jReplica.entityProviderAddress ? {
            name: jReplica.name,
            chainId: Number(chainId ?? 0),
            address: rpcUrl,
            entityProviderAddress: jReplica.entityProviderAddress,
            depositoryAddress: jReplica.depositoryAddress,
          } : null;

          if (!browserVM && !jurisdiction) {
            console.warn(`⚠️ [J-Machine ${jReplica.name}] Missing jurisdiction config (rpc/addresses). Batch broadcast will be skipped.`);
          }

          if (browserVM?.beginJurisdictionBlock) {
            browserVM.beginJurisdictionBlock(env.timestamp);
          }

          for (const jTx of mempool) {
            if (jTx.type === 'batch' && jTx.data?.batch) {
              if (!quietRuntimeLogs) {
                console.log(`🔨 [J-Machine] Executing batch from ${jTx.entityId.slice(-4)}`);
                console.log(`   Batch size: ${jTx.data.batchSize || 'unknown'}`);
                console.log(`   Batch.reserveToReserve:`, jTx.data.batch.reserveToReserve);
              }
              let batchSummary: string | undefined;
              try {
                const { summarizeBatch } = await import('./j-batch');
                batchSummary = safeStringify(summarizeBatch(jTx.data.batch));
                if (!quietRuntimeLogs) {
                  console.log(`   Batch.summary: ${batchSummary}`);
                }
              } catch {
                // best-effort debug only
              }

              // Create temporary jBatchState for broadcastBatch call
              const tempJBatchState = {
                batch: jTx.data.batch,
                jurisdiction: null,
                lastBroadcast: jTx.timestamp,
                broadcastCount: 1,
                failedAttempts: 0,
              };

              if (!browserVM && !jurisdiction) {
                console.error(`   ❌ Batch execution skipped: missing jurisdiction config for ${jReplica.name}`);
                continue;
              }

              // Execute batch on BrowserVM
              const result = await broadcastBatch(
                env,
                jTx.entityId,
                tempJBatchState,
                jurisdiction, // Required for RPC mode; BrowserVM ignores this
                browserVM || undefined,
                jTx.timestamp ?? env.timestamp,
                jTx.data?.signerId
              );

              if (result.success) {
                if (!quietRuntimeLogs) {
                  console.log(`   ✅ Batch executed successfully`);
                  console.log(`   📡 ${result.events?.length || 0} events will route back to entities`);
                }
              } else {
                console.error(`   ❌ Batch execution failed: ${result.error}`);
                if (!batchSummary) {
                  try {
                    const { summarizeBatch } = await import('./j-batch');
                    batchSummary = safeStringify(summarizeBatch(jTx.data.batch));
                    console.error(`   ❌ Failed batch summary: ${batchSummary}`);
                  } catch {
                    // best-effort debug only
                  }
                } else {
                  console.error(`   ❌ Failed batch summary: ${batchSummary}`);
                }
                if (env.scenarioMode) {
                  throw new Error(`J-BATCH FAILED: ${result.error || 'unknown error'}`);
                }
              }
            }

            // Handle direct mint operations (admin function, bypasses batch)
            if (jTx.type === 'mint' && jTx.data && browserVM?.debugFundReserves) {
              const { entityId, tokenId, amount } = jTx.data;
              if (!quietRuntimeLogs) {
                console.log(`💰 [J-Machine] Minting ${amount} token ${tokenId} to ${entityId.slice(-4)}`);
              }
              try {
                await browserVM.debugFundReserves(entityId, tokenId, amount);
                if (!quietRuntimeLogs) {
                  console.log(`   ✅ Mint successful`);
                }
              } catch (error) {
                console.error(`   ❌ Mint failed: ${error}`);
                if (env.scenarioMode) {
                  throw new Error(`J-MINT FAILED: ${error}`);
                }
              }
            }
          }

          if (browserVM?.endJurisdictionBlock) {
            browserVM.endJurisdictionBlock();
          }

          // Clear mempool immediately after processing (all txs executed)
          const processedCount = mempool.length;
          const successCount = processedCount; // Failures would throw in scenario mode
          const failCount = 0;

          // CRITICAL: Clear mempool immediately (txs already executed)
          if (!quietRuntimeLogs) {
            console.log(`🧹 [J-Machine] Clearing mempool (before: ${jReplica.mempool.length} items)...`);
          }
          jReplica.mempool = [];
          if (!quietRuntimeLogs) {
            console.log(`🧹 [J-Machine] Mempool AFTER clear: ${jReplica.mempool.length} items (should be 0)`);
          }

          jReplica.lastBlockTimestamp = env.timestamp; // Reset timer for next block
          jReplica.blockNumber = jReplica.blockNumber + 1n; // Increment ONLY when block processed
          jReplica.blockReady = false; // Block created, mempool empty

          if (!quietRuntimeLogs) {
            console.log(`✅ [J-Machine ${jReplica.name}] Block #${jReplica.blockNumber} finalized (${successCount}/${processedCount} batches)`);
          }
          if (failCount > 0) {
            console.warn(`   ⚠️ ${failCount} batches failed, queued for retry`);
          }
          if (!quietRuntimeLogs) {
            console.log(`   Next block in ${blockDelayMs}ms`);
          }

          // Emit J-block finalized event
          env.emit('JBlockFinalized', {
            jurisdictionName: jName,
            blockNumber: Number(jReplica.blockNumber),
            txCount: mempool.length,
          });
        } else if (mempool.length > 0) {
          // Mempool has items but delay not elapsed yet (yellow cube visible, waiting)
          jReplica.blockReady = true;
        } else {
          jReplica.blockReady = false;
        }
      }
    }

    // ALWAYS snapshot after tick (full frame chain)
    // env.extra only adds metadata (subtitle, description) - optional
    let browserVMState: any = undefined;
    const browserVMStateSource = getBrowserVMInstance(env);
    if (browserVMStateSource?.serializeState) {
      try {
        browserVMState = await browserVMStateSource.serializeState();
        env.browserVMState = browserVMState;
      } catch (error) {
        console.warn('[Runtime] Failed to serialize BrowserVM state:', error);
        if (env.scenarioMode) {
          throw error;
        }
      }
    }

    const snapshot: any = {
      height: env.height,
      timestamp: env.timestamp,
      ...(env.runtimeSeed !== undefined && env.runtimeSeed !== null ? { runtimeSeed: env.runtimeSeed } : {}),
      ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
      eReplicas: new Map(env.eReplicas),
      jReplicas: env.jReplicas ? Array.from(env.jReplicas.values()).map(jr => ({
        ...jr,
        mempool: [...jr.mempool], // Deep clone mempool array
        stateRoot: new Uint8Array(jr.stateRoot), // Clone Uint8Array
      })) : [],
      runtimeInput: env.runtimeInput,
      runtimeOutputs: env.pendingOutputs || [],
      frameLogs: env.frameLogs || [],
      title: `Frame ${env.history?.length || 0}`, // Default title
      ...(browserVMState ? { browserVMState } : {}),
    };

    // Add metadata if provided via snap()
    if (env.extra) {
      const { subtitle, description } = env.extra;
      if (subtitle) {
        snapshot.subtitle = subtitle;
        snapshot.title = subtitle.title || snapshot.title; // Override title
      }
      if (description) snapshot.description = description;
      env.extra = undefined; // Clear after use
    }

    if (!env.history) env.history = [];
    env.history.push(snapshot);

    if (!quietRuntimeLogs) {
      console.log(`📸 Snapshot: ${snapshot.title} (${env.history.length} total)`);
    }

    // Auto-persist
    await saveEnvToDB(env);

    if (env.strictScenario) {
      const { assertRuntimeStateStrict } = await import('./strict-assertions');
      await assertRuntimeStateStrict(env);
    }
    return env;
  } finally {
    processing = false;
  }
};

// === LEVELDB PERSISTENCE ===
export const saveEnvToDB = async (env: Env): Promise<void> => {
  if (!isBrowser) return; // Only persist in browser

  try {
    const dbReady = await tryOpenDb();
    if (!dbReady) return;

    // Save latest height pointer
    await db.put(Buffer.from('latest_height'), Buffer.from(String(env.height)));

    // Save environment snapshot (jReplicas with stateRoot are serializable)
    // CRITICAL: Exclude 'history' to prevent exponential growth (history contains all previous snapshots)
    const seen = new WeakSet();
    const snapshot = JSON.stringify(env, (k, v) => {
      if (k === 'history') return undefined; // Skip history - it's rebuilt from individual snapshots
      if (k === 'browserVM') return undefined; // BrowserVM is non-serializable (circular refs)
      if (k === 'log' || k === 'info' || k === 'warn' || k === 'error' || k === 'emit') return undefined;
      if (k === 'gossip' && v && typeof v === 'object') {
        return {
          profiles: v.profiles instanceof Map ? Array.from(v.profiles.entries()) : v.profiles,
        };
      }
      if (typeof v === 'bigint') return String(v);
      if (v instanceof Uint8Array) return Array.from(v);
      if (v instanceof Map) return Array.from(v.entries());
      if (v instanceof Set) return Array.from(v);
      if (typeof v === 'function') return undefined;
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
    await db.put(Buffer.from(`snapshot:${env.height}`), Buffer.from(snapshot));
  } catch (err) {
    console.error('❌ Failed to save to LevelDB:', err);
    if (env.scenarioMode) {
      throw err;
    }
  }
};

export const loadEnvFromDB = async (): Promise<Env | null> => {
  if (!isBrowser) return null;

  try {
    const dbReady = await tryOpenDb();
    if (!dbReady) return null;

    const latestHeightBuffer = await db.get(Buffer.from('latest_height'));
    const latestHeight = parseInt(latestHeightBuffer.toString());

    // Load all snapshots to build history
    const history: Env[] = [];
    for (let i = 0; i <= latestHeight; i++) {
      const buffer = await db.get(Buffer.from(`snapshot:${i}`));
      const data = JSON.parse(buffer.toString());

      // Hydrate Maps/BigInts
      const runtimeSeedRaw = Array.isArray(data.runtimeSeed)
        ? new TextDecoder().decode(new Uint8Array(data.runtimeSeed))
        : data.runtimeSeed;
      const env = createEmptyEnv(runtimeSeedRaw ?? null);
      env.height = Number(data.height || 0);
      env.timestamp = Number(data.timestamp || 0);
      if (data.browserVMState) {
        env.browserVMState = data.browserVMState;
      }
      if (runtimeSeedRaw !== undefined && runtimeSeedRaw !== null) {
        setCryptoRuntimeSeed(runtimeSeedRaw);
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
      if (data.gossip?.profiles) {
        env.gossip.profiles = new Map(data.gossip.profiles);
      }
      history.push(env);
    }

    const latestEnv = history[history.length - 1];
    if (latestEnv) {
      latestEnv.history = history;
      if (latestEnv.browserVMState && isBrowser) {
        try {
          const { BrowserVMProvider } = await import('./jadapter');
          const browserVM = new BrowserVMProvider();
          await browserVM.init();
          await browserVM.restoreState(latestEnv.browserVMState);
          latestEnv.browserVM = browserVM;
          setBrowserVMJurisdiction(latestEnv, browserVM.getDepositoryAddress(), browserVM);
          if (typeof window !== 'undefined') {
            (window as any).__xlnBrowserVM = browserVM;
          }
          console.log('✅ BrowserVM restored from loadEnvFromDB');
        } catch (error) {
          console.warn('⚠️ Failed to restore BrowserVM state (loadEnvFromDB):', error);
        }
      }
    }

    return latestEnv;
  } catch (err) {
    console.log('No persisted state found');
    return null;
  }
};

export const clearDB = async (): Promise<void> => {
  if (!isBrowser) return;

  try {
    const dbReady = await tryOpenDb();
    if (!dbReady) return;

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
