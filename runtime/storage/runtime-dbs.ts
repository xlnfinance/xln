import { Level } from 'level';
import { deriveSignerAddressSync } from '../account/crypto';
import { createStructuredLogger } from '../infra/logger';
import { dbRootPath, nodeProcess } from '../machine/platform';
import type { Env } from '../types';
import {
  readStorageHead,
  seedFreshStorageEpoch,
  verifyStorageTailIntegrity,
} from './';
import { assertStorageSafetyOverridesAllowed } from './safety';
import { withChunkedValues } from './chunked-db';
import {
  fsyncStorageParentDirectory,
  writeDurableStorageMarkerFile,
} from './fs-durability';

type RuntimeState = NonNullable<Env['runtimeState']>;

const storageLog = createStructuredLogger('runtime.storage');

const formatStorageError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const createChunkedLevel = (path: string): Level<Buffer, Buffer> => withChunkedValues(
  new Level(path, { valueEncoding: 'buffer', keyEncoding: 'binary' }) as unknown as Level<Buffer, Buffer>,
);

export type RuntimeStorageDbDeps = {
  ensureRuntimeState(env: Env): RuntimeState;
};

const DEFAULT_DB_NAMESPACE = 'default';
type RuntimeDbKind = 'core' | 'infra';

export const normalizeDbNamespace = (value: string): string => value.trim().toLowerCase();

export const deriveRuntimeIdFromSeed = (seed?: string | null): string | null => {
  if (!seed) return null;
  try {
    return deriveSignerAddressSync(seed, '1').toLowerCase();
  } catch (error) {
    storageLog.warn('namespace.derive_runtime_id_failed', { error: formatStorageError(error) });
    return null;
  }
};

export const resolveDbNamespace = (
  options: { env?: Env | null; runtimeId?: string | null; runtimeSeed?: string | null } = {},
): string => {
  const explicit = options.env?.dbNamespace;
  if (explicit) return normalizeDbNamespace(explicit);
  const runtimeId = options.runtimeId ?? options.env?.runtimeId;
  if (runtimeId) return normalizeDbNamespace(runtimeId);
  const seed = options.runtimeSeed ?? options.env?.runtimeSeed;
  const derived = deriveRuntimeIdFromSeed(seed ?? null);
  if (derived) return derived;
  return DEFAULT_DB_NAMESPACE;
};

export const resolveDbPath = (env: Env, kind: RuntimeDbKind = 'core'): string => {
  const namespace = resolveDbNamespace({ env });
  const suffix = kind === 'core' ? '' : '-infra';
  if (nodeProcess) {
    return `${dbRootPath}/${namespace}${suffix}`;
  }
  return `${dbRootPath}-${namespace}${suffix}`;
};

export type StorageDbRole = 'current' | 'previous';

type StorageEpochRotationMarker = {
  snapshotHeight: number;
  currentPath: string;
  previousPath: string;
  nextPath: string;
  createdAt: number;
};

const storageEpochRecoveryPromises = new Map<string, Promise<void>>();

export const resolveStorageDbPath = (env: Env, role: StorageDbRole = 'current'): string => {
  const base = resolveDbPath(env, 'core');
  return `${base}-storage-${role}`;
};

export const resolveFrameDbPath = (env: Env): string => {
  const base = resolveDbPath(env, 'core');
  return `${base}-frames`;
};

export const STORAGE_WRITER_LOCK_TTL_MS = 30_000;

export type StorageWriterLockBoundary =
  | 'after-candidate-sync'
  | 'after-canonical-link';

export type StorageWriterLockOptions = {
  onBoundary?: (boundary: StorageWriterLockBoundary) => void | Promise<void>;
};

export const resolveStorageWriterLockPath = (env: Env): string => {
  const base = resolveDbPath(env, 'core');
  return `${base}-writer.lock`;
};

const activeStorageWriterLocks = new Set<string>();

type StorageWriterLockBody = {
  owner: string;
  pid?: number;
  runtimeId?: string;
  frameHeight?: number;
  acquiredAt: number;
  expiresAt: number;
};

