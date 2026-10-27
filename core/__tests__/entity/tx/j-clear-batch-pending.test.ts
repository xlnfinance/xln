import { expect, test } from 'bun:test';
import { handleJClearBatch } from '../../../entity/tx/handlers/j-batch/j-clear-batch';
import { applyEntityTx } from '../../../entity/tx/apply';
import { createEmptyBatch } from '../../../jurisdiction/machine/batch';
import { createEmptyEnv } from '../../../runtime';
import { FailureDispositionError } from '../../../protocol/errors/failure-taxonomy';
import { addr, entity, makeJurisdiction, makeState } from '../../helpers/cross-j';

const self = entity('11');
const peer = entity('22');
const clear = { type: 'j_clear_batch', data: { reason: 'test' } } as const;
const draft = () => ({ ...createEmptyBatch(), reserveToReserve: [{ receivingEntity: peer, tokenId: 1, amount: 10n }] });
const stateWithDraft = () => {
  const state = makeState(self, addr('35'), makeJurisdiction('clear-pending', 31337, 'a1', 'b2'), peer);
  state.jBatchState = {
    batch: draft(),
    jurisdiction: null,
    lastBroadcast: 0,
    broadcastCount: 0,
    failedAttempts: 0,
    status: 'accumulating',
    entityNonce: 1,
  };
  return state;
};

for (const pending of ['sent', 'recovery', 'both'] as const) {
  for (const mutableFrameState of [false, true]) {
    test(`clear rejects ${pending} before any mutation (mutable=${mutableFrameState}) and dispatcher stays live`, async () => {
      const state = stateWithDraft();
      const batchState = state.jBatchState!;
      if (pending !== 'recovery')
        batchState.sentBatch = {
          batch: draft(),
          batchHash: `0x${'44'.repeat(32)}`,
          encodedBatch: '0x',
          entityNonce: 1,
          firstSubmittedAt: 1000,
          lastSubmittedAt: 1000,
          submitAttempts: 1,
        };
      if (pending !== 'sent') batchState.recoveryBatches = [draft()];
      const before = structuredClone(batchState);
      const root = state.accounts.rootHash();
      const env = createEmptyEnv(`clear-${pending}`);
      try {
        await handleJClearBatch(state, clear, env, mutableFrameState);
        throw new Error('Expected a typed reject');
      } catch (error) {
        expect(error).toBeInstanceOf(FailureDispositionError);
        expect(error).toMatchObject({ disposition: 'reject', code: 'J_CLEAR_BATCH_PENDING' });
      }
      const result = await applyEntityTx(env, state, clear, { mutableFrameState });
      expect(result.skippedError).toContain('Cannot clear');
      expect(result.newState).toBe(state);
      expect(result.outputs).toEqual([]);
      expect(result.jOutputs).toEqual([]);
      expect(result.storageChanges).toEqual([]);
      expect(state.jBatchState).toEqual(before);
      expect(state.accounts.rootHash()).toBe(root);
    });
  }
}

test('an unsigned draft still clears without changing the original state or nonce', async () => {
  const state = stateWithDraft();
  const result = await handleJClearBatch(state, clear, createEmptyEnv('clear-draft'));
  expect(result.newState.jBatchState?.batch).toEqual(createEmptyBatch());
  expect(result.newState.jBatchState?.status).toBe('empty');
  expect(result.newState.jBatchState?.entityNonce).toBe(1);
  expect(state.jBatchState?.batch).toEqual(draft());
});
