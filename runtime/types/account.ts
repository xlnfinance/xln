import type { CrossJurisdictionCloseProof, CrossJurisdictionPullBinding, CrossJurisdictionSwapRoute } from './cross-jurisdiction';
import type { HankoString } from './hanko';
import type { JurisdictionEvent } from './jurisdiction-events';
import type { PaymentDeliveryMode } from './payment';
import type { LendingTermId } from './lending';
import type { DisputeArgumentSnapshot } from '../protocol/dispute/arguments';
import type {
  AccountRebalanceShadowState,
  BilateralRebalanceFeePolicy,
  RebalanceRequestFeeState,
} from './rebalance';
import type { AccountJClaimAccumulatorState, AccountJClaimProof } from './account-j-claims';

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

  /**
   * Integrity binding for the encrypted onion carried by the signed AccountTx.
   * The full ciphertext is transient frame input and must not inflate durable
   * Account state.
   */
  envelopeHash?: string;

  /** Opaque beneficiary offer, decryptable only by the payer's default proposer. */
  secretOffer?: import('../protocol/htlc/multi-recipient').MultiRecipientCiphertext;
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
  originalGiveAmount?: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  originalWantAmount?: bigint;
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
  /** Exact opaque offer accepted by a durable outbound Account frame. */
  acceptedOfferHash?: string;
  acceptedAccountFrameHash?: string;
  acceptedAccountFrameHeight?: number;
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
  targetSignerId?: string;
  targetCounterpartyEntityId: string;
  targetLockId: string;
}

/** End-to-end payment notes stored locally by hashlock/lockId for activity rendering. */
export type HtlcNoteKey = `hashlock:${string}` | `lock:${string}`;

export type AccountStatus = 'active' | 'dispute_preparing' | 'disputed';

export interface AccountRejectedFrameEvidence {
  reason: string;
  frame: AccountFrame;
  frameHanko: HankoString;
}

export interface AccountSubcontract {
  transformerAddress: string;
  encodedBatch: string;
  allowances: Array<{
    deltaIndex: number;
    rightAllowance: bigint;
    leftAllowance: bigint;
  }>;
  // Runtime arguments are late adversarial evidence. Only optional commitments
  // belong to mutually signed account state; raw secrets stay outside it.
  leftArgumentsHash?: string;
  rightArgumentsHash?: string;
}

export type AccountLendingIntentKind =
  | 'fund'
  | 'borrow'
  | 'repay'
  | 'credit-grant'
  | 'credit-revoke'
  | 'close-request'
  | 'close-payout';

/** Immutable jurisdiction-stack identity shared by both Account replicas. */
export type AccountStateDomain = {
  chainId: number;
  depositoryAddress: string;
};

export interface AccountMachine {
  // CANONICAL REPRESENTATION (like Channel.ts - both entities store IDENTICAL structure)
  leftEntity: string;   // Lower entity ID (canonical left)
  rightEntity: string;  // Higher entity ID (canonical right)
  domain: AccountStateDomain; // Committed locally, then carried by every bilateral input
  watchSeed: string;    // 32-byte shared account seed revealed only when a dispute starts
  status: AccountStatus; // Manual lifecycle gate for dispute freeze/reopen

  mempool: AccountTx[]; // Unprocessed account transactions
  currentFrame: AccountFrame; // Latest finalized bilateral frame; older frames live in the frame DB.

  // Per-token delta states (giant per-token table like old_src)
  deltas: Map<number, Delta>; // tokenId -> Delta

  // HTLC state (conditional payments)
  locks: Map<string, HtlcLock>; // lockId → lock details

