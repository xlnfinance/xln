/**
 * Account types - bilateral 2-of-2 consensus machines
 */

import type { EntityId, TokenId, LockId } from '../ids';
import type { HankoString } from './core';
import type { SettlementWorkspace, SettlementDiff, HtlcLock, SwapOffer } from './settlement';
import type { JurisdictionEvent } from './jurisdiction';

// ═══════════════════════════════════════════════════════════════
// DELTA (Per-token bilateral state)
// ═══════════════════════════════════════════════════════════════

// Delta structure for per-token account state (based on old_src)
export interface Delta {
  tokenId: TokenId;
  collateral: bigint;
  ondelta: bigint; // On-chain delta
  offdelta: bigint; // Off-chain delta
  leftCreditLimit: bigint;
  rightCreditLimit: bigint;
  leftAllowance: bigint;
  rightAllowance: bigint;

  // HTLC holds (capacity locked in pending HTLCs)
  leftHtlcHold?: bigint;  // Left's outgoing HTLC holds
  rightHtlcHold?: bigint; // Right's outgoing HTLC holds

  // Swap holds (capacity locked in pending swap offers)
  leftSwapHold?: bigint;  // Left's locked swap offer amounts
  rightSwapHold?: bigint; // Right's locked swap offer amounts

  // Settlement holds (ring-fenced during settlement negotiation)
  // Set on workspace propose, cleared on finalize or reject
  // Prevents double-spend: entity can't withdraw what's promised in settlement
  leftSettleHold?: bigint;   // Left's pending settlement withdrawal
  rightSettleHold?: bigint;  // Right's pending settlement withdrawal
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
  ascii: string; // ASCII visualization from deriveDelta (like old_src)
}

// ═══════════════════════════════════════════════════════════════
// ACCOUNT MACHINE (Bilateral state machine)
// ═══════════════════════════════════════════════════════════════

/** Bundled proposal state - couples fields that must exist/not-exist together */
export interface ProposalState {
  pendingFrame: AccountFrame;
  pendingSignatures: string[];
  pendingAccountInput: AccountInput;
  clonedForValidation?: AccountMachine;
}

export interface AccountMachine {
  // CANONICAL REPRESENTATION (like Channel.ts - both entities store IDENTICAL structure)
  leftEntity: EntityId;   // Lower entity ID (canonical left)
  rightEntity: EntityId;  // Higher entity ID (canonical right)

  mempool: AccountTx[]; // Unprocessed account transactions
  currentFrame: AccountFrame; // Current agreed state (includes full transaction history for replay/audit)

  // Per-token delta states (giant per-token table like old_src)
  deltas: Map<TokenId, Delta>; // tokenId -> Delta

  // HTLC state (conditional payments)
  locks: Map<LockId, HtlcLock>; // lockId → lock details

  // Swap offers (limit orders)
  swapOffers: Map<string, SwapOffer>; // offerId → offer details

  // Global credit limits (in reference currency - USDC)
  globalCreditLimits: {
    ownLimit: bigint; // How much credit we extend to counterparty (USD)
    peerLimit: bigint; // How much credit counterparty extends to us (USD)
  };

  // Frame-based consensus (like old_src Channel, consistent with entity frames)
  currentHeight: number; // Renamed from currentFrameId for S/E/A consistency
  proposal?: ProposalState; // Bundled pending proposal (frame + sigs + input + clone)

  // Rollback support for bilateral disagreements
  rollbackCount: number;
  lastRollbackFrameHash?: string; // Track last rollback to prevent duplicate increments

  // Bilateral J-event consensus (2-of-2 agreement on jurisdiction events)
  leftJObservations: Array<{ jHeight: number; jBlockHash: string; events: any[]; observedAt: number }>;
  rightJObservations: Array<{ jHeight: number; jBlockHash: string; events: any[]; observedAt: number }>;
  jEventChain: Array<{ jHeight: number; jBlockHash: string; events: any[]; finalizedAt: number }>;
  lastFinalizedJHeight: number;

