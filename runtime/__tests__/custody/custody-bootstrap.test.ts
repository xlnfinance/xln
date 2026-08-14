import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { safeStringify } from '../../protocol/serialization';

import {
  decodeDaemonControlCliResult,
  isPublicDaemonHealthReady,
  stopManagedChild,
  waitForCustodyRouteableState,
  waitForHttpReady,
  type ManagedChild,
} from '../../orchestrator/bootstrap/custody-bootstrap';

test('daemon control setup result validates the complete secret-bearing identity boundary', () => {
  const identity = {
    entityId: `0x${'11'.repeat(32)}`,
    signerId: `0x${'22'.repeat(20)}`,
    privateKeyHex: `0x${'33'.repeat(32)}`,
    entitySeed: `0x${'44'.repeat(64)}`,
    consensusConfig: {
      mode: 'proposer-based',
      shares: { [`0x${'22'.repeat(20)}`]: 1n },
      threshold: 1n,
      validators: [`0x${'22'.repeat(20)}`],
    },
    position: { x: 0, y: 0, z: 0 },
    name: 'Custody',
  };
  expect(decodeDaemonControlCliResult({ ok: true, command: 'setup-custody', result: identity }))
    .toEqual({
      ok: true,
      command: 'setup-custody',
      result: { entityId: identity.entityId, signerId: identity.signerId, name: 'Custody' },
    });
  expect(() => decodeDaemonControlCliResult({
    ok: true,
    command: 'setup-custody',
    result: { ...identity, privateKeyHex: '0x01' },
  })).toThrow('DAEMON_CONTROL_RESULT_PRIVATE_KEY_INVALID');
});

const publicHealth = (runtime: boolean, phase: 'starting' | 'ready'): Record<string, unknown> => ({
  timestamp: 1,
  uptime: 2,
  coreOk: true,
  systemOk: true,
  degraded: [],
  failures: [],
  system: { runtime, p2p: true, relay: true },
  source: { height: 0 },
  bootstrap: {},
  boot: { phase, startedAt: 'now', completedAt: phase === 'ready' ? 'now' : null, error: null },
  relay: {},
  hubMesh: {},
  marketMaker: {},
  custody: {},
  bootstrapReserves: {},
  disk: {},
  storage: {},
  hubs: [],
});

test('public daemon health waits for completed runtime boot without private health fields', () => {
  expect(isPublicDaemonHealthReady(publicHealth(true, 'ready'))).toBe(true);
  expect(isPublicDaemonHealthReady(publicHealth(true, 'starting'))).toBe(false);
  expect(isPublicDaemonHealthReady(publicHealth(false, 'ready'))).toBe(false);
  expect(isPublicDaemonHealthReady({ ...publicHealth(true, 'ready'), privateAdapter: {} })).toBe(false);
  expect(isPublicDaemonHealthReady(null)).toBe(false);
});

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
  const debugEntity = (entityId: string, accounts: unknown[], isHub: boolean): Record<string, unknown> => ({
    entityId,
    name: entityId,
    isHub,
    online: true,
    lastUpdated: 1,
    accounts,
    publicAccounts: [],
    metadata: {},
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(safeStringify({
      entities: [
        debugEntity(hubIds[0], [{ counterpartyId: custodyId, tokenCapacities: { 1: { inCapacity: 0n, outCapacity: 10n } } }], true),
        debugEntity(hubIds[1], [{ counterpartyId: custodyId, tokenCapacities: { 1: { inCapacity: 0n, outCapacity: 10n } } }], true),
        debugEntity(hubIds[2], [{ counterpartyId: custodyId, tokenCapacities: { 1: { inCapacity: 0n, outCapacity: 10n } } }], true),
        debugEntity(custodyId, [], false),
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

test('stopManagedChild fails loudly when neither signal reaches a live child', async () => {
  const signals: NodeJS.Signals[] = [];
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    pid: 4242,
    kill: (signal: NodeJS.Signals) => {
      signals.push(signal);
      throw new Error(`${signal}_FAILED`);
    },
  });
  const child = {
    name: 'unreachable-child',
    proc,
    stdoutLines: ['still running'],
    stderrLines: ['signal transport unavailable'],
  } as unknown as ManagedChild;

  await expect(
    stopManagedChild(child, { terminateTimeoutMs: 10, killTimeoutMs: 10 }),
  ).rejects.toThrow(/MANAGED_CHILD_STOP_TIMEOUT[\s\S]*SIGTERM_FAILED[\s\S]*SIGKILL_FAILED/);
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
});
