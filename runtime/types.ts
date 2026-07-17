import type { OrderbookExtState } from './orderbook';
import type { SwapKey } from './orderbook/swap-keys';
import type { Level } from 'level';
import type { RuntimeP2P } from './networking/p2p';
import type { CrossJurisdictionBookAdmission, CrossJurisdictionSwapRoute } from './types/cross-jurisdiction';
import type { DebtEntry } from './types/debt';
import type {
  JPrefixAttestation,
  JPrefixCertificate,
  JPrefixRound,
  JBlockFinalized,
  ValidatorJHistory,
  JHistoryFinality,
} from './types/jurisdiction-events';
import type { HankoString } from './types/hanko';
import type {
  AccountInput,
  AccountMachine,
  AccountTx,
  HtlcNoteKey,
  HtlcRoute,
  RuntimeFrameDbRecord,
  RuntimeOverlayRecord,
} from './types/account';
import type { HubRebalanceConfig } from './types/rebalance';
import type { LendingState } from './types/lending';
import type { ConsensusOutputOrigin, EntityCommandNonceState, EntityTx } from './types/entity-tx';
import type { FrameLogEntry, LogCategory } from './types/logging';
import type {
  CertifiedRegistrationEvidence,
  JAdapterFailure,
  JReplica,
  JTx,
} from './types/jurisdiction-runtime';
import type { RuntimeFailureSignal } from './protocol/failure-taxonomy';
import type {
  CertifiedBoardNodeStore,
  CertifiedBoardRegistryState,
} from './types/entity-board-registry';
import type {
  ConsumptionAccumulatorState,
  ConsumptionNodeEntry,
  ConsumptionNodeStore,
} from './entity/consumption-accumulator-types';
import type {
  AccountJClaimNodeChanges,
  AccountJClaimNodeStore,
} from './types/account-j-claims';
import type {
  EntityProviderActionState,
  EntityProviderActionSubmitState,
  RecordEntityProviderActionSubmitResultData,
  RetryEntityProviderActionData,
} from './types/entity-provider-actions';
export type {
  CrossJurisdictionBookAdmission,
  CrossJurisdictionBookAdmissionReceipt,
  CrossJurisdictionBookLeg,
  CrossJurisdictionBookStatus,
  CrossJurisdictionCloseProof,
  CrossJurisdictionRouteDomain,
  CrossJurisdictionSettlementPolicy,
  CrossJurisdictionPendingFill,
  CrossJurisdictionPullBinding,
  CrossJurisdictionPullLeg,
  CrossJurisdictionSwapLeg,
  CrossJurisdictionSwapRoute,
  CrossJurisdictionSwapStatus,
  CrossJurisdictionTimePolicy,
} from './types/cross-jurisdiction';
export type {
  DebtEntry,
  DebtEventType,
  DebtStatus,
} from './types/debt';
export type {
  DisputeFinalizationEvidence,
  JBlockFinalized,
  JHistoryFinality,
  JPrefixAttestation,
  JPrefixCertificate,
  JPrefixClaim,
  JPrefixRound,
  JurisdictionEvent,
  JurisdictionEventBlock,
  JurisdictionEventData,
  ValidatorJBlockHeader,
  ValidatorJEventBlock,
  ValidatorJHistory,
} from './types/jurisdiction-events';
export type {
  FrameLogEntry,
  LogCategory,
  LogLevel,
} from './types/logging';
export type {
  JAdapterFailure,
  JAdapterFailureCategory,
  CertifiedRegistrationEvidence,
  JReplica,
  JTx,
} from './types/jurisdiction-runtime';
export type {
  HankoBoardDelays,
  HankoBoardMemberClaim,
  HankoEnvelope,
  HankoHex,
  HankoRecoveredSignature,
  HankoSemanticClaim,
  HankoString,
  HankoWireClaim,
  CanonicalHankoMergeResult,
} from './types/hanko';
export type { PaymentDeliveryMode } from './types/payment';
export type {
  EntityProviderActionCancelledData,
  EntityProviderActionExecutedData,
  EntityProviderExecutableActionKind,
  EntityProviderActionIntent,
  EntityProviderActionJTxData,
  EntityProviderActionKind,
  EntityProviderActionPayload,
  EntityProviderActionState,
  EntityProviderActionSubmitAttempt,
  EntityProviderActionSubmitOutcome,
  EntityProviderActionSubmitState,
  EntityProviderReleaseControlSharesPayload,
  EntityProviderTransferPayload,
  RecordEntityProviderActionSubmitResultData,
  RetryEntityProviderActionData,
} from './types/entity-provider-actions';
export type {
  CertifiedBoardBranchNode,
  CertifiedBoardAuthorityBinding,
  CertifiedBoardLeafNode,
  CertifiedBoardNodeStore,
  CertifiedBoardPatriciaNode,
  CertifiedBoardProof,
  CertifiedBoardRecord,
  CertifiedBoardRegistryState,
  CertifiedBoardSource,
} from './types/entity-board-registry';
export type {
  LendingLoan,
  LendingLoanStatus,
  LendingPoolPosition,
  LendingPoolStatus,
  LendingState,
  LendingTermId,
} from './types/lending';
export type {
  AccountDelta,
  AccountEvent,
  AccountFrame,
  AccountFrameAck,
  AccountBoardReseal,
  AccountBoardResealMigration,
  AccountFrameProposal,
  AccountInput,
  AccountDisputeSeal,
  AccountMachine,
  AccountStateDomain,
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
  buildDefaultRebalanceBaseFee,
  buildDefaultRebalancePolicy,
  DEFAULT_HARD_LIMIT_WHOLE,
  DEFAULT_MAX_FEE_WHOLE,
  DEFAULT_SOFT_LIMIT_WHOLE,
  QUOTE_EXPIRY_MS,
  REFERENCE_TOKEN_ID,
  scaleRawTokenAmount,
  scaleWholeTokenAmount,
} from './types/rebalance';
export type {
  AccountRebalanceShadowState,
  BilateralRebalanceFeePolicy,
  HubRebalanceConfig,
  RebalanceFeePolicySnapshot,
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
import type { CompletedBatch, JBatchState } from './jurisdiction/batch';
import type { CrontabState } from './entity/scheduler-types';

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
  announceProfilesForEntitiesNow(entityIds: string[], reason?: string): Promise<void>;
};

