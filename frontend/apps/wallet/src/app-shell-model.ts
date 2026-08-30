import type { RuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import type { WalletEmbeddedRuntimeSessionSnapshot } from '../../../packages/browser/src/wallet-embedded-runtime-session';

export const WALLET_APP_LINKS = [
  { href: '/app', label: 'Overview', view: 'overview' },
  { href: '/app?portfolio=1', label: 'Assets', view: 'portfolio' },
  { href: '/app?health=1', label: 'Health', view: 'health' },
  { href: '/app?payments=1', label: 'Payments', view: 'payments' },
  { href: '/app?markets=1', label: 'Markets', view: 'markets' },
  { href: '/app?setup=1', label: 'Identity', view: 'identity' },
  { href: '/app?settings=1', label: 'Settings', view: 'settings' },
  { href: '/app?diagnostics=1', label: 'Status', view: 'diagnostics' },
  { href: '/testnet', label: 'Testnet', view: null },
  { href: '/health', label: 'Network', view: null },
  { href: '/docs', label: 'Docs', view: null },
] as const;

export type WalletAppView = 'overview' | 'portfolio' | 'health' | 'payments' | 'markets' | 'identity' | 'settings' | 'diagnostics';

export const resolveWalletAppView = (search: string, hash = ''): WalletAppView => {
  const params = new URLSearchParams(search);
  if (params.get('setup') === '1' || params.has('demo')) return 'identity';
  if (params.get('portfolio') === '1') return 'portfolio';
  if (params.get('health') === '1') return 'health';
  if (params.get('payments') === '1' || hash.toLowerCase().startsWith('#pay/')) return 'payments';
  if (params.get('markets') === '1') return 'markets';
  if (params.get('settings') === '1') return 'settings';
  return params.get('diagnostics') === '1' ? 'diagnostics' : 'overview';
};

export type WalletRuntimeSummary = Readonly<{
  modeLabel: 'Local Runtime starting' | 'Local Runtime' | 'Local Runtime standby' | 'Local Runtime error' | 'Remote Runtime';
  endpointLabel: string;
  authorityLabel: 'Local owner' | 'Inactive tab' | 'Runtime booting' | 'Runtime failed' | 'Admin session' | 'Authority required';
  browserLabel: 'Online' | 'Offline';
  state: 'local-loading' | 'local-ready' | 'local-standby' | 'local-error' | 'remote-ready' | 'remote-blocked';
  message: string;
}>;

const embeddedRuntimeSummary = (
  snapshot: WalletEmbeddedRuntimeSessionSnapshot,
  browserLabel: 'Online' | 'Offline',
): WalletRuntimeSummary => {
  if (snapshot.status === 'ready') return {
    modeLabel: 'Local Runtime',
    endpointLabel: `${snapshot.runtimeId.slice(0, 12) || 'embedded'} · H${snapshot.height}`,
    authorityLabel: 'Local owner',
    browserLabel,
    state: 'local-ready',
    message: '',
  };
  if (snapshot.status === 'standby') return {
    modeLabel: 'Local Runtime standby', endpointLabel: 'Owned by another tab',
    authorityLabel: 'Inactive tab', browserLabel, state: 'local-standby', message: snapshot.message,
  };
  if (snapshot.status === 'error') return {
    modeLabel: 'Local Runtime error', endpointLabel: 'Boot failed',
    authorityLabel: 'Runtime failed', browserLabel, state: 'local-error', message: snapshot.message,
  };
  return {
    modeLabel: 'Local Runtime starting', endpointLabel: 'Starting…',
    authorityLabel: 'Runtime booting', browserLabel, state: 'local-loading', message: snapshot.message,
  };
};

export const resolveWalletRuntimeSummary = (
  snapshot: RuntimeAdapterStorageSnapshot,
  browserOnline: boolean,
  embedded: WalletEmbeddedRuntimeSessionSnapshot = {
    status: 'idle', runtimeId: '', height: 0, message: 'Local Runtime has not started.',
  },
): WalletRuntimeSummary => {
  const browserLabel = browserOnline ? 'Online' : 'Offline';
  if (snapshot.mode !== 'remote') {
    return embeddedRuntimeSummary(embedded, browserLabel);
  }

  const wsUrl = snapshot.wsUrl?.trim() || 'Endpoint missing';
  const hasAdminSession = snapshot.access === 'admin' && Boolean(snapshot.sessionKey?.trim());
  return {
    modeLabel: 'Remote Runtime',
    endpointLabel: wsUrl,
    authorityLabel: hasAdminSession ? 'Admin session' : 'Authority required',
    browserLabel,
    state: hasAdminSession && wsUrl !== 'Endpoint missing' ? 'remote-ready' : 'remote-blocked',
    message: '',
  };
};
