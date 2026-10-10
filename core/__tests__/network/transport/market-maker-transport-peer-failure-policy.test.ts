import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';

import { createEmptyEnv, startP2P } from '../../../runtime';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { deriveEncryptionKeyPair } from '../../../protocol/crypto/p2p-crypto';
import { decodeRuntimeEntityInputsEnvelope } from '../../../network/p2p/auth/entity-input-envelope';
import type { DirectWebSocket } from '../../../network/p2p/direct-runtime-bun';
import { RuntimeWsClient } from '../../../network/p2p/ws-client';
import { directRuntimeWsAudience } from '../../../network/p2p/ws-protocol';
import type { DirectInputDebugState } from '../../../orchestrator/hub/hub-runtime-transport';
import { createMarketMakerDirectRuntimeRoute } from '../../../orchestrator/market-maker/node/mm-node-run';
import { ensureRuntimeInfrastructure } from '../../../runtime/envelope/replica-envelope';
import { transitionRuntimeLifecycle } from '../../../runtime/replica/lifecycle';

const MM_SEED = 'mm-peer-failure-policy-server';
const PEER_SEED = 'mm-peer-failure-policy-peer';
const MM_ID = deriveSignerAddressSync(MM_SEED, '1').toLowerCase();
const PEER_ID = deriveSignerAddressSync(PEER_SEED, '1').toLowerCase();
const UNKNOWN_ENTITY = `0x${'42'.repeat(32)}`;
type NativeSocket = ServerWebSocket<{ type: 'direct-runtime' }>;
const clients: RuntimeWsClient[] = [];
const transports: NonNullable<ReturnType<typeof startP2P>>[] = [];
const stopServers: Array<() => void> = [];

afterEach(async () => {
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

const peerInput = () => decodeRuntimeEntityInputsEnvelope({
  sourceRuntimeId: PEER_ID,
  sourceRuntimeHeight: 3,
  sourceRuntimeTimestamp: 300,
  entityInputs: [{
    entityId: UNKNOWN_ENTITY,
    runtimeId: MM_ID,
    signerId: MM_ID,
    entityTxs: [{ type: 'chat', data: { from: PEER_ID, message: 'not-for-this-mm' } }],
  }],
});

/**
 * Real MM direct route + real Bun socket + real client. Only the socket's
 * buffered byte count is forced so a peer close can carry undelivered bytes.
 */
const connectMarketMaker = async (options: { ingressReady: boolean }) => {
  const env = createEmptyEnv(MM_SEED, 1);
  transitionRuntimeLifecycle(ensureRuntimeInfrastructure(env), 'running');
  const p2p = startP2P(env, { relayUrls: [] });
  if (!p2p) throw new Error('TEST_REAL_P2P_NOT_STARTED');
  transports.push(p2p);
  const errors: string[] = [];
  const warnings: string[] = [];
  env.error = (_category, message) => { errors.push(message); };
  env.warn = (_category, message) => { warnings.push(message); };
  const debug: DirectInputDebugState = { lastSeen: null, lastError: null };
  const route = createMarketMakerDirectRuntimeRoute(env, MM_SEED, () => options.ingressReady, debug);
  route.setReady(true);
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
  const client = new RuntimeWsClient({
    url: `ws://127.0.0.1:${server.port}${route.path}`,
    runtimeId: PEER_ID,
    helloAudience: directRuntimeWsAudience(MM_ID),
    signerId: '1', seed: PEER_SEED,
    encryptionKeyPair: deriveEncryptionKeyPair(PEER_SEED),
    getTargetEncryptionKey: () => deriveEncryptionKeyPair(MM_SEED).publicKey,
    onError: error => { peerErrors.push(error.message); },
  });
  clients.push(client);
  client.setReady(true);
  await client.connect();
  await waitFor(() => client.canDeliver() && route.hasOpenSession(PEER_ID));
  const halted = () => env.infrastructure?.operatorStatus === 'HALTED_REQUIRES_OPERATOR';
  return { env, route, debug, client, errors, warnings, peerErrors, forced, halted };
};

describe('market maker direct route reject policy', () => {
  test('an authenticated peer input the MM rejects is logged and never halts the MM Runtime', async () => {
    const h = await connectMarketMaker({ ingressReady: true });
    expect(h.client.sendEntityInputsRaw(MM_ID, peerInput())).toBe(true);
    await waitFor(() => h.debug.lastError !== null && h.errors.length > 0);
    expect(h.halted()).toBe(false);
    expect(h.errors).toContain('DIRECT_INBOUND_REJECTED');
    expect(h.debug.lastError?.error).toContain('INBOUND_ENTITY_UNKNOWN_TARGET');
    expect(h.debug.lastError?.fromRuntimeId).toBe(PEER_ID);
    await waitFor(() => h.peerErrors.some(error => error.includes('INBOUND_ENTITY_UNKNOWN_TARGET')));
    expect(h.route.hasOpenSession(PEER_ID)).toBe(true);
  });

  test('peer input before J catch-up is rejected to that peer without halting the MM', async () => {
    const h = await connectMarketMaker({ ingressReady: false });
    expect(h.client.sendEntityInputsRaw(MM_ID, peerInput())).toBe(true);
    await waitFor(() => h.errors.length > 0);
    expect(h.halted()).toBe(false);
    expect(h.errors).toEqual(['DIRECT_INBOUND_REJECTED']);
    await waitFor(() => h.peerErrors.some(error => error.includes('RUNTIME_STARTUP_J_CATCHUP_PENDING')));
  });

  test('a peer closing with bytes still buffered is an audit line, not an MM halt', async () => {
    const h = await connectMarketMaker({ ingressReady: true });
    h.forced.bufferedAmount = 4096;
    await h.client.closeAndWait();
    await waitFor(() => !h.route.hasOpenSession(PEER_ID));
    await waitFor(() => h.errors.length > 0);
    expect(h.halted()).toBe(false);
    expect(h.errors).toEqual(['DIRECT_RUNTIME_SESSION_CLOSED_UNDELIVERED']);
  });
});
