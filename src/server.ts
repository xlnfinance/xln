// for regular use > bun run src/server.ts
// for debugging > bun repl
// await import('./debug.js');

// Import utilities and types
// High-level database using Level polyfill (works in both Node.js and browser)
import fs from 'fs';
import { Level } from 'level';

import { logger } from './logger';
import { TIMING, LIMITS } from './constants';
import { applyEntityInput, mergeEntityInputs } from './entity-consensus';
import { entityChannelManager } from './entity-channel';
import { activateXLN, routeThroughChannels } from './activate-bilateral-channels';
import { jMachine } from './j-machine';
// Account messaging functions are handled through bilateral channels
// See entity-channel.ts for direct entity-to-entity communication
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
import { decode, encode } from './snapshot-coder';
import { captureSnapshot, cloneEntityReplica } from './state-helpers';
import { runDepositoryHankoTests } from './test-depository-hanko';
import { runBasicHankoTests } from './test-hanko-basic';
import { runAllTests as runCompleteHankoTests } from './test-hanko-complete';
import { EntityInput, EntityReplica, Env, EnvSnapshot, ServerInput } from './types';
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
// Initialize with default environment - will be replaced if server is initialized
let env: Env = {
  replicas: new Map(),
  height: 0,
  timestamp: Date.now(),
  serverInput: { serverTxs: [], entityInputs: [] },
  history: [],
  gossip: createGossipLayer(),
};

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
      logger.warn('Ethereum jurisdiction not found, skipping j-watcher');
      return;
    }

    // Set up j-watcher with the deployed contracts
    jWatcher = await setupJEventWatcher(
      env,
      ethereum.address, // RPC URL
      ethereum.entityProviderAddress,
      ethereum.depositoryAddress
    );

    logger.jMachine('J-Event Watcher started successfully', {
      rpcUrl: ethereum.address,
      entityProviderAddress: ethereum.entityProviderAddress,
      depositoryAddress: ethereum.depositoryAddress
    });
    
    // J-watcher now handles its own periodic sync every 500ms
    // Set up a periodic check to process any queued events from j-watcher
    setInterval(async () => {
      if (env.serverInput.entityInputs.length > 0) {
        const eventCount = env.serverInput.entityInputs.length;
        logger.jMachine('Processing J-machine events', { eventCount });
        
        // Process the queued entity inputs from j-watcher
        await applyServerInput(env, { 
          serverTxs: [], 
          entityInputs: [...env.serverInput.entityInputs] 
        });
        
        // Clear the processed inputs
        env.serverInput.entityInputs.length = 0;
        
        notifyEnvChange(env); // Notify UI of changes
      }
    }, TIMING.TICK_INTERVAL); // Check every tick interval to process j-watcher events quickly
    
  } catch (error) {
    logger.error('Failed to start J-Event Watcher', {}, error as Error);
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
    if (serverInput.serverTxs.length > LIMITS.MAX_SERVER_TXS) {
      log.error(`❌ Too many server transactions: ${serverInput.serverTxs.length} > ${LIMITS.MAX_SERVER_TXS}`);
      return { entityOutbox: [], mergedInputs: [] };
    }
    if (serverInput.entityInputs.length > LIMITS.MAX_ENTITY_INPUTS) {
      log.error(`❌ Too many entity inputs: ${serverInput.entityInputs.length} > ${LIMITS.MAX_ENTITY_INPUTS}`);
      return { entityOutbox: [], mergedInputs: [] };
    }

    // Merge new serverInput into env.serverInput
    env.serverInput.serverTxs.push(...serverInput.serverTxs);
    env.serverInput.entityInputs.push(...serverInput.entityInputs);

    // Merge all entityInputs in env.serverInput
    const mergedInputs = mergeEntityInputs(env.serverInput.entityInputs);
    const entityOutbox: EntityInput[] = [];

    if (DEBUG) {
      logger.debug('Starting server tick', {
        blockHeight: env.height,
        newServerTxs: serverInput.serverTxs.length,
        newEntityInputs: serverInput.entityInputs.length,
        totalServerTxs: env.serverInput.serverTxs.length,
        totalEntityInputs: env.serverInput.entityInputs.length,
        mergedInputsCount: mergedInputs.length
      });
      if (mergedInputs.length > 0) {
        logger.debug('Processing merged inputs', {
          inputsCount: mergedInputs.length,
          inputs: mergedInputs.map((input, i) => {
            const parts = [];
            if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
            if (input.precommits?.size) parts.push(`${input.precommits.size} precommits`);
            if (input.proposedFrame) parts.push(`frame: ${input.proposedFrame.hash.slice(0, 10)}...`);
            return `${i + 1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`;
          })
        });
      }
    }

    // Process server transactions (replica imports) from env.serverInput
    logger.debug('Processing serverTxs', {
      serverTxsCount: env.serverInput.serverTxs.length,
      currentReplicas: env.replicas.size
    });
    env.serverInput.serverTxs.forEach(serverTx => {
      if (serverTx.type === 'importReplica') {
        if (DEBUG)
          logger.debug('Importing replica', {
            entityId: serverTx.entityId,
            signerId: serverTx.signerId,
            isProposer: serverTx.data.isProposer
          });

        const replicaKey = `${serverTx.entityId}:${serverTx.signerId}`;

        // Register entity with channel manager for bilateral communication
        entityChannelManager.registerEntity(serverTx.entityId);

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
        logger.debug('Added replica', {
          replicaKey,
          expectedJBlock: 0,
          actualJBlock,
          jBlockType: typeof actualJBlock
        });

        if (typeof actualJBlock !== 'number') {
          logger.error('Entity creation bug: invalid jBlock', {
            replicaKey,
            expectedType: 'number',
            expectedValue: 0,
            actualType: typeof actualJBlock,
            actualValue: actualJBlock
          });
          // Force fix immediately
          if (createdReplica) {
            createdReplica.state.jBlock = 0;
            logger.info('Fixed jBlock for replica', { replicaKey, fixedValue: 0 });
          }
        }
      }
    });
    logger.debug('Completed serverTxs processing', { totalReplicas: env.replicas.size });

    // Simple watcher automatically syncs all proposer replicas from their last jBlock

    // BILATERAL CHANNELS: Pull pending messages from EntityChannelManager
    logger.channel('Checking for pending messages from channels');
    for (const [replicaKey, replica] of env.replicas) {
      const entityId = replica.entityId;
      const pendingMessages = entityChannelManager.getPendingMessages(entityId);

      if (pendingMessages.length > 0) {
        logger.channel('Found pending messages', {
          entityId: entityId.slice(0,10) + '...',
          messageCount: pendingMessages.length
        });

        // Convert messages to EntityInputs and add to processing queue
        for (const message of pendingMessages) {
          const entityInput = entityChannelManager.messageToEntityInput(message);
          env.serverInput.entityInputs.push(entityInput);
          logger.channel('Added message to processing queue', {
            fromEntityId: message.fromEntityId.slice(0,8) + '...'
          });
        }
      }
    }

    // Process entity inputs - check for j-events
    logger.debug('About to process merged entity inputs', {
      mergedInputsCount: mergedInputs.length
    });
    for (const entityInput of mergedInputs) {
      // Track j-events in this input
      const jEventCount = entityInput.entityTxs?.filter(tx => tx.type === 'j_event').length || 0;
      if (jEventCount > 0) {
        logger.jMachine('Found J-events in entity input', {
          entityId: entityInput.entityId.slice(0,10) + '...',
          signerId: entityInput.signerId,
          jEventCount,
          events: entityInput.entityTxs?.filter(tx => tx.type === 'j_event').map((jEvent, i) => ({
            index: i,
            type: jEvent.data.event.type,
            blockNumber: jEvent.data.blockNumber,
            observedAt: new Date(jEvent.data.observedAt).toLocaleTimeString()
          }))
        });
      }

      // For system-generated outputs, route to any available replica of the target entity
      let replicaKey = `${entityInput.entityId}:${entityInput.signerId}`;
      let entityReplica = env.replicas.get(replicaKey);

      // If signerId is 'system', find any replica for this entity
      if (entityInput.signerId === 'system' && !entityReplica) {
        const targetEntityReplicas = Array.from(env.replicas.keys())
          .filter(key => key.startsWith(entityInput.entityId + ':'));

        if (targetEntityReplicas.length > 0) {
          replicaKey = targetEntityReplicas[0]; // Use first available replica
          entityReplica = env.replicas.get(replicaKey);
          logger.debug('Routing system message', { replicaKey });
        }
      }

      logger.debug('Replica lookup', {
        replicaKey,
        foundReplica: !!entityReplica,
        inputTxsCount: entityInput.entityTxs?.length || 0,
        txTypes: entityInput.entityTxs?.map(tx => tx.type),
        availableReplicaKeys: !entityReplica ? Array.from(env.replicas.keys()) : undefined
      });

      if (entityReplica) {
        if (DEBUG) {
          logger.debug('Processing input for replica', {
            replicaKey,
            transactionCount: entityInput.entityTxs?.length,
            proposedFrameHash: entityInput.proposedFrame?.hash,
            precommitsCount: entityInput.precommits?.size
          });
        }

        const { newState, outputs } = await applyEntityInput(env, entityReplica, entityInput);
        // CRITICAL FIX: Update the replica in the environment with the new state
        env.replicas.set(replicaKey, { ...entityReplica, state: newState });

        // Route outputs through bilateral channels instead of global mempool
        const routedOutputs = routeThroughChannels(env, outputs);
        env.serverInput.entityInputs.push(...routedOutputs);
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
      logger.debug('Skipping frame creation - no work to do');
    }

    // Notify Svelte about environment changes
    logger.debug('Environment state before notification', {
      totalReplicas: env.replicas.size,
      replicaKeys: Array.from(env.replicas.keys()),
      environmentKeys: Object.keys(env),
      gossipLayerExists: !!env.gossip,
      gossipLayerType: typeof env.gossip,
      gossipAnnounceType: typeof env.gossip?.announce
    });
    
    // CRITICAL FIX: Initialize gossip layer only if needed and not a test placeholder
    // Don't create gossip for single-signer entities (tests use Map as placeholder)
    if (!env.gossip) {
      logger.error('Critical: gossip layer missing, creating new one');
      env.gossip = createGossipLayer();
      logger.info('Gossip layer created and added to environment');
    } else if (env.gossip instanceof Map) {
      // Test environment uses Map as placeholder - don't replace it
      logger.debug('Test environment detected (gossip is Map), keeping placeholder');
    } else if (typeof env.gossip.announce !== 'function') {
      logger.error('Critical: gossip layer incomplete, creating new one', {
        announceType: typeof env.gossip?.announce
      });
      env.gossip = createGossipLayer();
      logger.info('Gossip layer recreated and added to environment');
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

    logger.debug('Entity distribution analysis', {
      oldEntitiesCount: oldEntityKeys.length,
      oldEntitiesSample: oldEntityKeys.slice(0, 2),
      newEntitiesCount: newEntityKeys.length,
      newEntitiesSample: newEntityKeys.slice(0, 2)
    });

    if (oldEntityKeys.length > 0 && newEntityKeys.length > 0) {
      const oldReplica = env.replicas.get(oldEntityKeys[0]);
      const newReplica = env.replicas.get(newEntityKeys[0]);
      logger.debug('Replica structure analysis', {
        oldReplicaStructure: {
          hasState: !!oldReplica?.state,
          hasConfig: !!oldReplica?.state?.config,
          hasJurisdiction: !!oldReplica?.state?.config?.jurisdiction,
          jurisdictionName: oldReplica?.state?.config?.jurisdiction?.name,
        },
        newReplicaStructure: {
          hasState: !!newReplica?.state,
          hasConfig: !!newReplica?.state?.config,
          hasJurisdiction: !!newReplica?.state?.config?.jurisdiction,
          jurisdictionName: newReplica?.state?.config?.jurisdiction?.name,
        }
      });
    }

    notifyEnvChange(env);

    if (DEBUG && entityOutbox.length > 0) {
      logger.debug('Generated outputs', {
        outputCount: entityOutbox.length,
        outputs: entityOutbox.map((output, i) => ({
          index: i + 1,
          signerId: output.signerId,
          txCount: output.entityTxs?.length,
          proposedFrameHash: output.proposedFrame?.hash.slice(0, 10),
          precommitsCount: output.precommits?.size
        }))
      });
    } else if (DEBUG && entityOutbox.length === 0) {
      logger.debug('No outputs generated');
    }

    if (DEBUG) {
      logger.debug('Replica states summary', {
        replicas: Array.from(env.replicas.entries()).map(([key, replica]) => {
          const [entityId, signerId] = key.split(':');
          return {
            entityId: formatEntityDisplay(entityId),
            signerId: formatSignerDisplay(signerId),
            mempoolSize: replica.mempool.length,
            messagesCount: replica.state.messages.length,
            hasProposal: !!replica.proposal
          };
        })
      });
    }

    // Performance logging
    const endTime = Date.now();
    if (DEBUG) {
      logger.debug('Tick completed', {
        blockHeight: env.height - 1,
        processingTimeMs: endTime - startTime
      });
    }

    return { entityOutbox, mergedInputs };
  } catch (error) {
    log.error(`❌ Error processing server input:`, error);
    return { entityOutbox: [], mergedInputs: [] };
  }
};

// This is the new, robust main function that replaces the old one.
const main = async (): Promise<Env> => {
  // DEBUG: Log jurisdictions.json content on startup
  if (!isBrowser) {
    try {
      const jurisdictionsContent = fs.readFileSync('./jurisdictions.json', 'utf8');
      const jurisdictions = JSON.parse(jurisdictionsContent);
      logger.info('Startup: loaded jurisdictions configuration', {
        ethereumDepository: jurisdictions.jurisdictions.ethereum.contracts.depository,
        ethereumEntityProvider: jurisdictions.jurisdictions.ethereum.contracts.entityProvider,
        lastUpdated: jurisdictions.lastUpdated,
        ethereumConfig: jurisdictions.jurisdictions.ethereum
      });
    } catch (error) {
      logger.warn('Failed to read jurisdictions.json', {}, error as Error);
    }
  }

  // Initialize server when not imported as module
  if (import.meta.main === import.meta.url || process.argv[1] === import.meta.filename) {
    return await initializeServer();
  }

  // When imported as module, return a default environment without initialization
  return env;
};

// Server initialization function - can be called explicitly by tests or main execution
export async function initializeServer() {
  // Initialize gossip layer
  logger.info('Initializing gossip layer');
  const gossipLayer = createGossipLayer();
  logger.info('Gossip layer initialized');

  // Initialize J-Machine for blockchain event processing
  logger.jMachine('Initializing J-Machine');
  try {
    await jMachine.initialize({
      replicas: new Map(),
      height: 0,
      timestamp: Date.now(),
      serverInput: { serverTxs: [], entityInputs: [] },
      history: [],
      gossip: gossipLayer
    });
    logger.jMachine('J-Machine initialized');

    // Start periodic sync
    jMachine.startPeriodicSync(TIMING.J_MACHINE_SYNC); // Sync at J-Machine interval
  } catch (error) {
    logger.warn('J-Machine initialization failed', {}, error as Error);
    // Continue without J-Machine - system can work in offline mode
  }

  // Load persisted profiles from database into gossip layer
  logger.info('Loading persisted profiles from database');
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
      logger.debug('Starting IndexedDB snapshot loading process');
    } else {
      logger.debug('Node.js environment: Attempting to load snapshots from filesystem');
    }

    logger.debug('Querying latest_height from database');
    const latestHeightBuffer = await db.get(Buffer.from('latest_height'));
    const latestHeight = parseInt(latestHeightBuffer.toString(), 10);
    logger.debug('Found latest height in database', { latestHeight });

    logger.info('Loading snapshots', {
      latestHeight,
      snapshotsToLoad: latestHeight + 1
    });

    // Load snapshots starting from 1 (height 0 is initial state, no snapshot saved)
    logger.debug('Loading snapshots range', {
      startHeight: 1,
      endHeight: latestHeight
    });
    const snapshots = [];

    // Start from 1 since height 0 is initial state with no snapshot
    for (let i = 1; i <= latestHeight; i++) {
      try {
        const buffer = await db.get(Buffer.from(`snapshot:${i}`));
        const snapshot = decode(buffer);
        snapshots.push(snapshot);
        logger.debug('Snapshot loaded', {
          height: i,
          sizeBytes: buffer.length
        });
      } catch (error) {
        logger.error('Failed to load snapshot', { height: i }, error as Error);
        logger.warn('Snapshot missing, continuing with available data', { height: i });
      }
    }

    if (snapshots.length === 0) {
      logger.info('No snapshots found, using fresh environment', { latestHeight });
      throw new Error('LEVEL_NOT_FOUND');
    }

    logger.info('Snapshots loaded successfully', {
      loadedCount: snapshots.length,
      totalExpected: latestHeight,
      startHeight: 1
    });
    env.history = snapshots;

    if (snapshots.length > 0) {
      const latestSnapshot = snapshots[snapshots.length - 1];

      // Restore gossip profiles from snapshot
      const gossipLayer = createGossipLayer();
      if (latestSnapshot.gossip?.profiles) {
        for (const [id, profile] of Object.entries(latestSnapshot.gossip.profiles)) {
          gossipLayer.profiles.set(id, profile as Profile);
        }
        logger.info('Restored gossip profiles', {
          profileCount: Object.keys(latestSnapshot.gossip.profiles).length
        });
      }

      env = {
        replicas: latestSnapshot.replicas,
        height: latestSnapshot.height,
        timestamp: latestSnapshot.timestamp,
        serverInput: latestSnapshot.serverInput,
        history: snapshots, // Include the loaded history
        gossip: gossipLayer, // Use restored gossip layer
      };
      logger.info('History restored successfully', {
        height: env.height,
        snapshotCount: env.history.length,
        replicaCount: env.replicas.size,
        timestamp: new Date(env.timestamp).toISOString(),
        serverInputs: env.serverInput.entityInputs.length
      });
    }
  } catch (error: any) {
    if (error.code === 'LEVEL_NOT_FOUND') {
      logger.debug('No saved state found, using fresh environment');
      if (isBrowser) {
        logger.debug('First-time browser use: IndexedDB will be created automatically');
        logger.debug('Fresh environment: entities will start with jBlock=0');
      } else {
        logger.debug('Node.js: No existing snapshots in db directory');
      }
    } else {
      logger.error('Failed to load state from LevelDB', {
        errorCode: error.code,
        isBrowser,
        dbLocation: isBrowser ? 'IndexedDB: db' : 'db'
      }, error);
      throw error;
    }
  }

  // Demo profiles are only initialized during runDemo - not by default

  // Only run demos in Node.js environment, not browser
  if (!isBrowser) {
    // DISABLED: Hanko tests during development
    logger.info('Hanko tests disabled during development - focusing on core functionality');

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
    logger.info('Browser environment: Demos available via UI buttons, not auto-running');
  }

  log.info(`🎯 Server startup complete. Height: ${env.height}, Entities: ${env.replicas.size}`);

  // Debug final state before starting j-watcher
  if (isBrowser) {
    logger.debug('Final state before j-watcher start', {
      environmentHeight: env.height,
      totalReplicas: env.replicas.size,
      replicas: Array.from(env.replicas.entries()).map(([replicaKey, replica]) => {
        const [entityId, signerId] = replicaKey.split(':');
        return {
          entityId: entityId.slice(0,10) + '...',
          signerId,
          jBlock: replica.state.jBlock,
          isProposer: replica.isProposer
        };
      })
    });
  }

  // Start j-watcher after snapshots are fully loaded (prevent multiple instances)
  if (!jWatcherStarted) {
    try {
      logger.jMachine('Starting j-watcher after snapshots loaded');
      await startJEventWatcher(env);
      jWatcherStarted = true;
      logger.jMachine('J-watcher started successfully');
    } catch (error) {
      logger.error('Failed to start J-Event Watcher', {}, error as Error);
    }
  } else {
    logger.jMachine('J-watcher already started, skipping');
  }

  return env;
}

