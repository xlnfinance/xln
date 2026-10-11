import type { AccountReplica, AccountTx } from '../types/account';
import type { LendingBankTerms, LendingFacility, LendingTermId } from '../types/finance/lending';
import type { EntityState } from './types';
import { requireBoundaryInteger, requireBoundaryRecord, requireExactBoundaryKeys, requireBigInt, requireMap } from '../protocol/boundary/boundary-primitives';
import { LENDING_TERM_MS } from '../extensions/lending';
import { UINT256_MAX } from '../protocol/boundary/integer-ranges';
import { assertLendingClock } from '../protocol/dispute/lending-covenant';

const term = (value: unknown): LendingTermId => {
  if (value !== '1h' && value !== '1d' && value !== '1m') throw new Error('LENDING_POLICY_TERM_INVALID');
  return value;
};
const address = (value: unknown): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/.test(value)) throw new Error('LENDING_POLICY_DOMAIN_INVALID');
  return value;
};
const rate = (value: unknown): number => {
  const result = requireBoundaryInteger(value, 'LENDING_POLICY_RATE_INVALID', 0);
  if (result > 10_000) throw new Error('LENDING_POLICY_RATE_INVALID');
  return result;
};

export const lendingTermsKey = (terms: Pick<LendingBankTerms, 'chainId' | 'depositoryAddress' | 'tokenId' | 'termId'>): string =>
  `${terms.chainId}:${terms.depositoryAddress}:${terms.tokenId}:${terms.termId}`;
export const lendingFacilityKey = (borrower: string, tokenId: number, termId: LendingTermId): string =>
  `${borrower}:${tokenId}:${termId}`;

export const decodeLendingBankTerms = (value: unknown): LendingBankTerms => {
  const data = requireBoundaryRecord(value, 'LENDING_TERMS_INVALID');
  requireExactBoundaryKeys(data, ['chainId', 'depositoryAddress', 'tokenId', 'termId', 'savingsInterestBps', 'loanInterestBps', 'loanLateMs', 'expiresAt'], [], 'LENDING_TERMS_FIELDS');
  const termId = term(data['termId']);
  const loanLateMs = requireBoundaryInteger(data['loanLateMs'], 'LENDING_POLICY_LATE_INVALID');
  const expiresAt = requireBoundaryInteger(data['expiresAt'], 'LENDING_POLICY_EXPIRY_INVALID');
  requireBoundaryInteger(expiresAt + LENDING_TERM_MS[termId] + loanLateMs, 'LENDING_POLICY_CLOCK_OVERFLOW');
  return {
    chainId: requireBoundaryInteger(data['chainId'], 'LENDING_POLICY_CHAIN_INVALID', 1),
    depositoryAddress: address(data['depositoryAddress']),
    tokenId: requireBoundaryInteger(data['tokenId'], 'LENDING_POLICY_TOKEN_INVALID', 1),
    termId,
    savingsInterestBps: rate(data['savingsInterestBps']),
    loanInterestBps: rate(data['loanInterestBps']),
    loanLateMs, expiresAt,
  };
};

export const decodeLendingFacility = (value: unknown): LendingFacility => {
  const data = requireBoundaryRecord(value, 'LENDING_FACILITY_INVALID');
  requireExactBoundaryKeys(data, ['borrowerEntityId', 'chainId', 'depositoryAddress', 'jNonce', 'tokenId', 'termId', 'maxPrincipal', 'expiresAt'], [], 'LENDING_FACILITY_FIELDS');
  const borrower = data['borrowerEntityId'];
  if (typeof borrower !== 'string' || !/^0x[0-9a-f]{64}$/.test(borrower)) throw new Error('LENDING_FACILITY_BORROWER_INVALID');
  const maxPrincipal = requireBigInt(data['maxPrincipal'], 'LENDING_FACILITY_AMOUNT_INVALID', 0n);
  if (maxPrincipal > UINT256_MAX) throw new Error('LENDING_FACILITY_AMOUNT_INVALID');
  return {
    borrowerEntityId: borrower,
    chainId: requireBoundaryInteger(data['chainId'], 'LENDING_POLICY_CHAIN_INVALID', 1),
    depositoryAddress: address(data['depositoryAddress']),
    jNonce: requireBoundaryInteger(data['jNonce'], 'LENDING_FACILITY_NONCE_INVALID', 0),
    tokenId: requireBoundaryInteger(data['tokenId'], 'LENDING_POLICY_TOKEN_INVALID', 1),
    termId: term(data['termId']), maxPrincipal,
    expiresAt: requireBoundaryInteger(data['expiresAt'], 'LENDING_POLICY_EXPIRY_INVALID', 0),
  };
};

