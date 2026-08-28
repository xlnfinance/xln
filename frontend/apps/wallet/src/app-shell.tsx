import { useEffect, useState } from 'react';

import { readRuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import type { WalletAuthScheme } from '../../../packages/browser/src/wallet-runtime-preferences';
import {
  resolveWalletAppView,
  resolveWalletRuntimeSummary,
  WALLET_APP_LINKS,
  type WalletRuntimeSummary,
} from './app-shell-model';
import { IdentityOnboarding } from './identity-onboarding';
import { WalletSettings } from './wallet-settings';
import { readWalletPreferences } from './wallet-settings-model';
import './styles/app-shell.css';

const readRuntimeSummary = () => resolveWalletRuntimeSummary(
  readRuntimeAdapterStorageSnapshot({ durable: localStorage, session: sessionStorage }),
  navigator.onLine,
);

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
          <p className="wallet-shell-eyebrow">Available now</p>
          <h2 id="wallet-actions-title">Choose a working surface</h2>
        </div>
        <div className="wallet-shell-action-links">
          <a href="/app?setup=1">Set up wallet identity <span aria-hidden="true">→</span></a>
          <a href="/app?settings=1">Adjust wallet settings <span aria-hidden="true">→</span></a>
          <a href="/testnet">Open testnet tools <span aria-hidden="true">↗</span></a>
          <a href="/health">Inspect network health <span aria-hidden="true">↗</span></a>
          <a href="/docs">Read documentation <span aria-hidden="true">↗</span></a>
        </div>
      </section>
    </>
  );
}

export function WalletAppShell() {
  const [runtime, setRuntime] = useState(readRuntimeSummary);
  const [view] = useState(() => resolveWalletAppView(window.location.search));
  const [authScheme, setAuthScheme] = useState<WalletAuthScheme>(() => (
    readWalletPreferences(localStorage).authScheme
  ));

  useEffect(() => {
    const refreshRuntime = () => setRuntime(readRuntimeSummary());
    window.addEventListener('storage', refreshRuntime);
    window.addEventListener('online', refreshRuntime);
    window.addEventListener('offline', refreshRuntime);
    return () => {
      window.removeEventListener('storage', refreshRuntime);
      window.removeEventListener('online', refreshRuntime);
      window.removeEventListener('offline', refreshRuntime);
    };
  }, []);

  return (
    <main className={`wallet-shell${view !== 'overview' && authScheme === 'light' ? ' is-auth-light' : ''}`}>
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
            {runtime.modeLabel}
          </span>
        </header>

        <div className="wallet-shell-workspace">
          {view === 'identity' ? <IdentityOnboarding /> : null}
          {view === 'settings' ? <WalletSettings onAuthSchemeChange={setAuthScheme} /> : null}
          {view === 'overview' ? <WalletOverview runtime={runtime} /> : null}
        </div>
      </div>
    </main>
  );
}
