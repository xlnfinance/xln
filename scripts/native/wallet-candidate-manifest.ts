import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { compareStableText, safeStringify } from '../../core/protocol/serialization';
import type { CandidateReleaseManifest } from '../../frontend/scripts/candidate-release';

export const NATIVE_WALLET_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const NATIVE_WALLET_CANDIDATE_MANIFEST = 'native-wallet-candidate.json';

export type NativeWalletCandidateFile = Readonly<{
  sourcePath: string;
  path: string;
  sha256: string;
  size: number;
}>;

export type NativeWalletCandidateManifest = Readonly<{
  schemaVersion: typeof NATIVE_WALLET_CANDIDATE_SCHEMA_VERSION;
  releaseId: `sha256-${string}`;
  application: 'wallet';
  files: readonly NativeWalletCandidateFile[];
}>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_ID_PATTERN = /^sha256-[0-9a-f]{64}$/u;
const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const toPortablePath = (pathname: string): string => pathname.split(sep).join('/');
const isReleaseId = (value: unknown): value is `sha256-${string}` =>
  typeof value === 'string' && RELEASE_ID_PATTERN.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort(compareStableText);
  const canonical = [...expected].sort(compareStableText);
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(code);
  }
};

const portablePath = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(code);
  const parts = value.split('/');
  if (value.startsWith('/') || value.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(code);
  }
  return value;
};

const mapNativePath = (sourcePath: string, entryHtml: string, viteManifest: string): string =>
  sourcePath === entryHtml ? 'index.html' : sourcePath === viteManifest ? 'manifest.json' : sourcePath;

const walletSourcePaths = (release: CandidateReleaseManifest): readonly string[] => {
  const application = release.applications.find(({ id }) => id === 'wallet');
  if (!application) throw new Error('NATIVE_WALLET_CANDIDATE_APPLICATION_MISSING');
  return [
    application.entryHtml,
    application.viteManifest,
    ...release.files.filter(({ path }) => path.startsWith(`${application.assetDirectory}/`)).map(({ path }) => path),
    ...release.generatedInputs.filter(({ owner }) => owner === 'wallet').flatMap(({ files }) => files),
  ];
};

export const planNativeWalletCandidate = (
  release: CandidateReleaseManifest,
): NativeWalletCandidateManifest => {
  const application = release.applications.find(({ id }) => id === 'wallet');
  if (!application) throw new Error('NATIVE_WALLET_CANDIDATE_APPLICATION_MISSING');
  const declared = new Map(release.files.map((file) => [file.path, file]));
  const sourcePaths = walletSourcePaths(release);
  if (new Set(sourcePaths).size !== sourcePaths.length) throw new Error('NATIVE_WALLET_CANDIDATE_SOURCE_DUPLICATE');
  const files = sourcePaths.map((sourcePath): NativeWalletCandidateFile => {
    const source = declared.get(sourcePath);
    if (!source) throw new Error(`NATIVE_WALLET_CANDIDATE_SOURCE_MISSING:${sourcePath}`);
    return {
      sourcePath,
      path: mapNativePath(sourcePath, application.entryHtml, application.viteManifest),
      sha256: source.sha256,
      size: source.size,
    };
  }).sort(({ path: left }, { path: right }) => compareStableText(left, right));
  if (new Set(files.map(({ path }) => path)).size !== files.length) {
    throw new Error('NATIVE_WALLET_CANDIDATE_DESTINATION_COLLISION');
  }
  return { schemaVersion: NATIVE_WALLET_CANDIDATE_SCHEMA_VERSION, releaseId: release.releaseId, application: 'wallet', files };
};

const decodeFile = (value: unknown): NativeWalletCandidateFile => {
  if (!isRecord(value)) throw new Error('NATIVE_WALLET_CANDIDATE_FILE_INVALID');
  exactKeys(value, ['sourcePath', 'path', 'sha256', 'size'], 'NATIVE_WALLET_CANDIDATE_FILE_KEYS_INVALID');
  const sourcePath = portablePath(value['sourcePath'], 'NATIVE_WALLET_CANDIDATE_SOURCE_PATH_INVALID');
  const path = portablePath(value['path'], 'NATIVE_WALLET_CANDIDATE_PATH_INVALID');
  const sha256 = value['sha256'];
  const size = value['size'];
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new Error(`NATIVE_WALLET_CANDIDATE_HASH_INVALID:${path}`);
  }
  if (!Number.isSafeInteger(size) || Number(size) < 0) {
    throw new Error(`NATIVE_WALLET_CANDIDATE_SIZE_INVALID:${path}`);
  }
  return { sourcePath, path, sha256, size: Number(size) };
};

