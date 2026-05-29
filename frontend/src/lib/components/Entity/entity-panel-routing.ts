export type ViewTab = 'assets' | 'accounts' | 'settings';
export type SettingsSubview = 'wallet' | 'recovery' | 'display' | 'network' | 'data' | 'log' | 'entity';
export type AccountWorkspaceTab = 'send' | 'receive' | 'swap' | 'open' | 'activity' | 'move' | 'history' | 'configure' | 'appearance';
export type AssetWorkspaceTab = 'move' | 'history';
export type ConfigureWorkspaceTab = 'extend-credit' | 'request-credit' | 'collateral' | 'token' | 'dispute';

export type EntityPanelRouteState = {
  activeTab: ViewTab;
  assetWorkspaceTab: AssetWorkspaceTab;
  settingsSubview: SettingsSubview;
  accountWorkspaceTab: AccountWorkspaceTab;
};

export function getLocationHashRoute(location: Location): string | null {
  const hashRaw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!hashRaw) return null;
  const queryIndex = hashRaw.indexOf('?');
  const routePart = queryIndex >= 0 ? hashRaw.slice(0, queryIndex) : hashRaw;
  if (!routePart || routePart.includes('=')) return null;
  return routePart.trim().toLowerCase() || null;
}

export function getLocationHashParams(location: Location): URLSearchParams | null {
  const hashRaw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!hashRaw) return null;
  const queryIndex = hashRaw.indexOf('?');
  if (queryIndex >= 0) {
    const routePart = hashRaw.slice(0, queryIndex);
    if (!routePart.includes('=')) {
      return new URLSearchParams(hashRaw.slice(queryIndex + 1));
    }
  }
  return hashRaw.includes('=') ? new URLSearchParams(hashRaw) : null;
}

export function getLocationParamValue(location: Location, keys: string[]): string | null {
  const searchParams = new URLSearchParams(location.search);
  const hashParams = getLocationHashParams(location);
  for (const key of keys) {
    const hashValue = hashParams?.get(key);
    if (typeof hashValue === 'string' && hashValue.length > 0) return hashValue;
    const queryValue = searchParams.get(key);
    if (typeof queryValue === 'string' && queryValue.length > 0) return queryValue;
  }
  return null;
}

export function canonicalizeEntityPanelRoute(routeRaw: string | null): string | null {
  const route = String(routeRaw || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!route) return null;
  if (route.startsWith('pay/')) return 'accounts/send';
  switch (route) {
    case 'assets':
    case 'assets/move':
    case 'external':
    case 'reserves':
      return 'assets';
    case 'assets/history':
      return 'assets/history';
    case 'accounts':
    case 'accounts/open':
    case 'open':
      return 'accounts/open';
    case 'accounts/send':
    case 'pay':
    case 'send':
      return 'accounts/send';
    case 'accounts/receive':
    case 'receive':
      return 'accounts/receive';
    case 'accounts/swap':
    case 'swap':
      return 'accounts/swap';
    case 'accounts/move':
    case 'move':
      return 'accounts/move';
    case 'accounts/history':
    case 'history':
      return 'accounts/history';
    case 'accounts/configure':
    case 'configure':
      return 'accounts/configure';
    case 'accounts/activity':
    case 'activity':
      return 'accounts/activity';
    case 'accounts/appearance':
    case 'appearance':
      return 'accounts/appearance';
    case 'settings':
    case 'settings/wallet':
    case 'wallet':
      return 'settings';
    case 'settings/recovery':
    case 'recovery':
    case 'watchtowers':
      return 'settings/recovery';
    case 'settings/display':
    case 'display':
      return 'settings/display';
    case 'settings/network':
    case 'network':
    case 'gossip':
      return 'settings/network';
    case 'settings/data':
    case 'data':
      return 'settings/data';
    case 'settings/log':
    case 'log':
    case 'chat':
      return 'settings/log';
    case 'settings/entity':
    case 'entity':
    case 'governance':
    case 'create':
      return 'settings/entity';
    default:
      return null;
  }
}

export function buildEntityPanelHashRouteFromState(state: EntityPanelRouteState): string {
  if (state.activeTab === 'assets') {
    return state.assetWorkspaceTab === 'history' ? 'assets/history' : 'assets';
  }
  if (state.activeTab === 'settings') {
    return state.settingsSubview === 'wallet' ? 'settings' : `settings/${state.settingsSubview}`;
  }
  if (state.accountWorkspaceTab === 'open') return 'accounts';
  return `accounts/${state.accountWorkspaceTab}`;
}
