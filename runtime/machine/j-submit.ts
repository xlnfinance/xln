import type { EntityInput, Env, JAdapterFailure, JInput, JTx, RuntimeTx } from '../types';
import { getLocalSignerPrivateKey } from '../account/crypto';
import { isBatchEmpty } from '../jurisdiction/batch';
import { rememberRecentJEvents } from '../jurisdiction/event-evidence';
import { classifyJAdapterFailure } from '../jadapter/failure';
import { ensureLiveJAdapterForReplica } from './infra';
import { createStructuredLogger, shortId } from '../infra/logger';
import {
  findJSubmitReplica,
  isMatchingJSubmitBatch,
  makeJSubmitResultRuntimeTx,
} from './j-submit-state';
import {
  findEntityProviderActionReplica,
  isEntityProviderActionJTx,
  normalizeEntityProviderActionId,
  requireCanonicalEntityProviderActionAttempt,
  type ActionJTx,
} from './entity-provider-action-submit-state';
import { makeEntityProviderActionResultRuntimeTx } from './entity-provider-action-submit-result';
import { isEntityActiveLeader } from '../entity/consensus/leader';

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

const hasJHistoryTx = (input: EntityInput): boolean =>
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
  const newlyQueuedJEvents = newlyQueued.filter(hasJHistoryTx);
  if (newlyQueuedJEvents.length === 0) return 0;

  const newlyQueuedOtherInputs = newlyQueued.filter((input) => !hasJHistoryTx(input));
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

const normalizedEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();

type DisputeFinalizeClaim = { counterparty: string };

const getDisputeFinalizeClaims = (jTx: JTx): DisputeFinalizeClaim[] => {
  if (jTx.type !== 'batch') return [];
  return (jTx.data.batch.disputeFinalizations || []).map((op) => ({
    counterparty: normalizedEntityId(op.counterentity),
  })).filter((claim) => claim.counterparty);
};

type DisputeAccountReader = {
  getAccountInfo?: (
    entityId: string,
    counterpartyId: string,
  ) => Promise<{ disputeHash: string; disputeTimeout: bigint }>;
  hasProcessedBatch?: (
    entityId: string,
    batchHash: string,
    entityNonce: bigint,
  ) => Promise<boolean>;
};

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

const hasStaleDisputeFinalizeOnChain = async (
  jAdapter: DisputeAccountReader,
  entityId: string,
  claims: DisputeFinalizeClaim[],
): Promise<boolean> => {
  if (typeof jAdapter.getAccountInfo !== 'function') return false;
  for (const claim of claims) {
    const account = await jAdapter.getAccountInfo(entityId, claim.counterparty);
    const disputeHash = normalizedEntityId(account.disputeHash);
    if (disputeHash === ZERO_BYTES32 && account.disputeTimeout === 0n) return true;
  }
  return false;
};

