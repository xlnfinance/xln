import { ethers } from 'ethers';

import type { AccountState } from '../types/account';
import type { EntityState } from '../entity/types';
import type { LendingBankTerms, LendingFacility, LendingLoan, LendingSavings, LendingState, LendingTermId } from '../types/finance/lending';
import { lendingMaximumAmount, lendingExitAmount, type LendingClock } from '../protocol/dispute/lending-covenant';
import { deriveDelta } from '../account/utils';
import { compareStableText } from '../protocol/serialization';

export const LENDING_TERM_MS: Record<LendingTermId, number> = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
};

export const normalizeLendingTerm = (value: unknown): LendingTermId => {
  if (value === '1h' || value === '1d' || value === '1m') return value;
  throw new Error(`LENDING_INVALID_TERM: ${String(value)}`);
};

export const normalizeInterestBps = (value: unknown): number => {
  const next = Math.floor(Number(value));
  if (!Number.isFinite(next) || next < 0 || next > 10_000) {
    throw new Error(`LENDING_INVALID_INTEREST_BPS: ${String(value)}`);
  }
  return next;
};

export const computeLendingInterest = (principal: bigint, interestBps: number): bigint => {
  if (principal <= 0n || interestBps <= 0) return 0n;
  return principal * BigInt(interestBps) / 10_000n;
};

/** Savings are bank liabilities, independent of any borrower or collection. */
const lendingPositionMatured = (position: LendingSavings, timestamp: number): boolean =>
  timestamp >= position.createdAt + position.termMs;

export const lendingPositionCloseAmount = (position: LendingSavings, timestamp: number): bigint => {
  if (position.status === 'closed' || position.status === 'disputed') return 0n;
  const quoteAt = position.status === 'queued' ? position.updatedAt : timestamp;
  return position.principalAmount + (lendingPositionMatured(position, quoteAt)
    ? computeLendingInterest(position.principalAmount, position.interestBps) : 0n);
};

export const lendingLoanClock = (loan: Pick<LendingLoan, 'principalAmount' | Exclude<keyof LendingClock, 'principal'>>): LendingClock => ({
  principal: loan.principalAmount, interestBps: loan.interestBps, openedAt: loan.openedAt, termMs: loan.termMs, lateMs: loan.lateMs,
  accruedAt: loan.accruedAt, accruedInterest: loan.accruedInterest, interestRemainder: loan.interestRemainder,
});
export const lendingLoanRepaymentAmount = (loan: Parameters<typeof lendingLoanClock>[0], timestamp: number): bigint =>
  lendingExitAmount(lendingLoanClock(loan), timestamp);
export const lendingLoanMaximumAmount = (loan: Parameters<typeof lendingLoanClock>[0]): bigint => lendingMaximumAmount(lendingLoanClock(loan));

const lendingHash = (parts: readonly unknown[]): string =>
  ethers.keccak256(ethers.toUtf8Bytes(parts.map(part => String(part)).join('|'))).toLowerCase();

export const buildLendingLoanId = (input: {
  hubEntityId: string;
  borrowerEntityId: string;
  tokenId: number;
  amount: bigint;
  termId: LendingTermId;
  openedAt: number;
  requestId?: string;
}): string => `loan-${lendingHash([
  'loan',
  input.hubEntityId.toLowerCase(),
  input.borrowerEntityId.toLowerCase(),
  input.tokenId,
  input.amount.toString(),
  input.termId,
  input.openedAt,
  input.requestId ?? '',
]).slice(2, 18)}`;

export const ensureLendingState = (state: EntityState): LendingState => {
  if (!state.lending) {
    state.lending = { savings: new Map(), loans: new Map() };
  }
  if (!(state.lending.savings instanceof Map) || !(state.lending.loans instanceof Map)) {
    throw new Error('LENDING_BOOK_MAP_INVALID');
  }
  return state.lending;
};

export const getAccountOutCapacity = (
  account: AccountState,
  entityId: string,
  tokenId: number,
): bigint => {
  const delta = account.deltas.get(tokenId);
  if (!delta) return 0n;
  const normalized = String(entityId || '').toLowerCase();
  const left = String(account.leftEntity || '').toLowerCase();
  const right = String(account.rightEntity || '').toLowerCase();
  if (normalized !== left && normalized !== right) return 0n;
  return deriveDelta(delta, normalized === left).outCapacity;
};

