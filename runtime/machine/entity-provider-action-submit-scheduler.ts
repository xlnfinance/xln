import { ENTITY_J_SUBMIT_FALLBACK_MS, isEntityActiveLeader } from '../entity/consensus/leader';
import { getJurisdictionConfigName } from '../jurisdiction/jurisdiction-runtime';
import type { EntityReplica, Env, RuntimeTx } from '../types';
import {
  canSubmitEntityProviderActionLocally,
  getMatchingEntityProviderActionSubmitState,
  hasPendingCommittedEntityProviderAction,
  normalizeEntityProviderActionId,
} from './entity-provider-action-submit-state';
import { markLocalEntityProviderActionRuntimeTx } from './entity-provider-action-submit-auth';

type RetryActionTx = Extract<RuntimeTx, { type: 'retryEntityProviderAction' }>;

const hasQueuedRetry = (
  env: Env,
  identity: RetryActionTx['data'],
): boolean => (env.runtimeMempool?.runtimeTxs ?? []).some((tx) =>
  tx.type === 'retryEntityProviderAction' &&
  normalizeEntityProviderActionId(tx.data.jurisdictionName) === normalizeEntityProviderActionId(identity.jurisdictionName) &&
  normalizeEntityProviderActionId(tx.data.entityId) === normalizeEntityProviderActionId(identity.entityId) &&
  normalizeEntityProviderActionId(tx.data.signerId) === normalizeEntityProviderActionId(identity.signerId) &&
  normalizeEntityProviderActionId(tx.data.actionHash) === normalizeEntityProviderActionId(identity.actionHash) &&
  tx.data.actionNonce === identity.actionNonce &&
  tx.data.generation === identity.generation);

const retryIdentity = (replica: EntityReplica): RetryActionTx['data'] | null => {
  const pending = replica.state.entityProviderActionState?.pending;
  const jurisdictionName = getJurisdictionConfigName(replica.state.config.jurisdiction);
  if (!pending || !jurisdictionName) return null;
  return {
    entityId: replica.entityId,
    signerId: replica.signerId,
    jurisdictionName,
    actionHash: pending.actionHash,
    actionNonce: pending.actionNonce,
    generation: pending.generation,
  };
};

const nextRetryAt = (replica: EntityReplica): number | null => {
  if (!replica.state.entityProviderActionState?.pending) return null;
  const local = getMatchingEntityProviderActionSubmitState(replica);
  if (!local || local.submitAttempts <= 0) return 0;
  if (local.terminalFailure) return null;
  return local.lastSubmittedAt + ENTITY_J_SUBMIT_FALLBACK_MS;
};

export const getNextEntityProviderActionRetryTimestamp = (env: Env): number | null => {
  let next = Infinity;
  for (const replica of env.eReplicas.values()) {
    if (!isEntityActiveLeader(replica) || !canSubmitEntityProviderActionLocally(env, replica.signerId)) continue;
    const identity = retryIdentity(replica);
    if (!identity || hasPendingCommittedEntityProviderAction(env, identity)) continue;
    const dueAt = nextRetryAt(replica);
    if (dueAt !== null) next = Math.min(next, dueAt);
  }
  return Number.isFinite(next) ? next : null;
};

export const collectDueEntityProviderActionRuntimeTxs = (
  env: Env,
  now: number,
): RetryActionTx[] => {
  const retries: RetryActionTx[] = [];
  for (const replica of env.eReplicas.values()) {
    if (!isEntityActiveLeader(replica) || !canSubmitEntityProviderActionLocally(env, replica.signerId)) continue;
    const identity = retryIdentity(replica);
    if (!identity) continue;
    const local = getMatchingEntityProviderActionSubmitState(replica);
    if (local?.terminalFailure) continue;
    if (hasPendingCommittedEntityProviderAction(env, identity) || hasQueuedRetry(env, identity)) continue;
    const dueAt = nextRetryAt(replica);
    if (dueAt === null || dueAt > now) continue;
    retries.push(markLocalEntityProviderActionRuntimeTx({
      type: 'retryEntityProviderAction',
      data: identity,
    }));
  }
  return retries;
};
