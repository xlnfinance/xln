import { describe, expect, test } from 'bun:test';
import { getJurisdictionStackId } from '../../runtime/api/public/runtime-module';

import type { Runtime } from '../../frontend/src/lib/stores/vaultStore';
import {
  selectWalletOnboardingHubs,
  walletProfileOnboardingEntityIds,
  walletProfileOnboardingRequired,
} from '../../frontend/apps/wallet/src/features/onboarding/wallet-profile-onboarding';

const entity = (digit: string): string => `0x${digit.repeat(64)}`;
const signer = (digit: string): string => `0x${digit.repeat(40)}`;
const depository = (digit: string): string => `0x${digit.repeat(40)}`;

describe('React wallet profile onboarding', () => {
  test('gates incomplete manual runtimes across every local entity lane', () => {
    const runtime = {
      requiresOnboarding: true,
      signers: [
        { entityId: entity('1'), address: signer('a') },
        { entityId: entity('2'), address: signer('b') },
      ],
    } as Runtime;

    expect(walletProfileOnboardingEntityIds(runtime)).toEqual([entity('1'), entity('2')]);
    expect(walletProfileOnboardingRequired(runtime, false)).toBe(true);
    expect(walletProfileOnboardingRequired(runtime, true)).toBe(false);
    expect(walletProfileOnboardingRequired({ ...runtime, requiresOnboarding: false }, false)).toBe(false);
  });

  test('selects only advertised same-jurisdiction hubs without existing accounts', () => {
    const targetJurisdiction = { name: 'Testnet', chainId: 31337, depositoryAddress: depository('c') };
    const target = {
      entityId: entity('1'),
      signerId: signer('a'),
      jurisdiction: 'Testnet',
      jurisdictionKey: getJurisdictionStackId(targetJurisdiction),
    };
    const publicHubs = [
      { entityId: entity('2'), metadata: { isHub: true, jurisdiction: targetJurisdiction } },
      { entityId: entity('3'), metadata: { isHub: true, jurisdiction: targetJurisdiction } },
      { entityId: entity('4'), metadata: { isHub: true, jurisdiction: targetJurisdiction } },
      { entityId: entity('5'), metadata: { isHub: true, jurisdiction: { ...targetJurisdiction, chainId: 31338 } } },
      { entityId: entity('6'), metadata: { isHub: false, jurisdiction: targetJurisdiction } },
    ];

    expect(selectWalletOnboardingHubs({
      target,
      publicHubs,
      counterpartyIds: [entity('2')],
      requested: 2,
    })).toEqual([entity('3'), entity('4')]);
  });

  test('fails loudly when advertised capacity cannot satisfy the preference', () => {
    const jurisdiction = { name: 'Testnet', chainId: 31337, depositoryAddress: depository('c') };
    expect(() => selectWalletOnboardingHubs({
      target: {
        entityId: entity('1'),
        signerId: signer('a'),
        jurisdiction: 'Testnet',
        jurisdictionKey: getJurisdictionStackId(jurisdiction),
      },
      publicHubs: [{ entityId: entity('2'), metadata: { isHub: true, jurisdiction } }],
      counterpartyIds: [],
      requested: 3,
    })).toThrow('ONBOARDING_HUB_CAPACITY_INSUFFICIENT:requested=3:found=1');
  });
});
