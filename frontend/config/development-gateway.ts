import {
  SURFACES,
  isEdgeRoute,
  matchesRoute,
  resolveRouteOwner,
  type RouteOwner,
  type SurfaceId,
} from './surfaces';

export const DEVELOPMENT_GATEWAY_PORT = 8080;
export const DEVELOPMENT_EDGE_PORT = 8082;
export const DEVELOPMENT_APP_PREFIX = '/__app' as const;

export const parseDevelopmentGatewayPort = (raw: string | undefined): number => {
  if (raw === undefined) return DEVELOPMENT_GATEWAY_PORT;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`DEVELOPMENT_GATEWAY_PORT_INVALID:${raw}`);
  }
  return port;
};

export type GatewayProxyOwner = RouteOwner;

type GatewayProxyDecision = Readonly<{
  kind: 'proxy';
  owner: GatewayProxyOwner;
  rewrite: 'none' | 'app-base';
}>;

type GatewayRedirectDecision = Readonly<{
  kind: 'redirect';
  status: 307 | 308;
  location: `/${string}`;
}>;

type GatewayResponseDecision = Readonly<{
  kind: 'response';
  status: 200 | 400;
  body: string;
  headers: Readonly<Record<string, string>>;
}>;

export type DevelopmentGatewayDecision =
  | GatewayProxyDecision
  | GatewayRedirectDecision
  | GatewayResponseDecision;

const parseIncomingUrl = (rawUrl: string): URL => {
  if (!rawUrl.startsWith('/') || rawUrl.includes('#')) throw new Error('DEVELOPMENT_GATEWAY_URL_INVALID');
  return new URL(rawUrl, 'http://xln.local');
};

const findSurfaceByHmrPath = (pathname: string): SurfaceId | undefined =>
  SURFACES.find(({ hmrPath }) => pathname === hmrPath || pathname.startsWith(`${hmrPath}/`))?.id;

const findSurfaceByAppPrefix = (pathname: string): SurfaceId | undefined =>
  SURFACES.find(({ id }) => {
    const prefix = `${DEVELOPMENT_APP_PREFIX}/${id}`;
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  })?.id;

const findSurfaceByAsset = (pathname: string): SurfaceId | undefined =>
  SURFACES.find(({ assetDirectory, assetRoutes }) =>
    pathname === `/${assetDirectory}` ||
    pathname.startsWith(`/${assetDirectory}/`) ||
    assetRoutes.some((rule) => matchesRoute(pathname, rule)))?.id;

export const resolveDevelopmentGatewayRequest = (rawUrl: string): DevelopmentGatewayDecision => {
  const url = parseIncomingUrl(rawUrl);
  if (url.pathname === '/admin') return { kind: 'redirect', status: 308, location: '/health' };
  if (url.pathname === '/radapter') {
    if (url.search === '') return { kind: 'redirect', status: 307, location: '/app' };
    return {
      kind: 'response',
      status: 400,
      body: 'REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    };
  }
  if (url.pathname === '/resetdb') {
    return {
      kind: 'response',
      status: 200,
      body: 'Resetting local data',
      headers: {
        'cache-control': 'no-store, max-age=0',
        'clear-site-data': '"*"',
        refresh: '0;url=/app',
        'content-type': 'text/plain; charset=utf-8',
      },
    };
  }

  const hmrOwner = findSurfaceByHmrPath(url.pathname);
  if (hmrOwner !== undefined) return { kind: 'proxy', owner: hmrOwner, rewrite: 'none' };
  const appPrefixOwner = findSurfaceByAppPrefix(url.pathname);
  if (appPrefixOwner !== undefined) return { kind: 'proxy', owner: appPrefixOwner, rewrite: 'none' };

  if (isEdgeRoute(url.pathname)) return { kind: 'proxy', owner: 'edge', rewrite: 'none' };
  const assetOwner = findSurfaceByAsset(url.pathname);
  if (assetOwner !== undefined) return { kind: 'proxy', owner: assetOwner, rewrite: 'app-base' };
  const routeOwner = resolveRouteOwner(url.pathname);
  return routeOwner === 'edge'
    ? { kind: 'proxy', owner: 'edge', rewrite: 'none' }
    : { kind: 'proxy', owner: routeOwner, rewrite: 'app-base' };
};

export const rewriteDevelopmentGatewayUrl = (
  rawUrl: string,
  decision: GatewayProxyDecision,
): string => {
  if (decision.rewrite === 'none' || decision.owner === 'edge') return rawUrl;
  const url = parseIncomingUrl(rawUrl);
  return `${DEVELOPMENT_APP_PREFIX}/${decision.owner}${url.pathname}${url.search}`;
};

export const createDevelopmentGatewayTargets = (
  edgeTarget = `http://127.0.0.1:${DEVELOPMENT_EDGE_PORT}`,
): Readonly<Record<GatewayProxyOwner, string>> => ({
  edge: edgeTarget,
  site: `http://127.0.0.1:${SURFACES[0].developmentPort}`,
  docs: `http://127.0.0.1:${SURFACES[1].developmentPort}`,
  wallet: `http://127.0.0.1:${SURFACES[2].developmentPort}`,
  ops: `http://127.0.0.1:${SURFACES[3].developmentPort}`,
});
