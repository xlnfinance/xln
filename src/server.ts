import {Level} from 'level';
import { randomBytes, createHash } from 'crypto';
import { encode, decode } from 'rlp';
import WebSocket from 'ws';
import repl from 'repl';
import type { EntityInput } from './types';
import { validateTx, SignedTx } from './validation';
// Ensure that your tsconfig.json has "esModuleInterop": true.

// DBs for log and mutable state
const logDb = new Level<Buffer, Buffer>('./db/log', { keyEncoding: 'binary', valueEncoding: 'binary' });
const stateDb = new Level<Buffer, Buffer>('./db/state', { keyEncoding: 'binary', valueEncoding: 'binary' });
const entityLogDb = new Level<Buffer, Buffer>('./db/entitylog', { keyEncoding: 'binary', valueEncoding: 'binary' });

// Use hex for Map/Set keys, Buffers for DB/RLP
const ENC = 'hex' as const;
let blockNumber = 0;
let mempool = new Map<string, Map<string, EntityInput[]>>();  // signerId -> entityId -> inputs

type StateValue = Buffer | EntityRoot | ServerRoot | SignerRoot;
const stateMap = new Map<string, StateValue>();
const unsavedKeys = new Set<string>();

// Top level routing
type ServerInput = Map<string, SignerInput>     // signerId -> inputs
type SignerInput = Map<string, EntityInput[]>   // entityId -> inputs
 
// Channel inputs
type ChannelInput = 
  | { type: 'AddChannelTx', tx: Buffer }
  | { type: 'Consensus',
      signature: Buffer,
      blockNumber: number,
      consensusBlock?: Buffer,
      counterpartySig?: Buffer
    }
 
// Machine root state types (private/internal)
type ServerRoot = {
  blockHeight: number;
  timestamp: number;
  signers: Map<string, Buffer>; // signerId -> hash
}

type EntityRoot = {
  status: 'idle' | 'precommit' | 'commit'
  mempool: Map<string, Buffer>  // TxHash -> RLP encoded tx
  nonce: number
  value: number
  blockHeight: number
  latestHash?: string
  consensusData?: Buffer
  signers?: Set<string>        // Authorized signers for this entity
  finalBlock?: EntityBlock
  consensusBlock?: EntityBlock
}

// Block types (public/committed) 
type ServerBlock = {
  blockNumber: number
  timestamp: number
  entities: Map<string, EntityBlock>  // Direct mapping to entity blocks
  merkleRoot: Buffer
}

type EntityBlock = {
  blockNumber: number
  stateRoot: Buffer
  channelRoot: Buffer
  channelMap: Map<string, Buffer>
  inbox: Buffer[]
  validatorSet?: Buffer[]
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
  
  // Add tx to mempool
  let signerInputs = mempool.get(signerId);
  if (!signerInputs) {
    signerInputs = new Map();
    mempool.set(signerId, signerInputs);
  }
  
  let entityInputs = signerInputs.get(entityId) || [];
  entityInputs.push(input);
  signerInputs.set(entityId, entityInputs);
  
  printMempool();
}

// Process inputs every tick
async function processMempoolTick() {
  if (mempool.size === 0) return;
  
  // Get server root state
  const serverRoot = stateMap.get('') as ServerRoot;
  
  console.log(`Processing mempool at block ${serverRoot.blockHeight}`);
  
  // Save current mempool and create new empty one
  const serverInput = mempool;
  mempool = new Map();
  
  // Apply using the previous mempool
  await applyServerInput(serverInput, serverRoot);
  
  // Calculate server hash for verification
  const serverHash = calculateServerHash(serverInput);
  
  // Store block in log with both input and resulting hash
  const blockKey = Buffer.alloc(4);
  blockKey.writeUInt32BE(serverRoot.blockHeight);
  await logDb.put(blockKey, encode([
    mapToRLP(serverInput),
    serverHash
  ]));
  
  console.log(`Created block ${serverRoot.blockHeight} (hash: ${serverHash.toString('hex').slice(0,8)})`);
}

