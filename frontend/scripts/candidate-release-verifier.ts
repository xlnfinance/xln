import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { compareStableText, safeStringify } from '../../core/protocol/serialization';
import { EDGE_ROUTES, SURFACES, SURFACE_IDS } from '../config/surfaces';
import {
  RELEASE_SCHEMA_VERSION,
  type CandidateReleaseManifest,
} from './candidate-release';

const MANIFEST_FILENAME = 'release-manifest.json';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_ID_PATTERN = /^sha256-[0-9a-f]{64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort(compareStableText);
  const sortedExpected = [...expected].sort(compareStableText);
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(code);
  }
};

const requiredString = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(code);
  return value;
};

const portablePath = (value: unknown, code: string): string => {
  const pathname = requiredString(value, code);
  const segments = pathname.split('/');
  if (
    pathname.startsWith('/') || pathname.includes('\\') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) throw new Error(code);
  return pathname;
};

const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const toPortablePath = (pathname: string): string => pathname.split(sep).join('/');

const assertReleaseRoot = async (releaseDirectory: string): Promise<void> => {
  try {
    const stats = await lstat(releaseDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('CANDIDATE_RELEASE_ROOT_INVALID');
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'CANDIDATE_RELEASE_ROOT_INVALID') throw error;
    throw new Error('CANDIDATE_RELEASE_ROOT_INVALID');
  }
};

const walkRegularFiles = async (root: string, current = root): Promise<readonly string[]> => {
  const entries = await readdir(current, { withFileTypes: true });
  const paths: string[] = [];
  entries.sort(({ name: left }, { name: right }) => compareStableText(left, right));
  for (const entry of entries) {
    const pathname = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`CANDIDATE_RELEASE_SYMLINK:${toPortablePath(relative(root, pathname))}`);
    if (entry.isDirectory()) paths.push(...await walkRegularFiles(root, pathname));
    else if (entry.isFile()) paths.push(toPortablePath(relative(root, pathname)));
    else throw new Error(`CANDIDATE_RELEASE_FILE_TYPE_INVALID:${toPortablePath(relative(root, pathname))}`);
  }
  return paths.sort(compareStableText);
};

const decodeFiles = (value: unknown): CandidateReleaseManifest['files'] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error('CANDIDATE_RELEASE_FILES_INVALID');
  const files = value.map((item) => {
    if (!isRecord(item)) throw new Error('CANDIDATE_RELEASE_FILE_INVALID');
    exactKeys(item, ['path', 'sha256', 'size'], 'CANDIDATE_RELEASE_FILE_KEYS_INVALID');
    const path = portablePath(item['path'], 'CANDIDATE_RELEASE_FILE_PATH_INVALID');
    const sha256 = requiredString(item['sha256'], 'CANDIDATE_RELEASE_FILE_HASH_INVALID');
    const size = item['size'];
    if (!SHA256_PATTERN.test(sha256)) throw new Error(`CANDIDATE_RELEASE_FILE_HASH_INVALID:${path}`);
    if (!Number.isSafeInteger(size) || Number(size) < 0) throw new Error(`CANDIDATE_RELEASE_FILE_SIZE_INVALID:${path}`);
    return { path, sha256, size: Number(size) };
  });
  const paths = files.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) throw new Error('CANDIDATE_RELEASE_FILE_DUPLICATE');
  if (paths.some((path, index) => index > 0 && compareStableText(paths[index - 1] ?? '', path) >= 0)) {
    throw new Error('CANDIDATE_RELEASE_FILES_NONCANONICAL');
  }
  return files;
};

const decodeGeneratedInputs = (
  value: unknown,
  releaseFiles: ReadonlySet<string>,
): CandidateReleaseManifest['generatedInputs'] => {
  if (!Array.isArray(value)) throw new Error('CANDIDATE_RELEASE_INPUTS_INVALID');
  const claimedFiles = new Set<string>();
  const inputs = value.map((item) => {
    if (!isRecord(item)) throw new Error('CANDIDATE_RELEASE_INPUT_INVALID');
    exactKeys(item, ['id', 'owner', 'outputNamespace', 'definitionSha256', 'files'], 'CANDIDATE_RELEASE_INPUT_KEYS_INVALID');
    const id = requiredString(item['id'], 'CANDIDATE_RELEASE_INPUT_ID_INVALID');
    const owner = SURFACE_IDS.find((candidate) => candidate === item['owner']);
    if (owner === undefined) throw new Error(`CANDIDATE_RELEASE_INPUT_OWNER_INVALID:${id}`);
    const outputNamespace = portablePath(item['outputNamespace'], `CANDIDATE_RELEASE_INPUT_NAMESPACE_INVALID:${id}`);
    const definitionSha256 = requiredString(item['definitionSha256'], `CANDIDATE_RELEASE_INPUT_HASH_INVALID:${id}`);
    if (!SHA256_PATTERN.test(definitionSha256)) throw new Error(`CANDIDATE_RELEASE_INPUT_HASH_INVALID:${id}`);
    if (!Array.isArray(item['files'])) throw new Error(`CANDIDATE_RELEASE_INPUT_FILES_INVALID:${id}`);
    const files = item['files'].map((file) => portablePath(file, `CANDIDATE_RELEASE_INPUT_FILE_INVALID:${id}`));
    if (new Set(files).size !== files.length) throw new Error(`CANDIDATE_RELEASE_INPUT_FILE_DUPLICATE:${id}`);
    if (files.some((path) => !releaseFiles.has(path))) throw new Error(`CANDIDATE_RELEASE_INPUT_FILE_MISSING:${id}`);
    if (files.some((path) => claimedFiles.has(path))) throw new Error(`CANDIDATE_RELEASE_INPUT_FILE_MIXED:${id}`);
    files.forEach((path) => claimedFiles.add(path));
    return { id, owner, outputNamespace, definitionSha256, files };
  });
  if (new Set(inputs.map(({ id }) => id)).size !== inputs.length) {
    throw new Error('CANDIDATE_RELEASE_INPUT_DUPLICATE');
  }
  return inputs;
};

