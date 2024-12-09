import { Level } from 'level';
import cbor from 'cbor'; // For CBOR encoding and decoding

/**
 * HSTM - Hierachical State-Time Machine
 */ 
type Snap = {
  prevSnap: Buffer | null; // Reference to the previous state
  input: Map<Buffer, any>; // Input messages
  state: Map<Buffer, any>; // Current state
  output: Map<Buffer, any>; // Output messages
  timestamp: number;        // Timestamp of the snap
};

type STM = {
  db: Level; // Persistent database
  cache: Map<Buffer, any>; // In-memory cache
  diff: Map<Buffer, any>; // Unsaved changes
};

type Input = Map<Buffer, any>;

// Initialize an STM instance with binary and CBOR encoding
async function createSTM(dbPath: string): Promise<STM> {
  console.log('Initializing STM...');
  const db = new Level<Buffer, Buffer>(dbPath, {
    keyEncoding: 'binary',
    valueEncoding: 'binary',
  });
  
  const cache = new Map<Buffer, any>();
  const diff = new Map<Buffer, any>();

  // Load the initial state from the database into the cache
  const iterator = db.iterator();
  for await (const [key, value] of iterator) {
    cache.set(Buffer.from(key), cbor.decode(value));
  }
  console.log('STM initialized with state:', Array.from(cache.entries()));
  return { db, cache, diff };
}

// Process a new snap (state transition)
function processSnap(prevState: Map<Buffer, any>, input: Input): { newState: Map<Buffer, any>; output: Map<Buffer, any> } {
  console.log('Processing snap...');
  const newState = new Map(prevState); // Copy the previous state

  // Apply inputs to create the new state
  for (const [key, value] of input.entries()) {
    console.log(`Applying input: ${key.toString('hex')} => ${value}`);
    newState.set(key, value);
  }

  // Generate outputs (mirroring inputs for simplicity)
  const output = new Map(input);

  console.log('Snap processed with new state:', Array.from(newState.entries()));
  return { newState, output };
}

// Commit a new snap to the STM
async function commitSnap(stm: STM, input: Input): Promise<Buffer> {
  const { cache, diff, db } = stm;

  console.log('Committing new snap...');
  const prevState = new Map(cache); // Use the current cache as the previous state
  const { newState, output } = processSnap(prevState, input);

  // Generate a new snap
  const timestamp = Date.now();
  const newSnap: Snap = {
    prevSnap: cache.size > 0 ? Buffer.from([...cache.keys()].pop()!) : null,
    input,
    state: newState,
    output,
    timestamp,
  };

  const snapId = Buffer.from(timestamp.toString()).toString('hex');

  // Update the diff map with the new state changes
  for (const [key, value] of newState.entries()) {
    diff.set(key, value);
  }

  // Serialize snap with CBOR and persist the snap itself
  await db.put(Buffer.from(snapId, 'hex'), cbor.encode(newSnap));
  console.log(`Snap committed with ID: ${snapId}`);

  // Update the in-memory cache to reflect the new state
  stm.cache = newState;

  return Buffer.from(snapId, 'hex');
}

// Flush the diff map as a batch to the database and update the cache
async function flushDiff(stm: STM): Promise<void> {
  const { db, cache, diff } = stm;

  console.log('Flushing diff to database...');
  const batch = db.batch();
  for (const [key, value] of diff.entries()) {
    console.log(`Flushing key: ${key.toString('hex')} => ${value}`);
    batch.put(key, cbor.encode(value));
    cache.set(key, value); // Simultaneously update the cache
  }
  await batch.write();
  diff.clear(); // Clear the diff map after flushing
  console.log('Diff flushed and cache updated.');
}

// Query the current state of the STM
function getCurrentState(stm: STM): Map<Buffer, any> {
  console.log('Retrieving current state...');
  return stm.cache;
}

// Example Usage
(async () => {
  const stm = await createSTM('./stm-db');

  // Example input
  const input1 = new Map<Buffer, any>([
    [Buffer.from('key1'), 'value1'],
    [Buffer.from('key2'), 42],
  ]);

  // Commit the first snap
  const snapId1 = await commitSnap(stm, input1);
  console.log('Snap ID 1:', snapId1.toString('hex'));
  console.log('State after snap 1:', Array.from(getCurrentState(stm).entries()));

  // Example second input
  const input2 = new Map<Buffer, any>([
    [Buffer.from('key1'), 'newValue1'],
    [Buffer.from('key3'), 'value3'],
  ]);

  // Commit the second snap
  const snapId2 = await commitSnap(stm, input2);
  console.log('Snap ID 2:', snapId2.toString('hex'));
  console.log('State after snap 2:', Array.from(getCurrentState(stm).entries()));

  // Flush the diff map
  await flushDiff(stm);
  console.log('Final State:', Array.from(getCurrentState(stm).entries()));
})();


