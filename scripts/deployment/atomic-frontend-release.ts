import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { verifyFrontendReleaseTree } from './frontend-release-files';
import {
  FRONTEND_RELEASE_MANIFEST_FILE,
  parseFrontendReleaseManifest,
  type FrontendReleaseManifest,
} from './frontend-release-schema';

export type FrontendActivationResult = Readonly<{
  current: string;
  previous: string | null;
}>;

type HealthCheck = (manifest: FrontendReleaseManifest) => void | Promise<void>;

let pointerSequence = 0;

const assertSafeReleaseId = (releaseId: string): void => {
  if (!/^[A-Za-z0-9._-]+$/.test(releaseId)) throw new Error(`FRONTEND_RELEASE_ID_INVALID:${releaseId}`);
};

const releasesRoot = (frontendRoot: string): string => join(resolve(frontendRoot), 'releases');

const assertInsideReleases = (frontendRoot: string, target: string): void => {
  const root = realpathSync(releasesRoot(frontendRoot));
  const resolved = realpathSync(target);
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error(`FRONTEND_RELEASE_TARGET_OUTSIDE_ROOT:${resolved}`);
};

export const loadValidatedFrontendRelease = (
  frontendRoot: string,
  releaseId: string,
): FrontendReleaseManifest => {
  assertSafeReleaseId(releaseId);
  const releaseRoot = join(releasesRoot(frontendRoot), releaseId);
  const stats = lstatSync(releaseRoot, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`FRONTEND_RELEASE_DIRECTORY_INVALID:${releaseId}`);
  }
  assertInsideReleases(frontendRoot, releaseRoot);
  const manifest = parseFrontendReleaseManifest(
    readFileSync(join(releaseRoot, FRONTEND_RELEASE_MANIFEST_FILE), 'utf8'),
  );
  if (manifest.releaseId !== releaseId) throw new Error(`FRONTEND_RELEASE_ID_MISMATCH:${releaseId}`);
  verifyFrontendReleaseTree(releaseRoot, manifest);
  return manifest;
};

const readPointer = (frontendRoot: string, name: 'current' | 'previous'): string | null => {
  const pointer = join(resolve(frontendRoot), name);
  const stats = lstatSync(pointer, { throwIfNoEntry: false });
  if (!stats) return null;
  if (!stats.isSymbolicLink()) throw new Error(`FRONTEND_RELEASE_POINTER_NOT_SYMLINK:${name}`);
  const target = resolve(dirname(pointer), readlinkSync(pointer));
  assertInsideReleases(frontendRoot, target);
  const releaseId = basename(realpathSync(target));
  loadValidatedFrontendRelease(frontendRoot, releaseId);
  return releaseId;
};

const removePointer = (frontendRoot: string, name: 'current' | 'previous'): void => {
  const pointer = join(resolve(frontendRoot), name);
  const stats = lstatSync(pointer, { throwIfNoEntry: false });
  if (!stats) return;
  if (!stats.isSymbolicLink()) throw new Error(`FRONTEND_RELEASE_POINTER_NOT_SYMLINK:${name}`);
  unlinkSync(pointer);
};

const switchPointer = (frontendRoot: string, name: 'current' | 'previous', releaseId: string): void => {
  assertSafeReleaseId(releaseId);
  loadValidatedFrontendRelease(frontendRoot, releaseId);
  pointerSequence += 1;
  const root = resolve(frontendRoot);
  const temporary = join(root, `.${name}-${process.pid}-${pointerSequence}`);
  const destination = join(root, name);
  symlinkSync(join('releases', releaseId), temporary);
  try {
    renameSync(temporary, destination);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
};

const restorePointer = (
  frontendRoot: string,
  name: 'current' | 'previous',
  releaseId: string | null,
): void => {
  if (releaseId) switchPointer(frontendRoot, name, releaseId);
  else removePointer(frontendRoot, name);
};

export const activateFrontendRelease = async (
  frontendRoot: string,
  releaseId: string,
  healthCheck?: HealthCheck,
): Promise<FrontendActivationResult> => {
  const manifest = loadValidatedFrontendRelease(frontendRoot, releaseId);
  const oldCurrent = readPointer(frontendRoot, 'current');
  const oldPrevious = readPointer(frontendRoot, 'previous');
  if (oldCurrent === releaseId) throw new Error(`FRONTEND_RELEASE_ALREADY_ACTIVE:${releaseId}`);

  if (oldCurrent) switchPointer(frontendRoot, 'previous', oldCurrent);
  switchPointer(frontendRoot, 'current', releaseId);
  try {
    await healthCheck?.(manifest);
  } catch (error) {
    restorePointer(frontendRoot, 'current', oldCurrent);
    restorePointer(frontendRoot, 'previous', oldPrevious);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`FRONTEND_RELEASE_HEALTH_FAILED_ROLLED_BACK:${releaseId}:${message}`);
  }
  return { current: releaseId, previous: oldCurrent };
};

export const rollbackFrontendRelease = async (
  frontendRoot: string,
  healthCheck?: HealthCheck,
): Promise<FrontendActivationResult> => {
  const current = readPointer(frontendRoot, 'current');
  const previous = readPointer(frontendRoot, 'previous');
  if (!current) throw new Error('FRONTEND_RELEASE_CURRENT_MISSING');
  if (!previous) throw new Error('FRONTEND_RELEASE_PREVIOUS_MISSING');
  const manifest = loadValidatedFrontendRelease(frontendRoot, previous);

  switchPointer(frontendRoot, 'current', previous);
  switchPointer(frontendRoot, 'previous', current);
  try {
    await healthCheck?.(manifest);
  } catch (error) {
    switchPointer(frontendRoot, 'current', current);
    switchPointer(frontendRoot, 'previous', previous);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`FRONTEND_ROLLBACK_HEALTH_FAILED_RESTORED:${previous}:${message}`);
  }
  return { current: previous, previous: current };
};

export const frontendReleasePointerTarget = (
  frontendRoot: string,
  name: 'current' | 'previous',
): string | null => readPointer(frontendRoot, name);

export const pruneFrontendReleases = (
  frontendRoot: string,
  releaseIds: readonly string[],
): readonly string[] => {
  if (releaseIds.length === 0) throw new Error('FRONTEND_RELEASE_PRUNE_TARGETS_REQUIRED');
  if (new Set(releaseIds).size !== releaseIds.length) throw new Error('FRONTEND_RELEASE_PRUNE_TARGET_DUPLICATE');
  const protectedIds = new Set([
    frontendReleasePointerTarget(frontendRoot, 'current'),
    frontendReleasePointerTarget(frontendRoot, 'previous'),
  ]);
  releaseIds.forEach(releaseId => {
    if (protectedIds.has(releaseId)) throw new Error(`FRONTEND_RELEASE_PRUNE_ACTIVE_REFUSED:${releaseId}`);
    loadValidatedFrontendRelease(frontendRoot, releaseId);
  });
  releaseIds.forEach(releaseId => rmSync(join(releasesRoot(frontendRoot), releaseId), { recursive: true }));
  return [...releaseIds];
};

export const relativeFrontendReleasePath = (frontendRoot: string, releaseId: string): string =>
  relative(resolve(frontendRoot), join(releasesRoot(frontendRoot), releaseId));
