import { describe, expect, test } from 'bun:test';

import {
  MAX_RUNTIME_SECURITY_INCIDENTS,
  buildRuntimeSecurityIncidentId,
  recordRuntimeSecurityIncident,
} from '../../../runtime/observability/security-incidents';
import { createEmptyEnv } from '../../../runtime';
import { buildDurableRuntimeMachineSnapshot, restoreDurableRuntimeSnapshot } from '../../../storage/wal/snapshot';
import { validateDurableRuntimeMachineSnapshot } from '../../../storage/wal/runtime-machine-schema';

const incident = {
  domain: 'cross-j' as const,
  code: 'CROSS_J_FILL_ACK_TTL_EXPIRED',
  source: 'local-consensus' as const,
  severity: 'critical' as const,
  summary: 'Committed sibling fill acknowledgement is unmatched',
  entityId: '0xentity',
  accountId: '0xaccount',
  offerId: 'offer-1',
  routeHash: '0xroute',
};

describe('runtime security incidents', () => {
  test('deduplicates one deterministic cross-j incident', () => {
    const env = createEmptyEnv('security-incident-lifecycle');
    let activeLogCount = 0;
    env.error = () => {
      activeLogCount += 1;
    };
    env.state.timestamp = 100;

    recordRuntimeSecurityIncident(env, incident);
    env.state.timestamp = 110;
    recordRuntimeSecurityIncident(env, incident);

    const id = buildRuntimeSecurityIncidentId(incident);
    expect(env.infrastructure?.securityIncidents?.size).toBe(1);
    expect(env.infrastructure?.securityIncidents?.get(id)).toMatchObject({
      status: 'active',
      firstSeenAt: 100,
      lastSeenAt: 110,
      occurrences: 2,
    });
    expect(activeLogCount).toBe(1);
  });

  test('bounds incident memory and aggregates overflow without throwing', () => {
    const env = createEmptyEnv('security-incident-capacity');
    env.error = () => undefined;
    env.state.timestamp = 100;
    for (let index = 0; index < MAX_RUNTIME_SECURITY_INCIDENTS + 20; index += 1) {
      recordRuntimeSecurityIncident(env, {
        ...incident,
        offerId: `offer-${index}`,
      });
    }

    expect(env.infrastructure?.securityIncidents?.size).toBe(MAX_RUNTIME_SECURITY_INCIDENTS);
    expect(env.infrastructure?.securityIncidents?.get('cross-j:incident-capacity')).toMatchObject({
      status: 'active',
      code: 'SECURITY_INCIDENT_CAPACITY_REACHED',
      occurrences: 21,
    });
  });

  test('keeps rejected-input telemetry outside the durable Runtime machine', () => {
    const env = createEmptyEnv('security-incident-durable-source');
    env.error = () => undefined;
    env.state.timestamp = 500;
    recordRuntimeSecurityIncident(env, incident);

    const snapshot = buildDurableRuntimeMachineSnapshot(env);
    expect(() => validateDurableRuntimeMachineSnapshot(snapshot, 'SECURITY_TEST')).not.toThrow();
    expect(JSON.stringify(snapshot)).not.toContain('securityIncidents');
    const restored = createEmptyEnv('security-incident-durable-target');
    restoreDurableRuntimeSnapshot(restored, snapshot);
    expect(restored.infrastructure?.securityIncidents).toBeUndefined();
  });
});
