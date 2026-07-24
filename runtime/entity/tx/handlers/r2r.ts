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

import type { EntityState, EntityTx, EntityInput } from '../../../types';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import { initJBatch, batchAddReserveToReserve } from '../../../jurisdiction/batch';
import { createStructuredLogger, shortId } from '../../../infra/logger';
import { getReserveCandidateIssue } from './j-batch-reserve-admission';

const jBatchActionLog = createStructuredLogger('entity.jbatch');

export async function handleR2R(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'r2r' }>
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { toEntityId, tokenId, amount } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  // Validate: Do we have enough reserve?
  const reserveIssue = getReserveCandidateIssue(entityState, {
    type: 'reserveToReserve',
    receivingEntity: toEntityId,
    tokenId,
    amount,
  });
  if (reserveIssue) {
    const msg = `❌ Insufficient spendable reserve: have ${reserveIssue.availableAfterDebt}, need ${amount} token ${tokenId}`;
    addMessage(newState, msg);
    jBatchActionLog.error('r2r.insufficient_reserve', {
      entity: shortId(entityState.entityId),
      tokenId,
      currentReserve: reserveIssue.availableAfterDebt.toString(),
      amount: amount.toString(),
    });
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

  jBatchActionLog.debug('r2r.queued', {
    entity: shortId(entityState.entityId),
    to: shortId(toEntityId),
    tokenId,
    amount: amount.toString(),
  });

  return { newState, outputs };
}
