// for regular use > bun run src/server.ts
// for debugging > bun repl
// await import('./debug.js');

// Import utilities and types
import {
  isBrowser,
  log,
  hash,
  DEBUG,
  clearDatabase,
  createHash,
  formatEntityDisplay,
  formatSignerDisplay,
  generateEntityAvatar,
  generateSignerAvatar,
  getEntityDisplayInfo,
  getSignerDisplayInfo,
} from './utils.js';
import {
  Env,
  EnvSnapshot,
  EntityInput,
  EntityReplica,
  EntityState,
  EntityTx,
  ServerInput,
  ServerTx,
  ProposedEntityFrame,
  Proposal,
  ProposalAction,
  ConsensusConfig,
  JurisdictionConfig,
  ENC,
} from './types.js';
import {
  createLazyEntity,
  createNumberedEntity,
  requestNamedEntity,
  resolveEntityIdentifier,
  generateLazyEntityId,
  generateNumberedEntityId,
  generateNamedEntityId,
  detectEntityType,
  extractNumberFromEntityId,
  encodeBoard,
  hashBoard,
  isEntityRegistered,
} from './entity-factory.js';
import {
  applyEntityInput,
  applyEntityFrame,
  calculateQuorumPower,
  sortSignatures,
  mergeEntityInputs,
  getEntityStateSummary,
} from './entity-consensus.js';
// import { applyEntityTx, generateProposalId, executeProposal } from './entity-tx.js';

import {
  registerNumberedEntityOnChain,
  assignNameOnChain,
  getEntityInfoFromChain,
  getNextEntityNumber,
  transferNameBetweenEntities,
  connectToEthereum,
  getJurisdictions,
  getAvailableJurisdictions,
  getJurisdictionByAddress,
} from './evm.js';
import { runDemo } from './rundemo.js';

import { testFullCycle } from './hanko-real.js';
import { runDepositoryHankoTests } from './test-depository-hanko.js';
import { runBasicHankoTests } from './test-hanko-basic.js';
import { runAllTests as runCompleteHankoTests } from './test-hanko-complete.js';
import {
  initializeDemoProfiles,
  getProfile,
  storeProfile,
  searchEntityNames as searchEntityNamesOriginal,
  resolveEntityName as resolveEntityNameOriginal,
  getEntityDisplayInfo as getEntityDisplayInfoFromProfileOriginal,
  processProfileUpdate,
  createProfileUpdateTx,
} from './name-resolution.js';

// High-level database using Level polyfill (works in both Node.js and browser)
import { Level } from 'level';
import { encode, decode } from './snapshot-coder.js';
// import { ethers } from 'ethers';
// import path from 'path';
// import fs from 'fs';
import { createCachedMPTStorage } from './entity-cached-storage.js';

// --- Global DB for snapshots, name resolution, registry ---
const globalDb: Level<Buffer, Buffer> = new Level('db/global', {
  valueEncoding: 'buffer',
  keyEncoding: 'binary',
});

// --- Global history for time machine ---
let envHistory: EnvSnapshot[] = [];

// --- Snapshot utilities ---
const captureSnapshot = (
  env: Env,
  serverInput: ServerInput,
  serverOutputs: EntityInput[],
  description: string,
): void => {
  const snapshot: EnvSnapshot = {
    height: env.height,
    timestamp: env.timestamp,
    replicas: new Map(env.replicas), // store in-memory state only
    serverInput,
    serverOutputs,
    description,
  };

  envHistory.push(snapshot);

  const batch = globalDb.batch();
  batch.put(Buffer.from(`snapshot:${snapshot.height}`), encode(snapshot));
  batch.put(Buffer.from('latest_height'), Buffer.from(snapshot.height.toString()));
  batch.write();

  if (DEBUG) console.log(`📸 Snapshot captured: "${description}"`);
};

