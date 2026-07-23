import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  fsyncStorageParentDirectory,
  writeDurableStorageMarkerFile,
  type StorageDurabilityBoundary,
} from '../storage/fs-durability';
import {
  closeFrameDb,
  closeInfraDb,
  closeStorageDb,
  getFrameDb,
  getInfraDb,
  getStorageDb,
  resolveDbPath,
  tryOpenStorageDb,
} from '../storage/runtime-dbs';
import type { Env } from '../types';

const fixture = join(import.meta.dir, 'fixtures/storage-marker-crash-child.ts');
const tempRoots: string[] = [];
const markerBody = `${JSON.stringify({ snapshotHeight: 7, generation: 'durable-marker-v1' })}\n`;

const makeMarkerPath = (label: string): string => {
  const root = mkdtempSync(join(tmpdir(), `xln-storage-${label}-`));
  tempRoots.push(root);
  return join(root, 'rotation.json');
};

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('storage filesystem durability', () => {
  for (const boundary of [
    'after-marker-write',
    'after-marker-file-sync',
    'after-marker-rename',
  ] satisfies StorageDurabilityBoundary[]) {
    test(`publishes only a complete marker across SIGKILL ${boundary}`, async () => {
      const markerPath = makeMarkerPath(boundary);
      const child = Bun.spawn({
        cmd: [process.execPath, fixture, markerPath, boundary],
        cwd: join(import.meta.dir, '..', '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      const stderr = await new Response(child.stderr).text();

      expect(exitCode, stderr).toBe(137);
      expect(child.signalCode, stderr).toBe('SIGKILL');
      expect(existsSync(markerPath)).toBe(boundary === 'after-marker-rename');
      if (existsSync(markerPath)) expect(readFileSync(markerPath, 'utf8')).toBe(markerBody);

      // A fresh process may retry an interrupted publication. The canonical
      // marker must then be the complete, file-synced body, never a torn tmp.
      await writeDurableStorageMarkerFile(markerPath, markerBody);
      expect(readFileSync(markerPath, 'utf8')).toBe(markerBody);
    }, 10_000);
  }

  test('surfaces a directory fsync I/O failure', async () => {
    const markerPath = makeMarkerPath('dir-sync-eio');
    await expect(fsyncStorageParentDirectory(markerPath, {
      syncDirectory: async () => {
        throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' });
      },
    })).rejects.toThrow('STORAGE_PARENT_DIR_FSYNC_FAILED:code=EIO');
  });

  test('surfaces a marker file fsync failure before publication', async () => {
    const markerPath = makeMarkerPath('file-sync-eio');
    await expect(writeDurableStorageMarkerFile(markerPath, markerBody, {
      syncFile: async () => {
        throw Object.assign(new Error('injected marker sync failure'), { code: 'EIO' });
      },
    })).rejects.toThrow('STORAGE_MARKER_FILE_FSYNC_FAILED:code=EIO');
    expect(existsSync(markerPath)).toBeFalse();
  });

  test('classifies an unsupported directory fsync explicitly', async () => {
    const markerPath = makeMarkerPath('dir-sync-unsupported');
    const result = await fsyncStorageParentDirectory(markerPath, {
      syncDirectory: async () => {
        throw Object.assign(new Error('directory sync unsupported'), { code: 'EINVAL' });
      },
    });
    expect(result).toEqual({ status: 'unsupported', code: 'EINVAL' });
  });

  test('surfaces a parent directory open failure', async () => {
    const markerPath = join(makeMarkerPath('dir-open'), 'missing', 'rotation.json');
    await expect(fsyncStorageParentDirectory(markerPath))
      .rejects.toThrow('STORAGE_PARENT_DIR_OPEN_FAILED:code=ENOENT');
  });

  test('fails closed on a malformed durable rotation marker', async () => {
    const namespace = `storage-marker-invalid-${process.pid}-${Date.now()}`;
    const env = {
      height: 0,
      timestamp: 0,
      runtimeId: namespace,
      dbNamespace: namespace,
      runtimeState: {},
    } as Env;
    const basePath = resolveDbPath(env);
    const markerPath = `${basePath}-storage-rotation.json`;
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, '{"snapshotHeight":7', 'utf8');

    try {
      await expect(tryOpenStorageDb(env, {
        ensureRuntimeState: target => (target.runtimeState ??= {}),
      })).rejects.toThrow('STORAGE_EPOCH_MARKER_INVALID');
    } finally {
      if (env.runtimeState?.storageDb) await closeStorageDb(env);
      rmSync(basePath, { recursive: true, force: true });
      rmSync(`${basePath}-storage-current`, { recursive: true, force: true });
      rmSync(`${basePath}-storage-previous`, { recursive: true, force: true });
      rmSync(markerPath, { force: true });
      rmSync(`${markerPath}.tmp`, { force: true });
    }
  });

  test('detaches a poisoned handle before close and rejects concurrent reuse', async () => {
    let rejectClose: ((error: Error) => void) | null = null;
    const closeFailure = new Promise<void>((_resolve, reject) => {
      rejectClose = reject;
    });
    const poisonedHandle = {
      close: () => closeFailure,
    };
    const env = {
      height: 0,
      timestamp: 0,
      runtimeId: `storage-close-poison-${process.pid}-${Date.now()}`,
      dbNamespace: `storage-close-poison-${process.pid}-${Date.now()}`,
      runtimeState: {
        storageDb: poisonedHandle,
        storageDbOpenPromise: Promise.resolve(true),
        storageVerifiedCurrentHeight: 7,
      },
    } as unknown as Env;
    const deps = {
      ensureRuntimeState: (target: Env) => (target.runtimeState ??= {}),
    };

    const closing = closeStorageDb(env);
    expect(() => getStorageDb(env, deps)).toThrow(
      'STORAGE_HANDLE_STATUS_CONFLICT:role=storage-current:status=closing',
    );
    expect(env.runtimeState?.storageDb).toBeNull();
    expect(env.runtimeState?.storageDbOpenPromise).toBeNull();
    expect(env.runtimeState?.storageVerifiedCurrentHeight).toBeUndefined();

    rejectClose!(new Error('injected close failure'));
    await expect(closing).rejects.toThrow('injected close failure');

    const replacement = getStorageDb(env, deps);
    expect(replacement).not.toBe(poisonedHandle);
    await closeStorageDb(env);
  });

  test('frame and infra handles cannot escape after close starts', async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const frameClose = deferred();
    const infraClose = deferred();
    const env = {
      height: 0,
      timestamp: 0,
      runtimeId: `storage-close-all-${process.pid}-${Date.now()}`,
      dbNamespace: `storage-close-all-${process.pid}-${Date.now()}`,
      runtimeState: {
        frameDb: { close: () => frameClose.promise },
        frameDbOpenPromise: Promise.resolve(true),
        storageVerifiedHistoryHeight: 9,
        infraDb: { close: () => infraClose.promise },
        infraDbOpenPromise: Promise.resolve(true),
      },
    } as unknown as Env;
    const deps = {
      ensureRuntimeState: (target: Env) => (target.runtimeState ??= {}),
    };

    const closingFrame = closeFrameDb(env);
    const closingInfra = closeInfraDb(env);
    expect(() => getFrameDb(env, deps)).toThrow(
      'STORAGE_HANDLE_STATUS_CONFLICT:role=frames:status=closing',
    );
    expect(() => getInfraDb(env, deps)).toThrow(
      'STORAGE_HANDLE_STATUS_CONFLICT:role=infra:status=closing',
    );
    expect(env.runtimeState?.frameDb).toBeNull();
    expect(env.runtimeState?.frameDbOpenPromise).toBeNull();
    expect(env.runtimeState?.storageVerifiedHistoryHeight).toBeUndefined();
    expect(env.runtimeState?.infraDb).toBeNull();
    expect(env.runtimeState?.infraDbOpenPromise).toBeNull();

    frameClose.resolve();
    infraClose.resolve();
    await Promise.all([closingFrame, closingInfra]);
  });
});
