import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { compareStableText, safeStringify } from '../../core/protocol/serialization';
import { assertNativeWalletContentSecurityPolicy, createNativeCapacitorConfig } from './capacitor-candidate';
import {
  snapshotRegularTree as snapshotTree,
  type RegularTreeFile,
} from './regular-tree';
import { verifyNativeWalletCandidateDirectory } from './wallet-candidate-manifest';

export const CAPACITOR_SHELL_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const CAPACITOR_SHELL_CANDIDATE_MANIFEST = 'capacitor-shell-candidate.json';
export const CAPACITOR_SHELL_CANDIDATE_ROOT = resolve(
  import.meta.dir,
  '../../frontend/.artifacts/capacitor-shell-candidates',
);

export type { RegularTreeFile } from './regular-tree';

type SourceShellDigests = Readonly<{ ios: string; android: string }>;

export type CapacitorShellCandidateManifest = Readonly<{
  schemaVersion: typeof CAPACITOR_SHELL_CANDIDATE_SCHEMA_VERSION;
  releaseId: `sha256-${string}`;
  workspaceId: `sha256-${string}`;
  sourceShells: SourceShellDigests;
  configSha256: string;
  files: readonly RegularTreeFile[];
}>;

export type CapacitorShellCandidatePlan = Readonly<{
  releaseId: `sha256-${string}`;
  workspaceId: `sha256-${string}`;
  workspaceDirectory: string;
  sourceShells: SourceShellDigests;
  config: ReturnType<typeof createNativeCapacitorConfig>;
  configText: string;
}>;

const FRONTEND_ROOT = resolve(import.meta.dir, '../../frontend');
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_ID_PATTERN = /^sha256-[0-9a-f]{64}$/u;
const hashBytes = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort(compareStableText);
  const canonical = [...expected].sort(compareStableText);
  if (safeStringify(actual) !== safeStringify(canonical)) throw new Error(code);
};

const assertPlainDirectory = async (directory: string, code: string): Promise<void> => {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(code);
};

export const snapshotRegularTree = async (
  root: string,
  current = root,
): Promise<readonly RegularTreeFile[]> => snapshotTree(root, current, 'CAPACITOR_SHELL');

const treeDigest = (files: readonly RegularTreeFile[]): string => hashBytes(safeStringify(files));

const sourceShellDigests = async (): Promise<SourceShellDigests> => {
  const [ios, android] = await Promise.all([
    snapshotRegularTree(join(FRONTEND_ROOT, 'ios')),
    snapshotRegularTree(join(FRONTEND_ROOT, 'android')),
  ]);
  return { ios: treeDigest(ios), android: treeDigest(android) };
};

export const createCapacitorShellCandidatePlan = async (
  stagingDirectory: string,
  outputRoot = CAPACITOR_SHELL_CANDIDATE_ROOT,
): Promise<CapacitorShellCandidatePlan> => {
  const releaseId = basename(stagingDirectory);
  if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error('CAPACITOR_SHELL_RELEASE_ID_INVALID');
  await verifyNativeWalletCandidateDirectory(stagingDirectory, releaseId);
  assertNativeWalletContentSecurityPolicy(await readFile(join(stagingDirectory, 'index.html'), 'utf8'));
  const sourceShells = await sourceShellDigests();
  const provisionalDirectory = join(outputRoot, releaseId, 'workspace');
  const config = createNativeCapacitorConfig(provisionalDirectory, stagingDirectory);
  const configText = `${safeStringify(config, 2)}\n`;
  const workspaceId = `sha256-${hashBytes(safeStringify({ releaseId, sourceShells, configSha256: hashBytes(configText) }))}`;
  return {
    releaseId: releaseId as `sha256-${string}`,
    workspaceId: workspaceId as `sha256-${string}`,
    workspaceDirectory: join(outputRoot, releaseId, workspaceId),
    sourceShells,
    config,
    configText,
  };
};

const decodeTreeFile = (value: unknown): RegularTreeFile => {
  if (!isRecord(value)) throw new Error('CAPACITOR_SHELL_MANIFEST_FILE_INVALID');
  exactKeys(value, ['path', 'sha256', 'size', 'mode'], 'CAPACITOR_SHELL_MANIFEST_FILE_KEYS_INVALID');
  const path = value['path'];
  const sha256 = value['sha256'];
  const size = value['size'];
  const mode = value['mode'];
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('CAPACITOR_SHELL_MANIFEST_PATH_INVALID');
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new Error(`CAPACITOR_SHELL_MANIFEST_HASH_INVALID:${path}`);
  }
  if (!Number.isSafeInteger(size) || Number(size) < 0 || !Number.isSafeInteger(mode) || Number(mode) < 0) {
    throw new Error(`CAPACITOR_SHELL_MANIFEST_METADATA_INVALID:${path}`);
  }
  return { path, sha256, size: Number(size), mode: Number(mode) };
};

