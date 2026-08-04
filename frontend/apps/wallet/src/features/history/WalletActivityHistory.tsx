import { useEffect, useState } from 'react';

import { useExternalStore } from '../../../../../packages/react-adapters/use-external-store';
import type { WalletEntityAccountsView } from '../accounts/account-view-model';
import {
  WALLET_ACTIVITY_TYPES,
  type WalletActivityKind,
  type WalletActivityType,
} from './activity-history-adapter';
import { walletActivityController, walletActivityExternalStore } from './wallet-activity-store';

const STATUS_SUCCESS = new Set(['committed', 'finalized', 'settled', 'completed']);
const STATUS_FAILURE = new Set(['failed', 'error', 'rejected']);
const STATUS_IN_FLIGHT = new Set(['queued', 'locked', 'started', 'received', 'created', 'updated', 'observed']);

const statusTone = (status: string): 'success' | 'failure' | 'in-flight' | 'neutral' => {
  const normalized = status.trim().toLowerCase();
  if (STATUS_SUCCESS.has(normalized)) return 'success';
  if (STATUS_FAILURE.has(normalized)) return 'failure';
  if (STATUS_IN_FLIGHT.has(normalized)) return 'in-flight';
  return 'neutral';
};
const formatTimestamp = (timestamp: number): string => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
}).format(new Date(timestamp));

const eventAmount = (
  amount: string | undefined,
  tokenId: number | undefined,
  entity: WalletEntityAccountsView,
): string | null => {
  if (amount === undefined) return null;
  const exact = BigInt(amount).toString();
  if (tokenId === undefined) return exact;
  const token = entity.catalog.find(candidate => candidate.tokenId === tokenId);
  if (!token) throw new Error(`WALLET_ACTIVITY_TOKEN_METADATA_MISSING:${tokenId}`);
  return `${exact} raw ${token.symbol}`;
};

export const WalletActivityHistory = ({ entity }: Readonly<{ entity: WalletEntityAccountsView }>) => {
  const state = useExternalStore(walletActivityExternalStore);
  const [kind, setKind] = useState<WalletActivityKind>('all');
  const [search, setSearch] = useState('');
  const [types, setTypes] = useState<readonly WalletActivityType[]>(Object.freeze([]));
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const typesKey = types.join(',');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void walletActivityController.load({
        entityId: entity.entityId,
        kind,
        types,
        search,
        limit: 40,
        beforeHeight: null,
      });
    }, search ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [entity.entityId, kind, search, typesKey]);

  useEffect(() => () => walletActivityController.release(), []);

  const toggleType = (type: WalletActivityType): void => {
    setTypes(current => current.includes(type)
      ? Object.freeze(current.filter(candidate => candidate !== type))
      : Object.freeze([...current, type]));
  };

  return (
    <section className="wallet-history" data-testid="wallet-activity-history">
      <header className="wallet-history-head">
        <div>
          <p className="wallet-eyebrow">disk-backed committed history</p>
          <h1>Activity</h1>
          <p>Current results are loaded on demand and released when you leave this view.</p>
        </div>
        <div className="wallet-history-metric"><span>latest frame</span><strong>{state.latestHeight || entity.height}</strong></div>
      </header>
      <div className="wallet-history-filters">
        <label>Ledger
          <select value={kind} onChange={event => setKind(event.target.value as WalletActivityKind)}>
            <option value="all">All activity</option>
            <option value="offchain">Offchain</option>
            <option value="onchain">Onchain</option>
          </select>
        </label>
        <label>Search
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Order, entity, hash, status" />
        </label>
      </div>
      <div className="wallet-filter-chips" aria-label="Activity types">
        {WALLET_ACTIVITY_TYPES.map(type => (
          <button key={type} type="button" aria-pressed={types.includes(type)} onClick={() => toggleType(type)}>{type.replace('_', ' ')}</button>
        ))}
      </div>
      {state.error ? (
        <div className="wallet-history-state" role="alert">
          <strong>History read failed</strong><code>{state.error}</code>
          <button type="button" onClick={() => void walletActivityController.retry()}>Retry exact query</button>
        </div>
      ) : state.loading ? (
        <div className="wallet-history-state" role="status"><strong>Reading committed frames…</strong></div>
      ) : state.events.length === 0 ? (
        <div className="wallet-history-state"><strong>No matching committed activity</strong><span>Adjust filters or submit a wallet action.</span></div>
      ) : (
        <div className="wallet-activity-list" role="list">
          {state.events.map(event => {
            const amount = eventAmount(event.amount, event.tokenId, entity);
            const quote = eventAmount(event.quoteAmount, event.quoteTokenId, entity);
            const expanded = expandedId === event.id;
            return (
              <article key={event.id} role="listitem" data-testid="wallet-activity-row">
                <button type="button" aria-expanded={expanded} onClick={() => setExpandedId(current => current === event.id ? null : event.id)}>
                  <span className={`wallet-activity-direction is-${event.direction}`}>{event.direction}</span>
                  <span className="wallet-activity-copy"><strong>{event.title}</strong><small>{event.subtitle}</small></span>
                  <span className="wallet-activity-amount">{amount ?? '—'}{quote ? <small>quote {quote}</small> : null}</span>
                  <span className={`wallet-activity-status is-${statusTone(event.status)}`}>{event.status}</span>
                  <time dateTime={new Date(event.timestamp).toISOString()}>{formatTimestamp(event.timestamp)}</time>
                </button>
                {expanded ? (
                  <dl className="wallet-activity-detail" data-testid="wallet-activity-detail">
                    <div><dt>Event ID</dt><dd>{event.id}</dd></div>
                    <div><dt>Frame</dt><dd>{event.height}</dd></div>
                    <div><dt>Canonical type</dt><dd>{event.type} / {event.rawType}</dd></div>
                    <div><dt>Source</dt><dd>{event.source}</dd></div>
                    <div><dt>Entity</dt><dd>{event.entityId ?? 'not attached'}</dd></div>
                    <div><dt>Counterparty</dt><dd>{event.counterpartyId ?? 'not attached'}</dd></div>
                    <div><dt>Order</dt><dd>{event.orderId ?? 'not attached'}</dd></div>
                    <div><dt>Hash</dt><dd>{event.hash ?? 'not attached'}</dd></div>
                  </dl>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      {state.nextBeforeHeight !== null && !state.loading ? (
        <button className="wallet-history-more wallet-button-secondary" type="button" disabled={state.loadingMore} onClick={() => void walletActivityController.loadMore()}>
          {state.loadingMore ? 'Reading older frames…' : `Load before frame ${state.nextBeforeHeight}`}
        </button>
      ) : null}
    </section>
  );
};