// === TIME MACHINE API ===
const getHistory = () => env.history || [];
const getSnapshot = (index: number) => {
  const history = env.history || [];
  return index >= 0 && index < history.length ? history[index] : null;
};
const getCurrentHistoryIndex = () => (env.history || []).length - 1;

// Server-specific clearDatabase that also resets history
const clearDatabaseAndHistory = async () => {
  logger.info('Clearing database and resetting server history');

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

  logger.info('Database and server history cleared');
};

// Export j-watcher status for frontend display
export const getJWatcherStatus = () => {
  if (!jWatcher || !env) return null;
  return {
    isWatching: jWatcher.getStatus().isWatching,
    proposers: Array.from(env.replicas.entries())
      .filter(([key, replica]) => replica.isProposer)
      .map(([key, replica]) => {
        const [entityId, signerId] = key.split(':');
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
  
  // Account messaging handled via entityChannelManager
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
        const noDemoFlag = process.env.NO_DEMO === '1' || process.argv.includes('--no-demo');

        if (!noDemoFlag) {
          logger.info('Node.js environment initialized. Running demo for local testing');
          logger.info('To skip demo, use: NO_DEMO=1 bun run src/server.ts or --no-demo flag');
          await runDemo(env);

          // Start j-watcher after demo completes
          await startJEventWatcher(env);

          // Add a small delay to ensure demo completes before verification
          setTimeout(async () => {
            await verifyJurisdictionRegistrations();
          }, 2000);
        } else {
          logger.info('Node.js environment initialized. Demo skipped (NO_DEMO=1 or --no-demo)');
          logger.info('Use XLN.runDemo(env) to run demo manually if needed');
          
          // J-watcher is already started in main(), no need to start again
        }
      }
    })
    .catch(error => {
      logger.error('An error occurred during Node.js auto-execution', {}, error as Error);
    });
}

