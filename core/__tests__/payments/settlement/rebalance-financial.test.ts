import { describe, expect, test } from 'bun:test';

import { handleRebalanceRefund } from '../../../account/tx/handlers/rebalance/refund';
import { handleRequestCollateral } from '../../../account/tx/handlers/rebalance/request-collateral';
import type { AccountReplica, AccountTx } from '../../../types/account';
import type { RebalanceRequestFeeState } from '../../../types/finance/rebalance';
import { createDefaultDelta } from '../../../account/state/delta';
import { INT512_MAX, INT512_MIN, UINT256_MAX } from '../../../protocol/boundary/integer-ranges';
import { entity, makeAccount } from '../../helpers/cross-j';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
  discardAccountTransition,
  publishAccountOverlay,
} from '../../../account/state/candidate-overlay';

const requestState = (
  requestId: string,
  feeTokenId: number,
  feePaidUpfront: bigint,
  requestedByLeft = true,
): RebalanceRequestFeeState => ({
  requestId,
  feeTokenId,
  feePaidUpfront,
  requestedAmount: 500n,
  policyVersion: 1,
  requestedAt: 1,
  requestedByLeft,
});

const account = (): AccountReplica => {
  const replica = makeAccount(entity('11'), entity('22'));
  replica.currentHeight = 4;
  replica.state.rebalanceFeePolicies = PersistentAccountStateMap.fromEntries('rebalanceFeePolicies', [
    [
      1,
      {
        right: { policyVersion: 1, baseFee: 1n, liquidityFeeBps: 0n, gasFee: 0n, updatedAt: 1 },
      },
    ],
  ]);
  replica.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [
    [
      1,
      {
        ...createDefaultDelta(1),
        leftCreditLimit: 10_000n,
        rightCreditLimit: 10_000n,
      },
    ],
  ]);
  replica.state.locks = PersistentAccountStateMap.fromEntries('locks', replica.state.locks);
  replica.state.swapOffers = PersistentAccountStateMap.fromEntries('swapOffers', replica.state.swapOffers);
  replica.state.pulls = PersistentAccountStateMap.fromEntries('pulls', replica.state.pulls ?? []);
  replica.state.requestedRebalance = PersistentAccountStateMap.fromEntries('requestedRebalance', [
    [7, 500n],
    [8, 500n],
  ]);
  replica.state.requestedRebalanceFeeState = PersistentAccountStateMap.fromEntries('requestedRebalanceFeeState', [
    [7, requestState('request-7', 1, 100n)],
    [8, requestState('request-8', 1, 100n)],
  ]);
  replica.shadow.rebalance.submittedAtByToken = PersistentAccountStateMap.fromEntries('rebalanceShadowSubmitted', [
    [7, 123],
    [8, 123],
  ]);
  return replica;
};

const applyOnDraft = <T extends AccountTx>(
  replica: AccountReplica,
  tx: T,
  apply: (draft: ReturnType<typeof accountTransitionView>) => ReturnType<typeof handleRebalanceRefund>,
): ReturnType<typeof handleRebalanceRefund> => {
  const transition = beginAccountTransition(replica);
  const result = apply(accountTransitionView(transition));
  if (!result.ok) {
    discardAccountTransition(transition);
    return result;
  }
  publishAccountOverlay(replica, commitAccountTransition(transition).account);
  return result;
};

