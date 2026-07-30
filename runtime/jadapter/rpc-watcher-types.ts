import type { ethers } from 'ethers';
import type {
  Depository,
  EntityProvider,
} from '../../jurisdictions/typechain-types/index.ts';
import type { RuntimeReplica } from '../runtime/types';
import type { DisputeFinalizationEvidence } from '../types/jurisdiction-events';
import type {
  EventBatchCounter,
  PendingWatcherJBlockMap,
  PendingWatcherJHistoryRange,
} from './watcher';
import type { WatchedErc20Token } from './rpc-watcher-inputs';

export type RpcWatcherScanProgress = {
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
  chainId: number;
  rpcUrl?: string;
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
  ): Promise<DisputeFinalizationEvidence | undefined>;
  isTransientRpcUnavailable(error: unknown): boolean;
};

export type RpcWatcherSession = {
  env: RuntimeReplica;
  generation: number;
  interval: ReturnType<typeof setInterval> | null;
  manualPolling: boolean;
  confirmationDepth: number;
  pollMs: number;
  lastSyncedBlock: number;
  scanProgress: RpcWatcherScanProgress;
  pendingBlocks: PendingWatcherJBlockMap;
  pendingHistoryRange: PendingWatcherJHistoryRange | null;
  pendingHistoryWaitKey: string;
  pendingRewindReplicaKeys: string[];
  lastAuthorityAuditKey: string;
  lastObservedHead: number;
  lastCanonicalAuditAtMs: number;
  transientFailures: number;
  lastTransientLogAtMs: number;
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
};
