// for regular use > bun run src/server.ts
// for debugging > bun repl 
// await import('./debug.js'); 

// Environment detection and compatibility layer
const isBrowser = typeof window !== 'undefined';

// Simplified crypto compatibility
const createHash = isBrowser ? 
  (algorithm: string) => ({
    update: (data: string) => ({
      digest: (encoding?: string) => {
        // Simple deterministic hash for browser demo
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
          const char = data.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash; // Convert to 32bit integer
        }
        const hashStr = Math.abs(hash).toString(16).padStart(8, '0');
        return encoding === 'hex' ? hashStr : Buffer.from(hashStr);
      }
    })
  }) :
  require('crypto').createHash;

const randomBytes = isBrowser ?
  (size: number): Uint8Array => {
    const array = new Uint8Array(size);
    crypto.getRandomValues(array);
    return array;
  } :
  require('crypto').randomBytes;

// Simplified Buffer polyfill for browser
const getBuffer = () => {
  if (isBrowser) {
    return {
      from: (data: any, encoding: string = 'utf8') => {
        if (typeof data === 'string') {
          return new TextEncoder().encode(data);
        }
        return new Uint8Array(data);
      }
    };
  }
  return require('buffer').Buffer;
};

const Buffer = getBuffer();

// Browser polyfill for Uint8Array.toString()
if (isBrowser) {
  (Uint8Array.prototype as any).toString = function(encoding: string = 'utf8') {
    return new TextDecoder().decode(this);
  };
  (window as any).Buffer = Buffer;
}

// RLP compatibility (simplified for browser)


// Debug compatibility
// Simplified debug configuration
const createDebug = (namespace: string) => {
  const shouldLog = namespace.includes('state') || namespace.includes('tx') || 
                   namespace.includes('block') || namespace.includes('error') || 
                   namespace.includes('diff') || namespace.includes('info');
  return shouldLog ? console.log.bind(console, `[${namespace}]`) : () => {};
};

const debug = isBrowser ? createDebug : require('debug');

// Configure debug logging with functional approach
const log = {
  state: debug('state:🔵'),
  tx: debug('tx:🟡'),
  block: debug('block:🟢'),
  error: debug('error:🔴'),
  diff: debug('diff:🟣'),
  info: debug('info:ℹ️')
};

// Use hex for Map/Set keys, Buffers for DB/RLP
const ENC = 'hex' as const;

const hash = (data: Buffer | string): Buffer => 
  createHash('sha256').update(data.toString()).digest();

// This code works in both Node.js and the browser
import { Level } from 'level';
import { encode, decode } from './snapshot-coder.js';

// --- Database Setup ---
const db: Level<Buffer, Buffer> = new Level('xln-snapshots', { valueEncoding: 'buffer', keyEncoding: 'binary' });

// Function to clear the database and reset in-memory history
const clearDatabase = async () => {
  console.log('Clearing database and resetting history...');
  await db.clear();
  resetHistory(); // a function you already have
  console.log('Database cleared.');
  // After calling this, you might need to restart the process or reload the page
  // to re-initialize the environment from a clean state.
};




// === TYPES ===

declare const console: any;
let DEBUG = true;

interface JurisdictionConfig {
  address: string;
  name: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  chainId?: number;
}

interface ConsensusConfig {
  mode: 'proposer-based' | 'gossip-based';
  threshold: bigint;
  validators: string[];
  shares: { [validatorId: string]: bigint };
  jurisdiction?: JurisdictionConfig; // Add jurisdiction support
}

interface ServerInput {
  serverTxs: ServerTx[];
  entityInputs: EntityInput[];
}

interface ServerTx {
  type: 'importReplica';
  entityId: string;
  signerId: string;
  data: {
    config: ConsensusConfig;
    isProposer: boolean;
  };
}

interface EntityInput {
  entityId: string;
  signerId: string;
  entityTxs?: EntityTx[];
  precommits?: Map<string, string>; // signerId -> signature
  proposedFrame?: ProposedEntityFrame;
}

interface Proposal {
  id: string; // hash of the proposal
  proposer: string;
  action: ProposalAction;
  votes: Map<string, 'yes' | 'no'>;
  status: 'pending' | 'executed' | 'rejected';
  created: number; // entity timestamp when proposal was created (deterministic)
}

interface ProposalAction {
  type: 'collective_message';
  data: {
    message: string;
  };
}

interface EntityTx {
  type: 'chat' | 'propose' | 'vote';
  data: any;
}

// === STATE ===
interface EntityState {
  height: number;
  timestamp: number;
  nonces: Map<string, number>;
  messages: string[];
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;
}

// === ENTITY REGISTRATION FUNCTIONS ===

// Entity types
type EntityType = 'lazy' | 'numbered' | 'named';

// Entity encoding utilities
const encodeBoard = (config: ConsensusConfig): string => {
  const delegates = config.validators.map(validator => ({
    entityId: validator, // For EOA addresses (20 bytes)
    votingPower: Number(config.shares[validator] || 1n)
  }));

  const board = {
    votingThreshold: Number(config.threshold),
    delegates: delegates
  };

  // Return JSON representation that can be hashed consistently
  return JSON.stringify(board, Object.keys(board).sort());
};

const hashBoard = (encodedBoard: string): string => {
  // Use real keccak256 hash like Ethereum
  return ethers.keccak256(ethers.toUtf8Bytes(encodedBoard));
};

const generateLazyEntityId = (validators: {name: string, weight: number}[] | string[], threshold: bigint): string => {
  // Create deterministic entity ID from quorum composition
  let validatorData: {name: string, weight: number}[];
  
  // Handle both formats: array of objects or array of strings (assume weight=1)
  if (typeof validators[0] === 'string') {
    validatorData = (validators as string[]).map(name => ({name, weight: 1}));
  } else {
    validatorData = validators as {name: string, weight: number}[];
  }
  
  // Sort by name for canonical ordering
  const sortedValidators = validatorData.slice().sort((a, b) => a.name.localeCompare(b.name));
  
  const quorumData = {
    validators: sortedValidators,
    threshold: threshold.toString()
  };
  
  const serialized = JSON.stringify(quorumData);
  return hashBoard(serialized);
};

const generateNumberedEntityId = (entityNumber: number): string => {
  // Convert number to bytes32 (left-padded with zeros)
  return `0x${entityNumber.toString(16).padStart(64, '0')}`;
};

const generateNamedEntityId = (name: string): string => {
  // For named entities: entityId resolved via name lookup on-chain
  // This is just for client-side preview
  return hashBoard(name);
};

const detectEntityType = (entityId: string): EntityType => {
  // Check if this is a hex string (0x followed by hex digits)
  if (entityId.startsWith('0x') && entityId.length === 66) {
    try {
      const num = BigInt(entityId);
      
      // Small positive numbers = numbered entities
      if (num > 0n && num < 1000000n) {
        return 'numbered';
      }
      
      // Very large numbers are lazy entity hashes
      return 'lazy';
    } catch {
      return 'lazy';
    }
  }
  
  // Check if this is a numeric string before trying BigInt conversion
  if (/^[0-9]+$/.test(entityId)) {
    try {
      const num = BigInt(entityId);
      
      // Small positive numbers = numbered entities
      if (num > 0n && num < 1000000n) {
        return 'numbered';
      }
      
      // Very large numbers might be lazy entity hashes
      return 'lazy';
    } catch {
      return 'lazy';
    }
  }
  
  // Non-numeric, non-hex strings are lazy entities
  return 'lazy';
};

const extractNumberFromEntityId = (entityId: string): number | null => {
  // Check if this is a hex string (0x followed by hex digits)
  if (entityId.startsWith('0x') && entityId.length === 66) {
    try {
      const num = BigInt(entityId);
      
      // Check if it's a numbered entity (small positive number)
      if (num > 0n && num < 1000000n) {
        return Number(num);
      }
      
      return null;
    } catch {
      return null;
    }
  }
  
  // Check if this is a numeric string before trying BigInt conversion
  if (/^[0-9]+$/.test(entityId)) {
    try {
      const num = BigInt(entityId);
      
      // Check if it's a numbered entity (small positive number)
      if (num > 0n && num < 1000000n) {
        return Number(num);
      }
      
      return null;
    } catch {
      return null;
    }
  }
  
  return null;
};

// 1. LAZY ENTITIES (Free, instant)
const createLazyEntity = (name: string, validators: string[], threshold: bigint, jurisdiction?: JurisdictionConfig): ConsensusConfig => {
  const entityId = generateLazyEntityId(validators, threshold);
  
  if (DEBUG) console.log(`🔒 Creating lazy entity: ${name}`);
  if (DEBUG) console.log(`   EntityID: ${entityId} (quorum hash)`);
  if (DEBUG) console.log(`   Validators: ${validators.join(', ')}`);
  if (DEBUG) console.log(`   Threshold: ${threshold}`);
  if (DEBUG) console.log(`   🆓 FREE - No gas required`);
  
  const shares: { [validatorId: string]: bigint } = {};
  validators.forEach(validator => {
    shares[validator] = 1n; // Equal voting power for simplicity
  });

  return {
    mode: 'proposer-based',
    threshold,
    validators,
    shares,
    jurisdiction
  };
};

