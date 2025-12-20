/**
 * Mint Reserves Handler
 *
 * SAME FLOW AS R2R: adds mint operation to jBatch, broadcasts via j_broadcast
 * Pattern: E-machine tx accumulates ops → jBroadcast tx commits batch → J-machine executes
 *
 * Flow:
 * 1. Entity validates (optional)
 * 2. Add mint operation to jBatch
 * 3. User sends j_broadcast
 * 4. J-machine executes → BrowserVM mints
 * 5. J-events route back
 */

import type { EntityState, EntityTx, EntityInput } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { initJBatch } from '../../j-batch';

export async function handleMintReserves(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'mintReserves' }>
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs?: any[] }> {
  const { tokenId, amount } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  console.log(`💰 mintReserves: ${entityState.entityId.slice(-4)} adding ${amount} token ${tokenId} to jBatch`);

  // Initialize jBatch on first use
  if (!newState.jBatchState) {
    newState.jBatchState = initJBatch();
  }

  // Add mint to jBatch (same pattern as R2R)
  // Note: JBatch.reserveToReserve uses "receivingEntity" field name
  const mintOp = {
    receivingEntity: entityState.entityId,
    tokenId,
    amount,
  };

  console.log(`📦 jBatch: Adding mint:`, mintOp);
  newState.jBatchState.batch.reserveToReserve.push(mintOp);
  console.log(`📦 jBatch: After push, array length: ${newState.jBatchState.batch.reserveToReserve.length}`);

  addMessage(newState,
    `📦 Queued Mint: ${amount} token ${tokenId} (use jBroadcast to commit)`
  );

  console.log(`✅ mintReserves: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Token: ${tokenId}, Amount: ${amount}`);

  return { newState, outputs };
}
