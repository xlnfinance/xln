import type { EntityReplica, Env, JTx, RuntimeTx } from '../types';
import { classifyRuntimeJBatchFailure } from '../protocol/failure-taxonomy';
import { safeStringify } from '../protocol/serialization';
import {
  buildJSubmitAttemptId,
  findJSubmitReplica,
  isMatchingJSubmitBatch,
  normalizeJSubmitId,
} from './j-submit-state';

type RecordJSubmitResultTx = Extract<RuntimeTx, { type: 'recordJSubmitResult' }>;
type BatchJTx = Extract<JTx, { type: 'batch' }>;
type PendingAttempt = { jurisdictionName: string; jTx: BatchJTx };

/**
 * At the default 60-second retry cadence this retains 4h16m of conflicting
 * duplicate evidence per validator/entity lane. Older exact results remain
 * structurally idempotent through attempt/batch identity checks.
 */
export const J_SUBMIT_RESULT_FINGERPRINT_LIMIT = 256;

const assertValidAdapterFailure = (data: RecordJSubmitResultTx['data']): void => {
  const failure = data.adapterFailure;
  if (!failure) return;
  if (!['transient', 'terminal'].includes(failure.category)) {
    throw new Error(`J_SUBMIT_ADAPTER_FAILURE_CATEGORY_INVALID:${String(failure.category)}`);
  }
  if (!String(failure.code || '').trim()) throw new Error('J_SUBMIT_ADAPTER_FAILURE_CODE_MISSING');
  if (!String(failure.message || '').trim()) throw new Error('J_SUBMIT_ADAPTER_FAILURE_MESSAGE_MISSING');
  if (failure.message !== data.message) throw new Error('J_SUBMIT_ADAPTER_FAILURE_MESSAGE_MISMATCH');
  const expectedOutcome = failure.category === 'transient' ? 'transientFailure' : 'terminalFailure';
  if (data.outcome !== expectedOutcome) {
    throw new Error(`J_SUBMIT_ADAPTER_FAILURE_OUTCOME_MISMATCH:${failure.category}:${data.outcome}`);
  }
};

const findPendingAttempt = (env: Env, attemptId: string): PendingAttempt | null => {
  const matches: PendingAttempt[] = [];
  for (const input of env.runtimeState?.pendingCommittedJOutbox ?? []) {
    for (const jTx of input.jTxs) {
      if (jTx.type === 'batch' && jTx.data.runtimeSubmitAttempt?.attemptId === attemptId) {
        matches.push({ jurisdictionName: input.jurisdictionName, jTx });
      }
    }
  }
  if (matches.length > 1) throw new Error(`J_SUBMIT_PENDING_ATTEMPT_DUPLICATED:${attemptId}`);
  return matches[0] ?? null;
};

const pendingAttemptMatchesResult = (
  pending: PendingAttempt,
  result: RecordJSubmitResultTx['data'],
): boolean => {
  const attempt = pending.jTx.data.runtimeSubmitAttempt;
  return Boolean(
    attempt &&
    normalizeJSubmitId(pending.jTx.entityId) === normalizeJSubmitId(result.entityId) &&
    normalizeJSubmitId(pending.jTx.data.signerId) === normalizeJSubmitId(result.signerId) &&
    pending.jurisdictionName === result.jurisdictionName &&
    normalizeJSubmitId(pending.jTx.data.batchHash) === normalizeJSubmitId(result.batchHash) &&
    Number(pending.jTx.data.entityNonce) === Number(result.entityNonce) &&
    Number(pending.jTx.data.batchGeneration) === result.batchGeneration &&
    attempt.attemptId === result.attemptId &&
    attempt.attemptNumber === result.attemptNumber &&
    attempt.attemptedAt === result.attemptedAt
  );
};

const assertValidJSubmitResult = (data: RecordJSubmitResultTx['data']): void => {
  if (!normalizeJSubmitId(data.entityId)) throw new Error('J_SUBMIT_RESULT_ENTITY_MISSING');
  if (!normalizeJSubmitId(data.signerId)) throw new Error('J_SUBMIT_RESULT_SIGNER_MISSING');
  if (!String(data.jurisdictionName || '').trim()) throw new Error('J_SUBMIT_RESULT_JURISDICTION_MISSING');
  if (!normalizeJSubmitId(data.batchHash)) throw new Error('J_SUBMIT_RESULT_BATCH_HASH_MISSING');
  if (!String(data.attemptId || '').trim()) throw new Error('J_SUBMIT_RESULT_ATTEMPT_ID_MISSING');
  if (!Number.isSafeInteger(data.entityNonce) || data.entityNonce < 0) {
    throw new Error(`J_SUBMIT_RESULT_ENTITY_NONCE_INVALID:${data.entityNonce}`);
  }
  if (!Number.isSafeInteger(data.batchGeneration) || data.batchGeneration <= 0) {
    throw new Error(`J_SUBMIT_RESULT_BATCH_GENERATION_INVALID:${data.batchGeneration}`);
  }
  if (!Number.isSafeInteger(data.attemptNumber) || data.attemptNumber <= 0) {
    throw new Error(`J_SUBMIT_RESULT_ATTEMPT_NUMBER_INVALID:${data.attemptNumber}`);
  }
  if (!Number.isSafeInteger(data.attemptedAt) || data.attemptedAt < 0) {
    throw new Error(`J_SUBMIT_RESULT_ATTEMPT_TIMESTAMP_INVALID:${data.attemptedAt}`);
  }
  const expectedAttemptId = buildJSubmitAttemptId({
    jurisdictionName: data.jurisdictionName,
    entityId: data.entityId,
    signerId: data.signerId,
    entityNonce: data.entityNonce,
    batchGeneration: data.batchGeneration,
    batchHash: data.batchHash,
    attemptNumber: data.attemptNumber,
  });
  if (data.attemptId !== expectedAttemptId) {
    throw new Error(`J_SUBMIT_RESULT_ATTEMPT_ID_MISMATCH:${data.attemptId}:${expectedAttemptId}`);
  }
  if (!['submitted', 'transientFailure', 'terminalFailure', 'reconciled'].includes(data.outcome)) {
    throw new Error(`J_SUBMIT_RESULT_OUTCOME_INVALID:${String(data.outcome)}`);
  }
  assertValidAdapterFailure(data);
};

