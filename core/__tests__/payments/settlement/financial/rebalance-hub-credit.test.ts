import { describe, expect, test } from 'bun:test';

import { handleRequestCollateral, rebalanceFeeFor } from '../../../../account/tx/handlers/rebalance/request-collateral';
import { createDefaultDelta } from '../../../../account/state/delta';
import { PersistentAccountStateMap } from '../../../../account/state/persistent-state-map';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
  discardAccountTransition,
  publishAccountOverlay,
} from '../../../../account/state/candidate-overlay';
import type { AccountReplica, AccountTx } from '../../../../types/account';
import type { JurisdictionEvent } from '../../../../types/jurisdiction-events';
import { applyFinalizedAccountJEvents } from '../../../helpers/jurisdiction/account-j-finality';
import { entity, makeAccount } from '../../../helpers/cross-j';

const LEFT = entity('11');
const RIGHT = entity('22');
const HUB_POLICY = { policyVersion: 3, baseFee: 10n, liquidityFeeBps: 100n, gasFee: 5n, updatedAt: 1 };

const accountWithHubPolicy = (policy = HUB_POLICY): AccountReplica => {
  const account = makeAccount(LEFT, RIGHT);
  account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [
    [
      1,
      {
        ...createDefaultDelta(1),
        leftCreditLimit: 10_000n,
        rightCreditLimit: 10_000n,
      },
    ],
  ]);
  // LEFT requests; RIGHT is the hub whose committed policy prices the deposit.
  account.state.rebalanceFeePolicies = PersistentAccountStateMap.fromEntries('rebalanceFeePolicies', [
    [1, { right: policy }],
  ]);
  return account;
};

const request = (
  account: AccountReplica,
  data: Partial<Extract<AccountTx, { type: 'request_collateral' }>['data']>,
) => {
  const tx: Extract<AccountTx, { type: 'request_collateral' }> = {
    type: 'request_collateral',
    data: { tokenId: 1, amount: 1_000n, feeTokenId: 1, feeAmount: 25n, policyVersion: 3, ...data },
  };
  const transition = beginAccountTransition(account);
  const result = handleRequestCollateral(accountTransitionView(transition), tx, true, 5);
  if (!result.ok) {
    discardAccountTransition(transition);
    return result;
  }
  publishAccountOverlay(account, commitAccountTransition(transition).account);
  return result;
};

const settled = (nonce: number, collateral: bigint, ondelta: bigint): JurisdictionEvent =>
  ({
    type: 'AccountSettled',
    data: {
      leftEntity: LEFT,
      rightEntity: RIGHT,
      tokenId: 1,
      leftReserve: '0',
      rightReserve: '0',
      collateral: collateral.toString(),
      ondelta: ondelta.toString(),
      nonce,
    },
  }) as JurisdictionEvent;

describe('rebalance request admission against the hub policy', () => {
  test('request_collateral.rejects_without_a_committed_hub_fee_policy', () => {
    const account = makeAccount(LEFT, RIGHT);
    const result = request(account, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.rejection.message).toContain('hub has no committed fee policy');
    expect(account.state.requestedRebalance.size).toBe(0);
  });

  test('request_collateral.rejects_policy_version_mismatch', () => {
    const account = accountWithHubPolicy();
    const result = request(account, { policyVersion: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.rejection.message).toContain('does not match hub policy v3');
  });

  test('request_collateral.rejects_fee_below_hub_policy_and_accepts_the_exact_fee', () => {
    const account = accountWithHubPolicy();
    // 10 base + 5 gas + 1% of 1000 = 25.
    expect(rebalanceFeeFor(HUB_POLICY, 1_000n)).toBe(25n);
    const low = request(account, { feeAmount: 24n });
    expect(low.ok).toBe(false);
    if (low.ok) throw new Error('expected rejection');
    expect(low.rejection.message).toContain('below hub policy fee 25');
    expect(account.state.deltas.get(1)?.offdelta).toBe(0n);

    const exact = request(account, { feeAmount: 25n });
    expect(exact.ok).toBe(true);
    // Fee is prepaid by LEFT and netted from the same-token request.
    expect(account.state.deltas.get(1)?.offdelta).toBe(-25n);
    expect(account.state.requestedRebalance.get(1)).toBe(975n);
    expect(account.state.requestedRebalanceFeeState.get(1)?.feePaidUpfront).toBe(25n);
  });
});

describe('AccountSettled finality credits only the hub deposit', () => {
  const requested = (): AccountReplica => {
    const account = accountWithHubPolicy();
    expect(request(account, { amount: 200n, feeAmount: 17n }).ok).toBe(true); // 10 + 5 + 2
    expect(account.state.requestedRebalance.get(1)).toBe(183n);
    account.shadow.rebalance.submittedAtByToken = PersistentAccountStateMap.fromEntries('rebalanceShadowSubmitted', [
      [1, 123],
    ]);
    return account;
  };

  test('finality.requester_own_r2c_does_not_consume_the_request', () => {
    const account = requested();
    // LEFT (the requester) deposits 100: collateral +100, LEFT share +100.
    applyFinalizedAccountJEvents(account, RIGHT, [settled(1, 100n, 100n)], `0x${'d1'.repeat(20)}`);
    expect(account.state.requestedRebalance.get(1)).toBe(183n);
    expect(account.state.requestedRebalanceFeeState.has(1)).toBe(true);
    expect(account.shadow.rebalance.submittedAtByToken.get(1)).toBe(123);
  });

  test('finality.hub_r2c_credits_and_clears_the_request', () => {
    const account = requested();
    // RIGHT (the hub) deposits 100: collateral +100, LEFT share unchanged.
    applyFinalizedAccountJEvents(account, RIGHT, [settled(1, 100n, 0n)], `0x${'d1'.repeat(20)}`);
    expect(account.state.requestedRebalance.get(1)).toBe(83n);
    expect(account.shadow.rebalance.submittedAtByToken.has(1)).toBe(false);

    applyFinalizedAccountJEvents(account, RIGHT, [settled(2, 200n, 0n)], `0x${'d1'.repeat(20)}`);
    expect(account.state.requestedRebalance.has(1)).toBe(false);
    expect(account.state.requestedRebalanceFeeState.has(1)).toBe(false);
  });

  test('finality.mixed_settlement_credits_only_the_hub_share_growth', () => {
    const account = requested();
    // Hub deposits 50 while LEFT deposits 30 in the same settlement.
    applyFinalizedAccountJEvents(account, RIGHT, [settled(1, 80n, 30n)], `0x${'d1'.repeat(20)}`);
    expect(account.state.requestedRebalance.get(1)).toBe(133n);
  });
});
