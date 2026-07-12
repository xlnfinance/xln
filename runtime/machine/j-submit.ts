import type { EntityInput, Env, JInput, JTx, RuntimeTx } from '../types';
import { getCachedSignerPrivateKey } from '../account/crypto';
import { isBatchEmpty } from '../jurisdiction/batch';
import { rememberRecentJEvents } from '../jurisdiction/event-evidence';
import { getEntityReplicaById } from '../orchestrator/mesh-common';
import { ensureLiveJAdapterForReplica } from './infra';
import { classifyRuntimeJBatchFailure } from '../protocol/failure-taxonomy';
import { createStructuredLogger, shortId } from '../infra/logger';

const jSubmitLog = createStructuredLogger('runtime.jsubmit');

export type RuntimeJOutboxQueue = (
  env: Env,
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
) => void;

export type RuntimeJSubmitDeps = {
  enqueueRuntimeInputs: RuntimeJOutboxQueue;
};

const hasJEventTx = (input: EntityInput): boolean =>
  (input.entityTxs ?? []).some((tx) => tx?.type === 'j_event');

const captureQueuedEntityInputs = (env: Env): EntityInput[] => {
  const mempool = env.runtimeMempool ?? env.runtimeInput;
  return Array.isArray(mempool?.entityInputs) ? [...mempool.entityInputs] : [];
};

const prioritizeJEventsQueuedAfterSubmit = (env: Env, beforePoll: EntityInput[]): number => {
  const mempool = env.runtimeMempool ?? env.runtimeInput;
  if (!mempool || !Array.isArray(mempool.entityInputs)) return 0;
  const current = mempool.entityInputs;
  if (current.length <= beforePoll.length) return 0;

  const newlyQueued = current.slice(beforePoll.length);
  const newlyQueuedJEvents = newlyQueued.filter(hasJEventTx);
  if (newlyQueuedJEvents.length === 0) return 0;

  const newlyQueuedOtherInputs = newlyQueued.filter((input) => !hasJEventTx(input));
  // Chain receipts caused by the just-submitted J batch must be visible before
  // same-entity local follow-ups already queued for the next R-frame. Otherwise
  // a follow-up such as j_broadcast can observe a stale sentBatch latch and
  // fail even though the chain transaction has already finalized.
  mempool.entityInputs = [...newlyQueuedJEvents, ...beforePoll, ...newlyQueuedOtherInputs];
  env.runtimeMempool = mempool;
  env.runtimeInput = mempool;
  return newlyQueuedJEvents.length;
};

const pollSubmittedJEventsBeforeFollowups = async (env: Env, jAdapter: { pollNow?: () => Promise<void> }): Promise<void> => {
  if (typeof jAdapter.pollNow !== 'function') return;
  const beforePoll = captureQueuedEntityInputs(env);
  await jAdapter.pollNow();
  const prioritized = prioritizeJEventsQueuedAfterSubmit(env, beforePoll);
  if (prioritized > 0) {
    jSubmitLog.debug('j_event.prioritized', { prioritized });
  }
};

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

export const isTransientJSubmitFailure = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error
    ? String((error as Error & { code?: unknown }).code || '')
    : '';
  return [
    code,
    message,
  ].some((value) => (
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND/i.test(value) ||
    /transaction was not mined|timeout exceeded|request timeout|gateway timeout|503|504|rate limit/i.test(value)
  ));
};

const markSentBatchTerminalFailure = (env: Env, jTx: JTx, message: string): void => {
  if (jTx.type !== 'batch') return;
  const replica = getEntityReplicaById(env, jTx.entityId);
  const jBatchState = replica?.state?.jBatchState;
  const sentBatch = jBatchState?.sentBatch;
  if (!sentBatch) return;
  const submittedNonce = typeof jTx.data?.entityNonce === 'number' ? jTx.data.entityNonce : null;
  const submittedHash = String(jTx.data?.batchHash || '');
  if (submittedNonce !== null && Number(sentBatch.entityNonce) !== submittedNonce) return;
  if (submittedHash && sentBatch.batchHash && submittedHash !== sentBatch.batchHash) return;
  const failure = classifyRuntimeJBatchFailure('J_SUBMIT_FATAL', message);
  sentBatch.terminalFailure = {
    message,
    failedAt: env.timestamp,
    failure,
  };
  sentBatch.lastFailure = {
    message,
    failedAt: env.timestamp,
    failure,
  };
  jBatchState.status = 'failed';
  jBatchState.failedAttempts = (jBatchState.failedAttempts || 0) + 1;
};