const decodeManifest = (value: unknown): CapacitorShellCandidateManifest => {
  if (!isRecord(value)) throw new Error('CAPACITOR_SHELL_MANIFEST_INVALID');
  exactKeys(
    value,
    ['schemaVersion', 'releaseId', 'workspaceId', 'sourceShells', 'configSha256', 'files'],
    'CAPACITOR_SHELL_MANIFEST_KEYS_INVALID',
  );
  if (value['schemaVersion'] !== CAPACITOR_SHELL_CANDIDATE_SCHEMA_VERSION) {
    throw new Error('CAPACITOR_SHELL_SCHEMA_UNSUPPORTED');
  }
  const releaseId = value['releaseId'];
  const workspaceId = value['workspaceId'];
  const configSha256 = value['configSha256'];
  const sources = value['sourceShells'];
  if (typeof releaseId !== 'string' || !RELEASE_ID_PATTERN.test(releaseId) ||
    typeof workspaceId !== 'string' || !RELEASE_ID_PATTERN.test(workspaceId)) {
    throw new Error('CAPACITOR_SHELL_ID_INVALID');
  }
  if (typeof configSha256 !== 'string' || !SHA256_PATTERN.test(configSha256) || !isRecord(sources)) {
    throw new Error('CAPACITOR_SHELL_INPUT_DIGEST_INVALID');
  }
  exactKeys(sources, ['ios', 'android'], 'CAPACITOR_SHELL_SOURCE_KEYS_INVALID');
  if (typeof sources['ios'] !== 'string' || !SHA256_PATTERN.test(sources['ios']) ||
    typeof sources['android'] !== 'string' || !SHA256_PATTERN.test(sources['android'])) {
    throw new Error('CAPACITOR_SHELL_SOURCE_DIGEST_INVALID');
  }
  if (!Array.isArray(value['files']) || value['files'].length === 0) throw new Error('CAPACITOR_SHELL_FILES_INVALID');
  const files = value['files'].map(decodeTreeFile);
  if (files.some(({ path }, index) => index > 0 && compareStableText(files[index - 1]?.path ?? '', path) >= 0)) {
    throw new Error('CAPACITOR_SHELL_FILES_NONCANONICAL');
  }
  return {
    schemaVersion: CAPACITOR_SHELL_CANDIDATE_SCHEMA_VERSION,
    releaseId: releaseId as `sha256-${string}`,
    workspaceId: workspaceId as `sha256-${string}`,
    sourceShells: { ios: sources['ios'], android: sources['android'] },
    configSha256,
    files,
  };
};

const readManifest = async (workspaceDirectory: string): Promise<CapacitorShellCandidateManifest> => {
  const pathname = join(workspaceDirectory, CAPACITOR_SHELL_CANDIDATE_MANIFEST);
  const stats = await lstat(pathname);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('CAPACITOR_SHELL_MANIFEST_FILE_INVALID');
  const raw = await readFile(pathname, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('CAPACITOR_SHELL_MANIFEST_JSON_INVALID');
  }
  const manifest = decodeManifest(value);
  if (raw !== `${safeStringify(manifest, 2)}\n`) throw new Error('CAPACITOR_SHELL_MANIFEST_NONCANONICAL');
  return manifest;
};

const comparableWebFiles = (files: readonly RegularTreeFile[]) =>
  files.map(({ path, sha256, size }) => ({ path, sha256, size }));

const verifyCopiedWebRoot = async (stagingDirectory: string, webRoot: string): Promise<void> => {
  const [source, copied] = await Promise.all([
    snapshotRegularTree(stagingDirectory),
    snapshotRegularTree(webRoot),
  ]);
  const emptyHash = hashBytes('');
  const expected = [
    ...comparableWebFiles(source),
    { path: 'cordova.js', sha256: emptyHash, size: 0 },
    { path: 'cordova_plugins.js', sha256: emptyHash, size: 0 },
  ].sort(({ path: left }, { path: right }) => compareStableText(left, right));
  if (safeStringify(comparableWebFiles(copied)) !== safeStringify(expected)) {
    throw new Error('CAPACITOR_SHELL_WEB_ROOT_MISMATCH');
  }
};

