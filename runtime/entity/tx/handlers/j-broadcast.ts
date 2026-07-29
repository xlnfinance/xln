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

import type { EntityState, EntityTx, EntityInput, RuntimeState, JTx, JInput, HashType } from '../../../types';
import { requireUsableContractAddress } from '../../../jurisdiction/contract-address';
import { cloneEntityState } from '../../../state-helpers';
import { addMessage } from '../../frame-events';
import {
  isBatchEmpty, getBatchSize, cloneJBatch, encodeJBatch,
  computeBatchHankoHash, batchOpCount, createEmptyBatch,
  assertJBatchWithinContractLimits,
} from '../../../jurisdiction/batch';
import {
  getJurisdictionConfigName,
  requireRuntimeJurisdictionConfigByName,
} from '../../../jurisdiction/jurisdiction-runtime';
import type { EntityTxReducerResult } from '../apply';
import { createStructuredLogger, shortHash, shortId } from '../../../infra/logger';
import { getEntityLeaderState } from '../../consensus/leader';

const jBatchActionLog = createStructuredLogger('entity.jbatch');

const resolveBroadcastJurisdiction = (
  state: EntityState,
  env: RuntimeState,
): ReturnType<typeof requireRuntimeJurisdictionConfigByName> | null => {
  const configuredName = getJurisdictionConfigName(state.config.jurisdiction);
  if (!configuredName) {
    addMessage(state, '❌ No jurisdiction configured for this entity');
    return null;
  }
  try {
    return requireRuntimeJurisdictionConfigByName(env, configuredName, state.config.jurisdiction);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addMessage(state, `❌ Jurisdiction unavailable: ${message}`);
    return null;
  }
};

type PreparedBroadcast = {
  batchHash: string;
  batchGeneration: number;
  encodedBatch: string;
  jTx: JTx;
  nextNonce: bigint;
  opCount: number;
};

const prepareBroadcast = (
  state: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_broadcast' }>,
  entityId: string,
  jurisdiction: ReturnType<typeof requireRuntimeJurisdictionConfigByName>,
  signerId: string,
): PreparedBroadcast => {
  const depositoryAddress = requireUsableContractAddress('depository', jurisdiction.depositoryAddress);
  requireUsableContractAddress('entity_provider', jurisdiction.entityProviderAddress);
  const chainId = BigInt(jurisdiction.chainId ?? 0);
  const nextNonce = BigInt(state.jBatchState!.entityNonce ?? 0) + 1n;
  assertJBatchWithinContractLimits(state.jBatchState!.batch, 'j_broadcast');
  const encodedBatch = encodeJBatch(state.jBatchState!.batch);
  const batchHash = computeBatchHankoHash(chainId, depositoryAddress, encodedBatch, nextNonce);
  const batchSize = getBatchSize(state.jBatchState!.batch);
  const opCount = batchOpCount(state.jBatchState!.batch);
  const batchGeneration = state.jBatchState!.broadcastCount + 1;
  const jTx: JTx = {
    type: 'batch',
    entityId,
    data: {
      batch: cloneJBatch(state.jBatchState!.batch),
      batchHash,
      encodedBatch,
      entityNonce: Number(nextNonce),
      batchGeneration,
      ...(entityTx.data?.feeOverrides ? { feeOverrides: { ...entityTx.data.feeOverrides } } : {}),
      batchSize,
      signerId,
    },
    timestamp: state.timestamp,
  };
  jBatchActionLog.debug('broadcast.submit', {
    entity: shortId(entityId),
    jurisdiction: jurisdiction.name,
    batchSize,
    opCount,
    nonce: nextNonce.toString(),
    batchHash: shortHash(batchHash),
  });
  return { batchHash, batchGeneration, encodedBatch, jTx, nextNonce, opCount };
};

const commitBroadcast = (
  state: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_broadcast' }>,
  prepared: PreparedBroadcast,
): void => {
  const batch = cloneJBatch(state.jBatchState!.batch);
  state.jBatchState!.sentBatch = {
    batch,
    batchHash: prepared.batchHash,
    encodedBatch: prepared.encodedBatch,
    entityNonce: Number(prepared.nextNonce),
    firstSubmittedAt: state.timestamp,
    lastSubmittedAt: 0,
    submitAttempts: 0,
    ...(entityTx.data?.feeOverrides ? { feeOverrides: { ...entityTx.data.feeOverrides } } : {}),
  };
  state.jBatchState!.batch = createEmptyBatch();
  delete state.jBatchState!.autoBroadcastDraft;
  state.jBatchState!.broadcastCount = prepared.batchGeneration;
  state.jBatchState!.lastBroadcast = state.timestamp;
  state.jBatchState!.status = 'sent';
};

export async function handleJBroadcast(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_broadcast' }>,
  env: RuntimeState
): Promise<EntityTxReducerResult> {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  if (!newState.jBatchState) {
    const msg = '❌ No jBatchState found for j_broadcast';
    addMessage(newState, msg);
    throw new Error(msg);
  }

  if (newState.jBatchState.sentBatch) {
    const sent = newState.jBatchState.sentBatch;
    const msg = `❌ Cannot broadcast: sentBatch pending nonce=${sent.entityNonce} attempts=${sent.submitAttempts}`;
    addMessage(newState, msg);
    throw new Error(msg);
  }

  // ── Validate: jBatch exists and is non-empty ──
  if (isBatchEmpty(newState.jBatchState.batch)) {
    const msg = 'ℹ️ j_broadcast skipped: jBatch is empty';
    addMessage(newState, msg);
    return { newState, outputs, jOutputs };
  }

  const jurisdiction = resolveBroadcastJurisdiction(newState, env);
  if (!jurisdiction) return { newState, outputs, jOutputs };
  newState.config = {
    ...newState.config,
    jurisdiction,
  };
  if (!BigInt(jurisdiction.chainId ?? 0)) {
    addMessage(newState, '❌ Missing chainId');
    return { newState, outputs, jOutputs };
  }

  // ── Validate: signerId available ──
  const signerId = getEntityLeaderState(entityState).activeValidatorId;
  if (!signerId) {
    addMessage(newState, '❌ No signerId available');
    return { newState, outputs, jOutputs };
  }

  const prepared = prepareBroadcast(newState, entityTx, entityState.entityId, jurisdiction, signerId);
  jOutputs.push({ jurisdictionName: jurisdiction.name, jTxs: [prepared.jTx] });
  commitBroadcast(newState, entityTx, prepared);
  // IMPORTANT: do not advance entityNonce optimistically here.
  // If network submission fails, optimistic increment causes permanent nonce desync.
  // entityNonce is advanced only when HankoBatchProcessed is observed.

  addMessage(newState, `📤 Batch (${prepared.opCount} ops) → hashesToSign [nonce=${prepared.nextNonce}]`);

  // ── Return hashesToSign for entity consensus ──
  const hashesToSign: Array<{ hash: string; type: HashType; context: string }> = [{
    hash: prepared.batchHash,
    type: 'jBatch',
    context: `jBatch:${entityState.entityId.slice(-4)}:nonce:${prepared.nextNonce}`,
  }];

  return { newState, outputs, jOutputs, hashesToSign };
}
