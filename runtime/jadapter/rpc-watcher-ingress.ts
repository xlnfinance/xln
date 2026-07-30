import type { RuntimeReplica, RuntimeInput } from '../runtime/types';
import {
  applyJBlockHeadersIngressTransform,
  enqueueJHistoryRange,
  type PendingWatcherJHistoryRange,
  type findWatcherJurisdictionReplica,
  processEventBatch,
  rememberPendingWatcherJBlock,
} from './watcher';
import { isTronChainId, prepareAuthenticatedWatcherIngress } from './rpc-public';
import { readAuthenticatedReceiptRange } from './receipt-root';
import { buildTrackedExternalOwners } from './rpc-watcher-inputs';
import { decodeAuthenticatedWatcherEvents } from './rpc-watcher-events';
import type {
  RpcWatcherServices,
  RpcWatcherSession,
} from './rpc-watcher-types';
import type { JEvent } from './types';

type WatcherReplica = NonNullable<ReturnType<typeof findWatcherJurisdictionReplica>>;

export type AuthenticatedWatcherRangeRequest = {
  activeEnv: RuntimeReplica;
  watcherReplica: WatcherReplica;
  currentBlock: number;
  fromBlock: number;
  toBlock: number;
  expectedParentHash?: string;
  expectedParentFinalized: boolean;
  session: RpcWatcherSession;
  services: RpcWatcherServices;
  isCancelled(): boolean;
  isPaused(): boolean;
  pause(details: Record<string, unknown>): void;
  emitDebug(payload: Record<string, unknown>): void;
  setStep(step: string): void;
};

const requireWatcherBlockHash = (
  events: readonly JEvent[],
  blockNumber: number,
): string => {
  const blockHash = events[0]?.blockHash;
  if (!blockHash) throw new Error(`J_EVENT_WATCHER_BLOCK_HASH_MISSING:${blockNumber}`);
  return blockHash;
};

const groupEventsByBlock = (
  events: readonly JEvent[],
): Map<number, JEvent[]> => {
  const byBlock = new Map<number, JEvent[]>();
  for (const event of events) {
    const blockNumber = event.blockNumber;
    const blockEvents = byBlock.get(blockNumber);
    if (blockEvents) blockEvents.push(event);
    else byBlock.set(blockNumber, [event]);
  }
  return byBlock;
};

const buildObservedRuntimeInputs = (
  request: AuthenticatedWatcherRangeRequest,
  events: readonly JEvent[],
  authorityTxsByBlock: ReadonlyMap<number, RuntimeInput['runtimeTxs']>,
): RuntimeInput[] => {
  const observedInputs: RuntimeInput[] = [];
  const byBlock = groupEventsByBlock(events);
  for (const [blockNumber, blockEvents] of byBlock) {
    request.setStep(`processEventBatch:${blockNumber}`);
    const builtInput = processEventBatch(
      blockEvents,
      request.activeEnv,
      blockNumber,
      requireWatcherBlockHash(blockEvents, blockNumber),
      request.session.txCounter,
      'rpc',
      request.services.depositoryAddress,
      true,
      'chain',
      request.services.chainId,
      request.fromBlock <= request.session.lastSyncedBlock,
      authorityTxsByBlock.get(blockNumber) ?? [],
    );
    if (builtInput) observedInputs.push(builtInput);
  }
  const eventCounts: Record<string, number> = {};
  for (const event of events) {
    eventCounts[event.name] = (eventCounts[event.name] ?? 0) + 1;
  }
  request.emitDebug({
    event: 'j_watch_batch',
    fromBlock: request.fromBlock,
    toBlock: request.toBlock,
    chainTip: request.currentBlock,
    confirmationDepth: request.session.confirmationDepth,
    blockCount: byBlock.size,
    rawEventCount: events.length,
    eventCounts,
  });
  return observedInputs;
};

const rememberPendingHistoryRange = (
  session: RpcWatcherSession,
  pendingRange: PendingWatcherJHistoryRange,
): void => {
  if (session.pendingHistoryRange) {
    throw new Error('J_WATCHER_PENDING_SCAN_ALREADY_EXISTS');
  }
  session.pendingHistoryRange = pendingRange;
};

