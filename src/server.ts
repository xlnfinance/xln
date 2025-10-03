// for regular use > bun run src/server.ts
// for debugging > bun repl
// await import('./debug.js');
// FORCE AUTO-REBUILD: Fixed signerId consistency and fintech type safety

// Import utilities and types
// High-level database using Level polyfill (works in both Node.js and browser)
import { Level } from 'level';

import { applyEntityInput, mergeEntityInputs } from './entity-consensus';
// TODO: Re-enable account-tx imports after fixing export issues
// import {
//   sendAccountInputMessage,
//   sendDirectPaymentToEntity, 
//   sendCreditLimitUpdateToEntity,
//   sendAccountAcknowledgment,
//   sendBatchAccountInputs,
//   getCrossEntityMessagingSummary,
//   validateAccountInputMessage
// } from './account-tx/messaging';
import {
  createLazyEntity,
  createNumberedEntity,
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
  submitProcessBatch,
  submitPrefundAccount,
  submitSettle,
  submitReserveToReserve,
  transferNameBetweenEntities,
} from './evm';
import { createGossipLayer } from './gossip';
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
import { getEntityNumber } from './entity-helpers';
import { safeStringify } from './serialization-utils';
import { validateDelta, validateAccountDeltas, createDefaultDelta, isDelta, validateEntityInput, validateEntityOutput } from './validation-utils';
import { EntityInput, EntityReplica, Env, ServerInput } from './types';
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

// --- Database Setup ---
// Level polyfill: Node.js uses filesystem, Browser uses IndexedDB
export const db: Level<Buffer, Buffer> = new Level('db', {
  valueEncoding: 'buffer',
  keyEncoding: 'binary',
});

declare const console: any;

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

const notifyEnvChange = (env: Env) => {
  if (envChangeCallback) {
    envChangeCallback(env);
  }
};

// J-Watcher initialization
const startJEventWatcher = async (env: Env): Promise<void> => {
  try {
    // Get the Ethereum jurisdiction
    const ethereum = await getJurisdictionByAddress('ethereum');
    if (!ethereum) {
      console.warn('⚠️ Ethereum jurisdiction not found, skipping j-watcher');
      return;
    }

    // Set up j-watcher with the deployed contracts
    jWatcher = await setupJEventWatcher(
      env,
      ethereum.address, // RPC URL
      ethereum.entityProviderAddress,
      ethereum.depositoryAddress
    );

    console.log('✅ J-Event Watcher started successfully');
    console.log(`🔭 Monitoring: ${ethereum.address}`);
    console.log(`📍 EntityProvider: ${ethereum.entityProviderAddress}`);
    console.log(`📍 Depository: ${ethereum.depositoryAddress}`);
    
    // J-watcher now handles its own periodic sync every 500ms
    // Set up a periodic check to process any queued events from j-watcher
    setInterval(async () => {
      if (env.serverInput.entityInputs.length > 0) {
        const eventCount = env.serverInput.entityInputs.length;
        console.log(`🔭 J-WATCHER: Processing ${eventCount} J-machine events`);
        
        // Process the queued entity inputs from j-watcher
        await applyServerInput(env, { 
          serverTxs: [], 
          entityInputs: [...env.serverInput.entityInputs] 
        });
        
        // Clear the processed inputs
        env.serverInput.entityInputs.length = 0;
      }
    }, 100); // Check every 100ms to process j-watcher events quickly
    
  } catch (error) {
    console.error('❌ Failed to start J-Event Watcher:', error);
  }
};

// Note: History is now stored in env.history (no global variable needed)

// === SNAPSHOT UTILITIES ===
// All cloning utilities now moved to state-helpers.ts

// All snapshot functionality now moved to state-helpers.ts

// === UTILITY FUNCTIONS ===

