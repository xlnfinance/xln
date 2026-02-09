/**
 * XLN Type Definitions
 * All interfaces and type definitions used across the XLN system
 *
 * ═══════════════════════════════════════════════════════════════════════
 * R→E→A→J ARCHITECTURE (Hierarchical Containment)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The naming reflects CONTAINMENT HIERARCHY (what contains what):
 *
 * Runtime (R) - Top-level coordinator
 *   ├─ Contains: J-replicas (jurisdictions) + E-replicas (entities)
 *   ├─ Responsibilities:
 *   │   - Tick orchestration (100ms discrete steps)
 *   │   - Input routing (entityInputs → E-layer, jInputs → J-layer)
 *   │   - Output merging (prevents same-tick cascades)
 *   │   - Env lifecycle (state, history, snapshots, time machine)
 *   └─ Why "Runtime"?
 *       - It's the runtime environment for all state machines
 *       - Like OS: manages processes (E-replicas), resources (J-state)
 *       - Provides deterministic execution (env.timestamp control)
 *
 * Entity (E) - BFT consensus state machines
 *   ├─ Contains: A-machines (bilateral accounts in entity.state.accounts)
 *   ├─ Responsibilities:
 *   │   - Multi-party consensus (threshold signatures)
 *   │   - Internal governance (proposals, votes)
 *   │   - Account management (owns bilateral relationships)
 *   │   - J-batch accumulation (queue operations for on-chain)
 *   └─ Why Entity-first?
 *       - Entities own accounts (not vice versa)
 *       - Entity = legal/organizational boundary
 *       - Account exists WITHIN entity context
 *
 * Account (A) - Bilateral consensus machines
 *   ├─ Contains: Per-token deltas (giant table, indexed by tokenId)
 *   ├─ Responsibilities:
 *   │   - 2-of-2 signatures (both entities must agree)
 *   │   - Frame-based consensus (propose → sign → commit)
 *   │   - Delta transformations (payments, HTLCs, swaps)
 *   │   - Credit limits (left/right perspective)
 *   └─ Why Account-before-Jurisdiction?
 *       - Accounts are off-chain (high frequency)
 *       - J-layer is final settlement (low frequency)
 *       - A→J not J→A (accounts settle TO jurisdiction)
 *
 * Jurisdiction (J) - EVM settlement layer
 *   ├─ Contains: On-chain state (reserves, collaterals, EVM contracts)
 *   ├─ Responsibilities:
 *   │   - Mempool (batches pending execution)
 *   │   - Block processing (executes batches after blockDelayMs)
 *   │   - FIFO debt enforcement (enforceDebts on reserve updates)
 *   │   - Final truth (on-chain state root)
 *   └─ Why Jurisdiction-last?
 *       - Slowest layer (block time delay)
 *       - Highest finality (on-chain proof)
 *       - Other layers settle TO it (terminal layer)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY R→E→A→J (Not J→E→A→R or E→A→J→R)?
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. CONTAINMENT HIERARCHY:
 *    Runtime contains {jReplicas, eReplicas}
 *    Entity contains {accounts}
 *    Account contains {deltas}
 *    Jurisdiction contains {reserves, collaterals}
 *
 * 2. EXECUTION FLOW MATCHES:
 *    User action → Runtime.process()
 *                → applyEntityInput (E-layer)
 *                  → applyEntityTx (E-machine)
 *                    → processAccountTx (A-machine)
 *                      → jOutputs → J-mempool
 *                        → J-processor → BrowserVM
 *
 * 3. MENTAL MODEL:
 *    "Runtime runs Entities which manage Accounts that settle via Jurisdictions"
 *    Not: "Jurisdictions run Entities..." (backwards)
 *    Not: "Entities run Runtime..." (inverted)
 *
 * 4. ALTERNATIVE ORDERS (Why They're Wrong):
 *    - J→E→A→R: Implies J contains E (wrong - E registers WITH J)
 *    - E→A→J→R: Implies R is innermost (wrong - R is outermost)
 *    - A→E→J→R: Implies A contains E (backwards!)
 *
 * R→E→A→J is the NATURAL order: container → contained → contained → terminal.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * XLN MESSAGE FLOW: Runtime → Entity → Account → Jurisdiction
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
 *    └─ disputeProofNonce: number       // cooperativeNonce at dispute proof signing
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
 *   - Validates frame chain (prevFrameHash), signatures
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
 * **cooperativeNonce** (on-chain dispute domain):
 *   - proofHeader.cooperativeNonce — incremented per message (propose/ACK)
 *   - Used in dispute proof bodies for on-chain settlement ordering
 *   - Replay protection is handled by frame chain (height + prevFrameHash), NOT counters
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import type { Profile } from './networking/gossip';
import type { JAdapter } from './jadapter/types';

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
  entityInputs: RoutedEntityInput[];
  jInputs?: JInput[]; // J-layer inputs (queue to J-mempool)
  queuedAt?: number; // When first queued into runtime mempool (ms)
}

/** J-layer input - queues JTx to jurisdiction mempool */
export interface JInput {
  jurisdictionName: string; // Which J-machine to queue to
  jTxs: JTx[]; // Transactions to queue
}

