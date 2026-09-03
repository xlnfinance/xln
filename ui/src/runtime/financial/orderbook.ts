import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountState } from '@xln/core/api/public/runtime-module';
import { decodeMarketWireResponse, encodeMarketWireMessage } from '@xln/core/network/relay/market/wire';
import { normalizeMarketPairId } from '@xln/core/network/relay/market/identifiers';
import { resolveOrderbookRelayWsUrl } from '@xln/frontend/lib/components/Trading/orderbook-relay-url';
import { getAdapter } from '../adapter';
import { useAdapterRead } from '../hooks';
import { useApp } from '../store';
import { peekXLN } from '../xln-loader';

/** Canonical price unit of the runtime orderbook: ticks per quote unit, 4 decimals. */
export const PRICE_SCALE = 10_000n;

export type BookLevel = {
	priceTicks: bigint;
	/** Base amount at this price, raw base units. */
	size: bigint;
	/** Cumulative base amount from the best price down to this level. */
	total: bigint;
	orders: number;
	/** True when one of this wallet's own offers rests here. */
	own: boolean;
};

export type BookView = {
	pairId: string;
	baseTokenId: number;
	quoteTokenId: number;
	/** Best price first on both sides. */
	bids: BookLevel[];
	asks: BookLevel[];
	spreadTicks: bigint | null;
	lastTradeTicks: bigint | null;
	status: 'live' | 'syncing' | 'no-market' | 'unavailable';
	source: 'hosted' | 'relay';
	updatedAt: number;
	error: string | null;
};

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

export function orientPair(tokenA: number, tokenB: number): { baseTokenId: number; quoteTokenId: number; pairId: string } {
	const xln = peekXLN();
	if (xln?.getSwapPairOrientation) return xln.getSwapPairOrientation(tokenA, tokenB);
	const left = Math.min(tokenA, tokenB);
	const right = Math.max(tokenA, tokenB);
	const liquid = (id: number): boolean => id === 1 || id === 3;
	const pairId = `${left}/${right}`;
	if (liquid(tokenA) && !liquid(tokenB)) return { baseTokenId: tokenB, quoteTokenId: tokenA, pairId };
	if (!liquid(tokenA) && liquid(tokenB)) return { baseTokenId: tokenA, quoteTokenId: tokenB, pairId };
	return { baseTokenId: left, quoteTokenId: right, pairId };
}

/** Quote amount for `size` base units at `priceTicks`, in raw quote units. */
export function quoteForBase(size: bigint, priceTicks: bigint, baseDecimals: number, quoteDecimals: number): bigint {
	const baseUnit = 10n ** BigInt(baseDecimals);
	const quoteUnit = 10n ** BigInt(quoteDecimals);
	return (size * priceTicks * quoteUnit) / (PRICE_SCALE * baseUnit);
}

// ---------------------------------------------------------------------------
// Hosted hub: the book is the union of resting offers on the hub's accounts.
// ---------------------------------------------------------------------------

type HostedAccountDoc = { state?: AccountState };
type HostedAccountsPage = { items?: HostedAccountDoc[] };

function foldLevels(entries: Array<{ priceTicks: bigint; size: bigint; own: boolean }>, bestFirst: (a: bigint, b: bigint) => number, depth: number): BookLevel[] {
	const byPrice = new Map<bigint, BookLevel>();
	for (const entry of entries) {
		const level = byPrice.get(entry.priceTicks) ?? { priceTicks: entry.priceTicks, size: 0n, total: 0n, orders: 0, own: false };
		level.size += entry.size;
		level.orders += 1;
		level.own = level.own || entry.own;
		byPrice.set(entry.priceTicks, level);
	}
	const levels = [...byPrice.values()].sort((a, b) => bestFirst(a.priceTicks, b.priceTicks)).slice(0, depth);
	let running = 0n;
	for (const level of levels) {
		running += level.size;
		level.total = running;
	}
	return levels;
}

