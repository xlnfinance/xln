import { serializeFrontendMigrationContractReport } from '../../frontend/src/lib/contracts/frontendMigrationContract';
import { buildFrontendRelease } from './frontend-release-builder';
import { resolveFrontendSurfaceSources, frontendSurfaceEntrypoints } from './frontend-surface-build';
import { FRONTEND_BUILD_IDENTITY_FILE, type FrontendReleaseManifest } from './frontend-release-schema';

export const NATIVE_REQUIRED_ASSETS = [
  FRONTEND_BUILD_IDENTITY_FILE,
  'brainvault-worker.js',
  'index.html',
  'push-wake-sw.js',
  'runtime.js',
  'site.webmanifest',
] as const;

export type FrontendReleasePackageInput = Readonly<{
  buildRoot: string;
  releaseRoot: string;
  sourceCommit: string;
  productVersion: string;
}>;

export const packageFrontendRelease = (
  input: FrontendReleasePackageInput,
): FrontendReleaseManifest => buildFrontendRelease({
  releaseRoot: input.releaseRoot,
  sourceCommit: input.sourceCommit,
  productVersion: input.productVersion,
  routeContract: serializeFrontendMigrationContractReport(),
  surfaceSources: resolveFrontendSurfaceSources(input.buildRoot),
  entrypoints: frontendSurfaceEntrypoints(),
  nativeRequiredAssets: NATIVE_REQUIRED_ASSETS,
});
