import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import canonicalCapacitorConfig from '../../frontend/capacitor.config';
import { CONTENT_SECURITY_POLICY_HTML_ATTRIBUTE } from '../../frontend/config/content-security-policy.js';
import { safeStringify } from '../../core/protocol/serialization';
import { verifyNativeWalletCandidateDirectory } from './wallet-candidate-manifest';

export const NATIVE_CAPACITOR_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const NATIVE_CAPACITOR_CANDIDATE_MANIFEST = 'native-capacitor-candidate.json';
export const NATIVE_CAPACITOR_CONFIG = 'capacitor.config.json';

export type NativeCapacitorCandidateManifest = Readonly<{
  schemaVersion: typeof NATIVE_CAPACITOR_CANDIDATE_SCHEMA_VERSION;
  releaseId: `sha256-${string}`;
  webDir: string;
  configSha256: string;
}>;

export type NativeCapacitorCandidateResult = Readonly<{
  releaseId: `sha256-${string}`;
  workspaceDirectory: string;
  status: 'created' | 'reused';
  manifest: NativeCapacitorCandidateManifest;
}>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_ID_PATTERN = /^sha256-[0-9a-f]{64}$/u;
const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');
const toPortablePath = (pathname: string): string => pathname.split(sep).join('/');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (safeStringify(actual) !== safeStringify(canonical)) throw new Error(code);
};

const readQuotedAttributes = (tag: string, attribute: string): readonly string[] =>
  [...tag.matchAll(new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'giu'))]
    .map((match) => match[1] ?? match[2] ?? '');

const readQuotedAttribute = (tag: string, attribute: string): string | null =>
  readQuotedAttributes(tag, attribute)[0] ?? null;

export const assertNativeWalletContentSecurityPolicy = (html: string): void => {
  const policyTags = [...html.matchAll(/<meta\b[^>]*>/giu)]
    .map(([tag]) => tag)
    .filter((tag) => readQuotedAttribute(tag, 'http-equiv')?.toLowerCase() === 'content-security-policy');
  if (policyTags.length !== 1) throw new Error(`NATIVE_CAPACITOR_CSP_META_COUNT:${policyTags.length}`);
  const policyTag = policyTags[0] ?? '';
  if (readQuotedAttributes(policyTag, 'http-equiv').length !== 1 ||
    readQuotedAttributes(policyTag, 'content').length !== 1 ||
    readQuotedAttribute(policyTag, 'content') !== CONTENT_SECURITY_POLICY_HTML_ATTRIBUTE) {
    throw new Error('NATIVE_CAPACITOR_CSP_MISMATCH');
  }
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
    if (readQuotedAttribute(script[1] ?? '', 'src') === null || (script[2] ?? '').trim()) {
      throw new Error('NATIVE_CAPACITOR_INLINE_SCRIPT_FORBIDDEN');
    }
  }
};

export const createNativeCapacitorConfig = (workspaceDirectory: string, stagingDirectory: string) => ({
  ...canonicalCapacitorConfig,
  webDir: toPortablePath(relative(workspaceDirectory, stagingDirectory)),
});

const manifestFor = (workspaceDirectory: string, stagingDirectory: string): NativeCapacitorCandidateManifest => {
  const releaseId = basename(stagingDirectory);
  if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error('NATIVE_CAPACITOR_RELEASE_ID_INVALID');
  const config = createNativeCapacitorConfig(workspaceDirectory, stagingDirectory);
  const configText = `${safeStringify(config, 2)}\n`;
  return {
    schemaVersion: NATIVE_CAPACITOR_CANDIDATE_SCHEMA_VERSION,
    releaseId: releaseId as `sha256-${string}`,
    webDir: config.webDir,
    configSha256: hashText(configText),
  };
};

const decodeManifest = (value: unknown): NativeCapacitorCandidateManifest => {
  if (!isRecord(value)) throw new Error('NATIVE_CAPACITOR_MANIFEST_INVALID');
  exactKeys(
    value,
    ['schemaVersion', 'releaseId', 'webDir', 'configSha256'],
    'NATIVE_CAPACITOR_MANIFEST_KEYS_INVALID',
  );
  if (value['schemaVersion'] !== NATIVE_CAPACITOR_CANDIDATE_SCHEMA_VERSION) {
    throw new Error('NATIVE_CAPACITOR_SCHEMA_UNSUPPORTED');
  }
  const releaseId = value['releaseId'];
  const webDir = value['webDir'];
  const configSha256 = value['configSha256'];
  if (typeof releaseId !== 'string' || !RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error('NATIVE_CAPACITOR_RELEASE_ID_INVALID');
  }
  if (typeof webDir !== 'string' || !webDir || webDir.includes('\\') || webDir.startsWith('/')) {
    throw new Error('NATIVE_CAPACITOR_WEB_DIR_INVALID');
  }
  if (typeof configSha256 !== 'string' || !SHA256_PATTERN.test(configSha256)) {
    throw new Error('NATIVE_CAPACITOR_CONFIG_HASH_INVALID');
  }
  return {
    schemaVersion: NATIVE_CAPACITOR_CANDIDATE_SCHEMA_VERSION,
    releaseId: releaseId as `sha256-${string}`,
    webDir,
    configSha256,
  };
};

