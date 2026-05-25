import { expect, test } from 'bun:test';

import { waitForHttpReady, type ManagedChild } from '../orchestrator/custody-bootstrap';

test('waitForHttpReady rejects when the spawned child exited behind a stale ready listener', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    }),
  });

  const exitedChild = {
    name: 'custody-daemon',
    proc: { exitCode: 1 },
    stdoutLines: [],
    stderrLines: ['Failed to start server. Is port already in use?'],
  } as unknown as ManagedChild;

  try {
    await expect(
      waitForHttpReady(`http://127.0.0.1:${server.port}/api/health`, exitedChild, 100),
    ).rejects.toThrow(/custody-daemon exited early/);
  } finally {
    server.stop(true);
  }
});
