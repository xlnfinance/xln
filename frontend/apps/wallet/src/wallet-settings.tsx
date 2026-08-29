import { useState } from 'react';

import type { WalletAuthScheme } from '../../../packages/browser/src/wallet-runtime-preferences';
import {
  persistWalletAuthScheme,
  persistWalletWorkerCap,
  readWalletPreferences,
  walletPreferenceStorageErrorMessage,
  type WalletWorkerCapChoice,
} from './wallet-settings-model';
import './styles/wallet-settings.css';

const WORKER_CAPS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export function WalletSettings({
  onAuthSchemeChange,
}: Readonly<{ onAuthSchemeChange: (scheme: WalletAuthScheme) => void }>) {
  const [preferences, setPreferences] = useState(() => readWalletPreferences(localStorage));
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const changeAuthScheme = (authScheme: WalletAuthScheme): void => {
    setStatus('');
    setError('');
    try {
      const next = persistWalletAuthScheme(localStorage, authScheme);
      setPreferences(next);
      onAuthSchemeChange(next.authScheme);
      setStatus('Identity appearance saved in this browser.');
    } catch (failure: unknown) {
      setError(walletPreferenceStorageErrorMessage(failure));
    }
  };

  const changeWorkerCap = (rawChoice: string): void => {
    const choice: WalletWorkerCapChoice = rawChoice === 'automatic'
      ? 'automatic'
      : Number(rawChoice) as WalletWorkerCapChoice;
    setStatus('');
    setError('');
    try {
      const next = persistWalletWorkerCap(localStorage, choice);
      setPreferences(next);
      setStatus(choice === 'automatic'
        ? 'Automatic BrainVault worker selection restored.'
        : `BrainVault concurrency capped at ${choice} worker${choice === 1 ? '' : 's'}.`);
    } catch (failure: unknown) {
      setError(walletPreferenceStorageErrorMessage(failure));
    }
  };

  return (
    <section className="wallet-settings" aria-labelledby="wallet-settings-title">
      <header>
        <p className="wallet-shell-eyebrow">Browser preferences</p>
        <h1 id="wallet-settings-title">Wallet settings</h1>
        <p>Device-local choices for identity entry and memory-hard recovery work.</p>
      </header>

      <div className="wallet-settings-list">
        <fieldset className="wallet-preference-row">
          <legend>Identity appearance</legend>
          <p>Applied to identity and recovery screens. It does not change wallet data.</p>
          <div className="wallet-scheme-options">
            {(['dark', 'light'] as const).map((scheme) => (
              <button
                aria-pressed={preferences.authScheme === scheme}
                key={scheme}
                onClick={() => changeAuthScheme(scheme)}
                type="button"
              >
                <strong>{scheme === 'dark' ? 'Vault dark' : 'Paper light'}</strong>
                <span>{scheme === 'dark' ? 'Low-light workspace' : 'High-contrast document'}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <label className="wallet-preference-row" htmlFor="wallet-worker-cap">
          <span>
            <strong>BrainVault worker cap</strong>
            <small>Limits browser concurrency; memory pressure may reduce it further.</small>
          </span>
          <select
            id="wallet-worker-cap"
            onChange={(event) => changeWorkerCap(event.target.value)}
            value={preferences.brainVaultWorkerCap ?? 'automatic'}
          >
            <option value="automatic">Automatic</option>
            {WORKER_CAPS.map((cap) => <option key={cap} value={cap}>{cap} worker{cap === 1 ? '' : 's'}</option>)}
          </select>
        </label>
      </div>

      <p className="wallet-settings-boundary">
        Preferences stay in this browser. Recovery secrets, Runtime state, and authority are not stored here.
      </p>
      {status ? <p className="wallet-settings-status" aria-live="polite">{status}</p> : null}
      {error ? <p className="wallet-settings-error" role="alert">{error}</p> : null}
    </section>
  );
}
