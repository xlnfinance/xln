import { safeStringify } from '../protocol/serialization';
import {
  pushDebugEvent,
  setDebugIncidentState,
  type RelayDebugIncidentState,
  type RelayStore,
} from './store';

export type RelayDebugHttpInput = {
  request: Request;
  pathname: string;
  url: URL;
  headers: HeadersInit;
  store: RelayStore;
  operatorAuthorized: boolean;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const boundedString = (value: unknown, maxLength: number): string | undefined => {
  const text = optionalString(value);
  return text ? text.slice(0, maxLength) : undefined;
};

const json = (
  input: RelayDebugHttpInput,
  body: unknown,
  status = 200,
): Response => new Response(safeStringify(body), { status, headers: input.headers });

const loopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

const ingestOriginAllowed = (request: Request): boolean => {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    return originUrl.origin === requestUrl.origin ||
      (loopback(originUrl.hostname) && loopback(requestUrl.hostname));
  } catch {
    return false;
  }
};

const handleEvents = (input: RelayDebugHttpInput): Response => {
  const last = Math.max(1, Math.min(5000, Number(input.url.searchParams.get('last') || '200')));
  const event = input.url.searchParams.get('event') || undefined;
  const runtimeId = input.url.searchParams.get('runtimeId') || undefined;
  const from = input.url.searchParams.get('from') || undefined;
  const to = input.url.searchParams.get('to') || undefined;
  const msgType = input.url.searchParams.get('msgType') || undefined;
  const status = input.url.searchParams.get('status') || undefined;
  const since = Number(input.url.searchParams.get('since') || '0');
  let filtered = input.store.debugEvents;
  if (since > 0) filtered = filtered.filter(entry => entry.ts >= since);
  if (event) filtered = filtered.filter(entry => entry.event === event);
  if (runtimeId) {
    filtered = filtered.filter(entry =>
      entry.runtimeId === runtimeId || entry.from === runtimeId || entry.to === runtimeId,
    );
  }
  if (from) filtered = filtered.filter(entry => entry.from === from);
  if (to) filtered = filtered.filter(entry => entry.to === to);
  if (msgType) filtered = filtered.filter(entry => entry.msgType === msgType);
  if (status) filtered = filtered.filter(entry => entry.status === status);
  const events = filtered.slice(-last);
  return json(input, {
    ok: true,
    total: input.store.debugEvents.length,
    returned: events.length,
    serverTime: Date.now(),
    filters: { last, event, runtimeId, from, to, msgType, status, since: Number.isFinite(since) ? since : 0 },
    events,
  });
};

const handleMark = async (input: RelayDebugHttpInput): Promise<Response> => {
  const body = await input.request.json().catch(() => null) as Record<string, unknown> | null;
  const label = optionalString(body?.['label']);
  if (!label) return json(input, { ok: false, error: 'DEBUG_MARK_LABEL_REQUIRED' }, 400);
  const runtimeId = optionalString(body?.['runtimeId']);
  const entityId = optionalString(body?.['entityId']);
  const phase = optionalString(body?.['phase']);
  const details = body?.['details'] && typeof body['details'] === 'object'
    ? body['details']
    : undefined;
  pushDebugEvent(input.store, {
    event: 'e2e_phase',
    runtimeId,
    status: 'marked',
    details: { label, entityId, phase, details },
  });
  return json(input, { ok: true, label });
};