/** Build the hub's book for one pair from the offers resting on its accounts. */
export function bookFromHostedAccounts(
	docs: readonly HostedAccountDoc[],
	pair: { baseTokenId: number; quoteTokenId: number; pairId: string },
	ownEntityId: string,
	depth: number,
): Pick<BookView, 'bids' | 'asks'> {
	const own = normalizeId(ownEntityId);
	const bids: Array<{ priceTicks: bigint; size: bigint; own: boolean }> = [];
	const asks: Array<{ priceTicks: bigint; size: bigint; own: boolean }> = [];
	for (const doc of docs) {
		const state = doc.state;
		if (!state?.swapOffers) continue;
		const left = normalizeId(state.leftEntity);
		const right = normalizeId(state.rightEntity);
		for (const offer of state.swapOffers.values()) {
			if (offer.crossJurisdiction) continue;
			const maker = offer.makerIsLeft ? left : right;
			const isOwn = maker === own;
			if (offer.giveTokenId === pair.baseTokenId && offer.wantTokenId === pair.quoteTokenId) {
				// Maker sells base for quote: an ask, sized by what is still offered.
				asks.push({ priceTicks: offer.priceTicks, size: offer.giveAmount, own: isOwn });
			} else if (offer.giveTokenId === pair.quoteTokenId && offer.wantTokenId === pair.baseTokenId) {
				// Maker buys base with quote: a bid, sized by the base still wanted.
				bids.push({ priceTicks: offer.priceTicks, size: offer.wantAmount, own: isOwn });
			}
		}
	}
	return {
		bids: foldLevels(bids, (a, b) => (a > b ? -1 : a < b ? 1 : 0), depth),
		asks: foldLevels(asks, (a, b) => (a < b ? -1 : a > b ? 1 : 0), depth),
	};
}

// ---------------------------------------------------------------------------
// Relay market stream, for hubs this runtime does not host.
// ---------------------------------------------------------------------------

type RelayLevel = { price: string; size: string; total: string; orderCount?: number; ownerIds?: string[] };
type RelaySnapshot = { pairId: string; bids: RelayLevel[]; asks: RelayLevel[]; spread: string | null; lastTradePrice: string | null; updatedAt: number };

function relayLevels(levels: RelayLevel[], ownEntityId: string, lotScale: bigint): BookLevel[] {
	const own = normalizeId(ownEntityId);
	return levels.map(level => ({
		priceTicks: BigInt(level.price),
		size: BigInt(level.size) * lotScale,
		total: BigInt(level.total) * lotScale,
		orders: Number(level.orderCount ?? 1),
		own: (level.ownerIds ?? []).some(id => normalizeId(id) === own),
	}));
}

const RELAY_STALE_MS = 15_000;

/**
 * The relay's market feed for one hub and pair. Same wire protocol and same
 * URL resolution as the SvelteKit OrderbookPanel; one socket per hook.
 */
function useRelayBook(input: { enabled: boolean; hubId: string; relayUrl: string; pairId: string; depth: number; ownEntityId: string; lotScale: bigint }) {
	const [snapshot, setSnapshot] = useState<RelaySnapshot | null>(null);
	const [status, setStatus] = useState<BookView['status']>('syncing');
	const [error, setError] = useState<string | null>(null);
	const socketRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		if (!input.enabled || !input.hubId || !input.pairId) return;
		const resolution = resolveOrderbookRelayWsUrl(input.relayUrl, typeof window === 'undefined' ? null : window.location);
		if (!resolution.url) {
			setStatus('unavailable');
			setError(resolution.unavailableReason || 'RELAY_URL_UNAVAILABLE');
			return;
		}
		let cancelled = false;
		let seq = 0;
		setStatus('syncing');
		setError(null);
		const socket = new WebSocket(resolution.url);
		socketRef.current = socket;
		socket.onopen = () => {
			socket.send(
				encodeMarketWireMessage({
					type: 'market_subscribe',
					id: `market_sub_${Date.now()}_${++seq}`,
					replace: true,
					hubEntityIds: [input.hubId],
					pairs: [input.pairId],
					depth: input.depth,
				}),
			);
		};
		socket.onmessage = event => {
			if (cancelled) return;
			let message: ReturnType<typeof decodeMarketWireResponse>;
			try {
				message = decodeMarketWireResponse(JSON.parse(String(event.data)));
			} catch (decodeError) {
				setError(decodeError instanceof Error ? decodeError.message : String(decodeError));
				return;
			}
			if (message.type === 'market_snapshot') {
				const payload = message.payload as unknown as RelaySnapshot;
				if (normalizeMarketPairId(payload.pairId) !== input.pairId) return;
				setSnapshot(payload);
				setStatus('live');
			} else if (message.type === 'market_status') {
				setStatus('no-market');
			} else if (message.type === 'error') {
				setError(message.error);
				setStatus('unavailable');
			}
		};
		socket.onerror = () => {
			if (!cancelled) {
				setStatus('unavailable');
				setError('RELAY_SOCKET_ERROR');
			}
		};
		socket.onclose = () => {
			if (!cancelled && status === 'live') setStatus('syncing');
		};
		return () => {
			cancelled = true;
			socketRef.current = null;
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(encodeMarketWireMessage({ type: 'market_unsubscribe', id: `market_unsub_${Date.now()}`, pairs: [input.pairId] }));
			}
			socket.close();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [input.enabled, input.hubId, input.relayUrl, input.pairId, input.depth]);

	return useMemo(() => {
		if (!input.enabled) return null;
		const stale = snapshot ? Date.now() - snapshot.updatedAt > RELAY_STALE_MS : false;
		return {
			bids: snapshot ? relayLevels(snapshot.bids, input.ownEntityId, input.lotScale) : [],
			asks: snapshot ? relayLevels(snapshot.asks, input.ownEntityId, input.lotScale) : [],
			spreadTicks: snapshot?.spread ? BigInt(snapshot.spread) : null,
			lastTradeTicks: snapshot?.lastTradePrice ? BigInt(snapshot.lastTradePrice) : null,
			status: stale && status === 'live' ? ('syncing' as const) : status,
			updatedAt: snapshot?.updatedAt ?? 0,
			error,
		};
	}, [input.enabled, input.ownEntityId, input.lotScale, snapshot, status, error]);
}

