import type { RuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';

export const WALLET_APP_LINKS = [
  { href: '/app', label: 'Overview', view: 'overview' },
  { href: '/app?portfolio=1', label: 'Assets', view: 'portfolio' },
  { href: '/app?setup=1', label: 'Identity', view: 'identity' },
  { href: '/app?settings=1', label: 'Settings', view: 'settings' },
  { href: '/app?diagnostics=1', label: 'Status', view: 'diagnostics' },
  { href: '/testnet', label: 'Testnet', view: null },
  { href: '/health', label: 'Network', view: null },
  { href: '/docs', label: 'Docs', view: null },
] as const;

export type WalletAppView = 'overview' | 'portfolio' | 'identity' | 'settings' | 'diagnostics';

export const resolveWalletAppView = (search: string): WalletAppView => {
  const params = new URLSearchParams(search);
  if (params.get('setup') === '1' || params.has('demo')) return 'identity';
  if (params.get('portfolio') === '1') return 'portfolio';
  if (params.get('settings') === '1') return 'settings';
  return params.get('diagnostics') === '1' ? 'diagnostics' : 'overview';
};

export type WalletRuntimeSummary = Readonly<{
  modeLabel: 'Local Runtime' | 'Remote Runtime';
  endpointLabel: string;
  authorityLabel: 'Local control' | 'Admin session' | 'Authority required';
  browserLabel: 'Online' | 'Offline';
  state: 'local' | 'remote-ready' | 'remote-blocked';
}>;

export const resolveWalletRuntimeSummary = (
  snapshot: RuntimeAdapterStorageSnapshot,
  browserOnline: boolean,
): WalletRuntimeSummary => {
  if (snapshot.mode !== 'remote') {
    return {
      modeLabel: 'Local Runtime',
      endpointLabel: 'This browser',
      authorityLabel: 'Local control',
      browserLabel: browserOnline ? 'Online' : 'Offline',
      state: 'local',
    };
  }

  const wsUrl = snapshot.wsUrl?.trim() || 'Endpoint missing';
  const hasAdminSession = snapshot.access === 'admin' && Boolean(snapshot.sessionKey?.trim());
  return {
    modeLabel: 'Remote Runtime',
    endpointLabel: wsUrl,
    authorityLabel: hasAdminSession ? 'Admin session' : 'Authority required',
    browserLabel: browserOnline ? 'Online' : 'Offline',
    state: hasAdminSession && wsUrl !== 'Endpoint missing' ? 'remote-ready' : 'remote-blocked',
  };
};
