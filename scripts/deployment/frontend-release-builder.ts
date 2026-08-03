import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { prettyCanonicalJson, sha256Text } from './canonical-json';
import {
  buildFrontendReleaseAssets,
  frontendAssetInventorySha256,
  frontendSurfaceContentSha256,
  verifyFrontendReleaseTree,
  type FrontendBuildIdentity,
} from './frontend-release-files';
import {
  FRONTEND_BUILD_IDENTITY_FILE,
  FRONTEND_NATIVE_TARGET_IDS,
  FRONTEND_RELEASE_MANIFEST_FILE,
  FRONTEND_RELEASE_SCHEMA_VERSION,
  FRONTEND_ROUTE_CONTRACT_FILE,
  FRONTEND_SURFACE_IDS,
  validateFrontendReleaseManifest,
  type FrontendNativeTarget,
  type FrontendNativeTargetId,
  type FrontendReleaseManifest,
  type FrontendReleaseSurface,
  type FrontendReleaseSurfaceId,
} from './frontend-release-schema';

export type FrontendReleaseBuildInput = Readonly<{
  releaseRoot: string;
  sourceCommit: string;
  productVersion: string;
  routeContract: string;
  surfaceSources: Readonly<Record<FrontendReleaseSurfaceId, string>>;
  entrypoints: Readonly<Record<FrontendReleaseSurfaceId, readonly string[]>>;
  nativeRequiredAssets: readonly string[];
}>;

const releaseId = (productVersion: string, sourceCommit: string): string =>
  `${productVersion}-${sourceCommit.slice(0, 12)}`;

const prepareReleaseRoot = (releaseRoot: string): void => {
  if (existsSync(releaseRoot)) {
    const entries = readdirSync(releaseRoot);
    if (entries.length > 0) throw new Error(`FRONTEND_RELEASE_ROOT_NOT_EMPTY:${releaseRoot}`);
  }
  mkdirSync(releaseRoot, { recursive: true });
};
const copySurfaceFiles = (sourceRoot: string, destinationRoot: string): void => {
  const assets = buildFrontendReleaseAssets(sourceRoot);
  if (assets.some(asset => asset.path === FRONTEND_BUILD_IDENTITY_FILE)) {
    throw new Error(`FRONTEND_RELEASE_RESERVED_ASSET:${sourceRoot}:${FRONTEND_BUILD_IDENTITY_FILE}`);
  }
  assets.forEach(asset => {
    const source = join(sourceRoot, asset.path);
    const destination = join(destinationRoot, asset.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  });
};

const writeSurfaceIdentity = (
  destinationRoot: string,
  surface: FrontendReleaseSurfaceId,
  input: FrontendReleaseBuildInput,
): void => {
  const identity: FrontendBuildIdentity = {
    schemaVersion: 1,
    releaseId: releaseId(input.productVersion, input.sourceCommit),
    surface,
    sourceCommit: input.sourceCommit,
    productVersion: input.productVersion,
  };
  writeFileSync(join(destinationRoot, FRONTEND_BUILD_IDENTITY_FILE), prettyCanonicalJson(identity));
};

const buildSurface = (
  surface: FrontendReleaseSurfaceId,
  input: FrontendReleaseBuildInput,
): FrontendReleaseSurface => {
  const destinationRoot = join(input.releaseRoot, surface);
  mkdirSync(destinationRoot, { recursive: true });
  copySurfaceFiles(input.surfaceSources[surface], destinationRoot);
  writeSurfaceIdentity(destinationRoot, surface, input);
  const assets = buildFrontendReleaseAssets(destinationRoot);
  return {
    id: surface,
    outputRoot: surface,
    sourceCommit: input.sourceCommit,
    productVersion: input.productVersion,
    entrypoints: [...input.entrypoints[surface]].sort((left, right) => left.localeCompare(right)),
    assets,
    contentSha256: frontendSurfaceContentSha256(assets),
  };
};

const nativeTarget = (
  id: FrontendNativeTargetId,
  requiredAssets: readonly string[],
): FrontendNativeTarget => ({
  id,
  surfaces: ['wallet'],
  requiredAssets: [...requiredAssets].sort((left, right) => left.localeCompare(right)),
});

export const buildFrontendRelease = (input: FrontendReleaseBuildInput): FrontendReleaseManifest => {
  prepareReleaseRoot(input.releaseRoot);
  writeFileSync(join(input.releaseRoot, FRONTEND_ROUTE_CONTRACT_FILE), input.routeContract);

  const surfaces = Object.fromEntries(
    FRONTEND_SURFACE_IDS.map(surface => [surface, buildSurface(surface, input)]),
  ) as Record<FrontendReleaseSurfaceId, FrontendReleaseSurface>;
  const nativeTargets = Object.fromEntries(
    FRONTEND_NATIVE_TARGET_IDS.map(id => [id, nativeTarget(id, input.nativeRequiredAssets)]),
  ) as Record<FrontendNativeTargetId, FrontendNativeTarget>;
  const manifest: FrontendReleaseManifest = {
    schemaVersion: FRONTEND_RELEASE_SCHEMA_VERSION,
    releaseId: releaseId(input.productVersion, input.sourceCommit),
    sourceCommit: input.sourceCommit,
    productVersion: input.productVersion,
    routeContractSha256: sha256Text(input.routeContract),
    assetInventorySha256: frontendAssetInventorySha256(surfaces),
    surfaces,
    nativeTargets,
  };
  const errors = validateFrontendReleaseManifest(manifest);
  if (errors.length > 0) throw new Error(`FRONTEND_RELEASE_MANIFEST_INVALID:${errors.join(',')}`);
  writeFileSync(join(input.releaseRoot, FRONTEND_RELEASE_MANIFEST_FILE), prettyCanonicalJson(manifest));
  verifyFrontendReleaseTree(input.releaseRoot, manifest);
  return manifest;
};
