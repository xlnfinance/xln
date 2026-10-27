import { describe, expect, test } from 'bun:test';

import {
  buildMarketMakerConsensusConfig,
  deriveMarketMakerEntityId,
  getBootstrapCreditAmount,
  getBootstrapTokenAmount,
} from '../../../orchestrator/mesh/mesh-common';

import { getBootstrapTokenAmountBySymbol } from '../../../jurisdiction/machine/config/bootstrap-economy';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;

describe('mesh account bootstrap ownership', () => {
  test.each([
    [1, 'USDC', 6, 2_000_000_000_000n],
    [2, 'WETH', 18, 800n * 10n ** 18n],
    [3, 'USDT', 6, 2_000_000_000_000n],
    [4, 'TRX', 6, 16_666_666_666_666n],
    [5, 'SUN', 18, 100_000_000n * 10n ** 18n],
  ] as const)('targets $2M at the committed rate for %s/%s', (tokenId, symbol, decimals, expected) => {
    expect(getBootstrapCreditAmount(tokenId)).toBe(expected);
    expect(getBootstrapTokenAmount(tokenId, decimals)).toBe(expected);
    expect(getBootstrapTokenAmountBySymbol(symbol, decimals)).toBe(expected);
    expect(getBootstrapTokenAmountBySymbol(` ${symbol.toLowerCase()} `, decimals)).toBe(expected);
  });

  test('rejects unknown bootstrap tokens and mismatched catalog precision', () => {
    expect(() => getBootstrapTokenAmountBySymbol('DAI', 18)).toThrow('BOOTSTRAP_TOKEN_SYMBOL_UNKNOWN');
    expect(() => getBootstrapTokenAmountBySymbol('', 6)).toThrow('BOOTSTRAP_TOKEN_SYMBOL_UNKNOWN');
    expect(() => getBootstrapTokenAmount(999, 6)).toThrow('TOKEN_USD_RATE_UNAVAILABLE:999');
    expect(() => getBootstrapTokenAmount(2, 6)).toThrow('BOOTSTRAP_TOKEN_DECIMALS_MISMATCH');
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
