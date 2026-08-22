export const SURFACE_IDS = ['site', 'docs', 'wallet', 'ops'] as const;

export type SurfaceId = (typeof SURFACE_IDS)[number];
export type RouteOwner = SurfaceId | 'edge';

type ExactRoute = Readonly<{
  kind: 'exact';
  pathname: `/${string}`;
}>;

type PrefixRoute = Readonly<{
  kind: 'prefix';
  pathname: `/${string}`;
}>;

type StemRoute = Readonly<{
  kind: 'stem';
  pathname: `/${string}`;
}>;

export type RouteRule = ExactRoute | PrefixRoute | StemRoute;

export type SurfaceDefinition = Readonly<{
  id: SurfaceId;
  developmentPort: number;
  hmrPath: `/__hmr/${SurfaceId}`;
  artifactDirectory: `.artifacts/${SurfaceId}`;
  assetDirectory: `assets/${SurfaceId}`;
  routes: readonly RouteRule[];
  assetRoutes: readonly RouteRule[];
}>;

const exact = (pathname: `/${string}`): ExactRoute => ({ kind: 'exact', pathname });
const prefix = (pathname: `/${string}`): PrefixRoute => ({ kind: 'prefix', pathname });
const stem = (pathname: `/${string}`): StemRoute => ({ kind: 'stem', pathname });

export const SURFACES = [
  {
    id: 'site',
    developmentPort: 8081,
    hmrPath: '/__hmr/site',
    artifactDirectory: '.artifacts/site',
    assetDirectory: 'assets/site',
    routes: [
      exact('/'),
      exact('/install'),
      exact('/rcpan'),
      exact('/releases'),
      exact('/reviews'),
      exact('/unicast'),
      exact('/market-cap'),
    ],
    assetRoutes: [exact('/install.sh')],
  },
  {
    id: 'docs',
    developmentPort: 8083,
    hmrPath: '/__hmr/docs',
    artifactDirectory: '.artifacts/docs',
    assetDirectory: 'assets/docs',
    routes: [exact('/docs')],
    assetRoutes: [prefix('/docs-catalog'), stem('/llms')],
  },
  {
    id: 'wallet',
    developmentPort: 8084,
    hmrPath: '/__hmr/wallet',
    artifactDirectory: '.artifacts/wallet',
    assetDirectory: 'assets/wallet',
    routes: [exact('/app'), prefix('/address'), exact('/testnet')],
    assetRoutes: [
      prefix('/contracts'),
      exact('/brainvault-worker.js'),
      stem('/hash-wasm-'),
      exact('/push-wake-sw.js'),
      exact('/route-mode.js'),
    ],
  },
  {
    id: 'ops',
    developmentPort: 8085,
    hmrPath: '/__hmr/ops',
    artifactDirectory: '.artifacts/ops',
    assetDirectory: 'assets/ops',
    routes: [
      exact('/health'),
      exact('/qa'),
      exact('/qa/hlt'),
      exact('/runs'),
      exact('/scenarios'),
      prefix('/ai'),
      exact('/embed'),
    ],
    assetRoutes: [prefix('/scenarios'), exact('/comparative-results.json')],
  },
] as const satisfies readonly SurfaceDefinition[];

export const EDGE_ROUTES = [
  exact('/admin'),
  exact('/radapter'),
  exact('/resetdb'),
  prefix('/api'),
  exact('/rpc'),
  exact('/rpc2'),
  exact('/rpc3'),
  exact('/rpc4'),
  exact('/rpc5'),
  exact('/rpc6'),
  exact('/rpc7'),
  exact('/rpc8'),
  prefix('/relay'),
  exact('/runtime.js'),
] as const satisfies readonly RouteRule[];

const canonicalizePathname = (pathname: string): string => {
  if (!pathname.startsWith('/') || pathname.includes('?') || pathname.includes('#')) {
    throw new Error('SURFACE_PATHNAME_INVALID');
  }
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/, '');
};

export const matchesRoute = (pathname: string, rule: RouteRule): boolean => {
  if (rule.kind === 'exact') return pathname === rule.pathname;
  if (rule.kind === 'stem') return pathname.startsWith(rule.pathname);
  return pathname === rule.pathname || pathname.startsWith(`${rule.pathname}/`);
};

export const isEdgeRoute = (rawPathname: string): boolean => {
  const pathname = canonicalizePathname(rawPathname);
  return EDGE_ROUTES.some((rule) => matchesRoute(pathname, rule));
};

export const resolveRouteOwner = (rawPathname: string): RouteOwner => {
  const pathname = canonicalizePathname(rawPathname);
  if (isEdgeRoute(pathname)) return 'edge';
  for (const surface of SURFACES) {
    if (surface.routes.some((rule) => matchesRoute(pathname, rule))) return surface.id;
  }
  return 'edge';
};

export const getSurface = (surfaceId: SurfaceId): SurfaceDefinition => {
  const surface = SURFACES.find(({ id }) => id === surfaceId);
  if (!surface) throw new Error(`FRONTEND_SURFACE_UNKNOWN:${surfaceId}`);
  return surface;
};
