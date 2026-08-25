import { useState } from 'react';

import { DEMO_ACCOUNTS } from '$lib/config/demo-accounts';
import { resetBrowserRuntimeData } from '../../../packages/browser/src/browser-runtime-reset';
import { publishBrowserHardResetRequest } from '../../../packages/browser/src/hard-reset-request';
import { createDemoWalletHref, TESTNET_CARDS } from './testnet-model';
import './styles/testnet.css';

const RESET_CONFIRMATION = 'Delete every local xln wallet, cache, and testnet database on this device?';

const resetErrorMessage = (error: unknown): string => error instanceof Error
  ? error.message
  : 'TESTNET_RESET_FAILED';

export function TestnetPage() {
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const resetTestnet = async (): Promise<void> => {
    if (!window.confirm(RESET_CONFIRMATION)) return;
    setResetting(true);
    setResetError(null);
    try {
      await resetBrowserRuntimeData(
        { confirmed: true, reason: 'testnet-tools' },
        { beforeClear: publishBrowserHardResetRequest },
      );
    } catch (error: unknown) {
      setResetting(false);
      setResetError(resetErrorMessage(error));
      throw error;
    }
  };

  return (
    <main className="testnet-page">
      <header className="testnet-hero">
        <div className="testnet-badge">TESTNET</div>
        <h1>xln Testnet</h1>
        <p>Explore the bilateral payment network. Free to use, no real funds at risk.</p>
      </header>

      <section className="testnet-cards" aria-label="Testnet destinations">
        {TESTNET_CARDS.map((card) => (
          <a
            className="testnet-card"
            href={card.href}
            key={card.title}
            rel={card.external ? 'noopener noreferrer' : undefined}
            target={card.external ? '_blank' : undefined}
          >
            <span className="testnet-card-icon" aria-hidden="true">{card.icon}</span>
            <h2>{card.title}</h2>
            <p>{card.description}</p>
            <span className="testnet-card-badges">
              {card.badges.map((badge) => <span className="testnet-card-badge" key={badge}>{badge}</span>)}
            </span>
            <strong>{card.cta} →</strong>
            {card.note ? <small>{card.note}</small> : null}
          </a>
        ))}
      </section>

      <section className="testnet-tools" aria-labelledby="testnet-tools-heading">
        <div>
          <div className="testnet-badge">LOCAL TOOLS</div>
          <h2 id="testnet-tools-heading">Test identities</h2>
          <p>Disposable Brain Vault wallets for local scenarios. They use no saved production identity.</p>
        </div>
        <div className="testnet-demo-grid">
          {DEMO_ACCOUNTS.map((account) => (
            <a className="testnet-demo-account" href={createDemoWalletHref(account.label)} key={account.label}>
              <strong>{account.label}</strong>
              <span>Open disposable wallet</span>
            </a>
          ))}
        </div>
        <button className="testnet-reset" disabled={resetting} onClick={() => void resetTestnet()} type="button">
          {resetting ? 'Deleting local testnet data…' : 'Delete local testnet data'}
        </button>
        {resetError ? <p className="testnet-reset-error" role="alert">Reset failed: {resetError}</p> : null}
      </section>

      <footer className="testnet-footer">
        <p>Built with bilateral consensus. Every payment is a cryptographic proof.</p>
        <nav aria-label="Testnet resources">
          <a href="https://github.com/xln-finance" rel="noopener noreferrer" target="_blank">GitHub</a>
          <a href="https://x.com/xlnfinance" rel="noopener noreferrer" target="_blank">Twitter</a>
          <a href="/docs">Docs</a>
        </nav>
      </footer>
    </main>
  );
}
