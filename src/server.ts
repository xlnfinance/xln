import {Level} from 'level';
import { randomBytes, createHash } from 'crypto';
import { encode, decode } from 'rlp';
import WebSocket from 'ws';
import repl from 'repl';
// Ensure that your tsconfig.json has "esModuleInterop": true.

// DBs for log and mutable state
const logDb = new Level<Buffer, Buffer>('./db/log', { keyEncoding: 'binary', valueEncoding: 'binary' });
const stateDb = new Level<Buffer, Buffer>('./db/state', { keyEncoding: 'binary', valueEncoding: 'binary' });
const entityLogDb = new Level<Buffer, Buffer>('./db/entitylog', { keyEncoding: 'binary', valueEncoding: 'binary' });

// Use latin1 for Map/Set keys, Buffers for DB/RLP
const ENC = 'hex' as const;
let blockNumber = 0;
const mempool = new Map<string, Map<string, EntityInput[]>>();  // signerId -> entityId -> inputs

type StateValue = Buffer | EntityRoot;
const stateMap = new Map<string, StateValue>();
const unsavedKeys = new Set<string>();

// Top level routing
type ServerInput = Map<string, SignerInput>     // signerId -> inputs
type SignerInput = Map<string, EntityInput[]>   // entityId -> inputs

// Entity inputs
type EntityInput =
  | { type: 'AddEntityTx', tx: Buffer }
  | { type: 'AddChannelInput', channelId: string, input: ChannelInput }
  | { type: 'Flush' }
  | { type: 'Sync', blocks: Buffer[], signature: Buffer }
  | { type: 'Consensus', 
      signature: Buffer,
      blockNumber: number,
      consensusBlock?: Buffer,
      proposerSig?: Buffer 
    }

// Channel inputs
type ChannelInput = 
  | { type: 'AddChannelTx', tx: Buffer }
  | { type: 'Consensus',
      signature: Buffer,
      blockNumber: number,
      consensusBlock?: Buffer,
      counterpartySig?: Buffer
    }

// Block structures
type EntityBlock = {
  blockNumber: number
  stateRoot: Buffer           // Entity state hash
  channelRoot: Buffer         // Hash of channelMap
  channelMap: Map<string, Buffer>  // counterpartyId -> channelHash
  inbox: Buffer[]             // Both entityTx and channelInputs
  validatorSet?: Buffer[]     // Optional validator set update
}

// Root states
type EntityRoot = {
  status: 'idle' | 'precommit' | 'commit'
  finalBlock?: EntityBlock
  consensusBlock?: EntityBlock
  mempool: Map<string, Buffer>  // txHash -> tx (both entity and channel)
}

type ChannelRoot = {
  status: 'idle' | 'precommit' | 'commit'
  finalBlock?: Buffer
  consensusBlock?: Buffer
  mempool: Map<string, Buffer>  // txHash -> channelTx
}

// Load all entries from LevelDB into an in-memory Map.
async function loadAllEntries(): Promise<void> {
  for await (const [key, value] of stateDb.iterator()) {
    stateMap.set(key.toString(ENC), value);
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
  const ops: LevelBatchOp[] = Array.from(unsavedKeys).map(key => {
    const value = stateMap.get(key);
    if (!value) {
      return { type: 'del', key: Buffer.from(key, ENC) };
    }
    
    // Convert EntityRoot to Buffer if needed
    const valueBuffer = Buffer.isBuffer(value) ? value : encodeEntityRoot(value);
    return { type: 'put', key: Buffer.from(key, ENC), value: valueBuffer };
  });
  
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
      
      const inputs = (ev as unknown as Buffer[]).map(i => {
        const decoded = decode(i) as unknown as Buffer[];
        console.log('Input values:', decoded);
        const type = Buffer.from(decoded[0]).toString();
        const tx = Buffer.from(decoded[1]);
        console.log('Reconstructed input:', { type, tx });
        return { type, tx } as EntityInput;
      });
      
      console.log(`Entity ${entityId.slice(0,8)} inputs:`, inputs);
      return [entityId, inputs];
    }));
    
    console.log(`Signer ${signerId.slice(0,8)} map:`, entityMap);
    return [signerId, entityMap];
  }));
};

// Main entry point
async function receive(signerId: string, entityId: string, input: EntityInput) {
  console.log(`Received input for ${signerId.slice(0,8)}/${entityId.slice(0,8)}:`, input);
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
      const decoded = decode(input.tx) as unknown as Buffer[];
      const cmdStr = Buffer.from(decoded[0]).toString();
      const args = decoded.slice(1).map(arg => {
        // If it's RLP's "empty" value (0x80), return 0
        if (arg.length === 1 && arg[0] === 0x80) {
          return 0;
        }
        // If it's a single byte, treat as number
        if (arg.length === 1) {
          return arg[0];
        }
        // Otherwise convert to string
        return Buffer.from(arg).toString();
      });
      console.log('Command:', cmdStr, 'Args:', args);
      
      // Add to mempool
      const txHash = hash(input.tx);
      state.mempool.set(txHash.toString(ENC), input.tx);
      return state;

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
        mempool: new Map()
      };

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

