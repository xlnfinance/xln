import { keccak256, toUtf8Bytes } from 'ethers';

import { ENTITY_J_SUBMIT_RETRY_MS } from '../../entity/consensus/leader';
import { normalizeSubmitId, truncateSubmitFailureMessage } from '../command/submit-identity';
import { safeStringify } from '../../protocol/serialization';
import type { JInput } from '../../jurisdiction/machine/input';
import type { JAdapterFailure, JTx } from '../../types/jurisdiction-runtime';
import type { RuntimeReplica, RuntimeTx } from '../types';

export type GovernanceJTx = Extract<JTx, { type: 'entityProviderProposeControlBoard' }>;
type GovernanceResultTx = Extract<RuntimeTx, { type: 'recordGovernanceJSubmitResult' }>;

const LOCAL_GOVERNANCE_RESULT = Symbol.for('xln.runtime.governance-submit-result.local');

export const isGovernanceJTx = (jTx: JTx): jTx is GovernanceJTx =>
  jTx.type === 'entityProviderProposeControlBoard';

const unsignedGovernancePayload = (jTx: GovernanceJTx) => ({
  type: jTx.type,
  entityId: jTx.entityId,
  data: {
    targetEntityId: jTx.data.targetEntityId,
    newBoardHash: jTx.data.newBoardHash,
    boardEpoch: jTx.data.boardEpoch,
    actionNonce: jTx.data.actionNonce,
    proposalHash: jTx.data.proposalHash,
    supporterVotes: jTx.data.supporterVotes,
    signerId: jTx.data.signerId,
  },
  timestamp: jTx.timestamp,
});

const governancePayloadHash = (jTx: GovernanceJTx): string =>
  keccak256(toUtf8Bytes(safeStringify(unsignedGovernancePayload(jTx)))).toLowerCase();

const buildGovernanceAttemptId = (identity: {
  jurisdictionName: string;
  entityId: string;
  signerId: string;
  proposalHash: string;
  payloadHash: string;
  attemptNumber: number;
}): string => {
  const normalized = {
    domain: 'xln/governance-j-submit-attempt/v1',
    jurisdictionName: normalizeSubmitId(identity.jurisdictionName),
    entityId: normalizeSubmitId(identity.entityId),
    signerId: normalizeSubmitId(identity.signerId),
    proposalHash: normalizeSubmitId(identity.proposalHash),
    payloadHash: normalizeSubmitId(identity.payloadHash),
    attemptNumber: identity.attemptNumber,
  };
  if (!normalized.jurisdictionName) throw new Error('GOVERNANCE_SUBMIT_JURISDICTION_MISSING');
  if (!normalized.entityId) throw new Error('GOVERNANCE_SUBMIT_ENTITY_MISSING');
  if (!normalized.signerId) throw new Error('GOVERNANCE_SUBMIT_SIGNER_MISSING');
  if (!/^0x[0-9a-f]{64}$/.test(normalized.proposalHash)) {
    throw new Error('GOVERNANCE_SUBMIT_PROPOSAL_HASH_INVALID');
  }
  if (!/^0x[0-9a-f]{64}$/.test(normalized.payloadHash)) {
    throw new Error('GOVERNANCE_SUBMIT_PAYLOAD_HASH_INVALID');
  }
  if (!Number.isSafeInteger(normalized.attemptNumber) || normalized.attemptNumber <= 0) {
    throw new Error('GOVERNANCE_SUBMIT_ATTEMPT_NUMBER_INVALID');
  }
  return keccak256(toUtf8Bytes(safeStringify(normalized))).toLowerCase();
};

const attemptIdentity = (jurisdictionName: string, jTx: GovernanceJTx) => {
  const signerId = normalizeSubmitId(jTx.data.signerId);
  if (!signerId) throw new Error('GOVERNANCE_SUBMIT_SIGNER_MISSING');
  return {
    jurisdictionName,
    entityId: jTx.entityId,
    signerId,
    proposalHash: jTx.data.proposalHash,
    payloadHash: governancePayloadHash(jTx),
  };
};

