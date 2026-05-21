import type { EntityState, JurisdictionEvent } from '../types';
import type { BatchOpBreakdown, JBatch } from '../j-batch';
import { addMessage } from '../state-helpers';
import { filterActiveDisputeFinalizations } from './dispute-finalize-guards';
import { appendBatchHistory } from './j-events-history';
import { findAccountEntryByCounterparty } from './j-events-account-lookup';
import { createStructuredLogger } from '../logger';

const jEventBatchLog = createStructuredLogger('j.event.batch');

const syncEntityNonce = (state: EntityState, nonce: number): void => {
  if (!state.jBatchState) return;
  const currentNonce = Number(state.jBatchState.entityNonce || 0);
  const eventNonceNum = Number(nonce || 0);
  state.jBatchState.entityNonce = eventNonceNum > currentNonce ? eventNonceNum : currentNonce;
};

function appendSelfBatchHistory(opts: {
  state: EntityState;
  sentBatch: NonNullable<EntityState['jBatchState']>['sentBatch'];
  opCount: number;
  opBreakdown: BatchOpBreakdown | undefined;
  nonce: number;
  blockNumber: number;
  transactionHash: string;
  status: 'confirmed' | 'failed';
  cloneJBatch: (batch: JBatch) => JBatch;
}): void {
  const { state, sentBatch, opCount, opBreakdown, nonce, blockNumber, transactionHash, status, cloneJBatch } = opts;
  appendBatchHistory(state, {
    batchHash: sentBatch?.batchHash || '',
    txHash: sentBatch?.txHash || transactionHash || '',
    status,
    broadcastedAt: sentBatch?.lastSubmittedAt || state.jBatchState?.lastBroadcast || 0,
    confirmedAt: state.timestamp,
    opCount,
    entityNonce: Number(nonce),
    jBlockNumber: Number(blockNumber || 0),
    ...(sentBatch?.batch ? { batch: cloneJBatch(sentBatch.batch) } : {}),
    ...(opBreakdown ? { operations: opBreakdown } : {}),
    source: 'self-batch' as const,
  });
}

export async function applyHankoBatchProcessedEvent(opts: {
  newState: EntityState;
  event: JurisdictionEvent;
  transactionHash: string;
  blockNumber: number;
  dirtyAccounts: Set<string>;
}): Promise<void> {
  const { newState, event, transactionHash, blockNumber, dirtyAccounts } = opts;
  const { entityId: batchEntityId, nonce, success } = event.data as {
    entityId: string;
    nonce: number;
    success: boolean;
  };

  if (String(batchEntityId || '').toLowerCase() !== String(newState.entityId || '').toLowerCase()) {
    return;
  }

  if (success) {
    if (newState.jBatchState) {
      const { batchOpCount: countOps, batchOpBreakdown, isBatchEmpty, cloneJBatch } = await import('../j-batch');
      const sentBatch = newState.jBatchState.sentBatch;
      const opCount = sentBatch ? countOps(sentBatch.batch) : 0;
      const opBreakdown = sentBatch ? batchOpBreakdown(sentBatch.batch) : undefined;
      const wasPending = !!sentBatch;

      if (!wasPending && opCount === 0) {
        syncEntityNonce(newState, nonce);
        jEventBatchLog.debug('duplicate_ignored', { nonce, opCount, pending: false });
        return;
      }

      appendSelfBatchHistory({
        state: newState,
        sentBatch,
        opCount,
        opBreakdown,
        nonce,
        blockNumber,
        transactionHash,
        status: 'confirmed',
        cloneJBatch,
      });

      delete newState.jBatchState.sentBatch;
      newState.jBatchState.status = isBatchEmpty(newState.jBatchState.batch) ? 'empty' : 'accumulating';
      syncEntityNonce(newState, nonce);
    }
    addMessage(newState, `✅ jBatch finalized (nonce ${nonce}) | Block ${blockNumber}`);
    return;
  }

  if (newState.jBatchState) {
    const { batchOpCount: countOps, batchOpBreakdown, isBatchEmpty, mergeBatchOps, cloneJBatch } = await import('../j-batch');
    const sentBatch = newState.jBatchState.sentBatch;
    const opCount = sentBatch ? countOps(sentBatch.batch) : 0;
    const opBreakdown = sentBatch ? batchOpBreakdown(sentBatch.batch) : undefined;
    newState.jBatchState.status = 'failed';
    newState.jBatchState.failedAttempts++;
    syncEntityNonce(newState, nonce);

    appendSelfBatchHistory({
      state: newState,
      sentBatch,
      opCount,
      opBreakdown,
      nonce,
      blockNumber,
      transactionHash,
      status: 'failed',
      cloneJBatch,
    });

    if (sentBatch) {
      const requeueBatch = cloneJBatch(sentBatch.batch);
      const { removed, droppedCounterparties } = filterActiveDisputeFinalizations(newState, requeueBatch);
      if (removed > 0) {
        addMessage(newState, `🧹 Filtered ${removed} stale dispute-finalize op(s) from failed batch requeue`);
      }
      mergeBatchOps(newState.jBatchState.batch, requeueBatch);
      for (const fin of requeueBatch.disputeFinalizations || []) {
        const accountEntry = findAccountEntryByCounterparty(newState, String(fin.counterentity || ''));
        const account = accountEntry?.[1];
        if (account?.activeDispute) {
          account.activeDispute.finalizeQueued = false;
          dirtyAccounts.add(String(accountEntry?.[0] || fin.counterentity || '').toLowerCase());
        }
      }
      for (const counterpartyId of droppedCounterparties) {
        const accountEntry = findAccountEntryByCounterparty(newState, counterpartyId);
        const account = accountEntry?.[1];
        if (account?.activeDispute) {
          account.activeDispute.finalizeQueued = false;
          dirtyAccounts.add(String(accountEntry?.[0] || counterpartyId).toLowerCase());
        }
      }
    }
    delete newState.jBatchState.sentBatch;
    newState.jBatchState.status = isBatchEmpty(newState.jBatchState.batch) ? 'failed' : 'accumulating';
  }

  for (const [accountId, account] of newState.accounts.entries()) {
    if (!account.requestedRebalanceFeeState) continue;
    for (const feeState of account.requestedRebalanceFeeState.values()) {
      if ((feeState.jBatchSubmittedAt || 0) > 0) {
        feeState.jBatchSubmittedAt = 0;
        dirtyAccounts.add(String(accountId).toLowerCase());
      }
    }
  }
  jEventBatchLog.warn('failed_on_chain', { nonce });
  addMessage(newState, `⚠️ jBatch failed (nonce ${nonce}) - use j_clear_batch to abort | Block ${blockNumber}`);
}