const expectedApplications = (): CandidateReleaseManifest['applications'] => SURFACES.map((surface) => ({
  id: surface.id,
  entryHtml: `apps/${surface.id}/index.html`,
  viteManifest: `apps/${surface.id}/manifest.json`,
  assetDirectory: surface.assetDirectory,
  routes: surface.routes,
  assetRoutes: surface.assetRoutes,
}));

const decodeManifest = (value: unknown): CandidateReleaseManifest => {
  if (!isRecord(value)) throw new Error('CANDIDATE_RELEASE_MANIFEST_INVALID');
  exactKeys(value, ['schemaVersion', 'releaseId', 'applications', 'generatedInputs', 'edgeRoutes', 'files'], 'CANDIDATE_RELEASE_MANIFEST_KEYS_INVALID');
  if (value['schemaVersion'] !== RELEASE_SCHEMA_VERSION) throw new Error('CANDIDATE_RELEASE_SCHEMA_UNSUPPORTED');
  const releaseId = requiredString(value['releaseId'], 'CANDIDATE_RELEASE_ID_INVALID');
  if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error('CANDIDATE_RELEASE_ID_INVALID');
  const applications = expectedApplications();
  if (safeStringify(value['applications']) !== safeStringify(applications)) {
    throw new Error('CANDIDATE_RELEASE_APPLICATIONS_INVALID');
  }
  if (safeStringify(value['edgeRoutes']) !== safeStringify(EDGE_ROUTES)) {
    throw new Error('CANDIDATE_RELEASE_EDGE_ROUTES_INVALID');
  }
  const files = decodeFiles(value['files']);
  const generatedInputs = decodeGeneratedInputs(value['generatedInputs'], new Set(files.map(({ path }) => path)));
  return { schemaVersion: RELEASE_SCHEMA_VERSION, releaseId, applications, generatedInputs, edgeRoutes: EDGE_ROUTES, files };
};

const readManifest = async (releaseDirectory: string): Promise<Readonly<{ raw: string; manifest: CandidateReleaseManifest }>> => {
  let raw: string;
  try {
    raw = await readFile(join(releaseDirectory, MANIFEST_FILENAME), 'utf8');
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`CANDIDATE_RELEASE_MANIFEST_READ_FAILED:${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('CANDIDATE_RELEASE_MANIFEST_JSON_INVALID');
  }
  return { raw, manifest: decodeManifest(parsed) };
};

const identityFor = (manifest: CandidateReleaseManifest): string => hashBytes(Buffer.from(safeStringify({
  schemaVersion: manifest.schemaVersion,
  applications: manifest.applications,
  generatedInputs: manifest.generatedInputs,
  edgeRoutes: manifest.edgeRoutes,
  files: manifest.files,
})));

export const verifyCandidateReleaseDirectory = async (
  releaseDirectory: string,
): Promise<CandidateReleaseManifest> => {
  await assertReleaseRoot(releaseDirectory);
  const { raw, manifest } = await readManifest(releaseDirectory);
  if (raw !== `${safeStringify(manifest, 2)}\n`) throw new Error('CANDIDATE_RELEASE_MANIFEST_NONCANONICAL');
  if (basename(releaseDirectory) !== manifest.releaseId) throw new Error('CANDIDATE_RELEASE_DIRECTORY_ID_MISMATCH');
  if (manifest.releaseId !== `sha256-${identityFor(manifest)}`) throw new Error('CANDIDATE_RELEASE_ID_MISMATCH');
  const actualPaths = await walkRegularFiles(releaseDirectory);
  const expectedPaths = [...manifest.files.map(({ path }) => path), MANIFEST_FILENAME].sort(compareStableText);
  if (safeStringify(actualPaths) !== safeStringify(expectedPaths)) throw new Error('CANDIDATE_RELEASE_FILE_SET_MISMATCH');
  for (const file of manifest.files) {
    const bytes = await readFile(join(releaseDirectory, file.path));
    if (bytes.byteLength !== file.size || hashBytes(bytes) !== file.sha256) {
      throw new Error(`CANDIDATE_RELEASE_FILE_MISMATCH:${file.path}`);
    }
  }
  return manifest;
};

const run = async (): Promise<void> => {
  const releaseDirectory = Bun.argv[2];
  if (!releaseDirectory || Bun.argv.length !== 3) throw new Error('CANDIDATE_RELEASE_DIRECTORY_REQUIRED');
  const manifest = await verifyCandidateReleaseDirectory(releaseDirectory);
  console.info(`FRONTEND_CANDIDATE_VERIFY_OK release=${manifest.releaseId} files=${manifest.files.length} path=${releaseDirectory}`);
};

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
