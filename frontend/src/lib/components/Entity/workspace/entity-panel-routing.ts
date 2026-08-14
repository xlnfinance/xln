export type ViewTab = 'assets' | 'accounts' | 'company' | 'settings';
export type SettingsSubview = 'wallet' | 'consensus' | 'recovery' | 'display' | 'stack-manager' | 'network' | 'data' | 'log' | 'entity';
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
  jurisdiction?: string | null;
  availableJurisdictionNames?: readonly (string | null | undefined)[];
};

export type EntityPanelDeepLinkUpdate = Partial<EntityPanelRouteState & {
  configureWorkspaceTab: ConfigureWorkspaceTab;
  selectedJurisdictionName: string | null;
}>;

type RouteLocation = Pick<Location, 'hash' | 'search'>;

export function getLocationHashRoute(location: RouteLocation): string | null {
  const hashRaw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!hashRaw) return null;
  const queryIndex = hashRaw.indexOf('?');
  const routePart = queryIndex >= 0 ? hashRaw.slice(0, queryIndex) : hashRaw;
  if (!routePart || routePart.includes('=')) return null;
  return routePart.trim().toLowerCase() || null;
}

export function getLocationHashParams(location: RouteLocation): URLSearchParams | null {
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

export function getLocationParamValue(location: RouteLocation, keys: string[]): string | null {
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
  switch (route) {
    case 'assets':
    case 'assets/move':
      return 'assets';
    case 'assets/history':
      return 'assets/history';
    case 'accounts':
    case 'accounts/open':
      return 'accounts/open';
    case 'accounts/send':
      return 'accounts/send';
    case 'accounts/receive':
      return 'accounts/receive';
    case 'accounts/swap':
      return 'accounts/swap';
    case 'accounts/move':
      return 'accounts/move';
    case 'accounts/lending':
      return 'accounts/lending';
    case 'accounts/history':
      return 'accounts/history';
    case 'accounts/configure':
      return 'accounts/configure';
    case 'accounts/activity':
      return 'accounts/activity';
    case 'accounts/appearance':
      return 'accounts/appearance';
    case 'company':
      return 'company';
    case 'settings':
    case 'settings/wallet':
      return 'settings';
    case 'settings/recovery':
      return 'settings/recovery';
    case 'settings/consensus':
      return 'settings/consensus';
    case 'settings/display':
      return 'settings/display';
    case 'settings/stack-manager':
      return 'settings/stack-manager';
    case 'settings/network':
      return 'settings/network';
    case 'settings/data':
      return 'settings/data';
    case 'settings/log':
      return 'settings/log';
    case 'settings/entity':
      return 'settings/entity';
    default:
      return null;
  }
}

export function resolveEntityPanelDeepLink(input: EntityPanelDeepLinkRequest): EntityPanelDeepLinkUpdate {
  const update: EntityPanelDeepLinkUpdate = {};
  const rawHashRoute = String(input.hashRoute || '').trim().toLowerCase();
  // `pay/<invoice>` is the canonical invoice route. The payload remains owned
  // by PaymentPanel; this router selects only the Account send workspace.
  const hashRoute = rawHashRoute.startsWith('pay/')
    ? 'accounts/send'
    : canonicalizeEntityPanelRoute(rawHashRoute);
  const view = String(hashRoute || '').trim().toLowerCase();
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
    case 'company':
      update.activeTab = 'company';
      break;
    case 'settings':
      update.activeTab = 'settings';
      update.settingsSubview = 'wallet';
      break;
    case 'settings/recovery':
      update.activeTab = 'settings';
      update.settingsSubview = 'recovery';
      break;
    case 'settings/consensus':
      update.activeTab = 'settings';
      update.settingsSubview = 'consensus';
      break;
    case 'settings/display':
      update.activeTab = 'settings';
      update.settingsSubview = 'display';
      break;
    case 'settings/stack-manager':
      update.activeTab = 'settings';
      update.settingsSubview = 'stack-manager';
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

  if (jurisdiction) {
    const matched = input.availableJurisdictionNames?.find((candidate) =>
      String(candidate || '').trim().toLowerCase() === jurisdiction.toLowerCase(),
    );
    update.selectedJurisdictionName = matched ? String(matched) : jurisdiction;
  }
  return update;
}

export function resolveEntityPanelDeepLinkFromLocation(
  location: RouteLocation,
  availableJurisdictionNames: readonly (string | null | undefined)[] = [],
): EntityPanelDeepLinkUpdate {
  const hashRoute = getLocationHashRoute(location);
  return resolveEntityPanelDeepLink({
    hashRoute,
    jurisdiction: getLocationParamValue(location, ['jurisdiction']),
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
  if (state.activeTab === 'company') return 'company';
  if (state.accountWorkspaceTab === 'open') return 'accounts';
  return `accounts/${state.accountWorkspaceTab}`;
}
