import type { EntityInput, EntityState, EntityTx, Env, JInput } from '../../../types';
import { addMessage, cloneEntityState } from '../../../state-helpers';
import { createEmptyBatch, getBatchSize, mergeBatchOps } from '../../../jurisdiction/batch';
import { createStructuredLogger, shortId } from '../../../infra/logger';

const jBatchActionLog = createStructuredLogger('entity.jbatch');

function shouldRequeueDisputeFinalize(_state: EntityState, _counterpartyIdRaw: unknown): boolean {
  // Dispute finality is watcher-authoritative. Do not resurrect disputeFinalize from a
  // local abort path: if finalize really succeeded on-chain, requeueing races the next
  // DisputeFinalized poll and can poison an unrelated mixed batch. If finalize did not
  // succeed, crontab/manual dispute flow will draft a fresh op from current account state.
  return false;
}

export async function handleJAbortSentBatch(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_abort_sent_batch' }>,
  _env: Env,
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs: JInput[] }> {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  if (!newState.jBatchState?.sentBatch) {
    addMessage(newState, '⚠️ No sentBatch to abort');
    return { newState, outputs, jOutputs };
  }

  const sent = newState.jBatchState.sentBatch;
  const requeue = entityTx.data.requeueToCurrent !== false;
  const reason = entityTx.data.reason ? ` (${entityTx.data.reason})` : '';
  const sentSize = getBatchSize(sent.batch);
  const droppedFinalizeCounterparties = new Set<string>();
  if (!requeue) {
    for (const op of sent.batch.disputeFinalizations || []) {
      droppedFinalizeCounterparties.add(String(op.counterentity).toLowerCase());
    }
  }

  if (requeue) {
    if (!newState.jBatchState.batch) {
      newState.jBatchState.batch = createEmptyBatch();
    }
    if (sent.batch.disputeFinalizations?.length) {
      const before = sent.batch.disputeFinalizations.length;
      sent.batch.disputeFinalizations = sent.batch.disputeFinalizations.filter((op) => {
        const keep = shouldRequeueDisputeFinalize(newState, op.counterentity);
        if (!keep) {
          droppedFinalizeCounterparties.add(String(op.counterentity).toLowerCase());
        }
        return keep;
      });
      if (before !== sent.batch.disputeFinalizations.length) {
        jBatchActionLog.debug('abort.filtered_dispute_finalize', {
          entity: shortId(entityState.entityId),
          count: before - sent.batch.disputeFinalizations.length,
        });
      }
    }
    // Drop stale C2R ops whose signed nonce is now <= on-chain nonce (would revert E2).
    if (sent.batch.collateralToReserve?.length) {
      const before = sent.batch.collateralToReserve.length;
      sent.batch.collateralToReserve = sent.batch.collateralToReserve.filter(c2r => {
        const cpId = String(c2r.counterparty).toLowerCase();
        const account = [...newState.accounts.entries()].find(
          ([k]) => k.toLowerCase() === cpId,
        )?.[1];
        const jNonce = account?.jNonce ?? 0;
        if (c2r.nonce <= jNonce) {
          jBatchActionLog.warn('abort.drop_stale_c2r', {
            entity: shortId(entityState.entityId),
            counterparty: shortId(cpId),
            signedNonce: c2r.nonce,
            jNonce,
          });
          // AccountSettled finality is the sole authority that clears the
          // workspace. The stale batch may refer to an older workspace than
          // the account's current one, and deleting here could both erase the
          // newer proposal and strand its exact workspace holds.
          return false;
        }
        return true;
      });
      if (before !== sent.batch.collateralToReserve.length) {
        jBatchActionLog.debug('abort.filtered_c2r', {
          entity: shortId(entityState.entityId),
          count: before - sent.batch.collateralToReserve.length,
        });
      }
    }
    mergeBatchOps(newState.jBatchState.batch, sent.batch);
  }

  delete newState.jBatchState.sentBatch;
  newState.jBatchState.status = getBatchSize(newState.jBatchState.batch) > 0 ? 'accumulating' : 'empty';

  // Release stale "submitted" latches if operator aborts the in-flight batch.
  for (const account of newState.accounts.values()) {
    account.shadow.rebalance.submittedAtByToken.clear();
  }
  if (droppedFinalizeCounterparties.size > 0) {
    for (const [counterpartyId, account] of newState.accounts.entries()) {
      if (!account.activeDispute) continue;
      if (!droppedFinalizeCounterparties.has(counterpartyId.toLowerCase())) continue;
      account.activeDispute.finalizeQueued = false;
    }
  }

  addMessage(
    newState,
    `🛑 Aborted sentBatch nonce=${sent.entityNonce} ops=${sentSize}` +
      (requeue ? ' (requeued to current)' : ' (dropped)') +
      reason,
  );

  return { newState, outputs, jOutputs };
}
