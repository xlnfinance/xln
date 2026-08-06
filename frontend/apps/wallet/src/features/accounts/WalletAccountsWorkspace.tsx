import { useEffect, useState } from 'react';

import { useExternalStore } from '../../../../../packages/react-adapters/use-external-store';
import { runtimeCommandLatestReceiptExternalStore } from '$lib/stores/runtimeCommandBus';
import { runtimeControllerHandleExternalStore } from '$lib/stores/runtimeControllerStore';
import { WalletMoveCredit } from './WalletMoveCredit';
import { WalletExternalMove } from './WalletExternalMove';
import { WalletLending } from './WalletLending';
import { WalletOpenAccount } from './WalletOpenAccount';
import { WalletSettlement } from './WalletSettlement';
import { WalletAccountConfigure } from './WalletAccountConfigure';
import { WalletAccountDispute } from './WalletAccountDispute';
import { WalletTestAssetFaucet } from './WalletTestAssetFaucet';
import { WalletPaymentForm } from '../payments/WalletPaymentForm';
import { WalletReceiveForm } from '../payments/WalletReceiveForm';
import { WalletActivityHistory } from '../history/WalletActivityHistory';
import { WalletSwapWorkspace } from '../swap/WalletSwapWorkspace';
import {
  walletAccountExternalStore,
  walletAccountStoreController,
} from './wallet-account-store';

export type WalletAccountSection = 'accounts' | 'pay' | 'receive' | 'move' | 'lending' | 'settlement' | 'swap' | 'activity';

const shortId = (value: string): string => `${value.slice(0, 10)}…${value.slice(-8)}`;
const coverageTone = (coverage: number): string => coverage >= 100 ? 'cov-good' : coverage >= 50 ? 'cov-warn' : 'cov-risk';
const coverageText = (coverage: number): string => `${Number.isInteger(coverage) ? coverage : coverage.toFixed(2)}%`;

const RemoteTestAssetBoundary = () => (
  <section className="wallet-test-assets" data-testid="wallet-remote-test-assets-boundary">
    <div><p className="wallet-eyebrow">testnet ingress</p><h2>Local signer required</h2></div>
    <p>Remote Runtime inspection stays read-only here. Open a local, signer-backed runtime to request test assets.</p>
  </section>
);

