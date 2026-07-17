import type { EntityReplica, Env, RuntimeTx } from '../types';
import { getLocalSignerPrivateKey } from '../account/crypto';
import { ENTITY_J_SUBMIT_FALLBACK_MS, isEntityActiveLeader } from '../entity/consensus/leader';
import { isBatchEmpty } from '../jurisdiction/batch';
import {
  getMatchingJSubmitState,
  hasPendingCommittedJBatch,
  markLocalJSubmitRuntimeTx,
  normalizeJSubmitId,
  type JSubmitBatchIdentity,
} from './j-submit-state';

type RetryJSubmitTx = Extract<RuntimeTx, { type: 'retryJSubmit' }>;

const hasQueuedAbort = (env: Env, entityId: string): boolean =>
  (env.runtimeMempool?.entityInputs ?? []).some((input) =>
    normalizeJSubmitId(input.entityId) === normalizeJSubmitId(entityId) &&
    (input.entityTxs ?? []).some((tx) => tx.type === 'j_abort_sent_batch'));

const hasQueuedRetry = (env: Env, identity: JSubmitBatchIdentity): boolean =>
  (env.runtimeMempool?.runtimeTxs ?? []).some((tx) =>
    tx.type === 'retryJSubmit' &&
    normalizeJSubmitId(tx.data.jurisdictionName) === normalizeJSubmitId(identity.jurisdictionName) &&
    normalizeJSubmitId(tx.data.entityId) === normalizeJSubmitId(identity.entityId) &&
    normalizeJSubmitId(tx.data.signerId) === normalizeJSubmitId(identity.signerId) &&
    normalizeJSubmitId(tx.data.batchHash) === normalizeJSubmitId(identity.batchHash) &&
    Number(tx.data.entityNonce) === Number(identity.entityNonce) &&
    tx.data.batchGeneration === identity.batchGeneration);

const jSubmitBatchIdentity = (replica: EntityReplica): JSubmitBatchIdentity | null => {
  const sent = replica.state.jBatchState?.sentBatch;
  if (!sent) return null;
  return {
    jurisdictionName: String(replica.state.config.jurisdiction?.name || ''),
    entityId: replica.entityId,
    signerId: replica.signerId,
    batchHash: sent.batchHash,
    entityNonce: sent.entityNonce,
    batchGeneration: replica.state.jBatchState?.broadcastCount ?? 0,
  };
};

const canSubmitLocally = (env: Env, signerId: string): boolean => {
  const signer = normalizeJSubmitId(signerId);
  return signer === normalizeJSubmitId(env.runtimeId) || Boolean(getLocalSignerPrivateKey(env, signer));
};

const nextRetryAt = (replica: EntityReplica): number | null => {
  const sent = replica.state.jBatchState?.sentBatch;
  if (!sent || isBatchEmpty(sent.batch)) return null;
  if (sent.terminalFailure) return null;
  const local = getMatchingJSubmitState(replica);
  if (!local || local.submitAttempts <= 0) return 0;
  if (local.terminalFailure || local.lastResultOutcome === 'reconciled') return null;
  return local.lastSubmittedAt + ENTITY_J_SUBMIT_FALLBACK_MS;
};

export const getNextJSubmitRetryTimestamp = (env: Env): number | null => {
  let next = Infinity;
  for (const replica of env.eReplicas.values()) {
    if (!isEntityActiveLeader(replica) || !canSubmitLocally(env, replica.signerId)) continue;
    const sent = replica.state.jBatchState?.sentBatch;
    if (!sent || hasQueuedAbort(env, replica.entityId)) continue;
    const identity = jSubmitBatchIdentity(replica);
    if (!identity) continue;
    if (hasPendingCommittedJBatch(env, identity)) continue;
    const dueAt = nextRetryAt(replica);
    if (dueAt !== null) next = Math.min(next, dueAt);
  }
  return Number.isFinite(next) ? next : null;
};

export const collectDueJSubmitRuntimeTxs = (env: Env, now: number): RetryJSubmitTx[] => {
  const retries: RetryJSubmitTx[] = [];
  for (const replica of env.eReplicas.values()) {
    if (!isEntityActiveLeader(replica) || !canSubmitLocally(env, replica.signerId)) continue;
    const sent = replica.state.jBatchState?.sentBatch;
    if (!sent || sent.terminalFailure || isBatchEmpty(sent.batch) || hasQueuedAbort(env, replica.entityId)) continue;
    const identity = jSubmitBatchIdentity(replica);
    if (!identity) continue;
    const local = getMatchingJSubmitState(replica);
    if (local?.terminalFailure || local?.lastResultOutcome === 'reconciled') continue;
    if (hasPendingCommittedJBatch(env, identity)) continue;
    if (hasQueuedRetry(env, identity)) continue;
    const dueAt = nextRetryAt(replica);
    if (dueAt === null || dueAt > now) continue;
    retries.push(markLocalJSubmitRuntimeTx({
      type: 'retryJSubmit',
      data: {
        entityId: replica.entityId,
        signerId: replica.signerId,
        jurisdictionName: String(replica.state.config.jurisdiction?.name || ''),
        batchHash: sent.batchHash,
        entityNonce: sent.entityNonce,
        batchGeneration: identity.batchGeneration,
        ...(sent.feeOverrides ? { feeOverrides: { ...sent.feeOverrides } } : {}),
      },
    }));
  }
  return retries;
};
