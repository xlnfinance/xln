import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  FRONTEND_ROUTES,
  type FrontendRoute,
} from '../../frontend/src/lib/contracts/frontendSurfaces';
import {
  REACT_CANDIDATE_MANIFEST_FILE,
  validateReactCandidateManifest,
} from '../../frontend/packages/build-contracts/react-candidate';
import { buildFrontendReleaseAssets } from './frontend-release-files';
import {
  FRONTEND_BUILD_IDENTITY_FILE,
  FRONTEND_SURFACE_IDS,
  type FrontendReleaseSurfaceId,
} from './frontend-release-schema';

type SurfaceDestination = Readonly<{
  surface: FrontendReleaseSurfaceId;
  path: string;
}>;

const pageSource = (route: FrontendRoute): string => {
  if (route.pattern === '/') return 'index.html';
  const firstSegment = route.pattern.split('/').filter(Boolean)[0];
  if (!firstSegment) throw new Error(`FRONTEND_SURFACE_PAGE_SOURCE_INVALID:${route.id}`);
  return `${firstSegment}.html`;
};

const routeDestinations = (): Map<string, SurfaceDestination[]> => {
  const destinations = new Map<string, SurfaceDestination[]>();
  const add = (source: string, destination: SurfaceDestination): void => {
    const current = destinations.get(source) ?? [];
    if (!current.some(item => item.surface === destination.surface && item.path === destination.path)) {
      destinations.set(source, [...current, destination]);
    }
  };
  FRONTEND_ROUTES.forEach(route => {
    if (route.surface === 'edge' || !route.outputEntry || route.pattern.endsWith('/**')) return;
    const source = route.kind === 'page' ? pageSource(route) : route.pattern.slice(1);
    add(source, { surface: route.surface, path: route.outputEntry });
  });
  return destinations;
};

const allSurfaces = (path: string): SurfaceDestination[] =>
  FRONTEND_SURFACE_IDS.map(surface => ({ surface, path }));

const selectedSurfaces = (path: string, surfaces: readonly FrontendReleaseSurfaceId[]): SurfaceDestination[] =>
  surfaces.map(surface => ({ surface, path }));

export const assertNoBlockedReactCandidateBuild = (buildRoot: string): void => {
  const manifestPath = join(buildRoot, 'site', REACT_CANDIDATE_MANIFEST_FILE);
  if (!existsSync(manifestPath)) return;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`FRONTEND_REACT_CANDIDATE_MANIFEST_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
  const errors = validateReactCandidateManifest(manifest, currentFrontendEntrypoints().site);
  if (errors.length > 0) throw new Error(`FRONTEND_REACT_CANDIDATE_MANIFEST_INVALID:${errors.join(',')}`);
  throw new Error('FRONTEND_REACT_CANDIDATE_ACTIVATION_BLOCKED:site');
};

const extraAssetDestinations = (path: string): SurfaceDestination[] | null => {
  if (path.startsWith('_app/')) return allSurfaces(path);
  if (path.startsWith('docs-catalog/')) return selectedSurfaces(path, ['docs']);
  if (path.startsWith('docs-static/') || path.startsWith('llms_') || path.startsWith('XLN_')) {
    return selectedSurfaces(path, ['docs']);
  }
  if (path.startsWith('contracts/') || path.startsWith('sounds/') || path.startsWith('hash-wasm-')) {
    return selectedSurfaces(path, ['wallet']);
  }
  if (path.startsWith('img/') || path.startsWith('bikes/')) return selectedSurfaces(path, ['site', 'wallet']);
  if (path.startsWith('news/')) return selectedSurfaces(path, ['site']);
  if (/^(?:favicon(?:-\d+x\d+)?\.png|favicon\.ico|apple-touch-icon\.png|android-chrome-\d+x\d+\.png)$/.test(path)) {
    return selectedSurfaces(path, ['site', 'wallet']);
  }
  if (path === 'install.sh') return selectedSurfaces(path, ['site']);
  if (path === 'comparative-results.json') return selectedSurfaces(path, ['ops']);
  if (path === 'radapter.html') return [];
  return null;
};

const copyDestination = (
  buildRoot: string,
  outputRoot: string,
  sourcePath: string,
  destination: SurfaceDestination,
): void => {
  const target = join(outputRoot, destination.surface, destination.path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(buildRoot, sourcePath), target);
};

export const currentFrontendEntrypoints = (): Readonly<Record<FrontendReleaseSurfaceId, readonly string[]>> => {
  const entries = Object.fromEntries(FRONTEND_SURFACE_IDS.map(surface => [surface, new Set<string>()])) as
    Record<FrontendReleaseSurfaceId, Set<string>>;
  FRONTEND_ROUTES.forEach(route => {
    if (route.surface !== 'edge' && route.kind === 'page' && route.outputEntry) {
      entries[route.surface].add(route.outputEntry);
    }
  });
  const result: Record<FrontendReleaseSurfaceId, readonly string[]> = {
    site: [],
    docs: [],
    wallet: [],
    ops: [],
  };
  FRONTEND_SURFACE_IDS.forEach(surface => {
    result[surface] = [...entries[surface]].sort((left, right) => left.localeCompare(right));
  });
  return result;
};

export const assembleCurrentFrontendSurfaces = (
  buildRoot: string,
  outputRoot: string,
): Readonly<Record<FrontendReleaseSurfaceId, string>> => {
  if (!existsSync(buildRoot)) throw new Error(`FRONTEND_UNIFIED_BUILD_MISSING:${buildRoot}`);
  assertNoBlockedReactCandidateBuild(buildRoot);
  if (existsSync(outputRoot) && readdirSync(outputRoot).length > 0) {
    throw new Error(`FRONTEND_SURFACE_OUTPUT_NOT_EMPTY:${outputRoot}`);
  }
  FRONTEND_SURFACE_IDS.forEach(surface => mkdirSync(join(outputRoot, surface), { recursive: true }));
  const routeFiles = routeDestinations();
  for (const asset of buildFrontendReleaseAssets(buildRoot)) {
    if (asset.path === FRONTEND_BUILD_IDENTITY_FILE) {
      throw new Error(`FRONTEND_UNIFIED_BUILD_RESERVED_ASSET:${asset.path}`);
    }
    const destinations = routeFiles.get(asset.path) ?? extraAssetDestinations(asset.path);
    if (destinations === null) throw new Error(`FRONTEND_UNIFIED_BUILD_ASSET_UNOWNED:${asset.path}`);
    destinations.forEach(destination => copyDestination(buildRoot, outputRoot, asset.path, destination));
  }
  routeFiles.forEach((_destinations, source) => {
    if (!existsSync(join(buildRoot, source))) throw new Error(`FRONTEND_UNIFIED_BUILD_ROUTE_MISSING:${source}`);
  });
  return Object.fromEntries(FRONTEND_SURFACE_IDS.map(surface => [surface, join(outputRoot, surface)])) as
    Record<FrontendReleaseSurfaceId, string>;
};
