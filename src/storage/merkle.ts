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
  nodeType: 'server' | 'signer' | 'entity' | 'storage';
  path: Buffer;  // Full path to this node
  values: Map<string, NodeValue | MerkleNode>;  // Can contain either values or child nodes
  children?: Map<number, MerkleNode>;  // For path-based routing
  hash?: Hash;
}

// Convert a buffer to hex path with nibble count prefix
export function bufferToPath(buffer: Buffer): string {
  // Count significant nibbles (ignoring trailing zeros)
  let nibbles = buffer.length * 2;
  while (nibbles > 0 && buffer[Math.floor((nibbles - 1) / 2)] >> (((nibbles - 1) % 2) * 4) === 0) {
    nibbles--;
  }
  
  // Prefix with nibble count as 2 hex chars (up to 255)
  return nibbles.toString(16).padStart(2, '0') + buffer.toString('hex');
}

// Convert hex path back to buffer, removing nibble count prefix
export function pathToBuffer(path: string): Buffer {
  // First 2 chars are nibble count
  const nibbleCount = parseInt(path.slice(0, 2), 16);
  const hex = path.slice(2);
  
  // Convert to buffer and trim any extra bytes
  const fullBuffer = Buffer.from(hex, 'hex');
  const neededBytes = Math.ceil(nibbleCount / 2);
  return fullBuffer.slice(0, neededBytes);
}

// Get number of significant nibbles in a path
export function getNibbleCount(path: string): number {
  return parseInt(path.slice(0, 2), 16);
}