  // Swap offers (limit orders)
  swapOffers: Map<string, SwapOffer>; // offerId → offer details
  pulls?: Map<string, PullCommitment>; // pullId → ratio-gated pull details
  subcontracts?: Map<string, AccountSubcontract>; // custom DeltaTransformer clauses
  // Bilateral idempotency receipts for lending extension commands. Financial
  // effects and these receipts commit in the same Account frame, so replaying
  // an intent can never move money twice.
  lendingIntents?: Map<string, AccountLendingIntentKind>;
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
  pendingAccountInput?: Extract<AccountInput, { kind: 'frame' | 'frame_ack' }>; // Cached outbound frame input for resend/nudge
  // Validator-local exact replica route chosen when pendingAccountInput was
  // emitted. It is persisted for restart-safe resend but excluded from Entity
  // consensus roots because local key/profile availability can differ.
  pendingAccountInputSignerId?: string;
  lastOutboundFrameAck?: {
    height: number;
    counterpartyEntityId: string;
    response: Extract<AccountInput, { kind: 'ack' }>;
  };

  // Rollback support for bilateral disagreements
  rollbackCount: number;
  lastRollbackFrameHash?: string; // Track last rollback to prevent duplicate increments

  // Bilateral J-event consensus. Only authenticated pending roots are state;
  // finalized bodies have already been applied and belong in the frame DB UI view.
  leftPendingJClaims: AccountJClaimAccumulatorState;
  rightPendingJClaims: AccountJClaimAccumulatorState;
  lastFinalizedJHeight: number;

  // Removed isProposer - use isLeft() function like old_src Channel.ts instead

  // Cloned state for validation before committing (replaces dryRun)
  clonedForValidation?: AccountMachine;

  // Proof structures for dispute resolution
  proofHeader: {
    fromEntity: string; // Our entity ID
    toEntity: string; // Counterparty entity ID
    nextProofNonce: number; // Next nonce reserved for a fresh dispute proof.
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
  /** One bounded, consensus-visible reminder that this Account still needs the active board seal. */
  boardResealMigration?: AccountBoardResealMigration;
  counterpartyBoardReseal?: {
    activationJHeight: number;
    activationLogIndex: number;
    frameHeight: number;
    frameHash: string;
  };

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
    /** Cross-Entity book rows that must confirm removal before disputeStart. */
    pendingOrderbookRemovalIds?: string[];
    /** Exact start request retained until every asynchronous cleanup ACK commits. */
    startIntent?: {
      crossJurisdictionRouteId?: string;
      starterInitialArguments?: string;
      description?: string;
      allowUnsafeCrossJTargetDispute?: boolean;
      acceptedCrossJTargetLossAmount?: bigint;
    };
  };

  // ON-CHAIN NONCE: Tracks the nonce stored on-chain
  // Starts at 0, set to signedNonce when settlement/dispute succeeds
  // DISTINCT from proofHeader.nextProofNonce (which tracks what value to use next)
  jNonce: number;

  // SETTLEMENT WORKSPACE: Structured negotiation area
  settlementWorkspace?: SettlementWorkspace;

  // Active dispute state (set after disputeStart, needed for disputeFinalize)
  activeDispute?: {
    startedByLeft: boolean;           // Who initiated dispute (from on-chain)
    initialProofbodyHash: string;     // Hash committed in disputeStart
    initialNonce: number;             // Unified nonce from disputeStart (replaces initialDisputeNonce)
    disputeTimeout: number;           // Block number when timeout expires
    jNonce: number;             // On-chain nonce at dispute start (replaces initialCooperativeNonce + onChainCooperativeNonce)
    starterInitialArguments: string;  // Starter-side args for initial proof
    starterIncrementedArguments: string;  // Starter-side args for the one known newer proof, or 0x
    observedOnChain?: boolean;        // false for local placeholder, true after DisputeStarted J-event
    observedBlockNumber?: number;     // J block where DisputeStarted was observed
    batchNonce?: number;              // Hanko batch nonce observed with DisputeStarted when available
    finalizeQueued?: boolean;         // Finalize op already queued locally (single-source lifecycle guard)
  };

  hankoSignature?: string; // Latest generated account proof hanko.

