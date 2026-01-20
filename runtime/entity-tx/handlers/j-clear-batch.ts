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

  // Clear the batch and unlock for new operations
  newState.jBatchState.batch = createEmptyBatch();
  newState.jBatchState.pendingBroadcast = false;

  const reasonMsg = reason ? ` (${reason})` : '';
  const pendingMsg = wasPending ? ' [was pending]' : '';
  console.log(`🗑️ j_clear_batch: Cleared ${oldBatchSize} operations${reasonMsg}${pendingMsg}`);
  addMessage(newState, `🗑️ Cleared jBatch (${oldBatchSize} ops)${reasonMsg}${pendingMsg}`);

  return { newState, outputs, jOutputs };
}
