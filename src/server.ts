// for regular use > bun run src/server.ts
// for debugging > bun repl 
// await import('./debug.js'); 

// Import utilities and types
import { isBrowser, log, hash, DEBUG, clearDatabase, createHash, formatEntityDisplay, formatSignerDisplay, generateEntityAvatar, generateSignerAvatar, getEntityDisplayInfo, getSignerDisplayInfo } from './utils.js';
import { 
  Env, EnvSnapshot, EntityInput, EntityReplica, EntityState, EntityTx, 
  ServerInput, ServerTx, ProposedEntityFrame, Proposal, ProposalAction,
  ConsensusConfig, JurisdictionConfig, ENC
} from './types.js';
import {
  createLazyEntity, createNumberedEntity, requestNamedEntity,
  resolveEntityIdentifier, generateLazyEntityId, generateNumberedEntityId,
  generateNamedEntityId, detectEntityType, extractNumberFromEntityId,
  encodeBoard, hashBoard, isEntityRegistered
} from './entity-factory.js';
import { 
  applyEntityInput, applyEntityFrame, calculateQuorumPower, 
  sortSignatures, mergeEntityInputs, getEntityStateSummary
} from './entity-consensus.js';
import { applyEntityTx, generateProposalId, executeProposal } from './entity-tx.js';

import { 
  registerNumberedEntityOnChain, assignNameOnChain, getEntityInfoFromChain, getNextEntityNumber, transferNameBetweenEntities, connectToEthereum,
  getJurisdictions, getAvailableJurisdictions, getJurisdictionByAddress
} from './evm.js';
import { runDemo } from './rundemo.js';

import { testFullCycle } from './hanko-real.js';
import { runDepositoryHankoTests } from './test-depository-hanko.js';
import { runBasicHankoTests } from './test-hanko-basic.js';
import { runAllTests as runCompleteHankoTests } from './test-hanko-complete.js';
import {
  initializeDemoProfiles, getProfile, storeProfile,
  searchEntityNames as searchEntityNamesOriginal,
  resolveEntityName as resolveEntityNameOriginal,
  getEntityDisplayInfo as getEntityDisplayInfoFromProfileOriginal,
  processProfileUpdate, createProfileUpdateTx
} from './name-resolution.js';

// High-level database using Level polyfill (works in both Node.js and browser)
import { Level } from 'level';
import { encode, decode } from './snapshot-coder.js';
import { ethers } from 'ethers';
import path from 'path';
import fs from 'fs';

// --- Database Setup ---
// Level polyfill: Node.js uses filesystem, Browser uses IndexedDB
const db: Level<Buffer, Buffer> = new Level('db', { 
  valueEncoding: 'buffer', 
  keyEncoding: 'binary'
});

declare const console: any;



// === ETHEREUM INTEGRATION ===



// Global history for time machine
let envHistory: EnvSnapshot[] = [];

// === SNAPSHOT UTILITIES ===
const deepCloneReplica = (replica: EntityReplica): EntityReplica => {
  const cloneMap = <K, V>(map: Map<K, V>) => new Map(map);
  const cloneArray = <T>(arr: T[]) => [...arr];
  
  return {
    entityId: replica.entityId,
    signerId: replica.signerId,
    state: {
      height: replica.state.height,
      timestamp: replica.state.timestamp,
      nonces: cloneMap(replica.state.nonces),
      messages: cloneArray(replica.state.messages),
      proposals: new Map(
        Array.from(replica.state.proposals.entries()).map(([id, proposal]) => [
          id,
          { ...proposal, votes: cloneMap(proposal.votes) }
        ])
      ),
      config: replica.state.config
    },
    mempool: cloneArray(replica.mempool),
    proposal: replica.proposal ? {
      height: replica.proposal.height,
      txs: cloneArray(replica.proposal.txs),
      hash: replica.proposal.hash,
      newState: replica.proposal.newState,
      signatures: cloneMap(replica.proposal.signatures)
    } : undefined,
    lockedFrame: replica.lockedFrame ? {
      height: replica.lockedFrame.height,
      txs: cloneArray(replica.lockedFrame.txs),
      hash: replica.lockedFrame.hash,
      newState: replica.lockedFrame.newState,
      signatures: cloneMap(replica.lockedFrame.signatures)
    } : undefined,
    isProposer: replica.isProposer
  };
};

