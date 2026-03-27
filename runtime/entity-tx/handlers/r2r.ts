/**
 * Reserve-to-Reserve Handler
 *
 * Entity moves reserves to another entity (accumulates in jBatch for atomic broadcast)
 * Pattern: E-machine tx accumulates ops → jBroadcast tx commits batch → J-machine executes
 *
 * Flow:
 * 1. Entity validates sufficient reserve
 * 2. Add R→R operation to jBatch
 * 3. User reviews batch via UI
 * 4. jBroadcast tx commits batch to J-machine
 */

import type { EntityState, EntityTx, EntityInput } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { initJBatch, batchAddReserveToReserve, getEffectiveDraftReserveBalance } from '../../j-batch';

export async function handleR2R(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'r2r' }>
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { toEntityId, tokenId, amount } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  // Validate: Do we have enough reserve?
  const currentReserve = getEffectiveDraftReserveBalance(
    entityState.entityId,
    entityState.reserves.get(tokenId) || 0n,
    entityState.jBatchState?.batch,
    tokenId,
  );
  if (currentReserve < amount) {
    const msg = `❌ Insufficient reserve: have ${currentReserve}, need ${amount} token ${tokenId}`;
    addMessage(newState, msg);
    console.error(`❌ R2R FAILED: ${entityState.entityId.slice(-4)} ${msg}`);
    throw new Error(msg);
  }

  // Initialize jBatch on first use
  if (!newState.jBatchState) {
    newState.jBatchState = initJBatch();
  }

  // Add to jBatch (will be broadcast via j_broadcast tx)
  batchAddReserveToReserve(
    newState.jBatchState,
    toEntityId,
    tokenId,
    amount
  );

  addMessage(newState,
    `📦 Queued R→R: ${amount} token ${tokenId} to ${toEntityId.slice(-4)} (use jBroadcast to commit)`
  );

  console.log(`✅ r2r: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   To: ${toEntityId.slice(-4)}, Token: ${tokenId}, Amount: ${amount}`);

  return { newState, outputs };
}
