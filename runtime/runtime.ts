// for regular use > bun run runtime/runtime.ts
// for debugging > bun repl
// await import('./debug.js');
// FORCE AUTO-REBUILD: Fixed signerId consistency and fintech type safety

// Import utilities and types
// High-level database using Level polyfill (works in both Node.js and browser)
import { Level } from 'level';

import { applyEntityInput, mergeEntityInputs } from './entity-consensus';
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
import { createGossipLayer } from './gossip';
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
import { type Profile } from './gossip.js';
import { loadPersistedProfiles } from './gossip-loader';
import { setupJEventWatcher, JEventWatcher } from './j-event-watcher';
import {
  createProfileUpdateTx,
  getEntityDisplayInfo as getEntityDisplayInfoFromProfileOriginal,
  resolveEntityName as resolveEntityNameOriginal,
  searchEntityNames as searchEntityNamesOriginal,
} from './name-resolution';
import { runDemo } from './rundemo';
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
import { getEntityShortId, getEntityNumber, formatEntityId } from './entity-helpers';
import { safeStringify } from './serialization-utils';
import { validateDelta, validateAccountDeltas, createDefaultDelta, isDelta, validateEntityInput, validateEntityOutput } from './validation-utils';
import { EntityInput, EntityReplica, Env, RuntimeInput, JReplica } from './types';
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
export const db: Level<Buffer, Buffer> = new Level('db', {
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

/**
 * Initialize module-level env if not already set
 * Call this early in frontend initialization before prepopulate
 */
export const initEnv = (): Env => {
  if (!env) {
    env = createEmptyEnv();
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

  const pending = env.runtimeInput.entityInputs.length;
  if (pending === 0) return;

  console.log(`🔗 J-BLOCK: ${pending} j-events queued → routing to eReplicas`);
  const toProcess = [...env.runtimeInput.entityInputs];
  env.runtimeInput.entityInputs = [];

  await applyRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: toProcess,
  });
  console.log(`   ✓ ${toProcess.length} j-events processed`);
};

// J-Watcher initialization
const startJEventWatcher = async (env: Env): Promise<void> => {
  try {
    // Get the Arrakis jurisdiction (primary testnet)
    const arrakis = await getJurisdictionByAddress('arrakis');
    if (!arrakis) {
      console.warn('⚠️ Arrakis jurisdiction not found, skipping j-watcher');
      return;
    }

    // Set up j-watcher with the deployed contracts
    jWatcher = await setupJEventWatcher(
      env,
      arrakis.address, // RPC URL (via /rpc/arrakis proxy)
      arrakis.entityProviderAddress,
      arrakis.depositoryAddress
    );

    console.log('✅ J-Event Watcher started successfully');
    console.log(`🔭 Monitoring: ${arrakis.address}`);
    console.log(`📍 EntityProvider: ${arrakis.entityProviderAddress}`);
    console.log(`📍 Depository: ${arrakis.depositoryAddress}`);
    
    // J-watcher now handles its own periodic sync every 500ms
    // Set up a periodic check to process any queued events from j-watcher
    setInterval(async () => {
      if (env.runtimeInput.entityInputs.length > 0) {
        // const eventCount = env.runtimeInput.entityInputs.length;
        // J-WATCHER routine log removed

        // Process the queued entity inputs from j-watcher
        await applyRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [...env.runtimeInput.entityInputs]
        });

        // Clear the processed inputs
        env.runtimeInput.entityInputs.length = 0;
      }
    }, 100); // Check every 100ms to process j-watcher events quickly
    
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
  const startTime = Date.now();

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

    // SECURITY: Resource limits
    if (runtimeInput.runtimeTxs.length > 1000) {
      log.error(`❌ Too many runtime transactions: ${runtimeInput.runtimeTxs.length} > 1000`);
      return { entityOutbox: [], mergedInputs: [] };
    }
    if (runtimeInput.entityInputs.length > 10000) {
      log.error(`❌ Too many entity inputs: ${runtimeInput.entityInputs.length} > 10000`);
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

    // NOW safe to merge into env.runtimeInput (after validation)
    env.runtimeInput.runtimeTxs.push(...validatedRuntimeTxs);
    env.runtimeInput.entityInputs.push(...validatedEntityInputs);

    // Merge all entityInputs in env.runtimeInput (already validated above)
    const mergedInputs = mergeEntityInputs(env.runtimeInput.entityInputs);

    const entityOutbox: EntityInput[] = [];

    // Process runtime transactions (handle async operations properly)
    for (const runtimeTx of env.runtimeInput.runtimeTxs) {
      if (runtimeTx.type === 'createXlnomy') {
        console.log(`[Runtime] Creating Xlnomy "${runtimeTx.data.name}"...`);

        try {
          const { createXlnomy } = await import('./jurisdiction-factory.js');
          const xlnomy = await createXlnomy({
            name: runtimeTx.data.name,
            evmType: runtimeTx.data.evmType,
            rpcUrl: runtimeTx.data.rpcUrl,
            blockTimeMs: runtimeTx.data.blockTimeMs,
            autoGrid: runtimeTx.data.autoGrid,
            env, // Pass env so grid entities get added to runtime
          });

          // Initialize jReplicas Map if it doesn't exist
          if (!env.jReplicas) {
            env.jReplicas = new Map();
          }

          // Capture initial stateRoot from EVM (for time travel)
          let stateRoot = new Uint8Array(32);
          if (xlnomy.evm?.captureStateRoot) {
            try {
              stateRoot = await xlnomy.evm.captureStateRoot();
              console.log(`[Runtime] Captured initial stateRoot: ${Buffer.from(stateRoot).toString('hex').slice(0, 16)}...`);
            } catch (e) {
              console.warn(`[Runtime] Could not capture stateRoot: ${e}`);
            }
          }

          // Create JReplica from Xlnomy
          const jReplica: JReplica = {
            name: xlnomy.name,
            blockNumber: BigInt(xlnomy.jMachine.jHeight),
            stateRoot,
            mempool: xlnomy.jMachine.mempool || [],
            blockDelayMs: 300,             // 300ms delay before processing mempool
            lastBlockTimestamp: env.timestamp,  // Use env.timestamp for determinism
            position: xlnomy.jMachine.position,
            contracts: xlnomy.contracts ? {
              depository: xlnomy.contracts.depository,
              entityProvider: xlnomy.contracts.entityProvider,
            } : undefined,
          };
          env.jReplicas.set(xlnomy.name, jReplica);

          // Set as active if it's the first one
          if (!env.activeJurisdiction) {
            env.activeJurisdiction = xlnomy.name;
          }

          console.log(`[Runtime] ✅ JReplica "${xlnomy.name}" created`);
          console.log(`[Runtime] Grid entities queued in runtimeInput: ${env.runtimeInput.runtimeTxs.length} txs`);
          console.log(`[Runtime] Active Jurisdiction: ${env.activeJurisdiction}`);
        } catch (error) {
          console.error(`[Runtime] ❌ Failed to create Xlnomy:`, error);
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

            // 🔭 J-machine tracking
            jBlock: 0, // Must start from 0 to resync all reserves

            // ⏰ Crontab system - will be initialized on first use
            crontabState: undefined,

            // 📦 J-Batch system - will be initialized on first use
            jBatchState: undefined,
          },
        };

        // Only add position if it exists (exactOptionalPropertyTypes compliance)
        if (runtimeTx.data.position) {
          replica.position = {
            ...runtimeTx.data.position,
            jurisdiction: runtimeTx.data.position.jurisdiction || runtimeTx.data.position.xlnomy || env.activeJurisdiction || 'default',
          };
        }

        env.eReplicas.set(replicaKey, replica);
        // Validate jBlock immediately after creation
        const createdReplica = env.eReplicas.get(replicaKey);
        const actualJBlock = createdReplica?.state.jBlock;
        // REPLICA-DEBUG removed

        // Broadcast initial profile to gossip layer
        if (env.gossip && createdReplica) {
          const profile = {
            entityId: runtimeTx.entityId,
            capabilities: [],
            hubs: [],
            metadata: {
              lastUpdated: Date.now(),
              routingFeePPM: 100, // Default 100 PPM (0.01%)
              baseFee: 0n,
            },
            accounts: [], // No accounts yet
          };
          env.gossip.announce(profile);
          // Broadcast log removed
        }

        if (typeof actualJBlock !== 'number') {
          logError("RUNTIME_TICK", `💥 ENTITY-CREATION-BUG: Just created entity with invalid jBlock!`);
          logError("RUNTIME_TICK", `💥   Expected: 0 (number), Got: ${typeof actualJBlock}, Value: ${actualJBlock}`);
          // Force fix immediately
          if (createdReplica) {
            createdReplica.state.jBlock = 0;
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
          if (entityInput.entityTxs!.length) console.log(`  → ${entityInput.entityTxs!.length} transactions`);
          if (entityInput.proposedFrame) console.log(`  → Proposed frame: ${entityInput.proposedFrame.hash}`);
          if (entityInput.precommits?.size) console.log(`  → ${entityInput.precommits.size} precommits`);
        }

        const { newState, outputs } = await applyEntityInput(env, entityReplica, entityInput);
        // APPLY-ENTITY-INPUT-RESULT removed - too noisy

        // IMMUTABILITY: Create fresh replica (working memory cleared, state updated)
        // applyEntityInput clones internally, so mempool/proposal mutations stay local
        // Reset working memory to prevent stale data from previous frames
        env.eReplicas.set(replicaKey, {
          ...entityReplica,
          state: newState,
          mempool: [], // Fresh mempool (applyEntityInput already processed txs)
          proposal: undefined, // Clear proposal after commit
          lockedFrame: undefined, // Clear lock
          sentTransitions: 0 // Reset counter
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
        // ENTITY-OUTBOX log removed - too noisy
      }
    }

    // Only create runtime frame if there's actual work to do
    const hasRuntimeTxs = env.runtimeInput.runtimeTxs.length > 0;
    const hasEntityInputs = mergedInputs.length > 0;
    const hasOutputs = entityOutbox.length > 0;

    if (hasRuntimeTxs || hasEntityInputs || hasOutputs) {
      // Update env (mutable)
      env.height++;
      env.timestamp = Date.now();

      // Capture snapshot BEFORE clearing (to show what was actually processed)
      const inputDescription = `Tick ${env.height - 1}: ${env.runtimeInput.runtimeTxs.length} runtimeTxs, ${mergedInputs.length} merged entityInputs → ${entityOutbox.length} outputs`;
      const processedInput = {
        runtimeTxs: [...env.runtimeInput.runtimeTxs],
        entityInputs: [...mergedInputs], // Use merged inputs instead of raw inputs
      };

      // Clear processed data from env.runtimeInput
      env.runtimeInput.runtimeTxs.length = 0;
      env.runtimeInput.entityInputs.length = 0;

      // CRITICAL: Update JReplica stateRoots from BrowserVM BEFORE snapshot
      // Without this, time-travel shows stale EVM state from xlnomy creation
      const browserVM = getBrowserVMInstance();
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
        } catch (e) {
          // Silent fail - collaterals sync is optional for debugging
          console.warn('[Runtime] Failed to sync BrowserVM state:', e);
        }
      }

      // Capture snapshot with the actual processed input and outputs
      await captureSnapshot(env, env.history, db, processedInput, entityOutbox, inputDescription);
    } else {
      console.log(`⚪ SKIP-FRAME: No runtimeTxs, entityInputs, or outputs - not creating empty frame`);
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
          `  ${i + 1}. → ${output.signerId} (${output.entityTxs ? `${output.entityTxs.length} txs` : ''}${output.proposedFrame ? ` proposal: ${output.proposedFrame.hash.slice(0, 10)}...` : ''}${output.precommits ? ` ${output.precommits.size} precommits` : ''})`,
        );
      });
    } else if (DEBUG && entityOutbox.length === 0) {
      console.log(`📤 No outputs generated`);
    }

    // Replica states dump removed - too verbose

    // Always notify UI after processing a frame (this is the discrete simulation step)
    notifyEnvChange(env);

    // Performance logging
    const endTime = Date.now();
    if (DEBUG) {
      console.log(`⏱️  Tick ${env.height - 1} completed in ${endTime - startTime}ms`);
    }

    // APPLY-SERVER-INPUT-FINAL-RETURN removed
    return { entityOutbox, mergedInputs };
  } catch (error) {
    log.error(`❌ Error processing runtime input:`, error);
    return { entityOutbox: [], mergedInputs: [] };
  }
};

