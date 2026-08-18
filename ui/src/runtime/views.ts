import { useMemo } from 'react';
import type { Delta, DerivedDelta } from '@xln/core/api/public/runtime-module';
import { useAdapterRead, type ReadState } from './hooks';
import { peekXLN } from './xln-loader';

export type EntityCoreView = {
	entityId: string;
	signerId?: string;
	height: number;
	timestamp: number;
	reserves: Map<number, bigint>;
	profile?: { name?: string } | null;
	prevFrameHash?: string;
	jBatchState?: unknown;
};

export type AccountTokenView = {
	tokenId: number;
	delta: Delta;
	derived: DerivedDelta;
	/** Net bilateral position from our perspective: positive = owed to us. */
	signed: bigint;
};

export type AccountView = {
	counterpartyId: string;
	isLeft: boolean;
	tokens: AccountTokenView[];
};

type AccountDoc = {
	state: {
		leftEntity: string;
		rightEntity: string;
		deltas: Map<number, Delta>;
	};
};

type AccountsPage = { items: AccountDoc[] };

export function useEntityCore(entityId: string | null): ReadState<EntityCoreView> {
	return useAdapterRead<EntityCoreView>(entityId ? `entity/${entityId}` : null);
}

export function useAccounts(entityId: string | null): { accounts: AccountView[]; loading: boolean; error: string | null } {
	const read = useAdapterRead<AccountsPage>(entityId ? `entity/${entityId}/accounts` : null);

	const accounts = useMemo<AccountView[]>(() => {
		const xln = peekXLN();
		if (!read.data?.items || !entityId || !xln) return [];
		const self = entityId.toLowerCase();
		const views: AccountView[] = [];
		for (const doc of read.data.items) {
			const left = String(doc.state?.leftEntity || '').toLowerCase();
			const right = String(doc.state?.rightEntity || '').toLowerCase();
			if (!left || !right) continue;
			const counterpartyId = left === self ? right : left;
			const isLeft = left === self;
			const tokens: AccountTokenView[] = [];
			for (const [tokenId, delta] of doc.state?.deltas?.entries?.() ?? []) {
				try {
					const derived = xln.deriveDelta(delta, isLeft);
					const total = delta.ondelta + delta.offdelta;
					// Negative total = LEFT pays, so LEFT's own position is +total
					// and RIGHT's is -total. Verified against a live routed payment.
					tokens.push({
						tokenId: Number(tokenId),
						delta,
						derived,
						signed: isLeft ? total : -total,
					});
				} catch {
					// Skip malformed deltas rather than blanking the whole account list.
				}
			}
			tokens.sort((a, b) => a.tokenId - b.tokenId);
			views.push({ counterpartyId, isLeft, tokens });
		}
		return views;
	}, [read.data, entityId]);

	return { accounts, loading: read.loading, error: read.error };
}

export type PortfolioToken = {
	tokenId: number;
	reserve: bigint;
	accountsNet: bigint;
	spendable: bigint;
	receivable: bigint;
	total: bigint;
};

export function usePortfolio(core: EntityCoreView | null, accounts: AccountView[]): PortfolioToken[] {
	return useMemo(() => {
		const byToken = new Map<number, PortfolioToken>();
		const ensure = (tokenId: number): PortfolioToken => {
			let entry = byToken.get(tokenId);
			if (!entry) {
				entry = { tokenId, reserve: 0n, accountsNet: 0n, spendable: 0n, receivable: 0n, total: 0n };
				byToken.set(tokenId, entry);
			}
			return entry;
		};
		for (const [tokenId, amount] of core?.reserves?.entries?.() ?? []) {
			ensure(Number(tokenId)).reserve = amount;
		}
		for (const account of accounts) {
			for (const token of account.tokens) {
				const entry = ensure(token.tokenId);
				entry.accountsNet += token.signed;
				entry.spendable += token.derived.outCapacity;
				entry.receivable += token.derived.inCapacity;
			}
		}
		for (const entry of byToken.values()) {
			entry.total = entry.reserve + entry.accountsNet;
		}
		return Array.from(byToken.values()).sort((a, b) => a.tokenId - b.tokenId);
	}, [core, accounts]);
}

export type SwapOfferView = {
	counterpartyId: string;
	offerId: string;
	giveTokenId: number;
	giveAmount: bigint;
	wantTokenId: number;
	wantAmount: bigint;
	priceTicks: bigint;
	createdHeight: number;
	mine: boolean;
};

type SwapOfferDoc = {
	offerId: string;
	giveTokenId: number;
	giveAmount: bigint;
	wantTokenId: number;
	wantAmount: bigint;
	priceTicks: bigint;
	createdHeight: number;
	makerIsLeft: boolean;
};

type AccountDocWithOffers = AccountDoc & { state: { swapOffers?: Map<string, SwapOfferDoc> } };
type AccountsPageWithOffers = { items: AccountDocWithOffers[] };

/** Open swap offers across every bilateral account, newest first. */
export function useOpenSwapOffers(entityId: string | null): { offers: SwapOfferView[]; loading: boolean } {
	const read = useAdapterRead<AccountsPageWithOffers>(entityId ? `entity/${entityId}/accounts` : null);

	const offers = useMemo<SwapOfferView[]>(() => {
		if (!read.data?.items || !entityId) return [];
		const self = entityId.toLowerCase();
		const out: SwapOfferView[] = [];
		for (const doc of read.data.items) {
			const left = String(doc.state?.leftEntity || '').toLowerCase();
			const right = String(doc.state?.rightEntity || '').toLowerCase();
			if (!left || !right) continue;
			const counterpartyId = left === self ? right : left;
			const isLeft = left === self;
			for (const offer of doc.state?.swapOffers?.values?.() ?? []) {
				out.push({
					counterpartyId,
					offerId: offer.offerId,
					giveTokenId: offer.giveTokenId,
					giveAmount: offer.giveAmount,
					wantTokenId: offer.wantTokenId,
					wantAmount: offer.wantAmount,
					priceTicks: offer.priceTicks,
					createdHeight: offer.createdHeight,
					mine: offer.makerIsLeft === isLeft,
				});
			}
		}
		out.sort((a, b) => b.createdHeight - a.createdHeight);
		return out;
	}, [read.data, entityId]);

	return { offers, loading: read.loading };
}

export function displayEntityName(core: EntityCoreView | null, entityId: string | null): string {
	const name = String(core?.profile?.name || '').trim();
	if (name) return name;
	const id = String(entityId || '');
	return id ? `${id.slice(0, 8)}…` : '—';
}
