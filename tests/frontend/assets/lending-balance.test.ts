import { describe, expect, test } from 'bun:test';
import { projectLendingBalance, type LendingBalanceAccount } from '../../../frontend/src/lib/utils/ui/lendingBalance';

const account: LendingBalanceAccount = { hubEntityId: 'hub', intents: [['fund:deposit', 'fund']] };
const pool = { positionId: 'deposit', hubEntityId: 'hub', lenderEntityId: 'user', tokenId: 1, status: 'open', availableAmount: '20', borrowedAmount: '0' };
const response = (pools: unknown[]) => ({ success: true, hubEntityId: 'hub', pools, loans: [] });
const balance = (pools: unknown[], local = account) => projectLendingBalance(response(pools), 'user', local).get(1) ?? 0n;

describe('lending portfolio ownership', () => {
  test('deposit, allocation and payout preserve total owned value', () => {
    expect(80n + balance([pool])).toBe(100n);
    expect(80n + balance([{ ...pool, availableAmount: '5', borrowedAmount: '15' }])).toBe(100n);
    expect(80n + balance([{ ...pool, status: 'closing' }])).toBe(100n);
    expect(100n + balance([{ ...pool, status: 'closed', availableAmount: '0' }], {
      ...account, intents: [...account.intents, ['payout:deposit', 'close-payout']],
    })).toBe(100n);
  });
  test('adds paid interest once, not original principal or promised interest', () => {
    expect(balance([{ ...pool, availableAmount: '21', principalAmount: '20', interestAmount: '1' }])).toBe(21n);
  });
  test('does not double count received payouts when hub HTTP lags', () => {
    expect(balance([pool], { ...account, intents: [...account.intents, ['payout:deposit', 'close-payout']] })).toBe(0n);
  });
  test('keeps older positions when the compact view has dropped their fund intent', () => {
    expect(balance([pool], { ...account, intents: [['borrow:recent', 'borrow']] })).toBe(20n);
  });
  test('borrowing permission never becomes an owned asset', () => {
    expect(balance([], { ...account, intents: [['borrow:recent', 'borrow']] })).toBe(0n);
  });
  test('missing newly funded pool and not-yet-received payout are visibly pending', () => {
    expect(() => balance([])).toThrow('LENDING_BALANCE_SYNC_PENDING');
    expect(() => balance([{ ...pool, status: 'closed', availableAmount: '0' }])).toThrow('LENDING_BALANCE_SYNC_PENDING');
  });
  test('rejects duplicate, foreign and malformed financial data instead of showing zero', () => {
    expect(() => balance([pool, pool])).toThrow('LENDING_BALANCE_DUPLICATE');
    expect(() => balance([{ ...pool, lenderEntityId: 'other' }])).toThrow('LENDING_BALANCE_OWNER_MISMATCH');
    expect(() => balance([{ ...pool, availableAmount: 'invalid' }])).toThrow('LENDING_BALANCE_AMOUNT_INVALID');
    expect(() => balance([{ ...pool, availableAmount: '-1' }])).toThrow('LENDING_BALANCE_AMOUNT_INVALID');
  });
  test('keeps token amounts separate', () => {
    const result = projectLendingBalance(response([pool, { ...pool, positionId: 'second', tokenId: 2, availableAmount: '500' }]), 'user', account);
    expect(result.get(1)).toBe(20n);
    expect(result.get(2)).toBe(500n);
  });
});


test('term-loan principal is not profit and repayment is not counted twice', () => {
  const borrower = { hubEntityId: 'hub', intents: [['disburse:loan', 'disburse']] as Array<[string, string]> };
  const loan = { loanId: 'loan', hubEntityId: 'hub', borrowerEntityId: 'user', tokenId: 1, status: 'active', repaymentAmount: '2020', repaidAmount: '0' };
  const data = { ...response([]), loans: [loan] };
  expect(12000n + (projectLendingBalance(data, 'user', borrower).get(1) ?? 0n)).toBe(9980n);
  expect(projectLendingBalance(data, 'user', { ...borrower, intents: [...borrower.intents, ['repay:loan', 'repay']] }).get(1) ?? 0n).toBe(0n);
  expect(() => projectLendingBalance(response([]), 'user', borrower)).toThrow('LENDING_BALANCE_SYNC_PENDING');
  expect(projectLendingBalance({ ...data, loans: [{ ...loan, status: 'defaulted' }] }, 'user', borrower).get(1)).toBe(-2020n);
});
