import {Level} from 'level';
import { randomBytes, createHash } from 'crypto';
import { encode, decode } from 'rlp';
import WebSocket from 'ws';
import repl from 'repl';
import { EntityInput, EntityRoot, EntityBlock, EntityStorage, encodeEntityRoot, decodeEntityRoot, executeEntityBlock, flushEntity, executeEntityTx, decodeTxArg } from './entity';

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
export type ServerRoot = {
  blockHeight: number;
  merkleRoot: Buffer;
  timestamp: number;
  signers: Map<string, Buffer>;  // signerId -> signerHash
};

export type SignerInput = Map<string, EntityInput[]>;
export type ServerInput = Map<string, SignerInput>;     // signerId -> entityId -> inputs
type StateValue = ServerRoot | SignerRoot | EntityRoot | Buffer;




const stateMap = new Map<string, StateValue>();
const unsavedKeys = new Set<string>();


// Block types (public/committed) 
type ServerBlock = {
  blockNumber: number
  timestamp: number
  entities: Map<string, EntityBlock>  // Direct mapping to entity blocks
  merkleRoot: Buffer
}


// Load all entries from LevelDB into an in-memory Map.
async function loadAllEntries(): Promise<void> {
  for await (const [key, value] of stateDb.iterator()) {
    const keyStr = key.toString(ENC);
    
    if (key.length === 0) {
      // Server root
      stateMap.set('', decodeServerRoot(value));
    } 
    else if (key.length === 32) {
      // Signer root
      stateMap.set(keyStr, decodeSignerRoot(value));
    }
    else if (keyStr.includes('/')) {
      // Entity state (signerId/entityId format)
      stateMap.set(keyStr, decodeEntityRoot(value));
    }
  }
}

function performRandomOps(): void {
  const keys = Array.from(stateMap.keys());
  for (const key of keys) {
    if (Math.random() < 0.5) {
      stateMap.set(key, randomBytes(16));
      unsavedKeys.add(key);
    }
    if (Math.random() < 0.1) {
      stateMap.delete(key);
      unsavedKeys.add(key);
    }
  }
  for (let i = 0; i < 10; i++) {
    const key = randomBytes(8).toString(ENC);
    stateMap.set(key, randomBytes(16));
    unsavedKeys.add(key);
  }
}

// Define batch operation type that matches Level's expectations
type LevelBatchOp = {
  type: 'put';
  key: Buffer;
  value: Buffer;
} | {
  type: 'del';
  key: Buffer;
};

// Flush all changes in the Map back to LevelDB using a batch.
async function flushChanges(): Promise<void> {
  const ops: LevelBatchOp[] = [];
  
  for (const key of unsavedKeys) {
    const value = stateMap.get(key);
    if (!value) {
      ops.push({ type: 'del', key: Buffer.from(key, ENC) });
      continue;
    }
    
    const valueBuffer = (Buffer.isBuffer(value) ? value :
      key.length === 0 ? encodeServerRoot(value as ServerRoot) :
      key.length === 32 ? encodeSignerRoot(value as SignerRoot) :
      key.includes('/') ? encodeEntityRoot(value as EntityRoot) :
      value) as Buffer;
      
    ops.push({ type: 'put', key: Buffer.from(key, ENC), value: valueBuffer });
  }
  
  await stateDb.batch(ops);
  unsavedKeys.clear();
}

// Helper for RLP encoding maps
export const mapToRLP = (map: Map<string, SignerInput>): Buffer => {
  console.log('\nEncoding map to RLP:', map);
  const encoded = Buffer.from(encode(Array.from(map.entries()).map(([k, v]) => {
    console.log(`\nEncoding signer ${k.slice(0,8)}:`, v);
    return [
      Buffer.from(k, ENC),
      Array.from((v).entries()).map(([ek, ev]) => {
        console.log(`Encoding entity ${ek.slice(0,8)}:`, ev);
        return [
          Buffer.from(ek, ENC),
          ev.map(i => {
            console.log('Encoding input:', i);
            return encode(Object.values(i));
          })
        ]
      })
    ]
  })));
  console.log('Final encoded size:', encoded.length);
  return encoded;
};

export const rlpToMap = (rlpData: Buffer): Map<string, Map<string, EntityInput[]>> => {
  console.log('\nDecoding RLP data of size:', rlpData.length);
  const decoded = decode(rlpData) as unknown as Buffer[][];
  console.log('First level decode:', decoded.map(([k,v]) => [
    Buffer.from(k).toString(ENC).slice(0,8),
    '...'
  ]));
  
  return new Map(decoded.map(([k, v]) => {
    const signerId = Buffer.from(k).toString(ENC);
    console.log(`\nProcessing signer ${signerId.slice(0,8)}`);
    
    const entityMap = new Map((v as unknown as Buffer[][]).map(([ek, ev]) => {
      const entityId = Buffer.from(ek).toString(ENC);
      console.log(`Processing entity ${entityId.slice(0,8)}`);
      
      const inputs = (ev as unknown as Buffer[]).map(buf => {
        const decoded = decode(buf) as unknown as Buffer[];
        return { type: Buffer.from(decoded[0]).toString(), tx: decoded[1] } as EntityInput;
      });
      
      console.log(`Entity ${entityId.slice(0,8)} inputs:`, inputs);
      return [entityId, inputs];
    }));
    
    console.log(`Signer ${signerId.slice(0,8)} map:`, entityMap);
    return [signerId, entityMap];
  }));
};

