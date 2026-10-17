import { formatMoney } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';
import { PRICE_SCALE, type BookLevel, type BookView } from '../runtime/financial/orderbook';

export type BookSide = 'bid' | 'ask';

/** Price in quote units per one base unit: ticks carry four decimals. */
export function formatPrice(priceTicks: bigint): string {
	return formatMoney(priceTicks, 4, 4);
}

function Row({ level, side, base, deepest, onPick }: { level: BookLevel; side: BookSide; base: number; deepest: bigint; onPick?: ((side: BookSide, level: BookLevel) => void) | undefined }) {
	const baseMeta = getTokenMeta(base);
	const Tag = onPick ? 'button' : 'div';
	return (
		<Tag
			{...(onPick ? { type: 'button' as const, onClick: () => onPick(side, level) } : {})}
			className={`bk-row ${side}${level.own ? ' own' : ''}`}
			data-testid={`book-row-${side}`}
			title={`${level.orders} ${level.orders === 1 ? 'order' : 'orders'} · total ${formatMoney(level.total, baseMeta.decimals, 4)} ${baseMeta.symbol}`}
		>
			<span className={`bk-price num ${side === 'bid' ? 'st-settled' : 'st-dispute'}`}>{formatPrice(level.priceTicks)}</span>
			<span className="bk-size num">{formatMoney(level.size, baseMeta.decimals, 4)}</span>
			<span className="bk-bar" aria-hidden>
				<i className={`bk-depth ${side}`} style={{ width: `${deepest > 0n ? Number((level.size * 1000n) / deepest) / 10 : 0}%` }} />
			</span>
		</Tag>
	);
}

/**
 * The hub's book: asks above, spread, bids below. Depth is drawn against the
 * deepest visible level: a market's levels dwarf a wallet's balances, so the
 * wallet's one dollar scale would draw every level at full width.
 */
export function Orderbook({ book, hubLabel, onPick }: { book: BookView; hubLabel: string; onPick?: ((side: BookSide, level: BookLevel) => void) | undefined }) {
	const baseMeta = getTokenMeta(book.baseTokenId);
	const quoteMeta = getTokenMeta(book.quoteTokenId);
	const empty = book.bids.length === 0 && book.asks.length === 0;
	const deepest = [...book.asks, ...book.bids].reduce((max, level) => (level.size > max ? level.size : max), 0n);
	const spreadPct =
		book.spreadTicks !== null && book.asks[0] ? Number((book.spreadTicks * 100_000n) / book.asks[0].priceTicks) / 1000 : null;
	return (
		<div className="book" data-testid="orderbook" data-status={book.status} data-source={book.source}>
			<div className="bk-head">
				<span className="caps">
					{baseMeta.symbol}/{quoteMeta.symbol} · {hubLabel}
				</span>
				<span className={`state ${book.status === 'live' ? 'st-settled' : book.status === 'syncing' ? 'st-pending' : 'st-neutral'}`}>
					{book.status === 'live' ? (book.source === 'hosted' ? 'live · this runtime' : 'live · relay') : book.status === 'syncing' ? 'syncing' : book.status === 'no-market' ? 'no market' : 'unavailable'}
				</span>
			</div>
			<div className="bk-cols caps">
				<span>Price {quoteMeta.symbol}</span>
				<span>Size {baseMeta.symbol}</span>
				<span />
			</div>
			{empty ? (
				<p className="note" style={{ padding: '14px 0' }}>
					{book.status === 'live' ? 'No resting orders on this pair yet. Yours would be the first.' : book.error ? book.error : 'Waiting for the book.'}
				</p>
			) : (
				<>
					<div className="bk-side asks">
						{[...book.asks].reverse().map(level => (
							<Row key={`a${level.priceTicks}`} level={level} side="ask" base={book.baseTokenId} deepest={deepest} onPick={onPick} />
						))}
					</div>
					<div className="bk-spread num">
						{book.spreadTicks !== null ? (
							<>
								spread {formatPrice(book.spreadTicks)} {quoteMeta.symbol}
								{spreadPct !== null ? <span className="faint"> · {spreadPct.toFixed(2)}%</span> : null}
							</>
						) : book.asks[0] ? (
							<>best ask {formatPrice(book.asks[0].priceTicks)}</>
						) : book.bids[0] ? (
							<>best bid {formatPrice(book.bids[0].priceTicks)}</>
						) : null}
						{book.lastTradeTicks !== null ? <span className="faint"> · last {formatPrice(book.lastTradeTicks)}</span> : null}
					</div>
					<div className="bk-side bids">
						{book.bids.map(level => (
							<Row key={`b${level.priceTicks}`} level={level} side="bid" base={book.baseTokenId} deepest={deepest} onPick={onPick} />
						))}
					</div>
				</>
			)}
			<p className="note" style={{ marginTop: 10 }}>
				Tap a level to fill the ticket at that price. 1 tick = 1/{PRICE_SCALE.toLocaleString('en-US')} {quoteMeta.symbol}.
			</p>
		</div>
	);
}
