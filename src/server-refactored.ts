// === MAIN SERVER FILE (REFACTORED) ===
// for regular use > bun run src/server-refactored.ts
// for debugging > bun repl 
// await import('./debug.js'); 

// Environment detection and compatibility layer
const isBrowser = typeof window !== 'undefined';

// Browser polyfill for Uint8Array.toString()
if (isBrowser) {
  (Uint8Array.prototype as any).toString = function(encoding: string = 'utf8') {
    return new TextDecoder().decode(this);
  };
}

// Simplified debug configuration
const createDebug = (namespace: string) => {
  const shouldLog = namespace.includes('state') || namespace.includes('tx') || 
                   namespace.includes('block') || namespace.includes('error') || 
                   namespace.includes('diff') || namespace.includes('info');
  return shouldLog ? console.log.bind(console, `[${namespace}]`) : () => {};
};

const debug = isBrowser ? createDebug : require('debug');

// Configure debug logging with functional approach
const log = {
  state: debug('state:🔵'),
  tx: debug('tx:🟡'),
  block: debug('block:🟢'),
  error: debug('error:🔴'),
  diff: debug('diff:🟣'),
  info: debug('info:ℹ️')
};

declare const console: any;
let DEBUG = true;

// Import all modules
import { Env, ServerInput, EntityInput } from './types.js';
import { hash, ENC } from './crypto-utils.js';
import { 
  generateLazyEntityId, 
  generateNumberedEntityId, 
  generateNamedEntityId,
  detectEntityType,
  extractNumberFromEntityId,
  encodeBoard,
  hashBoard,
  resolveEntityIdentifier,
  isEntityRegistered
} from './entity-utils.js';
import {
  createLazyEntity,
  createNumberedEntity,
  requestNamedEntity,
  transferNameBetweenEntities
} from './entity-factory.js';
import {
  connectToEthereum,
  registerNumberedEntityOnChain,
  assignNameOnChain,
  getEntityInfoFromChain,
  getNextEntityNumber,
  getContractAddress
} from './blockchain.js';
import {
  generateJurisdictions,
  DEFAULT_JURISDICTIONS,
  getAvailableJurisdictions,
  getJurisdictionByAddress,
  registerEntityInJurisdiction
} from './jurisdictions.js';
import {
  processServerInput,
  processUntilEmpty
} from './consensus-engine.js';
import {
  captureSnapshot,
  clearDatabase,
  resetHistory,
  getHistory,
  getSnapshot,
  getCurrentHistoryIndex,
  loadFromDatabase
} from './snapshot-manager.js';
import { runDemo, runTests } from './demo.js';

// This is the new, robust main function that replaces the old one.
const main = async (): Promise<Env> => {
  const { env, snapshots } = await loadFromDatabase();

  // If env is still null, create a fresh environment
  if (!env) {
    console.log('No saved state found, creating a new environment.');
    return {
      replicas: new Map(),
      height: 0,
      timestamp: Date.now(),
      serverInput: { serverTxs: [], entityInputs: [] }
    };
  }

  return env;
};

// === BLOCKCHAIN VERIFICATION ===
const verifyJurisdictionRegistrations = async () => {
  console.log('\n🔍 === JURISDICTION VERIFICATION ===');
  console.log('📋 Verifying entity registrations across all jurisdictions...\n');
  
  const jurisdictions = Array.from(DEFAULT_JURISDICTIONS.values());
  
  for (const jurisdiction of jurisdictions) {
    try {
      console.log(`🏛️ ${jurisdiction.name}:`);
      console.log(`   📡 RPC: ${jurisdiction.address}`);
      console.log(`   📄 Contract: ${jurisdiction.entityProviderAddress}`);
      
      // Connect to this jurisdiction's network
      const { entityProvider } = await connectToEthereum(jurisdiction.address, jurisdiction.entityProviderAddress);
      
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

// Export all public functions
export { 
  runDemo, 
  processServerInput, 
  main, 
  getHistory, 
  getSnapshot, 
  resetHistory, 
  getCurrentHistoryIndex, 
  clearDatabase, 
  runTests, 
  getAvailableJurisdictions, 
  getJurisdictionByAddress, 
  registerEntityInJurisdiction,
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
  // Blockchain registration functions
  registerNumberedEntityOnChain,
  assignNameOnChain,
  getEntityInfoFromChain,
  getNextEntityNumber,
  connectToEthereum,
  transferNameBetweenEntities,
  isEntityRegistered
};

// --- Node.js auto-execution for local testing ---
// This part will only run when the script is executed directly in Node.js.
if (!isBrowser) {
  main().then(async env => {
    if (env) {
      console.log('✅ Node.js environment initialized. Running demo for local testing...');
      runDemo(env);
      
      // Add a small delay to ensure demo completes before verification
      setTimeout(async () => {
        await verifyJurisdictionRegistrations();
      }, 2000);
    }
  }).catch(error => {
    console.error('❌ An error occurred during Node.js auto-execution:', error);
  });
}
