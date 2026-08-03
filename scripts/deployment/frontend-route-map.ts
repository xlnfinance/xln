import {
  FRONTEND_ROUTES,
  findFrontendRoute,
  type FrontendRoute,
  type FrontendSurfaceId,
} from '../../frontend/src/lib/contracts/frontendSurfaces';
import { isSafeReleasePath } from './frontend-release-schema';

export type FrontendReleaseRouteResolution =
  | Readonly<{ kind: 'surface'; surface: Exclude<FrontendSurfaceId, 'edge'>; outputEntry: string }>
  | Readonly<{ kind: 'redirect'; location: '/health' | '/app' }>
  | Readonly<{ kind: 'server'; endpoint: '/resetdb' | '/rpc' | '/rpc2' }>
  | Readonly<{ kind: 'not-found' }>;

const edgeResolution = (route: FrontendRoute): FrontendReleaseRouteResolution => {
  if (route.pattern === '/admin') return { kind: 'redirect', location: '/health' };
  if (route.pattern === '/radapter') return { kind: 'redirect', location: '/app' };
  if (route.pattern === '/resetdb' || route.pattern === '/rpc' || route.pattern === '/rpc2') {
    return { kind: 'server', endpoint: route.pattern };
  }
  throw new Error(`FRONTEND_EDGE_ROUTE_UNMAPPED:${route.id}`);
};

const wildcardOutput = (route: FrontendRoute, pathname: string): string | null => {
  if (!route.pattern.endsWith('/**') || !route.outputEntry?.endsWith('/**')) return route.outputEntry;
  const patternRoot = route.pattern.slice(0, -3);
  const outputRoot = route.outputEntry.slice(0, -3);
  const suffix = pathname.slice(patternRoot.length).replace(/^\//, '');
  return suffix.length > 0 ? `${outputRoot}/${suffix}` : `${outputRoot}/index.html`;
};

const isSafePathname = (pathname: string): boolean => {
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')) return false;
  const segments = pathname.split('/').filter(Boolean);
  return !segments.some(segment => segment === '.' || segment === '..');
};

export const resolveFrontendReleaseRoute = (pathname: string): FrontendReleaseRouteResolution => {
  if (!isSafePathname(pathname)) return { kind: 'not-found' };
  const route = findFrontendRoute(pathname);
  if (!route) return { kind: 'not-found' };
  if (route.surface === 'edge') return edgeResolution(route);
  const outputEntry = wildcardOutput(route, pathname);
  if (!outputEntry || !isSafeReleasePath(outputEntry)) {
    throw new Error(`FRONTEND_SURFACE_OUTPUT_INVALID:${route.id}`);
  }
  return { kind: 'surface', surface: route.surface, outputEntry };
};

export const frontendReleaseRouteMatrix = () => FRONTEND_ROUTES.map(route => ({
  id: route.id,
  pattern: route.pattern,
  resolution: route.pattern.endsWith('/**')
    ? resolveFrontendReleaseRoute(route.pattern.slice(0, -3))
    : resolveFrontendReleaseRoute(route.pattern.replace('/:entityId', '/entity').replace('/:chatId?', '')),
}));
