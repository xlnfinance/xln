#!/usr/bin/env bun

type Incident = {
  fingerprint: string;
  state: 'unread' | 'acknowledged' | 'resolved';
  source: string;
  code: string;
  message: string;
  runtimeId?: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  lastEventId: number;
};

type IncidentResponse = {
  ok: boolean;
  returned: number;
  highestEventId: number;
  incidents: Incident[];
  error?: string;
};

const argValue = (name: string): string | undefined => {
  const direct = process.argv.find(argument => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const baseUrl = String(
  argValue('--url') ||
  process.env['XLN_DEBUG_BASE_URL'] ||
  'http://127.0.0.1:8082',
).replace(/\/+$/, '');
const state = String(argValue('--state') || 'open');
const afterId = Math.max(0, Math.floor(Number(argValue('--after-id') || '0')));
const resolveFingerprint = argValue('--resolve');
const acknowledge = process.argv.includes('--ack');

const requestJson = async (path: string, init?: RequestInit): Promise<IncidentResponse> => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: IncidentResponse;
  try {
    body = JSON.parse(text) as IncidentResponse;
  } catch {
    throw new Error(`DEBUG_SERVICE_RESPONSE_INVALID:${response.status}:${text.slice(0, 300)}`);
  }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error || `DEBUG_SERVICE_HTTP_${response.status}`);
  }
  return body;
};

const setState = async (fingerprint: string, nextState: Incident['state']): Promise<void> => {
  await requestJson('/api/debug/incidents/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint, state: nextState }),
  });
};

if (resolveFingerprint) {
  await setState(resolveFingerprint, 'resolved');
  console.log(`DEBUG_INCIDENT_RESOLVED fingerprint=${resolveFingerprint}`);
  process.exit(0);
}

const params = new URLSearchParams({ state, afterId: String(afterId), limit: '1000' });
const result = await requestJson(`/api/debug/incidents?${params.toString()}`);
console.log(
  `DEBUG_INCIDENTS base=${baseUrl} state=${state} returned=${result.returned} highestEventId=${result.highestEventId}`,
);
for (const incident of result.incidents) {
  console.log([
    incident.state.toUpperCase(),
    incident.code,
    `count=${incident.count}`,
    `source=${incident.source}`,
    `runtime=${incident.runtimeId || 'none'}`,
    `fingerprint=${incident.fingerprint}`,
    `last=${new Date(incident.lastSeen).toISOString()}`,
    `message=${incident.message.replace(/\s+/g, ' ').slice(0, 500)}`,
  ].join(' '));
}
if (acknowledge) {
  await Promise.all(result.incidents.map(incident => setState(incident.fingerprint, 'acknowledged')));
  console.log(`DEBUG_INCIDENTS_ACKNOWLEDGED count=${result.incidents.length}`);
}
if (result.incidents.length > 0) process.exitCode = 1;