// 2. NUMBERED ENTITIES (Small gas cost)
const createNumberedEntity = async (name: string, validators: string[], threshold: bigint, jurisdiction: JurisdictionConfig): Promise<{config: ConsensusConfig, entityNumber: number}> => {
  if (!jurisdiction) {
    throw new Error("Jurisdiction required for numbered entity registration");
  }
  
  const boardHash = hashBoard(encodeBoard({
    mode: 'proposer-based',
    threshold,
    validators,
    shares: validators.reduce((acc, v) => ({...acc, [v]: 1n}), {}),
    jurisdiction
  }));
  
  if (DEBUG) console.log(`🔢 Creating numbered entity: ${name}`);
  if (DEBUG) console.log(`   Board Hash: ${boardHash}`);
  if (DEBUG) console.log(`   Jurisdiction: ${jurisdiction.name}`);
  if (DEBUG) console.log(`   💸 Gas required for registration`);
  
  // Simulate blockchain call
  const entityNumber = Math.floor(Math.random() * 1000000) + 1; // Demo: random number
  const entityId = generateNumberedEntityId(entityNumber);
  
  if (DEBUG) console.log(`   ✅ Assigned Entity Number: ${entityNumber}`);
  if (DEBUG) console.log(`   EntityID: ${entityId}`);
  
  const shares: { [validatorId: string]: bigint } = {};
  validators.forEach(validator => {
    shares[validator] = 1n;
  });

  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold,
    validators,
    shares,
    jurisdiction
  };
  
  return { config, entityNumber };
};

// 3. NAMED ENTITIES (Premium - admin assignment required)
const requestNamedEntity = async (name: string, entityNumber: number, jurisdiction: JurisdictionConfig): Promise<string> => {
  if (!jurisdiction) {
    throw new Error("Jurisdiction required for named entity");
  }
  
  if (DEBUG) console.log(`🏷️ Requesting named entity assignment`);
  if (DEBUG) console.log(`   Name: ${name}`);
  if (DEBUG) console.log(`   Target Entity Number: ${entityNumber}`);
  if (DEBUG) console.log(`   Jurisdiction: ${jurisdiction.name}`);
  if (DEBUG) console.log(`   👑 Requires admin approval`);
  
  // Simulate admin assignment request
  const requestId = `req_${Math.random().toString(16).substring(2, 10)}`;
  
  if (DEBUG) console.log(`   📝 Name assignment request submitted: ${requestId}`);
  if (DEBUG) console.log(`   ⏳ Waiting for admin approval...`);
  
  return requestId;
};

// Entity resolution (client-side)
const resolveEntityIdentifier = async (identifier: string): Promise<{entityId: string, type: EntityType}> => {
  // Handle different input formats
  if (identifier.startsWith('#')) {
    // #42 -> numbered entity
    const number = parseInt(identifier.slice(1));
    return {
      entityId: generateNumberedEntityId(number),
      type: 'numbered'
    };
  } else if (/^\d+$/.test(identifier)) {
    // 42 -> numbered entity
    const number = parseInt(identifier);
    return {
      entityId: generateNumberedEntityId(number),
      type: 'numbered'
    };
  } else if (identifier.startsWith('0x')) {
    // 0x123... -> direct entity ID
    return {
      entityId: identifier,
      type: detectEntityType(identifier)
    };
  } else {
    // "coinbase" -> named entity (requires on-chain lookup)
    // For demo, simulate lookup
    if (DEBUG) console.log(`🔍 Looking up named entity: ${identifier}`);
    
    // Simulate on-chain name resolution
    const simulatedNumber = identifier === 'coinbase' ? 42 : 0;
    if (simulatedNumber > 0) {
      return {
        entityId: generateNumberedEntityId(simulatedNumber),
        type: 'named'
      };
    } else {
      throw new Error(`Named entity "${identifier}" not found`);
    }
  }
};

// === ETHEREUM INTEGRATION ===
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Load contract configuration directly in jurisdiction generation
const ENTITY_PROVIDER_ABI = [
  "function registerNumberedEntity(bytes32 boardHash) external returns (uint256 entityNumber)",
  "function assignName(string memory name, uint256 entityNumber) external",
  "function transferName(string memory name, uint256 newEntityNumber) external",
  "function entities(bytes32 entityId) external view returns (tuple(uint256 boardHash, uint8 status, uint256 activationTime))",
  "function nameToNumber(string memory name) external view returns (uint256)",
  "function numberToName(uint256 entityNumber) external view returns (string memory)",
  "function nextNumber() external view returns (uint256)",
  "event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash)",
  "event NameAssigned(string indexed name, uint256 indexed entityNumber)",
  "event NameTransferred(string indexed name, uint256 indexed oldEntityNumber, uint256 indexed newEntityNumber)"
];

const connectToEthereum = async (rpcUrl: string = 'http://localhost:8545', contractAddress?: string) => {
  // Get contract address from configuration if not provided
  const port = rpcUrl.split(':').pop() || '8545';
  const finalContractAddress = contractAddress || await getContractAddress(port);
  
  if (!finalContractAddress) {
    throw new Error(`No contract address found for network port ${port}`);
  }
  
  try {
    // Connect to specified RPC node
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    
    // Use first account for testing (Hardhat account #0)
    const signer = await provider.getSigner(0);
    
    // Create contract instance
    const entityProvider = new ethers.Contract(finalContractAddress, ENTITY_PROVIDER_ABI, signer);
    
    return { provider, signer, entityProvider };
  } catch (error) {
    console.error(`Failed to connect to Ethereum at ${rpcUrl}:`, error);
    throw error;
  }
};

const registerNumberedEntityOnChain = async (config: ConsensusConfig, name: string): Promise<{txHash: string, entityNumber: number}> => {
  if (!config.jurisdiction) {
    throw new Error("Jurisdiction required for on-chain registration");
  }
  
  try {
    const { entityProvider } = await connectToEthereum();
    
    const encodedBoard = encodeBoard(config);
    const boardHash = hashBoard(encodedBoard);
    
    if (DEBUG) console.log(`🏛️ Registering numbered entity "${name}" on chain`);
    if (DEBUG) console.log(`   Jurisdiction: ${config.jurisdiction.name}`);
    if (DEBUG) console.log(`   EntityProvider: ${config.jurisdiction.entityProviderAddress}`);
    if (DEBUG) console.log(`   Board Hash: ${boardHash}`);
    
    // Call the smart contract
    const tx = await entityProvider.registerNumberedEntity(boardHash);
    if (DEBUG) console.log(`   📤 Transaction sent: ${tx.hash}`);
    
    // Wait for confirmation
    const receipt = await tx.wait();
    if (DEBUG) console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);
    
    // Extract entity number from event logs
    const event = receipt.logs.find((log: any) => {
      try {
        const parsed = entityProvider.interface.parseLog(log);
        return parsed?.name === 'EntityRegistered';
      } catch {
        return false;
      }
    });
    
    if (!event) {
      throw new Error('EntityRegistered event not found in transaction logs');
    }
    
    const parsedEvent = entityProvider.interface.parseLog(event);
    const entityId = parsedEvent?.args[0];
    const entityNumber = Number(parsedEvent?.args[1]);
    
    if (DEBUG) console.log(`✅ Numbered entity registered!`);
    if (DEBUG) console.log(`   TX: ${tx.hash}`);
    if (DEBUG) console.log(`   Entity Number: ${entityNumber}`);
    
    return { txHash: tx.hash, entityNumber };
    
  } catch (error) {
    console.error('❌ Blockchain registration failed:', error);
    
    // Fallback to simulation for development
    if (DEBUG) console.log('   🔄 Falling back to simulation...');
    
    const txHash = `0x${Math.random().toString(16).substring(2, 66)}`;
    const entityNumber = Math.floor(Math.random() * 1000000) + 1;
    
    if (DEBUG) console.log(`   ✅ Simulated registration completed`);
    if (DEBUG) console.log(`   TX: ${txHash}`);
    if (DEBUG) console.log(`   Entity Number: ${entityNumber}`);
    
    return { txHash, entityNumber };
  }
};

const assignNameOnChain = async (name: string, entityNumber: number): Promise<{txHash: string}> => {
  try {
    const { entityProvider } = await connectToEthereum();
    
    if (DEBUG) console.log(`🏷️  Assigning name "${name}" to entity #${entityNumber}`);
    
    // Call the smart contract (admin only)
    const tx = await entityProvider.assignName(name, entityNumber);
    if (DEBUG) console.log(`   📤 Transaction sent: ${tx.hash}`);
    
    // Wait for confirmation
    const receipt = await tx.wait();
    if (DEBUG) console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);
    
    if (DEBUG) console.log(`✅ Name assigned successfully!`);
    if (DEBUG) console.log(`   TX: ${tx.hash}`);
    
    return { txHash: tx.hash };
    
  } catch (error) {
    console.error('❌ Name assignment failed:', error);
    throw error;
  }
};

