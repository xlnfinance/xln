import { useMemo } from 'react';
import type {
	Delta,
	DerivedDelta,
	JBatchState,
	RuntimeAdapterEntitySummary,
	RuntimeAdapterViewFrame,
} from '@xln/core/api/public/runtime-module';
import { useAdapterRead, type ReadState } from './hooks';
import { peekXLN } from './xln-loader';
import { usdOf } from './financial/prices';
import { disputeView, settlementView, type AccountDoc, type DisputePhase, type SettlementPhase } from './financial/manage';

/**
 * One projection read per committed frame, the same `view-frame` the SvelteKit
 * frontend renders from (`readRuntimeEntityProjectionFrame`). Everything on
 * Home, Pay and Swap derives from this single frame.
 */
export const VIEW_FRAME_QUERY = { accountsLimit: 50, booksLimit: 10 } as const;

export function useViewFrame(entityId: string | null): ReadState<RuntimeAdapterViewFrame> {
	const query = useMemo(() => (entityId ? { entityId, ...VIEW_FRAME_QUERY } : undefined), [entityId]);
	return useAdapterRead<RuntimeAdapterViewFrame>(entityId ? 'view-frame' : null, query);
}

export type AccountTokenView = {
	tokenId: number;
	delta: Delta;
	derived: DerivedDelta;
	/** Net bilateral position from our perspective: positive means they owe us. */
	signed: bigint;
};

export type AccountView = {
	counterpartyId: string;
	isLeft: boolean;
	label: string;
	isHub: boolean;
	tokens: AccountTokenView[];
	disputed: boolean;
	dispute: DisputePhase;
	/** 'none' when no settlement workspace is open on this account. */
	settlement: SettlementPhase;
	frameHeight: number;
	/** The full account document, for management screens that need policy and workspace detail. */
	doc: AccountDoc;
};

/** Money that lives outside bilateral accounts: on-chain wallet or Depository reserve. */
export type PlaceRow = {
	tokenId: number;
	amount: bigint;
	/** Reserve deposits accepted into a J-batch but not yet observed on-chain. */
	pending: bigint;
	jurisdiction: string;
};

export type TokenTotals = {
	tokenId: number;
	onchain: bigint;
	reserve: bigint;
	pending: bigint;
	/** Sum of positive account positions: what counterparties owe us. */
	receivable: bigint;
	/** Sum of negative account positions: what we owe. Never positive. */
	owed: bigint;
	net: bigint;
	/** Instant send / receive room across every account holding this token. */
	sendCapacity: bigint;
	receiveCapacity: bigint;
	/** False when nothing about this token is non-zero: no money, no debt, no credit room. */
	active: boolean;
	jurisdictions: string[];
};

export type WalletView = {
	frame: RuntimeAdapterViewFrame | null;
	entityId: string;
	signerId: string;
	name: string;
	jurisdiction: string;
	frameHeight: number;
	summaries: RuntimeAdapterEntitySummary[];
	names: Map<string, string>;
	hubs: Set<string>;
	accounts: AccountView[];
	onchain: PlaceRow[];
	reserves: PlaceRow[];
	totals: TokenTotals[];
	usd: { onchain: number; reserve: number; pending: number; receivable: number; owed: number; net: number; sendCapacity: number; receiveCapacity: number };
	loading: boolean;
	error: string | null;
	refresh: () => void;
};

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

export function displayEntityName(names: Map<string, string>, entityId: string): string {
	const name = names.get(normalizeId(entityId));
	if (name && name.trim()) return name.trim();
	const id = String(entityId || '');
	return id ? `${id.slice(0, 8)}…${id.slice(-4)}` : '—';
}

