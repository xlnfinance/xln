/**
 * Hub lending: offer liquidity to a hub's pool, borrow from it, repay. Entity
 * txs are the frontend's exact shapes; the pool and loan state is served by
 * the hub runtime's HTTP API, so it is live only against a hosted runtime.
 */
import type { EntityTx } from '@xln/core/api/public/runtime-module';
import { getJson } from '../http';

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
	status: string;
};

export type LendingState = {
	hubEntityId: string;
	pools: LendingPool[];
	loans: LendingLoan[];
	totals: { available: bigint; borrowed: bigint; activePrincipal: bigint };
};

const big = (value: unknown): bigint => {
	try {
		return BigInt(String(value ?? '0'));
	} catch {
		return 0n;
	}
};

const term = (value: unknown): TermId => (value === '1h' || value === '1m' ? value : '1d');

export async function fetchLendingState(input: { hubEntityId: string; userEntityId: string; tokenId: number }): Promise<LendingState> {
	const result = await getJson('/api/lending/state', { hubEntityId: input.hubEntityId, userEntityId: input.userEntityId, tokenId: String(input.tokenId) });
	const pools = Array.isArray(result['pools']) ? (result['pools'] as Array<Record<string, unknown>>) : [];
	const loans = Array.isArray(result['loans']) ? (result['loans'] as Array<Record<string, unknown>>) : [];
	const totals = (result['totals'] ?? {}) as Record<string, unknown>;
	return {
		hubEntityId: String(result['hubEntityId'] || input.hubEntityId),
		pools: pools.map(pool => ({
			positionId: String(pool['positionId'] || ''),
			hubEntityId: String(pool['hubEntityId'] || ''),
			lenderEntityId: String(pool['lenderEntityId'] || ''),
			tokenId: Number(pool['tokenId'] || 0),
			principalAmount: big(pool['principalAmount']),
			availableAmount: big(pool['availableAmount']),
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
			dueAt: Number(loan['dueAt'] || 0),
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

export function buildLendingBorrowTx(input: { hubEntityId: string; tokenId: number; amount: bigint; termId: TermId; maxInterestBps: number }): EntityTx {
	return {
		type: 'lendingBorrow',
		data: {
			requestId: newIntentId('borrow'),
			hubEntityId: input.hubEntityId,
			tokenId: input.tokenId,
			amount: input.amount,
			termId: input.termId,
			maxInterestBps: Math.max(0, Math.floor(Number(input.maxInterestBps) || 0)),
		},
	};
}

export function buildLendingRepayTx(loan: LendingLoan, borrowerEntityId: string): EntityTx {
	if (loan.status !== 'active') throw new Error(`Loan ${loan.loanId} is ${loan.status}, not active`);
	if (loan.borrowerEntityId.trim().toLowerCase() !== borrowerEntityId) throw new Error('Only the borrower repays this loan');
	const remaining = loan.repaymentAmount - loan.repaidAmount;
	if (remaining <= 0n) throw new Error('Nothing left to repay');
	return { type: 'lendingRepay', data: { hubEntityId: loan.hubEntityId, loanId: loan.loanId, tokenId: loan.tokenId, amount: remaining } };
}
