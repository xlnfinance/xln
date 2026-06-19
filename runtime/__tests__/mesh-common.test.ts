import { describe, expect, test } from 'bun:test';

import {
  buildMarketMakerConsensusConfig,
  deriveMarketMakerEntityId,
  isCanonicalAccountOpener,
} from '../orchestrator/mesh-common';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;

describe('mesh account bootstrap ownership', () => {
  test('assigns exactly one canonical opener per bilateral account', () => {
    const lower = entityId('11');
    const upper = entityId('22');

    expect(isCanonicalAccountOpener(lower, upper)).toBe(true);
    expect(isCanonicalAccountOpener(upper, lower)).toBe(false);
    expect(isCanonicalAccountOpener(lower.toUpperCase(), upper)).toBe(true);
    expect(isCanonicalAccountOpener(lower, lower)).toBe(false);
  });

  test('derives market-maker entity ids from signer and carries jurisdiction config', () => {
    const signerId = entityId('aa');
    const siblingSignerId = entityId('bb');
    const baseJurisdiction = {
      name: 'Testnet',
      address: 'http://127.0.0.1:8545',
      entityProviderAddress: entityId('01'),
      depositoryAddress: entityId('02'),
      chainId: 31337,
    };
    const tronJurisdiction = {
      ...baseJurisdiction,
      name: 'Tron',
      address: 'http://127.0.0.1:8546',
      entityProviderAddress: entityId('03'),
      depositoryAddress: entityId('04'),
      chainId: 31338,
    };

    expect(buildMarketMakerConsensusConfig(signerId, tronJurisdiction).jurisdiction).toEqual(tronJurisdiction);
    expect(deriveMarketMakerEntityId(signerId, baseJurisdiction)).toBe(
      deriveMarketMakerEntityId(signerId.toUpperCase(), baseJurisdiction),
    );
    expect(deriveMarketMakerEntityId(signerId, baseJurisdiction)).not.toBe(
      deriveMarketMakerEntityId(siblingSignerId, tronJurisdiction),
    );
  });
});
