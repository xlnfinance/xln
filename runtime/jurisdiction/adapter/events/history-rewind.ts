import type { RuntimeReplica, RuntimeTx } from '../../../runtime/types';
import { enqueueRuntimeInput } from '../../../runtime/input-pipeline/input-queue';
import { getEntityCertifiedJAnchor } from '../../machine/local-history';
import { getJEventJurisdictionRef } from '../../machine/event-observation';
import { markLocalJAuthorityRuntimeTx } from '../../machine/registration-evidence';
import {
  findWatcherJurisdictionReplica,
  isEntityReplicaRelevantToWatcher,
  requireWatcherJurisdictionReplica,
} from '../watcher/observe/watcher-replica';

const enqueueScopedRewind = (
  env: RuntimeReplica,
  conflictingHeight: number,
  conflictingBlockHash: string,
  requestedKeys: ReadonlySet<string> | null,
  depositoryAddress?: string,
  chainId?: number,
): string[] => {
  const watcher = depositoryAddress || chainId !== undefined
    ? requireWatcherJurisdictionReplica(
        env, depositoryAddress, chainId, 'history-rewind',
      )
    : findWatcherJurisdictionReplica(env, depositoryAddress, chainId);
  const runtimeTxs: RuntimeTx[] = [];
  const replicaKeys: string[] = [];
  const foundKeys = new Set<string>();
  for (const [replicaKey, replica] of env.state.eReplicas) {
    if (requestedKeys && !requestedKeys.has(replicaKey)) continue;
    if (requestedKeys) foundKeys.add(replicaKey);
    if (watcher && !isEntityReplicaRelevantToWatcher(env, replica, watcher)) {
      if (requestedKeys) {
        throw new Error(`J_HISTORY_REWIND_TARGET_JURISDICTION_MISMATCH:${replicaKey}`);
      }
      continue;
    }
    if (!replica.jHistory) {
      if (requestedKeys) {
        throw new Error(`J_HISTORY_REWIND_TARGET_HISTORY_MISSING:${replicaKey}`);
      }
      continue;
    }
    const anchor = getEntityCertifiedJAnchor(replica.state);
    if (anchor && replica.jHistory.scannedThroughHeight <= anchor.height) {
      if (requestedKeys) {
        throw new Error(`J_HISTORY_REWIND_TARGET_NOT_PRIVATE:${replicaKey}`);
      }
      continue;
    }
    const entityId = String(
      replica.state.entityId || replica.entityId || '',
    ).trim().toLowerCase();
    const signerId = String(replica.signerId || '').trim().toLowerCase();
    if (!entityId || !signerId) {
      throw new Error(`J_HISTORY_REWIND_REPLICA_ID_MISSING:${replicaKey}`);
    }
    runtimeTxs.push(markLocalJAuthorityRuntimeTx({
      type: 'rewindJHistory',
      data: {
        entityId,
        signerId,
        jurisdictionRef: getJEventJurisdictionRef(
          replica.state.config.jurisdiction,
        ),
        conflictingHeight,
        conflictingBlockHash: String(conflictingBlockHash || '').trim().toLowerCase(),
      },
    }));
    replicaKeys.push(replicaKey);
  }
  for (const replicaKey of requestedKeys || []) {
    if (!foundKeys.has(replicaKey)) {
      throw new Error(`J_HISTORY_REWIND_TARGET_REPLICA_MISSING:${replicaKey}`);
    }
  }
  if (runtimeTxs.length === 0) return [];
  enqueueRuntimeInput(env, {
    timestamp: conflictingHeight,
    runtimeTxs,
    entityInputs: [],
  });
  return replicaKeys.sort();
};

export const enqueueJHistoryRewindForReplicaKeys = (
  env: RuntimeReplica,
  conflictingHeight: number,
  conflictingBlockHash: string,
  replicaKeys: readonly string[],
  depositoryAddress?: string,
  chainId?: number,
): string[] => {
  if (replicaKeys.length === 0) throw new Error('J_HISTORY_REWIND_TARGETS_EMPTY');
  const requestedKeys = new Set(replicaKeys);
  if (requestedKeys.size !== replicaKeys.length) {
    throw new Error('J_HISTORY_REWIND_TARGETS_DUPLICATE');
  }
  return enqueueScopedRewind(
    env,
    conflictingHeight,
    conflictingBlockHash,
    requestedKeys,
    depositoryAddress,
    chainId,
  );
};
