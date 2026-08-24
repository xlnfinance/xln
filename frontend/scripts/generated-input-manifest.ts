import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization';
import {
  PREPARED_GENERATED_INPUTS,
  isCommandGeneratedInput,
  type CommandGeneratedInputDefinition,
  type GeneratedInputOwner,
  type PreparedGeneratedInputDefinition,
} from '../config/generated-inputs';
import { matchesRoute } from '../config/surfaces';

export const GENERATED_INPUT_SCHEMA_VERSION = 2 as const;

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
  definitionSha256: string;
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

export const toPortablePath = (pathname: string): string => pathname.split(sep).join('/');
export const comparePaths = (left: string, right: string): number => left.localeCompare(right);

export const assertGeneratedInputRelativePath = (pathname: string, label: string): void => {
  const parts = pathname.split('/');
  if (
    pathname.length === 0 || isAbsolute(pathname) || pathname.includes('\\') ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`GENERATED_INPUT_${label}_INVALID:${pathname}`);
  }
};

export const hashGeneratedInputBytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const hashDefinition = (definition: PreparedGeneratedInputDefinition): string =>
  hashGeneratedInputBytes(Buffer.from(safeStringify(definition)));

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
  assertGeneratedInputRelativePath(destinationPath, 'DESTINATION_PATH');
  return { sourcePath, destinationPath, sha256, size: size as number };
};

const readPreparedManifest = async (
  frontendRoot: string,
  definition: PreparedGeneratedInputDefinition,
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
    parsed['outputNamespace'] !== definition.outputNamespace ||
    parsed['definitionSha256'] !== hashDefinition(definition) || !Array.isArray(parsed['files'])
  ) {
    throw new Error(`CANDIDATE_INPUT_MANIFEST_INVALID:${definition.id}:ROOT`);
  }
  return {
    schemaVersion: GENERATED_INPUT_SCHEMA_VERSION,
    id: definition.id,
    owner: definition.owner,
    outputNamespace: definition.outputNamespace,
    definitionSha256: hashDefinition(definition),
    files: parsed['files'].map((file) => parsePreparedFile(file, definition.id)),
  };
};

export const walkPreparedPayload = async (root: string, current = root): Promise<readonly string[]> => {
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
  return paths.sort(comparePaths);
};

export const assertCommandOutputs = async (
  payloadRoot: string,
  definition: CommandGeneratedInputDefinition,
): Promise<void> => {
  const paths = await walkPreparedPayload(payloadRoot);
  for (const pathname of paths) {
    if (!definition.producer.outputRoutes.some((route) => matchesRoute(`/${pathname}`, route))) {
      throw new Error(`GENERATED_INPUT_COMMAND_OUTPUT_UNDECLARED:${definition.id}:${pathname}`);
    }
  }
  for (const route of definition.producer.outputRoutes) {
    if (!paths.some((pathname) => matchesRoute(`/${pathname}`, route))) {
      throw new Error(`GENERATED_INPUT_COMMAND_OUTPUT_MISSING:${definition.id}:${route.pathname}`);
    }
  }
};

export const createPreparedManifest = async (
  payloadRoot: string,
  definition: PreparedGeneratedInputDefinition,
  sources: ReadonlyMap<string, string>,
): Promise<PreparedGeneratedInputManifest> => {
  const paths = await walkPreparedPayload(payloadRoot);
  const files = await Promise.all(paths.map(async (destinationPath) => {
    const bytes = await readFile(join(payloadRoot, destinationPath));
    return {
      sourcePath: sources.get(destinationPath) ?? `command:${definition.id}`,
      destinationPath,
      sha256: hashGeneratedInputBytes(bytes),
      size: bytes.byteLength,
    };
  }));
  return {
    schemaVersion: GENERATED_INPUT_SCHEMA_VERSION,
    id: definition.id,
    owner: definition.owner,
    outputNamespace: definition.outputNamespace,
    definitionSha256: hashDefinition(definition),
    files,
  };
};

export const validatePreparedInput = async (
  frontendRoot: string,
  definition: PreparedGeneratedInputDefinition,
): Promise<ValidatedGeneratedInput> => {
  const manifest = await readPreparedManifest(frontendRoot, definition);
  const payloadRoot = join(frontendRoot, '.artifacts', 'inputs', definition.id, 'files');
  if (isCommandGeneratedInput(definition)) await assertCommandOutputs(payloadRoot, definition);
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
    if (bytes.byteLength !== expected.size || hashGeneratedInputBytes(bytes) !== expected.sha256) {
      throw new Error(`CANDIDATE_INPUT_FILE_MISMATCH:${definition.id}:${expected.destinationPath}`);
    }
    return { ...expected, sourcePath };
  }));
  return { manifest, files };
};

export const readPreparedGeneratedInputs = async (
  frontendRoot: string,
  definitions: readonly PreparedGeneratedInputDefinition[] = PREPARED_GENERATED_INPUTS,
): Promise<readonly ValidatedGeneratedInput[]> => Promise.all(
  definitions.map((definition) => validatePreparedInput(frontendRoot, definition)),
);