const parseStorageWriterLock = (raw: string): StorageWriterLockBody | null => {
  try {
    const body = JSON.parse(raw) as Partial<StorageWriterLockBody>;
    if (!body || typeof body !== 'object') return null;
    const expiresAt = Number(body.expiresAt);
    if (!Number.isFinite(expiresAt)) return null;
    return {
      owner: String(body.owner || 'unknown'),
      ...(typeof body.pid === 'number' ? { pid: body.pid } : {}),
      ...(typeof body.runtimeId === 'string' ? { runtimeId: body.runtimeId } : {}),
      ...(typeof body.frameHeight === 'number' ? { frameHeight: body.frameHeight } : {}),
      acquiredAt: Number.isFinite(Number(body.acquiredAt)) ? Number(body.acquiredAt) : 0,
      expiresAt,
    };
  } catch {
    return null;
  }
};

const storageWriterLockHeldError = (lockPath: string, lock: StorageWriterLockBody | null): Error => {
  const owner = lock?.owner ? ` owner=${lock.owner}` : '';
  const frame = typeof lock?.frameHeight === 'number' ? ` frame=${lock.frameHeight}` : '';
  return new Error(`STORAGE_WRITER_LOCK_HELD: path=${lockPath}${owner}${frame}`);
};

const storageWriterErrorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';

const storageWriterPidIsAlive = (pid: number | undefined): boolean => {
  if (!Number.isFinite(pid) || Number(pid) <= 0) return false;
  try {
    nodeProcess?.kill(Number(pid), 0);
    return true;
  } catch (error) {
    const code = storageWriterErrorCode(error);
    if (code === 'ESRCH') return false;
    // EPERM proves that a process owns the PID even though this runtime cannot
    // signal it. Treating EPERM as death could delete a live contender's
    // candidate before it publishes the canonical hard link.
    if (code === 'EPERM') return true;
    throw new Error(`STORAGE_WRITER_PID_PROBE_FAILED:pid=${pid}:code=${code || 'UNKNOWN'}`, {
      cause: error,
    });
  }
};

let staleStorageLockSequence = 0;

const readStorageWriterLock = async (
  lockPath: string,
  fs: typeof import('fs/promises'),
): Promise<StorageWriterLockBody | null> => {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    return raw ? parseStorageWriterLock(raw) : null;
  } catch (error) {
    if (storageWriterErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
};

const unlinkStorageFileIfPresent = async (
  filePath: string,
  fs: typeof import('fs/promises'),
): Promise<void> => {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (storageWriterErrorCode(error) !== 'ENOENT') throw error;
  }
};

const cleanupDeadStorageWriterCandidates = async (
  lockPath: string,
  fs: typeof import('fs/promises'),
  path: typeof import('path'),
): Promise<void> => {
  const directory = path.dirname(lockPath);
  const candidatePrefix = `${path.basename(lockPath)}.candidate-`;
  const candidateNames = (await fs.readdir(directory))
    .filter(name => name.startsWith(candidatePrefix))
    .sort();
  let sawDeadCandidate = false;

  for (const candidateName of candidateNames) {
    const candidatePath = path.join(directory, candidateName);
    const suffix = candidateName.slice(candidatePrefix.length);
    const match = /^(\d+)-(\d+)-(\d+)$/.exec(suffix);
    if (!match) {
      throw new Error(`STORAGE_WRITER_CANDIDATE_NAME_INVALID:${candidatePath}`);
    }
    const ownerPid = Number(match[1]);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
      throw new Error(`STORAGE_WRITER_CANDIDATE_PID_INVALID:${candidatePath}`);
    }
    // Candidate filenames are created before the body is written. The PID in
    // the exclusive filename is therefore the only recovery evidence that is
    // guaranteed to survive a kill at every write boundary. Never inspect or
    // delete a candidate while that owner PID is alive.
    if (storageWriterPidIsAlive(ownerPid)) continue;
    await unlinkStorageFileIfPresent(candidatePath, fs);
    sawDeadCandidate = true;
  }

  if (sawDeadCandidate) await fsyncStorageParentDirectory(lockPath);
};

const storageWriterLockIsReclaimable = (lock: StorageWriterLockBody | null): lock is StorageWriterLockBody => {
  if (!lock) return false;
  // A recorded local PID is a stronger liveness oracle than the lease clock.
  // Reclaim a SIGKILL orphan immediately; never steal from a live process even
  // if a long persistence operation outlives the advisory TTL.
  if (typeof lock.pid === 'number') return !storageWriterPidIsAlive(lock.pid);
  return lock.expiresAt <= Date.now();
};

