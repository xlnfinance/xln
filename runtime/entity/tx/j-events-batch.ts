import type { EntityInput, EntityState, JurisdictionEvent } from '../../types';
import {
  batchOpBreakdown,
  batchOpCount,
  cloneJBatch,
  isBatchEmpty,
  mergeBatchOps,
  type BatchOpBreakdown,
} from '../../jurisdiction/batch';
import { addMessage } from '../../state-helpers';
import { filterActiveDisputeFinalizations } from './dispute-finalize-guards';
import { appendBatchHistory } from './j-events-history';
import { findAccountEntryByCounterparty } from './j-events-account-lookup';
import { createStructuredLogger } from '../../infra/logger';

const jEventBatchLog = createStructuredLogger('j.event.batch');

const normalizeBatchHash = (value: unknown, label: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`J_BATCH_EVENT_${label}_INVALID:${normalized || 'missing'}`);
  }
  return normalized;
};

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
}): void {
  const { state, sentBatch, opCount, opBreakdown, nonce, blockNumber, transactionHash, status } = opts;
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
    ...(sentBatch?.skippedOperations
      ? { skippedOperations: structuredClone(sentBatch.skippedOperations) }
      : {}),
    source: 'self-batch' as const,
  });
}

export async function applyHankoBatchProcessedEvent(opts: {
  newState: EntityState;
  event: JurisdictionEvent;
  transactionHash: string;
  blockNumber: number;
  dirtyAccounts: Set<string>;
  outputs?: EntityInput[];
}): Promise<void> {
  const { newState, event, transactionHash, blockNumber, dirtyAccounts } = opts;
  const outputs = opts.outputs ?? [];
  const { entityId: batchEntityId, batchHash, nonce, success } = event.data as {
    entityId: string;
    batchHash: string;
    nonce: number;
    success: boolean;
  };

  if (String(batchEntityId || '').toLowerCase() !== String(newState.entityId || '').toLowerCase()) {
    return;
  }

  const eventBatchHash = normalizeBatchHash(batchHash, 'BATCH_HASH');
  if (!Number.isSafeInteger(nonce) || nonce < 1) {
    throw new Error(`J_BATCH_EVENT_NONCE_INVALID:${String(nonce)}`);
  }

  const sentBatch = newState.jBatchState?.sentBatch;
  const matchesPending = !!sentBatch &&
    sentBatch.entityNonce === nonce &&
    normalizeBatchHash(sentBatch.batchHash, 'PENDING_BATCH_HASH') === eventBatchHash;

  // A batch can be aborted locally and rebuilt with the same not-yet-observed
  // nonce. The old transaction may still land afterwards. Nonce-only matching
  // would then confirm/requeue the replacement batch even though validators
  // never authorized that payload. The on-chain signed batch hash is the exact
  // identity. A finalized event at or beyond the pending nonce also proves the
  // replacement can never execute: Depository nonces are strictly sequential.
  // Preserve that payload for forensic/operator review, but quarantine it so
  // validator-local retry machinery cannot keep submitting an impossible tx.
  if (!matchesPending) {
    if (newState.jBatchState) syncEntityNonce(newState, nonce);
    if (sentBatch && nonce >= sentBatch.entityNonce) {
      const failureMessage =
        `J_BATCH_NONCE_CONSUMED_BY_DIFFERENT_HASH:${eventBatchHash}:` +
        `pending=${normalizeBatchHash(sentBatch.batchHash, 'PENDING_BATCH_HASH')}:` +
        `pendingNonce=${sentBatch.entityNonce}:finalizedNonce=${nonce}`;
      sentBatch.terminalFailure = {
        message: failureMessage,
        failedAt: newState.timestamp,
      };
      if (newState.jBatchState) newState.jBatchState.status = 'failed';
      jEventBatchLog.error('pending_batch_nonce_consumed', {
        nonce,
        batchHash: eventBatchHash,
        pendingNonce: sentBatch.entityNonce,
        pendingBatchHash: sentBatch.batchHash,
      });
      addMessage(
        newState,
        `❌ Pending jBatch nonce ${sentBatch.entityNonce} quarantined: ` +
          `chain finalized different batch ${eventBatchHash} at nonce ${nonce}`,
      );
      return;
    }
    jEventBatchLog.warn('non_pending_batch_observed', {
      nonce,
      batchHash: eventBatchHash,
      pendingNonce: sentBatch?.entityNonce,
      pendingBatchHash: sentBatch?.batchHash,
      success,
    });
    return;
  }

  if (success) {
    if (newState.jBatchState) {
      const opCount = sentBatch ? batchOpCount(sentBatch.batch) : 0;
      const opBreakdown = sentBatch ? batchOpBreakdown(sentBatch.batch) : undefined;

      appendSelfBatchHistory({
        state: newState,
        sentBatch,
        opCount,
        opBreakdown,
        nonce,
        blockNumber,
        transactionHash,
        status: 'confirmed',
      });

      delete newState.jBatchState.sentBatch;
      newState.jBatchState.status = isBatchEmpty(newState.jBatchState.batch) ? 'empty' : 'accumulating';
      syncEntityNonce(newState, nonce);
      if (newState.jBatchState.autoBroadcastDraft && !isBatchEmpty(newState.jBatchState.batch)) {
        const signerId = newState.config.validators[0];
        if (!signerId) throw new Error('J_BATCH_AUTO_BROADCAST_SIGNER_MISSING');
        outputs.push({
          entityId: newState.entityId,
          signerId,
          entityTxs: [{ type: 'j_broadcast', data: {} }],
        });
      }
    }
    addMessage(newState, `✅ jBatch finalized (nonce ${nonce}) | Block ${blockNumber}`);
    return;
  }

  if (newState.jBatchState) {
    const opCount = sentBatch ? batchOpCount(sentBatch.batch) : 0;
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
    if (account.shadow.rebalance.submittedAtByToken.size > 0) {
      account.shadow.rebalance.submittedAtByToken.clear();
      dirtyAccounts.add(String(accountId).toLowerCase());
    }
  }
  jEventBatchLog.warn('failed_on_chain', { nonce });
  addMessage(newState, `⚠️ jBatch failed (nonce ${nonce}) - use j_clear_batch to abort | Block ${blockNumber}`);
}
