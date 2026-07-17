import { keccak256, toUtf8Bytes } from 'ethers';

import { getLocalSignerPrivateKey } from '../account/crypto';
import { isEntityActiveLeader, ENTITY_J_SUBMIT_FALLBACK_MS } from '../entity/consensus/leader';
import {
  assertEntityProviderActionIntent,
  recomputeEntityProviderActionHash,
} from '../entity/entity-provider-action';
import { requireUsableContractAddress } from '../jurisdiction/contract-address';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from '../jurisdiction/board-registry';
import {
  getJurisdictionConfigName,
  requireRuntimeJurisdictionConfigByName,
} from '../jurisdiction/jurisdiction-runtime';
import { safeStringify } from '../protocol/serialization';
import type { EntityReplica, Env, JInput, JTx, RuntimeTx } from '../types';

type RetryActionTx = Extract<RuntimeTx, { type: 'retryEntityProviderAction' }>;
export type ActionJTx =
  | Extract<JTx, { type: 'entityProviderTransfer' }>
  | Extract<JTx, { type: 'entityProviderReleaseControlShares' }>
  | Extract<JTx, { type: 'entityProviderCancelAction' }>;

export const isEntityProviderActionJTx = (jTx: JTx): jTx is ActionJTx =>
  jTx.type === 'entityProviderTransfer' ||
  jTx.type === 'entityProviderReleaseControlShares' ||
  jTx.type === 'entityProviderCancelAction';

const MAX_UINT256 = (1n << 256n) - 1n;

export const normalizeEntityProviderActionId = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

export const MAX_ENTITY_PROVIDER_ACTION_FAILURE_MESSAGE_CHARS = 4_096;

export const truncateEntityProviderActionFailureMessage = (value: unknown): string => {
  const message = String(value ?? 'unknown');
  if (message.length <= MAX_ENTITY_PROVIDER_ACTION_FAILURE_MESSAGE_CHARS) return message;
  const suffix = `...[truncated:${message.length}]`;
  return message.slice(0, MAX_ENTITY_PROVIDER_ACTION_FAILURE_MESSAGE_CHARS - suffix.length) + suffix;
};

export type EntityProviderActionAttemptIdentity = {
  jurisdictionName: string;
  entityId: string;
  signerId: string;
  actionHash: string;
  actionNonce: bigint;
  generation: number;
  attemptNumber: number;
};

export const buildEntityProviderActionAttemptId = (
  identity: EntityProviderActionAttemptIdentity,
): string => {
  const jurisdictionName = normalizeEntityProviderActionId(identity.jurisdictionName);
  const entityId = normalizeEntityProviderActionId(identity.entityId);
  const signerId = normalizeEntityProviderActionId(identity.signerId);
  const actionHash = normalizeEntityProviderActionId(identity.actionHash);
  if (!jurisdictionName) throw new Error('ENTITY_PROVIDER_ACTION_ATTEMPT_JURISDICTION_MISSING');
  if (!entityId) throw new Error('ENTITY_PROVIDER_ACTION_ATTEMPT_ENTITY_MISSING');
  if (!signerId) throw new Error('ENTITY_PROVIDER_ACTION_ATTEMPT_SIGNER_MISSING');
  if (!/^0x[0-9a-f]{64}$/.test(actionHash)) {
    throw new Error(`ENTITY_PROVIDER_ACTION_ATTEMPT_HASH_INVALID:${actionHash || 'missing'}`);
  }
  if (identity.actionNonce <= 0n || identity.actionNonce > MAX_UINT256) {
    throw new Error('ENTITY_PROVIDER_ACTION_ATTEMPT_NONCE_INVALID');
  }
  if (!Number.isSafeInteger(identity.generation) || identity.generation <= 0) {
    throw new Error(`ENTITY_PROVIDER_ACTION_ATTEMPT_GENERATION_INVALID:${identity.generation}`);
  }
  if (!Number.isSafeInteger(identity.attemptNumber) || identity.attemptNumber <= 0) {
    throw new Error(`ENTITY_PROVIDER_ACTION_ATTEMPT_NUMBER_INVALID:${identity.attemptNumber}`);
  }
  return keccak256(toUtf8Bytes(safeStringify({
    domain: 'xln/entity-provider-action-submit-attempt/v1',
    jurisdictionName,
    entityId,
    signerId,
    actionHash,
    actionNonce: identity.actionNonce,
    generation: identity.generation,
    attemptNumber: identity.attemptNumber,
  }))).toLowerCase();
};

