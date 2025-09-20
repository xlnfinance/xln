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

export interface AccountTxInput {
  fromEntityId: string;
  toEntityId: string;
  accountTx: AccountTx; // The actual account transaction to process
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
    }
  | {
      type: 'openAccount';
      data: { targetEntityId: string };
    }
  | {
      type: 'place_order';
      data: {
        orderId: number;
        side: 0 | 1; // 0=BUY, 1=SELL
        price: number; // in ticks
        quantity: number; // in lots
        tif: 0 | 1 | 2; // 0=GTC, 1=IOC, 2=FOK
        market?: string; // ETH/USDT, etc (optional, default to entity's primary market)
      };
    }
  | {
      type: 'cancel_order';
      data: { orderId: number };
    }
  | {
      type: 'modify_order';
      data: {
        orderId: number;
        newPrice?: number;
        deltaQty?: number;
      };
    };

export interface AssetBalance {
  amount: bigint; // Balance in smallest unit (wei, cents, shares)
  // Note: symbol, decimals, contractAddress come from token registry, not stored here
}

// Account machine structures for signed and collateralized accounts between entities
export interface AccountDelta {
  tokenId: number;
  delta: bigint; // Positive = we owe them, Negative = they owe us
}

// Simple account state snapshot (for currentFrame)
export interface AccountSnapshot {
  frameId: number;
  timestamp: number;
  tokenIds: number[]; // Array of token IDs in this account
  deltas: bigint[]; // Array of deltas corresponding to tokenIds
}

export interface AccountMachine {
  counterpartyEntityId: string;
  mempool: AccountTx[]; // Unprocessed account transactions
  currentFrame: AccountSnapshot; // Current agreed state
  sentTransitions: number; // Number of transitions sent but not yet confirmed
  ackedTransitions: number; // Number of transitions acknowledged by counterparty

  // Per-token delta states (giant per-token table like old_src)
  deltas: Map<number, Delta>; // tokenId -> Delta

  // Global credit limits (in reference currency - USDC)
  globalCreditLimits: {
    ownLimit: bigint; // How much credit we extend to counterparty (USD)
    peerLimit: bigint; // How much credit counterparty extends to us (USD)
  };

  // Frame-based consensus (like old_src Channel, consistent with entity frames)
  currentFrameId: number;
  pendingFrame?: AccountFrame;
  pendingSignatures: string[];

  // Rollback support for bilateral disagreements
  rollbackCount: number;
  isProposer: boolean; // Left entity (lexicographically smaller) is proposer

  // Cloned state for validation before committing (replaces dryRun)
  clonedForValidation?: AccountMachine;

  // Proof structures for dispute resolution
  proofHeader: {
    fromEntity: string; // Our entity ID
    toEntity: string; // Counterparty entity ID
    cooperativeNonce: number;
    disputeNonce: number;
  };
  proofBody: {
    tokenIds: number[];
    deltas: bigint[];
  };
  hankoSignature?: string; // Last signed proof by counterparty
}

// Account frame structure for bilateral consensus (renamed from AccountBlock)
export interface AccountFrame {
  frameId: number;
  timestamp: number;
  accountTxs: AccountTx[]; // Renamed from transitions
  previousStateHash: string;
  stateHash: string;
  isProposer: boolean; // Which side proposed this frame
  tokenIds: number[]; // Array of token IDs in this frame
  deltas: bigint[]; // Array of deltas corresponding to tokenIds
}

// Unified AccountInput interface (merging transaction-level and frame-level inputs)
export interface AccountInput {
  fromEntityId: string;
  toEntityId: string;

  // For transaction-level inputs
  accountTx?: AccountTx; // Single account transaction to process
  metadata?: {
    purpose?: string;
    description?: string;
  };

  // For frame-level inputs (consensus)
  frameId?: number; // Frame-based consensus
  prevSignatures?: string[]; // Previous signatures (acknowledging their frame)
  newAccountFrame?: AccountFrame; // New account frame we're proposing
  newSignatures?: string[]; // Our signatures on the new frame
  counter?: number; // Message counter for ordering (replay protection)
  accountFrame?: AccountFrame; // Full frame data when proposing
}

// Delta structure for per-token account state (based on old_src)
export interface Delta {
  tokenId: number;
  collateral: bigint;
  ondelta: bigint; // On-chain delta
  offdelta: bigint; // Off-chain delta
  leftCreditLimit: bigint;
  rightCreditLimit: bigint;
  leftAllowence: bigint;
  rightAllowence: bigint;
}

// Derived account balance information per token
export interface DerivedDelta {
  delta: bigint;
  collateral: bigint;
  inCollateral: bigint;
  outCollateral: bigint;
  inOwnCredit: bigint;
  outPeerCredit: bigint;
  inAllowence: bigint;
  outAllowence: bigint;
  totalCapacity: bigint;
  ownCreditLimit: bigint;
  peerCreditLimit: bigint;
  inCapacity: bigint;
  outCapacity: bigint;
  outOwnCredit: bigint;
  inPeerCredit: bigint;
}

// Account transaction types
export type AccountTx =
  | { type: 'initial_ack'; data: { message: string } }
  | { type: 'account_payment'; data: { tokenId: number; amount: bigint } }
  | { type: 'direct_payment'; data: { tokenId: number; amount: bigint; description?: string } }
  | { type: 'set_credit_limit'; data: { tokenId: number; amount: bigint; isForSelf: boolean } }
  | { type: 'account_frame'; data: { frame: AccountFrame; processedTransactions: number; fromEntity: string } }
  | {
      type: 'account_settle';
      data: {
        tokenId: number;
        ownReserve: string;
        counterpartyReserve: string;
        collateral: string;
        ondelta: string;
        side: 'left' | 'right';
        blockNumber: number;
        transactionHash: string;
      };
    };

export interface EntityState {
  entityId: string; // The entity ID this state belongs to
  height: number;
  timestamp: number;
  nonces: Map<string, number>;
  messages: string[];
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;

  // 💰 Financial state
  reserves: Map<string, bigint>; // tokenId -> amount only, metadata from TOKEN_REGISTRY
  accounts: Map<string, AccountMachine>; // counterpartyEntityId -> account state
  // 🔭 J-machine tracking
  jBlock: number; // Last processed J-machine block number

  // 🔗 Account machine integration
  accountInputQueue?: AccountInput[]; // Queue of settlement events to be processed by a-machine

  // 🎯 Trading state
  orderbook?: any; // Will be lob_core instance
  markets?: Map<string, MarketConfig>; // Trading pairs this entity makes markets in

  // 🔐 Idempotency tracking
  processedRequests?: Set<string>; // Track processed requests to prevent duplicates
}

// Market configuration for an entity's trading pair
export interface MarketConfig {
  baseToken: string; // e.g. 'ETH'
  quoteToken: string; // e.g. 'USDT'
  tickSize: number; // Minimum price increment
  lotSize: number; // Minimum quantity increment
  priceMin: number; // Min price in ticks
  priceMax: number; // Max price in ticks
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
