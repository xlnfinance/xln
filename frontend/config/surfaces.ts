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

export type RouteRule = ExactRoute | PrefixRoute;

export type SurfaceDefinition = Readonly<{
  id: SurfaceId;
  developmentPort: number;
  hmrPath: `/__hmr/${SurfaceId}`;
  artifactDirectory: `.artifacts/${SurfaceId}`;
  assetDirectory: `assets/${SurfaceId}`;
  routes: readonly RouteRule[];
  fixedAssets: readonly `/${string}`[];
}>;

const exact = (pathname: `/${string}`): ExactRoute => ({ kind: 'exact', pathname });
const prefix = (pathname: `/${string}`): PrefixRoute => ({ kind: 'prefix', pathname });

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
    fixedAssets: ['/install.sh'],
  },
  {
    id: 'docs',
    developmentPort: 8083,
    hmrPath: '/__hmr/docs',
    artifactDirectory: '.artifacts/docs',
    assetDirectory: 'assets/docs',
    routes: [exact('/docs')],
    fixedAssets: ['/docs-catalog', '/llms.txt', '/llms-full.txt'],
  },
  {
    id: 'wallet',
    developmentPort: 8084,
    hmrPath: '/__hmr/wallet',
    artifactDirectory: '.artifacts/wallet',
    assetDirectory: 'assets/wallet',
    routes: [exact('/app'), prefix('/address'), exact('/testnet')],
    fixedAssets: [
      '/contracts',
      '/brainvault-worker.js',
      '/hash-wasm-argon2.js',
      '/hash-wasm-blake3.js',
      '/push-wake-sw.js',
      '/route-mode.js',
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
    fixedAssets: ['/scenarios', '/comparative-results.json'],
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

const matchesRoute = (pathname: string, rule: RouteRule): boolean =>
  rule.kind === 'exact'
    ? pathname === rule.pathname
    : pathname === rule.pathname || pathname.startsWith(`${rule.pathname}/`);

export const resolveRouteOwner = (rawPathname: string): RouteOwner => {
  const pathname = canonicalizePathname(rawPathname);
  for (const surface of SURFACES) {
    if (surface.routes.some((rule) => matchesRoute(pathname, rule))) return surface.id;
  }
  if (EDGE_ROUTES.some((rule) => matchesRoute(pathname, rule))) return 'edge';
  return 'edge';
};

export const getSurface = (surfaceId: SurfaceId): SurfaceDefinition => {
  const surface = SURFACES.find(({ id }) => id === surfaceId);
  if (!surface) throw new Error(`FRONTEND_SURFACE_UNKNOWN:${surfaceId}`);
  return surface;
};