// === BLOCKCHAIN VERIFICATION ===
const verifyJurisdictionRegistrations = async () => {
  logger.info('Starting jurisdiction verification');

  const jurisdictions = await getAvailableJurisdictions();

  for (const jurisdiction of jurisdictions) {
    try {
      logger.info('Verifying jurisdiction', {
        name: jurisdiction.name,
        rpcUrl: jurisdiction.address,
        contractAddress: jurisdiction.entityProviderAddress
      });

      // Connect to this jurisdiction's network
      const { entityProvider } = await connectToEthereum(jurisdiction);

      // Get next entity number (indicates how many are registered)
      const nextNumber = await entityProvider.nextNumber();
      const registeredCount = Number(nextNumber) - 1;

      logger.info('Jurisdiction entity count', {
        jurisdictionName: jurisdiction.name,
        registeredEntities: registeredCount
      });

      // Read registered entities
      if (registeredCount > 0) {
        logger.debug('Reading entity details', {
          jurisdictionName: jurisdiction.name
        });
        for (let i = 1; i <= registeredCount; i++) {
          try {
            const entityId = generateNumberedEntityId(i);
            const entityInfo = await entityProvider.entities(entityId);
            logger.debug('Entity details', {
              entityNumber: i,
              entityId: entityId.slice(0, 10) + '...',
              registrationBlock: entityInfo.registrationBlock
            });
          } catch (error) {
            logger.warn('Error reading entity data', {
              entityNumber: i
            });
          }
        }
      }

    } catch (error) {
      logger.error('Failed to verify jurisdiction', {
        jurisdictionName: jurisdiction.name
      }, error instanceof Error ? error : new Error(String(error)));
    }
  }

  logger.info('Jurisdiction verification complete');
};