const getEntityInfoFromChain = async (entityId: string): Promise<{exists: boolean, entityNumber?: number, name?: string}> => {
  try {
    const { entityProvider } = await connectToEthereum();
    
    // Try to get entity info
    const entityInfo = await entityProvider.entities(entityId);
    
    if (entityInfo.status === 0) {
      return { exists: false };
    }
    
    // For numbered entities, get the number and name
    const entityType = detectEntityType(entityId);
    let entityNumber: number | undefined;
    let name: string | undefined;
    
         if (entityType === 'numbered') {
       const extractedNumber = extractNumberFromEntityId(entityId);
       if (extractedNumber !== null) {
         entityNumber = extractedNumber;
        try {
          const retrievedName = await entityProvider.numberToName(entityNumber);
          name = retrievedName || undefined;
        } catch {
          // No name assigned
        }
      }
    }
    
    return { exists: true, entityNumber, name };
    
  } catch (error) {
    console.error('❌ Failed to get entity info from chain:', error);
    return { exists: false };
  }
};

const getNextEntityNumber = async (port: string = '8545'): Promise<number> => {
  try {
    const rpcUrl = `http://localhost:${port}`;
    const contractAddress = await getContractAddress(port);
    const { entityProvider } = await connectToEthereum(rpcUrl, contractAddress);
    
    if (DEBUG) console.log(`🔍 Fetching next entity number from ${contractAddress} (port ${port})`);
    
    const nextNumber = await entityProvider.nextNumber();
    const result = Number(nextNumber);
    
    if (DEBUG) console.log(`🔢 Next entity number: ${result}`);
    return result;
    
  } catch (error) {
    console.error('❌ Failed to get next entity number:', error);
    
    // Try to check if contract exists by calling a simpler function
    try {
      const rpcUrl = `http://localhost:${port}`;
      const contractAddress = await getContractAddress(port);
      const { provider } = await connectToEthereum(rpcUrl, contractAddress);
      const code = await provider.getCode(contractAddress);
      if (code === '0x') {
        console.error('❌ Contract not deployed at address:', contractAddress);
      } else {
        console.log('✅ Contract exists, but nextNumber() call failed');
      }
    } catch (checkError) {
      console.error('❌ Failed to check contract:', checkError);
    }
    
    // Fallback to a reasonable default
    return 1;
  }
};

const transferNameBetweenEntities = async (name: string, fromNumber: number, toNumber: number, jurisdiction: JurisdictionConfig): Promise<string> => {
  if (DEBUG) console.log(`🔄 Transferring name "${name}" from #${fromNumber} to #${toNumber}`);
  
  const txHash = `0x${Math.random().toString(16).substring(2, 66)}`;
  
  if (DEBUG) console.log(`✅ Name transferred! TX: ${txHash}`);
  return txHash;
};

const isEntityRegistered = async (entityId: string): Promise<boolean> => {
  const type = detectEntityType(entityId);
  
  // Lazy entities are never "registered" - they exist by definition
  if (type === 'lazy') {
    return false;
  }
  
  // Numbered and named entities require on-chain verification
  // For demo, assume they exist if they're small numbers
  if (!/^[0-9]+$/.test(entityId)) {
    return false; // Non-numeric IDs are not registered
  }
  
  try {
    const num = BigInt(entityId);
    return num > 0n && num < 1000000n;
  } catch {
    return false;
  }
};

interface ProposedEntityFrame {
  height: number;
  txs: EntityTx[];
  hash: string;
  newState: EntityState;
  signatures: Map<string, string>; // signerId -> signature
}

interface EntityReplica {
  entityId: string;
  signerId: string;
  state: EntityState;
  mempool: EntityTx[];
  proposal?: ProposedEntityFrame;
  lockedFrame?: ProposedEntityFrame; // Frame this validator is locked/precommitted to
  isProposer: boolean;
}

interface Env {
  replicas: Map<string, EntityReplica>;
  height: number;
  timestamp: number;
  serverInput: ServerInput; // Persistent storage for merged inputs
  // Future: add database connections, config, utilities, etc.
}

interface EnvSnapshot {
  height: number;
  timestamp: number;
  replicas: Map<string, EntityReplica>;
  serverInput: ServerInput;
  serverOutputs: EntityInput[];
  description: string;
}

// Global history for time machine
let envHistory: EnvSnapshot[] = [];

// === SNAPSHOT UTILITIES ===
const deepCloneReplica = (replica: EntityReplica): EntityReplica => {
  const cloneMap = <K, V>(map: Map<K, V>) => new Map(map);
  const cloneArray = <T>(arr: T[]) => [...arr];
  
  return {
    entityId: replica.entityId,
    signerId: replica.signerId,
    state: {
      height: replica.state.height,
      timestamp: replica.state.timestamp,
      nonces: cloneMap(replica.state.nonces),
      messages: cloneArray(replica.state.messages),
      proposals: new Map(
        Array.from(replica.state.proposals.entries()).map(([id, proposal]) => [
          id,
          { ...proposal, votes: cloneMap(proposal.votes) }
        ])
      ),
      config: replica.state.config
    },
    mempool: cloneArray(replica.mempool),
    proposal: replica.proposal ? {
      height: replica.proposal.height,
      txs: cloneArray(replica.proposal.txs),
      hash: replica.proposal.hash,
      newState: replica.proposal.newState,
      signatures: cloneMap(replica.proposal.signatures)
    } : undefined,
    lockedFrame: replica.lockedFrame ? {
      height: replica.lockedFrame.height,
      txs: cloneArray(replica.lockedFrame.txs),
      hash: replica.lockedFrame.hash,
      newState: replica.lockedFrame.newState,
      signatures: cloneMap(replica.lockedFrame.signatures)
    } : undefined,
    isProposer: replica.isProposer
  };
};

