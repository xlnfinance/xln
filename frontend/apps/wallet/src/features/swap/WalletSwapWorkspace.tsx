import { useEffect, useMemo, useState } from 'react';

import type { CommandReceipt } from '$lib/stores/runtimeCommandBus';
import { xlnInstanceExternalStore } from '$lib/stores/xlnRuntimeLoader';
import { useExternalStore } from '../../../../../packages/react-adapters/use-external-store';
import type { WalletEntityAccountsView } from '../accounts/account-view-model';
import { WalletCommandReceipt } from '../accounts/WalletCommandReceipt';
import type { WalletDirectoryEntity } from '../accounts/wallet-account-store';
import { walletAccountStoreController } from '../accounts/wallet-account-store';
import { WalletOrderbook } from './WalletOrderbook';
import { WalletSwapOrders } from './WalletSwapOrders';
import {
  assertSwapConfirmationCurrent,
  createSwapDraftIdentity,
} from './swap-request-identity';
import { submitWalletSwapPlan } from './wallet-swap-actions';
import { buildWalletSwapRouteOptions } from './swap-route-options';
import { useWalletSwapQuote, walletSwapErrorText } from './use-wallet-swap-quote';

type SwapOperation =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'submitting'; offerId: string }>
  | Readonly<{ phase: 'submitted'; offerId: string }>
  | Readonly<{ phase: 'failed'; offerId: string; error: string }>;