const markSentBatchTransientFailure = (env: Env, jTx: JTx, message: string): void => {
  if (jTx.type !== 'batch') return;
  const replica = getEntityReplicaById(env, jTx.entityId);
  const jBatchState = replica?.state?.jBatchState;
  const sentBatch = jBatchState?.sentBatch;
  if (!jBatchState || !sentBatch) return;
  sentBatch.lastFailure = {
    message,
    failedAt: env.timestamp,
    failure: classifyRuntimeJBatchFailure('J_SUBMIT_TRANSIENT', message),
  };
  jBatchState.failedAttempts = (jBatchState.failedAttempts || 0) + 1;
  jBatchState.status = 'sent';
};

const markSentBatchStaleNonceSkipped = (env: Env, jTx: JTx, chainNonce: bigint): boolean => {
  if (jTx.type !== 'batch') return false;
  const replica = getEntityReplicaById(env, jTx.entityId);
  const jBatchState = replica?.state?.jBatchState;
  const sentBatch = jBatchState?.sentBatch;
  if (!jBatchState || !sentBatch) return false;
  const submittedNonce = typeof jTx.data?.entityNonce === 'number' ? jTx.data.entityNonce : null;
  const submittedHash = String(jTx.data?.batchHash || '');
  if (submittedNonce === null) return false;
  if (Number(sentBatch.entityNonce) !== submittedNonce) return false;
  if (submittedHash && sentBatch.batchHash && submittedHash !== sentBatch.batchHash) return false;

  jBatchState.entityNonce = Math.max(Number(jBatchState.entityNonce || 0), Number(chainNonce));
  delete jBatchState.sentBatch;
  jBatchState.status = isBatchEmpty(jBatchState.batch) ? 'empty' : 'accumulating';
  return true;
};