  // Payment routing: locally derived follow-ups for every routed payment in a
  // committed Account frame. This must remain an ordered list: byte-identical
  // payments are independent signed intents and must never be deduplicated.
  pendingForwards?: Array<{
    tokenId: number;
    amount: bigint;
    route: string[];
    description?: string;
    deliveryMode?: Extract<PaymentDeliveryMode, 'trusted'>;
    trustedGatewayEntityId?: string;
  }>;

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
  rebalanceFeePolicies?: Map<number, BilateralRebalanceFeePolicy>;

  // Entity-private automation state. It is persisted and committed by the
  // owning Entity machine, but excluded from the bilateral Account root and
  // never sent to the counterparty.
  shadow: {
    rebalance: AccountRebalanceShadowState;
    rejectedFrameEvidence?: AccountRejectedFrameEvidence;
  };
}

export type AccountBoardResealMigration = {
  activationJHeight: number;
  activationLogIndex: number;
  reason:
    | 'pending'
    | 'account-identity-invalid'
    | 'bilateral-frame-uncertified'
    | 'certified-frame-invalid'
    | 'bilateral-dispute-uncertified'
    | 'certified-dispute-invalid'
    | 'output-route-unavailable';
};

// Account frame structure for bilateral consensus (renamed from AccountBlock)
export interface AccountFrame {
  height: number; // Renamed from frameId for S/E/A consistency
  timestamp: number;
  jHeight: number; // J-machine height agreed for HTLC deadline checks
  accountTxs: AccountTx[]; // Renamed from transitions
  prevFrameHash: string; // Hash of previous frame (creates chain linkage, not state linkage)
  accountStateRoot: string; // Canonical RLP/radix-Merkle root of bilateral AccountMachine state
  stateHash: string;
  byLeft?: boolean; // Who proposed this frame (left or right entity)
  // One source of truth for account-frame token state. Compact offdelta arrays
  // and token id arrays are derived by helpers when logs/proofs need them.
  deltas: Delta[];
}

export type AccountFrameDbRecord =
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
  /** Exact cooperative-settlement digest; required for Entity-quorum drafts. */
  settlementHash?: string;
};

type AccountInputBase = {
  fromEntityId: string;
  toEntityId: string;
  domain: AccountStateDomain;
  watchSeed?: string;
};

export type AccountDisputeSeal = {
  /**
   * Absent only while the Account output is an internal Entity-consensus draft.
   * Any routed AccountInput must be sealed before it leaves the committing
   * Entity replica; inbound validation rejects an absent Hanko.
   */
  hanko?: HankoString;
  hash: string;
  proofBodyHash: string;
  proofNonce: number;
};

export type AccountFrameAck = {
  height: number;
  /** Exact Account frame committed by this acknowledgement. */
  frameHash: string;
  /** Internal Entity-consensus draft until the secondary hash reaches quorum. */
  frameHanko?: HankoString;
  disputeSeal?: AccountDisputeSeal;
};

/**
 * Board rotation changes only who may authorize an already-committed Account
 * state. It must never manufacture a new Account frame or consume a dispute
 * nonce, so the exact certified hashes travel in a separate control input.
 */
export type AccountBoardReseal = AccountFrameAck & {
  /** Exact ordered EVM log position of the on-chain board activation. */
  boardActivationJHeight: number;
  boardActivationLogIndex: number;
};

export type AccountFrameProposal = {
  frame: AccountFrame;
  /** Internal Entity-consensus draft until the secondary hash reaches quorum. */
  frameHanko?: HankoString;
  disputeSeal?: AccountDisputeSeal;
};