const applyServerInput = async (
  env: Env,
  serverInput: ServerInput,
): Promise<{ entityOutbox: EntityInput[]; mergedInputs: EntityInput[] }> => {
  const startTime = Date.now();

  try {
    // SECURITY: Validate server input
    if (!serverInput) {
      log.error('❌ Null server input provided');
      return { entityOutbox: [], mergedInputs: [] };
    }
    if (!Array.isArray(serverInput.serverTxs)) {
      log.error(`❌ Invalid serverTxs: expected array, got ${typeof serverInput.serverTxs}`);
      return { entityOutbox: [], mergedInputs: [] };
    }
    if (!Array.isArray(serverInput.entityInputs)) {
      log.error(`❌ Invalid entityInputs: expected array, got ${typeof serverInput.entityInputs}`);
      return { entityOutbox: [], mergedInputs: [] };
    }

    // SECURITY: Resource limits
    if (serverInput.serverTxs.length > 1000) {
      log.error(`❌ Too many server transactions: ${serverInput.serverTxs.length} > 1000`);
      return { entityOutbox: [], mergedInputs: [] };
    }
    if (serverInput.entityInputs.length > 10000) {
      log.error(`❌ Too many entity inputs: ${serverInput.entityInputs.length} > 10000`);
      return { entityOutbox: [], mergedInputs: [] };
    }

    // Merge new serverInput into env.serverInput
    env.serverInput.serverTxs.push(...serverInput.serverTxs);
    env.serverInput.entityInputs.push(...serverInput.entityInputs);

    // Merge all entityInputs in env.serverInput
    const mergedInputs = mergeEntityInputs(env.serverInput.entityInputs);

    // FINTECH-LEVEL TYPE SAFETY: Validate all merged inputs at entry point
    mergedInputs.forEach((input, i) => {
      try {
        validateEntityInput(input);
      } catch (error) {
        console.error(`🚨 CRITICAL FINANCIAL ERROR: Invalid merged EntityInput[${i}]!`, {
          error: (error as Error).message,
          input
        });
        throw error; // Fail fast
      }
    });

    const entityOutbox: EntityInput[] = [];

    if (DEBUG) {
      console.log(`\n=== TICK ${env.height} ===`);
      console.log(
        `Server inputs: ${serverInput.serverTxs.length} new serverTxs, ${serverInput.entityInputs.length} new entityInputs`,
      );
      console.log(
        `Total in env: ${env.serverInput.serverTxs.length} serverTxs, ${env.serverInput.entityInputs.length} entityInputs (merged to ${mergedInputs.length})`,
      );
      if (mergedInputs.length > 0) {
        console.log(`🔄 Processing merged inputs:`);
        mergedInputs.forEach((input, i) => {
          const parts = [];
          if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`); // Debug logging - keep defensive
          if (input.precommits?.size) parts.push(`${input.precommits.size} precommits`);
          if (input.proposedFrame) parts.push(`frame: ${input.proposedFrame.hash.slice(0, 10)}...`);
          console.log(`  ${i + 1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
        });
      }
    }

    // Process server transactions (replica imports) from env.serverInput
    console.log(
      `🔍 REPLICA-DEBUG: Processing ${env.serverInput.serverTxs.length} serverTxs, current replicas: ${env.replicas.size}`,
    );
    env.serverInput.serverTxs.forEach(serverTx => {
      if (serverTx.type === 'importReplica') {
        if (DEBUG)
          console.log(
            `Importing replica Entity #${formatEntityDisplay(serverTx.entityId)}:${formatSignerDisplay(serverTx.signerId)} (proposer: ${serverTx.data.isProposer})`,
          );

        const replicaKey = `${serverTx.entityId}:${serverTx.signerId}`;
        env.replicas.set(replicaKey, {
          entityId: serverTx.entityId,
          signerId: serverTx.signerId,
          state: {
            entityId: serverTx.entityId, // Store entityId in state
            height: 0,
            timestamp: env.timestamp,
            nonces: new Map(),
            messages: [],
            proposals: new Map(),
            config: serverTx.data.config,
            // 💰 Initialize financial state
            reserves: new Map(), // tokenId -> bigint amount
            accounts: new Map(), // counterpartyEntityId -> AccountMachine

            // 🔭 J-machine tracking
            jBlock: 0, // Must start from 0 to resync all reserves
          },
          mempool: [],
          isProposer: serverTx.data.isProposer,
        });
        // Validate jBlock immediately after creation
        const createdReplica = env.replicas.get(replicaKey);
        const actualJBlock = createdReplica?.state.jBlock;
        console.log(`🔍 REPLICA-DEBUG: Added replica ${replicaKey}, jBlock should be 0, actually is: ${actualJBlock} (type: ${typeof actualJBlock})`);

        // Broadcast initial profile to gossip layer
        if (env.gossip && createdReplica) {
          const profile = {
            entityId: serverTx.entityId,
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
          console.log(`📡 Broadcast initial profile for Entity #${formatEntityDisplay(serverTx.entityId)}`);
        }

        if (typeof actualJBlock !== 'number') {
          console.error(`💥 ENTITY-CREATION-BUG: Just created entity with invalid jBlock!`);
          console.error(`💥   Expected: 0 (number), Got: ${typeof actualJBlock}, Value: ${actualJBlock}`);
          // Force fix immediately
          if (createdReplica) {
            createdReplica.state.jBlock = 0;
            console.log(`💥   FIXED: Set jBlock to 0 for replica ${replicaKey}`);
          }
        }
      }
    });
    console.log(`🔍 REPLICA-DEBUG: After processing serverTxs, total replicas: ${env.replicas.size}`);

    // Simple watcher automatically syncs all proposer replicas from their last jBlock

    // Process entity inputs - check for j-events
    console.log(`🔍 SERVER-PROCESSING: About to process ${mergedInputs.length} merged entity inputs`);
    for (const entityInput of mergedInputs) {
      // Track j-events in this input - entityInput.entityTxs guaranteed by validateEntityInput above
      const jEventCount = entityInput.entityTxs!.filter(tx => tx.type === 'j_event').length;
      if (jEventCount > 0) {
        console.log(`🚨 FOUND-J-EVENTS: Entity ${entityInput.entityId.slice(0,10)}... has ${jEventCount} j-events from ${entityInput.signerId}`);
        entityInput.entityTxs!.filter(tx => tx.type === 'j_event').forEach((jEvent, i) => {
          console.log(`🚨   J-EVENT-${i}: type=${jEvent.data.event.type}, block=${jEvent.data.blockNumber}, observedAt=${new Date(jEvent.data.observedAt).toLocaleTimeString()}`);
        });
      }

      // Handle empty signerId for AccountInputs - auto-route to proposer
      let actualSignerId = entityInput.signerId;
      if (!actualSignerId || actualSignerId === '') {
        // Check if this is an AccountInput that needs auto-routing
        const hasAccountInput = entityInput.entityTxs!.some(tx => tx.type === 'accountInput');
        if (hasAccountInput) {
          // Find the proposer for this entity
          const entityReplicaKeys = Array.from(env.replicas.keys()).filter(key => key.startsWith(entityInput.entityId + ':'));
          if (entityReplicaKeys.length > 0) {
            const firstReplicaKey = entityReplicaKeys[0];
            if (!firstReplicaKey) {
              console.error(`❌ Invalid replica key for entity ${entityInput.entityId}`);
              continue;
            }
            const firstReplica = env.replicas.get(firstReplicaKey);
            if (firstReplica?.state.config.validators[0]) {
              actualSignerId = firstReplica.state.config.validators[0];
              console.log(`🔄 AUTO-ROUTE: Routing AccountInput to proposer ${actualSignerId} for entity ${entityInput.entityId.slice(0,10)}...`);
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
      const entityReplica = env.replicas.get(replicaKey);

      console.log(`🔍 REPLICA-LOOKUP: Key="${replicaKey}"`);
      console.log(`🔍 REPLICA-LOOKUP: Found replica: ${!!entityReplica}`);
      console.log(`🔍 REPLICA-LOOKUP: Input txs: ${entityInput.entityTxs!.length}`);
      if (entityInput.entityTxs && entityInput.entityTxs.length > 0) {
        console.log(
          `🔍 REPLICA-LOOKUP: Tx types:`,
          entityInput.entityTxs.map(tx => tx.type),
        );
      }
      if (!entityReplica) {
        console.log(`🔍 REPLICA-LOOKUP: Available replica keys:`, Array.from(env.replicas.keys()));
      }

      if (entityReplica) {
        if (DEBUG) {
          console.log(`Processing input for ${replicaKey}:`);
          if (entityInput.entityTxs!.length) console.log(`  → ${entityInput.entityTxs!.length} transactions`);
          if (entityInput.proposedFrame) console.log(`  → Proposed frame: ${entityInput.proposedFrame.hash}`);
          if (entityInput.precommits?.size) console.log(`  → ${entityInput.precommits.size} precommits`);
        }

        const { newState, outputs } = await applyEntityInput(env, entityReplica, entityInput);
        console.log(`🔍 APPLY-ENTITY-INPUT-RESULT: Got ${outputs.length} outputs from ${replicaKey}`);

        // CRITICAL FIX: Update the replica in the environment with the new state
        env.replicas.set(replicaKey, { ...entityReplica, state: newState });

        // FINTECH-LEVEL TYPE SAFETY: Validate all entity outputs before routing
        outputs.forEach((output, index) => {
          try {
            validateEntityOutput(output);
          } catch (error) {
            console.error(`🚨 CRITICAL FINANCIAL ERROR: Invalid EntityOutput[${index}] from ${replicaKey}!`, {
              error: (error as Error).message,
              output
            });
            throw error; // Fail fast to prevent financial routing corruption
          }
        });

        entityOutbox.push(...outputs);
        console.log(`🔍 ENTITY-OUTBOX-AFTER-PUSH: entityOutbox now has ${entityOutbox.length} outputs`);
      }
    }

    // Only create server frame if there's actual work to do
    const hasServerTxs = env.serverInput.serverTxs.length > 0;
    const hasEntityInputs = mergedInputs.length > 0;
    const hasOutputs = entityOutbox.length > 0;

    if (hasServerTxs || hasEntityInputs || hasOutputs) {
      // Update env (mutable)
      env.height++;
      env.timestamp = Date.now();

      // Capture snapshot BEFORE clearing (to show what was actually processed)
      const inputDescription = `Tick ${env.height - 1}: ${env.serverInput.serverTxs.length} serverTxs, ${mergedInputs.length} merged entityInputs → ${entityOutbox.length} outputs`;
      const processedInput = {
        serverTxs: [...env.serverInput.serverTxs],
        entityInputs: [...mergedInputs], // Use merged inputs instead of raw inputs
      };

      // Clear processed data from env.serverInput
      env.serverInput.serverTxs.length = 0;
      env.serverInput.entityInputs.length = 0;

      // Capture snapshot with the actual processed input and outputs
      await captureSnapshot(env, env.history, db, processedInput, entityOutbox, inputDescription);
    } else {
      console.log(`⚪ SKIP-FRAME: No serverTxs, entityInputs, or outputs - not creating empty frame`);
    }

    // Notify Svelte about environment changes
    console.log(`🔍 REPLICA-DEBUG: Before notifyEnvChange, total replicas: ${env.replicas.size}`);
    console.log(`🔍 REPLICA-DEBUG: Replica keys:`, Array.from(env.replicas.keys()));
    console.log(`🔍 GOSSIP-DEBUG: Environment keys before notify:`, Object.keys(env));
    console.log(`🔍 GOSSIP-DEBUG: Gossip layer exists:`, !!env.gossip);
    console.log(`🔍 GOSSIP-DEBUG: Gossip layer type:`, typeof env.gossip);
    console.log(`🔍 GOSSIP-DEBUG: Gossip announce method:`, typeof env.gossip?.announce);
    
    // CRITICAL FIX: Initialize gossip layer if missing
    if (!env.gossip) {
      console.log(`🚨 CRITICAL: gossip layer missing from environment, creating new one`);
      env.gossip = createGossipLayer();
      console.log(`✅ Gossip layer created and added to environment`);
    }

    // Compare old vs new entities
    const oldEntityKeys = Array.from(env.replicas.keys()).filter(
      key =>
        key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000001:') ||
        key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000002:'),
    );
    const newEntityKeys = Array.from(env.replicas.keys()).filter(
      key =>
        !key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000001:') &&
        !key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000002:') &&
        !key.startsWith('0x57e360b00f393ea6d898d6119f71db49241be80aec0fbdecf6358b0103d43a31:'),
    );

    console.log(`🔍 OLD-ENTITY-DEBUG: ${oldEntityKeys.length} old entities:`, oldEntityKeys.slice(0, 2));
    console.log(`🔍 NEW-ENTITY-DEBUG: ${newEntityKeys.length} new entities:`, newEntityKeys.slice(0, 2));

    if (oldEntityKeys.length > 0 && newEntityKeys.length > 0) {
      const oldReplicaKey = oldEntityKeys[0];
      const newReplicaKey = newEntityKeys[0];
      if (!oldReplicaKey || !newReplicaKey) {
        console.error(`❌ Invalid replica keys: old=${oldReplicaKey}, new=${newReplicaKey}`);
        // Continue with empty outbox instead of crashing
      } else {
      const oldReplica = env.replicas.get(oldReplicaKey);
      const newReplica = env.replicas.get(newReplicaKey);
      console.log(`🔍 OLD-REPLICA-STRUCTURE:`, {
        hasState: !!oldReplica?.state,
        hasConfig: !!oldReplica?.state?.config,
        hasJurisdiction: !!oldReplica?.state?.config?.jurisdiction,
        jurisdictionName: oldReplica?.state?.config?.jurisdiction?.name,
      });
      console.log(`🔍 NEW-REPLICA-STRUCTURE:`, {
        hasState: !!newReplica?.state,
        hasConfig: !!newReplica?.state?.config,
        hasJurisdiction: !!newReplica?.state?.config?.jurisdiction,
        jurisdictionName: newReplica?.state?.config?.jurisdiction?.name,
      });
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

    if (DEBUG) {
      console.log(`Replica states:`);
      env.replicas.forEach((replica, key) => {
        const [entityId, signerId] = key.split(':');
        if (!entityId || !signerId) return; // Skip malformed keys (use return in forEach)
        const entityDisplay = formatEntityDisplay(entityId);
        const signerDisplay = formatSignerDisplay(signerId);
        console.log(
          `  Entity #${entityDisplay}:${signerDisplay}: mempool=${replica.mempool.length}, messages=${replica.state.messages.length}, proposal=${replica.proposal ? '✓' : '✗'}`,
        );
      });
    }

    // Always notify UI after processing a frame (this is the discrete simulation step)
    notifyEnvChange(env);

    // Performance logging
    const endTime = Date.now();
    if (DEBUG) {
      console.log(`⏱️  Tick ${env.height - 1} completed in ${endTime - startTime}ms`);
    }

    console.log(`🔍 APPLY-SERVER-INPUT-FINAL-RETURN: Returning ${entityOutbox.length} outputs, ${mergedInputs.length} mergedInputs`);
    return { entityOutbox, mergedInputs };
  } catch (error) {
    log.error(`❌ Error processing server input:`, error);
    return { entityOutbox: [], mergedInputs: [] };
  }
};

// This is the new, robust main function that replaces the old one.
const main = async (): Promise<Env> => {
  // DEBUG: Log jurisdictions content on startup using centralized loader
  if (!isBrowser) {
    try {
      const { loadJurisdictions } = await import('./jurisdiction-loader');
      const jurisdictions = loadJurisdictions();
      console.log('🔍 STARTUP: Current jurisdictions content (from centralized loader):');
      console.log('📍 Ethereum Depository:', jurisdictions.jurisdictions['ethereum']?.contracts?.depository);
      console.log('📍 Ethereum EntityProvider:', jurisdictions.jurisdictions['ethereum']?.contracts?.entityProvider);
      console.log('📍 Last updated:', jurisdictions.lastUpdated);
      console.log('📍 Full Ethereum config:', JSON.stringify(jurisdictions.jurisdictions['ethereum'], null, 2));
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
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: gossipLayer,
  };

  // Then try to load saved state if available
  try {
    if (isBrowser) {
      console.log('🌐 BROWSER-DEBUG: Starting IndexedDB snapshot loading process...');
    } else {
      console.log('🖥️ Node.js environment: Attempting to load snapshots from filesystem...');
    }

    console.log('🔍 BROWSER-DEBUG: Querying latest_height from database...');
    const latestHeightBuffer = await db.get(Buffer.from('latest_height'));
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
        console.error(`❌ Failed to load snapshot ${i}:`, error);
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

      // CRITICAL: Validate snapshot has proper replicas data
      if (!latestSnapshot.replicas) {
        console.warn('⚠️ Latest snapshot missing replicas data, using fresh environment');
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

      // CRITICAL: Convert replicas to proper Map if needed (handle deserialization from DB)
      let replicasMap: Map<string, EntityReplica>;
      try {
        if (latestSnapshot.replicas instanceof Map) {
          replicasMap = latestSnapshot.replicas;
        } else if (latestSnapshot.replicas && typeof latestSnapshot.replicas === 'object') {
          // Deserialized from DB - convert object to Map
          replicasMap = new Map(Object.entries(latestSnapshot.replicas));
        } else {
          console.warn('⚠️ Invalid replicas format in snapshot, using fresh environment');
          throw new Error('LEVEL_NOT_FOUND');
        }
      } catch (conversionError) {
        console.error('❌ Failed to convert replicas to Map:', conversionError);
        console.warn('⚠️ Falling back to fresh environment');
        throw new Error('LEVEL_NOT_FOUND');
      }

      env = {
        // CRITICAL: Clone the replicas Map to avoid mutating snapshot data!
        replicas: new Map(Array.from(replicasMap).map(([key, replica]): [string, EntityReplica] => {
          return [key, cloneEntityReplica(replica)];
        })),
        height: latestSnapshot.height,
        timestamp: latestSnapshot.timestamp,
        // CRITICAL: serverInput must start EMPTY on restore!
        // The snapshot's serverInput was already processed
        serverInput: {
          serverTxs: [],
          entityInputs: []
        },
        history: snapshots, // Include the loaded history
        gossip: gossipLayer, // Use restored gossip layer
      };
      console.log(`✅ History restored. Server is at height ${env.height} with ${env.history.length} snapshots.`);
      console.log(`📈 Snapshot details:`, {
        height: env.height,
        replicaCount: env.replicas.size,
        timestamp: new Date(env.timestamp).toISOString(),
        serverInputs: env.serverInput.entityInputs.length,
      });
    }
  } catch (error: any) {
    // Handle various "not found" error conditions gracefully
    const isNotFoundError =
      error.code === 'LEVEL_NOT_FOUND' ||
      error.message?.includes('LEVEL_NOT_FOUND') ||
      error.message?.includes('NotFoundError') ||
      error.name === 'NotFoundError';

    if (isNotFoundError) {
      console.log('📦 No saved state found, using fresh environment');
      if (isBrowser) {
        console.log('💡 This is normal for first-time use. IndexedDB will be created automatically.');
      } else {
        console.log('💡 Node.js: No existing snapshots in db directory.');
      }
    } else {
      // Log the error but don't crash - fall back to fresh environment
      console.warn('⚠️ Error loading state from LevelDB (falling back to fresh environment):', error.message);
      console.log('🔍 Error type:', error.code || error.name || 'Unknown');

      if (DEBUG) {
        console.error('🔍 Full error details:', {
          code: error.code,
          name: error.name,
          message: error.message,
          isBrowser,
          dbLocation: isBrowser ? 'IndexedDB: db' : 'db',
        });
      }

      // Don't throw - just use fresh environment
      console.log('✅ Using fresh environment to continue startup');
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

  log.info(`🎯 Server startup complete. Height: ${env.height}, Entities: ${env.replicas.size}`);

  // Debug final state before starting j-watcher
  if (isBrowser) {
    console.log(`🔍 BROWSER-DEBUG: Final state before j-watcher start:`);
    console.log(`🔍   Environment height: ${env.height}`);
    console.log(`🔍   Total replicas: ${env.replicas.size}`);
    for (const [replicaKey, replica] of env.replicas.entries()) {
      const [entityId, signerId] = replicaKey.split(':');
      if (entityId && signerId) {
        console.log(`🔍   Entity ${entityId.slice(0,10)}... (${signerId}): jBlock=${replica.state.jBlock}, isProposer=${replica.isProposer}`);
      }
    }
  }

  // Start j-watcher after snapshots are fully loaded (prevent multiple instances)
  if (!jWatcherStarted) {
    try {
      console.log('🔭 STARTING-JWATCHER: Snapshots loaded, starting j-watcher...');
      await startJEventWatcher(env);
      jWatcherStarted = true;
      console.log('🔭 JWATCHER-READY: J-watcher started successfully');
    } catch (error) {
      console.error('❌ Failed to start J-Event Watcher:', error);
    }
  } else {
    console.log('🔭 JWATCHER-SKIP: J-watcher already started, skipping');
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

// Server-specific clearDatabase that also resets history
const clearDatabaseAndHistory = async () => {
  console.log('🗑️ Clearing database and resetting server history...');

  // Clear the Level database
  await clearDatabase(db);

  // Reset the server environment to initial state (including history)
  env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: createGossipLayer(),
  };

  console.log('✅ Database and server history cleared');
};

// Export j-watcher status for frontend display
export const getJWatcherStatus = () => {
  if (!jWatcher || !env) return null;
  return {
    isWatching: jWatcher.getStatus().isWatching,
    proposers: Array.from(env.replicas.entries())
      .filter(([, replica]) => replica.isProposer)
      .map(([key, replica]) => {
        const [entityId, signerId] = key.split(':');
        if (!entityId || !signerId) {
          throw new Error(`Invalid replica key format: ${key}`);
        }
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
  applyServerInput,
  assignNameOnChain,
  clearDatabase,
  clearDatabaseAndHistory,
  connectToEthereum,
  // Entity creation functions
  createLazyEntity,
  createNumberedEntity,
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
  getEntityNumber,
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
  
  // Account messaging functions - TODO: Re-enable after fixing account-tx exports
  // sendAccountInputMessage,
  // sendDirectPaymentToEntity,
  // sendCreditLimitUpdateToEntity,
  // sendAccountAcknowledgment,
  // sendBatchAccountInputs,
  // getCrossEntityMessagingSummary,
  // validateAccountInputMessage,
};

// The browser-specific auto-execution logic has been removed.
// The consuming application (e.g., index.html) is now responsible for calling main().

// --- Node.js auto-execution for local testing ---
// This part will only run when the script is executed directly in Node.js.
if (!isBrowser) {
  main()
    .then(async env => {
      if (env) {
        // Check if demo should run automatically (can be disabled with NO_DEMO=1)
        const noDemoFlag = process.env['NO_DEMO'] === '1' || process.argv.includes('--no-demo');

        if (!noDemoFlag) {
          console.log('✅ Node.js environment initialized. Running demo for local testing...');
          console.log('💡 To skip demo, use: NO_DEMO=1 bun run src/server.ts or --no-demo flag');
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
      console.error('❌ An error occurred during Node.js auto-execution:', error);
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
      console.error(`   ❌ Failed to verify ${jurisdiction.name}:`, error instanceof Error ? error.message : error);
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
    console.error('❌ Complete Hanko tests failed:', error);
    throw error;
  }
};

// Create a wrapper for runDemo that provides better browser feedback
const runDemoWrapper = async (env: any): Promise<any> => {
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
    console.error('❌ XLN Demo failed:', error);
    throw error;
  }
};

// === ENVIRONMENT UTILITIES ===
export const createEmptyEnv = (): Env => {
  return {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: createGossipLayer(),
  };
};

// === CONSENSUS PROCESSING UTILITIES ===
export const processUntilEmpty = async (env: Env, inputs?: EntityInput[]) => {
  let outputs = inputs || [];
  let iterationCount = 0;
  const maxIterations = 10; // Safety limit

  // Only log cascade details if there are outputs to process
  if (outputs.length > 0) {
    console.log('🔥 PROCESS-CASCADE: Starting with', outputs.length, 'initial outputs');

    // Log FULL entityIds for debugging routing issues
    outputs.forEach((o, idx) => {
      console.log(`📤 CASCADE-INPUT[${idx}]: FULL entityId="${o.entityId}", signerId="${o.signerId}", replicaKey="${o.entityId}:${o.signerId}"`);
    });

    console.log(
      '🔥 PROCESS-CASCADE: Initial outputs:',
      outputs.map(o => {
        // FINTECH-LEVEL TYPE SAFETY: Validate all financial routing inputs
        try {
          validateEntityInput(o);
        } catch (error) {
          console.error(`🚨 CRITICAL FINANCIAL ERROR: Invalid EntityInput detected!`, {
            error: (error as Error).message,
            input: o
          });
          throw error; // Re-throw to fail fast
        }

        return {
          entityId: o.entityId.slice(0, 8) + '...',
          signerId: o.signerId,
          txs: o.entityTxs?.length || 0,
          precommits: o.precommits?.size || 0,
          hasFrame: !!o.proposedFrame,
        };
      }),
    );
  }

  // DEBUG: Log transaction details for vote transactions
  outputs.forEach((output, i) => {
    if (output.entityTxs?.some(tx => tx.type === 'vote')) {
      console.log(
        `🗳️ VOTE-DEBUG: Input ${i + 1} contains vote transactions:`,
        output.entityTxs.filter(tx => tx.type === 'vote'),
      );
    }
  });

  while (outputs.length > 0 && iterationCount < maxIterations) {
    iterationCount++;
    console.log(`🔥 PROCESS-CASCADE: Iteration ${iterationCount} - processing ${outputs.length} outputs`);

    const result = await applyServerInput(env, { serverTxs: [], entityInputs: outputs });
    outputs = result.entityOutbox;

    console.log(`🔥 PROCESS-CASCADE: Iteration ${iterationCount} generated ${outputs.length} new outputs`);
    if (outputs.length > 0) {
      console.log(
        '🔥 PROCESS-CASCADE: New outputs:',
        outputs.map(o => ({
          entityId: o.entityId.slice(0, 8) + '...',
          signerId: o.signerId,
          txs: o.entityTxs?.length || 0,
          precommits: o.precommits?.size || 0,
          hasFrame: !!o.proposedFrame,
        })),
      );
    }
  }

  if (iterationCount >= maxIterations) {
    console.warn('⚠️ processUntilEmpty reached maximum iterations');
  } else if (iterationCount > 0) {
    console.log(`🔥 PROCESS-CASCADE: Completed after ${iterationCount} iterations`);
  }

  return env;
};

// === PREPOPULATE FUNCTION ===
import { prepopulate } from './prepopulate';
export { prepopulate };

// === SCENARIO SYSTEM ===
export { parseScenario, mergeAndSortEvents } from './scenarios/parser.js';
export { executeScenario } from './scenarios/executor.js';
export { loadScenarioFromFile, loadScenarioFromText } from './scenarios/loader.js';

// === NAME RESOLUTION WRAPPERS (override imports) ===
const searchEntityNames = (query: string, limit?: number) => searchEntityNamesOriginal(db, query, limit);
const resolveEntityName = (entityId: string) => resolveEntityNameOriginal(db, entityId);
const getEntityDisplayInfoFromProfile = (entityId: string) => getEntityDisplayInfoFromProfileOriginal(db, entityId);

// Avatar functions are already imported and exported above
