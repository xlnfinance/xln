/**
 * Hub lending: offer liquidity to a hub's pool, borrow from it, repay. Entity
 * txs are the frontend's exact shapes; the pool and loan state is served by
 * the hub runtime's HTTP API, so it is live only against a hosted runtime.
 */
import type { EntityTx } from '@xln/core/api/public/runtime-module';
import { computeLendingInterest, normalizeInterestBps, lendingLoanMaximumAmount } from '@xln/core/extensions/lending';
import type { AccountView } from '../views';
import { parseAmount } from '../format';
import { decodeLendingBankTerms, decodeLendingFacility } from '@xln/core/entity/lending-policy';
import type { LendingBankTerms, LendingFacility, LendingLoan as CoreLendingLoan } from '@xln/core/types/finance/lending';

export function previewLendingTerms(amount: string, rate: string, decimals: number, late?: { termMs: number; lateMs: number }) {
  if (!amount.trim()) return null;
  try {
    const principal = parseAmount(amount, decimals);
    if (principal <= 0n) throw new Error('Enter a positive amount');
    const coupon = computeLendingInterest(principal, normalizeInterestBps(rate));
    const maximum = late ? lendingLoanMaximumAmount({ principalAmount: principal, interestAmount: coupon, openedAt: 0, ...late }) : principal + coupon;
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

export type TermId = '1h' | '1d' | '1m';

export const LENDING_TERMS: Array<{ id: TermId; label: string }> = [
	{ id: '1h', label: '1 hour' },
	{ id: '1d', label: '1 day' },
	{ id: '1m', label: '1 month' },
];

export type LendingPool = {
	positionId: string;
	hubEntityId: string;
	lenderEntityId: string;
	tokenId: number;
	principalAmount: bigint;
	availableAmount: bigint;
	closeAmount: bigint;
	matured: boolean;
	borrowedAmount: bigint;
	interestBps: number;
	termId: TermId;
	status: string;
	updatedAt: number;
};

export type LendingLoan = {
	loanId: string;
	hubEntityId: string;
	borrowerEntityId: string;
	lenderEntityId: string;
	positionId: string;
	tokenId: number;
	principalAmount: bigint;
	interestAmount: bigint;
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
	pools: LendingPool[];
	requestId: string | null;
	loans: LendingLoan[];
	terms: LendingBankTerms[];
	facilities: LendingFacility[];
	requestStatus: CoreLendingLoan['status'] | 'unseen' | 'not-funded' | null;
	totals: { available: bigint; borrowed: bigint; activePrincipal: bigint };
};

const big = (value: unknown): bigint => {
	try {
		return BigInt(String(value ?? '0'));
	} catch {
		return 0n;
	}
};

const clock = (value: unknown, minimum: number): number => {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Invalid loan clock');
	return value;
};

const term = (value: unknown): TermId => (value === '1h' || value === '1m' ? value : '1d');

export async function fetchLendingState(input: { hubEntityId: string; userEntityId: string; tokenId: number; requestId?: string }): Promise<LendingState> {
	const { getJson } = await import('../http');
	const result = await getJson('/api/lending/state', { hubEntityId: input.hubEntityId, userEntityId: input.userEntityId, tokenId: String(input.tokenId), ...(input.requestId ? { requestId: input.requestId } : {}) });
	const pools = Array.isArray(result['pools']) ? (result['pools'] as Array<Record<string, unknown>>) : [];
	const loans = Array.isArray(result['loans']) ? (result['loans'] as Array<Record<string, unknown>>) : [];
	const totals = (result['totals'] ?? {}) as Record<string, unknown>;
	if (!Array.isArray(result['terms']) || !Array.isArray(result['facilities'])) throw new Error('Bank lending policy unavailable');
	const requestStatus = result['requestStatus'];
	const requestId = input.requestId ?? null;
	if (result['requestId'] !== requestId) throw new Error('Borrower request response mismatch');
	if (requestStatus !== null && requestStatus !== 'unseen' && requestStatus !== 'not-funded' && requestStatus !== 'opening' && requestStatus !== 'active' && requestStatus !== 'closing' && requestStatus !== 'repaid' && requestStatus !== 'defaulted' && requestStatus !== 'disputed') throw new Error('Invalid borrower request status');
	return {
		requestId,
		requestStatus,
		hubEntityId: String(result['hubEntityId'] || input.hubEntityId),
		terms: result['terms'].map(decodeLendingBankTerms),
		facilities: result['facilities'].map((value: unknown) => {
			if (!value || typeof value !== 'object' || !('maxPrincipal' in value) || typeof value.maxPrincipal !== 'string' || !/^\d+$/.test(value.maxPrincipal)) throw new Error('Invalid bank facility');
			return decodeLendingFacility({ ...value, maxPrincipal: BigInt(value.maxPrincipal) });
		}),
		pools: pools.map(pool => ({
			positionId: String(pool['positionId'] || ''),
			hubEntityId: String(pool['hubEntityId'] || ''),
			lenderEntityId: String(pool['lenderEntityId'] || ''),
			tokenId: Number(pool['tokenId'] || 0),
			principalAmount: big(pool['principalAmount']),
			availableAmount: big(pool['availableAmount']),
			closeAmount: BigInt(String(pool['closeAmount'])),
			matured: pool['matured'] === true,
			borrowedAmount: big(pool['borrowedAmount']),
			interestBps: Number(pool['interestBps'] || 0),
			termId: term(pool['termId']),
			status: String(pool['status'] || ''),
			updatedAt: Number(pool['updatedAt'] || 0),
		})),
		loans: loans.map(loan => ({
			loanId: String(loan['loanId'] || ''),
			hubEntityId: String(loan['hubEntityId'] || ''),
			borrowerEntityId: String(loan['borrowerEntityId'] || ''),
			lenderEntityId: String(loan['lenderEntityId'] || ''),
			positionId: String(loan['positionId'] || ''),
			tokenId: Number(loan['tokenId'] || 0),
			principalAmount: big(loan['principalAmount']),
			interestAmount: big(loan['interestAmount']),
			repaymentAmount: big(loan['repaymentAmount']),
			repaidAmount: big(loan['repaidAmount']),
			interestBps: Number(loan['interestBps'] || 0),
			termId: term(loan['termId']),
			dueAt: clock(loan['dueAt'], 0),
			openedAt: clock(loan['openedAt'], 0), termMs: clock(loan['termMs'], 1), lateMs: clock(loan['lateMs'], 0),
			status: String(loan['status'] || ''),
		})),
		totals: { available: big(totals['availableAmount']), borrowed: big(totals['borrowedAmount']), activePrincipal: big(totals['activePrincipalAmount']) },
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

export function buildLendingRepayTx(loan: LendingLoan, borrowerEntityId: string): EntityTx {
	if (!isLendingLoanRepayable(loan)) throw new Error(`Loan ${loan.loanId} has no repayable claim`);
	if (loan.borrowerEntityId.trim().toLowerCase() !== borrowerEntityId) throw new Error('Only the borrower repays this loan');
	// Debit only the committed-time amount due, bounded by the signed covenant.
	const remaining = lendingLoanMaximumAmount(loan) - loan.repaidAmount;
	if (remaining <= 0n) throw new Error('Nothing left to repay');
	return { type: 'lendingRepay', data: { hubEntityId: loan.hubEntityId, loanId: loan.loanId, tokenId: loan.tokenId, amount: remaining } };
}
