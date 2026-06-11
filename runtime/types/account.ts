import type { CrossJurisdictionPullBinding, CrossJurisdictionSwapRoute } from './cross-jurisdiction';
import type { HankoString } from './hanko';
import type { JurisdictionEvent } from './jurisdiction-events';
import type { DisputeArgumentSnapshot } from '../dispute-arguments';
import type { RebalancePolicy, RebalanceQuote, RebalanceRequestFeeState } from './rebalance';

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

// ═══════════════════════════════════════════════════════════════
// HTLC (Hash Time-Locked Contracts)
// ═══════════════════════════════════════════════════════════════

/**
 * HTLC Lock - Conditional payment held until secret reveal or timeout
 * Reference: 2024 StoredSubcontract (ChannelState.ts:4-11)
 */
export interface HtlcLock {
  lockId: string;              // keccak256(hash + height + nonce)
  hashlock: string;            // keccak256(abi.encode(secret)) - 32 bytes hex
  timelock: bigint;            // Expiry timestamp (unix-ms)
  revealBeforeHeight: number;  // J-block height deadline (enforced on-chain)
  amount: bigint;              // Locked amount
  tokenId: number;             // Token being locked
  senderIsLeft: boolean;       // Who initiated (canonical direction)
  createdHeight: number;       // AccountFrame height when created
  createdTimestamp: number;    // When lock was added (for logging)

  // Onion routing envelope (cleartext JSON in Phase 2, encrypted in Phase 3)
  envelope?: import('../htlc-envelope-types').HtlcEnvelope | string;
}

export interface PullCommitment {
  pullId: string;
  tokenId: number;
  amount: bigint;
  claimedRatio?: number;
  claimedAmount?: bigint;
  revealedUntilTimestamp: number;
  fullHash: string;
  partialRoot: string;
  crossJurisdiction?: CrossJurisdictionPullBinding;
  createdHeight: number;
  createdTimestamp: number;
}

// Swap offer (limit order) in bilateral account
export interface SwapOffer {
  offerId: string;              // UUID for this offer
  giveTokenId: number;          // Token maker is giving
  giveAmount: bigint;           // Original amount (partial fills reduce this)
  wantTokenId: number;          // Token maker wants in return
  wantAmount: bigint;           // Corresponding want amount (maintains ratio)
  priceTicks?: bigint;          // Canonical limit price used for requantization after partial fills
  timeInForce?: 0 | 1 | 2;      // 0 = GTC, 1 = IOC, 2 = FOK
  minFillRatio: number;         // 0-65535, minimum acceptable fill
  makerIsLeft: boolean;         // Who created this offer (canonical direction)
  createdHeight: number;        // AccountFrame height when created
  // Quantized amounts for orderbook consistency (set by hub when adding to book)
  // These ensure fill ratios computed from lots match settlement amounts exactly
  quantizedGive?: bigint;       // giveAmount rounded to LOT_SCALE multiple
  quantizedWant?: bigint;       // wantAmount scaled proportionally
  crossJurisdiction?: CrossJurisdictionSwapRoute;
}

export interface SwapOrderResolveHistoryEntry {
  fillRatio: number;
  fillNumerator?: bigint;
  fillDenominator?: bigint;
  cancelRemainder: boolean;
  height: number;
  executionGiveAmount?: bigint;
  executionWantAmount?: bigint;
  feeTokenId?: number;
  feeAmount?: bigint;
  comment?: string;
}

export interface SwapOrderHistoryEntry {
  offerId: string;
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  priceTicks?: bigint;
  createdHeight: number;
  crossJurisdiction?: CrossJurisdictionSwapRoute;
  cancelRequested: boolean;
  lastUpdatedHeight: number;
  resolves: SwapOrderResolveHistoryEntry[];
}

/**
 * HTLC Routing Context (replaces 2024 User.hashlockMap)
 * Tracks inbound/outbound hops for automatic secret propagation
 */
export interface HtlcRoute {
  hashlock: string;
  tokenId?: number;
  amount?: bigint;
  startedAtMs?: number;

  // Inbound hop (who sent us this HTLC)
  inboundEntity?: string;
  inboundLockId?: string;

  // Outbound hop (who we forwarded to)
  outboundEntity?: string;
  outboundLockId?: string;

