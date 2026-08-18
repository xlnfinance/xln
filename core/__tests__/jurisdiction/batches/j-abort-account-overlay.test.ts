import { expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { createEmptyBatch } from '../../../jurisdiction/machine/batch';
import { handleJAbortSentBatch } from '../../../entity/tx/handlers/j-batch/j-abort-sent-batch';
import { makeAccount, makeJurisdiction, makeState, entity } from '../../helpers/cross-j';

test('aborting a finalize claims an Account overlay without mutating the certified base', async () => {
  const entityId = entity('31');
  const counterpartyId = entity('32');
  const signerId = `0x${'33'.repeat(20)}`;
  const state = makeState(entityId, signerId, makeJurisdiction('abort-overlay', 31_337, '34', '35'));
  const account = makeAccount(entityId, counterpartyId);
  account.activeDispute = {
    startedByLeft: true,
    disputeTimeout: 1_700_000_123,
    disputeStartTimestamp: 1_700_000_000,
    initialProofbodyHash: `0x${'36'.repeat(32)}`,
    initialNonce: 5,
    finalizeQueued: true,
  };
  state.accounts = state.accounts.updated(counterpartyId, account);
  const certifiedAccount = state.accounts.get(counterpartyId);
  const certifiedRoot = state.accounts.rootHash();
  state.jBatchState = {
    batch: createEmptyBatch(),
    jurisdiction: null,
    lastBroadcast: 0,
    broadcastCount: 0,
    failedAttempts: 0,
    status: 'sent',
    sentBatch: {
      batch: {
        ...createEmptyBatch(),
        disputeFinalizations: [{
          counterentity: counterpartyId,
          initialNonce: 5,
          finalNonce: 5,
          initialProofbodyHash: `0x${'36'.repeat(32)}`,
          finalProofbody: {
            watchSeed: `0x${'37'.repeat(32)}`,
            leftResponseSeconds: 10,
            rightResponseSeconds: 10,
            offdeltas: [],
            tokenIds: [],
            transformers: [],
          },
          starterArguments: '0x',
          otherArguments: '0x',
          sig: '0x',
          startedByLeft: true,
          cooperative: false,
        }],
      },
      batchHash: `0x${'38'.repeat(32)}`,
      encodedBatch: '0x',
      entityNonce: 1,
      firstSubmittedAt: 1_000,
      lastSubmittedAt: 1_000,
    },
  };

  const result = await handleJAbortSentBatch(
    state,
    {
      type: 'j_abort_sent_batch',
      data: { reason: 'submit_failed', requeueToCurrent: true },
    },
    createEmptyEnv('j-abort-account-overlay'),
  );

  expect(certifiedAccount?.activeDispute?.finalizeQueued).toBe(true);
  expect(state.accounts.rootHash()).toBe(certifiedRoot);
  expect(result.newState.accounts.get(counterpartyId)?.activeDispute?.finalizeQueued).toBe(false);
  expect(result.newState.accounts.rootHash()).not.toBe(certifiedRoot);
  expect(result.newState.jBatchState?.batch.disputeFinalizations).toEqual([]);
});
