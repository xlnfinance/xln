/**
 * J-Clear-Batch Handler
 *
 * Manually clears the entity's pending jBatch.
 * Use when: batch rejected by J-machine, want to build fresh batch,
 * or abandoning pending operations.
 *
 * NOTE: This does NOT affect settlement workspaces - those must be
 * rejected/cleared separately if the settlement is no longer valid.
 */

import type { EntityState, EntityTx, EntityInput, Env, JInput } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { createEmptyBatch, getBatchSize } from '../../j-batch';

export async function handleJClearBatch(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_clear_batch' }>,
  _env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs: JInput[] }> {
  const { reason } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  if (!newState.jBatchState) {
    addMessage(newState, `⚠️ No jBatchState to clear`);
    return { newState, outputs, jOutputs };
  }

  const oldBatchSize = getBatchSize(newState.jBatchState.batch);
  const wasPending = newState.jBatchState.pendingBroadcast;
  let resetSubmittedMarkers = 0;

  // Clear the batch and reset lifecycle
  newState.jBatchState.batch = createEmptyBatch();
  newState.jBatchState.pendingBroadcast = false;
  newState.jBatchState.status = 'empty';
  newState.jBatchState.batchHash = undefined;
  newState.jBatchState.encodedBatch = undefined;
  newState.jBatchState.broadcastedAt = undefined;
  newState.jBatchState.txHash = undefined;

  // Manual recovery: release stale "submitted" latches so hub can retry requests.
  for (const account of newState.accounts.values()) {
    if (!account.requestedRebalanceFeeState) continue;
    for (const feeState of account.requestedRebalanceFeeState.values()) {
      if ((feeState.jBatchSubmittedAt || 0) > 0) {
        feeState.jBatchSubmittedAt = 0;
        resetSubmittedMarkers++;
      }
    }
  }

  const reasonMsg = reason ? ` (${reason})` : '';
  const pendingMsg = wasPending ? ' [was pending]' : '';
  const resetMsg = resetSubmittedMarkers > 0 ? `; reset ${resetSubmittedMarkers} submitted rebalance marker(s)` : '';
  console.log(`🗑️ j_clear_batch: Cleared ${oldBatchSize} operations${reasonMsg}${pendingMsg}${resetMsg}`);
  addMessage(newState, `🗑️ Cleared jBatch (${oldBatchSize} ops)${reasonMsg}${pendingMsg}${resetMsg}`);

  return { newState, outputs, jOutputs };
}