export const materializeInitialGovernanceAttempt = (
  jurisdictionName: string,
  jTx: GovernanceJTx,
): GovernanceJTx => {
  if (jTx.data.runtimeSubmitAttempt) {
    requireCanonicalGovernanceAttempt(jurisdictionName, jTx);
    return jTx;
  }
  const identity = attemptIdentity(jurisdictionName, jTx);
  return {
    ...jTx,
    data: {
      ...jTx.data,
      runtimeSubmitAttempt: {
        attemptId: buildGovernanceAttemptId({ ...identity, attemptNumber: 1 }),
        attemptNumber: 1,
        attemptedAt: jTx.timestamp,
        eligibleAt: jTx.timestamp,
      },
    },
  };
};

export const requireCanonicalGovernanceAttempt = (
  jurisdictionName: string,
  jTx: GovernanceJTx,
): NonNullable<GovernanceJTx['data']['runtimeSubmitAttempt']> => {
  const attempt = jTx.data.runtimeSubmitAttempt;
  if (!attempt) throw new Error('GOVERNANCE_SUBMIT_ATTEMPT_MISSING');
  if (
    !Number.isSafeInteger(attempt.attemptedAt) || attempt.attemptedAt < 0 ||
    !Number.isSafeInteger(attempt.eligibleAt) || attempt.eligibleAt < attempt.attemptedAt
  ) throw new Error('GOVERNANCE_SUBMIT_ATTEMPT_TIME_INVALID');
  const expected = buildGovernanceAttemptId({
    ...attemptIdentity(jurisdictionName, jTx),
    attemptNumber: attempt.attemptNumber,
  });
  if (attempt.attemptId !== expected) {
    throw new Error(`GOVERNANCE_SUBMIT_ATTEMPT_ID_MISMATCH:${attempt.attemptId}:${expected}`);
  }
  return attempt;
};

export const governanceAttemptIsDue = (jTx: GovernanceJTx, now: number): boolean =>
  Boolean(jTx.data.runtimeSubmitAttempt && jTx.data.runtimeSubmitAttempt.eligibleAt <= now);

export const getNextGovernanceSubmitTimestamp = (env: RuntimeReplica): number | null => {
  let next = Infinity;
  for (const input of env.infrastructure?.pendingCommittedJOutbox ?? []) {
    for (const jTx of input.jTxs) {
      if (!isGovernanceJTx(jTx)) continue;
      const attempt = requireCanonicalGovernanceAttempt(input.jurisdictionName, jTx);
      next = Math.min(next, attempt.eligibleAt);
    }
  }
  return Number.isFinite(next) ? next : null;
};

export const hasReadyCommittedJOutbox = (env: RuntimeReplica, now: number): boolean => {
  for (const input of env.infrastructure?.pendingCommittedJOutbox ?? []) {
    for (const jTx of input.jTxs) {
      if (!isGovernanceJTx(jTx) || governanceAttemptIsDue(jTx, now)) return true;
    }
  }
  return false;
};