  // Resolution
  secret?: string;
  // Waiting for inbound counterparty to ACK secret-return (htlc_resolve(secret)).
  secretAckPending?: boolean;
  secretAckStartedAt?: number;
  secretAckDeadlineAt?: number;
  secretAckedAt?: number;
  pendingFee?: bigint; // Fee to accrue on successful reveal (not on forward)
  crossJurisdictionRelay?: CrossJurisdictionSecretRelay;
  createdTimestamp: number;
}

export interface CrossJurisdictionSecretRelay {
  routeId: string;
  fillRatio: number;
  sourceAmount: bigint;
  targetAmount: bigint;
  targetEntityId: string;
  targetCounterpartyEntityId: string;
  targetLockId: string;
}

/** End-to-end payment notes stored locally by hashlock/lockId for activity rendering. */
export type HtlcNoteKey = `hashlock:${string}` | `lock:${string}`;

export type AccountStatus = 'active' | 'dispute_preparing' | 'disputed';

export interface AccountMachine {
  // CANONICAL REPRESENTATION (like Channel.ts - both entities store IDENTICAL structure)
  leftEntity: string;   // Lower entity ID (canonical left)
  rightEntity: string;  // Higher entity ID (canonical right)
  status: AccountStatus; // Manual lifecycle gate for dispute freeze/reopen

  mempool: AccountTx[]; // Unprocessed account transactions
  currentFrame: AccountFrame; // Current agreed state (includes full transaction history for replay/audit)

  // Per-token delta states (giant per-token table like old_src)
  deltas: Map<number, Delta>; // tokenId -> Delta

  // HTLC state (conditional payments)
  locks: Map<string, HtlcLock>; // lockId → lock details

  // Swap offers (limit orders)
  swapOffers: Map<string, SwapOffer>; // offerId → offer details
  pulls?: Map<string, PullCommitment>; // pullId → ratio-gated pull details
  // Durable local lifecycle log for swap UI/history.
  // Keep this in account state so closed/partial orders do not disappear
  // when the short bilateral frameHistory ring buffer prunes old frames.
  swapOrderHistory?: Map<string, SwapOrderHistoryEntry>;
  // Terminal swap orders (filled/canceled/closed) used by the UI closed-orders view.
  // Keep open working state and terminal history separate so the UI does not infer
  // closed rows by subtracting live offers from a broad lifecycle store.
  swapClosedOrders?: Map<string, SwapOrderHistoryEntry>;

  // Global credit limits (in reference currency - USDC)
  globalCreditLimits: {
    ownLimit: bigint; // How much credit we extend to counterparty (USD)
    peerLimit: bigint; // How much credit counterparty extends to us (USD)
  };

  // Frame-based consensus (like old_src Channel, consistent with entity frames)
  currentHeight: number; // Renamed from currentFrameId for S/E/A consistency
  pendingFrame?: AccountFrame;
  pendingSignatures: string[];
  pendingAccountInput?: AccountInput; // Cached outbound frame input for resend/nudge
  lastOutboundFrameAck?: {
    height: number;
    counterpartyEntityId: string;
    prevHanko: HankoString;
  };

  // Rollback support for bilateral disagreements
  rollbackCount: number;
  lastRollbackFrameHash?: string; // Track last rollback to prevent duplicate increments

  // Bilateral J-event consensus (2-of-2 agreement on jurisdiction events)
  leftJObservations: Array<{ jHeight: number; jBlockHash: string; events: JurisdictionEvent[]; observedAt: number }>;
  rightJObservations: Array<{ jHeight: number; jBlockHash: string; events: JurisdictionEvent[]; observedAt: number }>;
  jEventChain: Array<{ jHeight: number; jBlockHash: string; events: JurisdictionEvent[]; finalizedAt: number }>;
  lastFinalizedJHeight: number;

  // Removed isProposer - use isLeft() function like old_src Channel.ts instead

  // Cloned state for validation before committing (replaces dryRun)
  clonedForValidation?: AccountMachine;

