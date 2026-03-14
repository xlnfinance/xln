/**
 * Reserve-to-external handler
 *
 * Entity withdraws reserve balance to an external EOA address encoded as bytes32.
 * The entity layer stays declarative: it only validates balance and appends the
 * operation into the next J-batch. J-broadcast remains the only on-chain commit path.
 */

import type { EntityInput, EntityState, EntityTx } from '../../types';
import { addMessage, cloneEntityState } from '../../state-helpers';
import { batchAddReserveToExternal, initJBatch } from '../../j-batch';

export async function handleReserveToExternal(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'reserve_to_external' }>,
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { receivingEntity, tokenId, amount } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  const currentReserve = entityState.reserves.get(tokenId) || 0n;
  if (currentReserve < amount) {
    const message = `❌ Insufficient reserve: have ${currentReserve}, need ${amount} token ${tokenId}`;
    addMessage(newState, message);
    throw new Error(message);
  }

  if (!newState.jBatchState) {
    newState.jBatchState = initJBatch();
  }

  batchAddReserveToExternal(newState.jBatchState, receivingEntity, tokenId, amount);
  addMessage(
    newState,
    `📦 Queued R→E: ${amount} token ${tokenId} to ${receivingEntity.slice(-8)} (use jBroadcast to commit)`,
  );

  return { newState, outputs };
}
