import { describe, expect, test } from 'bun:test';

import { handleRebalanceRefund } from '../account/tx/handlers/rebalance/refund';
import { handleRequestCollateral } from '../account/tx/handlers/rebalance/request-collateral';
import type { AccountReplica } from '../types/account';
import type { RebalanceRequestFeeState } from '../types/finance/rebalance';
import { createDefaultDelta } from '../account/state/delta';
import { entity, makeAccount } from './helpers/cross-j';

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
  replica.state.deltas = new Map([[1, {
    ...createDefaultDelta(1),
    leftCreditLimit: 10_000n,
    rightCreditLimit: 10_000n,
  }]]);
  replica.state.requestedRebalance = new Map([[7, 500n], [8, 500n]]);
  replica.state.requestedRebalanceFeeState = new Map([
    [7, requestState('request-7', 1, 100n)],
    [8, requestState('request-8', 1, 100n)],
  ]);
  replica.shadow.rebalance.submittedAtByToken = new Map([[7, 123], [8, 123]]);
  return replica;
};

describe('rebalance financial transitions', () => {
  test('partial refund preserves exact outstanding request until fully repaid', () => {
    const state = account();
    const partial = handleRebalanceRefund(state, {
      type: 'rebalance_refund',
      data: { requestId: 'request-7', requestTokenId: 7, amount: 1n, reason: 'timeout' },
    }, false);

    expect(partial.success).toBe(true);
    expect(state.state.requestedRebalance.get(7)).toBe(500n);
    expect(state.state.requestedRebalanceFeeState.get(7)?.refund?.refundedAmount).toBe(1n);
    expect(state.state.requestedRebalanceFeeState.get(8)?.refund).toBeUndefined();

    const final = handleRebalanceRefund(state, {
      type: 'rebalance_refund',
      data: { requestId: 'request-7', requestTokenId: 7, amount: 99n, reason: 'timeout' },
    }, false);
    expect(final.success).toBe(true);
    expect(state.state.requestedRebalance.has(7)).toBe(false);
    expect(state.state.requestedRebalanceFeeState.has(7)).toBe(false);
    expect(state.shadow.rebalance.submittedAtByToken.has(7)).toBe(false);
    expect(state.shadow.rebalance.submittedAtByToken.get(8)).toBe(123);
    expect(state.state.requestedRebalance.has(8)).toBe(true);
  });

  test('rejects wrong request and over-refund without mutating balances', () => {
    const state = account();
    const before = state.state.deltas.get(1)?.offdelta;
    const wrong = handleRebalanceRefund(state, {
      type: 'rebalance_refund',
      data: { requestId: 'request-8', requestTokenId: 7, amount: 1n, reason: 'manual' },
    }, false);
    const over = handleRebalanceRefund(state, {
      type: 'rebalance_refund',
      data: { requestId: 'request-7', requestTokenId: 7, amount: 101n, reason: 'manual' },
    }, false);

    expect(wrong.success).toBe(false);
    expect(over.success).toBe(false);
    expect(state.state.deltas.get(1)?.offdelta).toBe(before);
    expect(state.state.requestedRebalanceFeeState.get(7)?.refund).toBeUndefined();
  });

  test('pending request is immutable before any fee mutation', () => {
    const state = account();
    state.state.requestedRebalance = new Map([[1, 100n]]);
    state.state.requestedRebalanceFeeState = new Map([[1, requestState('covered', 1, 10n)]]);
    const delta = state.state.deltas.get(1)!;
    const before = delta.offdelta;

    const result = handleRequestCollateral(state, {
      type: 'request_collateral',
      data: { tokenId: 1, amount: 90n, feeTokenId: 1, feeAmount: 20n, policyVersion: 1 },
    }, true, 5);

    expect(result.success).toBe(true);
    expect(delta.offdelta).toBe(before);
    expect(state.state.requestedRebalanceFeeState.get(1)?.feePaidUpfront).toBe(10n);
  });
});