  // Removed isProposer - use isLeft() function like old_src Channel.ts instead

  // Proof structures for dispute resolution
  proofHeader: {
    fromEntity: string; // Our entity ID
    toEntity: string; // Counterparty entity ID
    cooperativeNonce: number;
    disputeNonce: number;
  };
  // Simple proofBody for internal use (computed on demand from deltas/locks/swapOffers)
  proofBody: {
    tokenIds: number[];
    deltas: bigint[];
    // HTLC transformers (like 2024 subcontracts - sorted by deltaIndex)
    htlcLocks?: Array<{
      deltaIndex: number;       // Index in tokenIds array
      amount: bigint;
      revealedUntilBlock: number; // revealBeforeHeight
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
  currentDisputeProofCooperativeNonce?: number;        // Cooperative nonce used in currentDisputeProofHanko
  currentDisputeProofBodyHash?: string;                // ProofBodyHash used in currentDisputeProofHanko
  counterpartyDisputeProofHanko?: HankoString;         // Their hanko on dispute proof (ready for disputes)
  counterpartyDisputeProofCooperativeNonce?: number;   // Cooperative nonce used in counterpartyDisputeProofHanko
  counterpartyDisputeProofBodyHash?: string;           // ProofBodyHash that counterparty signed (MUST match dispute)
  counterpartySettlementHanko?: HankoString;           // Their hanko on settlement operations
  disputeProofNoncesByHash?: Record<string, number>;   // ProofBodyHash → cooperative nonce (local + counterparty)
  disputeProofBodiesByHash?: Record<string, any>;      // ProofBodyHash → ProofBodyStruct (for dispute finalize)

  // ON-CHAIN SETTLEMENT NONCE: Tracks the cooperativeNonce stored on-chain
  // Starts at 0, incremented when settlement succeeds (NOT on R2C)
  // DISTINCT from proofHeader.cooperativeNonce (which is local-only frame consensus)
  // SYMMETRIC: Both sides increment via workspace status check in j-events.ts
  onChainSettlementNonce: number;

  // SETTLEMENT WORKSPACE: Structured negotiation area (replaces legacy fields)
  settlementWorkspace?: SettlementWorkspace;

  // Active dispute state (set after disputeStart, needed for disputeFinalize)
  activeDispute?: {
    startedByLeft: boolean;           // Who initiated dispute (from on-chain)
    initialProofbodyHash: string;     // Hash committed in disputeStart
    initialDisputeNonce: number;      // Dispute nonce from disputeStart
    disputeTimeout: number;           // Block number when timeout expires
    initialCooperativeNonce: number;  // Cooperative nonce PASSED to disputeStart (for hash match)
    onChainCooperativeNonce: number;  // On-chain nonce (may differ from initial)
    initialArguments?: string;        // On-chain initialArguments from disputeStart
  };

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
  requestedRebalance: Map<TokenId, bigint>; // tokenId → amount entity wants rebalanced (credit→collateral)
}

// ═══════════════════════════════════════════════════════════════
// ACCOUNT FRAME (Agreed bilateral state)
// ═══════════════════════════════════════════════════════════════

// Account frame structure for bilateral consensus (renamed from AccountBlock)
export interface AccountFrame {
  height: number; // Renamed from frameId for S/E/A consistency
  timestamp: number;
  jHeight: number; // J-machine height agreed for HTLC deadline checks
  accountTxs: AccountTx[]; // Renamed from transitions
  prevFrameHash: string; // Hash of previous frame (creates chain linkage, not state linkage)
  stateHash: string;
  byLeft?: boolean; // Who proposed this frame (left or right entity)
  tokenIds: number[]; // Array of token IDs in this frame
  deltas: bigint[]; // Array of deltas corresponding to tokenIds (ondelta+offdelta for quick access)
  fullDeltaStates?: Delta[]; // OPTIONAL: Full delta objects (includes credit limits, allowances, collateral)
}

// ═══════════════════════════════════════════════════════════════
// ACCOUNT INPUT (Discriminated union for bilateral consensus)
// ═══════════════════════════════════════════════════════════════

// AccountInput - Maps 1:1 to Channel.ts FlushMessage (frame-level consensus ONLY)
// AccountInput base fields shared by all variants
interface AccountInputBase {
  fromEntityId: string;
  toEntityId: string;
  disputeProofNonce?: number;
}

// Proposal: We propose a new bilateral frame
export interface AccountInputProposal extends AccountInputBase {
  type: 'proposal';
  height: number;
  newAccountFrame: AccountFrame;
  newHanko: HankoString;
  newDisputeHanko?: HankoString;
  newDisputeHash?: string;
  newDisputeProofBodyHash?: string;
  newSettlementHanko?: HankoString;
}

// ACK: We acknowledge their frame (optionally batched with our new proposal)
export interface AccountInputAck extends AccountInputBase {
  type: 'ack';
  height: number;
  prevHanko: HankoString;
  // Optional batched proposal (ACK + new frame in one message):
  newAccountFrame?: AccountFrame;
  newHanko?: HankoString;
  newDisputeHanko?: HankoString;
  newDisputeHash?: string;
  newDisputeProofBodyHash?: string;
  newSettlementHanko?: HankoString;
}

// Settlement: Bilateral settlement negotiation action
export interface AccountInputSettlement extends AccountInputBase {
  type: 'settlement';
  settleAction: {
    type: 'propose' | 'update' | 'approve' | 'execute' | 'reject';
    diffs?: SettlementDiff[];
    forgiveTokenIds?: number[];
    hanko?: HankoString;
    memo?: string;
    version?: number;
  };
}

// Discriminated union - replaces flat AccountInput
export type AccountInput = AccountInputProposal | AccountInputAck | AccountInputSettlement;

// ═══════════════════════════════════════════════════════════════
// ACCOUNT TRANSACTIONS
// ═══════════════════════════════════════════════════════════════

// Account transaction types
export type AccountTx =
  | { type: 'account_payment'; data: { tokenId: number; amount: bigint } }
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
  // === SWAP TRANSACTION TYPES ===
  | {
      type: 'swap_offer';
      data: {
        offerId: string;          // UUID, not array index
        giveTokenId: number;
        giveAmount: bigint;
        wantTokenId: number;
        wantAmount: bigint;       // at this ratio
        minFillRatio: number;     // 0-65535 (uint16), minimum partial fill
      };
    }
  | {
      type: 'swap_cancel';
      data: {
        offerId: string;
      };
    }
  | {
      type: 'swap_resolve';
      data: {
        offerId: string;
        fillRatio: number;        // 0-65535 (uint16)
        cancelRemainder: boolean; // true = fill + cancel, false = fill + keep open
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
      type: 'j_sync';
      data: {
        jBlockNumber: number;  // Block number from j-machine (both sides must match)
        tokenId: number;
        collateral: bigint;    // Absolute collateral from j-event
        ondelta: bigint;       // Absolute ondelta from j-event
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

// ═══════════════════════════════════════════════════════════════
// ACCOUNT EVENTS (bubbled up from A-layer to E-layer)
// ═══════════════════════════════════════════════════════════════

/**
 * Account Events - Bubbled up from A-layer to E-layer
 * Used for routing (HTLC secrets) and matching (swap offers)
 */
export type AccountEvent =
  | { type: 'htlc_revealed'; hashlock: string; secret: string }
  | { type: 'swap_offer_created'; offerId: string; makerId: string; accountId: string; giveTokenId: number; giveAmount: bigint; wantTokenId: number; wantAmount: bigint; minFillRatio: number }
  | { type: 'swap_offer_cancelled'; offerId: string; accountId: string };
