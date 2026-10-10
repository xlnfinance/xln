import { getAssetValueUsd } from '@xln/frontend/lib/components/Entity/assets/entity-asset-values';
import { describe, expect, test } from 'bun:test';
import { deriveDelta } from '../../../../core/account/utils';
import type { Delta } from '../../../../core/types/account';
import { accountNetBalance } from '@xln/frontend/lib/utils/ui/accountBalance';

const delta = (collateral: bigint, ondelta: bigint): Delta => ({
	tokenId: 1,
	collateral,
	ondelta,
	offdelta: 0n,
	leftCreditLimit: 0n,
	rightCreditLimit: 0n,
	leftAllowance: 0n,
	rightAllowance: 0n,
	leftHold: 0n,
	rightHold: 0n,
});

describe('wallet ownership from the canonical Account perspective', () => {
	test.each([
		[0n, 0n, 0n, 0n],
		[100n, 0n, 0n, 100n],
		[100n, 100n, 100n, 0n],
		[100n, 25n, 25n, 75n],
		[100n, -25n, -25n, 125n],
		[100n, 125n, 125n, -25n],
	] as const)('collateral %s, allocation %s preserves both owners', (collateral, allocation, left, right) => {
		const value = delta(collateral, allocation);
		expect(accountNetBalance(deriveDelta(value, true))).toBe(left);
		expect(accountNetBalance(deriveDelta(value, false))).toBe(right);
	});
	test('held capacity and unused credit do not change ownership', () => {
		const value = {
			...delta(100n, 25n),
			leftCreditLimit: 1_000n,
			rightCreditLimit: 2_000n,
			leftHold: 20n,
			rightHold: 30n,
		};
		expect(accountNetBalance(deriveDelta(value, true))).toBe(25n);
		expect(accountNetBalance(deriveDelta(value, false))).toBe(75n);
	});
	test('wide signed exposure remains exact on both sides', () => {
		const collateral = (1n << 256n) - 1n;
		const allocation = 1n << 300n;
		const value = delta(collateral, allocation);
		expect(accountNetBalance(deriveDelta(value, true))).toBe(allocation);
		expect(accountNetBalance(deriveDelta(value, false))).toBe(collateral - allocation);
	});
});


test('USD totals retain the sign of term-loan liabilities', () => {
  expect(getAssetValueUsd(-2_020_000n, { symbol: 'USDC', decimals: 6 })).toBe(-2.02);
  expect(getAssetValueUsd(102_000_000n, { symbol: 'USDC', decimals: 6 }) + getAssetValueUsd(-2_020_000n, { symbol: 'USDC', decimals: 6 })).toBe(99.98);
});
