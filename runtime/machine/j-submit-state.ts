import type { EntityReplica, Env, JInput, JTx, RuntimeTx } from '../types';
import { keccak256, toUtf8Bytes } from 'ethers';
import { batchOpCount, cloneJBatch } from '../jurisdiction/batch';
import { safeStringify } from '../protocol/serialization';
import {
  ENTITY_J_SUBMIT_FALLBACK_MS,
  isEntityActiveLeader,
} from '../entity/consensus/leader';
import {
  isEntityProviderActionJTx,
  requireCanonicalEntityProviderActionAttempt,
  type ActionJTx,
} from './entity-provider-action-submit-state';
import { markLocalEntityProviderActionRuntimeTx } from './entity-provider-action-submit-auth';

type RetryJSubmitTx = Extract<RuntimeTx, { type: 'retryJSubmit' }>;
type RecordJSubmitResultTx = Extract<RuntimeTx, { type: 'recordJSubmitResult' }>;
type BatchJTx = Extract<JTx, { type: 'batch' }>;
type DurableAttempt =
  | NonNullable<BatchJTx['data']['runtimeSubmitAttempt']>
  | NonNullable<ActionJTx['data']['runtimeSubmitAttempt']>;

const LOCAL_J_SUBMIT_RUNTIME_TX = Symbol.for('xln.runtime.j-submit.local');

export const normalizeJSubmitId = (value: unknown): string => String(value || '').trim().toLowerCase();

export const MAX_J_SUBMIT_FAILURE_MESSAGE_CHARS = 4_096;

export const truncateJSubmitFailureMessage = (value: unknown): string => {
  const message = String(value || 'unknown');
  if (message.length <= MAX_J_SUBMIT_FAILURE_MESSAGE_CHARS) return message;
  const suffix = `...[truncated:${message.length}]`;
  return message.slice(0, MAX_J_SUBMIT_FAILURE_MESSAGE_CHARS - suffix.length) + suffix;
};

type JSubmitAttemptIdentity = {
  jurisdictionName: string;
  entityId: string;
  signerId: string;
  entityNonce: number;
  batchGeneration: number;
  batchHash: string;
  attemptNumber: number;
};

export type JSubmitBatchIdentity = Omit<JSubmitAttemptIdentity, 'attemptNumber'>;

/**
 * Validator-local attempt counters restart at one when leadership moves. The
 * signer and jurisdiction domains are therefore mandatory: entity+batch alone
 * lets a new leader collide with an old leader's already-recorded result. The
 * broadcast generation also separates an abort+rebuild that intentionally
 * repeats the same on-chain nonce and batch hash.
 */
export const buildJSubmitAttemptId = (identity: JSubmitAttemptIdentity): string => {
  const jurisdictionName = normalizeJSubmitId(identity.jurisdictionName);
  const entityId = normalizeJSubmitId(identity.entityId);
  const signerId = normalizeJSubmitId(identity.signerId);
  const batchHash = normalizeJSubmitId(identity.batchHash);
  if (!jurisdictionName) throw new Error('J_SUBMIT_ATTEMPT_JURISDICTION_MISSING');
  if (!entityId) throw new Error('J_SUBMIT_ATTEMPT_ENTITY_MISSING');
  if (!signerId) throw new Error('J_SUBMIT_ATTEMPT_SIGNER_MISSING');
  if (!batchHash) throw new Error('J_SUBMIT_ATTEMPT_BATCH_HASH_MISSING');
  if (!Number.isSafeInteger(identity.entityNonce) || identity.entityNonce < 0) {
    throw new Error(`J_SUBMIT_ATTEMPT_ENTITY_NONCE_INVALID:${identity.entityNonce}`);
  }
  if (!Number.isSafeInteger(identity.batchGeneration) || identity.batchGeneration <= 0) {
    throw new Error(`J_SUBMIT_ATTEMPT_BATCH_GENERATION_INVALID:${identity.batchGeneration}`);
  }
  if (!Number.isSafeInteger(identity.attemptNumber) || identity.attemptNumber <= 0) {
    throw new Error(`J_SUBMIT_ATTEMPT_NUMBER_INVALID:${identity.attemptNumber}`);
  }
  return keccak256(toUtf8Bytes(safeStringify({
    domain: 'xln/j-submit-attempt/v2',
    jurisdictionName,
    entityId,
    signerId,
    entityNonce: identity.entityNonce,
    batchGeneration: identity.batchGeneration,
    batchHash,
    attemptNumber: identity.attemptNumber,
  }))).toLowerCase();
};