  // Proof structures for dispute resolution
  proofHeader: {
    fromEntity: string; // Our entity ID
    toEntity: string; // Counterparty entity ID
    nonce: number;  // Unified on-chain nonce (replaces cooperativeNonce + disputeNonce)
  };
  // Simple proofBody for internal use (computed on demand from deltas/locks/swapOffers)
  proofBody: {
    tokenIds: number[];
    deltas: bigint[];
    // HTLC transformers (like 2024 subcontracts - sorted by deltaIndex)
    htlcLocks?: Array<{
      deltaIndex: number;       // Index in tokenIds array
      amount: bigint;
      revealedUntilTimestamp: number; // Unix-second deadline
      hash: string;             // hashlock
    }>;
  };
  // ABI-encoded proofBody for on-chain disputes (built by proof-builder.ts)
  abiProofBody?: {
    encodedProofBody: string;   // ABI-encoded bytes for contract call
    proofBodyHash: string;      // keccak256(encodedProofBody) - signed for disputes
    lastUpdatedHeight: number;  // Frame height when last computed
  };
  // Dispute configuration (per-side delay settings)
  disputeConfig: {
    leftDisputeDelay: number;   // uint16 - value * 10 = blocks
    rightDisputeDelay: number;  // uint16 - value * 10 = blocks
  };
  // HANKO SYSTEM: Frame consensus + Dispute proofs
  currentFrameHanko?: HankoString;           // My hanko on current frame (bilateral consensus)
  counterpartyFrameHanko?: HankoString;      // Their hanko on current frame (bilateral consensus)

  currentDisputeProofHanko?: HankoString;              // My hanko on dispute proof (for J-machine enforcement)
  currentDisputeProofNonce?: number;                    // Nonce used in currentDisputeProofHanko
  currentDisputeProofBodyHash?: string;                // ProofBodyHash used in currentDisputeProofHanko
  currentDisputeHash?: string;                         // Exact dispute hash signed in currentDisputeProofHanko
  counterpartyDisputeProofHanko?: HankoString;         // Their hanko on dispute proof (ready for disputes)
  counterpartyDisputeProofNonce?: number;               // Nonce used in counterpartyDisputeProofHanko
  counterpartyDisputeProofBodyHash?: string;           // ProofBodyHash that counterparty signed (MUST match dispute)
  counterpartyDisputeHash?: string;                    // Exact dispute hash signed in counterpartyDisputeProofHanko
  counterpartySettlementHanko?: HankoString;           // Their hanko on settlement operations
  disputeProofNoncesByHash?: Record<string, number>;   // ProofBodyHash → nonce (local + counterparty)
  disputeProofBodiesByHash?: Record<string, unknown>;      // ProofBodyHash → ProofBodyStruct (for dispute finalize)
  disputeArgumentSnapshotsByHash?: Record<string, DisputeArgumentSnapshot>; // ProofBodyHash → stable argument plan
  disputePrepare?: {
    // Local-only cooldown before an on-chain dispute is queued.
    //
    // The jurisdiction never sees this object. It exists to stop normal account
    // traffic, clear orderbook exposure, and wait until dispute transformer
    // arguments are stable. Counterexample: if we immediately start/counter a
    // dispute while an HTLC secret ACK or swap fill frame is still pending, the
    // calldata for the signed proof body can change after we already committed
    // the disputeStart hash.
    startedAt: number;
    readyAfter: number;
    reason: string;
  };

  // ON-CHAIN NONCE: Tracks the nonce stored on-chain
  // Starts at 0, set to signedNonce when settlement/dispute succeeds
  // DISTINCT from proofHeader.nonce (which tracks what value to use next)
  onChainSettlementNonce: number;

  // SETTLEMENT WORKSPACE: Structured negotiation area
  settlementWorkspace?: SettlementWorkspace;

  // Active dispute state (set after disputeStart, needed for disputeFinalize)
  activeDispute?: {
    startedByLeft: boolean;           // Who initiated dispute (from on-chain)
    initialProofbodyHash: string;     // Hash committed in disputeStart
    initialNonce: number;             // Unified nonce from disputeStart (replaces initialDisputeNonce)
    disputeTimeout: number;           // Block number when timeout expires
    onChainNonce: number;             // On-chain nonce at dispute start (replaces initialCooperativeNonce + onChainCooperativeNonce)
    starterInitialArguments: string;  // Starter-side args for initial proof
    starterIncrementedArguments: string;  // Starter-side args for the one known newer proof, or 0x
    finalizeQueued?: boolean;         // Finalize op already queued locally (single-source lifecycle guard)
  };

