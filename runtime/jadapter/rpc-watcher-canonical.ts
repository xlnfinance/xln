import {
  getCertifiedBoardStackKey,
} from '../jurisdiction/board-registry';
import {
  getEntityCertifiedJAnchor,
  getValidatorJExpectedBlockHash,
} from '../jurisdiction/local-history';
import type { RuntimeReplica } from '../runtime/types';
import {
  enqueueJHistoryRewindForReplicaKeys,
  findWatcherJurisdictionReplica,
} from './watcher';
import {
  assertFinalizedWatcherAnchors,
  collectTargetedWatcherRewinds,
  collectWatcherCanonicalAudit,
} from './watcher-reconciliation';
import type {
  RpcWatcherServices,
  RpcWatcherSession,
} from './rpc-watcher-types';

type EmitWatcherDebug = (payload: Record<string, unknown>) => void;

const clearPendingRewindIfApplied = (
  session: RpcWatcherSession,
  activeEnv: RuntimeReplica,
): boolean => {
  if (session.pendingRewindReplicaKeys.length === 0) return false;
  const stillPending = session.pendingRewindReplicaKeys.some(replicaKey => {
    const replica = activeEnv.eReplicas.get(replicaKey);
    if (!replica?.jHistory) return false;
    const certifiedAnchor = getEntityCertifiedJAnchor(replica.state);
    return !certifiedAnchor || replica.jHistory.scannedThroughHeight > certifiedAnchor.height;
  });
  if (stillPending) return true;
  session.pendingRewindReplicaKeys = [];
  return false;
};

const enqueueTargetedRewinds = (
  session: RpcWatcherSession,
  activeEnv: RuntimeReplica,
  services: RpcWatcherServices,
  targetedRewinds: ReturnType<typeof collectTargetedWatcherRewinds>,
  emitWatcherDebug: EmitWatcherDebug,
): boolean => {
  if (targetedRewinds.size === 0) return false;
  const rewoundReplicaKeys = new Set<string>();
  for (const group of targetedRewinds.values()) {
    for (const replicaKey of enqueueJHistoryRewindForReplicaKeys(
      activeEnv,
      group.height,
      group.canonicalHash,
      group.replicaKeys,
      services.depositoryAddress,
      services.chainId,
    )) {
      rewoundReplicaKeys.add(replicaKey);
    }
  }
  session.pendingRewindReplicaKeys = [...rewoundReplicaKeys].sort();
  for (const [height, replicaKeys] of session.pendingBlocks) {
    for (const replicaKey of rewoundReplicaKeys) replicaKeys.delete(replicaKey);
    if (replicaKeys.size === 0) session.pendingBlocks.delete(height);
  }
  session.txCounter._seenLogs = { set: new Set<string>(), order: [] };
  emitWatcherDebug({
    event: 'j_watch_local_frontier_rewind_enqueued',
    replicaCount: session.pendingRewindReplicaKeys.length,
    frontiers: [...targetedRewinds.values()].map(group => ({
      height: group.height,
      canonicalBlockHash: group.canonicalHash,
      replicaCount: group.replicaKeys.length,
    })),
  });
  return true;
};

const enqueueTipRewind = (
  session: RpcWatcherSession,
  activeEnv: RuntimeReplica,
  services: RpcWatcherServices,
  canonicalTipHash: string,
  expectedTipHash: string,
  mismatchingReplicaKeys: string[],
  relevantLastFinalizedHeights: number[],
  emitWatcherDebug: EmitWatcherDebug,
): void => {
  session.pendingRewindReplicaKeys = enqueueJHistoryRewindForReplicaKeys(
    activeEnv,
    session.lastSyncedBlock,
    canonicalTipHash,
    mismatchingReplicaKeys,
    services.depositoryAddress,
    services.chainId,
  );
  if (session.pendingRewindReplicaKeys.length === 0) {
    throw new Error(`J_HISTORY_REORG_WITHOUT_REWINDABLE_SUFFIX:${session.lastSyncedBlock}`);
  }
  session.pendingBlocks.clear();
  session.txCounter._seenLogs = { set: new Set<string>(), order: [] };
  session.lastSyncedBlock = Math.max(0, Math.min(...relevantLastFinalizedHeights));
  emitWatcherDebug({
    event: 'j_watch_reorg_rewind_enqueued',
    conflictingHeight: session.lastSyncedBlock,
    expectedBlockHash: expectedTipHash,
    canonicalBlockHash: canonicalTipHash,
    rewindToHeight: session.lastSyncedBlock,
    replicaCount: session.pendingRewindReplicaKeys.length,
  });
};

/**
 * Reconciles only authenticated local history. A detected reorg is converted
 * into deterministic Runtime ingress; this adapter never edits Entity state.
 */
