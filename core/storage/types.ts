import type { BookState, EntityReferral, HubProfile, OrderbookExtState } from '../orderbook';
import type { CrontabState } from '../entity/scheduler/types';
import type { JBatchState } from '../jurisdiction/machine/batch';
import type { AccountReplica, HtlcRoute } from '../types/account';
import type { ConsensusConfig, EntityReplica, EntityState, EntitySwapPair, LockBookEntry, Proposal } from '../entity/types';
import type { RoutedEntityInput, RuntimeInput } from '../runtime/types';
import type { DebtEntry } from '../types/finance/debt';
import type { FrameLogEntry } from '../types/logging';
import type { HubRebalanceConfig } from '../types/finance/rebalance';
import type { DurableOutputRetryState } from '../runtime/delivery/durable-output-retry';
import type { EntityInfraContext } from '../types/entity/infra-context';
import type { RadixMerkleRadix } from '../protocol/state/radix-merkle';
import type { Covered } from '../types/hash-coverage/coverage';
import type {
  EntityContextPayloadHash,
  RuntimeMachineRootHash,
  RuntimeOutputPayloadHash,
} from '../protocol/hashes';

export type {
  EntityContextPayloadHash,
  RuntimeMachineRootHash,
  RuntimeOutputPayloadHash,
} from '../protocol/hashes';

export type RuntimeDbLike = {
  get: (key: Buffer) => Promise<Buffer>;
  put?: (key: Buffer, value: Buffer, options?: { sync?: boolean }) => Promise<void>;
  batch: () => {
    put: (key: Buffer, value: Buffer) => unknown;
    del: (key: Buffer) => unknown;
    write: (options?: { sync?: boolean }) => Promise<void>;
  };
  keys?: (options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean }) => AsyncIterable<Buffer | Uint8Array | string>;
};

export type PerfDeps = {
  getPerfMs: () => number;
  formatPerfMs: (value: number) => string;
};

export type StorageRuntimeConfig = {
  enabled?: boolean;
  snapshotPeriodFrames?: number;
  retainSnapshots?: number;
  epochMaxBytes?: number;
  historyViewMaxBytes?: number;
  historyViewRetainFrames?: number;
  materializePeriodFrames?: number;
  /**
   * Canonical runtime-state commitment.
   * 0 disables it; a positive value stores and verifies a full canonical hash
   * on that cadence and on mandatory materialization checkpoints. Every frame
   * remains protected by the chained authoritative storage frame hash.
   */
  canonicalHashPeriodFrames?: number;
  accountMerkleRadix?: RadixMerkleRadix;
};

export type StoragePersistenceBoundary =
  | 'after-authoritative-history-commit'
  | 'after-history-view-commit'
  | 'after-current-cache-commit'
  | 'after-history-view-prune'
  | 'after-snapshot-body-batch'
  | 'after-snapshot-manifest'
  | 'after-snapshot-history-publish'
  | 'after-snapshot-retention-prune'
  | 'after-replay-prune'
  | 'after-snapshot-history-head'
  | 'after-snapshot-current-head'
  | 'after-epoch-history-head-reset'
  | 'after-restore-current-fence'
  | 'after-restore-current-clear-batch'
  | 'after-restore-current-body'
  | 'after-restore-authoritative-swap'
  | 'after-restore-current-head';

export type StoragePersistenceBoundaryHook = (
  boundary: StoragePersistenceBoundary,
) => void | Promise<void>;

export type StoragePersistenceProgressHook = (step: string) => void;

export type StorageHead = {
  schemaVersion: number;
  latestHeight: number;
  latestMaterializedHeight: number;
  latestSnapshotHeight: number;
  snapshotPeriodFrames: number;
  retainSnapshots: number;
  epochMaxBytes: number;
  accountMerkleRadix: RadixMerkleRadix;
  epochReplayBytes: number;
  retainedHistoryBytes: number;
};

