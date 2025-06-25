import { Buffer } from 'buffer';
import { encode, decode } from 'rlp';
import { createHash } from 'crypto';
// Types
export type EntityInput =
  | { type: 'AddEntityTx', tx: Buffer }

  | { type: 'Flush' }
  | { type: 'Sync', blocks: Buffer[], signature: Buffer }
  | { type: 'Consensus', 
      signature: Buffer,
      blockNumber: number,
      consensusBlock?: Buffer,
      proposerSig?: Buffer 
    }

export type EntityStorage = {
  value: number;
  [key: string]: any;
}

export type EntityBlock = {
  blockNumber: number
  storage: EntityStorage      // Storage directly in block
  channelRoot: Buffer         
  channelMap: Map<string, Buffer>  
  inbox: Buffer[]             
  validatorSet?: Buffer[]     
}

export type EntityRoot = {
  status: 'idle' | 'precommit' | 'commit'
  finalBlock?: EntityBlock     
  consensusBlock?: EntityBlock 
  entityPool: Map<string, Buffer> 
}

// Update execute function to work with storage
export function executeEntityTx(storage: EntityStorage, cmd: string, args: (string | number)[]): EntityStorage {
  switch(cmd) {
    case 'Create':
      return {
        value: 0
      };
      
    case 'Increment':
      const increment = Number(args[0]) || 0;
      return {
        ...storage,
        value: (storage.value || 0) + increment
      };
      
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

// Encoders
export function encodeEntityBlock(block: EntityBlock): Buffer {
  const encoded = encode([
    block.blockNumber,
    Object.entries(block.storage),
    block.channelRoot,
    Array.from(block.channelMap.entries()),
    block.inbox,
    block.validatorSet || []  // Provide empty array as default
  ]);
  return Buffer.from(encoded);
}

export function decodeEntityBlock(data: Buffer): EntityBlock {
  const [blockNumber, storageEntries, channelRoot, channelEntries, inbox, validatorSet] = 
    decode(data) as unknown as [number, [string, any][], Buffer, [string, Buffer][], Buffer[], Buffer[]];
  
  return {
    blockNumber,
    storage: { value: 0, ...Object.fromEntries(storageEntries) },
    channelRoot,
    channelMap: new Map(channelEntries),
    inbox,
    validatorSet
  };
}

export function encodeEntityRoot(root: EntityRoot): Buffer {
  const encoded = encode([
    root.status,
    root.finalBlock ? encodeEntityBlock(root.finalBlock) : Buffer.from([]),
    root.consensusBlock ? encodeEntityBlock(root.consensusBlock) : Buffer.from([]),
    Array.from(root.entityPool.entries())
  ]);
  return Buffer.from(encoded);
}

export function decodeEntityRoot(data: Buffer): EntityRoot {
  const [status, finalBlockRlp, consensusBlockRlp, entityPoolRlp] = decode(data) as unknown as [Buffer, Buffer, Buffer, Buffer[][]];
  
  return {
    status: Buffer.from(status).toString() as 'idle' | 'precommit' | 'commit',
    finalBlock: finalBlockRlp.length > 0 ? decodeEntityBlock(finalBlockRlp) : undefined,
    consensusBlock: consensusBlockRlp.length > 0 ? decodeEntityBlock(consensusBlockRlp) : undefined,
    entityPool: new Map(entityPoolRlp.map(([k, v]) => [Buffer.from(k).toString(), v]))
  };
}

export function executeEntityBlock(state: EntityRoot): EntityRoot {
  const currentBlockNumber = state.finalBlock?.blockNumber || 0;
  
  console.log('executeEntityBlock - Initial state:', {
    currentBlockNumber,
    hasInputs: state.entityPool.size > 0
  });

  let currentState = {
    blockNumber: currentBlockNumber + 1,
    storage: state.finalBlock?.storage || { value: 0 },
    channelRoot: state.finalBlock?.channelRoot || Buffer.from([]),
    channelMap: state.finalBlock?.channelMap || new Map(),
    inbox: state.finalBlock?.inbox || [],
    validatorSet: state.finalBlock?.validatorSet || []
  };

  for (const inputBuf of Array.from(state.entityPool.values())) {
    const decoded = decode(inputBuf) as unknown as Buffer[];
    const cmdStr = Buffer.from(decoded[0]).toString();
    const args = decoded.slice(1).map(buf => decodeTxArg(buf));
    
    currentState.storage = executeEntityTx(currentState.storage, cmdStr, args);
  }

  console.log('executeEntityBlock - New state:', {
    newBlockNumber: currentState.blockNumber,
    storage: currentState.storage,
    inputs: state.entityPool.size
  });

  return {
    ...state,
    finalBlock: currentState
  };
}
