import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { JInput } from '../../../../jurisdiction/machine/input';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import {
  batchOpCount,
  hasJBatchWork,
  prependRecoveryBatch,
  type JBatch,
} from '../../../../jurisdiction/machine/batch';
import { createStructuredLogger, shortId } from '../../../../support/logger';
import { getEntityAccountForWrite } from '../../../state/persistent-account-map';
import { requirePersistentAccountStateMap } from '../../../../account/state/persistent-state-map';

const jBatchActionLog = createStructuredLogger('entity.jbatch');

const dropDisputeFinalizations = (
  state: EntityState,
  dropped: Set<string>,
): void => {
  const finalizations = state.jBatchState?.sentBatch?.batch.disputeFinalizations;
  if (!finalizations?.length) return;
  for (const operation of finalizations) {
    dropped.add(String(operation.counterentity).toLowerCase());
  }
  state.jBatchState!.sentBatch!.batch.disputeFinalizations = [];
  // Dispute finality is watcher-authoritative. An abort must never resurrect a
  // finalize operation: if it landed, replay would poison the next batch; if
  // it did not, crontab/manual flow drafts fresh evidence from current state.
  jBatchActionLog.debug('abort.filtered_dispute_finalize', {
    entity: shortId(state.entityId),
    count: finalizations.length,
  });
};

const accountByCounterparty = (state: EntityState, counterparty: string) =>
  state.accounts.get(counterparty) ?? state.accounts.get(counterparty.toLowerCase());

const dropStaleCollateralToReserve = (state: EntityState): void => {
  const operations = state.jBatchState?.sentBatch?.batch.collateralToReserve;
  if (!operations?.length) return;
  const retained = operations.filter(operation => {
    const counterparty = String(operation.counterparty).toLowerCase();
    const account = accountByCounterparty(state, counterparty);
    const jNonce = account?.state.jNonce ?? 0;
    if (operation.nonce > jNonce) return true;
    jBatchActionLog.warn('abort.drop_stale_c2r', {
      entity: shortId(state.entityId),
      counterparty: shortId(counterparty),
      signedNonce: operation.nonce,
      jNonce,
    });
    // AccountSettled finality alone clears the workspace. This stale operation
    // may name an older workspace, so abort cannot delete the current one.
    return false;
  });
  state.jBatchState!.sentBatch!.batch.collateralToReserve = retained;
  if (retained.length !== operations.length) {
    jBatchActionLog.debug('abort.filtered_c2r', {
      entity: shortId(state.entityId),
      count: operations.length - retained.length,
    });
  }
};

const releaseR2CSubmittedLatches = (state: EntityState, batch: JBatch): void => {
  for (const operation of batch.reserveToCollateral) {
    for (const pair of operation.pairs) {
      const accountId = String(pair.entity).toLowerCase();
      const account = getEntityAccountForWrite(state.accounts, accountId);
      if (!account) continue;
      account.shadow.rebalance.submittedAtByToken = requirePersistentAccountStateMap(
        account.shadow.rebalance.submittedAtByToken,
        'rebalanceShadowSubmitted',
      ).removed(operation.tokenId);
    }
  }
};

const releaseFinalizeLatches = (
  state: EntityState,
  droppedFinalizers: Set<string>,
): void => {
  for (const counterpartyId of droppedFinalizers) {
    const account = getEntityAccountForWrite(state.accounts, counterpartyId);
    if (account?.activeDispute) account.activeDispute.finalizeQueued = false;
  }
};

export async function handleJAbortSentBatch(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_abort_sent_batch' }>,
  _env: EntityRuntimeContext,
  mutableFrameState = false,
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs: JInput[] }> {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  if (!newState.jBatchState?.sentBatch) {
    addMessage(newState, '⚠️ No sentBatch to abort');
    return { newState, outputs, jOutputs };
  }

  const sent = newState.jBatchState.sentBatch;
  const requeue = entityTx.data.requeueToCurrent !== false;
  const reason = entityTx.data.reason ? ` (${entityTx.data.reason})` : '';
  const sentSize = batchOpCount(sent.batch);
  const droppedFinalizeCounterparties = new Set<string>();
  if (!requeue) {
    for (const op of sent.batch.disputeFinalizations || []) {
      droppedFinalizeCounterparties.add(String(op.counterentity).toLowerCase());
    }
  }

  if (requeue) {
    dropDisputeFinalizations(newState, droppedFinalizeCounterparties);
    dropStaleCollateralToReserve(newState);
    prependRecoveryBatch(newState.jBatchState, sent.batch);
  } else {
    releaseR2CSubmittedLatches(newState, sent.batch);
  }

  delete newState.jBatchState.sentBatch;
  newState.jBatchState.status = hasJBatchWork(newState.jBatchState) ? 'accumulating' : 'empty';

  releaseFinalizeLatches(newState, droppedFinalizeCounterparties);

  addMessage(
    newState,
    `🛑 Aborted sentBatch nonce=${sent.entityNonce} ops=${sentSize}` +
      (requeue ? ' (requeued to current)' : ' (dropped)') +
      reason,
  );

  return { newState, outputs, jOutputs };
}