const encodeEntityRoot = (root: EntityRoot): Buffer =>
  encode([
    Buffer.from(root.status),
    root.finalBlock ? encodeEntityBlock(root.finalBlock) : null,
    root.consensusBlock ? encodeEntityBlock(root.consensusBlock) : null,
    encode(Array.from(root.mempool.entries()))
  ]);

const decodeEntityRoot = (data: Buffer): EntityRoot => {
  const decoded = decode(data) as unknown as [Buffer, Buffer | null, Buffer | null, Buffer];
  const [status, finalBlockRlp, consensusBlockRlp, mempoolRlp] = decoded;
  
  return {
    status: Buffer.from(status).toString() as 'idle' | 'precommit' | 'commit',
    finalBlock: finalBlockRlp ? decodeEntityBlock(finalBlockRlp) : undefined,
    consensusBlock: consensusBlockRlp ? decodeEntityBlock(consensusBlockRlp) : undefined,
    mempool: new Map(decode(mempoolRlp) as unknown as [string, Buffer][])
  };
};

// Update processMempoolTick to maintain full state hierarchy
async function processMempoolTick() {
  if (mempool.size === 0) return;
  
  const serverInput = new Map(Array.from(mempool.entries()));
  mempool.clear();
  
  // Update RAM state with proper hierarchy
  const signerRoots = new Map<string, Buffer>();
  
  for (const [signerId, entityInputs] of serverInput.entries()) {
    const entityRoots = new Map<string, Buffer>();
    
    for (const [entityId, inputs] of entityInputs.entries()) {
      const entityKey = key(signerId, entityId);
      const storedState = stateMap.get(entityKey);
      
      let state: EntityRoot = storedState && !Buffer.isBuffer(storedState) 
        ? storedState 
        : { status: 'idle', mempool: new Map() };
        
      // Process inputs and flush
      for (const input of inputs) {
        state = executeInput(state, input);
      }
      if (state.mempool.size > 0) {
        state = executeInput(state, { type: 'Flush' });
      }
      
      // Store full state and its hash
      const encodedState = encodeEntityRoot(state);
      const entityHash = hash(encodedState);
      
      stateMap.set(entityKey, state);  // Store full state
      entityRoots.set(entityId, entityHash);  // Store hash for parent
      unsavedKeys.add(entityKey);
    }
    
    // Create and store signer root
    const signerHash = hash(encode(Array.from(entityRoots.entries())));
    const signerKey = key(signerId);
    stateMap.set(signerKey, signerHash);
    signerRoots.set(signerId, signerHash);
    unsavedKeys.add(signerKey);
  }
  
  // Create and store server root
  const serverRoot = hash(encode(Array.from(signerRoots.entries())));
  stateMap.set('', serverRoot);
  unsavedKeys.add('');
  
  const logValue = encode([encodeServerInput(serverInput), serverRoot]);
  await logDb.put(Buffer.from([blockNumber++]), logValue);
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
  
  // Send some increments
  for (let i = 0; i < 2; i++) {
    console.log(`Sending increment ${i}...`);
    await receive(signerId, entityId, {
      type: 'AddEntityTx',
      tx: Buffer.from(encode(['Increment', i]))
    });
    await new Promise(r => setTimeout(r, 150));
  }
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

async function replayLog(): Promise<void> {
  const blocks = await logDb.keys().all();
  const blockNums = blocks.map(k => k[0]).sort();
  console.log('\nReplaying blocks:', blockNums);
  
  for (const num of blockNums) {
    console.log(`\nReplaying block ${num}`);
    const value = await logDb.get(Buffer.from([num]));
    const [inputRlp, hash] = decode(value) as unknown as [Buffer, Buffer];
    
    try {
      const serverInput = decodeServerInput(inputRlp);
      console.log('Decoded inputs:', JSON.stringify(Array.from(serverInput.entries()), null, 2));
      
      const calculated = calculateServerHash(serverInput);
      console.log('Hash verification:', calculated.equals(hash));
      
      // Update RAM state
      for (const [signerId, entityInputs] of serverInput.entries()) {
        for (const [entityId, inputs] of entityInputs.entries()) {
          const key = `${signerId.slice(0,8)}/${entityId.slice(0,8)}`;
          console.log(`Restoring state for ${key}:`, inputs.length, 'inputs');
          stateMap.set(key, hash);
          unsavedKeys.add(key);
        }
      }
    } catch (e) {
      console.error('Failed to replay block:', e);
      throw e;
    }
  }
  
  blockNumber = blockNums.length > 0 ? blockNums[blockNums.length - 1] + 1 : 0;
  console.log(`\nReplayed ${blockNums.length} blocks, current block: ${blockNumber}`);
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
