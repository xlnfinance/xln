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

import type { EntityState, EntityInput, HashType } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { JInput } from '../../../../jurisdiction/machine/input';
import type { EntityTx } from '../../../../types/entity-tx';
import type { JTx } from '../../../../types/jurisdiction-runtime';
import { requireUsableContractAddress } from '../../../../jurisdiction/machine/contract-address';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import {
  isBatchEmpty, batchOpCount, cloneJBatch, encodeJBatch,
  computeBatchHankoHash, createEmptyBatch,
  hasJBatchWork,
  assertJBatchWithinContractLimits,
  type JBatch,
} from '../../../../jurisdiction/machine/batch';
import { flushDeferredHashLadderReveals } from '../../j-events-htlc';
import {
  getJurisdictionConfigName,
  requireRuntimeJurisdictionConfigByName,
} from '../../../../jurisdiction/machine/jurisdiction-runtime';
import type { EntityTxReducerResult } from '../../apply';
import { createStructuredLogger, shortHash, shortId } from '../../../../support/logger';
import { getEntityLeaderState } from '../../../consensus/leader';
import { requireBoundaryUint } from '../../../../protocol/boundary-validation';

const jBatchActionLog = createStructuredLogger('entity.jbatch');

const resolveBroadcastJurisdiction = (
  state: EntityState,
  env: EntityRuntimeContext,
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

export const shouldAutoBroadcastDraft = (batch: JBatch): boolean => !isBatchEmpty(batch);

export const takeBroadcastBatch = (current: JBatch): {
  selected: JBatch;
  remainder: JBatch;
  disputePriority: boolean;
} => {
  const selected = cloneJBatch(current);
  const disputePriority =
    selected.disputeStarts.length > 0
    || selected.counterDisputes.length > 0
    || selected.disputeFinalizations.length > 0;
  if (!disputePriority) {
    return { selected, remainder: createEmptyBatch(), disputePriority: false };
  }
  const remainder = cloneJBatch(selected);
  const priority = createEmptyBatch();
  if (selected.hashLadderRegistrations.length > 0) {
    // Registry writes are independent public evidence, but an accepted reveal
    // must still be mined before a queued finalization: the transformer in that
    // finalization reads the registry synchronously. Starts may share the batch;
    // Depository processes starts, then registrations, then finalizations.
    priority.disputeStarts = selected.disputeStarts;
    priority.counterDisputes = selected.counterDisputes;
    priority.hashLadderRegistrations = selected.hashLadderRegistrations;
    priority.revealSecrets = selected.revealSecrets;
    remainder.disputeStarts = [];
    remainder.counterDisputes = [];
    remainder.hashLadderRegistrations = [];
    remainder.revealSecrets = [];
    return { selected: priority, remainder, disputePriority: true };
  }
  priority.disputeStarts = selected.disputeStarts;
  priority.counterDisputes = selected.counterDisputes;
  // A finalization executes adversarial transformer evidence and can consume
  // roughly 8M gas. Sending the protocol maximum of eight exceeds the 60M
  // Sepolia/anvil block limit. FIFO one-at-a-time keeps every broadcast valid;
  // finality below automatically releases the next parked operation.
  priority.disputeFinalizations = selected.disputeFinalizations.slice(0, 1);
  priority.revealSecrets = selected.revealSecrets;
  remainder.disputeStarts = [];
  remainder.counterDisputes = [];
  remainder.disputeFinalizations = selected.disputeFinalizations.slice(1);
  remainder.revealSecrets = [];
  return { selected: priority, remainder, disputePriority: true };
};

const prepareBroadcast = (
  state: EntityState,
  batch: JBatch,
  entityTx: Extract<EntityTx, { type: 'j_broadcast' }>,
  entityId: string,
  jurisdiction: ReturnType<typeof requireRuntimeJurisdictionConfigByName>,
  signerId: string,
): PreparedBroadcast => {
  const depositoryAddress = requireUsableContractAddress('depository', jurisdiction.depositoryAddress);
  requireUsableContractAddress('entity_provider', jurisdiction.entityProviderAddress);
  const chainId = BigInt(jurisdiction.chainId ?? 0);
  const nextNonce = BigInt(state.jBatchState!.entityNonce ?? 0) + 1n;
  assertJBatchWithinContractLimits(batch, 'j_broadcast');
  const encodedBatch = encodeJBatch(batch);
  const batchHash = computeBatchHankoHash(chainId, depositoryAddress, encodedBatch, nextNonce);
  const batchSize = batchOpCount(batch);
  const opCount = batchSize;
  const batchGeneration = state.jBatchState!.broadcastCount + 1;
  const jTx: JTx = {
    type: 'batch',
    entityId,
    data: {
      batch: cloneJBatch(batch),
      batchHash,
      encodedBatch,
      entityNonce: requireBoundaryUint(nextNonce, 'J_BROADCAST_ENTITY_NONCE_INVALID'),
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
  selected: JBatch,
  remainder: JBatch,
  fromRecovery: boolean,
): void => {
  state.jBatchState!.sentBatch = {
    batch: cloneJBatch(selected),
    batchHash: prepared.batchHash,
    encodedBatch: prepared.encodedBatch,
    entityNonce: requireBoundaryUint(
      prepared.nextNonce,
      'J_BROADCAST_ENTITY_NONCE_INVALID',
    ),
    firstSubmittedAt: state.timestamp,
    lastSubmittedAt: 0,
    submitAttempts: 0,
    ...(entityTx.data?.feeOverrides ? { feeOverrides: { ...entityTx.data.feeOverrides } } : {}),
  };
  if (fromRecovery) {
    const queue = state.jBatchState!.recoveryBatches ?? [];
    if (isBatchEmpty(remainder)) queue.shift();
    else queue[0] = remainder;
    if (queue.length === 0) delete state.jBatchState!.recoveryBatches;
    else state.jBatchState!.recoveryBatches = queue;
  } else {
    state.jBatchState!.batch = remainder;
  }
  // Registration-priority submission may park any unrelated operation, not
  // only a finalization. The exact ACK must therefore continue whenever the
  // selected batch left a non-empty remainder; keying this latch to one op
  // class strands valid R2R/R2C/settlement work indefinitely.
  if (hasJBatchWork(state.jBatchState!)) {
    state.jBatchState!.autoBroadcastDraft = true;
  } else {
    delete state.jBatchState!.autoBroadcastDraft;
  }
  state.jBatchState!.broadcastCount = prepared.batchGeneration;
  state.jBatchState!.lastBroadcast = state.timestamp;
  state.jBatchState!.status = 'sent';
};

export async function handleJBroadcast(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_broadcast' }>,
  env: EntityRuntimeContext,
  mutableFrameState = false,
): Promise<EntityTxReducerResult> {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  if (!newState.jBatchState) {
    const msg = '❌ No jBatchState found for j_broadcast';
    addMessage(newState, msg);
    throw new Error(msg);
  }

  // Porter reveals deferred while finalize occupied the entity batch.
  const flushed = flushDeferredHashLadderReveals(newState);
  if (flushed > 0) {
    addMessage(newState, `🌉 Flushed ${flushed} deferred hash-ladder reveal(s) into jBatch`);
  }

  if (newState.jBatchState.sentBatch) {
    const sent = newState.jBatchState.sentBatch;
    const msg = `❌ Cannot broadcast: sentBatch pending nonce=${sent.entityNonce} attempts=${sent.submitAttempts}`;
    addMessage(newState, msg);
    throw new Error(msg);
  }

  // ── Validate: jBatch exists and is non-empty ──
  if (!hasJBatchWork(newState.jBatchState)) {
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

  const fromRecovery = Boolean(
    newState.jBatchState.recoveryBatches?.[0]
    && !isBatchEmpty(newState.jBatchState.recoveryBatches[0]),
  );
  const sourceBatch = fromRecovery
    ? newState.jBatchState.recoveryBatches![0]!
    : newState.jBatchState.batch;
  const { selected, remainder, disputePriority } = takeBroadcastBatch(sourceBatch);
  const prepared = prepareBroadcast(
    newState,
    selected,
    entityTx,
    entityState.entityId,
    jurisdiction,
    signerId,
  );
  jOutputs.push({ jurisdictionName: jurisdiction.name, jTxs: [prepared.jTx] });
  commitBroadcast(newState, entityTx, prepared, selected, remainder, fromRecovery);
  // IMPORTANT: do not advance entityNonce optimistically here.
  // If network submission fails, optimistic increment causes permanent nonce desync.
  // entityNonce is advanced only when HankoBatchProcessed is observed.

  addMessage(newState, `📤 Batch (${prepared.opCount} ops) → hashesToSign [nonce=${prepared.nextNonce}]`);
  if (disputePriority) {
    addMessage(newState, '⚖️ Dispute operations broadcast before ordinary queued operations');
  }

  // ── Return hashesToSign for entity consensus ──
  const hashesToSign: Array<{ hash: string; type: HashType; context: string }> = [{
    hash: prepared.batchHash,
    type: 'jBatch',
    context: `jBatch:${entityState.entityId.slice(-4)}:nonce:${prepared.nextNonce}`,
  }];

  return { newState, outputs, jOutputs, hashesToSign };
}
