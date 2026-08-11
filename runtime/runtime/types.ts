import type { Level } from 'level';
import type { RuntimeP2P } from '../network/p2p/p2p';
import type {
  AccountHistoryRecord,
  RuntimeOverlayRecord,
} from '../types/account';
import type { FrameLogEntry, LogCategory } from '../types/logging';
import type {
  CertifiedRegistrationEvidence,
  JAdapterFailure,
  JReplica,
  JTx,
} from '../types/jurisdiction-runtime';
import type { CertifiedBoardNodeStore } from '../types/entity-board-registry';
import type { ConsumptionNodeStore } from '../entity/consumption-accumulator-types';
import type { AccountJClaimNodeStore } from '../types/account-j-claims';
import type {
  RecordEntityProviderActionSubmitResultData,
  RetryEntityProviderActionData,
} from '../types/entity-provider-actions';
import type {
  CertifiedEntityFrameLink,
  ConsensusConfig,
  EntityInput,
  EntityReplica,
} from '../entity/types';
/**
 * Runtime machine State, Input, Tx, routing envelopes, and local infrastructure.
 *
 * Entity, Account, Jurisdiction, and protocol types stay in their owner
 * modules. This file may import child-layer types to compose RuntimeReplica, but
 * it must never re-export them as a neutral convenience barrel.
 */

import type { GossipLayer } from '../network/p2p/gossip';
import type { Profile } from '../entity/profile';
import type { RuntimeP2PConfig } from './p2p-types';

import type {
  RuntimeSecurityIncident,
} from '../protocol/security-incident';

export interface RuntimeInput {
  runtimeTxs: RuntimeTx[];
  entityInputs: EntityInput[];
  jInputs?: JInput[]; // J-layer inputs (queue to J-mempool)
  /** Authenticated application receipts; persisted as part of the consuming R-frame. */
  reliableReceipts?: ReliableDeliveryReceipt[];
  timestamp?: number | undefined; // External ingress timestamp seed (ms) for this runtime input batch
  queuedAt?: number | undefined; // When first queued into runtime mempool (ms)
}

type ReliableDeliveryKind =
  | 'entity-frame'
  | 'hash-precommit'
  | 'leader-timeout-vote'
  | 'account-ack'
  | 'account-board-reseal'
  | 'j-prefix-attestation'
  | 'j-finality';

type ReliableDeliveryEvidenceKind =
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

