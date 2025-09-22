// for regular use > bun run src/server.ts
// for debugging > bun repl
// await import('./debug.js');
// Import utilities and types
// High-level database using Level polyfill (works in both Node.js and browser)
import fs from 'fs';
import { Level } from 'level';
import { applyEntityInput, mergeEntityInputs } from './entity-consensus';
import { entityChannelManager } from './entity-channel';
import { jMachine } from './j-machine';
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
import { createLazyEntity, createNumberedEntity, detectEntityType, encodeBoard, generateLazyEntityId, generateNamedEntityId, generateNumberedEntityId, hashBoard, isEntityRegistered, requestNamedEntity, resolveEntityIdentifier, } from './entity-factory';
import { assignNameOnChain, connectToEthereum, debugFundReserves, getAvailableJurisdictions, getEntityInfoFromChain, getJurisdictionByAddress, getNextEntityNumber, registerNumberedEntityOnChain, submitProcessBatch, submitPrefundAccount, submitSettle, submitReserveToReserve, transferNameBetweenEntities, } from './evm';
import { createGossipLayer } from './gossip';
import { loadPersistedProfiles } from './gossip-loader';
import { setupJEventWatcher } from './j-event-watcher';
import { createProfileUpdateTx, getEntityDisplayInfo as getEntityDisplayInfoFromProfileOriginal, resolveEntityName as resolveEntityNameOriginal, searchEntityNames as searchEntityNamesOriginal, } from './name-resolution';
import { runDemo } from './rundemo';
import { decode } from './snapshot-coder';
import { captureSnapshot } from './state-helpers';
import { runAllTests as runCompleteHankoTests } from './test-hanko-complete';
import { clearDatabase, DEBUG, formatEntityDisplay, formatSignerDisplay, generateEntityAvatar, generateSignerAvatar, getEntityDisplayInfo, getSignerDisplayInfo, isBrowser, log, } from './utils';
// --- Database Setup ---
// Level polyfill: Node.js uses filesystem, Browser uses IndexedDB
export const db = new Level('db', {
    valueEncoding: 'buffer',
    keyEncoding: 'binary',
});
// === ETHEREUM INTEGRATION ===
// === SVELTE REACTIVITY INTEGRATION ===
// Callback that Svelte can register to get notified of env changes
let envChangeCallback = null;
// Module-level environment variable
// Initialize with default environment - will be replaced if server is initialized
let env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: createGossipLayer(),
};
// Module-level j-watcher instance - prevent multiple instances
let jWatcher = null;
let jWatcherStarted = false;
export const registerEnvChangeCallback = (callback) => {
    envChangeCallback = callback;
};
const notifyEnvChange = (env) => {
    if (envChangeCallback) {
        envChangeCallback(env);
    }
};
// J-Watcher initialization
const startJEventWatcher = async (env) => {
    try {
        // Get the Ethereum jurisdiction
        const ethereum = await getJurisdictionByAddress('ethereum');
        if (!ethereum) {
            console.warn('⚠️ Ethereum jurisdiction not found, skipping j-watcher');
            return;
        }
        // Set up j-watcher with the deployed contracts
        jWatcher = await setupJEventWatcher(env, ethereum.address, // RPC URL
        ethereum.entityProviderAddress, ethereum.depositoryAddress);
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
                notifyEnvChange(env); // Notify UI of changes
            }
        }, 100); // Check every 100ms to process j-watcher events quickly
    }
    catch (error) {
        console.error('❌ Failed to start J-Event Watcher:', error);
    }
};
// Note: History is now stored in env.history (no global variable needed)
// === SNAPSHOT UTILITIES ===
// All cloning utilities now moved to state-helpers.ts
// All snapshot functionality now moved to state-helpers.ts
// === UTILITY FUNCTIONS ===
const applyServerInput = async (env, serverInput) => {
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
        const entityOutbox = [];
        if (DEBUG) {
            console.log(`\n=== TICK ${env.height} ===`);
            console.log(`Server inputs: ${serverInput.serverTxs.length} new serverTxs, ${serverInput.entityInputs.length} new entityInputs`);
            console.log(`Total in env: ${env.serverInput.serverTxs.length} serverTxs, ${env.serverInput.entityInputs.length} entityInputs (merged to ${mergedInputs.length})`);
            if (mergedInputs.length > 0) {
                console.log(`🔄 Processing merged inputs:`);
                mergedInputs.forEach((input, i) => {
                    const parts = [];
                    if (input.entityTxs?.length)
                        parts.push(`${input.entityTxs.length} txs`);
                    if (input.precommits?.size)
                        parts.push(`${input.precommits.size} precommits`);
                    if (input.proposedFrame)
                        parts.push(`frame: ${input.proposedFrame.hash.slice(0, 10)}...`);
                    console.log(`  ${i + 1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
                });
            }
        }
        // Process server transactions (replica imports) from env.serverInput
        console.log(`🔍 REPLICA-DEBUG: Processing ${env.serverInput.serverTxs.length} serverTxs, current replicas: ${env.replicas.size}`);
        env.serverInput.serverTxs.forEach(serverTx => {
            if (serverTx.type === 'importReplica') {
                if (DEBUG)
                    console.log(`Importing replica Entity #${formatEntityDisplay(serverTx.entityId)}:${formatSignerDisplay(serverTx.signerId)} (proposer: ${serverTx.data.isProposer})`);
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
                console.log(`🔍 REPLICA-DEBUG: Added replica ${replicaKey}, jBlock should be 0, actually is: ${actualJBlock} (type: ${typeof actualJBlock})`);
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
        // BILATERAL CHANNELS: Pull pending messages from EntityChannelManager
        console.log(`📡 BILATERAL-CHANNELS: Checking for pending messages from channels...`);
        for (const [replicaKey, replica] of env.replicas) {
            const entityId = replica.entityId;
            const pendingMessages = entityChannelManager.getPendingMessages(entityId);
            if (pendingMessages.length > 0) {
                console.log(`📥 BILATERAL-CHANNELS: Found ${pendingMessages.length} pending messages for ${entityId.slice(0, 10)}...`);
                // Convert messages to EntityInputs and add to processing queue
                for (const message of pendingMessages) {
                    const entityInput = entityChannelManager.messageToEntityInput(message);
                    env.serverInput.entityInputs.push(entityInput);
                    console.log(`🔄 BILATERAL-CHANNELS: Added message from ${message.fromEntityId.slice(0, 8)}... to processing queue`);
                }
            }
        }
        // Process entity inputs - check for j-events
        console.log(`🔍 SERVER-PROCESSING: About to process ${mergedInputs.length} merged entity inputs`);
        for (const entityInput of mergedInputs) {
            // Track j-events in this input
            const jEventCount = entityInput.entityTxs?.filter(tx => tx.type === 'j_event').length || 0;
            if (jEventCount > 0) {
                console.log(`🚨 FOUND-J-EVENTS: Entity ${entityInput.entityId.slice(0, 10)}... has ${jEventCount} j-events from ${entityInput.signerId}`);
                entityInput.entityTxs?.filter(tx => tx.type === 'j_event').forEach((jEvent, i) => {
                    console.log(`🚨   J-EVENT-${i}: type=${jEvent.data.event.type}, block=${jEvent.data.blockNumber}, observedAt=${new Date(jEvent.data.observedAt).toLocaleTimeString()}`);
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
                    console.log(`🔍 SYSTEM-ROUTING: Routing system message to ${replicaKey}`);
                }
            }
            console.log(`🔍 REPLICA-LOOKUP: Key="${replicaKey}"`);
            console.log(`🔍 REPLICA-LOOKUP: Found replica: ${!!entityReplica}`);
            console.log(`🔍 REPLICA-LOOKUP: Input txs: ${entityInput.entityTxs?.length || 0}`);
            if (entityInput.entityTxs && entityInput.entityTxs.length > 0) {
                console.log(`🔍 REPLICA-LOOKUP: Tx types:`, entityInput.entityTxs.map(tx => tx.type));
            }
            if (!entityReplica) {
                console.log(`🔍 REPLICA-LOOKUP: Available replica keys:`, Array.from(env.replicas.keys()));
            }
            if (entityReplica) {
                if (DEBUG) {
                    console.log(`Processing input for ${replicaKey}:`);
                    if (entityInput.entityTxs?.length)
                        console.log(`  → ${entityInput.entityTxs.length} transactions`);
                    if (entityInput.proposedFrame)
                        console.log(`  → Proposed frame: ${entityInput.proposedFrame.hash}`);
                    if (entityInput.precommits?.size)
                        console.log(`  → ${entityInput.precommits.size} precommits`);
                }
                const { newState, outputs } = await applyEntityInput(env, entityReplica, entityInput);
                // CRITICAL FIX: Update the replica in the environment with the new state
                env.replicas.set(replicaKey, { ...entityReplica, state: newState });
                entityOutbox.push(...outputs);
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
        }
        else {
            console.log(`⚪ SKIP-FRAME: No serverTxs, entityInputs, or outputs - not creating empty frame`);
        }
        // Notify Svelte about environment changes
        console.log(`🔍 REPLICA-DEBUG: Before notifyEnvChange, total replicas: ${env.replicas.size}`);
        console.log(`🔍 REPLICA-DEBUG: Replica keys:`, Array.from(env.replicas.keys()));
        console.log(`🔍 GOSSIP-DEBUG: Environment keys before notify:`, Object.keys(env));
        console.log(`🔍 GOSSIP-DEBUG: Gossip layer exists:`, !!env.gossip);
        console.log(`🔍 GOSSIP-DEBUG: Gossip layer type:`, typeof env.gossip);
        console.log(`🔍 GOSSIP-DEBUG: Gossip announce method:`, typeof env.gossip?.announce);
        // CRITICAL FIX: Initialize gossip layer only if needed and not a test placeholder
        // Don't create gossip for single-signer entities (tests use Map as placeholder)
        if (!env.gossip) {
            console.log(`🚨 CRITICAL: gossip layer missing, creating new one`);
            env.gossip = createGossipLayer();
            console.log(`✅ Gossip layer created and added to environment`);
        }
        else if (env.gossip instanceof Map) {
            // Test environment uses Map as placeholder - don't replace it
            console.log(`📝 Test environment detected (gossip is Map), keeping placeholder`);
        }
        else if (typeof env.gossip.announce !== 'function') {
            console.log(`🚨 CRITICAL: gossip layer incomplete (announce: ${typeof env.gossip?.announce}), creating new one`);
            env.gossip = createGossipLayer();
            console.log(`✅ Gossip layer recreated and added to environment`);
        }
        // Compare old vs new entities
        const oldEntityKeys = Array.from(env.replicas.keys()).filter(key => key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000001:') ||
            key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000002:'));
        const newEntityKeys = Array.from(env.replicas.keys()).filter(key => !key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000001:') &&
            !key.startsWith('0x0000000000000000000000000000000000000000000000000000000000000002:') &&
            !key.startsWith('0x57e360b00f393ea6d898d6119f71db49241be80aec0fbdecf6358b0103d43a31:'));
        console.log(`🔍 OLD-ENTITY-DEBUG: ${oldEntityKeys.length} old entities:`, oldEntityKeys.slice(0, 2));
        console.log(`🔍 NEW-ENTITY-DEBUG: ${newEntityKeys.length} new entities:`, newEntityKeys.slice(0, 2));
        if (oldEntityKeys.length > 0 && newEntityKeys.length > 0) {
            const oldReplica = env.replicas.get(oldEntityKeys[0]);
            const newReplica = env.replicas.get(newEntityKeys[0]);
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
        notifyEnvChange(env);
        if (DEBUG && entityOutbox.length > 0) {
            console.log(`📤 Outputs: ${entityOutbox.length} messages`);
            entityOutbox.forEach((output, i) => {
                console.log(`  ${i + 1}. → ${output.signerId} (${output.entityTxs ? `${output.entityTxs.length} txs` : ''}${output.proposedFrame ? ` proposal: ${output.proposedFrame.hash.slice(0, 10)}...` : ''}${output.precommits ? ` ${output.precommits.size} precommits` : ''})`);
            });
        }
        else if (DEBUG && entityOutbox.length === 0) {
            console.log(`📤 No outputs generated`);
        }
        if (DEBUG) {
            console.log(`Replica states:`);
            env.replicas.forEach((replica, key) => {
                const [entityId, signerId] = key.split(':');
                const entityDisplay = formatEntityDisplay(entityId);
                const signerDisplay = formatSignerDisplay(signerId);
                console.log(`  Entity #${entityDisplay}:${signerDisplay}: mempool=${replica.mempool.length}, messages=${replica.state.messages.length}, proposal=${replica.proposal ? '✓' : '✗'}`);
            });
        }
        // Performance logging
        const endTime = Date.now();
        if (DEBUG) {
            console.log(`⏱️  Tick ${env.height - 1} completed in ${endTime - startTime}ms`);
        }
        return { entityOutbox, mergedInputs };
    }
    catch (error) {
        log.error(`❌ Error processing server input:`, error);
        return { entityOutbox: [], mergedInputs: [] };
    }
};
// This is the new, robust main function that replaces the old one.
const main = async () => {
    // DEBUG: Log jurisdictions.json content on startup
    if (!isBrowser) {
        try {
            const jurisdictionsContent = fs.readFileSync('./jurisdictions.json', 'utf8');
            const jurisdictions = JSON.parse(jurisdictionsContent);
            console.log('🔍 STARTUP: Current jurisdictions.json content:');
            console.log('📍 Ethereum Depository:', jurisdictions.jurisdictions.ethereum.contracts.depository);
            console.log('📍 Ethereum EntityProvider:', jurisdictions.jurisdictions.ethereum.contracts.entityProvider);
            console.log('📍 Last updated:', jurisdictions.lastUpdated);
            console.log('📍 Full Ethereum config:', JSON.stringify(jurisdictions.jurisdictions.ethereum, null, 2));
        }
        catch (error) {
            console.log('⚠️ Failed to read jurisdictions.json:', error.message);
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
    console.log('🕸️ Initializing gossip layer...');
    const gossipLayer = createGossipLayer();
    console.log('✅ Gossip layer initialized');
    // Initialize J-Machine for blockchain event processing
    console.log('🏛️ Initializing J-Machine...');
    try {
        await jMachine.initialize({
            replicas: new Map(),
            height: 0,
            timestamp: Date.now(),
            serverInput: { serverTxs: [], entityInputs: [] },
            history: [],
            gossip: gossipLayer
        });
        console.log('✅ J-Machine initialized');
        // Start periodic sync
        jMachine.startPeriodicSync(5000); // Sync every 5 seconds
    }
    catch (error) {
        console.warn('⚠️ J-Machine initialization failed:', error);
        // Continue without J-Machine - system can work in offline mode
    }
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
        }
        else {
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
            }
            catch (error) {
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
            // Restore gossip profiles from snapshot
            const gossipLayer = createGossipLayer();
            if (latestSnapshot.gossip?.profiles) {
                for (const [id, profile] of Object.entries(latestSnapshot.gossip.profiles)) {
                    gossipLayer.profiles.set(id, profile);
                }
                console.log(`📡 Restored gossip profiles: ${Object.keys(latestSnapshot.gossip.profiles).length} entries`);
            }
            env = {
                replicas: latestSnapshot.replicas,
                height: latestSnapshot.height,
                timestamp: latestSnapshot.timestamp,
                serverInput: latestSnapshot.serverInput,
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
    }
    catch (error) {
        if (error.code === 'LEVEL_NOT_FOUND') {
            console.log('📦 BROWSER-DEBUG: No saved state found, using fresh environment');
            if (isBrowser) {
                console.log('💡 BROWSER-DEBUG: This is normal for first-time use. IndexedDB will be created automatically.');
                console.log('🔍 BROWSER-DEBUG: Fresh environment means entities will start with jBlock=0');
            }
            else {
                console.log('💡 Node.js: No existing snapshots in db directory.');
            }
        }
        else {
            console.error('❌ Failed to load state from LevelDB:', error);
            console.error('🔍 Error details:', {
                code: error.code,
                message: error.message,
                isBrowser,
                dbLocation: isBrowser ? 'IndexedDB: db' : 'db',
            });
            throw error;
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
    }
    else {
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
            console.log(`🔍   Entity ${entityId.slice(0, 10)}... (${signerId}): jBlock=${replica.state.jBlock}, isProposer=${replica.isProposer}`);
        }
    }
    // Start j-watcher after snapshots are fully loaded (prevent multiple instances)
    if (!jWatcherStarted) {
        try {
            console.log('🔭 STARTING-JWATCHER: Snapshots loaded, starting j-watcher...');
            await startJEventWatcher(env);
            jWatcherStarted = true;
            console.log('🔭 JWATCHER-READY: J-watcher started successfully');
        }
        catch (error) {
            console.error('❌ Failed to start J-Event Watcher:', error);
        }
    }
    else {
        console.log('🔭 JWATCHER-SKIP: J-watcher already started, skipping');
    }
    return env;
}
// === TIME MACHINE API ===
const getHistory = () => env.history || [];
const getSnapshot = (index) => {
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
    if (!jWatcher || !env)
        return null;
    return {
        isWatching: jWatcher.getStatus().isWatching,
        proposers: Array.from(env.replicas.entries())
            .filter(([key, replica]) => replica.isProposer)
            .map(([key, replica]) => {
            const [entityId, signerId] = key.split(':');
            return {
                entityId: entityId.slice(0, 10) + '...',
                signerId,
                jBlock: replica.state.jBlock,
            };
        }),
        nextSyncIn: Math.floor((1000 - (Date.now() % 1000)) / 100) / 10, // Seconds until next 1s sync
    };
};
export { applyServerInput, assignNameOnChain, clearDatabase, clearDatabaseAndHistory, connectToEthereum, 
// Entity creation functions
createLazyEntity, createNumberedEntity, createProfileUpdateTx, demoCompleteHanko, detectEntityType, encodeBoard, 
// Display and avatar functions
formatEntityDisplay, formatSignerDisplay, generateEntityAvatar, 
// Entity utility functions
generateLazyEntityId, generateNamedEntityId, generateNumberedEntityId, generateSignerAvatar, getAvailableJurisdictions, getCurrentHistoryIndex, getEntityDisplayInfo, getEntityDisplayInfoFromProfile, getEntityInfoFromChain, getHistory, getJurisdictionByAddress, getNextEntityNumber, getSignerDisplayInfo, getSnapshot, hashBoard, isEntityRegistered, main, 
// Blockchain registration functions
registerNumberedEntityOnChain, requestNamedEntity, resolveEntityIdentifier, resolveEntityName, runDemo, runDemoWrapper, 
// Name resolution functions
searchEntityNames, submitProcessBatch, submitPrefundAccount, submitSettle, submitReserveToReserve, debugFundReserves, transferNameBetweenEntities,
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
        .then(async (env) => {
        if (env) {
            // Check if demo should run automatically (can be disabled with NO_DEMO=1)
            const noDemoFlag = process.env.NO_DEMO === '1' || process.argv.includes('--no-demo');
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
            }
            else {
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
            const nextNumber = await entityProvider.nextNumber();
            const registeredCount = Number(nextNumber) - 1;
            console.log(`   📊 Registered Entities: ${registeredCount}`);
            // Read registered entities
            if (registeredCount > 0) {
                console.log(`   📝 Entity Details:`);
                for (let i = 1; i <= registeredCount; i++) {
                    try {
                        const entityId = generateNumberedEntityId(i);
                        const entityInfo = await entityProvider.entities(entityId);
                        console.log(`      #${i}: ${entityId.slice(0, 10)}... (Block: ${entityInfo.registrationBlock})`);
                    }
                    catch (error) {
                        console.log(`      #${i}: Error reading entity data`);
                    }
                }
            }
            console.log('');
        }
        catch (error) {
            console.error(`   ❌ Failed to verify ${jurisdiction.name}:`, error instanceof Error ? error.message : error);
            console.log('');
        }
    }
    console.log('✅ Jurisdiction verification complete!\n');
};
// === HANKO DEMO FUNCTION ===
const demoCompleteHanko = async () => {
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
        console.log('🎯 Running complete Hanko test suite...');
        await runCompleteHankoTests();
        console.log('✅ Complete Hanko tests passed!');
    }
    catch (error) {
        console.error('❌ Complete Hanko tests failed:', error);
        throw error;
    }
};
// Create a wrapper for runDemo that provides better browser feedback
const runDemoWrapper = async (env) => {
    try {
        console.log('🚀 Starting XLN Consensus Demo...');
        console.log('📊 This will demonstrate entity creation, consensus, and message passing');
        const result = await runDemo(env);
        console.log('✅ XLN Demo completed successfully!');
        console.log('🎯 Check the entity cards above to see the results');
        console.log('🕰️ Use the time machine to replay the consensus steps');
        // J-watcher is already started in main(), no need to start again
        return result;
    }
    catch (error) {
        console.error('❌ XLN Demo failed:', error);
        throw error;
    }
};
// === ENVIRONMENT UTILITIES ===
export const createEmptyEnv = () => {
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
export const processUntilEmpty = async (env, inputs) => {
    let outputs = inputs || [];
    let iterationCount = 0;
    const maxIterations = 10; // Safety limit
    // Only log cascade details if there are outputs to process
    if (outputs.length > 0) {
        console.log('🔥 PROCESS-CASCADE: Starting with', outputs.length, 'initial outputs');
        console.log('🔥 PROCESS-CASCADE: Initial outputs:', outputs.map(o => ({
            entityId: o.entityId.slice(0, 8) + '...',
            signerId: o.signerId,
            txs: o.entityTxs?.length || 0,
            precommits: o.precommits?.size || 0,
            hasFrame: !!o.proposedFrame,
        })));
    }
    // DEBUG: Log transaction details for vote transactions
    outputs.forEach((output, i) => {
        if (output.entityTxs?.some(tx => tx.type === 'vote')) {
            console.log(`🗳️ VOTE-DEBUG: Input ${i + 1} contains vote transactions:`, output.entityTxs.filter(tx => tx.type === 'vote'));
        }
    });
    while (outputs.length > 0 && iterationCount < maxIterations) {
        iterationCount++;
        console.log(`🔥 PROCESS-CASCADE: Iteration ${iterationCount} - processing ${outputs.length} outputs`);
        const result = await applyServerInput(env, { serverTxs: [], entityInputs: outputs });
        outputs = result.entityOutbox;
        console.log(`🔥 PROCESS-CASCADE: Iteration ${iterationCount} generated ${outputs.length} new outputs`);
        if (outputs.length > 0) {
            console.log('🔥 PROCESS-CASCADE: New outputs:', outputs.map(o => ({
                entityId: o.entityId.slice(0, 8) + '...',
                signerId: o.signerId,
                txs: o.entityTxs?.length || 0,
                precommits: o.precommits?.size || 0,
                hasFrame: !!o.proposedFrame,
            })));
        }
    }
    if (iterationCount >= maxIterations && outputs.length > 0) {
        console.error('❌ processUntilEmpty reached maximum iterations with outputs remaining!');
        console.error('❌ This indicates an infinite loop in entity communication.');
        console.error('❌ Remaining outputs:', outputs.length);
        throw new Error(`Infinite loop detected: ${outputs.length} outputs remain after ${maxIterations} iterations`);
    }
    else if (iterationCount > 0) {
        console.log(`🔥 PROCESS-CASCADE: Completed after ${iterationCount} iterations`);
    }
    return env;
};
// === NAME RESOLUTION WRAPPERS (override imports) ===
const searchEntityNames = (query, limit) => searchEntityNamesOriginal(db, query, limit);
const resolveEntityName = (entityId) => resolveEntityNameOriginal(db, entityId);
const getEntityDisplayInfoFromProfile = (entityId) => getEntityDisplayInfoFromProfileOriginal(db, entityId);
