import { createHash } from 'crypto';
import { encode } from 'rlp';
import debug from 'debug';
import { EntityRoot, EntityBlock } from '../entity.js';

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

let logSequence = 0;

function getNextSequence(): string {
  return `#${(++logSequence).toString().padStart(4, '0')}`;
}

function getChunk(path: string, offset: number, config: TreeConfig): number {
  const bits = config.bitWidth;
  // For 4-bit chunks, we want to process one hex char at a time
  if (bits === 4) {
    // Take the first hex character at this offset
    const hexChar = path[offset];
    const chunk = parseInt(hexChar, 16);
    
    // Only log when offset is 0 (new path) to reduce spam
    if (offset === 0) {
      log.path(`Processing path ${formatHex(path.slice(0, 8))}... chunk: 0x${chunk.toString(16)} ${getNextSequence()}`);
    }
    return chunk;
  }
  
  // For other bit widths, use the original byte-based logic
  const bytesNeeded = Math.ceil(bits / 8);
  const buffer = Buffer.from(path.slice(offset * 2, offset * 2 + bytesNeeded * 2), 'hex');
  
  let chunk = 0;
  for (let i = 0; i < bytesNeeded; i++) {
    chunk = (chunk << 8) | buffer[i];
  }
  
  const mask = (1 << bits) - 1;
  chunk = chunk & mask;

  // Only log when offset is 0 (new path) to reduce spam
  if (offset === 0) {
    log.path(`Processing path ${formatHex(path.slice(0, 8))}... chunk: 0x${chunk.toString(16)} ${getNextSequence()}`);
  }
  return chunk;
}

function splitNode(node: MerkleNode, config: TreeConfig): void {
  if (node.values.size >= config.leafThreshold && !node.children) {
    log.split(`Splitting leaf with ${node.values.size} values ${getNextSequence()}`);
    node.children = new Map();
    
    for (const [path, value] of node.values) {
      const chunk = getChunk(path, 0, config);
      let child = node.children.get(chunk);
      if (!child) {
        child = createNode();
        node.children.set(chunk, child);
        log.split(`Created new child for chunk 0x${chunk.toString(16)} ${getNextSequence()}`);
      }
      // Always slice one character for 4-bit chunks, otherwise use bitWidth/4
      const sliceLen = config.bitWidth === 4 ? 1 : Math.ceil(config.bitWidth / 4);
      const newPath = path.slice(sliceLen);
      child.values.set(newPath, value);
    }

    const childCount = node.children.size;
    node.values.clear();
    log.split(`Split complete: ${childCount} branches ${getNextSequence()}`);
  }
}

function getNodeValue(node: MerkleNode, path: string, config: TreeConfig): NodeValue | undefined {
  if (node.children) {
    const chunk = getChunk(path, 0, config);
    const child = node.children.get(chunk);
    if (!child) {
      log.node(`No child found for chunk ${chunk} ${getNextSequence()}`);
      return undefined;
    }
    // Always slice one character for 4-bit chunks, otherwise use bitWidth/4
    const sliceLen = config.bitWidth === 4 ? 1 : Math.ceil(config.bitWidth / 4);
    return getNodeValue(child, path.slice(sliceLen), config);
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
      log.node(`New branch at chunk ${chunk} ${getNextSequence()}`);
    }
    // Always slice one character for 4-bit chunks, otherwise use bitWidth/4
    const sliceLen = config.bitWidth === 4 ? 1 : Math.ceil(config.bitWidth / 4);
    setNodeValue(child, path.slice(sliceLen), value, config);
  } else {
    node.values.set(path, value);
    log.node(`Updated leaf: ${formatHex(path.slice(0, 8))}... ${getNextSequence()}`);
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
  log.hash(`${node.children ? 'Branch' : 'Leaf'} hash: ${node.hash.toString('hex').slice(0, 8)} ${getNextSequence()}`);
  return node.hash;
}

// Helper to format hex strings with nibble grouping
function formatHex(hex: string, groupSize: number = 4): string {
  if (!hex) return 'no_hash';
  const groups = hex.match(new RegExp(`.{1,${groupSize}}`, 'g')) || [];
  return groups.join('.');
}

