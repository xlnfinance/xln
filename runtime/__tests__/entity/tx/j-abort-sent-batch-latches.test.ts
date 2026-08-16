import { describe, expect, test } from 'bun:test';

import { handleJAbortSentBatch } from '../../../entity/tx/handlers/jurisdiction/j-abort-sent-batch';
import { createEmptyBatch } from '../../../jurisdiction/machine/batch';
import { createEmptyEnv } from '../../../runtime';
import { addr, entity, makeJurisdiction, makeState } from '../../helpers/cross-j';
import { EntityAccountCandidateMap } from '../../../entity/state/persistent-account-map';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { requirePersistentAccountStateMap } from '../../../account/state/persistent-state-map';

const LEFT = entity('11');
const RIGHT = entity('22');

const sentR2CBatch = () => ({
  batch: {
    ...createEmptyBatch(),
    reserveToCollateral: [{
      tokenId: 1,
      receivingEntity: LEFT,
      pairs: [{ entity: RIGHT, amount: 10n }],
    }],
  },
  batchHash: `0x${'44'.repeat(32)}`,
  encodedBatch: '0x',
  entityNonce: 1,
  firstSubmittedAt: 1_000,
  lastSubmittedAt: 1_000,
  submitAttempts: 1,
});

const abortState = () => {
  const state = makeState(LEFT, addr('35'), makeJurisdiction('abort-latch', 31337, 'a1', 'b2'), RIGHT);
  if (!(state.accounts instanceof PersistentEntityAccountMap)) throw new Error('TEST_ACCOUNTS_NOT_PERSISTENT');
  const accounts = new EntityAccountCandidateMap(state.accounts);
  const account = accounts.getForWrite(RIGHT);
  if (!account) throw new Error('TEST_ACCOUNT_MISSING');
  account.shadow.rebalance.submittedAtByToken = requirePersistentAccountStateMap(
    account.shadow.rebalance.submittedAtByToken,
    'rebalanceShadowSubmitted',
  ).updated(1, 123).updated(2, 456);
  state.accounts = accounts.sealCandidate();
  state.jBatchState = {
    batch: createEmptyBatch(),
    jurisdiction: null,
    lastBroadcast: 0,
    broadcastCount: 0,
    failedAttempts: 0,
    status: 'sent',
    sentBatch: sentR2CBatch(),
    entityNonce: 1,
  };
  return state;
};

describe('j_abort_sent_batch R2C latches', () => {
  test('requeue keeps submittedAt so the scheduler cannot draft a duplicate R2C', async () => {
    const result = await handleJAbortSentBatch(
      abortState(),
      { type: 'j_abort_sent_batch', data: { requeueToCurrent: true, reason: 'stale' } },
      createEmptyEnv('abort-requeue-latch'),
    );
    const account = result.newState.accounts.get(RIGHT)!;
    expect(account.shadow.rebalance.submittedAtByToken.get(1)).toBe(123);
    expect(result.newState.jBatchState?.recoveryBatches?.[0]?.reserveToCollateral).toEqual([{
      tokenId: 1,
      receivingEntity: LEFT,
      pairs: [{ entity: RIGHT, amount: 10n }],
    }]);
  });

  test('drop releases only the aborted R2C token latch', async () => {
    const result = await handleJAbortSentBatch(
      abortState(),
      { type: 'j_abort_sent_batch', data: { requeueToCurrent: false, reason: 'drop' } },
      createEmptyEnv('abort-drop-latch'),
    );
    const account = result.newState.accounts.get(RIGHT)!;
    expect(account.shadow.rebalance.submittedAtByToken.get(1)).toBeUndefined();
    expect(account.shadow.rebalance.submittedAtByToken.get(2)).toBe(456);
    expect(result.newState.jBatchState?.batch.reserveToCollateral).toEqual([]);
  });
});
