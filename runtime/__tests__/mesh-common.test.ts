import { describe, expect, test } from 'bun:test';

import {
  buildMarketMakerConsensusConfig,
  deriveMarketMakerEntityId,
  getBootstrapCreditAmount,
  getBootstrapTokenAmount,
  isCanonicalAccountOpener,
} from '../orchestrator/mesh-common';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;

describe('mesh account bootstrap ownership', () => {
  test('targets the same $2M notional for stablecoins and WETH at $1,000', () => {
    const unit = 10n ** 18n;

    expect(getBootstrapCreditAmount(1)).toBe(2_000_000n * 10n ** 6n);
    expect(getBootstrapCreditAmount(3)).toBe(2_000_000n * 10n ** 6n);
    expect(getBootstrapCreditAmount(2)).toBe(2_000n * unit);
    expect(getBootstrapTokenAmount(1, 6)).toBe(2_000_000n * 10n ** 6n);
    expect(getBootstrapTokenAmount(2, 18)).toBe(2_000n * unit);
  });

  test('assigns exactly one canonical opener per bilateral account', () => {
    const lower = entityId('11');
    const upper = entityId('22');

    expect(isCanonicalAccountOpener(lower, upper)).toBe(true);
    expect(isCanonicalAccountOpener(upper, lower)).toBe(false);
    expect(isCanonicalAccountOpener(lower.toUpperCase(), upper)).toBe(true);
    expect(isCanonicalAccountOpener(lower, lower)).toBe(false);
  });

  test('derives market-maker entity ids from signer and carries jurisdiction config', () => {
    const signerId = `0x${'aa'.repeat(20)}`;
    const siblingSignerId = `0x${'bb'.repeat(20)}`;
    const baseJurisdiction = {
      name: 'Testnet',
      address: 'http://127.0.0.1:8545',
      entityProviderAddress: entityId('01'),
      depositoryAddress: entityId('02'),
      chainId: 31337,
      blockTimeMs: 1_000,
    };
    const tronJurisdiction = {
      ...baseJurisdiction,
      name: 'Tron',
      address: 'http://127.0.0.1:8546',
      entityProviderAddress: entityId('03'),
      depositoryAddress: entityId('04'),
      chainId: 31338,
      blockTimeMs: 3_000,
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
