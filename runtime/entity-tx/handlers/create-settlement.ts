/**
 * Create Settlement Handler
 *
 * Adds settlement to entity's jBatch (via proper E-layer flow)
 * Used for: Rebalancing, cooperative closes, dispute resolutions
 *
 * Flow:
 * 1. Entity creates createSettlement EntityTx
 * 2. Handler calls batchAddSettlement (adds to jBatch)
 * 3. Entity sends j_broadcast
 * 4. Settlement executes via J-processor
 */

import type { EntityState, EntityTx, EntityInput } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { initJBatch, batchAddSettlement } from '../../j-batch';

export async function handleCreateSettlement(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'createSettlement' }>
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs?: any[] }> {
  const { counterpartyEntityId, diffs } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  console.log(`⚖️ createSettlement: ${entityState.entityId.slice(-4)} → ${counterpartyEntityId.slice(-4)}`);
  console.log(`   Diffs: ${diffs.length} operations`);

  // Initialize jBatch on first use
  if (!newState.jBatchState) {
    newState.jBatchState = initJBatch();
  }

  // Determine canonical left/right order
  const isLeft = entityState.entityId < counterpartyEntityId;
  const leftEntity = isLeft ? entityState.entityId : counterpartyEntityId;
  const rightEntity = isLeft ? counterpartyEntityId : entityState.entityId;

  // Add settlement to jBatch
  batchAddSettlement(
    newState.jBatchState,
    leftEntity,
    rightEntity,
    diffs
  );

  console.log(`✅ createSettlement: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Settlement: ${leftEntity.slice(-4)} ↔ ${rightEntity.slice(-4)}`);

  addMessage(newState, `⚖️ Settlement created (${diffs.length} diffs) - use jBroadcast to commit`);

  return { newState, outputs };
}
