import {Level} from 'level';
import { randomBytes, createHash } from 'crypto';
import { encode, decode } from 'rlp';
import { WebSocket, WebSocketServer } from 'ws';
import repl from 'repl';
import { EntityInput, EntityRoot, EntityBlock, EntityStorage, encodeEntityRoot, decodeEntityRoot, executeEntityBlock, flushEntity, executeEntityTx, decodeTxArg } from './entity.js';
import { createMerkleStore, StorageType } from './storage/merkle.js'
import debug from 'debug';

// Enable all debug namespaces
debug.enable('state:*,tx:*,block:*,error:*,diff:*,merkle:*');

// Ensure that your tsconfig.json has "esModuleInterop": true.

// DBs for log and mutable state
const logDb = new Level<Buffer, Buffer>('./db/log', { keyEncoding: 'binary', valueEncoding: 'binary' });
const stateDb = new Level<Buffer, Buffer>('./db/state', { keyEncoding: 'binary', valueEncoding: 'binary' });
const entityLogDb = new Level<Buffer, Buffer>('./db/entitylog', { keyEncoding: 'binary', valueEncoding: 'binary' });

// Use hex for Map/Set keys, Buffers for DB/RLP
const ENC = 'hex' as const;
let blockNumber = 0;
let serverPool = new Map<string, Map<string, EntityInput[]>>();  // signerId -> entityId -> inputs

// Types
type StateValue = ServerRoot | EntityRoot | SignerRoot | Buffer;

// Configure debug logging
const log = {
  state: debug('state:🔵'),
  tx: debug('tx:🟡'),
  block: debug('block:🟢'),
  error: debug('error:🔴'),
  diff: debug('diff:🟣'),
  merkle: debug('merkle:⚪')
};

// Core types with readonly to enforce immutability
type ServerState = {
  pool: ServerInput
  block: number
  merkleStore: ReturnType<typeof createMerkleStore>
  unsaved: Set<string>
  merkleRoot?: Buffer
}

// Add this after types
let serverState: ServerState = createServerState();

// Initialize store
const merkleStore = createMerkleStore()

// Main entry point
async function main() {
  // Create initial state
  let state = createServerState();
  
  // Load existing state
  try {
    log.state('Loading initial state');
    state = await loadAllEntries(state);
    log.state(`Loaded initial state at block ${state.block}`);
    
    state = await replayLog(state);
    log.state(`Replayed log to block ${state.block}`);
  } catch (error) {
    log.error('Failed to load state:', error);
    throw error;
  }

  // Start processing loop in background
  startProcessing(state).catch(error => {
    log.error('Processing loop failed:', error);
    process.exit(1);
  });

  // Call runSelfTest in main
  await runSelfTest(state);
}