export type RuntimeTx =
  | {
      type: 'importReplica';
      entityId: string;
      signerId: string;
      data: {
        config: ConsensusConfig;
        isProposer: boolean;
        position?: { x: number; y: number; z: number; jurisdiction?: string; xlnomy?: string };
      };
    }
  | {
      type: 'importJ';
      data: {
        name: string;           // Unique J-machine name (key in jReplicas Map)
        chainId: number;        // 1=ETH, 8453=Base, 1001+=BrowserVM
        ticker: string;         // "ETH", "MATIC", "SIM"
        rpcs: string[];         // [] = BrowserVM, [...urls] = RPC
        rpcPolicy?: 'single' | 'failover' | { mode: 'quorum'; min: number };
        contracts?: {
          depository?: string;
          entityProvider?: string;
        };
        tokens?: Array<{      // Auto-deploy for BrowserVM only
          symbol: string;
          decimals: number;
          initialSupply?: bigint;
        }>;
      };
    };

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
 * Common metadata for all J-events (for JBlock tracking)
 */
interface JEventMetadata {
  blockNumber?: number;      // J-block number where event occurred
  blockHash?: string;        // J-block hash for consensus
  transactionHash?: string;  // On-chain transaction hash
}

/**
 * Jurisdiction event types - discriminated union for type safety
 * Each on-chain event has its own typed data structure
 */
export type JurisdictionEvent =
  | (JEventMetadata & {
      type: 'ReserveUpdated';
      data: {
        entity: string;
        tokenId: number;
        newBalance: string;
        symbol?: string;   // Optional - BrowserVM doesn't have token registry
        decimals?: number; // Optional - use TOKEN_REGISTRY lookup if missing
      };
    })
  | (JEventMetadata & {
      type: 'SecretRevealed';
      data: {
        hashlock: string;
        revealer: string;
        secret: string;
      };
    })
  | (JEventMetadata & {
      type: 'AccountSettled';
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
    })
  | (JEventMetadata & {
      type: 'InsuranceClaimed';
      data: {
        insured: string;
        insurer: string;
        creditor: string;
        tokenId: number;
        amount: string;
      };
    })
  | (JEventMetadata & {
      type: 'GovernanceEnabled';
      data: {
        entityId: string;
        proposalThreshold: number;
      };
    })
  | (JEventMetadata & {
      type: 'HankoBatchProcessed';
      data: {
        entityId: string;      // Entity that submitted the batch
        hankoHash: string;     // Hash of hanko data for verification
        nonce: number;         // Batch nonce (incrementing per entity)
        success: boolean;      // Whether batch processing succeeded
      };
    })
  | (JEventMetadata & {
      type: 'InsuranceRegistered';
      data: {
        insured: string;
        insurer: string;
        tokenId: number;
        limit: string;
        expiresAt: string;
      };
    })
  | (JEventMetadata & {
      type: 'InsuranceExpired';
      data: {
        insured: string;
        insurer: string;
        tokenId: number;
      };
    })
  | (JEventMetadata & {
      type: 'DebtCreated';
      data: {
        debtor: string;
        creditor: string;
        tokenId: number;
        amount: string;
        debtIndex: number;
      };
    })
  | (JEventMetadata & {
      type: 'DisputeStarted';
      data: {
        sender: string;
        counterentity: string;
        disputeNonce: string;
        proofbodyHash: string;
        initialArguments: string;
      };
    })
  | (JEventMetadata & {
      type: 'DisputeFinalized';
      data: {
        sender: string;
        counterentity: string;
        initialDisputeNonce: string;
        initialProofbodyHash: string;
        finalProofbodyHash: string;
      };
    })
  | (JEventMetadata & {
      type: 'DebtEnforced';
      data: {
        debtor: string;
        creditor: string;
        tokenId: number;
        amountPaid: string;
        remainingAmount: string;
        newDebtIndex: number;
      };
    });

