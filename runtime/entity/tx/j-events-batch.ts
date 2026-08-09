import type { EntityInput, EntityState } from '../types';
import type { JurisdictionEvent } from '../../types/jurisdiction-events';
import {
  initJBatch,
  hasJBatchWork,
} from '../../jurisdiction/machine/batch';
import { addMessage } from '../frame-events';
import { createStructuredLogger } from '../../infra/logger';
import { flushDeferredHashLadderReveals } from './j-events-htlc';

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

const handleNonPendingBatch = (
  state: EntityState,
  sentBatch: NonNullable<EntityState['jBatchState']>['sentBatch'],
  nonce: number,
  eventBatchHash: string,
): void => {
  syncEntityNonce(state, nonce);
  if (!sentBatch || nonce < sentBatch.entityNonce) {
    jEventBatchLog.warn('non_pending_batch_observed', {
      nonce,
      batchHash: eventBatchHash,
      pendingNonce: sentBatch?.entityNonce,
      pendingBatchHash: sentBatch?.batchHash,
    });
    return;
  }
  const pendingHash = normalizeBatchHash(sentBatch.batchHash, 'PENDING_BATCH_HASH');
  const failureMessage =
    `J_BATCH_NONCE_CONSUMED_BY_DIFFERENT_HASH:${eventBatchHash}:` +
    `pending=${pendingHash}:pendingNonce=${sentBatch.entityNonce}:finalizedNonce=${nonce}`;
  sentBatch.terminalFailure = { message: failureMessage, failedAt: state.timestamp };
  state.jBatchState!.status = 'failed';
  jEventBatchLog.error('pending_batch_nonce_consumed', {
    nonce,
    batchHash: eventBatchHash,
    pendingNonce: sentBatch.entityNonce,
    pendingBatchHash: sentBatch.batchHash,
  });
  addMessage(
    state,
    `❌ Pending jBatch nonce ${sentBatch.entityNonce} quarantined: ` +
      `chain finalized different batch ${eventBatchHash} at nonce ${nonce}`,
  );
};

const finalizePendingBatch = (
  state: EntityState,
  nonce: number,
  outputs: EntityInput[],
): void => {
  delete state.jBatchState!.sentBatch;
  state.jBatchState!.status = hasJBatchWork(state.jBatchState!) ? 'accumulating' : 'empty';
  syncEntityNonce(state, nonce);
  // After finalize leaves sentBatch, queue any Target reveals that waited.
  const flushed = flushDeferredHashLadderReveals(state);
  if (flushed > 0) {
    state.jBatchState!.status = 'accumulating';
    state.jBatchState!.autoBroadcastDraft = true;
  }
  if (!state.jBatchState!.autoBroadcastDraft || !hasJBatchWork(state.jBatchState!)) return;
  const signerId = state.config.validators[0];
  if (!signerId) throw new Error('J_BATCH_AUTO_BROADCAST_SIGNER_MISSING');
  outputs.push({
    entityId: state.entityId,
    signerId,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  });
};

export async function applyHankoBatchProcessedEvent(opts: {
  newState: EntityState;
  event: JurisdictionEvent;
  blockNumber: number;
  outputs?: EntityInput[];
}): Promise<void> {
  const { newState, event, blockNumber } = opts;
  const outputs = opts.outputs ?? [];
  const { entityId: batchEntityId, batchHash, nonce } = event.data as {
    entityId: string;
    batchHash: string;
    nonce: number;
  };

  if (String(batchEntityId || '').toLowerCase() !== String(newState.entityId || '').toLowerCase()) {
    return;
  }

  const eventBatchHash = normalizeBatchHash(batchHash, 'BATCH_HASH');
  if (!Number.isSafeInteger(nonce) || nonce < 1) {
    throw new Error(`J_BATCH_EVENT_NONCE_INVALID:${String(nonce)}`);
  }

  // HankoBatchProcessed is the authoritative Entity-state nonce input. A hub
  // can receive finalized bootstrap/maintenance batches before it ever needs
  // to build a local batch, so lazy batch initialization must not discard
  // those nonces. Otherwise the first later rebalance restarts at nonce 1 and
  // can never pass Depository's strictly sequential nonce check.
  newState.jBatchState ??= initJBatch();
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
    handleNonPendingBatch(newState, sentBatch, nonce, eventBatchHash);
    return;
  }

  finalizePendingBatch(
    newState,
    nonce,
    outputs,
  );
  addMessage(newState, `✅ jBatch finalized (nonce ${nonce}) | Block ${blockNumber}`);
}
