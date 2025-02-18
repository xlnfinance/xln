import { createHash } from 'crypto';
import { encode } from 'rlp';
import debug from 'debug';
import { EntityRoot, EntityBlock } from '../entity';

const log = {
  tree: debug('merkle:tree'),
  node: debug('merkle:node'),
  path: debug('merkle:path'),
  split: debug('merkle:split'),
  hash: debug('merkle:hash')
};

export enum StorageType {
  CURRENT_BLOCK = 0x01,
  CONSENSUS_BLOCK = 0x02,
  CHANNEL_MAP = 0x03,
  CURRENT_BOARD = 0x10,
  PROPOSED_BOARD = 0x11,
  VALIDATOR_STAKES = 0x12,
  PRECOMMITS = 0x20,
  VOTES = 0x21,
  FINAL_CHANNELS = 0x30,
  CONSENSUS_CHANNELS = 0x31
}

export type NodeValue = Map<StorageType, Buffer>;
export type Hash = Buffer;

interface TreeConfig {
  bitWidth: number;      // 1-16 bits per chunk
  leafThreshold: number; // 1-1024 entries before splitting
}

interface MerkleNode {
  values: Map<string, NodeValue>;
  children?: Map<number, MerkleNode>;
  hash?: Hash;
}

function createNode(): MerkleNode {
  return {
    values: new Map(),
    children: undefined,
    hash: undefined
  };
}

function getChunk(path: string, offset: number, config: TreeConfig): number {
  const bits = config.bitWidth;
  const bytesNeeded = Math.ceil(bits / 8);
  const buffer = Buffer.from(path.slice(offset * 2, offset * 2 + bytesNeeded * 2), 'hex');
  
  let chunk = 0;
  for (let i = 0; i < bytesNeeded; i++) {
    chunk = (chunk << 8) | buffer[i];
  }
  
  const mask = (1 << bits) - 1;
  chunk = chunk & mask;

  log.path(`Got chunk ${chunk} from path ${path} at offset ${offset}`);
  return chunk;
}

function splitNode(node: MerkleNode, config: TreeConfig): void {
  if (node.values.size <= config.leafThreshold || node.children) {
    return;
  }

  log.split(`Splitting node with ${node.values.size} values`);
  node.children = new Map();
  
  for (const [path, value] of node.values) {
    const chunk = getChunk(path, 0, config);
    let child = node.children.get(chunk);
    if (!child) {
      child = createNode();
      node.children.set(chunk, child);
      log.split(`Created new child for chunk ${chunk}`);
    }
    child.values.set(path.slice(config.bitWidth / 4), value);
  }

  node.values.clear();
  log.split('Split complete');
}

function getNodeValue(node: MerkleNode, path: string, config: TreeConfig): NodeValue | undefined {
  if (node.children) {
    const chunk = getChunk(path, 0, config);
    const child = node.children.get(chunk);
    if (!child) {
      log.node(`No child found for chunk ${chunk}`);
      return undefined;
    }
    return getNodeValue(child, path.slice(config.bitWidth / 4), config);
  }
  return node.values.get(path);
}

function setNodeValue(node: MerkleNode, path: string, value: NodeValue, config: TreeConfig): void {
  node.hash = undefined;

  if (node.children) {
    const chunk = getChunk(path, 0, config);
    let child = node.children.get(chunk);
    if (!child) {
      child = createNode();
      node.children.set(chunk, child);
      log.node(`Created new child for chunk ${chunk}`);
    }
    setNodeValue(child, path.slice(config.bitWidth / 4), value, config);
  } else {
    node.values.set(path, value);
    log.node(`Set value at path ${path}`);
    splitNode(node, config);
  }
}

function hashNode(node: MerkleNode): Hash {
  if (node.hash) {
    return node.hash;
  }

  const hasher = createHash('sha256');

  if (node.children) {
    const sortedChildren = Array.from(node.children.entries())
      .sort(([a], [b]) => a - b);
    
    for (const [chunk, child] of sortedChildren) {
      hasher.update(Buffer.from([chunk]));
      hasher.update(hashNode(child));
    }
  } else {
    const sortedValues = Array.from(node.values.entries())
      .sort(([a], [b]) => a.localeCompare(b));
    
    for (const [path, value] of sortedValues) {
      hasher.update(Buffer.from(path, 'hex'));
      const sortedEntries = Array.from(value.entries())
        .sort(([a], [b]) => Number(a) - Number(b));
      
      for (const [type, data] of sortedEntries) {
        hasher.update(Buffer.from([Number(type)]));
        hasher.update(data);
      }
    }
  }

  node.hash = hasher.digest();
  log.hash(`Generated hash: ${node.hash.toString('hex').slice(0, 8)}...`);
  return node.hash;
}

export function createMerkleStore(config: TreeConfig = { bitWidth: 4, leafThreshold: 16 }) {
  if (config.bitWidth < 1 || config.bitWidth > 16) {
    throw new Error('Bit width must be between 1 and 16');
  }
  if (config.leafThreshold < 1 || config.leafThreshold > 1024) {
    throw new Error('Leaf threshold must be between 1 and 1024');
  }
  
  const rootNode = createNode();
  log.tree('Created tree with config:', config);

  return {
    updateEntityState: (signerId: string, entityId: string, state: EntityRoot) => {
      const path = signerId + entityId;
      const oldValue = getNodeValue(rootNode, path, config);
      const oldHash = oldValue ? createHash('sha256').update(Buffer.from(encode(Array.from(oldValue.entries())))).digest() : undefined;

      // Create entity value map with storage types
      const entityValue = new Map<StorageType, Buffer>();
      if (state.finalBlock) {
        entityValue.set(StorageType.CURRENT_BLOCK, Buffer.from(encode([
          state.finalBlock.blockNumber,
          encode(Object.entries(state.finalBlock.storage)),
          state.finalBlock.channelRoot,
          encode(Array.from(state.finalBlock.channelMap.entries())),
          state.finalBlock.inbox,
          state.finalBlock.validatorSet || []
        ])));
      }
      if (state.consensusBlock) {
        entityValue.set(StorageType.CONSENSUS_BLOCK, Buffer.from(encode([
          state.consensusBlock.blockNumber,
          encode(Object.entries(state.consensusBlock.storage)),
          state.consensusBlock.channelRoot,
          encode(Array.from(state.consensusBlock.channelMap.entries())),
          state.consensusBlock.inbox,
          state.consensusBlock.validatorSet || []
        ])));
      }

      setNodeValue(rootNode, path, entityValue, config);
      const newHash = createHash('sha256').update(Buffer.from(encode(Array.from(entityValue.entries())))).digest();

      if (!oldHash || !newHash.equals(oldHash)) {
        log.tree(`Entity state updated:
          Path: ${signerId.slice(0,8)}/${entityId.slice(0,8)}
          Old Hash: ${oldHash?.toString('hex').slice(0,8) || 'none'}
          New Hash: ${newHash.toString('hex').slice(0,8)}
          Types: ${Array.from(entityValue.keys()).map(k => StorageType[k]).join(', ')}
        `);
      }
    },

    getMerkleRoot: () => {
      const merkleRoot = hashNode(rootNode);
      log.tree('Generated merkle root:', merkleRoot.toString('hex'));
      return merkleRoot;
    },

    debug: {
      getEntityNode: (signerId: string, entityId: string) => {
        const path = signerId + entityId;
        const value = getNodeValue(rootNode, path, config);
        if (!value) return undefined;
        return {
          value,
          hash: createHash('sha256').update(Buffer.from(encode(Array.from(value.entries())))).digest()
        };
      }
    }
  };
}