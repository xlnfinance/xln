import { expect, test } from 'bun:test';
import { withdrawableCollateral } from '../../../frontend/src/lib/components/Entity/move-routes';
import { getHubOpeningCredit, getOpenAccountRebalancePolicyData } from '../../../frontend/src/lib/utils/onboarding/onboardingPreferences';

test('collateral withdrawals never spend unsecured capacity or funds already held', () => {
  expect(withdrawableCollateral({ outCollateral: 0n, outTotalHold: 0n })).toBe(0n);
  expect(withdrawableCollateral({ outCollateral: 100n, outTotalHold: 30n })).toBe(70n);
  expect(withdrawableCollateral({ outCollateral: 100n, outTotalHold: 120n })).toBe(0n);
});

test('hub onboarding uses the reference credit and autopilot defaults at token precision', () => {
  expect(getHubOpeningCredit(6)).toBe(10_000_000_000n);
  expect(getHubOpeningCredit(18)).toBe(10_000n * 10n ** 18n);
  expect(getOpenAccountRebalancePolicyData(6)).toEqual({ r2cRequestSoftLimit: 500_000_000n, hardLimit: 10_000_000_000n, maxAcceptableFee: 15_000_000n });
  expect(() => getHubOpeningCredit(-1)).toThrow('ONBOARDING_TOKEN_DECIMALS_INVALID');
});
