/**
 * XLN Type Definitions
 * All interfaces and type definitions used across the XLN system
 *
 * ═══════════════════════════════════════════════════════════════════════
 * XLN MESSAGE FLOW: Runtime → Entity → Account (R→E→A)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. RuntimeInput (External trigger - 100ms tick or user action)
 *    ├─ runtimeTxs: RuntimeTx[]        // System commands (importReplica, etc.)
 *    └─ entityInputs: EntityInput[]    // Messages to specific entities
 *
 * 2. EntityInput (BFT consensus at entity level)
 *    ├─ entityTxs: EntityTx[]          // State transitions (chat, payment, vote)
 *    ├─ precommits: Map<signerId, sig> // BFT signatures from validators
 *    └─ proposedFrame: ProposedEntityFrame // Consensus proposal with merkle root
 *
 * 3. EntityTx (Entity state machine transitions)
 *    ├─ 'chat' | 'propose' | 'vote'    // Governance layer
 *    ├─ 'j_event'                      // Blockchain events (reserves, settlements)
 *    ├─ 'openAccount'                  // Create bilateral account
 *    ├─ 'directPayment'                // Multi-hop payment through accounts
 *    └─ 'accountInput'                 // Process bilateral consensus message
 *
 * 4. AccountInput (Bilateral consensus between two entities)
 *    ├─ height: number                 // Which frame we're ACKing
 *    ├─ prevSignatures: string[]       // ACK their previous frame
 *    ├─ newAccountFrame: AccountFrame  // Our proposed frame
 *    ├─ newSignatures: string[]        // Signatures on new frame
 *    └─ counter: number                // Replay protection (CRITICAL)
 *
 * 5. AccountFrame (Agreed bilateral state - like a block)
 *    ├─ height: number                 // Frame number in bilateral chain
 *    ├─ accountTxs: AccountTx[]        // State transitions this frame
 *    ├─ prevFrameHash: string          // Links to previous frame (blockchain)
 *    ├─ stateHash: string              // Merkle root of current state
 *    ├─ tokenIds: number[]             // Active tokens in this account
 *    └─ deltas: bigint[]               // Per-token balances (signed integers)
 *
 * 6. AccountTx (Bilateral account state transitions)
 *    ├─ 'direct_payment'               // Update offdelta (instant settlement)
 *    ├─ 'add_delta'                    // Add new token to account
 *    ├─ 'set_credit_limit'             // Set mutual credit limits
 *    ├─ 'request_withdrawal'           // Phase 2: C→R (collateral to reserve)
 *    ├─ 'approve_withdrawal'           // ACK/NACK withdrawal request
 *    └─ 'reserve_to_collateral'        // Phase 1: R→C (from j_event)
 *
 * 7. Delta (Per-token bilateral state - the money)
 *    ├─ collateral: bigint             // Escrowed on-chain funds
 *    ├─ ondelta: bigint                // On-chain balance delta
 *    ├─ offdelta: bigint               // Off-chain balance delta (instant)
 *    ├─ leftCreditLimit: bigint        // Credit extended by left entity
 *    ├─ rightCreditLimit: bigint       // Credit extended by right entity
 *    ├─ leftAllowance: bigint          // Left entity's remaining credit
 *    └─ rightAllowance: bigint         // Right entity's remaining credit
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CONSENSUS GUARANTEES (Byzantine Fault Tolerance)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Entity Level (BFT):
 *   - Proposer rotates deterministically
 *   - Threshold signatures (t of n validators must sign)
 *   - Precommit-lock prevents double-signing
 *   - Safety: Never finalize conflicting states
 *   - Liveness: Progress if >threshold validators honest
 *
 * Account Level (Bilateral):
 *   - Both sides must sign every frame (2-of-2 consensus)
 *   - Counter prevents replay attacks
 *   - prevSignatures ACK prevents forks
 *   - State hash ensures deterministic state computation
 *   - Dispute resolution via on-chain proof submission
 *
 * ═══════════════════════════════════════════════════════════════════════
 * EXAMPLE FLOW: Alice pays Bob 100 USDC
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Step 1: Alice's UI creates RuntimeInput
 *   runtimeInput = {
 *     runtimeTxs: [],
 *     entityInputs: [{
 *       entityId: "Alice",
 *       entityTxs: [{
 *         type: 'directPayment',
 *         data: { targetEntityId: "Bob", tokenId: 1, amount: 100n }
 *       }]
 *     }]
 *   }
 *
 * Step 2: Alice's entity processes payment (entity-consensus.ts)
 *   - Validates Alice has account with Bob
 *   - Creates AccountInput to send to Bob
 *   - Updates Alice's AccountMachine.mempool
 *
 * Step 3: Bob receives AccountInput (account-consensus.ts)
 *   - Validates counter, prevSignatures
 *   - Applies payment tx: Bob.offdelta += 100n, Alice.offdelta -= 100n
 *   - Creates AccountFrame with new state
 *   - Signs frame, sends back to Alice
 *
 * Step 4: Alice receives Bob's signature
 *   - Both sides now have 2-of-2 signed frame
 *   - Payment is FINAL (instant finality)
 *   - No on-chain tx needed (pure off-chain)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * NAMING CONVENTIONS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Consistent terminology prevents confusion when reading/debugging code:
 *
 * **height** (NOT frameId):
 *   - Used everywhere: EntityFrame.height, AccountFrame.height, ServerFrame.height
 *   - Consistent with blockchain terminology (block height)
 *   - Old code used "frameId" but we migrated to "height" for S/E/A consistency
 *
 * **tx** (NOT transition):
 *   - EntityTx, AccountTx, RuntimeTx (transaction = state change request)
 *   - Used for actual state modifications
 *
 * **transition** (NOT tx):
 *   - ackedTransitions, sentTransitions (counter = message sequence number)
 *   - Used for replay protection counters, NOT transaction counts
 *   - Counts message exchanges, not individual transactions
 *   - Example: One message can contain multiple AccountTxs, but only increments counter by 1
 *
 * **counter** (for replay protection):
 *   - AccountInput.counter (sequential message counter, starts at 1)
 *   - CRITICAL: Must be exactly ackedTransitions + 1 (no gaps allowed)
 *   - Different from "transitions" which tracks confirmed message count
 *
 * ═══════════════════════════════════════════════════════════════════════
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

export interface RuntimeInput {
  runtimeTxs: RuntimeTx[];
  entityInputs: EntityInput[];
}

export type RuntimeTx =
  | {
      type: 'importReplica';
      entityId: string;
      signerId: string;
      data: {
        config: ConsensusConfig;
        isProposer: boolean;
        position?: { x: number; y: number; z: number };
      };
    }
  | {
      type: 'createXlnomy';
      data: {
        name: string;
        evmType: 'browservm' | 'reth' | 'erigon' | 'monad';
        rpcUrl?: string; // If evmType === RPC-based
        blockTimeMs?: number; // Default: 1000ms
        autoGrid?: boolean; // Auto-create 2x2x2 grid with $1M reserves
      };
    };

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
 * Jurisdiction event types - discriminated union for type safety
 * Each on-chain event has its own typed data structure
 */
