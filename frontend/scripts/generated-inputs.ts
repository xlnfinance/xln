import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization';
import {
  COPY_GENERATED_INPUTS,
  type CopyGeneratedInputDefinition,
  type GeneratedInputCopy,
  type GeneratedInputOwner,
} from '../config/generated-inputs';

export const GENERATED_INPUT_SCHEMA_VERSION = 1 as const;

export type PreparedGeneratedInputFile = Readonly<{
  sourcePath: string;
  destinationPath: string;
  sha256: string;
  size: number;
}>;

export type PreparedGeneratedInputManifest = Readonly<{
  schemaVersion: typeof GENERATED_INPUT_SCHEMA_VERSION;
  id: string;
  owner: GeneratedInputOwner;
  outputNamespace: string;
  files: readonly PreparedGeneratedInputFile[];
}>;

export type ValidatedGeneratedInput = Readonly<{
  manifest: PreparedGeneratedInputManifest;
  files: readonly Readonly<{
    sourcePath: string;
    destinationPath: string;
    sha256: string;
    size: number;
  }>[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toPortablePath = (pathname: string): string => pathname.split(sep).join('/');
const comparePaths = (left: string, right: string): number => left.localeCompare(right);

const assertRelativePath = (pathname: string, label: string): void => {
  const parts = pathname.split('/');
  if (
    pathname.length === 0 || isAbsolute(pathname) || pathname.includes('\\') ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`GENERATED_INPUT_${label}_INVALID:${pathname}`);
  }
};

const walkSourceFiles = async (current: string): Promise<readonly string[]> => {
  const stats = await lstat(current);
  if (stats.isSymbolicLink()) throw new Error(`GENERATED_INPUT_SOURCE_SYMLINK:${current}`);
  if (stats.isFile()) return [current];
  if (!stats.isDirectory()) throw new Error(`GENERATED_INPUT_SOURCE_UNSUPPORTED:${current}`);

  const entries = await readdir(current, { withFileTypes: true });
  entries.sort(({ name: left }, { name: right }) => comparePaths(left, right));
  const files: string[] = [];
  for (const entry of entries) files.push(...await walkSourceFiles(join(current, entry.name)));
  return files;
};

const expandCopy = async (
  repositoryRoot: string,
  entry: GeneratedInputCopy,
): Promise<readonly Readonly<{ sourcePath: string; destinationPath: string }>[]> => {
  assertRelativePath(entry.sourcePath, 'SOURCE_PATH');
  assertRelativePath(entry.destinationPath, 'DESTINATION_PATH');
  const sourceRoot = join(repositoryRoot, entry.sourcePath);
  let files: readonly string[];
  try {
    files = await walkSourceFiles(sourceRoot);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`GENERATED_INPUT_SOURCE_MISSING:${entry.sourcePath}`);
    }
    throw error;
  }
  if (files.length === 0) throw new Error(`GENERATED_INPUT_SOURCE_EMPTY:${entry.sourcePath}`);
  const rootIsFile = files.length === 1 && files[0] === sourceRoot;
  return files.map((sourcePath) => ({
    sourcePath,
    destinationPath: rootIsFile
      ? entry.destinationPath
      : `${entry.destinationPath}/${toPortablePath(relative(sourceRoot, sourcePath))}`,
  }));
};

const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const parsePreparedFile = (value: unknown, definitionId: string): PreparedGeneratedInputFile => {
  if (!isRecord(value)) throw new Error(`CANDIDATE_INPUT_FILE_INVALID:${definitionId}`);
  const sourcePath = value['sourcePath'];
  const destinationPath = value['destinationPath'];
  const sha256 = value['sha256'];
  const size = value['size'];
  if (
    typeof sourcePath !== 'string' || sourcePath.length === 0 ||
    typeof destinationPath !== 'string' || typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || (size as number) < 0
  ) {
    throw new Error(`CANDIDATE_INPUT_FILE_INVALID:${definitionId}`);
  }
  assertRelativePath(destinationPath, 'DESTINATION_PATH');
  return { sourcePath, destinationPath, sha256, size: size as number };
};

const readPreparedManifest = async (
  frontendRoot: string,
  definition: CopyGeneratedInputDefinition,
): Promise<PreparedGeneratedInputManifest> => {
  const manifestPath = join(frontendRoot, '.artifacts', 'inputs', definition.id, 'input-manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`CANDIDATE_INPUT_MANIFEST_INVALID:${definition.id}:${detail}`);
  }
  if (
    !isRecord(parsed) || parsed['schemaVersion'] !== GENERATED_INPUT_SCHEMA_VERSION ||
    parsed['id'] !== definition.id || parsed['owner'] !== definition.owner ||
    parsed['outputNamespace'] !== definition.outputNamespace || !Array.isArray(parsed['files'])
  ) {
    throw new Error(`CANDIDATE_INPUT_MANIFEST_INVALID:${definition.id}:ROOT`);
  }
  return {
    schemaVersion: GENERATED_INPUT_SCHEMA_VERSION,
    id: definition.id,
    owner: definition.owner,
    outputNamespace: definition.outputNamespace,
    files: parsed['files'].map((file) => parsePreparedFile(file, definition.id)),
  };
};