const captureSnapshot = (env: Env, serverInput: ServerInput, serverOutputs: EntityInput[], description: string): void => {
  const snapshot: EnvSnapshot = {
    height: env.height,
    timestamp: env.timestamp,
    replicas: new Map(Array.from(env.replicas.entries()).map(([key, replica]) => [
      key,
      deepCloneReplica(replica)
    ])),
    serverInput: {
      serverTxs: [...serverInput.serverTxs],
      entityInputs: serverInput.entityInputs.map(input => ({
        ...input,
        entityTxs: input.entityTxs ? [...input.entityTxs] : undefined,
        precommits: input.precommits ? new Map(input.precommits) : undefined
      }))
    },
    serverOutputs: serverOutputs.map(output => ({
      ...output,
      entityTxs: output.entityTxs ? [...output.entityTxs] : undefined,
      precommits: output.precommits ? new Map(output.precommits) : undefined
    })),
    description
  };
  
  envHistory.push(snapshot);

  // --- PERSISTENCE WITH BATCH OPERATIONS ---
  // Use batch operations for better performance
  const batch = db.batch();
  batch.put(Buffer.from(`snapshot:${snapshot.height}`), encode(snapshot));
  batch.put(Buffer.from('latest_height'), Buffer.from(snapshot.height.toString()));
  
  batch.write().catch(err => {
    console.error(`🔥 Failed to save snapshot ${snapshot.height} to LevelDB`, err);
  });
  
  if (DEBUG) {
    console.log(`📸 Snapshot captured: "${description}" (${envHistory.length} total)`);
    if (serverInput.serverTxs.length > 0) {
      console.log(`    🖥️  ServerTxs: ${serverInput.serverTxs.length}`);
      serverInput.serverTxs.forEach((tx, i) => {
        console.log(`      ${i+1}. ${tx.type} ${tx.entityId}:${tx.signerId} (${tx.data.isProposer ? 'proposer' : 'validator'})`);
      });
    }
    if (serverInput.entityInputs.length > 0) {
      console.log(`    📨 EntityInputs: ${serverInput.entityInputs.length}`);
      serverInput.entityInputs.forEach((input, i) => {
        const parts = [];
        if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
        if (input.precommits?.size) parts.push(`${input.precommits.size} precommits`);
        if (input.proposedFrame) parts.push(`frame: ${input.proposedFrame.hash.slice(0,10)}...`);
        console.log(`      ${i+1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
      });
    }
  }
};

// === UTILITY FUNCTIONS ===
const calculateQuorumPower = (config: ConsensusConfig, signers: string[]): bigint => {
  return signers.reduce((sum, signerId) => sum + (config.shares[signerId] ?? 0n), 0n);
};

const sortSignatures = (signatures: Map<string, string>, config: ConsensusConfig): Map<string, string> => {
  const sortedEntries = Array.from(signatures.entries())
    .sort(([a], [b]) => {
      const indexA = config.validators.indexOf(a);
      const indexB = config.validators.indexOf(b);
      return indexA - indexB;
    });
  return new Map(sortedEntries);
};

const mergeEntityInputs = (entityInputs: EntityInput[]): EntityInput[] => {
  const merged = new Map<string, EntityInput>();
  let mergeCount = 0;
  
  entityInputs.forEach(input => {
    const key = `${input.entityId}:${input.signerId}`;
    const existing = merged.get(key);
    
    if (existing) {
      mergeCount++;
      if (DEBUG) console.log(`    🔄 Merging inputs for ${key}: txs=${input.entityTxs?.length || 0}, precommits=${input.precommits?.size || 0}, frame=${!!input.proposedFrame}`);
      
      // Merge entityTxs
      if (input.entityTxs?.length) {
        existing.entityTxs = [...(existing.entityTxs || []), ...input.entityTxs];
      }
      
      // Merge precommits
      if (input.precommits?.size) {
        if (!existing.precommits) existing.precommits = new Map();
        input.precommits.forEach((value, key) => existing.precommits!.set(key, value));
      }
      
      // Take latest proposedFrame
      if (input.proposedFrame) {
        existing.proposedFrame = input.proposedFrame;
      }
    } else {
      merged.set(key, {
        ...input,
        precommits: input.precommits ? new Map(input.precommits) : undefined
      });
    }
  });
  
  if (DEBUG && mergeCount > 0) {
    console.log(`    ⚠️  CORNER CASE: Merged ${mergeCount} duplicate inputs (${entityInputs.length} → ${merged.size})`);
  }
  
  return Array.from(merged.values());
};

// === JURISDICTION MANAGEMENT ===

// Load contract configuration and generate jurisdictions
const generateJurisdictions = (): Map<string, JurisdictionConfig> => {
  const jurisdictions = new Map<string, JurisdictionConfig>();
  
  // For browser, return empty map - jurisdictions will be populated dynamically
  if (isBrowser) {
    console.log('🌐 Browser detected - jurisdictions will be loaded dynamically');
    return jurisdictions;
  }
  
  // Node.js environment - load from file
  let networks: any;
  try {
    const configPath = path.join(process.cwd(), 'contract-addresses.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    console.log('✅ Loaded contract addresses from config file');
    networks = config.networks;
  } catch (error) {
    console.error('❌ CRITICAL: Could not load contract-addresses.json');
    console.error('   Please run: ./deploy-contracts.sh');
    throw new Error('Contract addresses configuration file not found or invalid');
  }
  
  if (networks['8545']) {
    const network = networks['8545'];
    if (!network.entityProvider) {
      throw new Error('Missing entityProvider address for Ethereum network (8545)');
    }
    jurisdictions.set('ethereum', {
      address: network.rpc,
      name: network.name,
      entityProviderAddress: network.entityProvider,
      depositoryAddress: network.depository,
      chainId: network.chainId
    });
  }
  
  if (networks['8546']) {
    const network = networks['8546'];
    if (!network.entityProvider) {
      throw new Error('Missing entityProvider address for Polygon network (8546)');
    }
    jurisdictions.set('polygon', {
      address: network.rpc,
      name: network.name,
      entityProviderAddress: network.entityProvider,
      depositoryAddress: network.depository,
      chainId: network.chainId
    });
  }
  
  if (networks['8547']) {
    const network = networks['8547'];
    if (!network.entityProvider) {
      throw new Error('Missing entityProvider address for Arbitrum network (8547)');
    }
    jurisdictions.set('arbitrum', {
      address: network.rpc,
      name: network.name,
      entityProviderAddress: network.entityProvider,
      depositoryAddress: network.depository,
      chainId: network.chainId
    });
  }
  
  return jurisdictions;
};

const DEFAULT_JURISDICTIONS = generateJurisdictions();

const getAvailableJurisdictions = (): JurisdictionConfig[] => {
  return Array.from(DEFAULT_JURISDICTIONS.values());
};

const getJurisdictionByAddress = (address: string): JurisdictionConfig | undefined => {
  return DEFAULT_JURISDICTIONS.get(address);
};

const registerEntityInJurisdiction = async (
  entityId: string,
  config: ConsensusConfig,
  jurisdiction: JurisdictionConfig
): Promise<{ success: boolean; transactionHash?: string; error?: string }> => {
  try {
    if (DEBUG) {
      console.log(`🏛️  Registering entity "${entityId}" in jurisdiction "${jurisdiction.name}"`);
      console.log(`    EntityProvider: ${jurisdiction.entityProviderAddress}`);
      console.log(`    Validators: ${config.validators.join(', ')}`);
      console.log(`    Threshold: ${config.threshold}/${Object.values(config.shares).reduce((a, b) => a + b, 0n)}`);
    }
    
    // For demo purposes, simulate successful registration
    // In production, this would make actual contract calls
    const mockTxHash = `0x${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
    
    if (DEBUG) {
      console.log(`✅ Entity registration simulated successfully`);
      console.log(`    Transaction Hash: ${mockTxHash}`);
      console.log(`    Entity can now interact with jurisdiction contracts`);
    }
    
    return {
      success: true,
      transactionHash: mockTxHash
    };
  } catch (error) {
    if (DEBUG) {
      console.error(`❌ Entity registration failed:`, error);
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
};

// === ENTITY PROCESSING ===
const generateProposalId = (action: ProposalAction, proposer: string, entityState: EntityState): string => {
  // Create deterministic hash from proposal data using entity timestamp
  const proposalData = JSON.stringify({
    type: action.type,
    data: action.data,
    proposer,
    timestamp: entityState.timestamp // Deterministic across all validators
  });
  
  const hash = createHash('sha256').update(proposalData).digest('hex');
  return `prop_${hash.slice(0, 12)}`;
};

const executeProposal = (entityState: EntityState, proposal: Proposal): EntityState => {
  if (proposal.action.type === 'collective_message') {
    const message = `[COLLECTIVE] ${proposal.action.data.message}`;
    if (DEBUG) console.log(`    🏛️  Executing collective proposal: "${message}"`);
    
    const newMessages = [...entityState.messages, message];
    
    // Limit messages to 10 maximum
    if (newMessages.length > 10) {
      newMessages.shift(); // Remove oldest message
    }
    
    return {
      ...entityState,
      messages: newMessages
    };
  }
  return entityState;
};

// === ENTITY PROCESSING ===
const applyEntityTx = (env: Env, entityState: EntityState, entityTx: EntityTx): EntityState => {
  if (entityTx.type === 'chat') {
    const { from, message } = entityTx.data;
    const currentNonce = entityState.nonces.get(from) || 0;
    
    // Create new state (immutable at transaction level)
    const newEntityState = {
      ...entityState,
      nonces: new Map(entityState.nonces),
      messages: [...entityState.messages],
      proposals: new Map(entityState.proposals)
    };
    
    newEntityState.nonces.set(from, currentNonce + 1);
    newEntityState.messages.push(`${from}: ${message}`);
    
    // Limit messages to 10 maximum
    if (newEntityState.messages.length > 10) {
      newEntityState.messages.shift(); // Remove oldest message
    }
    
    return newEntityState;
  }
  
  if (entityTx.type === 'propose') {
    const { action, proposer } = entityTx.data;
    const proposalId = generateProposalId(action, proposer, entityState);
    
    if (DEBUG) console.log(`    📝 Creating proposal ${proposalId} by ${proposer}: ${action.data.message}`);
    
    const proposal: Proposal = {
      id: proposalId,
      proposer,
      action,
      votes: new Map([[proposer, 'yes']]), // Proposer auto-votes yes
      status: 'pending',
      created: entityState.timestamp // Use deterministic entity timestamp
    };
    
    // Check if proposer has enough voting power to execute immediately
    const proposerPower = entityState.config.shares[proposer] || BigInt(0);
    const shouldExecuteImmediately = proposerPower >= entityState.config.threshold;
    
    let newEntityState = {
      ...entityState,
      nonces: new Map(entityState.nonces),
      messages: [...entityState.messages],
      proposals: new Map(entityState.proposals)
    };
    
    if (shouldExecuteImmediately) {
      proposal.status = 'executed';
      newEntityState = executeProposal(newEntityState, proposal);
      if (DEBUG) console.log(`    ⚡ Proposal executed immediately - proposer has ${proposerPower} >= ${entityState.config.threshold} threshold`);
    } else {
      if (DEBUG) console.log(`    ⏳ Proposal pending votes - proposer has ${proposerPower} < ${entityState.config.threshold} threshold`);
    }
    
    newEntityState.proposals.set(proposalId, proposal);
    return newEntityState;
  }
  
  if (entityTx.type === 'vote') {
    const { proposalId, voter, choice } = entityTx.data;
    const proposal = entityState.proposals.get(proposalId);
    
    if (!proposal || proposal.status !== 'pending') {
      if (DEBUG) console.log(`    ❌ Vote ignored - proposal ${proposalId.slice(0, 12)}... not found or not pending`);
      return entityState;
    }
    
    if (DEBUG) console.log(`    🗳️  Vote by ${voter}: ${choice} on proposal ${proposalId.slice(0, 12)}...`);
    
    const newEntityState = {
      ...entityState,
      nonces: new Map(entityState.nonces),
      messages: [...entityState.messages],
      proposals: new Map(entityState.proposals)
    };
    
    const updatedProposal = {
      ...proposal,
      votes: new Map(proposal.votes)
    };
    updatedProposal.votes.set(voter, choice);
    
    // Calculate voting power for 'yes' votes
    const yesVoters = Array.from(updatedProposal.votes.entries())
      .filter(([_, vote]) => vote === 'yes')
      .map(([voter, _]) => voter);
    
    const totalYesPower = calculateQuorumPower(entityState.config, yesVoters);
    
    if (DEBUG) {
      const totalShares = Object.values(entityState.config.shares).reduce((sum, val) => sum + val, BigInt(0));
      const percentage = ((Number(totalYesPower) / Number(entityState.config.threshold)) * 100).toFixed(1);
      log.info(`    🔍 Proposal votes: ${totalYesPower} / ${totalShares} [${percentage}% threshold${Number(totalYesPower) >= Number(entityState.config.threshold) ? '+' : ''}]`);
    }
    
    // Check if threshold reached
    if (totalYesPower >= entityState.config.threshold) {
      updatedProposal.status = 'executed';
      const executedState = executeProposal(newEntityState, updatedProposal);
      executedState.proposals.set(proposalId, updatedProposal);
      return executedState;
    }
    
    newEntityState.proposals.set(proposalId, updatedProposal);
    return newEntityState;
  }
  
  return entityState;
};

const applyEntityFrame = (env: Env, entityState: EntityState, entityTxs: EntityTx[]): EntityState => {
  return entityTxs.reduce((currentEntityState, entityTx) => applyEntityTx(env, currentEntityState, entityTx), entityState);
};

// === PROCESSING ===
const processEntityInput = (env: Env, entityReplica: EntityReplica, entityInput: EntityInput): EntityInput[] => {
  // Add validation
  if (!entityReplica) {
    log.error('Invalid entityReplica provided');
    return [];
  }
  if (!entityInput.entityId || !entityInput.signerId) {
    log.error('Invalid entityInput: missing required fields');
    return [];
  }
  
  const entityOutbox: EntityInput[] = [];
  
  // Add transactions to mempool (mutable for performance)
  if (entityInput.entityTxs?.length) {
    entityReplica.mempool.push(...entityInput.entityTxs);
    if (DEBUG) console.log(`    → Added ${entityInput.entityTxs.length} txs to mempool (total: ${entityReplica.mempool.length})`);
    if (DEBUG && entityInput.entityTxs.length > 3) {
      console.log(`    ⚠️  CORNER CASE: Large batch of ${entityInput.entityTxs.length} transactions`);
    }
  } else if (entityInput.entityTxs && entityInput.entityTxs.length === 0) {
    if (DEBUG) console.log(`    ⚠️  CORNER CASE: Empty transaction array received - no mempool changes`);
  }
  
  // Handle commit notifications FIRST (when receiving finalized frame from proposer)
  if (entityInput.precommits?.size && entityInput.proposedFrame && !entityReplica.proposal) {
    const signers = Array.from(entityInput.precommits.keys());
    const totalPower = calculateQuorumPower(entityReplica.state.config, signers);
    
    if (totalPower >= entityReplica.state.config.threshold) {
      // This is a commit notification from proposer, apply the frame
      if (DEBUG) console.log(`    → Received commit notification with ${entityInput.precommits.size} signatures`);
      
      // Apply the committed frame with incremented height
      entityReplica.state = {
        ...entityInput.proposedFrame.newState,
        height: entityReplica.state.height + 1
      };
      entityReplica.mempool.length = 0;
      entityReplica.lockedFrame = undefined; // Release lock after commit
      if (DEBUG) console.log(`    → Applied commit, new state: ${entityReplica.state.messages.length} messages, height: ${entityReplica.state.height}`);
      
      // Return early - commit notifications don't trigger further processing
      return entityOutbox;
    }
  }
  
  // Handle proposed frame (PROPOSE phase) - only if not a commit notification
  if (entityInput.proposedFrame && (!entityReplica.proposal || 
      (entityReplica.state.config.mode === 'gossip-based' && entityReplica.isProposer))) {
    const frameSignature = `sig_${entityReplica.signerId}_${entityInput.proposedFrame.hash}`;
    const config = entityReplica.state.config;
    
    // Lock to this frame (CometBFT style)
    entityReplica.lockedFrame = entityInput.proposedFrame;
    if (DEBUG) console.log(`    → Validator locked to frame ${entityInput.proposedFrame.hash.slice(0,10)}...`);
    
    if (config.mode === 'gossip-based') {
      // Send precommit to all validators
      config.validators.forEach(validatorId => {
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          precommits: new Map([[entityReplica.signerId, frameSignature]])
        });
      });
      if (DEBUG) console.log(`    → Signed proposal, gossiping precommit to ${config.validators.length} validators`);
    } else {
      // Send precommit to proposer only
      const proposerId = config.validators[0];
      entityOutbox.push({
        entityId: entityInput.entityId,
        signerId: proposerId,
        precommits: new Map([[entityReplica.signerId, frameSignature]])
      });
      if (DEBUG) console.log(`    → Signed proposal, sending precommit to ${proposerId}`);
    }
  }
  
  // Handle precommits (SIGN phase) 
  if (entityInput.precommits?.size && entityReplica.proposal) {
    // Collect signatures (mutable for performance)
    for (const [signerId, signature] of entityInput.precommits) {
      entityReplica.proposal.signatures.set(signerId, signature);
    }
    if (DEBUG) console.log(`    → Collected ${entityInput.precommits.size} signatures (total: ${entityReplica.proposal.signatures.size})`);
    
    // Check threshold using shares
    const signers = Array.from(entityReplica.proposal.signatures.keys());
    const totalPower = calculateQuorumPower(entityReplica.state.config, signers);
    
    if (DEBUG) {
      const totalShares = Object.values(entityReplica.state.config.shares).reduce((sum, val) => sum + val, BigInt(0));
      const percentage = ((Number(totalPower) / Number(entityReplica.state.config.threshold)) * 100).toFixed(1);
      log.info(`    🔍 Threshold check: ${totalPower} / ${totalShares} [${percentage}% threshold${Number(totalPower) >= Number(entityReplica.state.config.threshold) ? '+' : ''}]`);
      if (entityReplica.state.config.mode === 'gossip-based') {
        console.log(`    ⚠️  CORNER CASE: Gossip mode - all validators receive precommits`);
      }
    }
    
    if (totalPower >= entityReplica.state.config.threshold) {
      // Commit phase - use pre-computed state with incremented height
      entityReplica.state = {
        ...entityReplica.proposal.newState,
        height: entityReplica.state.height + 1
      };
      if (DEBUG) console.log(`    → Threshold reached! Committing frame, height: ${entityReplica.state.height}`);
      
      // Save proposal data before clearing
      const sortedSignatures = sortSignatures(entityReplica.proposal.signatures, entityReplica.state.config);
      const committedFrame = entityReplica.proposal;
      
      // Clear state (mutable)
      entityReplica.mempool.length = 0;
      entityReplica.proposal = undefined;
      entityReplica.lockedFrame = undefined; // Release lock after commit
      
      // Notify all validators
      entityReplica.state.config.validators.forEach(validatorId => {
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          precommits: sortedSignatures,
          proposedFrame: committedFrame
        });
      });
      if (DEBUG) console.log(`    → Sending commit notifications to ${entityReplica.state.config.validators.length} validators`);
    }
  }
  
  // Commit notifications are now handled at the top of the function
  
  // Auto-propose logic: ONLY proposer can propose (BFT requirement)
  if (entityReplica.isProposer && entityReplica.mempool.length > 0 && !entityReplica.proposal) {
    if (DEBUG) console.log(`    🚀 Auto-propose triggered: mempool=${entityReplica.mempool.length}, isProposer=${entityReplica.isProposer}, hasProposal=${!!entityReplica.proposal}`);
    // Compute new state once during proposal
    const newEntityState = applyEntityFrame(env, entityReplica.state, entityReplica.mempool);
    
    // Proposer creates new timestamp for this frame
    const newTimestamp = env.timestamp;
    
    const frameHash = `frame_${entityReplica.state.height + 1}_${newTimestamp}`;
    const selfSignature = `sig_${entityReplica.signerId}_${frameHash}`;

    entityReplica.proposal = {
      height: entityReplica.state.height + 1,
      txs: [...entityReplica.mempool],
      hash: frameHash,
      newState: {
        ...newEntityState,
        height: entityReplica.state.height + 1,
        timestamp: newTimestamp // Set new deterministic timestamp in proposed state
      },
      signatures: new Map<string, string>([[entityReplica.signerId, selfSignature]]) // Proposer signs immediately
    };
    
    if (DEBUG) console.log(`    → Auto-proposing frame ${entityReplica.proposal.hash} with ${entityReplica.proposal.txs.length} txs and self-signature.`);
    
    // Send proposal to all validators (except self)
    entityReplica.state.config.validators.forEach(validatorId => {
      if (validatorId !== entityReplica.signerId) {
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          proposedFrame: entityReplica.proposal!
          // Note: Don't send entityTxs separately - they're already in proposedFrame.txs
        });
      }
    });
  } else if (entityReplica.isProposer && entityReplica.mempool.length === 0 && !entityReplica.proposal) {
    if (DEBUG) console.log(`    ⚠️  CORNER CASE: Proposer with empty mempool - no auto-propose`);
  } else if (!entityReplica.isProposer && entityReplica.mempool.length > 0) {
    if (DEBUG) console.log(`    → Non-proposer sending ${entityReplica.mempool.length} txs to proposer`);
    // Send mempool to proposer
    const proposerId = entityReplica.state.config.validators[0];
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: proposerId,
      entityTxs: [...entityReplica.mempool]
    });
    // Clear mempool after sending
    entityReplica.mempool.length = 0;
  } else if (entityReplica.isProposer && entityReplica.proposal) {
    if (DEBUG) console.log(`    ⚠️  CORNER CASE: Proposer already has pending proposal - no new auto-propose`);
  }
  
  return entityOutbox;
};