export interface JurisdictionConfig {
  address: string;
  name: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  chainId?: number;
  blockTimeMs?: number;
  /** First J block relevant to this registered entity's history. */
  registrationBlock?: number;
  /** Authenticated history scan starts at this EntityProvider deployment block. */
  entityProviderDeploymentBlock?: number;
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

export interface EntityLeaderState {
  activeValidatorId: string;
  view: number;
  changedAtHeight: number;
}

export interface EntityLeaderTimeoutVoteBody {
  entityId: string;
  targetHeight: number;
  previousFrameHash: string;
  fromView: number;
  toView: number;
  previousLeaderId: string;
  nextLeaderId: string;
}

export interface EntityLeaderTimeoutVote extends EntityLeaderTimeoutVoteBody {
  voterId: string;
  signature: string;
  /** Exact locally locked frame, including every precommit observed so far. */
  preparedFrame?: ProposedEntityFrame;
}

export interface EntityLeaderCertificate extends EntityLeaderTimeoutVoteBody {
  /** Compact signatures for certificates whose votes carry no lock evidence. */
  votes: Map<string, string>;
  /** Individual signed votes when prepared evidence differs per voter. */
  preparedVotes?: Map<string, EntityLeaderTimeoutVote>;
  /** Set only after exact prepared evidence reaches the Entity threshold. */
  preparedFrameHash?: string;
}

export interface RuntimeInput {
  runtimeTxs: RuntimeTx[];
  entityInputs: EntityInput[];
  jInputs?: JInput[]; // J-layer inputs (queue to J-mempool)
  /** Authenticated application receipts; persisted as part of the consuming R-frame. */
  reliableReceipts?: ReliableDeliveryReceipt[];
  timestamp?: number | undefined; // External ingress timestamp seed (ms) for this runtime input batch
  queuedAt?: number | undefined; // When first queued into runtime mempool (ms)
}

export type ReliableDeliveryKind =
  | 'entity-frame'
  | 'hash-precommit'
  | 'leader-timeout-vote'
  | 'account-ack'
  | 'account-board-reseal'
  | 'j-prefix-attestation'
  | 'j-finality';

export type ReliableDeliveryEvidenceKind =
  | 'entity-proposal'
  | 'entity-certificate'
  | 'hash-precommit'
  | 'leader-timeout-vote'
  | 'account-ack'
  | 'account-frame-ack'
  | 'account-board-reseal'
  | 'j-prefix-attestation'
  | 'j-finality';

export type ReliableDeliveryEvidenceBinding = {
  subject: string;
  digest: string;
};

/** Exact application identity for protocol messages that require durable delivery. */
export type ReliableDeliveryIdentity = {
  kind: ReliableDeliveryKind;
  entityId: string;
  signerId: string;
  laneKey: string;
  height: number;
  /** Required only for Account board re-seals: exact BoardActivated logIndex. */
  logIndex?: number;
  frameHash: string;
  logicalKey: string;
  evidenceVersion: 1;
  evidenceKind: ReliableDeliveryEvidenceKind;
  evidenceDigest: string;
  /** Immutable protocol body after separating relay authorization and post-body witnesses. */
  bodyDigest?: string;
  /** Canonical signer evidence needed to reject durable precommit equivocation. */
  evidenceBindings?: ReliableDeliveryEvidenceBinding[];
};

export type ReliableDeliveryReceiptBody = {
  /**
   * Version 2 receipts bind one exact durably applied identity. Receivers and
   * senders may compact protocol-terminal identities to one monotonic frontier
   * per lane, but height alone is not an authenticated ancestry proof and never
   * ACKs a different lower frameHash.
   */
  version: 2;
  /** `terminal` changes frontier retention, never the receipt's exact hash coverage. */
  coverage: 'exact' | 'terminal';
  receiverRuntimeId: string;
  identity: ReliableDeliveryIdentity;
  appliedRuntimeHeight: number;
};

export type ReliableDeliveryReceipt = {
  body: ReliableDeliveryReceiptBody;
  signature: string;
};

export type PendingReliableIngress = {
  identity: ReliableDeliveryIdentity;
  targetRuntimeIds: Set<string>;
};

/** J-layer input - queues JTx to jurisdiction mempool */
export interface JInput {
  jurisdictionName: string; // Which J-machine to queue to
  jTxs: JTx[]; // Transactions to queue
}

export type JurisdictionImportRequest = {
  name: string;
  chainId: number;
  ticker: string;
  rpcs: string[];
  /** Trusted provisioning receipt height; RPC import never probes pruned historical state. */
  entityProviderDeploymentBlock?: number;
  blockTimeMs?: number;
  startAtCurrentBlock?: boolean;
  rpcPolicy?: 'single' | 'failover' | { mode: 'quorum'; min: number };
  contracts?: {
    depository?: string;
    entityProvider?: string;
    account?: string;
    deltaTransformer?: string;
  };
  tokens?: Array<{
    symbol: string;
    decimals: number;
    initialSupply?: bigint;
  }>;
};

export type PendingJurisdictionImport = {
  importId: string;
  requestHash: string;
  request: JurisdictionImportRequest;
};

export type NumberedRegistrationEntityPlan = {
  name: string;
  boardHash: string;
  config: ConsensusConfig;
  profileName?: string;
  position?: { x: number; y: number; z: number; jurisdiction?: string; xlnomy?: string };
};

export type NumberedRegistrationRequest = {
  version: 1;
  intentId: string;
  stackKey: string;
  payerSignerId: string;
  entityProviderAddress: string;
  entities: NumberedRegistrationEntityPlan[];
};

export type PendingNumberedRegistration = {
  status: 'pending';
  request: NumberedRegistrationRequest;
  requestHash: string;
  rawTransaction: string;
  transactionHash: string;
  transactionNonce: number;
};

export type CompletedNumberedRegistration = {
  status: 'completed';
  intentId: string;
  requestHash: string;
  transactionHash: string;
  results: Array<{
    entityNumber: number;
    entityId: string;
    registrationBlock: number;
    evidenceHash: string;
  }>;
};

export type QuarantinedNumberedRegistration = Omit<PendingNumberedRegistration, 'status'> & {
  status: 'quarantined';
  reason: string;
};

export type NumberedRegistrationRecord =
  | PendingNumberedRegistration
  | CompletedNumberedRegistration
  | QuarantinedNumberedRegistration;

export type ResolveNumberedRegistrationData =
  | ({ kind: 'completed' } & Omit<CompletedNumberedRegistration, 'status'>)
  | {
      kind: 'quarantined';
      intentId: string;
      requestHash: string;
      transactionHash: string;
      reason: string;
    };

export type JurisdictionImportResult = {
  importId: string;
  requestHash: string;
  name: string;
  chainId: number;
  ticker: string;
  rpcs: string[];
  blockTimeMs?: number;
  blockNumber: string;
  stateRoot: string | null;
  defaultDisputeDelayBlocks: number;
  watcherConfirmationDepth: number;
  entityProviderDeploymentBlock: number;
  contracts: {
    depository: string;
    entityProvider: string;
    account: string;
    deltaTransformer: string;
  };
  browserVMState?: BrowserVMState;
};

export type RuntimeTx =
  | {
      /** Local-only replayable marker; commits remote command replay protection with its effects. */
      type: 'recordRuntimeAdapterCommand';
      data: {
        laneId: string;
        sequence: number;
        commandId: string;
        inputHash: string;
        /** Null only for a vault-owner lane; capability lanes always expire. */
        expiresAtMs: number | null;
      };
    }
  | {
      /** Durable exact signed transaction; broadcast retries must reuse these bytes. */
      type: 'recordNumberedRegistrationIntent';
      data: PendingNumberedRegistration;
    }
  | {
      /** Atomic terminal transition after exact imports, or fail-closed nonce quarantine. */
      type: 'resolveNumberedRegistrationIntent';
      data: ResolveNumberedRegistrationData;
    }
  | {
      /** Internal-only authenticated settlement-chain registration authority. */
      type: 'recordAuthenticatedJAuthority';
      data: CertifiedRegistrationEvidence;
    }
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
      type: 'observeJRange';
      data: {
        entityId: string;
        signerId: string;
        jurisdictionRef: string;
        scannedThroughHeight: number;
        tipBlockHash: string;
        headers?: import('./types/jurisdiction-events').ValidatorJBlockHeader[];
        blocks: import('./types/jurisdiction-events').ValidatorJEventBlock[];
      };
    }
  | {
      /** Internal-only, WAL-replayable publication of an authenticated watcher cursor. */
      type: 'advanceJWatcherCursor';
      data: {
        depositoryAddress: string;
        /** Missing only for a unique legacy replica that predates persisted chainId. */
        chainId?: number;
        blockNumber: number;
      };
    }
  | {
      type: 'rewindJHistory';
      data: {
        entityId: string;
        signerId: string;
        jurisdictionRef: string;
        conflictingHeight: number;
        conflictingBlockHash: string;
      };
    }
  | {
      /** Validator-local, WAL-replayable intent to submit one committed J batch. */
      type: 'retryJSubmit';
      data: {
        entityId: string;
        signerId: string;
        jurisdictionName: string;
        batchHash: string;
        entityNonce: number;
        batchGeneration: number;
        feeOverrides?: Extract<JTx, { type: 'batch' }>['data']['feeOverrides'];
      };
    }
  | {
      /** Validator-local result for a previously durable retryJSubmit attempt. */
      type: 'recordJSubmitResult';
      data: {
        entityId: string;
        signerId: string;
        jurisdictionName: string;
        batchHash: string;
        entityNonce: number;
        batchGeneration: number;
        attemptId: string;
        attemptNumber: number;
        attemptedAt: number;
        outcome: 'submitted' | 'transientFailure' | 'terminalFailure' | 'reconciled';
        message?: string;
        adapterFailure?: JAdapterFailure;
        txHash?: string;
      };
    }
  | {
      /** Validator-local, WAL-replayable intent for one committed EntityProvider action. */
      type: 'retryEntityProviderAction';
      data: RetryEntityProviderActionData;
    }
  | {
      /** Validator-local result for one exact durable EntityProvider attempt. */
      type: 'recordEntityProviderActionSubmitResult';
      data: RecordEntityProviderActionSubmitResultData;
    }
  | {
      type: 'importJ';
      data: JurisdictionImportRequest;
    }
  | {
      /** Internal-only result of an already durable importJ intent. */
      type: 'completeImportJ';
      data: JurisdictionImportResult;
    };