function createNode(nodeType: MerkleNode['nodeType'], path: Buffer): MerkleNode {
  log.node(`Creating ${nodeType} node with path ${path.toString('hex').slice(0,8)}...`);
  
  // Validate node type based on path length
  const expectedType = path.length === 0 ? 'server' :
                      path.length === 32 ? 'signer' :
                      path.length === 64 ? 'entity' : 'storage';
                      
  if (nodeType !== expectedType) {
    throw new Error(`Invalid node type ${nodeType} for path length ${path.length}, expected ${expectedType}`);
  }

  return {
    nodeType,
    path,
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
  const nibbleCount = parseInt(path.slice(0, 2), 16);
  
  // Skip nibble count prefix
  const actualPath = path.slice(2);
  
  // Return 0 if we're past the significant nibbles
  if (offset >= nibbleCount) {
    return 0;
  }
  
  // For 4-bit chunks, process one hex char at a time
  if (bits === 4) {
    const hexChar = actualPath[offset];
    return parseInt(hexChar || '0', 16);
  }
  
  // For other bit widths, use byte-based logic
  const bytesNeeded = Math.ceil(bits / 8);
  const buffer = Buffer.from(actualPath.slice(offset * 2, offset * 2 + bytesNeeded * 2), 'hex');
  
  let chunk = 0;
  for (let i = 0; i < bytesNeeded; i++) {
    chunk = (chunk << 8) | (buffer[i] || 0);
  }
  
  return chunk & ((1 << bits) - 1);
}

function splitNode(node: MerkleNode, config: TreeConfig): void {
  if (node.values.size >= config.leafThreshold && !node.children) {
    log.split(`Splitting leaf with ${node.values.size} values`);
    node.children = new Map();
    
    // Convert values to array for deterministic processing
    const values = Array.from(node.values.entries())
      .sort(([a], [b]) => a.localeCompare(b)); // Sort by path for deterministic order
    node.values.clear();
    
    // Process each value
    for (const [path, value] of values) {
      const chunk = getChunk(path, 0, config);
      
      let child = node.children.get(chunk);
      if (!child) {
        child = createNode(value instanceof Map ? 'storage' : 'entity', Buffer.from(path, 'hex'));
        node.children.set(chunk, child);
      }
      
      // Remove processed nibbles from path
      const sliceLen = config.bitWidth === 4 ? 1 : Math.ceil(config.bitWidth / 4);
      const newPath = path.slice(0, 2) + path.slice(2 + sliceLen); // Keep nibble count
      child.values.set(newPath, value);
      
      // Recursively split if needed
      splitNode(child, config);
    }
  }
}

// Validation functions
function validateNodeType(parentType: MerkleNode['nodeType'], childType: MerkleNode['nodeType'] | 'value'): boolean {
  switch (parentType) {
    case 'server':
      return childType === 'signer';
    case 'signer':
      return childType === 'entity';
    case 'entity':
    case 'storage':
      return childType === 'value';
    default:
      return false;
  }
}

function validateNodeValue(node: MerkleNode, value: NodeValue | MerkleNode): void {
  const childType = value instanceof Map ? 'value' : value.nodeType;
  if (!validateNodeType(node.nodeType, childType)) {
    throw new Error(`Invalid child type ${childType} for parent type ${node.nodeType}`);
  }
}

function getNodeValue(node: MerkleNode, path: string, config: TreeConfig): NodeValue | undefined {
  if (node.children) {
    const chunk = getChunk(path, 0, config);
    const child = node.children.get(chunk);
    if (!child) return undefined;
    
    // Remove processed nibbles from path
    const sliceLen = config.bitWidth === 4 ? 1 : Math.ceil(config.bitWidth / 4);
    const result = getNodeValue(child, path.slice(0, 2) + path.slice(2 + sliceLen), config);
    
    // Only return if it's a valid NodeValue
    return result instanceof Map ? result : undefined;
  }
  
  const value = node.values.get(path);
  return value instanceof Map ? value : undefined;
}

function setNodeValue(node: MerkleNode, path: string, value: NodeValue, config: TreeConfig): void {
  node.hash = undefined; // Invalidate cached hash
  
  if (node.children) {
    const chunk = getChunk(path, 0, config);
    let child = node.children.get(chunk);
    if (!child) {
      // Create appropriate node type based on parent
      const childType = node.nodeType === 'server' ? 'signer' : 
                       node.nodeType === 'signer' ? 'entity' : 'storage';
      child = createNode(childType, Buffer.from(path, 'hex'));
      node.children.set(chunk, child);
    }
    
    // Remove processed nibbles from path
    const sliceLen = config.bitWidth === 4 ? 1 : Math.ceil(config.bitWidth / 4);
    setNodeValue(child, path.slice(0, 2) + path.slice(2 + sliceLen), value, config);
  } else {
    // Validate before setting
    validateNodeValue(node, value);
    node.values.set(path, value);
    splitNode(node, config);
  }
}

function hashNode(node: MerkleNode): Hash {
  if (node.hash) return node.hash;
  
  const hasher = createHash('sha256');
  
  if (node.children) {
    // Branch node - hash sorted children
    const sortedChildren = Array.from(node.children.entries())
      .sort(([a], [b]) => a - b);
      
    for (const [chunk, child] of sortedChildren) {
      hasher.update(Buffer.from([chunk]));
      hasher.update(hashNode(child));
    }
  } else {
    // Leaf node - hash sorted values
    const sortedValues = Array.from(node.values.entries())
      .sort(([a], [b]) => a.localeCompare(b));
      
    for (const [path, value] of sortedValues) {
      hasher.update(node.path);
      
      if (value instanceof Map) {
        // Storage node - hash sorted entries
        const sortedEntries = Array.from(value.entries())
          .sort(([a], [b]) => Number(a) - Number(b));
          
        for (const [type, data] of sortedEntries) {
          hasher.update(Buffer.from([Number(type)]));
          hasher.update(data);
        }
      } else {
        // Entity/Signer node - hash child node
        hasher.update(hashNode(value));
      }
    }
  }
  
  node.hash = hasher.digest();
  return node.hash;
}

function isLeaf(node: MerkleNode): boolean {
  return node && !node.children && node.values !== undefined;
}

function formatTree(node: MerkleNode | null, prefix: string = ''): string {
  if (!node) return '';
  //console.log(node)
  const pathDisplay = node.path.toString('hex').slice(0, 8);
  
  // Show node type and validate hierarchy
  let result = `${prefix}[${pathDisplay}][${node.nodeType}]`;
  const hash = node.hash?.toString('hex').slice(0, 8) || 'no_hash';
  result += `[${node.children ? 'Branch' : 'Leaf'} ${hash}]`;

  if (node.children) {
    const childKeys = Array.from(node.children.keys()).sort((a, b) => a - b);
    result += ` (${childKeys.length} children)\n`;
    result += `${prefix}  ↳ Nibbles: ${childKeys.map(k => k.toString(16)).join(',')}\n`;
    
    // Validate and show children
    for (const key of childKeys) {
      const child = node.children.get(key);
      if (child) {
        // Validate child type matches parent
        const expectedType = node.nodeType === 'server' ? 'signer' :
                           node.nodeType === 'signer' ? 'entity' : 'storage';
        if (child.nodeType !== expectedType) {
          result += `${prefix}  ⚠️  Invalid child type ${child.nodeType} for parent ${node.nodeType}\n`;
        }
        result += formatTree(child, prefix + '  ');
      }
    }
  } else {
    const entries = Array.from(node.values.entries())
      .sort(([a], [b]) => a.localeCompare(b));
    
    result += ` (${entries.length} values)\n`;
    for (const [key, value] of entries) {
      const shortKey = key.slice(0, 16);
      if (value instanceof Map) {
        // Storage value - format as key-value pairs
        if (node.nodeType !== 'entity' && node.nodeType !== 'storage') {
          result += `${prefix}  ⚠️  Invalid storage value in ${node.nodeType} node\n`;
        }
        const valueObj = Object.fromEntries(Array.from(value.entries())
          .map(([k, v]) => [StorageType[k], v?.toString('hex').slice(0, 8)]));
        result += `${prefix}  ├─${shortKey}... ${JSON.stringify(valueObj)}\n`;
      } else {
        // Node value - validate and format recursively
        if (!validateNodeType(node.nodeType, value.nodeType)) {
          result += `${prefix}  ⚠️  Invalid value type ${value.nodeType} in ${node.nodeType} node\n`;
        }
        result += formatTree(value, prefix + '  ');
      }
    }
  }

  return result;
}

function formatValue(value: NodeValue): string {
  const entries = Array.from(value.entries())
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([type, data]) => `${StorageType[type]}=${data.slice(0,8).toString('hex')}`);
  return `{${entries.join(', ')}}`;
}

