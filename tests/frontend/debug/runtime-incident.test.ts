import { expect, test } from 'bun:test';
import { decodeIncidentPayload } from '../../../frontend/src/lib/debug/runtime-incident';

test('incident evidence is decoded without granting command readiness', () => {
  const payload = {
    ok: true,
    total: 1,
    returned: 1,
    highestEventId: 3,
    incidents: [
      {
        fingerprint: 'h2_unexpected_exit-123',
        code: 'H2_UNEXPECTED_EXIT',
        runtimeId: 'h2',
        state: 'open',
        source: 'orchestrator',
        message: 'exit',
        firstSeen: 1,
        lastSeen: 2,
        count: 1,
        firstEventId: 3,
        lastEventId: 3,
      },
    ],
  };
  expect(decodeIncidentPayload(payload)).toEqual([
    { fingerprint: 'h2_unexpected_exit-123', code: 'H2_UNEXPECTED_EXIT' },
  ]);
  expect(decodeIncidentPayload({ ...payload, incidents: [] })).toEqual([]);
  expect(() => decodeIncidentPayload({ ...payload, commandReady: true })).toThrow(
    'DEBUG_INCIDENT_RESPONSE_EXTRA_FIELD',
  );
  expect(() => decodeIncidentPayload({ ...payload, incidents: [{ ...payload.incidents[0], sample: {} }] })).toThrow(
    'DEBUG_INCIDENT_EXTRA_FIELD',
  );
  expect(() => decodeIncidentPayload({ ...payload, incidents: [{ fingerprint: 123, code: 'exit' }] })).toThrow(
    'DEBUG_INCIDENT_FINGERPRINT_INVALID',
  );
  expect(() => decodeIncidentPayload({ ...payload, incidents: [{ fingerprint: 'abc' }] })).toThrow(
    'DEBUG_INCIDENT_CODE_INVALID',
  );
});