  hankoSignature?: string; // Latest generated account proof hanko.

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
  requestedRebalanceFeeState: Map<number, RebalanceRequestFeeState>; // tokenId → prepaid fee metadata
  counterpartyRebalanceFeePolicy?: {
    policyVersion: number;
    baseFee: bigint;
    liquidityFeeBps: bigint;
    gasFee: bigint;
    updatedAt: number;
  };

  // Rebalance policy (per-token soft/hard limits + max acceptable fee)
  rebalancePolicy: Map<number, RebalancePolicy>; // tokenId → policy

  // Active rebalance quote (one at a time, quoteId = timestamp)
  activeRebalanceQuote?: RebalanceQuote;

  // Pending manual rebalance request (user-initiated, awaiting hub quote)
  pendingRebalanceRequest?: { tokenId: number; targetAmount: bigint };
}

// Account frame structure for bilateral consensus (renamed from AccountBlock)
export interface AccountFrame {
  height: number; // Renamed from frameId for S/E/A consistency
  timestamp: number;
  jHeight: number; // J-machine height agreed for HTLC deadline checks
  accountTxs: AccountTx[]; // Renamed from transitions
  prevFrameHash: string; // Hash of previous frame (creates chain linkage, not state linkage)
  stateHash: string;
  byLeft?: boolean; // Who proposed this frame (left or right entity)
  // One source of truth for account-frame token state. Compact offdelta arrays
  // and token id arrays are derived by helpers when logs/proofs need them.
  deltas: Delta[];
}

export type RuntimeFrameDbRecord =
  {
    kind: 'accountFrame';
    entityId: string;
    counterpartyId: string;
    accountHeight: number;
    source: 'ackCommit' | 'peerCommit';
    frame: AccountFrame;
    runtimeHeight?: number;
    timestamp?: number;
  };

export type RuntimeOverlayRecord =
  | { family: 'entity'; entityId: string }
  | { family: 'account'; entityId: string; counterpartyId: string }
  | { family: 'book'; entityId: string; pairId: string; deleted?: boolean };

export type AccountSettleAction = {
  type: 'propose' | 'update' | 'approve' | 'execute' | 'reject';
  ops?: SettlementOp[];                // For propose/update
  executorIsLeft?: boolean;            // For propose/update
  hanko?: HankoString;                 // For approve (signer's hanko)
  memo?: string;                       // For propose/update/reject
  version?: number;                    // Version being approved/executed
  nonceAtSign?: number;                // Settlement nonce counterparty signed with (approve)
};

type AccountInputBase = {
  fromEntityId: string;
  toEntityId: string;

  // Frame-level consensus (matches Channel.ts FlushMessage structure)
  height?: number;                   // Which frame we're ACKing or referencing (renamed from frameId)

  disputeProofNonce?: number;        // nonce at which dispute proof was signed (explicit, replaces counter-1 hack)
};

type AccountDisputeSeal = {
  newDisputeHanko?: HankoString;
  newDisputeHash?: string;
  newDisputeProofBodyHash?: string;
  disputeProofNonce?: number;
};

type AccountInputNoSettlement = {
  settleAction?: never;
  newSettlementHanko?: never;
};

type AccountInputNoFrame = {
  newAccountFrame?: never;
  newHanko?: never;
};

type AccountInputNoAck = {
  prevHanko?: never;
};

// AccountInput - Channel.ts-style bilateral wire message.
// The discriminant preserves the real protocol shapes while still allowing the
// existing ACK+next-frame batching path to be represented explicitly.
export type AccountInput =
  | (AccountInputBase & AccountDisputeSeal & AccountInputNoSettlement & AccountInputNoAck & {
      kind: 'frame';
      newAccountFrame: AccountFrame;
      newHanko: HankoString;
    })
  | (AccountInputBase & AccountDisputeSeal & AccountInputNoSettlement & AccountInputNoFrame & {
      kind: 'ack';
      prevHanko: HankoString;
    })
  | (AccountInputBase & AccountDisputeSeal & AccountInputNoSettlement & {
      kind: 'frame_ack';
      prevHanko: HankoString;
      newAccountFrame: AccountFrame;
      newHanko: HankoString;
    })
  | (AccountInputBase & AccountDisputeSeal & AccountInputNoSettlement & AccountInputNoFrame & AccountInputNoAck & {
      kind: 'dispute';
      newDisputeHanko: HankoString;
      newDisputeHash: string;
      newDisputeProofBodyHash: string;
    })
  | (AccountInputBase & AccountInputNoFrame & AccountInputNoAck & {
      kind: 'settle';
      settleAction: AccountSettleAction;
      newSettlementHanko?: HankoString;
      newDisputeHanko?: never;
      newDisputeHash?: never;
      newDisputeProofBodyHash?: never;
    });

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

  // Unified per-side holds across all transformers (HTLC/swap/settlement).
  // This is the only hold model in Delta state.
  leftHold?: bigint;
  rightHold?: bigint;
}