async function replayLog(): Promise<void> {
  // Get existing server root from state DB or create new
  const serverRoot = stateMap.get('') as ServerRoot || {
    blockHeight: 0,
    timestamp: Date.now(),
    signers: new Map()
  };
  
  // Create start key from last processed block
  const startKey = Buffer.alloc(4);
  startKey.writeUInt32BE(serverRoot.blockHeight);
  
  // Get blocks and their data in one pass
  const blocks = [];
  for await (const [key, value] of logDb.iterator({ 
    gt: startKey,
    keys: true,
    values: true
  })) {
    blocks.push([key.readUInt32BE(0), value]);
  }
  
  // Sort by block number
  blocks.sort(([a], [b]) => Number(a) - Number(b));
  
  console.log(`\nReplaying blocks ${serverRoot.blockHeight} -> ${serverRoot.blockHeight + blocks.length}`);
  
  // Replay each block
  for (const [_, blockData] of blocks) {
    const serverInput = rlpToMap(blockData as Buffer);
    applyServerInput(serverInput, serverRoot);
  }
  stateMap.set('', serverRoot);
  
  console.log(`\nReplayed ${blocks.length} blocks`);
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
      
      stateMap.set(entityKey, state);
    }
  }
  
  updateMerkleTree();
  
  // Update block height after processing
  serverRoot.blockHeight++;
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
      const decoded = decode(input.tx) as unknown as Buffer[];
      const cmdStr = Buffer.from(decoded[0]).toString();
      const args = decoded.slice(1).map(buf => decodeTxArg(buf));
      
      // Execute tx inside entity VM
      return executeEntityTx(state, cmdStr, args);
      
    case 'Flush':
      // Create new block from mempool
      const block: EntityBlock = {
        blockNumber: (state.finalBlock?.blockNumber || 0) + 1,
        stateRoot: hash(encode([...state.mempool.values()])),
        channelRoot: hash(encode([])),
        channelMap: new Map(),
        inbox: [...state.mempool.values()]
      };

      return {
        status: 'commit',
        finalBlock: block,
        mempool: new Map(),
        nonce: state.nonce,
        value: state.value,
        blockHeight: state.blockHeight + 1,
        latestHash: computeStateHash(state)
      };

    case 'Consensus':
      // Apply consensus immediately
      return executeConsensus(state, input);
      
    default:
      throw new Error(`Unknown input type: ${input.type}`);
  }
}

// RLP encoding/decoding helpers
const encodeEntityBlock = (block: EntityBlock): Buffer => 
  encode([
    block.blockNumber,
    block.stateRoot,
    block.channelRoot,
    encode(Array.from(block.channelMap.entries())),
    block.inbox,
    block.validatorSet || []
  ]);

const decodeEntityBlock = (data: Buffer): EntityBlock => {
  const decoded = decode(data) as unknown as [number, Buffer, Buffer, Buffer, Buffer[], Buffer[]];
  const [blockNumber, stateRoot, channelRoot, channelMapRlp, inbox, validatorSet] = decoded;
  
  return {
    blockNumber,
    stateRoot,
    channelRoot,
    channelMap: new Map(decode(channelMapRlp) as unknown as [string, Buffer][]),
    inbox,
    validatorSet: validatorSet.length > 0 ? validatorSet : undefined
  };
};

function encodeEntityRoot(state: EntityRoot): Buffer {
  return encode([
    state.status,
    state.value || 0,
    state.nonce || 0,
    state.blockHeight || 0,
    Array.from(state.signers || []),
    Array.from(state.mempool.entries())
  ]);
}

function computeStateHash(state: EntityRoot): string {
  const encoded = encodeEntityRoot(state);
  return createHash('sha256').update(encoded).digest().toString('hex');
}

const decodeEntityRoot = (data: Buffer): EntityRoot => {
  const decoded = decode(data) as unknown as [Buffer, Buffer | null, Buffer | null, Buffer, Buffer | null, Buffer | null];
  const [status, finalBlockRlp, consensusBlockRlp, mempoolRlp, nonceRlp, valueRlp] = decoded;
  
  return {
    status: Buffer.from(status).toString() as 'idle' | 'precommit' | 'commit',
    finalBlock: finalBlockRlp ? decodeEntityBlock(finalBlockRlp) : undefined,
    consensusBlock: consensusBlockRlp ? decodeEntityBlock(consensusBlockRlp) : undefined,
    mempool: new Map(decode(mempoolRlp) as unknown as [string, Buffer][]),
    nonce: nonceRlp ? parseInt(Buffer.from(nonceRlp).toString()) : 0,
    value: valueRlp ? parseInt(Buffer.from(valueRlp).toString()) : 0,
    blockHeight: 0
  };
};

