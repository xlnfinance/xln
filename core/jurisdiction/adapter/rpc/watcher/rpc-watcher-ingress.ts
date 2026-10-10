import type { RuntimeReplica, RuntimeInput } from '../../../../runtime/types';
import {
  applyJBlockHeadersIngressTransform,
  enqueueJHistoryRange,
  getMinimumScannedSignerJHeight,
  type PendingWatcherJHistoryRange,
  type findWatcherJurisdictionReplica,
  processEventBatch,
  rememberPendingWatcherJBlock,
  settleSeenLogs,
  stageSeenLogs,
} from '../../watcher';
import { Depository__factory } from '../../../../../jurisdictions/typechain-types';
import { prepareAuthenticatedWatcherIngress } from '../../rpc-public';
import { readAuthenticatedReceiptRange } from '../../receipt-root';
import { buildTrackedExternalOwners } from '../../rpc-watcher-inputs';
import { decodeAuthenticatedWatcherEvents } from '../../rpc-watcher-events';
import { isJEventDeliveredByWatcher } from '../../events/event-observation';
import { decodeJEventLog } from '../../j-event-log-decoder';
import type {
  RpcWatcherServices,
  RpcWatcherSession,
} from './rpc-watcher-types';
import type { JEvent } from '../../types';

type WatcherReplica = NonNullable<ReturnType<typeof findWatcherJurisdictionReplica>>;
type WatcherDecodeInput = Parameters<typeof decodeAuthenticatedWatcherEvents>[0];

const depositoryInterface = Depository__factory.createInterface();
const CALLDATA_DISPUTE_TOPICS = new Set(
  (['DisputeStarted', 'CounterDisputeRegistered', 'DisputeFinalized'] as const)
    .map(name => depositoryInterface.getEvent(name).topicHash.toLowerCase()),
);

const undeliveredDisputeEvent = (
  input: WatcherDecodeInput,
  log: WatcherDecodeInput['logs'][number],
): JEvent | null => {
  if (log.address.toLowerCase() !== input.depositoryAddress) return null;
  if (!CALLDATA_DISPUTE_TOPICS.has(String(log.topics[0] ?? '').toLowerCase())) return null;
  let event: JEvent;
  try {
    event = decodeJEventLog(log, depositoryInterface, {
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    }, 'J_WATCHER_CANONICAL_EVENT_DECODE_FAILED');
  } catch {
    // Not dropped: the canonical decoder below re-decodes this exact log and
    // fails the range with its usual J_EVENT_LOG_DECODE_FAILED evidence.
    return null;
  }
  return isJEventDeliveredByWatcher(input.env, input.watcherReplica, event) ? null : event;
};

/**
 * Dispute events carry their signed ProofBody only in transaction calldata.
 * Read it solely for disputes some served Entity will receive: a dispute
 * between two foreign Entities, submitted through any wrapper contract, must
 * not make this Runtime read, or fail on, calldata it never commits. The
 * removed events are exactly those event delivery would drop, so every
 * delivered event and its eventsHash keep the same bytes.
 */
export const decodeServedWatcherEvents = async (
  input: WatcherDecodeInput,
): Promise<Awaited<ReturnType<typeof decodeAuthenticatedWatcherEvents>> & {
  undeliveredDisputes: JEvent[];
}> => {
  const undeliveredDisputes: JEvent[] = [];
  const logs = input.logs.filter(log => {
    const undelivered = undeliveredDisputeEvent(input, log);
    if (undelivered) undeliveredDisputes.push(undelivered);
    return !undelivered;
  });
  return { ...await decodeAuthenticatedWatcherEvents({ ...input, logs }), undeliveredDisputes };
};

const requireNativeRpcUrl = (services: RpcWatcherServices): string => {
  if (!services.rpcUrl) throw new Error('J_AUTHORITY_NATIVE_RPC_SOURCE_MISSING');
  return services.rpcUrl;
};

const requireNativeSolidifiedHeight = (request: AuthenticatedWatcherRangeRequest): number => {
  const height = request.nativeSolidifiedThroughHeight;
  if (height === undefined || height < request.toBlock) throw new Error('J_AUTHORITY_NATIVE_UNSOLIDIFIED_RANGE');
  return height;
};

export type AuthenticatedWatcherRangeRequest = {
  activeEnv: RuntimeReplica;
  watcherReplica: WatcherReplica;
  currentBlock: number;
  nativeSolidifiedThroughHeight?: number;
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
      commitment: request.services.mode === 'tron'
        ? 'tron-complete-receipts'
        : 'ethereum-trie',
      ...(request.services.mode === 'tron' ? {
        nativeRpc: { chainId: request.services.chainId, rpcUrl: requireNativeRpcUrl(request.services),
          solidifiedThroughHeight: requireNativeSolidifiedHeight(request) },
      } : {}),
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
  const decoded = await decodeServedWatcherEvents({
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
    findDisputeProofBody: request.services.resolveDisputeProofBody,
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
  // A signer can be imported while receipt authentication awaits RPC. Its
  // certified prefix may precede this range: admitting 515..770 to a signer
  // anchored at 2 makes pending-history wait forever for missing 3..514.
  // Re-read from the current minimum before publishing any of these inputs.
  const minimumLocalScan = getMinimumScannedSignerJHeight(request.activeEnv, request.watcherReplica);
  if (minimumLocalScan !== null && request.fromBlock > minimumLocalScan + 1) {
    request.emitDebug({
      event: 'j_watch_range_rebased_after_signer_import',
      fromBlock: request.fromBlock,
      toBlock: request.toBlock,
      nextFromBlock: minimumLocalScan + 1,
    });
    return false;
  }
  // The same import race can add an Entity that receives a dispute decoded
  // above without its calldata. Re-read the range; never deliver it bodiless.
  if (decoded.undeliveredDisputes.some(event =>
    isJEventDeliveredByWatcher(request.activeEnv, request.watcherReplica, event))) {
    request.emitDebug({
      event: 'j_watch_range_dispute_audience_changed',
      fromBlock: request.fromBlock,
      toBlock: request.toBlock,
    });
    return false;
  }
  stageSeenLogs(request.session.txCounter);
  let enqueued = false;
  try {
    enqueued = ingestAuthenticatedRange(request, decoded, authenticatedIngress);
    return enqueued;
  } finally {
    settleSeenLogs(request.session.txCounter, enqueued);
  }
};

const ingestAuthenticatedRange = (
  request: AuthenticatedWatcherRangeRequest,
  decoded: Awaited<ReturnType<typeof decodeAuthenticatedWatcherEvents>>,
  authenticatedIngress: ReturnType<typeof prepareAuthenticatedWatcherIngress>,
): boolean => {
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