// Helper to visualize tree structure with improved formatting
function visualizeTree(node: MerkleNode, prefix: string = '', isLast: boolean = true, showDetails: boolean = true, parentPath: string = '', depth: number = 0): string {
  let result = prefix;
  
  // Add branch visualization with thicker lines for root
  if (depth === 0) {
    result += '╔═';
  } else {
    result += isLast ? '└─' : '├─';
  }
  
  // Add node info with color coding
  if (node.children) {
    const hashHex = node.hash?.toString('hex')?.slice(0, 8) || '';
    const hash = formatHex(hashHex);
    const childCount = node.children.size;
    const childNibbles = Array.from(node.children.keys())
      .map(k => k.toString(16))
      .sort()
      .join(',');
    
    // Count total descendants
    let totalDescendants = 0;
    const countDescendants = (n: MerkleNode) => {
      if (n.children) {
        totalDescendants += n.children.size;
        for (const child of n.children.values()) {
          countDescendants(child);
        }
      }
    };
    countDescendants(node);
    
    result += `\x1b[36m[Branch ${hash}]\x1b[0m \x1b[33m(${childCount} direct, ${totalDescendants} total)\x1b[0m\n`;
    if (childCount > 0) {
      result += `${prefix}${isLast ? ' ' : '│'}  \x1b[90m↳ Nibbles: ${childNibbles}\x1b[0m\n`;
    }
    
    // Recursively add children with improved connecting lines
    const children = Array.from(node.children.entries()).sort(([a], [b]) => a - b);
    children.forEach(([chunk, child], index) => {
      const newPrefix = prefix + (isLast ? '   ' : '│  ');
      const isLastChild = index === children.length - 1;
      const newParentPath = parentPath + chunk.toString(16);
      result += visualizeTree(child, newPrefix, isLastChild, showDetails, newParentPath, depth + 1);
    });
  } else {
    // Leaf node - show values with improved formatting
    const hashHex = node.hash?.toString('hex')?.slice(0, 8) || '';
    const hash = formatHex(hashHex);
    const valueCount = node.values.size;
    // Show current path nibbles in front of leaf
    const currentPath = formatHex(parentPath);
    result += `\x1b[90m${currentPath}\x1b[0m \x1b[32m[Leaf ${hash}]\x1b[0m \x1b[33m(${valueCount} values)\x1b[0m\n`;
    
    // Show value details if requested and there are values
    if (showDetails && valueCount > 0) {
      const newPrefix = prefix + (isLast ? '   ' : '│  ');
      const values = Array.from(node.values.entries())
        .sort(([a], [b]) => a.localeCompare(b));
      
      values.forEach(([path, value], index) => {
        const isLastValue = index === values.length - 1;
        const fullPath = parentPath + path;
        // Format first 8 nibbles with dots between them
        const formattedPath = formatHex(fullPath.slice(0, 8));
        result += `${newPrefix}${isLastValue ? '└─' : '├─'}\x1b[90m${formattedPath}\x1b[0m\n`;
        
        // Add indentation for value details
        const valuePrefix = newPrefix + (isLastValue ? '   ' : '│  ');
        
        // Show all storage types and their values with improved formatting, excluding CURRENT_BLOCK
        const sortedTypes = Array.from(value.entries())
          .filter(([type]) => type !== StorageType.CURRENT_BLOCK)
          .sort(([a], [b]) => Number(a) - Number(b));
        
        sortedTypes.forEach(([type, data], typeIndex) => {
          const isLastType = typeIndex === sortedTypes.length - 1;
          const typeName = StorageType[type] || type;
          const shortData = data.toString('hex').slice(0, 16) + (data.length > 16 ? '...' : '');
          result += `${valuePrefix}${isLastType ? '└─' : '├─'}\x1b[35m${typeName}\x1b[0m: \x1b[33m${shortData}\x1b[0m\n`;
        });
      });
    }
  }
  
  return result;
}

interface MerkleStoreDebug {
  getEntityNode: (signerId: string, entityId: string) => { 
    value: NodeValue; 
    hash: Buffer; 
  } | undefined;
  visualizeTree: () => string;
  formatHex: (hex: string, groupSize?: number) => string;
}

export function createMerkleStore(config: TreeConfig = { bitWidth: 4, leafThreshold: 16 }) {
  if (config.bitWidth < 1 || config.bitWidth > 16) {
    throw new Error('Bit width must be between 1 and 16');
  }
  if (config.leafThreshold < 1 || config.leafThreshold > 1024) {
    throw new Error('Leaf threshold must be between 1 and 1024');
  }
  
  const rootNode = createNode();
  log.tree(`Created tree with config: ${JSON.stringify(config)} ${getNextSequence()}`);

  return {
    updateEntityState: (signerId: string, entityId: string, state: EntityRoot) => {
      const path = signerId + entityId;
      const oldValue = getNodeValue(rootNode, path, config);
      const oldHash = oldValue ? createHash('sha256').update(Buffer.from(encode(Array.from(oldValue.entries())))).digest() : undefined;

      // Create entity value map with storage types
      const entityValue = new Map<StorageType, Buffer>();
      if (state.finalBlock) {
        const blockData = encode([
          state.finalBlock.blockNumber,
          encode(Object.entries(state.finalBlock.storage)),
          state.finalBlock.channelRoot,
          encode(Array.from(state.finalBlock.channelMap.entries())),
          state.finalBlock.inbox,
          state.finalBlock.validatorSet || []
        ]);
        entityValue.set(StorageType.CURRENT_BLOCK, Buffer.from(blockData));
      }
      if (state.consensusBlock) {
        const blockData = encode([
          state.consensusBlock.blockNumber,
          encode(Object.entries(state.consensusBlock.storage)),
          state.consensusBlock.channelRoot,
          encode(Array.from(state.consensusBlock.channelMap.entries())),
          state.consensusBlock.inbox,
          state.consensusBlock.validatorSet || []
        ]);
        entityValue.set(StorageType.CONSENSUS_BLOCK, Buffer.from(blockData));
      }

      setNodeValue(rootNode, path, entityValue, config);
      const newHash = createHash('sha256').update(Buffer.from(encode(Array.from(entityValue.entries())))).digest();

      if (!oldHash || !newHash.equals(oldHash)) {
        log.tree(`Entity state updated:
          Path: ${signerId.slice(0,8)}/${entityId.slice(0,8)}
          Old Hash: ${oldHash?.toString('hex').slice(0,8) || 'none'}
          New Hash: ${newHash.toString('hex').slice(0,8)}
          Types: ${Array.from(entityValue.keys()).map(k => StorageType[k]).join(', ')}
          ${getNextSequence()}
        `);
      }
    },

    getMerkleRoot: () => {
      const merkleRoot = hashNode(rootNode);
      log.tree(`Generated merkle root: ${merkleRoot.toString('hex')} ${getNextSequence()}`);
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
      },
      
      visualizeTree: () => visualizeTree(rootNode),
      formatHex: (hex: string, groupSize?: number) => formatHex(hex, groupSize)
    } as MerkleStoreDebug
  };
} 