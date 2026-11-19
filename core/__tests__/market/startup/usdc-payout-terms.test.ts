import { expect, test } from 'bun:test';
import { announcedRebalancePolicy } from '../../../account/config/term-notice';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { requirePayoutTerms } from '../../../scenarios/usdc-poc/journey/payout-terms';
import { entity, makeAccount } from '../../helpers/cross-j';

const terms = {
  policyVersion: 1,
  baseFee: 100_000n,
  gasFee: 0n,
  liquidityFeeBps: 1n,
  updatedAt: 1,
  noticePeriodSeconds: 86_400,
};

test('Cross-J payout pricing includes the signed Hub fee at the exact minimum', () => {
  const account = makeAccount(entity('11'), entity('22'));
  account.state.rebalanceFeePolicies = PersistentAccountStateMap.fromEntries('rebalanceFeePolicies', [
    [1, { right: announcedRebalancePolicy(undefined, terms) }],
  ]);

  expect(() => requirePayoutTerms(account, true, 950_000n)).toThrow('net=849905');
  expect(() => requirePayoutTerms(account, true, 950_094n)).toThrow('net=849999');
  expect(requirePayoutTerms(account, true, 950_095n).net).toBe(850_000n);
  expect(requirePayoutTerms(account, true, 999_900n)).toMatchObject({ fee: 100_099n, net: 899_801n });
  expect(() => requirePayoutTerms(account, false, 999_900n)).toThrow('USDC_POC_SIGNED_TARIFF_MISSING');
});

test('the committed Account frame selects the active tariff on the Hub side', () => {
  const account = makeAccount(entity('22'), entity('11'));
  const active = announcedRebalancePolicy(undefined, terms);
  const scheduled = announcedRebalancePolicy(active, {
    ...terms,
    policyVersion: 2,
    baseFee: 200_000n,
    updatedAt: 2,
  });
  account.state.rebalanceFeePolicies = PersistentAccountStateMap.fromEntries('rebalanceFeePolicies', [
    [1, { left: scheduled }],
  ]);

  account.currentFrame.timestamp = scheduled.effectiveAt - 1;
  expect(requirePayoutTerms(account, false, 999_900n).policy.policyVersion).toBe(1);
  account.currentFrame.timestamp = scheduled.effectiveAt;
  expect(() => requirePayoutTerms(account, false, 999_900n)).toThrow('net=799801');
});
