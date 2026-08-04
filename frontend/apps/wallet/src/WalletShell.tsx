import { useEffect, useRef, useState } from 'react';

import type { Settings, ThemeName } from '$lib/types/ui';
import { walletErrorText } from './error-surface';
import type { WalletViewSnapshot } from './wallet-view-store';
import { WalletAccountsWorkspace, type WalletAccountSection } from './features/accounts/WalletAccountsWorkspace';

type WalletSection = 'overview' | 'settings' | WalletAccountSection;

export type WalletShellProps = Readonly<{
  wallet: WalletViewSnapshot;
  settings: Settings;
  connected: boolean;
  online: boolean;
  onSelectRuntime: (runtimeId: string) => Promise<void>;
  onLockRuntime: (runtimeId: string) => Promise<void>;
  onTheme: (theme: ThemeName) => void;
  onLiteMode: (enabled: boolean) => void;
  onTimeMachine: (enabled: boolean) => void;
  onMascot: (enabled: boolean) => void;
}>;

const shortId = (value: string): string => `${value.slice(0, 8)}…${value.slice(-6)}`;

export const WalletShell = (props: WalletShellProps) => {
  const initialSection: WalletSection = typeof window !== 'undefined' && window.location.hash.startsWith('#pay/') ? 'pay' : 'overview';
  const [section, setSection] = useState<WalletSection>(initialSection);
  const railRef = useRef<HTMLElement>(null);
  const [pending, setPending] = useState<'select' | 'lock' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = props.wallet.runtimes.find(runtime => runtime.id === props.wallet.activeRuntimeId) ?? null;
  const selectSection = (next: WalletSection, button: HTMLButtonElement): void => {
    setSection(next);
    if (window.matchMedia('(max-width: 760px)').matches) {
      button.scrollIntoView({ block: 'nearest', inline: 'center' });
    } else if (railRef.current) {
      railRef.current.scrollLeft = 0;
    }
  };
  useEffect(() => {
    const resetDesktopRail = (): void => {
      if (window.innerWidth > 760 && railRef.current) railRef.current.scrollLeft = 0;
    };
    window.addEventListener('resize', resetDesktopRail);
    resetDesktopRail();
    return () => window.removeEventListener('resize', resetDesktopRail);
  }, []);
  const run = async (kind: 'select' | 'lock', action: () => Promise<void>): Promise<void> => {
    setPending(kind);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(walletErrorText(actionError));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="wallet-shell" data-testid="app-runtime-ready">
      <header className="wallet-topbar">
        <a className="wallet-wordmark" href="/app" aria-label="xln wallet home">xln<span>/wallet</span></a>
        <div className="wallet-runtime-picker">
          <span className={`wallet-status-dot ${props.connected ? 'is-ready' : ''}`} aria-hidden="true" />
          <select
            aria-label="Active runtime"
            value={props.wallet.activeRuntimeId ?? ''}
            disabled={pending !== null}
            onChange={event => void run('select', () => props.onSelectRuntime(event.target.value))}
          >
            {props.wallet.runtimes.map(runtime => <option key={runtime.id} value={runtime.id}>{runtime.label}</option>)}
          </select>
        </div>
      </header>
      <aside ref={railRef} className="wallet-rail" aria-label="Wallet navigation">
        <button type="button" aria-current={section === 'overview' ? 'page' : undefined} onClick={event => selectSection('overview', event.currentTarget)}>
          <span>01</span>Overview
        </button>
        <button type="button" aria-current={section === 'accounts' ? 'page' : undefined} onClick={event => selectSection('accounts', event.currentTarget)}><span>02</span>Accounts</button>
        <button type="button" aria-current={section === 'pay' ? 'page' : undefined} onClick={event => selectSection('pay', event.currentTarget)}><span>03</span>Pay</button>
        <button type="button" aria-current={section === 'receive' ? 'page' : undefined} onClick={event => selectSection('receive', event.currentTarget)}><span>04</span>Receive</button>
        <button type="button" aria-current={section === 'move' ? 'page' : undefined} onClick={event => selectSection('move', event.currentTarget)}><span>05</span>Move</button>
        <button type="button" aria-current={section === 'lending' ? 'page' : undefined} onClick={event => selectSection('lending', event.currentTarget)}><span>06</span>Lending</button>
        <button type="button" aria-current={section === 'settlement' ? 'page' : undefined} onClick={event => selectSection('settlement', event.currentTarget)}><span>07</span>Settlement</button>
        <button type="button" aria-current={section === 'swap' ? 'page' : undefined} onClick={event => selectSection('swap', event.currentTarget)}><span>08</span>Swap</button>
        <button type="button" aria-current={section === 'activity' ? 'page' : undefined} onClick={event => selectSection('activity', event.currentTarget)}><span>09</span>Activity</button>
        <button type="button" aria-current={section === 'settings' ? 'page' : undefined} onClick={event => selectSection('settings', event.currentTarget)}>
          <span>10</span>Settings
        </button>
      </aside>
      <main className="wallet-main">
        {!props.online && <p className="wallet-network-banner" role="status">Offline — local vault access remains available.</p>}
        {props.online && !props.connected && <p className="wallet-network-banner" role="status">Runtime connecting — commands remain paused.</p>}
        {error && <p className="wallet-inline-error" role="alert">{error}</p>}
        {section === 'overview' ? (
          <section className="wallet-overview">
            <p className="wallet-eyebrow">active local runtime</p>
            <h1>{active?.label ?? 'Wallet'}</h1>
            <p className="wallet-runtime-id">{active ? shortId(active.id) : 'No runtime selected'}</p>
            <div className="wallet-balance-line">
              <span>Runtime state</span>
              <strong>{props.connected ? 'Ready' : 'Connecting'}</strong>
            </div>
            <dl className="wallet-facts">
              <div><dt>Signers</dt><dd>{active?.signerCount ?? 0}</dd></div>
              <div><dt>Local runtimes</dt><dd>{props.wallet.runtimes.length}</dd></div>
              <div><dt>Vault</dt><dd>{active?.unlocked ? 'Unlocked' : 'Locked'}</dd></div>
            </dl>
            {active && (
              <button className="wallet-button-secondary" type="button" disabled={pending !== null} onClick={() => void run('lock', () => props.onLockRuntime(active.id))}>
                {pending === 'lock' ? 'Locking…' : 'Lock this runtime'}
              </button>
            )}
          </section>
        ) : section === 'settings' ? (
          <WalletSettings
            settings={props.settings}
            onTheme={props.onTheme}
            onLiteMode={props.onLiteMode}
            onTimeMachine={props.onTimeMachine}
            onMascot={props.onMascot}
          />
        ) : (
          <WalletAccountsWorkspace section={section} />
        )}
      </main>
      <footer className="wallet-footer">
        <span>{props.connected ? 'connected' : 'connecting'}</span>
        <span>{props.online ? 'network online' : 'network offline'}</span>
      </footer>
    </div>
  );
};

