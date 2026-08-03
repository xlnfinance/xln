import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import { canonicalJson, sha256Text } from './canonical-json';
import {
  FRONTEND_BUILD_IDENTITY_FILE,
  FRONTEND_NATIVE_TARGET_IDS,
  FRONTEND_RELEASE_MANIFEST_FILE,
  FRONTEND_ROUTE_CONTRACT_FILE,
  FRONTEND_SURFACE_IDS,
  type FrontendReleaseAsset,
  type FrontendReleaseManifest,
  type FrontendReleaseSurface,
  type FrontendReleaseSurfaceId,
} from './frontend-release-schema';

export type FrontendBuildIdentity = Readonly<{
  schemaVersion: 1;
  releaseId: string;
  surface: FrontendReleaseSurfaceId;
  sourceCommit: string;
  productVersion: string;
}>;

const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const assertContainedPath = (root: string, candidate: string): void => {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (candidatePath !== rootPath && !candidatePath.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`FRONTEND_RELEASE_PATH_OUTSIDE_ROOT:${candidatePath}`);
  }
};

const walkReleaseFiles = (root: string, directory = root): string[] => {
  assertContainedPath(root, directory);
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`FRONTEND_RELEASE_SYMLINK_FORBIDDEN:${relative(root, path)}`);
    if (stat.isDirectory()) files.push(...walkReleaseFiles(root, path));
    else if (stat.isFile()) files.push(path);
    else throw new Error(`FRONTEND_RELEASE_FILE_TYPE_INVALID:${relative(root, path)}`);
  }
  return files;
};

export const buildFrontendReleaseAssets = (root: string): readonly FrontendReleaseAsset[] => {
  if (!lstatSync(root).isDirectory()) throw new Error(`FRONTEND_RELEASE_SURFACE_NOT_DIRECTORY:${root}`);
  return walkReleaseFiles(root).map(path => ({
    path: relative(root, path).split(sep).join('/'),
    bytes: lstatSync(path).size,
    sha256: sha256File(path),
  }));
};

export const frontendSurfaceContentSha256 = (assets: readonly FrontendReleaseAsset[]): string =>
  sha256Text(canonicalJson(assets));

export const frontendAssetInventorySha256 = (
  surfaces: Readonly<Record<FrontendReleaseSurfaceId, FrontendReleaseSurface>>,
): string => sha256Text(canonicalJson(
  FRONTEND_SURFACE_IDS.flatMap(surface => surfaces[surface].assets.map(asset => ({ surface, ...asset }))),
));

const parseBuildIdentity = (path: string): FrontendBuildIdentity => {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`FRONTEND_BUILD_IDENTITY_INVALID:${path}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'productVersion,releaseId,schemaVersion,sourceCommit,surface') {
    throw new Error(`FRONTEND_BUILD_IDENTITY_KEYS_INVALID:${path}:${keys}`);
  }
  if (record['schemaVersion'] !== 1) throw new Error(`FRONTEND_BUILD_IDENTITY_SCHEMA_INVALID:${path}`);
  return record as FrontendBuildIdentity;
};

const verifyBuildIdentity = (
  surfaceRoot: string,
  surface: FrontendReleaseSurfaceId,
  manifest: FrontendReleaseManifest,
): void => {
  const identity = parseBuildIdentity(join(surfaceRoot, FRONTEND_BUILD_IDENTITY_FILE));
  const expected: FrontendBuildIdentity = {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    surface,
    sourceCommit: manifest.sourceCommit,
    productVersion: manifest.productVersion,
  };
  if (canonicalJson(identity) !== canonicalJson(expected)) {
    throw new Error(`FRONTEND_BUILD_IDENTITY_MISMATCH:${surface}`);
  }
};

const verifySurface = (
  releaseRoot: string,
  surface: FrontendReleaseSurfaceId,
  manifest: FrontendReleaseManifest,
): void => {
  const expected = manifest.surfaces[surface];
  const surfaceRoot = join(releaseRoot, expected.outputRoot);
  assertContainedPath(releaseRoot, surfaceRoot);
  verifyBuildIdentity(surfaceRoot, surface, manifest);
  const assets = buildFrontendReleaseAssets(surfaceRoot);
  if (canonicalJson(assets) !== canonicalJson(expected.assets)) {
    throw new Error(`FRONTEND_RELEASE_ASSET_INVENTORY_MISMATCH:${surface}`);
  }
  if (frontendSurfaceContentSha256(assets) !== expected.contentSha256) {
    throw new Error(`FRONTEND_RELEASE_SURFACE_HASH_MISMATCH:${surface}`);
  }
  const paths = new Set(assets.map(asset => asset.path));
  expected.entrypoints.forEach(entry => {
    if (!paths.has(entry)) throw new Error(`FRONTEND_RELEASE_ENTRYPOINT_MISSING:${surface}:${entry}`);
  });
};

const verifyRootEntries = (releaseRoot: string): void => {
  const allowed = new Set<string>([
    FRONTEND_RELEASE_MANIFEST_FILE,
    FRONTEND_ROUTE_CONTRACT_FILE,
    ...FRONTEND_SURFACE_IDS,
  ]);
  for (const entry of readdirSync(releaseRoot)) {
    if (!allowed.has(entry)) throw new Error(`FRONTEND_RELEASE_ROOT_ENTRY_UNKNOWN:${entry}`);
  }
};

const verifyNativeTargets = (manifest: FrontendReleaseManifest): void => {
  const walletPaths = new Set(manifest.surfaces.wallet.assets.map(asset => asset.path));
  FRONTEND_NATIVE_TARGET_IDS.forEach(id => {
    manifest.nativeTargets[id].requiredAssets.forEach(path => {
      if (!walletPaths.has(path)) throw new Error(`FRONTEND_NATIVE_ASSET_MISSING:${id}:${path}`);
    });
  });
};

export const verifyFrontendReleaseTree = (releaseRoot: string, manifest: FrontendReleaseManifest): void => {
  const resolvedRoot = realpathSync(releaseRoot);
  verifyRootEntries(resolvedRoot);
  const routeContract = readFileSync(join(resolvedRoot, FRONTEND_ROUTE_CONTRACT_FILE), 'utf8');
  if (sha256Text(routeContract) !== manifest.routeContractSha256) {
    throw new Error('FRONTEND_RELEASE_ROUTE_CONTRACT_HASH_MISMATCH');
  }
  FRONTEND_SURFACE_IDS.forEach(surface => verifySurface(resolvedRoot, surface, manifest));
  if (frontendAssetInventorySha256(manifest.surfaces) !== manifest.assetInventorySha256) {
    throw new Error('FRONTEND_RELEASE_ASSET_INVENTORY_HASH_MISMATCH');
  }
  verifyNativeTargets(manifest);
};

export const releaseIdFromPath = (releaseRoot: string): string => basename(resolve(releaseRoot));