const reconcileFinalizedDispute = async (
  env: Env,
  jAdapter: DisputeAccountReader,
  jTx: JTx,
  deps: RuntimeJSubmitDeps,
  reason: 'counterparty-finalized-before-submit' | 'counterparty-finalized-after-submit-failure',
): Promise<boolean> => {
  if (jTx.type !== 'batch') return false;
  const claims = getDisputeFinalizeClaims(jTx);
  if (claims.length === 0) return false;
  const entityId = normalizedEntityId(jTx.entityId);
  try {
    if (!await hasStaleDisputeFinalizeOnChain(jAdapter, entityId, claims)) return false;
  } catch (error) {
    jSubmitLog.warn('dispute_finalize.reconcile_read_failed', {
      entityId: shortId(jTx.entityId),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  const signerId = normalizedEntityId(jTx.data.signerId);
  if (!signerId) throw new Error(`J_SUBMIT_FATAL: STALE_DISPUTE_FINALIZE_SIGNER_MISSING:${jTx.entityId}`);
  deps.enqueueRuntimeInputs(env, [{
    entityId: jTx.entityId,
    signerId,
    entityTxs: [{
      type: 'j_abort_sent_batch',
      data: { reason, requeueToCurrent: true },
    }],
  }], undefined, undefined, env.timestamp);
  jSubmitLog.warn('dispute_finalize.stale_reconciled', {
    entityId: shortId(jTx.entityId),
    counterparties: claims.map(({ counterparty }) => shortId(counterparty)),
    phase: reason,
  });
  return true;
};

const reconcileExactProcessedBatch = async (
  env: Env,
  jAdapter: DisputeAccountReader,
  jTx: JTx,
  deps: RuntimeJSubmitDeps,
): Promise<boolean> => {
  if (
    jTx.type !== 'batch' ||
    typeof jAdapter.hasProcessedBatch !== 'function' ||
    typeof jTx.data.entityNonce !== 'number' ||
    !jTx.data.batchHash
  ) return false;
  const matched = await jAdapter.hasProcessedBatch(
    jTx.entityId,
    jTx.data.batchHash,
    BigInt(jTx.data.entityNonce),
  );
  if (!matched) return false;
  const signerId = normalizedEntityId(jTx.data.signerId);
  if (!signerId) throw new Error(`J_SUBMIT_FATAL: PROCESSED_BATCH_SIGNER_MISSING:${jTx.entityId}`);
  deps.enqueueRuntimeInputs(env, [{
    entityId: jTx.entityId,
    signerId,
    entityTxs: [{
      type: 'j_abort_sent_batch',
      data: { reason: 'exact-onchain-batch-receipt', requeueToCurrent: false },
    }],
  }], undefined, undefined, env.timestamp);
  jSubmitLog.warn('sealed_batch.exact_receipt_reconciled', {
    entityId: shortId(jTx.entityId),
    batchHash: jTx.data.batchHash,
    entityNonce: jTx.data.entityNonce,
  });
  return true;
};

const reconcilePermanentSubmitFailure = async (
  env: Env,
  jAdapter: DisputeAccountReader,
  jTx: JTx,
  deps: RuntimeJSubmitDeps,
): Promise<boolean> => (
  await reconcileExactProcessedBatch(env, jAdapter, jTx, deps) ||
  await reconcileFinalizedDispute(
    env,
    jAdapter,
    jTx,
    deps,
    'counterparty-finalized-after-submit-failure',
  )
);

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
  env: Env,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  jTx: Extract<JTx, { type: 'batch' }>,
  outcome: Extract<RuntimeTx, { type: 'recordJSubmitResult' }>['data']['outcome'],
  extra: { message?: string; txHash?: string; adapterFailure?: JAdapterFailure } = {},
): void => {
  const resultTx = makeJSubmitResultRuntimeTx(jTx, jurisdictionName, outcome, extra);
  deps.enqueueRuntimeInputs(env, undefined, [resultTx], undefined, env.timestamp);
  jSubmitLog.info('tx.result_queued', {
    entityId: shortId(jTx.entityId),
    jurisdictionName,
    attemptId: resultTx.data.attemptId,
    outcome,
  });
};

const queueEntityProviderActionResult = (
  env: Env,
  deps: RuntimeJSubmitDeps,
  jurisdictionName: string,
  jTx: ActionJTx,
  outcome: Extract<RuntimeTx, { type: 'recordEntityProviderActionSubmitResult' }>['data']['outcome'],
  extra: { message?: string; txHash?: string; adapterFailure?: JAdapterFailure } = {},
): void => {
  const resultTx = makeEntityProviderActionResultRuntimeTx(jTx, jurisdictionName, outcome, extra);
  deps.enqueueRuntimeInputs(env, undefined, [resultTx], undefined, env.timestamp);
  jSubmitLog.info('entity_provider_action.result_queued', {
    entityId: shortId(jTx.entityId),
    jurisdictionName,
    attemptId: resultTx.data.attemptId,
    outcome,
  });
};

const shouldSubmitFromThisRuntime = (env: Env, jTx: JTx): boolean => {
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
  env: Env,
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
    normalizeEntityProviderActionId(pending.actionHash) === normalizeEntityProviderActionId(jTx.data.intent.actionHash) &&
    pending.actionNonce === jTx.data.intent.actionNonce &&
    pending.generation === jTx.data.intent.generation
  ) return false;
  queueEntityProviderActionResult(env, deps, jurisdictionName, jTx, 'reconciled', {
    message: pending ? 'entity-provider-action-leader-changed-before-submit' : 'entity-provider-action-finalized-before-submit',
  });
  return true;
};

const reconcileDurablyAbortedBatch = (
  env: Env,
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
  jSubmitLog.warn('sealed_batch.durable_abort_reconciled', {
    entityId: shortId(jTx.entityId),
    jurisdictionName,
    attemptId: jTx.data.runtimeSubmitAttempt.attemptId,
  });
  return true;
};

/**
 * Submit post-commit J batches after the R-frame is durable.
 *
 * This is deliberately outside Entity consensus. Every batch attempt was
 * committed by retryJSubmit before this function runs; every result is queued
 * as recordJSubmitResult so restart/replay cannot lose failure classification.
 */
export async function submitRuntimeJOutbox(
  env: Env,
  jOutbox: JInput[],
  deps: RuntimeJSubmitDeps,
): Promise<void> {
  if (jOutbox.length === 0) return;

  const totalJTxs = jOutbox.reduce((n, ji) => n + ji.jTxs.length, 0);
  jSubmitLog.debug('outbox.submit_start', { jTxs: totalJTxs, jInputs: jOutbox.length });

  for (const jInput of jOutbox) {
    const activeJTxs: JTx[] = [];
    for (const jTx of jInput.jTxs) {
      if (
        !reconcileDurablyAbortedBatch(env, deps, jInput.jurisdictionName, jTx) &&
        !reconcileDurablyStaleEntityProviderAction(env, deps, jInput.jurisdictionName, jTx)
      ) {
        activeJTxs.push(jTx);
      }
    }
    if (activeJTxs.length === 0) continue;

    const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
    if (!jReplica) {
      const message = `missing_jReplica:${jInput.jurisdictionName}`;
      const failure = classifyJAdapterFailure(message, {
        category: 'transient',
        code: 'J_SUBMIT_MISSING_JREPLICA',
      });
      for (const jTx of activeJTxs) {
        if (jTx.type === 'batch') {
          queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'transientFailure', { message, adapterFailure: failure });
        } else if (isEntityProviderActionJTx(jTx)) {
          queueEntityProviderActionResult(env, deps, jInput.jurisdictionName, jTx, 'transientFailure', { message, adapterFailure: failure });
        } else throw new Error(`J_SUBMIT_FATAL: ${message}`);
      }
      continue;
    }

    let jAdapter = typeof jReplica.jadapter?.submitTx === 'function' ? jReplica.jadapter : null;
    try {
      jAdapter ??= await ensureLiveJAdapterForReplica(env, jInput.jurisdictionName, {
        allowBrowserVm: typeof window !== 'undefined',
        context: `j-submit:${jInput.jurisdictionName}`,
      });
    } catch (error) {
      const failure = classifyJAdapterFailure(error);
      const outcome = failure.category === 'transient' ? 'transientFailure' : 'terminalFailure';
      for (const jTx of activeJTxs) {
        if (jTx.type === 'batch') {
          queueBatchResult(env, deps, jInput.jurisdictionName, jTx, outcome, { message: failure.message, adapterFailure: failure });
        } else if (isEntityProviderActionJTx(jTx)) {
          queueEntityProviderActionResult(env, deps, jInput.jurisdictionName, jTx, outcome, { message: failure.message, adapterFailure: failure });
        } else throw error;
      }
      continue;
    }
    if (!jAdapter) {
      const message = `missing_jAdapter:${jInput.jurisdictionName}`;
      const failure = classifyJAdapterFailure(message, {
        category: 'transient',
        code: 'J_SUBMIT_MISSING_JADAPTER',
      });
      for (const jTx of activeJTxs) {
        if (jTx.type === 'batch') {
          queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'transientFailure', { message, adapterFailure: failure });
        } else if (isEntityProviderActionJTx(jTx)) {
          queueEntityProviderActionResult(env, deps, jInput.jurisdictionName, jTx, 'transientFailure', { message, adapterFailure: failure });
        } else throw new Error(`J_SUBMIT_FATAL: ${message}`);
      }
      continue;
    }

    for (const jTx of activeJTxs) {
      jSubmitLog.debug('tx.submit_start', {
        type: jTx.type,
        entityId: shortId(jTx.entityId),
        jurisdictionName: jInput.jurisdictionName,
      });
      try {
        validateSealedBatchJTx(jTx);
        validateDurableEntityProviderAction(jInput.jurisdictionName, jTx);
      } catch (error) {
        if (jTx.type === 'batch') {
          queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'terminalFailure', {
            message: error instanceof Error ? error.message : String(error),
          });
        } else if (isEntityProviderActionJTx(jTx) && jTx.data.runtimeSubmitAttempt) {
          queueEntityProviderActionResult(env, deps, jInput.jurisdictionName, jTx, 'terminalFailure', {
            message: error instanceof Error ? error.message : String(error),
          });
        } else throw error;
        continue;
      }
      if (!shouldSubmitFromThisRuntime(env, jTx)) {
        if (jTx.type === 'batch') {
          queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'terminalFailure', {
            message: 'sealed_batch_non_local_submitter',
          });
        } else if (isEntityProviderActionJTx(jTx)) {
          queueEntityProviderActionResult(env, deps, jInput.jurisdictionName, jTx, 'terminalFailure', {
            message: 'entity_provider_action_non_local_submitter',
          });
        }
        continue;
      }
      if (await reconcileFinalizedDispute(
        env,
        jAdapter,
        jTx,
        deps,
        'counterparty-finalized-before-submit',
      )) {
        if (jTx.type === 'batch') queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'reconciled');
        continue;
      }

      const submitData = jTx.data as { signerId?: unknown } | undefined;
      const submitSignerId = typeof submitData?.signerId === 'string' ? submitData.signerId : undefined;
      const submitSignerPrivateKey = submitSignerId ? getLocalSignerPrivateKey(env, submitSignerId) : null;
      let result;
      try {
        result = await jAdapter.submitTx(jTx, {
          env,
          ...(submitSignerId ? { signerId: submitSignerId } : {}),
          ...(submitSignerPrivateKey ? { signerPrivateKey: submitSignerPrivateKey } : {}),
          timestamp: jTx.timestamp ?? env.timestamp,
        });
      } catch (error) {
        const failure = classifyJAdapterFailure(error);
        const message = failure.message;
        jSubmitLog.error('tx.submit_threw', {
          type: jTx.type,
          entityId: shortId(jTx.entityId),
          jurisdictionName: jInput.jurisdictionName,
          error: message,
        });
        if (failure.category === 'transient') {
          if (jTx.type === 'batch') {
            queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'transientFailure', {
              message,
              adapterFailure: failure,
            });
            continue;
          }
          if (isEntityProviderActionJTx(jTx)) {
            queueEntityProviderActionResult(env, deps, jInput.jurisdictionName, jTx, 'transientFailure', {
              message,
              adapterFailure: failure,
            });
            continue;
          }
          throw new Error(`J_SUBMIT_TRANSIENT: ${message}`);
        }
        if (await reconcilePermanentSubmitFailure(env, jAdapter, jTx, deps)) {
          if (jTx.type === 'batch') queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'reconciled');
          continue;
        }
        if (jTx.type === 'batch') {
          queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'terminalFailure', {
            message,
            adapterFailure: failure,
          });
          continue;
        }
        if (isEntityProviderActionJTx(jTx)) {
          queueEntityProviderActionResult(env, deps, jInput.jurisdictionName, jTx, 'terminalFailure', {
            message,
            adapterFailure: failure,
          });
          continue;
        }
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
        if (jTx.type === 'batch') {
          queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'submitted', {
            ...(result.txHash ? { txHash: result.txHash } : {}),
          });
        } else if (isEntityProviderActionJTx(jTx)) {
          queueEntityProviderActionResult(env, deps, jInput.jurisdictionName, jTx, 'submitted', {
            ...(result.txHash ? { txHash: result.txHash } : {}),
          });
        }
      } else {
        const message = result.error || 'unknown';
        const failure = result.failure ?? classifyJAdapterFailure(message);
        jSubmitLog.error('tx.submit_failed', {
          type: jTx.type,
          entityId: shortId(jTx.entityId),
          jurisdictionName: jInput.jurisdictionName,
          error: message,
        });
        if (failure.category === 'transient') {
          if (jTx.type === 'batch') {
            queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'transientFailure', {
              message,
              adapterFailure: failure,
            });
            continue;
          }
          if (isEntityProviderActionJTx(jTx)) {
            queueEntityProviderActionResult(env, deps, jInput.jurisdictionName, jTx, 'transientFailure', {
              message,
              adapterFailure: failure,
            });
            continue;
          }
          throw new Error(`J_SUBMIT_TRANSIENT: ${message}`);
        }
        if (await reconcilePermanentSubmitFailure(env, jAdapter, jTx, deps)) {
          if (jTx.type === 'batch') queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'reconciled');
          continue;
        }
        if (jTx.type === 'batch') {
          queueBatchResult(env, deps, jInput.jurisdictionName, jTx, 'terminalFailure', {
            message,
            adapterFailure: failure,
          });
          continue;
        }
        if (isEntityProviderActionJTx(jTx)) {
          queueEntityProviderActionResult(env, deps, jInput.jurisdictionName, jTx, 'terminalFailure', {
            message,
            adapterFailure: failure,
          });
          continue;
        }
        throw new Error(`J_SUBMIT_FATAL: ${message}`);
      }
    }

    // Submission does not own the watcher cursor.
    // The authoritative J-height path is watcher poll -> processEventBatch.
    jReplica.lastBlockTimestamp = env.timestamp;
  }
}