const verifyPreservedShellFiles = async (workspaceDirectory: string): Promise<void> => {
  const [sourceIos, sourceAndroid, copiedIos, copiedAndroid] = await Promise.all([
    snapshotRegularTree(join(FRONTEND_ROOT, 'ios')),
    snapshotRegularTree(join(FRONTEND_ROOT, 'android')),
    snapshotRegularTree(join(workspaceDirectory, 'ios')),
    snapshotRegularTree(join(workspaceDirectory, 'android')),
  ]);
  const preservedIos = copiedIos.filter(({ path }) =>
    path !== 'App/App/capacitor.config.json' && path !== 'App/App/config.xml' && !path.startsWith('App/App/public/'));
  const preservedAndroid = copiedAndroid.filter(({ path }) =>
    path !== 'app/src/main/assets/capacitor.config.json' &&
    path !== 'app/src/main/res/xml/config.xml' &&
    !path.startsWith('app/src/main/assets/public/'));
  if (safeStringify(preservedIos) !== safeStringify(sourceIos) ||
    safeStringify(preservedAndroid) !== safeStringify(sourceAndroid)) {
    throw new Error('CAPACITOR_SHELL_SOURCE_COPY_MISMATCH');
  }
};

const verifyGeneratedConfig = async (
  pathname: string,
  expected: CapacitorShellCandidatePlan['config'],
  ios: boolean,
): Promise<void> => {
  const value = JSON.parse(await readFile(pathname, 'utf8')) as unknown;
  if (!isRecord(value)) throw new Error('CAPACITOR_SHELL_CONFIG_INVALID');
  const packageClassList = value['packageClassList'];
  const base = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'packageClassList'));
  if (safeStringify(base) !== safeStringify(expected)) throw new Error('CAPACITOR_SHELL_CONFIG_MISMATCH');
  if (ios) {
    if (!Array.isArray(packageClassList) || packageClassList.length === 0 ||
      packageClassList.some((item) => typeof item !== 'string' || !item) ||
      new Set(packageClassList).size !== packageClassList.length) {
      throw new Error('CAPACITOR_SHELL_IOS_PLUGIN_CLASSES_INVALID');
    }
  } else if (packageClassList !== undefined) throw new Error('CAPACITOR_SHELL_ANDROID_CONFIG_KEYS_INVALID');
};

export const verifyCapacitorShellCandidateDirectory = async (
  workspaceDirectory: string,
  stagingDirectory: string,
  outputRoot = CAPACITOR_SHELL_CANDIDATE_ROOT,
  requireWorkspaceId = true,
): Promise<CapacitorShellCandidateManifest> => {
  const plan = await createCapacitorShellCandidatePlan(stagingDirectory, outputRoot);
  await assertPlainDirectory(workspaceDirectory, 'CAPACITOR_SHELL_WORKSPACE_INVALID');
  if (requireWorkspaceId && resolve(workspaceDirectory) !== resolve(plan.workspaceDirectory)) {
    throw new Error('CAPACITOR_SHELL_WORKSPACE_ID_MISMATCH');
  }
  const manifest = await readManifest(workspaceDirectory);
  const inputEvidence = {
    releaseId: manifest.releaseId,
    workspaceId: manifest.workspaceId,
    sourceShells: manifest.sourceShells,
    configSha256: manifest.configSha256,
  };
  const expectedEvidence = {
    releaseId: plan.releaseId,
    workspaceId: plan.workspaceId,
    sourceShells: plan.sourceShells,
    configSha256: hashBytes(plan.configText),
  };
  if (safeStringify(inputEvidence) !== safeStringify(expectedEvidence)) {
    throw new Error('CAPACITOR_SHELL_INPUT_EVIDENCE_MISMATCH');
  }
  const actualFiles = (await snapshotRegularTree(workspaceDirectory))
    .filter(({ path }) => path !== CAPACITOR_SHELL_CANDIDATE_MANIFEST);
  if (safeStringify(actualFiles) !== safeStringify(manifest.files)) throw new Error('CAPACITOR_SHELL_FILE_SET_MISMATCH');
  await Promise.all([
    verifyCopiedWebRoot(stagingDirectory, join(workspaceDirectory, 'ios/App/App/public')),
    verifyCopiedWebRoot(stagingDirectory, join(workspaceDirectory, 'android/app/src/main/assets/public')),
    verifyGeneratedConfig(join(workspaceDirectory, 'ios/App/App/capacitor.config.json'), plan.config, true),
    verifyGeneratedConfig(join(workspaceDirectory, 'android/app/src/main/assets/capacitor.config.json'), plan.config, false),
    verifyPreservedShellFiles(workspaceDirectory),
  ]);
  const [plist, androidManifest] = await Promise.all([
    readFile(join(workspaceDirectory, 'ios/App/App/Info.plist'), 'utf8'),
    readFile(join(workspaceDirectory, 'android/app/src/main/AndroidManifest.xml'), 'utf8'),
  ]);
  if (!plist.includes('<string>xln</string>') || !androidManifest.includes('<data android:scheme="xln" />')) {
    throw new Error('CAPACITOR_SHELL_DEEP_LINK_MISSING');
  }
  return manifest;
};
