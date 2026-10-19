/**
 * Hub lending: offer liquidity to a hub's pool, borrow from it, repay. Entity
 * txs are the frontend's exact shapes; the pool and loan state is served by
 * the hub runtime's HTTP API, so it is live only against a hosted runtime.
 */
import type { EntityTx } from '@xln/core/api/public/runtime-module';
import { computeLendingInterest, normalizeInterestBps, normalizeLendingTerm, lendingLoanMaximumAmount } from '@xln/core/lendbook/state';
import type { AccountView } from '../views';
import { parseAmount } from '../format';
import { decodeLendingBankTerms, decodeLendingFacility } from '@xln/core/lendbook/policy';
import type { LendingTermId, LendingBankTerms, LendingFacility, LendingLoan as CoreLendingLoan } from '@xln/core/types/finance/lending';

export function previewLendingTerms(amount: string, rate: string, decimals: number, late?: { termMs: number; lateMs: number }) {
  if (!amount.trim()) return null;
  try {
    const principal = parseAmount(amount, decimals);
    if (principal <= 0n) throw new Error('Enter a positive amount');
    const interestBps = normalizeInterestBps(rate);
    const coupon = computeLendingInterest(principal, interestBps);
    const maximum = late ? lendingLoanMaximumAmount({ principalAmount: principal, interestBps, openedAt: 0,
      accruedAt: 0, accruedInterest: 0n, interestRemainder: 0n, ...late }) : principal + coupon;
    return { ok: true as const, principal, coupon, repayment: principal + coupon, maximum };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export function previewSavingsRisk(hub: AccountView, tokenId: number, amount: string, rate: string, decimals: number) {
  const quote = previewLendingTerms(amount, rate, decimals);
  if (!quote || !quote.ok) return quote;
  const risk = hub.doc.lendingRisk.get(tokenId);
  if (!risk) return { ok: false as const, error: 'Bank risk projection is unavailable' };
  const currentLimit = hub.isLeft ? risk.rightLimit : risk.leftLimit;
  const capacity = hub.isLeft ? risk.rightCouponCapacity : risk.leftCouponCapacity;
  const shortfall = quote.coupon > 0n && quote.coupon > capacity ? quote.coupon - capacity : 0n;
  return { ok: true as const, currentLimit, requiredLimit: currentLimit + shortfall };
}

export type TermId = LendingTermId;

export const LENDING_TERMS: Array<{ id: TermId; label: string }> = [
	{ id: 'demand', label: 'On demand' },
	{ id: '1h', label: '1 hour' },
	{ id: '1d', label: '1 day' },
	{ id: '1m', label: '1 month' },
];

export type LendingSavings = {
	positionId: string;
	hubEntityId: string;
	lenderEntityId: string;
	tokenId: number;
	principalAmount: bigint;
	closeAmount: bigint;
	matured: boolean;
	rateExpiresAt: number | null;
	interestBps: number;
	termId: TermId;
	status: string;
	updatedAt: number;
};

export type LendingLoan = {
	loanId: string;
	hubEntityId: string;
	borrowerEntityId: string;
	tokenId: number;
	principalAmount: bigint;
	accruedAt: number;
	accruedInterest: bigint;
	interestRemainder: bigint;
	repaymentAmount: bigint;
	repaidAmount: bigint;
	interestBps: number;
	termId: TermId;
	dueAt: number;
	openedAt: number;
	termMs: number;
	lateMs: number;
	status: string;
};

export type LendingState = {
	hubEntityId: string;
	savings: LendingSavings[];
	requestId: string | null;
	loans: LendingLoan[];
	terms: LendingBankTerms[];
	facilities: LendingFacility[];
	requestStatus: CoreLendingLoan['status'] | 'unseen' | 'not-funded' | null;
	totals: { savingsPrincipal: bigint; loanPrincipal: bigint; activePrincipal: bigint };
};

const money = (value: unknown, field: string): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`LENDING_MONEY_INVALID:${field}`);
  }
  return BigInt(value);
};

const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`LENDING_RECORD_INVALID:${field}`);
  return value as Record<string, unknown>;
};

const clock = (value: unknown, minimum: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error('Invalid loan clock');
  return value;
};

const term = normalizeLendingTerm;