// Separate immediate application from mempool
function applyEntityInput(state: EntityRoot, input: EntityInput): EntityRoot {
  switch(input.type) {
    case 'AddEntityTx':
      // Add to mempool only
      const txHash = hash(encode(Object.values(input))).toString(ENC);
      return {
        ...state,
        mempool: new Map(state.mempool).set(txHash, encode(Object.values(input)))
      };
      
    case 'Consensus':
      // Apply consensus immediately
      return executeConsensus(state, input);
      
    default:
      throw new Error(`Unknown input type: ${input.type}`);
  }
}

// Entity layer - handles tx execution and block creation
function executeEntityBlock(state: EntityRoot, inputs: EntityInput[]): EntityRoot {
  // Process all inputs in block
  let newState = {...state};
  
  for (const input of inputs) {
    if (input.type === 'AddEntityTx') {
      const decoded = decode(input.tx) as unknown as Buffer[];
      const cmdStr = Buffer.from(decoded[0]).toString();
      const args = decoded.slice(1).map(buf => decodeTxArg(buf));
      
      // Execute tx inside entity VM
      newState = executeEntityTx(newState, cmdStr, args);
    }
  }
  
  return {
    ...newState,
    blockHeight: (state.blockHeight || 0) + 1,
    latestHash: computeStateHash(newState)
  };
}

// Entity flush creates new block
function flushEntity(state: EntityRoot): EntityRoot {
  const inputs = Array.from(state.mempool.values()).map(buf => {
    const [type, tx] = decode(buf) as unknown as [Buffer, Buffer];
    return { type: Buffer.from(type).toString(), tx } as EntityInput;
  });
  
  // Execute block with inputs
  const newState = executeEntityBlock(state, inputs);
  
  return {
    ...newState,
    status: 'commit',
    mempool: new Map()  // Clear mempool after execution
  };
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
  mempool,
  blockNumber,
  stateMap,
  unsavedKeys,
  logDb,
  stateDb,
  flushChanges,
  calculateServerHash
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
  setInterval(processMempoolTick, 100);

  // Create entity
  console.log('Creating entity...');
  await receive(signerId, entityId, {
    type: 'AddEntityTx',
    tx: Buffer.from(encode(['Create']))
  });
  
  // Send increments with delays to allow multiple block creation
  for (let i = 0; i < 20; i++) {
    console.log(`Sending increment ${i}...`);
    await receive(signerId, entityId, {
      type: 'AddEntityTx',
      tx: Buffer.from(encode(['Increment', Math.floor(Math.random() * 100)]))
    });
    await new Promise(r => setTimeout(r, 350));
  }

  // Final flush
  console.log('\nFlushing state...');
  flushEntityState(signerId, entityId);
  await new Promise(r => setTimeout(r, 200));  // Wait for flush

  await flushChanges();
  console.log('Test complete');

  console.log('\nFinal state:');
  console.log('StateMap:', stateMap);
  console.log('Blocks in log:', await logDb.keys().all());
}

main().catch(console.error);

// Calculate server hash from all signer inputs
function calculateServerHash(input: ServerInput): Buffer {
  const entries = Array.from(input.entries()).sort((a, b) => 
    Buffer.from(a[0], ENC).compare(Buffer.from(b[0], ENC))
  );
  
  const signerHashes = entries.map(([signerId, entityInputs]) => {
    const entityEntries = Array.from(entityInputs.entries()).sort((a, b) =>
      Buffer.from(a[0], ENC).compare(Buffer.from(b[0], ENC))
    );
    
    const entityHashes = entityEntries.map(([entityId, inputs]) => {
      const rlp = Buffer.from(encode(inputs.map(i => encode(Object.values(i)))));
      return createHash('sha256').update(rlp).digest();
    });
    
    return createHash('sha256').update(Buffer.from(encode(entityHashes))).digest();
  });
  
  return createHash('sha256').update(Buffer.from(encode(signerHashes))).digest();
}

