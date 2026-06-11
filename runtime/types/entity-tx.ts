import type { JurisdictionEvent, JurisdictionEventData } from './jurisdiction-events';
import type { AccountInput, CrossJurisdictionSecretRelay, SettlementDiff, SettlementOp } from './account';
import type { CrossJurisdictionBookAdmissionReceipt, CrossJurisdictionPullBinding, CrossJurisdictionSwapRoute } from './cross-jurisdiction';
import type { ProfileUpdateTx } from './profile';
import type { ProposalAction } from '../types';

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
        crossJurisdiction?: CrossJurisdictionPullBinding;
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
        starterInitialArguments?: string;
        starterIncrementedArguments?: string;
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
        targetReceipt?: CrossJurisdictionBookAdmissionReceipt;
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
        cumulativeFillRatio: number; // Coarse 0-65535 compatibility/dispute ratio.
        fillNumerator?: bigint;
        fillDenominator?: bigint;
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
      type: 'admitCrossJurisdictionBookOrder';
      data: {
        route: CrossJurisdictionSwapRoute;
        receipt: CrossJurisdictionBookAdmissionReceipt;
        reason?: string;
      };
    }
  | {
      type: 'applyCrossJurisdictionBookProgress';
      data: {
        orderId: string;
        sourceEntityId: string;
        fillSeq: number;
        incrementalSourceAmount: bigint;
        incrementalTargetAmount: bigint;
        cumulativeSourceAmount: bigint;
        cumulativeTargetAmount: bigint;
        cumulativeFillRatio: number; // Coarse 0-65535 compatibility/dispute ratio.
        fillNumerator?: bigint;
        fillDenominator?: bigint;
        priceImprovementMode?: 'source_savings' | 'target_bonus' | 'none';
        priceImprovementAmount?: bigint;
        priceImprovementTokenId?: number;
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
        cooperative?: boolean;  // Unsupported compatibility flag. Finalize is unilateral timeout or signed counter-proof.
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
        fillRatio: number; // Coarse 0-65535 compatibility/dispute ratio.
        fillNumerator?: bigint;
        fillDenominator?: bigint;
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
