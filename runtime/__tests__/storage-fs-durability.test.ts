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
  closeStorageDb,
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
});
