import { useEffect, useState, useSyncExternalStore } from 'react';

import { readRuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import { WalletMarketActivityView } from './wallet-market-activity-view';
import { WalletMarketPane } from './wallet-market-pane';
import { WalletMarketSource } from './wallet-market-source';
import './styles/wallet-markets.css';
import './styles/wallet-markets-responsive.css';

type MarketTab = 'market' | 'activity';

export function WalletMarkets() {
  const [source] = useState(() => new WalletMarketSource(
    readRuntimeAdapterStorageSnapshot({ durable: localStorage, session: sessionStorage }),
  ));
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const [tab, setTab] = useState<MarketTab>('market');
  const [retryError, setRetryError] = useState('');

  useEffect(() => {
    void source.start();
    return source.stop;
  }, [source]);

  const retryCommand = async (): Promise<void> => {
    setRetryError('');
    try {
      await source.retryPendingCommand();
    } catch (error: unknown) {
      setRetryError(error instanceof Error ? error.message : String(error));
    }
  };

  const projection = snapshot.projection;
  return (
    <section className="wallet-markets" aria-labelledby="wallet-markets-title">
      <header className="wallet-markets-heading">
        <p className="wallet-shell-eyebrow">Committed liquidity and history</p>
        <h1 id="wallet-markets-title">Markets</h1>
        <p>Read Runtime-owned books, place canonical same-j orders, and follow cross-j and persisted activity without rebuilding protocol state in React.</p>
      </header>

      {projection ? (
        <>
          <div className="wallet-markets-toolbar">
            <label htmlFor="wallet-markets-entity">Entity</label>
            <select
              disabled={snapshot.command.status === 'submitting' || snapshot.command.status === 'pending'}
              id="wallet-markets-entity"
              onChange={(event) => source.selectEntity(event.target.value)}
              value={projection.activeEntityId}
            >
              {projection.entities.map((entity) => <option key={entity.entityId} value={entity.entityId}>{entity.label}</option>)}
            </select>
            <span>Height {projection.height}</span>
            <button disabled={snapshot.status === 'loading'} onClick={() => void source.refresh()} type="button">{snapshot.status === 'loading' ? 'Refreshing…' : 'Refresh'}</button>
          </div>

          {snapshot.command.status !== 'idle' ? (
            <section className={`wallet-market-command is-${snapshot.command.status}`} role={snapshot.command.status === 'error' ? 'alert' : 'status'}>
              <div><span>Runtime command …{snapshot.command.commandId}</span><strong>{snapshot.command.status}</strong></div>
              <p>{snapshot.command.message}</p>
              <footer><span>{snapshot.command.durable ? 'Encrypted durable replay identity' : 'Memory-only command identity'}</span>{snapshot.command.retryable ? <button onClick={() => void retryCommand()} type="button">Retry same command</button> : null}</footer>
              {retryError ? <p className="wallet-market-error">{retryError}</p> : null}
            </section>
          ) : null}

          <nav className="wallet-market-tabs" aria-label="Market tools">
            <button aria-current={tab === 'market' ? 'page' : undefined} className={tab === 'market' ? 'is-current' : ''} onClick={() => setTab('market')} type="button">Market</button>
            <button aria-current={tab === 'activity' ? 'page' : undefined} className={tab === 'activity' ? 'is-current' : ''} onClick={() => setTab('activity')} type="button">Activity</button>
          </nav>
          {tab === 'market' ? <WalletMarketPane projection={projection} snapshot={snapshot} source={source} /> : null}
          {tab === 'activity' ? <WalletMarketActivityView projection={projection} source={source} /> : null}
        </>
      ) : (
        <section className="wallet-market-unavailable" role={snapshot.status === 'error' ? 'alert' : 'status'}>
          <p className="wallet-shell-eyebrow">Market surface unavailable</p>
          <h2>No committed market can be read.</h2>
          <p>{snapshot.message}</p>
          <div>{snapshot.status === 'error' ? <button onClick={() => void source.refresh()} type="button">Retry Runtime connection</button> : null}<a href="/app?diagnostics=1">Review diagnostics</a></div>
        </section>
      )}

      <p className="wallet-market-boundary">Cross-j routes are lifecycle evidence here; this increment does not synthesize a cross-j authorization from partial browser context.</p>
    </section>
  );
}
