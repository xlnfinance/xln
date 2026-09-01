import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';

import { readRuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import type { WalletAuthScheme } from '../../../packages/browser/src/wallet-runtime-preferences';
import {
  resolveWalletAppView,
  resolveWalletRuntimeSummary,
  WALLET_APP_LINKS,
  type WalletRuntimeSummary,
} from './app-shell-model';
import { IdentityOnboarding } from './identity-onboarding';
import { WalletDiagnostics } from './wallet-diagnostics';
import { WalletFinancialHealth } from './wallet-financial-health';
import { WalletMarkets } from './wallet-markets';
import { WalletPayments } from './wallet-payments';
import { WalletPortfolio } from './wallet-portfolio';
import { WalletSettings } from './wallet-settings';
import { readWalletPreferences } from './wallet-settings-model';
import {
  getWalletEmbeddedRuntimeSnapshot,
  startWalletEmbeddedRuntime,
  subscribeWalletEmbeddedRuntime,
} from './wallet-embedded-runtime';
import './styles/app-shell.css';

const readRuntimeConfig = () =>
  readRuntimeAdapterStorageSnapshot({ durable: localStorage, session: sessionStorage });

let runtimeInitializationStarted = false;

const WalletScenarioPreview = lazy(async () => {
  const module = await import('./wallet-scenario-preview');
  return { default: module.WalletScenarioPreview };
});

const initializeEmbeddedRuntimeOnce = (): void => {
  if (runtimeInitializationStarted || readRuntimeConfig().mode === 'remote') return;
  runtimeInitializationStarted = true;
  void startWalletEmbeddedRuntime().catch((error: unknown) => {
    runtimeInitializationStarted = false;
    window.setTimeout(() => {
      throw error instanceof Error ? error : new Error(String(error));
    }, 0);
  });
};

function WalletOverview({ runtime }: Readonly<{ runtime: WalletRuntimeSummary }>) {
  return (
    <>
      <section className="wallet-shell-intro" aria-labelledby="wallet-overview-title">
        <p className="wallet-shell-eyebrow">Runtime context</p>
        <h1 id="wallet-overview-title">Wallet overview</h1>
        <p>Runtime and authority status for this browser.</p>
      </section>

      {runtime.state === 'remote-blocked' ? (
        <section className="wallet-shell-alert" aria-labelledby="wallet-authority-title">
          <p>Action required</p>
          <h2 id="wallet-authority-title">Restore remote authority</h2>
          <span>Open an authorized Runtime link in this tab before sending commands.</span>
        </section>
      ) : null}

      <section className="wallet-shell-facts" aria-label="Current Runtime status">
        <dl>
          <div><dt>Runtime</dt><dd>{runtime.modeLabel}</dd></div>
          <div><dt>Endpoint</dt><dd>{runtime.endpointLabel}</dd></div>
          <div><dt>Authority</dt><dd>{runtime.authorityLabel}</dd></div>
          <div><dt>Browser</dt><dd>{runtime.browserLabel}</dd></div>
        </dl>
      </section>

      <section className="wallet-shell-actions" aria-labelledby="wallet-actions-title">
        <div>
          <p className="wallet-shell-eyebrow">Candidate surfaces</p>
          <h2 id="wallet-actions-title">Choose a wallet surface</h2>
        </div>
        <div className="wallet-shell-action-links">
          <a href="/app?setup=1">Review identity and recovery <span aria-hidden="true">→</span></a>
          <a href="/app?portfolio=1">Inspect assets and accounts <span aria-hidden="true">→</span></a>
          <a href="/app?health=1">Review financial health <span aria-hidden="true">→</span></a>
          <a href="/app?payments=1">Send or receive payments <span aria-hidden="true">→</span></a>
          <a href="/app?markets=1">Trade committed markets <span aria-hidden="true">→</span></a>
          <a href="/app?settings=1">Adjust wallet settings <span aria-hidden="true">→</span></a>
          <a href="/app?diagnostics=1">Review wallet diagnostics <span aria-hidden="true">→</span></a>
          <a href="/testnet">Open testnet tools <span aria-hidden="true">↗</span></a>
          <a href="/health">Inspect network health <span aria-hidden="true">↗</span></a>
          <a href="/docs">Read documentation <span aria-hidden="true">↗</span></a>
        </div>
      </section>
    </>
  );
}

function WalletRuntimeBoundary({ runtime }: Readonly<{ runtime: WalletRuntimeSummary }>) {
  const standby = runtime.state === 'local-standby';
  return (
    <section className="wallet-shell-alert" aria-labelledby="wallet-local-runtime-title" role="alert">
      <p>{standby ? 'Inactive tab' : 'Runtime error'}</p>
      <h1 id="wallet-local-runtime-title">
        {standby ? 'Another tab owns the local Runtime.' : 'Local Runtime boot failed.'}
      </h1>
      <span>{runtime.message}</span>
    </section>
  );
}

export function WalletAppShell() {
  const [, setEnvironmentRevision] = useState(0);
  const embedded = useSyncExternalStore(
    subscribeWalletEmbeddedRuntime,
    getWalletEmbeddedRuntimeSnapshot,
    getWalletEmbeddedRuntimeSnapshot,
  );
  const [view] = useState(() => resolveWalletAppView(window.location.search, window.location.hash));
  const [authScheme, setAuthScheme] = useState<WalletAuthScheme>(() => (
    readWalletPreferences(localStorage).authScheme
  ));
  const usesIdentityAppearance = view === 'identity' || view === 'settings';
  const runtime = resolveWalletRuntimeSummary(readRuntimeConfig(), navigator.onLine, embedded);

  useEffect(() => {
    if (view !== 'scenario-preview') initializeEmbeddedRuntimeOnce();
    const refreshRuntime = () => setEnvironmentRevision(revision => revision + 1);
    window.addEventListener('storage', refreshRuntime);
    window.addEventListener('online', refreshRuntime);
    window.addEventListener('offline', refreshRuntime);
    return () => {
      window.removeEventListener('storage', refreshRuntime);
      window.removeEventListener('online', refreshRuntime);
      window.removeEventListener('offline', refreshRuntime);
    };
  }, [view]);

  return (
    <main className={`wallet-shell${usesIdentityAppearance && authScheme === 'light' ? ' is-auth-light' : ''}`}>
      <aside className="wallet-shell-rail">
        <a className="wallet-shell-brand" href="/app" aria-label="xln wallet">xln</a>
        <nav className="wallet-shell-nav" aria-label="Wallet navigation">
          {WALLET_APP_LINKS.map((link) => (
            <a
              aria-current={link.view === view ? 'page' : undefined}
              className={link.view === view ? 'wallet-shell-link is-current' : 'wallet-shell-link'}
              href={link.href}
              key={link.href}
            >
              {link.label}
            </a>
          ))}
        </nav>
        <p className="wallet-shell-privacy">Keys stay with your Runtime.</p>
      </aside>

      <div className="wallet-shell-canvas">
        <header className="wallet-shell-topbar">
          <span>Wallet</span>
          <span className={`wallet-shell-runtime-state is-${runtime.state}`}>
            <span aria-hidden="true" />
            {view === 'scenario-preview' ? 'Scenario preview' : runtime.modeLabel}
          </span>
        </header>

        <div className="wallet-shell-workspace">
          {runtime.state === 'local-standby' || runtime.state === 'local-error' ? (
            <WalletRuntimeBoundary runtime={runtime} />
          ) : (
            <>
              {view === 'identity' ? <IdentityOnboarding /> : null}
              {view === 'portfolio' ? <WalletPortfolio /> : null}
              {view === 'health' ? <WalletFinancialHealth /> : null}
              {view === 'payments' ? <WalletPayments /> : null}
              {view === 'markets' ? <WalletMarkets /> : null}
              {view === 'settings' ? <WalletSettings onAuthSchemeChange={setAuthScheme} /> : null}
              {view === 'diagnostics' ? <WalletDiagnostics runtime={runtime} /> : null}
              {view === 'scenario-preview' ? <Suspense fallback={<p>Loading scenario preview…</p>}><WalletScenarioPreview /></Suspense> : null}
              {view === 'overview' ? <WalletOverview runtime={runtime} /> : null}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