export const reconcileWatcherCanonicalTip = async (
  session: RpcWatcherSession,
  activeEnv: RuntimeReplica,
  services: RpcWatcherServices,
  emitWatcherDebug: EmitWatcherDebug,
): Promise<boolean> => {
  if (clearPendingRewindIfApplied(session, activeEnv)) return true;
  if (session.lastSyncedBlock <= 0) return false;
  const watcherReplica = findWatcherJurisdictionReplica(
    activeEnv,
    services.depositoryAddress,
    services.chainId,
  );
  if (!watcherReplica) return false;
  const audit = collectWatcherCanonicalAudit(activeEnv, watcherReplica, session.lastSyncedBlock);
  if (audit.relevantReplicas.length === 0) return false;
  const canonicalHeaders = new Map(
    (await services.readBlockHeaders(audit.auditHeights))
      .map(header => [header.jHeight, header.jBlockHash]),
  );
  assertFinalizedWatcherAnchors(audit, canonicalHeaders, services.chainId);
  const targetedRewinds = collectTargetedWatcherRewinds(
    audit,
    canonicalHeaders,
    services.chainId,
  );
  if (enqueueTargetedRewinds(session, activeEnv, services, targetedRewinds, emitWatcherDebug)) {
    return true;
  }

  const expectedTipHashes = new Set(
    audit.relevantReplicas
      .map(replica => getValidatorJExpectedBlockHash(
        replica.state,
        replica.jHistory,
        session.lastSyncedBlock,
      ))
      .filter((hash): hash is string => Boolean(hash)),
  );
  if (expectedTipHashes.size === 0) return false;
  if (expectedTipHashes.size !== 1) {
    throw new Error(`J_HISTORY_LOCAL_TIP_DIVERGENCE:height=${session.lastSyncedBlock}`);
  }
  const canonicalTipHash = canonicalHeaders.get(session.lastSyncedBlock);
  if (!canonicalTipHash) {
    throw new Error(`J_HISTORY_HEADER_MISSING:height=${session.lastSyncedBlock}`);
  }
  const expectedTipHash = [...expectedTipHashes][0]!;
  if (canonicalTipHash === expectedTipHash) return false;
  const mismatchingReplicaKeys = audit.relevantReplicaEntries.flatMap(([replicaKey, replica]) =>
    getValidatorJExpectedBlockHash(replica.state, replica.jHistory, session.lastSyncedBlock) === expectedTipHash
      ? [replicaKey]
      : [],
  );
  if (mismatchingReplicaKeys.length === 0) {
    throw new Error(`J_HISTORY_REORG_WITHOUT_REWINDABLE_SUFFIX:${session.lastSyncedBlock}`);
  }
  enqueueTipRewind(
    session,
    activeEnv,
    services,
    canonicalTipHash,
    expectedTipHash,
    mismatchingReplicaKeys,
    audit.relevantReplicas.map(replica => Number(replica.state.lastFinalizedJHeight || 0)),
    emitWatcherDebug,
  );
  return true;
};

export const assertAuthorityEvidenceCanonical = async (
  session: RpcWatcherSession,
  activeEnv: RuntimeReplica,
  currentHead: number,
  services: RpcWatcherServices,
): Promise<void> => {
  const stackKey = getCertifiedBoardStackKey({
    chainId: services.chainId,
    depositoryAddress: services.depositoryAddress,
    entityProviderAddress: services.entityProviderAddress,
  });
  const evidence = Array.from(
    activeEnv.runtimeState?.certifiedRegistrationEvidence?.values() ?? [],
  ).filter(candidate => candidate.stackKey === stackKey);
  const currentHeader = (await services.readBlockHeaders([currentHead]))[0];
  if (!currentHeader) throw new Error(`J_AUTHORITY_HEAD_HEADER_MISSING:${currentHead}`);
  const auditKey = `${currentHead}:${currentHeader.jBlockHash}:${evidence.length}`;
  if (session.lastAuthorityAuditKey === auditKey) return;
  if (evidence.length === 0) {
    session.lastAuthorityAuditKey = auditKey;
    return;
  }
  const heights = evidence.flatMap(candidate => [
    candidate.activationHeight,
    candidate.observedThroughHeight,
  ]);
  const canonicalHeaders = new Map(
    (await services.readBlockHeaders(heights))
      .map(header => [header.jHeight, header.jBlockHash]),
  );
  for (const candidate of evidence) {
    const activationHash = canonicalHeaders.get(candidate.activationHeight);
    if (activationHash !== candidate.blockHash) {
      throw new Error(
        `J_AUTHORITY_FINALIZED_REORG:entity=${candidate.entityId}:` +
        `height=${candidate.activationHeight}:expected=${candidate.blockHash}:` +
        `canonical=${activationHash ?? 'missing'}`,
      );
    }
    const tipHash = canonicalHeaders.get(candidate.observedThroughHeight);
    if (tipHash !== candidate.observedTipBlockHash) {
      throw new Error(
        `J_AUTHORITY_FINALITY_TIP_REORG:entity=${candidate.entityId}:` +
        `height=${candidate.observedThroughHeight}:` +
        `expected=${candidate.observedTipBlockHash}:canonical=${tipHash ?? 'missing'}`,
      );
    }
  }
  session.lastAuthorityAuditKey = auditKey;
};
