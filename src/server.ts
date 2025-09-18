// for regular use > bun run src/server.ts
// for debugging > bun repl
// await import('./debug.js');

// === IMPORTS ===
// Core modules
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
  transferNameBetweenEntities,
} from './evm';
import { createProfileUpdateTx } from './name-resolution';
import { runDemo } from './rundemo';
// Server modules
import { clearDatabaseAndHistory, db } from './server/database';
import { createEmptyEnv, registerEnvChangeCallback } from './server/environment';
import { initializeServer, runNodeAutoExecution } from './server/initialization';
import {
  applyServerInput as applyServerInputFromModule,
  processUntilEmpty as processUntilEmptyFromModule,
} from './server/processing';
import { Env } from './types';
import {
  clearDatabase,
  formatEntityDisplay,
  formatSignerDisplay,
  generateEntityAvatar,
  generateSignerAvatar,
  getEntityDisplayInfo,
  getSignerDisplayInfo,
  isBrowser,
} from './utils';

declare const console: any;

// Module-level environment variable
let env: Env;

// === WRAPPER FUNCTIONS FOR BACKWARD COMPATIBILITY ===
const applyServerInput = (env: Env, serverInput: any) => applyServerInputFromModule(db, env, serverInput);
const processUntilEmpty = (env: Env, inputs?: any[]) => processUntilEmptyFromModule(env, db, inputs);

// History functions
const getHistory = () => env?.history || [];
const getSnapshot = (index: number) => {
  const history = env?.history || [];
  return index >= 0 && index < history.length ? history[index] : null;
};
const getCurrentHistoryIndex = () => (env?.history || []).length - 1;

// Name resolution wrappers
const searchEntityNames = (query: string, limit?: number) => {
  // For now, return empty array - this can be enhanced later
  return [];
};
const resolveEntityName = (entityId: string) => {
  // For now, return null - this can be enhanced later
  return null;
};
const getEntityDisplayInfoFromProfile = (entityId: string) => {
  // For now, return null - this can be enhanced later
  return null;
};

// Demo wrappers
const demoCompleteHanko = () => {
  console.log('🎯 Hanko demo functionality available via modules');
};
const runDemoWrapper = (env: Env) => {
  console.log('🚀 Demo wrapper functionality available via modules');
  return runDemo(env);
};

// Verification wrapper
const verifyJurisdictionRegistrations = () => {
  console.log('🔍 Jurisdiction verification functionality available via modules');
};

// === MAIN SERVER INITIALIZATION ===

// Main initialization function
const main = async (): Promise<Env> => {
  env = await initializeServer(db);
  return env;
};

// === NODE.JS AUTO-EXECUTION ===
// This part will only run when the script is executed directly in Node.js.
if (!isBrowser) {
  main()
    .then(async env => {
      await runNodeAutoExecution(env);
    })
    .catch(error => {
      console.error('❌ An error occurred during Node.js auto-execution:', error);
    });
}

// === EXPORTS ===
export {
  applyServerInput,
  assignNameOnChain,
  clearDatabase,
  clearDatabaseAndHistory,
  connectToEthereum,
  createEmptyEnv,
  createLazyEntity,
  createNumberedEntity,
  createProfileUpdateTx,
  db,
  debugFundReserves,
  demoCompleteHanko,
  detectEntityType,
  encodeBoard,
  formatEntityDisplay,
  formatSignerDisplay,
  generateEntityAvatar,
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
  processUntilEmpty,
  registerEnvChangeCallback,
  registerNumberedEntityOnChain,
  requestNamedEntity,
  resolveEntityIdentifier,
  resolveEntityName,
  runDemo,
  runDemoWrapper,
  searchEntityNames,
  submitProcessBatch,
  transferNameBetweenEntities,
  verifyJurisdictionRegistrations,
};
