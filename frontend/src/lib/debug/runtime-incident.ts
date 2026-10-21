import { readJsonUnknown, rejectExtraKeys, requireString, requireUnknownRecord } from '../utils/boundary/index.ts';

type Incident = {
  fingerprint: string;
  code: string;
};

export function decodeIncidentPayload(value: unknown): Incident[] {
  const record = requireUnknownRecord(value, 'DEBUG_INCIDENT_RESPONSE_INVALID');
  rejectExtraKeys(
    record,
    ['ok', 'total', 'returned', 'highestEventId', 'incidents'],
    'DEBUG_INCIDENT_RESPONSE_EXTRA_FIELD',
  );
  if (record['ok'] !== true || !Array.isArray(record['incidents'])) throw new Error('DEBUG_INCIDENT_RESPONSE_INVALID');
  return record['incidents'].map(entry => {
    const incident = requireUnknownRecord(entry, 'DEBUG_INCIDENT_INVALID');
    rejectExtraKeys(
      incident,
      [
        'fingerprint',
        'state',
        'source',
        'code',
        'message',
        'runtimeId',
        'firstSeen',
        'lastSeen',
        'count',
        'firstEventId',
        'lastEventId',
      ],
      'DEBUG_INCIDENT_EXTRA_FIELD',
    );
    return {
      fingerprint: requireString(incident['fingerprint'], 'DEBUG_INCIDENT_FINGERPRINT_INVALID'),
      code: requireString(incident['code'], 'DEBUG_INCIDENT_CODE_INVALID'),
    };
  });
}

export type IncidentLookup =
  { status: 'found'; fingerprint: string; code: string } | { status: 'not-found' } | { status: 'error'; error: string };

/** Diagnostic journal only: never grants command readiness or bypasses server operator access. */
export async function loadRuntimeIncident(
  apiBase: string,
  runtimeId: string,
  signal: AbortSignal,
): Promise<IncidentLookup> {
  let lastError = '';
  for (const delayMs of [0, 250, 750]) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    signal.throwIfAborted();
    try {
      const url = new URL('/api/debug/incidents', apiBase);
      url.searchParams.set('state', 'open');
      url.searchParams.set('runtimeId', runtimeId);
      url.searchParams.set('limit', '1');
      const response = await fetch(url, { cache: 'no-store', signal });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const incident = decodeIncidentPayload(await readJsonUnknown(response))[0];
      if (incident) return { status: 'found', fingerprint: incident.fingerprint, code: incident.code };
      lastError = '';
    } catch (error) {
      signal.throwIfAborted();
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return lastError ? { status: 'error', error: lastError } : { status: 'not-found' };
}