// Channel.ts flush semantics: one delivery may acknowledge the previous frame
// and propose the next frame. Each state epoch carries its own frame Hanko and
// optional dispute seal. Sharing one seal across ACK + proposal is invalid
// because the two parts commit different account states.
export type AccountInput =
  | (AccountInputBase & {
      kind: 'frame';
      proposal: AccountFrameProposal;
    })
  | (AccountInputBase & {
      kind: 'ack';
      ack: AccountFrameAck;
    })
  | (AccountInputBase & {
      kind: 'frame_ack';
      ack: AccountFrameAck;
      proposal: AccountFrameProposal;
    })
  | (AccountInputBase & {
      kind: 'dispute';
      disputeSeal: AccountDisputeSeal;
    })
  | (AccountInputBase & {
      kind: 'board_reseal';
      reseal: AccountBoardReseal;
    })
  | (AccountInputBase & {
      kind: 'settle';
      settleAction: AccountSettleAction;
      newSettlementHanko?: HankoString;
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
 * 1. An Account settle_transition atomically creates/updates workspace + holds.
 * 2. Each side seals the post-proof; only the non-executor seals settlementHash.
 * 3. Executor submit is an exact hash/version Account transition.
 * 4. Submit releases workspace holds; AccountSettled finality clears the body.
 */
export interface SettlementWorkspace {
  /** Canonical bilateral identity of the exact editable workspace body. */
  workspaceHash: string;
  ops: SettlementOp[];                        // Typed operations (compiled to diffs at approve)
  compiledDiffs?: SettlementDiff[];           // Cached at approve time
  compiledForgiveTokenIds?: number[];         // Cached at approve time

  // Hanko signatures
  leftHanko?: HankoString;                    // Left's signature on settlement
  rightHanko?: HankoString;                   // Right's signature on settlement
  settlementHash?: string;                    // Exact digest sealed by the Entity quorum

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
    disputeHash: string;                      // Exact hash signed by both post-settlement hankos
    proofBodyHash: string;                    // Same as pre-settlement (offdelta unchanged)
    nonce: number;                            // = nonceAtSign + 1 (replaces cooperativeNonce)
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
  | { type: 'swap_offer_created'; offerId: string; makerId: string; accountId: string; giveTokenId: number; giveAmount: bigint; wantTokenId: number; wantAmount: bigint; timeInForce?: 0 | 1 | 2; crossJurisdiction?: CrossJurisdictionSwapRoute }
  | { type: 'swap_offer_cancelled'; offerId: string; accountId: string };

// Account transaction types
export type AccountTx =
  | { type: 'direct_payment'; data: { tokenId: number; amount: bigint; route?: string[]; description?: string; fromEntityId?: string; toEntityId?: string; deliveryMode?: Extract<PaymentDeliveryMode, 'trusted'>; trustedGatewayEntityId?: string } }
  | {
      type: 'lending_fund';
      data: {
        positionId: string;
        hubEntityId: string;
        lenderEntityId: string;
        tokenId: number;
        amount: bigint;
        termId: LendingTermId;
        interestBps: number;
      };
    }
  | {
      type: 'lending_borrow_request';
      data: {
        requestId: string;
        hubEntityId: string;
        borrowerEntityId: string;
        tokenId: number;
        amount: bigint;
        termId: LendingTermId;
        maxInterestBps: number;
      };
    }
  | {
      type: 'lending_repay';
      data: {
        loanId: string;
        hubEntityId: string;
        borrowerEntityId: string;
        tokenId: number;
        amount: bigint;
      };
    }
  | {
      type: 'lending_credit';
      data: {
        action: 'grant' | 'revoke';
        loanId: string;
        hubEntityId: string;
        borrowerEntityId: string;
        tokenId: number;
        creditLimit: bigint;
      };
    }
  | {
      type: 'lending_close_request';
      data: {
        positionId: string;
        hubEntityId: string;
        lenderEntityId: string;
      };
    }
  | {
      type: 'lending_close_payout';
      data: {
        positionId: string;
        hubEntityId: string;
        lenderEntityId: string;
        tokenId: number;
        amount: bigint;
      };
    }
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
      type: 'rebalance_refund';
      data: {
        requestId: string;
        requestTokenId: number;
        amount: bigint;
        reason: 'policy_mismatch' | 'timeout' | 'fee_too_low' | 'manual';
      };
    }
  | {
      type: 'rebalance_policy';
      data: {
        tokenId: number;
        policyVersion: number;
        baseFee: bigint;
        liquidityFeeBps: bigint;
        gasFee: bigint;
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
        deliveryMode?: Exclude<PaymentDeliveryMode, 'trusted'>;
        envelope?: import('../protocol/htlc/envelope').HtlcEnvelope
          | import('../protocol/htlc/multi-recipient').MultiRecipientCiphertext
          | string
          | undefined;
      };
    }
  | {
      type: 'htlc_resolve';
      data:
        | {
            lockId: string;
            outcome: 'offer';
            offer: import('../protocol/htlc/multi-recipient').MultiRecipientCiphertext;
          }
        | {
            lockId: string;
            outcome: 'secret';
            secret: string;
          }
        | {
            lockId: string;
            outcome: 'secret';
            offerHash: string;
          }
        | {
            lockId: string;
            outcome: 'error';
            reason?: string;
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
	        crossJurisdictionRoute?: CrossJurisdictionSwapRoute;
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
        reason?: 'beneficiary_release' | 'expired' | 'cross_j_cancel_no_fill' | 'cross_j_source_remainder_release';
      };
    }
  | {
      type: 'cross_pull_close';
      data: {
        pullId: string;
        binary: string;
        proof: CrossJurisdictionCloseProof;
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
        routeHash?: string;
        previousFillSeq?: number;
        fillSeq?: number;
        incrementalSourceAmount?: bigint;
        incrementalTargetAmount?: bigint;
        cumulativeSourceAmount?: bigint;
        cumulativeTargetAmount?: bigint;
	        cumulativeFillRatio: number; // Coarse 0-65535 compatibility/dispute ratio.
	        fillNumerator?: bigint;
	        fillDenominator?: bigint;
	        ackKind?: 'fill' | 'cancel';
	        executionSourceAmount?: bigint;
        executionTargetAmount?: bigint;
        priceImprovementMode?: 'source_savings';
        priceImprovementAmount?: bigint;
        priceImprovementTokenId?: number;
        cancelRemainder?: boolean;
        comment?: string;
        priceTicks?: bigint;
        pairId?: string;
      };
    }
  // === ATOMIC SETTLEMENT WORKSPACE TRANSITION ===
  | {
      type: 'settle_transition';
      data:
        | {
            kind: 'upsert';
            version: number;
            previousWorkspaceHash?: string;
            ops: SettlementOp[];
            executorIsLeft: boolean;
            memo?: string;
          }
        | {
            kind: 'submit' | 'clear';
            version: number;
            workspaceHash: string;
          }
        | {
            /**
             * One side's exact authorization, ordered by bilateral Account
             * consensus. The elected executor never signs settlementHash; it
             * signs only the post-settlement dispute proof.
             */
            kind: 'seal';
            version: number;
            workspaceHash: string;
            settlementNonce: number;
            settlementHash: string;
            settlementHanko?: HankoString;
            postProof: {
              nonce: number;
              proofBodyHash: string;
              disputeHash: string;
              hanko?: HankoString;
            };
          };
    }
  | {
      type: 'reopen_disputed';
      data: {
        jNonce: number;
      };
    }
  | {
      type: 'j_event_claim';
      data: {
        jHeight: number;
        jBlockHash: string;
        events: JurisdictionEvent[];
        /** Deterministic Patricia witnesses added by the Account proposer. */
        leftProof?: AccountJClaimProof;
        rightProof?: AccountJClaimProof;
      };
    };

// ═══════════════════════════════════════════════════════════════════════════
// J-BLOCK CONSENSUS (Multi-signer agreement on J-machine state)
// ═══════════════════════════════════════════════════════════════════════════
//
