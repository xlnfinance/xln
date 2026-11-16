import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { candidatePaths, captureArtifactDigests } from '../evidence.cjs';
import { record } from './inputs.ts';
import {
  decodeJurisdictionStackManifest,
  decodeRegisteredStackStablecoin,
} from '../../../../core/jurisdiction/adapter/stack-manager/validation.ts';
import type { JurisdictionStackManifest } from '../../../../core/jurisdiction/adapter/stack-manager/types.ts';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const hashMap = (input: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record(input)).map(([path, hash]) => {
      if (
        typeof hash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(hash) ||
        !/^[\w./-]+$/.test(path) ||
        path.startsWith('/') ||
        path.split('/').some(part => !part || part === '.' || part === '..')
      ) {
        throw new Error('XLN_VERIFY_HASH_MAP_INVALID');
      }
      return [path, hash];
    }),
  );

const git = (args: string[]): Buffer => execFileSync('git', args, { cwd: repository, maxBuffer: 32 * 1024 * 1024 });

const assertSources = (sha: unknown, sources: Record<string, string>): string => {
  if (
    typeof sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    git(['rev-parse', '--verify', `${sha}^{commit}`])
      .toString()
      .trim() !== sha
  ) {
    throw new Error('XLN_VERIFY_EXECUTION_REVISION_INVALID');
  }
  const paths = git(['ls-tree', '-rz', '--name-only', sha, '--', ...candidatePaths])
    .toString()
    .split('\0')
    .filter(Boolean)
    .sort();
  if (!isDeepStrictEqual(Object.keys(sources).sort(), paths)) throw new Error('XLN_VERIFY_SOURCE_INVENTORY_MISMATCH');
  for (const path of paths) {
    if (digest(git(['show', `${sha}:${path}`])) !== sources[path])
      throw new Error(`XLN_VERIFY_SOURCE_HASH_MISMATCH:${path}`);
  }
  return sha;
};

const rejectSnapshotLinks = async (directory: string): Promise<void> => {
  if (!(await lstat(directory)).isDirectory()) throw new Error('XLN_VERIFY_ARTIFACT_SNAPSHOT_INVALID');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await rejectSnapshotLinks(join(directory, entry.name));
    else if (!entry.isFile()) throw new Error('XLN_VERIFY_ARTIFACT_SNAPSHOT_INVALID');
  }
};

const origin = (input: unknown) => {
  const value = record(input);
  const blockNumber = value['blockNumber'];
  const nonce = value['nonce'];
  const blockHash = value['blockHash'];
  const balanceWei = value['balanceWei'];
  if (
    typeof blockNumber !== 'number' ||
    !Number.isSafeInteger(blockNumber) ||
    blockNumber < 0 ||
    typeof nonce !== 'number' ||
    !Number.isSafeInteger(nonce) ||
    nonce < 0 ||
    typeof blockHash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(blockHash) ||
    typeof balanceWei !== 'string' ||
    !/^\d+$/.test(balanceWei) ||
    Object.keys(value).sort().join() !== 'balanceWei,blockHash,blockNumber,nonce'
  )
    throw new Error('XLN_VERIFY_ORIGIN_INVALID');
  return { blockNumber, nonce, blockHash, balanceWei };
};