const findRecordedResultFingerprint = (env: Env, attemptId: string): string | null => {
  let fingerprint: string | null = null;
  for (const replica of env.eReplicas.values()) {
    const local = replica.jSubmitState;
    if (!local) continue;
    const journalFingerprint = Object.prototype.hasOwnProperty.call(local.resultFingerprints ?? {}, attemptId)
      ? local.resultFingerprints?.[attemptId]
      : undefined;
    const lastFingerprint = local.lastResultAttemptId === attemptId
      ? local.lastResultFingerprint
      : undefined;
    if (local.lastResultAttemptId === attemptId && !lastFingerprint) {
      throw new Error(`J_SUBMIT_RESULT_FINGERPRINT_MISSING:${attemptId}`);
    }
    if (journalFingerprint !== undefined && lastFingerprint !== undefined && journalFingerprint !== lastFingerprint) {
      throw new Error(`J_SUBMIT_RESULT_RECORDED_CONFLICT:${attemptId}`);
    }
    const recorded = journalFingerprint ?? lastFingerprint;
    if (recorded === undefined) continue;
    if (fingerprint !== null && fingerprint !== recorded) {
      throw new Error(`J_SUBMIT_RESULT_RECORDED_CONFLICT:${attemptId}`);
    }
    fingerprint = recorded;
  }
  return fingerprint;
};