const removeStorageLockIfOwned = async (
  lockPath: string,
  expectedOwner: string,
  action: 'release' | 'stale',
  fs: typeof import('fs/promises'),
): Promise<boolean> => {
  staleStorageLockSequence += 1;
  const movedPath = `${lockPath}.${action}-${nodeProcess?.pid ?? 'unknown'}-${Date.now()}-${staleStorageLockSequence}`;
  try {
    await fs.rename(lockPath, movedPath);
  } catch (error) {
    if (storageWriterErrorCode(error) === 'ENOENT') return false;
    throw error;
  }

  const moved = await readStorageWriterLock(movedPath, fs);
  if (moved?.owner !== expectedOwner) {
    // Another contender replaced the path after our observation. Restore its
    // inode only if the canonical path is still empty, then fail closed.
    await fs.link(movedPath, lockPath).catch((error) => {
      if (storageWriterErrorCode(error) !== 'EEXIST') throw error;
    });
  }
  await unlinkStorageFileIfPresent(movedPath, fs);
  return moved?.owner === expectedOwner;
};

const removeMalformedStorageLock = async (
  lockPath: string,
  fs: typeof import('fs/promises'),
): Promise<boolean> => {
  staleStorageLockSequence += 1;
  const movedPath = `${lockPath}.malformed-${nodeProcess?.pid ?? 'unknown'}-${Date.now()}-${staleStorageLockSequence}`;
  try {
    await fs.rename(lockPath, movedPath);
  } catch (error) {
    if (storageWriterErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
  const moved = await readStorageWriterLock(movedPath, fs);
  if (moved) {
    await fs.link(movedPath, lockPath).catch((error) => {
      if (storageWriterErrorCode(error) !== 'EEXIST') throw error;
    });
    await unlinkStorageFileIfPresent(movedPath, fs);
    return false;
  }
  await unlinkStorageFileIfPresent(movedPath, fs);
  return true;
};

const tryReclaimExpiredStorageLock = async (
  lockPath: string,
  fs: typeof import('fs/promises'),
): Promise<boolean> => {
  const observed = await readStorageWriterLock(lockPath, fs);
  if (!storageWriterLockIsReclaimable(observed)) return false;
  return removeStorageLockIfOwned(lockPath, observed.owner, 'stale', fs);
};

const acquireStorageRecoveryLock = async (
  env: Env,
  recoveryPath: string,
  fs: typeof import('fs/promises'),
  path: typeof import('path'),
): Promise<StorageWriterLockBody> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await tryAcquireStorageWriterLock(env, recoveryPath, fs, path);
    } catch (error) {
      if (storageWriterErrorCode(error) !== 'EEXIST') throw error;
      const observed = await readStorageWriterLock(recoveryPath, fs);
      const reclaimed = observed
        ? await tryReclaimExpiredStorageLock(recoveryPath, fs)
        : await removeMalformedStorageLock(recoveryPath, fs);
      if (!reclaimed) {
        throw storageWriterLockHeldError(recoveryPath, await readStorageWriterLock(recoveryPath, fs));
      }
    }
  }
  throw storageWriterLockHeldError(recoveryPath, await readStorageWriterLock(recoveryPath, fs));
};

const storageLockIsOwnedBy = async (
  lockPath: string,
  owner: StorageWriterLockBody,
  fs: typeof import('fs/promises'),
): Promise<boolean> => (await readStorageWriterLock(lockPath, fs))?.owner === owner.owner;

const releaseStorageRecoveryLock = async (
  lockPath: string,
  owner: StorageWriterLockBody,
  fs: typeof import('fs/promises'),
): Promise<void> => {
  await removeStorageLockIfOwned(lockPath, owner.owner, 'release', fs);
};

