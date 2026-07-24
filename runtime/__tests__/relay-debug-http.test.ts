import { expect, test } from 'bun:test';
import { maybeHandleRelayDebugRequest } from '../relay/debug-http';
import { clearDebugTimeline, createRelayStore, pushDebugEvent } from '../relay/store';

const call = async (
  store: ReturnType<typeof createRelayStore>,
  path: string,
  init: RequestInit = {},
  operatorAuthorized = false,
): Promise<{ status: number; body: any }> => {
  const request = new Request(`http://127.0.0.1:8082${path}`, init);
  const response = await maybeHandleRelayDebugRequest({
    request,
    pathname: new URL(request.url).pathname,
    url: new URL(request.url),
    headers: { 'content-type': 'application/json' },
    store,
    operatorAuthorized,
  });
  if (!response) throw new Error(`DEBUG_ROUTE_NOT_HANDLED:${path}`);
  return { status: response.status, body: await response.json() };
};

test('browser errors enter the shared incident registry without exposing samples', async () => {
  const store = createRelayStore('relay-test');
  const ingested = await call(store, '/api/debug/events/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:8080',
    },
    body: JSON.stringify({
      events: [{
        kind: 'console_error',
        message: 'FAUCET_FAILED',
        stack: 'Error: FAUCET_FAILED\n at click (SwapPanel.svelte:1)',
        route: '/app',
        sessionId: 'page-1',
      }],
    }),
  });
  expect(ingested).toMatchObject({ status: 202, body: { ok: true, accepted: 1 } });

  const queried = await call(store, '/api/debug/incidents?state=unread');
  expect(queried.status).toBe(200);
  expect(queried.body.incidents).toHaveLength(1);
  expect(queried.body.incidents[0]).toMatchObject({
    state: 'unread',
    source: 'browser',
    code: 'CONSOLE_ERROR',
    message: 'FAUCET_FAILED',
  });
  expect(queried.body.incidents[0].sample).toBeUndefined();
});

test('incident state mutation requires operator authorization', async () => {
  const store = createRelayStore('relay-test');
  pushDebugEvent(store, { event: 'error', reason: 'FATAL_STORAGE', status: 'fatal' });
  const fingerprint = Array.from(store.debugIncidents.keys())[0]!;
  const body = JSON.stringify({ fingerprint, state: 'resolved' });

  expect(await call(store, '/api/debug/incidents/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })).toMatchObject({ status: 403 });

  expect(await call(store, '/api/debug/incidents/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }, true)).toMatchObject({
    status: 200,
    body: { ok: true, incident: { state: 'resolved' } },
  });
});

test('timeline reset preserves monotonic incident cursors', async () => {
  const store = createRelayStore('relay-test');
  pushDebugEvent(store, { event: 'error', reason: 'FIRST_FATAL', status: 'fatal' });
  const firstEventId = store.debugId;

  clearDebugTimeline(store);
  expect(store.debugEvents).toHaveLength(0);
  expect(store.debugIncidents.size).toBe(1);
  expect(store.debugId).toBe(firstEventId);

  pushDebugEvent(store, { event: 'error', reason: 'SECOND_FATAL', status: 'fatal' });
  expect(store.debugId).toBe(firstEventId + 1);
  const queried = await call(store, `/api/debug/incidents?state=open&afterId=${firstEventId}`);
  expect(queried.body.incidents).toHaveLength(1);
  expect(queried.body.incidents[0]).toMatchObject({
    code: 'SECOND_FATAL',
    lastEventId: firstEventId + 1,
  });
});