type ReliableDeliveryReceiptBody = {
  /**
   * Canonical v1 receipts bind one exact durably applied identity. Receivers and
   * senders may compact protocol-terminal identities to one monotonic frontier
   * per lane, but height alone is not an authenticated ancestry proof and never
   * ACKs a different lower frameHash.
   */
  version: 1;
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

type PendingReliableIngress = {
  identity: ReliableDeliveryIdentity;
  targetRuntimeIds: Set<string>;
};

import type { JInput } from '../jurisdiction/machine/input';

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

export type NumberedRegistrationDefinition = Readonly<{
  name: string;
  validators: ReadonlyArray<string | Readonly<{ name: string; weight: number | bigint }>>;
  threshold: bigint;
  localSignerId: string | null;
  profileName?: string;
  position?: { x: number; y: number; z: number; jurisdiction?: string };
}>;

type NumberedRegistrationCommandEntity = Readonly<
  Omit<NumberedRegistrationDefinition, 'validators'> & {
    validators: ReadonlyArray<Readonly<{ name: string; weight: number }>>;
  }
>;

export type NumberedRegistrationCommand = Readonly<{
  jurisdictionRef: string;
  payerSignerId: string;
  entities: readonly NumberedRegistrationCommandEntity[];
}>;

export type NumberedRegistrationCommandResult = Readonly<{
  intentId: string;
  transactionHash: string;
  committedHeight: number;
  entities: ReadonlyArray<Readonly<{
    config: ConsensusConfig;
    entityNumber: number;
    entityId: string;
    localSignerId: string | null;
    isProposer: boolean;
    imported: boolean;
  }>>;
}>;

type NumberedRegistrationEntityPlan = {
  name: string;
  boardHash: string;
  config: ConsensusConfig;
  /** Local replica owner, or null when this Runtime only pays to register another board. */
  localSignerId: string | null;
  profileName?: string;
  position?: { x: number; y: number; z: number; jurisdiction?: string };
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

type QuarantinedNumberedRegistration = Omit<PendingNumberedRegistration, 'status'> & {
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
        position?: { x: number; y: number; z: number; jurisdiction?: string };
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
        headers?: import('../types/jurisdiction-events').ValidatorJBlockHeader[];
        blocks: import('../types/jurisdiction-events').ValidatorJEventBlock[];
      };
    }
  | {
      /** Internal-only, WAL-replayable publication of an authenticated watcher cursor. */
      type: 'advanceJWatcherCursor';
      data: {
        depositoryAddress: string;
        chainId: number;
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
        outcome: 'submitted' | 'eventBarrier' | 'transientFailure' | 'terminalFailure' | 'reconciled';
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

/**
 * Transport envelope for REA-bound entity inputs.
 *
 * signerId is mandatory once an input enters runtime queues/outbox/network. The
 * older "entityId only, resolve later" shape can silently route to a stale
 * read-only replica or the wrong validator. Only `EntityAddressedOutput` may
 * omit it, and Runtime must resolve that output before it becomes an input.
 */
export interface RoutedEntityInput extends EntityInput {
  signerId: string;
  runtimeId?: string;
  /**
   * Authenticated Runtime-frame provenance. Outbound it survives durable
   * retries so frames are never combined; inbound it binds paired cross-j
   * Account inputs to the same source envelope. A committed Runtime input
   * retains it so WAL replay cannot pair legs from different source frames.
   */
  sourceRuntimeFrame?: {
    height: number;
    timestamp: number;
  };
  /**
   * Transport-only cohort for the exact two cross-j Account legs. It never
   * authorizes money: the receiving Runtime still state-validates both signed
   * Account frames before applying either one. The marker prevents unrelated
   * ACKs from being coupled or garbage-collected as an atomic pair.
   */
  atomicCrossJurisdictionPair?: {
    phase: 'proposal' | 'ack';
    pairKey: string;
  };
}

/** Fields signed by the source Runtime for one committed outbound R-frame. */
export interface UnsignedRuntimeEntityInputsEnvelope {
  sourceRuntimeId: string;
  sourceRuntimeHeight: number;
  sourceRuntimeTimestamp: number;
  entityInputs: DeliverableEntityInput[];
  atomicCrossJurisdictionPair?: {
    phase: 'proposal' | 'ack';
    pairKey: string;
  };
}

/**
 * Transport-independent source authentication for Runtime-to-Runtime input.
 *
 * Relay hop authentication only proves who spoke to the relay. The encrypted
 * plaintext therefore carries its own signature, bound to the exact target,
 * so direct, relayed and process-local delivery enforce one canonical rule.
 */
export interface RuntimeEntityInputsEnvelope extends UnsignedRuntimeEntityInputsEnvelope {
  sourceSignature: string;
}

/**
 * Network-deliverable entity input.
 * By the time an input leaves the local runtime, target runtime resolution must
 * already be complete and runtimeId becomes mandatory.
 */
export interface DeliverableEntityInput extends RoutedEntityInput {
  runtimeId: string;
}

export type RuntimeHistoryRecord = AccountHistoryRecord | {
  kind: 'entityFrame';
  entityId: string;
  entityHeight: number;
  link: CertifiedEntityFrameLink;
  runtimeHeight?: number;
  timestamp?: number;
};

export type BrowserVMState = import('../jurisdiction/adapter/browservm/browservm-state').BrowserVmSerializedState;

/**
 * Deterministic data fixed by one committed Runtime frame.
 *
 * This object contains no mempool, transport, database handle, callback,
 * secret, wall clock, or retry machinery. A RuntimeFrame commits this State;
 * RuntimeReplica owns the machinery that builds and durably publishes it.
 */
export interface RuntimeState {
  eReplicas: Map<string, EntityReplica>;  // Entity replicas (E-layer state machines)
  jReplicas: Map<string, JReplica>;       // Jurisdiction replicas (J-layer EVM state)
  height: number;
  timestamp: number;
}

/** One live Runtime instance: committed State plus local machine machinery. */
interface RuntimeInfrastructure {
  /** Validator-local secrets; never enter Runtime State, WAL, or history. */
  entityEncryptionPrivateKeys?: Map<string, string>;
  /**
   * Process-local chain clients, keyed by canonical jurisdiction name.
   *
   * Providers, signers, sockets, and callbacks are capabilities, not State.
   * Keeping them beside JReplica would make the object non-deterministic and
   * force every hash/snapshot path to remember an exclusion list.
   */
  liveJAdapters?: Map<string, import('../jurisdiction/adapter/types').JAdapter>;
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
  /** Ephemeral keys owned by the active storage writer; never persisted. */
  storageReplicaMetaKeys?: Set<string>;
  /** Ephemeral, event-driven profile certification candidates; rebuilt by a full scan after restart. */
  pendingProfileCertificationEntityIds?: Set<string>;
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
  /** Writer-preference gate: queued financial frames cannot be starved by new API readers. */
  queuedFrameWriters?: number;
  frameWritersDrained?: Promise<void> | null;
  resolveFrameWritersDrained?: (() => void) | null;
  /** Infra-only read/write barrier; never part of deterministic Runtime State. */
  activeCommittedReaders?: number;
  committedReadersDrained?: Promise<void> | null;
  resolveCommittedReadersDrained?: (() => void) | null;
  /** True after owned-State mutation starts and until WAL-backed publish. */
  stateMutationInFlight?: boolean;
  /** Entity inputs detached from the live mempool and owned by the active runtime frame. */
  inFlightEntityInputs?: number;
  /** Reliable identities detached into the frame currently owned by the single writer. */
  inFlightReliableInputKeys?: Set<string>;
  p2p?: RuntimeP2P | null | undefined;
  pendingP2PConfig?: RuntimeP2PConfig | null;
  lastP2PConfig?: RuntimeP2PConfig | null;
  envChangeCallbacks?: Set<(state: RuntimeReplica) => void>;
  runtimeFrameCommitCallbacks?: Set<(frame: { height: number; runtimeInput: RuntimeInput }) => void>;
  storageDb?: Level<Buffer, Buffer> | null | undefined;
  storageDbOpenPromise?: Promise<boolean> | null | undefined;
  storagePreviousDb?: Level<Buffer, Buffer> | null | undefined;
  storagePreviousDbOpenPromise?: Promise<boolean> | null | undefined;
  storageVerifiedCurrentHeight?: number;
  storageVerifiedPreviousHeight?: number;
  storageVerifiedWalHeight?: number;
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
  runtimeWalDb?: Level<Buffer, Buffer> | null | undefined;
  runtimeWalDbOpenPromise?: Promise<boolean> | null | undefined;
  /** Rebuildable Entity/Account/J history indexes. Runtime WAL remains authoritative. */
  historyViewDb?: Level<Buffer, Buffer> | null | undefined;
  historyViewDbOpenPromise?: Promise<boolean> | null | undefined;
  infraDb?: Level<Buffer, Buffer> | null | undefined;
  infraDbOpenPromise?: Promise<boolean> | null | undefined;
  infraDbClosing?: boolean;
  infraDbPendingWrites?: Set<Promise<void>>;
  runtimeSyncChannel?: {
    postMessage(message: unknown): void;
    close(): void;
  } | null;
  /** Last post-WAL browser notification failure; never changes commit status. */
  runtimeSyncNotificationFailure?: {
    height: number;
    message: string;
  };
  logState?: {
    nextId: number;
    mirrorToConsole?: boolean;
  };
  /** Exact frame-local event set keyed by canonical bytes; preserves insertion order. */
  pendingAuditEvents?: Map<string, Record<string, unknown>>;
  /** Bounded, replayable wallet security status. Never stores untrusted payload bodies. */
  securityIncidents?: Map<string, RuntimeSecurityIncident>;
  recentReserveUpdatedEvents?: Map<string, {
    name: 'ReserveUpdated';
    args: Record<string, unknown>;
    blockNumber: number;
    blockHash: string;
    transactionHash: string;
    observedAt: number;
  }>;
  pendingHistoryRecords?: RuntimeHistoryRecord[];
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
  verifiedProfileRoutes?: Map<string, {
    runtimeId: string;
    runtimeSignerId: string;
    runtimeEncPubKey: string;
    lastUpdated: number;
  }>;
  entityRuntimeHints?: Map<string, {
    runtimeId: string;
    seenAt: number;
  }>;
  externalWalletWatchOwners?: Map<string, Map<string, number>>;
  watcherDedupCounter?: import('../jurisdiction/adapter/watcher').EventBatchCounter;
  directEntityInputsDispatch?: ((
    targetRuntimeId: string,
    envelope: RuntimeEntityInputsEnvelope,
    ingressTimestamp?: number,
  ) => import('../runtime/output-routing').RuntimeDirectEntityInputDispatchResult) | null;
  directReliableReceiptDispatch?: ((
    targetRuntimeId: string,
    receipt: ReliableDeliveryReceipt,
  ) => import('../protocol/payments/delivery-result').DeliveryResult) | null;
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
    state: RuntimeReplica,
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
  /** Process-local serialized command lane; its lifetime is exactly this RuntimeReplica. */
  numberedRegistrationDriver?: {
    inFlight: Map<string, Promise<NumberedRegistrationCommandResult>>;
    resumeRun: Promise<void> | null;
  };
  runtimeAdapterCommandFrontiers?: Map<
    string,
    import('./command-frontier').RuntimeAdapterCommandFrontier
  >;
}

export interface RuntimeReplica {
  state: RuntimeState;
  runtimeSeed?: string | undefined; // BrainVault seed backing this runtime (plaintext, dev mode)
  runtimeId?: string | undefined; // Runtime identity (usually signer1 address)
  lastProcessEnteredAt?: number; // Wall-clock timestamp of most recent process() entry
  /** Ephemeral wall-clock boundary for the active process(); never consensus or WAL state. */
  activeProcessProgressAt?: number;
  /** Last completed operational phase of the active process(); diagnostics only. */
  activeProcessProgressStep?: string;
  dbNamespace?: string; // DB namespace for per-runtime persistence (defaults to runtimeId)
  // The sole live Runtime ingress queue. Persisted frames separately call
  // their immutable applied input `runtimeInput`.
  runtimeMempool: RuntimeInput;
  overlay?: RuntimeOverlayRecord[];
  runtimeConfig?: {
    minFrameDelayMs?: number; // Minimum delay between runtime frames
    loopIntervalMs?: number;  // Loop interval for runtime processing
    /** In-memory/debug history cadence. Durable storage snapshots use storage.snapshotPeriodFrames. */
    snapshotIntervalFrames?: number;
    /** Local operator warning only; never rejects an otherwise valid Entity frame. */
    entityConsensusStateWarningBytes?: number;
    advertiseProfileMirrors?: boolean; // Opt-in only; otherwise profiles do not correlate sibling entities.
    /**
     * Local operator alarms. These never reject or alter a deterministic
     * frame: exceeding a budget emits a structured warning after processing.
     */
    performance?: {
      maxCloneBytes?: number;
      maxCloneMs?: number;
      maxReducerMs?: number;
      maxWalMs?: number;
    };
    storage?: {
      enabled?: boolean;
      snapshotPeriodFrames?: number;
      retainSnapshots?: number;
      epochMaxBytes?: number;
      historyViewMaxBytes?: number;
      historyViewRetainFrames?: number;
      materializePeriodFrames?: number;
      canonicalHashPeriodFrames?: number;
      accountMerkleRadix?: 16 | 256;
    };
  } | undefined;
  infrastructure?: RuntimeInfrastructure | undefined;
  /** Bounded local/debug timeline. Authoritative history lives in the storage WAL. */
  history: EnvSnapshot[];
  gossip: GossipLayer;

  // The BrowserVM's durable image belongs to the replica. Its live provider is
  // owned exclusively by the process-local JAdapter.
  browserVMState?: BrowserVMState; // Serialized BrowserVM state for time travel

  // Active jurisdiction
  activeJurisdiction?: string | undefined; // Currently active J-replica name

  // Scenario mode: deterministic time control (scenarios set env.timestamp manually)
  scenarioMode?: boolean; // When true, runtime doesn't auto-update timestamp
  // Explicit dependency injection for scenario execution. Visual previews use the
  // real in-process EVM so they never depend on or flood an external RPC endpoint.
  scenarioJAdapterMode?: import('../jurisdiction/adapter/types').JAdapterMode;
  quietRuntimeLogs?: boolean; // When true, suppress noisy runtime console logs
  debugJWatcherBatches?: boolean; // Enables verbose J watcher batch routing diagnostics
  scenarioLogLevel?: 'debug' | 'info' | 'warn' | 'error'; // Scenario log verbosity
  strictScenario?: boolean; // When true, runtime asserts invariants per frame
  strictScenarioLabel?: string; // Optional label for strict scenario errors

  // Frame stepping: stop at specific frame for debugging
  stopAtFrame?: number | undefined; // When set, process() stops at this frame and dumps state

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
  networkInbox?: RoutedEntityInput[];   // Inbound network messages queued for next tick
  pendingNetworkOutputs?: RoutedEntityInput[]; // Durable, bounded at-least-once transport outbox.

  // Frame-scoped structured logs (captured into snapshot, then reset)
  frameLogs: FrameLogEntry[];

  // Event emission methods (EVM-style - like Ethereum block logs)
  log: (message: string) => void;
  info: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => void;
  warn: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => void;
  error: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => void;
  emit: (eventName: string, data: Record<string, unknown>) => void; // Generic event emission
}

export interface EnvSnapshot {
  state: RuntimeState;
  runtimeSeed?: string;
  runtimeId?: string;
  dbNamespace?: string;
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