// Main entry point for receiving inputs
function receive(signerId: string, entityId: string, input: EntityInput) {
  console.log(`Received input for ${short(signerId)}/${short(entityId)}:`, input);
  
  if (!isValidTx(input)) {
    throw new Error('Invalid transaction');
  }
  
  // Add tx to serverPool
  let signerInputs = serverPool.get(signerId);
  if (!signerInputs) {
    signerInputs = new Map();
    serverPool.set(signerId, signerInputs);
  }
  
  let entityInputs = signerInputs.get(entityId) || [];
  entityInputs.push(input);
  signerInputs.set(entityId, entityInputs);
  
  printServerPool();
}

// Process inputs every tick
async function processMempoolTick() {  
  // Skip if serverPool empty
  if (serverPool.size === 0) return;

  console.log(`\nProcessing serverPool at block ${blockNumber}`);

  // Create block from current serverPool
  const blockData = encodeServerInput(serverPool);
  const blockHash = createHash('sha256').update(blockData).digest();
  
  // Store block
  const blockKey = Buffer.alloc(4);
  blockKey.writeUInt32BE(blockNumber + 1);
  await logDb.put(blockKey, blockData);
  
  console.log(`Created block ${blockNumber + 1} (hash: ${blockHash.toString('hex').slice(0,8)})`);
  blockNumber++;

  // Apply inputs and flush states
  const serverRoot = stateMap.get('') as ServerRoot || {
    blockHeight: blockNumber,
    merkleRoot: Buffer.from([]),
    timestamp: Date.now(),
    signers: new Map()
  };
  applyServerInput(serverPool, serverRoot);

  // Create new serverPool
  serverPool = new Map();

  // Save changes to disk
  await flushChanges();
}

async function replayLog(): Promise<void> {
  const serverRoot = stateMap.get('') as ServerRoot || {
    blockHeight: 0,
    merkleRoot: Buffer.from([]),
    timestamp: Date.now(),
    signers: new Map()
  };
  
  const startKey = Buffer.alloc(4);
  startKey.writeUInt32BE(serverRoot.blockHeight);
  
  console.log(`\nReplaying blocks from ${serverRoot.blockHeight}`);
  
  // Process blocks in order directly from iterator
  for await (const [_, blockData] of logDb.iterator({ 
    gt: startKey,
    keys: true,
    values: true
  })) {
    const serverInput = rlpToMap(blockData as Buffer);
    applyServerInput(serverInput, serverRoot);
  }
  
  stateMap.set('', serverRoot);
  console.log(`\nReplayed to block ${serverRoot.blockHeight}`);
}

function applyServerInput(input: ServerInput, serverRoot: ServerRoot) {
  for (const [signerId, entityInputs] of input.entries()) {
    for (const [entityId, inputs] of entityInputs.entries()) {
      const entityKey = key(signerId, entityId);
      let state = getOrCreateEntityRoot(entityKey);
      
      // Apply each input to entity
      for (const input of inputs) {
        state = applyEntityInput(state, input);
      }
      
      // Flush entity state after applying inputs
      state = flushEntity(state, inputs);
      stateMap.set(entityKey, state);
    }
  }
  
  // Calculate new merkle root after processing
  const merkleRoot = calculateMerkleRoot(input);
  
  // Update server root with new block height and merkle root
  serverRoot.blockHeight++;
  serverRoot.merkleRoot = merkleRoot;
  stateMap.set('', serverRoot);
}

// Utility functions
const hash = (data: Buffer): Buffer => 
  createHash('sha256').update(data).digest();

const short = (buf: Buffer | string): string => 
  (typeof buf === 'string' ? buf : buf.toString(ENC)).slice(0, 8);

const key = (signerId: string, entityId?: string): string =>
  entityId ? `${short(signerId)}/${short(entityId)}` : short(signerId);