/**
 * Jurisdiction event data for j_event transactions
 * Now with typed event discriminated union and JBlock consensus info
 */
export interface JurisdictionEventData {
  from: string;
  event: JurisdictionEvent;
  events?: JurisdictionEvent[]; // Batched events from same block
  observedAt: number;
  blockNumber: number;
  blockHash: string;  // Block hash for JBlock consensus
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
  envelope?: import('./htlc-envelope-types').HtlcEnvelope | string;
}

// Swap offer (limit order) in bilateral account
export interface SwapOffer {
  offerId: string;              // UUID for this offer
  giveTokenId: number;          // Token maker is giving
  giveAmount: bigint;           // Original amount (partial fills reduce this)
  wantTokenId: number;          // Token maker wants in return
  wantAmount: bigint;           // Corresponding want amount (maintains ratio)
  minFillRatio: number;         // 0-65535, minimum acceptable fill
  makerIsLeft: boolean;         // Who created this offer (canonical direction)
  createdHeight: number;        // AccountFrame height when created
  // Quantized amounts for orderbook consistency (set by hub when adding to book)
  // These ensure fill ratios computed from lots match settlement amounts exactly
  quantizedGive?: bigint;       // giveAmount rounded to LOT_SCALE multiple
  quantizedWant?: bigint;       // wantAmount scaled proportionally
}

/**
 * HTLC Routing Context (replaces 2024 User.hashlockMap)
 * Tracks inbound/outbound hops for automatic secret propagation
 */
export interface HtlcRoute {
  hashlock: string;

  // Inbound hop (who sent us this HTLC)
  inboundEntity?: string;
  inboundLockId?: string;

  // Outbound hop (who we forwarded to)
  outboundEntity?: string;
  outboundLockId?: string;

  // Resolution
  secret?: string;
  pendingFee?: bigint; // Fee to accrue on successful reveal (not on forward)
  createdTimestamp: number;
}

export interface AccountMachine {
  // CANONICAL REPRESENTATION (like Channel.ts - both entities store IDENTICAL structure)
  leftEntity: string;   // Lower entity ID (canonical left)
  rightEntity: string;  // Higher entity ID (canonical right)

  mempool: AccountTx[]; // Unprocessed account transactions
  currentFrame: AccountFrame; // Current agreed state (includes full transaction history for replay/audit)

  // Per-token delta states (giant per-token table like old_src)
  deltas: Map<number, Delta>; // tokenId -> Delta

  // HTLC state (conditional payments)
  locks: Map<string, HtlcLock>; // lockId → lock details

  // Swap offers (limit orders)
  swapOffers: Map<string, SwapOffer>; // offerId → offer details

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

  // Rollback support for bilateral disagreements
  rollbackCount: number;
  lastRollbackFrameHash?: string; // Track last rollback to prevent duplicate increments

  // Bilateral J-event consensus (2-of-2 agreement on jurisdiction events)
  leftJObservations: Array<{ jHeight: number; jBlockHash: string; events: any[]; observedAt: number }>;
  rightJObservations: Array<{ jHeight: number; jBlockHash: string; events: any[]; observedAt: number }>;
  jEventChain: Array<{ jHeight: number; jBlockHash: string; events: any[]; finalizedAt: number }>;
  lastFinalizedJHeight: number;

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

