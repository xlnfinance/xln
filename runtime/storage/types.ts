import type { BookState, EntityReferral, HubProfile } from '../orderbook';
import type { CrontabState } from '../crontab-types';
import type { JBatchState } from '../j-batch';
import type { SwapKey } from '../swap-keys';
import type {
  AccountInput,
  AccountMachine,
  AccountStatus,
  ConsensusConfig,
  Delta,
  DebtEntry,
  EntityReplica,
  EntityState,
  EntitySwapPair,
  HtlcLock,
  HtlcNoteKey,
  HtlcRoute,
  HubRebalanceConfig,
  JurisdictionEvent,
  LockBookEntry,
  Proposal,
  RebalancePolicy,
  RebalanceQuote,
  RebalanceRequestFeeState,
  RuntimeInput,
  RuntimeOverlayRecord,
  SwapOffer,
} from '../types';
import type { RadixMerkleRadix, RadixMerkleRootKind } from './merkle';
import type { StorageMerkleNamespace } from './keys';

export type RuntimeDbLike = {
  get: (key: Buffer) => Promise<Buffer>;
  put?: (key: Buffer, value: Buffer, options?: { sync?: boolean }) => Promise<void>;
  batch: () => {
    put: (key: Buffer, value: Buffer) => unknown;
    del?: (key: Buffer) => unknown;
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
  frameDbMaxBytes?: number;
  frameDbRetainFrames?: number;
  materializePeriodFrames?: number;
  /**
   * Canonical runtime-state commitment.
   * 0 disables it; any positive value stores and verifies a full canonical hash
   * every frame. Sparse cadences are intentionally not used for restore safety.
   */
  canonicalHashPeriodFrames?: number;
  accountMerkleRadix?: RadixMerkleRadix;
};

export type StorageHead = {
  schemaVersion: number;
  latestHeight: number;
  latestMaterializedHeight?: number;
  latestSnapshotHeight: number;
  snapshotPeriodFrames: number;
  retainSnapshots: number;
  epochMaxBytes: number;
  accountMerkleRadix: RadixMerkleRadix;
  retainedHistoryBytes: number;
};

export type StorageEntityCoreDoc = {
  entityId: string;
  signerId?: string;
  isProposer?: boolean;
  height: number;
  timestamp: number;
  messages: EntityState['messages'];
  nonces: Map<string, number>;
  proposals: Map<string, Proposal>;
  config: ConsensusConfig;
  prevFrameHash?: string;
  reserves: Map<number, bigint>;
  deferredAccountProposals?: Map<string, true>;
  lastFinalizedJHeight: number;
  jBlockObservations: EntityState['jBlockObservations'];
  jBlockChain: EntityState['jBlockChain'];
  batchHistory?: EntityState['batchHistory'];
  accountInputQueue?: AccountInput[];
  crontabState?: CrontabState;
  jBatchState?: JBatchState;
  entityEncPubKey: string;
  entityEncPrivKey: string;
  profile: EntityState['profile'];
  htlcRoutes: Map<string, HtlcRoute>;
  htlcFeesEarned: bigint;
  htlcNotes?: Map<HtlcNoteKey, string>;
  outDebtsByToken?: Map<number, Map<string, DebtEntry>>;
  inDebtsByToken?: Map<number, Map<string, DebtEntry>>;
  lockBook: Map<string, LockBookEntry>;
  swapTradingPairs?: EntitySwapPair[];
  pendingSwapFillRatios?: Map<SwapKey, number>;
  crossJurisdictionSwaps?: EntityState['crossJurisdictionSwaps'];
  pendingCrossJurisdictionFillAcks?: EntityState['pendingCrossJurisdictionFillAcks'];
  crossJurisdictionBookAdmissions?: EntityState['crossJurisdictionBookAdmissions'];
  hubRebalanceConfig?: HubRebalanceConfig;
  orderbookHubProfile?: HubProfile;
  orderbookReferrals?: Map<string, EntityReferral>;
};

export type StorageAccountDoc = {
  leftEntity: string;
  rightEntity: string;
  watchSeed: string;
  status: AccountStatus;
  mempool: AccountMachine['mempool'];
  currentFrame: AccountMachine['currentFrame'];
  deltas: Map<number, Delta>;
  locks: Map<string, HtlcLock>;
  swapOffers: Map<string, SwapOffer>;
  pulls?: AccountMachine['pulls'];
  globalCreditLimits: AccountMachine['globalCreditLimits'];
  currentHeight: number;
  pendingFrame?: AccountMachine['pendingFrame'];
  pendingSignatures: string[];
  pendingAccountInput?: AccountMachine['pendingAccountInput'];
  lastOutboundFrameAck?: AccountMachine['lastOutboundFrameAck'];
  pendingForward?: AccountMachine['pendingForward'];
  hankoSignature?: AccountMachine['hankoSignature'];
  rollbackCount: number;
  lastRollbackFrameHash?: string;
  leftJObservations?: Array<{ jHeight: number; jBlockHash: string; events: JurisdictionEvent[]; observedAt: number }>;
  rightJObservations?: Array<{ jHeight: number; jBlockHash: string; events: JurisdictionEvent[]; observedAt: number }>;
  jEventChain?: AccountMachine['jEventChain'];
  lastFinalizedJHeight: number;
  proofHeader: AccountMachine['proofHeader'];
  proofBody: AccountMachine['proofBody'];
  abiProofBody?: AccountMachine['abiProofBody'];
  disputeConfig: AccountMachine['disputeConfig'];
  currentFrameHanko?: AccountMachine['currentFrameHanko'];
  counterpartyFrameHanko?: AccountMachine['counterpartyFrameHanko'];
  currentDisputeProofHanko?: AccountMachine['currentDisputeProofHanko'];
  currentDisputeProofNonce?: number;
  currentDisputeProofBodyHash?: string;
  currentDisputeHash?: string;
  counterpartyDisputeProofHanko?: AccountMachine['counterpartyDisputeProofHanko'];
  counterpartyDisputeProofNonce?: number;
  counterpartyDisputeProofBodyHash?: string;
  counterpartyDisputeHash?: string;
  counterpartySettlementHanko?: AccountMachine['counterpartySettlementHanko'];
  disputeProofNoncesByHash?: AccountMachine['disputeProofNoncesByHash'];
  disputeProofBodiesByHash?: AccountMachine['disputeProofBodiesByHash'];
  disputeArgumentSnapshotsByHash?: AccountMachine['disputeArgumentSnapshotsByHash'];
  onChainSettlementNonce: number;
  settlementWorkspace?: AccountMachine['settlementWorkspace'];
  activeDispute?: AccountMachine['activeDispute'];
  swapOrderHistory?: AccountMachine['swapOrderHistory'];
  swapClosedOrders?: AccountMachine['swapClosedOrders'];
  pendingWithdrawals: Map<string, {
    requestId: string;
    tokenId: number;
    amount: bigint;
    requestedAt: number;
    direction: 'outgoing' | 'incoming';
    status: 'pending' | 'approved' | 'rejected' | 'timed_out';
    signature?: string;
  }>;
  requestedRebalance: Map<number, bigint>;
  requestedRebalanceFeeState: Map<number, RebalanceRequestFeeState>;
  counterpartyRebalanceFeePolicy?: AccountMachine['counterpartyRebalanceFeePolicy'];
  rebalancePolicy: Map<number, RebalancePolicy>;
  activeRebalanceQuote?: RebalanceQuote;
  pendingRebalanceRequest?: { tokenId: number; targetAmount: bigint };
};

export type StorageDoc =
  | { family: 'entity'; entityId: string; value: StorageEntityCoreDoc }
  | { family: 'account'; entityId: string; counterpartyId: string; value: StorageAccountDoc }
  | { family: 'book'; entityId: string; pairId: string; value: BookState };

export type StorageDocRef =
  | { family: 'entity'; entityId: string }
  | { family: 'account'; entityId: string; counterpartyId: string }
  | { family: 'book'; entityId: string; pairId: string };

export type StorageFrameRecord = {
  height: number;
  timestamp: number;
  prevFrameHash?: string;
  frameHash?: string;
  stateHash: string;
  hashMode?: 'storage-merkle-v1';
  materializedState?: boolean;
  entityHashes?: StorageFrameEntityHash[];
  /**
   * Independent canonical root computed directly from live EntityReplica data.
   * This intentionally avoids cloneEntityReplica(), project*Doc(), msgpack, and
   * coarse-doc storage cells so replay verification can catch bugs in those
   * pipelines instead of repeating them.
   */
  canonicalStateHash?: string;
  canonicalEntityHashes?: StorageFrameEntityHash[];
  runtimeInput: RuntimeInput;
  overlayRecords?: RuntimeOverlayRecord[];
  touchedEntities: string[];
  touchedAccounts: Array<{ entityId: string; counterpartyId: string }>;
  touchedBookEntities: string[];
};

export type StorageEntityHashDoc = {
  entityId: string;
  hash: string;
  cellCount: number;
};

export type StorageMerkleRootDoc = {
  entityId: string;
  namespace: StorageMerkleNamespace;
  radix: RadixMerkleRadix;
  rootHash: string;
  rootKind?: RadixMerkleRootKind;
  rootPath?: number[];
  leafCount: number;
};

export type StorageMerkleBranchDoc = {
  entityId: string;
  namespace: StorageMerkleNamespace;
  radix: RadixMerkleRadix;
  path: number[];
  hash: string;
  children: Array<{
    slot: number;
    kind: 'branch' | 'leaf';
    path: number[];
    hash: string;
  }>;
};

export type StorageMerkleLeafDoc = {
  entityId: string;
  namespace: StorageMerkleNamespace;
  radix: RadixMerkleRadix;
  path: number[];
  key: string;
  valueHash: string;
  hash: string;
};

export type StorageFrameEntityHash = {
  entityId: string;
  hash: string;
  cellCount: number;
};

export type StorageReplicaMeta = {
  entityId: string;
  signerId?: string;
  isProposer?: boolean;
  proposal?: EntityReplica['proposal'];
  lockedFrame?: EntityReplica['lockedFrame'];
  validatorComputedState?: EntityReplica['validatorComputedState'];
  hankoWitness?: EntityReplica['hankoWitness'];
};

export type StorageDiffRecord = {
  height: number;
  puts: StorageDoc[];
  dels: StorageDocRef[];
};

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
  liveBookCount: number;
  merkleRootCount?: number;
  merkleBranchCount?: number;
  merkleLeafCount?: number;
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

export type RuntimeFrameDbLike = RuntimeDbLike;

export type FrameDbPut = { key: Buffer; value: Buffer };

export type StorageFrameDbHead = {
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