const walkPreparedPayload = async (root: string, current = root): Promise<readonly string[]> => {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort(({ name: left }, { name: right }) => comparePaths(left, right));
  const paths: string[] = [];
  for (const entry of entries) {
    const pathname = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`CANDIDATE_INPUT_SYMLINK:${pathname}`);
    if (entry.isDirectory()) {
      paths.push(...await walkPreparedPayload(root, pathname));
      continue;
    }
    if (!entry.isFile()) throw new Error(`CANDIDATE_INPUT_UNSUPPORTED:${pathname}`);
    paths.push(toPortablePath(relative(root, pathname)));
  }
  return paths;
};

const validatePreparedInput = async (
  frontendRoot: string,
  definition: CopyGeneratedInputDefinition,
): Promise<ValidatedGeneratedInput> => {
  const manifest = await readPreparedManifest(frontendRoot, definition);
  const payloadRoot = join(frontendRoot, '.artifacts', 'inputs', definition.id, 'files');
  const actualPaths = await walkPreparedPayload(payloadRoot);
  const expectedPaths = manifest.files.map(({ destinationPath }) => destinationPath).sort(comparePaths);
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((pathname, index) => pathname !== expectedPaths[index])
  ) {
    throw new Error(`CANDIDATE_INPUT_FILE_SET_MISMATCH:${definition.id}`);
  }
  const files = await Promise.all(manifest.files.map(async (expected) => {
    const sourcePath = join(payloadRoot, expected.destinationPath);
    const bytes = await readFile(sourcePath);
    if (bytes.byteLength !== expected.size || hashBytes(bytes) !== expected.sha256) {
      throw new Error(`CANDIDATE_INPUT_FILE_MISMATCH:${definition.id}:${expected.destinationPath}`);
    }
    return { ...expected, sourcePath };
  }));
  return { manifest, files };
};

const prepareOne = async (
  repositoryRoot: string,
  frontendRoot: string,
  definition: CopyGeneratedInputDefinition,
): Promise<PreparedGeneratedInputManifest> => {
  const expanded = (await Promise.all(
    definition.producer.entries.map((entry) => expandCopy(repositoryRoot, entry)),
  )).flat();
  expanded.sort(({ destinationPath: left }, { destinationPath: right }) => left.localeCompare(right));
  const destinations = new Set<string>();
  for (const file of expanded) {
    if (destinations.has(file.destinationPath)) {
      throw new Error(`GENERATED_INPUT_DESTINATION_COLLISION:${definition.id}:${file.destinationPath}`);
    }
    destinations.add(file.destinationPath);
  }

  const inputsRoot = join(frontendRoot, '.artifacts', 'inputs');
  await mkdir(inputsRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(join(inputsRoot, `.preparing-${definition.id}-`));
  try {
    const files: PreparedGeneratedInputFile[] = [];
    for (const file of expanded) {
      const bytes = await readFile(file.sourcePath);
      const outputPath = join(temporaryRoot, 'files', file.destinationPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);
      files.push({
        sourcePath: toPortablePath(relative(repositoryRoot, file.sourcePath)),
        destinationPath: file.destinationPath,
        sha256: hashBytes(bytes),
        size: bytes.byteLength,
      });
    }
    const manifest: PreparedGeneratedInputManifest = {
      schemaVersion: GENERATED_INPUT_SCHEMA_VERSION,
      id: definition.id,
      owner: definition.owner,
      outputNamespace: definition.outputNamespace,
      files,
    };
    await writeFile(join(temporaryRoot, 'input-manifest.json'), `${safeStringify(manifest, 2)}\n`);
    const outputRoot = join(inputsRoot, definition.id);
    await rm(outputRoot, { recursive: true, force: true });
    await rename(temporaryRoot, outputRoot);
    return manifest;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

export const prepareGeneratedInputs = async (
  repositoryRoot: string,
  frontendRoot: string,
  owners: readonly GeneratedInputOwner[],
  definitions: readonly CopyGeneratedInputDefinition[] = COPY_GENERATED_INPUTS,
): Promise<readonly PreparedGeneratedInputManifest[]> => {
  const selected = definitions.filter(({ owner }) => owners.includes(owner));
  const ids = selected.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('GENERATED_INPUT_DEFINITION_DUPLICATE');
  const manifests: PreparedGeneratedInputManifest[] = [];
  for (const definition of selected) manifests.push(await prepareOne(repositoryRoot, frontendRoot, definition));
  return manifests;
};

export const readPreparedGeneratedInputs = async (
  frontendRoot: string,
  definitions: readonly CopyGeneratedInputDefinition[] = COPY_GENERATED_INPUTS,
): Promise<readonly ValidatedGeneratedInput[]> => Promise.all(
  definitions.map((definition) => validatePreparedInput(frontendRoot, definition)),
);
