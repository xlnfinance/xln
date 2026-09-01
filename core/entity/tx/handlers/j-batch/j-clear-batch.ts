/**
 * J-Clear-Batch Handler
 *
 * Manually clears the entity's pending jBatch.
 * Use when: batch rejected by J-machine, want to build fresh batch,
 * or abandoning pending operations.
 *
 * NOTE: This does NOT affect settlement workspaces - those must be
 * rejected/cleared separately if the settlement is no longer valid.
 */

import type { EntityState, EntityInput } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { JInput } from '../../../../jurisdiction/machine/input';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import { createEmptyBatch, batchOpCount } from '../../../../jurisdiction/machine/batch';
import { createStructuredLogger, shortId } from '../../../../support/logger';
import { getEntityAccountForWrite } from '../../../state/persistent-account-map';
import { applyEntityAccountEnvelopeUpdate } from '../../../account-envelope-update';
import { requirePersistentAccountStateMap } from '../../../../account/state/persistent-state-map';

const jBatchActionLog = createStructuredLogger('entity.jbatch');

export async function handleJClearBatch(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_clear_batch' }>,
  env: EntityRuntimeContext,
  mutableFrameState = false,
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs: JInput[] }> {
  const { reason } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  if (!newState.jBatchState) {
    addMessage(newState, `⚠️ No jBatchState to clear`);
    return { newState, outputs, jOutputs };
  }

  const oldBatchSize = batchOpCount(newState.jBatchState.batch);
  const recoveryBatchSize = (newState.jBatchState.recoveryBatches ?? [])
    .reduce((total, batch) => total + batchOpCount(batch), 0);
  const sentBatchSize = newState.jBatchState.sentBatch ? batchOpCount(newState.jBatchState.sentBatch.batch) : 0;
  const hadSentBatch = !!newState.jBatchState.sentBatch;
  const droppedFinalizeCounterparties = new Set<string>();
  for (const op of newState.jBatchState.batch.disputeFinalizations || []) {
    droppedFinalizeCounterparties.add(String(op.counterentity).toLowerCase());
  }
  for (const op of newState.jBatchState.sentBatch?.batch.disputeFinalizations || []) {
    droppedFinalizeCounterparties.add(String(op.counterentity).toLowerCase());
  }
  for (const recoveryBatch of newState.jBatchState.recoveryBatches ?? []) {
    for (const op of recoveryBatch.disputeFinalizations) {
      droppedFinalizeCounterparties.add(String(op.counterentity).toLowerCase());
    }
  }
  let resetSubmittedMarkers = 0;

  // Clear current + sent batch and reset lifecycle
  newState.jBatchState.batch = createEmptyBatch();
  delete newState.jBatchState.sentBatch;
  delete newState.jBatchState.recoveryBatches;
  newState.jBatchState.status = 'empty';

  // Manual recovery: release stale "submitted" latches so hub can retry requests.
  for (const accountId of newState.accounts.keys()) {
    const account = getEntityAccountForWrite(newState.accounts, accountId);
    if (!account) continue;
    resetSubmittedMarkers += account.shadow.rebalance.submittedAtByToken.size;
    account.shadow.rebalance.submittedAtByToken = requirePersistentAccountStateMap(
      account.shadow.rebalance.submittedAtByToken,
      'rebalanceShadowSubmitted',
    ).emptied();
  }
  if (droppedFinalizeCounterparties.size > 0) {
    for (const counterpartyId of newState.accounts.keys()) {
      const visible = newState.accounts.get(counterpartyId);
      if (!visible?.activeDispute) continue;
      if (!droppedFinalizeCounterparties.has(counterpartyId.toLowerCase())) continue;
      const account = getEntityAccountForWrite(newState.accounts, counterpartyId);
      if (!account?.activeDispute) continue;
      // Same typed transition the Account stage applies; a direct write here
      // would leave the Account workers holding the pre-clear leaf.
      applyEntityAccountEnvelopeUpdate(env, counterpartyId, account, {
        type: 'replaceDisputeLifecycle',
        status: account.status,
        activeDispute: { ...account.activeDispute, finalizeQueued: false },
      });
    }
  }

  const reasonMsg = reason ? ` (${reason})` : '';
  const pendingMsg = hadSentBatch ? ` [sentBatch=${sentBatchSize} ops]` : '';
  const recoveryMsg = recoveryBatchSize > 0 ? ` [recoveryBatch=${recoveryBatchSize} ops]` : '';
  const resetMsg = resetSubmittedMarkers > 0 ? `; reset ${resetSubmittedMarkers} submitted rebalance marker(s)` : '';
  jBatchActionLog.debug('clear.completed', {
    entity: shortId(entityState.entityId),
    currentOps: oldBatchSize,
    recoveryOps: recoveryBatchSize,
    sentOps: sentBatchSize,
    hadSentBatch,
    resetSubmittedMarkers,
    reason: reason ?? '',
  });
  addMessage(newState, `🗑️ Cleared jBatch current=${oldBatchSize}${pendingMsg}${recoveryMsg}${reasonMsg}${resetMsg}`);

  return { newState, outputs, jOutputs };
}
