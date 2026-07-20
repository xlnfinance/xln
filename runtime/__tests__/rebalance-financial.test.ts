import { describe, expect, test } from 'bun:test';

import { handleRebalanceRefund } from '../account/tx/handlers/rebalance-refund';
import { handleRequestCollateral } from '../account/tx/handlers/request-collateral';
import type { AccountMachine, RebalanceRequestFeeState } from '../types';
import { createDefaultDelta } from '../validation-utils';

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

const account = (): AccountMachine => ({
  currentHeight: 4,
  deltas: new Map([[1, {
    ...createDefaultDelta(1),
    leftCreditLimit: 10_000n,
    rightCreditLimit: 10_000n,
  }]]),
  requestedRebalance: new Map([[7, 500n], [8, 500n]]),
  requestedRebalanceFeeState: new Map([
    [7, requestState('request-7', 1, 100n)],
    [8, requestState('request-8', 1, 100n)],
  ]),
}) as unknown as AccountMachine;

describe('rebalance financial transitions', () => {
  test('partial refund preserves exact outstanding request until fully repaid', () => {
    const state = account();
    const partial = handleRebalanceRefund(state, {
      type: 'rebalance_refund',
      data: { requestId: 'request-7', requestTokenId: 7, amount: 1n, reason: 'timeout' },
    }, false);

    expect(partial.success).toBe(true);
    expect(state.requestedRebalance.get(7)).toBe(500n);
    expect(state.requestedRebalanceFeeState.get(7)?.refund?.refundedAmount).toBe(1n);
    expect(state.requestedRebalanceFeeState.get(8)?.refund).toBeUndefined();

    const final = handleRebalanceRefund(state, {
      type: 'rebalance_refund',
      data: { requestId: 'request-7', requestTokenId: 7, amount: 99n, reason: 'timeout' },
    }, false);
    expect(final.success).toBe(true);
    expect(state.requestedRebalance.has(7)).toBe(false);
    expect(state.requestedRebalanceFeeState.has(7)).toBe(false);
    expect(state.requestedRebalance.has(8)).toBe(true);
  });

  test('rejects wrong request and over-refund without mutating balances', () => {
    const state = account();
    const before = state.deltas.get(1)?.offdelta;
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
    expect(state.deltas.get(1)?.offdelta).toBe(before);
    expect(state.requestedRebalanceFeeState.get(7)?.refund).toBeUndefined();
  });

  test('covered request is a true no-op before fee top-up mutation', () => {
    const state = account();
    state.requestedRebalance = new Map([[1, 100n]]);
    state.requestedRebalanceFeeState = new Map([[1, requestState('covered', 1, 10n)]]);
    const delta = state.deltas.get(1)!;
    const before = delta.offdelta;

    const result = handleRequestCollateral(state, {
      type: 'request_collateral',
      data: { tokenId: 1, amount: 90n, feeTokenId: 1, feeAmount: 20n, policyVersion: 1 },
    }, true, 5);

    expect(result.success).toBe(true);
    expect(delta.offdelta).toBe(before);
    expect(state.requestedRebalanceFeeState.get(1)?.feePaidUpfront).toBe(10n);
  });
});
