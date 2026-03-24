import type { EntityInput, EntityState, EntityTx, Env, JInput } from '../../types';
import { addMessage, cloneEntityState } from '../../state-helpers';
import { createEmptyBatch, getBatchSize, mergeBatchOps } from '../../j-batch';

export async function handleJAbortSentBatch(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_abort_sent_batch' }>,
  _env: Env,
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs: JInput[] }> {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  if (!newState.jBatchState?.sentBatch) {
    addMessage(newState, '⚠️ No sentBatch to abort');
    return { newState, outputs, jOutputs };
  }

  const sent = newState.jBatchState.sentBatch;
  const requeue = entityTx.data.requeueToCurrent !== false;
  const reason = entityTx.data.reason ? ` (${entityTx.data.reason})` : '';
  const sentSize = getBatchSize(sent.batch);
  const droppedFinalizeCounterparties = new Set<string>();
  if (!requeue) {
    for (const op of sent.batch.disputeFinalizations || []) {
      droppedFinalizeCounterparties.add(String(op.counterentity).toLowerCase());
    }
  }

  if (requeue) {
    if (!newState.jBatchState.batch) {
      newState.jBatchState.batch = createEmptyBatch();
    }
    // Drop stale C2R ops whose signed nonce is now <= on-chain nonce (would revert E2).
    if (sent.batch.collateralToReserve?.length) {
      const before = sent.batch.collateralToReserve.length;
      sent.batch.collateralToReserve = sent.batch.collateralToReserve.filter(c2r => {
        const cpId = String(c2r.counterparty).toLowerCase();
        const account = [...newState.accounts.entries()].find(
          ([k]) => k.toLowerCase() === cpId,
        )?.[1];
        const onChainNonce = account?.onChainSettlementNonce ?? 0;
        if (c2r.nonce <= onChainNonce) {
          console.warn(
            `🗑️ Dropping stale C2R for ${cpId.slice(-4)}: signed nonce ${c2r.nonce} <= onChain ${onChainNonce}`,
          );
          // Also clear the workspace so user can re-propose
          if (account?.settlementWorkspace) {
            delete account.settlementWorkspace;
          }
          return false;
        }
        return true;
      });
      if (before !== sent.batch.collateralToReserve.length) {
        console.log(`🧹 Filtered ${before - sent.batch.collateralToReserve.length} stale C2R ops from requeue`);
      }
    }
    mergeBatchOps(newState.jBatchState.batch, sent.batch);
  }

  newState.jBatchState.sentBatch = undefined;
  newState.jBatchState.status = getBatchSize(newState.jBatchState.batch) > 0 ? 'accumulating' : 'empty';

  // Release stale "submitted" latches if operator aborts the in-flight batch.
  for (const account of newState.accounts.values()) {
    if (!account.requestedRebalanceFeeState) continue;
    for (const feeState of account.requestedRebalanceFeeState.values()) {
      if ((feeState.jBatchSubmittedAt || 0) > 0) {
        feeState.jBatchSubmittedAt = 0;
      }
    }
  }
  if (droppedFinalizeCounterparties.size > 0) {
    for (const [counterpartyId, account] of newState.accounts.entries()) {
      if (!account.activeDispute) continue;
      if (!droppedFinalizeCounterparties.has(counterpartyId.toLowerCase())) continue;
      account.activeDispute.finalizeQueued = false;
    }
  }

  addMessage(
    newState,
    `🛑 Aborted sentBatch nonce=${sent.entityNonce} ops=${sentSize}` +
      (requeue ? ' (requeued to current)' : ' (dropped)') +
      reason,
  );

  return { newState, outputs, jOutputs };
}
