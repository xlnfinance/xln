/**
 * XLN Type Definitions
 * All interfaces and type definitions used across the XLN system
 */

export interface JurisdictionConfig {
  address: string;
  name: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  chainId?: number;
}

export interface ConsensusConfig {
  mode: 'proposer-based' | 'gossip-based';
  threshold: bigint;
  validators: string[];
  shares: { [validatorId: string]: bigint };
  jurisdiction?: JurisdictionConfig;
}

export interface ServerInput {
  serverTxs: ServerTx[];
  entityInputs: EntityInput[];
}

export interface ServerTx {
  type: 'importReplica';
  entityId: string;
  signerId: string;
  data: {
    config: ConsensusConfig;
    isProposer: boolean;
  };
}

export interface EntityInput {
  entityId: string;
  signerId: string;
  entityTxs?: EntityTx[];
  precommits?: Map<string, string>; // signerId -> signature
  proposedFrame?: ProposedEntityFrame;
}

export interface Proposal {
  id: string; // hash of the proposal
  proposer: string;
  action: ProposalAction;
  votes: Map<string, 'yes' | 'no'>;
  status: 'pending' | 'executed' | 'rejected';
  created: number; // entity timestamp when proposal was created (deterministic)
}

export interface ProposalAction {
  type: 'collective_message';
  data: {
    message: string;
  };
}

export interface EntityTx {
  type: 'chat' | 'propose' | 'vote';
  data: any;
}

export interface EntityState {
  height: number;
  timestamp: number;
  nonces: Map<string, number>;
  messages: string[];
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;
}

export interface ProposedEntityFrame {
  height: number;
  txs: EntityTx[];
  hash: string;
  newState: EntityState;
  signatures: Map<string, string>; // signerId -> signature
}

export interface EntityReplica {
  entityId: string;
  signerId: string;
  state: EntityState;
  mempool: EntityTx[];
  proposal?: ProposedEntityFrame;
  lockedFrame?: ProposedEntityFrame; // Frame this validator is locked/precommitted to
  isProposer: boolean;
}

export interface Env {
  replicas: Map<string, EntityReplica>;
  height: number;
  timestamp: number;
  serverInput: ServerInput; // Persistent storage for merged inputs
  // Future: add database connections, config, utilities, etc.
}

export interface EnvSnapshot {
  height: number;
  timestamp: number;
  replicas: Map<string, EntityReplica>;
  serverInput: ServerInput;
  serverOutputs: EntityInput[];
  description: string;
}

// Entity types
export type EntityType = 'lazy' | 'numbered' | 'named';

// Constants
export const ENC = 'hex' as const; 

// === HANKO BYTES SYSTEM (Final Design) ===
export interface HankoBytes {
  packedSignatures: Buffer;  // Optimized: rsrsrs...vvv format
  noEntities: Buffer[];      // Entity IDs that failed to sign
  claims: HankoClaim[];      // Verification claims from primitive to complex
}

export interface HankoClaim {
  entityId: Buffer;          // Entity being verified
  entityIndexes: number[];   // Indexes into noEntities + yesEntities array
  weights: number[];         // Voting weights for each entity
  threshold: number;         // Required voting power
  expectedQuorumHash: Buffer; // Expected quorum hash for this entity
}

export interface HankoVerificationResult {
  valid: boolean;
  entityId: Buffer;
  signedHash: Buffer;
  yesEntities: Buffer[];
  noEntities: Buffer[];
  completionPercentage: number; // 0-100% completion
  errors?: string[];
}

export interface HankoMergeResult {
  merged: HankoBytes;
  addedSignatures: number;
  completionBefore: number;
  completionAfter: number;
  log: string[];
}

/**
 * Context for hanko verification
 */
export interface HankoContext {
  timestamp: number;
  blockNumber?: number;
  networkId?: number;
} 