// Main loop function that processes the mempool periodically
async function startProcessing(initialState: ServerState): Promise<never> {
  let currentState = initialState;
  
  while (true) {
    try {
      if (currentState.pool.size > 0) {
        currentState = await processMempoolTick(currentState);
        currentState = await saveMutableState(currentState);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } catch (error) {
      log.error('Processing error:', error instanceof Error ? error.message : String(error));
      // Continue processing despite errors
    }
  }
}

// Load state from database
async function loadAllEntries(state: ServerState): Promise<ServerState> {
  log.state('Loading entries from database');
  
  let newState = state;
  
  for await (const [key, value] of stateDb.iterator()) {
    const keyStr = key.toString('hex');
    try {
      if (keyStr === '') {
        // Server root
        const decoded = decode(value as Buffer) as unknown;
        if (!Array.isArray(decoded) || decoded.length !== 3) {
          throw new Error('Invalid server root format');
        }
        const [blockHeight, merkleRoot, timestamp] = decoded as [number, Buffer, number];
        newState = updateState(newState, { block: blockHeight });
      } else if (keyStr.includes('/')) {
        // Entity state
        const [signerId, entityId] = keyStr.split('/');
        const decoded = decode(value as Buffer) as unknown;
        if (!Array.isArray(decoded)) {
          throw new Error('Invalid entity state format');
        }
        const entries = decoded as [StorageType, Buffer][];
        const nodeValue = new Map(entries);
        
        const blockData = nodeValue.get(StorageType.CURRENT_BLOCK);
        if (!blockData) {
          log.error('Entity has no current block:', { signerId, entityId });
          continue;
        }

        newState.merkleStore.updateEntityState(signerId, entityId, {
          status: 'idle',
          entityPool: new Map(),
          finalBlock: decodeEntityBlock(blockData)
        });
      }
    } catch (error) {
      if (error instanceof Error) {
        log.error('Failed to load entry:', { key: keyStr, error: error.message });
        throw new Error(`Failed to load entry ${keyStr}: ${error.message}`);
      }
      throw error;
    }
  }
  
  return newState;
}

// Save state to database
async function saveMutableState(state: ServerState): Promise<ServerState> {
  log.state('Saving state to database');
  
  try {
    return await saveChanges(state, stateDb);
  } catch (error) {
    if (error instanceof Error) {
      log.error('Failed to save state:', error.message);
      throw new Error(`Failed to save state: ${error.message}`);
    }
    throw error;
  }
}

// Start server
if (import.meta.url === `file://${process.argv[1]}`) {
  const debugMode = process.argv.includes('-d');
  
  main().then(() => {
    if (debugMode) {
      // Start REPL with full context in debug mode
      const r = repl.start('> ');
      Object.assign(r.context, {
        receive,
        serverPool,
        blockNumber,
        serverState,
        logDb,
        stateDb,
        flushChanges,
        calculateMerkleRoot,
        restart: async (bitWidth: number = 4, leafThreshold: number = 16) => {
          log.state('Restarting server with new merkle config:', { bitWidth, leafThreshold });
          
          // Clear databases
          await logDb.clear();
          await stateDb.clear();
          
          // Create new state with configured merkle store
          serverState = createServerState();
          serverState.merkleStore = createMerkleStore({ bitWidth, leafThreshold });
          
          // Run test transactions
          const signerId = randomBytes(32).toString(ENC);
          const entityId = randomBytes(32).toString(ENC);
          
          log.state('Test IDs:', {
            signer: signerId.slice(0,8),
            entity: entityId.slice(0,8)
          });

          // Send test transactions
          try {
            serverState = await receive(serverState, signerId, entityId, {
              type: 'AddEntityTx',
              tx: Buffer.from(encode(['Create']))
            });

            for (let i = 0; i < 20; i++) {
              serverState = await receive(serverState, signerId, entityId, {
                type: 'AddEntityTx',
                tx: Buffer.from(encode(['Increment', Math.floor(Math.random() * 100)]))
              });
              await new Promise(r => setTimeout(r, 50));
            }
          } catch (error) {
            log.error('Test transactions failed:', error);
            throw error;
          }

          log.state('Restart complete');
          return serverState;
        }
      });
    } else {
      // In non-debug mode, exit after main completes
      process.exit(0);
    }
  }).catch(error => {
    log.error('Fatal error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else {
  console.log('Server is not running');
}

// Export for testing
export {
  ServerState,
  createServerState,
  updateState,
  processInput,
  getEntityState,
  createInitialEntityRoot,
  processMempoolTick,
  receive,
  loadAllEntries,
  saveMutableState,
  replayLog,
  printState,
  runSelfTest
};

export type ServerRoot = {
  blockHeight: number;
  merkleRoot: Buffer;
  timestamp: number;
  signers: Map<string, Buffer>;  // signerId -> signerHash
};

export type SignerInput = Map<string, EntityInput[]>;
export type ServerInput = Map<string, SignerInput>;     // signerId -> entityId -> inputs
type StoredValue = ServerRoot | EntityRoot | SignerRoot | Buffer;

// Pure function to create initial state
function createServerState(): ServerState {
  log.state('Creating new server state');
  return {
    pool: new Map(),
    block: 0,
    merkleStore: createMerkleStore(),
    unsaved: new Set(),
    merkleRoot: undefined
  };
}

// Pure function to create a new state with updated values
function updateState(state: ServerState, updates: Partial<ServerState>): ServerState {
  log.state('Updating state:', updates);
  return {
    ...state,
    ...updates,
    // Preserve immutable collections by creating new ones
    pool: updates.pool || new Map(state.pool),
    unsaved: updates.unsaved || new Set(state.unsaved)
  };
}

type LevelDB = Level<Buffer, Buffer>

async function loadState(db: LevelDB): Promise<ServerState> {
  log.state('Loading state from database');
  
  let state = createServerState();
  const batch = new Map<string, Buffer>();
  
  // Load all entries into memory first
  for await (const [key, value] of db.iterator()) {
    batch.set(key.toString('hex'), value);
  }
  
  // Process server root first
  const rootValue = batch.get('');
  if (rootValue) {
    const decoded = decode(rootValue as Buffer) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 3) {
      throw new Error('Invalid server root format');
    }
    const [blockHeight, merkleRoot, timestamp] = decoded as [number, Buffer, number];
    state = updateState(state, { block: blockHeight });
  }

  // Process all entity states with nibble routing
  for (const [key, value] of batch.entries()) {
    if (!key.includes('/')) continue; // Skip non-entity entries
    
    const [signerId, entityId] = key.split('/');
    try {
      const decoded = decode(value as Buffer) as unknown;
      if (!Array.isArray(decoded)) {
        throw new Error('Invalid entity state format');
      }
      const entries = decoded as [StorageType, Buffer][];
      const nodeValue = new Map(entries);
      
      const blockData = nodeValue.get(StorageType.CURRENT_BLOCK);
      if (!blockData) {
        log.error('Entity has no current block:', { signerId, entityId });
        continue;
      }

      // Update entity state with nibble routing
      state.merkleStore.updateEntityState(signerId, entityId, {
        status: 'idle',
        entityPool: new Map(),
        finalBlock: decodeEntityBlock(blockData)
      });
    } catch (error) {
      log.error('Failed to load entity state:', { key, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  
  return state;
}

// Update LevelBatchOp type to match Level's expectations
type LevelBatchPutOp = {
  type: 'put';
  key: Buffer;
  value: Buffer;
};

type LevelBatchDelOp = {
  type: 'del';
  key: Buffer;
};

type LevelBatchOp = LevelBatchPutOp | LevelBatchDelOp;

// Update saveChanges function to use batch operations
async function saveChanges(state: ServerState, db: LevelDB): Promise<ServerState> {
  if (state.unsaved.size === 0) return state;

  const ops: LevelBatchOp[] = [];
  
  // Save server root with merkle root in batch
  ops.push({
    type: 'put',
    key: Buffer.from([]),
    value: Buffer.from(encode([state.block, state.merkleStore.getMerkleRoot(), Date.now()]))
  });
  
  // Save all entity states in batch
  for (const key of state.unsaved) {
    const [signerId, entityId] = key.split('/');
    const node = state.merkleStore.debug.getEntityNode(signerId, entityId);
    if (node?.value) {
      ops.push({
        type: 'put',
        key: Buffer.from(key, 'hex'),
        value: Buffer.from(encode(Array.from(node.value.entries())))
      });
    }
  }
  
  // Execute batch operation
  await db.batch(ops);
  return updateState(state, { unsaved: new Set() });
}

// Update flushChanges function
async function flushChanges(state: ServerState): Promise<void> {
  const ops: LevelBatchPutOp[] = [];
  
  // Save server root with merkle root
  ops.push({
    type: 'put',
    key: Buffer.from([]),
    value: Buffer.from(encode([state.block, state.merkleStore.getMerkleRoot(), Date.now()]))
  });
  
  // Save individual entity states
  for (const key of state.unsaved) {
    const [signerId, entityId] = key.split('/');
    const node = state.merkleStore.debug.getEntityNode(signerId, entityId);
    if (node?.value) {
      ops.push({
        type: 'put',
        key: Buffer.from(key, 'hex'),
        value: Buffer.from(encode(Array.from(node.value.entries())))
      });
    }
  }
  
  await stateDb.batch(ops);
  state.unsaved.clear();
}

function markAsUnsaved(state: ServerState, key: string): ServerState {
  return updateState(state, {
    unsaved: new Set([...state.unsaved, key])
  });
}

// Update updateEntityState to use merkleStore
function updateEntityState(state: ServerState, signerId: string, entityId: string, newValue: EntityRoot): ServerState {
  state.merkleStore.updateEntityState(signerId, entityId, newValue);
  return markAsUnsaved(state, `${signerId}/${entityId}`);
}

// Block types (public/committed) 
type ServerBlock = {
  blockNumber: number
  timestamp: number
  entities: Map<string, EntityBlock>  // Direct mapping to entity blocks
  merkleRoot: Buffer
}

// Helper to split entity key
function splitEntityKey(key: string): [string, string] {
  const [signerId, entityId] = key.split('/');
  if (!signerId || !entityId) {
    throw new Error(`Invalid entity key: ${key}`);
  }
  return [signerId, entityId];
}

// Remove references to serverState.data
function performRandomOps(state: ServerState): ServerState {
  let newState = state;
  const keys = Array.from(state.unsaved);
  
  for (const key of keys) {
    if (Math.random() < 0.5) {
      try {
        const [signerId, entityId] = splitEntityKey(key);
        const node = state.merkleStore.debug.getEntityNode(signerId, entityId);
        if (node) {
          newState = updateState(newState, {
            unsaved: new Set([...state.unsaved, key])
          });
        }
      } catch (error) {
        log.error('Failed to process key:', { key, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  
  return newState;
}

// Helper for RLP encoding maps
export const mapToRLP = (map: Map<string, SignerInput>): Buffer => {
  log.merkle('Encoding map to RLP:', map.size, 'signers');
  const encoded = Buffer.from(encode(Array.from(map.entries()).map(([k, v]) => {
    log.merkle(`Encoding signer ${k.slice(0,8)}:`, Array.from(v.entries()).length, 'entities');
    return [
      Buffer.from(k, ENC),
      Array.from((v).entries()).map(([ek, ev]) => {
        log.merkle(`Encoding entity ${ek.slice(0,8)}:`, ev.length, 'inputs');
        return [
          Buffer.from(ek, ENC),
          ev.map(i => encode(Object.values(i)))
        ]
      })
    ]
  })));
  log.merkle('Final encoded size:', encoded.length);
  return encoded;
};

export const rlpToMap = (rlpData: Buffer): Map<string, Map<string, EntityInput[]>> => {
  log.merkle('Decoding RLP data of size:', rlpData.length);
  const decoded = decode(rlpData) as unknown as Buffer[][];
  log.merkle('First level decode:', decoded.length, 'signers');
  
  return new Map(decoded.map(([k, v]) => {
    const signerId = Buffer.from(k).toString(ENC);
    log.merkle(`Processing signer ${signerId.slice(0,8)}`);
    
    const entityMap = new Map((v as unknown as [Buffer, Buffer[]][]).map(([ek, ev]) => {
      const entityId = Buffer.from(ek).toString(ENC);
      log.merkle(`Processing entity ${entityId.slice(0,8)}:`, ev.length, 'inputs');
      
      const inputs = ev.map(buf => {
        const decoded = decode(buf) as unknown as Buffer[];
        return { type: Buffer.from(decoded[0]).toString(), tx: decoded[1] } as EntityInput;
      });
      
      return [entityId, inputs];
    }));
    
    return [signerId, entityMap];
  }));
};

// Get entity state from merkle store
function getEntityState(state: ServerState, signerId: string, entityId: string): EntityRoot | null {
  try {
    const node = state.merkleStore.debug.getEntityNode(signerId, entityId);
    if (!node?.value) return null;
    
    const blockData = node.value.get(StorageType.CURRENT_BLOCK);
    if (!blockData) return null;

    return {
      status: 'idle',
      entityPool: new Map(),
      finalBlock: decodeEntityBlock(blockData)
    };
  } catch (error) {
    log.error('Failed to get entity state:', { signerId, entityId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

// Process input and update state
function processInput(state: ServerState, signerId: string, entityId: string, input: EntityInput, options?: { skipPool?: boolean }): ServerState {
  const entityState = getEntityState(state, signerId, entityId);
  if (!entityState && input.type !== 'AddEntityTx') {
    log.error('Entity not found:', { signerId, entityId });
    return state;
  }

  try {
    const newEntityState = executeInput(entityState || createInitialEntityRoot(), input);
    state.merkleStore.updateEntityState(signerId, entityId, newEntityState);
    
    let newState = updateState(state, {
      unsaved: new Set([...state.unsaved, `${signerId}/${entityId}`])
    });

    // Add to pool unless skipPool is true
    if (!options?.skipPool) {
      const newPool = new Map(state.pool);
      const signerInputs = newPool.get(signerId) || new Map();
      const entityInputs = signerInputs.get(entityId) || [];
      signerInputs.set(entityId, [...entityInputs, input]);
      newPool.set(signerId, signerInputs);
      newState = updateState(newState, { pool: newPool });
    }

    return newState;
  } catch (error) {
    log.error('Failed to process input:', { signerId, entityId, input, error: error instanceof Error ? error.message : String(error) });
    return state;
  }
}

// Apply server input to state
function applyServerInput(input: ServerInput, state: ServerState): ServerState {
  let newState = state;
  
  for (const [signerId, entityInputs] of input.entries()) {
    for (const [entityId, inputs] of entityInputs.entries()) {
      for (const input of inputs) {
        newState = processInput(newState, signerId, entityId, input, { skipPool: true });
      }
    }
  }
  
  return newState;
}

// Pure function to get entity state
/*
function getEntityState(
  state: ServerState,
  signerId: string,
  entityId: string
): EntityRoot | undefined {
  log.state('Getting entity state:', { signerId, entityId });
  
  const node = state.merkleStore.debug.getEntityNode(signerId, entityId);
  if (!node?.value) {
    log.state('Entity node not found');
    return undefined;
  }

  const blockData = node.value.get(StorageType.CURRENT_BLOCK);
  if (!blockData) {
    log.state('Entity has no current block');
    return undefined;
  }

  try {
    return {
      status: 'idle',
      entityPool: new Map(),
      finalBlock: decodeEntityBlock(blockData)
    };
  } catch (error) {
    log.error('Failed to decode entity block:', error);
    throw new Error(`Invalid entity state for ${signerId}/${entityId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
*/

// Pure function to create initial entity state
function createInitialEntityRoot(): EntityRoot {
  return {
    status: 'idle',
    entityPool: new Map(),
    finalBlock: undefined
  };
}

// Update processMempoolTick to show state diffs
async function processMempoolTick(state: ServerState): Promise<ServerState> {
  if (state.pool.size === 0) return state;

  const oldRoot = state.merkleStore.getMerkleRoot().toString('hex');
  
  // Create and store block
  const blockData = encodeServerInput(state.pool);
  const blockHash = createHash('sha256').update(blockData).digest();
  
  const blockKey = Buffer.alloc(4);
  blockKey.writeUInt32BE(state.block + 1);
  await logDb.put(blockKey, blockData);
  
  // Get new merkle root
  const newState = updateState(state, {
    block: state.block + 1,
    pool: new Map()
  });
  const newRoot = newState.merkleStore.getMerkleRoot().toString('hex');

  log.diff(`Block ${state.block + 1} committed:
    Hash: ${blockHash.toString('hex').slice(0,8)}
    Old Root: ${oldRoot.slice(0,8)}
    New Root: ${newRoot.slice(0,8)}
    Pool Size: ${state.pool.size}
  `);

  return newState;
}

// Update receive function to show entity state changes
async function receive(state: ServerState, signerId: string, entityId: string, input: EntityInput): Promise<ServerState> {
  const oldState = state.merkleStore.debug.getEntityNode(signerId, entityId);
  const oldHash = oldState?.hash?.toString('hex');
  
  log.tx(`[${signerId.slice(0,8)}/${entityId.slice(0,8)}] ${input.type}`);
  
  // Process input
  const newState = processInput(state, signerId, entityId, input);
  const newNode = newState.merkleStore.debug.getEntityNode(signerId, entityId);
  const newHash = newNode?.hash?.toString('hex');

  if (oldHash !== newHash) {
    log.diff(`Entity state changed:
      Entity: ${signerId.slice(0,8)}/${entityId.slice(0,8)}
      Old Hash: ${oldHash?.slice(0,8) || 'none'}
      New Hash: ${newHash?.slice(0,8)}
    `);
  }

  // Save changes
  await saveMutableState(newState);
  return newState;
}

// Update replayLog to show progress
async function replayLog(state: ServerState): Promise<ServerState> {
  log.state('Replaying log from block:', state.block);
  
  let newState = state;
  const startKey = Buffer.alloc(4);
  startKey.writeUInt32BE(state.block);
  
  try {
    let blockCount = 0;
    const startTime = Date.now();
  
  // Process blocks in order directly from iterator
  for await (const [_, blockData] of logDb.iterator({ 
    gt: startKey,
    keys: true,
    values: true
  })) {
    const serverInput = rlpToMap(blockData as Buffer);
      newState = applyServerInput(serverInput, newState);
      newState = updateState(newState, { block: newState.block + 1 });
      blockCount++;
    }
    
    const duration = Date.now() - startTime;
    log.state(`Replay complete:
      Blocks: ${blockCount}
      Duration: ${duration}ms
      Final Block: ${newState.block}
    `);

    return newState;
  } catch (error) {
    log.error('Failed to replay log:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

// Print server pool for debugging
/*
function printServerPool(state: ServerState) {
  log.state('ServerPool:');
  for (const [signerId, entityInputs] of state.pool.entries()) {
    log.state(`  Signer ${signerId.slice(0,8)}:`);
    for (const [entityId, inputs] of entityInputs.entries()) {
      log.state(`    Entity ${entityId.slice(0,8)}: ${inputs.length} inputs`);
      log.state('    ', inputs);
    }
  }
}
*/

// Utility functions
const hash = (data: Buffer): Buffer => 
  createHash('sha256').update(data).digest();

const short = (buf: Buffer | string): string => 
  (typeof buf === 'string' ? buf : buf.toString(ENC)).slice(0, 8);

const key = (signerId: string, entityId?: string): string =>
  entityId ? `${short(signerId)}/${short(entityId)}` : short(signerId);

// Entity execution
function executeInput(state: EntityRoot, input: EntityInput): EntityRoot {
  log.tx('Executing:', {
    type: input.type,
    data: input.type === 'AddEntityTx' ? `${input.tx.slice(0,4)}...` : undefined
  });

  switch(input.type) {
    case 'AddEntityTx':
      if (!isValidTx(input)) {
        throw new Error('Invalid AddEntityTx input');
      }
      if (input.tx) {
        const decoded = decode(input.tx) as unknown as Buffer[];
        const cmdStr = Buffer.from(decoded[0]).toString();
        const args = decoded.slice(1).map(buf => decodeTxArg(buf));
        
        log.tx('Command:', cmdStr, 'Args:', args);
        
        // Execute tx inside entity VM
        const newStorage = executeEntityTx(state.finalBlock?.storage || { value: 0 }, cmdStr, args);
        return {
          ...state,
          finalBlock: {
            ...(state.finalBlock || { blockNumber: 0, channelRoot: Buffer.from([]), channelMap: new Map(), inbox: [] }),
            storage: newStorage
          }
        };
      }
      
    case 'Flush':
      // Create new block from mempool
      const block: EntityBlock = {
        blockNumber: (state.finalBlock?.blockNumber || 0) + 1,
        storage: { value: 0 },  // Initialize empty storage
        channelRoot: Buffer.from(encode([])),
        channelMap: new Map(),
        inbox: [...state.entityPool.values()]
      };

      return {
        status: 'commit' as const,
        finalBlock: block,
        entityPool: new Map()
      };

    case 'Consensus':
      // Apply consensus immediately
      return executeConsensus(state, input);
      
    default:
      throw new Error(`Unknown input type: ${input.type}`);
  }
}

// RLP encoding/decoding helpers
export const encodeEntityBlock = (block: EntityBlock): Buffer => 
  Buffer.from(encode([
    block.blockNumber,
    encode(Object.entries(block.storage)),
    block.channelRoot,
    encode(Array.from(block.channelMap.entries())),
    block.inbox,
    block.validatorSet || []
  ]));

const decodeEntityBlock = (data: Buffer): EntityBlock => {
  const decoded = decode(data) as unknown as [number, Buffer, Buffer, Buffer, Buffer[], Buffer[]];
  const [blockNumber, storageRlp, channelRoot, channelMapRlp, inbox, validatorSet] = decoded;
  
  const storageMap = new Map(decode(storageRlp) as unknown as [string, any][]);
  const storage: EntityStorage = {
    value: storageMap.get('value') || 0,
    ...Object.fromEntries(storageMap)
  };
  
  return {
    blockNumber,
    storage,
    channelRoot,
    channelMap: new Map(decode(channelMapRlp) as unknown as [string, Buffer][]),
    inbox,
    validatorSet: validatorSet.length > 0 ? validatorSet : undefined
  };
};


function computeStateHash(state: EntityRoot): string {
  const encoded = encodeEntityRoot(state);
  return createHash('sha256').update(encoded).digest().toString('hex');
}


// Separate immediate application from mempool
function applyEntityInput(state: EntityRoot, input: EntityInput): EntityRoot {
  switch(input.type) {
    case 'AddEntityTx':
      // Add to mempool only
      const txHash = hash(Buffer.from(encode(Object.values(input)))).toString(ENC);
      return {
        ...state,
        entityPool: new Map(state.entityPool).set(txHash, Buffer.from(encode(Object.values(input))))
      };
      
    case 'Consensus':
      // Apply consensus immediately
      return executeConsensus(state, input);
      
    default:
      throw new Error(`Unknown input type: ${input.type}`);
  }
}



// Start WebSocket server
const wss = new WebSocketServer({ port: 8080 });
wss.on('connection', ws => {
  let currentState = createServerState();
  
  ws.on('message', async (msg) => {
    try {
    const { signerId, entityId, input } = JSON.parse(msg.toString());
      currentState = await receive(currentState, signerId, entityId, input);
      ws.send(JSON.stringify({ success: true }));
    } catch (error) {
      ws.send(JSON.stringify({ 
        error: error instanceof Error ? error.message : String(error) 
      }));
    }
  });
});

// Start REPL with full context
const r = repl.start('> ');
Object.assign(r.context, {
  receive,
  serverPool,
  blockNumber,
  serverState,
  logDb,
  stateDb,
  flushChanges,
  calculateMerkleRoot,
  restart: async (bitWidth: number = 4, leafThreshold: number = 16) => {
    log.state('Restarting server with new merkle config:', { bitWidth, leafThreshold });
    
    // Clear databases
    await logDb.clear();
    await stateDb.clear();
    
    // Create new state with configured merkle store
    serverState = createServerState();
    serverState.merkleStore = createMerkleStore({ bitWidth, leafThreshold });
    
    // Run test transactions
    const signerId = randomBytes(32).toString(ENC);
    const entityId = randomBytes(32).toString(ENC);
    
    log.state('Test IDs:', {
      signer: signerId.slice(0,8),
      entity: entityId.slice(0,8)
    });

    // Send test transactions
    try {
      serverState = await receive(serverState, signerId, entityId, {
        type: 'AddEntityTx',
        tx: Buffer.from(encode(['Create']))
      });

      for (let i = 0; i < 20; i++) {
        serverState = await receive(serverState, signerId, entityId, {
          type: 'AddEntityTx',
          tx: Buffer.from(encode(['Increment', Math.floor(Math.random() * 100)]))
        });
        await new Promise(r => setTimeout(r, 50));
      }
    } catch (error) {
      log.error('Test transactions failed:', error);
      throw error;
    }

    log.state('Restart complete');
    return serverState;
  }
});



// Calculate merkle root from all signer inputs
function calculateMerkleRoot(input: ServerInput): Buffer {
  // Sort signers by ID for deterministic ordering
  const entries = Array.from(input.entries()).sort((a, b) => 
    Buffer.from(a[0], ENC).compare(Buffer.from(b[0], ENC))
  );
  
  // Calculate signer-level hashes
  const signerHashes = entries.map(([signerId, entityInputs]) => {
    // Sort entities by ID within each signer
    const entityEntries = Array.from(entityInputs.entries()).sort((a, b) =>
      Buffer.from(a[0], ENC).compare(Buffer.from(b[0], ENC))
    );
    
    // Calculate entity-level hashes
    const entityHashes = entityEntries.map(([entityId, inputs]) => {
      // RLP encode all inputs for this entity
      const rlp = Buffer.from(encode(inputs.map(i => encode(Object.values(i)))));
      return createHash('sha256').update(rlp).digest();
    });
    
    // Combine entity hashes into signer hash
    return createHash('sha256').update(Buffer.from(encode(entityHashes))).digest();
  });
  
  // Combine all signer hashes into root
  return createHash('sha256').update(Buffer.from(encode(signerHashes))).digest();
}

// Update getEntityInputs to use state.pool instead of serverPool
function getEntityInputs(state: ServerState, signerId: string, entityId: string): EntityInput[] {
  return state.pool.get(signerId)?.get(entityId) || [];
}

// Update clearEntityInputs to use state.pool
function clearEntityInputs(state: ServerState, signerId: string, entityId: string): ServerState {
  const newPool = new Map(state.pool);
  const signerInputs = newPool.get(signerId);
  if (signerInputs) {
    signerInputs.delete(entityId);
    if (signerInputs.size === 0) {
      newPool.delete(signerId);
    }
  }
  return updateState(state, { pool: newPool });
}

// RLP encoding/decoding helpers
const encodeServerInput = (input: ServerInput): Buffer => {
  console.log('\nEncoding server input:', input);
  const encoded = Buffer.from(encode(Array.from(input.entries()).map(([k, v]) => {
    return [
      Buffer.from(k, ENC),
      Array.from((v).entries()).map(([ek, ev]) => [
        Buffer.from(ek, ENC),
        ev.map(i => encode(Object.values(i)))
      ])
    ]
  })));
  return encoded;
};

const decodeServerInput = (rlpData: Buffer): ServerInput => {
  const decoded = decode(rlpData) as unknown as Buffer[][];
  return new Map(decoded.map(([k, v]) => {
    const signerId = Buffer.from(k).toString(ENC);
    const entityMap = new Map((v as unknown as Buffer[][]).map(([ek, ev]) => {
      const entityId = Buffer.from(ek).toString(ENC);
      const inputs = (ev as unknown as Buffer[]).map(buf => {
        const decoded = decode(buf) as unknown as Buffer[];
        return { type: Buffer.from(decoded[0]).toString(), tx: decoded[1] } as EntityInput;
      });
      return [entityId, inputs];
    }));
    return [signerId, entityMap];
  }));
};


function executeConsensus(state: EntityRoot, input: EntityInput): EntityRoot {
  if (input.type !== 'Consensus') throw new Error('Invalid input type');
  
  return {
    ...state,
    status: 'precommit',
    consensusBlock: input.consensusBlock ? decodeEntityBlock(input.consensusBlock) : undefined
  };
}

type ConsensusState = {
  round: number
  height: number
  step: 'propose' | 'prevote' | 'precommit'
  lockedValue?: Buffer
  validRound?: number
}

// Add stricter types and validation
type ValidatedTx = {
    hash: Buffer;
    signature: Buffer;
    payload: Buffer;
    timestamp: number;
};

function validateAndNormalizeTx(tx: unknown): ValidatedTx {
    if (!tx || typeof tx !== 'object') {
        throw new Error('Invalid transaction format');
    }
    // Add validation logic
    return tx as ValidatedTx;
}

// Add type guard for tx field
function isValidTx(input: EntityInput): input is { type: 'AddEntityTx', tx: Buffer } {
  return input.type === 'AddEntityTx' && input.tx !== undefined;
}

function decodeServerRoot(data: Buffer): ServerRoot {
  const [blockHeight, merkleRoot, timestamp, signerEntries] = decode(data) as unknown as [number, Buffer, number, [string, Buffer][]];
  return {
    blockHeight,
    merkleRoot,
    timestamp,
    signers: new Map(signerEntries)
  };
}

function encodeServerRoot(root: ServerRoot): Buffer {
  return Buffer.from(encode([
    root.blockHeight,
    root.merkleRoot,
    root.timestamp,
    Array.from(root.signers.entries())
  ]));
}

// Add type
export type SignerRoot = {
  entities: Map<string, Buffer>  // entityId -> entityHash
}

// Add encoders
export function encodeSignerRoot(root: SignerRoot): Buffer {
  return Buffer.from(encode(Array.from(root.entities.entries())));
}

export function decodeSignerRoot(data: Buffer): SignerRoot {
  const entityEntries = decode(data) as unknown as [string, Buffer][];
  return {
    entities: new Map(entityEntries)
  };
}

function isEntityRoot(state: StoredValue): state is EntityRoot {
  return 'status' in state && 'entityPool' in state;
}

function isSignerRoot(value: StateValue): value is SignerRoot {
  return 'entities' in value && !('blockHeight' in value)
}

function decodeStateValue(value: Buffer): StoredValue {
  // Decode based on value format - could be ServerRoot, EntityRoot, etc
  try {
    return decode(value) as StoredValue
  } catch (e) {
    return value // If not RLP encoded, return raw buffer
  }
}

function encodeStateValue(value: StoredValue | undefined): Buffer {
  if (!value) return Buffer.from([])
  if (Buffer.isBuffer(value)) return value
  if (isEntityRoot(value)) return encodeEntityRoot(value)
  if (isSignerRoot(value)) return encodeSignerRoot(value)
  return encodeServerRoot(value) // Now must be ServerRoot
}

// Add state printing function
function printState(state: ServerState) {
  console.log('\nCurrent State:');
  console.log('Block:', state.block);
  console.log('MerkleRoot:', state.merkleStore.getMerkleRoot().toString('hex'));
  console.log('\nPool:');
  for (const [signerId, entityInputs] of state.pool.entries()) {
    console.log(`  Signer ${signerId.slice(0,8)}:`);
    for (const [entityId, inputs] of entityInputs.entries()) {
      console.log(`    Entity ${entityId.slice(0,8)}: ${inputs.length} inputs`);
      console.log('    ', inputs);
    }
  }
  console.log('\nUnsaved:', Array.from(state.unsaved));
}

async function runSelfTest(state: ServerState) {
  // Create test entity
  const signerId = randomBytes(32).toString(ENC);
  const entityId = randomBytes(32).toString(ENC);
  
  log.state('Test IDs:', {
    signer: signerId.slice(0,8),
    entity: entityId.slice(0,8)
  });
  
  // Send test transactions
  try {
    state = await receive(state, signerId, entityId, {
      type: 'AddEntityTx',
      tx: Buffer.from(encode(['Create']))
    });
    
    for (let i = 0; i < 20; i++) {
      state = await receive(state, signerId, entityId, {
        type: 'AddEntityTx',
        tx: Buffer.from(encode(['Increment', Math.floor(Math.random() * 100)]))
      });
      await new Promise(r => setTimeout(r, 50));
    }

    // Process mempool to increment block number
    if (state.pool.size > 0) {
      state = await processMempoolTick(state);
      state = await saveMutableState(state);
    }

    // Update merkle root after all transactions
    const merkleRoot = state.merkleStore.getMerkleRoot();
    state = updateState(state, { merkleRoot });
    
  } catch (error) {
    log.error('Test transactions failed:', error);
    throw error;
  }

  log.state('Test complete');
  return state;
}