const assertCanonicalFiles = (files: readonly NativeWalletCandidateFile[]): void => {
  const paths = files.map(({ path }) => path);
  const sourcePaths = files.map(({ sourcePath }) => sourcePath);
  if (new Set(paths).size !== paths.length || new Set(sourcePaths).size !== sourcePaths.length) {
    throw new Error('NATIVE_WALLET_CANDIDATE_FILE_DUPLICATE');
  }
  if (paths.some((path, index) => index > 0 && compareStableText(paths[index - 1] ?? '', path) >= 0)) {
    throw new Error('NATIVE_WALLET_CANDIDATE_FILES_NONCANONICAL');
  }
  if (!files.some(({ sourcePath, path }) => sourcePath === 'apps/wallet/index.html' && path === 'index.html')) {
    throw new Error('NATIVE_WALLET_CANDIDATE_ENTRY_MISSING');
  }
  if (!files.some(({ sourcePath, path }) => sourcePath === 'apps/wallet/manifest.json' && path === 'manifest.json')) {
    throw new Error('NATIVE_WALLET_CANDIDATE_VITE_MANIFEST_MISSING');
  }
};

const decodeManifest = (value: unknown): NativeWalletCandidateManifest => {
  if (!isRecord(value)) throw new Error('NATIVE_WALLET_CANDIDATE_MANIFEST_INVALID');
  exactKeys(value, ['schemaVersion', 'releaseId', 'application', 'files'], 'NATIVE_WALLET_CANDIDATE_MANIFEST_KEYS_INVALID');
  if (value['schemaVersion'] !== NATIVE_WALLET_CANDIDATE_SCHEMA_VERSION) {
    throw new Error('NATIVE_WALLET_CANDIDATE_SCHEMA_UNSUPPORTED');
  }
  const releaseId = value['releaseId'];
  if (!isReleaseId(releaseId)) {
    throw new Error('NATIVE_WALLET_CANDIDATE_RELEASE_ID_INVALID');
  }
  if (value['application'] !== 'wallet') throw new Error('NATIVE_WALLET_CANDIDATE_APPLICATION_INVALID');
  if (!Array.isArray(value['files']) || value['files'].length === 0) {
    throw new Error('NATIVE_WALLET_CANDIDATE_FILES_INVALID');
  }
  const files = value['files'].map(decodeFile);
  assertCanonicalFiles(files);
  return {
    schemaVersion: NATIVE_WALLET_CANDIDATE_SCHEMA_VERSION,
    releaseId,
    application: 'wallet',
    files,
  };
};

const assertDirectory = async (directory: string): Promise<void> => {
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('NATIVE_WALLET_CANDIDATE_ROOT_INVALID');
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'NATIVE_WALLET_CANDIDATE_ROOT_INVALID') throw error;
    throw new Error('NATIVE_WALLET_CANDIDATE_ROOT_INVALID');
  }
};

const walkFiles = async (root: string, current = root): Promise<readonly string[]> => {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  entries.sort(({ name: left }, { name: right }) => compareStableText(left, right));
  for (const entry of entries) {
    const pathname = join(current, entry.name);
    const relativePath = toPortablePath(relative(root, pathname));
    if (entry.isSymbolicLink()) throw new Error(`NATIVE_WALLET_CANDIDATE_SYMLINK:${relativePath}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, pathname));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`NATIVE_WALLET_CANDIDATE_FILE_TYPE_INVALID:${relativePath}`);
  }
  return files.sort(compareStableText);
};

const readManifest = async (directory: string): Promise<NativeWalletCandidateManifest> => {
  let raw: string;
  try {
    raw = await readFile(join(directory, NATIVE_WALLET_CANDIDATE_MANIFEST), 'utf8');
  } catch {
    throw new Error('NATIVE_WALLET_CANDIDATE_MANIFEST_READ_FAILED');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('NATIVE_WALLET_CANDIDATE_MANIFEST_JSON_INVALID');
  }
  const manifest = decodeManifest(parsed);
  if (raw !== `${safeStringify(manifest, 2)}\n`) throw new Error('NATIVE_WALLET_CANDIDATE_MANIFEST_NONCANONICAL');
  return manifest;
};

export const verifyNativeWalletCandidateDirectory = async (
  directory: string,
  expectedReleaseId: string,
): Promise<NativeWalletCandidateManifest> => {
  if (!RELEASE_ID_PATTERN.test(expectedReleaseId)) throw new Error('NATIVE_WALLET_CANDIDATE_EXPECTED_ID_INVALID');
  await assertDirectory(directory);
  const manifest = await readManifest(directory);
  if (manifest.releaseId !== expectedReleaseId || basename(directory) !== expectedReleaseId) {
    throw new Error('NATIVE_WALLET_CANDIDATE_RELEASE_ID_MISMATCH');
  }
  const actualPaths = await walkFiles(directory);
  const expectedPaths = [...manifest.files.map(({ path }) => path), NATIVE_WALLET_CANDIDATE_MANIFEST]
    .sort(compareStableText);
  if (safeStringify(actualPaths) !== safeStringify(expectedPaths)) {
    throw new Error('NATIVE_WALLET_CANDIDATE_FILE_SET_MISMATCH');
  }
  for (const file of manifest.files) {
    const bytes = await readFile(join(directory, file.path));
    if (bytes.byteLength !== file.size || hashBytes(bytes) !== file.sha256) {
      throw new Error(`NATIVE_WALLET_CANDIDATE_FILE_MISMATCH:${file.path}`);
    }
  }
  return manifest;
};
