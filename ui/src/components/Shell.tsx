import { useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useApp } from '../runtime/store';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icons';
import { Toasts } from './Toasts';
import { Palette } from './Palette';
import { JurisdictionBanner } from './JurisdictionBanner';
import { getJurisdictionBadgeInfo } from '@xln/frontend/lib/utils/identity/jurisdictionBadge';
import { Tour } from './Tour';
import { useExternalWalletSync } from '../runtime/financial/external';
import { useWallet } from '../runtime/views';
import { Logo } from './Logo';
import { observeFundingBatches } from '../runtime/financial/funding-submission';
import { useRecoverySync } from '../runtime/recovery-sync';

/**
 * Destinations only. Pay, Receive and Swap are flows pushed over Home with a
 * back control, so no action is ever offered twice on one screen.
 */
const NAV: Array<{ to: string; label: string; icon: IconName; match: (pathname: string) => boolean }> = [
  {
    to: '/',
    label: 'Home',
    icon: 'home',
    match: pathname =>
      pathname === '/' ||
      pathname.startsWith('/accounts') ||
      pathname === '/pay' ||
      pathname === '/receive' ||
      pathname === '/swap' ||
      pathname === '/move',
  },
  { to: '/activity', label: 'Activity', icon: 'activity', match: pathname => pathname.startsWith('/activity') },
  {
    to: '/manage',
    label: 'Manage',
    icon: 'accounts',
    match: pathname =>
      pathname.startsWith('/manage') ||
      pathname.startsWith('/assets') ||
      pathname.startsWith('/lend') ||
      pathname.startsWith('/ownership') ||
      pathname.startsWith('/sovereignty') ||
      pathname.startsWith('/desk'),
  },
  { to: '/settings', label: 'Settings', icon: 'settings', match: pathname => pathname.startsWith('/settings') },
];

/** Screens with their own back control and one primary action; the tab bar would compete with them on a phone. */
const FLOW_ROUTES = new Set(['/pay', '/receive', '/swap', '/move']);

export function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const entityId = useApp(s => s.activeEntityId);
  const wallet = useWallet(entityId);
  useRecoverySync();
  const assets = useExternalWalletSync(wallet.entityId, wallet.signerId);
  const batches = wallet.frame?.activeEntity?.core?.jBatchState;
  useEffect(() => {
    observeFundingBatches(wallet.entityId, [
      batches?.batch,
      batches?.sentBatch?.batch,
      ...(batches?.recoveryBatches ?? []),
    ]);
  }, [wallet.entityId, batches]);
  const clearToasts = useApp(s => s.clearToasts);
  // A toast belongs to the screen that raised it.
  useEffect(() => clearToasts(), [pathname, clearToasts]);

  return (
    <div
      className="app jurisdiction-surface"
      data-jurisdiction={
        getJurisdictionBadgeInfo(wallet.jurisdiction, wallet.frame?.activeEntity?.core?.config.jurisdiction?.chainId)
          ?.className ?? 'generic'
      }
    >
      <a className="skip-link" href="#wallet-content">
        Skip to content
      </a>
      <Palette />
      <nav className="rail" aria-label="Primary">
        <div className="rail-brand" aria-hidden>
          <span className="rail-mark">
            <Logo size={17} />
          </span>
          <span className="rail-brand-name">xln</span>
        </div>
        {NAV.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            className={`rail-item${item.match(pathname) ? ' active' : ''}`}
            data-testid={`nav-${item.label.toLowerCase()}`}
            aria-label={item.label}
            title={item.label}
          >
            <Icon name={item.icon} size={18} />
            <span className="rail-label">{item.label}</span>
          </NavLink>
        ))}
        <div className="rail-spacer" />
        <div className="rail-foot">
          <span className="net-badge">{wallet.jurisdiction || 'Testnet'}</span>
          <span>Frame #{wallet.frameHeight.toLocaleString('en-US')}</span>
        </div>
      </nav>

      <main className="main" id="wallet-content" tabIndex={-1}>
        <JurisdictionBanner wallet={wallet} />
        {/* Asset refresh must not remount the guide and replay its chapter navigation. */}
        <Tour />
        {assets.ready ? (
          <>{children}</>
        ) : (
          <section
            className="stack"
            role={assets.error && !assets.sourceAdvance ? 'alert' : 'status'}
            data-testid="asset-snapshot-status"
          >
            <p>
              {assets.sourceAdvance
                ? 'The chain advanced during the balance read. Waiting for a consistent snapshot…'
                : assets.error
                  ? 'Could not load your assets.'
                  : 'Loading your assets…'}
            </p>
            {assets.error && (
              <>
                <p className="note">{assets.error}</p>
                <button className="btn" onClick={assets.retry}>
                  Retry
                </button>
              </>
            )}
          </section>
        )}
      </main>

      <nav className={`tabbar${FLOW_ROUTES.has(pathname) ? ' flow' : ''}`} aria-label="Primary">
        {NAV.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            className={`tabbar-item${item.match(pathname) ? ' active' : ''}`}
            data-testid={`nav-${item.label.toLowerCase()}`}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <Toasts />
    </div>
  );
}