// This is the new, robust main function that replaces the old one.
const main = async (): Promise<Env> => {
  console.log('🚀 RUNTIME.JS VERSION: 2025-10-05-16:45 - GRID POSITIONS + ACTIVITY HIGHLIGHTS');

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

  // First, create default environment with gossip layer
  env = {
    eReplicas: new Map(),
    jReplicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    history: [],
    gossip: gossipLayer,
    frameLogs: [],
  };

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
        if (latestSnapshot.eReplicas instanceof Map) {
          eReplicasMap = latestSnapshot.eReplicas;
        } else if (latestSnapshot.eReplicas && typeof latestSnapshot.eReplicas === 'object') {
          // Deserialized from DB - convert object to Map
          eReplicasMap = new Map(Object.entries(latestSnapshot.eReplicas));
        } else {
          console.warn('⚠️ Invalid eReplicas format in snapshot, using fresh environment');
          throw new Error('LEVEL_NOT_FOUND');
        }
      } catch (conversionError) {
        logError("RUNTIME_TICK", '❌ Failed to convert eReplicas to Map:', conversionError);
        console.warn('⚠️ Falling back to fresh environment');
        throw new Error('LEVEL_NOT_FOUND');
      }

      // Convert jReplicas array to Map
      const jReplicasMap = new Map<string, JReplica>();
      if (latestSnapshot.jReplicas) {
        for (const jr of latestSnapshot.jReplicas) {
          jReplicasMap.set(jr.name, {
            ...jr,
            stateRoot: new Uint8Array(jr.stateRoot), // Ensure proper Uint8Array
          });
        }
      }

      env = {
        // CRITICAL: Clone the eReplicas Map to avoid mutating snapshot data!
        eReplicas: new Map(Array.from(eReplicasMap).map(([key, replica]): [string, EntityReplica] => {
          return [key, cloneEntityReplica(replica)];
        })),
        jReplicas: jReplicasMap,
        height: latestSnapshot.height,
        timestamp: latestSnapshot.timestamp,
        // CRITICAL: runtimeInput must start EMPTY on restore!
        // The snapshot's runtimeInput was already processed
        runtimeInput: {
          runtimeTxs: [],
          entityInputs: []
        },
        history: snapshots, // Include the loaded history
        gossip: gossipLayer, // Use restored gossip layer
        frameLogs: [],
      };
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
    console.log(`🔍 BROWSER-DEBUG: Final state before j-watcher start:`);
    console.log(`🔍   Environment height: ${env.height}`);
    console.log(`🔍   Total replicas: ${env.eReplicas.size}`);
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const { entityId, signerId } = parseReplicaKey(replicaKey);
      console.log(`🔍   Entity ${entityId.slice(0,10)}... (${signerId}): jBlock=${replica.state.jBlock}, isProposer=${replica.isProposer}`);
    }
  }

  // DISABLED: J-watcher temporarily disabled (external RPC not needed for demo)
  // Re-enable by uncommenting this block when blockchain integration is needed
  /*
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
  */
  console.log('🔭 J-WATCHER: Disabled (external RPC not needed for simnet demo)');

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
      if (replica.state.entityId < counterpartyId) {
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
    timestamp: Date.now(),
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
          jBlock: replica.state.jBlock,
        };
      }),
    nextSyncIn: Math.floor((1000 - (Date.now() % 1000)) / 100) / 10, // Seconds until next 1s sync
  };
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
  // Blockchain registration functions
  registerNumberedEntityOnChain,
  requestNamedEntity,
  resolveEntityIdentifier,
  resolveEntityName,
  runDemo,
  runDemoWrapper,
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

