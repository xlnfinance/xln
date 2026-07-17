import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import {
  resolveStorageWriterLockPath,
  STORAGE_WRITER_LOCK_TTL_MS,
  withStorageWriterLock,
  type StorageWriterLockBoundary,
} from '../storage/runtime-dbs';
import type { Env } from '../types';

const waitForReadyWorkers = async (directory: string, count: number): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (readdirSync(directory).length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`STORAGE_WRITER_LOCK_TEST_TIMEOUT: ready=${readdirSync(directory).length}/${count}`);
    }
    await Bun.sleep(10);
  }
};

const crashFixture = `${import.meta.dir}/fixtures/storage-writer-lock-crash-child.ts`;

for (const boundary of [
  'after-candidate-sync',
  'after-canonical-link',
] satisfies StorageWriterLockBoundary[]) {
  test(`fresh process acquires immediately after SIGKILL ${boundary}`, async () => {
    const namespace = `storage-writer-kill-${boundary}-${process.pid}-${Date.now()}`;
    const env = { dbNamespace: namespace, runtimeId: namespace, height: 2 } as Env;
    const lockPath = resolveStorageWriterLockPath(env);
    const child = Bun.spawn({
      cmd: [process.execPath, crashFixture, namespace, boundary],
      cwd: process.cwd(),
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(137);
    expect(child.signalCode, stderr).toBe('SIGKILL');

    let acquired = false;
    try {
      await withStorageWriterLock(env, async () => { acquired = true; });
      expect(acquired).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
      const directory = dirname(lockPath);
      const prefix = lockPath.slice(directory.length + 1);
      const residualLockArtifacts = readdirSync(directory)
        .filter((entry) => entry.startsWith(prefix))
        .sort();
      expect(residualLockArtifacts).toEqual([]);
    } finally {
      const directory = dirname(lockPath);
      const prefix = lockPath.slice(directory.length + 1);
      for (const name of readdirSync(directory).filter((entry) => entry.startsWith(prefix))) {
        rmSync(`${directory}/${name}`, { force: true });
      }
    }
  });
}

test('candidate recovery preserves a candidate owned by a live process', async () => {
  const namespace = `storage-writer-live-candidate-${process.pid}-${Date.now()}`;
  const env = { dbNamespace: namespace, runtimeId: namespace, height: 3 } as Env;
  const lockPath = resolveStorageWriterLockPath(env);
  const candidatePath = `${lockPath}.candidate-${process.pid}-${Date.now()}-777`;
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(candidatePath, `${JSON.stringify({
    owner: `live-owner-${process.pid}`,
    pid: process.pid,
    runtimeId: namespace,
    frameHeight: 2,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + STORAGE_WRITER_LOCK_TTL_MS,
  })}\n`, 'utf8');

  try {
    await withStorageWriterLock(env, async () => {});
    expect(existsSync(candidatePath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(candidatePath, { force: true });
    rmSync(lockPath, { force: true });
  }
});

test('candidate recovery fails loud on an unparseable candidate owner', async () => {
  const namespace = `storage-writer-invalid-candidate-${process.pid}-${Date.now()}`;
  const env = { dbNamespace: namespace, runtimeId: namespace, height: 4 } as Env;
  const lockPath = resolveStorageWriterLockPath(env);
  const candidatePath = `${lockPath}.candidate-invalid-owner`;
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(candidatePath, 'invalid candidate', 'utf8');

  try {
    await expect(withStorageWriterLock(env, async () => {})).rejects.toThrow(
      `STORAGE_WRITER_CANDIDATE_NAME_INVALID:${candidatePath}`,
    );
    expect(existsSync(candidatePath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(candidatePath, { force: true });
    rmSync(lockPath, { force: true });
  }
});

test('concurrent processes cannot both reclaim the same expired writer lock', async () => {
  const namespace = `storage-writer-race-${process.pid}-${Date.now()}`;
  const env = {
    dbNamespace: namespace,
    runtimeId: namespace,
    height: 1,
  } as Env;
  const lockPath = resolveStorageWriterLockPath(env);
  const controlPath = `${lockPath}.test-control`;
  const readyPath = `${controlPath}/ready`;
  const activePath = `${controlPath}/active`;
  const acquiredPath = `${controlPath}/acquired`;
  const goPath = `${controlPath}/go`;
  const violationPath = `${controlPath}/violation`;
  const workerCount = 20;

  rmSync(controlPath, { recursive: true, force: true });
  rmSync(lockPath, { force: true });
  mkdirSync(readyPath, { recursive: true });
  mkdirSync(activePath, { recursive: true });
  mkdirSync(acquiredPath, { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({
    owner: 'expired-dead-writer',
    pid: 999_999,
    runtimeId: namespace,
    frameHeight: 1,
    acquiredAt: Date.now() - STORAGE_WRITER_LOCK_TTL_MS - 1_000,
    expiresAt: Date.now() - 1_000,
  })}\n`, 'utf8');

  const workerSource = `
    import { existsSync, readdirSync, rmSync, writeFileSync } from 'fs';
    import { withStorageWriterLock } from './runtime/storage/runtime-dbs.ts';
    const env = ${JSON.stringify(env)};
    const readyPath = ${JSON.stringify(readyPath)};
    const activePath = ${JSON.stringify(activePath)};
    const acquiredPath = ${JSON.stringify(acquiredPath)};
    const goPath = ${JSON.stringify(goPath)};
    const violationPath = ${JSON.stringify(violationPath)};
    writeFileSync(readyPath + '/' + process.pid, 'ready');
    while (!existsSync(goPath)) await Bun.sleep(1);
    try {
      await withStorageWriterLock(env, async () => {
        const marker = activePath + '/' + process.pid;
        writeFileSync(acquiredPath + '/' + process.pid, 'acquired');
        writeFileSync(marker, 'active');
        if (readdirSync(activePath).length > 1) writeFileSync(violationPath, 'overlap');
        await Bun.sleep(200);
        rmSync(marker, { force: true });
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('STORAGE_WRITER_LOCK_HELD')) throw error;
    }
  `;

  const workers = Array.from({ length: workerCount }, () => Bun.spawn({
    cmd: ['bun', '-e', workerSource],
    cwd: process.cwd(),
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  }));

  try {
    await waitForReadyWorkers(readyPath, workerCount);
    writeFileSync(goPath, 'go', 'utf8');
    const exitCodes = await Promise.all(workers.map((worker) => worker.exited));
    const workerErrors = await Promise.all(workers.map((worker) => new Response(worker.stderr).text()));
    const failedWorkers = exitCodes.flatMap((code, index) => (
      code === 0 ? [] : [`worker=${index} exit=${code} stderr=${workerErrors[index]}`]
    ));
    if (failedWorkers.length > 0) {
      throw new Error(`STORAGE_WRITER_LOCK_WORKER_FAILURE:\n${failedWorkers.join('\n')}`);
    }
    expect(exitCodes).toEqual(Array(workerCount).fill(0));
    expect(readdirSync(acquiredPath)).toHaveLength(1);
    expect(existsSync(violationPath)).toBe(false);
  } finally {
    for (const worker of workers) worker.kill();
    rmSync(controlPath, { recursive: true, force: true });
    rmSync(lockPath, { force: true });
  }
});

test('a new writer reclaims expired writer and recovery locks after a crash', async () => {
  const namespace = `storage-writer-recovery-${process.pid}-${Date.now()}`;
  const env = { dbNamespace: namespace, runtimeId: namespace, height: 7 } as Env;
  const lockPath = resolveStorageWriterLockPath(env);
  const recoveryPath = `${lockPath}.recovery`;
  const expired = {
    pid: 999_997,
    runtimeId: namespace,
    frameHeight: 6,
    acquiredAt: Date.now() - STORAGE_WRITER_LOCK_TTL_MS - 1_000,
    expiresAt: Date.now() - 1_000,
  };

  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({ ...expired, owner: 'expired-dead-writer' })}\n`, 'utf8');
  writeFileSync(recoveryPath, `${JSON.stringify({ ...expired, owner: 'expired-dead-recovery' })}\n`, 'utf8');

  let calls = 0;
  try {
    await withStorageWriterLock(env, async () => { calls += 1; });
    expect(calls).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(recoveryPath)).toBe(false);
  } finally {
    rmSync(lockPath, { force: true });
    rmSync(recoveryPath, { force: true });
  }
});

test('a new writer reclaims a non-expired lock immediately when the recorded pid is dead', async () => {
  const namespace = `storage-writer-dead-pid-${process.pid}-${Date.now()}`;
  const env = { dbNamespace: namespace, runtimeId: namespace, height: 8 } as Env;
  const lockPath = resolveStorageWriterLockPath(env);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({
    owner: 'sigkill-orphan',
    pid: 999_996,
    runtimeId: namespace,
    frameHeight: 7,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + STORAGE_WRITER_LOCK_TTL_MS,
  })}\n`, 'utf8');

  let calls = 0;
  try {
    await withStorageWriterLock(env, async () => { calls += 1; });
    expect(calls).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(lockPath, { force: true });
  }
});

test('a malformed canonical lock cannot permanently fence the namespace', async () => {
  const namespace = `storage-writer-malformed-${process.pid}-${Date.now()}`;
  const env = { dbNamespace: namespace, runtimeId: namespace, height: 9 } as Env;
  const lockPath = resolveStorageWriterLockPath(env);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, '', 'utf8');

  let calls = 0;
  try {
    await withStorageWriterLock(env, async () => { calls += 1; });
    expect(calls).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(lockPath, { force: true });
  }
});
