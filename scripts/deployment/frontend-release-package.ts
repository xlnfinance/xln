import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { serializeFrontendMigrationContractReport } from '../../frontend/src/lib/contracts/frontendMigrationContract';
import { assembleCurrentFrontendSurfaces, currentFrontendEntrypoints } from './current-frontend-surface-build';
import { buildFrontendRelease } from './frontend-release-builder';
import type { FrontendReleaseManifest } from './frontend-release-schema';

export const CURRENT_NATIVE_REQUIRED_ASSETS = [
  '_app/version.json',
  'brainvault-worker.js',
  'index.html',
  'push-wake-sw.js',
  'runtime.js',
  'site.webmanifest',
] as const;

export type CurrentFrontendReleaseInput = Readonly<{
  buildRoot: string;
  releaseRoot: string;
  sourceCommit: string;
  productVersion: string;
}>;

export const packageCurrentFrontendRelease = (
  input: CurrentFrontendReleaseInput,
): FrontendReleaseManifest => {
  mkdirSync(dirname(input.releaseRoot), { recursive: true });
  const surfaceStage = mkdtempSync(join(dirname(input.releaseRoot), '.surface-inputs-'));
  try {
    const surfaceSources = assembleCurrentFrontendSurfaces(input.buildRoot, surfaceStage);
    return buildFrontendRelease({
      releaseRoot: input.releaseRoot,
      sourceCommit: input.sourceCommit,
      productVersion: input.productVersion,
      routeContract: serializeFrontendMigrationContractReport(),
      surfaceSources,
      entrypoints: currentFrontendEntrypoints(),
      nativeRequiredAssets: CURRENT_NATIVE_REQUIRED_ASSETS,
    });
  } finally {
    rmSync(surfaceStage, { recursive: true, force: true });
  }
};