// ═══════════════════════════════════════════════════════════════
// SETTLEMENT WORKSPACE (Bilateral Negotiation Area)
// ═══════════════════════════════════════════════════════════════

/**
 * Settlement diff - single token operation in a settlement
 * CONSERVATION LAW: leftDiff + rightDiff + collateralDiff = 0
 */
export interface SettlementDiff {
  tokenId: number;
  leftDiff: bigint;       // Change to left's reserve (+ = credit, - = debit)
  rightDiff: bigint;      // Change to right's reserve
  collateralDiff: bigint; // Change to account collateral
  ondeltaDiff: bigint;    // Change to ondelta (tracks left's share)
}

/**
 * Typed settlement operation (V1 — 4 ops)
 * Compiled to SettlementDiff[] at approve time via compileOps()
 *
 * All ops are from the PROPOSER's perspective:
 * - r2c: proposer's reserve → collateral
 * - c2r: collateral → proposer's reserve
 * - r2r: proposer's reserve → counterparty's reserve
 * - forgive: forgive debt in this token
 */
export type SettlementOp =
  | { type: 'r2c';     tokenId: number; amount: bigint }  // Proposer reserve → collateral
  | { type: 'c2r';     tokenId: number; amount: bigint }  // Collateral → proposer reserve
  | { type: 'r2r';     tokenId: number; amount: bigint }  // Proposer reserve → counterparty reserve
  | { type: 'forgive'; tokenId: number }                   // Forgive debt in this token
  | { type: 'rawDiff'; tokenId: number; leftDiff: bigint; rightDiff: bigint; collateralDiff: bigint; ondeltaDiff: bigint };  // V1 escape hatch for complex settlements

/**
 * Settlement workspace - shared editing area per bilateral account
 *
 * Flow:
 * 1. Either party creates workspace via settle_propose (ops + lastModifiedByLeft)
 * 2. Both parties can update via settle_update (replaces ops)
 * 3. Counterparty approves via settle_approve (compiles ops, signs, caches diffs)
 * 4. Executor submits via settle_execute (uses cached compiled diffs)
 * 5. Execute or reject clears workspace
 */
export interface SettlementWorkspace {
  ops: SettlementOp[];                        // Typed operations (compiled to diffs at approve)
  compiledDiffs?: SettlementDiff[];           // Cached at approve time
  compiledForgiveTokenIds?: number[];         // Cached at approve time

  // Hanko signatures
  leftHanko?: HankoString;                    // Left's signature on settlement
  rightHanko?: HankoString;                   // Right's signature on settlement

  // Metadata
  lastModifiedByLeft: boolean;                // Who last proposed/updated
  status: 'draft' | 'awaiting_counterparty' | 'ready_to_submit' | 'submitted';
  memo?: string;                              // Human-readable description
  version: number;                            // Increments on each update
  createdAt: number;                          // Timestamp when created
  lastUpdatedAt: number;                      // Timestamp of last update

  // Executor: who submits batch (locked after any hanko)
  executorIsLeft: boolean;

  // Nonce tracking (for invalidating old dispute proofs)
  nonceAtSign?: number;                       // nonce when signing

