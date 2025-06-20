import {Level} from 'level';
import { randomBytes, createHash } from 'crypto';
import { encode, decode } from 'rlp';
import { WebSocket, WebSocketServer } from 'ws';
import repl from 'repl';
import { EntityInput, EntityRoot, EntityBlock, EntityStorage, encodeEntityRoot, decodeEntityRoot, executeEntityBlock, flushEntity, executeEntityTx, decodeTxArg } from './entity.js';

import debug from 'debug';

// Enable all debug namespaces
debug.enable('state:*,tx:*,block:*,error:*,diff:*,merkle:*');

// Ensure that your tsconfig.json has "esModuleInterop": true.


type LevelDB = Level<Buffer, Buffer>

// DBs for log and mutable state
const serverBlocksDb = new Level<Buffer, Buffer>('./db/serverBlocks', { keyEncoding: 'binary', valueEncoding: 'binary' });
const serverStateDb = new Level<Buffer, Buffer>('./db/serverState', { keyEncoding: 'binary', valueEncoding: 'binary' });

// Use hex for Map/Set keys, Buffers for DB/RLP
const ENC = 'hex' as const;
let blockNumber = 0;
let serverPool = new Map<string, Map<string, EntityInput[]>>();  // signerId -> entityId -> inputs

// Utility functions
const hash = (data: Buffer): Buffer => 
  createHash('sha256').update(data).digest();


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
}

// Add this after types
let serverState: ServerState = createServerState();

// Main entry point
async function main() {
  // Create initial state
  let serverState = createServerState();
  
  // Load existing state
  try {
    log.state('Loading initial state');
    serverState = await loadServerState(serverStateDb);
    log.state(`Loaded initial state at block ${serverState.block}`);
    
    serverState = await replayLog(serverState);
    log.state(`Replayed log to block ${serverState.block}`);
  } catch (error) {
    log.error('Failed to load state:', error);
    throw error;
  }

  // Start processing loop in background
  startProcessing(serverState).catch(error => {
    log.error('Processing loop failed:', error);
    process.exit(1);
  });

  // Call runSelfTest in main
  await runSelfTest(serverState);
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
  


// Save state to database
async function saveMutableState(state: ServerState): Promise<ServerState> {
  log.state('Saving state to database');
  
  try {
    return await saveChanges(state, serverStateDb);
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
        serverBlocksDb,
        serverStateDb,
        flushChanges,
        restart: async (bitWidth: number = 4, leafThreshold: number = 16) => {
          log.state('Restarting server with new merkle config:', { bitWidth, leafThreshold });
          
          // Clear databases
          await serverBlocksDb.clear();
          await serverStateDb.clear();
          
          // Create new state with configured merkle store
          serverState = createServerState();
          
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
  processInput,
  createInitialEntityRoot,
  processMempoolTick,
  receive,
  saveMutableState,
  replayLog,
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
    height: 0,
    storage: new Map<number, Map<number, Buffer>>()
  };
}

async function loadServerState(serverStateDb: LevelDB): Promise<ServerState> {
  log.state('Loading state from database');
  
  let state = createServerState();
  const batch = new Map<string, Buffer>();
  
  // Load all entries into memory first
  for await (const [key, value] of serverStateDb.iterator()) {
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
  
  await serverStateDb.batch(ops);
}

// Block types (public/committed) 
type ServerBlock = {
  blockNumber: number
  timestamp: number
  entities: Map<string, EntityBlock>  // Direct mapping to entity blocks
  merkleRoot: Buffer
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


// Process input and update state
function processInput(state: ServerState, signerId: string, entityId: string, input: EntityInput, options?: { skipPool?: boolean }): ServerState {
  const entityState = getEntityState(state, signerId, entityId);
  if (!entityState && input.type !== 'AddEntityTx') {
    log.error('Entity not found:', { signerId, entityId });
    return state;
  }

  try {
    const newEntityState = executeInput(entityState || createInitialEntityRoot(), input);
    

    // Add to pool unless skipPool is true
    if (!options?.skipPool) {
      const newPool = new Map(state.pool);
      const signerInputs = newPool.get(signerId) || new Map();
      const entityInputs = signerInputs.get(entityId) || [];
      signerInputs.set(entityId, [...entityInputs, input]);
      newPool.set(signerId, signerInputs);
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
  await serverBlocksDb.put(blockKey, blockData);
  
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
  for await (const [_, blockData] of serverBlocksDb.iterator({ 
    gt: startKey,
    keys: true,
    values: true
  })) {
    const serverInput = rlpToMap(blockData as Buffer);
      newState = applyServerInput(serverInput, newState);
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


// Entity execution
function executeInput(state: EntityRoot, input: EntityInput): EntityRoot {
  log.tx('Executing:', {
    type: input.type,
    data: input.type === 'AddEntityTx' ? `${input.tx.slice(0,4)}...` : undefined
  });

  switch(input.type) {
    case 'AddEntityTx':
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
      //return executeConsensus(state, input);
      return state;
      
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
  serverBlocksDb,
  serverStateDb,
  flushChanges,
  restart: async () => {
    log.state('Restarting server with new config');
    
    // Clear databases
    await serverBlocksDb.clear();
    await serverStateDb.clear();
    
    // Create new state with configured merkle store
    serverState = createServerState();
    
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


  } catch (error) {
    log.error('Test transactions failed:', error);
    throw error;
  }

  log.state('Test complete');
  return state;
}