export type JurisdictionEvent =
  | {
      type: 'ReserveUpdated';
      data: {
        entity: string;
        tokenId: number;
        newBalance: string;
        symbol: string;
        decimals: number;
      };
    }
  | {
      type: 'SettlementProcessed';
      data: {
        leftEntity: string;
        rightEntity: string;
        counterpartyEntityId: string;
        tokenId: number;
        ownReserve: string;
        counterpartyReserve: string;
        collateral: string;
        ondelta: string;
        side: 'left' | 'right';
      };
    }
  | {
      type: 'TransferReserveToCollateral';
      data: {
        receivingEntity: string;
        counterentity: string;
        collateral: string;
        ondelta: string;
        tokenId: number;
        side: 'receiving' | 'counterparty';
      };
    }
  | {
      type: 'InsuranceClaimed';
      data: {
        entityId: string;
        counterpartyId: string;
        tokenId: number;
        amount: string;
        claimReason: string;
      };
    }
  | {
      type: 'GovernanceEnabled';
      data: {
        entityId: string;
        proposalThreshold: number;
      };
    };

/**
 * Jurisdiction event data for j_event transactions
 * Now with typed event discriminated union
 */
export interface JurisdictionEventData {
  from: string;
  event: JurisdictionEvent;
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
    }
  | {
      // Reserve-to-reserve: Entity moves reserves to another entity (accumulates in jBatch)
      type: 'reserve_to_reserve';
      data: {
        toEntityId: string; // Recipient entity
        tokenId: number;
        amount: bigint;
      };
    }
  | {
      // J-Broadcast: Entity broadcasts accumulated jBatch to J-machine
      type: 'j_broadcast';
      data: {
        hankoSignature?: string; // Optional hanko seal for the batch
      };
    }
  | {
      // Extend credit to a counterparty in bilateral account
      type: 'extendCredit';
      data: {
        counterpartyEntityId: string;
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

  // 🛡️ Insurance - coverage lines from insurers
  insuranceLines?: Array<{
    insurer: string;
    tokenId: number;
    remaining: bigint;
    expiresAt: bigint;
  }>;

  // 💳 Debts - amounts owed to creditors (from FIFO queue)
  debts?: Array<{
    creditor: string;
    tokenId: number;
    amount: bigint;
    index: number;
  }>;
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
  // Position is RELATIVE to j-machine (jurisdiction)
  // Frontend calculates: worldPos = jMachine.position + relativePosition
  position?: {
    x: number;      // Relative X offset from j-machine center
    y: number;      // Relative Y offset from j-machine center
    z: number;      // Relative Z offset from j-machine center
    jurisdiction?: string; // Which j-machine this entity belongs to (defaults to activeJurisdiction)
    xlnomy?: string; // DEPRECATED: Use jurisdiction instead
  };
}

// =============================================================================
// STRUCTURED LOGGING SYSTEM
// =============================================================================

/** Log severity levels - ordered by priority */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Log categories for filtering */
export type LogCategory =
  | 'consensus'     // BFT entity consensus
  | 'account'       // Bilateral account consensus
  | 'jurisdiction'  // J-machine events
  | 'evm'           // Blockchain interactions
  | 'network'       // Routing/messaging
  | 'ui'            // UI events
  | 'system';       // System-level

/** Single log entry attached to a frame */
export interface FrameLogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  entityId?: string;              // Associated entity (if applicable)
  data?: Record<string, unknown>; // Structured data
}

