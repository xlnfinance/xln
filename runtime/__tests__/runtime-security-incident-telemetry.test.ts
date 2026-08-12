import { expect, test } from 'bun:test';

import { publicAggregatedHealth, publicLocalHubHealth } from '../api/server/health/redaction';
import { createRelayStore } from '../network/relay/store';
import { createEmptyEnv } from '../runtime';
import {
  readRuntimeSecurityIncidentTelemetry,
  recordRuntimeSecurityIncident,
} from '../runtime/observability/security-incidents';
import {
  parseRuntimeSecurityIncidentTelemetry,
  syncRuntimeSecurityTelemetry,
} from '../orchestrator/health/runtime-security-telemetry';
import { validateHubHealthPayload } from '../orchestrator/bootstrap/bootstrap-health-validation';

const runtimeId = '0x1111111111111111111111111111111111111111';

const active = {
  id: `0x${'ab'.repeat(32)}`,
  code: 'CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH',
  source: 'remote-ingress' as const,
  severity: 'warning' as const,
  status: 'active' as const,
  firstSeenAt: 100,
  lastSeenAt: 100,
  occurrences: 1,
};

test('runtime incident health projection excludes raw evidence and routing identities', () => {
  const env = createEmptyEnv('runtime-security-telemetry-projection');
  env.error = () => undefined;
  env.state.timestamp = 100;
  recordRuntimeSecurityIncident(env, {
    domain: 'cross-j',
    code: active.code,
    source: active.source,
    severity: active.severity,
    summary: 'CANARY_INPUT_SUMMARY mnemonic abandon abandon',
    entityId: 'CANARY_ENTITY_ID',
    accountId: 'CANARY_ACCOUNT_ID',
    offerId: 'CANARY_OFFER_ID',
    routeHash: 'CANARY_ROUTE_HASH',
  });

  const projected = readRuntimeSecurityIncidentTelemetry(env);
  expect(projected).toHaveLength(1);
  expect(Object.keys(projected[0]!).sort()).toEqual([
    'code',
    'firstSeenAt',
    'id',
    'lastSeenAt',
    'occurrences',
    'severity',
    'source',
    'status',
  ]);
  const encoded = JSON.stringify(projected);
  for (const secret of ['CANARY_INPUT_SUMMARY', 'CANARY_ENTITY_ID', 'CANARY_ACCOUNT_ID', 'CANARY_OFFER_ID', 'CANARY_ROUTE_HASH']) {
    expect(encoded).not.toContain(secret);
  }
});

test('runtime incident parser strips unknown fields and rejects malformed lifecycle data', () => {
  expect(parseRuntimeSecurityIncidentTelemetry([{ ...active, summary: 'CANARY', inputSummary: 'CANARY' }]))
    .toEqual([active]);
  expect(validateHubHealthPayload({
    runtime: { securityIncidents: [{ ...active, summary: 'CANARY', inputSummary: 'CANARY' }] },
  }).runtime?.securityIncidents).toEqual([active]);
  expect(() => parseRuntimeSecurityIncidentTelemetry([{ ...active, status: 'ignored' }]))
    .toThrow('RUNTIME_SECURITY_TELEMETRY_INVALID');
  expect(() => parseRuntimeSecurityIncidentTelemetry([{ ...active, lastSeenAt: 99 }]))
    .toThrow('RUNTIME_SECURITY_TELEMETRY_INVALID');
  expect(() => parseRuntimeSecurityIncidentTelemetry([{ ...active, status: 'resolved' }]))
    .toThrow('RUNTIME_SECURITY_TELEMETRY_INVALID');
});

test('runtime incident bridge journals only changes and preserves resolution', () => {
  const store = createRelayStore('runtime-security-telemetry');
  expect(syncRuntimeSecurityTelemetry(store, 'MM', runtimeId, undefined, [active])).toBe(1);
  const first = [...store.debugIncidents.values()][0]!;
  expect(first).toMatchObject({
    state: 'unread',
    source: 'runtime-security',
    code: active.code,
    runtimeId,
    count: 1,
  });
  expect(JSON.stringify(first)).not.toContain('inputSummary');

  expect(syncRuntimeSecurityTelemetry(store, 'MM', runtimeId, [active], [active])).toBe(0);
  expect(store.debugIncidents.get(first.fingerprint)?.count).toBe(1);

  const repeated = { ...active, lastSeenAt: 110, occurrences: 2 };
  expect(syncRuntimeSecurityTelemetry(store, 'MM', runtimeId, [active], [repeated])).toBe(1);
  expect(store.debugIncidents.get(first.fingerprint)).toMatchObject({ state: 'unread', count: 2 });

  const resolved = { ...repeated, status: 'resolved' as const, resolvedAt: 120, lastSeenAt: 120 };
  expect(syncRuntimeSecurityTelemetry(store, 'MM', runtimeId, [repeated], [resolved])).toBe(1);
  expect(store.debugIncidents.get(first.fingerprint)).toMatchObject({ state: 'resolved', count: 3 });
});

test('public child and aggregate health omit operator incident telemetry', () => {
  const payload = {
    runtime: { halted: false, securityIncidents: [{ ...active, summary: 'CANARY_PUBLIC' }] },
  };
  expect(JSON.stringify(publicLocalHubHealth(payload))).not.toContain('securityIncidents');
  expect(JSON.stringify(publicAggregatedHealth(payload))).not.toContain('securityIncidents');
  expect(JSON.stringify(publicLocalHubHealth(payload))).not.toContain('CANARY_PUBLIC');
});
