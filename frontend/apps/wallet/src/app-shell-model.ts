import type { RuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';

export const WALLET_APP_LINKS = [
  { href: '/app', label: 'Overview', current: true },
  { href: '/testnet', label: 'Testnet', current: false },
  { href: '/health', label: 'Network', current: false },
  { href: '/docs', label: 'Docs', current: false },
] as const;

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
