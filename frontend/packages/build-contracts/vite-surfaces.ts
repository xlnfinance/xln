import { resolve } from 'node:path';

import {
  FRONTEND_ROUTES,
  type FrontendRoute,
} from '../../src/lib/contracts/frontendSurfaces';

export const REACT_FRONTEND_SURFACES = ['all', 'site', 'docs', 'wallet'] as const;
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

const appRoutes = (surface: Exclude<ReactFrontendSurface, 'all'>): readonly FrontendRoute[] => FRONTEND_ROUTES.filter(route => (
  route.surface === surface && route.kind === 'page' && route.outputEntry !== null
));

const appInputs = (
  frontendRoot: string,
  surface: Exclude<ReactFrontendSurface, 'all'>,
): Readonly<Record<string, string>> => Object.fromEntries(
  appRoutes(surface).map(route => [route.id, resolve(frontendRoot, 'apps', surface, 'entries', route.outputEntry!)]),
);

export const createReactViteSurfaceContract = (
  frontendRoot: string,
  surface: ReactFrontendSurface,
): ReactViteSurfaceContract => {
  const selected = surface === 'all' ? ['site', 'docs', 'wallet'] as const : [surface];
  const routes = selected.flatMap(appRoutes);
  const inputs = Object.assign({}, ...selected.map(selectedSurface => appInputs(frontendRoot, selectedSurface)));
  return {
    surface,
    root: surface === 'all' ? frontendRoot : resolve(frontendRoot, 'apps', surface, 'entries'),
    outDir: resolve(frontendRoot, 'build', surface === 'all' ? 'react-all' : surface),
    inputs,
    routes,
  };
};
