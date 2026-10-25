import type { ethers } from 'ethers';
import type {
  Depository,
  EntityProvider,
} from '../../../../../jurisdictions/typechain-types/index';
import type { RuntimeReplica } from '../../../../runtime/types';
import type { DisputeFinalizationEvidence } from '../../../../types/jurisdiction-events';
import type { TxDisputeProofBodyEvidence } from '../../rpc-public';
import type { EntityProvenValues } from '../state-anchor/rpc-proven-values-root';
import type {
  EventBatchCounter,
  PendingWatcherJBlockMap,
  PendingWatcherJHistoryRange,
} from '../../watcher';
import type { WatchedErc20Token , AuthenticatedTxLocation } from '../../rpc-watcher-inputs';
import type { JAdapterMode } from '../../types';

type RpcWatcherScanProgress = {
  scannedThroughHeight: number;
  replicaScannedThrough: Record<string, number>;
};

export type RpcWatcherTrace = {
  step: string;
  fromBlock: number | null;
  toBlock: number | null;
};

export type RpcWatcherServices = {
  provider: ethers.JsonRpcProvider;
  // Explicit protocol mode also covers private TVM chains; chainId remains
  // the verified jurisdiction/signature identity, never a finality allowlist.
  mode: JAdapterMode;
  chainId: number;
  rpcUrl?: string;
  watchPollMs?: number;
  depositoryAddress: string;
  entityProviderAddress: string;
  getDepository(): Depository;
  getEntityProvider(): EntityProvider;
  getLiveDepositoryAddress(): Promise<string>;
  getLiveEntityProviderAddress(): Promise<string>;
  assertStackBindingVerified(): void;
  readCurrentBlockNumber(): Promise<number>;
  readSafeBlockNumber(): Promise<number>;
  readBlockHeaders(heights: number[]): Promise<Array<{ jHeight: number; jBlockHash: string }>>;
  sendAuthenticatedBatch(
    calls: readonly { method: string; params: unknown[] }[],
  ): Promise<unknown[]>;
  resolveFinalityDepth(scenarioMode: boolean): number;
  resolveDisputeFinalizationEvidence(
    txHash: string,
    args: Record<string, unknown>,
    location: AuthenticatedTxLocation,
  ): Promise<DisputeFinalizationEvidence | undefined>;
  resolveDisputeProofBody(
    txHash: string,
    eventName: TxDisputeProofBodyEvidence['eventName'],
    args: Record<string, unknown>,
    location: AuthenticatedTxLocation,
  ): Promise<TxDisputeProofBodyEvidence['proofbody']>;
  isTransientRpcUnavailable(error: unknown): boolean;
};

export type RpcWatcherSession = {
  env: RuntimeReplica;
  generation: number;
  interval: ReturnType<typeof setTimeout> | null;
  manualPolling: boolean;
  confirmationDepth: number;
  pollMs: number;
  lastSyncedBlock: number;
  scanProgress: RpcWatcherScanProgress;
  pendingBlocks: PendingWatcherJBlockMap;
  pendingHistoryRange: PendingWatcherJHistoryRange | null;
  pendingHistoryWaitKey: string;
  /** A fresh-import 'j_anchor' enqueued at this height; scanning waits until every replica committed it. */
  pendingAnchor: { height: number; replicaKeys: string[] } | null;
  pendingRewindReplicaKeys: string[];
  lastAuthorityAuditKey: string;
  /** Finalized board registries proven equal to EntityProvider storage: audit key -> storage registry root. */
  boardAnchorAudits: Map<string, string>;
  /** Finalized Entity reserves proven equal to Depository storage: audit key -> per-Entity reserve root, proven _tokens.length and entityNonces. */
  reserveAnchorAudits: Map<string, { root: string; tokenCount: bigint; batchNonce: bigint }>;
  /** Finalized Entity action nonces read from EntityProvider storage: audit key -> raw entityActionNonces. */
  actionNonceAudits: Map<string, bigint>;
  /** Finalized Entity open debts proven equal to Depository storage: audit key -> per-Entity storage debt root. */
  debtAnchorAudits: Map<string, string>;
  /** Open DebtEntry creations proven under their header, and creation hashes linked to a certified anchor. */
  debtProvenanceAudits: Set<string>;
  /** Process-local per-replica proven-values roots (fold == storage) of the last audit. Observation only. */
  provenValues: Map<string, EntityProvenValues>;
  lastObservedHead: number;
  lastCanonicalAuditAtMs: number;
  transientFailures: number;
  lastTransientLogAtMs: number;
  /** Process-local transport pressure shared by scheduled and explicit polls. */
  rpcCooldown: { backoffMs: number; untilMs: number; releaseWait: (() => void) | null };
  /** Shrinks under RPC or Runtime mempool pressure, grows after success. */
  maxBlocksPerPoll: number;
  txCounter: EventBatchCounter;
  readWatchedErc20Tokens(): Promise<WatchedErc20Token[]>;
};

export type RpcWatcherControllerState = {
  session: RpcWatcherSession | null;
  inFlight: Promise<void> | null;
  fatalError: string | null;
  generation: number;
  lastScanProgress: RpcWatcherScanProgress;
};

export type RpcWatcherMethods = {
  startWatching(env: RuntimeReplica): void;
  pollNow(): Promise<void>;
  isWatching(): boolean;
  stopWatching(): void;
  stopWatchingAndWait(): Promise<void>;
  getWatcherScanProgress(): RpcWatcherScanProgress;
  /** Per-Entity proven-values roots (fold == storage) of the last canonical audit. Observation only. */
  getWatcherProvenValues(): EntityProvenValues[];
};
