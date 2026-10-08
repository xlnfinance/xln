import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';

import { createEmptyEnv, startP2P } from '../../../runtime';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { deriveEncryptionKeyPair } from '../../../protocol/crypto/p2p-crypto';
import { decodeRuntimeEntityInputsEnvelope } from '../../../network/p2p/auth/entity-input-envelope';
import type { DirectWebSocket } from '../../../network/p2p/direct-runtime-bun';
import { RuntimeWsClient } from '../../../network/p2p/ws-client';
import { directRuntimeWsAudience, makeMessageId, type RuntimeWsMessage } from '../../../network/p2p/ws-protocol';
import {
  createHubDirectRuntimeRoute,
  type DirectInputDebugState,
} from '../../../orchestrator/hub/hub-runtime-transport';
import { ensureRuntimeInfrastructure } from '../../../runtime/envelope/replica-envelope';
import { getRuntimeCommandReadiness, transitionRuntimeLifecycle } from '../../../runtime/replica/lifecycle';
import { rejectFailFast } from '../../../support/process/runtime-process';

const HUB_SEED = 'hub-peer-failure-policy-server';
const PEER_SEED = 'hub-peer-failure-policy-peer';
const HUB_ID = deriveSignerAddressSync(HUB_SEED, '1').toLowerCase();
const PEER_ID = deriveSignerAddressSync(PEER_SEED, '1').toLowerCase();
type NativeSocket = ServerWebSocket<{ type: 'direct-runtime' }>;
const clients: RuntimeWsClient[] = [];
const transports: NonNullable<ReturnType<typeof startP2P>>[] = [];
const stopServers: Array<() => void> = [];
const REJECT_ENV = 'XLN_REJECT_FAIL_FAST';
const previousRejectPolicy = process.env[REJECT_ENV];

afterEach(async () => {
  if (previousRejectPolicy === undefined) delete process.env[REJECT_ENV];
  else process.env[REJECT_ENV] = previousRejectPolicy;
  try {
    await Promise.all([...clients.splice(0), ...transports.splice(0)].map(client => client.closeAndWait()));
  } finally {
    for (const stop of stopServers.splice(0)) stop();
  }
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};

const hubOutput = () => decodeRuntimeEntityInputsEnvelope({
  sourceRuntimeId: HUB_ID,
  sourceRuntimeHeight: 9,
  sourceRuntimeTimestamp: 900,
  entityInputs: [{ entityId: `0x${'51'.repeat(32)}`, runtimeId: PEER_ID, signerId: PEER_ID, entityTxs: [] }],
});

type ClientInternals = { sendRaw(msg: RuntimeWsMessage): boolean };

/**
 * Real Hub route + real Bun socket + real client. The only substitution is a
 * forced `getBufferedAmount` so a peer close can carry "undelivered bytes"
 * deterministically; every send/auth/close path is production code.
 */
const connectHub = async (options: { rejectInbound?: boolean } = {}) => {
  const env = createEmptyEnv(HUB_SEED, 1);
  transitionRuntimeLifecycle(ensureRuntimeInfrastructure(env), 'running');
  const p2p = startP2P(env, { relayUrls: [] });
  if (!p2p) throw new Error('TEST_REAL_P2P_NOT_STARTED');
  transports.push(p2p);
  const hubErrors: string[] = [];
  const hubWarnings: string[] = [];
  env.error = (_category, message) => { hubErrors.push(message); };
  env.warn = (_category, message) => { hubWarnings.push(message); };
  const debug: DirectInputDebugState = { lastSeen: null, lastError: null };
  const route = createHubDirectRuntimeRoute(env, HUB_SEED, () => getRuntimeCommandReadiness(env).ready, debug);
  const sockets = new Map<NativeSocket, DirectWebSocket>();
  const forced = { bufferedAmount: null as number | null };
  const observed = (ws: NativeSocket): DirectWebSocket => {
    const socket = sockets.get(ws);
    if (!socket) throw new Error('TEST_REAL_SOCKET_NOT_REGISTERED');
    return socket;
  };
  const server = Bun.serve<{ type: 'direct-runtime' }>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, bunServer) {
      const decision = route.maybeUpgrade(request, bunServer);
      return decision.handled ? decision.response : new Response('websocket only', { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.set(ws, {
          get readyState() { return ws.readyState; },
          send: raw => ws.send(raw),
          close: (code, reason) => ws.close(code, reason),
          getBufferedAmount: () => forced.bufferedAmount ?? ws.getBufferedAmount(),
        });
        route.websocket.open(observed(ws));
      },
      message(ws, raw) { return route.websocket.message(observed(ws), raw); },
      drain(ws) { route.websocket.drain(observed(ws)); },
      close(ws, code, reason) {
        route.websocket.close(observed(ws), code, reason);
        sockets.delete(ws);
      },
    },
  });
  stopServers.push(() => server.stop(true));
  const peerErrors: string[] = [];
  const peerRejectedSessions: string[] = [];
  const client = new RuntimeWsClient({
    url: `ws://127.0.0.1:${server.port}${route.path}`,
    runtimeId: PEER_ID,
    helloAudience: directRuntimeWsAudience(HUB_ID),
    signerId: '1', seed: PEER_SEED,
    encryptionKeyPair: deriveEncryptionKeyPair(PEER_SEED),
    getTargetEncryptionKey: () => deriveEncryptionKeyPair(HUB_SEED).publicKey,
    onEntityInputs: () => {
      if (options.rejectInbound) throw new Error('PEER_REFUSES_HUB_OUTPUT:test');
    },
    onError: error => { peerErrors.push(error.message); },
    onPeerSessionRejected: error => { peerRejectedSessions.push(error.message); },
  });
  clients.push(client);
  client.setReady(true);
  await client.connect();
  await waitFor(() => client.canDeliver() && route.canDeliver(PEER_ID));
  const halted = () => env.infrastructure?.operatorStatus === 'HALTED_REQUIRES_OPERATOR';
  return { env, route, debug, client, hubErrors, hubWarnings, peerErrors, peerRejectedSessions, forced, halted };
};

