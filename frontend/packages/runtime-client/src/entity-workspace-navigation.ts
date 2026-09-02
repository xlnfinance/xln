export type ViewTab = 'assets' | 'accounts' | 'ownership' | 'settings';
export type SettingsSubview =
  | 'wallet'
  | 'consensus'
  | 'recovery'
  | 'display'
  | 'stack-manager'
  | 'network'
  | 'data'
  | 'log'
  | 'entity';
export type AccountWorkspaceTab =
  | 'send'
  | 'receive'
  | 'swap'
  | 'open'
  | 'activity'
  | 'move'
  | 'lending'
  | 'history'
  | 'configure'
  | 'appearance';
export type AssetWorkspaceTab = 'move' | 'history';
export type ConfigureWorkspaceTab =
  | 'extend-credit'
  | 'request-credit'
  | 'collateral'
  | 'token'
  | 'load-testing'
  | 'dispute';

export const ENTITY_WORKSPACE_SECTIONS = [
  { id: 'assets', label: 'Assets' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'ownership', label: 'Ownership' },
  { id: 'settings', label: 'Settings' },
] as const satisfies readonly Readonly<{ id: ViewTab; label: string }>[];

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

const CANONICAL_ROUTE_BY_INPUT: Readonly<Record<string, string>> = {
  assets: 'assets',
  'assets/move': 'assets',
  'assets/history': 'assets/history',
  accounts: 'accounts/open',
  'accounts/open': 'accounts/open',
  'accounts/send': 'accounts/send',
  'accounts/receive': 'accounts/receive',
  'accounts/swap': 'accounts/swap',
  'accounts/move': 'accounts/move',
  'accounts/lending': 'accounts/lending',
  'accounts/history': 'accounts/history',
  'accounts/configure': 'accounts/configure',
  'accounts/activity': 'accounts/activity',
  'accounts/appearance': 'accounts/appearance',
  ownership: 'ownership',
  settings: 'settings',
  'settings/wallet': 'settings',
  'settings/recovery': 'settings/recovery',
  'settings/consensus': 'settings/consensus',
  'settings/display': 'settings/display',
  'settings/stack-manager': 'settings/stack-manager',
  'settings/network': 'settings/network',
  'settings/data': 'settings/data',
  'settings/log': 'settings/log',
  'settings/entity': 'settings/entity',
};

const DEEP_LINK_UPDATE_BY_ROUTE: Readonly<Record<string, EntityPanelDeepLinkUpdate>> = {
  assets: { activeTab: 'assets', assetWorkspaceTab: 'move' },
  'assets/history': { activeTab: 'assets', assetWorkspaceTab: 'history' },
  'accounts/open': { activeTab: 'accounts', accountWorkspaceTab: 'open' },
  'accounts/send': { activeTab: 'accounts', accountWorkspaceTab: 'send' },
  'accounts/receive': { activeTab: 'accounts', accountWorkspaceTab: 'receive' },
  'accounts/swap': { activeTab: 'accounts', accountWorkspaceTab: 'swap' },
  'accounts/move': { activeTab: 'accounts', accountWorkspaceTab: 'move' },
  'accounts/lending': { activeTab: 'accounts', accountWorkspaceTab: 'lending' },
  'accounts/history': { activeTab: 'accounts', accountWorkspaceTab: 'history' },
  'accounts/configure': { activeTab: 'accounts', accountWorkspaceTab: 'configure' },
  'accounts/activity': { activeTab: 'accounts', accountWorkspaceTab: 'activity' },
  'accounts/appearance': { activeTab: 'accounts', accountWorkspaceTab: 'appearance' },
  ownership: { activeTab: 'ownership' },
  settings: { activeTab: 'settings', settingsSubview: 'wallet' },
  'settings/recovery': { activeTab: 'settings', settingsSubview: 'recovery' },
  'settings/consensus': { activeTab: 'settings', settingsSubview: 'consensus' },
  'settings/display': { activeTab: 'settings', settingsSubview: 'display' },
  'settings/stack-manager': { activeTab: 'settings', settingsSubview: 'stack-manager' },
  'settings/network': { activeTab: 'settings', settingsSubview: 'network' },
  'settings/data': { activeTab: 'settings', settingsSubview: 'data' },
  'settings/log': { activeTab: 'settings', settingsSubview: 'log' },
  'settings/entity': { activeTab: 'settings', settingsSubview: 'entity' },
};

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

export function getLocationParamValue(location: RouteLocation, keys: readonly string[]): string | null {
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
  if (!Object.hasOwn(CANONICAL_ROUTE_BY_INPUT, route)) return null;
  return CANONICAL_ROUTE_BY_INPUT[route] ?? null;
}

export function resolveEntityPanelDeepLink(input: EntityPanelDeepLinkRequest): EntityPanelDeepLinkUpdate {
  const rawHashRoute = String(input.hashRoute || '').trim().toLowerCase();
  // `pay/<invoice>` is the canonical invoice route. The payload remains owned
  // by PaymentPanel; this router selects only the Account send workspace.
  const hashRoute = rawHashRoute.startsWith('pay/')
    ? 'accounts/send'
    : canonicalizeEntityPanelRoute(rawHashRoute);
  const view = String(hashRoute || '').trim().toLowerCase();
  const jurisdiction = String(input.jurisdiction || '').trim();
  const update = { ...(DEEP_LINK_UPDATE_BY_ROUTE[view] ?? {}) };
  if (!jurisdiction) return update;
  const matched = input.availableJurisdictionNames?.find((candidate) =>
    String(candidate || '').trim().toLowerCase() === jurisdiction.toLowerCase(),
  );
  return { ...update, selectedJurisdictionName: matched ? String(matched) : jurisdiction };
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
  if (state.activeTab === 'ownership') return 'ownership';
  if (state.accountWorkspaceTab === 'open') return 'accounts';
  return `accounts/${state.accountWorkspaceTab}`;
}