const tryAcquireStorageWriterLock = async (
  env: Env,
  lockPath: string,
  fs: typeof import('fs/promises'),
  path: typeof import('path'),
  options: StorageWriterLockOptions = {},
): Promise<StorageWriterLockBody> => {
  const now = Date.now();
  staleStorageLockSequence += 1;
  const ownerSequence = staleStorageLockSequence;
  const body: StorageWriterLockBody = {
    owner: `${nodeProcess?.pid ?? 'unknown'}:${now}:${Math.max(0, Number(env.height || 0))}:${ownerSequence}`,
    ...(typeof nodeProcess?.pid === 'number' ? { pid: nodeProcess.pid } : {}),
    ...(typeof env.runtimeId === 'string' ? { runtimeId: env.runtimeId } : {}),
    frameHeight: Math.max(0, Number(env.height || 0)),
    acquiredAt: now,
    expiresAt: now + STORAGE_WRITER_LOCK_TTL_MS,
  };
  const directory = path.dirname(lockPath);
  const candidatePath = `${lockPath}.candidate-${nodeProcess?.pid ?? 'unknown'}-${now}-${ownerSequence}`;
  await fs.mkdir(directory, { recursive: true });
  await cleanupDeadStorageWriterCandidates(lockPath, fs, path);
  const handle = await fs.open(candidatePath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(body)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  let canonicalLinked = false;
  try {
    await options.onBoundary?.('after-candidate-sync');
    // The canonical path becomes visible only after the complete owner body is
    // fsynced. A crash leaves either no canonical lock or a fully parseable one.
    await fs.link(candidatePath, lockPath);
    canonicalLinked = true;
    const directoryHandle = await fs.open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await options.onBoundary?.('after-canonical-link');
  } catch (error) {
    if (canonicalLinked) {
      await removeStorageLockIfOwned(lockPath, body.owner, 'release', fs);
    }
    await unlinkStorageFileIfPresent(candidatePath, fs);
    throw error;
  }
  await unlinkStorageFileIfPresent(candidatePath, fs);
  return body;
};

const releaseStorageWriterLock = async (
  lockPath: string,
  owner: StorageWriterLockBody,
  fs: typeof import('fs/promises'),
): Promise<void> => {
  if (!await removeStorageLockIfOwned(lockPath, owner.owner, 'release', fs)) {
    throw new Error(
      `STORAGE_WRITER_LOCK_OWNERSHIP_LOST: path=${lockPath} expected=${owner.owner} ` +
      `actual=${(await readStorageWriterLock(lockPath, fs))?.owner ?? 'missing'}`,
    );
  }
};

type BrowserLockManager = {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
};

const getBrowserLockManager = (): BrowserLockManager | null => {
  const browserNavigator = (globalThis as typeof globalThis & {
    navigator?: { locks?: BrowserLockManager };
  }).navigator;
  return browserNavigator?.locks ?? null;
};

const withBrowserStorageWriterLock = async <T>(env: Env, fn: () => Promise<T>): Promise<T> => {
  const locks = getBrowserLockManager();
  if (!locks) {
    throw new Error(`STORAGE_BROWSER_WRITER_LOCK_UNAVAILABLE: namespace=${resolveDbNamespace({ env })}`);
  }
  const lockName = `xln:storage-writer:${resolveDbNamespace({ env })}`;
  return locks.request(lockName, { mode: 'exclusive' }, async (lock) => {
    if (!lock) throw new Error(`STORAGE_BROWSER_WRITER_LOCK_NOT_GRANTED: namespace=${resolveDbNamespace({ env })}`);
    return fn();
  });
};

export const withStorageWriterLock = async <T>(
  env: Env,
  fn: () => Promise<T>,
  options: StorageWriterLockOptions = {},
): Promise<T> => {
  if (!nodeProcess) return withBrowserStorageWriterLock(env, fn);

  const lockPath = resolveStorageWriterLockPath(env);
  if (activeStorageWriterLocks.has(lockPath)) {
    throw storageWriterLockHeldError(lockPath, null);
  }
  activeStorageWriterLocks.add(lockPath);

  const fs = await import('fs/promises');
  const path = await import('path');
  let acquired: StorageWriterLockBody | null = null;
  try {
    try {
      acquired = await tryAcquireStorageWriterLock(env, lockPath, fs, path, options);
    } catch (error) {
      if (storageWriterErrorCode(error) !== 'EEXIST') throw error;

      const recoveryPath = `${lockPath}.recovery`;
      let recoveryOwner: StorageWriterLockBody | null = null;
      try {
        recoveryOwner = await acquireStorageRecoveryLock(env, recoveryPath, fs, path);

        const existing = await readStorageWriterLock(lockPath, fs);
        if (!await storageLockIsOwnedBy(recoveryPath, recoveryOwner, fs)) {
          throw storageWriterLockHeldError(recoveryPath, await readStorageWriterLock(recoveryPath, fs));
        }
        if (!existing) {
          if (!await removeMalformedStorageLock(lockPath, fs)) {
            throw storageWriterLockHeldError(lockPath, await readStorageWriterLock(lockPath, fs));
          }
        } else {
          if (!storageWriterLockIsReclaimable(existing)) {
            throw storageWriterLockHeldError(lockPath, existing);
          }
          if (!await removeStorageLockIfOwned(lockPath, existing.owner, 'stale', fs)) {
            throw storageWriterLockHeldError(lockPath, await readStorageWriterLock(lockPath, fs));
          }
        }
        try {
          acquired = await tryAcquireStorageWriterLock(env, lockPath, fs, path, options);
        } catch (acquireError) {
          if (storageWriterErrorCode(acquireError) !== 'EEXIST') throw acquireError;
          let replacementRaw = '';
          try {
            replacementRaw = await fs.readFile(lockPath, 'utf8');
          } catch (readError) {
            if (storageWriterErrorCode(readError) !== 'ENOENT') throw readError;
          }
          throw storageWriterLockHeldError(
            lockPath,
            replacementRaw ? parseStorageWriterLock(replacementRaw) : null,
          );
        }
      } finally {
        if (recoveryOwner) {
          await releaseStorageRecoveryLock(recoveryPath, recoveryOwner, fs);
        }
      }
    }

    return await fn();
  } finally {
    if (acquired) {
      await releaseStorageWriterLock(lockPath, acquired, fs);
    }
    activeStorageWriterLocks.delete(lockPath);
  }
};

/**
 * Pin a multi-read recovery view against snapshot publication and replay
 * pruning. Browser runtimes share the same Web Lock with frame writers; node
 * readers use the durable writer lock and fail loudly on an external live
 * contender instead of observing a torn history window.
 */
export const withStorageConsistentRead = async <T>(
  env: Env,
  fn: () => Promise<T>,
): Promise<T> => withStorageWriterLock(env, fn);

const resolveStorageRotationMarkerPath = (env: Env): string => {
  const base = resolveDbPath(env, 'core');
  return `${base}-storage-rotation.json`;
};

const storageStateFields = (role: StorageDbRole) =>
  role === 'current'
    ? ({
        dbField: 'storageDb',
        openField: 'storageDbOpenPromise',
      } as const)
    : ({
        dbField: 'storagePreviousDb',
        openField: 'storagePreviousDbOpenPromise',
      } as const);

export const getStorageDb = (
  env: Env,
  deps: RuntimeStorageDbDeps,
  role: StorageDbRole = 'current',
): Level<Buffer, Buffer> => {
  const state = deps.ensureRuntimeState(env);
  const fields = storageStateFields(role);
  const existing = state[fields.dbField] as Level<Buffer, Buffer> | undefined;
  if (existing) return existing;
  const db = createChunkedLevel(resolveStorageDbPath(env, role));
  state[fields.dbField] = db;
  return db;
};

export const closeStorageDb = async (
  env: Env,
  role: StorageDbRole = 'current',
): Promise<void> => {
  const state = env.runtimeState;
  if (!state) return;
  const fields = storageStateFields(role);
  const db = state[fields.dbField] as Level<Buffer, Buffer> | undefined;
  if (!db) return;
  try {
    await db.close();
    state[fields.dbField] = null;
    state[fields.openField] = null;
    if (role === 'previous') delete state.storageVerifiedPreviousHeight;
    else delete state.storageVerifiedCurrentHeight;
  } catch (error) {
    storageLog.warn('storage_db.close_failed', { role, error: formatStorageError(error) });
    throw error;
  }
};

const storagePathExists = async (path: string): Promise<boolean> => {
  if (!nodeProcess) return false;
  const fs = await import('fs/promises');
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if (storageWriterErrorCode(error) === 'ENOENT') return false;
    throw new Error(`STORAGE_PATH_STAT_FAILED:path=${path}`, { cause: error });
  }
};

