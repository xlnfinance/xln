import { useEffect, useMemo, useState } from 'react';

import { useExternalStore } from '../../../../../packages/react-adapters/use-external-store';
import {
  walletAccountExternalStore,
  walletAccountStoreController,
} from '../accounts/wallet-account-store';

const shortId = (value: string): string => `${value.slice(0, 12)}…${value.slice(-8)}`;

export const WalletAddressDirectory = () => {
  const state = useExternalStore(walletAccountExternalStore);
  const [search, setSearch] = useState('');
  useEffect(() => { void walletAccountStoreController.showActiveEntity(); }, []);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return state.directory;
    return state.directory.filter(entity => [entity.entityId, entity.runtimeId, entity.label, entity.jurisdiction, entity.isHub ? 'hub routing' : 'entity'].join(' ').toLowerCase().includes(query));
  }, [search, state.directory]);
  return (
    <main className="wallet-route-page" data-testid="wallet-address-directory">
      <header className="wallet-route-header"><div><a href="/app">← Wallet</a><p className="wallet-eyebrow">runtime directory · h{state.frameHeight}</p><h1>Address book</h1><p>Committed and discovered entities from the active Runtime projection.</p></div><button type="button" onClick={() => void walletAccountStoreController.refresh()}>Refresh</button></header>
      <label className="wallet-directory-search"><span>Search entities</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, entity ID, runtime, jurisdiction" /></label>
      {state.error && <p className="wallet-inline-error" role="alert">{state.error}</p>}
      {state.loading && state.directory.length === 0 ? <p className="wallet-empty-state">Loading address directory…</p> : (
        <section className="wallet-directory-list" aria-label="Entities">
          {visible.length === 0 ? <p className="wallet-empty-state">No entities match this search.</p> : visible.map(entity => <a key={entity.entityId} href={`/address/${entity.entityId}`}>
            <span className="wallet-entity-mark" aria-hidden="true">{entity.isHub ? 'H' : 'E'}</span>
            <div><strong>{entity.label}</strong><code>{shortId(entity.entityId)}</code></div>
            <div className="wallet-directory-meta"><span>{entity.isHub ? 'hub · routing' : 'entity'}</span><span>{entity.jurisdiction ?? 'jurisdiction unavailable'}</span><span>h{entity.height}</span></div>
          </a>)}
        </section>
      )}
    </main>
  );
};
