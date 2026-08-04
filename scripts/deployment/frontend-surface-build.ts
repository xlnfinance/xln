import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { FRONTEND_ROUTES } from '../../frontend/src/lib/contracts/frontendSurfaces';
import {
  FRONTEND_BUILD_IDENTITY_FILE,
  FRONTEND_SURFACE_IDS,
  type FrontendReleaseSurfaceId,
} from './frontend-release-schema';

export const frontendSurfaceEntrypoints = (): Readonly<Record<FrontendReleaseSurfaceId, readonly string[]>> => {
  const entries = Object.fromEntries(FRONTEND_SURFACE_IDS.map(surface => [surface, new Set<string>()])) as
    Record<FrontendReleaseSurfaceId, Set<string>>;
  for (const route of FRONTEND_ROUTES) {
    if (route.surface !== 'edge' && route.kind === 'page' && route.outputEntry) {
      entries[route.surface].add(route.outputEntry);
    }
  }
  return Object.fromEntries(FRONTEND_SURFACE_IDS.map(surface => [
    surface,
    [...entries[surface]].sort((left, right) => left.localeCompare(right)),
  ])) as Record<FrontendReleaseSurfaceId, readonly string[]>;
};

const exactBuildRoots = (buildRoot: string): void => {
  if (!existsSync(buildRoot) || !lstatSync(buildRoot).isDirectory()) {
    throw new Error(`FRONTEND_SURFACE_BUILD_MISSING:${buildRoot}`);
  }
  const actual = readdirSync(buildRoot, { withFileTypes: true })
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const expected = [...FRONTEND_SURFACE_IDS].sort((left, right) => left.localeCompare(right));
  if (actual.join('\n') !== expected.join('\n')) {
    throw new Error(`FRONTEND_SURFACE_BUILD_ROOTS_INVALID:${actual.join(',')}`);
  }
};

export const resolveFrontendSurfaceSources = (
  buildRoot: string,
): Readonly<Record<FrontendReleaseSurfaceId, string>> => {
  exactBuildRoots(buildRoot);
  const entrypoints = frontendSurfaceEntrypoints();
  const sources = {} as Record<FrontendReleaseSurfaceId, string>;
  for (const surface of FRONTEND_SURFACE_IDS) {
    const root = join(buildRoot, surface);
    if (!lstatSync(root).isDirectory()) throw new Error(`FRONTEND_SURFACE_NOT_DIRECTORY:${surface}`);
    if (existsSync(join(root, FRONTEND_BUILD_IDENTITY_FILE))) {
      throw new Error(`FRONTEND_SURFACE_RESERVED_ASSET:${surface}:${FRONTEND_BUILD_IDENTITY_FILE}`);
    }
    for (const entrypoint of entrypoints[surface]) {
      const path = join(root, entrypoint);
      if (!existsSync(path) || !lstatSync(path).isFile()) {
        throw new Error(`FRONTEND_SURFACE_ENTRYPOINT_MISSING:${surface}:${entrypoint}`);
      }
    }
    sources[surface] = root;
  }
  return sources;
};