export interface EntityInput {
  entityId: string;
  /**
   * Exact local signer/replica that must process this input.
   *
   * Do not "resolve later" from entityId alone. Entity ids can have imported
   * read-only replicas, sibling jurisdiction replicas, or several validators.
   * Late proposer guessing previously let a proposal be applied to whichever
   * local replica looked convenient after routing. In financial state machines
   * the route is part of the command: entity + signer +, for network delivery,
   * runtime.
   */
  signerId: string;
  runtimeId?: string;
  from?: string;
  /** Validator-derived source identity, removed from the routed envelope. */
  certifiedOutputIdentity?: {
    lane: ConsensusOutputOrigin['lane'];
    sequence: bigint;
    semanticHash: string;
  };
  entityTxs?: EntityTx[];
  proposedFrame?: ProposedEntityFrame;

  // HANKO PRECOMMITS: signerId -> array of EOA sigs (one per proposedFrame.hashesToSign[])
  // Validators sign ALL hashes, proposer collects and merges into hankos after threshold
  hashPrecommitFrame?: {
    height: number;
    frameHash: string;
  };
  hashPrecommits?: Map<string, string[]>;
  /** Dedicated reliable lane for validator-local signed J-prefix evidence. */
  jPrefixAttestations?: Map<string, JPrefixAttestation>;
  leaderTimeoutVote?: EntityLeaderTimeoutVote;
}

