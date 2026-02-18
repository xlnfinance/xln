/**
 * J-Broadcast Handler
 *
 * Entity broadcasts accumulated jBatch via entity consensus (hashesToSign pipeline).
 *
 * Flow:
 * 1. Validate batch is non-empty, jurisdiction configured
 * 2. Encode batch + compute batchHash (deterministic: uses tracked entity nonce)
 * 3. Create JTx WITHOUT hanko (will be attached post-commit by entity-consensus)
 * 4. Return hashesToSign with batchHash (type: 'jBatch')
 * 5. Entity consensus signs batchHash (single-signer shortcut or full multisig)
 * 6. Post-commit: entity-consensus attaches quorum hanko to JTx
 * 7. Runtime submits JTx via JAdapter
 */

import type { EntityState, EntityTx, EntityInput, Env, JTx, JInput, HashType } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import {
  isBatchEmpty, getBatchSize, cloneJBatch, encodeJBatch,
  computeBatchHankoHash, batchOpCount,
} from '../../j-batch';
import type { ApplyEntityTxResult } from '../apply';

export async function handleJBroadcast(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_broadcast' }>,
  env: Env
): Promise<ApplyEntityTxResult> {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  // ── Validate: jBatch exists and is non-empty ──
  if (!newState.jBatchState || isBatchEmpty(newState.jBatchState.batch)) {
    const msg = '❌ No operations to broadcast - jBatch is empty';
    addMessage(newState, msg);
    throw new Error(msg);
  }

  // ── Validate: jurisdiction configured ──
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction) {
    addMessage(newState, '❌ No jurisdiction configured for this entity');
    return { newState, outputs, jOutputs };
  }

  const depositoryAddress = jurisdiction.depositoryAddress;
  const chainId = BigInt(jurisdiction.chainId ?? 0);
  if (!depositoryAddress || depositoryAddress === '0x0000000000000000000000000000000000000000') {
    addMessage(newState, '❌ Missing depository address');
    return { newState, outputs, jOutputs };
  }
  if (!chainId) {
    addMessage(newState, '❌ Missing chainId');
    return { newState, outputs, jOutputs };
  }

  // ── Validate: signerId available ──
  const signerId = entityState.config.validators[0];
  if (!signerId) {
    addMessage(newState, '❌ No signerId available');
    return { newState, outputs, jOutputs };
  }

  // ── Compute batch hash (deterministic: uses tracked entity nonce) ──
  // Entity nonce tracks on-chain nonce. Contract expects currentNonce + 1.
  const currentEntityNonce = BigInt(newState.jBatchState.entityNonce ?? 0);
  const nextNonce = currentEntityNonce + 1n;

  // Set entityProvider on settlements before encoding
  const entityProviderAddress = jurisdiction.entityProviderAddress;
  for (const settlement of newState.jBatchState.batch.settlements) {
    if (settlement.diffs.length > 0 || settlement.forgiveDebtsInTokenIds.length > 0) {
      settlement.entityProvider = entityProviderAddress;
    }
  }

  const encodedBatch = encodeJBatch(newState.jBatchState.batch);
  const batchHash = computeBatchHankoHash(chainId, depositoryAddress, encodedBatch, nextNonce);

  const batchSize = getBatchSize(newState.jBatchState.batch);
  const opCount = batchOpCount(newState.jBatchState.batch);
  const jurisdictionName = jurisdiction.name || env.activeJurisdiction || 'default';

  console.log(`📤 j_broadcast: ${entityState.entityId.slice(-4)} | ${batchSize} ops | nonce=${nextNonce} | hash=${batchHash.slice(0, 10)}...`);
  console.log(
    `[REB][3][J_BROADCAST_SUBMIT] entity=${entityState.entityId.slice(-8)} nonce=${nextNonce} ops=${opCount} hash=${batchHash}`,
  );

  // ── Create JTx WITHOUT hanko (attached post-commit by entity-consensus) ──
  const jTx: JTx = {
    type: 'batch',
    entityId: entityState.entityId,
    data: {
      batch: cloneJBatch(newState.jBatchState.batch),
      batchHash,
      encodedBatch,
      entityNonce: Number(nextNonce),
      batchSize,
      signerId,
    },
    timestamp: newState.timestamp,
  };

  jOutputs.push({
    jurisdictionName,
    jTxs: [jTx],
  });

  // ── Update batch state ──
  newState.jBatchState.broadcastCount++;
  newState.jBatchState.lastBroadcast = newState.timestamp;
  newState.jBatchState.pendingBroadcast = true;
  newState.jBatchState.status = 'broadcasting';
  newState.jBatchState.batchHash = batchHash;
  newState.jBatchState.encodedBatch = encodedBatch;
  newState.jBatchState.entityNonce = Number(nextNonce);

  addMessage(newState, `📤 Batch (${opCount} ops) → hashesToSign [nonce=${nextNonce}]`);

  // ── Return hashesToSign for entity consensus ──
  const hashesToSign: Array<{ hash: string; type: HashType; context: string }> = [{
    hash: batchHash,
    type: 'jBatch',
    context: `jBatch:${entityState.entityId.slice(-4)}:nonce:${nextNonce}`,
  }];

  return { newState, outputs, jOutputs, hashesToSign };
}