export type StorageEntityCoreDoc = {
  entityId: string;
  height: number;
  timestamp: number;
  nonces: Map<string, number>;
  entityCommandNonces?: EntityState['entityCommandNonces'];
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;
  prevFrameHash?: string;
  leaderState?: EntityState['leaderState'];
  reserves: Map<number, bigint>;
  externalWallet?: EntityState['externalWallet'];
  deferredAccountProposals?: Map<string, string>;
  settlementContinuations?: EntityState['settlementContinuations'];
  lastFinalizedJHeight: number;
  jHistoryFinality?: EntityState['jHistoryFinality'];
  certifiedBoardState?: EntityState['certifiedBoardState'];
  crontabState?: CrontabState;
  jBatchState?: JBatchState;
  entityProviderActionState?: EntityState['entityProviderActionState'];
  entityEncryptionPublicKey: EntityState['entityEncryptionPublicKey'];
  profile: EntityState['profile'];
  htlcRoutes: Map<string, HtlcRoute>;
  htlcFeesEarned: bigint;
  consumptionAccumulator?: EntityState['consumptionAccumulator'];
  certifiedOutputSequences?: EntityState['certifiedOutputSequences'];
  outDebtsByToken?: Map<number, Map<string, DebtEntry>>;
  inDebtsByToken?: Map<number, Map<string, DebtEntry>>;
  lockBook: Map<string, LockBookEntry>;
  swapTradingPairs?: EntitySwapPair[];
  crossJurisdictionSwaps?: EntityState['crossJurisdictionSwaps'];
  crossJurisdictionAuthorizations?: EntityState['crossJurisdictionAuthorizations'];
  pendingCrossJurisdictionFillAcks?: EntityState['pendingCrossJurisdictionFillAcks'];
  crossJurisdictionBookAdmissions?: EntityState['crossJurisdictionBookAdmissions'];
  hubRebalanceConfig?: HubRebalanceConfig;
  orderbookHubProfile?: HubProfile;
  orderbookReferrals?: Map<string, EntityReferral>;
  orderbookPairDimensions?: OrderbookExtState['pairDimensions'];
  lending?: EntityState['lending'];
};

export type StorageAccountDoc = AccountReplica;

export type StorageDoc =
  | { family: 'entity'; entityId: string; value: StorageEntityCoreDoc }
  | { family: 'account'; entityId: string; counterpartyId: string; value: StorageAccountDoc }
  | { family: 'book'; entityId: string; pairId: string; value: BookState };

export type StorageDocRef =
  | { family: 'entity'; entityId: string }
  | { family: 'account'; entityId: string; counterpartyId: string }
  | { family: 'book'; entityId: string; pairId: string };

