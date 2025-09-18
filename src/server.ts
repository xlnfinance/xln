// for regular use > bun run src/server.ts
// for debugging > bun repl
// await import('./debug.js');

// Import utilities and types
// High-level database using Level polyfill (works in both Node.js and browser)
import fs from 'fs';
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
let env: Env;

// Module-level j-watcher instance
let jWatcher: JEventWatcher | null = null;

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
        
        notifyEnvChange(env); // Notify UI of changes
      }
    }, 100); // Check every 100ms to process j-watcher events quickly
    
  } catch (error) {
    console.error('❌ Failed to start J-Event Watcher:', error);
  }
};

// Note: History is now stored in env.history (no global variable needed)

// === SNAPSHOT UTILITIES ===
const deepCloneReplica = (replica: EntityReplica): EntityReplica => {
  const cloneMap = <K, V>(map: Map<K, V>) => new Map(map);
  const cloneArray = <T>(arr: T[]) => [...arr];

  return {
    entityId: replica.entityId,
    signerId: replica.signerId,
    state: {
      entityId: replica.state.entityId, // Clone entityId
      height: replica.state.height,
      timestamp: replica.state.timestamp,
      nonces: cloneMap(replica.state.nonces),
      messages: cloneArray(replica.state.messages),
      proposals: new Map(
        Array.from(replica.state.proposals.entries()).map(([id, proposal]) => [
          id,
          { ...proposal, votes: cloneMap(proposal.votes) },
        ]),
      ),
      config: replica.state.config,
      // 💰 Clone financial state
      reserves: cloneMap(replica.state.reserves),
      channels: cloneMap(replica.state.channels),
      collaterals: cloneMap(replica.state.collaterals),
    },
    mempool: cloneArray(replica.mempool),
    proposal: replica.proposal
      ? {
          height: replica.proposal.height,
          txs: cloneArray(replica.proposal.txs),
          hash: replica.proposal.hash,
          newState: replica.proposal.newState,
          signatures: cloneMap(replica.proposal.signatures),
        }
      : undefined,
    lockedFrame: replica.lockedFrame
      ? {
          height: replica.lockedFrame.height,
          txs: cloneArray(replica.lockedFrame.txs),
          hash: replica.lockedFrame.hash,
          newState: replica.lockedFrame.newState,
          signatures: cloneMap(replica.lockedFrame.signatures),
        }
      : undefined,
    isProposer: replica.isProposer,
  };
};

