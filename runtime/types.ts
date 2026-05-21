import type { OrderbookExtState } from './orderbook';
import type { SwapKey } from './swap-keys';
import type { Level } from 'level';
import type { RuntimeP2P } from './networking/p2p';
import type { CrossJurisdictionSwapRoute } from './types/cross-jurisdiction';
import type { DebtEntry } from './types/debt';
import type {
  JBlockFinalized,
  JBlockObservation,
  JurisdictionEvent,
  JurisdictionEventData,
} from './types/jurisdiction-events';
import type { HankoString } from './types/hanko';
import type {
  AccountInput,
  AccountMachine,
  AccountTx,
  CrossJurisdictionSecretRelay,
  HtlcNoteKey,
  HtlcRoute,
  RuntimeFrameDbRecord,
  RuntimeOverlayRecord,
  SettlementDiff,
  SettlementOp,
} from './types/account';
import type { HubRebalanceConfig } from './types/rebalance';
export type {
  CrossJurisdictionPullLeg,
  CrossJurisdictionSwapLeg,
  CrossJurisdictionSwapRoute,
  CrossJurisdictionSwapStatus,
} from './types/cross-jurisdiction';
export type {
  DebtEntry,
  DebtEventType,
  DebtStatus,
  DebtUpdate,
} from './types/debt';
export type {
  JBlockFinalized,
  JBlockObservation,
  JurisdictionEvent,
  JurisdictionEventData,
} from './types/jurisdiction-events';
export type {
  HankoBytes,
  HankoClaim,
  HankoContext,
  HankoMergeResult,
  HankoString,
  HankoVerificationResult,
} from './types/hanko';
export type {
  AccountDelta,
  AccountEvent,
  AccountFrame,
  AccountInput,
  AccountMachine,
  AccountSettleAction,
  AccountSnapshot,
  AccountStatus,
  AccountTx,
  AssetBalance,
  CrossJurisdictionSecretRelay,
  Delta,
  DerivedDelta,
  HtlcLock,
  HtlcNoteKey,
  HtlcRoute,
  PullCommitment,
  RuntimeFrameDbRecord,
  RuntimeOverlayRecord,
  SettlementDiff,
  SettlementOp,
  SettlementWorkspace,
  SwapOffer,
  SwapOrderHistoryEntry,
  SwapOrderResolveHistoryEntry,
} from './types/account';
export {
  DEFAULT_HARD_LIMIT,
  DEFAULT_MAX_FEE,
  DEFAULT_SOFT_LIMIT,
  QUOTE_EXPIRY_MS,
  REFERENCE_TOKEN_ID,
} from './types/rebalance';
export type {
  HubRebalanceConfig,
  RebalancePolicy,
  RebalanceQuote,
  RebalanceRequestFeeState,
} from './types/rebalance';

/**
 * Shared XLN wire/state type barrel.
 *
 * Keep new domain-specific types under runtime/types/* and re-export them here
 * only when older call sites still import from ./types. The runtime architecture
 * narrative lives in docs/architecture/runtime-reaj.md.
 */

import type { GossipLayer, Profile } from './networking/gossip';
import type { JAdapter } from './jadapter/types';
import type { CompletedBatch, JBatch, JBatchState } from './j-batch';
import type { CrontabState } from './crontab-types';

export type { Profile } from './networking/gossip';

export type RuntimeP2PConfigLike = {
  relayUrls?: string[];
  wsUrl?: string | null;
  seedRuntimeIds?: string[];
  runtimeId?: string;
  signerId?: string;
  advertiseEntityIds?: string[];
  isHub?: boolean;
  gossipPollMs?: number;
};

export type RuntimeP2PSurface = {
  close(): void;
  connect(): void;
  isConnected(): boolean;
  matchesIdentity(runtimeId: string, signerId?: string): boolean;
  updateConfig(config: RuntimeP2PConfigLike): void;
  refreshGossip(mode?: unknown): void;
  ensureProfiles(entityIds: string[]): Promise<boolean>;
  sendDebugEvent(payload: unknown): boolean;
  syncProfiles(): Promise<boolean>;
  announceProfilesForEntities(entityIds: string[], reason?: string): void;
};