// Save current state to mutable DB
async function saveMutableState() {
  // Server root: hash of all signer roots
  const signerRoots = new Map();
  for (const [signerId, entityInputs] of mempool.entries()) {
    const signerRoot = calculateServerHash(new Map([[signerId, entityInputs]]));
    signerRoots.set(signerId, signerRoot);
  }
  const serverRoot = Buffer.from(encode(Array.from(signerRoots.entries())));
  await stateDb.put(Buffer.from([]), serverRoot);
  
  // Save each signer and entity state
  for (const [signerId, entityInputs] of mempool.entries()) {
    const signerKey = Buffer.from(signerId, ENC);
    const entityRoots = new Map();
    
    for (const [entityId, inputs] of entityInputs.entries()) {
      const entityKey = Buffer.concat([signerKey, Buffer.from(entityId, ENC)]);
      const rlp = Buffer.from(encode(inputs.map(i => encode(Object.values(i)))));
      const entityRoot = createHash('sha256').update(rlp).digest();
      await stateDb.put(entityKey, entityRoot);
      entityRoots.set(entityId, entityRoot);
    }
    
    const signerRoot = Buffer.from(encode(Array.from(entityRoots.entries())));
    await stateDb.put(signerKey, signerRoot);
  }
}

function printMap(map: Map<any, any>, indent = '') {
  for (const [k, v] of map.entries()) {
    if (v instanceof Map) {
      console.log(indent + k.slice(0,8) + ':');
      printMap(v, indent + '  ');
    } else {
      console.log(indent + k.slice(0,8) + ':', v);
    }
  }
}

function printMempool() {
  console.log('Mempool:');
  for (const [signerId, entityInputs] of mempool.entries()) {
    console.log(`  Signer ${signerId.slice(0,8)}:`);
    for (const [entityId, inputs] of entityInputs.entries()) {
      console.log(`    Entity ${entityId.slice(0,8)}: ${inputs.length} inputs`);
      console.log('    ', inputs);
    }
  }
}

// RLP encoding/decoding helpers
const encodeServerInput = (input: ServerInput): Buffer => {
  const encoded = Array.from(input.entries()).map(([k, v]) => [
    Buffer.from(k, ENC),
    Array.from(v.entries()).map(([ek, ev]) => [
      Buffer.from(ek, ENC),
      ev.map(i => encode(Object.values(i)))
    ])
  ]);
  return encode(encoded);
};

const decodeServerInput = (data: Buffer): ServerInput => {
  const decoded = decode(data) as unknown as Array<[Buffer, Array<[Buffer, Buffer[]]>]>;
  return new Map(
    decoded.map(([k, v]) => [
      Buffer.from(k).toString(ENC),
      new Map(
        v.map(([ek, ev]) => [
          Buffer.from(ek).toString(ENC),
          ev.map(i => {
            const [type, tx] = decode(i) as unknown as [Buffer, Buffer];
            return { 
              type: Buffer.from(type).toString(), 
              tx 
            } as EntityInput;
          })
        ])
      )
    ])
  );
};

function executeBlock(state: EntityRoot, inputs: EntityInput[]): EntityRoot {
  // Process all inputs
  const newState = inputs.reduce((state, input) => {
    return executeInput(state, input);
  }, state);

  // Update block metadata
  return {
    ...newState,
    blockHeight: (state.blockHeight || 0) + 1,
    latestHash: computeStateHash(newState)
  };
}

function getEntityInputs(signerId: string, entityId: string): EntityInput[] {
  return mempool.get(signerId)?.get(entityId) || [];
}

function clearEntityInputs(signerId: string, entityId: string) {
  mempool.get(signerId)?.delete(entityId);
}