/**
 * Transport envelope for REA-bound entity inputs.
 *
 * signerId is mandatory once an input enters runtime queues/outbox/network. The
 * older "entityId only, resolve later" shape can silently route to a stale
 * read-only replica or the wrong validator; raw EntityInput is the only place
 * where shorthand is allowed.
 */
export interface RoutedEntityInput extends EntityInput {
  signerId: string;
  runtimeId?: string;
}

/**
 * Live-only ingress received while a runtime frame is isolated from its Env.
 * The owning frame transaction must detach and drain this exact buffer on
 * commit or abort. It is deliberately excluded from every durable snapshot.
 */
export type RuntimeFrameIngressBuffer = {
  status: 'active' | 'draining' | 'closed';
  entries: Array<
    | {
        kind: 'entity';
        from: string;
        input: RoutedEntityInput;
        ingressTimestamp?: number;
      }
    | {
        kind: 'receipt';
        from: string;
        receipt: ReliableDeliveryReceipt;
      }
  >;
};

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
  /** Board hash in the exact authority epoch that created and may finish this proposal. */
  boardHash: string;
  /** Exact certified activation epoch; prevents A0 proposals reviving after A0 → B1 → A2. */
  boardEpoch: number;
  action: ProposalAction;
  /** Full canonical commitment to action.data, independently recomputed. */
  actionHash: string;
  // Votes: signerId → vote (string for simple votes, object for commented votes)
  // Future: Create VoteData interface for type-safe vote objects
  votes: Map<string, 'yes' | 'no' | 'abstain' | { choice: 'yes' | 'no' | 'abstain'; comment: string }>;
  status: 'pending' | 'executed' | 'rejected';
  created: number; // entity timestamp when proposal was created (deterministic)
}

