import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization';
import { EDGE_ROUTES, SURFACES, type RouteRule, type SurfaceId } from '../config/surfaces';

const RELEASE_SCHEMA_VERSION = 1 as const;

type CandidateFile = Readonly<{
  sourcePath: string;
  destinationPath: string;
  sha256: string;
  size: number;
}>;

type CandidateApplication = Readonly<{
  id: SurfaceId;
  entryHtml: `apps/${SurfaceId}/index.html`;
  viteManifest: `apps/${SurfaceId}/manifest.json`;
  assetDirectory: `assets/${SurfaceId}`;
  routes: readonly RouteRule[];
}>;

export type CandidateReleaseManifest = Readonly<{
  schemaVersion: typeof RELEASE_SCHEMA_VERSION;
  releaseId: `sha256-${string}`;
  applications: readonly CandidateApplication[];
  edgeRoutes: readonly RouteRule[];
  files: readonly Readonly<{
    path: string;
    sha256: string;
    size: number;
  }>[];
}>;

export type CandidateReleasePlan = Readonly<{
  releaseId: `sha256-${string}`;
  releaseDirectory: string;
  manifest: CandidateReleaseManifest;
  files: readonly CandidateFile[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toPortablePath = (pathname: string): string => pathname.split(sep).join('/');

const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const readArtifactFile = async (
  sourcePath: string,
  destinationPath: string,
): Promise<CandidateFile> => {
  const bytes = await readFile(sourcePath);
  return {
    sourcePath,
    destinationPath,
    sha256: hashBytes(bytes),
    size: bytes.byteLength,
  };
};

const walkRegularFiles = async (root: string, current = root): Promise<readonly string[]> => {
  const entries = await readdir(current, { withFileTypes: true });
  const paths: string[] = [];
  entries.sort(({ name: left }, { name: right }) => left.localeCompare(right));
  for (const entry of entries) {
    const pathname = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`CANDIDATE_ARTIFACT_SYMLINK:${pathname}`);
    if (entry.isDirectory()) {
      paths.push(...await walkRegularFiles(root, pathname));
      continue;
    }
    if (!entry.isFile()) throw new Error(`CANDIDATE_ARTIFACT_UNSUPPORTED:${pathname}`);
    paths.push(toPortablePath(relative(root, pathname)));
  }
  return paths;
};

const readViteManifestReferences = async (
  manifestPath: string,
  surfaceId: SurfaceId,
): Promise<readonly string[]> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`CANDIDATE_VITE_MANIFEST_INVALID:${surfaceId}:${detail}`);
  }
  if (!isRecord(parsed)) throw new Error(`CANDIDATE_VITE_MANIFEST_INVALID:${surfaceId}:ROOT`);
  const entry = parsed['index.html'];
  if (!isRecord(entry) || entry['isEntry'] !== true || typeof entry['file'] !== 'string') {
    throw new Error(`CANDIDATE_VITE_ENTRY_INVALID:${surfaceId}`);
  }

  const references: string[] = [];
  for (const value of Object.values(parsed)) {
    if (!isRecord(value)) throw new Error(`CANDIDATE_VITE_CHUNK_INVALID:${surfaceId}`);
    const file = value['file'];
    if (typeof file !== 'string') throw new Error(`CANDIDATE_VITE_FILE_INVALID:${surfaceId}`);
    references.push(file);
    for (const field of ['css', 'assets'] as const) {
      const items = value[field];
      if (items === undefined) continue;
      if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) {
        throw new Error(`CANDIDATE_VITE_${field.toUpperCase()}_INVALID:${surfaceId}`);
      }
      references.push(...items as string[]);
    }
  }
  return [...new Set(references)].sort();
};

const assertOwnedArtifactPath = (surfaceId: SurfaceId, pathname: string): void => {
  if (pathname === 'index.html' || pathname === 'manifest.json') return;
  if (pathname.startsWith(`assets/${surfaceId}/`)) return;
  throw new Error(`CANDIDATE_ARTIFACT_PATH_UNOWNED:${surfaceId}:${pathname}`);
};

const destinationFor = (surfaceId: SurfaceId, pathname: string): string => {
  if (pathname === 'index.html') return `apps/${surfaceId}/index.html`;
  if (pathname === 'manifest.json') return `apps/${surfaceId}/manifest.json`;
  return pathname;
};

const collectSurfaceFiles = async (frontendRoot: string, surfaceId: SurfaceId): Promise<readonly CandidateFile[]> => {
  const artifactRoot = join(frontendRoot, '.artifacts', surfaceId);
  let paths: readonly string[];
  try {
    paths = await walkRegularFiles(artifactRoot);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`CANDIDATE_ARTIFACT_READ_FAILED:${surfaceId}:${detail}`);
  }
  if (!paths.includes('index.html')) throw new Error(`CANDIDATE_ENTRY_MISSING:${surfaceId}`);
  if (!paths.includes('manifest.json')) throw new Error(`CANDIDATE_VITE_MANIFEST_MISSING:${surfaceId}`);
  for (const pathname of paths) assertOwnedArtifactPath(surfaceId, pathname);

  const references = await readViteManifestReferences(join(artifactRoot, 'manifest.json'), surfaceId);
  for (const reference of references) {
    assertOwnedArtifactPath(surfaceId, reference);
    if (!paths.includes(reference)) throw new Error(`CANDIDATE_VITE_REFERENCE_MISSING:${surfaceId}:${reference}`);
  }

  return Promise.all(paths.map((pathname) =>
    readArtifactFile(join(artifactRoot, pathname), destinationFor(surfaceId, pathname))));
};

