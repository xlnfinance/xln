import { safeStringify } from '../protocol/serialization';
import type { EntityReplica, Env, RuntimeTx } from '../types';
import type { EntityProviderActionSubmitState } from '../types/entity-provider-actions';
import {
  type ActionJTx,
  buildEntityProviderActionAttemptId,
  findEntityProviderActionReplica,
  isEntityProviderActionJTx,
  normalizeEntityProviderActionId,
  truncateEntityProviderActionFailureMessage,
} from './entity-provider-action-submit-state';
import { markLocalEntityProviderActionRuntimeTx } from './entity-provider-action-submit-auth';

type RecordActionResultTx = Extract<RuntimeTx, { type: 'recordEntityProviderActionSubmitResult' }>;
type PendingActionAttempt = { jurisdictionName: string; jTx: ActionJTx };

export const ENTITY_PROVIDER_ACTION_RESULT_FINGERPRINT_LIMIT = 256;
const MAX_UINT256 = (1n << 256n) - 1n;

const assertValidAdapterFailure = (data: RecordActionResultTx['data']): void => {
  const failure = data.adapterFailure;
  if (!failure) return;
  if (failure.category !== 'transient' && failure.category !== 'terminal') {
    throw new Error(`ENTITY_PROVIDER_ACTION_ADAPTER_FAILURE_CATEGORY_INVALID:${String(failure.category)}`);
  }
  if (!String(failure.code ?? '').trim()) throw new Error('ENTITY_PROVIDER_ACTION_ADAPTER_FAILURE_CODE_MISSING');
  if (!String(failure.message ?? '').trim()) throw new Error('ENTITY_PROVIDER_ACTION_ADAPTER_FAILURE_MESSAGE_MISSING');
  if (failure.message !== data.message) throw new Error('ENTITY_PROVIDER_ACTION_ADAPTER_FAILURE_MESSAGE_MISMATCH');
  const expected = failure.category === 'transient' ? 'transientFailure' : 'terminalFailure';
  if (data.outcome !== expected) {
    throw new Error(`ENTITY_PROVIDER_ACTION_ADAPTER_FAILURE_OUTCOME_MISMATCH:${failure.category}:${data.outcome}`);
  }
};

