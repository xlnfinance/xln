export const FRONTEND_RELEASE_SCHEMA_VERSION = 1;
export const FRONTEND_RELEASE_MANIFEST_FILE = 'release-manifest.json';
export const FRONTEND_ROUTE_CONTRACT_FILE = 'route-contract.json';
export const FRONTEND_BUILD_IDENTITY_FILE = 'build-identity.json';
export const FRONTEND_SURFACE_IDS = ['site', 'docs', 'wallet', 'ops'] as const;
export const FRONTEND_NATIVE_TARGET_IDS = ['ios', 'android', 'desktop', 'extension'] as const;

export type FrontendReleaseSurfaceId = typeof FRONTEND_SURFACE_IDS[number];
export type FrontendNativeTargetId = typeof FRONTEND_NATIVE_TARGET_IDS[number];

export type FrontendReleaseAsset = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

export type FrontendReleaseSurface = Readonly<{
  id: FrontendReleaseSurfaceId;
  outputRoot: string;
  sourceCommit: string;
  productVersion: string;
  entrypoints: readonly string[];
  assets: readonly FrontendReleaseAsset[];
  contentSha256: string;
}>;

export type FrontendNativeTarget = Readonly<{
  id: FrontendNativeTargetId;
  surfaces: readonly FrontendReleaseSurfaceId[];
  requiredAssets: readonly string[];
}>;

export type FrontendReleaseManifest = Readonly<{
  schemaVersion: typeof FRONTEND_RELEASE_SCHEMA_VERSION;
  releaseId: string;
  sourceCommit: string;
  productVersion: string;
  routeContractSha256: string;
  assetInventorySha256: string;
  surfaces: Readonly<Record<FrontendReleaseSurfaceId, FrontendReleaseSurface>>;
  nativeTargets: Readonly<Record<FrontendNativeTargetId, FrontendNativeTarget>>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): string[] => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return JSON.stringify(actual) === JSON.stringify(wanted) ? [] : [`${label}_KEYS_INVALID:${actual.join(',')}`];
};

const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export const isSafeReleasePath = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
};

const validateAsset = (value: unknown, label: string): string[] => {
  if (!isRecord(value)) return [`${label}_INVALID`];
  const errors = exactKeys(value, ['path', 'bytes', 'sha256'], label);
  if (!isSafeReleasePath(value['path'])) errors.push(`${label}_PATH_INVALID`);
  if (!Number.isSafeInteger(value['bytes']) || Number(value['bytes']) < 0) errors.push(`${label}_BYTES_INVALID`);
  if (!isSha256(value['sha256'])) errors.push(`${label}_SHA256_INVALID`);
  return errors;
};

const validateSurface = (
  value: unknown,
  id: FrontendReleaseSurfaceId,
  manifest: Record<string, unknown>,
): string[] => {
  const label = `SURFACE_${id.toUpperCase()}`;
  if (!isRecord(value)) return [`${label}_INVALID`];
  const errors = exactKeys(
    value,
    ['id', 'outputRoot', 'sourceCommit', 'productVersion', 'entrypoints', 'assets', 'contentSha256'],
    label,
  );
  if (value['id'] !== id) errors.push(`${label}_ID_INVALID`);
  if (value['outputRoot'] !== id) errors.push(`${label}_OUTPUT_ROOT_INVALID`);
  if (value['sourceCommit'] !== manifest['sourceCommit']) errors.push(`${label}_COMMIT_MISMATCH`);
  if (value['productVersion'] !== manifest['productVersion']) errors.push(`${label}_VERSION_MISMATCH`);
  if (!isSha256(value['contentSha256'])) errors.push(`${label}_CONTENT_SHA256_INVALID`);
  if (!Array.isArray(value['entrypoints']) || value['entrypoints'].some(entry => !isSafeReleasePath(entry))) {
    errors.push(`${label}_ENTRYPOINTS_INVALID`);
  }
  if (!Array.isArray(value['assets'])) return [...errors, `${label}_ASSETS_INVALID`];
  value['assets'].forEach((asset, index) => errors.push(...validateAsset(asset, `${label}_ASSET_${index}`)));
  const paths = value['assets'].map(asset => isRecord(asset) ? asset['path'] : undefined);
  if (new Set(paths).size !== paths.length) errors.push(`${label}_ASSET_PATH_DUPLICATE`);
  return errors;
};

