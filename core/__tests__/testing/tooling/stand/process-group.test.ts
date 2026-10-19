import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { stopProcessGroup } from '../../../../scripts/e2e/runners/process-group';
import { terminateGateProcessGroup } from '../../../../scripts/release/gate-child-process';
import { acquireStandLock, registerStandGroup, releaseStandLock } from '../../../../../tools/stand-lock';

const root = mkdtempSync(join(tmpdir(), 'xln-process-group-native-'));
const executable = join(root, 'zombie-group');

beforeAll(() => {
  const source = fileURLToPath(new URL('../../../fixtures/tooling/process-group-zombie.c', import.meta.url));
  const result = spawnSync('cc', ['-O0', '-o', executable, source], { encoding: 'utf8', timeout: 5_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`NATIVE_PROCESS_GROUP_COMPILE_FAILED:${result.stderr}`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const startZombieGroup = async () => {
  const child = spawn(executable, [], { stdio: 'pipe' });
  const lines = createInterface({ input: child.stdout });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`NATIVE_PROCESS_GROUP_EXIT:${code}`)));
  });
  void exited.catch(() => undefined);
  const pid = await new Promise<number>((resolve, reject) => {
    lines.once('line', line => resolve(Number(line)));
    child.once('error', reject);
    child.once('exit', () => reject(new Error('NATIVE_PROCESS_GROUP_PID_MISSING')));
  });
  lines.close();
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('NATIVE_PROCESS_GROUP_PID_INVALID');
  return { pid, reap: async () => { child.stdin.end('R'); await exited; } };
};

const expectGroupAbsent = (pid: number): void => {
  expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
};

test('native exited group may finish reaping after a denied signal before its stand slot releases', async () => {
  const group = await startZombieGroup();
  const grant = await acquireStandLock({ root: join(root, 'reaped'), reason: 'native-reap', waitMs: 0 });
  registerStandGroup(grant, group.pid);
  // Darwin reports EPERM for a zombie-only group; Linux can report it alive.
  // Both platforms must await actual group disappearance, not parent exit alone.
  if (process.platform === 'darwin') {
    expect(() => process.kill(-group.pid, 0)).toThrow(expect.objectContaining({ code: 'EPERM' }));
  }
  const reaped = new Promise<void>((resolve, reject) => {
    setTimeout(() => { void group.reap().then(resolve, reject); }, 50);
  });
  try {
    await stopProcessGroup({ pid: group.pid, termTimeoutMs: 1_000, killTimeoutMs: 1_000, timeoutError: 'NATIVE_REAP_TIMEOUT' });
    expectGroupAbsent(group.pid);
    expect(() => releaseStandLock(grant)).not.toThrow();
  } finally {
    await reaped;
    releaseStandLock(grant);
  }
});

test('native group that remains unreaped preserves the signal error and keeps its stand slot', async () => {
  const group = await startZombieGroup();
  const grant = await acquireStandLock({ root: join(root, 'unreaped'), reason: 'native-unreaped', waitMs: 0 });
  registerStandGroup(grant, group.pid);
  try {
    const stopping = stopProcessGroup({ pid: group.pid, termTimeoutMs: 50, killTimeoutMs: 50, timeoutError: 'NATIVE_REAP_TIMEOUT' });
    if (process.platform === 'darwin') {
      await expect(stopping).rejects.toMatchObject({
        message: `PROCESS_GROUP_SIGNAL_FAILED:pid=${group.pid}:signal=SIGTERM`, cause: { code: 'EPERM' },
      });
    } else {
      await expect(stopping).rejects.toThrow('NATIVE_REAP_TIMEOUT');
    }
    expect(() => releaseStandLock(grant)).toThrow('STAND_LOCK_CHILDREN_STILL_ALIVE');
  } finally {
    await group.reap();
    expectGroupAbsent(group.pid);
    releaseStandLock(grant);
  }
});

test('release timeout reaps the exact real child group after TERM-resistant descendants', async () => {
  const child = spawn('sh', ['-c', 'trap "" TERM; sleep 30 & echo ready; wait'], {
    detached: true,
    stdio: 'pipe',
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  const lines = createInterface({ input: child.stdout });
  await new Promise<void>((resolve, reject) => {
    lines.once('line', () => resolve());
    child.once('error', reject);
  });
  lines.close();
  if (!child.pid) throw new Error('RELEASE_GROUP_PID_MISSING');
  try {
    await terminateGateProcessGroup(child, 1_000);
    await exited;
    expectGroupAbsent(child.pid);
    expect(child.signalCode).toBe('SIGKILL');
  } finally {
    await stopProcessGroup({
      pid: child.pid,
      termTimeoutMs: 1_000,
      killTimeoutMs: 1_000,
      timeoutError: 'RELEASE_GROUP_CLEANUP_FAILED',
    });
    await exited;
  }
});
