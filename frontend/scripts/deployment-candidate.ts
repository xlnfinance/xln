import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { compareStableText, safeStringify } from '../../core/protocol/serialization';
import { verifyCandidateReleaseDirectory } from './candidate-release-verifier';

export const DEPLOYMENT_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const DEPLOYMENT_CANDIDATE_STATE = 'deployment-candidate-state.json';

export type DeploymentCandidateState = Readonly<{
  schemaVersion: typeof DEPLOYMENT_CANDIDATE_SCHEMA_VERSION;
  activeReleaseId: `sha256-${string}`;
  rollbackReleaseId: `sha256-${string}` | null;
}>;

export type DeploymentCandidateSelection = Readonly<{
  state: DeploymentCandidateState;
  activeDirectory: string;
}>;

const RELEASE_ID_PATTERN = /^sha256-[0-9a-f]{64}$/u;
const LOCK_DIRECTORY = '.deployment-candidate.lock';
const NEXT_STATE = '.deployment-candidate-state.next';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort(compareStableText);
  const canonical = [...expected].sort(compareStableText);
  if (safeStringify(actual) !== safeStringify(canonical)) throw new Error(code);
};

const releaseId = (value: unknown, code: string): `sha256-${string}` => {
  if (typeof value !== 'string' || !RELEASE_ID_PATTERN.test(value)) throw new Error(code);
  return value as `sha256-${string}`;
};

const decodeState = (value: unknown): DeploymentCandidateState => {
  if (!isRecord(value)) throw new Error('DEPLOYMENT_CANDIDATE_STATE_INVALID');
  exactKeys(
    value,
    ['schemaVersion', 'activeReleaseId', 'rollbackReleaseId'],
    'DEPLOYMENT_CANDIDATE_STATE_KEYS_INVALID',
  );
  if (value['schemaVersion'] !== DEPLOYMENT_CANDIDATE_SCHEMA_VERSION) {
    throw new Error('DEPLOYMENT_CANDIDATE_SCHEMA_UNSUPPORTED');
  }
  const activeReleaseId = releaseId(value['activeReleaseId'], 'DEPLOYMENT_CANDIDATE_ACTIVE_ID_INVALID');
  const rollbackValue = value['rollbackReleaseId'];
  const rollbackReleaseId = rollbackValue === null
    ? null
    : releaseId(rollbackValue, 'DEPLOYMENT_CANDIDATE_ROLLBACK_ID_INVALID');
  if (rollbackReleaseId === activeReleaseId) throw new Error('DEPLOYMENT_CANDIDATE_RELEASE_IDS_EQUAL');
  return { schemaVersion: DEPLOYMENT_CANDIDATE_SCHEMA_VERSION, activeReleaseId, rollbackReleaseId };
};

const statePath = (deploymentRoot: string): string => join(deploymentRoot, DEPLOYMENT_CANDIDATE_STATE);
const releasesRoot = (deploymentRoot: string): string => join(deploymentRoot, 'releases');
export const deploymentReleaseDirectory = (deploymentRoot: string, id: string): string =>
  join(releasesRoot(deploymentRoot), releaseId(id, 'DEPLOYMENT_CANDIDATE_RELEASE_ID_INVALID'));

const pathExists = async (pathname: string): Promise<boolean> => {
  try {
    await lstat(pathname);
    return true;
  } catch (error: unknown) {
    if (isRecord(error) && error['code'] === 'ENOENT') return false;
    throw error;
  }
};

const assertPlainDirectory = async (pathname: string, code: string): Promise<void> => {
  const stats = await lstat(pathname);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(code);
};

const prepareDeploymentRoot = async (deploymentRoot: string): Promise<void> => {
  await mkdir(deploymentRoot, { recursive: true, mode: 0o755 });
  await assertPlainDirectory(deploymentRoot, 'DEPLOYMENT_CANDIDATE_ROOT_INVALID');
  const store = releasesRoot(deploymentRoot);
  await mkdir(store, { recursive: true, mode: 0o755 });
  await assertPlainDirectory(store, 'DEPLOYMENT_CANDIDATE_RELEASES_ROOT_INVALID');
};

export const readDeploymentCandidateState = async (
  deploymentRoot: string,
  allowMissing = false,
): Promise<DeploymentCandidateState | null> => {
  let raw: string;
  try {
    raw = await readFile(statePath(deploymentRoot), 'utf8');
  } catch (error: unknown) {
    if (allowMissing && isRecord(error) && error['code'] === 'ENOENT') return null;
    throw new Error('DEPLOYMENT_CANDIDATE_STATE_READ_FAILED');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('DEPLOYMENT_CANDIDATE_STATE_JSON_INVALID');
  }
  const state = decodeState(value);
  if (raw !== `${safeStringify(state, 2)}\n`) throw new Error('DEPLOYMENT_CANDIDATE_STATE_NONCANONICAL');
  return state;
};

const verifyStoredRelease = async (deploymentRoot: string, id: `sha256-${string}`): Promise<void> => {
  const manifest = await verifyCandidateReleaseDirectory(deploymentReleaseDirectory(deploymentRoot, id));
  if (manifest.releaseId !== id) throw new Error('DEPLOYMENT_CANDIDATE_STORED_ID_MISMATCH');
};

const verifyStateReleases = async (deploymentRoot: string, state: DeploymentCandidateState): Promise<void> => {
  await verifyStoredRelease(deploymentRoot, state.activeReleaseId);
  if (state.rollbackReleaseId !== null) await verifyStoredRelease(deploymentRoot, state.rollbackReleaseId);
};

