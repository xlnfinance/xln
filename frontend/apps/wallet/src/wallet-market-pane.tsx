import { useEffect, useState } from 'react';

import type { WalletMarketProjection } from './wallet-market-model';
import type { WalletMarketSource, WalletMarketSourceSnapshot } from './wallet-market-source';

const commandBusy = (snapshot: WalletMarketSourceSnapshot): boolean =>
  snapshot.command.status === 'submitting' || snapshot.command.status === 'pending';

const shortId = (value: string): string => value.length > 16
  ? `${value.slice(0, 8)}…${value.slice(-6)}`
  : value;

const runtimeTimeLabel = (timestamp: number): string => timestamp < 946_684_800_000
  ? `Runtime t+${timestamp}ms`
  : new Date(timestamp).toLocaleString();

export function WalletMarketPane({
  projection,
  snapshot,
  source,
}: Readonly<{
  projection: WalletMarketProjection;
  snapshot: WalletMarketSourceSnapshot;
  source: WalletMarketSource;
}>) {
  const selectedPair = projection.pairs.find(({ pairId }) => pairId === projection.selectedPairId) ?? null;
  const pairTokens = selectedPair
    ? projection.tokens.filter(({ tokenId }) => tokenId === selectedPair.baseTokenId || tokenId === selectedPair.quoteTokenId)
    : [];
  const [giveTokenId, setGiveTokenId] = useState(selectedPair?.baseTokenId ?? projection.tokens[0]?.tokenId ?? 0);
  const [wantTokenId, setWantTokenId] = useState(selectedPair?.quoteTokenId ?? projection.tokens[1]?.tokenId ?? 0);
  const [giveAmount, setGiveAmount] = useState('');
  const [wantAmount, setWantAmount] = useState('');
  const [timeInForce, setTimeInForce] = useState<0 | 1 | 2>(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!selectedPair) return;
    setGiveTokenId(selectedPair.baseTokenId);
    setWantTokenId(selectedPair.quoteTokenId);
    setGiveAmount('');
    setWantAmount('');
  }, [selectedPair?.pairId]);

  const flip = (): void => {
    setGiveTokenId(wantTokenId);
    setWantTokenId(giveTokenId);
    setGiveAmount(wantAmount);
    setWantAmount(giveAmount);
  };

  const submit = async (): Promise<void> => {
    setError('');
    try {
      await source.submitOrder({
        hubEntityId: projection.selectedHubId,
        giveTokenId,
        wantTokenId,
        giveAmount,
        wantAmount,
        timeInForce,
      });
      setGiveAmount('');
      setWantAmount('');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const cancel = async (offerId: string): Promise<void> => {
    setError('');
    try {
      await source.cancelOrder(offerId);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (projection.hubs.length === 0) {
    return (
      <section className="wallet-market-empty">
        <p className="wallet-shell-eyebrow">Trading unavailable</p>
        <h2>Open an active Account with a committed hub.</h2>
        <p>Markets only submit against a known hub Account. Disputed and profile-only counterparties are excluded.</p>
      </section>
    );
  }

  return (
    <div className="wallet-market-pane">
      <section className="wallet-market-context" aria-label="Market selection">
        <label>
          <span>Hub</span>
          <select
            disabled={commandBusy(snapshot)}
            onChange={(event) => source.selectHub(event.target.value)}
            value={projection.selectedHubId}
          >
            {projection.hubs.map((hub) => (
              <option key={hub.entityId} value={hub.entityId}>{hub.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Market</span>
          <select
            disabled={commandBusy(snapshot) || projection.pairs.length === 0}
            onChange={(event) => source.selectPair(event.target.value)}
            value={projection.selectedPairId}
          >
            {projection.pairs.map((pair) => (
              <option key={pair.pairId} value={pair.pairId}>{pair.label}</option>
            ))}
          </select>
        </label>
        <div><span>Hub fee</span><strong>{projection.hubs.find(({ entityId }) => entityId === projection.selectedHubId)?.feeBps ?? '—'} bps</strong></div>
        <div><span>Committed</span><strong>Height {projection.height}</strong></div>
      </section>

      {selectedPair ? (
        <div className="wallet-market-grid">
          <section className="wallet-orderbook" aria-labelledby="wallet-orderbook-title">
            <header>
              <div><p className="wallet-shell-eyebrow">Runtime book</p><h2 id="wallet-orderbook-title">{selectedPair.label}</h2></div>
              <dl>
                <div><dt>Last</dt><dd>{selectedPair.lastTradePriceLabel}</dd></div>
                <div><dt>Trades</dt><dd>{selectedPair.tradeCount}</dd></div>
              </dl>
            </header>
            <div className="wallet-orderbook-head"><span>Side</span><span>Price</span><span>Lots</span><span>Orders</span></div>
            <div className="wallet-orderbook-side is-ask">
              {selectedPair.asks.length ? selectedPair.asks.slice(0, 5).toReversed().map((level) => (
                <div key={`ask:${level.priceTicks}`}><b>Ask</b><span>{level.priceLabel}</span><span>{level.quantityLots.toString()}</span><span>{level.orderCount}</span></div>
              )) : <p>No resting asks</p>}
            </div>
            <div className="wallet-orderbook-spread">
              <span>Committed spread</span>
              <strong>{selectedPair.bids[0]?.priceLabel ?? '—'} / {selectedPair.asks[0]?.priceLabel ?? '—'}</strong>
            </div>
            <div className="wallet-orderbook-side is-bid">
              {selectedPair.bids.length ? selectedPair.bids.slice(0, 5).map((level) => (
                <div key={`bid:${level.priceTicks}`}><b>Bid</b><span>{level.priceLabel}</span><span>{level.quantityLots.toString()}</span><span>{level.orderCount}</span></div>
              )) : <p>No resting bids</p>}
            </div>
          </section>

          <section className="wallet-order-ticket" aria-labelledby="wallet-order-ticket-title">
            <header><p className="wallet-shell-eyebrow">Canonical limit</p><h2 id="wallet-order-ticket-title">Place or cross</h2></header>
            <label><span>Give</span><div><input inputMode="decimal" onChange={(event) => setGiveAmount(event.target.value)} placeholder="0.00" value={giveAmount} /><select onChange={(event) => setGiveTokenId(Number(event.target.value))} value={giveTokenId}>{pairTokens.map((token) => <option key={token.tokenId} value={token.tokenId}>{token.symbol}</option>)}</select></div></label>
            <button className="wallet-market-flip" onClick={flip} type="button">Reverse direction <span aria-hidden="true">⇅</span></button>
            <label><span>Receive at least</span><div><input inputMode="decimal" onChange={(event) => setWantAmount(event.target.value)} placeholder="0.00" value={wantAmount} /><select onChange={(event) => setWantTokenId(Number(event.target.value))} value={wantTokenId}>{pairTokens.map((token) => <option key={token.tokenId} value={token.tokenId}>{token.symbol}</option>)}</select></div></label>
            <fieldset>
              <legend>Time in force</legend>
              {([[0, 'GTC'], [1, 'IOC'], [2, 'FOK']] as const).map(([value, label]) => (
                <label className={timeInForce === value ? 'is-selected' : ''} key={value}><input checked={timeInForce === value} name="market-tif" onChange={() => setTimeInForce(value)} type="radio" /><strong>{label}</strong></label>
              ))}
            </fieldset>
            <p>Crossing prices fill existing orders; GTC remainders rest. Runtime quantizes both legs and signs the fee ceiling.</p>
            {error ? <p className="wallet-market-error" role="alert">{error}</p> : null}
            <button className="wallet-market-submit" disabled={commandBusy(snapshot) || !giveAmount || !wantAmount || giveTokenId === wantTokenId} onClick={() => void submit()} type="button">
              {snapshot.command.status === 'submitting' ? 'Submitting…' : 'Submit canonical order'}
            </button>
          </section>
        </div>
      ) : <p className="wallet-market-empty-line">This hub has no committed orderbook pair.</p>}

      <section className="wallet-open-orders" aria-labelledby="wallet-open-orders-title">
        <header><div><p className="wallet-shell-eyebrow">Account-owned</p><h2 id="wallet-open-orders-title">Open orders</h2></div><span>{projection.openOrders.length} live</span></header>
        {projection.openOrders.length ? projection.openOrders.map((order) => (
          <article key={order.offerId}>
            <div><strong>{order.sideLabel}</strong><code>{shortId(order.offerId)}</code></div>
            <dl><div><dt>Give</dt><dd>{order.giveLabel}</dd></div><div><dt>Want</dt><dd>{order.wantLabel}</dd></div><div><dt>Limit</dt><dd>{order.priceLabel}</dd></div><div><dt>Policy</dt><dd>{order.timeInForceLabel} · h{order.createdHeight}</dd></div></dl>
            <button disabled={commandBusy(snapshot)} onClick={() => void cancel(order.offerId)} type="button">Propose cancel</button>
          </article>
        )) : <p>No maker-owned offers are open on this hub Account.</p>}
      </section>

      <section className="wallet-cross-routes" aria-labelledby="wallet-cross-routes-title">
        <header><div><p className="wallet-shell-eyebrow">Cross-j lifecycle</p><h2 id="wallet-cross-routes-title">Committed routes</h2></div><span>{projection.crossRoutes.length} tracked</span></header>
        {projection.crossRoutes.length ? projection.crossRoutes.map((route) => (
          <article key={route.orderId}><div><strong>{route.status.replaceAll('_', ' ')}</strong><code>{shortId(route.orderId)}</code></div><p>{route.sourceLabel} <span aria-hidden="true">→</span> {route.targetLabel}</p><time>Updated {runtimeTimeLabel(route.updatedAt)}</time></article>
        )) : <p>No cross-jurisdiction route is committed for this Entity.</p>}
      </section>
    </div>
  );
}