const assertValidActionResult = (data: RecordActionResultTx['data']): void => {
  if (!normalizeEntityProviderActionId(data.entityId)) throw new Error('ENTITY_PROVIDER_ACTION_RESULT_ENTITY_MISSING');
  if (!normalizeEntityProviderActionId(data.signerId)) throw new Error('ENTITY_PROVIDER_ACTION_RESULT_SIGNER_MISSING');
  if (!normalizeEntityProviderActionId(data.jurisdictionName)) {
    throw new Error('ENTITY_PROVIDER_ACTION_RESULT_JURISDICTION_MISSING');
  }
  if (!/^0x[0-9a-f]{64}$/.test(normalizeEntityProviderActionId(data.actionHash))) {
    throw new Error('ENTITY_PROVIDER_ACTION_RESULT_HASH_INVALID');
  }
  if (data.actionNonce <= 0n || data.actionNonce > MAX_UINT256) {
    throw new Error('ENTITY_PROVIDER_ACTION_RESULT_NONCE_INVALID');
  }
  if (!Number.isSafeInteger(data.generation) || data.generation <= 0) {
    throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_GENERATION_INVALID:${data.generation}`);
  }
  if (!Number.isSafeInteger(data.attemptNumber) || data.attemptNumber <= 0) {
    throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_ATTEMPT_NUMBER_INVALID:${data.attemptNumber}`);
  }
  if (!Number.isSafeInteger(data.attemptedAt) || data.attemptedAt < 0) {
    throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_ATTEMPT_TIMESTAMP_INVALID:${data.attemptedAt}`);
  }
  if (!['submitted', 'transientFailure', 'terminalFailure', 'reconciled'].includes(data.outcome)) {
    throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_OUTCOME_INVALID:${String(data.outcome)}`);
  }
  const expectedAttemptId = buildEntityProviderActionAttemptId({
    jurisdictionName: data.jurisdictionName,
    entityId: data.entityId,
    signerId: data.signerId,
    actionHash: data.actionHash,
    actionNonce: data.actionNonce,
    generation: data.generation,
    attemptNumber: data.attemptNumber,
  });
  if (data.attemptId !== expectedAttemptId) {
    throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_ATTEMPT_ID_MISMATCH:${data.attemptId}:${expectedAttemptId}`);
  }
  assertValidAdapterFailure(data);
};

const findPendingAttempt = (env: Env, attemptId: string): PendingActionAttempt | null => {
  const matches: PendingActionAttempt[] = [];
  for (const input of env.runtimeState?.pendingCommittedJOutbox ?? []) {
    for (const jTx of input.jTxs) {
      if (
        isEntityProviderActionJTx(jTx) &&
        jTx.data.runtimeSubmitAttempt?.attemptId === attemptId
      ) matches.push({ jurisdictionName: input.jurisdictionName, jTx });
    }
  }
  if (matches.length > 1) throw new Error(`ENTITY_PROVIDER_ACTION_PENDING_ATTEMPT_DUPLICATED:${attemptId}`);
  return matches[0] ?? null;
};

const pendingMatchesResult = (
  pending: PendingActionAttempt,
  data: RecordActionResultTx['data'],
): boolean => {
  const attempt = pending.jTx.data.runtimeSubmitAttempt;
  const intent = pending.jTx.data.intent;
  return Boolean(
    attempt &&
    normalizeEntityProviderActionId(pending.jurisdictionName) === normalizeEntityProviderActionId(data.jurisdictionName) &&
    normalizeEntityProviderActionId(pending.jTx.entityId) === normalizeEntityProviderActionId(data.entityId) &&
    normalizeEntityProviderActionId(pending.jTx.data.signerId) === normalizeEntityProviderActionId(data.signerId) &&
    normalizeEntityProviderActionId(intent.actionHash) === normalizeEntityProviderActionId(data.actionHash) &&
    intent.actionNonce === data.actionNonce &&
    intent.generation === data.generation &&
    attempt.attemptId === data.attemptId &&
    attempt.attemptNumber === data.attemptNumber &&
    attempt.attemptedAt === data.attemptedAt
  );
};

const findRecordedFingerprint = (env: Env, attemptId: string): string | null => {
  let found: string | null = null;
  for (const replica of env.eReplicas.values()) {
    const local = replica.entityProviderActionSubmitState;
    if (!local) continue;
    const journal = local.resultFingerprints?.[attemptId];
    const last = local.lastResultAttemptId === attemptId ? local.lastResultFingerprint : undefined;
    if (local.lastResultAttemptId === attemptId && !last) {
      throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_FINGERPRINT_MISSING:${attemptId}`);
    }
    if (journal !== undefined && last !== undefined && journal !== last) {
      throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_RECORDED_CONFLICT:${attemptId}`);
    }
    const fingerprint = journal ?? last;
    if (fingerprint === undefined) continue;
    if (found !== null && found !== fingerprint) {
      throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_RECORDED_CONFLICT:${attemptId}`);
    }
    found = fingerprint;
  }
  return found;
};

export const removePendingEntityProviderActionAttempt = (env: Env, attemptId: string): void => {
  const remaining = (env.runtimeState?.pendingCommittedJOutbox ?? []).flatMap((input) => {
    const jTxs = input.jTxs.filter((jTx) => !(
      isEntityProviderActionJTx(jTx) &&
      jTx.data.runtimeSubmitAttempt?.attemptId === attemptId
    ));
    return jTxs.length > 0 ? [{ jurisdictionName: input.jurisdictionName, jTxs }] : [];
  });
  if (env.runtimeState) env.runtimeState.pendingCommittedJOutbox = remaining;
};

