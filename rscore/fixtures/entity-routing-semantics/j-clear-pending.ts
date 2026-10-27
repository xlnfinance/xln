import { handleJClearBatch } from '../../../core/entity/tx/handlers/j-batch/j-clear-batch';
import { createEmptyBatch } from '../../../core/jurisdiction/machine/batch';
import { FailureDispositionError } from '../../../core/protocol/errors/failure-taxonomy';
import { safeStringify } from '../../../core/protocol/serialization';
import { createEmptyEnv } from '../../../core/runtime';
import { addr, entity, makeJurisdiction, makeState } from '../../../core/__tests__/helpers/cross-j';

/** Shared rejection vectors: sender command cannot erase signed reconciliation evidence. */
export const executeJClearPendingVectors = async () => {
  const cases = [];
  for (const pending of ['sent', 'recovery', 'both', 'empty-recovery'] as const) {
    const state = makeState(entity('11'), addr('35'), makeJurisdiction('clear-pending', 31337, 'a1', 'b2'));
    const draft = () => ({
      ...createEmptyBatch(),
      reserveToReserve: [{ receivingEntity: entity('22'), tokenId: 1, amount: 10n }],
    });
    state.jBatchState = {
      batch: draft(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'accumulating',
      entityNonce: 1,
    };
    if (pending === 'sent' || pending === 'both')
      state.jBatchState.sentBatch = {
        batch: draft(),
        batchHash: `0x${'44'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 1,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      };
    if (pending !== 'sent')
      state.jBatchState.recoveryBatches = [pending === 'empty-recovery' ? createEmptyBatch() : draft()];
    const before = safeStringify(state.jBatchState);
    try {
      await handleJClearBatch(state, { type: 'j_clear_batch', data: {} }, createEmptyEnv('clear-parity'), true);
      throw new Error('Expected J_CLEAR_BATCH_PENDING');
    } catch (error) {
      if (!(error instanceof FailureDispositionError)) throw error;
      cases.push({
        pending,
        code: error.code,
        message: error.message,
        disposition: error.disposition,
        stateUnchanged: safeStringify(state.jBatchState) === before,
      });
    }
  }
  return cases;
};
