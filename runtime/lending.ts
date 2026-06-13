import { ethers } from 'ethers';

import type {
  AccountMachine,
  EntityState,
  LendingLoan,
  LendingPoolPosition,
  LendingState,
  LendingTermId,
} from './types';

export const LENDING_TERM_MS: Record<LendingTermId, number> = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
};

const ENTITY_ID_RE = /^0x[0-9a-fA-F]{64}$/;

export const isLendingEntityId = (value: unknown): value is string =>
  typeof value === 'string' && ENTITY_ID_RE.test(value);

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

const lendingHash = (parts: readonly unknown[]): string =>
  ethers.keccak256(ethers.toUtf8Bytes(parts.map(part => String(part)).join('|'))).toLowerCase();

export const buildLendingPositionId = (input: {
  hubEntityId: string;
  lenderEntityId: string;
  tokenId: number;
  amount: bigint;
  termId: LendingTermId;
  interestBps: number;
  createdAt: number;
}): string => `lend-${lendingHash([
  'position',
  input.hubEntityId.toLowerCase(),
  input.lenderEntityId.toLowerCase(),
  input.tokenId,
  input.amount.toString(),
  input.termId,
  input.interestBps,
  input.createdAt,
]).slice(2, 18)}`;

export const buildLendingLoanId = (input: {
  hubEntityId: string;
  borrowerEntityId: string;
  tokenId: number;
  amount: bigint;
  termId: LendingTermId;
  openedAt: number;
}): string => `loan-${lendingHash([
  'loan',
  input.hubEntityId.toLowerCase(),
  input.borrowerEntityId.toLowerCase(),
  input.tokenId,
  input.amount.toString(),
  input.termId,
  input.openedAt,
]).slice(2, 18)}`;

export const ensureLendingState = (state: EntityState): LendingState => {
  if (!state.lending) {
    state.lending = { pools: new Map(), loans: new Map() };
  }
  if (!(state.lending.pools instanceof Map)) state.lending.pools = new Map();
  if (!(state.lending.loans instanceof Map)) state.lending.loans = new Map();
  return state.lending;
};

export const getCreditGrantedByAccountOwner = (
  account: AccountMachine,
  ownerEntityId: string,
  tokenId: number,
): bigint => {
  const delta = account.deltas.get(tokenId);
  if (!delta) return 0n;
  const owner = String(ownerEntityId || '').toLowerCase();
  const left = String(account.leftEntity || '').toLowerCase();
  return owner === left ? BigInt(delta.rightCreditLimit ?? 0n) : BigInt(delta.leftCreditLimit ?? 0n);
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
      left.positionId.localeCompare(right.positionId)
    ));
  return candidates[0] ?? null;
};

export const summarizeLendingState = (
  state: EntityState,
  filter?: { userEntityId?: string; tokenId?: number },
): {
  pools: LendingPoolPosition[];
  loans: LendingLoan[];
  totals: {
    availableAmount: string;
    borrowedAmount: string;
    activePrincipalAmount: string;
  };
} => {
  const lending = state.lending ?? { pools: new Map(), loans: new Map() };
  const userEntityId = String(filter?.userEntityId || '').toLowerCase();
  const tokenId = filter?.tokenId;
  const pools = Array.from(lending.pools.values())
    .filter(position => tokenId === undefined || position.tokenId === tokenId)
    .filter(position => !userEntityId || position.lenderEntityId.toLowerCase() === userEntityId)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.positionId.localeCompare(right.positionId));
  const loans = Array.from(lending.loans.values())
    .filter(loan => tokenId === undefined || loan.tokenId === tokenId)
    .filter(loan => !userEntityId || loan.borrowerEntityId.toLowerCase() === userEntityId || loan.lenderEntityId.toLowerCase() === userEntityId)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.loanId.localeCompare(right.loanId));
  const allPools = Array.from(lending.pools.values()).filter(position => tokenId === undefined || position.tokenId === tokenId);
  const allLoans = Array.from(lending.loans.values()).filter(loan => tokenId === undefined || loan.tokenId === tokenId);
  const availableAmount = allPools.reduce((sum, position) => sum + position.availableAmount, 0n);
  const borrowedAmount = allPools.reduce((sum, position) => sum + position.borrowedAmount, 0n);
  const activePrincipalAmount = allLoans
    .filter(loan => loan.status === 'active')
    .reduce((sum, loan) => sum + loan.principalAmount, 0n);
  return {
    pools,
    loans,
    totals: {
      availableAmount: availableAmount.toString(),
      borrowedAmount: borrowedAmount.toString(),
      activePrincipalAmount: activePrincipalAmount.toString(),
    },
  };
};