// Entity execution
function executeInput(state: EntityRoot, input: EntityInput): EntityRoot {
  console.log('Executing input:', input);
  switch(input.type) {
    case 'AddEntityTx':
      if (!isValidTx(input)) {
        throw new Error('Invalid AddEntityTx input');
      }
      if (input.tx) {
        const decoded = decode(input.tx) as unknown as Buffer[];
        const cmdStr = Buffer.from(decoded[0]).toString();
        const args = decoded.slice(1).map(buf => decodeTxArg(buf));
        
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
        channelRoot: hash(encode([])),
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
  encode([
    block.blockNumber,
    encode(Object.entries(block.storage)),
    block.channelRoot,
    encode(Array.from(block.channelMap.entries())),
    block.inbox,
    block.validatorSet || []
  ]);

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
      const txHash = hash(encode(Object.values(input))).toString(ENC);
      return {
        ...state,
        entityPool: new Map(state.entityPool).set(txHash, encode(Object.values(input)))
      };
      
    case 'Consensus':
      // Apply consensus immediately
      return executeConsensus(state, input);
      
    default:
      throw new Error(`Unknown input type: ${input.type}`);
  }
}



// Start WebSocket server
const wss = new WebSocket.Server({ port: 8080 });
wss.on('connection', ws => {
  ws.on('message', async (msg) => {
    const { signerId, entityId, input } = JSON.parse(msg.toString());
    await receive(signerId, entityId, input);
  });
});

// Start REPL with full context
const r = repl.start('> ');
Object.assign(r.context, {
  receive,
  serverPool,
  blockNumber,
  stateMap,
  unsavedKeys,
  logDb,
  stateDb,
  flushChanges,
  calculateMerkleRoot
});

// Self-test
async function main() {
  const signerId = randomBytes(32).toString(ENC);
  const entityId = randomBytes(32).toString(ENC);
  console.log('Test IDs:', {
    signer: signerId.slice(0,8),
    entity: entityId.slice(0,8)
  });
  
  await loadAllEntries();
  console.log(`Loaded ${stateMap.size} entries from DB`);
  
  await replayLog();
  // Start processing loop
  setInterval(processMempoolTick, 250);

  // Create entity and send test transactions
  console.log('Creating entity...');
  await receive(signerId, entityId, {
    type: 'AddEntityTx',
    tx: Buffer.from(encode(['Create']))
  });
  
  for (let i = 0; i < 20; i++) {
    console.log(`Sending increment ${i}...`);
    await receive(signerId, entityId, {
      type: 'AddEntityTx',
      tx: Buffer.from(encode(['Increment', Math.floor(Math.random() * 100)]))
    });
    await new Promise(r => setTimeout(r, 50));
  }

  console.log('Test complete');
}

main().catch(console.error);

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

// Save current state to mutable DB
async function saveMutableState() {
  const serverRoot = getOrCreateServerRoot();
  
  // Save server root with merkle root
  await stateDb.put(Buffer.from([]), encode([
    serverRoot.blockHeight,
    serverRoot.merkleRoot,
    serverRoot.timestamp
  ]));
  
  // Save individual entity states
  for (const [signerId, entityInputs] of serverPool.entries()) {
    for (const [entityId, inputs] of entityInputs.entries()) {
      const entityKey = Buffer.concat([
        Buffer.from(signerId, ENC),
        Buffer.from(entityId, ENC)
      ]);
      const state = stateMap.get(key(signerId, entityId));
      if (state && isEntityRoot(state)) {
        await stateDb.put(entityKey, encodeEntityRoot(state));
      }
    }
  }
}

function printServerPool() {
  console.log('ServerPool:');
  for (const [signerId, entityInputs] of serverPool.entries()) {
    console.log(`  Signer ${signerId.slice(0,8)}:`);
    for (const [entityId, inputs] of entityInputs.entries()) {
      console.log(`    Entity ${entityId.slice(0,8)}: ${inputs.length} inputs`);
      console.log('    ', inputs);
    }
  }
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


function getEntityInputs(signerId: string, entityId: string): EntityInput[] {
  return serverPool.get(signerId)?.get(entityId) || [];
}

function clearEntityInputs(signerId: string, entityId: string) {
  serverPool.get(signerId)?.delete(entityId);
}

function getOrCreateEntityRoot(entityKey: string): EntityRoot {
  const existingState = stateMap.get(entityKey) as EntityRoot;
  if (existingState) return existingState;

  // Initialize new entity state
  return {
    status: 'idle' as const,
    entityPool: new Map(),
    finalBlock: {
      blockNumber: 0,
      storage: { value: 0 },
      channelRoot: Buffer.from([]),
      channelMap: new Map(),
      inbox: [],
      validatorSet: []
    }
  };
}

function getOrCreateServerRoot(): ServerRoot {
  const existing = stateMap.get('') as ServerRoot;
  if (existing) return existing;
  
  return {
    blockHeight: 0,
    merkleRoot: Buffer.from([]),
    timestamp: Date.now(),
    signers: new Map()
  };
}

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
  return encode([
    root.blockHeight,
    root.merkleRoot,
    root.timestamp,
    Array.from(root.signers.entries())
  ]);
}

// Add type
export type SignerRoot = {
  entities: Map<string, Buffer>  // entityId -> entityHash
}

// Add encoders
export function encodeSignerRoot(root: SignerRoot): Buffer {
  return encode(Array.from(root.entities.entries()));
}

export function decodeSignerRoot(data: Buffer): SignerRoot {
  const entityEntries = decode(data) as unknown as [string, Buffer][];
  return {
    entities: new Map(entityEntries)
  };
}

function isEntityRoot(state: StateValue): state is EntityRoot {
  return 'status' in state && 'entityPool' in state;
}