export const WalletSwapWorkspace = (props: Readonly<{
  entity: WalletEntityAccountsView;
  directory: readonly WalletDirectoryEntity[];
  receipt: CommandReceipt | null;
}>) => {
  const runtime = useExternalStore(xlnInstanceExternalStore);
  if (!runtime) throw new Error('WALLET_SWAP_RUNTIME_API_NOT_READY');
  const liquidTokens = props.entity.catalog.filter(token => runtime.isLiquidSwapToken(token.tokenId));
  const [giveTokenId, setGiveTokenId] = useState(liquidTokens[0]?.tokenId ?? 0);
  const [wantTokenId, setWantTokenId] = useState(liquidTokens.find(token => token.tokenId !== giveTokenId)?.tokenId ?? 0);
  const [amountInput, setAmountInput] = useState('');
  const [priceTicksInput, setPriceTicksInput] = useState('');
  const [routeValue, setRouteValue] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [operation, setOperation] = useState<SwapOperation>(Object.freeze({ phase: 'idle' }));
  const [ordersRefreshNonce, setOrdersRefreshNonce] = useState(0);
  const routes = useMemo(() => buildWalletSwapRouteOptions({
    sourceEntityId: props.entity.entityId,
    sourceRuntimeId: props.entity.runtimeId,
    sourceJurisdictionRef: props.entity.jurisdictionRef,
    sourceAccountIds: props.entity.accounts.map(account => account.counterpartyId),
    directory: props.directory,
  }), [props.entity.entityId, props.entity.runtimeId, props.entity.jurisdictionRef, props.entity.accounts, props.directory]);
  const selectedRoute = routes.find(route => route.value === routeValue) ?? null;
  const { quoteState, quoteIsStale } = useWalletSwapQuote({
    entity: props.entity,
    route: selectedRoute,
    giveTokenId,
    wantTokenId,
    amountInput,
    priceTicksInput,
    runtime,
  });

  useEffect(() => {
    if (!routes.some(route => route.value === routeValue && route.enabled)) {
      setRouteValue(routes.find(route => route.enabled)?.value ?? '');
    }
  }, [routes, routeValue]);

  useEffect(() => {
    setReviewing(false);
    setOperation(Object.freeze({ phase: 'idle' }));
  }, [selectedRoute, amountInput, priceTicksInput, giveTokenId, wantTokenId, props.entity.height]);

  const submit = async (): Promise<void> => {
    if (quoteState.phase !== 'ready') throw new Error('WALLET_SWAP_QUOTE_NOT_READY');
    const visibleDraft = createSwapDraftIdentity({
      frameHeight: props.entity.height,
      routeValue: quoteState.route.value,
      giveTokenId,
      wantTokenId,
      amountInput,
      priceTicksInput,
    });
    assertSwapConfirmationCurrent(quoteState.draftIdentity, visibleDraft);
    setOperation(Object.freeze({ phase: 'submitting', offerId: quoteState.quote.offerId }));
    try {
      const offerId = await submitWalletSwapPlan(quoteState.evidenceIdentity, quoteState.plan);
      setOperation(Object.freeze({ phase: 'submitted', offerId }));
      setReviewing(false);
      setAmountInput('');
      setPriceTicksInput('');
      await walletAccountStoreController.refresh();
      setOrdersRefreshNonce(value => value + 1);
    } catch (error) {
      setOperation(Object.freeze({ phase: 'failed', offerId: quoteState.quote.offerId, error: walletSwapErrorText(error) }));
    }
  };

  const giveToken = liquidTokens.find(token => token.tokenId === giveTokenId) ?? null;
  const wantToken = liquidTokens.find(token => token.tokenId === wantTokenId) ?? null;
  return (
    <section className="wallet-swap" data-testid="wallet-swap-workspace">
      <header className="wallet-swap-head">
        <div><p className="wallet-eyebrow">canonical limit-order planner</p><h1>Swap</h1><p>Quotes are deterministic command plans tied to the latest committed account evidence.</p></div>
        <div className="wallet-history-metric"><span>entity frame</span><strong>{props.entity.height}</strong></div>
      </header>
      {liquidTokens.length < 2 ? <p className="wallet-inline-error" role="alert">At least two canonical liquid swap tokens are required.</p> : null}
      {routes.length === 0 ? <p className="wallet-inline-error" role="alert">No canonical hub route exists for a committed source account.</p> : null}
      <div className="wallet-swap-grid">
        <div className="wallet-swap-ticket">
          <label>Route
            <select data-testid="wallet-swap-route" value={routeValue} onChange={event => setRouteValue(event.target.value)}>
              {routes.map(route => <option key={route.value} value={route.value} disabled={!route.enabled}>{route.label}{route.disabledReason ? ` · ${route.disabledReason}` : ''}</option>)}
            </select>
          </label>
          <div className="wallet-form-grid">
            <label>Give asset
              <select data-testid="wallet-swap-give-token" value={giveTokenId} onChange={event => setGiveTokenId(Number(event.target.value))}>
                {liquidTokens.map(token => <option key={token.tokenId} value={token.tokenId}>{token.symbol} · token {token.tokenId}</option>)}
              </select>
            </label>
            <label>Want asset
              <select data-testid="wallet-swap-want-token" value={wantTokenId} onChange={event => setWantTokenId(Number(event.target.value))}>
                {liquidTokens.map(token => <option key={token.tokenId} value={token.tokenId}>{token.symbol} · token {token.tokenId}</option>)}
              </select>
            </label>
          </div>
          <div className="wallet-form-grid">
            <label>Give amount ({giveToken?.symbol ?? 'asset'})
              <input data-testid="wallet-swap-amount" inputMode="decimal" value={amountInput} onChange={event => setAmountInput(event.target.value)} placeholder="0.00" />
            </label>
            <label>Limit price ticks
              <input data-testid="wallet-swap-price" inputMode="numeric" value={priceTicksInput} onChange={event => setPriceTicksInput(event.target.value)} placeholder="Exact integer ticks" />
            </label>
          </div>
          <p className="wallet-field-note">Want: {wantToken?.symbol ?? 'select asset'} · click a canonical book level to set exact price ticks.</p>
          {quoteState.phase === 'loading' ? <div className="wallet-swap-quote is-loading" data-testid="wallet-swap-quote-loading">Prior evidence is invalidated. Planning against the latest committed account state…</div> : null}
          {quoteState.phase === 'error' ? <p className="wallet-inline-error" role="alert" data-testid="wallet-swap-quote-error">{quoteState.error}</p> : null}
          {quoteState.phase === 'ready' && quoteIsStale ? (
            <p className="wallet-inline-error" role="alert" data-testid="wallet-swap-quote-stale">Quote invalidated by changed input or committed state. Replanning is required.</p>
          ) : null}
          {quoteState.phase === 'ready' && !quoteIsStale && !reviewing ? (
            <div className="wallet-swap-quote" data-testid="wallet-swap-quote-result">
              <dl>
                <div><dt>Canonical give</dt><dd>{quoteState.quote.giveAmountRaw} raw {giveToken?.symbol}</dd></div>
                <div><dt>Canonical want</dt><dd>{quoteState.quote.wantAmountRaw} raw {wantToken?.symbol}</dd></div>
                <div><dt>Price</dt><dd>{quoteState.quote.priceTicks} ticks</dd></div>
                <div><dt>Unspent dust</dt><dd>{quoteState.quote.unspentGiveRaw} raw</dd></div>
                <div><dt>Capacity evidence</dt><dd>{quoteState.quote.sourceOutCapacityRaw} raw</dd></div>
                <div><dt>Fee evidence</dt><dd>Bound by execution; no invented preflight fee</dd></div>
              </dl>
              <button type="button" data-testid="wallet-swap-review" onClick={() => setReviewing(true)}>Review canonical order</button>
            </div>
          ) : null}
          {quoteState.phase === 'ready' && !quoteIsStale && reviewing ? (
            <div className="wallet-confirm wallet-swap-confirm" data-testid="wallet-swap-confirmation">
              <h3>Confirm one durable swap intent</h3>
              <dl>
                <div><dt>Route</dt><dd>{quoteState.quote.routeLabel}</dd></div>
                <div><dt>Offer ID</dt><dd>{quoteState.quote.offerId}</dd></div>
                <div><dt>Give / want</dt><dd>{quoteState.quote.giveAmountRaw} / {quoteState.quote.wantAmountRaw} raw</dd></div>
                <div><dt>Evidence</dt><dd>{quoteState.evidenceIdentity}</dd></div>
                <div><dt>Expiration</dt><dd>{quoteState.plan.mode === 'cross' ? '24 hours in canonical Runtime plan' : 'GTC in bilateral account'}</dd></div>
              </dl>
              <div className="wallet-action-row">
                <button className="wallet-button-secondary" type="button" disabled={operation.phase === 'submitting'} onClick={() => setReviewing(false)}>Back</button>
                <button type="button" data-testid="wallet-swap-submit" disabled={operation.phase === 'submitting' || quoteIsStale} onClick={() => void submit()}>{operation.phase === 'submitting' ? 'Submitting…' : 'Submit swap intent'}</button>
              </div>
            </div>
          ) : null}
          {operation.phase === 'submitted' ? <p className="wallet-swap-operation is-success" role="status" data-testid="wallet-swap-submitted">Intent submitted · offer {operation.offerId}</p> : null}
          {operation.phase === 'failed' ? <p className="wallet-inline-error" role="alert" data-testid="wallet-swap-failed">{operation.error}</p> : null}
          <WalletCommandReceipt receipt={props.receipt} />
        </div>
        <WalletOrderbook
          hubEntityId={selectedRoute?.sourceHubEntityId ?? ''}
          giveTokenId={giveTokenId}
          wantTokenId={wantTokenId}
          onPrice={setPriceTicksInput}
        />
      </div>
      <WalletSwapOrders entity={props.entity} runtime={runtime} refreshNonce={ordersRefreshNonce} />
    </section>
  );
};
