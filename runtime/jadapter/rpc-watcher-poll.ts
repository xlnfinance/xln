import { compareStableText } from '../protocol/serialization';
import {
  getEntityCertifiedJAnchor,
  getValidatorJExpectedBlockHash,
} from '../jurisdiction/local-history';
import type { RuntimeReplica } from '../runtime/types';
import {
  findWatcherJurisdictionReplica,
  getMinimumCommittedSignerJHeight,
  getMinimumScannedSignerJHeight,
  getWatcherStartBlock,
  isEntityReplicaRelevantToWatcher,
  isWatcherJHistoryRangeDurable,
  resolveCommittedWatcherCursor,
  updateWatcherJurisdictionCursor,
} from './watcher';
import {
  isTronChainId,
  resolveWatcherPollToBlock,
  rpcLog,
} from './rpc-public';
import { shouldAuditCanonicalWatcherState } from './watcher-poll-policy';
import {
  assertAuthorityEvidenceCanonical,
  reconcileWatcherCanonicalTip,
} from './rpc-watcher-canonical';
import { applyAuthenticatedWatcherRange } from './rpc-watcher-ingress';
import type {
  RpcWatcherServices,
  RpcWatcherSession,
  RpcWatcherTrace,
} from './rpc-watcher-types';

type PollRequest = {
  session: RpcWatcherSession;
  services: RpcWatcherServices;
  trace: RpcWatcherTrace;
  isCancelled(): boolean;
  emitDebug(payload: Record<string, unknown>): void;
};

const isIngressPaused = (env: RuntimeReplica): boolean =>
  !!env.runtimeState?.persistenceQuiescing && !env.scenarioMode;

const pauseForQuiesce = (
  request: PollRequest,
  details: Record<string, unknown>,
): void => {
  request.emitDebug({
    event: 'j_watch_paused_persistence_quiescing',
    lastSyncedBlock: request.session.lastSyncedBlock,
    ...details,
  });
};

const commitScannedWatcherCursor = (
  session: RpcWatcherSession,
  services: RpcWatcherServices,
): number => {
  const env = session.env;
  const currentCursor = Math.max(
    0,
    getWatcherStartBlock(env, services.depositoryAddress, services.chainId) - 1,
  );
  const watcherReplica = findWatcherJurisdictionReplica(
    env,
    services.depositoryAddress,
    services.chainId,
  );
  if (!watcherReplica) {
    throw new Error(
      `J_WATCHER_JURISDICTION_NOT_FOUND:cursor:${services.chainId}:` +
      services.depositoryAddress,
    );
  }
  // Empty authenticated tails are deliberately not durable Runtime progress.
  // Only the Entity-certified common prefix may advance the WAL cursor.
  const certifiedCursor = getMinimumCommittedSignerJHeight(env, watcherReplica);
  const durableCandidate = certifiedCursor === null
    ? currentCursor
    : Math.min(session.lastSyncedBlock, certifiedCursor);
  const resolvedCursor = resolveCommittedWatcherCursor(
    env,
    session.pendingBlocks,
    durableCandidate,
    currentCursor,
  );
  if (resolvedCursor > currentCursor) {
    updateWatcherJurisdictionCursor(
      env,
      resolvedCursor,
      services.depositoryAddress,
      services.chainId,
    );
  }
  return resolvedCursor;
};

const waitForPendingHistory = (request: PollRequest): boolean => {
  const pending = request.session.pendingHistoryRange;
  if (!pending) return false;
  if (!isWatcherJHistoryRangeDurable(request.session.env, pending)) {
    const waitKey = `${pending.fromBlock}:${pending.toBlock}`;
    if (request.session.pendingHistoryWaitKey !== waitKey) {
      request.session.pendingHistoryWaitKey = waitKey;
      rpcLog.info('watcher.waiting_for_durable_history_range', {
        chainId: request.services.chainId,
        fromBlock: pending.fromBlock,
        toBlock: pending.toBlock,
        replicas: [...pending.replicaKeys],
      });
    }
    return true;
  }
  request.session.pendingHistoryRange = null;
  request.session.pendingHistoryWaitKey = '';
  return false;
};

const rememberScanProgress = (
  session: RpcWatcherSession,
  services: RpcWatcherServices,
  scannedThroughHeight: number,
): void => {
  const watcherReplica = findWatcherJurisdictionReplica(
    session.env,
    services.depositoryAddress,
    services.chainId,
  );
  if (!watcherReplica) return;
  const byReplica = new Map(Object.entries(session.scanProgress.replicaScannedThrough));
  for (const [key, replica] of session.env.eReplicas.entries()) {
    if (!isEntityReplicaRelevantToWatcher(session.env, replica, watcherReplica)) continue;
    byReplica.set(key, Math.max(byReplica.get(key) ?? 0, scannedThroughHeight));
  }
  session.scanProgress = {
    scannedThroughHeight: Math.max(
      session.scanProgress.scannedThroughHeight,
      scannedThroughHeight,
    ),
    replicaScannedThrough: Object.fromEntries(
      [...byReplica.entries()].sort(([left], [right]) => compareStableText(left, right)),
    ),
  };
};

