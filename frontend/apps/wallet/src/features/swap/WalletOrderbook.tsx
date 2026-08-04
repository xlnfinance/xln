import type { MarketSideLevel } from '@xln/runtime/network/relay/market-snapshot';

import { useWalletOrderbook } from './use-wallet-orderbook';

const LevelRows = (props: Readonly<{
  side: 'bid' | 'ask';
  levels: readonly MarketSideLevel[];
  onPrice: (priceTicks: string) => void;
}>) => (
  <div className={`wallet-book-side is-${props.side}`}>
    <header><span>{props.side}s</span><span>price ticks</span><span>lots</span></header>
    {props.levels.length === 0 ? <p>No {props.side} liquidity.</p> : props.levels.map((level, index) => (
      <button key={`${level.price}:${index}`} type="button" onClick={() => props.onPrice(level.price)}>
        <span>{level.orderCount ?? level.orderIds?.length ?? '—'}</span>
        <strong>{level.price}</strong>
        <span>{level.size}</span>
      </button>
    ))}
  </div>
);

export const WalletOrderbook = (props: Readonly<{
  hubEntityId: string;
  giveTokenId: number;
  wantTokenId: number;
  onPrice: (priceTicks: string) => void;
}>) => {
  const orderbook = useWalletOrderbook(props);
  return (
    <section className="wallet-orderbook" data-testid="wallet-swap-orderbook">
      <header>
        <div><span>Canonical relay market</span><strong>{props.hubEntityId || 'Select a route'}</strong></div>
        <em className={`is-${orderbook.phase}`}>{orderbook.phase}</em>
      </header>
      {orderbook.error ? <p className="wallet-inline-error" role="alert">{orderbook.error}</p> : null}
      {orderbook.phase === 'connecting' ? <p className="wallet-book-state">Waiting for exact market snapshot…</p> : null}
      {orderbook.phase === 'empty' ? <p className="wallet-book-state">The selected canonical market has no resting liquidity.</p> : null}
      {orderbook.payload ? (
        <>
          <div className="wallet-book-facts">
            <span>pair {orderbook.payload.pairId}</span>
            <span>hub frame {orderbook.payload.entityHeight}</span>
            <span>spread {orderbook.payload.spread ?? '—'}</span>
          </div>
          <div className="wallet-book-grid">
            <LevelRows side="bid" levels={orderbook.payload.bids} onPrice={props.onPrice} />
            <LevelRows side="ask" levels={orderbook.payload.asks} onPrice={props.onPrice} />
          </div>
        </>
      ) : null}
    </section>
  );
};