export type ProposalAction =
  | {
      type: 'collective_message';
      data: { message: string };
    }
  | {
      type: 'entity_transaction';
      data: {
        version: 1;
        actionHash: string;
        txs: EntityTx[];
      };
    };

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

export type {
  ConsensusOutputOrigin,
  EntityCommandNonceState,
  EntityTx,
  SignedEntityCommandV2,
} from './types/entity-tx';

export interface EntitySwapPair {
  baseTokenId: number;
  quoteTokenId: number;
  pairId: string; // canonical sorted token key used by orderbook books map
}

export interface PendingCrossJurisdictionFillAck {
  accountId: string;
  tx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;
  storedAt: number;
  ttlExpiredAt?: number;
  reason?: string;
}

export type ExternalWalletBalanceRecord = {
  tokenAddress: string;
  tokenId?: number;
  balance: bigint;
  jHeight: number;
  transactionHash?: string;
};

export type ExternalWalletAllowanceRecord = {
  tokenAddress: string;
  spender: string;
  allowance: bigint;
  jHeight: number;
  transactionHash?: string;
};

export type ExternalWalletState = {
  balances: Map<string, Map<string, ExternalWalletBalanceRecord>>;
  allowances: Map<string, Map<string, ExternalWalletAllowanceRecord>>;
};

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
  /** Bounded exact-once namespace for independently signed board-member commands. */
  entityCommandNonces?: EntityCommandNonceState;
  messages: string[];
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;
  prevFrameHash?: string; // Chain linkage for BFT consensus (keccak256 of previous frame)
  leaderState?: EntityLeaderState;

  // 💰 Financial state
  // Financial invariant: entity reserves are always keyed by numeric tokenId.
  // Never persist or pass string token keys through live state.
  reserves: Map<number, bigint>; // tokenId -> amount only, metadata from TOKEN_REGISTRY
  accounts: Map<string, AccountMachine>; // canonicalKey "left:right" -> account state
  // External EOA balances/allowances observed through finalized J snapshots.
  // Keyed by owner EOA, then token/spender keys, so multi-validator entities
  // keep one deterministic map instead of signer-local side-channel state.
  externalWallet?: ExternalWalletState;
  // Exact settlement approvals waiting for Account mempool + ACK quiescence.
  // Bounded one-per-account; value is the governance-approved workspace hash.
  deferredAccountProposals?: Map<string, string>;
  // 🔭 J-machine tracking (JBlock consensus)
  lastFinalizedJHeight: number;           // Last finalized J-block height
  // Bounded display/audit cache only. Finalized effects plus jHistoryFinality
  // are authoritative; deleting these bodies must not change consensus.
  jBlockChain: JBlockFinalized[];
  jHistoryFinality?: JHistoryFinality;
  /** Entity-finalized active board authority for this exact jurisdiction stack. */
  certifiedBoardState?: CertifiedBoardRegistryState;

  // 🔗 Account machine integration
  accountInputQueue?: AccountInput[]; // Queue of settlement events to be processed by a-machine

  // ⏰ Declarative entity-local schedule. Persisted as pure data and rebound to handlers at runtime.
  crontabState?: CrontabState;

  // 📦 J-Batch system - accumulates operations for on-chain submission (typed in j-batch.ts)
  jBatchState?: JBatchState;
  /** Bounded current EntityProvider nonce plus at most one committed action. */
  entityProviderActionState?: EntityProviderActionState;
  batchHistory?: CompletedBatch[]; // Last completed batch records for UI + replay diagnostics


  // 🔐 Deterministic entity-scoped X25519 keys for HTLC envelope encryption.
  // These are derived exactly once at entity creation/import and are required
  // for every locally-owned entity. Missing keys are a hard invariant failure.
  entityEncPubKey: string;
  entityEncPrivKey: string;
  /** Entity-consensus-certified public board key manifest; never contains private material. */
  profileEncryptionManifest?: import('./protocol/htlc/validator-encryption').ValidatorEncryptionManifest;

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
  // Fill notices can outrun the local account frame that materializes the
  // source-side offer. Keep the ack durably in entity state until the account
  // offer is visible instead of throwing every runtime loop.
  pendingCrossJurisdictionFillAcks?: Map<string, PendingCrossJurisdictionFillAck>;
  // Cross-jurisdiction book admission is local hub gate state. A cross order
  // can enter the shared matcher only after source and target account frames
  // both committed their pull_lock receipts.
  crossJurisdictionBookAdmissions?: Map<string, CrossJurisdictionBookAdmission>;

  // 🔄 Rebalance Configuration - Hub-level matching strategy
  hubRebalanceConfig?: HubRebalanceConfig;

  // 🏦 Hub lending pools and term loans. This is hub-local consensus state:
  // borrowers receive ordinary bilateral credit, while the hub records term,
  // rate, and maturity here.
  lending?: LendingState;

  /**
   * Exact-once certified-output commitment. The root is consensus authority;
   * content-addressed nodes are validator-local witnesses and never authority.
   */
  consumptionAccumulator?: ConsumptionAccumulatorState;
  /** Generic source-output lifetime frontier. Account-frame outputs use Account height instead. */
  certifiedOutputSequences?: Map<string, {
    lastSequence: bigint;
    lastSemanticHash: string;
  }>;
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
export type HashType =
  | 'entityFrame'
  | 'entityOutput'
  | 'accountFrame'
  | 'dispute'
  | 'settlement'
  | 'profile'
  | 'jBatch'
  | 'entityProviderAction';

