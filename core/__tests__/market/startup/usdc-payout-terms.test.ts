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

  expect(() => requirePayoutTerms(account, true, 950_000n, 1)).toThrow('net=849905');
  expect(() => requirePayoutTerms(account, true, 950_094n, 1)).toThrow('net=849999');
  expect(requirePayoutTerms(account, true, 950_095n, 1).net).toBe(850_000n);
  expect(requirePayoutTerms(account, true, 999_900n, 1)).toMatchObject({ fee: 100_099n, net: 899_801n });
  expect(() => requirePayoutTerms(account, false, 999_900n, 1)).toThrow('USDC_POC_SIGNED_TARIFF_MISSING');
});

test('pricing rejects a signed increase effective at the next Account frame or during the authorized payout window', () => {
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
  expect(requirePayoutTerms(account, false, 999_900n, scheduled.effectiveAt - 1).policy.policyVersion).toBe(1);
  expect(() => requirePayoutTerms(account, false, 999_900n, scheduled.effectiveAt)).toThrow('net=799801');
  expect(() => requirePayoutTerms(account, false, 999_900n, scheduled.effectiveAt - 1, scheduled.effectiveAt)).toThrow(
    'net=799801',
  );
});
