import { ethers } from 'ethers';

import type { AccountState } from '../types/account';
import type { EntityState } from '../entity/types';
import type { LendingBankTerms, LendingFacility, LendingLoan, LendingPoolPosition, LendingState, LendingTermId } from '../types/finance/lending';
import { lendingMaximumAmount, lendingRepaymentAmount } from '../protocol/dispute/lending-covenant';
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
  const numerator = principal * BigInt(interestBps);
  const raw = numerator / 10_000n;
  return raw === 0n ? 1n : raw;
};

/** The bank owes the deposit's agreed return at maturity, independently of its
 * loan collections. Preserve any earnings already committed to the position.
 * Early cancellation returns the available claim without unearned term interest.
 */
export const lendingPositionMatured = (position: LendingPoolPosition, timestamp: number): boolean =>
  timestamp >= position.createdAt + position.termMs;

export const lendingPositionCloseAmount = (position: LendingPoolPosition, timestamp: number): bigint => {
  if (position.status !== 'open' || !lendingPositionMatured(position, timestamp)) {
    return position.availableAmount;
  }
  const promised = position.principalAmount + computeLendingInterest(position.principalAmount, position.interestBps);
  return position.availableAmount > promised ? position.availableAmount : promised;
};

const loanClock = (loan: Pick<LendingLoan, 'principalAmount' | 'interestAmount' | 'openedAt' | 'termMs' | 'lateMs'>) => ({
  principal: loan.principalAmount, interest: loan.interestAmount, openedAt: loan.openedAt, termMs: loan.termMs, lateMs: loan.lateMs,
});
export const lendingLoanRepaymentAmount = (loan: Parameters<typeof loanClock>[0], timestamp: number): bigint =>
  lendingRepaymentAmount(loanClock(loan), timestamp);
export const lendingLoanMaximumAmount = (loan: Parameters<typeof loanClock>[0]): bigint => lendingMaximumAmount(loanClock(loan));

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
    state.lending = { pools: new Map(), loans: new Map() };
  }
  if (!(state.lending.pools instanceof Map) || !(state.lending.loans instanceof Map)) {
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

export const selectBestLendingPool = (
  lending: LendingState,
  tokenId: number,
  amount: bigint,
  termId: LendingTermId,
  maxInterestBps: number,
): LendingPoolPosition | null => {
  const candidates = Array.from(lending.pools.values())
    .filter(position =>
      position.status === 'open' &&
      position.tokenId === tokenId &&
      position.termId === termId &&
      position.availableAmount >= amount &&
      position.interestBps <= maxInterestBps
    )
    .sort((left, right) => (
      left.interestBps - right.interestBps ||
      left.createdAt - right.createdAt ||
      compareStableText(left.positionId, right.positionId)
    ));
  return candidates[0] ?? null;
};

export const summarizeLendingState = (
  state: EntityState,
  filter?: { userEntityId?: string; tokenId?: number; requestId?: string },
): {
  pools: Array<LendingPoolPosition & { closeAmount: bigint; matured: boolean }>;
  loans: LendingLoan[];
  terms: LendingBankTerms[];
  facilities: LendingFacility[];
  requestStatus: LendingLoan['status'] | 'unseen' | 'not-funded' | null;
  totals: {
    availableAmount: string;
    borrowedAmount: string;
    activePrincipalAmount: string;
  };
} => {
  const lending: LendingState = state.lending ?? { pools: new Map(), loans: new Map() };
  const userEntityId = String(filter?.userEntityId || '').toLowerCase();
  const tokenId = filter?.tokenId;
  // The Account receipt and bank allocation commit in the same Entity frame.
  // Read their current state; no second durable receipt or Account-history scan.
  const requestedLoan = filter?.requestId ? [...lending.loans.values()].find(loan =>
    loan.requestId === filter.requestId && loan.borrowerEntityId === userEntityId) : undefined;
  const requestStatus = !filter?.requestId ? null : requestedLoan?.status ??
    (state.accounts.get(userEntityId)?.state.lendingIntents?.get(`borrow:${filter.requestId}`) === 'borrow' ? 'not-funded' : 'unseen');
  const pools = Array.from(lending.pools.values())
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
    .filter(loan => !userEntityId || loan.borrowerEntityId.toLowerCase() === userEntityId || loan.lenderEntityId.toLowerCase() === userEntityId)
    .sort((left, right) => right.updatedAt - left.updatedAt || compareStableText(left.loanId, right.loanId))
    .map(loan => loan.status === 'active' || loan.status === 'defaulted'
      ? { ...loan, repaymentAmount: lendingLoanRepaymentAmount(loan, state.timestamp) } : loan);
  const allPools = Array.from(lending.pools.values()).filter(position => tokenId === undefined || position.tokenId === tokenId);
  const allLoans = Array.from(lending.loans.values()).filter(loan => tokenId === undefined || loan.tokenId === tokenId);
  const availableAmount = allPools.reduce((sum, position) => sum + position.availableAmount, 0n);
  const borrowedAmount = allPools.reduce((sum, position) => sum + position.borrowedAmount, 0n);
  const activePrincipalAmount = allLoans
    .filter(loan => loan.status === 'opening' || loan.status === 'active' || loan.status === 'closing')
    .reduce((sum, loan) => sum + loan.principalAmount, 0n);
  return {
    requestStatus,
    pools,
    loans,
    terms: [...lending.terms?.values() ?? []].filter(value => tokenId === undefined || value.tokenId === tokenId),
    facilities: [...lending.facilities?.values() ?? []].filter(value => value.borrowerEntityId === userEntityId && (tokenId === undefined || value.tokenId === tokenId)),
    totals: {
      availableAmount: availableAmount.toString(),
      borrowedAmount: borrowedAmount.toString(),
      activePrincipalAmount: activePrincipalAmount.toString(),
    },
  };
};
