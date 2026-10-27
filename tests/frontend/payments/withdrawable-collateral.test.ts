import { expect, test } from 'bun:test';
import { withdrawableCollateral } from '../../../frontend/src/lib/components/Entity/move-routes';
import { getHubOpeningCredit, getOpenAccountRebalancePolicyData } from '../../../frontend/src/lib/utils/onboarding/onboardingPreferences';

test('collateral withdrawals never spend unsecured capacity or funds already held', () => {
  expect(withdrawableCollateral({ outCollateral: 0n, outTotalHold: 0n })).toBe(0n);
  expect(withdrawableCollateral({ outCollateral: 100n, outTotalHold: 30n })).toBe(70n);
  expect(withdrawableCollateral({ outCollateral: 100n, outTotalHold: 120n })).toBe(0n);
});

test('hub onboarding uses the reference credit and autopilot defaults at token precision', () => {
  expect(getHubOpeningCredit(1)).toBe(10_000_000_000n);
  expect(getHubOpeningCredit(2)).toBe(4n * 10n ** 18n);
  expect(getOpenAccountRebalancePolicyData(1)).toEqual({ r2cRequestSoftLimit: 500_000_000n, hardLimit: 10_000_000_000n, maxAcceptableFee: 15_000_000n });
  expect(getOpenAccountRebalancePolicyData(2)).toEqual({ r2cRequestSoftLimit: 2n * 10n ** 17n, hardLimit: 4n * 10n ** 18n, maxAcceptableFee: 6n * 10n ** 15n });
  expect(() => getHubOpeningCredit(-1)).toThrow('TOKEN_USD_RATE_UNAVAILABLE');
});
