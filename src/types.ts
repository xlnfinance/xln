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
    position?: { x: number; y: number; z: number };
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
  // Votes: signerId → vote (string for simple votes, object for commented votes)
  // Future: Create VoteData interface for type-safe vote objects
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
      type: 'chatMessage';
      data: {
        message: string;
        timestamp: number;
        metadata?: {
          type: string;
          counterpartyId?: string;
          height?: number;
          frameAge?: number;
          tokenId?: number;
          rebalanceAmount?: string;
          [key: string]: any; // Allow additional rebalance metadata
        };
      };
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
      type: 'directPayment';
      data: {
        targetEntityId: string;
        tokenId: number;
        amount: bigint;
        route: string[]; // Full path from source to target
        description?: string;
      };
    }
  | {
      type: 'requestWithdrawal';
      data: {
        counterpartyEntityId: string;
        tokenId: number;
        amount: bigint;
      };
    }
  | {
      type: 'settleDiffs';
      data: {
        counterpartyEntityId: string;
        diffs: Array<{
          tokenId: number;
          leftDiff: bigint;   // Positive = credit, Negative = debit
          rightDiff: bigint;
          collateralDiff: bigint;
          ondeltaDiff: bigint;
        }>;
        description?: string; // e.g., "Fund collateral from reserve"
      };
    }
  | {
      type: 'deposit_collateral';
      data: {
        counterpartyId: string; // Which account to add collateral to
        tokenId: number;
        amount: bigint;
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
  height: number; // Renamed from frameId for S/E/A consistency
  timestamp: number;
  tokenIds: number[]; // Array of token IDs in this account
  deltas: bigint[]; // Array of deltas corresponding to tokenIds
  stateHash?: string; // Optional hash for cryptographic verification
}

export interface AccountMachine {
  counterpartyEntityId: string;
  mempool: AccountTx[]; // Unprocessed account transactions
  currentFrame: AccountFrame; // Current agreed state (includes full transaction history for replay/audit)
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
  currentHeight: number; // Renamed from currentFrameId for S/E/A consistency
  pendingFrame?: AccountFrame;
  pendingSignatures: string[];

  // Rollback support for bilateral disagreements
  rollbackCount: number;

  // CHANNEL.TS REFERENCE: Proper message counters (NOT timestamps!)
  sendCounter: number;    // Incremented for each outgoing message
  receiveCounter: number; // Incremented for each incoming message
  // Removed isProposer - use isLeft() function like old_src Channel.ts instead

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
  // Historical frame log - grows until manually pruned by entity
  frameHistory: AccountFrame[]; // All confirmed bilateral frames in chronological order

  // Payment routing: temporary storage for multi-hop payments
  pendingForward?: {
    tokenId: number;
    amount: bigint;
    route: string[];
    description?: string;
  };

  // Withdrawal tracking (Phase 2: C→R)
  pendingWithdrawals: Map<string, {
    requestId: string;
    tokenId: number;
    amount: bigint;
    requestedAt: number; // Timestamp
    direction: 'outgoing' | 'incoming'; // Did we request, or did they?
    status: 'pending' | 'approved' | 'rejected' | 'timed_out';
    signature?: string; // If approved
  }>;

  // Rebalancing hints (Phase 3: Hub coordination)
  requestedRebalance: Map<number, bigint>; // tokenId → amount entity wants rebalanced (credit→collateral)
}

// Account frame structure for bilateral consensus (renamed from AccountBlock)
export interface AccountFrame {
  height: number; // Renamed from frameId for S/E/A consistency
  timestamp: number;
  accountTxs: AccountTx[]; // Renamed from transitions
  prevFrameHash: string; // Hash of previous frame (creates chain linkage, not state linkage)
  stateHash: string;
  // Removed isProposer - both sides can propose bilaterally
  tokenIds: number[]; // Array of token IDs in this frame
  deltas: bigint[]; // Array of deltas corresponding to tokenIds (ondelta+offdelta for quick access)
  fullDeltaStates?: Delta[]; // OPTIONAL: Full delta objects (includes credit limits, allowances, collateral)
}

// AccountInput - Maps 1:1 to Channel.ts FlushMessage (frame-level consensus ONLY)
export interface AccountInput {
  fromEntityId: string;
  toEntityId: string;

  // Frame-level consensus (matches Channel.ts FlushMessage structure)
  height?: number;                   // Which frame we're ACKing or referencing (renamed from frameId)
  prevSignatures?: string[];         // ACK for their frame (like pendingSignatures in Channel.ts)
  newAccountFrame?: AccountFrame;    // Our new proposed frame (like block in Channel.ts)
  newSignatures?: string[];          // Signatures on new frame (like newSignatures in Channel.ts)
  counter?: number;                  // Message counter for replay protection (like Channel.ts line 620)
}

// Delta structure for per-token account state (based on old_src)
export interface Delta {
  tokenId: number;
  collateral: bigint;
  ondelta: bigint; // On-chain delta
  offdelta: bigint; // Off-chain delta
  leftCreditLimit: bigint;
  rightCreditLimit: bigint;
  leftAllowance: bigint;
  rightAllowance: bigint;
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
  ascii: string; // ASCII visualization from deriveDelta (like old_src)
}

// Account transaction types
export type AccountTx =
  | { type: 'account_payment'; data: { tokenId: number; amount: bigint } }
  | { type: 'direct_payment'; data: { tokenId: number; amount: bigint; route?: string[]; description?: string; fromEntityId?: string; toEntityId?: string } }
  | { type: 'add_delta'; data: { tokenId: number } }
  | { type: 'set_credit_limit'; data: { tokenId: number; amount: bigint; side: 'left' | 'right' } }
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
    }
  | {
      type: 'reserve_to_collateral';
      data: {
        tokenId: number;
        collateral: string; // Absolute collateral value from contract
        ondelta: string;    // Absolute ondelta value from contract
        side: 'receiving' | 'counterparty';
        blockNumber: number;
        transactionHash: string;
      };
    }
  | {
      type: 'request_withdrawal';
      data: {
        tokenId: number;
        amount: bigint;
        requestId: string; // Unique ID for matching ACK/NACK
      };
    }
  | {
      type: 'approve_withdrawal';
      data: {
        tokenId: number;
        amount: bigint;
        requestId: string; // Matches request_withdrawal.requestId
        approved: boolean; // true = ACK, false = NACK
        signature?: string; // If approved: signature for on-chain submission
      };
    }
  | {
      type: 'request_rebalance';
      data: {
        tokenId: number;
        amount: bigint; // How much collateral requested for insurance
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

  // ⏰ Crontab system - periodic task execution (typed in entity-crontab.ts)
  crontabState?: any; // CrontabState - avoid circular import

  // 📦 J-Batch system - accumulates operations for on-chain submission (typed in j-batch.ts)
  jBatchState?: any; // JBatchState - avoid circular import
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
  sentTransitions?: number; // Number of txs sent to proposer but not yet committed (Channel.ts pattern)
  position?: { x: number; y: number; z: number }; // 3D visualization position (for grid scenarios)
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
    profiles: Profile[];
  };
  // Interactive storytelling narrative
  title?: string; // Short headline (e.g., "Bank Run Begins")
  narrative?: string; // Detailed explanation of what's happening in this frame
  // Cinematic view state for scenario playback
  viewState?: {
    camera?: 'orbital' | 'overview' | 'follow' | 'free';
    zoom?: number;
    focus?: string; // Entity ID to center on
    panel?: 'accounts' | 'transactions' | 'consensus' | 'network';
    speed?: number; // Playback speed multiplier
    position?: { x: number; y: number; z: number }; // Camera position
    rotation?: { x: number; y: number; z: number }; // Camera rotation
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
