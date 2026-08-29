import { useEffect, useState, useSyncExternalStore } from 'react';

import { readRuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import type {
  WalletPortfolioAccount,
  WalletPortfolioAsset,
  WalletPortfolioProjection,
} from './wallet-portfolio-model';
import { WalletPortfolioSource } from './wallet-portfolio-source';
import './styles/wallet-portfolio.css';
import './styles/wallet-portfolio-responsive.css';

const shortEntityId = (entityId: string): string =>
  entityId.length > 18 ? `${entityId.slice(0, 10)}…${entityId.slice(-6)}` : entityId;

function PortfolioUnavailable({
  error,
  message,
  retry,
  retryable,
}: Readonly<{ error: boolean; message: string; retry: () => void; retryable: boolean }>) {
  return (
    <section className="wallet-portfolio-unavailable" role={error ? 'alert' : 'status'}>
      <p className="wallet-shell-eyebrow">Committed projection unavailable</p>
      <h2>No portfolio data is being shown.</h2>
      <p>{message}</p>
      <div>
        {retryable ? <button onClick={retry} type="button">Retry Runtime read</button> : null}
        <a href="/app?diagnostics=1">Review diagnostics</a>
      </div>
    </section>
  );
}

function PortfolioAssets({ assets }: Readonly<{ assets: readonly WalletPortfolioAsset[] }>) {
  if (assets.length === 0) {
    return <p className="wallet-portfolio-empty">No committed reserve or Account asset positions.</p>;
  }
  return (
    <div className="wallet-portfolio-assets" role="table" aria-label="Committed asset positions">
      <div className="wallet-portfolio-asset-heading" role="row">
        <span role="columnheader">Asset</span>
        <span role="columnheader">Reserve</span>
        <span role="columnheader">Available in accounts</span>
        <span role="columnheader">Inbound capacity</span>
      </div>
      {assets.map((asset) => (
        <div className="wallet-portfolio-asset-row" role="row" key={asset.tokenId}>
          <span role="cell"><strong>{asset.symbol}</strong><small>Token {asset.tokenId}</small></span>
          <span role="cell">{asset.reserveLabel}</span>
          <span role="cell">{asset.accountSpendableLabel}<small>{asset.accountCount} account{asset.accountCount === 1 ? '' : 's'}</small></span>
          <span role="cell">{asset.accountInboundCapacityLabel}</span>
        </div>
      ))}
    </div>
  );
}

function PortfolioAccount({ account }: Readonly<{ account: WalletPortfolioAccount }>) {
  return (
    <article className="wallet-portfolio-account">
      <header>
        <div>
          <strong>{account.counterpartyLabel}</strong>
          <code title={account.counterpartyId}>{shortEntityId(account.counterpartyId)}</code>
        </div>
        <span>{account.positions.length} asset{account.positions.length === 1 ? '' : 's'}</span>
      </header>
      {account.positions.length === 0 ? (
        <p>No committed token positions in this Account.</p>
      ) : account.positions.map((position) => (
        <dl key={position.tokenId}>
          <div><dt>Asset</dt><dd>{position.symbol}</dd></div>
          <div><dt>Spendable</dt><dd>{position.spendableLabel}</dd></div>
          <div><dt>Inbound capacity</dt><dd>{position.inboundCapacityLabel}</dd></div>
          <div><dt>Collateral</dt><dd>{position.collateralLabel}</dd></div>
          <div><dt>Peer granted us</dt><dd>{position.ownCreditLimitLabel}</dd></div>
          <div><dt>We granted peer</dt><dd>{position.peerCreditLimitLabel}</dd></div>
        </dl>
      ))}
    </article>
  );
}

function PortfolioAccounts({
  projection,
  selectPage,
}: Readonly<{
  projection: WalletPortfolioProjection;
  selectPage: (page: number) => void;
}>) {
  return (
    <section className="wallet-portfolio-section" aria-labelledby="wallet-accounts-title">
      <div className="wallet-portfolio-section-heading">
        <div><p>02</p><h2 id="wallet-accounts-title">Accounts</h2></div>
        <span>{projection.accounts.length} shown · {projection.accountsTotal} total</span>
      </div>
      {projection.accounts.length === 0 ? (
        <p className="wallet-portfolio-empty">No committed bilateral Accounts for this Entity.</p>
      ) : <div className="wallet-portfolio-account-list">
        {projection.accounts.map((account) => (
          <PortfolioAccount account={account} key={account.counterpartyId} />
        ))}
      </div>}
      {projection.accountsPageCount > 1 ? (
        <nav className="wallet-portfolio-pagination" aria-label="Account pages">
          <button
            disabled={projection.accountsPage === 0}
            onClick={() => selectPage(projection.accountsPage - 1)}
            type="button"
          >Previous</button>
          <span>Page {projection.accountsPage + 1} of {projection.accountsPageCount}</span>
          <button
            disabled={projection.accountsPage + 1 >= projection.accountsPageCount}
            onClick={() => selectPage(projection.accountsPage + 1)}
            type="button"
          >Next</button>
        </nav>
      ) : null}
    </section>
  );
}

function PortfolioContent({
  projection,
  refreshing,
  source,
}: Readonly<{
  projection: WalletPortfolioProjection;
  refreshing: boolean;
  source: WalletPortfolioSource;
}>) {
  return (
    <>
      <div className="wallet-portfolio-context">
        <label htmlFor="wallet-portfolio-entity">Entity</label>
        <select
          id="wallet-portfolio-entity"
          onChange={(event) => source.selectEntity(event.target.value)}
          value={projection.activeEntityId}
        >
          {projection.entities.map((entity) => (
            <option key={entity.entityId} value={entity.entityId}>{entity.label}</option>
          ))}
        </select>
        <span>Committed height {projection.height}</span>
        <button disabled={refreshing} onClick={() => void source.refresh()} type="button">
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <section className="wallet-portfolio-section" aria-labelledby="wallet-assets-title">
        <div className="wallet-portfolio-section-heading">
          <div><p>01</p><h2 id="wallet-assets-title">Assets</h2></div>
          <span>Committed token amounts · no estimated prices</span>
        </div>
        <PortfolioAssets assets={projection.assets} />
      </section>
      <PortfolioAccounts projection={projection} selectPage={source.selectAccountsPage} />
    </>
  );
}

export function WalletPortfolio() {
  const [source] = useState(() => new WalletPortfolioSource(
    readRuntimeAdapterStorageSnapshot({ durable: localStorage, session: sessionStorage }),
  ));
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);

  useEffect(() => {
    void source.start();
    return source.stop;
  }, [source]);

  return (
    <section className="wallet-portfolio" aria-labelledby="wallet-portfolio-title">
      <header className="wallet-portfolio-heading">
        <p className="wallet-shell-eyebrow">Canonical RuntimeView</p>
        <h1 id="wallet-portfolio-title">Assets &amp; accounts</h1>
        <p>Committed balances from the selected Runtime. No optimistic or sample values.</p>
      </header>
      {snapshot.projection ? (
        <PortfolioContent
          projection={snapshot.projection}
          refreshing={snapshot.status === 'loading'}
          source={source}
        />
      ) : (
        <PortfolioUnavailable
          error={snapshot.status === 'error'}
          message={snapshot.message}
          retry={() => void source.refresh()}
          retryable={snapshot.status === 'error'}
        />
      )}
      <p className="wallet-portfolio-boundary">
        Credit and capacity values use the canonical bilateral deriveDelta perspective. This read-only slice sends no Runtime inputs.
      </p>
    </section>
  );
}