// The browser-specific auto-execution logic has been removed.
// The consuming application (e.g., index.html) is now responsible for calling main().

// --- Node.js auto-execution for local testing ---
// This part will only run when the script is executed directly in Node.js.
if (!isBrowser) {
  main()
    .then(async env => {
      if (env) {
        // Check if demo should run automatically (can be disabled with NO_DEMO=1)
        const noDemoFlag = globalThis.process.env['NO_DEMO'] === '1' || globalThis.process.argv.includes('--no-demo');

        if (!noDemoFlag) {
          console.log('✅ Node.js environment initialized. Running demo for local testing...');
          console.log('💡 To skip demo, use: NO_DEMO=1 bun run src/runtime.ts or --no-demo flag');
          await runDemo(env);

          // Start j-watcher after demo completes
          await startJEventWatcher(env);

          // Add a small delay to ensure demo completes before verification
          setTimeout(async () => {
            await verifyJurisdictionRegistrations();
          }, 2000);
        } else {
          console.log('✅ Node.js environment initialized. Demo skipped (NO_DEMO=1 or --no-demo)');
          console.log('💡 Use XLN.runDemo(env) to run demo manually if needed');
          
          // J-watcher is already started in main(), no need to start again
        }
      }
    })
    .catch(error => {
      logError("RUNTIME_TICK", '❌ An error occurred during Node.js auto-execution:', error);
    });
}