const isFsNotFound = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  return String((error as { code?: unknown }).code ?? '') === 'ENOENT';
};

const readStorageRotationMarker = async (env: Env): Promise<StorageEpochRotationMarker | null> => {
  if (!nodeProcess) return null;
  const fs = await import('fs/promises');
  const markerPath = resolveStorageRotationMarkerPath(env);
  let raw: string;
  try {
    raw = await fs.readFile(markerPath, 'utf8');
  } catch (error) {
    if (isFsNotFound(error)) return null;
    throw new Error(`STORAGE_EPOCH_MARKER_READ_FAILED:path=${markerPath}`, { cause: error });
  }

  let parsed: Partial<StorageEpochRotationMarker>;
  try {
    parsed = JSON.parse(raw) as Partial<StorageEpochRotationMarker>;
  } catch (error) {
    throw new Error(`STORAGE_EPOCH_MARKER_INVALID:path=${markerPath}`, { cause: error });
  }
  if (
    typeof parsed.currentPath !== 'string' || !parsed.currentPath ||
    typeof parsed.previousPath !== 'string' || !parsed.previousPath ||
    typeof parsed.nextPath !== 'string' || !parsed.nextPath ||
    !Number.isSafeInteger(parsed.snapshotHeight) || Number(parsed.snapshotHeight) <= 0 ||
    !Number.isFinite(Number(parsed.createdAt ?? 0))
  ) {
    throw new Error(`STORAGE_EPOCH_MARKER_INVALID:path=${markerPath}`);
  }
  return {
    snapshotHeight: Number(parsed.snapshotHeight),
    currentPath: parsed.currentPath,
    previousPath: parsed.previousPath,
    nextPath: parsed.nextPath,
    createdAt: Number(parsed.createdAt ?? 0),
  };
};