function getNodePrefix(path: string): string {
  switch(path.length) {
    case 0: return '[Server]';
    case 1: return '[Signer]';
    case 2: return '[Entity]';
    case 3: return '[Channel]';
    default: return '[Node]';
  }
}

// Create a new merkle store
export function createMerkleStore(config: TreeConfig = { bitWidth: 4, leafThreshold: 16 }) {
  const root = createNode('server', Buffer.from([]));
  
  return {
    updateEntityState(signerId: string, entityId: string, state: EntityRoot) {
      log.tree(`Updating entity state: signer=${signerId.slice(0,8)}... entity=${entityId.slice(0,8)}...`);
      
      // Convert IDs to buffers
      const signerBuf = Buffer.from(signerId, 'hex');
      const entityBuf = Buffer.concat([signerBuf, Buffer.from(entityId, 'hex')]);
      
      // Get or create signer node
      let signerNode = root.values.get(signerId) as MerkleNode;
      if (!signerNode) {
        signerNode = createNode('signer', signerBuf);
        validateNodeValue(root, signerNode);
        root.values.set(signerId, signerNode);
      }
      
      // Get or create entity node
      let entityNode = signerNode.values.get(entityId) as MerkleNode;
      if (!entityNode) {
        entityNode = createNode('entity', entityBuf);
        validateNodeValue(signerNode, entityNode);
        signerNode.values.set(entityId, entityNode);
      }
      
      // Convert entity state to storage value
      const value = new Map<StorageType, Buffer>();
      if (state.finalBlock) {
        const blockData = encode([
          state.finalBlock.blockNumber,
          encode(Object.entries(state.finalBlock.storage)),
          state.finalBlock.channelRoot,
          encode(Array.from(state.finalBlock.channelMap.entries())),
          state.finalBlock.inbox,
          state.finalBlock.validatorSet || []
        ]);
        value.set(StorageType.CURRENT_BLOCK, Buffer.from(blockData));
        log.tree(`Set block ${state.finalBlock.blockNumber} for entity ${entityId.slice(0,8)}...`);
      }
      
      // Set the storage value
      validateNodeValue(entityNode, value);
      entityNode.values = new Map([['storage', value]]);
      
      // Invalidate hashes up the tree
      entityNode.hash = undefined;
      signerNode.hash = undefined;
      root.hash = undefined;
    },
    
    debug: {
      getEntityNode(signerId: string, entityId: string) {
        const signerNode = root.values.get(signerId) as MerkleNode;
        if (!signerNode) return null;
        
        const entityNode = signerNode.values.get(entityId) as MerkleNode;
        if (!entityNode) return null;
        
        const storageValue = entityNode.values.get('storage') as NodeValue;
        return {
          value: storageValue,
          hash: hashNode(entityNode)
        };
      }
    },
    
    getMerkleRoot(): Buffer {
      return hashNode(root);
    },
    
    print(): string {
      return formatTree(root);
    }
  };
} 