/** Hash with type info for entity-level signing */
export interface HashToSign {
  hash: string;
  type: HashType;
  context: string;  // e.g., "account:0002:frame:1" or "account:0002:dispute"
}

export interface ProposedEntityFrame {
  height: number;
  /** Exact predecessor committed by this frame hash. Never inferred from transport order. */
  parentFrameHash: string;
  /** Exact post-replay consensus root signed by every validator. */
  stateRoot: string;
  /** Signed compact post-state authority commitment for durable lineage verification. */
  authorityRoot: string;
  /** Proposer-chosen deterministic frame time; validators replay with this value. */
  timestamp: number;
  txs: EntityTx[];
  hash: string;
  leader: {
    proposerSignerId: string;
    view: number;
    certificate?: EntityLeaderCertificate;
    /** View-change authorization to relay this exact already-prepared frame. */
    relayCertificate?: EntityLeaderCertificate;
  };

  /** Independent board authorization for the exact J prefix, when one is due. */
  jPrefixCertificate?: JPrefixCertificate;

  // HANKO SYSTEM:
  // 1. During frame creation: proposer collects hashes that need signing
  hashesToSign?: HashToSign[];  // Entity frame hash + account-level hashes with types

  // 2. During precommit: validators send EOA signatures (one per hash)
  // signerId -> array of EOA signatures (indexes match hashesToSign[])
  collectedSigs?: Map<string, string[]>;

  // 3. After threshold: merged quorum hankos (one per hash, indexes match hashesToSign[])
  hankos?: HankoString[];
}

/**
 * Durable quorum certificate for one Entity state transition.
 *
 * The full frame carries one validator signature bundle variant, while
 * `postAuthority` exposes only the compact authority fields committed by the
 * signed `authorityRoot`. Storage validates and deterministically selects one
 * individually valid certificate variant for each immutable frame body.
 */
export interface EntityFrameAuthority {
  config: ConsensusConfig;
  leaderState: EntityLeaderState;
}

export interface CertifiedEntityFrameLink {
  frame: ProposedEntityFrame;
  postAuthority: EntityFrameAuthority;
}

/** Locally trusted genesis/checkpoint root published by the authoritative R-frame WAL. */
export interface CertifiedEntityLineageAnchor {
  entityId: string;
  height: number;
  frameHash: string;
  stateRoot: string;
  authority: EntityFrameAuthority;
  /** Required for non-self-certifying (numbered/named) H0 authorities. */
  authorityEvidenceHash?: string;
  /**
   * Validator-local trust boundary created only by an atomic Runtime WAL commit.
   * This is recovery metadata, never an Entity/peer certificate.
   */
  runtimeCheckpoint?: {
    runtimeHeight: number;
    replicaSetRoot: string;
  };
}

/**
 * Validator-private result of replaying one exact proposed frame.
 *
 * The frame hash and height make the state and side effects indivisible: a
 * restored replica must never combine output from one proposal with state from
 * another. This bundle is durable local metadata, never protocol payload.
 */
export interface ValidatorEntityFrameExecution {
  frameHash: string;
  height: number;
  state: EntityState;
  outputs: EntityInput[];
  jOutputs: JInput[];
  hashesToSign: HashToSign[];
  /** Validator-computed CAS delta, published only when this exact frame commits. */
  consumptionNodeChanges?: {
    newNodes: readonly ConsumptionNodeEntry[];
    replacedNodeHashes: readonly string[];
  };
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
}