export const summarizeLendingState = (
  state: EntityState,
  filter?: { userEntityId?: string; tokenId?: number; requestId?: string },
): {
  savings: Array<LendingSavings & { closeAmount: bigint; matured: boolean }>;
  loans: LendingLoan[];
  terms: LendingBankTerms[];
  facilities: LendingFacility[];
  requestStatus: LendingLoan['status'] | 'unseen' | 'not-funded' | null;
  totals: {
    savingsPrincipalAmount: string;
    loanPrincipalAmount: string;
    activePrincipalAmount: string;
  };
} => {
  const lending: LendingState = state.lending ?? { savings: new Map(), loans: new Map() };
  const userEntityId = String(filter?.userEntityId || '').toLowerCase();
  const tokenId = filter?.tokenId;
  // The Account receipt and bank allocation commit in the same Entity frame.
  // Read their current state; no second durable receipt or Account-history scan.
  const requestedLoan = filter?.requestId ? [...lending.loans.values()].find(loan =>
    loan.requestId === filter.requestId && loan.borrowerEntityId === userEntityId) : undefined;
  const requestStatus = !filter?.requestId ? null : requestedLoan?.status ??
    (state.accounts.get(userEntityId)?.state.lendingIntents?.get(`borrow:${filter.requestId}`) === 'borrow' ? 'not-funded' : 'unseen');
  const savings = Array.from(lending.savings.values())
    .filter(position => tokenId === undefined || position.tokenId === tokenId)
    .filter(position => !userEntityId || position.lenderEntityId.toLowerCase() === userEntityId)
    .sort((left, right) => right.updatedAt - left.updatedAt || compareStableText(left.positionId, right.positionId))
    .map(position => ({
      ...position,
      closeAmount: lendingPositionCloseAmount(position, state.timestamp),
      matured: lendingPositionMatured(position, state.timestamp),
    }));
  const loans = Array.from(lending.loans.values())
    .filter(loan => tokenId === undefined || loan.tokenId === tokenId)
    .filter(loan => !userEntityId || loan.borrowerEntityId.toLowerCase() === userEntityId)
    .sort((left, right) => right.updatedAt - left.updatedAt || compareStableText(left.loanId, right.loanId))
    .map(loan => loan.status === 'active' || loan.status === 'defaulted'
      ? { ...loan, repaymentAmount: loan.repaidAmount + lendingLoanRepaymentAmount(loan, state.timestamp) } : loan);
  const allPools = Array.from(lending.savings.values()).filter(position => tokenId === undefined || position.tokenId === tokenId);
  const allLoans = Array.from(lending.loans.values()).filter(loan => tokenId === undefined || loan.tokenId === tokenId);
  const savingsPrincipalAmount = allPools.filter(position => position.status === 'open' || position.status === 'queued')
    .reduce((sum, position) => sum + position.principalAmount, 0n);
  const loanPrincipalAmount = allLoans.filter(loan => loan.status !== 'repaid' && loan.status !== 'disputed')
    .reduce((sum, loan) => sum + loan.principalAmount, 0n);
  const activePrincipalAmount = allLoans
    .filter(loan => loan.status === 'opening' || loan.status === 'active' || loan.status === 'closing')
    .reduce((sum, loan) => sum + loan.principalAmount, 0n);
  return {
    requestStatus,
    savings,
    loans,
    terms: [...lending.terms?.values() ?? []].filter(value => tokenId === undefined || value.tokenId === tokenId),
    facilities: [...lending.facilities?.values() ?? []].filter(value => value.borrowerEntityId === userEntityId && (tokenId === undefined || value.tokenId === tokenId)),
    totals: {
      savingsPrincipalAmount: savingsPrincipalAmount.toString(),
      loanPrincipalAmount: loanPrincipalAmount.toString(),
      activePrincipalAmount: activePrincipalAmount.toString(),
    },
  };
};