type WalletSettingsProps = Pick<WalletShellProps, 'settings' | 'onTheme' | 'onLiteMode' | 'onTimeMachine' | 'onMascot'>;

export const WalletSettings = (props: WalletSettingsProps) => (
  <section className="wallet-settings">
    <p className="wallet-eyebrow">display preferences</p>
    <h1>Settings</h1>
    <label>
      <span>Theme</span>
      <select value={props.settings.theme} onChange={event => props.onTheme(event.target.value as ThemeName)}>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="editor">Editor</option>
        <option value="gold-luxe">Gold luxe</option>
        <option value="matrix">Matrix</option>
        <option value="arctic">Arctic</option>
      </select>
    </label>
    <label className="wallet-toggle"><span><strong>Lite mode</strong><small>Reduce decorative rendering.</small></span><input type="checkbox" checked={props.settings.liteMode} onChange={event => props.onLiteMode(event.target.checked)} /></label>
    <label className="wallet-toggle"><span><strong>Time machine</strong><small>Show committed runtime history controls.</small></span><input type="checkbox" checked={props.settings.showTimeMachine} onChange={event => props.onTimeMachine(event.target.checked)} /></label>
    <label className="wallet-toggle"><span><strong>xln mascot</strong><small>Show the local interface guide.</small></span><input type="checkbox" checked={props.settings.showXlnMascot} onChange={event => props.onMascot(event.target.checked)} /></label>
  </section>
);
