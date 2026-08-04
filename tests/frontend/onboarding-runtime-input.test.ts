import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  assertCommittedAutoJoinCount,
  buildOnboardingHubOpenRuntimeInput,
  buildOnboardingProfileRuntimeInput,
  selectAdvertisedAutoJoinCandidates,
} from '../../frontend/src/lib/components/Entity/onboarding-runtime-input';
import { getOpenAccountRebalancePolicyData } from '../../frontend/src/lib/utils/onboardingPreferences';

const ENTITY = `0x${'11'.repeat(32)}`;
const SIGNER = `0x${'22'.repeat(20)}`;
const HUB_A = `0x${'33'.repeat(32)}`;
const HUB_B = `0x${'44'.repeat(32)}`;
const REBALANCE_POLICY = {
  r2cRequestSoftLimit: 100n,
  hardLimit: 200n,
  maxAcceptableFee: 3n,
};

test('onboarding policy converts human defaults to trusted token raw units', () => {
  expect(getOpenAccountRebalancePolicyData(6)).toEqual({
    r2cRequestSoftLimit: 500n * 10n ** 6n,
    hardLimit: 10_000n * 10n ** 6n,
    maxAcceptableFee: 15n * 10n ** 6n,
  });
  expect(getOpenAccountRebalancePolicyData(18)).toEqual({
    r2cRequestSoftLimit: 500n * 10n ** 18n,
    hardLimit: 10_000n * 10n ** 18n,
    maxAcceptableFee: 15n * 10n ** 18n,
  });
  expect(() => getOpenAccountRebalancePolicyData(Number.NaN))
    .toThrow('ONBOARDING_TOKEN_DECIMALS_INVALID:NaN');
});

test('onboarding profile setup builds explicit RuntimeInput batches', () => {
  const input = buildOnboardingProfileRuntimeInput({
    displayName: ' Alice ',
    targets: [
      { entityId: ENTITY.toUpperCase(), signerId: SIGNER.toUpperCase(), jurisdiction: 'Testnet' },
      { entityId: ENTITY, signerId: SIGNER, jurisdiction: 'Testnet' },
      { entityId: HUB_A, signerId: SIGNER, jurisdiction: 'Tron' },
    ],
  });

  expect(input.runtimeTxs).toEqual([]);
  expect(input.entityInputs).toHaveLength(2);
  expect(input.entityInputs[0]).toEqual({
    entityId: ENTITY.toLowerCase(),
    signerId: SIGNER.toLowerCase(),
    entityTxs: [{
      type: 'profile-update',
      data: {
        profile: {
          entityId: ENTITY.toLowerCase(),
          name: 'Alice',
          bio: '',
          website: '',
        },
      },
    }],
  });
});

test('onboarding hub setup builds one RuntimeInput with deduped open-account txs', () => {
  const input = buildOnboardingHubOpenRuntimeInput({
    target: { entityId: ENTITY.toUpperCase(), signerId: SIGNER.toUpperCase(), jurisdiction: 'Testnet' },
    hubEntityIds: [HUB_A.toUpperCase(), HUB_A, ENTITY, HUB_B],
    creditAmount: 10_000n,
    tokenId: 7,
    rebalancePolicy: REBALANCE_POLICY,
  });

  expect(input.runtimeTxs).toEqual([]);
  expect(input.entityInputs).toEqual([{
    entityId: ENTITY.toLowerCase(),
    signerId: SIGNER.toLowerCase(),
    entityTxs: [
      {
        type: 'openAccount',
        data: {
          targetEntityId: HUB_A.toLowerCase(),
          creditAmount: 10_000n,
          tokenId: 7,
          rebalancePolicy: REBALANCE_POLICY,
        },
      },
      {
        type: 'openAccount',
        data: {
          targetEntityId: HUB_B.toLowerCase(),
          creditAmount: 10_000n,
          tokenId: 7,
          rebalancePolicy: REBALANCE_POLICY,
        },
      },
    ],
  }]);
});

test('onboarding RuntimeInput builders reject malformed setup commands', () => {
  expect(() => buildOnboardingProfileRuntimeInput({
    displayName: 'A',
    targets: [{ entityId: ENTITY, signerId: SIGNER }],
  })).toThrow('profile name');

  expect(() => buildOnboardingHubOpenRuntimeInput({
    target: { entityId: ENTITY, signerId: SIGNER },
    hubEntityIds: [ENTITY],
    creditAmount: 1n,
  })).toThrow('requires at least one hub');

  expect(() => buildOnboardingHubOpenRuntimeInput({
    target: { entityId: ENTITY, signerId: SIGNER },
    hubEntityIds: [HUB_A],
    creditAmount: 0n,
  })).toThrow('credit amount must be positive');
});

test('onboarding completion requires every requested hub account to commit', () => {
  expect(assertCommittedAutoJoinCount({
    requestedPerTarget: 1,
    targetCount: 2,
    committedCount: 2,
  })).toBe(2);

  expect(assertCommittedAutoJoinCount({
    requestedPerTarget: 0,
    targetCount: 2,
    committedCount: 0,
  })).toBe(0);

  expect(() => assertCommittedAutoJoinCount({
    requestedPerTarget: 2,
    targetCount: 2,
    committedCount: 3,
  })).toThrow('ONBOARDING_AUTO_JOIN_INCOMPLETE:requested=4:committed=3');
});

test('onboarding creates every jurisdiction entity but only requires advertised hub lanes', () => {
  expect(selectAdvertisedAutoJoinCandidates({
    requested: 1,
    advertisedHubEntityIds: [],
    eligibleHubEntityIds: [],
  })).toEqual({ required: false, hubEntityIds: [] });

  expect(selectAdvertisedAutoJoinCandidates({
    requested: 1,
    advertisedHubEntityIds: [HUB_A],
    eligibleHubEntityIds: [HUB_A],
  })).toEqual({ required: true, hubEntityIds: [HUB_A] });

  expect(() => selectAdvertisedAutoJoinCandidates({
    requested: 2,
    advertisedHubEntityIds: [HUB_A],
    eligibleHubEntityIds: [HUB_A],
  })).toThrow('ONBOARDING_HUB_CAPACITY_INSUFFICIENT:requested=2:found=1');

  expect(() => selectAdvertisedAutoJoinCandidates({
    requested: 1,
    advertisedHubEntityIds: [HUB_A],
    eligibleHubEntityIds: [],
  })).toThrow('ONBOARDING_HUB_CAPACITY_INSUFFICIENT:requested=1:found=0');
});
