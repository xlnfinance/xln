import type { JurisdictionEventData } from './jurisdiction-events';
import type { AccountPeerInput, AccountState, AccountStateDomain, SettlementOp } from './account';
import type { CrossJurisdictionCloseProof, CrossJurisdictionSwapRoute } from './cross-jurisdiction';
import type { LendingTermId } from './lending';
import type { ProposalAction } from '../entity/types';
import type { PaymentDeliveryMode } from './payment';
import type { ValidatorEncryptionAttestation } from '../protocol/htlc/validator-encryption';
import type { EntityProfileDescriptor } from '../entity/profile/profile-descriptor';
import type { CertifiedBoardAuthorityBinding } from './entity-board-registry';
import type { ConsumptionProof } from '../entity/consumption/consumption-accumulator-types';
import type { MultiRecipientCiphertext } from '../protocol/htlc/multi-recipient';

type ProfileUpdateTx = {
  name?: string;
  avatar?: string;
  bio?: string;
  website?: string;
};

export type SignedEntityCommandV1 = Readonly<{
  version: 1;
  entityId: string;
  /** Trusted jurisdiction-stack commitment, recomputed from EntityState. */
  stackKey: string;
  /** Exact current board encoded as on-chain validator EOAs + weights. */
  boardHash: string;
  /** Trusted activation epoch from the local certified board registry; lazy entities stay at zero. */
  boardEpoch: number;
  /** Consensus board identity. Numeric aliases stay aliases. */
  authorSignerId: string;
  /** EOA bound to authorSignerId by the certified manifest/current board. */
  authorSigner: string;
  /** Strictly sequential inside the exact current boardHash + boardEpoch namespace. */
  nonce: bigint;
  txsHash: string;
  txs: EntityTx[];
  signature: string;
}>;

export type EntityCommandNonceState = {
  version: 1;
  boardHash: string;
  boardEpoch: number;
  /** One bounded retry/equivocation fence per current board alias. */
  bySigner: Map<string, {
    nonce: bigint;
    commandHash: string;
  }>;
};

/**
 * Bounded Entity-owned work that follows one exact bilateral settlement.
 *
 * Account consensus never interprets these actions. The proposing Entity
 * commits the plan, binds it to the resulting workspace hash, and materializes
 * it only after both Account replicas have committed `ready_to_submit`.
 */
type SettlementContinuationAction =
  | {
      type: 'r2r';
      toEntityId: string;
      tokenId: number;
      amount: bigint;
    }
  | {
      type: 'r2e';
      receivingEntity: string;
      tokenId: number;
      amount: bigint;
    }
  | {
      type: 'r2c';
      counterpartyId: string;
      receivingEntityId?: string;
      tokenId: number;
      amount: bigint;
    };

type SettlementContinuationPlan = {
  actions: SettlementContinuationAction[];
  broadcast: boolean;
};

export type PendingSettlementContinuation = SettlementContinuationPlan & {
  workspaceHash: string;
};

export type ConsensusOutputOrigin = {
  sourceEntityId: string;
  lane: 'generic' | 'account-frame' | 'account-ack' | 'account-dispute';
  /** Lifetime-monotonic for this exact source→target relationship. */
  sequence: bigint;
  /** Stable payload commitment preserved across a current-board reissue. */
  semanticHash: string;
  height: number;
  frameHash: string;
  outputIndex: number;
  /** Required for a source whose id is certified in a jurisdiction registry. */
  boardAuthority?: CertifiedBoardAuthorityBinding;
};

