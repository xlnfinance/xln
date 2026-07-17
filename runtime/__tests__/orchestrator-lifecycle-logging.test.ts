import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createHttpDrainTracker, stopServerGracefully } from '../orchestrator/graceful-server';
import { startParentLivenessWatch } from '../orchestrator/parent-watch';

const withSuppressedStructuredLogs = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const previousScopes = process.env['XLN_LOG_SCOPES'];
  process.env['XLN_LOG_SCOPES'] = 'test-suppressed';
  try {
    return await fn();
  } finally {
    if (previousScopes === undefined) delete process.env['XLN_LOG_SCOPES'];
    else process.env['XLN_LOG_SCOPES'] = previousScopes;
  }
};

test('orchestrator lifecycle helpers use structured logging without direct console output', () => {
  const files = [
    'runtime/orchestrator/graceful-server.ts',
    'runtime/orchestrator/managed-runtime-leases.ts',
    'runtime/orchestrator/parent-watch.ts',
  ];
  const sources = files.map((file) => readFileSync(join(process.cwd(), file), 'utf8'));

  expect(sources.join('\n')).toContain("createStructuredLogger('orchestrator.lifecycle')");
  expect(sources.join('\n')).toContain("createStructuredLogger('orchestrator.managed_leases')");
  expect(sources.join('\n')).toContain("createStructuredLogger('orchestrator.parent_watch')");
  for (const source of sources) {
    expect(source).not.toContain('console.');
  }
});

test('HTTP drain timeout still force-closes active connections', async () => {
  await withSuppressedStructuredLogs(async () => {
    const tracker = createHttpDrainTracker();
    const release = tracker.begin();
    const stopCalls: Array<boolean | undefined> = [];
    const idle = await stopServerGracefully({ stop: (force) => stopCalls.push(force) }, tracker, 'test-http', 1);

    release();
    expect(idle).toBe(false);
    expect(stopCalls).toEqual([false, true]);
  });
});

test('parent watch still fails closed on missing parent pid', async () => {
  await withSuppressedStructuredLogs(async () => {
    const previousAllow = process.env['XLN_ALLOW_ORPHAN_RUNTIME'];
    try {
      delete process.env['XLN_ALLOW_ORPHAN_RUNTIME'];
      let lost = 0;
      const stop = startParentLivenessWatch('test-runtime', undefined, () => {
        lost += 1;
      }, 1);

      await delay(0);
      stop();
      expect(lost).toBe(1);
    } finally {
      if (previousAllow === undefined) delete process.env['XLN_ALLOW_ORPHAN_RUNTIME'];
      else process.env['XLN_ALLOW_ORPHAN_RUNTIME'] = previousAllow;
    }
  });
});

test('managed custody children terminate when their spawning process is replaced', () => {
  const bootstrap = readFileSync(join(process.cwd(), 'runtime/orchestrator/custody-bootstrap.ts'), 'utf8');
  const daemon = readFileSync(join(process.cwd(), 'runtime/server/index.ts'), 'utf8');
  const custody = readFileSync(join(process.cwd(), 'custody/server.ts'), 'utf8');

  expect(bootstrap).toContain("XLN_MANAGED_PARENT_PID: String(process.pid)");
  expect(daemon).toContain("startParentLivenessWatch('runtime-server'");
  expect(custody).toContain("startParentLivenessWatch('custody-service'");
});

test('managed child survives with its parent and exits after the exact parent is killed', async () => {
  const fixture = join(process.cwd(), 'runtime/__tests__/fixtures/parent-watch-process.ts');
  const parent = spawn('bun', [fixture, 'parent'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childPid = 0;
  try {
    childPid = await new Promise<number>((resolvePid, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error('PARENT_WATCH_CHILD_READY_TIMEOUT')), 5_000);
      parent.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        const match = stdout.match(/CHILD_READY:(\d+)/);
        if (!match) return;
        clearTimeout(timeout);
        resolvePid(Number(match[1]));
      });
      parent.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`PARENT_WATCH_PARENT_EXITED_EARLY:${String(code)}:${String(signal)}`));
      });
    });

    expect(() => process.kill(childPid, 0)).not.toThrow();
    parent.kill('SIGKILL');
    const deadline = Date.now() + 5_000;
    let childExited = false;
    while (Date.now() < deadline) {
      try {
        process.kill(childPid, 0);
      } catch {
        childExited = true;
        break;
      }
      await delay(25);
    }
    expect(childExited).toBe(true);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    if (childPid > 1) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // Already exited as required.
      }
    }
  }
});