export interface Env {
  eReplicas: Map<string, EntityReplica>;  // Entity replicas (E-layer state machines)
  jReplicas: Map<string, JReplica>;       // Jurisdiction replicas (J-layer EVM state)
  height: number;
  timestamp: number;
  runtimeInput: RuntimeInput; // Persistent storage for merged inputs
  history: EnvSnapshot[]; // Time machine snapshots - single source of truth
  gossip: any; // Gossip layer for network profiles

  // Active jurisdiction
  activeJurisdiction?: string; // Currently active J-replica name

  // Snapshot control (for prepopulate demos)
  disableAutoSnapshots?: boolean; // When true, captureSnapshot skips automatic tick frames

  // Frame-scoped structured logs (captured into snapshot, then reset)
  frameLogs: FrameLogEntry[];
}

/**
 * JReplica = Jurisdiction replica (J-Machine EVM state)
 * Contains stateRoot for time travel + decoded contracts for UI
 */
export interface JReplica {
  name: string;                           // "ethereum", "base", "simnet"
  blockNumber: bigint;                    // Current J-block height
  stateRoot: Uint8Array;                  // 32 bytes - for time travel via setStateRoot()
  mempool: JTx[];                         // Pending settlement txs

  // Visual position (for 3D rendering)
  position: { x: number; y: number; z: number };