const validateNativeTarget = (value: unknown, id: FrontendNativeTargetId): string[] => {
  const label = `NATIVE_${id.toUpperCase()}`;
  if (!isRecord(value)) return [`${label}_INVALID`];
  const errors = exactKeys(value, ['id', 'surfaces', 'requiredAssets'], label);
  if (value['id'] !== id) errors.push(`${label}_ID_INVALID`);
  if (!Array.isArray(value['surfaces']) || value['surfaces'].length !== 1 || value['surfaces'][0] !== 'wallet') {
    errors.push(`${label}_SURFACES_INVALID`);
  }
  if (!Array.isArray(value['requiredAssets']) || value['requiredAssets'].some(path => !isSafeReleasePath(path))) {
    errors.push(`${label}_REQUIRED_ASSETS_INVALID`);
  }
  return errors;
};

export const validateFrontendReleaseManifest = (value: unknown): readonly string[] => {
  if (!isRecord(value)) return ['MANIFEST_INVALID'];
  const errors = exactKeys(value, [
    'schemaVersion', 'releaseId', 'sourceCommit', 'productVersion', 'routeContractSha256',
    'assetInventorySha256', 'surfaces', 'nativeTargets',
  ], 'MANIFEST');
  if (value['schemaVersion'] !== FRONTEND_RELEASE_SCHEMA_VERSION) errors.push('MANIFEST_SCHEMA_VERSION_INVALID');
  if (typeof value['releaseId'] !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value['releaseId'])) errors.push('MANIFEST_RELEASE_ID_INVALID');
  if (typeof value['sourceCommit'] !== 'string' || !/^[a-f0-9]{40}$/.test(value['sourceCommit'])) errors.push('MANIFEST_SOURCE_COMMIT_INVALID');
  if (typeof value['productVersion'] !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(value['productVersion'])) errors.push('MANIFEST_PRODUCT_VERSION_INVALID');
  if (!isSha256(value['routeContractSha256'])) errors.push('MANIFEST_ROUTE_CONTRACT_SHA256_INVALID');
  if (!isSha256(value['assetInventorySha256'])) errors.push('MANIFEST_ASSET_INVENTORY_SHA256_INVALID');

  const surfaces = value['surfaces'];
  if (!isRecord(surfaces)) errors.push('MANIFEST_SURFACES_INVALID');
  else {
    errors.push(...exactKeys(surfaces, FRONTEND_SURFACE_IDS, 'MANIFEST_SURFACES'));
    FRONTEND_SURFACE_IDS.forEach(id => errors.push(...validateSurface(surfaces[id], id, value)));
  }
  const nativeTargets = value['nativeTargets'];
  if (!isRecord(nativeTargets)) errors.push('MANIFEST_NATIVE_TARGETS_INVALID');
  else {
    errors.push(...exactKeys(nativeTargets, FRONTEND_NATIVE_TARGET_IDS, 'MANIFEST_NATIVE_TARGETS'));
    FRONTEND_NATIVE_TARGET_IDS.forEach(id => errors.push(...validateNativeTarget(nativeTargets[id], id)));
  }
  return errors.sort();
};

export const parseFrontendReleaseManifest = (text: string): FrontendReleaseManifest => {
  const parsed: unknown = JSON.parse(text);
  const errors = validateFrontendReleaseManifest(parsed);
  if (errors.length > 0) throw new Error(`FRONTEND_RELEASE_MANIFEST_INVALID:${errors.join(',')}`);
  return parsed as FrontendReleaseManifest;
};