export const WalletAccountsWorkspace = ({ section }: Readonly<{ section: WalletAccountSection }>) => {
  const state = useExternalStore(walletAccountExternalStore);
  const receipt = useExternalStore(runtimeCommandLatestReceiptExternalStore);
  const runtime = useExternalStore(runtimeControllerHandleExternalStore);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  useEffect(() => {
    void walletAccountStoreController.refresh();
  }, []);
  const entity = state.entity;
  if (state.loading && !entity) return <section className="wallet-operation"><p className="wallet-eyebrow">runtime projection</p><h1>Loading accounts…</h1></section>;
  if (state.error) return <section className="wallet-operation"><p className="wallet-eyebrow">runtime projection failed</p><h1>Accounts unavailable</h1><p className="wallet-inline-error" role="alert">{state.error}</p><button type="button" onClick={() => void walletAccountStoreController.refresh()}>Retry</button></section>;
  if (!entity) return <section className="wallet-operation"><p className="wallet-eyebrow">no active entity</p><h1>Create an entity to use accounts</h1><p>The runtime is connected, but it has no active Entity projection yet.</p></section>;
  if (section === 'pay') return <WalletPaymentForm entity={entity} directory={state.directory} receipt={receipt} initialInvoice={window.location.hash.startsWith('#pay/') ? window.location.href : null} />;
  if (section === 'receive') return <WalletReceiveForm entity={entity} />;
  if (section === 'move') return <div className="wallet-operation-stack"><WalletMoveCredit entity={entity} receipt={receipt} /><WalletExternalMove entity={entity} receipt={receipt} /></div>;
  if (section === 'lending') return <WalletLending entity={entity} receipt={receipt} />;
  if (section === 'settlement') return <WalletSettlement entity={entity} receipt={receipt} />;
  if (section === 'swap') return <WalletSwapWorkspace entity={entity} directory={state.directory} receipt={receipt} />;
  if (section === 'activity') return <WalletActivityHistory entity={entity} />;

  const selected = entity.accounts.find(account => account.counterpartyId === selectedAccountId) ?? null;
  return (
    <section className="wallet-accounts" data-testid="wallet-accounts-overview">
      <header className="wallet-accounts-head">
        <div><p className="wallet-eyebrow">committed entity state · h{entity.height}</p><h1>{entity.label}</h1><code>{entity.entityId}</code></div>
        <a href="/address">Address directory</a>
      </header>
      <div className="wallet-asset-strip">
        {entity.reserves.length === 0 ? <p>No committed reserve balances.</p> : entity.reserves.map(reserve => <article key={reserve.tokenId}><span>{reserve.symbol} reserve</span><strong>{reserve.formatted}</strong><small>{reserve.raw} raw</small></article>)}
      </div>
      {runtime.mode === 'remote' ? <RemoteTestAssetBoundary /> : <WalletTestAssetFaucet entity={entity} />}
      <WalletOpenAccount entity={entity} directory={state.directory} />
      <div className="wallet-account-layout">
        <div className="wallet-account-list" role="list">
          {entity.accounts.length === 0 ? <p className="wallet-empty-state">No bilateral accounts are committed.</p> : entity.accounts.map(account => (
            <button key={account.counterpartyId} type="button" data-testid="wallet-account-row" data-counterparty-id={account.counterpartyId} className={selectedAccountId === account.counterpartyId ? 'is-selected' : ''} onClick={() => setSelectedAccountId(account.counterpartyId)}>
              <span>{shortId(account.counterpartyId)}</span><small>{account.status} · A{account.currentHeight}{account.pending ? ' · pending' : ''}</small>
            </button>
          ))}
        </div>
        <div className="wallet-account-detail" data-testid="wallet-account-detail" data-counterparty-id={selected?.counterpartyId}>
          {!selected ? <p>Select an account to inspect exact bilateral capacity.</p> : <>
            <header><div><span>Counterparty</span><strong>{selected.counterpartyId}</strong></div><em className={selected.disputed ? 'is-error' : ''}>{selected.disputed ? 'disputed' : selected.pending ? 'pending' : 'committed'}</em></header>
            {selected.tokens.map(token => <article key={token.tokenId} data-testid="wallet-account-token" data-token-id={token.tokenId}>
              <div><strong>{token.symbol}</strong><small>token {token.tokenId}</small></div>
              <dl><div><dt>Outbound</dt><dd data-testid="wallet-token-outbound">{token.outbound}</dd></div><div><dt>Inbound</dt><dd data-testid="wallet-token-inbound">{token.inbound}</dd></div><div><dt>Collateral</dt><dd>{token.collateralRaw}</dd></div><div><dt>Delta</dt><dd>{token.raw}</dd></div><div><dt>Unsecured</dt><dd>{token.uncollateralizedRaw}</dd></div><div><dt>Rebalance requested</dt><dd>{token.requestedRebalanceRaw}</dd></div><div className="wallet-account-coverage"><dt>Secured coverage</dt><dd data-testid="account-status-coverage" className={coverageTone(token.securedCoveragePercent)}>{coverageText(token.securedCoveragePercent)}</dd><progress max="100" value={token.securedCoveragePercent}>{coverageText(token.securedCoveragePercent)}</progress></div></dl>
            </article>)}
            <WalletAccountConfigure entity={entity} account={selected} receipt={receipt} />
            <WalletAccountDispute entity={entity} account={selected} receipt={receipt} />
          </>}
        </div>
      </div>
    </section>
  );
};