  hankoSignature?: string; // LEGACY - will be removed

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
  jHeight: number; // J-machine height agreed for HTLC deadline checks
  accountTxs: AccountTx[]; // Renamed from transitions
  prevFrameHash: string; // Hash of previous frame (creates chain linkage, not state linkage)
  stateHash: string;
  byLeft?: boolean; // Who proposed this frame (left or right entity)
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

  // HANKO SYSTEM:
  prevHanko?: HankoString;                // ACK hanko for their frame
  newAccountFrame?: AccountFrame;         // Our new proposed frame (like block in Channel.ts)
  newHanko?: HankoString;                 // Hanko on newAccountFrame
  newDisputeHanko?: HankoString;          // Hanko on dispute proof (for J-machine enforcement)
  newDisputeHash?: string;               // Full dispute hash (key in hankoWitness, wraps proofBodyHash)
  newDisputeProofBodyHash?: string;       // ProofBodyHash that newDisputeHanko signs
  newSettlementHanko?: HankoString;       // Hanko for settlement operations

  // SETTLEMENT WORKSPACE ACTIONS (bilateral negotiation)
  settleAction?: {
    type: 'propose' | 'update' | 'approve' | 'execute' | 'reject';
    diffs?: SettlementDiff[];            // For propose/update
    forgiveTokenIds?: number[];          // For propose/update
    hanko?: HankoString;                 // For approve (signer's hanko)
    memo?: string;                       // For propose/update/reject
    version?: number;                    // Version being approved/executed
  };

  // LEGACY (will be removed):
  prevSignatures?: string[];         // ACK for their frame (LEGACY)
  newSignatures?: string[];          // Signatures on new frame (LEGACY)

  disputeProofNonce?: number;        // cooperativeNonce at which dispute proof was signed (explicit, replaces counter-1 hack)
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
 * Settlement workspace - shared editing area per bilateral account
 *
 * Flow:
 * 1. Either party creates workspace via settle_propose
 * 2. Both parties can update via settle_update (replaces diffs)
 * 3. Either party can approve via settle_approve (signs + bumps coopNonce)
 * 4. Initiator or counterparty executes via settle_execute (adds to jBatch)
 * 5. Execute or reject clears workspace
 */
export interface SettlementWorkspace {
  diffs: SettlementDiff[];                    // The settlement operations
  forgiveTokenIds: number[];                  // Debts to forgive (optional)
  insuranceRegs: Array<{                      // Insurance registrations (optional)
    insured: string;
    insurer: string;
    tokenId: number;
    limit: bigint;
    expiresAt: bigint;
  }>;

  // Hanko signatures
  leftHanko?: HankoString;                    // Left's signature on settlement
  rightHanko?: HankoString;                   // Right's signature on settlement

  // Metadata
  initiatedBy: 'left' | 'right';              // Who created the workspace
  status: 'draft' | 'awaiting_counterparty' | 'ready_to_submit';
  memo?: string;                              // Human-readable description
  version: number;                            // Increments on each update
  createdAt: number;                          // Timestamp when created
  lastUpdatedAt: number;                      // Timestamp of last update

  // Broadcast responsibility: true = left broadcasts, false = right broadcasts
  // When cross-signed, this determines whose responsibility it is to submit on-chain.
  // Generally hub (larger batches = cheaper gas) should broadcast.
  broadcastByLeft: boolean;

