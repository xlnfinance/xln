import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildFrontendRelease } from '../../scripts/deployment/frontend-release-builder';
import {
  FRONTEND_RELEASE_MANIFEST_FILE,
  type FrontendReleaseManifest,
  type FrontendReleaseSurfaceId,
} from '../../scripts/deployment/frontend-release-schema';

export const FIXTURE_NATIVE_ASSETS = [
  '_app/version.json',
  'brainvault-worker.js',
  'index.html',
  'push-wake-sw.js',
  'runtime.js',
  'site.webmanifest',
] as const;

export const FIXTURE_ENTRYPOINTS: Readonly<Record<FrontendReleaseSurfaceId, readonly string[]>> = {
  site: ['index.html'],
  docs: ['index.html', 'docs-catalog/index.html'],
  wallet: ['index.html', 'address/index.html', 'testnet/index.html'],
  ops: ['health/index.html', 'qa/index.html'],
};

const writeFixtureFile = (root: string, path: string, content: string): void => {
  const destination = join(root, path);
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(destination, content);
};

const createSurfaceSources = (root: string, marker: string): Record<FrontendReleaseSurfaceId, string> => {
  const sources = {} as Record<FrontendReleaseSurfaceId, string>;
  (Object.keys(FIXTURE_ENTRYPOINTS) as FrontendReleaseSurfaceId[]).forEach(surface => {
    const surfaceRoot = join(root, surface);
    mkdirSync(surfaceRoot, { recursive: true });
    FIXTURE_ENTRYPOINTS[surface].forEach(path => writeFixtureFile(surfaceRoot, path, `${surface}:${path}:${marker}\n`));
    writeFixtureFile(surfaceRoot, '_app/version.json', `${marker}\n`);
    sources[surface] = surfaceRoot;
  });
  FIXTURE_NATIVE_ASSETS.forEach(path => {
    if (!FIXTURE_ENTRYPOINTS.wallet.includes(path)) writeFixtureFile(sources.wallet, path, `wallet:${path}:${marker}\n`);
  });
  return sources;
};

export const buildFixtureRelease = (
  frontendRoot: string,
  marker: string,
  sourceCommit: string,
  productVersion: string,
): { manifest: FrontendReleaseManifest; releaseRoot: string } => {
  const releaseId = `${productVersion}-${sourceCommit.slice(0, 12)}`;
  const releaseRoot = join(frontendRoot, 'releases', releaseId);
  const sources = createSurfaceSources(join(frontendRoot, 'fixture-sources', marker), marker);
  const manifest = buildFrontendRelease({
    releaseRoot,
    sourceCommit,
    productVersion,
    routeContract: '{"version":1}\n',
    surfaceSources: sources,
    entrypoints: FIXTURE_ENTRYPOINTS,
    nativeRequiredAssets: FIXTURE_NATIVE_ASSETS,
  });
  return { manifest, releaseRoot };
};

export const readFixtureManifestText = (releaseRoot: string): string =>
  readFileSync(join(releaseRoot, FRONTEND_RELEASE_MANIFEST_FILE), 'utf8');
