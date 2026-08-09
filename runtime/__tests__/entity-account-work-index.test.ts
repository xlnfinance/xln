import { describe, expect, test } from 'bun:test';

import {
  getProposableAccountIds,
  getPendingAccountIds,
  getQueuedAccountIds,
  getRebalanceAccountIds,
  hasProposableAccount,
  refreshAccountWorkIndex,
} from '../entity/consensus/account-work-index';
import { hasEntityLeaderWork } from '../entity/consensus/leader';
import type { EntityReplica } from '../entity/types';
import { cloneEntityState } from '../entity/state-clone';
import {
  entity,
  makeJurisdiction,
  makeState,
} from './helpers/cross-j';

describe('Entity Account work indexes', () => {
  test('tracks only touched queued/pending Accounts and forks independently', () => {
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
      data: {
        tokenId: 1,
        amount: 1n,
        route: [self],
        deliveryMode: 'direct',
        fromEntityId: self,
        toEntityId: counterparty,
      },
    });
    refreshAccountWorkIndex(state, counterparty);

    expect([...getQueuedAccountIds(state)]).toEqual([counterparty]);
    expect(getProposableAccountIds(state)).toEqual([counterparty]);
    expect(hasProposableAccount(state)).toBe(true);
    const pendingFrame = {
      ...account.currentFrame,
      height: 1,
      timestamp: 1,
      prevFrameHash: 'genesis',
      stateHash: `0x${'22'.repeat(32)}`,
    };
    account.pendingFrame = pendingFrame;
    account.pendingAccountInput = {
      kind: 'frame',
      fromEntityId: self,
      toEntityId: counterparty,
      domain: account.state.domain,
      proposal: {
        frame: pendingFrame,
        disputeSeal: {
          hash: `0x${'33'.repeat(32)}`,
          proofBodyHash: `0x${'44'.repeat(32)}`,
          proofNonce: 1,
        },
      },
    };
    account.state.requestedRebalance.set(1, 10n);
    refreshAccountWorkIndex(state, counterparty);
    expect([...getPendingAccountIds(state)]).toEqual([counterparty]);
    expect([...getRebalanceAccountIds(state)]).toEqual([counterparty]);

    const candidate = cloneEntityState(state);
    candidate.accounts.get(counterparty)!.mempool = [];
    candidate.accounts.get(counterparty)!.pendingFrame = undefined;
    candidate.accounts.get(counterparty)!.pendingAccountInput = undefined;
    candidate.accounts.get(counterparty)!.state.requestedRebalance.clear();
    refreshAccountWorkIndex(candidate, counterparty);

    expect([...getQueuedAccountIds(candidate)]).toEqual([]);
    expect([...getPendingAccountIds(candidate)]).toEqual([]);
    expect([...getRebalanceAccountIds(candidate)]).toEqual([]);
    expect([...getQueuedAccountIds(state)]).toEqual([counterparty]);
    expect([...getPendingAccountIds(state)]).toEqual([counterparty]);
    expect([...getRebalanceAccountIds(state)]).toEqual([counterparty]);
  });

  test('leader liveness never scans the Account map after index warmup', () => {
    const self = entity('31');
    const counterparty = entity('32');
    const state = makeState(
      self,
      'validator',
      makeJurisdiction('leader-work-index', 31_337, 'ca', 'cb'),
      counterparty,
    );
    let iterations = 0;
    class CountingAccountMap extends Map<string, typeof state.accounts extends Map<string, infer V> ? V : never> {
      override *[Symbol.iterator](): MapIterator<[string, typeof state.accounts extends Map<string, infer V> ? V : never]> {
        iterations += 1;
        yield* super[Symbol.iterator]();
      }
    }
    state.accounts = new CountingAccountMap(state.accounts);
    getQueuedAccountIds(state);
    getPendingAccountIds(state);
    iterations = 0;

    const replica = { state, mempool: [] } as EntityReplica;
    expect(hasEntityLeaderWork(replica)).toBe(false);
    expect(iterations).toBe(0);

    state.accounts.get(counterparty)!.mempool.push({
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 1n,
        route: [self],
        deliveryMode: 'direct',
        fromEntityId: self,
        toEntityId: counterparty,
      },
    });
    refreshAccountWorkIndex(state, counterparty);
    expect(hasEntityLeaderWork(replica)).toBe(true);
    expect(iterations).toBe(0);
  });
});