const commitAuthenticatedRange = (
  request: AuthenticatedWatcherRangeRequest,
  inputs: RuntimeInput[],
  headers: ReturnType<typeof applyJBlockHeadersIngressTransform>,
  tipBlockHash: string,
): void => {
  const replicaKeys = enqueueJHistoryRange(
    request.activeEnv,
    inputs,
    request.toBlock,
    tipBlockHash,
    request.services.depositoryAddress,
    headers,
    request.services.chainId,
  );
  rememberPendingWatcherJBlock(
    request.session.pendingBlocks,
    request.toBlock,
    replicaKeys.finalityReplicaKeys,
  );
  if (replicaKeys.scannedReplicaKeys.length > 0) {
    rememberPendingHistoryRange(request.session, {
      fromBlock: request.fromBlock,
      toBlock: request.toBlock,
      tipBlockHash,
      replicaKeys: new Set(replicaKeys.scannedReplicaKeys),
    });
  }
  request.session.lastSyncedBlock = Math.max(
    request.session.lastSyncedBlock,
    request.toBlock,
  );
};

/**
 * Reads one authenticated receipt range and converts it into Runtime ingress.
 * The cancellation and quiesce fences immediately before commit are protocol
 * boundaries: external I/O completed, but Runtime has not been touched yet.
 */
export const applyAuthenticatedWatcherRange = async (
  request: AuthenticatedWatcherRangeRequest,
): Promise<boolean> => {
  request.setStep('resolveDepository');
  const depositoryAddress = (await request.services.getLiveDepositoryAddress()).toLowerCase();
  request.setStep('resolveEntityProvider');
  const entityProviderAddress = (await request.services.getLiveEntityProviderAddress()).toLowerCase();
  request.setStep('resolveErc20Registry');
  const watchedTokens = await request.session.readWatchedErc20Tokens();
  request.setStep('authenticatedReceipts');
  const authenticatedRange = await readAuthenticatedReceiptRange(
    (method, params) => request.services.provider.send(method, params),
    request.fromBlock,
    request.toBlock,
    [
      depositoryAddress,
      entityProviderAddress,
      ...watchedTokens.map(token => token.address),
    ],
    {
      commitment: isTronChainId(request.services.chainId)
        ? 'tron-complete-receipts'
        : 'ethereum-trie',
    },
    request.services.sendAuthenticatedBatch,
  );
  if (request.isCancelled()) return false;
  const authenticatedIngress = prepareAuthenticatedWatcherIngress(
    authenticatedRange,
    request.expectedParentHash
      ? {
          height: request.fromBlock - 1,
          hash: request.expectedParentHash,
          finalized: request.expectedParentFinalized,
        }
      : undefined,
  );
  const tokenByAddress = new Map(watchedTokens.map(token => [token.address, token]));
  const decoded = await decodeAuthenticatedWatcherEvents({
    env: request.activeEnv,
    watcherReplica: request.watcherReplica,
    logs: authenticatedIngress.logs,
    depositoryAddress,
    entityProviderAddress,
    tokenByAddress,
    trackedOwners: buildTrackedExternalOwners(request.activeEnv),
    observedThroughHeight: request.toBlock,
    observedTipBlockHash: authenticatedIngress.tipBlockHash,
    observedHeadHeight: request.currentBlock,
    confirmationDepth: request.session.confirmationDepth,
    findDisputeFinalizationEvidence: request.services.resolveDisputeFinalizationEvidence,
  });
  if (request.isCancelled()) {
    request.emitDebug({
      event: 'j_watch_shutdown_poll_aborted',
      message: 'watcher cancellation observed before J-event ingress',
      chainId: request.services.chainId,
      rpcUrl: request.services.rpcUrl,
      step: 'before-process-event-batch',
      fromBlock: request.fromBlock,
      toBlock: request.toBlock,
      lastSyncedBlock: request.session.lastSyncedBlock,
    });
    return false;
  }
  if (decoded.events.length > 0 && request.isPaused()) {
    request.pause({
      step: 'before-process-event-batch',
      fromBlock: request.fromBlock,
      toBlock: request.toBlock,
      rawEventCount: decoded.events.length,
    });
    return false;
  }
  const observedInputs = decoded.events.length > 0
    ? buildObservedRuntimeInputs(request, decoded.events, decoded.authorityTxsByBlock)
    : [];
  if (request.isCancelled()) return false;
  if (request.isPaused()) {
    request.pause({
      step: authenticatedIngress.logs.length > 0
        ? 'before-authenticated-history-range-ingress'
        : 'before-authenticated-empty-range-ingress',
      fromBlock: request.fromBlock,
      toBlock: request.toBlock,
      rawEventCount: decoded.events.length,
    });
    return false;
  }
  commitAuthenticatedRange(
    request,
    observedInputs,
    authenticatedIngress.headers,
    authenticatedIngress.tipBlockHash,
  );
  return true;
};