export interface EntityReplica {
  entityId: string;
  signerId: string;
  state: EntityState;
  mempool: EntityTx[];
  proposal?: ProposedEntityFrame;
  lockedFrame?: ProposedEntityFrame; // Frame this validator is locked/precommitted to
  /** Validator-local replay result; commits never consume proposer-supplied state or outputs. */
  validatorExecution?: ValidatorEntityFrameExecution;
  /** Deduplicated certified suffix used to prove any legal local replica lag. */
  certifiedFrameLineage?: CertifiedEntityFrameLink[];
  certifiedFrameAnchor?: CertifiedEntityLineageAnchor;
  isProposer: boolean;
  leaderVotes?: Map<string, EntityLeaderTimeoutVote>;
  pendingLeaderCertificate?: EntityLeaderCertificate;
  lastConsensusProgressAt?: number;
  /** Validator-private durable J-chain evidence; never part of EntityState. */
  jHistory?: ValidatorJHistory;
  /** Signed validator heads for the current Entity-height J-prefix round. */
  jPrefixRound?: JPrefixRound;
  /** Validator-private J submission receipt; never part of EntityState consensus. */
  jSubmitState?: {
    jurisdictionName: string;
    batchHash: string;
    entityNonce: number;
    batchGeneration: number;
    submitAttempts: number;
    lastSubmittedAt: number;
    txHash?: string;
    lastFailure?: {
      message: string;
      failedAt: number;
      failure: RuntimeFailureSignal;
      adapterFailure?: JAdapterFailure;
    };
    terminalFailure?: {
      message: string;
      failedAt: number;
      failure: RuntimeFailureSignal;
      adapterFailure?: JAdapterFailure;
    };
    lastResultAttemptId?: string;
    lastResultAt?: number;
    lastResultOutcome?: 'submitted' | 'transientFailure' | 'terminalFailure' | 'reconciled';
    /** Canonical full payload of lastResultAttemptId; detects conflicting WAL duplicates. */
    lastResultFingerprint?: string;
    /** Bounded durable fingerprints for recent processed attempt IDs. */
    resultFingerprints?: Record<string, string>;
    /** Oldest-to-newest deterministic order for the bounded dedupe journal. */
    resultFingerprintOrder?: string[];
  };
  /** Validator-local EntityProvider submit receipt; never part of Entity consensus. */
  entityProviderActionSubmitState?: EntityProviderActionSubmitState;
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
    type: 'accountFrame' | 'dispute' | 'profile' | 'settlement' | 'jBatch' | 'entityProviderAction';
    entityHeight: number;  // Height when created
    createdAt: number;     // Timestamp
  }>;
}

