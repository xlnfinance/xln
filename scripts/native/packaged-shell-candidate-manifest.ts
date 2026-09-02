import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { compareStableText, safeStringify } from '../../core/protocol/serialization';
import { assertNativeWalletContentSecurityPolicy } from './capacitor-candidate';
import { verifyPackagedShellPolicy } from './packaged-shell-policy';
import { snapshotRegularTree, type RegularTreeFile } from './regular-tree';
import {
  NATIVE_WALLET_CANDIDATE_MANIFEST,
  verifyNativeWalletCandidateDirectory,
} from './wallet-candidate-manifest';

export const PACKAGED_SHELL_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const PACKAGED_SHELL_CANDIDATE_MANIFEST = 'packaged-shell-candidate.json';
export const PACKAGED_SHELL_CANDIDATE_ROOT = resolve(import.meta.dir, '../../native/dist/packaged-candidates');

type SourceShellDigests = Readonly<{ desktop: string; extension: string }>;
export type PackagedShellCandidateManifest = Readonly<{
  schemaVersion: typeof PACKAGED_SHELL_CANDIDATE_SCHEMA_VERSION;
  releaseId: `sha256-${string}`;
  workspaceId: `sha256-${string}`;
  sourceShells: SourceShellDigests;
  desktopPackageSha256: string;
  layoutSha256: string;
  files: readonly RegularTreeFile[];
}>;

export type PackagedShellCopy = Readonly<{
  sourcePath: string;
  destinationPath: string;
  file: RegularTreeFile;
}>;

export type PackagedShellCandidatePlan = Readonly<{
  releaseId: `sha256-${string}`;
  workspaceId: `sha256-${string}`;
  workspaceDirectory: string;
  sourceShells: SourceShellDigests;
  desktopPackageText: string;
  desktopPackageSha256: string;
  layoutSha256: string;
  copyFiles: readonly PackagedShellCopy[];
  expectedFiles: readonly RegularTreeFile[];
}>;

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const DESKTOP_SOURCE = join(REPOSITORY_ROOT, 'native/desktop');
const EXTENSION_SOURCE = join(REPOSITORY_ROOT, 'native/extension');
const EXTENSION_SHELL_FILES = ['extension-security.js', 'extension-service-worker.js', 'manifest.json'] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_ID_PATTERN = /^sha256-[0-9a-f]{64}$/u;
const hashBytes = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const treeDigest = (files: readonly RegularTreeFile[]): string => hashBytes(safeStringify(files));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort(compareStableText);
  const canonical = [...expected].sort(compareStableText);
  if (safeStringify(actual) !== safeStringify(canonical)) throw new Error(code);
};

const destinationFile = (source: RegularTreeFile, path: string): RegularTreeFile => ({ ...source, path });
const packageFile = (text: string): RegularTreeFile => ({
  path: 'desktop/package.json',
  sha256: hashBytes(text),
  size: Buffer.byteLength(text),
  mode: 0o644,
});

const sourceFile = (files: readonly RegularTreeFile[], path: string, code: string): RegularTreeFile => {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`${code}:${path}`);
  return file;
};

const copy = (sourceRoot: string, source: RegularTreeFile, destinationPath: string): PackagedShellCopy => ({
  sourcePath: join(sourceRoot, source.path),
  destinationPath,
  file: destinationFile(source, destinationPath),
});

const extensionStagePath = (path: string): string => path === 'index.html' ? 'app.html' : path;

const assertCanonicalLayout = (files: readonly RegularTreeFile[]): void => {
  const paths = files.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) throw new Error('PACKAGED_CANDIDATE_DESTINATION_COLLISION');
  if (paths.some((path, index) => index > 0 && compareStableText(paths[index - 1] ?? '', path) >= 0)) {
    throw new Error('PACKAGED_CANDIDATE_FILES_NONCANONICAL');
  }
};

