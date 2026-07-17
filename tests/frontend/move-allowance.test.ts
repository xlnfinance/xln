import { describe, expect, test } from 'bun:test';

import {
  buildMoveAllowanceContextSignature,
  buildMoveAllowanceStatusLabel,
  getMoveRequiredAllowanceAmount,
  isMoveAllowanceSatisfied,
} from '../../frontend/src/lib/components/Entity/move-allowance';
import { routeRequiresExplicitExternalAllowance } from '../../frontend/src/lib/components/Entity/move-routes';

const fmt = (amount: bigint, decimals: number) => `${amount / (10n ** BigInt(decimals))}`;

describe('move allowance helpers', () => {
  test('detects routes that need explicit external allowance', () => {
    expect(routeRequiresExplicitExternalAllowance('external', 'reserve')).toBe(true);
    expect(routeRequiresExplicitExternalAllowance('external', 'account')).toBe(true);
    expect(routeRequiresExplicitExternalAllowance('external', 'external')).toBe(false);
    expect(routeRequiresExplicitExternalAllowance('reserve', 'account')).toBe(false);
  });

  test('builds stable context signature', () => {
    expect(buildMoveAllowanceContextSignature({
      enabled: true,
      from: 'external',
      to: 'reserve',
      assetSymbol: 'USDC',
      signerId: '0xABC',
      runtimeId: 'dev',
    })).toBe('1|external->reserve|USDC|0xabc|dev');
  });

  test('derives required amount and satisfaction', () => {
    const required = getMoveRequiredAllowanceAmount({
      enabled: true,
      token: { decimals: 6 },
      amountInput: '2.5',
      sourceAvailableBalance: 3_000_000n,
    });
    expect(required).toBe(2_500_000n);
    expect(isMoveAllowanceSatisfied(required, 2_499_999n)).toBe(false);
    expect(isMoveAllowanceSatisfied(required, 2_500_000n)).toBe(true);
    expect(getMoveRequiredAllowanceAmount({
      enabled: false,
      token: { decimals: 6 },
      amountInput: '2.5',
      sourceAvailableBalance: 3_000_000n,
    })).toBe(null);
  });

  test('builds allowance status label states', () => {
    expect(buildMoveAllowanceStatusLabel({
      enabled: false,
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      metadataLoading: false,
      raw: null,
      loading: false,
      error: null,
      required: null,
      formatAmount: fmt,
    })).toBe('');
    expect(buildMoveAllowanceStatusLabel({
      enabled: true,
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      metadataLoading: false,
      raw: null,
      loading: true,
      error: null,
      required: null,
      formatAmount: fmt,
    })).toBe('Checking allowance...');
    expect(buildMoveAllowanceStatusLabel({
      enabled: true,
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      metadataLoading: false,
      raw: 1_000_000n,
      loading: false,
      error: null,
      required: 2_000_000n,
      formatAmount: fmt,
    })).toBe('Current allowance 1 USDC · required 2 USDC');
  });

  test('waits for exact token metadata and then fails loud if it never arrives', () => {
    const base = {
      enabled: true,
      tokenSymbol: 'USDC',
      tokenDecimals: null,
      raw: null,
      loading: false,
      error: null,
      required: null,
      formatAmount: fmt,
    };
    expect(buildMoveAllowanceStatusLabel({ ...base, metadataLoading: true }))
      .toBe('Loading asset metadata...');
    expect(() => buildMoveAllowanceStatusLabel({ ...base, metadataLoading: false }))
      .toThrow('MOVE_ALLOWANCE_TOKEN_METADATA_MISSING:USDC');
  });
});