export type BrowserVMState = import('./jadapter/browservm-state').BrowserVmSerializedState;

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
    /** Local operator warning only; never rejects an otherwise valid Entity frame. */
    entityConsensusStateWarningBytes?: number;
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
    lifecyclePhase?: 'booting' | 'running' | 'quiescing' | 'stopped' | 'halted';
    loopActive?: boolean;
    halted?: boolean;
    fatalDebugPayload?: {
      message: string;
      stack?: string;
      height?: number;
      timestamp?: number;
    };
    loopPromise?: Promise<void> | null;
    stopLoop?: (() => void) | null;
    wakeLoop?: (() => void) | null;
    wakeRequested?: boolean;
    scheduledWakeIndex?: {
      heap: Array<{
        dueAt: number;
        entityId: string;
        signerId: string;
        generation: number;
      }>;
      generations: Map<string, number>;
      replicas: Map<string, EntityReplica>;
      initialized: boolean;
    };
    persistencePaused?: boolean;
    persistenceQuiescing?: boolean;
    lastFrameAt?: number; // Wall-clock timestamp of the most recent processed runtime cycle
    maxEntityInputsPerFrame?: number;
    maxEntityTxsPerFrame?: number;
    processingPromise?: Promise<void> | null;
    /** Entity inputs detached from the live mempool and owned by the active runtime frame. */
    inFlightEntityInputs?: number;
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
    /** Content-addressed board nodes. Authority is the root in EntityState. */
    certifiedBoardNodes?: CertifiedBoardNodeStore;
    /** Newly created immutable nodes awaiting the same atomic batch as a root. */
    pendingCertifiedBoardNodes?: CertifiedBoardNodeStore;
    /** Content-addressed consumed-output witnesses. EntityState root is authority. */
    consumptionNodes?: ConsumptionNodeStore;
    /** Committed nodes awaiting the same atomic storage batch as EntityState. */
    pendingConsumptionNodes?: ConsumptionNodeStore;
    /** Obsolete committed path nodes awaiting safe cross-replica reachability GC. */
    pendingConsumptionNodeDeletes?: Set<string>;
    /** Content-addressed bilateral Account J-claim witnesses. Account roots are authority. */
    accountJClaimNodes?: AccountJClaimNodeStore;
    /** Committed nodes awaiting the same atomic batch as Account root documents. */
    pendingAccountJClaimNodes?: AccountJClaimNodeStore;
    /** Obsolete path nodes awaiting safe cross-replica reachability GC. */
    pendingAccountJClaimNodeDeletes?: Set<string>;
    /** Validator-local receipt proofs; never sourced from Entity/peer state. */
    certifiedRegistrationEvidence?: Map<string, CertifiedRegistrationEvidence>;
    currentStorageOverlayMarks?: RuntimeOverlayRecord[];
    frameDb?: Level<Buffer, Buffer> | null | undefined;
    frameDbOpenPromise?: Promise<boolean> | null | undefined;
    infraDb?: Level<Buffer, Buffer> | null | undefined;
    infraDbOpenPromise?: Promise<boolean> | null | undefined;
    infraDbClosing?: boolean;
    infraDbPendingWrites?: Set<Promise<void>>;
    runtimeSyncChannel?: {
      postMessage(message: unknown): void;
      close(): void;
    } | null;
    logState?: {
      nextId: number;
      mirrorToConsole?: boolean;
    };
    pendingAuditEvents?: Array<Record<string, unknown>>;
    recentJEvents?: Array<{
      name: string;
      args: Record<string, unknown>;
      blockNumber: number;
      blockHash: string;
      transactionHash: string;
      observedAt: number;
    }>;
    recentReserveUpdatedEvents?: Map<string, {
      name: 'ReserveUpdated';
      args: Record<string, unknown>;
      blockNumber: number;
      blockHash: string;
      transactionHash: string;
      observedAt: number;
    }>;
    quarantinedRuntimeInputs?: Array<{
      id: string;
      height: number;
      timestamp: number;
      reason: string;
      message: string;
      action: 'halted';
      counts: {
        runtimeTxs: number;
        entityInputs: number;
        jInputs: number;
      };
      entityInputs: Array<{
        entityId: string;
        signerId: string;
        txTypes: string[];
      }>;
      runtimeTxTypes: string[];
      jInputs: Array<{
        jurisdictionName: string;
        jTxCount: number;
      }>;
    }>;
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
    /** Durable receiver active exact frontier, keyed by authenticated source runtime + lane. */
    reliableIngressReceiptLedger?: Map<string, ReliableDeliveryReceipt>;
    /** Durable receiver terminal watermark, keyed by authenticated source runtime + lane. */
    reliableIngressTerminalWatermarks?: Map<string, ReliableDeliveryReceipt>;
    /** Durable sender-side active exact frontier, keyed by receiver + reliable lane. */
    receivedReliableReceiptLedger?: Map<string, ReliableDeliveryReceipt>;
    /** Durable sender-side protocol-terminal watermark, keyed by receiver + reliable lane. */
    receivedReliableTerminalWatermarks?: Map<string, ReliableDeliveryReceipt>;
    /** Ephemeral ingress waiters. These never imply durability and are never snapshotted. */
    pendingReliableIngress?: Map<string, PendingReliableIngress>;
    /** Ephemeral guard: receipt exists in working state but the enclosing frame is not durable yet. */
    reliableIngressCommitting?: Set<string>;
    /** Ephemeral exact-owner sidecar for ingress racing an isolated frame. */
    runtimeFrameIngressBuffer?: RuntimeFrameIngressBuffer;
    verifiedProfileRoutes?: Map<string, {
      runtimeId: string;
      lastUpdated: number;
    }>;
    entityRuntimeHints?: Map<string, {
      runtimeId: string;
      seenAt: number;
    }>;
    externalWalletWatchOwners?: Map<string, Map<string, number>>;
    watcherDedupCounter?: import('./jadapter/watcher').EventBatchCounter;
    directEntityInputDispatch?: ((
      targetRuntimeId: string,
      input: DeliverableEntityInput,
      ingressTimestamp?: number,
    ) => import('./machine/output-routing').RuntimeDirectEntityInputDispatchResult) | null;
    directReliableReceiptDispatch?: ((
      targetRuntimeId: string,
      receipt: ReliableDeliveryReceipt,
    ) => import('./protocol/payments/delivery-result').DeliveryResult) | null;
    /**
     * True only when the target runtime is already attached to this same
     * server/relay process with a cached encryption key. This is local socket
     * delivery capability, not permission to queue arbitrary public relay hops.
     */
    canUseConnectedRelayFallback?: ((targetRuntimeId: string) => boolean) | null;
    /**
     * Optional post-commit backup barrier. If present, runtime holds remote
     * side effects until this callback confirms external recovery storage for
     * the just-committed state.
     */
    recoveryBackupBarrier?: ((
      env: Env,
      info: {
        height: number;
        remoteOutputCount: number;
        jInputCount: number;
      },
    ) => Promise<void>) | null;
    /** Already committed J side effects awaiting a durable result RuntimeTx. */
    pendingCommittedJOutbox?: JInput[];
    /** Durable import intents awaiting a local, replayable completeImportJ result. */
    pendingJurisdictionImports?: Map<string, PendingJurisdictionImport>;
    /** Caller-idempotent registration batches; completed records are O(actual batches). */
    numberedRegistrationIntents?: Map<string, NumberedRegistrationRecord>;
    runtimeAdapterCommandFrontiers?: Map<
      string,
      import('./radapter/command-frontier').RuntimeAdapterCommandFrontier
    >;
  } | undefined;
  /** Bounded local/debug timeline. Authoritative history lives in the storage WAL. */
  history: EnvSnapshot[];
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
  pendingNetworkOutputs?: RoutedEntityInput[]; // Durable, bounded at-least-once transport outbox.
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

export type { EntityProfile, NameIndex, NameSearchResult, ProfileUpdateTx } from './types/profile';

export type {
  ConnectionRules,
  JurisdictionEVM,
  TopologyLayer,
  TopologyType,
  Xlnomy,
  XlnomySnapshot,
  XlnomyTopology,
} from './types/xlnomy';