// === HANKO DEMO FUNCTION ===

const demoCompleteHanko = async (): Promise<void> => {
  try {
    // Check if running in browser environment
    const isBrowser = typeof window !== 'undefined';

    if (isBrowser) {
      logger.info('Browser environment detected - running simplified Hanko demo');
      logger.info('Basic signature verification available');
      logger.info('Full test suite available in Node.js environment');
      logger.info('Hanko browser demo completed');
      return;
    }

    logger.info('Running complete Hanko test suite');
    await runCompleteHankoTests();
    logger.info('Complete Hanko tests passed');
  } catch (error) {
    logger.error('Complete Hanko tests failed', {}, error as Error);
    throw error;
  }
};

// Create a wrapper for runDemo that provides better browser feedback
const runDemoWrapper = async (env: any): Promise<any> => {
  try {
    logger.info('Starting XLN Consensus Demo');
    logger.info('This will demonstrate entity creation, consensus, and message passing');

    const result = await runDemo(env);

    logger.info('XLN Demo completed successfully');
    logger.info('Check the entity cards above to see the results');
    logger.info('Use the time machine to replay the consensus steps');

    // J-watcher is already started in main(), no need to start again

    return result;
  } catch (error) {
    logger.error('XLN Demo failed', {}, error as Error);
    throw error;
  }
};