  // Decoded contract addresses for UI
  contracts?: {
    depository?: string;
    entityProvider?: string;
    account?: string;
  };

  // === SYNCED FROM DEPOSITORY.SOL ===
  // mapping(bytes32 => mapping(uint => uint)) _reserves
  reserves?: Map<string, Map<number, bigint>>;  // entityId -> tokenId -> amount

  // mapping(bytes => mapping(uint => AccountCollateral)) _collaterals
  collaterals?: Map<string, Map<number, bigint>>; // accountKey -> tokenId -> amount

  // mapping(bytes32 => InsuranceLine[]) insuranceLines
  insuranceLines?: Map<string, Array<{ insurer: string; tokenId: number; remaining: bigint; expiresAt: bigint }>>;

  // === SYNCED FROM ENTITYPROVIDER.SOL ===
  // mapping(bytes32 => Entity) entities
  registeredEntities?: Map<string, { name: string; quorum: string[]; threshold: number }>;
}

/** J-Machine transaction (settlement layer) */
export interface JTx {
  type: 'settle' | 'dispute' | 'register' | 'deposit' | 'withdraw';
  entityId: string;
  data: any;
  timestamp: number;
}

export interface RuntimeSnapshot {
  height: number;
  entities: Record<string, EntityState>;
  gossip: {
    profiles: Record<string, Profile>;
  };
}

export interface EnvSnapshot {
  height: number;
  timestamp: number;
  eReplicas: Map<string, EntityReplica>;  // E-layer state
  jReplicas: JReplica[];                   // J-layer state (with stateRoot for time travel)
  runtimeInput: RuntimeInput;
  runtimeOutputs: EntityInput[];
  description: string;
  gossip?: {
    profiles: Profile[];
  };
  // Interactive storytelling narrative
  title?: string; // Short headline (e.g., "Bank Run Begins")
  narrative?: string; // Detailed explanation of what's happening in this frame
  // Fed Chair educational subtitles (AHB demo)
  subtitle?: {
    title: string;           // Technical summary (e.g., "Reserve-to-Reserve Transfer")
    what: string;            // What's happening
    why: string;             // Why it matters
    tradfiParallel: string;  // Traditional finance equivalent
    keyMetrics?: string[];   // Bullet points of key numbers
  };
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
  // Frame-specific structured logs
  logs?: FrameLogEntry[];
}

// Entity types - canonical definition in ids.ts
export { type EntityType } from './ids';

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

// === XLNOMY (JURISDICTION) SYSTEM ===

/**
 * Economic Topology Types
 * Defines how central bank, commercial banks, and customers interact
 */
export type TopologyType = 'star' | 'mesh' | 'tiered' | 'correspondent' | 'hybrid';

export interface TopologyLayer {
  name: string;              // "Federal Reserve", "Tier 1 Banks", "Customers"
  yPosition: number;         // Vertical position in 3D space
  entityCount: number;       // How many entities in this layer
  xzSpacing: number;         // Horizontal spread between entities

  // Visual properties
  color: string;             // Hex color (#FFD700 for Fed)
  size: number;              // Size multiplier (10.0 for Fed, 1.0 for banks, 0.5 for customers)
  emissiveIntensity: number; // Glow intensity

  // Economic properties
  initialReserves: bigint;   // Starting balance
  canMintMoney: boolean;     // Only central bank = true
}

export interface ConnectionRules {
  // Who can create accounts with whom
  allowedPairs: Array<{ from: string; to: string }>;

