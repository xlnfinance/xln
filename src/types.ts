/**
 * XLN Type Definitions
 * All interfaces and type definitions used across the XLN system
 */

import type { Profile } from './gossip.js';

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
  // TODO: refactor votes to use VoteData
  votes: Map<string, 'yes' | 'no' | 'abstain' | { choice: 'yes' | 'no' | 'abstain'; comment: string }>;
  status: 'pending' | 'executed' | 'rejected';
  created: number; // entity timestamp when proposal was created (deterministic)
}

export interface ProposalAction {
  type: 'collective_message';
  data: {
    message: string;
  };
}

export interface VoteData {
  proposalId: string;
  voter: string;
  choice: 'yes' | 'no' | 'abstain';
  comment?: string;
}

/**
 * Jurisdiction event data for j_event transactions
 * Flattened structure (no nested event object)
 */
export interface JurisdictionEventData {
  from: string;
  event: {
    type: string; // e.g. "reserveToReserve", "GovernanceEnabled"
    data: any;
  };
  observedAt: number;
  blockNumber: number;
  transactionHash: string;
}

export interface AccountInput {
  fromEntityId: string;
  toEntityId: string;
  metadata?: {
    purpose?: string;
    description?: string;
  };
}

export type EntityTx =
  | {
      type: 'chat';
      data: { from: string; message: string };
    }
  | {
      type: 'propose';
      data: { action: ProposalAction; proposer: string };
    }
  | {
      type: 'vote';
      data: { proposalId: string; voter: string; choice: 'yes' | 'no'; comment?: string };
    }
  | {
      type: 'profile-update';
      data: { profile: any }; // replace with concrete profile type if available
    }
  | {
      type: 'j_event';
      data: JurisdictionEventData;
    }
  | {
      type: 'accountInput';
      data: AccountInput;
    };

export interface AssetBalance {
  symbol: string; // "ETH", "USDT", "ACME-SHARES"
  amount: bigint; // Balance in smallest unit (wei, cents, shares)
  decimals: number; // For display (18 for ETH, 6 for USDT, 0 for shares)
  contractAddress?: string; // For ERC20 tokens
}

export interface ChannelState {
  counterparty: string; // Other entity's address
  myBalance: bigint; // My balance in this channel
  theirBalance: bigint; // Their balance in this channel
  collateral: AssetBalance[]; // Assets locked as collateral
  nonce: number; // Channel nonce for updates
  isActive: boolean; // Channel status
  lastUpdate: number; // Timestamp of last update
}

export interface EntityState {
  entityId: string; // The entity ID this state belongs to
  height: number;
  timestamp: number;
  nonces: Map<string, number>;
  messages: string[];
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;

  // 💰 NEW: Financial state
  reserves: Map<string, AssetBalance>; // symbol -> balance ("ETH" -> {amount: 10n, decimals: 18})
  channels: Map<string, ChannelState>; // counterpartyId -> channel state
  collaterals: Map<string, AssetBalance>; // Total assets locked in channels
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
  history: EnvSnapshot[]; // Time machine snapshots - single source of truth
  gossip: any; // Gossip layer for network profiles
  // Future: add config, utilities, etc.
}

export interface ServerSnapshot {
  height: number;
  entities: Record<string, EntityState>;
  gossip: {
    profiles: Record<string, Profile>;
  };
}

export interface EnvSnapshot {
  height: number;
  timestamp: number;
  replicas: Map<string, EntityReplica>;
  serverInput: ServerInput;
  serverOutputs: EntityInput[];
  description: string;
  gossip?: {
    profiles: Record<string, Profile>;
  };
}

// Entity types
export type EntityType = 'lazy' | 'numbered' | 'named';

// Constants
export const ENC = 'hex' as const;

// === HANKO BYTES SYSTEM (Final Design) ===
export interface HankoBytes {
  placeholders: Buffer[]; // Entity IDs that failed to sign (index 0..N-1)
  packedSignatures: Buffer; // EOA signatures → yesEntities (index N..M-1)
  claims: HankoClaim[]; // Entity claims to verify (index M..∞)
}

export interface HankoClaim {
  entityId: Buffer;
  entityIndexes: number[];
  weights: number[];
  threshold: number;
  expectedQuorumHash: Buffer;
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

// === PROFILE & NAME RESOLUTION TYPES ===

/**
 * Entity profile stored in gossip layer
 */
export interface EntityProfile {
  entityId: string;
  name: string; // Human-readable name e.g., "Alice Corp", "Bob's DAO"
  avatar?: string; // Custom avatar URL (fallback to generated identicon)
  bio?: string; // Short description
  website?: string; // Optional website URL
  lastUpdated: number; // Timestamp of last update
  hankoSignature: string; // Signature proving entity ownership
}

/**
 * Profile update transaction data
 */
export interface ProfileUpdateTx {
  name?: string;
  avatar?: string;
  bio?: string;
  website?: string;
}

/**
 * Name index for autocomplete
 */
export interface NameIndex {
  [name: string]: string; // name -> entityId mapping
}

/**
 * Autocomplete search result
 */
export interface NameSearchResult {
  entityId: string;
  name: string;
  avatar: string;
  relevance: number; // Search relevance score 0-1
}
