import { useEffect, useRef, useState } from 'react';

import type { Settings, ThemeName } from '$lib/types/ui';
import { useExternalStore } from '../../../packages/react-adapters/use-external-store';
import { walletErrorText } from './error-surface';
import type { WalletRuntimeSummary, WalletViewSnapshot } from './wallet-view-store';
import { WalletAccountsWorkspace, type WalletAccountSection } from './features/accounts/WalletAccountsWorkspace';
import type { WalletEntityAccountsView } from './features/accounts/account-view-model';
import { walletAccountExternalStore, type WalletDirectoryEntity } from './features/accounts/wallet-account-store';

type WalletSection = 'overview' | 'settings' | WalletAccountSection;

export type WalletShellProps = Readonly<{
  wallet: WalletViewSnapshot;
  settings: Settings;
  connected: boolean;
  online: boolean;
  onSelectRuntime: (runtimeId: string) => Promise<void>;
  onSelectEntity: (entityId: string) => Promise<void>;
  onLockRuntime: (runtimeId: string) => Promise<void>;
  onTheme: (theme: ThemeName) => void;
  onLiteMode: (enabled: boolean) => void;
  onTimeMachine: (enabled: boolean) => void;
  onMascot: (enabled: boolean) => void;
}>;

const shortId = (value: string): string => `${value.slice(0, 8)}…${value.slice(-6)}`;

export const resolveWalletShellIdentity = (
  active: WalletRuntimeSummary | null,
  entity: Pick<WalletEntityAccountsView, 'runtimeId' | 'entityId' | 'signerId'> | null,
) => Object.freeze({
  runtimeId: entity?.runtimeId || active?.id || null,
  entityId: entity?.entityId || active?.entityId || null,
  signerId: entity?.signerId || active?.signerId || null,
});

export const resolveWalletShellEntities = (
  runtimeId: string | null,
  directory: readonly WalletDirectoryEntity[],
): readonly WalletDirectoryEntity[] => {
  const runtime = String(runtimeId || '').trim().toLowerCase();
  if (!runtime) return Object.freeze([]);
  return Object.freeze(directory
    .filter(entity => !entity.isHub && entity.runtimeId === runtime)
    .toSorted((left, right) =>
      String(left.jurisdiction || '').localeCompare(String(right.jurisdiction || '')) ||
      left.entityId.localeCompare(right.entityId)
    ));
};

export const WalletShell = (props: WalletShellProps) => {
  const accountState = useExternalStore(walletAccountExternalStore);
  const initialSection: WalletSection = typeof window !== 'undefined' && window.location.hash.startsWith('#pay/') ? 'pay' : 'overview';
  const [section, setSection] = useState<WalletSection>(initialSection);
  const railRef = useRef<HTMLElement>(null);
  const [pending, setPending] = useState<'runtime' | 'entity' | 'lock' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = props.wallet.runtimes.find(runtime => runtime.id === props.wallet.activeRuntimeId) ?? null;
  const selectedIdentity = resolveWalletShellIdentity(active, accountState.entity);
  const localEntities = resolveWalletShellEntities(active?.id ?? null, accountState.directory);
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
  const run = async (kind: 'runtime' | 'entity' | 'lock', action: () => Promise<void>): Promise<void> => {
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
            data-testid="context-current"
            data-runtime-id={selectedIdentity.runtimeId ?? undefined}
            data-entity-id={selectedIdentity.entityId ?? undefined}
            data-signer-id={selectedIdentity.signerId ?? undefined}
            aria-label="Active runtime"
            value={props.wallet.activeRuntimeId ?? ''}
            disabled={pending !== null}
            onChange={event => void run('runtime', () => props.onSelectRuntime(event.target.value))}
          >
            {props.wallet.runtimes.map(runtime => <option key={runtime.id} value={runtime.id}>{runtime.label}</option>)}
          </select>
          {localEntities.length > 1 ? <select
            data-testid="wallet-entity-picker"
            aria-label="Active entity"
            value={selectedIdentity.entityId ?? ''}
            disabled={pending !== null}
            onChange={event => void run('entity', () => props.onSelectEntity(event.target.value))}
          >
            {localEntities.map(entity => <option key={entity.entityId} value={entity.entityId} data-jurisdiction={entity.jurisdiction ?? ''}>{entity.label} · {entity.jurisdiction ?? 'jurisdiction'}</option>)}
          </select> : null}
        </div>
      </header>
      <aside ref={railRef} className="wallet-rail" aria-label="Wallet navigation">
        <button type="button" aria-current={section === 'overview' ? 'page' : undefined} onClick={event => selectSection('overview', event.currentTarget)}>
          <span aria-hidden="true">01</span>Overview
        </button>
        <button type="button" data-testid="wallet-nav-accounts" aria-current={section === 'accounts' ? 'page' : undefined} onClick={event => selectSection('accounts', event.currentTarget)}><span aria-hidden="true">02</span>Accounts</button>
        <button type="button" data-testid="wallet-nav-pay" aria-current={section === 'pay' ? 'page' : undefined} onClick={event => selectSection('pay', event.currentTarget)}><span aria-hidden="true">03</span>Pay</button>
        <button type="button" data-testid="wallet-nav-receive" aria-current={section === 'receive' ? 'page' : undefined} onClick={event => selectSection('receive', event.currentTarget)}><span aria-hidden="true">04</span>Receive</button>
        <button type="button" data-testid="wallet-nav-move" aria-current={section === 'move' ? 'page' : undefined} onClick={event => selectSection('move', event.currentTarget)}><span aria-hidden="true">05</span>Move</button>
        <button type="button" data-testid="wallet-nav-lending" aria-current={section === 'lending' ? 'page' : undefined} onClick={event => selectSection('lending', event.currentTarget)}><span aria-hidden="true">06</span>Lending</button>
        <button type="button" aria-current={section === 'settlement' ? 'page' : undefined} onClick={event => selectSection('settlement', event.currentTarget)}><span aria-hidden="true">07</span>Settlement</button>
        <button type="button" data-testid="wallet-nav-swap" aria-current={section === 'swap' ? 'page' : undefined} onClick={event => selectSection('swap', event.currentTarget)}><span aria-hidden="true">08</span>Swap</button>
        <button type="button" data-testid="wallet-nav-activity" aria-current={section === 'activity' ? 'page' : undefined} onClick={event => selectSection('activity', event.currentTarget)}><span aria-hidden="true">09</span>Activity</button>
        <button type="button" aria-current={section === 'settings' ? 'page' : undefined} onClick={event => selectSection('settings', event.currentTarget)}>
          <span aria-hidden="true">10</span>Settings
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