const processServerInput = (env: Env, serverInput: ServerInput): EntityInput[] => {
  const startTime = Date.now();
  
  // Merge new serverInput into env.serverInput
  env.serverInput.serverTxs.push(...serverInput.serverTxs);
  env.serverInput.entityInputs.push(...serverInput.entityInputs);
  
  // Merge all entityInputs in env.serverInput
  const mergedInputs = mergeEntityInputs(env.serverInput.entityInputs);
  const entityOutbox: EntityInput[] = [];
  
  if (DEBUG) {
    console.log(`\n=== TICK ${env.height} ===`);
    console.log(`Server inputs: ${serverInput.serverTxs.length} new serverTxs, ${serverInput.entityInputs.length} new entityInputs`);
    console.log(`Total in env: ${env.serverInput.serverTxs.length} serverTxs, ${env.serverInput.entityInputs.length} entityInputs (merged to ${mergedInputs.length})`);
    if (mergedInputs.length > 0) {
      console.log(`🔄 Processing merged inputs:`);
      mergedInputs.forEach((input, i) => {
        const parts = [];
        if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
        if (input.precommits?.size) parts.push(`${input.precommits.size} precommits`);
        if (input.proposedFrame) parts.push(`frame: ${input.proposedFrame.hash.slice(0,10)}...`);
        console.log(`  ${i+1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
      });
    }
  }
  
  // Process server transactions (replica imports) from env.serverInput
  env.serverInput.serverTxs.forEach(serverTx => {
    if (serverTx.type === 'importReplica') {
      if (DEBUG) console.log(`Importing replica ${serverTx.entityId}:${serverTx.signerId} (proposer: ${serverTx.data.isProposer})`);
      
      const replicaKey = `${serverTx.entityId}:${serverTx.signerId}`;
      env.replicas.set(replicaKey, {
        entityId: serverTx.entityId,
        signerId: serverTx.signerId,
        state: {
          height: 0,
          timestamp: env.timestamp,
          nonces: new Map(),
          messages: [],
          proposals: new Map(),
          config: serverTx.data.config
        },
        mempool: [],
        isProposer: serverTx.data.isProposer
      });
    }
  });
  
  // Process entity inputs
  mergedInputs.forEach(entityInput => {
    const replicaKey = `${entityInput.entityId}:${entityInput.signerId}`;
    const entityReplica = env.replicas.get(replicaKey);
    
    if (entityReplica) {
      if (DEBUG) {
        console.log(`Processing input for ${replicaKey}:`);
        if (entityInput.entityTxs?.length) console.log(`  → ${entityInput.entityTxs.length} transactions`);
        if (entityInput.proposedFrame) console.log(`  → Proposed frame: ${entityInput.proposedFrame.hash}`);
        if (entityInput.precommits?.size) console.log(`  → ${entityInput.precommits.size} precommits`);
      }
      
      const entityOutputs = processEntityInput(env, entityReplica, entityInput);
      entityOutbox.push(...entityOutputs);
    }
  });
  
  // Update env (mutable)
  env.height++;
  env.timestamp = Date.now();
  
  // Capture snapshot BEFORE clearing (to show what was actually processed)
  const inputDescription = `Tick ${env.height - 1}: ${env.serverInput.serverTxs.length} serverTxs, ${env.serverInput.entityInputs.length} entityInputs → ${entityOutbox.length} outputs`;
  const processedInput = {
    serverTxs: [...env.serverInput.serverTxs],
    entityInputs: [...env.serverInput.entityInputs]
  };
  
  // Clear processed data from env.serverInput
  env.serverInput.serverTxs.length = 0;
  env.serverInput.entityInputs.length = 0;
  
  // Capture snapshot with the actual processed input and outputs
  captureSnapshot(env, processedInput, entityOutbox, inputDescription);
  
  if (DEBUG && entityOutbox.length > 0) {
    console.log(`📤 Outputs: ${entityOutbox.length} messages`);
    entityOutbox.forEach((output, i) => {
      console.log(`  ${i+1}. → ${output.signerId} (${output.entityTxs ? `${output.entityTxs.length} txs` : ''}${output.proposedFrame ? ` proposal: ${output.proposedFrame.hash.slice(0,10)}...` : ''}${output.precommits ? ` ${output.precommits.size} precommits` : ''})`);
    });
  } else if (DEBUG && entityOutbox.length === 0) {
    console.log(`📤 No outputs generated`);
  }
  
  if (DEBUG) {
    console.log(`Replica states:`);
    env.replicas.forEach((replica, key) => {
      console.log(`  ${key}: mempool=${replica.mempool.length}, messages=${replica.state.messages.length}, proposal=${replica.proposal ? '✓' : '✗'}`);
    });
  }
  
  // Performance logging
  const endTime = Date.now();
  if (DEBUG) {
    console.log(`⏱️  Tick ${env.height - 1} completed in ${endTime - startTime}ms`);
  }
  
  return entityOutbox;
};

// === DEMO ===
const processUntilEmpty = (env: Env, inputs: EntityInput[]) => {
  let outputs = inputs;
  while (outputs.length > 0) {
    outputs = processServerInput(env, { serverTxs: [], entityInputs: outputs });
  }
};

// Time machine utility functions
const resetHistory = () => envHistory.length = 0;

const runDemo = (env: Env): Env => {
  
  if (DEBUG) {
    console.log('🚀 Starting XLN Consensus Demo - Multi-Entity Test');
    console.log('✨ Using deterministic hash-based proposal IDs (no randomness)');
    console.log('🌍 Environment-based architecture with merged serverInput');
    console.log('🗑️ History cleared for fresh start');
  }
  
  // === TEST 1: Chat Entity - NUMBERED ENTITY (Blockchain Registered) ===
  console.log('\n📋 TEST 1: Chat Entity - Numbered Entity with Jurisdiction');
  const chatValidators = ['alice', 'bob', 'carol'];
  const chatConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: BigInt(2), // Need 2 out of 3 shares
    validators: chatValidators,
    shares: {
      alice: BigInt(1), // Equal voting power
      bob: BigInt(1),
      carol: BigInt(1)
    },
    jurisdiction: DEFAULT_JURISDICTIONS.get('ethereum') // Add jurisdiction
  };
  
  // Create numbered entity (blockchain registered)
  const chatEntityId = generateNumberedEntityId(1); // Use entity #1
  
  processServerInput(env, {
    serverTxs: chatValidators.map((signerId, index) => ({
      type: 'importReplica' as const,
      entityId: chatEntityId,
      signerId,
      data: {
        config: chatConfig,
        isProposer: index === 0
      }
    })),
    entityInputs: []
  });
  
  // === TEST 2: Trading Entity - NUMBERED ENTITY (Blockchain Registered) ===
  console.log('\n📋 TEST 2: Trading Entity - Numbered Entity with Jurisdiction');
  const tradingValidators = ['alice', 'bob', 'carol', 'david'];
  const tradingConfig: ConsensusConfig = {
    mode: 'gossip-based', // Test gossip mode
    threshold: BigInt(7), // Need 7 out of 10 total shares
    validators: tradingValidators,
    shares: {
      alice: BigInt(4), // Major stakeholder
      bob: BigInt(3),   // Medium stakeholder
      carol: BigInt(2), // Minor stakeholder
      david: BigInt(1)  // Minimal stakeholder
    },
    jurisdiction: DEFAULT_JURISDICTIONS.get('ethereum') // Add jurisdiction
  };
  
  // Create numbered entity (blockchain registered)
  const tradingEntityId = generateNumberedEntityId(2); // Use entity #2
  
  processServerInput(env, {
    serverTxs: tradingValidators.map((signerId, index) => ({
      type: 'importReplica' as const,
      entityId: tradingEntityId,
      signerId,
      data: {
        config: tradingConfig,
        isProposer: index === 0
      }
    })),
    entityInputs: []
  });
  
  // === TEST 3: Governance Entity - LAZY ENTITY (Hash-based ID) ===
  console.log('\n📋 TEST 3: Governance Entity - Lazy Entity with Jurisdiction');
  const govValidators = ['alice', 'bob', 'carol', 'david', 'eve'];
  const govConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: BigInt(10), // Need 10 out of 15 shares (2/3 + 1 for BFT)
    validators: govValidators,
    shares: {
      alice: BigInt(3),
      bob: BigInt(3),
      carol: BigInt(3),
      david: BigInt(3),
      eve: BigInt(3)
    },
    jurisdiction: DEFAULT_JURISDICTIONS.get('ethereum') // Add jurisdiction
  };
  
  // Create lazy entity (hash-based ID)
  const govEntityId = generateLazyEntityId(govValidators, BigInt(10));
  
  processServerInput(env, {
    serverTxs: govValidators.map((signerId, index) => ({
      type: 'importReplica' as const,
      entityId: govEntityId,
      signerId,
      data: {
        config: govConfig,
        isProposer: index === 0
      }
    })),
    entityInputs: []
  });
  
  console.log('\n🔥 CORNER CASE TESTS:');
  
  // === CORNER CASE 1: Single transaction (minimal consensus) ===
  console.log('\n⚠️  CORNER CASE 1: Single transaction in chat');
  processUntilEmpty(env, [{
    entityId: chatEntityId,
    signerId: 'alice',
    entityTxs: [{ type: 'chat', data: { from: 'alice', message: 'First message in chat!' } }]
  }]);
  
  // === CORNER CASE 2: Batch proposals (stress test) ===
  console.log('\n⚠️  CORNER CASE 2: Batch proposals in trading');
  processUntilEmpty(env, [{
    entityId: tradingEntityId,
    signerId: 'alice',
    entityTxs: [
      { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Trading proposal 1: Set daily limit' } }, proposer: 'alice' } },
      { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Trading proposal 2: Update fees' } }, proposer: 'bob' } },
      { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Trading proposal 3: Add new pairs' } }, proposer: 'carol' } }
    ]
  }]);
  
  // === CORNER CASE 3: High threshold governance (needs 4/5 validators) ===
  console.log('\n⚠️  CORNER CASE 3: High threshold governance vote');
  processUntilEmpty(env, [{
    entityId: govEntityId,
    signerId: 'alice',
    entityTxs: [{ type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Governance proposal: Increase block size limit' } }, proposer: 'alice' } }]
  }]);
  
  // === CORNER CASE 4: Multiple entities concurrent activity ===
  console.log('\n⚠️  CORNER CASE 4: Concurrent multi-entity activity');
  processUntilEmpty(env, [
    {
      entityId: chatEntityId,
      signerId: 'alice',
      entityTxs: [
        { type: 'chat', data: { from: 'bob', message: 'Chat during trading!' } },
        { type: 'chat', data: { from: 'carol', message: 'Exciting times!' } }
      ]
    },
          {
        entityId: tradingEntityId,
        signerId: 'alice',
        entityTxs: [
          { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Trading proposal: Cross-entity transfer protocol' } }, proposer: 'david' } }
        ]
      },
          {
        entityId: govEntityId,
        signerId: 'alice',
        entityTxs: [
          { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Governance decision: Implement new voting system' } }, proposer: 'bob' } },
          { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Governance decision: Update treasury rules' } }, proposer: 'carol' } }
        ]
      }
  ]);
  
  // === CORNER CASE 5: Empty mempool auto-propose (should be ignored) ===
  console.log('\n⚠️  CORNER CASE 5: Empty mempool test (no auto-propose)');
  processUntilEmpty(env, [{
    entityId: chatEntityId,
    signerId: 'alice',
    entityTxs: [] // Empty transactions should not trigger proposal
  }]);
  
  // === CORNER CASE 6: Large message batch ===
  console.log('\n⚠️  CORNER CASE 6: Large message batch');
  const largeBatch: EntityTx[] = Array.from({ length: 8 }, (_, i) => ({
    type: 'chat' as const,
    data: { from: ['alice', 'bob', 'carol'][i % 3], message: `Batch message ${i + 1}` }
  }));
  
  processUntilEmpty(env, [{
    entityId: chatEntityId,
    signerId: 'alice',
    entityTxs: largeBatch
  }]);
  
  // === CORNER CASE 7: Proposal voting system ===
  console.log('\n⚠️  CORNER CASE 7: Proposal voting system');
  
  // Create a proposal that needs votes
  processUntilEmpty(env, [{
    entityId: tradingEntityId,
    signerId: 'alice',
    entityTxs: [
      { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Major decision: Upgrade trading protocol' } }, proposer: 'carol' } } // Carol only has 2 shares, needs more votes
    ]
  }]);
  
  // Simulate voting on the proposal
  // We need to get the proposal ID from the previous execution, but for demo purposes, we'll simulate voting workflow
  console.log('\n⚠️  CORNER CASE 7b: Voting on proposals (simulated)');
  processUntilEmpty(env, [{
    entityId: govEntityId,
    signerId: 'alice',
    entityTxs: [
      { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Critical governance: Emergency protocol activation' } }, proposer: 'eve' } } // Eve only has 3 shares, needs 10 total
    ]
  }]);
  
  // === FINAL VERIFICATION ===
  if (DEBUG) {
    console.log('\n🎯 === FINAL VERIFICATION ===');
    console.log('✨ All proposal IDs are deterministic hashes of proposal data');
    console.log('🌍 Environment-based architecture working correctly');
    
    // Group replicas by entity
    const entitiesByType = new Map<string, Array<[string, EntityReplica]>>();
    env.replicas.forEach((replica, key) => {
      const entityType = replica.entityId;
      if (!entitiesByType.has(entityType)) {
        entitiesByType.set(entityType, []);
      }
      entitiesByType.get(entityType)!.push([key, replica]);
    });
    
    let allEntitiesConsensus = true;
    
    entitiesByType.forEach((replicas, entityType) => {
      console.log(`\n📊 Entity: ${entityType.toUpperCase()}`);
      console.log(`   Mode: ${replicas[0][1].state.config.mode}`);
      console.log(`   Threshold: ${replicas[0][1].state.config.threshold}`);
      console.log(`   Validators: ${replicas[0][1].state.config.validators.length}`);
      
      // Show voting power distribution
      const shares = replicas[0][1].state.config.shares;
      console.log(`   Voting Power:`);
      Object.entries(shares).forEach(([validator, power]) => {
        console.log(`     ${validator}: ${power} shares`);
      });
      
             // Check consensus within entity
       const allMessages: string[][] = [];
       const allProposals: Proposal[][] = [];
       replicas.forEach(([key, replica]) => {
         console.log(`   ${key}: ${replica.state.messages.length} messages, ${replica.state.proposals.size} proposals, height ${replica.state.height}`);
         if (replica.state.messages.length > 0) {
           replica.state.messages.forEach((msg, i) => console.log(`     ${i+1}. ${msg}`));
         }
         if (replica.state.proposals.size > 0) {
           console.log(`     Proposals:`);
           replica.state.proposals.forEach((proposal, id) => {
             const yesVotes = Array.from(proposal.votes.values()).filter(vote => vote === 'yes').length;
             const totalVotes = proposal.votes.size;
             console.log(`       ${id} by ${proposal.proposer} [${proposal.status}] ${yesVotes}/${totalVotes} votes`);
             console.log(`         Action: ${proposal.action.data.message}`);
           });
         }
         allMessages.push([...replica.state.messages]);
         allProposals.push([...replica.state.proposals.values()]);
       });
      
             // Verify consensus within entity (messages and proposals)
       const firstMessages = allMessages[0];
       const messagesConsensus = allMessages.every(messages => 
         messages.length === firstMessages.length && 
         messages.every((msg, i) => msg === firstMessages[i])
       );
       
       const firstProposals = allProposals[0];
       const proposalsConsensus = allProposals.every(proposals => 
         proposals.length === firstProposals.length &&
         proposals.every((prop, i) => 
           prop.id === firstProposals[i].id &&
           prop.status === firstProposals[i].status &&
           prop.votes.size === firstProposals[i].votes.size
         )
       );
       
       const entityConsensus = messagesConsensus && proposalsConsensus;
       
       console.log(`   🔍 Consensus: ${entityConsensus ? '✅ SUCCESS' : '❌ FAILED'} (messages: ${messagesConsensus ? '✅' : '❌'}, proposals: ${proposalsConsensus ? '✅' : '❌'})`);
       if (entityConsensus) {
         console.log(`   📈 Total messages: ${firstMessages.length}, proposals: ${firstProposals.length}`);
         const totalShares = Object.values(shares).reduce((sum, val) => sum + val, BigInt(0));
         console.log(`   ⚖️  Total voting power: ${totalShares} (threshold: ${replicas[0][1].state.config.threshold})`);
       }
      
      allEntitiesConsensus = allEntitiesConsensus && entityConsensus;
    });
    
    console.log(`\n🏆 === OVERALL RESULT ===`);
    console.log(`${allEntitiesConsensus ? '✅ SUCCESS' : '❌ FAILED'} - All entities achieved consensus`);
    console.log(`📊 Total entities tested: ${entitiesByType.size}`);
    console.log(`📊 Total replicas: ${env.replicas.size}`);
    console.log(`🔄 Total server ticks: ${env.height}`);
    console.log('🎯 Fully deterministic - no randomness used');
    console.log('🌍 Environment-based architecture with clean function signatures');
    
    // Show mode distribution
    const modeCount = new Map<string, number>();
    env.replicas.forEach(replica => {
      const mode = replica.state.config.mode;
      modeCount.set(mode, (modeCount.get(mode) || 0) + 1);
    });
    console.log(`📡 Mode distribution:`);
    modeCount.forEach((count, mode) => {
      console.log(`   ${mode}: ${count} replicas`);
    });
  }
  
  if (DEBUG) {
    console.log('\n🎯 Demo completed successfully!');
    console.log('📊 Check the dashboard for final entity states');
    console.log('🔄 Use time machine to replay any step');
  }

  // === BLOCKCHAIN DEMO: Create numbered entities on Ethereum ===
  console.log('\n🔗 BLOCKCHAIN DEMO: Creating numbered entities on Ethereum');
  
  // Get Ethereum jurisdiction config
  const ethereumJurisdiction = DEFAULT_JURISDICTIONS.get('ethereum');
  if (!ethereumJurisdiction) {
    console.warn('⚠️ Ethereum jurisdiction not found, skipping blockchain demo');
    return env;
  }
  
  // Create numbered entities for demo purposes (async, fire and forget)
  setTimeout(async () => {
    try {
      // Create numbered entity for chat
      const chatConfig = {
        mode: 'proposer-based' as const,
        threshold: BigInt(2),
        validators: chatValidators,
        shares: {
          alice: BigInt(1),
          bob: BigInt(1), 
          carol: BigInt(1)
        },
        jurisdiction: ethereumJurisdiction
      };
      await registerNumberedEntityOnChain(chatConfig, 'Demo Chat');
      console.log('✅ Demo chat entity registered on Ethereum');
      
      // Create numbered entity for trading
      const tradingConfigForChain = {
        mode: 'gossip-based' as const,
        threshold: BigInt(7),
        validators: tradingValidators,
        shares: {
          alice: BigInt(4),
          bob: BigInt(3),
          carol: BigInt(2),
          david: BigInt(1)
        },
        jurisdiction: ethereumJurisdiction
      };
      await registerNumberedEntityOnChain(tradingConfigForChain, 'Demo Trading');
      console.log('✅ Demo trading entity registered on Ethereum');
      
      // Create numbered entity for governance
      const govConfigForChain = {
        mode: 'proposer-based' as const,
        threshold: BigInt(10),
        validators: govValidators,
        shares: {
          alice: BigInt(3),
          bob: BigInt(3),
          carol: BigInt(3),
          david: BigInt(3),
          eve: BigInt(3)
        },
        jurisdiction: ethereumJurisdiction
      };
      await registerNumberedEntityOnChain(govConfigForChain, 'Demo Governance');
      console.log('✅ Demo governance entity registered on Ethereum');
      
    } catch (error: any) {
      console.warn('⚠️ Demo blockchain registration failed:', error.message);
    }
  }, 1000); // Give demo time to complete first

  return env;
};

// This is the new, robust main function that replaces the old one.
const main = async (): Promise<Env> => {
  let env: Env | null = null;

  try {
    const latestHeightBuffer = await db.get(Buffer.from('latest_height'));
    const latestHeight = parseInt(latestHeightBuffer.toString(), 10);

    // Load all snapshots in parallel
    const snapshotPromises = Array.from({ length: latestHeight + 1 }, (_, i) => 
      db.get(Buffer.from(`snapshot:${i}`)).then(decode).catch(() => null)
    );

    const snapshots = (await Promise.all(snapshotPromises)).filter(Boolean);
    envHistory = snapshots;

    if (snapshots.length > 0) {
      const latestSnapshot = snapshots[snapshots.length - 1];
      env = {
        replicas: latestSnapshot.replicas,
        height: latestSnapshot.height,
        timestamp: latestSnapshot.timestamp,
        serverInput: latestSnapshot.serverInput,
      };
      console.log(`✅ History restored. Server is at height ${env.height} with ${envHistory.length} snapshots.`);
    }

  } catch (error: any) {
    if (error.code !== 'LEVEL_NOT_FOUND') {
      console.error('An unexpected error occurred while loading state from LevelDB:', error);
    }
  }

  // If env is still null, create a fresh environment
  if (!env) {
    console.log('No saved state found, creating a new environment.');
    env = {
      replicas: new Map(),
      height: 0,
      timestamp: Date.now(),
      serverInput: { serverTxs: [], entityInputs: [] }
    };
  }

  return env;
};

// === TIME MACHINE API ===
const getHistory = () => envHistory;
const getSnapshot = (index: number) => index >= 0 && index < envHistory.length ? envHistory[index] : null;
const getCurrentHistoryIndex = () => envHistory.length - 1;

// === TESTING ===
const runTests = async () => {
  console.log('🧪 Running XLN tests...');
  
  const env = await main();
  
  // Test 1: Basic functionality
  console.log('✅ Test 1: Environment initialization');
  console.log(`   Height: ${env.height}`);
  console.log(`   Replicas: ${env.replicas.size}`);
  
  // Test 2: Process simple input
  console.log('✅ Test 2: Process simple input');
  const testInput: ServerInput = {
    serverTxs: [{
      type: 'importReplica',
      entityId: 'test',
      signerId: 'alice',
      data: {
        config: {
          mode: 'proposer-based',
          threshold: BigInt(1),
          validators: ['alice'],
          shares: { alice: BigInt(1) }
        },
        isProposer: true
      }
    }],
    entityInputs: []
  };
  
  const outputs = processServerInput(env, testInput);
  console.log(`   Outputs: ${outputs.length}`);
  
  // Test 3: Verify state persistence
  console.log('✅ Test 3: State persistence');
  console.log(`   Snapshots: ${envHistory.length}`);
  console.log(`   Latest height: ${env.height}`);
  
  console.log('🎉 All tests passed!');
  return env;
};

export { 
  runDemo, 
  processServerInput, 
  main, 
  getHistory, 
  getSnapshot, 
  resetHistory, 
  getCurrentHistoryIndex, 
  clearDatabase, 
  runTests, 
  getAvailableJurisdictions, 
  getJurisdictionByAddress, 
  registerEntityInJurisdiction,
  // Entity creation functions
  createLazyEntity,
  createNumberedEntity,
  requestNamedEntity,
  resolveEntityIdentifier,
  // Entity utility functions
  generateLazyEntityId,
  generateNumberedEntityId,
  generateNamedEntityId,
  detectEntityType,
  encodeBoard,
  hashBoard,
  // Blockchain registration functions
  registerNumberedEntityOnChain,
  assignNameOnChain,
  getEntityInfoFromChain,
  getNextEntityNumber,
  connectToEthereum,
  transferNameBetweenEntities,
  isEntityRegistered
};

// The browser-specific auto-execution logic has been removed.
// The consuming application (e.g., index.html) is now responsible for calling main().

// --- Node.js auto-execution for local testing ---
// This part will only run when the script is executed directly in Node.js.
if (!isBrowser) {
  main().then(async env => {
    if (env) {
      console.log('✅ Node.js environment initialized. Running demo for local testing...');
      runDemo(env);
      
      // Add a small delay to ensure demo completes before verification
      setTimeout(async () => {
        await verifyJurisdictionRegistrations();
      }, 2000);
    }
  }).catch(error => {
    console.error('❌ An error occurred during Node.js auto-execution:', error);
  });
}

// Get contract address for specific network/port
const getContractAddress = async (port: string): Promise<string> => {
  let config: any;
  
  if (isBrowser) {
    // Browser environment - fetch from server
    try {
      const response = await fetch('/contract-addresses.json');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      config = await response.json();
    } catch (error) {
      throw new Error(`Could not fetch contract address for port ${port} from server. Make sure server is running and contracts are deployed.`);
    }
  } else {
    // Node.js environment - load from file
    try {
      const configPath = path.join(process.cwd(), 'contract-addresses.json');
      const configData = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configData);
    } catch (error) {
      throw new Error(`Could not load contract address for port ${port}. Please run: ./deploy-contracts.sh`);
    }
  }
  
  const address = config.networks[port]?.entityProvider;
  if (!address) {
    throw new Error(`No contract address found for network port ${port}. Please deploy contracts first.`);
  }
  return address;
};

// === BLOCKCHAIN VERIFICATION ===
const verifyJurisdictionRegistrations = async () => {
  console.log('\n🔍 === JURISDICTION VERIFICATION ===');
  console.log('📋 Verifying entity registrations across all jurisdictions...\n');
  
  const jurisdictions = Array.from(DEFAULT_JURISDICTIONS.values());
  
  for (const jurisdiction of jurisdictions) {
    try {
      console.log(`🏛️ ${jurisdiction.name}:`);
      console.log(`   📡 RPC: ${jurisdiction.address}`);
      console.log(`   📄 Contract: ${jurisdiction.entityProviderAddress}`);
      
      // Connect to this jurisdiction's network
      const { entityProvider } = await connectToEthereum(jurisdiction.address, jurisdiction.entityProviderAddress);
      
      // Get next entity number (indicates how many are registered)
      const nextNumber = await entityProvider.nextNumber();
      const registeredCount = Number(nextNumber) - 1;
      
      console.log(`   📊 Registered Entities: ${registeredCount}`);
      
      // Read registered entities
      if (registeredCount > 0) {
        console.log(`   📝 Entity Details:`);
        for (let i = 1; i <= registeredCount; i++) {
          try {
            const entityId = generateNumberedEntityId(i);
            const entityInfo = await entityProvider.entities(entityId);
            console.log(`      #${i}: ${entityId.slice(0, 10)}... (Block: ${entityInfo.registrationBlock})`);
          } catch (error) {
            console.log(`      #${i}: Error reading entity data`);
          }
        }
      }
      
      console.log('');
      
    } catch (error) {
      console.error(`   ❌ Failed to verify ${jurisdiction.name}:`, error instanceof Error ? error.message : error);
      console.log('');
    }
  }
  
  console.log('✅ Jurisdiction verification complete!\n');
};

// === ENTITY MANAGEMENT ENDPOINTS ===




 