const writeStorageRotationMarker = async (env: Env, marker: StorageEpochRotationMarker): Promise<void> => {
  if (!nodeProcess) return;
  const markerPath = resolveStorageRotationMarkerPath(env);
  await writeDurableStorageMarkerFile(markerPath, `${JSON.stringify(marker)}\n`);
};

const removeStorageRotationMarker = async (env: Env): Promise<void> => {
  if (!nodeProcess) return;
  const fs = await import('fs/promises');
  const markerPath = resolveStorageRotationMarkerPath(env);
  await fs.rm(markerPath, { force: true });
  await fs.rm(`${markerPath}.tmp`, { force: true });
  await fsyncStorageParentDirectory(markerPath);
};

const recoverStorageEpochRotationOnce = async (env: Env): Promise<void> => {
  if (!nodeProcess) return;
  const fs = await import('fs/promises');
  const marker = await readStorageRotationMarker(env);
  const currentPath = resolveStorageDbPath(env, 'current');
  const previousPath = resolveStorageDbPath(env, 'previous');

  if (marker) {
    const expectedNextPath = `${currentPath}-next-${marker.snapshotHeight}`;
    if (
      marker.currentPath !== currentPath ||
      marker.previousPath !== previousPath ||
      marker.nextPath !== expectedNextPath
    ) {
      throw new Error(
        `STORAGE_EPOCH_MARKER_PATH_MISMATCH:` +
        `current=${marker.currentPath}:${currentPath}:` +
        `previous=${marker.previousPath}:${previousPath}:` +
        `next=${marker.nextPath}:${expectedNextPath}`,
      );
    }
    const currentExists = await storagePathExists(marker.currentPath);
    const nextExists = await storagePathExists(marker.nextPath);
    const previousExists = await storagePathExists(marker.previousPath);

    if (!currentExists && nextExists) {
      storageLog.warn('storage_epoch.recover_complete_interrupted', { snapshotHeight: marker.snapshotHeight });
      await fs.rename(marker.nextPath, marker.currentPath);
      await fsyncStorageParentDirectory(marker.currentPath);
    } else if (!currentExists && previousExists) {
      storageLog.warn('storage_epoch.recover_rollback_interrupted', { snapshotHeight: marker.snapshotHeight });
      await fs.rename(marker.previousPath, marker.currentPath);
      await fsyncStorageParentDirectory(marker.currentPath);
    } else if (currentExists && nextExists) {
      storageLog.warn('storage_epoch.recover_remove_stale_next', { snapshotHeight: marker.snapshotHeight });
      await fs.rm(marker.nextPath, { recursive: true, force: true });
      await fsyncStorageParentDirectory(marker.nextPath);
    }

    await removeStorageRotationMarker(env);
    return;
  }

  if (!(await storagePathExists(currentPath)) && (await storagePathExists(previousPath))) {
    storageLog.warn('storage_epoch.recover_previous_as_current');
    await fs.rename(previousPath, currentPath);
    await fsyncStorageParentDirectory(currentPath);
  }
};

const recoverStorageEpochRotation = async (env: Env): Promise<void> => {
  if (!nodeProcess) return;
  const key = resolveStorageRotationMarkerPath(env);
  const existing = storageEpochRecoveryPromises.get(key);
  if (existing) {
    await existing;
    return;
  }
  const recovery = recoverStorageEpochRotationOnce(env);
  storageEpochRecoveryPromises.set(key, recovery);
  try {
    await recovery;
  } finally {
    storageEpochRecoveryPromises.delete(key);
  }
};