export const requireCanonicalEntityProviderActionAttempt = (
  jurisdictionName: string,
  jTx: ActionJTx,
): NonNullable<ActionJTx['data']['runtimeSubmitAttempt']> => {
  const attempt = jTx.data.runtimeSubmitAttempt;
  if (!attempt) throw new Error('ENTITY_PROVIDER_ACTION_PENDING_ATTEMPT_METADATA_MISSING');
  const intent = jTx.data.intent;
  const expectedKind = jTx.type === 'entityProviderTransfer'
    ? 'entityTransferTokens'
    : jTx.type === 'entityProviderReleaseControlShares'
      ? 'releaseControlShares'
      : 'cancelPendingAction';
  if (intent.payload.kind !== expectedKind) {
    throw new Error(`ENTITY_PROVIDER_ACTION_JTX_KIND_MISMATCH:${jTx.type}:${intent.payload.kind}`);
  }
  if (
    normalizeEntityProviderActionId(jTx.entityId) !== normalizeEntityProviderActionId(intent.entityId) ||
    intent.actionHash.toLowerCase() !== recomputeEntityProviderActionHash(intent) ||
    attempt.generation !== intent.generation ||
    attempt.attemptedAt < 0 ||
    !Number.isSafeInteger(attempt.attemptedAt)
  ) throw new Error('ENTITY_PROVIDER_ACTION_PENDING_ATTEMPT_INVALID');
  const expected = buildEntityProviderActionAttemptId({
    jurisdictionName,
    entityId: jTx.entityId,
    signerId: jTx.data.signerId,
    actionHash: intent.actionHash,
    actionNonce: intent.actionNonce,
    generation: intent.generation,
    attemptNumber: attempt.attemptNumber,
  });
  if (attempt.attemptId !== expected) {
    throw new Error(`ENTITY_PROVIDER_ACTION_PENDING_ATTEMPT_ID_MISMATCH:${attempt.attemptId}:${expected}`);
  }
  return attempt;
};

export const findEntityProviderActionReplica = (
  env: Env,
  entityId: string,
  signerId: string,
): EntityReplica | null => {
  const entity = normalizeEntityProviderActionId(entityId);
  const signer = normalizeEntityProviderActionId(signerId);
  for (const replica of env.eReplicas.values()) {
    if (
      normalizeEntityProviderActionId(replica.entityId) === entity &&
      normalizeEntityProviderActionId(replica.signerId) === signer
    ) return replica;
  }
  return null;
};

export const actionAttemptMatchesIdentity = (
  jurisdictionName: string,
  jTx: JTx,
  identity: Omit<EntityProviderActionAttemptIdentity, 'attemptNumber'>,
): boolean => Boolean(
  isEntityProviderActionJTx(jTx) &&
  normalizeEntityProviderActionId(jurisdictionName) === normalizeEntityProviderActionId(identity.jurisdictionName) &&
  normalizeEntityProviderActionId(jTx.entityId) === normalizeEntityProviderActionId(identity.entityId) &&
  normalizeEntityProviderActionId(jTx.data.signerId) === normalizeEntityProviderActionId(identity.signerId) &&
  normalizeEntityProviderActionId(jTx.data.intent.actionHash) === normalizeEntityProviderActionId(identity.actionHash) &&
  jTx.data.intent.actionNonce === identity.actionNonce &&
  jTx.data.intent.generation === identity.generation
);