const skipAlreadyConsumedSealedBatch = async (
  env: Env,
  jAdapter: { getEntityNonce?: (entityId: string) => Promise<bigint> },
  jTx: JTx,
): Promise<boolean> => {
  if (jTx.type !== 'batch') return false;
  if (typeof jTx.data?.entityNonce !== 'number') return false;
  if (typeof jAdapter.getEntityNonce !== 'function') return false;
  let chainNonce: bigint;
  try {
    chainNonce = await jAdapter.getEntityNonce(jTx.entityId);
  } catch (error) {
    jSubmitLog.warn('nonce_preflight.unavailable', {
      entityId: shortId(jTx.entityId),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  const submittedNonce = BigInt(jTx.data.entityNonce);
  if (chainNonce < submittedNonce) return false;
  const skipped = markSentBatchStaleNonceSkipped(env, jTx, chainNonce);
  jSubmitLog.warn('sealed_batch.stale_skipped', {
    entityId: shortId(jTx.entityId),
    submittedNonce: submittedNonce.toString(),
    chainNonce: chainNonce.toString(),
    clearedSentBatch: skipped,
  });
  return true;
};

const shouldSubmitFromThisRuntime = (env: Env, jTx: JTx): boolean => {
  if (jTx.type !== 'batch') return true;
  const signerId = typeof jTx.data?.signerId === 'string' ? jTx.data.signerId.toLowerCase() : '';
  const runtimeId = typeof env.runtimeId === 'string' ? env.runtimeId.toLowerCase() : '';
  if (!signerId || !runtimeId) return true;
  if (signerId === runtimeId) return true;
  if (getCachedSignerPrivateKey(signerId)) return true;
  jSubmitLog.warn('sealed_batch.non_local_skipped', {
    entityId: shortId(jTx.entityId),
    signer: shortId(signerId, 8),
    runtime: shortId(runtimeId, 8),
  });
  return false;
};

/**
 * Submit post-commit J batches after the R-frame is durable.
 *
 * This is deliberately outside consensus. Permanent/protocol submit failures
 * mark the sent batch terminal before halting. Transient transport failures
 * still halt the current loop with a debug payload, but must not poison the
 * batch: a valid batch remains rebroadcastable after the operator fixes RPC.
 */
export async function submitRuntimeJOutbox(
  env: Env,
  jOutbox: JInput[],
  _deps: RuntimeJSubmitDeps,
): Promise<void> {
  if (jOutbox.length === 0) return;

  const totalJTxs = jOutbox.reduce((n, ji) => n + ji.jTxs.length, 0);
  jSubmitLog.debug('outbox.submit_start', { jTxs: totalJTxs, jInputs: jOutbox.length });

  for (const jInput of jOutbox) {
    const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
    if (!jReplica) {
      throw new Error(`J_SUBMIT_FATAL: missing_jReplica:${jInput.jurisdictionName}`);
    }

    const jAdapter = typeof jReplica.jadapter?.submitTx === 'function'
      ? jReplica.jadapter
      : await ensureLiveJAdapterForReplica(env, jInput.jurisdictionName, {
          allowBrowserVm: typeof window !== 'undefined',
          context: `j-submit:${jInput.jurisdictionName}`,
        });
    if (!jAdapter) {
      throw new Error(`J_SUBMIT_FATAL: missing_jAdapter:${jInput.jurisdictionName}`);
    }

    for (const jTx of jInput.jTxs) {
      jSubmitLog.debug('tx.submit_start', {
        type: jTx.type,
        entityId: shortId(jTx.entityId),
        jurisdictionName: jInput.jurisdictionName,
      });
      validateSealedBatchJTx(jTx);
      if (!shouldSubmitFromThisRuntime(env, jTx)) {
        continue;
      }
      if (await skipAlreadyConsumedSealedBatch(env, jAdapter, jTx)) {
        continue;
      }

      const submitData = jTx.data as { signerId?: unknown } | undefined;
      const submitSignerId = typeof submitData?.signerId === 'string' ? submitData.signerId : undefined;
      const submitSignerPrivateKey = submitSignerId ? getCachedSignerPrivateKey(submitSignerId) : null;
      let result;
      try {
        result = await jAdapter.submitTx(jTx, {
          env,
          ...(submitSignerId ? { signerId: submitSignerId } : {}),
          ...(submitSignerPrivateKey ? { signerPrivateKey: submitSignerPrivateKey } : {}),
          timestamp: jTx.timestamp ?? env.timestamp,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        jSubmitLog.error('tx.submit_threw', {
          type: jTx.type,
          entityId: shortId(jTx.entityId),
          jurisdictionName: jInput.jurisdictionName,
          error: message,
        });
        if (isTransientJSubmitFailure(error)) {
          markSentBatchTransientFailure(env, jTx, message);
          throw new Error(`J_SUBMIT_TRANSIENT: ${message}`);
        }
        markSentBatchTerminalFailure(env, jTx, message);
        throw error;
      }

      if (result.success) {
        rememberRecentJEvents(env, result.events);
        jSubmitLog.debug('tx.submit_ok', {
          type: jTx.type,
          entityId: shortId(jTx.entityId),
          jurisdictionName: jInput.jurisdictionName,
          events: result.events?.length ?? 0,
          txHash: result.txHash ?? null,
        });
        await pollSubmittedJEventsBeforeFollowups(env, jAdapter);
      } else {
        const message = result.error || 'unknown';
        jSubmitLog.error('tx.submit_failed', {
          type: jTx.type,
          entityId: shortId(jTx.entityId),
          jurisdictionName: jInput.jurisdictionName,
          error: message,
        });
        if (isTransientJSubmitFailure(message)) {
          markSentBatchTransientFailure(env, jTx, message);
          throw new Error(`J_SUBMIT_TRANSIENT: ${message}`);
        }
        markSentBatchTerminalFailure(env, jTx, message);
        throw new Error(`J_SUBMIT_FATAL: ${message}`);
      }
    }

    // Submission does not own the watcher cursor.
    // The authoritative J-height path is watcher poll -> processEventBatch.
    jReplica.lastBlockTimestamp = env.timestamp;
  }
}