  // Routing
  allowDirectInterbank: boolean;  // Banks can trade P2P?
  requireHubRouting: boolean;     // All payments through central hub?
  maxHops: number;                // Max routing path length

  // Credit limits (per layer pair)
  defaultCreditLimits: Map<string, bigint>;
}

export interface XlnomyTopology {
  type: TopologyType;
  layers: TopologyLayer[];
  rules: ConnectionRules;

  // Crisis management (for HYBRID)
  crisisThreshold: number;        // 0.20 = reserves < 20% deposits triggers crisis
  crisisMode: 'star' | 'mesh';    // Morph to this during crisis
}

/**
 * Xlnomy = J-Machine (court/jurisdiction) + Entities + Contracts
 * Self-contained economy where J-Machine IS the jurisdiction
 */
export interface Xlnomy {
  name: string; // e.g., "Simnet", "GameEconomy"
  evmType: 'browservm' | 'reth' | 'erigon' | 'monad';
  blockTimeMs: number; // Block time in milliseconds (1000ms default)

  // NEW: Economic topology configuration
  topology?: XlnomyTopology;

  // J-Machine = Jurisdiction machine (court that entities anchor to)
  jMachine: {
    position: { x: number; y: number; z: number }; // Visual position (0, 100, 0)
    capacity: number; // Broadcast threshold (default: 3)
    jHeight: number; // Current block height in jurisdiction
    mempool: any[]; // Pending transactions in J-Machine queue
  };

  // Deployed contracts
  contracts: {
    entityProviderAddress: string;
    depositoryAddress: string;
  };

  // EVM instance (BrowserVM in-browser, or Reth/Erigon RPC)
  evm: JurisdictionEVM;

  // Entity registry
  entities: string[]; // Entity IDs registered in this Xlnomy

  // Metadata
  created: number; // Timestamp
  version: string; // e.g., "1.0.0"
}

/**
 * Abstract jurisdiction EVM (BrowserVM or RPC to Reth/Erigon/Monad)
 * Allows swapping execution layer without changing runtime code
 */
export interface JurisdictionEVM {
  type: 'browservm' | 'reth' | 'erigon' | 'monad';

  // Contract deployment
  deployContract(bytecode: string, args?: any[]): Promise<string>;

  // Contract calls
  call(to: string, data: string, from?: string): Promise<string>;
  send(to: string, data: string, value?: bigint): Promise<string>;

  // State queries
  getBlock(): Promise<number>;
  getBalance(address: string): Promise<bigint>;

  // Serialization for persistence
  serialize(): Promise<XlnomySnapshot>;

  // Address getters
  getEntityProviderAddress(): string;
  getDepositoryAddress(): string;

  // Time travel (optional - only BrowserVM supports this)
  captureStateRoot?(): Promise<Uint8Array>;
  timeTravel?(stateRoot: Uint8Array): Promise<void>;
  getBlockNumber?(): bigint;
}

/**
 * Persisted Xlnomy snapshot (stored in Level/IndexedDB)
 * Can be exported as JSON and shared/imported
 */
export interface XlnomySnapshot {
  name: string;
  version: string;
  created: number;
  evmType: 'browservm' | 'reth' | 'erigon' | 'monad';
  blockTimeMs: number;

  // J-Machine config
  jMachine: {
    position: { x: number; y: number; z: number };
    capacity: number;
    jHeight: number;
  };

  // Deployed contracts
  contracts: {
    entityProviderAddress: string;
    depositoryAddress: string;
  };

  // EVM-specific state
  evmState: {
    rpcUrl?: string; // If RPC EVM (Reth/Erigon/Monad)
    vmState?: any; // If BrowserVM - serialized @ethereumjs/vm state
  };

  // Entity registry
  entities: string[];

  // Runtime state (replicas + history)
  runtimeState?: {
    replicas: any; // Serialized Map<string, EntityReplica>
    history: EnvSnapshot[];
  };
}