export const findJSubmitReplica = (env: Env, entityId: string, signerId: string): EntityReplica | null => {
  const entity = normalizeJSubmitId(entityId);
  const signer = normalizeJSubmitId(signerId);
  for (const replica of env.eReplicas.values()) {
    if (
      normalizeJSubmitId(replica.entityId) === entity &&
      normalizeJSubmitId(replica.signerId) === signer
    ) return replica;
  }
  return null;
};

export const isMatchingJSubmitBatch = (
  sent: NonNullable<EntityReplica['state']['jBatchState']>['sentBatch'],
  batchHash: string,
  entityNonce: number,
): boolean => Boolean(
  sent &&
  normalizeJSubmitId(sent.batchHash) === normalizeJSubmitId(batchHash) &&
  Number(sent.entityNonce) === Number(entityNonce)
);

const attemptOf = (jTx: JTx): DurableAttempt | undefined => {
  if (jTx.type === 'batch') return jTx.data.runtimeSubmitAttempt;
  if (isEntityProviderActionJTx(jTx)) {
    return jTx.data.runtimeSubmitAttempt;
  }
  return undefined;
};

const requireCanonicalPendingAttempt = (
  jurisdictionName: string,
  jTx: JTx,
): DurableAttempt => {
  const attempt = attemptOf(jTx);
  if (!attempt) throw new Error('J_SUBMIT_PENDING_ATTEMPT_METADATA_MISSING');
  if (isEntityProviderActionJTx(jTx)) {
    return requireCanonicalEntityProviderActionAttempt(jurisdictionName, jTx);
  }
  if (jTx.type !== 'batch') throw new Error('J_SUBMIT_PENDING_ATTEMPT_UNSUPPORTED');
  const batchAttempt = jTx.data.runtimeSubmitAttempt;
  if (!batchAttempt) throw new Error('J_SUBMIT_PENDING_ATTEMPT_METADATA_MISSING');
  const expected = buildJSubmitAttemptId({
    jurisdictionName,
    entityId: jTx.entityId,
    signerId: normalizeJSubmitId(jTx.data.signerId),
    entityNonce: Number(jTx.data.entityNonce),
    batchGeneration: batchAttempt.batchGeneration,
    batchHash: String(jTx.data.batchHash || ''),
    attemptNumber: batchAttempt.attemptNumber,
  });
  if (jTx.data.batchGeneration !== batchAttempt.batchGeneration) {
    throw new Error(`J_SUBMIT_PENDING_BATCH_GENERATION_MISMATCH:${String(jTx.data.batchGeneration)}:${batchAttempt.batchGeneration}`);
  }
  if (batchAttempt.attemptId !== expected) {
    throw new Error(`J_SUBMIT_PENDING_ATTEMPT_ID_MISMATCH:${batchAttempt.attemptId}:${expected}`);
  }
  return batchAttempt;
};

const pendingAttemptFingerprint = (jurisdictionName: string, jTx: JTx): string =>
  safeStringify({ jurisdictionName, jTx });

