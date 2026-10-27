import { expect, test } from 'bun:test';
import { formatTokenAmount, parseTokenAmount } from '../../../account/financial-utils';
import { parseRebalancePolicyUsd } from '../../../extensions/rebalance/usd';
import { buildCrossJurisdictionSwapIntent } from '../../../account/swap/swap-command-route';

test('missing balances cannot be displayed as zero', () => {
  for (const value of [null, undefined]) expect(() => formatTokenAmount(1, value)).toThrow('TOKEN_AMOUNT_MISSING');
  expect(formatTokenAmount(1, 0n)).toBe('0.0 USDC');
  expect(parseTokenAmount(1, '1.25')).toBe(1_250_000n);
});

test('only absent rebalance policy inherits defaults', () => {
  const policy = { r2cRequestSoftLimit: 1, hardLimit: 2, maxFee: 0 };
  expect(parseRebalancePolicyUsd(undefined)).toBeUndefined();
  expect(parseRebalancePolicyUsd(policy)).toEqual(policy);
  for (const value of [null, [], {}, { ...policy, maxFee: 'invalid' }, { ...policy, maxFee: -1 }, { ...policy, hardLimit: 0 }]) {
    expect(() => parseRebalancePolicyUsd(value)).toThrow('REBALANCE_POLICY_USD_INVALID');
  }
});

test('swap intent rejects a short requested expiry instead of extending it', () => {
  const party = (side: string, chain: number) => ({
    entityId: side, signerId: side, hubEntityId: `${side}-hub`, hubSignerId: `${side}-signer`,
    jurisdiction: `stack:${chain}:0x${'11'.repeat(20)}`,
    disputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
  });
  const input = { offerId: 'expiry', logicalTimestamp: 1000, expiresInMs: 5000,
    giveTokenId: 1, wantTokenId: 3, giveAmount: 1n, wantAmount: 1n, priceTicks: 10_000n,
    source: party('source', 1), target: party('target', 2) };
  expect(() => buildCrossJurisdictionSwapIntent(input)).toThrow('SWAP_COMMAND_EXPIRES_IN_BELOW_MINIMUM');
  expect(buildCrossJurisdictionSwapIntent({ ...input, expiresInMs: 30_000 }).expiresAt).toBe(31_000);
});
