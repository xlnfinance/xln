import { describe, expect, test } from 'bun:test';

import {
  getProposableAccountIds,
  getQueuedAccountIds,
  hasProposableAccount,
  refreshQueuedAccountIndex,
} from '../entity/consensus/account-work-index';
import { cloneEntityState } from '../entity/state-clone';
import {
  entity,
  makeJurisdiction,
  makeState,
} from './helpers/cross-j';

describe('Entity queued Account index', () => {
  test('tracks only touched queues and forks independently into a candidate', () => {
    const self = entity('11');
    const counterparty = entity('22');
    const state = makeState(
      self,
      'validator',
      makeJurisdiction('account-work-index', 31_337, 'aa', 'bb'),
      counterparty,
    );

    expect([...getQueuedAccountIds(state)]).toEqual([]);
    const account = state.accounts.get(counterparty)!;
    account.mempool.push({
      type: 'direct_payment',
      data: { tokenId: 1, amount: 1n },
    });
    refreshQueuedAccountIndex(state, counterparty);

    expect([...getQueuedAccountIds(state)]).toEqual([counterparty]);
    expect(getProposableAccountIds(state)).toEqual([counterparty]);
    expect(hasProposableAccount(state)).toBe(true);

    const candidate = cloneEntityState(state);
    candidate.accounts.get(counterparty)!.mempool = [];
    refreshQueuedAccountIndex(candidate, counterparty);

    expect([...getQueuedAccountIds(candidate)]).toEqual([]);
    expect([...getQueuedAccountIds(state)]).toEqual([counterparty]);
  });
});
