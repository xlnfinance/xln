/**
 * Entity types - BFT consensus state machines
 */

import type { AccountKey, SignerId } from '../ids';
import type { ConsensusConfig, HankoString, HashToSign } from './core';
import type { Proposal } from './governance';
import type { AccountMachine, AccountInput } from './account';
import type { HtlcRoute, SwapBookEntry, LockBookEntry } from './settlement';
import type { JBlockObservation, JBlockFinalized, JurisdictionEventData, JInput } from './jurisdiction';

// ═══════════════════════════════════════════════════════════════
// ENTITY STATE
// ═══════════════════════════════════════════════════════════════

export interface EntityState {
  entityId: string; // The entity ID this state belongs to
  height: number;
  timestamp: number;
  nonces: Map<SignerId, number>;
  messages: string[];
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;
  prevFrameHash?: string; // Chain linkage for BFT consensus (keccak256 of previous frame)

  // 💰 Financial state
  reserves: Map<string, bigint>; // tokenId -> amount only, metadata from TOKEN_REGISTRY
  accounts: Map<AccountKey, AccountMachine>; // canonicalKey "left:right" -> account state
  // Account frame scheduling (accounts blocked by pendingFrame, retried on next ACK)
  deferredAccountProposals?: Map<AccountKey, true>;
  // 🔭 J-machine tracking (JBlock consensus)
  lastFinalizedJHeight: number;           // Last finalized J-block height
  jBlockObservations: JBlockObservation[]; // Pending observations from signers
  jBlockChain: JBlockFinalized[];          // Finalized J-blocks (prunable)

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

  // 🔐 Cryptography - RSA-OAEP keys for HTLC envelope encryption
  cryptoPublicKey?: string;  // Base64 RSA-OAEP public key (shareable)
  cryptoPrivateKey?: string; // Base64 RSA-OAEP private key (secret, encrypt at rest in prod)

  // 🔒 HTLC Routing - Multi-hop payment tracking (like 2024 hashlockMap)
  htlcRoutes: Map<string, HtlcRoute>; // hashlock → routing context
  htlcFeesEarned: bigint; // Running total of HTLC routing fees collected

  // 💳 Debts - amounts owed to creditors (from FIFO queue)
  debts?: Array<{
    creditor: string;
    tokenId: number;
    amount: bigint;
    index: number;
  }>;

  // 📊 Orderbook Extension - Hub matching engine (typed in orderbook/types.ts)
  orderbookExt?: any; // OrderbookExtState - avoid circular import

  // 📖 Aggregated Books - E-Machine view of all A-Machine positions
  // Mirrors A-Machine state for easy UI access, updated on frame commits
  swapBook: Map<string, SwapBookEntry>;  // offerId → entry
  lockBook: Map<string, LockBookEntry>;  // lockId → entry

  // 📈 Pending swap fill ratios (orderbook → dispute arguments)
  pendingSwapFillRatios?: Map<string, number>; // key = "accountId:offerId"
}