  // Nonce tracking (for invalidating old dispute proofs)
  cooperativeNonceAtSign?: number;            // coopNonce when signing
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

/**
 * Account Events - Bubbled up from A-layer to E-layer
 * Used for routing (HTLC secrets) and matching (swap offers)
 */
export type AccountEvent =
  | { type: 'htlc_revealed'; hashlock: string; secret: string }
  | { type: 'swap_offer_created'; offerId: string; makerId: string; accountId: string; giveTokenId: number; giveAmount: bigint; wantTokenId: number; wantAmount: bigint; minFillRatio: number }
  | { type: 'swap_offer_cancelled'; offerId: string; accountId: string };

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
        envelope?: import('./htlc-envelope-types').HtlcEnvelope | string | undefined; // Onion routing envelope (string when encrypted)
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

// ═══════════════════════════════════════════════════════════════════════════
// J-BLOCK CONSENSUS (Multi-signer agreement on J-machine state)
// ═══════════════════════════════════════════════════════════════════════════
//
// Each signer independently observes J-machine blocks and submits observations.
// Entity finalizes a JBlock when threshold signers agree on (jHeight, jBlockHash).
// This ensures Byzantine-tolerant J-machine state tracking without extra signatures.
//
// Flow:
// 1. Signer observes J-block N with events relevant to entity
// 2. Signer submits JBlockObservation as EntityTx
// 3. Entity collects observations from all signers
// 4. When threshold agree on same (jHeight, jBlockHash) → finalize
// 5. Apply events from finalized JBlock to entity state
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Observation of a J-block by a single signer.
 * Submitted as j_event EntityTx, aggregated by entity consensus.
 */
export interface JBlockObservation {
  signerId: string;              // Who observed this
  jHeight: number;               // J-machine block number
  jBlockHash: string;            // EVM block hash (or BrowserVM frame hash)
  events: JurisdictionEvent[];   // Events relevant to this entity in this block
  observedAt: number;            // When signer observed this (for timeout detection)
}

/**
 * Finalized J-block after threshold agreement.
 * Events from this block can be safely applied to entity state.
 */
export interface JBlockFinalized {
  jHeight: number;
  jBlockHash: string;
  events: JurisdictionEvent[];
  finalizedAt: number;           // When consensus was reached
  signerCount: number;           // How many signers agreed (for audit)
}

/**
 * Liveness sync - empty block observation to prove chain is alive.
 * Required every JBLOCK_LIVENESS_INTERVAL blocks even if no events.
 */
export const JBLOCK_LIVENESS_INTERVAL = 100;

export interface EntityState {
  entityId: string; // The entity ID this state belongs to
  height: number;
  timestamp: number;
  nonces: Map<string, number>;
  messages: string[];
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;
  prevFrameHash?: string; // Chain linkage for BFT consensus (keccak256 of previous frame)

