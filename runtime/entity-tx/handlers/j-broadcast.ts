/**
 * J-Broadcast Handler (PROPER E→J MEMPOOL FLOW)
 *
 * Entity queues accumulated jBatch to J-machine mempool (does NOT execute immediately)
 * This is the CORRECT flow: E-layer → J-mempool (yellow cube) → J-block execution
 *
 * Flow:
 * 1. Entity validates batch is non-empty
 * 2. Create JTx with batch + hanko signature
 * 3. Queue to J-machine mempool (jReplica.mempool.push)
 * 4. Visual: Yellow cube appears in J-mempool
 * 5. J-machine tick processor executes after blockDelayMs
 * 6. J-watcher feeds events back to E-machines
 */

import type { EntityState, EntityTx, EntityInput, Env, JTx, JInput } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { isBatchEmpty, getBatchSize, createEmptyBatch } from '../../j-batch';

export async function handleJBroadcast(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_broadcast' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs: JInput[] }> {
  const { hankoSignature } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  // Validate: jBatch exists and is non-empty
  if (!newState.jBatchState || isBatchEmpty(newState.jBatchState.batch)) {
    addMessage(newState, `❌ No operations to broadcast - jBatch is empty`);
    return { newState, outputs, jOutputs };
  }

  // Validate: jurisdiction configured
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction) {
    addMessage(newState, `❌ No jurisdiction configured for this entity`);
    return { newState, outputs, jOutputs };
  }

  const batchSize = getBatchSize(newState.jBatchState.batch);
  console.log(`📤 j_broadcast: Queuing batch to J-mempool (${batchSize} operations)`);
  console.log(`   Hanko: ${hankoSignature ? 'provided' : 'none'}`);

  // Find the J-machine for this entity's jurisdiction
  const jurisdictionName = env.activeJurisdiction || 'default';
  console.log(`🔍 j_broadcast: Targeting J-machine "${jurisdictionName}"`);

  // Create JTx (J-machine transaction) with the batch
  // Type is ALWAYS 'batch' - the batch contains r2r, r2c, settlements, etc.
  // Use env.timestamp for determinism (scenarios control time)
  const jTx: JTx = {
    type: 'batch',
    entityId: entityState.entityId,
    data: {
      batch: newState.jBatchState.batch,
      hankoSignature: hankoSignature || undefined,
      batchSize,
    },
    timestamp: env.disableAutoSnapshots ? env.timestamp : Date.now(),
  };

  // PROPER ROUTING: Return jInput to be queued via runtime (like E→E uses entityInput)
  // This follows the SAME pattern as entity-to-entity communication
  const jInput: JInput = {
    jurisdictionName,
    jTxs: [jTx],
  };

  jOutputs.push(jInput);
  console.log(`✅ j_broadcast: Created jOutput for J-machine "${jurisdictionName}"`);
  console.log(`   📦 Will queue to J-mempool via runtime`);
  console.log(`   Batch size: ${batchSize} operations`);

  // Clear entity's jBatch after creating output (ready for next batch)
  newState.jBatchState.batch = createEmptyBatch();
  newState.jBatchState.broadcastCount++;
  newState.jBatchState.lastBroadcast = env.disableAutoSnapshots ? env.timestamp : Date.now();

  addMessage(newState, `📤 Created J-output (${batchSize} ops) - will queue via runtime`);

  // Note: JBatchQueued event will be emitted by runtime when actually queued

  return { newState, outputs, jOutputs };
}
