import { expect, test } from 'bun:test';
import {
  isLocalOperatorRequest,
  publicAggregatedHealth,
  publicRuntimeHealth,
} from '../health-redaction';

test('health redaction keeps local operator requests on loopback only', () => {
  expect(isLocalOperatorRequest(new Request('http://127.0.0.1:8080/api/health'))).toBe(true);
  expect(isLocalOperatorRequest(new Request('https://xln.finance/api/health'))).toBe(false);
  expect(isLocalOperatorRequest(new Request('http://127.0.0.1:8080/api/health', {
    headers: { 'x-forwarded-for': '203.0.113.9' },
  }))).toBe(false);
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

test('public aggregated health strips child process ids and hub runtime ids', () => {
  const publicPayload = publicAggregatedHealth({
    timestamp: 1,
    coreOk: true,
    systemOk: true,
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
    hubs: [{ name: 'H1', runtimeId: 'runtime-secret', entityId: '0xhub', accounts: 100, online: true }],
  });
  const body = JSON.stringify(publicPayload);

  expect(body).not.toContain('runtime-secret');
  expect(body).not.toContain('owner-secret');
  expect(body).not.toContain('/secret/db');
  expect(body).not.toContain('accounts');
  expect(body).toContain('childCount');
});
