import { expect, test } from 'bun:test';
import {
  isLocalOperatorRequest,
  publicAggregatedHealth,
  publicLocalHubHealth,
  publicRuntimeHealth,
} from '../server/health-redaction';

test('health redaction keeps local operator requests on loopback only', () => {
  expect(isLocalOperatorRequest(
    new Request('http://127.0.0.1:8080/api/health'),
    '127.0.0.1',
  )).toBe(true);
  expect(isLocalOperatorRequest(
    new Request('http://127.0.0.1:8080/api/health', { headers: { host: '127.0.0.1' } }),
    '203.0.113.9',
  )).toBe(false);
  expect(isLocalOperatorRequest(new Request('http://127.0.0.1:8080/api/health', {
    headers: { 'x-forwarded-for': '203.0.113.9' },
  }), '127.0.0.1')).toBe(false);
});

test('public runtime health strips operational identifiers and reserves', () => {
  const publicPayload = publicRuntimeHealth({
    timestamp: 1,
    systemOk: true,
    relay: {
      activeClientCount: 2,
      activeClients: ['runtime-secret'],
      clientsDetailed: [{ runtimeId: 'runtime-secret' }],
      profiles: [{ runtimeId: 'runtime-secret' }],
      profileCount: 1,
    },
    hubs: [{
      entityId: '0xhub',
      name: 'H1',
      runtimeId: 'runtime-secret',
      accounts: 100,
      reserves: { '1': '1000000' },
      status: 'healthy',
      online: true,
    }],
  });
  const body = JSON.stringify(publicPayload);

  expect(body).not.toContain('runtime-secret');
  expect(body).not.toContain('reserves');
  expect(body).not.toContain('accounts');
  expect(body).not.toContain('activeClients');
  expect(body).toContain('activeClientCount');
});

test('public hub health exposes halted status without leaking fatal internals', () => {
  const publicPayload = publicLocalHubHealth({
    ok: false,
    name: 'H1',
    runtime: {
      halted: true,
      lifecyclePhase: 'halted',
      fatalDebugPayload: { message: 'secret invariant payload', stack: 'secret stack' },
    },
    gossip: {},
    mesh: {},
    bootstrapReserves: {},
    jadapter: {},
  });
  const body = JSON.stringify(publicPayload);

  expect(publicPayload.runtime).toEqual({ halted: true });
  expect(body).not.toContain('secret invariant payload');
  expect(body).not.toContain('secret stack');
});

test('public aggregated health strips child process ids and hub runtime ids', () => {
  const publicPayload = publicAggregatedHealth({
    timestamp: 1,
    coreOk: true,
    systemOk: true,
    failures: [{
      category: 'TransientRace',
      code: 'HUBS_NOT_READY',
      message: 'internal hub pid 999 stale',
      retryable: true,
      fatal: false,
    }],
    relay: {
      clientCount: 1,
      managedRuntimeIds: ['runtime-secret'],
      externalClientIds: ['runtime-external'],
    },
    process: {
      pid: 123,
      ownerId: 'owner-secret',
      children: [{ pid: 999, dbPath: '/secret/db' }],
    },
    marketMaker: {
      enabled: true,
      ok: false,
      failure: {
        category: 'TransientRace',
        code: 'MARKET_MAKER_CROSS_NOT_READY',
        message: 'internal route 0xsecret is still empty',
        retryable: true,
        fatal: false,
      },
    },
    hubs: [{ name: 'H1', runtimeId: 'runtime-secret', entityId: '0xhub', accounts: 100, online: true }],
  });
  const body = JSON.stringify(publicPayload);

  expect(body).not.toContain('runtime-secret');
  expect(body).not.toContain('owner-secret');
  expect(body).not.toContain('/secret/db');
  expect(body).not.toContain('accounts');
  expect(body).not.toContain('internal hub pid');
  expect(body).not.toContain('internal route');
  expect(body).toContain('HUBS_NOT_READY');
  expect(body).toContain('MARKET_MAKER_CROSS_NOT_READY');
  expect(body).toContain('TransientRace');
  expect(body).toContain('childCount');
});

test('public aggregated health keeps bootstrap timeline evidence without state hashes', () => {
  const publicPayload = publicAggregatedHealth({
    timestamp: 1,
    bootstrapTimeline: {
      readyHash: 'ready-hash',
      runtimeStateHash: 'runtime-state-secret',
      entityStateHash: 'entity-state-secret',
      readyAt: 123,
      healthPoll: { actualMs: 42, budgetMs: 1500 },
      backlog: {
        processing: false,
        runtimeTxs: 1,
        entityInputs: 2,
        jInputs: 3,
        queuedEntityInputCount: 4,
        queuedEntityTxCount: 5,
        total: 6,
        queuedEntityInputs: [{ entityId: 'secret', txTypes: ['secretTx'] }],
      },
      lastEvent: { event: 'ready-hash', stage: 'offers-ready', at: '2026-06-24T00:00:00.000Z', height: 9 },
      stages: [{
        key: 'health-poll',
        label: 'Health Poll',
        status: 'blocked',
        reason: 'Latest /api/health child refresh window',
        failure: {
          category: 'TransientRace',
          code: 'BOOTSTRAP_HEALTH_POLL_NOT_READY',
          message: 'internal child pid 123 timed out',
          retryable: true,
          fatal: false,
        },
        budgetMs: 1500,
        actualMs: 42,
        evidence: [{ label: 'actual', value: 42, unit: 'ms' }],
      }],
    },
  });
  const body = JSON.stringify(publicPayload);

  expect(body).toContain('ready-hash');
  expect(body).toContain('Health Poll');
  expect(body).toContain('actualMs');
  expect(body).toContain('queuedEntityTxCount');
  expect(body).toContain('BOOTSTRAP_HEALTH_POLL_NOT_READY');
  expect(body).toContain('TransientRace');
  expect(body).not.toContain('runtime-state-secret');
  expect(body).not.toContain('entity-state-secret');
  expect(body).not.toContain('secretTx');
  expect(body).not.toContain('entityId');
  expect(body).not.toContain('internal child pid');
  expect(body).not.toContain('Latest /api/health child refresh window');
});