  // 💰 Financial state
  reserves: Map<string, bigint>; // tokenId -> amount only, metadata from TOKEN_REGISTRY
  accounts: Map<string, AccountMachine>; // canonicalKey "left:right" -> account state
  // Account frame scheduling (accounts blocked by pendingFrame, retried on next ACK)
  deferredAccountProposals?: Map<string, true>;
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

/** Aggregated swap order entry at E-Machine level */
export interface SwapBookEntry {
  offerId: string;
  accountId: string;        // counterparty entity ID where order lives
  giveTokenId: number;
  giveAmount: bigint;       // remaining amount
  wantTokenId: number;
  wantAmount: bigint;       // remaining want
  minFillRatio: number;
  createdAt: bigint;
}

/** Aggregated HTLC lock entry at E-Machine level */
export interface LockBookEntry {
  lockId: string;
  accountId: string;        // counterparty entity ID where lock lives
  tokenId: number;
  amount: bigint;
  hashlock: string;
  timelock: bigint;
  direction: 'outgoing' | 'incoming';
  createdAt: bigint;
}

/** Hash type for entity-level signing */
export type HashType = 'entityFrame' | 'accountFrame' | 'dispute' | 'settlement' | 'profile';

/** Hash with type info for entity-level signing */
export interface HashToSign {
  hash: string;
  type: HashType;
  context: string;  // e.g., "account:0002:frame:1" or "account:0002:dispute"
}

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

export interface BrowserVMState {
  stateRoot: string;
  trieData: Array<[string, string]>;
  nonce: string;
  addresses: { depository: string; entityProvider: string };
}

export interface Env {
  eReplicas: Map<string, EntityReplica>;  // Entity replicas (E-layer state machines)
  jReplicas: Map<string, JReplica>;       // Jurisdiction replicas (J-layer EVM state)
  height: number;
  timestamp: number;
  runtimeSeed?: string; // BrainVault seed backing this runtime (plaintext, dev mode)
  runtimeId?: string; // Runtime identity (usually signer1 address)
  dbNamespace?: string; // DB namespace for per-runtime persistence (defaults to runtimeId)
  // Runtime mempool (runtime-level queue; WAL-like)
  // NOTE: runtimeInput is deprecated alias - both point to same object
  runtimeMempool?: RuntimeInput;
  runtimeInput: RuntimeInput; // Deprecated alias of runtimeMempool
  runtimeConfig?: {
    minFrameDelayMs?: number; // Minimum delay between runtime frames
    loopIntervalMs?: number;  // Loop interval for runtime processing
  };
  runtimeState?: {
    loopActive?: boolean;
    stopLoop?: (() => void) | null;
    lastFrameAt?: number;
    p2p?: any;
    pendingP2PConfig?: any;
    lastP2PConfig?: any;
    envChangeCallbacks?: Set<(env: Env) => void>;
    db?: any;
    dbOpenPromise?: Promise<boolean> | null;
    logState?: {
      nextId: number;
      mirrorToConsole?: boolean;
    };
    cleanLogs?: string[];
    routeDeferState?: Map<string, {
      warnAt: number;
      gossipAt: number;
      deferredCount: number;
      escalated: boolean;
    }>;
    entityRuntimeHints?: Map<string, {
      runtimeId: string;
      seenAt: number;
    }>;
  };
  history: EnvSnapshot[]; // Time machine snapshots - single source of truth
  gossip: any; // Gossip layer for network profiles

  // Isolated BrowserVM instance per runtime (prevents cross-runtime state leakage)
  browserVM?: any; // BrowserVMProvider instance for this runtime (DEPRECATED: use jAdapter)
  browserVMState?: BrowserVMState; // Serialized BrowserVM state for time travel

  // Unified J-Machine adapter (preferred over browserVM or evms)
  // Use: const jAdapter = env.jAdapter ?? await createJAdapter({ mode: 'browservm', chainId: 1337 })
  jAdapter?: import('./jadapter/types').JAdapter;

  // EVM instances - DEPRECATED, use env.jAdapter or createJAdapter() from jadapter
  evms: Map<string, any>;

  // Active jurisdiction
  activeJurisdiction?: string; // Currently active J-replica name

  // Scenario mode: deterministic time control (scenarios set env.timestamp manually)
  scenarioMode?: boolean; // When true, runtime doesn't auto-update timestamp
  quietRuntimeLogs?: boolean; // When true, suppress noisy runtime console logs
  scenarioLogLevel?: 'debug' | 'info' | 'warn' | 'error'; // Scenario log verbosity
  strictScenario?: boolean; // When true, runtime asserts invariants per frame
  strictScenarioLabel?: string; // Optional label for strict scenario errors

  // Frame stepping: stop at specific frame for debugging
  stopAtFrame?: number; // When set, process() stops at this frame and dumps state

  // Frame display duration hint (for time-travel visualization)
  frameDisplayMs?: number; // How long to display this frame (default: 100ms)

  // Snapshot extras for scenarios (set before process(), consumed by captureSnapshot)
  extra?: {
    subtitle?: {
      title: string;
      what?: string;
      why?: string;
      tradfiParallel?: string;
      keyMetrics?: string[];
    };
    expectedSolvency?: bigint;
    description?: string;
  };

  // E→E message queue (always spans ticks - no same-tick cascade)
  pendingOutputs?: RoutedEntityInput[]; // Outputs queued for next tick
  skipPendingForward?: boolean;   // Temp flag to defer forwarding to next frame
  networkInbox?: RoutedEntityInput[];   // Inbound network messages queued for next tick
  pendingNetworkOutputs?: RoutedEntityInput[]; // Outputs waiting for runtimeId gossip before routing
  lockRuntimeSeed?: boolean;      // Prevent runtime seed updates during scenarios