const auditCanonicalStateWhenDue = async (
  request: PollRequest,
  currentBlock: number,
  fromBlock: number,
  safeToBlock: number,
): Promise<boolean> => {
  const session = request.session;
  const nowMs = Date.now();
  const auditDue = shouldAuditCanonicalWatcherState({
    currentHead: currentBlock,
    lastObservedHead: session.lastObservedHead,
    nowMs,
    lastAuditAtMs: session.lastCanonicalAuditAtMs,
    hasRangeWork: fromBlock <= safeToBlock,
    hasPendingHistory: session.pendingHistoryRange !== null,
    hasPendingReorg: session.pendingRewindReplicaKeys.length > 0,
  });
  session.lastObservedHead = currentBlock;
  if (!auditDue) return false;
  request.trace.step = `verifyAuthorityEvidence:${currentBlock}`;
  await assertAuthorityEvidenceCanonical(session, session.env, currentBlock, request.services);
  request.trace.step = `verifyCanonicalTip:${session.lastSyncedBlock}`;
  const rewound = await reconcileWatcherCanonicalTip(
    session,
    session.env,
    request.services,
    request.emitDebug,
  );
  session.lastCanonicalAuditAtMs = nowMs;
  if (!rewound) return false;
  session.pendingHistoryRange = null;
  session.scanProgress = { scannedThroughHeight: 0, replicaScannedThrough: {} };
  return true;
};

const resolveExpectedParent = (
  env: RuntimeReplica,
  watcherReplica: NonNullable<ReturnType<typeof findWatcherJurisdictionReplica>>,
  parentHeight: number,
): { hash?: string; finalized: boolean } => {
  if (parentHeight <= 0) return { finalized: false };
  const relevantReplicas = [...env.eReplicas.values()].filter(replica =>
    isEntityReplicaRelevantToWatcher(env, replica, watcherReplica),
  );
  const hashes = new Set(
    relevantReplicas
      .map(replica => getValidatorJExpectedBlockHash(
        replica.state,
        replica.jHistory,
        parentHeight,
      ))
      .filter((hash): hash is string => Boolean(hash)),
  );
  if (hashes.size > 1) {
    throw new Error(`J_HISTORY_RANGE_PARENT_DIVERGENCE:height=${parentHeight}`);
  }
  const hash = [...hashes][0];
  const finalized = hash !== undefined && relevantReplicas.some(replica => {
    const anchor = getEntityCertifiedJAnchor(replica.state);
    return anchor?.height === parentHeight && anchor.hash === hash;
  });
  return hash === undefined ? { finalized } : { hash, finalized };
};

/**
 * Executes one watcher poll. Every return before applyAuthenticatedWatcherRange
 * is read-only; that function owns the final cancellation/quiesce fences.
 */
export const runWatcherPoll = async (request: PollRequest): Promise<void> => {
  const { session, services } = request;
  if (isIngressPaused(session.env)) {
    pauseForQuiesce(request, { step: 'before-block-number' });
    return;
  }
  request.trace.step = 'eth_blockNumber';
  const currentBlock = await services.readCurrentBlockNumber();
  if (request.isCancelled()) return;
  const safeHead = isTronChainId(services.chainId)
    ? await services.readSafeBlockNumber()
    : currentBlock;
  const safeToBlock = safeHead - session.confirmationDepth;
  if (safeToBlock <= 0) return;
  const watcherReplica = findWatcherJurisdictionReplica(
    session.env,
    services.depositoryAddress,
    services.chainId,
  );
  if (!watcherReplica) {
    throw new Error(
      `J_WATCHER_JURISDICTION_NOT_FOUND:poll:${services.chainId}:` +
      services.depositoryAddress,
    );
  }
  const minimumLocalScan = getMinimumScannedSignerJHeight(session.env, watcherReplica);
  const nextGlobalBlock = session.lastSyncedBlock + 1;
  const fromBlock = Math.min(
    nextGlobalBlock,
    minimumLocalScan === null ? nextGlobalBlock : minimumLocalScan + 1,
  );
  if (await auditCanonicalStateWhenDue(request, currentBlock, fromBlock, safeToBlock)) return;
  if (waitForPendingHistory(request)) return;
  commitScannedWatcherCursor(session, services);
  if (fromBlock > safeToBlock) return;
  const toBlock = resolveWatcherPollToBlock(fromBlock, safeToBlock);
  request.trace.fromBlock = fromBlock;
  request.trace.toBlock = toBlock;
  const parent = resolveExpectedParent(session.env, watcherReplica, fromBlock - 1);
  const committed = await applyAuthenticatedWatcherRange({
    activeEnv: session.env,
    watcherReplica,
    currentBlock,
    fromBlock,
    toBlock,
    ...(parent.hash ? { expectedParentHash: parent.hash } : {}),
    expectedParentFinalized: parent.finalized,
    session,
    services,
    isCancelled: request.isCancelled,
    isPaused: () => isIngressPaused(session.env),
    pause: details => pauseForQuiesce(request, details),
    emitDebug: request.emitDebug,
    setStep: step => {
      request.trace.step = step;
    },
  });
  if (!committed) return;
  rememberScanProgress(session, services, toBlock);
  session.transientFailures = 0;
};