export type RuntimeFrame = {
  height: number;
  timestamp: number;
  prevFrameHash?: string;
  frameHash?: string;
  /** Commits the exact validator-local recovery metadata published with this frame. */
  replicaMetaDigest: string;
  replicaMetaCheckpoint: boolean;
  replicaMetaStateMode: 'live-head' | 'shared-entity-state';
  /** Required per-frame replay commitment over Entity heads and durable Runtime state. */
  postStateHash: string;
  materializedState?: boolean;
  /**
   * Independent canonical root computed directly from live EntityReplica data.
   * This intentionally avoids cloneEntityReplica(), project*Doc(), msgpack, and
   * coarse-doc storage cells so replay verification can catch bugs in those
   * pipelines instead of repeating them.
   */
  canonicalStateHash?: string;
  canonicalEntityHashes?: StorageFrameEntityHash[];
  /** Sparse canonical Entity + durable R-machine replay oracle. */
  runtimeStateHash?: string;
  runtimeInput: RuntimeInput;
  /** Replica-id to immutable infrastructure-context payload hash. */
  entityContextRefs?: Map<string, EntityContextPayloadHash>;
  /** Exact bounded input queue retained after this frame (for deferred H+1 work). */
  pendingRuntimeInput?: RuntimeInput;
  /** Root of the exact typed Runtime checkpoint Patricia graph for this height. */
  runtimeMachineRoot?: RuntimeMachineGraphRoot;
  /** Ordered immutable payload references; bodies live once in the outbox keyspace. */
  runtimeOutputRefs?: RuntimeOutputPayloadHash[];
  /** Retry/backoff state for the retained transport outputs. */
  runtimeOutputRetryState?: DurableOutputRetryState[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
};

/** Bodies addressed by one RuntimeFrame. They are never fields of the frame itself. */
export type RuntimeFramePayloads = {
  entityContexts: Map<string, EntityInfraContext>;
  runtimeMachine?: Record<string, unknown>;
  runtimeOutputs?: RoutedEntityInput[];
};

export type RuntimeMachineGraphRoot = Readonly<{
  rootHash: RuntimeMachineRootHash;
  leafCount: number;
}>;

export type PersistedFrameJournal = Pick<RuntimeFrame,
  | 'height'
  | 'timestamp'
  | 'replicaMetaDigest'
  | 'postStateHash'
  | 'replicaMetaCheckpoint'
  | 'replicaMetaStateMode'
  | 'runtimeInput'
  | 'pendingRuntimeInput'
  | 'runtimeOutputRefs'
  | 'runtimeOutputRetryState'
  | 'runtimeStateHash'
> & RuntimeFramePayloads & { logs: FrameLogEntry[] };

export type StorageFrameEntityHash = {
  entityId: string;
  hash: string;
  cellCount: number;
};

export type StorageReplicaMeta = {
  entityId: string;
  signerId: string;
  isProposer: boolean;
  /** Validator-local presentation index rebuilt from certified Entity frames. */
  htlcNotes?: EntityReplica['htlcNotes'];
  mempool: EntityReplica['mempool'];
  position?: EntityReplica['position'];
  proposal?: EntityReplica['proposal'];
  lockedFrame?: EntityReplica['lockedFrame'];
  candidate?: EntityReplica['candidate'];
  certifiedFrameHead?: EntityReplica['certifiedFrameHead'];
  certifiedFrameAnchor?: EntityReplica['certifiedFrameAnchor'];
  hankoWitness?: EntityReplica['hankoWitness'];
  leaderVotes?: EntityReplica['leaderVotes'];
  pendingLeaderCertificate?: EntityReplica['pendingLeaderCertificate'];
  lastConsensusProgressAt?: EntityReplica['lastConsensusProgressAt'];
  jHistory?: EntityReplica['jHistory'];
  jPrefixRound?: EntityReplica['jPrefixRound'];
  jSubmitState?: EntityReplica['jSubmitState'];
  entityProviderActionSubmitState?: EntityReplica['entityProviderActionSubmitState'];
};

type AssertNoUnclassifiedPersistenceKeys<T extends never> = T;
type EntityPersistenceSplitKeys =
  | 'accounts'
  | 'orderbookExt';
type ReplicaPersistenceSplitKeys = 'state';

type PersistenceCoverage =
  | AssertNoUnclassifiedPersistenceKeys<Exclude<keyof AccountReplica, keyof StorageAccountDoc | 'state'>>
  | AssertNoUnclassifiedPersistenceKeys<Exclude<
    keyof EntityState,
    keyof StorageEntityCoreDoc | EntityPersistenceSplitKeys
  >>
  | AssertNoUnclassifiedPersistenceKeys<Exclude<
    keyof EntityReplica,
    keyof StorageReplicaMeta | ReplicaPersistenceSplitKeys
  >>;

export type StorageDiffRecord = Covered<{
  height: number;
  puts: StorageDoc[];
  dels: StorageDocRef[];
}, PersistenceCoverage>;

export type StorageSnapshotManifest = {
  height: number;
  createdAt: number;
  docCount: number;
};

export type StorageDebugStats = {
  head: StorageHead | null;
  frameCount: number;
  diffCount: number;
  snapshotHeights: number[];
  liveEntityCount: number;
  liveAccountCount: number;
  liveAccountFieldCount?: number;
  liveAccountFieldBytes?: number;
  liveBookCount: number;
  accountGraphBranchCount?: number;
  accountGraphLeafCount?: number;
  bookGraphBranchCount?: number;
  bookGraphLeafCount?: number;
  certifiedBoardNodeCount?: number;
  consumptionNodeCount?: number;
  accountJClaimNodeCount?: number;
  certifiedBoardNodeBytes?: number;
  consumptionNodeBytes?: number;
  accountJClaimNodeBytes?: number;
  frameBytes: number;
  diffBytes: number;
  snapshotBytes: number;
  liveBytes: number;
  historyBytes: number;
  totalBytes: number;
  maxFrameBytes: number;
  maxDiffBytes: number;
  maxSnapshotBytes: number;
  epochDbs?: Array<{
    role: 'current' | 'history';
    path: string;
    latestHeight: number;
    latestSnapshotHeight: number;
    frameCount: number;
    diffCount: number;
    snapshotCount: number;
    liveBytes: number;
    historyBytes: number;
    totalBytes: number;
  }>;
};

export type StorageAccountRef = Extract<StorageDocRef, { family: 'account' }>;
export type StorageBookRef = Extract<StorageDocRef, { family: 'book' }>;
export type StorageOverlayRefs = {
  touchedEntities: Set<string>;
  touchedAccounts: Map<string, StorageAccountRef>;
  touchedBooks: Map<string, StorageBookRef>;
  touchedBookEntities: Set<string>;
};

export type StorageReplicaLookup = Map<string, { replicaKey: string; replica: EntityReplica; state: EntityState }>;

export type HistoryViewPut = { key: Buffer; value: Buffer };

export type StorageHistoryViewHead = {
  schemaVersion: number;
  latestHeight: number;
  latestPrunedRuntimeHeight: number;
  retainedBytes: number;
  maxBytes: number;
  retainFrames: number;
};

export type NamespaceBytes = {
  count: number;
  bytes: number;
  maxValueBytes: number;
};

export type StorageEpochSeedStats = {
  liveBytes: number;
  snapshotBytes: number;
  frameBytes: number;
  docCount: number;
};
