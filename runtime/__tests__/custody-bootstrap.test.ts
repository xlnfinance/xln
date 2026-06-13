import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';

import {
  stopManagedChild,
  waitForCustodyRouteableState,
  waitForHttpReady,
  type ManagedChild,
} from '../orchestrator/custody-bootstrap';

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

test('waitForCustodyRouteableState accepts hub-side custody capacity for non-routing custody', async () => {
  const custodyId = '0xcustody';
  const hubIds = ['0xhub1', '0xhub2', '0xhub3'];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(JSON.stringify({
      entities: [
        {
          entityId: hubIds[0],
          accounts: [{ counterpartyId: custodyId, tokenCapacities: { 1: { inCapacity: '0', outCapacity: '10' } } }],
        },
        {
          entityId: hubIds[1],
          accounts: [{ counterpartyId: custodyId, tokenCapacities: { 1: { inCapacity: '0', outCapacity: '10' } } }],
        },
        {
          entityId: hubIds[2],
          accounts: [{ counterpartyId: custodyId, tokenCapacities: { 1: { inCapacity: '0', outCapacity: '10' } } }],
        },
        {
          entityId: custodyId,
          accounts: [],
          isHub: false,
        },
      ],
    }), {
      headers: { 'content-type': 'application/json' },
    }),
  });

  try {
    await expect(
      waitForCustodyRouteableState(`http://127.0.0.1:${server.port}`, custodyId, hubIds, [1], 100),
    ).resolves.toMatchObject({ entityId: custodyId });
  } finally {
    server.stop(true);
  }
});

test('stopManagedChild escalates to SIGKILL when a child ignores SIGTERM', async () => {
  const proc = spawn('node', [
    '-e',
    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('sigterm-resistant child did not become ready')), 2000);
    proc.stdout.on('data', chunk => {
      if (chunk.toString('utf8').includes('ready')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    proc.once('exit', () => {
      clearTimeout(timer);
      rejectReady(new Error('sigterm-resistant child exited before ready'));
    });
  });
  const child = {
    name: 'sigterm-resistant-child',
    proc,
    stdoutLines: [],
    stderrLines: [],
  } as unknown as ManagedChild;

  await ready;
  await expect(
    stopManagedChild(child, { terminateTimeoutMs: 100, killTimeoutMs: 1500 }),
  ).resolves.toBeUndefined();
  expect(proc.signalCode).toBe('SIGKILL');
});