/** Validate policy authority when restoring, before it may authorize new money. */
export const validateLendingPolicies = (lending: Record<string, unknown>): void => {
  requireExactBoundaryKeys(lending, ['savings', 'loans'], ['terms', 'facilities'], 'LENDING_BOOK_FIELDS');
  for (const raw of requireMap(lending['savings'], 'LENDING_SAVINGS_MAP_INVALID').values()) {
    const savings = requireBoundaryRecord(raw, 'LENDING_SAVINGS_INVALID');
    if ('availableAmount' in savings || 'borrowedAmount' in savings) throw new Error('LENDING_ALLOCATION_MIGRATION_REQUIRED');
  }
  if (lending['terms'] !== undefined) for (const [key, raw] of requireMap(lending['terms'], 'LENDING_TERMS_MAP_INVALID')) {
    if (key !== lendingTermsKey(decodeLendingBankTerms(raw))) throw new Error('LENDING_TERMS_KEY_INVALID');
  }
  if (lending['facilities'] !== undefined) for (const [key, raw] of requireMap(lending['facilities'], 'LENDING_FACILITIES_MAP_INVALID')) {
    const facility = decodeLendingFacility(raw);
    if (key !== lendingFacilityKey(facility.borrowerEntityId, facility.tokenId, facility.termId)) throw new Error('LENDING_FACILITY_KEY_INVALID');
  }
  for (const raw of requireMap(lending['loans'], 'LENDING_LOANS_MAP_INVALID').values()) {
    const loan = requireBoundaryRecord(raw, 'LENDING_LOAN_INVALID');
    if ('lenderEntityId' in loan || 'positionId' in loan) throw new Error('LENDING_ALLOCATION_MIGRATION_REQUIRED');
    assertLendingClock({ principal: loan['principalAmount'], interestBps: loan['interestBps'], openedAt: loan['openedAt'],
      accruedAt: loan['accruedAt'], accruedInterest: loan['accruedInterest'], interestRemainder: loan['interestRemainder'],
      termMs: loan['termMs'], lateMs: loan['lateMs'] });
    if (loan['approval'] !== undefined) {
      const approval = decodeLendingFacility(loan['approval']);
      if (approval.borrowerEntityId !== loan['borrowerEntityId'] || approval.tokenId !== loan['tokenId'] || approval.termId !== loan['termId']) throw new Error('LENDING_LOAN_APPROVAL_BINDING');
    }
  }
};

const bankTermsForAccount = (state: EntityState, account: AccountReplica, tokenId: number, termId: LendingTermId): LendingBankTerms | undefined =>
  state.lending?.terms?.get(lendingTermsKey({ ...account.state.domain, tokenId, termId }));

/** This is bank acceptance policy, not a second Account settlement authority.
 * A peer cannot choose a coupon and make the bank automatically countersign it.
 * Already committed or already-signed local proposals retain their authority. */
export const bankSavingsAdmissionError = (state: EntityState, account: AccountReplica, tx: AccountTx, now: number): string | undefined => {
  if (tx.type !== 'lending_fund' || tx.data.hubEntityId !== state.entityId) return undefined;
  const terms = bankTermsForAccount(state, account, tx.data.tokenId, tx.data.termId);
  if (!terms || terms.expiresAt <= now) return 'LENDING_BANK_TERMS_UNAVAILABLE';
  if (terms.savingsInterestBps !== tx.data.interestBps) return 'LENDING_SAVINGS_RATE_NOT_APPROVED';
  return undefined;
};

export const approvedLendingDraw = (
  state: EntityState, account: AccountReplica, borrower: string,
  request: Extract<AccountTx, { type: 'lending_borrow_request' }>['data'], now: number,
): { ok: true; approval: LendingFacility; interestBps: number; lateMs: number } | { ok: false; reason: string } => {
  const terms = bankTermsForAccount(state, account, request.tokenId, request.termId);
  if (!terms || terms.expiresAt <= now) return { ok: false, reason: 'bank terms unavailable' };
  if (terms.loanInterestBps > request.maxInterestBps) return { ok: false, reason: 'bank rate exceeds requested maximum' };
  if (terms.loanLateMs > request.maxLateMs) return { ok: false, reason: 'bank late-interest window exceeds requested maximum' };
  const approval = state.lending?.facilities?.get(lendingFacilityKey(borrower, request.tokenId, request.termId));
  if (!approval || approval.expiresAt <= now || approval.maxPrincipal === 0n) return { ok: false, reason: 'no active bank approval' };
  const domain = account.state.domain;
  if (approval.chainId !== domain.chainId || approval.depositoryAddress !== domain.depositoryAddress || approval.jNonce !== account.state.jNonce) {
    return { ok: false, reason: 'approval belongs to another Account epoch' };
  }
  let reserved = 0n;
  for (const loan of state.lending?.loans.values() ?? []) {
    if (loan.borrowerEntityId === borrower && loan.tokenId === request.tokenId && loan.termId === request.termId
      && loan.status !== 'repaid' && loan.status !== 'disputed') reserved += loan.principalAmount;
  }
  if (reserved + request.amount > approval.maxPrincipal) return { ok: false, reason: 'approved facility exhausted' };
  return { ok: true, approval, interestBps: terms.loanInterestBps, lateMs: terms.loanLateMs };
};