const activePendingAttemptIds = (env: Env, replica: EntityReplica): Set<string> => {
  const active = new Set<string>();
  for (const input of env.runtimeState?.pendingCommittedJOutbox ?? []) {
    for (const jTx of input.jTxs) {
      if (
        isEntityProviderActionJTx(jTx) &&
        normalizeEntityProviderActionId(jTx.entityId) === normalizeEntityProviderActionId(replica.entityId) &&
        normalizeEntityProviderActionId(jTx.data.signerId) === normalizeEntityProviderActionId(replica.signerId) &&
        jTx.data.runtimeSubmitAttempt
      ) active.add(jTx.data.runtimeSubmitAttempt.attemptId);
    }
  }
  return active;
};

const buildResultJournal = (
  env: Env,
  replica: EntityReplica,
  attemptId: string,
  fingerprint: string,
): Pick<EntityProviderActionSubmitState, 'resultFingerprints' | 'resultFingerprintOrder'> => {
  const local = replica.entityProviderActionSubmitState;
  if (!local) throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_ATTEMPT_MISMATCH:${attemptId}`);
  const existing = local.resultFingerprints ?? {};
  const order = local.resultFingerprintOrder ?? Object.keys(existing);
  if (new Set(order).size !== order.length) throw new Error('ENTITY_PROVIDER_ACTION_RESULT_JOURNAL_ORDER_DUPLICATE');
  if (order.some((id) => existing[id] === undefined) || order.length !== Object.keys(existing).length) {
    throw new Error('ENTITY_PROVIDER_ACTION_RESULT_JOURNAL_ORDER_INVALID');
  }
  const nextOrder = [...order.filter((id) => id !== attemptId), attemptId];
  const retained = activePendingAttemptIds(env, replica);
  if (retained.size > ENTITY_PROVIDER_ACTION_RESULT_FINGERPRINT_LIMIT) {
    throw new Error(`ENTITY_PROVIDER_ACTION_ACTIVE_ATTEMPT_CAPACITY_EXCEEDED:${retained.size}`);
  }
  for (let index = nextOrder.length - 1; index >= 0 && retained.size < ENTITY_PROVIDER_ACTION_RESULT_FINGERPRINT_LIMIT; index -= 1) {
    retained.add(nextOrder[index]!);
  }
  const resultFingerprintOrder = nextOrder.filter((id) => retained.has(id));
  const all = { ...existing, [attemptId]: fingerprint };
  return {
    resultFingerprintOrder,
    resultFingerprints: Object.fromEntries(resultFingerprintOrder.map((id) => [id, all[id]!])),
  };
};

export const makeEntityProviderActionResultRuntimeTx = (
  jTx: ActionJTx,
  jurisdictionName: string,
  outcome: RecordActionResultTx['data']['outcome'],
  extra: {
    message?: string;
    txHash?: string;
    adapterFailure?: RecordActionResultTx['data']['adapterFailure'];
  } = {},
): RecordActionResultTx => {
  const attempt = jTx.data.runtimeSubmitAttempt;
  if (!attempt) throw new Error('ENTITY_PROVIDER_ACTION_RESULT_ATTEMPT_METADATA_MISSING');
  const message = extra.message ? truncateEntityProviderActionFailureMessage(extra.message) : undefined;
  const adapterFailure = extra.adapterFailure ? {
    ...structuredClone(extra.adapterFailure),
    message: truncateEntityProviderActionFailureMessage(extra.adapterFailure.message),
  } : undefined;
  return markLocalEntityProviderActionRuntimeTx({
    type: 'recordEntityProviderActionSubmitResult',
    data: {
      entityId: jTx.entityId,
      signerId: normalizeEntityProviderActionId(jTx.data.signerId),
      jurisdictionName,
      actionHash: jTx.data.intent.actionHash,
      actionNonce: jTx.data.intent.actionNonce,
      generation: jTx.data.intent.generation,
      attemptId: attempt.attemptId,
      attemptNumber: attempt.attemptNumber,
      attemptedAt: attempt.attemptedAt,
      outcome,
      ...(message ? { message } : {}),
      ...(adapterFailure ? { adapterFailure } : {}),
      ...(extra.txHash ? { txHash: extra.txHash } : {}),
    },
  });
};

export const applyRecordEntityProviderActionResultRuntimeTx = (
  env: Env,
  tx: RecordActionResultTx,
): void => {
  assertValidActionResult(tx.data);
  const fingerprint = safeStringify(tx.data);
  const pending = findPendingAttempt(env, tx.data.attemptId);
  if (pending && !pendingMatchesResult(pending, tx.data)) {
    throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_PENDING_CONFLICT:${tx.data.attemptId}`);
  }
  const recorded = findRecordedFingerprint(env, tx.data.attemptId);
  if (recorded !== null) {
    if (recorded !== fingerprint) throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_DUPLICATE_CONFLICT:${tx.data.attemptId}`);
    return;
  }
  const replica = findEntityProviderActionReplica(env, tx.data.entityId, tx.data.signerId);
  if (!replica) throw new Error(`ENTITY_PROVIDER_ACTION_LOCAL_REPLICA_MISSING:${tx.data.entityId}:${tx.data.signerId}`);
  const consensusPending = replica.state.entityProviderActionState?.pending;
  const local = replica.entityProviderActionSubmitState;
  const matchesConsensus = Boolean(
    consensusPending &&
    normalizeEntityProviderActionId(consensusPending.actionHash) === normalizeEntityProviderActionId(tx.data.actionHash) &&
    consensusPending.actionNonce === tx.data.actionNonce &&
    consensusPending.generation === tx.data.generation
  );
  const matchesLocal = Boolean(
    local &&
    normalizeEntityProviderActionId(local.actionHash) === normalizeEntityProviderActionId(tx.data.actionHash) &&
    local.actionNonce === tx.data.actionNonce &&
    local.generation === tx.data.generation
  );
  if (!matchesConsensus || (matchesLocal && local && tx.data.attemptNumber < local.submitAttempts)) {
    if (pending) removePendingEntityProviderActionAttempt(env, tx.data.attemptId);
    return;
  }
  if (
    !local ||
    !matchesLocal ||
    local.submitAttempts !== tx.data.attemptNumber ||
    local.lastSubmittedAt !== tx.data.attemptedAt
  ) throw new Error(`ENTITY_PROVIDER_ACTION_RESULT_ATTEMPT_MISMATCH:${tx.data.attemptId}`);
  if (!pending) throw new Error(`ENTITY_PROVIDER_ACTION_PENDING_ATTEMPT_MISSING:${tx.data.attemptId}`);
  const journal = buildResultJournal(env, replica, tx.data.attemptId, fingerprint);
  const next: EntityProviderActionSubmitState = {
    ...local,
    lastResultAttemptId: tx.data.attemptId,
    lastResultAt: env.timestamp,
    lastResultOutcome: tx.data.outcome,
    lastResultFingerprint: fingerprint,
    ...journal,
  };
  if (tx.data.outcome === 'submitted' || tx.data.outcome === 'reconciled') {
    if (tx.data.txHash) next.txHash = tx.data.txHash;
    delete next.lastFailure;
  } else {
    const failure = {
      message: String(tx.data.message ?? 'unknown'),
      failedAt: env.timestamp,
      ...(tx.data.adapterFailure ? { adapterFailure: structuredClone(tx.data.adapterFailure) } : {}),
    };
    next.lastFailure = failure;
    if (tx.data.outcome === 'terminalFailure') next.terminalFailure = failure;
  }
  removePendingEntityProviderActionAttempt(env, tx.data.attemptId);
  replica.entityProviderActionSubmitState = next;
};