type EntityTxPayload =
  | {
      /** Independently authored board-member command; validators replay and verify it. */
      type: 'entityCommand';
      data: SignedEntityCommandV1;
    }
  | {
      /** Quorum-certified source-frame output, deduplicated in target consensus state. */
      type: 'consensusOutput';
      data: {
        origin: ConsensusOutputOrigin;
        outputHanko: string;
        targetEntityId: string;
        entityTxs: EntityTx[];
        /** Target-proposer witness against the target's pre-frame accumulator root. */
        consumptionProof?: ConsumptionProof;
      };
    }
  | {
      /**
       * Runtime-local cross-j effect between jurisdiction siblings controlled
       * by the same proposer runtime. It is never accepted from P2P and needs
       * no source-board Hanko or cross-entity sequence.
       */
      type: 'runtimeOutput';
      data: {
        protocol: 'cross-j';
        sourceEntityId: string;
        targetEntityId: string;
        entityTxs: EntityTx[];
      };
    }
  | {
      /** Collective reissue of the exact bounded last generic source output. */
      type: 'reissueCertifiedOutput';
      data: {
        targetEntityId: string;
        /** Committed recipient lane; transport must never derive it from local topology during replay. */
        targetSignerId: string;
        sequence: bigint;
        semanticHash: string;
        entityTxs: EntityTx[];
      };
    }
  | {
      /**
       * Consensus-visible scheduler marker. The local runtime may create it
       * only for its proposer replica; validators replay the same crontab work
       * from this exact payload when checking the proposed entity frame.
       */
      type: 'scheduledWake';
      data: {
        version: 1;
        proposerSignerId: string;
        dueAt: number;
        jobs: Array<{
          kind: 'hook' | 'task';
          id: string;
          dueAt: number;
        }>;
      };
    }
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
      /** Public validator key manifest proposed only after gossip convergence. */
      type: 'certifyProfile';
      data: {
        encryptionAttestations: ValidatorEncryptionAttestation[];
      };
    }
  | {
      type: 'j_event';
      data: JurisdictionEventData;
    }
  | {
      type: 'accountInput';
      /** Exact peer consensus input committed by the parent Entity frame. */
      data: AccountPeerInput;
    }
  | {
      type: 'openAccount';
      data: {
        targetEntityId: string;
        /** Bilaterally agreed seconds clock, ordered by canonical left/right entity id. */
        disputeConfig: AccountState['disputeConfig'];
        accountDomain?: AccountStateDomain; // Materialized from committed Entity jurisdiction before signing
        watchSeed?: string;    // Generated at runtime ingress; fixed for this bilateral account
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
      type: 'directPayment';
      data: {
        targetEntityId: string;
        tokenId: number;
        amount: bigint;
        route: string[]; // Full path from source to target
        description?: string;
        deliveryMode: Extract<PaymentDeliveryMode, 'direct' | 'trusted'>;
        trustedGatewayEntityId?: string;
      };
    }
  | {
      type: 'htlcPayment';
      data: {
        targetEntityId: string;
        tokenId: number;
        amount: bigint;
        /** Caller-authorized maximum gross first-hop lock, including all route fees. */
        maxSenderDebit: bigint;
        route: string[]; // Full path from source to target
        description?: string;
        deliveryMode: Extract<PaymentDeliveryMode, 'instant' | 'async'>;
        startedAtMs?: number;
        /** Raw local-ingress hint only. Stripped before command/frame/WAL. */
        secret?: string;
        hashlock?: string;
        // Opaque onion and independently verifiable public commitments frozen
        // at local ingress before any multisig voting delay.
        preparedEnvelope?: unknown;
        preparedSenderLockAmount?: bigint | string;
        preparedTotalFee?: bigint | string;
        preparedLockId?: string;
        preparedTimelock?: bigint | string;
        preparedRevealBeforeHeight?: number;
        preparedAtEntityHeight?: number;
        preparedAtJHeight?: number;
        preparedRouteProfiles?: Array<{ descriptor: EntityProfileDescriptor; profileHanko: string }>;
        preparedHopForwardAmounts?: Array<{ entityId: string; amount: bigint | string }>;
      };
    }
  | {
      /**
       * Default-proposer-authored reveal of exactly one committed onion layer.
       * The encrypted layer remains the binding authority; this action exposes
       * only the deterministic effect that every validator can replay.
       */
      type: 'htlcOnionAdvance';
      data: {
        version: 1;
        proposerSignerId: string;
        inboundEntityId: string;
        inboundLockId: string;
        encryptedLayerHash: string;
        hashlock: string;
        tokenId: number;
        amount: bigint;
        timelock: bigint;
        revealBeforeHeight: number;
        advance:
          | {
              kind: 'final';
              secretOffer: MultiRecipientCiphertext;
              description?: string;
              startedAtMs?: number;
            }
          | {
              kind: 'acceptOffer';
              offerHash: string;
            }
          | {
              /**
               * Plaintext becomes consensus-visible only after the exact
               * Account ACK below has durably committed the final unlock.
               */
              kind: 'revealAccepted';
              offerHash: string;
              accountFrameHash: string;
              accountFrameHeight: number;
              secret: string;
            }
          | {
              kind: 'forward';
              nextHop: string;
              forwardAmount: bigint;
              innerEnvelope: MultiRecipientCiphertext;
            };
      };
    }
  | {
      // Resolve a direct/account HTLC when the preimage is known.
      type: 'resolveHtlcLock';
      data: {
        counterpartyEntityId: string;
        lockId: string;
        secret: string;
        crossJurisdictionRouteId?: string;
        description?: string;
      };
    }
  | {
      type: 'crossPullClose';
      data: {
        counterpartyEntityId: string;
        pullId: string;
        binary: string;
        proof: CrossJurisdictionCloseProof;
        route?: CrossJurisdictionSwapRoute;
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
      type: 'prepareDispute';
      data: {
        counterpartyEntityId: string;
        description?: string;
        minCooldownMs?: number;
        /** Internal cross-j recovery binding retained until remote book cleanup ACKs. */
        crossJurisdictionRouteId?: string;
        /** Dynamic evidence; a malformed wrapper becomes empty and the signed transformer decides. */
        starterInitialArguments?: string;
      };
    }
  | {
      type: 'disputeStart';
      data: {
        counterpartyEntityId: string;
        /** Exact committed route authorizing a target user to force its source-side dispute. */
        crossJurisdictionRouteId?: string;
        starterInitialArguments?: string;
        starterCounterArguments?: string;
        description?: string;
      };
    }
  | {
      type: 'registerCrossJurisdictionSwap';
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
      /** Source-hub default proposer publishes public ladder commitments; its seed stays local. */
      type: 'materializeCrossJurisdictionSwap';
      data: {
        proposerSignerId: string;
        route: CrossJurisdictionSwapRoute;
      };
    }
  | {
      /** Source-hub default proposer reveals only the committed fill; validators verify the public proof. */
      type: 'materializeCrossJurisdictionClear';
      data: {
        proposerSignerId: string;
        orderId: string;
        binary: string;
        proof: CrossJurisdictionCloseProof;
      };
    }
  | {
      type: 'crossJurisdictionFillNotice';
      data: {
        orderId: string;
        routeHash?: string;
        previousFillSeq?: number;
        fillSeq: number;
        incrementalSourceAmount: bigint;
        incrementalTargetAmount: bigint;
        cumulativeSourceAmount: bigint;
        cumulativeTargetAmount: bigint;
        cumulativeFillRatio: number; // Coarse 0-65535 ratio; this is the on-chain uint16 dispute form.
        fillNumerator: bigint;
        fillDenominator: bigint;
        priceImprovementMode?: 'source_savings';
        priceImprovementAmount?: bigint;
        priceImprovementTokenId?: number;
        cancelRemainder?: boolean;
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
      /**
       * Sibling fanout: any dispute observed on one cross-j leg instructs the
       * other sibling to prepareDispute on its leg so both clocks start and
       * reveals/ports can land before either T expires. Wall-clock T may
       * differ across chains; equal delay *config* is the prepare-time rule.
       */
      type: 'crossJurisdictionForceSiblingDispute';
      data: {
        routeId: string;
        observedCounterpartyEntityId: string;
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
        cumulativeFillRatio: number; // Coarse 0-65535 ratio; this is the on-chain uint16 dispute form.
        fillNumerator: bigint;
        fillDenominator: bigint;
        priceImprovementMode?: 'source_savings';
        priceImprovementAmount?: bigint;
        priceImprovementTokenId?: number;
        cancelRemainder?: boolean;
        reason?: string;
      };
    }
  | {
      type: 'removeCrossJurisdictionBookOrder';
      data: {
        orderId: string;
        sourceEntityId: string;
        /** Present only when the source Account requires a committed book-removal ACK. */
        sourceAccountId?: string;
        route?: CrossJurisdictionSwapRoute;
        reason?: string;
      };
    }
  | {
      /** Committed canonical-book ACK; never emitted before removal commits. */
      type: 'crossJurisdictionBookOrderRemoved';
      data: {
        orderId: string;
        sourceEntityId: string;
        sourceAccountId: string;
        route: CrossJurisdictionSwapRoute;
        removedAt: number;
        reason?: string;
      };
    }
  | {
      type: 'disputeFinalize';
      data: {
        counterpartyEntityId: string;
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
      /** Collective-only transfer from this numbered Entity's ERC1155 balance. */
      type: 'entityProviderTransfer';
      data: {
        to: string;
        tokenId: bigint;
        amount: bigint;
      };
    }
  | {
      /** Collective-only release to an explicit quorum-selected custodian. */
      type: 'entityProviderReleaseControlShares';
      data: {
        recipientAddress: string;
        controlAmount: bigint;
        dividendAmount: bigint;
        purpose: string;
      };
    }
  | {
      /** Collective-only cancellation of the exact current EntityProvider action. */
      type: 'entityProviderCancelAction';
      data: {
        actionHash: string;
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
      type: 'lendingOffer';
      data: {
        positionId: string;
        hubEntityId: string;
        tokenId: number;
        amount: bigint;
        termId: LendingTermId;
        interestBps: number;
      };
    }
  | {
      type: 'lendingBorrow';
      data: {
        requestId: string;
        hubEntityId: string;
        tokenId: number;
        amount: bigint;
        termId: LendingTermId;
        maxInterestBps?: number;
      };
    }
  | {
      type: 'lendingRepay';
      data: {
        hubEntityId: string;
        loanId: string;
        tokenId: number;
        amount: bigint;
      };
    }
  | {
      type: 'lendingClosePosition';
      data: {
        hubEntityId: string;
        positionId: string;
      };
    }
  | {
      // Declare entity as hub: sets rebalance config + routing fees, announces to gossip
      type: 'setHubConfig';
      data: {
        hubName?: string;                   // Stable mesh hub identity; display profile name can change
        matchingStrategy?: 'amount' | 'time' | 'fee'; // Default: 'amount'
        policyVersion?: number;             // Fee-policy version (auto-counter if omitted)
        routingFeePPM?: number;             // Default: 1 (0.0001%)
        baseFee?: bigint;                   // Default: 0n
        swapTakerFeeBps?: number;           // Default: 0 (testnet hubs may set 1)
        disputeAutoFinalizeMode?: 'auto' | 'ignore';
        minCollateralThreshold?: bigint;    // Reserved for future policy gates
        c2rWithdrawSoftLimit?: bigint;              // Hub-owned collateral keep-buffer before C→R pullback
        rebalanceBaseFee?: bigint;          // Fixed rebalance fee component
        rebalanceLiquidityFeeBps?: bigint;  // Rebalance liquidity fee in bps (volume-based)
        rebalanceGasFee?: bigint;           // Flat gas recovery component
        rebalanceTimeoutMs?: number;        // Auto-refund timeout for unfulfilled prepaid requests
      };
    }
  | {
      // User sets entity-private rebalance automation policy.
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
        maxFee: bigint;
        minNetReceive: bigint;
        // Explicit limit price in ORDERBOOK_PRICE_SCALE ticks (quote per 1 base).
        // Sent together with give/want for deterministic cross-checking.
        priceTicks?: bigint;
        timeInForce?: 0 | 1 | 2; // 0 = GTC, 1 = IOC, 2 = FOK
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
        usdQuoteAuthorityEntityId: string;
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
  // ═══════════════════════════════════════════════════════════════
  // SETTLEMENT WORKSPACE OPERATIONS
  // ═══════════════════════════════════════════════════════════════
  | {
      // Propose new settlement (creates workspace)
      type: 'settle_propose';
      data: {
        counterpartyEntityId: string;
        ops: SettlementOp[];
        executorIsLeft?: boolean;
        memo?: string;
        continuation?: SettlementContinuationPlan;
      };
    }
  | {
      // Update existing settlement workspace (replaces ops)
      type: 'settle_update';
      data: {
        counterpartyEntityId: string;
        ops: SettlementOp[];
        executorIsLeft?: boolean;
        memo?: string;
      };
    }
  | {
      // Approve settlement (sign + bump coopNonce)
      type: 'settle_approve';
      data: {
        counterpartyEntityId: string;
        workspaceHash: string;
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
  // ═══════════════════════════════════════════════════════════════
  // RESERVE OPERATIONS
  // ═══════════════════════════════════════════════════════════════
  ;

export type EntityTx = EntityTxPayload;