  // Frame-scoped structured logs (captured into snapshot, then reset)
  frameLogs: FrameLogEntry[];

  // Event emission methods (EVM-style - like Ethereum block logs)
  log: (message: string) => void;
  info: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => void;
  warn: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => void;
  error: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => void;
  emit: (eventName: string, data: Record<string, unknown>) => void; // Generic event emission
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

  // Block creation delay (ms-based for universal timing)
  // Creates visual delay where batches sit in mempool as yellow cubes
  blockDelayMs: number;                   // Delay in ms before processing mempool (default: 300)
  lastBlockTimestamp: number;             // Timestamp (ms) of last block creation
  blockReady?: boolean;                   // True when mempool has items and blockDelayMs elapsed

  // JAdapter instance (for balance queries, transactions, etc)
  // Works with both browservm and rpc modes
  jadapter?: JAdapter;
  // RPC endpoints for this jurisdiction (preferred for j-watcher + batch broadcast)
  rpcs?: string[];
  // Chain id (optional, prefer jadapter.chainId when available)
  chainId?: number;

  // Visual position (for 3D rendering)
  position: { x: number; y: number; z: number };

  // Contract addresses (primary)
  depositoryAddress?: string; // Primary depository address (for replay protection)
  entityProviderAddress?: string; // Primary entity provider address

  // Decoded contract addresses for UI (deprecated - use depositoryAddress/entityProviderAddress)
  contracts?: {
    depository?: string;
    entityProvider?: string;
    account?: string;
    deltaTransformer?: string;
  };

  // === SYNCED FROM DEPOSITORY.SOL ===
  // mapping(bytes32 => mapping(uint => uint)) _reserves
  reserves?: Map<string, Map<number, bigint>>;  // entityId -> tokenId -> amount

  // mapping(bytes => mapping(uint => AccountCollateral)) _collaterals
  collaterals?: Map<string, Map<number, { collateral: bigint; ondelta: bigint }>>; // accountKey -> tokenId -> {collateral, ondelta}

  // mapping(bytes32 => InsuranceLine[]) insuranceLines
  insuranceLines?: Map<string, Array<{ insurer: string; tokenId: number; remaining: bigint; expiresAt: bigint }>>;

  // === SYNCED FROM ENTITYPROVIDER.SOL ===
  // mapping(bytes32 => Entity) entities
  registeredEntities?: Map<string, { name: string; quorum: string[]; threshold: number }>;
}

/** J-Machine transaction (settlement layer) */
export type JTx =
  | {
      type: 'batch'; // ALL J-operations go through batch (matches Depository.processBatch)
      entityId: string;
      data: {
        batch: any; // JBatch structure from j-batch.ts
        hankoSignature?: string;
        batchSize: number;
        signerId?: string;
      };
      timestamp: number;
      expectedJBlock?: number; // Expected j-block height (for replay protection)
    }
  | {
      type: 'mint'; // Admin/debug function for minting reserves
      entityId: string;
      data: {
        entityId: string;
        tokenId: number;
        amount: bigint;
      };
      timestamp: number;
    };

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
  runtimeSeed?: string;
  runtimeId?: string;
  dbNamespace?: string;
  eReplicas: Map<string, EntityReplica>;  // E-layer state
  jReplicas: JReplica[];                   // J-layer state (with stateRoot for time travel)
  browserVMState?: BrowserVMState;
  runtimeInput: RuntimeInput;
  runtimeOutputs: RoutedEntityInput[];
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
    what?: string;           // What's happening (optional)
    why?: string;            // Why it matters (optional)
    tradfiParallel?: string; // Traditional finance equivalent (optional)
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
  // Display duration hint for time-travel visualization (default: 100ms)
  displayMs?: number;
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
  // NOTE: NO expectedQuorumHash - EP.sol reconstructs board hash from recovered signers
}

// Hanko in string format (hex-encoded ABI bytes)
export type HankoString = string;

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
    deltaTransformerAddress?: string;
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
    deltaTransformerAddress?: string;
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