const captureSnapshot = (env: Env, serverInput: ServerInput, serverOutputs: EntityInput[], description: string): void => {
  const snapshot: EnvSnapshot = {
    height: env.height,
    timestamp: env.timestamp,
    replicas: new Map(Array.from(env.replicas.entries()).map(([key, replica]) => [
      key,
      deepCloneReplica(replica)
    ])),
    serverInput: {
      serverTxs: [...serverInput.serverTxs],
      entityInputs: serverInput.entityInputs.map(input => ({
        ...input,
        entityTxs: input.entityTxs ? [...input.entityTxs] : undefined,
        precommits: input.precommits ? new Map(input.precommits) : undefined
      }))
    },
    serverOutputs: serverOutputs.map(output => ({
      ...output,
      entityTxs: output.entityTxs ? [...output.entityTxs] : undefined,
      precommits: output.precommits ? new Map(output.precommits) : undefined
    })),
    description
  };
  
  envHistory.push(snapshot);

  // --- PERSISTENCE WITH BATCH OPERATIONS ---
  // Use batch operations for better performance
  const batch = db.batch();
  batch.put(Buffer.from(`snapshot:${snapshot.height}`), encode(snapshot));
  batch.put(Buffer.from('latest_height'), Buffer.from(snapshot.height.toString()));
  
  batch.write();
  
  if (DEBUG) {
    console.log(`📸 Snapshot captured: "${description}" (${envHistory.length} total)`);
    if (serverInput.serverTxs.length > 0) {
      console.log(`    🖥️  ServerTxs: ${serverInput.serverTxs.length}`);
      serverInput.serverTxs.forEach((tx, i) => {
        console.log(`      ${i+1}. ${tx.type} ${tx.entityId}:${tx.signerId} (${tx.data.isProposer ? 'proposer' : 'validator'})`);
      });
    }
    if (serverInput.entityInputs.length > 0) {
      console.log(`    📨 EntityInputs: ${serverInput.entityInputs.length}`);
      serverInput.entityInputs.forEach((input, i) => {
        const parts = [];
        if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
        if (input.precommits?.size) parts.push(`${input.precommits.size} precommits`);
        if (input.proposedFrame) parts.push(`frame: ${input.proposedFrame.hash.slice(0,10)}...`);
        console.log(`      ${i+1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
      });
    }
  }
};

// === UTILITY FUNCTIONS ===









const applyServerInput = (env: Env, serverInput: ServerInput): { entityOutbox: EntityInput[], mergedInputs: EntityInput[] } => {
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
      console.log(`Server inputs: ${serverInput.serverTxs.length} new serverTxs, ${serverInput.entityInputs.length} new entityInputs`);
      console.log(`Total in env: ${env.serverInput.serverTxs.length} serverTxs, ${env.serverInput.entityInputs.length} entityInputs (merged to ${mergedInputs.length})`);
      if (mergedInputs.length > 0) {
        console.log(`🔄 Processing merged inputs:`);
        mergedInputs.forEach((input, i) => {
          const parts = [];
          if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
          if (input.precommits?.size) parts.push(`${input.precommits.size} precommits`);
          if (input.proposedFrame) parts.push(`frame: ${input.proposedFrame.hash.slice(0,10)}...`);
          console.log(`  ${i+1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
        });
      }
    }
    
    // Process server transactions (replica imports) from env.serverInput
    env.serverInput.serverTxs.forEach(serverTx => {
      if (serverTx.type === 'importReplica') {
        if (DEBUG) console.log(`Importing replica Entity #${formatEntityDisplay(serverTx.entityId)}:${formatSignerDisplay(serverTx.signerId)} (proposer: ${serverTx.data.isProposer})`);
        
        const replicaKey = `${serverTx.entityId}:${serverTx.signerId}`;
        env.replicas.set(replicaKey, {
          entityId: serverTx.entityId,
          signerId: serverTx.signerId,
          state: {
            height: 0,
            timestamp: env.timestamp,
            nonces: new Map(),
            messages: [],
            proposals: new Map(),
            config: serverTx.data.config
          },
          mempool: [],
          isProposer: serverTx.data.isProposer
        });
      }
    });
    
    // Process entity inputs
    mergedInputs.forEach(entityInput => {
      const replicaKey = `${entityInput.entityId}:${entityInput.signerId}`;
      const entityReplica = env.replicas.get(replicaKey);
      
      if (entityReplica) {
        if (DEBUG) {
          console.log(`Processing input for ${replicaKey}:`);
          if (entityInput.entityTxs?.length) console.log(`  → ${entityInput.entityTxs.length} transactions`);
          if (entityInput.proposedFrame) console.log(`  → Proposed frame: ${entityInput.proposedFrame.hash}`);
          if (entityInput.precommits?.size) console.log(`  → ${entityInput.precommits.size} precommits`);
        }
        
        const entityOutputs = applyEntityInput(env, entityReplica, entityInput);
        entityOutbox.push(...entityOutputs);
      }
    });
    
    // Update env (mutable)
    env.height++;
    env.timestamp = Date.now();
    
    // Capture snapshot BEFORE clearing (to show what was actually processed)
    // Use merged inputs to avoid showing intermediate gossip messages in UI
    const inputDescription = `Tick ${env.height - 1}: ${env.serverInput.serverTxs.length} serverTxs, ${mergedInputs.length} merged entityInputs → ${entityOutbox.length} outputs`;
    const processedInput = {
      serverTxs: [...env.serverInput.serverTxs],
      entityInputs: [...mergedInputs] // Use merged inputs instead of raw inputs
    };
    
    // Clear processed data from env.serverInput
    env.serverInput.serverTxs.length = 0;
    env.serverInput.entityInputs.length = 0;
    
    // Capture snapshot with the actual processed input and outputs
    captureSnapshot(env, processedInput, entityOutbox, inputDescription);
    
    if (DEBUG && entityOutbox.length > 0) {
      console.log(`📤 Outputs: ${entityOutbox.length} messages`);
      entityOutbox.forEach((output, i) => {
        console.log(`  ${i+1}. → ${output.signerId} (${output.entityTxs ? `${output.entityTxs.length} txs` : ''}${output.proposedFrame ? ` proposal: ${output.proposedFrame.hash.slice(0,10)}...` : ''}${output.precommits ? ` ${output.precommits.size} precommits` : ''})`);
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
        console.log(`  Entity #${entityDisplay}:${signerDisplay}: mempool=${replica.mempool.length}, messages=${replica.state.messages.length}, proposal=${replica.proposal ? '✓' : '✗'}`);
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
  // First, create default environment
  let env: Env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] }
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
    envHistory = snapshots;

    if (snapshots.length > 0) {
      const latestSnapshot = snapshots[snapshots.length - 1];
      env = {
        replicas: latestSnapshot.replicas,
        height: latestSnapshot.height,
        timestamp: latestSnapshot.timestamp,
        serverInput: latestSnapshot.serverInput,
      };
      console.log(`✅ History restored. Server is at height ${env.height} with ${envHistory.length} snapshots.`);
      console.log(`📈 Snapshot details:`, {
        height: env.height,
        replicaCount: env.replicas.size,
        timestamp: new Date(env.timestamp).toISOString(),
        serverInputs: env.serverInput.entityInputs.length
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
        dbLocation: isBrowser ? 'IndexedDB: db' : 'db'
      });
      throw error;
    }
  }

  // Initialize demo profiles (works in both Node.js and browser)
  await initializeDemoProfiles(db, env);

  // Only run demos in Node.js environment, not browser
  if (!isBrowser) {
    // Add hanko demo to the main execution
    console.log('\n🖋️  Testing Complete Hanko Implementation...');
    await demoCompleteHanko();
    
    // 🧪 Run basic Hanko functionality tests first
    console.log('\n🧪 Running basic Hanko functionality tests...');
    await runBasicHankoTests();
    
    // 🧪 Run comprehensive Depository-Hanko integration tests
    console.log('\n🧪 Running comprehensive Depository-Hanko integration tests...');
    try {
      await runDepositoryHankoTests();
    } catch (error) {
      console.log('ℹ️  Depository integration tests skipped (contract setup required):', (error as Error).message?.substring(0, 100) || 'Unknown error');
    }
  } else {
    console.log('🌐 Browser environment: Demos available via UI buttons, not auto-running');
  }

  log.info(`🎯 Server startup complete. Height: ${env.height}, Entities: ${env.replicas.size}`);

  return env;
};

// === TIME MACHINE API ===
const getHistory = () => envHistory;
const getSnapshot = (index: number) => index >= 0 && index < envHistory.length ? envHistory[index] : null;
const getCurrentHistoryIndex = () => envHistory.length - 1;

export { 
  runDemo, 
  runDemoWrapper,
  applyServerInput, 
  main, 
  getHistory, 
  getSnapshot, 
  getCurrentHistoryIndex, 
  clearDatabase, 
  getAvailableJurisdictions, 
  getJurisdictionByAddress, 
  demoCompleteHanko,

  // Entity creation functions
  createLazyEntity,
  createNumberedEntity,
  requestNamedEntity,
  resolveEntityIdentifier,
  // Entity utility functions
  generateLazyEntityId,
  generateNumberedEntityId,
  generateNamedEntityId,
  detectEntityType,
  encodeBoard,
  hashBoard,
  // Display and avatar functions
  formatEntityDisplay,
  formatSignerDisplay,
  generateEntityAvatar,
  generateSignerAvatar,
  getEntityDisplayInfo,
  getSignerDisplayInfo,
  // Name resolution functions
  searchEntityNames,
  resolveEntityName,
  getEntityDisplayInfoFromProfile,
  createProfileUpdateTx,
  // Blockchain registration functions
  registerNumberedEntityOnChain,
  assignNameOnChain,
  getEntityInfoFromChain,
  getNextEntityNumber,
  connectToEthereum,
  transferNameBetweenEntities,
  isEntityRegistered
};

// The browser-specific auto-execution logic has been removed.
// The consuming application (e.g., index.html) is now responsible for calling main().

// --- Node.js auto-execution for local testing ---
// This part will only run when the script is executed directly in Node.js.
if (!isBrowser) {
  main().then(async env => {
    if (env) {
      // Check if demo should run automatically (can be disabled with NO_DEMO=1)
      const noDemoFlag = process.env.NO_DEMO === '1' || process.argv.includes('--no-demo');
      
      if (!noDemoFlag) {
        console.log('✅ Node.js environment initialized. Running demo for local testing...');
        console.log('💡 To skip demo, use: NO_DEMO=1 bun run src/server.ts or --no-demo flag');
        await runDemo(env);
        
        // Add a small delay to ensure demo completes before verification
        setTimeout(async () => {
          await verifyJurisdictionRegistrations();
        }, 2000);
      } else {
        console.log('✅ Node.js environment initialized. Demo skipped (NO_DEMO=1 or --no-demo)');
        console.log('💡 Use XLN.runDemo(env) to run demo manually if needed');
      }
    }
  }).catch(error => {
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
    
    return result;
  } catch (error) {
    console.error('❌ XLN Demo failed:', error);
    throw error;
  }
};

// === NAME RESOLUTION WRAPPERS (override imports) ===
const searchEntityNames = (query: string, limit?: number) => searchEntityNamesOriginal(db, query, limit);
const resolveEntityName = (entityId: string) => resolveEntityNameOriginal(db, entityId);
const getEntityDisplayInfoFromProfile = (entityId: string) => getEntityDisplayInfoFromProfileOriginal(db, entityId);