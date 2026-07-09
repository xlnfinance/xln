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

import type { EntityState, EntityTx, EntityInput, JInput } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { initJBatch, batchAddSettlement } from '../../j-batch';
import { isLeftEntity } from '../../entity-id-utils';
import { createStructuredLogger, shortId } from '../../logger';

const jBatchActionLog = createStructuredLogger('entity.jbatch');

export async function handleCreateSettlement(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'createSettlement' }>
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs?: JInput[] }> {
  const { counterpartyEntityId, diffs, sig } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  jBatchActionLog.debug('settlement.create', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyEntityId),
    diffs: diffs.length,
  });

  // Initialize jBatch on first use
  if (!newState.jBatchState) {
    newState.jBatchState = initJBatch();
  }

  // Determine canonical left/right order
  const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);
  const leftEntity = isLeft ? entityState.entityId : counterpartyEntityId;
  const rightEntity = isLeft ? counterpartyEntityId : entityState.entityId;

  if (!sig || sig === '0x') {
    throw new Error(`Settlement ${entityState.entityId.slice(-4)}↔${counterpartyEntityId.slice(-4)} missing hanko signature`);
  }

  // Add settlement to jBatch
  batchAddSettlement(
    newState.jBatchState,
    leftEntity,
    rightEntity,
    diffs,
    [],    // forgiveDebtsInTokenIds
    sig,   // hanko signature
    undefined, // entityProvider (use default)
    '0x',  // hankoData
    0,     // nonce
    entityState.entityId // initiatorEntity
  );

  jBatchActionLog.debug('settlement.queued', {
    entity: shortId(entityState.entityId),
    left: shortId(leftEntity),
    right: shortId(rightEntity),
    diffs: diffs.length,
  });

  addMessage(newState, `⚖️ Settlement created (${diffs.length} diffs) - use jBroadcast to commit`);

  return { newState, outputs };
}