const pendingAttemptFingerprints = (env: Env): Map<string, string> => {
  const fingerprints = new Map<string, string>();
  for (const input of env.runtimeState?.pendingCommittedJOutbox ?? []) {
    for (const jTx of input.jTxs) {
      const attempt = requireCanonicalPendingAttempt(input.jurisdictionName, jTx);
      const fingerprint = pendingAttemptFingerprint(input.jurisdictionName, jTx);
      const previous = fingerprints.get(attempt.attemptId);
      if (previous !== undefined && previous !== fingerprint) {
        throw new Error(`J_SUBMIT_PENDING_ATTEMPT_CONFLICT:${attempt.attemptId}`);
      }
      if (previous !== undefined) {
        throw new Error(`J_SUBMIT_PENDING_ATTEMPT_DUPLICATED:${attempt.attemptId}`);
      }
      fingerprints.set(attempt.attemptId, fingerprint);
    }
  }
  return fingerprints;
};

const matchesJSubmitBatchIdentity = (
  jurisdictionName: string,
  jTx: JTx,
  identity: JSubmitBatchIdentity,
): boolean => Boolean(
  jTx.type === 'batch' &&
  normalizeJSubmitId(jurisdictionName) === normalizeJSubmitId(identity.jurisdictionName) &&
  normalizeJSubmitId(jTx.entityId) === normalizeJSubmitId(identity.entityId) &&
  normalizeJSubmitId(jTx.data.signerId) === normalizeJSubmitId(identity.signerId) &&
  normalizeJSubmitId(jTx.data.batchHash) === normalizeJSubmitId(identity.batchHash) &&
  Number(jTx.data.entityNonce) === Number(identity.entityNonce) &&
  Number(jTx.data.batchGeneration) === Number(identity.batchGeneration)
);

export const hasPendingCommittedJBatch = (env: Env, identity: JSubmitBatchIdentity): boolean =>
  (env.runtimeState?.pendingCommittedJOutbox ?? []).some((input) => input.jTxs.some((jTx) =>
    matchesJSubmitBatchIdentity(input.jurisdictionName, jTx, identity)));

export const getMatchingJSubmitState = (replica: EntityReplica) => {
  const sent = replica.state.jBatchState?.sentBatch;
  const local = replica.jSubmitState;
  if (
    !sent ||
    !local ||
    !isMatchingJSubmitBatch(sent, local.batchHash, local.entityNonce) ||
    local.batchGeneration !== replica.state.jBatchState?.broadcastCount
  ) return null;
  return local;
};

export const markLocalJSubmitRuntimeTx = <T extends RetryJSubmitTx | RecordJSubmitResultTx>(tx: T): T => {
  Object.defineProperty(tx, LOCAL_J_SUBMIT_RUNTIME_TX, { value: true, enumerable: false });
  return tx;
};

export const copyLocalJSubmitRuntimeTxAuthorization = (
  source: RuntimeTx,
  target: RuntimeTx,
): void => {
  if (
    (source.type === 'retryJSubmit' || source.type === 'recordJSubmitResult') &&
    source.type === target.type &&
    (source as RuntimeTx & { [LOCAL_J_SUBMIT_RUNTIME_TX]?: boolean })[LOCAL_J_SUBMIT_RUNTIME_TX]
  ) {
    markLocalJSubmitRuntimeTx(target as RetryJSubmitTx | RecordJSubmitResultTx);
  }
};

export const markRestoredJSubmitRuntimeTxs = (runtimeTxs: RuntimeTx[]): void => {
  for (const runtimeTx of runtimeTxs) {
    if (runtimeTx.type === 'retryJSubmit' || runtimeTx.type === 'recordJSubmitResult') {
      markLocalJSubmitRuntimeTx(runtimeTx);
    }
  }
};

export const assertJSubmitRuntimeTxAuthorized = (runtimeTx: RuntimeTx, replay: boolean): void => {
  if (runtimeTx.type !== 'retryJSubmit' && runtimeTx.type !== 'recordJSubmitResult') return;
  if (replay || (runtimeTx as RuntimeTx & { [LOCAL_J_SUBMIT_RUNTIME_TX]?: boolean })[LOCAL_J_SUBMIT_RUNTIME_TX]) return;
  throw new Error('J_SUBMIT_RUNTIME_TX_EXTERNAL_INGRESS_REJECTED');
};

