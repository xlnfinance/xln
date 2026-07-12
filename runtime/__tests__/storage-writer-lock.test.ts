import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import {
  resolveStorageWriterLockPath,
  STORAGE_WRITER_LOCK_TTL_MS,
  withStorageWriterLock,
} from '../runtime-storage-dbs';
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
    import { withStorageWriterLock } from './runtime/runtime-storage-dbs.ts';
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