const waitForStorageEpochRotation = async (
  env: Env,
  deps: RuntimeStorageDbDeps,
): Promise<void> => {
  const pending = deps.ensureRuntimeState(env).storageEpochRotatePromise;
  if (pending) await pending;
};

const verifyOpenedStorageDb = async (
  env: Env,
  deps: RuntimeStorageDbDeps,
  role: StorageDbRole,
  db: Level<Buffer, Buffer>,
): Promise<void> => {
  assertStorageSafetyOverridesAllowed();
  const state = deps.ensureRuntimeState(env);
  const verifiedField = role === 'current' ? 'storageVerifiedCurrentHeight' : 'storageVerifiedPreviousHeight';
  const previousVerifiedHeight = Number(state[verifiedField] ?? -1);
  const head = await readStorageHead(db);
  const verified = { latestHeight: Math.max(0, Math.floor(Number(head?.latestHeight ?? 0))) };
  if (verified.latestHeight <= previousVerifiedHeight) return;
  state[verifiedField] = verified.latestHeight;
};

export const tryOpenStorageDb = async (
  env: Env,
  deps: RuntimeStorageDbDeps,
  role: StorageDbRole = 'current',
): Promise<boolean> => {
  await waitForStorageEpochRotation(env, deps);
  await recoverStorageEpochRotation(env);
  const state = deps.ensureRuntimeState(env);
  const fields = storageStateFields(role);
  if (role === 'previous' && !(await storagePathExists(resolveStorageDbPath(env, role)))) {
    return false;
  }
  if (!state[fields.openField]) {
    const db = getStorageDb(env, deps, role);
    state[fields.openField] = (async () => {
      try {
        await db.open();
        await verifyOpenedStorageDb(env, deps, role, db);
        return true;
      } catch (error) {
        const isBlocked =
          error instanceof Error &&
          (error.message?.includes('blocked') || error.name === 'SecurityError' || error.name === 'InvalidStateError');
        if (isBlocked) {
          storageLog.warn('storage_db.blocked', { role, error: formatStorageError(error) });
          return false;
        }
        state[fields.openField] = null;
        throw error;
      }
    })();
  }
  try {
    return await (state[fields.openField] as Promise<boolean>);
  } catch (error) {
    storageLog.error('storage_db.open_failed', { role, error: formatStorageError(error) });
    throw error;
  }
};

export const rotateStorageEpochDb = async (
  env: Env,
  deps: RuntimeStorageDbDeps,
  snapshotHeight: number,
  timestamp = env.timestamp,
): Promise<boolean> => {
  if (!nodeProcess) return false;
  const state = deps.ensureRuntimeState(env);
  if (state.storageEpochRotatePromise) {
    await state.storageEpochRotatePromise;
    return true;
  }
  const rotation = (async () => {
    const currentPath = resolveStorageDbPath(env, 'current');
    const previousPath = resolveStorageDbPath(env, 'previous');
    const nextPath = `${currentPath}-next-${snapshotHeight}`;
    const fs = await import('fs/promises');
    const currentDb = getStorageDb(env, deps, 'current');
    const nextDb = createChunkedLevel(nextPath);
    await fs.rm(nextPath, { recursive: true, force: true });
    await nextDb.open();
    try {
      await seedFreshStorageEpoch({
        sourceDb: currentDb,
        targetDb: nextDb,
        snapshotHeight,
      });
    } finally {
      await nextDb.close();
    }

    await writeStorageRotationMarker(env, {
      snapshotHeight,
      currentPath,
      previousPath,
      nextPath,
      createdAt: Math.max(0, Math.floor(Number(timestamp || 0))),
    });
    await closeStorageDb(env, 'previous');
    await closeStorageDb(env, 'current');
    await fs.rm(previousPath, { recursive: true, force: true });
    if (await storagePathExists(currentPath)) {
      await fs.rename(currentPath, previousPath);
      await fsyncStorageParentDirectory(previousPath);
    }
    await fs.rename(nextPath, currentPath);
    await fsyncStorageParentDirectory(currentPath);
    await removeStorageRotationMarker(env);
    delete state.storageVerifiedCurrentHeight;
    delete state.storageVerifiedPreviousHeight;
  })();
  state.storageEpochRotatePromise = rotation;
  try {
    await rotation;
    return true;
  } finally {
    if (state.storageEpochRotatePromise === rotation) {
      state.storageEpochRotatePromise = null;
    }
  }
};

