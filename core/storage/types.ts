import type { BookState, EntityReferral, HubProfile, OrderbookExtState } from '../orderbook';
import type { CrontabState } from '../entity/scheduler/types';
import type { JBatchState } from '../jurisdiction/machine/batch';
import type { AccountReplica } from '../types/account';
import type { ConsensusConfig, EntityReplica, EntityState, EntitySwapPair, Proposal } from '../entity/types';
import type { RoutedEntityInput, RuntimeInput } from '../runtime/types';
import type { DebtEntry } from '../types/finance/debt';
import type { FrameLogEntry } from '../types/logging';
import type { HubRebalanceConfig } from '../types/finance/rebalance';
import type { EntityInfraContext } from '../types/entity/infra-context';
import type { RadixMerkleRadix } from '../protocol/state/radix-merkle';
import type { Covered } from '../types/hash-coverage/coverage';
import type {
  EntityContextPayloadHash,
  RuntimeMachineRootHash,
  RuntimeOutputsDigest,
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
  | 'after-authoritative-commit'
  | 'after-current-cache-commit'
  | 'after-snapshot-body-batch'
  | 'after-snapshot-manifest'
  | 'after-snapshot-wal-publish'
  | 'after-snapshot-retention-prune'
  | 'after-replay-prune'
  | 'after-snapshot-wal-head'
  | 'after-snapshot-current-head'
  | 'after-epoch-wal-head-reset'
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
  retainedWalBytes: number;
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
  paybook: {
    entries: Map<string, EntityState['paybook']['entries'] extends Map<string, infer Entry> ? Entry : never>;
    feesEarned: bigint;
  };
  outDebtsByToken?: Map<number, Map<string, DebtEntry>>;
  inDebtsByToken?: Map<number, Map<string, DebtEntry>>;
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
  /** Required per-frame replay commitment over durable Runtime component digests. */
  postStateHash: string;
  materializedState: boolean;
  /**
   * Independent canonical root over frame coordinates and live Entity roots.
   * This intentionally avoids cloneEntityReplica(), project*Doc(), msgpack, and
   * coarse-doc storage cells so replay verification can catch bugs in those
   * pipelines instead of repeating them.
   */
  canonicalStateHash?: string;
  canonicalEntityHashes?: StorageFrameEntityHash[];
  runtimeInput: RuntimeInput;
  /** Ordered committed machine events for this exact Runtime frame. */
  logs: FrameLogEntry[];
  /** Replica-id to manifest digest; physical rows are keyed by this frame height + replica path. */
  entityContextRefs?: Map<string, EntityContextPayloadHash>;
  /** Root of the exact typed Runtime checkpoint Patricia graph for this height. */
  runtimeMachineRoot?: RuntimeMachineGraphRoot;
  /** Exact Rust Account-authority restore tokens made durable by this frame. */
  accountAuthorityCheckpoints?: StorageRscoreCheckpointRef[];
  /** Exact flat outbox rows at `(height,index)`, committed in byte order. */
  runtimeOutputCount: number;
  runtimeOutputsDigest: RuntimeOutputsDigest;
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
};

export type StorageRscoreCheckpointRef = Readonly<{
  ownerEntityId: string;
  protocolFingerprint: string;
  baseRevision: string;
  revision: string;
  accountsRoot: string;
  signerDigest: string;
  accountCount: number;
}>;

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
  | 'materializedState'
  | 'runtimeInput'
  | 'logs'
  | 'runtimeOutputCount'
  | 'runtimeOutputsDigest'
  | 'canonicalStateHash'
> & RuntimeFramePayloads;

export type StorageFrameEntityHash = {
  entityId: string;
  hash: string;
  cellCount: number;
};

export type StorageReplicaMeta = {
  entityId: string;
  signerId: string;
  isProposer: boolean;
  position?: EntityReplica['position'];
  certifiedFrameHead?: EntityReplica['certifiedFrameHead'];
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
/**
 * Replica-envelope work is RAM-only. Accepted Runtime inputs are already in
 * the WAL, so persisting these overlays would duplicate replay authority and
 * make an uncommitted candidate affect a durable Runtime root.
 */
type ReplicaPersistenceSplitKeys =
  | 'state'
  | 'mempool'
  | 'proposal'
  | 'lockedFrame'
  | 'candidate';

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

export type StorageSnapshotManifest = Covered<{
  height: number;
  createdAt: number;
  docCount: number;
}, PersistenceCoverage>;

export type StorageDebugStats = {
  head: StorageHead | null;
  frameCount: number;
  snapshotHeights: number[];
  liveEntityCount: number;
  liveEntityFieldCount?: number;
  liveEntityFieldBytes?: number;
  liveAccountCount: number;
  liveAccountFieldCount?: number;
  liveAccountFieldBytes?: number;
  liveBookCount: number;
  accountGraphBranchCount?: number;
  accountGraphLeafCount?: number;
  bookGraphBranchCount?: number;
  bookGraphLeafCount?: number;
  entityGraphBranchCount?: number;
  entityGraphLeafCount?: number;
  certifiedBoardNodeCount?: number;
  accountJClaimNodeCount?: number;
  certifiedBoardNodeBytes?: number;
  accountJClaimNodeBytes?: number;
  frameBytes: number;
  boundedValueCount?: number;
  boundedValueBytes?: number;
  snapshotBytes: number;
  liveBytes: number;
  walBytes: number;
  totalBytes: number;
  maxFrameBytes: number;
  maxPhysicalValueBytes?: number;
  maxSnapshotBytes: number;
  epochDbs?: Array<{
    role: 'current' | 'wal';
    path: string;
    latestHeight: number;
    latestSnapshotHeight: number;
    frameCount: number;
    snapshotCount: number;
    liveBytes: number;
    walBytes: number;
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
