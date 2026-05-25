import { expect, test } from 'bun:test';

import { waitForCustodyRouteableState, waitForHttpReady, type ManagedChild } from '../orchestrator/custody-bootstrap';

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