function readPendingReserveByToken(entityId: string, jBatchState: JBatchState | undefined): Map<number, bigint> {
	const pending = new Map<number, bigint>();
	if (!jBatchState) return pending;
	const batches = [jBatchState.batch, jBatchState.sentBatch?.batch].filter(Boolean) as Array<JBatchState['batch']>;
	for (const batch of batches) {
		for (const deposit of batch.externalTokenToReserve ?? []) {
			if (normalizeId(deposit.entity) !== entityId) continue;
			const tokenId = Number(deposit.internalTokenId);
			pending.set(tokenId, (pending.get(tokenId) ?? 0n) + deposit.amount);
		}
	}
	return pending;
}

export function useWallet(entityId: string | null): WalletView {
	const read = useViewFrame(entityId);
	const frame = read.data;

	return useMemo<WalletView>(() => {
		const xln = peekXLN();
		const self = normalizeId(entityId);
		const summaries = frame?.entities ?? [];
		const names = new Map<string, string>();
		const hubs = new Set<string>();
		for (const summary of summaries) {
			const id = normalizeId(summary.entityId);
			if (!id) continue;
			if (summary.label) names.set(id, summary.label);
			if (summary.isHub) hubs.add(id);
		}

		const active = frame?.activeEntity ?? null;
		const core = active?.core ?? null;
		const jurisdiction = String(core?.config?.jurisdiction?.name || active?.summary?.jurisdiction?.name || '').trim();
		const profileName = String(core?.profile?.name || active?.summary?.label || '').trim();
		if (profileName && self) names.set(self, profileName);

		const accounts: AccountView[] = [];
		for (const doc of active?.accounts?.items ?? []) {
			const left = normalizeId(doc.state?.leftEntity);
			const right = normalizeId(doc.state?.rightEntity);
			if (!left || !right || !xln) continue;
			const counterpartyId = left === self ? right : left;
			const isLeft = left === self;
			const tokens: AccountTokenView[] = [];
			for (const [tokenId, delta] of doc.state.deltas.entries()) {
				const derived = xln.deriveDelta(delta, isLeft);
				const total = delta.ondelta + delta.offdelta;
				// Negative total means LEFT pays: LEFT's own position is +total, RIGHT's is -total.
				tokens.push({ tokenId: Number(tokenId), delta, derived, signed: isLeft ? total : -total });
			}
			tokens.sort((a, b) => a.tokenId - b.tokenId);
			const dispute = disputeView(doc, isLeft, core?.jBatchState?.batch ?? null);
			accounts.push({
				counterpartyId,
				isLeft,
				label: displayEntityName(names, counterpartyId),
				isHub: hubs.has(counterpartyId),
				tokens,
				disputed: Boolean(doc.activeDispute) || String(doc.status || '').toLowerCase() === 'disputed',
				dispute: dispute.phase,
				settlement: settlementView(doc, isLeft)?.phase ?? 'none',
				frameHeight: Number(doc.currentFrame?.height ?? 0),
				doc,
			});
		}
		accounts.sort((a, b) => (a.isHub === b.isHub ? a.label.localeCompare(b.label) : a.isHub ? -1 : 1));

		const onchainByToken = new Map<number, bigint>();
		for (const perOwner of core?.externalWallet?.balances?.values() ?? []) {
			for (const record of perOwner.values()) {
				if (typeof record.tokenId !== 'number' || record.balance <= 0n) continue;
				onchainByToken.set(record.tokenId, (onchainByToken.get(record.tokenId) ?? 0n) + record.balance);
			}
		}
		const onchain: PlaceRow[] = Array.from(onchainByToken.entries())
			.map(([tokenId, amount]) => ({ tokenId, amount, pending: 0n, jurisdiction }))
			.sort((a, b) => a.tokenId - b.tokenId);

		const pendingByToken = readPendingReserveByToken(self, core?.jBatchState);
		const reserveTokens = new Set<number>([...(core?.reserves?.keys() ?? []), ...pendingByToken.keys()].map(Number));
		const reserves: PlaceRow[] = Array.from(reserveTokens)
			.map(tokenId => ({
				tokenId,
				amount: core?.reserves?.get(tokenId) ?? 0n,
				pending: pendingByToken.get(tokenId) ?? 0n,
				jurisdiction,
			}))
			.filter(row => row.amount > 0n || row.pending > 0n)
			.sort((a, b) => a.tokenId - b.tokenId);

		const tokenIds = new Set<number>([
			...onchain.map(row => row.tokenId),
			...reserves.map(row => row.tokenId),
			...accounts.flatMap(account => account.tokens.map(token => token.tokenId)),
		]);
		const totals: TokenTotals[] = Array.from(tokenIds)
			.sort((a, b) => a - b)
			.map(tokenId => {
				const onchainAmount = onchain.filter(row => row.tokenId === tokenId).reduce((sum, row) => sum + row.amount, 0n);
				const reserveAmount = reserves.filter(row => row.tokenId === tokenId).reduce((sum, row) => sum + row.amount, 0n);
				const pending = reserves.filter(row => row.tokenId === tokenId).reduce((sum, row) => sum + row.pending, 0n);
				let receivable = 0n;
				let owed = 0n;
				let sendCapacity = 0n;
				let receiveCapacity = 0n;
				for (const account of accounts) {
					for (const token of account.tokens) {
						if (token.tokenId !== tokenId) continue;
						if (token.signed > 0n) receivable += token.signed;
						else owed += token.signed;
						sendCapacity += token.derived.outCapacity;
						receiveCapacity += token.derived.inCapacity;
					}
				}
				const active =
					onchainAmount > 0n || reserveAmount > 0n || pending > 0n || receivable > 0n || owed < 0n || sendCapacity > 0n || receiveCapacity > 0n;
				return {
					tokenId,
					onchain: onchainAmount,
					reserve: reserveAmount,
					pending,
					receivable,
					owed,
					net: onchainAmount + reserveAmount + receivable + owed,
					sendCapacity,
					receiveCapacity,
					active,
					jurisdictions: jurisdiction ? [jurisdiction] : [],
				};
			});

		const usd = { onchain: 0, reserve: 0, pending: 0, receivable: 0, owed: 0, net: 0, sendCapacity: 0, receiveCapacity: 0 };
		for (const total of totals) {
			usd.onchain += usdOf(total.tokenId, total.onchain);
			usd.reserve += usdOf(total.tokenId, total.reserve);
			usd.pending += usdOf(total.tokenId, total.pending);
			usd.receivable += usdOf(total.tokenId, total.receivable);
			usd.owed += usdOf(total.tokenId, -total.owed);
		}
		usd.net = usd.onchain + usd.reserve + usd.receivable - usd.owed;
		for (const account of accounts) {
			for (const token of account.tokens) {
				usd.sendCapacity += usdOf(token.tokenId, token.derived.outCapacity);
				usd.receiveCapacity += usdOf(token.tokenId, token.derived.inCapacity);
			}
		}

		return {
			frame,
			entityId: self,
			signerId: normalizeId(core?.signerId || active?.summary?.signerId || ''),
			name: profileName || displayEntityName(names, self),
			jurisdiction,
			frameHeight: Number(frame?.height ?? 0),
			summaries,
			names,
			hubs,
			accounts,
			onchain,
			reserves,
			totals,
			usd,
			loading: read.loading,
			error: read.error,
			refresh: read.refresh,
		};
	}, [frame, entityId, read.loading, read.error, read.refresh]);
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

/** Open swap offers across every bilateral account in the frame, newest first. */
export function openSwapOffers(frame: RuntimeAdapterViewFrame | null, entityId: string): SwapOfferView[] {
	const self = normalizeId(entityId);
	const out: SwapOfferView[] = [];
	for (const doc of frame?.activeEntity?.accounts?.items ?? []) {
		const left = normalizeId(doc.state?.leftEntity);
		const right = normalizeId(doc.state?.rightEntity);
		if (!left || !right) continue;
		const counterpartyId = left === self ? right : left;
		const isLeft = left === self;
		for (const offer of doc.state.swapOffers?.values() ?? []) {
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
}