// === BLOCKCHAIN VERIFICATION ===
const verifyJurisdictionRegistrations = async () => {
  console.log('\n🔍 === JURISDICTION VERIFICATION ===');
  console.log('📋 Verifying entity registrations across all jurisdictions...\n');

  const jurisdictions = await getAvailableJurisdictions();

  for (const jurisdiction of jurisdictions) {
    try {
      console.log(`🏛️ ${jurisdiction.name}:`);
      console.log(`   📡 RPC: ${jurisdiction.address}`);
      console.log(`   📄 Contract: ${jurisdiction.entityProviderAddress}`);

      // Connect to this jurisdiction's network
      const { entityProvider } = await connectToEthereum(jurisdiction);

      // Get next entity number (indicates how many are registered)
      const nextNumber = await entityProvider['nextNumber']!();
      const registeredCount = Number(nextNumber) - 1;

      console.log(`   📊 Registered Entities: ${registeredCount}`);

      // Read registered entities
      if (registeredCount > 0) {
        console.log(`   📝 Entity Details:`);
        for (let i = 1; i <= registeredCount; i++) {
          try {
            const entityId = generateNumberedEntityId(i);
            const entityInfo = await entityProvider['entities']!(entityId);
            console.log(`      #${i}: ${entityId.slice(0, 10)}... (Block: ${entityInfo.registrationBlock})`);
          } catch (error) {
            console.log(`      #${i}: Error reading entity data`);
          }
        }
      }

      console.log('');
    } catch (error) {
      logError("RUNTIME_TICK", `   ❌ Failed to verify ${jurisdiction.name}:`, error instanceof Error ? error.message : error);
      console.log('');
    }
  }

  console.log('✅ Jurisdiction verification complete!\n');
};

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

