export type FrontendSurfaceId = 'site' | 'docs' | 'wallet' | 'ops' | 'edge';

export type FrontendSurface = Readonly<{
  id: FrontendSurfaceId;
  outputRoot: string | null;
  native: boolean;
  pwa: boolean;
}>;

export type FrontendRouteKind = 'page' | 'redirect' | 'server' | 'resource';
export type FrontendFallbackPolicy = 'surface-entry' | 'edge-handler' | 'static-resource';

export type FrontendRoute = Readonly<{
  id: string;
  pattern: string;
  surface: FrontendSurfaceId;
  kind: FrontendRouteKind;
  outputEntry: string | null;
  fallback: FrontendFallbackPolicy;
  native: boolean;
  pwa: boolean;
}>;

export const FRONTEND_SURFACES: readonly FrontendSurface[] = Object.freeze([
  Object.freeze({ id: 'site', outputRoot: 'site', native: false, pwa: false }),
  Object.freeze({ id: 'docs', outputRoot: 'docs', native: false, pwa: false }),
  Object.freeze({ id: 'wallet', outputRoot: 'wallet', native: true, pwa: true }),
  Object.freeze({ id: 'ops', outputRoot: 'ops', native: false, pwa: false }),
  Object.freeze({ id: 'edge', outputRoot: null, native: false, pwa: false }),
]);

const page = (
  id: string,
  pattern: string,
  surface: Exclude<FrontendSurfaceId, 'edge'>,
  outputEntry: string,
  options: Readonly<{ native?: boolean; pwa?: boolean }> = {},
): FrontendRoute => Object.freeze({
  id,
  pattern,
  surface,
  kind: 'page',
  outputEntry,
  fallback: 'surface-entry',
  native: options.native ?? false,
  pwa: options.pwa ?? false,
});

const edge = (id: string, pattern: string, kind: 'redirect' | 'server'): FrontendRoute => Object.freeze({
  id,
  pattern,
  surface: 'edge',
  kind,
  outputEntry: null,
  fallback: 'edge-handler',
  native: false,
  pwa: false,
});

const resource = (
  id: string,
  pattern: string,
  surface: Exclude<FrontendSurfaceId, 'edge'>,
  outputEntry: string,
  options: Readonly<{ native?: boolean; pwa?: boolean }> = {},
): FrontendRoute => Object.freeze({
  id,
  pattern,
  surface,
  kind: 'resource',
  outputEntry,
  fallback: 'static-resource',
  native: options.native ?? false,
  pwa: options.pwa ?? false,
});

export const FRONTEND_ROUTES: readonly FrontendRoute[] = Object.freeze([
  page('site-home', '/', 'site', 'index.html'),
  page('site-install', '/install', 'site', 'install/index.html'),
  page('site-rcpan', '/rcpan', 'site', 'rcpan/index.html'),
  page('site-releases', '/releases', 'site', 'releases/index.html'),
  page('site-reviews', '/reviews', 'site', 'reviews/index.html'),
  page('site-unicast', '/unicast', 'site', 'unicast/index.html'),
  resource('site-superprompt', '/superprompt.txt', 'site', 'superprompt.txt'),

  page('docs-reader', '/docs', 'docs', 'index.html'),
  resource('docs-catalog', '/docs-catalog/**', 'docs', 'docs-catalog/**'),
  resource('docs-llms-context', '/llms.txt', 'docs', 'llms.txt'),

  page('wallet-app', '/app', 'wallet', 'index.html', { native: true, pwa: true }),
  page('wallet-address-index', '/address', 'wallet', 'address/index.html', { native: true, pwa: true }),
  page('wallet-address-detail', '/address/:entityId', 'wallet', 'address/index.html', { native: true, pwa: true }),
  page('wallet-testnet', '/testnet', 'wallet', 'testnet/index.html', { native: true, pwa: true }),
  resource('wallet-runtime-bundle', '/runtime.js', 'wallet', 'runtime.js', { native: true, pwa: true }),
  resource('wallet-brainvault-worker', '/brainvault-worker.js', 'wallet', 'brainvault-worker.js', { native: true, pwa: true }),
  resource('wallet-manifest', '/site.webmanifest', 'wallet', 'site.webmanifest', { pwa: true }),
  resource('wallet-push-worker', '/push-wake-sw.js', 'wallet', 'push-wake-sw.js', { pwa: true }),

  page('ops-health', '/health', 'ops', 'health/index.html'),
  page('ops-qa', '/qa', 'ops', 'qa/index.html'),
  page('ops-runs', '/runs', 'ops', 'runs/index.html'),
  page('ops-scenarios', '/scenarios', 'ops', 'scenarios/index.html'),
  page('ops-ai', '/ai/:chatId?', 'ops', 'ai/index.html'),
  page('ops-embed', '/embed', 'ops', 'embed/index.html'),

  edge('edge-admin-redirect', '/admin', 'redirect'),
  edge('edge-radapter-redirect', '/radapter', 'redirect'),
  edge('edge-reset-database', '/resetdb', 'server'),
  edge('edge-runtime-rpc', '/rpc', 'server'),
  edge('edge-runtime-rpc-secondary', '/rpc2', 'server'),
]);