function executeEntityTx(state: EntityRoot, cmd: string, args: (string | number)[]): EntityRoot {
  switch(cmd) {
    case 'Create':
      return {
        ...state,
        nonce: (state.nonce || 0) + 1,
        value: 0
      };
      
    case 'Increment':
      const increment = Number(args[0]) || 0;
      return {
        ...state,
        nonce: (state.nonce || 0) + 1,
        value: (state.value || 0) + increment
      };
      
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

function getOrCreateEntityRoot(entityKey: string): EntityRoot {
  const stored = stateMap.get(entityKey);
  if (!stored) {
    return {
      status: 'idle',
      mempool: new Map(),
      nonce: 0,
      value: 0,
      blockHeight: 0
    };
  }
  return (stored && !Buffer.isBuffer(stored)) ? stored as EntityRoot : decodeEntityRoot(stored);
}

function updateMerkleTree() {
  // Create signer roots from entity states
  for (const [signerId, entityInputs] of mempool.entries()) {
    const entityRoots = new Map();
    
    for (const [entityId, _] of entityInputs.entries()) {
      const entityKey = key(signerId, entityId);
      const state = stateMap.get(entityKey) as EntityRoot;
      entityRoots.set(entityId, computeStateHash(state));
    }
    
    // Store signer state as hash
    stateMap.set(signerId, createHash('sha256')
      .update(encode(Array.from(entityRoots.entries())))
      .digest());
  }
  
  // Create server root with timestamp and blockNumber
  const signerHashes = Array.from(mempool.keys())
    .map(signerId => stateMap.get(signerId))
    .filter((hash): hash is Buffer => Buffer.isBuffer(hash));
    
  const serverRoot = encode([
    Date.now(),
    blockNumber,
    signerHashes
  ]);
    
  stateMap.set('', createHash('sha256')
    .update(serverRoot)
    .digest());
}

function decodeTxArg(buf: Buffer): string | number {
  // Special case: RLP empty value (0x80) -> number 0
  if (buf.length === 1 && buf[0] === 0x80) return 0;
  // Single byte -> number
  if (buf.length === 1) return buf[0];
  // Empty string -> 0
  if (buf.length === 0) return 0;
  // Multiple bytes -> string
  return Buffer.from(buf).toString();
}

// Only clear mempool entries after flush
function flushEntityState(signerId: string, entityId: string) {
  const entityKey = key(signerId, entityId);
  const state = stateMap.get(entityKey) as EntityRoot;
  
  // Get inputs before they're cleared
  const inputs = Array.from(state.mempool.values()).map(buf => {
    const [type, tx] = decode(buf) as unknown as [Buffer, Buffer];
    return { type: Buffer.from(type).toString(), tx } as EntityInput;
  });
  
  // Execute block with mempool inputs
  const newState = flushEntity(state);
  
  // Store block with inputs and new state hash
  storeBlock(entityKey, inputs, newState.latestHash || computeStateHash(newState));
  
  // Clear this entity's inputs
  mempool.get(signerId)?.delete(entityId);
  if (mempool.get(signerId)?.size === 0) {
    mempool.delete(signerId);
  }
  
  stateMap.set(entityKey, newState);
}

async function storeBlock(entityKey: string, inputs: EntityInput[], hash: Buffer | string) {
  const hashBuf = typeof hash === 'string' ? Buffer.from(hash, 'hex') : hash;
  
  // Create 4-byte block number buffer
  const blockNumBuf = Buffer.alloc(4);
  blockNumBuf.writeUInt32BE(blockNumber);
  
  console.log(`\nStoring block ${blockNumber} (${hashBuf.toString('hex').slice(0,8)}) for ${entityKey}`);
  console.log('Block inputs:', inputs);
  
  await logDb.put(blockNumBuf, encode([
    encode(inputs.map(i => encode(Object.values(i)))),
    hashBuf
  ]));
  
  blockNumber++;
}

function executeConsensus(state: EntityRoot, input: EntityInput): EntityRoot {
  if (input.type !== 'Consensus') throw new Error('Invalid input type');
  
  // Verify signatures, update consensus state
  return {
    ...state,
    status: 'precommit',
    consensusBlock: input.consensusBlock ? decodeEntityBlock(input.consensusBlock) : undefined,
    blockHeight: (state.blockHeight || 0) + 1
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
  const [blockHeight, timestamp, signerEntries] = decode(data) as unknown as [number, number, [string, Buffer][]];
  return {
    blockHeight,
    timestamp,
    signers: new Map(signerEntries)
  };
}

function encodeServerRoot(root: ServerRoot): Buffer {
  return encode([
    root.blockHeight,
    root.timestamp,
    Array.from(root.signers.entries())
  ]);
}

type SignerRoot = {
  entities: Map<string, Buffer>; // entityId -> hash
}

function decodeSignerRoot(data: Buffer): SignerRoot {
  const entityEntries = decode(data) as unknown as [string, Buffer][];
  return {
    entities: new Map(entityEntries)
  };
}

function encodeSignerRoot(root: SignerRoot): Buffer {
  return encode(Array.from(root.entities.entries()));
}