export const hasPendingCommittedEntityProviderAction = (
  env: Env,
  identity: Omit<EntityProviderActionAttemptIdentity, 'attemptNumber'>,
): boolean => (env.runtimeState?.pendingCommittedJOutbox ?? []).some((input) =>
  input.jTxs.some((jTx) => actionAttemptMatchesIdentity(input.jurisdictionName, jTx, identity)));

const requireTrustedPending = (env: Env, replica: EntityReplica) => {
  const pending = replica.state.entityProviderActionState?.pending;
  if (!pending) throw new Error(`ENTITY_PROVIDER_ACTION_PENDING_MISSING:${replica.entityId}`);
  const configuredName = getJurisdictionConfigName(replica.state.config.jurisdiction);
  if (!configuredName) throw new Error('ENTITY_PROVIDER_ACTION_JURISDICTION_MISSING');
  const jurisdiction = requireRuntimeJurisdictionConfigByName(
    env,
    configuredName,
    replica.state.config.jurisdiction,
  );
  const chainId = Number(jurisdiction.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`ENTITY_PROVIDER_ACTION_CHAIN_ID_INVALID:${String(jurisdiction.chainId)}`);
  }
  const certifiedBoard = resolveObserverCertifiedBoardRecord(
    replica.state,
    getCertifiedBoardNodeStore(env),
    replica.entityId,
  );
  if (!certifiedBoard) {
    throw new Error(`ENTITY_PROVIDER_ACTION_CERTIFIED_BOARD_MISSING:${replica.entityId}`);
  }
  if (pending.boardEpoch !== BigInt(certifiedBoard.boardEpoch)) {
    throw new Error(
      `ENTITY_PROVIDER_ACTION_PENDING_BOARD_EPOCH_STALE:` +
      `${pending.boardEpoch.toString()}:${certifiedBoard.boardEpoch}`,
    );
  }
  assertEntityProviderActionIntent(pending, {
    chainId,
    entityProviderAddress: requireUsableContractAddress('entity_provider', jurisdiction.entityProviderAddress),
    depositoryAddress: requireUsableContractAddress('depository', jurisdiction.depositoryAddress),
    entityId: replica.entityId,
    boardEpoch: certifiedBoard.boardEpoch,
  });
  return { pending, jurisdictionName: jurisdiction.name };
};

export const getMatchingEntityProviderActionSubmitState = (replica: EntityReplica) => {
  const pending = replica.state.entityProviderActionState?.pending;
  const local = replica.entityProviderActionSubmitState;
  if (
    !pending ||
    !local ||
    normalizeEntityProviderActionId(local.actionHash) !== normalizeEntityProviderActionId(pending.actionHash) ||
    local.actionNonce !== pending.actionNonce ||
    local.generation !== pending.generation
  ) return null;
  return local;
};