export async function fetchLendingState(input: {
  hubEntityId: string;
  userEntityId: string;
  tokenId: number;
  requestId?: string;
}): Promise<LendingState> {
  const { getJson } = await import('../http');
  const result = await getJson('/api/lending/state', {
    hubEntityId: input.hubEntityId,
    userEntityId: input.userEntityId,
    tokenId: String(input.tokenId),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return decodeLendingState(result, input);
}

export function decodeLendingState(
  result: Record<string, unknown>,
  input: { hubEntityId: string; requestId?: string },
): LendingState {
  if (!Array.isArray(result['savings']) || !Array.isArray(result['loans']))
    throw new Error('Bank lending book schema mismatch');
  const savings = result['savings'].map(value => record(value, 'savings'));
  const loans = result['loans'].map(value => record(value, 'loans'));
  const totals = record(result['totals'], 'totals');
  if (!Array.isArray(result['terms']) || !Array.isArray(result['facilities']))
    throw new Error('Bank lending policy unavailable');
  const requestStatus = result['requestStatus'];
  const requestId = input.requestId ?? null;
  if (result['requestId'] !== requestId) throw new Error('Borrower request response mismatch');
  if (
    requestStatus !== null &&
    requestStatus !== 'unseen' &&
    requestStatus !== 'not-funded' &&
    requestStatus !== 'opening' &&
    requestStatus !== 'active' &&
    requestStatus !== 'closing' &&
    requestStatus !== 'repaid' &&
    requestStatus !== 'defaulted' &&
    requestStatus !== 'disputed'
  )
    throw new Error('Invalid borrower request status');
  return {
    requestId,
    requestStatus,
    hubEntityId: String(result['hubEntityId'] || input.hubEntityId),
    terms: result['terms'].map(decodeLendingBankTerms),
    facilities: result['facilities'].map((value: unknown) => {
      const facility = record(value, 'facility');
      return decodeLendingFacility({
        ...facility,
        maxPrincipal: money(facility['maxPrincipal'], 'facility.maxPrincipal'),
      });
    }),
    savings: savings.map(pool => ({
      positionId: String(pool['positionId'] || ''),
      hubEntityId: String(pool['hubEntityId'] || ''),
      lenderEntityId: String(pool['lenderEntityId'] || ''),
      tokenId: Number(pool['tokenId'] || 0),
      principalAmount: money(pool['principalAmount'], 'pool.principalAmount'),
      closeAmount: money(pool['closeAmount'], 'pool.closeAmount'),
      matured: pool['matured'] === true,
      rateExpiresAt:
        pool['termId'] === 'demand' && (pool['status'] === 'open' || pool['status'] === 'queued')
          ? clock(pool['rateExpiresAt'], 1)
          : null,
      interestBps: Number(pool['interestBps'] || 0),
      termId: term(pool['termId']),
      status: String(pool['status'] || ''),
      updatedAt: Number(pool['updatedAt'] || 0),
    })),
    loans: loans.map(loan => ({
      loanId: String(loan['loanId'] || ''),
      hubEntityId: String(loan['hubEntityId'] || ''),
      borrowerEntityId: String(loan['borrowerEntityId'] || ''),
      tokenId: Number(loan['tokenId'] || 0),
      principalAmount: money(loan['principalAmount'], 'loan.principalAmount'),
      accruedAt: clock(loan['accruedAt'], 0),
      accruedInterest: money(loan['accruedInterest'], 'loan.accruedInterest'),
      interestRemainder: money(loan['interestRemainder'], 'loan.interestRemainder'),
      repaymentAmount: money(loan['repaymentAmount'], 'loan.repaymentAmount'),
      repaidAmount: money(loan['repaidAmount'], 'loan.repaidAmount'),
      interestBps: Number(loan['interestBps'] || 0),
      termId: term(loan['termId']),
      dueAt: clock(loan['dueAt'], 0),
      openedAt: clock(loan['openedAt'], 0),
      termMs: clock(loan['termMs'], 1),
      lateMs: clock(loan['lateMs'], 0),
      status: String(loan['status'] || ''),
    })),
    totals: {
      savingsPrincipal: money(totals['savingsPrincipalAmount'], 'totals.savingsPrincipalAmount'),
      loanPrincipal: money(totals['loanPrincipalAmount'], 'totals.loanPrincipalAmount'),
      activePrincipal: money(totals['activePrincipalAmount'], 'totals.activePrincipalAmount'),
    },
  };
}

/** 'lend-<16 hex>' / 'borrow-<16 hex>', the frontend's intent id shape. */
export function newIntentId(prefix: 'lend' | 'borrow'): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return `${prefix}-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function buildLendingOfferTx(input: { hubEntityId: string; tokenId: number; amount: bigint; termId: TermId; interestBps: number }): EntityTx {
	return {
		type: 'lendingOffer',
		data: {
			positionId: newIntentId('lend'),
			hubEntityId: input.hubEntityId,
			tokenId: input.tokenId,
			amount: input.amount,
			termId: input.termId,
			interestBps: Math.max(0, Math.floor(Number(input.interestBps) || 0)),
		},
	};
}

export function buildLendingBorrowTx(input: { hubEntityId: string; tokenId: number; amount: bigint; termId: TermId; maxInterestBps: number; maxLateMs: number }): EntityTx {
	return {
		type: 'lendingBorrow',
		data: {
			requestId: newIntentId('borrow'),
			expiresAt: Date.now() + 5 * 60_000,
			maxLateMs: input.maxLateMs,
			hubEntityId: input.hubEntityId,
			tokenId: input.tokenId,
			amount: input.amount,
			termId: input.termId,
			maxInterestBps: Math.max(0, Math.floor(Number(input.maxInterestBps) || 0)),
		},
	};
}

export const isLendingLoanRepayable = (loan: LendingLoan): boolean =>
	(loan.status === 'active' || loan.status === 'defaulted') && loan.repaymentAmount > loan.repaidAmount;

export function buildLendingRepayTx(loan: LendingLoan, borrowerEntityId: string, amount?: bigint): EntityTx {
	if (!isLendingLoanRepayable(loan)) throw new Error(`Loan ${loan.loanId} has no repayable claim`);
	if (loan.borrowerEntityId.trim().toLowerCase() !== borrowerEntityId) throw new Error('Only the borrower repays this loan');
	// Debit only the committed-time amount due, bounded by the signed covenant.
	const remaining = amount ?? lendingLoanMaximumAmount(loan);
	if (remaining <= 0n) throw new Error('Nothing left to repay');
	return { type: 'lendingRepay', data: { hubEntityId: loan.hubEntityId, loanId: loan.loanId, tokenId: loan.tokenId, amount: remaining } };
}