const duplicates = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const duplicateValues = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value);
    seen.add(value);
  }
  return [...duplicateValues].sort();
};

export const validateFrontendSurfaceContract = (
  surfaces: readonly FrontendSurface[] = FRONTEND_SURFACES,
  routes: readonly FrontendRoute[] = FRONTEND_ROUTES,
): readonly string[] => {
  const errors: string[] = [];
  const surfaceIds = new Set(surfaces.map(surface => surface.id));

  for (const id of duplicates(surfaces.map(surface => surface.id))) errors.push(`DUPLICATE_SURFACE_ID:${id}`);
  for (const id of duplicates(routes.map(route => route.id))) errors.push(`DUPLICATE_ROUTE_ID:${id}`);
  for (const pattern of duplicates(routes.map(route => route.pattern))) errors.push(`DUPLICATE_ROUTE_PATTERN:${pattern}`);

  for (const route of routes) {
    if (!route.pattern.startsWith('/')) errors.push(`ROUTE_PATTERN_NOT_ABSOLUTE:${route.id}`);
    if (!surfaceIds.has(route.surface)) errors.push(`ROUTE_SURFACE_UNKNOWN:${route.id}:${route.surface}`);
    if (route.surface === 'edge' && route.outputEntry !== null) errors.push(`EDGE_ROUTE_HAS_OUTPUT:${route.id}`);
    if (route.surface !== 'edge' && route.outputEntry === null) errors.push(`SURFACE_ROUTE_MISSING_OUTPUT:${route.id}`);
    if (route.native && route.surface !== 'wallet') errors.push(`NATIVE_ROUTE_NOT_WALLET:${route.id}`);
    if (route.pwa && route.surface !== 'wallet') errors.push(`PWA_ROUTE_NOT_WALLET:${route.id}`);
  }

  return errors.sort();
};

const matchesRoutePattern = (pattern: string, pathname: string): boolean => {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  }

  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);
  const optionalTail = patternSegments.at(-1)?.startsWith(':')
    && patternSegments.at(-1)?.endsWith('?');
  const minimumSegments = optionalTail ? patternSegments.length - 1 : patternSegments.length;
  if (pathSegments.length < minimumSegments || pathSegments.length > patternSegments.length) return false;

  return patternSegments.every((segment, index) => {
    if (segment.startsWith(':')) return segment.endsWith('?') || pathSegments[index] !== undefined;
    return segment === pathSegments[index];
  });
};

export const findFrontendRoute = (
  pathname: string,
  routes: readonly FrontendRoute[] = FRONTEND_ROUTES,
): FrontendRoute | undefined => {
  const normalized = pathname === '/' ? '/' : `/${pathname.split('/').filter(Boolean).join('/')}`;
  return routes.find(route => matchesRoutePattern(route.pattern, normalized));
};