export const applyRetryEntityProviderActionRuntimeTx = (
  env: Env,
  tx: RetryActionTx,
): JInput[] => {
  const replica = findEntityProviderActionReplica(env, tx.data.entityId, tx.data.signerId);
  if (!replica) throw new Error(`ENTITY_PROVIDER_ACTION_LOCAL_REPLICA_MISSING:${tx.data.entityId}:${tx.data.signerId}`);
  if (!isEntityActiveLeader(replica)) throw new Error(`ENTITY_PROVIDER_ACTION_NOT_ACTIVE_LEADER:${tx.data.signerId}`);
  const { pending, jurisdictionName } = requireTrustedPending(env, replica);
  if (
    normalizeEntityProviderActionId(jurisdictionName) !== normalizeEntityProviderActionId(tx.data.jurisdictionName) ||
    normalizeEntityProviderActionId(pending.actionHash) !== normalizeEntityProviderActionId(tx.data.actionHash) ||
    pending.actionNonce !== tx.data.actionNonce ||
    pending.generation !== tx.data.generation
  ) throw new Error(`ENTITY_PROVIDER_ACTION_COMMITTED_INTENT_MISMATCH:${tx.data.entityId}`);
  const identity = {
    jurisdictionName,
    entityId: replica.entityId,
    signerId: replica.signerId,
    actionHash: pending.actionHash,
    actionNonce: pending.actionNonce,
    generation: pending.generation,
  };
  if (hasPendingCommittedEntityProviderAction(env, identity)) return [];
  const previous = getMatchingEntityProviderActionSubmitState(replica);
  if (previous?.terminalFailure) return [];
  if (
    previous &&
    previous.submitAttempts > 0 &&
    env.timestamp < previous.lastSubmittedAt + ENTITY_J_SUBMIT_FALLBACK_MS
  ) return [];
  const witness = replica.hankoWitness?.get(pending.actionHash);
  if (!witness || witness.type !== 'entityProviderAction') {
    throw new Error(`ENTITY_PROVIDER_ACTION_HANKO_WITNESS_MISSING:${replica.entityId}:${pending.actionHash}`);
  }
  const attemptNumber = (previous?.submitAttempts ?? 0) + 1;
  if (!Number.isSafeInteger(attemptNumber)) {
    throw new Error('ENTITY_PROVIDER_ACTION_ATTEMPT_NUMBER_EXHAUSTED');
  }
  const attemptId = buildEntityProviderActionAttemptId({ ...identity, attemptNumber });
  const attemptedAt = env.timestamp;
  replica.entityProviderActionSubmitState = {
    jurisdictionName,
    actionHash: pending.actionHash,
    actionNonce: pending.actionNonce,
    generation: pending.generation,
    submitAttempts: attemptNumber,
    lastSubmittedAt: attemptedAt,
    ...(previous?.txHash ? { txHash: previous.txHash } : {}),
    ...(previous?.lastFailure ? { lastFailure: structuredClone(previous.lastFailure) } : {}),
    ...(previous?.terminalFailure ? { terminalFailure: structuredClone(previous.terminalFailure) } : {}),
    ...(previous?.lastResultAttemptId ? { lastResultAttemptId: previous.lastResultAttemptId } : {}),
    ...(previous?.lastResultAt !== undefined ? { lastResultAt: previous.lastResultAt } : {}),
    ...(previous?.lastResultOutcome ? { lastResultOutcome: previous.lastResultOutcome } : {}),
    ...(previous?.lastResultFingerprint ? { lastResultFingerprint: previous.lastResultFingerprint } : {}),
    ...(previous?.resultFingerprints ? { resultFingerprints: { ...previous.resultFingerprints } } : {}),
    ...(previous?.resultFingerprintOrder ? { resultFingerprintOrder: [...previous.resultFingerprintOrder] } : {}),
  };
  const jTx: ActionJTx = {
    type: pending.payload.kind === 'entityTransferTokens'
      ? 'entityProviderTransfer'
      : pending.payload.kind === 'releaseControlShares'
        ? 'entityProviderReleaseControlShares'
        : 'entityProviderCancelAction',
    entityId: replica.entityId,
    data: {
      intent: structuredClone(pending),
      signerId: replica.signerId,
      hankoSignature: witness.hanko,
      runtimeSubmitAttempt: {
        attemptId,
        attemptNumber,
        attemptedAt,
        generation: pending.generation,
      },
    },
    timestamp: attemptedAt,
  } as ActionJTx;
  return [{ jurisdictionName, jTxs: [jTx] }];
};

export const canSubmitEntityProviderActionLocally = (env: Env, signerId: string): boolean => {
  const signer = normalizeEntityProviderActionId(signerId);
  return signer === normalizeEntityProviderActionId(env.runtimeId) || Boolean(getLocalSignerPrivateKey(env, signer));
};
