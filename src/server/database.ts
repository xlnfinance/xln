import { Level } from 'level';

import { createGossipLayer } from '../gossip';
import { Env } from '../types';
import { clearDatabase } from '../utils';

// --- Database Setup ---
// Level polyfill: Node.js uses filesystem, Browser uses IndexedDB
export const db: Level<Buffer, Buffer> = new Level('db', {
  valueEncoding: 'buffer',
  keyEncoding: 'binary',
});

// Server-specific clearDatabase that also resets history
export const clearDatabaseAndHistory = async (): Promise<Env> => {
  console.log('🗑️ Clearing database and resetting server history...');

  // Clear the Level database
  await clearDatabase(db);

  // Reset the server environment to initial state (including history)
  const env: Env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: createGossipLayer(),
  };

  console.log('✅ Database and server history cleared');
  return env;
};