const captureSnapshot = async (
  env: Env,
  serverInput: ServerInput,
  serverOutputs: EntityInput[],
  description: string,
): Promise<void> => {
  // Convert gossip profiles Map to plain object for serialization
  const profiles: Record<string, Profile> = {};
  console.log(`🔍 SNAPSHOT-DEBUG: env.gossip exists: ${!!env.gossip}`);
  console.log(`🔍 SNAPSHOT-DEBUG: env.gossip.profiles exists: ${!!env.gossip?.profiles}`);
  console.log(`🔍 SNAPSHOT-DEBUG: env.gossip.profiles size: ${env.gossip?.profiles?.size || 0}`);
  if (env.gossip?.profiles) {
    console.log(`🔍 SNAPSHOT-DEBUG: Profile keys:`, Array.from(env.gossip.profiles.keys()));
    for (const [id, profile] of env.gossip.profiles.entries()) {
      profiles[id] = profile;
      console.log(`🔍 SNAPSHOT-DEBUG: Capturing profile ${id}:`, profile.metadata?.name || 'no name');
    }
  }

  const snapshot: EnvSnapshot = {
    height: env.height,
    timestamp: env.timestamp,
    replicas: new Map(Array.from(env.replicas.entries()).map(([key, replica]) => [key, deepCloneReplica(replica)])),
    serverInput: {
      serverTxs: [...serverInput.serverTxs],
      entityInputs: serverInput.entityInputs.map(input => ({
        ...input,
        entityTxs: input.entityTxs ? [...input.entityTxs] : undefined,
        precommits: input.precommits ? new Map(input.precommits) : undefined,
      })),
    },
    serverOutputs: serverOutputs.map(output => ({
      ...output,
      entityTxs: output.entityTxs ? [...output.entityTxs] : undefined,
      precommits: output.precommits ? new Map(output.precommits) : undefined,
    })),
    description,
    gossip: {
      profiles,
    },
  };

  env.history = env.history || [];
  env.history.push(snapshot);

  // --- PERSISTENCE WITH BATCH OPERATIONS ---
  // Use batch operations for better performance
  try {
    const batch = db.batch();
    batch.put(Buffer.from(`snapshot:${snapshot.height}`), encode(snapshot));
    batch.put(Buffer.from('latest_height'), Buffer.from(snapshot.height.toString()));

    await batch.write();

    if (DEBUG) {
      console.log(`💾 Snapshot ${snapshot.height} saved to IndexedDB successfully`);
      console.log(`💾 Saved gossip profiles: ${Object.keys(profiles).length} entries`);
    }
  } catch (error) {
    console.error(`❌ Failed to save snapshot ${snapshot.height} to IndexedDB:`, error);
    throw error;
  }

  if (DEBUG) {
    console.log(`📸 Snapshot captured: "${description}" (${env.history.length} total)`);
    if (serverInput.serverTxs.length > 0) {
      console.log(`    🖥️  ServerTxs: ${serverInput.serverTxs.length}`);
      serverInput.serverTxs.forEach((tx, i) => {
        console.log(
          `      ${i + 1}. ${tx.type} ${tx.entityId}:${tx.signerId} (${tx.data.isProposer ? 'proposer' : 'validator'})`,
        );
      });
    }
    if (serverInput.entityInputs.length > 0) {
      console.log(`    📨 EntityInputs: ${serverInput.entityInputs.length}`);
      serverInput.entityInputs.forEach((input, i) => {
        const parts = [];
        if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
        if (input.precommits?.size) parts.push(`${input.precommits.size} precommits`);
        if (input.proposedFrame) parts.push(`frame: ${input.proposedFrame.hash.slice(0, 10)}...`);
        console.log(`      ${i + 1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
      });
    }
  }
};

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
          if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
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
            reserves: new Map(),
            channels: new Map(),
            collaterals: new Map(),
            
            // 🔭 J-machine tracking
            jBlock: 0,
          },
          mempool: [],
          isProposer: serverTx.data.isProposer,
        });
        console.log(`🔍 REPLICA-DEBUG: Added replica ${replicaKey}, total replicas now: ${env.replicas.size}`);
      }
    });
    console.log(`🔍 REPLICA-DEBUG: After processing serverTxs, total replicas: ${env.replicas.size}`);

    // Sync newly created entities with j-watcher for historical events
    console.log(`🔍 J-WATCHER SYNC CHECK: jWatcher=${!!jWatcher}, serverTxs.length=${env.serverInput.serverTxs.length}`);
    if (jWatcher && env.serverInput.serverTxs.length > 0) {
      const hasImportReplica = env.serverInput.serverTxs.some(tx => tx.type === 'importReplica');
      console.log(`🔍 J-WATCHER SYNC CHECK: hasImportReplica=${hasImportReplica}, serverTx types=[${env.serverInput.serverTxs.map(tx => tx.type).join(', ')}]`);
      if (hasImportReplica) {
        console.log('🔄 Triggering j-watcher sync for newly created entities...');
        try {
          const eventsProcessed = await jWatcher.syncNewlyCreatedEntities(env);
          if (eventsProcessed) {
            console.log('🔄✅ Historical events processed individually during sync');
          }
        } catch (error) {
          console.error('🔄❌ Failed to sync newly created entities:', error);
        }
      } else {
        console.log('🔍 J-WATCHER SYNC: No importReplica serverTxs found, skipping sync');
      }
    } else {
      console.log('🔍 J-WATCHER SYNC: Conditions not met for sync trigger');
    }

    // Process entity inputs
    for (const entityInput of mergedInputs) {
      const replicaKey = `${entityInput.entityId}:${entityInput.signerId}`;
      const entityReplica = env.replicas.get(replicaKey);

      console.log(`🔍 REPLICA-LOOKUP: Key="${replicaKey}"`);
      console.log(`🔍 REPLICA-LOOKUP: Found replica: ${!!entityReplica}`);
      console.log(`🔍 REPLICA-LOOKUP: Input txs: ${entityInput.entityTxs?.length || 0}`);
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
          if (entityInput.entityTxs?.length) console.log(`  → ${entityInput.entityTxs.length} transactions`);
          if (entityInput.proposedFrame) console.log(`  → Proposed frame: ${entityInput.proposedFrame.hash}`);
          if (entityInput.precommits?.size) console.log(`  → ${entityInput.precommits.size} precommits`);
        }

        const { newState, outputs } = await applyEntityInput(env, entityReplica, entityInput);
        // CRITICAL FIX: Update the replica in the environment with the new state
        env.replicas.set(replicaKey, { ...entityReplica, state: newState });
        entityOutbox.push(...outputs);
      }
    }

    // Update env (mutable)
    env.height++;
    env.timestamp = Date.now();

    // Capture snapshot BEFORE clearing (to show what was actually processed)
    // Use merged inputs to avoid showing intermediate gossip messages in UI
    const inputDescription = `Tick ${env.height - 1}: ${env.serverInput.serverTxs.length} serverTxs, ${mergedInputs.length} merged entityInputs → ${entityOutbox.length} outputs`;
    const processedInput = {
      serverTxs: [...env.serverInput.serverTxs],
      entityInputs: [...mergedInputs], // Use merged inputs instead of raw inputs
    };

    // Clear processed data from env.serverInput
    env.serverInput.serverTxs.length = 0;
    env.serverInput.entityInputs.length = 0;

    // Capture snapshot with the actual processed input and outputs
    await captureSnapshot(env, processedInput, entityOutbox, inputDescription);

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
        const entityDisplay = formatEntityDisplay(entityId);
        const signerDisplay = formatSignerDisplay(signerId);
        console.log(
          `  Entity #${entityDisplay}:${signerDisplay}: mempool=${replica.mempool.length}, messages=${replica.state.messages.length}, proposal=${replica.proposal ? '✓' : '✗'}`,
        );
      });
    }

    // Performance logging
    const endTime = Date.now();
    if (DEBUG) {
      console.log(`⏱️  Tick ${env.height - 1} completed in ${endTime - startTime}ms`);
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
      console.log('🔍 STARTUP: Current jurisdictions.json content:');
      console.log('📍 Ethereum Depository:', jurisdictions.jurisdictions.ethereum.contracts.depository);
      console.log('📍 Ethereum EntityProvider:', jurisdictions.jurisdictions.ethereum.contracts.entityProvider);
      console.log('📍 Polygon Depository:', jurisdictions.jurisdictions.polygon.contracts.depository);
      console.log('📍 Arbitrum Depository:', jurisdictions.jurisdictions.arbitrum.contracts.depository);
      console.log('📍 Last updated:', jurisdictions.lastUpdated);
      console.log('📍 Full Ethereum config:', JSON.stringify(jurisdictions.jurisdictions.ethereum, null, 2));
    } catch (error) {
      console.log('⚠️ Failed to read jurisdictions.json:', (error as Error).message);
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
      console.log('🌐 Browser environment: Attempting to load snapshots from IndexedDB...');
    } else {
      console.log('🖥️ Node.js environment: Attempting to load snapshots from filesystem...');
    }

    const latestHeightBuffer = await db.get(Buffer.from('latest_height'));
    const latestHeight = parseInt(latestHeightBuffer.toString(), 10);

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

      // Restore gossip profiles from snapshot
      const gossipLayer = createGossipLayer();
      if (latestSnapshot.gossip?.profiles) {
        for (const [id, profile] of Object.entries(latestSnapshot.gossip.profiles)) {
          gossipLayer.profiles.set(id, profile as Profile);
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
  } catch (error: any) {
    if (error.code === 'LEVEL_NOT_FOUND') {
      console.log('📦 No saved state found, using fresh environment');
      if (isBrowser) {
        console.log('💡 Browser: This is normal for first-time use. Database will be created automatically.');
      } else {
        console.log('💡 Node.js: No existing snapshots in db directory.');
      }
    } else {
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
  } else {
    console.log('🌐 Browser environment: Demos available via UI buttons, not auto-running');
  }

  log.info(`🎯 Server startup complete. Height: ${env.height}, Entities: ${env.replicas.size}`);

  // Start j-watcher for real-time blockchain monitoring (both Node.js and browser)  
  try {
    await startJEventWatcher(env);
  } catch (error) {
    console.error('❌ Failed to start J-Event Watcher:', error);
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
  debugFundReserves,
  transferNameBetweenEntities,
  
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

    console.log('🎯 Running complete Hanko test suite...');
    await runCompleteHankoTests();
    console.log('✅ Complete Hanko tests passed!');
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
    console.log(
      '🔥 PROCESS-CASCADE: Initial outputs:',
      outputs.map(o => ({
        entityId: o.entityId.slice(0, 8) + '...',
        signerId: o.signerId,
        txs: o.entityTxs?.length || 0,
        precommits: o.precommits?.size || 0,
        hasFrame: !!o.proposedFrame,
      })),
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

// === NAME RESOLUTION WRAPPERS (override imports) ===
const searchEntityNames = (query: string, limit?: number) => searchEntityNamesOriginal(db, query, limit);
const resolveEntityName = (entityId: string) => resolveEntityNameOriginal(db, entityId);
const getEntityDisplayInfoFromProfile = (entityId: string) => getEntityDisplayInfoFromProfileOriginal(db, entityId);