const pathExists = async (pathname: string): Promise<boolean> => {
  try {
    await lstat(pathname);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const assertPlainDirectory = async (directory: string): Promise<void> => {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('NATIVE_CAPACITOR_WORKSPACE_INVALID');
};

const readCanonicalJson = async (pathname: string, code: string): Promise<unknown> => {
  let raw: string;
  try {
    raw = await readFile(pathname, 'utf8');
  } catch {
    throw new Error(`${code}_READ_FAILED`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${code}_JSON_INVALID`);
  }
  if (raw !== `${safeStringify(parsed, 2)}\n`) throw new Error(`${code}_NONCANONICAL`);
  return parsed;
};

const verifyWorkspace = async (
  workspaceDirectory: string,
  stagingDirectory: string,
  requireReleaseBasename: boolean,
): Promise<NativeCapacitorCandidateManifest> => {
  await assertPlainDirectory(workspaceDirectory);
  const releaseId = basename(stagingDirectory);
  if (requireReleaseBasename && basename(workspaceDirectory) !== releaseId) {
    throw new Error('NATIVE_CAPACITOR_WORKSPACE_RELEASE_MISMATCH');
  }
  const expectedConfig = createNativeCapacitorConfig(workspaceDirectory, stagingDirectory);
  if (resolve(workspaceDirectory, expectedConfig.webDir) !== resolve(stagingDirectory)) {
    throw new Error('NATIVE_CAPACITOR_WEB_DIR_MISMATCH');
  }
  const entries = await readdir(workspaceDirectory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile()) || safeStringify(entries.map(({ name }) => name).sort()) !==
    safeStringify([NATIVE_CAPACITOR_CANDIDATE_MANIFEST, NATIVE_CAPACITOR_CONFIG].sort())) {
    throw new Error('NATIVE_CAPACITOR_WORKSPACE_FILE_SET_MISMATCH');
  }
  const configValue = await readCanonicalJson(join(workspaceDirectory, NATIVE_CAPACITOR_CONFIG), 'NATIVE_CAPACITOR_CONFIG');
  if (safeStringify(configValue) !== safeStringify(expectedConfig)) throw new Error('NATIVE_CAPACITOR_CONFIG_MISMATCH');
  const manifestValue = await readCanonicalJson(
    join(workspaceDirectory, NATIVE_CAPACITOR_CANDIDATE_MANIFEST),
    'NATIVE_CAPACITOR_MANIFEST',
  );
  const manifest = decodeManifest(manifestValue);
  const expectedManifest = manifestFor(workspaceDirectory, stagingDirectory);
  if (safeStringify(manifest) !== safeStringify(expectedManifest)) throw new Error('NATIVE_CAPACITOR_MANIFEST_MISMATCH');
  return manifest;
};

export const verifyNativeCapacitorCandidateDirectory = async (
  workspaceDirectory: string,
  stagingDirectory: string,
): Promise<NativeCapacitorCandidateManifest> => {
  const releaseId = basename(stagingDirectory);
  await verifyNativeWalletCandidateDirectory(stagingDirectory, releaseId);
  assertNativeWalletContentSecurityPolicy(await readFile(join(stagingDirectory, 'index.html'), 'utf8'));
  return verifyWorkspace(workspaceDirectory, stagingDirectory, true);
};

const writeWorkspace = async (workspaceDirectory: string, stagingDirectory: string): Promise<void> => {
  const config = createNativeCapacitorConfig(workspaceDirectory, stagingDirectory);
  const manifest = manifestFor(workspaceDirectory, stagingDirectory);
  await writeFile(join(workspaceDirectory, NATIVE_CAPACITOR_CONFIG), `${safeStringify(config, 2)}\n`);
  await writeFile(
    join(workspaceDirectory, NATIVE_CAPACITOR_CANDIDATE_MANIFEST),
    `${safeStringify(manifest, 2)}\n`,
  );
  await verifyWorkspace(workspaceDirectory, stagingDirectory, false);
};

const isDestinationExistsError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY');

export const prepareNativeCapacitorCandidate = async (
  stagingDirectory: string,
): Promise<NativeCapacitorCandidateResult> => {
  const releaseId = basename(stagingDirectory);
  await verifyNativeWalletCandidateDirectory(stagingDirectory, releaseId);
  assertNativeWalletContentSecurityPolicy(await readFile(join(stagingDirectory, 'index.html'), 'utf8'));
  const workspaceRoot = join(dirname(stagingDirectory), '.capacitor');
  const workspaceDirectory = join(workspaceRoot, releaseId);
  await mkdir(workspaceRoot, { recursive: true });
  await assertPlainDirectory(workspaceRoot);
  if (await pathExists(workspaceDirectory)) {
    const manifest = await verifyWorkspace(workspaceDirectory, stagingDirectory, true);
    return { releaseId: manifest.releaseId, workspaceDirectory, status: 'reused', manifest };
  }
  const temporaryDirectory = await mkdtemp(join(workspaceRoot, '.native-capacitor-candidate-'));
  try {
    await writeWorkspace(temporaryDirectory, stagingDirectory);
    try {
      await rename(temporaryDirectory, workspaceDirectory);
    } catch (error: unknown) {
      if (!isDestinationExistsError(error)) throw error;
    }
    const manifest = await verifyWorkspace(workspaceDirectory, stagingDirectory, true);
    const status = await pathExists(temporaryDirectory) ? 'reused' : 'created';
    return { releaseId: manifest.releaseId, workspaceDirectory, status, manifest };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
