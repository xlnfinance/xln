import { resolve } from 'node:path';

import {
  FRONTEND_ROUTES,
  type FrontendRoute,
} from '../../src/lib/contracts/frontendSurfaces';

export const REACT_FRONTEND_SURFACES = ['all', 'site'] as const;
export type ReactFrontendSurface = typeof REACT_FRONTEND_SURFACES[number];

export type ReactViteSurfaceContract = Readonly<{
  surface: ReactFrontendSurface;
  root: string;
  outDir: string;
  inputs: Readonly<Record<string, string>>;
  routes: readonly FrontendRoute[];
}>;

export const resolveReactFrontendSurface = (value: string | undefined): ReactFrontendSurface => {
  const normalized = value?.trim() || 'all';
  if (REACT_FRONTEND_SURFACES.some(surface => surface === normalized)) {
    return normalized as ReactFrontendSurface;
  }
  throw new Error(`REACT_FRONTEND_SURFACE_UNKNOWN:${normalized}`);
};

const siteRoutes = (): readonly FrontendRoute[] => FRONTEND_ROUTES.filter(route => (
  route.surface === 'site' && route.kind === 'page' && route.outputEntry !== null
));

const siteInputs = (entryRoot: string): Readonly<Record<string, string>> => Object.fromEntries(
  siteRoutes().map(route => [route.id, resolve(entryRoot, route.outputEntry!)]),
);

export const createReactViteSurfaceContract = (
  frontendRoot: string,
  surface: ReactFrontendSurface,
): ReactViteSurfaceContract => {
  const entryRoot = resolve(frontendRoot, 'apps/site/entries');
  const site = siteRoutes();
  return {
    surface,
    root: surface === 'site' ? entryRoot : frontendRoot,
    outDir: resolve(frontendRoot, 'build', surface === 'site' ? 'site' : 'react-all'),
    inputs: siteInputs(entryRoot),
    routes: site,
  };
};