export const createPackagedShellCandidatePlan = async (
  stagingDirectory: string,
  outputRoot = PACKAGED_SHELL_CANDIDATE_ROOT,
): Promise<PackagedShellCandidatePlan> => {
  const releaseId = basename(stagingDirectory);
  if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error('PACKAGED_CANDIDATE_RELEASE_ID_INVALID');
  await verifyNativeWalletCandidateDirectory(stagingDirectory, releaseId);
  assertNativeWalletContentSecurityPolicy(await readFile(join(stagingDirectory, 'index.html'), 'utf8'));
  const [stageFiles, desktopFiles, extensionTree, version] = await Promise.all([
    snapshotRegularTree(stagingDirectory, stagingDirectory, 'PACKAGED_CANDIDATE'),
    snapshotRegularTree(DESKTOP_SOURCE, DESKTOP_SOURCE, 'PACKAGED_CANDIDATE'),
    snapshotRegularTree(EXTENSION_SOURCE, EXTENSION_SOURCE, 'PACKAGED_CANDIDATE'),
    readFile(join(REPOSITORY_ROOT, 'VERSION'), 'utf8').then((value) => value.trim()),
  ]);
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('PACKAGED_CANDIDATE_VERSION_INVALID');
  const extensionFiles = EXTENSION_SHELL_FILES.map((path) =>
    sourceFile(extensionTree, path, 'PACKAGED_CANDIDATE_EXTENSION_SOURCE_MISSING'));
  const icon = sourceFile(stageFiles, 'android-chrome-192x192.png', 'PACKAGED_CANDIDATE_ICON_MISSING');
  const desktopPackageText = `${safeStringify({
    name: 'xln-wallet-desktop', version, main: 'native/desktop/main.cjs', private: true,
  }, 2)}\n`;
  const desktopCopies = [
    ...desktopFiles.map((file) => copy(DESKTOP_SOURCE, file, `desktop/native/desktop/${file.path}`)),
    ...stageFiles.map((file) => copy(stagingDirectory, file, `desktop/frontend/build/${file.path}`)),
  ];
  const extensionCopies = [
    ...extensionFiles.map((file) => copy(EXTENSION_SOURCE, file, `extension/${file.path}`)),
    ...stageFiles.filter(({ path }) =>
      path !== 'manifest.json' && path !== NATIVE_WALLET_CANDIDATE_MANIFEST)
      .map((file) => copy(stagingDirectory, file, `extension/${extensionStagePath(file.path)}`)),
    copy(stagingDirectory, icon, 'extension/icon-128.png'),
  ];
  const copyFiles = [...desktopCopies, ...extensionCopies]
    .sort(({ destinationPath: left }, { destinationPath: right }) => compareStableText(left, right));
  const expectedFiles = [...copyFiles.map(({ file }) => file), packageFile(desktopPackageText)]
    .sort(({ path: left }, { path: right }) => compareStableText(left, right));
  assertCanonicalLayout(expectedFiles);
  const sourceShells = { desktop: treeDigest(desktopFiles), extension: treeDigest(extensionFiles) };
  const desktopPackageSha256 = hashBytes(desktopPackageText);
  const layoutSha256 = treeDigest(expectedFiles);
  const workspaceId = `sha256-${hashBytes(safeStringify({
    schemaVersion: PACKAGED_SHELL_CANDIDATE_SCHEMA_VERSION,
    releaseId,
    sourceShells,
    desktopPackageSha256,
    layoutSha256,
  }))}` as const;
  return {
    releaseId: releaseId as `sha256-${string}`,
    workspaceId,
    workspaceDirectory: join(outputRoot, releaseId, workspaceId),
    sourceShells,
    desktopPackageText,
    desktopPackageSha256,
    layoutSha256,
    copyFiles,
    expectedFiles,
  };
};

const decodeFile = (value: unknown): RegularTreeFile => {
  if (!isRecord(value)) throw new Error('PACKAGED_CANDIDATE_MANIFEST_FILE_INVALID');
  exactKeys(value, ['path', 'sha256', 'size', 'mode'], 'PACKAGED_CANDIDATE_MANIFEST_FILE_KEYS_INVALID');
  const path = value['path'];
  const sha256 = value['sha256'];
  const size = value['size'];
  const mode = value['mode'];
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('PACKAGED_CANDIDATE_MANIFEST_PATH_INVALID');
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new Error(`PACKAGED_CANDIDATE_MANIFEST_HASH_INVALID:${path}`);
  }
  if (!Number.isSafeInteger(size) || Number(size) < 0 || !Number.isSafeInteger(mode) ||
    Number(mode) < 0 || Number(mode) > 0o777) {
    throw new Error(`PACKAGED_CANDIDATE_MANIFEST_METADATA_INVALID:${path}`);
  }
  return { path, sha256, size: Number(size), mode: Number(mode) };
};