export const verifyDeploymentCandidateState = async (
  deploymentRoot: string,
): Promise<DeploymentCandidateSelection> => {
  await assertPlainDirectory(deploymentRoot, 'DEPLOYMENT_CANDIDATE_ROOT_INVALID');
  const state = await readDeploymentCandidateState(deploymentRoot);
  if (state === null) throw new Error('DEPLOYMENT_CANDIDATE_STATE_REQUIRED');
  await verifyStateReleases(deploymentRoot, state);
  return { state, activeDirectory: deploymentReleaseDirectory(deploymentRoot, state.activeReleaseId) };
};

const isDestinationExistsError = (error: unknown): boolean =>
  isRecord(error) && (error['code'] === 'EEXIST' || error['code'] === 'ENOTEMPTY');

export const stageDeploymentCandidateRelease = async (
  sourceDirectory: string,
  deploymentRoot: string,
): Promise<Readonly<{ releaseId: `sha256-${string}`; releaseDirectory: string; status: 'created' | 'reused' }>> => {
  const sourceManifest = await verifyCandidateReleaseDirectory(sourceDirectory);
  await prepareDeploymentRoot(deploymentRoot);
  const destination = deploymentReleaseDirectory(deploymentRoot, sourceManifest.releaseId);
  if (await pathExists(destination)) {
    await verifyStoredRelease(deploymentRoot, sourceManifest.releaseId);
    return { releaseId: sourceManifest.releaseId, releaseDirectory: destination, status: 'reused' };
  }
  const temporaryRoot = await mkdtemp(join(releasesRoot(deploymentRoot), '.staging-'));
  const temporaryRelease = join(temporaryRoot, sourceManifest.releaseId);
  try {
    await cp(sourceDirectory, temporaryRelease, { recursive: true, force: false, errorOnExist: true });
    await verifyCandidateReleaseDirectory(temporaryRelease);
    try {
      await rename(temporaryRelease, destination);
    } catch (error: unknown) {
      if (!isDestinationExistsError(error)) throw error;
    }
    await verifyStoredRelease(deploymentRoot, sourceManifest.releaseId);
    return {
      releaseId: sourceManifest.releaseId,
      releaseDirectory: destination,
      status: await pathExists(temporaryRelease) ? 'reused' : 'created',
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

const syncDirectory = async (pathname: string): Promise<void> => {
  const directory = await open(pathname, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

const writeStateAtomically = async (
  deploymentRoot: string,
  state: DeploymentCandidateState,
): Promise<void> => {
  const temporaryPath = join(deploymentRoot, NEXT_STATE);
  let file;
  try {
    file = await open(temporaryPath, 'wx', 0o644);
  } catch (error: unknown) {
    if (isRecord(error) && error['code'] === 'EEXIST') throw new Error('DEPLOYMENT_CANDIDATE_STATE_TEMP_EXISTS');
    throw error;
  }
  try {
    await file.writeFile(`${safeStringify(state, 2)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporaryPath, statePath(deploymentRoot));
    await syncDirectory(deploymentRoot);
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
};

const withActivationLock = async <T>(deploymentRoot: string, operation: () => Promise<T>): Promise<T> => {
  const lockPath = join(deploymentRoot, LOCK_DIRECTORY);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error: unknown) {
    if (isRecord(error) && error['code'] === 'EEXIST') throw new Error('DEPLOYMENT_CANDIDATE_ACTIVATION_BUSY');
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rmdir(lockPath);
  }
};

export const activateDeploymentCandidate = async (
  sourceDirectory: string,
  deploymentRoot: string,
): Promise<DeploymentCandidateSelection> => {
  const staged = await stageDeploymentCandidateRelease(sourceDirectory, deploymentRoot);
  return withActivationLock(deploymentRoot, async () => {
    const current = await readDeploymentCandidateState(deploymentRoot, true);
    if (current !== null) {
      await verifyStateReleases(deploymentRoot, current);
      if (current.activeReleaseId === staged.releaseId) throw new Error('DEPLOYMENT_CANDIDATE_ALREADY_ACTIVE');
    }
    await writeStateAtomically(deploymentRoot, {
      schemaVersion: DEPLOYMENT_CANDIDATE_SCHEMA_VERSION,
      activeReleaseId: staged.releaseId,
      rollbackReleaseId: current?.activeReleaseId ?? null,
    });
    return verifyDeploymentCandidateState(deploymentRoot);
  });
};

export const rollbackDeploymentCandidate = async (
  deploymentRoot: string,
): Promise<DeploymentCandidateSelection> => {
  await prepareDeploymentRoot(deploymentRoot);
  return withActivationLock(deploymentRoot, async () => {
    const current = await verifyDeploymentCandidateState(deploymentRoot);
    const rollbackReleaseId = current.state.rollbackReleaseId;
    if (rollbackReleaseId === null) throw new Error('DEPLOYMENT_CANDIDATE_ROLLBACK_UNAVAILABLE');
    await writeStateAtomically(deploymentRoot, {
      schemaVersion: DEPLOYMENT_CANDIDATE_SCHEMA_VERSION,
      activeReleaseId: rollbackReleaseId,
      rollbackReleaseId: current.state.activeReleaseId,
    });
    return verifyDeploymentCandidateState(deploymentRoot);
  });
};

export const resolveDeploymentRoot = (pathname: string): string => {
  const resolved = resolve(pathname);
  if (dirname(resolved) === resolved) throw new Error('DEPLOYMENT_CANDIDATE_ROOT_UNSAFE');
  return resolved;
};