// === ENVIRONMENT UTILITIES ===
export const createEmptyEnv = (): Env => {
  const env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: createGossipLayer(),
  };

  // Note: activateXLN is now async and should be called separately after environment creation
  // to properly initialize J-Machine and bilateral channels

  return env;
};

// === CONSENSUS PROCESSING UTILITIES ===
export const processUntilEmpty = async (env: Env, inputs?: EntityInput[]) => {
  let outputs = inputs || [];
  let iterationCount = 0;
  const maxIterations = 10; // Safety limit

  // Only log cascade details if there are outputs to process
  if (outputs.length > 0) {
    logger.consensus('Process cascade starting', {
      initialOutputCount: outputs.length,
      initialOutputs: outputs.map(o => ({
        entityId: o.entityId.slice(0, 8) + '...',
        signerId: o.signerId,
        txs: o.entityTxs?.length || 0,
        precommits: o.precommits?.size || 0,
        hasFrame: !!o.proposedFrame,
      }))
    });
  }

  // DEBUG: Log transaction details for vote transactions
  outputs.forEach((output, i) => {
    if (output.entityTxs?.some(tx => tx.type === 'vote')) {
      logger.consensus('Vote transactions found', {
        inputIndex: i + 1,
        voteTransactions: output.entityTxs.filter(tx => tx.type === 'vote')
      });
    }
  });

  while (outputs.length > 0 && iterationCount < maxIterations) {
    iterationCount++;
    logger.consensus('Process cascade iteration', {
      iteration: iterationCount,
      outputCount: outputs.length
    });

    const result = await applyServerInput(env, { serverTxs: [], entityInputs: outputs });
    outputs = result.entityOutbox;

    logger.consensus('Process cascade iteration complete', {
      iteration: iterationCount,
      newOutputCount: outputs.length,
      newOutputs: outputs.length > 0 ? outputs.map(o => ({
        entityId: o.entityId.slice(0, 8) + '...',
        signerId: o.signerId,
        txs: o.entityTxs?.length || 0,
        precommits: o.precommits?.size || 0,
        hasFrame: !!o.proposedFrame,
      })) : undefined
    });
  }

  if (iterationCount >= maxIterations && outputs.length > 0) {
    logger.error('Process cascade reached maximum iterations - infinite loop detected', {
      maxIterations,
      remainingOutputs: outputs.length
    });
    throw new Error(`Infinite loop detected: ${outputs.length} outputs remain after ${maxIterations} iterations`);
  } else if (iterationCount > 0) {
    logger.consensus('Process cascade completed', {
      totalIterations: iterationCount
    });
  }

  return env;
};

// === NAME RESOLUTION WRAPPERS (override imports) ===
const searchEntityNames = (query: string, limit?: number) => searchEntityNamesOriginal(db, query, limit);
const resolveEntityName = (entityId: string) => resolveEntityNameOriginal(db, entityId);
const getEntityDisplayInfoFromProfile = (entityId: string) => getEntityDisplayInfoFromProfileOriginal(db, entityId);