// Create a wrapper for runDemo that provides better browser feedback
const runDemoWrapper = async (env: Env): Promise<Env> => {
  try {
    console.log('🚀 Starting XLN Consensus Demo...');
    console.log('📊 This will demonstrate entity creation, consensus, and message passing');

    const result = await runDemo(env);

    console.log('✅ XLN Demo completed successfully!');
    console.log('🎯 Check the entity cards above to see the results');
    console.log('🕰️ Use the time machine to replay the consensus steps');

    // J-watcher is already started in main(), no need to start again

    return result;
  } catch (error) {
    logError("RUNTIME_TICK", '❌ XLN Demo failed:', error);
    throw error;
  }
};

// === ENVIRONMENT UTILITIES ===
// Global reference to current env for log capturing
let currentEnvForLogs: Env | null = null;

export const createEmptyEnv = (): Env => {
  const env: Env = {
    eReplicas: new Map(),
    jReplicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    history: [],
    gossip: createGossipLayer(),
    frameLogs: [],
  };

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
          timestamp: Date.now(),
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
          timestamp: Date.now(),
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
          timestamp: Date.now(),
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
  // Lock: prevent interleaving
  if (processing) {
    console.warn('⏸️ SKIP: Previous tick still processing');
    return env;
  }

  processing = true;

  // Merge pending outputs from previous tick with new inputs
  const allInputs = [...(env.pendingOutputs || []), ...(inputs || [])];
  env.pendingOutputs = [];

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
    if (allInputs.length > 0) {
      console.log(`📥 TICK: Processing ${allInputs.length} inputs for [${allInputs.map(o => o.entityId.slice(-4)).join(',')}]`);

      const result = await applyRuntimeInput(env, { runtimeTxs: [], entityInputs: allInputs });

      // Store outputs for NEXT tick (never process in same tick)
      env.pendingOutputs = result.entityOutbox;

      if (result.entityOutbox.length > 0) {
        console.log(`📤 TICK: ${result.entityOutbox.length} outputs queued for next tick → [${result.entityOutbox.map(o => o.entityId.slice(-4)).join(',')}]`);
      }
    }

    // === J-MACHINE BLOCK PROPOSAL CHECK ===
    // Check if any J-Machine should propose a block based on blockDelayMs
    if (env.jReplicas) {
      for (const jReplica of env.jReplicas.values()) {
        const mempool = jReplica.mempool || [];
        const blockDelayMs = jReplica.blockDelayMs || 300;
        const lastBlockTs = jReplica.lastBlockTimestamp || 0;
        const elapsed = env.timestamp - lastBlockTs;

        // If mempool has items AND block delay has passed
        if (mempool.length > 0 && elapsed >= blockDelayMs) {
          console.log(`⏰ [J-Machine ${jReplica.name}] Block ready! ${mempool.length} txs pending, ${elapsed}ms since last block`);
          // Mark jReplica as ready for block (UI can read this)
          jReplica.blockReady = true;
        } else {
          jReplica.blockReady = false;
        }
      }
    }

    // Auto-persist
    await saveEnvToDB(env);
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
    const snapshot = JSON.stringify(env, (k, v) => {
      return typeof v === 'bigint' ? String(v) :
        v instanceof Uint8Array ? Array.from(v) :
        v instanceof Map ? Array.from(v.entries()) : v;
    });
    await db.put(Buffer.from(`snapshot:${env.height}`), Buffer.from(snapshot));
  } catch (err) {
    console.error('❌ Failed to save to LevelDB:', err);
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
      const env = createEmptyEnv();
      env.height = BigInt(data.height || 0);
      env.timestamp = BigInt(data.timestamp || 0);
      // Support both old (replicas) and new (eReplicas) format
      env.eReplicas = new Map(data.eReplicas || data.replicas || []);
      // Load jReplicas if present
      if (data.jReplicas) {
        env.jReplicas = new Map(data.jReplicas.map((jr: JReplica) => [jr.name, jr]));
      }
      if (data.gossip?.profiles) {
        env.gossip.profiles = new Map(data.gossip.profiles);
      }
      history.push(env);
    }

    const latestEnv = history[history.length - 1];
    if (latestEnv) {
      latestEnv.history = history;
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
import { prepopulate as prepopulateImpl } from './prepopulate';
import { prepopulateAHB as prepopulateAHBImpl } from './prepopulate-ahb';
import { prepopulateFullMechanics as prepopulateFullMechanicsImpl } from './prepopulate-full-mechanics';

// Re-export prepopulate functions (they use lazy-loaded process internally)
export const prepopulate = async (env: Env): Promise<Env> => {
  await prepopulateImpl(env);
  return env;
};

export const prepopulateAHB = async (passedEnv: Env): Promise<Env> => {
  // Sync module-level env with passed env so j-watcher events route correctly
  env = passedEnv;
  console.log('🌍 Module-level env synced with frontend env');
  await prepopulateAHBImpl(passedEnv);
  return passedEnv;
};

export const prepopulateFullMechanics = async (env: Env): Promise<Env> => {
  await prepopulateFullMechanicsImpl(env);
  return env;
};

// === SCENARIO SYSTEM ===
export { parseScenario, mergeAndSortEvents } from './scenarios/parser.js';
export { executeScenario } from './scenarios/executor.js';
export { loadScenarioFromFile, loadScenarioFromText } from './scenarios/loader.js';

// === NAME RESOLUTION WRAPPERS (override imports) ===
const searchEntityNames = (query: string, limit?: number) => searchEntityNamesOriginal(db, query, limit);
const resolveEntityName = (entityId: string) => resolveEntityNameOriginal(db, entityId);
const getEntityDisplayInfoFromProfile = (entityId: string) => getEntityDisplayInfoFromProfileOriginal(db, entityId);

// Avatar functions are already imported and exported above