/**
 * The hub's book for a token pair. A hub this runtime hosts (the sandbox, an
 * operator's own hub) is read from its accounts on every frame; any other hub
 * comes through the relay market stream, as in the SvelteKit panel.
 */
export function useOrderbook(input: {
	hubId: string;
	tokenA: number;
	tokenB: number;
	depth?: number;
	ownEntityId: string;
	relayUrl?: string;
	baseDecimals: number;
}): BookView {
	const depth = input.depth ?? 12;
	const pair = useMemo(() => orientPair(input.tokenA, input.tokenB), [input.tokenA, input.tokenB]);
	const hubId = normalizeId(input.hubId);
	const query = useMemo(() => ({ accountsLimit: 200 }), []);
	const hosted = useAdapterRead<HostedAccountsPage>(hubId ? `entity/${encodeURIComponent(hubId)}/accounts` : null, query);
	const height = useApp(s => s.height);
	const hostedMissing = Boolean(hosted.error && /E_NOT_FOUND|entity not found/i.test(hosted.error));
	// Relay lots are base units scaled to six decimals; a base token with fewer decimals uses its own scale.
	const lotScale = 10n ** BigInt(Math.max(0, input.baseDecimals - Math.min(input.baseDecimals, 6)));
	const relay = useRelayBook({
		enabled: hostedMissing || (getAdapter()?.mode === 'remote' && !hosted.data && !hosted.loading),
		hubId,
		relayUrl: input.relayUrl ?? '',
		pairId: pair.pairId,
		depth,
		ownEntityId: input.ownEntityId,
		lotScale,
	});

	return useMemo<BookView>(() => {
		if (relay && (hostedMissing || !hosted.data)) {
			return { pairId: pair.pairId, baseTokenId: pair.baseTokenId, quoteTokenId: pair.quoteTokenId, source: 'relay', ...relay };
		}
		const docs = hosted.data?.items ?? [];
		const { bids, asks } = bookFromHostedAccounts(docs, pair, input.ownEntityId, depth);
		const bestBid = bids[0]?.priceTicks ?? null;
		const bestAsk = asks[0]?.priceTicks ?? null;
		return {
			pairId: pair.pairId,
			baseTokenId: pair.baseTokenId,
			quoteTokenId: pair.quoteTokenId,
			bids,
			asks,
			spreadTicks: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
			lastTradeTicks: null,
			status: hosted.loading && !hosted.data ? 'syncing' : hosted.error ? 'unavailable' : 'live',
			source: 'hosted',
			updatedAt: height,
			error: hosted.error,
		};
	}, [relay, hostedMissing, hosted.data, hosted.loading, hosted.error, pair, input.ownEntityId, depth, height]);
}