export interface JurisdictionConfig {
  address: string;
  name: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  chainId?: number;
  blockTimeMs?: number;
  // Optional per-jurisdiction onboarding defaults (USD whole units).
  rebalancePolicyUsd?: {
    r2cRequestSoftLimit: number;
    hardLimit: number;
    maxFee: number;
  };
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
  timestamp?: number | undefined; // External ingress timestamp seed (ms) for this runtime input batch
  queuedAt?: number | undefined; // When first queued into runtime mempool (ms)
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
        profileName?: string;
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
        blockTimeMs?: number;   // Expected settlement-chain block time for wall-clock safety windows
        rpcPolicy?: 'single' | 'failover' | { mode: 'quorum'; min: number };
        contracts?: {
          depository?: string;
          entityProvider?: string;
          account?: string;
          deltaTransformer?: string;
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
  /**
   * Transport hint used by orchestrators, relay delivery, scenarios, and
   * bootstrap helpers before the input is normalized into deterministic REA
   * processing. Consensus code must keep treating signer/runtime routing as
   * envelope metadata, not state-machine input.
   */
  signerId?: string;
  runtimeId?: string;
  from?: string;
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

/**
 * Network-deliverable entity input.
 * By the time an input leaves the local runtime, target runtime resolution must
 * already be complete and runtimeId becomes mandatory.
 */
export interface DeliverableEntityInput extends RoutedEntityInput {
  runtimeId: string;
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
          [key: string]: unknown; // Allow additional rebalance metadata
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
      data: {
        profile: ProfileUpdateTx & {
          entityId: string;
          hankoSignature?: string;
        };
      };
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
        rebalancePolicy?: {
          r2cRequestSoftLimit: bigint;
          hardLimit: bigint;
          maxAcceptableFee: bigint;
        };
      };
    }
  | {
      type: 'j_event_account_claim';
      data: {
        counterpartyEntityId: string; // Which account this observation is for
        jHeight: number;
        jBlockHash: string;
        events: JurisdictionEvent[];
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
        startedAtMs?: number;
        secret?: string;   // Optional - generated if not provided
        hashlock?: string; // Optional - generated if not provided
        // Deterministic replay payload captured on first execution.
        preparedEnvelope?: unknown;
        preparedSenderLockAmount?: bigint | string;
        preparedTotalFee?: bigint | string;
        preparedLockId?: string;
        preparedTimelock?: bigint | string;
        preparedRevealBeforeHeight?: number;
      };
    }
  | {
      // Direct hashlock-only HTLC. Used for cross-jurisdiction swaps where
      // the sender must not know the preimage at lock time.
      type: 'hashlockPayment';
      data: {
        targetEntityId: string;
        tokenId: number;
        amount: bigint;
        hashlock: string;
        lockId?: string;
        timelock?: bigint;
        revealBeforeHeight?: number;
        description?: string;
        startedAtMs?: number;
        crossJurisdictionRelay?: CrossJurisdictionSecretRelay;
      };
    }
  | {
      // Resolve a direct/account HTLC when the preimage is known.
      type: 'resolveHtlcLock';
      data: {
        counterpartyEntityId: string;
        lockId: string;
        secret: string;
        description?: string;
      };
    }
  | {
      // Create a ratio-gated pull commitment in a bilateral account.
      // The side losing funds proposes it; the beneficiary resolves it with
      // hashladder ratio secrets.
      type: 'pullLock';
      data: {
        counterpartyEntityId: string;
        pullId: string;
        tokenId: number;
        amount: bigint;
        revealedUntilTimestamp: number;
        fullHash: string;
        partialRoot: string;
        description?: string;
      };
    }
  | {
      type: 'resolvePull';
      data: {
        counterpartyEntityId: string;
        pullId: string;
        binary: string;
        description?: string;
      };
    }
  | {
      type: 'cancelPull';
      data: {
        counterpartyEntityId: string;
        pullId: string;
        description?: string;
      };
    }
  | {
      type: 'pullCancelExpired';
      data: {
        counterpartyEntityId: string;
        pullId: string;
        description?: string;
      };
    }
  | {
      // Request hub collateralization on a bilateral account (prepaid fee model)
      type: 'requestCollateral';
      data: {
        counterpartyEntityId: string;
        tokenId: number;
        amount: bigint;
        feeTokenId?: number;
        feeAmount: bigint;
        policyVersion: number;
      };
    }
  | {
      // Manual reopen for disputed account (reactivates business txs after dispute cycle)
      type: 'reopenDisputedAccount';
      data: {
        counterpartyEntityId: string;
        onChainNonce?: number;
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
        initialArguments?: string;
        description?: string;
        allowUnsafeCrossJTargetDispute?: boolean;
        acceptedCrossJTargetLossAmount?: bigint;
      };
    }
  | {
      type: 'registerCrossJurisdictionSwap';
      data: {
        route: CrossJurisdictionSwapRoute;
      };
    }
  | {
      type: 'requestCrossJurisdictionSwap';
      data: {
        route: CrossJurisdictionSwapRoute;
      };
    }
  | {
      type: 'prepareCrossJurisdictionSwap';
      data: {
        route: CrossJurisdictionSwapRoute;
      };
    }
  | {
      type: 'commitCrossJurisdictionSwap';
      data: {
        route: CrossJurisdictionSwapRoute;
      };
    }
  | {
      type: 'crossJurisdictionFillNotice';
      data: {
        orderId: string;
        fillSeq: number;
        incrementalSourceAmount: bigint;
        incrementalTargetAmount: bigint;
        cumulativeSourceAmount: bigint;
        cumulativeTargetAmount: bigint;
        cumulativeFillRatio: number;
        priceImprovementMode?: 'source_savings' | 'target_bonus' | 'none';
        priceImprovementAmount?: bigint;
        priceImprovementTokenId?: number;
        priceTicks?: bigint;
        pairId: string;
      };
    }
  | {
      type: 'requestCrossJurisdictionClear';
      data: {
        orderId: string;
        cancelRemainder?: boolean;
        route?: CrossJurisdictionSwapRoute;
      };
    }
	  | {
	      type: 'crossJurisdictionSalvage';
	      data: {
	        routeId: string;
        binary: string;
        fillRatio: number;
        sourceEntityId: string;
        sourceCounterpartyEntityId: string;
	        observedAt?: number;
	      };
	    }
	  | {
	      type: 'orderbookSweepCrossJurisdiction';
	      data: {
	        reason?: string;
	      };
	    }
	  | {
	      type: 'removeCrossJurisdictionBookOrder';
	      data: {
	        orderId: string;
	        sourceEntityId: string;
	        route?: CrossJurisdictionSwapRoute;
	        reason?: string;
	      };
	    }
	  | {
	      type: 'disputeFinalize';
	      data: {
        counterpartyEntityId: string;
        cooperative?: boolean;  // Ignored compatibility flag. disputeFinalize is unilateral-only.
        useOnchainRegistry?: boolean; // Optional HTLC reveal via on-chain registry
        description?: string;
      };
    }
  | {
      // External-token-to-reserve: queue ERC20 deposit into entity jBatch.
      // On broadcast, the batch must be submitted by the entity signer EOA.
      type: 'e2r';
      data: {
        contractAddress: string;
        tokenType?: number;
        externalTokenId?: bigint;
        internalTokenId?: number;
        amount: bigint;
      };
    }
  | {
      type: 'r2c';
      data: {
        counterpartyId: string; // Which account to add collateral to
        receivingEntityId?: string; // Optional target entity for remote reserve->account funding
        tokenId: number;
        amount: bigint;
        // Optional: rebalance fee collection (atomic with deposit)
        rebalanceQuoteId?: number;      // References accepted quote
        rebalanceFeeTokenId?: number;   // Fee token (1 = USDT)
        rebalanceFeeAmount?: bigint;    // Must match accepted quote
      };
    }
  | {
      type: 'r2r';
      data: {
        toEntityId: string; // Recipient entity
        tokenId: number;
        amount: bigint;
      };
    }
  | {
      // r2e: Entity withdraws reserve balance to an external EOA address encoded as bytes32.
      // Declarative at entity layer; J-batch execution handles the actual token transfer.
      type: 'r2e';
      data: {
        receivingEntity: string; // bytes32-encoded external EOA destination
        tokenId: number;
        amount: bigint;
      };
    }
  | {
      // J-Broadcast: Entity broadcasts accumulated jBatch to J-machine
      type: 'j_broadcast';
      data: {
        hankoSignature?: string; // Optional hanko seal for the batch
        feeOverrides?: {
          gasBumpBps?: number;
          maxFeePerGasWei?: string;
          maxPriorityFeePerGasWei?: string;
        };
      };
    }
  | {
      // J-Rebroadcast: resend current sentBatch with same nonce/hash and optional fee bump.
      type: 'j_rebroadcast';
      data: {
        gasBumpBps?: number; // Optional EIP-1559 bump in basis points (e.g. 1250 = +12.5%)
      };
    }
  | {
      // J-Abort-Sent-Batch: clear or requeue in-flight sentBatch.
      type: 'j_abort_sent_batch';
      data: {
        reason?: string;
        requeueToCurrent?: boolean; // true => move sentBatch ops back into current batch
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
      // Declare entity as hub: sets rebalance config + routing fees, announces to gossip
      type: 'setHubConfig';
      data: {
        matchingStrategy?: 'amount' | 'time' | 'fee'; // Default: 'amount'
        policyVersion?: number;             // Fee-policy version (auto-incremented if omitted)
        routingFeePPM?: number;             // Default: 1 (0.0001%)
        baseFee?: bigint;                   // Default: 0n
        swapTakerFeeBps?: number;           // Default: 0 (testnet hubs may set 1)
        disputeAutoFinalizeMode?: 'auto' | 'ignore';
        minCollateralThreshold?: bigint;    // Reserved for future policy gates
        c2rWithdrawSoftLimit?: bigint;              // Hub-owned collateral keep-buffer before C→R pullback
        minFeeBps?: bigint;                 // Legacy fallback min-fee bps gate (if policy triplet missing)
        rebalanceBaseFee?: bigint;          // Fixed rebalance fee component
        rebalanceLiquidityFeeBps?: bigint;  // Rebalance liquidity fee in bps (volume-based)
        rebalanceGasFee?: bigint;           // Flat gas recovery component
        rebalanceTimeoutMs?: number;        // Auto-refund timeout for unfulfilled prepaid requests
      };
    }
  | {
      // User sets rebalance policy on bilateral account (pushes set_rebalance_policy AccountTx)
      type: 'setRebalancePolicy';
      data: {
        counterpartyEntityId: string;
        tokenId: number;
        r2cRequestSoftLimit: bigint;
        hardLimit: bigint;
        maxAcceptableFee: bigint;
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
        // Explicit limit price in ORDERBOOK_PRICE_SCALE ticks (quote per 1 base).
        // Sent together with give/want for deterministic cross-checking.
        priceTicks?: bigint;
        timeInForce?: 0 | 1 | 2; // 0 = GTC, 1 = IOC, 2 = FOK
        minFillRatio: number; // 0-65535
        crossJurisdiction?: CrossJurisdictionSwapRoute;
      };
    }
  | {
      // Resolve or cancel a swap offer in bilateral account (hub → user).
      // Non-zero fills must carry exact execution amounts.
      type: 'resolveSwap';
      data: {
        counterpartyEntityId: string; // User who placed the offer
        offerId: string;
        fillRatio: number; // 0-65535
        cancelRemainder: boolean;
        comment?: string;
        feeTokenId?: number;
        feeAmount?: bigint;
        executionGiveAmount?: bigint;
        executionWantAmount?: bigint;
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
      // Request hub/counterparty to cancel maker's open swap offer (no direct self-cancel)
      type: 'proposeCancelSwap';
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
        ops?: SettlementOp[];
        diffs?: SettlementDiff[];           // V1 compat: auto-converted to rawDiff ops
        forgiveTokenIds?: number[];          // V1 compat: auto-converted to forgive ops
        executorIsLeft?: boolean;
        memo?: string;
      };
    }
  | {
      // Update existing settlement workspace (replaces ops)
      type: 'settle_update';
      data: {
        counterpartyEntityId: string;
        ops?: SettlementOp[];
        diffs?: SettlementDiff[];           // V1 compat: auto-converted to rawDiff ops
        forgiveTokenIds?: number[];          // V1 compat: auto-converted to forgive ops
        executorIsLeft?: boolean;
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
        disableC2RShortcut?: boolean;
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

export interface EntitySwapPair {
  baseTokenId: number;
  quoteTokenId: number;
  pairId: string; // canonical sorted token key used by orderbook books map
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
  // Financial invariant: entity reserves are always keyed by numeric tokenId.
  // Never persist or pass string token keys through live state.
  reserves: Map<number, bigint>; // tokenId -> amount only, metadata from TOKEN_REGISTRY
  accounts: Map<string, AccountMachine>; // canonicalKey "left:right" -> account state
  // Account frame scheduling (accounts blocked by pendingFrame, retried on next ACK)
  deferredAccountProposals?: Map<string, true>;
  // 🔭 J-machine tracking (JBlock consensus)
  lastFinalizedJHeight: number;           // Last finalized J-block height
  jBlockObservations: JBlockObservation[]; // Pending observations from signers
  jBlockChain: JBlockFinalized[];          // Finalized J-blocks (prunable)

  // 🔗 Account machine integration
  accountInputQueue?: AccountInput[]; // Queue of settlement events to be processed by a-machine

  // ⏰ Declarative entity-local schedule. Persisted as pure data and rebound to handlers at runtime.
  crontabState?: CrontabState;

  // 📦 J-Batch system - accumulates operations for on-chain submission (typed in j-batch.ts)
  jBatchState?: JBatchState;
  batchHistory?: CompletedBatch[]; // Last completed batch records for UI + replay diagnostics


  // 🔐 Deterministic entity-scoped X25519 keys for HTLC envelope encryption.
  // These are derived exactly once at entity creation/import and are required
  // for every locally-owned entity. Missing keys are a hard invariant failure.
  entityEncPubKey: string;
  entityEncPrivKey: string;

  // Public entity-owned profile fields.
  // These are part of consensus state and are the source of truth for gossip.
  profile: {
    name: string;
    isHub: boolean;
    avatar: string;
    bio: string;
    website: string;
  };

  // 🔒 HTLC Routing - Multi-hop payment tracking (like 2024 hashlockMap)
  htlcRoutes: Map<string, HtlcRoute>; // hashlock → routing context
  htlcFeesEarned: bigint; // Running total of HTLC routing fees collected
  htlcNotes?: Map<HtlcNoteKey, string>; // local UI notes; recipient note comes from final encrypted envelope only

  // 💳 Debt ledger — mirrored on both debtor and creditor sides from canonical j-events.
  outDebtsByToken?: Map<number, Map<string, DebtEntry>>;
  inDebtsByToken?: Map<number, Map<string, DebtEntry>>;

  // 📊 Orderbook Extension - Hub matching engine (typed in orderbook/types.ts)
  orderbookExt?: OrderbookExtState;

  lockBook: Map<string, LockBookEntry>;  // lockId → entry

  // 💱 Swap market config
  // Kept in entity state so UI and runtime use one source of truth.
  swapTradingPairs?: EntitySwapPair[];

  // 📈 Pending swap fill ratios (orderbook → dispute arguments)
  pendingSwapFillRatios?: Map<SwapKey, number>; // key = "accountId:offerId"
  // Cross-jurisdiction swap routes are duplicated into sibling entities so
  // target-side dispute salvage does not depend on relay/profile gossip.
  crossJurisdictionSwaps?: Map<string, CrossJurisdictionSwapRoute>;

  // 🔄 Rebalance Configuration - Hub-level matching strategy
  hubRebalanceConfig?: HubRebalanceConfig;
}

/** Derived open swap order entry for UI/debug projections */
export interface SwapBookEntry {
  offerId: string;
  accountId: string;        // counterparty entity ID where order lives
  giveTokenId: number;
  giveAmount: bigint;       // remaining amount
  wantTokenId: number;
  wantAmount: bigint;       // remaining want
  minFillRatio: number;
  createdHeight: number;
  priceTicks: bigint;
  crossJurisdiction?: CrossJurisdictionSwapRoute;
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
export type HashType = 'entityFrame' | 'accountFrame' | 'dispute' | 'settlement' | 'profile' | 'jBatch';

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
  // has mutations applied (e.g., openAccount creates account). Store once,
  // attach hankos at commit.
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
  runtimeSeed?: string | undefined; // BrainVault seed backing this runtime (plaintext, dev mode)
  runtimeId?: string | undefined; // Runtime identity (usually signer1 address)
  lastProcessEnteredAt?: number; // Wall-clock timestamp of most recent process() entry
  dbNamespace?: string; // DB namespace for per-runtime persistence (defaults to runtimeId)
  // Runtime mempool (runtime-level queue; WAL-like). runtimeInput is the persisted frame input field.
  runtimeMempool?: RuntimeInput | undefined;
  runtimeInput: RuntimeInput;
  overlay?: RuntimeOverlayRecord[];
  runtimeConfig?: {
    minFrameDelayMs?: number; // Minimum delay between runtime frames
    loopIntervalMs?: number;  // Loop interval for runtime processing
    snapshotIntervalFrames?: number;
    advertiseProfileMirrors?: boolean; // Opt-in only; otherwise profiles do not correlate sibling entities.
    storage?: {
      enabled?: boolean;
      snapshotPeriodFrames?: number;
      retainSnapshots?: number;
      epochMaxBytes?: number;
      frameDbMaxBytes?: number;
      frameDbRetainFrames?: number;
      materializePeriodFrames?: number;
      canonicalHashPeriodFrames?: number;
      accountMerkleRadix?: 16 | 256;
    };
  } | undefined;
  runtimeState?: {
    loopActive?: boolean;
    loopPromise?: Promise<void> | null;
    stopLoop?: (() => void) | null;
    wakeLoop?: (() => void) | null;
    wakeRequested?: boolean;
    clockPrimed?: boolean;
    persistencePaused?: boolean;
    lastFrameAt?: number; // Wall-clock timestamp of the most recent processed runtime cycle
    processingPromise?: Promise<void> | null;
    p2p?: RuntimeP2P | null | undefined;
    pendingP2PConfig?: RuntimeP2PConfigLike | null;
    lastP2PConfig?: RuntimeP2PConfigLike | null;
    envChangeCallbacks?: Set<(env: Env) => void>;
    db?: Level<Buffer, Buffer> | null | undefined;
    dbOpenPromise?: Promise<boolean> | null | undefined;
    storageDb?: Level<Buffer, Buffer> | null | undefined;
    storageDbOpenPromise?: Promise<boolean> | null | undefined;
    storagePreviousDb?: Level<Buffer, Buffer> | null | undefined;
    storagePreviousDbOpenPromise?: Promise<boolean> | null | undefined;
    storageVerifiedCurrentHeight?: number;
    storageVerifiedPreviousHeight?: number;
    storageVerifiedHistoryHeight?: number;
    storageEpochRotatePromise?: Promise<void> | null;
    storageEntityHashDocs?: unknown;
    currentStorageOverlayMarks?: RuntimeOverlayRecord[];
    frameDb?: Level<Buffer, Buffer> | null | undefined;
    frameDbOpenPromise?: Promise<boolean> | null | undefined;
    infraDb?: Level<Buffer, Buffer> | null | undefined;
    infraDbOpenPromise?: Promise<boolean> | null | undefined;
    logState?: {
      nextId: number;
      mirrorToConsole?: boolean;
    };
    pendingAuditEvents?: Array<Record<string, unknown>>;
    pendingFrameDbRecords?: RuntimeFrameDbRecord[];
    cleanLogs?: string[];
    routeDeferState?: Map<string, {
      warnAt: number;
      gossipAt: number;
      deferredCount: number;
      escalated: boolean;
    }>;
    deferredNetworkMeta?: Map<string, {
      attempts: number;
      nextRetryAt: number;
    }>;
    entityRuntimeHints?: Map<string, {
      runtimeId: string;
      seenAt: number;
    }>;
    watcherDedupCounter?: import('./jadapter/watcher').EventBatchCounter;
    directEntityInputDispatch?: ((targetRuntimeId: string, input: DeliverableEntityInput, ingressTimestamp?: number) => boolean) | null;
    /**
     * True only when the target runtime is already attached to this same
     * server/relay process with a cached encryption key. This is local socket
     * delivery capability, not permission to queue arbitrary public relay hops.
     */
    canUseConnectedRelayFallback?: ((targetRuntimeId: string) => boolean) | null;
  } | undefined;
  history: EnvSnapshot[]; // Time machine snapshots - single source of truth
  gossip: GossipLayer;

  // Isolated BrowserVM instance per runtime (prevents cross-runtime state leakage)
  browserVM?: import('./jadapter/types').BrowserVMProvider | null; // BrowserVMProvider instance for this runtime (DEPRECATED: use jAdapter)
  browserVMState?: BrowserVMState; // Serialized BrowserVM state for time travel

  // Unified J-Machine adapter (preferred over browserVM or evms)
  // Use: const jAdapter = env.jAdapter ?? await createJAdapter({ mode: 'browservm', chainId: 31337 })
  jAdapter?: import('./jadapter/types').JAdapter;

  // EVM instances - DEPRECATED, use env.jAdapter or createJAdapter() from jadapter
  evms: Map<string, unknown>;

  // Active jurisdiction
  activeJurisdiction?: string | undefined; // Currently active J-replica name

  // Scenario mode: deterministic time control (scenarios set env.timestamp manually)
  scenarioMode?: boolean; // When true, runtime doesn't auto-update timestamp
  quietRuntimeLogs?: boolean; // When true, suppress noisy runtime console logs
  debugJWatcherBatches?: boolean; // Enables verbose J watcher batch routing diagnostics
  scenarioLogLevel?: 'debug' | 'info' | 'warn' | 'error'; // Scenario log verbosity
  strictScenario?: boolean; // When true, runtime asserts invariants per frame
  strictScenarioLabel?: string; // Optional label for strict scenario errors

  // Frame stepping: stop at specific frame for debugging
  stopAtFrame?: number | undefined; // When set, process() stops at this frame and dumps state

  // Frame display duration hint (for time-travel visualization)
  frameDisplayMs?: number | undefined; // How long to display this frame (default: 100ms)

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
  } | undefined;

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
  blockTimeMs?: number;                   // Settlement-chain block time estimate used for cross-j wall-clock deadlines
  lastBlockTimestamp: number;             // Timestamp (ms) of last block creation
  blockReady?: boolean;                   // True when mempool has items and blockDelayMs elapsed

  // JAdapter instance (for balance queries, transactions, etc)
  // Works with both browservm and rpc modes
  jadapter?: JAdapter;
  // RPC endpoints for this jurisdiction (preferred for j-watcher + batch broadcast)
  rpcs?: string[];
  // Chain id (optional, prefer jadapter.chainId when available)
  chainId?: number;
  // Persisted local view of depository.defaultDisputeDelay for deterministic handlers.
  defaultDisputeDelayBlocks?: number;

  // Visual position (for 3D rendering)
  position: { x: number; y: number; z: number };

  // Contract addresses (primary)
  depositoryAddress?: string; // Primary depository address (for replay protection)
  entityProviderAddress?: string; // Primary entity provider address

  // Additional deployed contract addresses.
  contracts?: {
    depository?: string;
    entityProvider?: string;
    account?: string;
    deltaTransformer?: string;
  };
}

/** J-Machine transaction (settlement layer) */
export type JTx =
  | {
      type: 'batch'; // ALL J-operations go through batch (matches Depository.processBatch)
      entityId: string;
      data: {
        batch: JBatch;
        hankoSignature?: string; // Quorum hanko (attached post-commit by entity consensus)
        batchHash?: string; // Hash of encoded batch (for hanko signing)
        encodedBatch?: string; // ABI-encoded batch (for on-chain submission)
        entityNonce?: number; // Entity nonce used for this batch
        feeOverrides?: {
          gasBumpBps?: number;
          maxFeePerGasWei?: string;
          maxPriorityFeePerGasWei?: string;
        };
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
  jReplicas: Map<string, JReplica>;        // J-layer state snapshot (same shape as live env)
  browserVMState?: BrowserVMState;
  runtimeInput: RuntimeInput;
  runtimeOutputs: RoutedEntityInput[];
  description: string;
  gossip?: {
    profiles: Profile[];
  };
  meta?: {
    title?: string; // Short headline (e.g., "Bank Run Begins")
    subtitle?: {
      title: string;           // Technical summary (e.g., "Reserve-to-Reserve Transfer")
      what?: string;           // What's happening (optional)
      why?: string;            // Why it matters (optional)
      tradfiParallel?: string; // Traditional finance equivalent (optional)
      keyMetrics?: string[];   // Bullet points of key numbers
    };
    displayMs?: number; // Display duration hint for time-travel visualization
  };
  // Interactive storytelling narrative
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
  // Frame-specific structured logs
  logs?: FrameLogEntry[];
}

// Entity types - canonical definition in ids.ts
export { type EntityType } from './ids';

// Constants
export const ENC = 'hex' as const;

// === PROFILE & NAME RESOLUTION TYPES ===

/**
 * Entity profile stored in gossip layer
 */
export interface EntityProfile {
  entityId: string;
  name: string; // Human-readable name e.g., "Alice Corp", "Bob's DAO"
  avatar?: string; // Custom avatar URL (fallback to generated avatar)
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
    mempool: unknown[]; // Pending transactions in J-Machine queue
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
  deployContract(bytecode: string, args?: unknown[]): Promise<string>;

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
    vmState?: unknown; // If BrowserVM - serialized @ethereumjs/vm state
  };

  // Entity registry
  entities: string[];

  // Runtime state (replicas + history)
  runtimeState?: {
    replicas: unknown; // Serialized Map<string, EntityReplica>
    history: EnvSnapshot[];
  };
}