const assertCollisionFree = (files: readonly CandidateFile[]): void => {
  const owners = new Map<string, string>();
  for (const file of files) {
    const existing = owners.get(file.destinationPath);
    if (existing !== undefined) {
      throw new Error(`CANDIDATE_DESTINATION_COLLISION:${file.destinationPath}:${existing}:${file.sourcePath}`);
    }
    owners.set(file.destinationPath, file.sourcePath);
  }
};

const createApplications = (): readonly CandidateApplication[] => SURFACES.map((surface) => ({
  id: surface.id,
  entryHtml: `apps/${surface.id}/index.html`,
  viteManifest: `apps/${surface.id}/manifest.json`,
  assetDirectory: surface.assetDirectory,
  routes: surface.routes,
}));

export const planCandidateRelease = async (frontendRoot: string): Promise<CandidateReleasePlan> => {
  const files = (await Promise.all(SURFACES.map(({ id }) => collectSurfaceFiles(frontendRoot, id)))).flat();
  files.sort(({ destinationPath: left }, { destinationPath: right }) => left.localeCompare(right));
  assertCollisionFree(files);

  const applications = createApplications();
  const publicFiles = files.map(({ destinationPath: path, sha256, size }) => ({ path, sha256, size }));
  const identityInput = safeStringify({
    schemaVersion: RELEASE_SCHEMA_VERSION,
    applications,
    edgeRoutes: EDGE_ROUTES,
    files: publicFiles,
  });
  const releaseId = `sha256-${hashBytes(Buffer.from(identityInput))}` as const;
  const releaseDirectory = join(frontendRoot, '.artifacts', 'releases', releaseId);
  return {
    releaseId,
    releaseDirectory,
    files,
    manifest: {
      schemaVersion: RELEASE_SCHEMA_VERSION,
      releaseId,
      applications,
      edgeRoutes: EDGE_ROUTES,
      files: publicFiles,
    },
  };
};

const pathExists = async (pathname: string): Promise<boolean> => {
  try {
    await stat(pathname);
    return true;
  } catch (error: unknown) {
    if (isRecord(error) && error['code'] === 'ENOENT') return false;
    throw error;
  }
};

const validateExistingRelease = async (plan: CandidateReleasePlan): Promise<void> => {
  const manifestPath = join(plan.releaseDirectory, 'release-manifest.json');
  const actual = await readFile(manifestPath, 'utf8');
  const expected = `${safeStringify(plan.manifest, 2)}\n`;
  if (actual !== expected) throw new Error(`CANDIDATE_RELEASE_ID_CONFLICT:${plan.releaseId}`);

  const actualPaths = await walkRegularFiles(plan.releaseDirectory);
  const expectedPaths = [...plan.files.map(({ destinationPath }) => destinationPath), 'release-manifest.json'].sort();
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((pathname, index) => pathname !== expectedPaths[index])
  ) {
    throw new Error(`CANDIDATE_RELEASE_FILE_SET_MISMATCH:${plan.releaseId}`);
  }
  for (const file of plan.files) {
    const bytes = await readFile(join(plan.releaseDirectory, file.destinationPath));
    if (bytes.byteLength !== file.size || hashBytes(bytes) !== file.sha256) {
      throw new Error(`CANDIDATE_RELEASE_FILE_MISMATCH:${file.destinationPath}`);
    }
  }
};

const copyAndVerify = async (file: CandidateFile, releaseRoot: string): Promise<void> => {
  const destination = join(releaseRoot, file.destinationPath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(file.sourcePath, destination);
  const copied = await readFile(destination);
  if (copied.byteLength !== file.size || hashBytes(copied) !== file.sha256) {
    throw new Error(`CANDIDATE_COPY_MISMATCH:${file.destinationPath}`);
  }
};

export const assembleCandidateRelease = async (frontendRoot: string): Promise<CandidateReleasePlan> => {
  const plan = await planCandidateRelease(frontendRoot);
  if (await pathExists(plan.releaseDirectory)) {
    await validateExistingRelease(plan);
    return plan;
  }

  const releasesRoot = join(frontendRoot, '.artifacts', 'releases');
  await mkdir(releasesRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(join(releasesRoot, '.assembling-'));
  try {
    for (const file of plan.files) await copyAndVerify(file, temporaryRoot);
    await writeFile(
      join(temporaryRoot, 'release-manifest.json'),
      `${safeStringify(plan.manifest, 2)}\n`,
    );
    await rename(temporaryRoot, plan.releaseDirectory);
  } finally {
    if (await pathExists(temporaryRoot)) await rm(temporaryRoot, { recursive: true, force: true });
  }
  return plan;
};
