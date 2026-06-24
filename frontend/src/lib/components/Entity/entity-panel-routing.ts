export type ViewTab = 'assets' | 'accounts' | 'settings';
export type SettingsSubview = 'wallet' | 'recovery' | 'display' | 'network' | 'data' | 'log' | 'entity';
export type AccountWorkspaceTab = 'send' | 'receive' | 'swap' | 'open' | 'activity' | 'move' | 'lending' | 'history' | 'configure' | 'appearance';
export type AssetWorkspaceTab = 'move' | 'history';
export type ConfigureWorkspaceTab = 'extend-credit' | 'request-credit' | 'collateral' | 'token' | 'dispute';

export type EntityPanelRouteState = {
  activeTab: ViewTab;
  assetWorkspaceTab: AssetWorkspaceTab;
  settingsSubview: SettingsSubview;
  accountWorkspaceTab: AccountWorkspaceTab;
};

export type EntityPanelDeepLinkRequest = {
  hashRoute?: string | null;
  view?: string | null;
  subview?: string | null;
  jurisdiction?: string | null;
  availableJurisdictionNames?: readonly (string | null | undefined)[];
};

export type EntityPanelDeepLinkUpdate = Partial<EntityPanelRouteState & {
  configureWorkspaceTab: ConfigureWorkspaceTab;
  selectedJurisdictionName: string | null;
}>;

const settingsSubviews: readonly SettingsSubview[] = ['wallet', 'recovery', 'display', 'network', 'data', 'log', 'entity'];
const configureWorkspaceTabs: readonly ConfigureWorkspaceTab[] = ['extend-credit', 'request-credit', 'collateral', 'token', 'dispute'];

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
    case 'accounts/lending':
    case 'lending':
    case 'borrow':
    case 'lend':
      return 'accounts/lending';
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

export function resolveEntityPanelDeepLink(input: EntityPanelDeepLinkRequest): EntityPanelDeepLinkUpdate {
  const update: EntityPanelDeepLinkUpdate = {};
  const hashRoute = canonicalizeEntityPanelRoute(input.hashRoute ?? null);
  const view = String(input.view || hashRoute || '').trim().toLowerCase();
  const subview = String(input.subview || '').trim().toLowerCase();
  const jurisdiction = String(input.jurisdiction || '').trim();

  switch (view) {
    case 'assets':
      update.activeTab = 'assets';
      update.assetWorkspaceTab = 'move';
      break;
    case 'assets/history':
      update.activeTab = 'assets';
      update.assetWorkspaceTab = 'history';
      break;
    case 'accounts':
    case 'accounts/open':
      update.activeTab = 'accounts';
      update.accountWorkspaceTab = 'open';
      break;
    case 'accounts/send':
      update.activeTab = 'accounts';
      update.accountWorkspaceTab = 'send';
      break;
    case 'accounts/receive':
      update.activeTab = 'accounts';
      update.accountWorkspaceTab = 'receive';
      break;
    case 'accounts/swap':
      update.activeTab = 'accounts';
      update.accountWorkspaceTab = 'swap';
      break;
    case 'accounts/move':
      update.activeTab = 'accounts';
      update.accountWorkspaceTab = 'move';
      break;
    case 'accounts/lending':
      update.activeTab = 'accounts';
      update.accountWorkspaceTab = 'lending';
      break;
    case 'accounts/history':
      update.activeTab = 'accounts';
      update.accountWorkspaceTab = 'history';
      break;
    case 'accounts/configure':
      update.activeTab = 'accounts';
      update.accountWorkspaceTab = 'configure';
      break;
    case 'accounts/activity':
      update.activeTab = 'accounts';
      update.accountWorkspaceTab = 'activity';
      break;
    case 'accounts/appearance':
      update.activeTab = 'accounts';
      update.accountWorkspaceTab = 'appearance';
      break;
    case 'settings':
      update.activeTab = 'settings';
      update.settingsSubview = 'wallet';
      break;
    case 'settings/recovery':
      update.activeTab = 'settings';
      update.settingsSubview = 'recovery';
      break;
    case 'settings/display':
      update.activeTab = 'settings';
      update.settingsSubview = 'display';
      break;
    case 'settings/network':
      update.activeTab = 'settings';
      update.settingsSubview = 'network';
      break;
    case 'settings/data':
      update.activeTab = 'settings';
      update.settingsSubview = 'data';
      break;
    case 'settings/log':
      update.activeTab = 'settings';
      update.settingsSubview = 'log';
      break;
    case 'settings/entity':
      update.activeTab = 'settings';
      update.settingsSubview = 'entity';
      break;
    default:
      break;
  }

  if (view === 'settings' && settingsSubviews.includes(subview as SettingsSubview)) {
    update.settingsSubview = subview as SettingsSubview;
  }
  if (view === 'configure' && subview) {
    if (subview === 'credit') {
      update.configureWorkspaceTab = 'extend-credit';
    } else if (configureWorkspaceTabs.includes(subview as ConfigureWorkspaceTab)) {
      update.configureWorkspaceTab = subview as ConfigureWorkspaceTab;
    }
  }
  if (jurisdiction) {
    const matched = input.availableJurisdictionNames?.find((candidate) =>
      String(candidate || '').trim().toLowerCase() === jurisdiction.toLowerCase(),
    );
    update.selectedJurisdictionName = matched ? String(matched) : jurisdiction;
  }
  return update;
}

export function resolveEntityPanelDeepLinkFromLocation(
  location: Location,
  availableJurisdictionNames: readonly (string | null | undefined)[] = [],
): EntityPanelDeepLinkUpdate {
  const hashRoute = canonicalizeEntityPanelRoute(getLocationHashRoute(location));
  return resolveEntityPanelDeepLink({
    hashRoute,
    view: getLocationParamValue(location, ['view']),
    subview: getLocationParamValue(location, ['subview', 'sub']),
    jurisdiction: getLocationParamValue(location, ['jId', 'jurisdiction', 'j']),
    availableJurisdictionNames,
  });
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
