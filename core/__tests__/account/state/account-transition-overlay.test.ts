import { describe, expect, test } from 'bun:test';

import { makeAccount } from '../../helpers/cross-j';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
  discardAccountTransition,
} from '../../../account/state/candidate-overlay';
import { computeAccountStateRootCold } from '../../../account/commitment/state-root';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import type { AccountReplica } from '../../../types/account';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;

const makePersistentAccount = (): AccountReplica => {
  const account = makeAccount(LEFT, RIGHT);
  // Historical swap rows belong to the certified frame-history store, never
  // the live Account replica exercised by this transition test.
  account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', account.state.deltas);
  account.state.locks = PersistentAccountStateMap.fromEntries('locks', account.state.locks);
  account.state.swapOffers = PersistentAccountStateMap.fromEntries('swapOffers', account.state.swapOffers);
  account.state.requestedRebalance = PersistentAccountStateMap.fromEntries(
    'requestedRebalance',
    account.state.requestedRebalance,
  );
  account.state.requestedRebalanceFeeState = PersistentAccountStateMap.fromEntries(
    'requestedRebalanceFeeState',
    account.state.requestedRebalanceFeeState,
  );
  if (account.state.pulls) {
    account.state.pulls = PersistentAccountStateMap.fromEntries('pulls', account.state.pulls);
  }
  account.pendingWithdrawals = PersistentAccountStateMap.fromEntries(
    'pendingWithdrawals',
    account.pendingWithdrawals,
  );
  account.shadow.rebalance.policy = PersistentAccountStateMap.fromEntries(
    'rebalanceShadowPolicy',
    account.shadow.rebalance.policy,
  );
  account.shadow.rebalance.submittedAtByToken = PersistentAccountStateMap.fromEntries(
    'rebalanceShadowSubmitted',
    account.shadow.rebalance.submittedAtByToken,
  );
  return account;
};

describe('Account transition overlay', () => {
  test('seals a dirty key while preserving the committed Patricia root', () => {
    const base = makePersistentAccount();
    const baseRoot = computeAccountStateRootCold(base.state);
    const transition = beginAccountTransition(base);
    const view = accountTransitionView(transition);
    const delta = view.state.deltas.get(1);
    if (!delta) throw new Error('TEST_DELTA_MISSING');
    const expectedOffdelta = delta.offdelta + 7n;
    view.state.deltas.edit(1, previous => ({ ...previous, offdelta: expectedOffdelta }));

    const committed = commitAccountTransition(transition);
    expect(committed.account.state.deltas).not.toBe(base.state.deltas);
    expect(base.state.deltas.get(1)?.offdelta).not.toBe(expectedOffdelta);
    expect(computeAccountStateRootCold(base.state)).toBe(baseRoot);
    expect(committed.accountStateRoot).toBe(computeAccountStateRootCold(committed.account.state));
    expect(committed.nodeChanges.deltas.puts.length).toBeGreaterThan(0);
    expect(committed.nodeChanges.deltas.puts.length).toBeLessThan(70);
    expect(committed.nodeChanges.locks.puts).toHaveLength(0);
    expect(committed.nodeChanges.locks.dels).toHaveLength(0);
  });

  test('discard preserves the exact committed root', () => {
    const base = makePersistentAccount();
    const before = computeAccountStateRootCold(base.state);
    const transition = beginAccountTransition(base);
    accountTransitionView(transition).state.locks.reset();
    discardAccountTransition(transition);
    expect(computeAccountStateRootCold(base.state)).toBe(before);
    expect(() => accountTransitionView(transition)).toThrow('ACCOUNT_TRANSITION_OVERLAY_NOT_ACTIVE:discarded');
  });

  test('retains nested writes below a newly assigned optional record', () => {
    const base = makePersistentAccount();
    const transition = beginAccountTransition(base);
    const view = accountTransitionView(transition);
    view.disputePrepare = {
      startedAt: 1,
      readyAfter: 2,
      reason: 'test',
      startIntent: { description: 'before' },
    };
    view.disputePrepare.startIntent!.description = 'after';

    const committed = commitAccountTransition(transition).account;
    expect(committed.disputePrepare?.startIntent?.description).toBe('after');
    expect(base.disputePrepare).toBeUndefined();
  });

  test('late collection failure preserves its cause and leaves the base untouched', () => {
    const base = makePersistentAccount();
    const before = computeAccountStateRootCold(base.state);
    const transition = beginAccountTransition(base);
    const view = accountTransitionView(transition);
    view.state.deltas.edit(1, previous => ({ ...previous, offdelta: 1n }));
    view.state.locks.put('oversized', {
      lockId: 'oversized',
      hashlock: `0x${'11'.repeat(32)}`,
      timelock: 1n,
      revealBeforeHeight: 1,
      amount: 1n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 1,
      createdTimestamp: 1,
      envelopeHash: 'x'.repeat(12 * 1024),
    });

    expect(() => commitAccountTransition(transition))
      .toThrow('ACCOUNT_STATE_LEAF_TOO_LARGE');
    expect(() => discardAccountTransition(transition)).not.toThrow();
    expect(computeAccountStateRootCold(base.state)).toBe(before);
    expect(base.state.locks.has('oversized')).toBe(false);
  });
});