const removePendingAttempt = (env: Env, attemptId: string): void => {
  const pending = env.runtimeState?.pendingCommittedJOutbox ?? [];
  const remaining = pending.flatMap((input) => {
    const jTxs = input.jTxs.filter((jTx) => (
      jTx.type !== 'batch' || jTx.data.runtimeSubmitAttempt?.attemptId !== attemptId
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
        jTx.type === 'batch' &&
        normalizeJSubmitId(jTx.entityId) === normalizeJSubmitId(replica.entityId) &&
        normalizeJSubmitId(jTx.data.signerId) === normalizeJSubmitId(replica.signerId) &&
        jTx.data.runtimeSubmitAttempt
      ) active.add(jTx.data.runtimeSubmitAttempt.attemptId);
    }
  }
  return active;
};

const orderedRecordedAttemptIds = (local: NonNullable<EntityReplica['jSubmitState']>): string[] => {
  const fingerprints = local.resultFingerprints ?? {};
  const order = local.resultFingerprintOrder ?? Object.keys(fingerprints);
  const seen = new Set<string>();
  for (const attemptId of order) {
    if (seen.has(attemptId)) throw new Error(`J_SUBMIT_RESULT_JOURNAL_ORDER_DUPLICATE:${attemptId}`);
    if (!Object.prototype.hasOwnProperty.call(fingerprints, attemptId)) {
      throw new Error(`J_SUBMIT_RESULT_JOURNAL_ORDER_UNKNOWN:${attemptId}`);
    }
    seen.add(attemptId);
  }
  if (seen.size !== Object.keys(fingerprints).length) {
    throw new Error('J_SUBMIT_RESULT_JOURNAL_ORDER_INCOMPLETE');
  }
  return [...order];
};

const buildBoundedResultJournal = (
  env: Env,
  replica: EntityReplica,
  attemptId: string,
  fingerprint: string,
): Pick<NonNullable<EntityReplica['jSubmitState']>, 'resultFingerprints' | 'resultFingerprintOrder'> => {
  const local = replica.jSubmitState;
  if (!local) throw new Error(`J_SUBMIT_RESULT_ATTEMPT_MISMATCH:${attemptId}`);
  const order = [...orderedRecordedAttemptIds(local).filter((id) => id !== attemptId), attemptId];
  const retained = activePendingAttemptIds(env, replica);
  if (retained.size > J_SUBMIT_RESULT_FINGERPRINT_LIMIT) {
    throw new Error(`J_SUBMIT_ACTIVE_ATTEMPT_CAPACITY_EXCEEDED:${retained.size}`);
  }
  for (let index = order.length - 1; index >= 0 && retained.size < J_SUBMIT_RESULT_FINGERPRINT_LIMIT; index -= 1) {
    if (order[index]) retained.add(order[index]!);
  }
  const resultFingerprintOrder = order.filter((id) => retained.has(id));
  const all = { ...(local.resultFingerprints ?? {}), [attemptId]: fingerprint };
  const resultFingerprints = Object.fromEntries(resultFingerprintOrder.map((id) => {
    if (all[id] === undefined) throw new Error(`J_SUBMIT_RESULT_FINGERPRINT_MISSING:${id}`);
    return [id, all[id]];
  }));
  return { resultFingerprints, resultFingerprintOrder };
};

const nextJSubmitState = (
  env: Env,
  replica: EntityReplica,
  tx: RecordJSubmitResultTx,
  resultFingerprint: string,
): NonNullable<EntityReplica['jSubmitState']> => {
  const local = replica.jSubmitState;
  if (!local) throw new Error(`J_SUBMIT_RESULT_ATTEMPT_MISMATCH:${tx.data.attemptId}`);
  const journal = buildBoundedResultJournal(env, replica, tx.data.attemptId, resultFingerprint);
  const next = {
    ...local,
    lastResultAttemptId: tx.data.attemptId,
    lastResultAt: env.timestamp,
    lastResultOutcome: tx.data.outcome,
    lastResultFingerprint: resultFingerprint,
    ...journal,
  };
  if (tx.data.outcome === 'submitted') {
    if (tx.data.txHash) next.txHash = tx.data.txHash;
    delete next.lastFailure;
  } else if (tx.data.outcome === 'transientFailure' || tx.data.outcome === 'terminalFailure') {
    const message = String(tx.data.message || 'unknown');
    const code = tx.data.outcome === 'transientFailure' ? 'J_SUBMIT_TRANSIENT' : 'J_SUBMIT_FATAL';
    const failure = {
      message,
      failedAt: env.timestamp,
      failure: classifyRuntimeJBatchFailure(code, message),
      ...(tx.data.adapterFailure ? { adapterFailure: structuredClone(tx.data.adapterFailure) } : {}),
    };
    next.lastFailure = failure;
    if (tx.data.outcome === 'terminalFailure') next.terminalFailure = failure;
  }
  return next;
};

export const applyRecordJSubmitResultRuntimeTx = (env: Env, tx: RecordJSubmitResultTx): void => {
  assertValidJSubmitResult(tx.data);
  const resultFingerprint = safeStringify(tx.data);
  const pending = findPendingAttempt(env, tx.data.attemptId);
  if (pending && !pendingAttemptMatchesResult(pending, tx.data)) {
    throw new Error(`J_SUBMIT_RESULT_PENDING_CONFLICT:${tx.data.attemptId}`);
  }
  const recordedFingerprint = findRecordedResultFingerprint(env, tx.data.attemptId);
  if (recordedFingerprint !== null) {
    if (recordedFingerprint !== resultFingerprint) {
      throw new Error(`J_SUBMIT_RESULT_DUPLICATE_CONFLICT:${tx.data.attemptId}`);
    }
    return;
  }
  const replica = findJSubmitReplica(env, tx.data.entityId, tx.data.signerId);
  if (!replica) throw new Error(`J_SUBMIT_LOCAL_REPLICA_MISSING:${tx.data.entityId}:${tx.data.signerId}`);
  const local = replica.jSubmitState;
  const sent = replica.state.jBatchState?.sentBatch;
  const matchesSent = Boolean(
    sent &&
    isMatchingJSubmitBatch(sent, tx.data.batchHash, tx.data.entityNonce) &&
    replica.state.jBatchState?.broadcastCount === tx.data.batchGeneration
  );
  const matchesLocal = Boolean(
    local &&
    normalizeJSubmitId(local.batchHash) === normalizeJSubmitId(tx.data.batchHash) &&
    local.entityNonce === tx.data.entityNonce &&
    local.batchGeneration === tx.data.batchGeneration
  );

  // Stale external I/O may retire only its exact old payload. It must never
  // overwrite the receipt or pending batch that replaced it.
  if (!matchesSent || (matchesLocal && local && tx.data.attemptNumber < local.submitAttempts)) {
    if (pending) removePendingAttempt(env, tx.data.attemptId);
    return;
  }
  if (
    !local ||
    !matchesLocal ||
    local.submitAttempts !== tx.data.attemptNumber ||
    local.lastSubmittedAt !== tx.data.attemptedAt
  ) {
    throw new Error(`J_SUBMIT_RESULT_ATTEMPT_MISMATCH:${tx.data.attemptId}`);
  }
  if (!pending) throw new Error(`J_SUBMIT_PENDING_ATTEMPT_MISSING:${tx.data.attemptId}`);
  const next = nextJSubmitState(env, replica, tx, resultFingerprint);
  removePendingAttempt(env, tx.data.attemptId);
  replica.jSubmitState = next;
};