  // Post-settlement dispute proofs (nonce+1)
  // Settlement increments on-chain nonce. Old dispute proofs become invalid.
  // These pre-signed proofs at nonce+1 become active after settlement passes.
  // proofBodyHash is unchanged by settlement (settlement modifies ondelta/collateral,
  // not offdelta — and proofBody only hashes offdelta).
  postSettlementDisputeProof?: {
    leftHanko?: HankoString;                  // Left's dispute hanko at nonce+1
    rightHanko?: HankoString;                 // Right's dispute hanko at nonce+1
    proofBodyHash: string;                    // Same as pre-settlement (offdelta unchanged)
    nonce: number;                            // = onChainSettlementNonce + 1 (replaces cooperativeNonce)
  };
}

// Derived account balance information per token
export interface DerivedDelta {
  delta: bigint;
  collateral: bigint;
  inCollateral: bigint;
  outCollateral: bigint;
  inOwnCredit: bigint;
  outPeerCredit: bigint;
  inAllowance: bigint;
  outAllowance: bigint;
  totalCapacity: bigint;
  ownCreditLimit: bigint;
  peerCreditLimit: bigint;
  inCapacity: bigint;
  outCapacity: bigint;
  outOwnCredit: bigint;
  inPeerCredit: bigint;
  peerCreditUsed: bigint;  // Credit peer lent that we're using
  ownCreditUsed: bigint;   // Credit we lent that peer is using
  outTotalHold: bigint;    // Unified hold deducted from out capacity
  inTotalHold: bigint;     // Unified hold deducted from in capacity
  ascii: string; // ASCII visualization from deriveDelta (like old_src)
}

/**
 * Account Events - Bubbled up from A-layer to E-layer
 * Used for routing (HTLC secrets) and matching (swap offers)
 */
export type AccountEvent =
  | { type: 'htlc_revealed'; hashlock: string; secret: string }
  | { type: 'swap_offer_created'; offerId: string; makerId: string; accountId: string; giveTokenId: number; giveAmount: bigint; wantTokenId: number; wantAmount: bigint; timeInForce?: 0 | 1 | 2; minFillRatio: number; crossJurisdiction?: CrossJurisdictionSwapRoute }
  | { type: 'swap_offer_cancelled'; offerId: string; accountId: string };