const handleBrowserIngest = async (input: RelayDebugHttpInput): Promise<Response> => {
  if (!ingestOriginAllowed(input.request)) {
    return json(input, { ok: false, error: 'DEBUG_INGEST_ORIGIN_REJECTED' }, 403);
  }
  const declaredBytes = Number(input.request.headers.get('content-length') || '0');
  if (Number.isFinite(declaredBytes) && declaredBytes > 64 * 1024) {
    return json(input, { ok: false, error: 'DEBUG_INGEST_BODY_TOO_LARGE' }, 413);
  }
  const text = await input.request.text();
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) {
    return json(input, { ok: false, error: 'DEBUG_INGEST_BODY_TOO_LARGE' }, 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(input, { ok: false, error: 'DEBUG_INGEST_JSON_INVALID' }, 400);
  }
  const records = parsed && typeof parsed === 'object' && Array.isArray((parsed as { events?: unknown }).events)
    ? (parsed as { events: unknown[] }).events
    : [parsed];
  if (records.length === 0 || records.length > 20) {
    return json(input, { ok: false, error: 'DEBUG_INGEST_EVENT_COUNT_INVALID' }, 400);
  }
  for (const item of records) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return json(input, { ok: false, error: 'DEBUG_INGEST_EVENT_INVALID' }, 400);
    }
    const event = item as Record<string, unknown>;
    const message = boundedString(event['message'], 4000);
    if (!message) return json(input, { ok: false, error: 'DEBUG_INGEST_MESSAGE_REQUIRED' }, 400);
    const kind = boundedString(event['kind'], 80) ?? 'console_error';
    pushDebugEvent(input.store, {
      event: 'browser_error',
      runtimeId: boundedString(event['runtimeId'], 200),
      status: 'error',
      reason: boundedString(event['code'], 200) ?? kind,
      details: {
        source: 'browser',
        severity: 'error',
        kind,
        message,
        stack: boundedString(event['stack'], 8000),
        route: boundedString(event['route'], 500),
        sessionId: boundedString(event['sessionId'], 100),
        entityId: boundedString(event['entityId'], 200),
        build: boundedString(event['build'], 200),
        clientAt: Number.isFinite(Number(event['at'])) ? Math.floor(Number(event['at'])) : undefined,
      },
    });
  }
  return json(input, { ok: true, accepted: records.length }, 202);
};

const handleIncidents = (input: RelayDebugHttpInput): Response => {
  const state = boundedString(input.url.searchParams.get('state'), 30);
  const runtimeId = boundedString(input.url.searchParams.get('runtimeId'), 200);
  const afterId = Math.max(0, Math.floor(Number(input.url.searchParams.get('afterId') || '0')));
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(input.url.searchParams.get('limit') || '200'))));
  const states = new Set<RelayDebugIncidentState>(['unread', 'acknowledged', 'resolved']);
  if (state && state !== 'open' && !states.has(state as RelayDebugIncidentState)) {
    return json(input, { ok: false, error: 'DEBUG_INCIDENT_STATE_INVALID' }, 400);
  }
  const incidents = Array.from(input.store.debugIncidents.values())
    .filter(incident => !state || (state === 'open' ? incident.state !== 'resolved' : incident.state === state))
    .filter(incident => !runtimeId || incident.runtimeId === runtimeId)
    .filter(incident => incident.lastEventId > afterId)
    .sort((left, right) => right.lastSeen - left.lastSeen)
    .slice(0, limit)
    .map(({ sample: _sample, ...incident }) => incident);
  return json(input, {
    ok: true,
    total: input.store.debugIncidents.size,
    returned: incidents.length,
    highestEventId: input.store.debugId,
    incidents,
  });
};

const handleIncidentState = async (input: RelayDebugHttpInput): Promise<Response> => {
  if (!input.operatorAuthorized) return json(input, { ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, 403);
  const body = await input.request.json().catch(() => null) as Record<string, unknown> | null;
  const fingerprint = boundedString(body?.['fingerprint'], 300);
  const state = boundedString(body?.['state'], 30) as RelayDebugIncidentState | undefined;
  const states = new Set<RelayDebugIncidentState>(['unread', 'acknowledged', 'resolved']);
  if (!fingerprint || !state || !states.has(state)) {
    return json(input, { ok: false, error: 'DEBUG_INCIDENT_STATE_INPUT_INVALID' }, 400);
  }
  try {
    return json(input, { ok: true, incident: setDebugIncidentState(input.store, fingerprint, state) });
  } catch (error) {
    return json(input, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 404);
  }
};

export const maybeHandleRelayDebugRequest = async (
  input: RelayDebugHttpInput,
): Promise<Response | null> => {
  if (input.pathname === '/api/debug/events' && input.request.method === 'GET') return handleEvents(input);
  if (input.pathname === '/api/debug/events/mark' && input.request.method === 'POST') return await handleMark(input);
  if (input.pathname === '/api/debug/events/ingest' && input.request.method === 'POST') {
    return await handleBrowserIngest(input);
  }
  if (input.pathname === '/api/debug/incidents' && input.request.method === 'GET') return handleIncidents(input);
  if (input.pathname === '/api/debug/incidents/state' && input.request.method === 'POST') {
    return await handleIncidentState(input);
  }
  return null;
};