const decodeManifest = (value: unknown): PackagedShellCandidateManifest => {
  if (!isRecord(value)) throw new Error('PACKAGED_CANDIDATE_MANIFEST_INVALID');
  exactKeys(value, [
    'schemaVersion', 'releaseId', 'workspaceId', 'sourceShells',
    'desktopPackageSha256', 'layoutSha256', 'files',
  ], 'PACKAGED_CANDIDATE_MANIFEST_KEYS_INVALID');
  const releaseId = value['releaseId'];
  const workspaceId = value['workspaceId'];
  const sourceShells = value['sourceShells'];
  if (value['schemaVersion'] !== PACKAGED_SHELL_CANDIDATE_SCHEMA_VERSION ||
    typeof releaseId !== 'string' || !RELEASE_ID_PATTERN.test(releaseId) ||
    typeof workspaceId !== 'string' || !RELEASE_ID_PATTERN.test(workspaceId) || !isRecord(sourceShells)) {
    throw new Error('PACKAGED_CANDIDATE_MANIFEST_IDENTITY_INVALID');
  }
  exactKeys(sourceShells, ['desktop', 'extension'], 'PACKAGED_CANDIDATE_SOURCE_KEYS_INVALID');
  const desktop = sourceShells['desktop'];
  const extension = sourceShells['extension'];
  const desktopPackageSha256 = value['desktopPackageSha256'];
  const layoutSha256 = value['layoutSha256'];
  if ([desktop, extension, desktopPackageSha256, layoutSha256]
    .some((item) => typeof item !== 'string' || !SHA256_PATTERN.test(item))) {
    throw new Error('PACKAGED_CANDIDATE_MANIFEST_DIGEST_INVALID');
  }
  if (!Array.isArray(value['files']) || value['files'].length === 0) {
    throw new Error('PACKAGED_CANDIDATE_MANIFEST_FILES_INVALID');
  }
  const files = value['files'].map(decodeFile);
  assertCanonicalLayout(files);
  return {
    schemaVersion: PACKAGED_SHELL_CANDIDATE_SCHEMA_VERSION,
    releaseId: releaseId as `sha256-${string}`,
    workspaceId: workspaceId as `sha256-${string}`,
    sourceShells: { desktop: desktop as string, extension: extension as string },
    desktopPackageSha256: desktopPackageSha256 as string,
    layoutSha256: layoutSha256 as string,
    files,
  };
};

const readManifest = async (directory: string): Promise<PackagedShellCandidateManifest> => {
  const pathname = join(directory, PACKAGED_SHELL_CANDIDATE_MANIFEST);
  const stats = await lstat(pathname);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('PACKAGED_CANDIDATE_MANIFEST_FILE_INVALID');
  const raw = await readFile(pathname, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('PACKAGED_CANDIDATE_MANIFEST_JSON_INVALID');
  }
  const manifest = decodeManifest(value);
  if (raw !== `${safeStringify(manifest, 2)}\n`) throw new Error('PACKAGED_CANDIDATE_MANIFEST_NONCANONICAL');
  return manifest;
};

export const verifyPackagedShellCandidateDirectory = async (
  workspaceDirectory: string,
  stagingDirectory: string,
  outputRoot = PACKAGED_SHELL_CANDIDATE_ROOT,
  requireWorkspaceId = true,
): Promise<PackagedShellCandidateManifest> => {
  const plan = await createPackagedShellCandidatePlan(stagingDirectory, outputRoot);
  const stats = await lstat(workspaceDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('PACKAGED_CANDIDATE_WORKSPACE_INVALID');
  if (requireWorkspaceId && resolve(workspaceDirectory) !== resolve(plan.workspaceDirectory)) {
    throw new Error('PACKAGED_CANDIDATE_WORKSPACE_ID_MISMATCH');
  }
  const manifest = await readManifest(workspaceDirectory);
  const expected: PackagedShellCandidateManifest = {
    schemaVersion: PACKAGED_SHELL_CANDIDATE_SCHEMA_VERSION,
    releaseId: plan.releaseId,
    workspaceId: plan.workspaceId,
    sourceShells: plan.sourceShells,
    desktopPackageSha256: plan.desktopPackageSha256,
    layoutSha256: plan.layoutSha256,
    files: plan.expectedFiles,
  };
  if (safeStringify(manifest) !== safeStringify(expected)) throw new Error('PACKAGED_CANDIDATE_INPUT_EVIDENCE_MISMATCH');
  const actualFiles = (await snapshotRegularTree(workspaceDirectory, workspaceDirectory, 'PACKAGED_CANDIDATE'))
    .filter(({ path }) => path !== PACKAGED_SHELL_CANDIDATE_MANIFEST);
  if (safeStringify(actualFiles) !== safeStringify(manifest.files) || treeDigest(actualFiles) !== manifest.layoutSha256) {
    throw new Error('PACKAGED_CANDIDATE_FILE_SET_MISMATCH');
  }
  await verifyPackagedShellPolicy(workspaceDirectory, plan.desktopPackageText);
  return manifest;
};
