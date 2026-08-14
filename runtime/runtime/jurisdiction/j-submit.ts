import { normalizeSubmitId } from '../command/submit-identity';
import type { EntityInput } from '../../entity/types';
import type { RuntimeReplica, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/machine/input';
import type { JAdapterFailure, JReplica, JTx } from '../../types/jurisdiction-runtime';
import type { JAdapter, JSubmitResult } from '../../jurisdiction/adapter/types';
import { getLocalSignerPrivateKey } from '../../account/crypto';
import { isBatchEmpty } from '../../jurisdiction/machine/batch';
import { indexReserveUpdatedEvents } from '../../jurisdiction/machine/events/event-evidence';
import { classifyJAdapterFailure } from '../../jurisdiction/adapter/core/failure';
import { ensureLiveJAdapterForReplica } from '../infra';
import { getLiveJAdapter } from './live-jadapters';
import { createStructuredLogger, shortId } from '../../infra/logger';
import {
  findJSubmitReplica,
  isMatchingJSubmitBatch,
  makeJSubmitResultRuntimeTx,
} from './j-submit-state';
import {
  findEntityProviderActionReplica,
  isEntityProviderActionJTx,
  requireCanonicalEntityProviderActionAttempt,
  type ActionJTx,
} from '../registration/entity-provider-action-submit-state';
import { makeEntityProviderActionResultRuntimeTx } from '../registration/entity-provider-action-submit-result';
import { isEntityActiveLeader } from '../../entity/consensus/leader';
import { requireRuntimeMempool } from '../input-pipeline/input-queue';

const jSubmitLog = createStructuredLogger('runtime.jsubmit');

export type RuntimeJOutboxQueue = (
  env: RuntimeReplica,
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
) => void;

export type RuntimeJSubmitDeps = {
  enqueueRuntimeInputs: RuntimeJOutboxQueue;
};

// Empty prefix attestations prove only chain liveness. They contain no event
// body, cannot advance an Entity nonce, and therefore must not starve a sealed
// submit while the watcher keeps extending an otherwise empty chain. A prefix
// with blocks is different: applying those authenticated events may retire the
// sealed nonce, so external I/O must wait for that deterministic frame.
const hasSemanticJHistoryTx = (input: EntityInput): boolean =>
  (input.entityTxs ?? []).some((tx) => tx?.type === 'j_event') ||
  [...(input.jPrefixAttestations?.values() ?? [])].some(
    (attestation) => attestation.blocks.length > 0,
  );

const captureQueuedEntityInputs = (env: RuntimeReplica): EntityInput[] => {
  const mempool = requireRuntimeMempool(env);
  return Array.isArray(mempool?.entityInputs) ? [...mempool.entityInputs] : [];
};

const prioritizeJEventsQueuedAfterSubmit = (env: RuntimeReplica, beforePoll: EntityInput[]): number => {
  const mempool = requireRuntimeMempool(env);
  if (!Array.isArray(mempool.entityInputs)) return 0;
  const current = mempool.entityInputs;
  if (current.length <= beforePoll.length) return 0;

  const newlyQueued = current.slice(beforePoll.length);
  const newlyQueuedJEvents = newlyQueued.filter(hasSemanticJHistoryTx);
  if (newlyQueuedJEvents.length === 0) return 0;

  const newlyQueuedOtherInputs = newlyQueued.filter((input) => !hasSemanticJHistoryTx(input));
  // Chain receipts caused by the just-submitted J batch must be visible before
  // same-entity local follow-ups already queued for the next R-frame. Otherwise
  // a follow-up such as j_broadcast can observe a stale sentBatch latch and
  // fail even though the chain transaction has already finalized.
  mempool.entityInputs = [...newlyQueuedJEvents, ...beforePoll, ...newlyQueuedOtherInputs];
  env.runtimeMempool = mempool;
  return newlyQueuedJEvents.length;
};

const pollSubmittedJEventsBeforeFollowups = async (env: RuntimeReplica, jAdapter: { pollNow?: () => Promise<void> }): Promise<void> => {
  if (typeof jAdapter.pollNow !== 'function') return;
  const beforePoll = captureQueuedEntityInputs(env);
  await jAdapter.pollNow();
  const prioritized = prioritizeJEventsQueuedAfterSubmit(env, beforePoll);
  if (prioritized > 0) {
    jSubmitLog.debug('j_event.prioritized', { prioritized });
  }
};

const awaitAuthenticatedJEventsBeforeSubmit = async (
  env: RuntimeReplica,
  jAdapter: { pollNow?: () => Promise<void> },
): Promise<number> => {
  const alreadyQueued = captureQueuedEntityInputs(env).filter(hasSemanticJHistoryTx).length;
  if (alreadyQueued > 0) return alreadyQueued;
  if (typeof jAdapter.pollNow !== 'function') return 0;
  const beforePoll = captureQueuedEntityInputs(env);
  await jAdapter.pollNow();
  return prioritizeJEventsQueuedAfterSubmit(env, beforePoll);
};

const normalizedEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();

const validateSealedBatchJTx = (jTx: JTx): void => {
  if (jTx.type !== 'batch') return;
  if (isBatchEmpty(jTx.data.batch)) return;
  const missing: string[] = [];
  if (!jTx.data.encodedBatch) missing.push('encodedBatch');
  if (typeof jTx.data.entityNonce !== 'number') missing.push('entityNonce');
  if (!jTx.data.hankoSignature) missing.push('hankoSignature');
  if (missing.length === 0) return;
  throw new Error(
    `J_SUBMIT_FATAL: J_BATCH_CONSENSUS_HANKO_MISSING:${jTx.entityId}:missing=${missing.join(',')}`,
  );
};

const validateDurableEntityProviderAction = (jurisdictionName: string, jTx: JTx): void => {
  if (!isEntityProviderActionJTx(jTx)) return;
  if (!jTx.data.runtimeSubmitAttempt) {
    throw new Error(`ENTITY_PROVIDER_ACTION_UNDURABLE_SUBMIT_REJECTED:${jTx.entityId}`);
  }
  if (!jTx.data.hankoSignature) {
    throw new Error(`ENTITY_PROVIDER_ACTION_CONSENSUS_HANKO_MISSING:${jTx.entityId}`);
  }
  requireCanonicalEntityProviderActionAttempt(jurisdictionName, jTx);
};

export const isTransientJSubmitFailure = (error: unknown): boolean => {
  return classifyJAdapterFailure(error).category === 'transient';
};

const queueBatchResult = (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  jTx: Extract<JTx, { type: 'batch' }>,
  outcome: Extract<RuntimeTx, { type: 'recordJSubmitResult' }>['data']['outcome'],
  extra: { message?: string; txHash?: string; adapterFailure?: JAdapterFailure } = {},
): void => {
  const resultTx = makeJSubmitResultRuntimeTx(jTx, jurisdictionName, outcome, extra);
  deps.enqueueRuntimeInputs(env, undefined, [resultTx], undefined, env.state.timestamp);
  jSubmitLog.info('tx.result_queued', {
    entityId: shortId(jTx.entityId),
    jurisdictionName,
    attemptId: resultTx.data.attemptId,
    outcome,
  });
};

const queueEntityProviderActionResult = (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  jTx: ActionJTx,
  outcome: Extract<RuntimeTx, { type: 'recordEntityProviderActionSubmitResult' }>['data']['outcome'],
  extra: { message?: string; txHash?: string; adapterFailure?: JAdapterFailure } = {},
): void => {
  const resultTx = makeEntityProviderActionResultRuntimeTx(jTx, jurisdictionName, outcome, extra);
  deps.enqueueRuntimeInputs(env, undefined, [resultTx], undefined, env.state.timestamp);
  jSubmitLog.info('entity_provider_action.result_queued', {
    entityId: shortId(jTx.entityId),
    jurisdictionName,
    attemptId: resultTx.data.attemptId,
    outcome,
  });
};

const shouldSubmitFromThisRuntime = (env: RuntimeReplica, jTx: JTx): boolean => {
  if (jTx.type !== 'batch' && !isEntityProviderActionJTx(jTx)) return true;
  const signerId = typeof jTx.data?.signerId === 'string' ? jTx.data.signerId.toLowerCase() : '';
  const runtimeId = typeof env.runtimeId === 'string' ? env.runtimeId.toLowerCase() : '';
  if (!signerId || !runtimeId) return true;
  if (signerId === runtimeId) return true;
  if (getLocalSignerPrivateKey(env, signerId)) return true;
  jSubmitLog.warn('sealed_batch.non_local_skipped', {
    entityId: shortId(jTx.entityId),
    signer: shortId(signerId, 8),
    runtime: shortId(runtimeId, 8),
  });
  return false;
};

const reconcileDurablyStaleEntityProviderAction = (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  jTx: JTx,
): boolean => {
  if (!isEntityProviderActionJTx(jTx) || !jTx.data.runtimeSubmitAttempt) return false;
  const replica = findEntityProviderActionReplica(env, jTx.entityId, jTx.data.signerId);
  if (!replica) {
    throw new Error(`ENTITY_PROVIDER_ACTION_LOCAL_REPLICA_MISSING:${jTx.entityId}:${jTx.data.signerId}`);
  }
  const pending = replica.state.entityProviderActionState?.pending;
  if (
    pending &&
    isEntityActiveLeader(replica) &&
    normalizeSubmitId(pending.actionHash) === normalizeSubmitId(jTx.data.intent.actionHash) &&
    pending.actionNonce === jTx.data.intent.actionNonce &&
    pending.generation === jTx.data.intent.generation
  ) return false;
  queueEntityProviderActionResult(env, deps, jurisdictionName, jTx, 'reconciled', {
    message: pending ? 'entity-provider-action-leader-changed-before-submit' : 'entity-provider-action-finalized-before-submit',
  });
  return true;
};

const reconcileDurablyAbortedBatch = (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  jTx: JTx,
): boolean => {
  if (jTx.type !== 'batch' || !jTx.data.runtimeSubmitAttempt) return false;
  const signerId = normalizedEntityId(jTx.data.signerId);
  const replica = findJSubmitReplica(env, jTx.entityId, signerId);
  if (!replica) {
    throw new Error(`J_SUBMIT_FATAL: LOCAL_REPLICA_MISSING:${jTx.entityId}:${signerId}`);
  }
  const sent = replica.state.jBatchState?.sentBatch;
  if (
    sent &&
    !sent.terminalFailure &&
    isMatchingJSubmitBatch(sent, String(jTx.data.batchHash || ''), Number(jTx.data.entityNonce)) &&
    replica.state.jBatchState?.broadcastCount === jTx.data.runtimeSubmitAttempt.batchGeneration
  ) {
    return false;
  }

  // The Entity abort/rebuild or finalized nonce-collision quarantine is already
  // durable while this exact external attempt was paused. Its absence or
  // terminal marker is the authoritative tombstone: submitting the stale
  // payload after restore would resurrect an operator-aborted/impossible batch.
  queueBatchResult(env, deps, jurisdictionName, jTx, 'reconciled', {
    message: 'committed-batch-cancelled-before-submit',
  });
  // This is a successful idempotent recovery outcome: the durable abort is
  // already authoritative and the stale external attempt is tombstoned.
  // Keep it observable without classifying a healthy recovery as a warning.
  jSubmitLog.info('sealed_batch.durable_abort_reconciled', {
    entityId: shortId(jTx.entityId),
    jurisdictionName,
    attemptId: jTx.data.runtimeSubmitAttempt.attemptId,
  });
  return true;
};

/**
 * Result recording is part of the next Runtime frame, never an in-memory
 * mutation of Entity state. This is the durable bridge between external J I/O
 * and deterministic RJEA execution.
 */
const queueKnownFailure = (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  jTx: JTx,
  failure: JAdapterFailure,
): boolean => {
  const outcome = failure.category === 'transient' ? 'transientFailure' : 'terminalFailure';
  const extra = { message: failure.message, adapterFailure: failure };
  if (jTx.type === 'batch') {
    queueBatchResult(env, deps, jurisdictionName, jTx, outcome, extra);
    return true;
  }
  if (isEntityProviderActionJTx(jTx)) {
    queueEntityProviderActionResult(env, deps, jurisdictionName, jTx, outcome, extra);
    return true;
  }
  return false;
};

const collectActiveJTxs = (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jInput: JInput,
): JTx[] =>
  jInput.jTxs.filter(jTx =>
    !reconcileDurablyAbortedBatch(env, deps, jInput.jurisdictionName, jTx) &&
    !reconcileDurablyStaleEntityProviderAction(env, deps, jInput.jurisdictionName, jTx));

const queueUnavailableAdapterResults = (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  jTxs: JTx[],
  failure: JAdapterFailure,
): void => {
  for (const jTx of jTxs) {
    if (!queueKnownFailure(env, deps, jurisdictionName, jTx, failure)) {
      throw new Error(`J_SUBMIT_FATAL: ${failure.message}`);
    }
  }
};

const resolveJSubmitAdapter = async (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  activeJTxs: JTx[],
): Promise<{ adapter: JAdapter; replica: JReplica } | null> => {
  const replica = env.state.jReplicas?.get(jurisdictionName);
  if (!replica) {
    const failure = classifyJAdapterFailure(`missing_jReplica:${jurisdictionName}`, {
      category: 'transient',
      code: 'J_SUBMIT_MISSING_JREPLICA',
    });
    queueUnavailableAdapterResults(env, deps, jurisdictionName, activeJTxs, failure);
    return null;
  }

  let adapter = getLiveJAdapter(env, jurisdictionName) ?? null;
  try {
    adapter ??= await ensureLiveJAdapterForReplica(env, jurisdictionName, {
      allowBrowserVm: typeof window !== 'undefined',
      context: `j-submit:${jurisdictionName}`,
    });
  } catch (error) {
    const failure = classifyJAdapterFailure(error);
    for (const jTx of activeJTxs) {
      if (!queueKnownFailure(env, deps, jurisdictionName, jTx, failure)) throw error;
    }
    return null;
  }
  if (adapter) return { adapter, replica };

  const failure = classifyJAdapterFailure(`missing_jAdapter:${jurisdictionName}`, {
    category: 'transient',
    code: 'J_SUBMIT_MISSING_JADAPTER',
  });
  queueUnavailableAdapterResults(env, deps, jurisdictionName, activeJTxs, failure);
  return null;
};

const deferSealedAttemptsForAuthenticatedEvents = (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  activeJTxs: JTx[],
  authenticatedJInputs: number,
): JTx[] => {
  if (authenticatedJInputs === 0) return activeJTxs;
  for (const jTx of activeJTxs) {
    if (jTx.type === 'batch') {
      queueBatchResult(env, deps, jurisdictionName, jTx, 'eventBarrier', {
        message: 'authenticated-j-events-before-submit',
      });
    } else if (isEntityProviderActionJTx(jTx)) {
      queueEntityProviderActionResult(env, deps, jurisdictionName, jTx, 'transientFailure', {
        message: 'authenticated-j-events-before-submit',
      });
    }
  }
  jSubmitLog.info('outbox.deferred_for_j_events', {
    jurisdictionName,
    authenticatedJInputs,
  });
  return activeJTxs.filter(jTx => jTx.type !== 'batch' && !isEntityProviderActionJTx(jTx));
};

const validateSubmitAttempt = (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  jTx: JTx,
): boolean => {
  try {
    validateSealedBatchJTx(jTx);
    validateDurableEntityProviderAction(jurisdictionName, jTx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jTx.type === 'batch') {
      queueBatchResult(env, deps, jurisdictionName, jTx, 'terminalFailure', { message });
      return false;
    }
    if (isEntityProviderActionJTx(jTx) && jTx.data.runtimeSubmitAttempt) {
      queueEntityProviderActionResult(env, deps, jurisdictionName, jTx, 'terminalFailure', { message });
      return false;
    }
    throw error;
  }

  if (shouldSubmitFromThisRuntime(env, jTx)) return true;
  if (jTx.type === 'batch') {
    queueBatchResult(env, deps, jurisdictionName, jTx, 'terminalFailure', {
      message: 'sealed_batch_non_local_submitter',
    });
  } else if (isEntityProviderActionJTx(jTx)) {
    queueEntityProviderActionResult(env, deps, jurisdictionName, jTx, 'terminalFailure', {
      message: 'entity_provider_action_non_local_submitter',
    });
  }
  return false;
};

const submitJTxToAdapter = async (
  env: RuntimeReplica,
  adapter: JAdapter,
  jTx: JTx,
): Promise<JSubmitResult> => {
  const submitData = jTx.data as { signerId?: unknown } | undefined;
  const signerId = typeof submitData?.signerId === 'string' ? submitData.signerId : undefined;
  const signerPrivateKey = signerId ? getLocalSignerPrivateKey(env, signerId) : null;
  return adapter.submitTx(jTx, {
    env,
    ...(signerId ? { signerId } : {}),
    ...(signerPrivateKey ? { signerPrivateKey } : {}),
    timestamp: jTx.timestamp ?? env.state.timestamp,
  });
};

const recordSuccessfulSubmit = async (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  adapter: JAdapter,
  jTx: JTx,
  result: JSubmitResult,
): Promise<void> => {
  indexReserveUpdatedEvents(env, result.events);
  jSubmitLog.debug('tx.submit_ok', {
    type: jTx.type,
    entityId: shortId(jTx.entityId),
    jurisdictionName,
    events: result.events?.length ?? 0,
    txHash: result.txHash ?? null,
  });
  await pollSubmittedJEventsBeforeFollowups(env, adapter);
  const extra = result.txHash ? { txHash: result.txHash } : {};
  if (jTx.type === 'batch') {
    queueBatchResult(env, deps, jurisdictionName, jTx, 'submitted', extra);
  } else if (isEntityProviderActionJTx(jTx)) {
    queueEntityProviderActionResult(env, deps, jurisdictionName, jTx, 'submitted', extra);
  }
};

const recordFailedSubmit = async (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  adapter: JAdapter,
  jTx: JTx,
  result: JSubmitResult,
): Promise<void> => {
  if (jTx.type === 'batch') {
    const authenticatedJInputs = await awaitAuthenticatedJEventsBeforeSubmit(env, adapter);
    if (authenticatedJInputs > 0) {
      queueBatchResult(env, deps, jurisdictionName, jTx, 'eventBarrier', {
        message: 'authenticated-j-events-after-submit-failure',
      });
      jSubmitLog.info('tx.failure_deferred_for_j_events', {
        entityId: shortId(jTx.entityId),
        jurisdictionName,
        authenticatedJInputs,
      });
      return;
    }
  }
  const message = result.error || 'unknown';
  const failure = result.failure ?? classifyJAdapterFailure(message);
  const fields = {
    type: jTx.type,
    entityId: shortId(jTx.entityId),
    jurisdictionName,
    error: message,
  };
  if (failure.code === 'STALE_FINALIZATION_AWAITING_FINALITY') {
    jSubmitLog.info('tx.competing_finalization_awaiting_finality', fields);
  } else if (failure.code === 'DISPUTE_FINALIZATION_AWAITING_CHAIN_TIME') {
    jSubmitLog.info('tx.dispute_finalization_awaiting_chain_time', fields);
  } else {
    jSubmitLog.error('tx.submit_failed', fields);
  }
  if (queueKnownFailure(env, deps, jurisdictionName, jTx, failure)) return;
  if (failure.category === 'transient') throw new Error(`J_SUBMIT_TRANSIENT: ${message}`);
  throw new Error(`J_SUBMIT_FATAL: ${message}`);
};

const submitOneJTx = async (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  adapter: JAdapter,
  jTx: JTx,
): Promise<void> => {
  jSubmitLog.debug('tx.submit_start', {
    type: jTx.type,
    entityId: shortId(jTx.entityId),
    jurisdictionName,
  });
  if (!validateSubmitAttempt(env, deps, jurisdictionName, jTx)) return;

  let result: JSubmitResult;
  try {
    result = await submitJTxToAdapter(env, adapter, jTx);
  } catch (error) {
    const failure = classifyJAdapterFailure(error);
    jSubmitLog.error('tx.submit_threw', {
      type: jTx.type,
      entityId: shortId(jTx.entityId),
      jurisdictionName,
      error: failure.message,
    });
    if (queueKnownFailure(env, deps, jurisdictionName, jTx, failure)) return;
    if (failure.category === 'transient') {
      throw new Error(`J_SUBMIT_TRANSIENT: ${failure.message}`);
    }
    throw error;
  }

  if (result.success) {
    await recordSuccessfulSubmit(env, deps, jurisdictionName, adapter, jTx, result);
  } else {
    await recordFailedSubmit(env, deps, jurisdictionName, adapter, jTx, result);
  }
};

const submitJInput = async (
  env: RuntimeReplica,
  deps: RuntimeJSubmitDeps,
  jInput: JInput,
): Promise<void> => {
  const activeJTxs = collectActiveJTxs(env, deps, jInput);
  if (activeJTxs.length === 0) return;
  const context = await resolveJSubmitAdapter(
    env,
    deps,
    jInput.jurisdictionName,
    activeJTxs,
  );
  if (!context) return;

  const authenticatedJInputs = await awaitAuthenticatedJEventsBeforeSubmit(env, context.adapter);
  const submitJTxs = deferSealedAttemptsForAuthenticatedEvents(
    env,
    deps,
    jInput.jurisdictionName,
    activeJTxs,
    authenticatedJInputs,
  );
  for (const jTx of submitJTxs) {
    await submitOneJTx(env, deps, jInput.jurisdictionName, context.adapter, jTx);
  }

  // Submission does not own the watcher cursor. The authoritative J-height
  // path is watcher poll -> processEventBatch.
  context.replica.lastBlockTimestamp = env.state.timestamp;
};

/**
 * Submit post-commit J batches after the R-frame is durable.
 *
 * This is deliberately outside Entity consensus. Every batch attempt was
 * committed by retryJSubmit before this function runs; every result is queued
 * as recordJSubmitResult so restart/replay cannot lose failure classification.
 */
export async function submitRuntimeJOutbox(
  env: RuntimeReplica,
  jOutbox: JInput[],
  deps: RuntimeJSubmitDeps,
): Promise<void> {
  if (jOutbox.length === 0) return;
  const totalJTxs = jOutbox.reduce((count, input) => count + input.jTxs.length, 0);
  jSubmitLog.debug('outbox.submit_start', { jTxs: totalJTxs, jInputs: jOutbox.length });
  for (const jInput of jOutbox) await submitJInput(env, deps, jInput);
}
