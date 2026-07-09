import { expect, test } from 'bun:test';
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