export const registerPendingCommittedJOutbox = (env: Env, additions: JInput[]): void => {
  if (additions.length === 0) return;
  if (!env.runtimeState) env.runtimeState = {};
  const existing = env.runtimeState.pendingCommittedJOutbox ?? [];
  const known = pendingAttemptFingerprints(env);
  const accepted: JInput[] = [];
  for (const input of additions) {
    const jTxs = input.jTxs.filter((jTx) => {
      const attempt = requireCanonicalPendingAttempt(input.jurisdictionName, jTx);
      const fingerprint = pendingAttemptFingerprint(input.jurisdictionName, jTx);
      const previous = known.get(attempt.attemptId);
      if (previous !== undefined) {
        if (previous !== fingerprint) {
          throw new Error(`J_SUBMIT_PENDING_ATTEMPT_CONFLICT:${attempt.attemptId}`);
        }
        return false;
      }
      known.set(attempt.attemptId, fingerprint);
      return true;
    });
    if (jTxs.length > 0) accepted.push({ jurisdictionName: input.jurisdictionName, jTxs });
  }
  env.runtimeState.pendingCommittedJOutbox = [...existing, ...accepted];
};

export const applyRetryJSubmitRuntimeTx = (env: Env, tx: RetryJSubmitTx): JInput[] => {
  const replica = findJSubmitReplica(env, tx.data.entityId, tx.data.signerId);
  if (!replica) throw new Error(`J_SUBMIT_LOCAL_REPLICA_MISSING:${tx.data.entityId}:${tx.data.signerId}`);
  if (!isEntityActiveLeader(replica)) throw new Error(`J_SUBMIT_NOT_ACTIVE_LEADER:${tx.data.signerId}`);
  const sent = replica.state.jBatchState?.sentBatch;
  if (
    !sent ||
    !isMatchingJSubmitBatch(sent, tx.data.batchHash, tx.data.entityNonce) ||
    tx.data.batchGeneration !== replica.state.jBatchState?.broadcastCount
  ) {
    throw new Error(`J_SUBMIT_COMMITTED_BATCH_MISMATCH:${tx.data.entityId}:${tx.data.entityNonce}`);
  }
  // A finalized exact chain event can prove that this nonce was consumed by a
  // different batch after the retry intent was queued. The intent is then a
  // stale scheduling hint, not permission to resurrect an impossible payload.
  if (sent.terminalFailure) return [];
  const previous = getMatchingJSubmitState(replica);
  // Retry intents can be queued before an earlier attempt result is applied.
  // They are replayable scheduling hints, not permission to overlap external
  // writes. Exactly one durable attempt may be outstanding for a batch.
  if (hasPendingCommittedJBatch(env, {
    jurisdictionName: tx.data.jurisdictionName,
    entityId: replica.entityId,
    signerId: replica.signerId,
    batchHash: sent.batchHash,
    entityNonce: sent.entityNonce,
    batchGeneration: tx.data.batchGeneration,
  })) return [];
  if (previous?.terminalFailure || previous?.lastResultOutcome === 'reconciled') return [];
  if (
    previous &&
    previous.submitAttempts > 0 &&
    env.timestamp < previous.lastSubmittedAt + ENTITY_J_SUBMIT_FALLBACK_MS
  ) return [];
  const witness = replica.hankoWitness?.get(sent.batchHash);
  if (!witness || witness.type !== 'jBatch') {
    throw new Error(`J_SUBMIT_HANKO_WITNESS_MISSING:${tx.data.entityId}:${sent.batchHash}`);
  }
  const attemptNumber = (previous?.submitAttempts ?? 0) + 1;
  const attemptId = buildJSubmitAttemptId({
    jurisdictionName: tx.data.jurisdictionName,
    entityId: replica.entityId,
    signerId: replica.signerId,
    entityNonce: sent.entityNonce,
    batchGeneration: tx.data.batchGeneration,
    batchHash: sent.batchHash,
    attemptNumber,
  });
  const attemptedAt = env.timestamp;
  const recordedResultFingerprints = replica.jSubmitState?.resultFingerprints;
  const recordedResultFingerprintOrder = replica.jSubmitState?.resultFingerprintOrder;
  replica.jSubmitState = {
    jurisdictionName: tx.data.jurisdictionName,
    batchHash: sent.batchHash,
    entityNonce: sent.entityNonce,
    batchGeneration: tx.data.batchGeneration,
    submitAttempts: attemptNumber,
    lastSubmittedAt: attemptedAt,
    ...(previous?.txHash ? { txHash: previous.txHash } : {}),
    ...(previous?.lastFailure ? { lastFailure: structuredClone(previous.lastFailure) } : {}),
    ...(previous?.lastResultAttemptId ? { lastResultAttemptId: previous.lastResultAttemptId } : {}),
    ...(previous?.lastResultAt !== undefined ? { lastResultAt: previous.lastResultAt } : {}),
    ...(previous?.lastResultOutcome ? { lastResultOutcome: previous.lastResultOutcome } : {}),
    ...(previous?.lastResultFingerprint ? { lastResultFingerprint: previous.lastResultFingerprint } : {}),
    ...(recordedResultFingerprints
      ? { resultFingerprints: structuredClone(recordedResultFingerprints) }
      : {}),
    ...(recordedResultFingerprintOrder
      ? { resultFingerprintOrder: [...recordedResultFingerprintOrder] }
      : {}),
  };
  const batchTx: BatchJTx = {
    type: 'batch',
    entityId: replica.entityId,
    data: {
      batch: cloneJBatch(sent.batch),
      batchHash: sent.batchHash,
      encodedBatch: sent.encodedBatch,
      entityNonce: sent.entityNonce,
      batchGeneration: tx.data.batchGeneration,
      hankoSignature: witness.hanko,
      batchSize: batchOpCount(sent.batch),
      signerId: replica.signerId,
      ...(tx.data.feeOverrides ? { feeOverrides: { ...tx.data.feeOverrides } } : {}),
      runtimeSubmitAttempt: {
        attemptId,
        attemptNumber,
        attemptedAt,
        batchGeneration: tx.data.batchGeneration,
      },
    },
    timestamp: attemptedAt,
  };
  return [{ jurisdictionName: tx.data.jurisdictionName, jTxs: [batchTx] }];
};

