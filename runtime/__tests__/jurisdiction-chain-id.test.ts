import { describe, expect, test } from 'bun:test';

import { buildJAdapterConfigFromJurisdiction } from '../jurisdiction/adapter/jurisdiction';
import { BrowserVMEthersProvider } from '../jurisdiction/adapter/browservm-ethers-provider';
import { requireJurisdictionChainId } from '../jurisdiction/machine/jurisdiction-stack';
import type { JurisdictionConfig } from '../entity/types';

const jurisdiction = (chainId: number | undefined): JurisdictionConfig => ({
  name: 'Chain identity test',
  address: 'http://127.0.0.1:8545',
  chainId,
  depositoryAddress: `0x${'11'.repeat(20)}`,
  entityProviderAddress: `0x${'22'.repeat(20)}`,
});

describe('jurisdiction chain identity', () => {
  test('accepts only exact positive safe integers', () => {
    expect(requireJurisdictionChainId(31337)).toBe(31337);
    expect(() => requireJurisdictionChainId(undefined)).toThrow(
      'JURISDICTION_CHAIN_ID_INVALID:undefined',
    );
    expect(() => requireJurisdictionChainId(1.5)).toThrow(
      'JURISDICTION_CHAIN_ID_INVALID:1.5',
    );
  });

  test('never attaches a malformed jurisdiction to the Anvil chain by default', () => {
    expect(() => buildJAdapterConfigFromJurisdiction(jurisdiction(undefined))).toThrow(
      'J_ADAPTER_JURISDICTION_CHAIN_ID_INVALID:undefined',
    );
    expect(buildJAdapterConfigFromJurisdiction(jurisdiction(31337)).chainId).toBe(31337);
  });

  test('never invents an Anvil identity for a malformed BrowserVM provider', () => {
    expect(() => new BrowserVMEthersProvider({})).toThrow(
      'BROWSERVM_ETHERS_CHAIN_ID_UNAVAILABLE',
    );
    expect(() => new BrowserVMEthersProvider({ getChainId: () => 1.5 })).toThrow(
      'BROWSERVM_ETHERS_CHAIN_ID_INVALID:1.5',
    );
  });
});
