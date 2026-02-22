import type { EntityInput, EntityState, EntityTx, Env, JInput } from '../../types';
import { addMessage, cloneEntityState } from '../../state-helpers';
import { createEmptyBatch, getBatchSize, mergeBatchOps } from '../../j-batch';

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

  if (requeue) {
    if (!newState.jBatchState.batch) {
      newState.jBatchState.batch = createEmptyBatch();
    }
    mergeBatchOps(newState.jBatchState.batch, sent.batch);
  }

  newState.jBatchState.sentBatch = undefined;
  newState.jBatchState.status = getBatchSize(newState.jBatchState.batch) > 0 ? 'accumulating' : 'empty';

  // Release stale "submitted" latches if operator aborts the in-flight batch.
  for (const account of newState.accounts.values()) {
    if (!account.requestedRebalanceFeeState) continue;
    for (const feeState of account.requestedRebalanceFeeState.values()) {
      if ((feeState.jBatchSubmittedAt || 0) > 0) {
        feeState.jBatchSubmittedAt = 0;
      }
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