// --- Apply server input (consensus loop) ---
const applyServerInput = async (
  env: Env,
  serverInput: ServerInput,
): Promise<{ entityOutbox: EntityInput[]; mergedInputs: EntityInput[] }> => {
  try {
    if (!serverInput) return { entityOutbox: [], mergedInputs: [] };

    env.serverInput.serverTxs.push(...serverInput.serverTxs);
    env.serverInput.entityInputs.push(...serverInput.entityInputs);

    const mergedInputs = mergeEntityInputs(env.serverInput.entityInputs);
    const entityOutbox: EntityInput[] = [];

    // Import replicas
    for (const serverTx of env.serverInput.serverTxs) {
      if (serverTx.type === 'importReplica') {
        const replicaKey = `${serverTx.entityId}:${serverTx.signerId}`;
        const storage = await createCachedMPTStorage(`db/entities/${serverTx.entityId}`);

        // Try to hydrate existing state from MPT storage
        const persistedHeight = await storage.get<number>('state', 'height');
        let loadedState: EntityState;
        if (persistedHeight !== undefined) {
          const timestamp = (await storage.get<number>('state', 'timestamp')) ?? env.timestamp;
          const messages = (await storage.get<string[]>('state', 'messages')) ?? [];
          const proposals = (await storage.get<Map<string, Proposal>>('state', 'proposals')) ?? new Map();
          const nonces = (await storage.get<Map<string, number>>('state', 'nonces')) ?? new Map();
          const config = (await storage.get<ConsensusConfig>('state', 'config')) ?? serverTx.data.config;

          loadedState = { height: persistedHeight, timestamp, messages, proposals, nonces, config };

          if (DEBUG) {
            const root = await storage.getRoot();
            console.log(
              `📦 Loaded persisted entity state for ${serverTx.entityId} at height ${persistedHeight}, root=${root.slice(0, 16)}...`,
            );
          }
        } else {
          loadedState = {
            height: 0,
            timestamp: env.timestamp,
            nonces: new Map(),
            messages: [],
            proposals: new Map(),
            config: serverTx.data.config,
          };
        }

        env.replicas.set(replicaKey, {
          entityId: serverTx.entityId,
          signerId: serverTx.signerId,
          storage,
          state: loadedState,
          mempool: [],
          isProposer: serverTx.data.isProposer,
        });
      }
    }

    // Process entity inputs
    for (const entityInput of mergedInputs) {
      const replicaKey = `${entityInput.entityId}:${entityInput.signerId}`;
      const entityReplica = env.replicas.get(replicaKey);
      if (entityReplica) {
        const outputs = await applyEntityInput(env, entityReplica, entityInput, entityReplica.storage);
        entityOutbox.push(...outputs);
      }
    }

    env.height++;
    env.timestamp = Date.now();

    const desc = `Tick ${env.height - 1}: ${mergedInputs.length} inputs → ${entityOutbox.length} outputs`;
    captureSnapshot(env, serverInput, entityOutbox, desc);

    env.serverInput.serverTxs.length = 0;
    env.serverInput.entityInputs.length = 0;

    return { entityOutbox, mergedInputs };
  } catch (err) {
    log.error('❌ Error in applyServerInput', err);
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
    serverInput: { serverTxs: [], entityInputs: [] },
  };

  // Then try to load saved state if available
  try {
    if (isBrowser) {
      console.log('🌐 Browser environment: Attempting to load snapshots from IndexedDB...');
    } else {
      console.log('🖥️ Node.js environment: Attempting to load snapshots from filesystem...');
    }

    const latestHeightBuffer = await globalDb.get(Buffer.from('latest_height'));
    const latestHeight = parseInt(latestHeightBuffer.toString(), 10);

    console.log(`📊 Found latest height: ${latestHeight}, loading ${latestHeight + 1} snapshots...`);

    // Load snapshots starting from 1 (height 0 is initial state, no snapshot saved)
    console.log(`📥 Loading snapshots: 1 to ${latestHeight}...`);
    const snapshots = [];

    // Start from 1 since height 0 is initial state with no snapshot
    for (let i = 1; i <= latestHeight; i++) {
      try {
        const buffer = await globalDb.get(Buffer.from(`snapshot:${i}`));
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

  // Initialize demo profiles (works in both Node.js and browser)
  await initializeDemoProfiles(globalDb, env);

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
      console.log(
        'ℹ️  Depository integration tests skipped (contract setup required):',
        (error as Error).message?.substring(0, 100) || 'Unknown error',
      );
    }
  } else {
    console.log('🌐 Browser environment: Demos available via UI buttons, not auto-running');
  }

  log.info(`🎯 Server startup complete. Height: ${env.height}, Entities: ${env.replicas.size}`);

  return env;
};

// === TIME MACHINE API ===
const getHistory = () => envHistory;
const getSnapshot = (index: number) => (index >= 0 && index < envHistory.length ? envHistory[index] : null);
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
  isEntityRegistered,
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

          // Add a small delay to ensure demo completes before verification
          setTimeout(async () => {
            await verifyJurisdictionRegistrations();
          }, 2000);
        } else {
          console.log('✅ Node.js environment initialized. Demo skipped (NO_DEMO=1 or --no-demo)');
          console.log('💡 Use XLN.runDemo(env) to run demo manually if needed');
        }
      }
    })
    .catch((error) => {
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

// === ENVIRONMENT CREATION UTILITIES ===
export const createEmptyEnv = (): Env => {
  return {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
  };
};

// === CONSENSUS PROCESSING UTILITIES ===
export const processUntilEmpty = async (env: Env, inputs?: EntityInput[]) => {
  let outputs = inputs || [];
  let iterationCount = 0;
  const maxIterations = 10; // Safety limit

  console.log('🔥 PROCESS-CASCADE: Starting with', outputs.length, 'initial outputs');
  console.log(
    '🔥 PROCESS-CASCADE: Initial outputs:',
    outputs.map((o) => ({
      entityId: o.entityId.slice(0, 8) + '...',
      signerId: o.signerId,
      txs: o.entityTxs?.length || 0,
      precommits: o.precommits?.size || 0,
      hasFrame: !!o.proposedFrame,
    })),
  );

  while (outputs.length > 0 && iterationCount < maxIterations) {
    iterationCount++;
    console.log(`🔥 PROCESS-CASCADE: Iteration ${iterationCount} - processing ${outputs.length} outputs`);

    const result = await applyServerInput(env, { serverTxs: [], entityInputs: outputs });
    outputs = result.entityOutbox;

    console.log(`🔥 PROCESS-CASCADE: Iteration ${iterationCount} generated ${outputs.length} new outputs`);
    if (outputs.length > 0) {
      console.log(
        '🔥 PROCESS-CASCADE: New outputs:',
        outputs.map((o) => ({
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
  } else {
    console.log(`🔥 PROCESS-CASCADE: Completed after ${iterationCount} iterations`);
  }

  return env;
};

// === NAME RESOLUTION WRAPPERS (override imports) ===
const searchEntityNames = (query: string, limit?: number) => searchEntityNamesOriginal(globalDb, query, limit);
const resolveEntityName = (entityId: string) => resolveEntityNameOriginal(globalDb, entityId);
const getEntityDisplayInfoFromProfile = (entityId: string) =>
  getEntityDisplayInfoFromProfileOriginal(globalDb, entityId);
