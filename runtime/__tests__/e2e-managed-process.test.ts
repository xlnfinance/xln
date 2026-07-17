import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';

import {
  stopProcess,
  stopProcessDependencyChain,
  type ManagedChildProcess,
  waitForProcessClose,
} from '../scripts/e2e-managed-process';

const waitForOutput = async (child: ManagedChildProcess, marker: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (!chunk.toString('utf8').includes(marker)) return;
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
  });
};

test('managed child stop waits for inherited output pipes to close', async () => {
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {
      spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 240)'], {
        stdio: ['ignore', process.stdout, process.stderr],
      });
      process.exit(0);
    });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1_000);
  `], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ManagedChildProcess;

  await waitForOutput(child, 'READY');

  const startedAt = performance.now();
  await stopProcess(child, 1_000);
  const elapsedMs = performance.now() - startedAt;

  expect(child.exitCode).not.toBeNull();
  expect(elapsedMs).toBeGreaterThanOrEqual(180);
  expect(child.stdout.destroyed || child.stdout.readableEnded).toBe(true);
  expect(child.stderr.destroyed || child.stderr.readableEnded).toBe(true);
});

test('managed child stop surfaces an inherited output drain timeout', async () => {
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {
      spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 180)'], {
        stdio: ['ignore', process.stdout, process.stderr],
      });
      process.exit(0);
    });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1_000);
  `], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ManagedChildProcess;
  await waitForOutput(child, 'READY');

  await expect(stopProcess(child, 20)).rejects.toThrow('MANAGED_CHILD_PROCESS_OUTPUT_DRAIN_TIMEOUT');
  expect(await waitForProcessClose(child, 1_000)).toBe(true);
});

test('managed process dependency chain closes proxy before upstream', async () => {
  const spawnProcess = (label: string, closeDelayMs: number): ManagedChildProcess => spawn(
    process.execPath,
    ['-e', `
      process.on('SIGTERM', () => {
        process.stdout.write('${label}:term\\n');
        setTimeout(() => {
          process.stdout.write('${label}:closed\\n');
          process.exit(0);
        }, ${String(closeDelayMs)});
      });
      process.stdout.write('${label}:ready\\n');
      setInterval(() => {}, 1_000);
    `],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ManagedChildProcess;

  const proxy = spawnProcess('proxy', 40);
  const upstream = spawnProcess('upstream', 0);
  const events: string[] = [];
  const ready = Promise.all([
    waitForOutput(proxy, 'proxy:ready'),
    waitForOutput(upstream, 'upstream:ready'),
  ]);
  for (const child of [proxy, upstream]) {
    child.stdout.on('data', (chunk: Buffer) => {
      events.push(...chunk.toString('utf8').trim().split('\n').filter(line => !line.endsWith(':ready')));
    });
  }
  await ready;

  await stopProcessDependencyChain([
    { label: 'vite-proxy', proc: proxy, termTimeoutMs: 1_000 },
    { label: 'api-upstream', proc: upstream, termTimeoutMs: 1_000 },
  ]);

  expect(events).toEqual([
    'proxy:term',
    'proxy:closed',
    'upstream:term',
    'upstream:closed',
  ]);
});