describe('hub transport reject policy', () => {
  test('bun test runs the fail-fast policy by default', () => {
    expect(rejectFailFast()).toBe(true);
  });

  test('peer_error_frame_uncorrelated_is_rejected_not_halt', async () => {
    const h = await connectHub();
    // Authenticated peer, valid session MAC, forged correlation id.
    expect((h.client as unknown as ClientInternals).sendRaw({
      type: 'error',
      id: makeMessageId(),
      from: PEER_ID,
      to: HUB_ID,
      timestamp: Date.now(),
      inReplyTo: 'hub-output-that-never-existed',
      error: 'P2P_INBOUND_ENTITY_INPUT_REJECTED:forged',
    })).toBe(true);
    await waitFor(() => !h.route.hasOpenSession(PEER_ID));
    expect(h.halted()).toBe(false);
    expect(getRuntimeCommandReadiness(h.env).ready).toBe(true);
    expect(h.debug.lastError).toBeNull();
    expect(h.hubErrors).toEqual([]);
    // The peer sees its own session closed by the Hub with the misbehaviour code.
    await waitFor(() => h.peerErrors.some(error => error.includes('code=4004') && error.includes('uncorrelated-peer-error')));
    expect(h.peerRejectedSessions).toEqual([]);
  });

  test('a correlated peer rejection of a committed output halts under fail-fast (tests/dev)', async () => {
    const h = await connectHub({ rejectInbound: true });
    expect(h.route.sendEntityInputsDelivery(PEER_ID, hubOutput(), 900)).toMatchObject({ outcome: 'delivered' });
    await waitFor(() => h.halted());
    expect(h.hubErrors).toEqual(['DIRECT_OUTPUT_REJECTED_BY_PEER']);
    expect(h.debug.lastError?.error).toContain('DIRECT_OUTPUT_REJECTED_BY_PEER');
    expect(h.debug.lastError?.error).toContain('PEER_REFUSES_HUB_OUTPUT:test');
    expect(h.env.infrastructure?.fatalDebugPayload?.message).toContain('DIRECT_OUTPUT_REJECTED_BY_PEER');
    expect(h.peerErrors.some(error => error.includes('PEER_REFUSES_HUB_OUTPUT:test'))).toBe(true);
  });

  test('a correlated peer rejection under the production policy logs, closes that session and never halts', async () => {
    process.env[REJECT_ENV] = '0';
    expect(rejectFailFast()).toBe(false);
    const h = await connectHub({ rejectInbound: true });
    expect(h.route.sendEntityInputsDelivery(PEER_ID, hubOutput(), 900)).toMatchObject({ outcome: 'delivered' });
    await waitFor(() => !h.route.hasOpenSession(PEER_ID));
    expect(h.halted()).toBe(false);
    expect(getRuntimeCommandReadiness(h.env).ready).toBe(true);
    expect(h.hubErrors).toEqual(['DIRECT_OUTPUT_REJECTED_BY_PEER']);
    expect(h.debug.lastError?.error).toContain('PEER_REFUSES_HUB_OUTPUT:test');
    await waitFor(() => h.peerErrors.some(error => error.includes('code=4005') && error.includes('peer-rejected-output')));
    // A fresh dial from the same peer is admitted again: the close was per-session.
    const again = new RuntimeWsClient({
      url: h.client.getUrl(),
      runtimeId: PEER_ID,
      helloAudience: directRuntimeWsAudience(HUB_ID),
      signerId: '1', seed: PEER_SEED,
      encryptionKeyPair: deriveEncryptionKeyPair(PEER_SEED),
      getTargetEncryptionKey: () => deriveEncryptionKeyPair(HUB_SEED).publicKey,
      onError: () => undefined,
    });
    clients.push(again);
    again.setReady(true);
    await again.connect();
    await waitFor(() => again.canDeliver() && h.route.canDeliver(PEER_ID));
    expect(h.halted()).toBe(false);
  });

  test('peer_close_with_buffered_bytes_closes_session_not_hub', async () => {
    const h = await connectHub();
    h.forced.bufferedAmount = 4096;
    await h.client.closeAndWait();
    await waitFor(() => !h.route.hasOpenSession(PEER_ID));
    await waitFor(() => h.hubErrors.length > 0);
    expect(h.hubErrors).toEqual(['DIRECT_RUNTIME_SESSION_CLOSED_UNDELIVERED']);
    expect(h.hubWarnings).toEqual([]);
    expect(h.halted()).toBe(false);
    expect(getRuntimeCommandReadiness(h.env).ready).toBe(true);
    expect(h.route.getSessionState()).toEqual([]);
  });

  test('a clean peer close with nothing buffered is only a peer-offline warning', async () => {
    const h = await connectHub();
    h.forced.bufferedAmount = 0;
    await h.client.closeAndWait();
    await waitFor(() => h.hubWarnings.length > 0);
    expect(h.hubWarnings).toEqual(['DIRECT_RUNTIME_PEER_OFFLINE']);
    expect(h.hubErrors).toEqual([]);
    expect(h.halted()).toBe(false);
  });
});