export const makeJSubmitResultRuntimeTx = (
  jTx: BatchJTx,
  jurisdictionName: string,
  outcome: RecordJSubmitResultTx['data']['outcome'],
  extra: {
    message?: string;
    txHash?: string;
    adapterFailure?: RecordJSubmitResultTx['data']['adapterFailure'];
  } = {},
): RecordJSubmitResultTx => {
  const attempt = jTx.data.runtimeSubmitAttempt;
  const signerId = normalizeJSubmitId(jTx.data.signerId);
  if (!attempt) throw new Error('J_SUBMIT_RESULT_ATTEMPT_METADATA_MISSING');
  if (!signerId) throw new Error('J_SUBMIT_RESULT_SIGNER_MISSING');
  const expectedAttemptId = buildJSubmitAttemptId({
    jurisdictionName,
    entityId: jTx.entityId,
    signerId,
    entityNonce: Number(jTx.data.entityNonce),
    batchGeneration: attempt.batchGeneration,
    batchHash: String(jTx.data.batchHash || ''),
    attemptNumber: attempt.attemptNumber,
  });
  if (attempt.attemptId !== expectedAttemptId) {
    throw new Error(`J_SUBMIT_RESULT_ATTEMPT_ID_MISMATCH:${attempt.attemptId}:${expectedAttemptId}`);
  }
  const message = extra.message ? truncateJSubmitFailureMessage(extra.message) : undefined;
  const adapterFailure = extra.adapterFailure
    ? {
        ...structuredClone(extra.adapterFailure),
        message: truncateJSubmitFailureMessage(extra.adapterFailure.message),
      }
    : undefined;
  return markLocalJSubmitRuntimeTx({
    type: 'recordJSubmitResult',
    data: {
      entityId: jTx.entityId,
      signerId,
      jurisdictionName,
      batchHash: String(jTx.data.batchHash || ''),
      entityNonce: Number(jTx.data.entityNonce),
      batchGeneration: attempt.batchGeneration,
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

export const splitJOutboxForDurableSubmit = (
  jOutbox: JInput[],
): { maintenance: JInput[]; durable: JInput[]; retries: RuntimeTx[] } => {
  const maintenance: JInput[] = [];
  const durable: JInput[] = [];
  const retries: RuntimeTx[] = [];
  for (const input of jOutbox) {
    const maintenanceTxs: JTx[] = [];
    const durableTxs: JTx[] = [];
    for (const jTx of input.jTxs) {
      if (isEntityProviderActionJTx(jTx)) {
        if (jTx.data.runtimeSubmitAttempt) {
          requireCanonicalEntityProviderActionAttempt(input.jurisdictionName, jTx);
          durableTxs.push(jTx);
        } else {
          const signerId = normalizeJSubmitId(jTx.data.signerId);
          if (!signerId) throw new Error(`ENTITY_PROVIDER_ACTION_SUBMITTER_MISSING:${jTx.entityId}`);
          if (!jTx.data.hankoSignature) {
            throw new Error(`ENTITY_PROVIDER_ACTION_CONSENSUS_HANKO_MISSING:${jTx.entityId}`);
          }
          retries.push(markLocalEntityProviderActionRuntimeTx({
            type: 'retryEntityProviderAction',
            data: {
              entityId: jTx.entityId,
              signerId,
              jurisdictionName: input.jurisdictionName,
              actionHash: jTx.data.intent.actionHash,
              actionNonce: jTx.data.intent.actionNonce,
              generation: jTx.data.intent.generation,
            },
          }));
        }
      } else if (jTx.type === 'mint' || jTx.type === 'debtEnforcement') {
        // These are deliberately not consensus settlement commands:
        // - mint is a local-dev/testnet admin utility and is unavailable on
        //   production chains;
        // - enforceDebts is permissionless monotonic queue maintenance. Every
        //   monetary contract path enforces debt too, so this call is only a
        //   liveness hint and repeating it can only advance valid FIFO debt.
        // Submit both after WAL, but never replay them as durable financial
        // intents. New JTx kinds must choose an explicit durable design rather
        // than silently entering this maintenance lane.
        maintenanceTxs.push(jTx);
      } else if (jTx.data.runtimeSubmitAttempt) {
        durableTxs.push(jTx);
      } else {
        const signerId = normalizeJSubmitId(jTx.data.signerId);
        if (!signerId) throw new Error(`J_SUBMIT_INTENT_SIGNER_MISSING:${jTx.entityId}`);
        const batchGeneration = Number(jTx.data.batchGeneration);
        if (!Number.isSafeInteger(batchGeneration) || batchGeneration <= 0) {
          throw new Error(`J_SUBMIT_INTENT_BATCH_GENERATION_INVALID:${String(jTx.data.batchGeneration)}`);
        }
        retries.push(markLocalJSubmitRuntimeTx({
          type: 'retryJSubmit',
          data: {
            entityId: jTx.entityId,
            signerId,
            jurisdictionName: input.jurisdictionName,
            batchHash: String(jTx.data.batchHash || ''),
            entityNonce: Number(jTx.data.entityNonce),
            batchGeneration,
            ...(jTx.data.feeOverrides ? { feeOverrides: { ...jTx.data.feeOverrides } } : {}),
          },
        }));
      }
    }
    if (maintenanceTxs.length > 0) maintenance.push({ jurisdictionName: input.jurisdictionName, jTxs: maintenanceTxs });
    if (durableTxs.length > 0) durable.push({ jurisdictionName: input.jurisdictionName, jTxs: durableTxs });
  }
  return { maintenance, durable, retries };
};