// Account transaction types
export type AccountTx =
  | { type: 'direct_payment'; data: { tokenId: number; amount: bigint; route?: string[]; description?: string; fromEntityId?: string; toEntityId?: string } }
  | { type: 'add_delta'; data: { tokenId: number } }
  | { type: 'set_credit_limit'; data: { tokenId: number; amount: bigint } }
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
      type: 'request_collateral';
      data: {
        tokenId: number;
        amount: bigint;       // Requested collateral deposit amount (R→C)
        feeTokenId?: number;  // Optional fee token (defaults to tokenId)
        feeAmount: bigint;    // Prepaid fee debited immediately in the request_collateral frame
        policyVersion: number; // Hub fee-policy version used to compute feeAmount
      };
    }
  | {
      type: 'set_rebalance_policy';
      data: {
        tokenId: number;
        r2cRequestSoftLimit: bigint;         // Auto-trigger below this
        hardLimit: bigint;         // Never exceed
        maxAcceptableFee: bigint;  // Auto-accept quotes with fee ≤ this (USDT)
      };
    }
  // === HTLC TRANSACTION TYPES ===
  | {
      type: 'htlc_lock';
      data: {
        lockId: string;
        hashlock: string;
        timelock: bigint;
        revealBeforeHeight: number;
        amount: bigint;
        tokenId: number;
        envelope?: import('../htlc-envelope-types').HtlcEnvelope | string | undefined; // Onion routing envelope (string when encrypted)
      };
    }
  | {
      type: 'htlc_resolve';
      data: {
        lockId: string;
        outcome: 'secret' | 'error';
        secret?: string;  // required when outcome='secret'
        reason?: string;  // when outcome='error': no_account, no_capacity, timeout, amount_too_small, etc.
      };
    }
  | {
      type: 'pull_lock';
      data: {
        pullId: string;
        tokenId: number;
        amount: bigint;
	        revealedUntilTimestamp: number;
	        fullHash: string;
	        partialRoot: string;
	        crossJurisdiction?: CrossJurisdictionPullBinding;
	      };
	    }
  | {
      type: 'pull_resolve';
      data: {
        pullId: string;
        binary: string;
      };
    }
  | {
      type: 'pull_cancel';
      data: {
        pullId: string;
        reason?: 'beneficiary_release' | 'expired' | 'cross_j_cancel_no_fill';
      };
    }
  // === SWAP TRANSACTION TYPES ===
  | {
      type: 'swap_offer';
      data: {
        offerId: string;          // UUID, not array index
        giveTokenId: number;
        giveAmount: bigint;
        wantTokenId: number;
        wantAmount: bigint;       // at this ratio
        // Explicit limit price in ORDERBOOK_PRICE_SCALE ticks (quote per 1 base).
        // Kept optional for backwards compatibility with older scenarios.
        priceTicks?: bigint;
        timeInForce?: 0 | 1 | 2;  // 0 = GTC, 1 = IOC, 2 = FOK
        minFillRatio: number;     // 0-65535 (uint16), minimum partial fill
        crossJurisdiction?: CrossJurisdictionSwapRoute;
      };
    }
  | {
      // Maker proposes cancellation; counterparty/hub resolves via swap_resolve.
      type: 'swap_cancel_request';
      data: {
        offerId: string;
      };
    }
  | {
      type: 'swap_resolve';
      data: {
        offerId: string;
        fillRatio: number;        // Coarse 0-65535 compatibility/dispute ratio.
        fillNumerator?: bigint;   // Exact fill ratio numerator.
        fillDenominator?: bigint; // Exact fill ratio denominator.
        cancelRemainder: boolean; // true = fill + cancel, false = fill + keep open
        comment?: string;
        feeTokenId?: number;
        feeAmount?: bigint;
        // Optional exact execution amounts from orderbook fills.
        // Settlement uses these amounts directly.
        executionGiveAmount?: bigint;
        executionWantAmount?: bigint;
        // Canonical resting offer state from the matcher/book.
        // Used to keep partial-fill remainder math identical to the book view.
        // These fields also let the UI reconstruct closed-order history even if
        // the original swap_offer frame has aged out of the short frameHistory window.
        restingGiveTokenId?: number;
        restingWantTokenId?: number;
        restingPriceTicks?: bigint;
        restingGiveAmount?: bigint;
        restingWantAmount?: bigint;
        restingQuantizedGive?: bigint;
        restingQuantizedWant?: bigint;
      };
    }
  | {
      type: 'cross_swap_fill_ack';
      data: {
        offerId: string;
        fillSeq?: number;
        incrementalSourceAmount?: bigint;
        incrementalTargetAmount?: bigint;
        cumulativeSourceAmount?: bigint;
        cumulativeTargetAmount?: bigint;
        cumulativeFillRatio: number; // Coarse 0-65535 compatibility/dispute ratio.
        fillNumerator?: bigint;
        fillDenominator?: bigint;
        executionSourceAmount?: bigint;
        executionTargetAmount?: bigint;
        priceImprovementMode?: 'source_savings' | 'target_bonus' | 'none';
        priceImprovementAmount?: bigint;
        priceImprovementTokenId?: number;
        cancelRemainder?: boolean;
        comment?: string;
        priceTicks?: bigint;
        pairId?: string;
      };
    }
  // === SETTLEMENT HOLD TYPES (ring-fencing via bilateral consensus) ===
  | {
      type: 'settle_hold';
      data: {
        workspaceVersion: number;  // Which workspace version this hold is for
        diffs: Array<{
          tokenId: number;
          leftWithdrawing: bigint;   // Amount left is withdrawing (from leftDiff < 0)
          rightWithdrawing: bigint;  // Amount right is withdrawing (from rightDiff < 0)
        }>;
      };
    }
  | {
      type: 'settle_release';
      data: {
        workspaceVersion: number;  // Which workspace version to release holds for
        diffs: Array<{
          tokenId: number;
          leftWithdrawing: bigint;
          rightWithdrawing: bigint;
        }>;
      };
    }
  | {
      type: 'reopen_disputed';
      data: {
        onChainNonce: number;
      };
    }
  | {
      type: 'j_event_claim';
      data: {
        jHeight: number;
        jBlockHash: string;
        events: JurisdictionEvent[];
        observedAt: number;
      };
    };

// ═══════════════════════════════════════════════════════════════════════════
// J-BLOCK CONSENSUS (Multi-signer agreement on J-machine state)
// ═══════════════════════════════════════════════════════════════════════════
//