const assertIdentity = (seal: Record<string, unknown>, manifest: JurisdictionStackManifest): number => {
  const keys = [
    'schemaVersion',
    'deploymentId',
    'graphVersion',
    'chainId',
    'deployer',
    'foundationRecipient',
    'stablecoin',
    'fixtureToken',
    'wrapped',
    'origin',
    'artifacts',
    'sources',
    'candidateSha',
    'policy',
  ];
  if (
    !isDeepStrictEqual(Object.keys(seal).sort(), keys.sort()) ||
    seal['schemaVersion'] !== 1 ||
    seal['graphVersion'] !== 'xln-stack-ignition-1' ||
    seal['wrapped'] !== null ||
    seal['deploymentId'] !== manifest.deploymentId ||
    seal['chainId'] !== manifest.chainId ||
    seal['deployer'] !== manifest.deployer ||
    seal['foundationRecipient'] !== manifest.foundationRecipient ||
    manifest.deployer !== manifest.foundationRecipient
  )
    throw new Error('XLN_VERIFY_EXECUTION_IDENTITY_MISMATCH');
  const token = decodeRegisteredStackStablecoin(manifest.registeredTokens);
  if (seal['fixtureToken'] === true) {
    if (
      seal['stablecoin'] !== null ||
      !manifest.evmContracts.stablecoin ||
      token.address !== manifest.evmContracts.stablecoin.address
    ) {
      throw new Error('XLN_VERIFY_TOKEN_IDENTITY_MISMATCH');
    }
  } else if (
    seal['fixtureToken'] !== false ||
    manifest.evmContracts.stablecoin ||
    !isDeepStrictEqual(seal['stablecoin'], { address: token.address, symbol: token.symbol, decimals: token.decimals })
  ) {
    throw new Error('XLN_VERIFY_TOKEN_IDENTITY_MISMATCH');
  }
  const policy = record(seal['policy']);
  const confirmations = policy['admissionConfirmations'];
  if (
    policy['executionConfirmations'] !== 1 ||
    typeof confirmations !== 'number' ||
    !Number.isSafeInteger(confirmations) ||
    confirmations < 12
  )
    throw new Error('XLN_VERIFY_CONFIRMATION_POLICY_INVALID');
  record(policy['native']);
  return confirmations;
};

export const readVerificationInputs = async (directory: string) => {
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  const sealBytes = await readFile(join(directory, 'manifest.json.execution.json'));
  const manifest = decodeJurisdictionStackManifest(JSON.parse(manifestBytes.toString()));
  const seal = record(JSON.parse(sealBytes.toString()));
  const confirmations = assertIdentity(seal, manifest);
  const sources = hashMap(seal['sources']);
  const candidateSha = assertSources(seal['candidateSha'], sources);
  const artifactDigests = hashMap(seal['artifacts']);
  const artifactDirectory = join(directory, 'manifest.json.artifacts');
  await rejectSnapshotLinks(artifactDirectory);
  if (!isDeepStrictEqual(captureArtifactDigests(artifactDirectory), artifactDigests))
    throw new Error('XLN_VERIFY_ARTIFACT_HASH_MISMATCH');
  return {
    directory,
    manifest,
    confirmations,
    deployer: manifest.deployer,
    identity: { origin: origin(seal['origin']) },
    artifactsRoot: pathToFileURL(`${artifactDirectory}/`),
    executionCandidate: { sha: candidateSha, sources, artifacts: artifactDigests, sealSha256: digest(sealBytes) },
    inputDigests: {
      manifest: digest(manifestBytes),
      seal: digest(sealBytes),
      journal: digest(await readFile(join(directory, 'journal.jsonl'))),
    },
  };
};

export const assertVerificationInputsUnchanged = async (
  input: Awaited<ReturnType<typeof readVerificationInputs>>,
): Promise<void> => {
  const files = [
    ['manifest', 'manifest.json'],
    ['seal', 'manifest.json.execution.json'],
    ['journal', 'journal.jsonl'],
  ] as const;
  for (const [key, path] of files) {
    if (digest(await readFile(join(input.directory, path))) !== input.inputDigests[key]) {
      throw new Error('XLN_VERIFY_INPUT_CHANGED_DURING_VERIFICATION');
    }
  }
  await rejectSnapshotLinks(fileURLToPath(input.artifactsRoot));
  if (
    !isDeepStrictEqual(captureArtifactDigests(fileURLToPath(input.artifactsRoot)), input.executionCandidate.artifacts)
  ) {
    throw new Error('XLN_VERIFY_ARTIFACT_HASH_MISMATCH');
  }
};

export const verificationOutputPath = async (
  directory: string,
  output: string | undefined,
): Promise<string | undefined> => {
  if (!output) return undefined;
  const absolute = resolve(output);
  const physical = join(await realpath(dirname(absolute)), relative(dirname(absolute), absolute));
  const inside = (path: string) =>
    path === directory || (!relative(directory, path).startsWith('../') && relative(directory, path) !== '..');
  if (inside(absolute) || inside(physical)) throw new Error('XLN_VERIFY_OUTPUT_OVERWRITES_INPUT');
  try {
    await lstat(physical);
    throw new Error('XLN_VERIFY_OUTPUT_ALREADY_EXISTS');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return physical;
};
