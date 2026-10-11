import { getAssetValueUsd } from '@xln/frontend/lib/components/Entity/assets/entity-asset-values';
import { describe, expect, test } from 'bun:test';
import { deriveDelta } from '../../../../core/account/utils';
import type { Delta } from '../../../../core/types/account';
import { accountNetBalance } from '@xln/frontend/lib/utils/ui/accountBalance';
import { buildLendingRepayTx, isLendingLoanRepayable, type LendingLoan } from './lending';
import { walletTokenTotals } from './token-totals';
import { applyDebtCreated, applyDebtEnforced } from '../../../../core/entity/tx/j-events-observations/debt';
import { projectEntityCoreDoc } from '../../../../core/storage/read/projections';
import { compactEntityCoreForRemote } from '../../../../core/api/runtime-adapter/read/compact-view';
import { addr, entity, makeJurisdiction, makeState } from '../../../../core/__tests__/helpers/cross-j';

test('dispute shortfall remains an unsecured asset after the Account claim retires', () => {
  const [total] = walletTokenTotals({
    onchain: [], accounts: [], jurisdiction: 'Ethereum',
    reserves: [{ tokenId: 1, amount: 950n, pending: 0n, jurisdiction: 'Ethereum' }],
    debtTotals: { incoming: new Map([[1, 50n]]), outgoing: new Map() },
  });
  expect(total?.net).toBe(1_000n);
  expect(total?.risk).toBe(50n);
  expect(total?.secured).toBe(0n);
  expect(total?.sendCapacity).toBe(0n);
});

test('a debt-only token stays visible as a liability with no payment capacity', () => {
  const [total] = walletTokenTotals({
    onchain: [], accounts: [], reserves: [], jurisdiction: 'Ethereum',
    debtTotals: { incoming: new Map(), outgoing: new Map([[21, 50n]]) },
  });
  expect(total).toMatchObject({ tokenId: 21, net: -50n, owed: -50n, risk: 0n, active: true, sendCapacity: 0n });
});

test('wallet debt totals include every active J debt beyond both compact view limits', () => {
  const creditor = entity('11');
  const debtor = entity('22');
  const state = makeState(creditor, addr('33'), makeJurisdiction('Ethereum', 31_337, 'dd', 'ee'));
  for (let tokenId = 1; tokenId <= 21; tokenId++) for (let debtIndex = 0; debtIndex < 21; debtIndex++) {
    applyDebtCreated(state, {
      type: 'DebtCreated', blockNumber: 1, transactionHash: `0x${'44'.repeat(32)}`,
      data: { creditor, debtor, tokenId, amount: '50', debtIndex },
    });
  }
  const before = compactEntityCoreForRemote(projectEntityCoreDoc(state));
  expect(before.inDebtsByToken?.size).toBe(20);
  expect(before.inDebtsByToken?.get(1)?.size).toBe(20);
  expect(before.debtTotals.incoming.size).toBe(21);
  expect(before.debtTotals.incoming.get(1)).toBe(1_050n);
  expect(before.debtTotals.incoming.get(21)).toBe(1_050n);
  applyDebtEnforced(state, {
    type: 'DebtEnforced', blockNumber: 2, transactionHash: `0x${'55'.repeat(32)}`,
    data: { creditor, debtor, tokenId: 21, amountPaid: '30', remainingAmount: '20', newDebtIndex: 0 },
  });
  const after = compactEntityCoreForRemote(projectEntityCoreDoc(state));
  const totals = walletTokenTotals({ onchain: [], accounts: [], reserves: [], jurisdiction: 'Ethereum', debtTotals: after.debtTotals });
  expect(totals.find(total => total.tokenId === 21)?.net).toBe(1_020n);
  expect(before.debtTotals.incoming.get(21)).toBe(1_050n);
});

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

test('overdue borrower repayment preserves the original claim and rejects a second payment', () => {
  const borrower = `0x${'20'.repeat(32)}`;
  const loan: LendingLoan = {
    loanId: 'loan-1111111111111111', hubEntityId: `0x${'10'.repeat(32)}`,
    borrowerEntityId: borrower, lenderEntityId: `0x${'30'.repeat(32)}`,
    positionId: 'lend-2222222222222222', tokenId: 1, principalAmount: 2_500n,
    interestAmount: 25n, repaymentAmount: 2_525n, repaidAmount: 0n,
    interestBps: 100, termId: '1d', openedAt: 0, termMs: 86_400_000, lateMs: 0, dueAt: 86_400_000, status: 'defaulted',
  };
  expect(isLendingLoanRepayable(loan)).toBe(true);
  expect(buildLendingRepayTx(loan, borrower)).toEqual({
    type: 'lendingRepay', data: { hubEntityId: loan.hubEntityId, loanId: loan.loanId, tokenId: 1, amount: 2_525n },
  });
  expect(() => buildLendingRepayTx(loan, loan.lenderEntityId)).toThrow('Only the borrower');
  const repaid = { ...loan, status: 'repaid', repaidAmount: 2_525n };
  expect(isLendingLoanRepayable(repaid)).toBe(false);
  expect(() => buildLendingRepayTx(repaid, borrower)).toThrow('no repayable claim');
});