export const makeGovernanceSubmitResultRuntimeTx = (
  jurisdictionName: string,
  jTx: GovernanceJTx,
  outcome: GovernanceResultTx['data']['outcome'],
  extra: { message?: string; adapterFailure?: JAdapterFailure; txHash?: string } = {},
): GovernanceResultTx => {
  const attempt = requireCanonicalGovernanceAttempt(jurisdictionName, jTx);
  const identity = attemptIdentity(jurisdictionName, jTx);
  const message = extra.message ? truncateSubmitFailureMessage(extra.message) : undefined;
  const adapterFailure = extra.adapterFailure ? {
    ...structuredClone(extra.adapterFailure),
    message: truncateSubmitFailureMessage(extra.adapterFailure.message),
  } : undefined;
  return markLocalGovernanceResultRuntimeTx({
    type: 'recordGovernanceJSubmitResult',
    data: {
      ...identity,
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

const findPending = (
  env: RuntimeReplica,
  data: GovernanceResultTx['data'],
): { input: JInput; jTx: GovernanceJTx } | null => {
  const matches: Array<{ input: JInput; jTx: GovernanceJTx }> = [];
  for (const input of env.infrastructure?.pendingCommittedJOutbox ?? []) {
    for (const jTx of input.jTxs) {
      if (!isGovernanceJTx(jTx)) continue;
      if (jTx.data.runtimeSubmitAttempt?.attemptId === data.attemptId) matches.push({ input, jTx });
    }
  }
  if (matches.length > 1) throw new Error(`GOVERNANCE_SUBMIT_ATTEMPT_DUPLICATED:${data.attemptId}`);
  return matches[0] ?? null;
};

const removePending = (env: RuntimeReplica, attemptId: string): void => {
  const pending = env.infrastructure?.pendingCommittedJOutbox ?? [];
  const remaining = pending.flatMap((input) => {
    const jTxs = input.jTxs.filter((jTx) => !(
      isGovernanceJTx(jTx) && jTx.data.runtimeSubmitAttempt?.attemptId === attemptId
    ));
    return jTxs.length > 0 ? [{ jurisdictionName: input.jurisdictionName, jTxs }] : [];
  });
  if (env.infrastructure) env.infrastructure.pendingCommittedJOutbox = remaining;
};

export const applyGovernanceSubmitResultRuntimeTx = (
  env: RuntimeReplica,
  tx: GovernanceResultTx,
): void => {
  const pending = findPending(env, tx.data);
  if (!pending) throw new Error(`GOVERNANCE_SUBMIT_RESULT_ATTEMPT_MISSING:${tx.data.attemptId}`);
  const attempt = requireCanonicalGovernanceAttempt(pending.input.jurisdictionName, pending.jTx);
  const identity = attemptIdentity(pending.input.jurisdictionName, pending.jTx);
  if (
    normalizeSubmitId(tx.data.jurisdictionName) !== normalizeSubmitId(identity.jurisdictionName) ||
    normalizeSubmitId(tx.data.entityId) !== normalizeSubmitId(identity.entityId) ||
    normalizeSubmitId(tx.data.signerId) !== normalizeSubmitId(identity.signerId) ||
    normalizeSubmitId(tx.data.proposalHash) !== normalizeSubmitId(identity.proposalHash) ||
    normalizeSubmitId(tx.data.payloadHash) !== normalizeSubmitId(identity.payloadHash) ||
    tx.data.attemptNumber !== attempt.attemptNumber ||
    tx.data.attemptedAt !== attempt.attemptedAt
  ) throw new Error(`GOVERNANCE_SUBMIT_RESULT_IDENTITY_MISMATCH:${tx.data.attemptId}`);
  if (tx.data.outcome !== 'transientFailure') {
    removePending(env, tx.data.attemptId);
    return;
  }
  const nextAttemptNumber = attempt.attemptNumber + 1;
  if (!Number.isSafeInteger(nextAttemptNumber)) throw new Error('GOVERNANCE_SUBMIT_ATTEMPT_EXHAUSTED');
  const nextAttemptedAt = env.state.timestamp;
  pending.jTx.data.runtimeSubmitAttempt = {
    attemptId: buildGovernanceAttemptId({ ...identity, attemptNumber: nextAttemptNumber }),
    attemptNumber: nextAttemptNumber,
    attemptedAt: nextAttemptedAt,
    eligibleAt: nextAttemptedAt + ENTITY_J_SUBMIT_RETRY_MS,
  };
};

export const markLocalGovernanceResultRuntimeTx = <T extends GovernanceResultTx>(tx: T): T => {
  Object.defineProperty(tx, LOCAL_GOVERNANCE_RESULT, { value: true, enumerable: false });
  return tx;
};

export const copyLocalGovernanceResultAuthorization = (source: RuntimeTx, target: RuntimeTx): void => {
  if (
    source.type === 'recordGovernanceJSubmitResult' &&
    target.type === source.type &&
    (source as RuntimeTx & { [LOCAL_GOVERNANCE_RESULT]?: boolean })[LOCAL_GOVERNANCE_RESULT]
  ) markLocalGovernanceResultRuntimeTx(target);
};

export const markRestoredGovernanceResultRuntimeTxs = (runtimeTxs: RuntimeTx[]): void => {
  for (const tx of runtimeTxs) {
    if (tx.type === 'recordGovernanceJSubmitResult') markLocalGovernanceResultRuntimeTx(tx);
  }
};

export const assertGovernanceResultRuntimeTxAuthorized = (tx: RuntimeTx, replay: boolean): void => {
  if (tx.type !== 'recordGovernanceJSubmitResult') return;
  if (
    replay ||
    (tx as RuntimeTx & { [LOCAL_GOVERNANCE_RESULT]?: boolean })[LOCAL_GOVERNANCE_RESULT]
  ) return;
  throw new Error('GOVERNANCE_SUBMIT_RESULT_EXTERNAL_INGRESS_REJECTED');
};