// ═══════════════════════════════════════════════════════════════
// ENTITY TRANSACTIONS
// ═══════════════════════════════════════════════════════════════

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
      data: { action: import('./governance').ProposalAction; proposer: string };
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
      data: {
        targetEntityId: string;
        creditAmount?: bigint;  // Optional: extend credit in same frame as add_delta
        tokenId?: number;       // Token for credit (default: 1 = USDC)
      };
    }
  | {
      type: 'j_event_account_claim';
      data: {
        counterpartyEntityId: string; // Which account this observation is for
        jHeight: number;
        jBlockHash: string;
        events: any[];
        observedAt: number;
      };
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
      type: 'htlcPayment';
      data: {
        targetEntityId: string;
        tokenId: number;
        amount: bigint;
        route: string[]; // Full path from source to target
        description?: string;
        secret?: string;   // Optional - generated if not provided
        hashlock?: string; // Optional - generated if not provided
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
        sig: string; // Hanko signature from counterparty
        description?: string; // e.g., "Fund collateral from reserve"
      };
    }
  | {
      type: 'disputeStart';
      data: {
        counterpartyEntityId: string;
        description?: string;
      };
    }
  | {
      type: 'disputeFinalize';
      data: {
        counterpartyEntityId: string;
        cooperative?: boolean;  // If true, use cooperative finalization
        useOnchainRegistry?: boolean; // Optional HTLC reveal via on-chain registry
        description?: string;
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
      // J-Clear-Batch: Manually clear pending jBatch (abort stuck batch)
      // Use when: batch rejected by J-machine, want to build fresh batch
      type: 'j_clear_batch';
      data: {
        reason?: string; // Optional reason for clearing (audit trail)
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
    }
  | {
      // Place swap offer in bilateral account (user → hub)
      type: 'placeSwapOffer';
      data: {
        counterpartyEntityId: string; // Hub
        offerId: string;
        giveTokenId: number;
        giveAmount: bigint;
        wantTokenId: number;
        wantAmount: bigint;
        minFillRatio: number; // 0-65535
      };
    }
  | {
      // Resolve swap offer in bilateral account (hub → user)
      type: 'resolveSwap';
      data: {
        counterpartyEntityId: string; // User who placed the offer
        offerId: string;
        fillRatio: number; // 0-65535
        cancelRemainder: boolean;
      };
    }
  | {
      // Cancel swap offer (user cancels their own offer)
      type: 'cancelSwap';
      data: {
        counterpartyEntityId: string;
        offerId: string;
      };
    }
  | {
      // Initialize orderbook extension (hub only)
      type: 'initOrderbookExt';
      data: {
        name: string;
        spreadDistribution: {
          makerBps: number;
          takerBps: number;
          hubBps: number;
          makerReferrerBps: number;
          takerReferrerBps: number;
        };
        referenceTokenId: number;
        minTradeSize: bigint;
        supportedPairs: string[];
      };
    }
  | {
      // Mint reserves (admin/test only - creates reserves via J-layer)
      type: 'mintReserves';
      data: {
        tokenId: number;
        amount: bigint;
      };
    }
  | {
      // Create settlement batch (builds settlement in jBatch)
      type: 'createSettlement';
      data: {
        counterpartyEntityId: string;
        diffs: Array<{
          tokenId: number;
          leftDiff: bigint;
          rightDiff: bigint;
          collateralDiff: bigint;
          ondeltaDiff: bigint;
        }>;
        sig: string; // Hanko signature from counterparty (required for cooperative settlement)
      };
    }
  // ═══════════════════════════════════════════════════════════════
  // SETTLEMENT WORKSPACE OPERATIONS
  // ═══════════════════════════════════════════════════════════════
  | {
      // Propose new settlement (creates workspace)
      type: 'settle_propose';
      data: {
        counterpartyEntityId: string;
        diffs: Array<{
          tokenId: number;
          leftDiff: bigint;
          rightDiff: bigint;
          collateralDiff: bigint;
          ondeltaDiff: bigint;
        }>;
        forgiveTokenIds?: number[];
        memo?: string;
      };
    }
  | {
      // Update existing settlement workspace (replaces diffs)
      type: 'settle_update';
      data: {
        counterpartyEntityId: string;
        diffs: Array<{
          tokenId: number;
          leftDiff: bigint;
          rightDiff: bigint;
          collateralDiff: bigint;
          ondeltaDiff: bigint;
        }>;
        forgiveTokenIds?: number[];
        memo?: string;
      };
    }
  | {
      // Approve settlement (sign + bump coopNonce)
      type: 'settle_approve';
      data: {
        counterpartyEntityId: string;
      };
    }
  | {
      // Execute approved settlement (adds to jBatch)
      type: 'settle_execute';
      data: {
        counterpartyEntityId: string;
      };
    }
  | {
      // Reject/cancel settlement workspace
      type: 'settle_reject';
      data: {
        counterpartyEntityId: string;
        reason?: string;
      };
    }
  // ═══════════════════════════════════════════════════════════════
  // DEBUG/TEST OPERATIONS
  // ═══════════════════════════════════════════════════════════════
  | {
      // Process expired HTLC locks (timeout test)
      type: 'processHtlcTimeouts';
      data: {
        expiredLocks?: Array<{ accountId: string; lockId: string }>;
      };
    }
  | {
      // Rollback timed-out pending frames and cancel HTLC locks backward
      type: 'rollbackTimedOutFrames';
      data: {
        timedOutAccounts: Array<{ counterpartyId: string; frameHeight: number }>;
      };
    }
  | {
      // Manual HTLC lock creation without envelope (timeout test)
      type: 'manualHtlcLock';
      data: {
        counterpartyId: string;
        lockId: string;
        hashlock: string;
        timelock: bigint;
        revealBeforeHeight: number;
        amount: bigint;
        tokenId: number;
      };
    }
  // ═══════════════════════════════════════════════════════════════
  // SWAP OPERATIONS (ALIASES)
  // ═══════════════════════════════════════════════════════════════
  | {
      // Fill swap offer (alias for resolveSwap)
      type: 'fillSwapOffer';
      data: {
        counterpartyId: string;
        offerId: string;
        fillRatio: number;
      };
    }
  | {
      // Cancel swap offer (alias for cancelSwap)
      type: 'cancelSwapOffer';
      data: {
        counterpartyEntityId: string;
        offerId: string;
      };
    }
  // ═══════════════════════════════════════════════════════════════
  // RESERVE OPERATIONS
  // ═══════════════════════════════════════════════════════════════
  | {
      // Direct R2R transfer: from entity reserve to target entity's reserve
      type: 'payFromReserve';
      data: {
        targetEntityId: string;
        tokenId: number;
        amount: bigint;
      };
    }
  | {
      // Fund entity: add tokens to reserve (mint-like operation)
      type: 'payToReserve';
      data: {
        tokenId: number;
        amount: bigint;
      };
    };

// ═══════════════════════════════════════════════════════════════
// ENTITY INPUT / OUTPUT (BFT consensus messages)
// ═══════════════════════════════════════════════════════════════

export interface EntityInput {
  entityId: string;
  entityTxs?: EntityTx[];
  proposedFrame?: ProposedEntityFrame;

  // HANKO PRECOMMITS: signerId -> array of EOA sigs (one per proposedFrame.hashesToSign[])
  // Validators sign ALL hashes, proposer collects and merges into hankos after threshold
  hashPrecommits?: Map<string, string[]>;
}

/**
 * Transport envelope for REA-bound entity inputs.
 * signerId/runtimeId are routing hints and MUST NOT be used by deterministic REA logic.
 */
export interface RoutedEntityInput extends EntityInput {
  signerId?: string;
  runtimeId?: string;
}

/** Entity output - can include both E→E messages AND J-layer outputs */
export interface EntityOutput {
  entityInputs: RoutedEntityInput[];  // E→E messages
  jInputs: JInput[];             // E→J messages (batches to queue)
}

// ═══════════════════════════════════════════════════════════════
// ENTITY FRAMES & REPLICAS
// ═══════════════════════════════════════════════════════════════

export interface ProposedEntityFrame {
  height: number;
  txs: EntityTx[];
  hash: string;
  newState: EntityState;

  // DETERMINISTIC OUTPUTS: Stored at proposal time, used at commit time
  // CRITICAL: Cannot re-apply frame at commit because proposal.newState already
  // has mutations applied (e.g., openAccount creates account). Idempotent handlers
  // would return empty outputs on re-application. Store once, attach hankos at commit.
  outputs?: EntityInput[];
  jOutputs?: JInput[];

  // HANKO SYSTEM:
  // 1. During frame creation: proposer collects hashes that need signing
  hashesToSign?: HashToSign[];  // Entity frame hash + account-level hashes with types

  // 2. During precommit: validators send EOA signatures (one per hash)
  // signerId -> array of EOA signatures (indexes match hashesToSign[])
  collectedSigs?: Map<string, string[]>;

  // 3. After threshold: merged quorum hankos (one per hash, indexes match hashesToSign[])
  hankos?: HankoString[];
}

export interface EntityReplica {
  entityId: string;
  signerId: string;
  state: EntityState;
  mempool: EntityTx[];
  proposal?: ProposedEntityFrame;
  lockedFrame?: ProposedEntityFrame; // Frame this validator is locked/precommitted to
  // SECURITY: Validator's own computed state from applying proposer's txs
  // Used at commit time instead of proposer's newState to prevent state injection
  validatorComputedState?: EntityState;
  isProposer: boolean;
  // Position is RELATIVE to j-machine (jurisdiction)
  // Frontend calculates: worldPos = jMachine.position + relativePosition
  position?: {
    x: number;      // Relative X offset from j-machine center
    y: number;      // Relative Y offset from j-machine center
    z: number;      // Relative Z offset from j-machine center
    jurisdiction?: string; // Which j-machine this entity belongs to (defaults to activeJurisdiction)
    xlnomy?: string; // DEPRECATED: Use jurisdiction instead
  };

  // HANKO WITNESS STORAGE (NOT part of state hash - stored alongside, not inside)
  // Persists finalized hankos for on-chain disputes, settlements, batch submissions
  hankoWitness?: Map<string, {
    hanko: HankoString;
    type: 'accountFrame' | 'dispute' | 'profile' | 'settlement' | 'jBatch';
    entityHeight: number;  // Height when created
    createdAt: number;     // Timestamp
  }>;
}
