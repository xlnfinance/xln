/**
 * J-Broadcast Handler
 *
 * Entity broadcasts accumulated jBatch to J-machine with hanko signature
 * Pattern: User reviews accumulated ops → commits batch → J-machine executes atomically
 *
 * Flow:
 * 1. Entity validates batch is non-empty
 * 2. Attach hanko signature (entity seal)
 * 3. Submit batch to J-machine via Depository.processBatch()
 * 4. Clear local jBatch on success
 * 5. J-watcher feeds events back to E-machines
 */

import type { EntityState, EntityTx, EntityInput } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { isBatchEmpty, getBatchSize, broadcastBatch, createEmptyBatch } from '../../j-batch';

export async function handleJBroadcast(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_broadcast' }>
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { hankoSignature } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  // Validate: jBatch exists and is non-empty
  if (!newState.jBatchState || isBatchEmpty(newState.jBatchState.batch)) {
    addMessage(newState, `❌ No operations to broadcast - jBatch is empty`);
    return { newState, outputs };
  }

  // Validate: jurisdiction configured
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction) {
    addMessage(newState, `❌ No jurisdiction configured for this entity`);
    return { newState, outputs };
  }

  const batchSize = getBatchSize(newState.jBatchState.batch);
  console.log(`📤 j_broadcast: Broadcasting batch with ${batchSize} operations`);
  console.log(`   Hanko: ${hankoSignature ? 'provided' : 'none'}`);

  // Store hanko in batch metadata if provided (future: attach to batch for verification)
  if (hankoSignature) {
    console.log(`   Hanko signature: ${hankoSignature.slice(0, 20)}...`);
  }

  // Broadcast to J-machine
  const result = await broadcastBatch(entityState.entityId, newState.jBatchState, jurisdiction);

  if (result.success) {
    addMessage(newState,
      `✅ Batch broadcast success! ${batchSize} ops, tx: ${result.txHash?.slice(0, 12)}...`
    );
    console.log(`✅ j_broadcast: Batch submitted successfully`);
    console.log(`   Tx: ${result.txHash}`);
  } else {
    addMessage(newState,
      `❌ Batch broadcast failed: ${result.error}`
    );
    console.log(`❌ j_broadcast: Batch failed - ${result.error}`);
  }

  return { newState, outputs };
}