export const getRuntimeDb = (
  env: Env,
  deps: RuntimeStorageDbDeps,
): Level<Buffer, Buffer> => {
  const state = deps.ensureRuntimeState(env);
  if (!state.db) {
    const path = resolveDbPath(env, 'core');
    state.db = createChunkedLevel(path);
  }
  return state.db;
};

export const getInfraDb = (
  env: Env,
  deps: RuntimeStorageDbDeps,
): Level<Buffer, Buffer> => {
  const state = deps.ensureRuntimeState(env);
  if (!state.infraDb) {
    const path = resolveDbPath(env, 'infra');
    state.infraDb = createChunkedLevel(path);
  }
  return state.infraDb;
};

export const getFrameDb = (
  env: Env,
  deps: RuntimeStorageDbDeps,
): Level<Buffer, Buffer> => {
  const state = deps.ensureRuntimeState(env);
  if (!state.frameDb) {
    state.frameDb = createChunkedLevel(resolveFrameDbPath(env));
  }
  return state.frameDb as Level<Buffer, Buffer>;
};

export const closeFrameDb = async (env: Env): Promise<void> => {
  const state = env.runtimeState;
  const db = state?.frameDb as Level<Buffer, Buffer> | undefined;
  if (!db) return;
  try {
    await db.close();
    state!.frameDb = null;
    state!.frameDbOpenPromise = null;
    delete state!.storageVerifiedHistoryHeight;
  } catch (error) {
    storageLog.warn('frame_db.close_failed', { error: formatStorageError(error) });
    throw error;
  }
};

export const closeInfraDb = async (env: Env): Promise<void> => {
  const state = env.runtimeState;
  if (!state?.infraDb) return;
  try {
    await state.infraDb.close();
    state.infraDb = null;
    state.infraDbOpenPromise = null;
  } catch (error) {
    storageLog.warn('infra_db.close_failed', { error: formatStorageError(error) });
    throw error;
  }
};

export async function tryOpenDb(
  env: Env,
  deps: RuntimeStorageDbDeps,
): Promise<boolean> {
  const state = deps.ensureRuntimeState(env);
  if (!state.dbOpenPromise) {
    const db = getRuntimeDb(env, deps);
    state.dbOpenPromise = (async () => {
      try {
        await db.open();
        return true;
      } catch (error) {
        const isBlocked =
          error instanceof Error &&
          (error.message?.includes('blocked') || error.name === 'SecurityError' || error.name === 'InvalidStateError');
        if (isBlocked) {
          storageLog.warn('runtime_db.blocked', { error: formatStorageError(error) });
          return false;
        }
        // Non-blocked open errors are fatal for persistence.
        state.dbOpenPromise = null;
        throw error;
      }
    })();
  }
  try {
    return await state.dbOpenPromise;
  } catch (error) {
    storageLog.error('runtime_db.open_failed', { error: formatStorageError(error) });
    throw error;
  }
}

export async function tryOpenFrameDb(
  env: Env,
  deps: RuntimeStorageDbDeps,
): Promise<boolean> {
  const state = deps.ensureRuntimeState(env);
  if (!state.frameDbOpenPromise) {
    const db = getFrameDb(env, deps);
    state.frameDbOpenPromise = (async () => {
      try {
        await db.open();
        const previousVerifiedHeight = Number(state.storageVerifiedHistoryHeight ?? -1);
        const verified = await verifyStorageTailIntegrity(db, { tailFrames: 128 });
        if (verified.latestHeight > previousVerifiedHeight) {
          state.storageVerifiedHistoryHeight = verified.latestHeight;
        }
        return true;
      } catch (error) {
        const isBlocked =
          error instanceof Error &&
          (error.message?.includes('blocked') || error.name === 'SecurityError' || error.name === 'InvalidStateError');
        if (isBlocked) {
          storageLog.warn('frame_db.blocked', { error: formatStorageError(error) });
          return false;
        }
        state.frameDbOpenPromise = null;
        throw error;
      }
    })();
  }
  try {
    return await state.frameDbOpenPromise;
  } catch (error) {
    storageLog.error('frame_db.open_failed', { error: formatStorageError(error) });
    throw error;
  }
}