describe('rebalance financial transitions', () => {
  test('rebalance_refund rejects overflow before consuming request, refund evidence or submission marker', () => {
    const base = account();
    base.state.deltas = base.state.deltas.updated(1, {
      ...createDefaultDelta(1),
      offdelta: INT512_MAX,
      // Keep spendable capacity positive so rejection reaches representation validation.
      ondelta: -INT512_MAX,
      rightCreditLimit: UINT256_MAX,
    });
    const transition = beginAccountTransition(base);
    const draft = accountTransitionView(transition);
    const result = handleRebalanceRefund(
      draft,
      {
        type: 'rebalance_refund',
        data: { requestId: 'request-7', requestTokenId: 7, amount: 1n, reason: 'timeout' },
      },
      false,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refund overflow rejection');
    expect(result.rejection.message).toContain('Offdelta outside int512:');
    expect([...draft.state.deltas]).toEqual([...base.state.deltas]);
    expect([...draft.state.requestedRebalance]).toEqual([...base.state.requestedRebalance]);
    expect([...draft.state.requestedRebalanceFeeState]).toEqual([...base.state.requestedRebalanceFeeState]);
    expect([...draft.shadow.rebalance.submittedAtByToken]).toEqual([...base.shadow.rebalance.submittedAtByToken]);
    discardAccountTransition(transition);
  });

  test('request_collateral rejects fee overflow before charging or opening the request', () => {
    const base = account();
    base.state.deltas = base.state.deltas.updated(1, {
      ...createDefaultDelta(1),
      offdelta: INT512_MIN,
      // Net delta is -1; the one-unit fee overflows offdelta, not available credit.
      ondelta: INT512_MAX,
      leftCreditLimit: UINT256_MAX,
    });
    const transition = beginAccountTransition(base);
    const draft = accountTransitionView(transition);
    const result = handleRequestCollateral(
      draft,
      {
        type: 'request_collateral',
        data: { tokenId: 1, amount: 500n, feeAmount: 1n, policyVersion: 1 },
      },
      true,
      5,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected collateral fee overflow rejection');
    expect(result.rejection.message).toContain('Offdelta outside int512:');
    expect([...draft.state.deltas]).toEqual([...base.state.deltas]);
    expect([...draft.state.requestedRebalance]).toEqual([...base.state.requestedRebalance]);
    expect([...draft.state.requestedRebalanceFeeState]).toEqual([...base.state.requestedRebalanceFeeState]);
    discardAccountTransition(transition);
  });

  test('partial refund preserves exact outstanding request until fully repaid', () => {
    const state = account();
    const partialTx = {
      type: 'rebalance_refund',
      data: { requestId: 'request-7', requestTokenId: 7, amount: 1n, reason: 'timeout' },
    } as const;
    const partial = applyOnDraft(state, partialTx, draft => handleRebalanceRefund(draft, partialTx, false));

    expect(partial.ok).toBe(true);
    expect(state.state.requestedRebalance.get(7)).toBe(500n);
    expect(state.state.requestedRebalanceFeeState.get(7)?.refund?.refundedAmount).toBe(1n);
    expect(state.state.requestedRebalanceFeeState.get(8)?.refund).toBeUndefined();

    const finalTx = {
      type: 'rebalance_refund',
      data: { requestId: 'request-7', requestTokenId: 7, amount: 99n, reason: 'timeout' },
    } as const;
    const final = applyOnDraft(state, finalTx, draft => handleRebalanceRefund(draft, finalTx, false));
    expect(final.ok).toBe(true);
    expect(state.state.requestedRebalance.has(7)).toBe(false);
    expect(state.state.requestedRebalanceFeeState.has(7)).toBe(false);
    expect(state.shadow.rebalance.submittedAtByToken.has(7)).toBe(false);
    expect(state.shadow.rebalance.submittedAtByToken.get(8)).toBe(123);
    expect(state.state.requestedRebalance.has(8)).toBe(true);
  });

  test('rejects wrong request and over-refund without mutating balances', () => {
    const state = account();
    const before = state.state.deltas.get(1)?.offdelta;
    const wrongTx = {
      type: 'rebalance_refund',
      data: { requestId: 'request-8', requestTokenId: 7, amount: 1n, reason: 'manual' },
    } as const;
    const wrong = applyOnDraft(state, wrongTx, draft => handleRebalanceRefund(draft, wrongTx, false));
    const overTx = {
      type: 'rebalance_refund',
      data: { requestId: 'request-7', requestTokenId: 7, amount: 101n, reason: 'manual' },
    } as const;
    const over = applyOnDraft(state, overTx, draft => handleRebalanceRefund(draft, overTx, false));

    expect(wrong.ok).toBe(false);
    expect(over.ok).toBe(false);
    expect(state.state.deltas.get(1)?.offdelta).toBe(before);
    expect(state.state.requestedRebalanceFeeState.get(7)?.refund).toBeUndefined();
  });

  test('pending request is immutable before any fee mutation', () => {
    const state = account();
    state.state.requestedRebalance = PersistentAccountStateMap.fromEntries('requestedRebalance', [[1, 100n]]);
    state.state.requestedRebalanceFeeState = PersistentAccountStateMap.fromEntries('requestedRebalanceFeeState', [
      [1, requestState('covered', 1, 10n)],
    ]);
    const delta = state.state.deltas.get(1)!;
    const before = delta.offdelta;

    const requestTx = {
      type: 'request_collateral',
      data: { tokenId: 1, amount: 90n, feeTokenId: 1, feeAmount: 20n, policyVersion: 1 },
    } as const;
    const result = applyOnDraft(state, requestTx, draft => handleRequestCollateral(draft, requestTx, true, 5));

    expect(result.ok).toBe(true);
    expect(delta.offdelta).toBe(before);
    expect(state.state.requestedRebalanceFeeState.get(1)?.feePaidUpfront).toBe(10n);
  });
});
