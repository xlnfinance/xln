import { useEffect, useState } from 'react';

import type { XLNModule } from '@xln/runtime/api/public/runtime-module';
import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
import type { WalletEntityAccountsView } from '../accounts/account-view-model';
import { walletAccountStoreController } from '../accounts/wallet-account-store';
import { requestWalletCrossSwapClear, requestWalletSwapCancel } from './wallet-swap-actions';
import { projectWalletSwapOrders, type WalletSwapOrderView } from './swap-order-view-model';

type OrderFilter = 'all' | 'open' | 'closed';

const isOpen = (order: WalletSwapOrderView): boolean => order.status === 'open' || order.status === 'cancel-requested';

const tokenLabel = (entity: WalletEntityAccountsView, tokenId: number): string => {
  const token = entity.catalog.find(candidate => candidate.tokenId === tokenId);
  if (!token) throw new Error(`WALLET_SWAP_ORDER_TOKEN_METADATA_MISSING:${tokenId}`);
  return token.symbol;
};

export const WalletSwapOrders = (props: Readonly<{
  entity: WalletEntityAccountsView;
  runtime: XLNModule;
  refreshNonce: number;
}>) => {
  const [orders, setOrders] = useState<readonly WalletSwapOrderView[]>(Object.freeze([]));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void Promise.all(props.entity.accounts.map(async account => {
      const persisted = await runtimeQueryClient.readAccount(
        props.entity.entityId,
        account.counterpartyId,
        { atHeight: props.entity.height },
      );
      return projectWalletSwapOrders(persisted, account.counterpartyId, {
        computeSwapPriceTicks: props.runtime.computeSwapPriceTicks,
      });
    })).then(groups => {
      if (disposed) return;
      const combined = groups.flat().toSorted((left, right) =>
        right.lastUpdatedHeight - left.lastUpdatedHeight || left.key.localeCompare(right.key)
      );
      setOrders(Object.freeze(combined));
      setLoading(false);
    }).catch(loadError => {
      if (disposed) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setLoading(false);
    });
    return () => { disposed = true; };
  }, [props.entity.entityId, props.entity.height, props.entity.accounts, props.runtime, props.refreshNonce]);

  const act = async (order: WalletSwapOrderView): Promise<void> => {
    setActionKey(order.key);
    setError(null);
    try {
      if (order.crossJurisdiction) {
        await requestWalletCrossSwapClear({
          entityId: props.entity.entityId,
          signerId: props.entity.signerId,
          orderId: order.offerId,
          cancelRemainder: true,
        });
      } else {
        await requestWalletSwapCancel({
          entityId: props.entity.entityId,
          signerId: props.entity.signerId,
          accountId: order.accountId,
          offerId: order.offerId,
        });
      }
      await walletAccountStoreController.refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setActionKey(null);
    }
  };
  const visible = orders.filter(order => filter === 'all' || (filter === 'open' ? isOpen(order) : !isOpen(order)));
  return (
    <section className="wallet-swap-orders" data-testid="wallet-swap-orders">
      <header>
        <div><span>Canonical account lifecycle</span><strong>Orders</strong></div>
        <select aria-label="Order lifecycle filter" value={filter} onChange={event => setFilter(event.target.value as OrderFilter)}>
          <option value="all">All ({orders.length})</option>
          <option value="open">Open ({orders.filter(isOpen).length})</option>
          <option value="closed">Closed ({orders.filter(order => !isOpen(order)).length})</option>
        </select>
      </header>
      {error ? <p className="wallet-inline-error" role="alert">{error}</p> : null}
      {loading ? <p className="wallet-book-state">Reading account order histories…</p> : null}
      {!loading && visible.length === 0 ? <p className="wallet-book-state">No orders for this lifecycle filter.</p> : null}
      <div className="wallet-order-list">
        {visible.map(order => {
          const isExpanded = expanded === order.key;
          return (
            <article key={order.key} data-testid="wallet-swap-order-row">
              <button type="button" className="wallet-order-summary" aria-expanded={isExpanded} onClick={() => setExpanded(current => current === order.key ? null : order.key)}>
                <span className={`wallet-order-state is-${order.status}`}>{order.status.replace('-', ' ')}</span>
                <strong>{tokenLabel(props.entity, order.giveTokenId)} → {tokenLabel(props.entity, order.wantTokenId)}</strong>
                <span>{order.giveAmountRaw} → {order.wantAmountRaw} raw</span>
                <span>h{order.lastUpdatedHeight}</span>
              </button>
              {isExpanded ? (
                <div className="wallet-order-detail" data-testid="wallet-swap-order-detail">
                  <dl>
                    <div><dt>Offer</dt><dd>{order.offerId}</dd></div>
                    <div><dt>Hub account</dt><dd>{order.accountId}</dd></div>
                    <div><dt>Price ticks</dt><dd>{order.priceTicks}</dd></div>
                    <div><dt>Executed</dt><dd>{order.executionGiveRaw} / {order.executionWantRaw} raw</dd></div>
                    <div><dt>Fee</dt><dd>{order.feeRaw}{order.feeTokenId ? ` raw token ${order.feeTokenId}` : ' (none recorded)'}</dd></div>
                    <div><dt>Close evidence</dt><dd>{order.closeComment ?? 'none recorded'}</dd></div>
                  </dl>
                  {isOpen(order) ? (
                    <button type="button" disabled={actionKey !== null || order.status === 'cancel-requested'} onClick={() => void act(order)}>
                      {actionKey === order.key ? 'Submitting durable intent…' : order.crossJurisdiction ? 'Clear + cancel remainder' : 'Request cancel'}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
};
