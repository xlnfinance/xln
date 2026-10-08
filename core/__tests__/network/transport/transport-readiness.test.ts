import { RuntimeP2P } from '../../../network/p2p/p2p';
import { createEmptyEnv } from '../../../runtime';
import { buildCryptographicProfileFixture, certifySingleSignerProfileFixture, deriveSingleSignerFixtureEntityId } from '../../helpers/cryptographic-profile';
import { verifyProfileSignature } from '../../../entity/profile/profile-signing';
import { parseProfile } from '../../../entity/profile';
import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';

import { deriveSignerAddressSync } from '../../../account/crypto';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../../../protocol/crypto/p2p-crypto';
import { decodeRuntimeEntityInputsEnvelope } from '../../../network/p2p/auth/entity-input-envelope';
import { createDirectRuntimeWsRoute, type DirectWebSocket } from '../../../network/p2p/direct-runtime-bun';
import { RuntimeWsClient } from '../../../network/p2p/ws-client';
import {
  deserializeWsMessage,
  directRuntimeWsAudience,
  serializeWsMessage,
  type RuntimeWsMessage,
} from '../../../network/p2p/ws-protocol';
import type { RuntimeEntityInputsEnvelope } from '../../../runtime/types';

const SERVER_SEED = 'transport-readiness-server';
const CLIENT_SEED = 'transport-readiness-client';
const SERVER_ID = deriveSignerAddressSync(SERVER_SEED, '1').toLowerCase();
const CLIENT_ID = deriveSignerAddressSync(CLIENT_SEED, '1').toLowerCase();
type NativeSocket = ServerWebSocket<{ type: 'direct-runtime' }>;
type CapturedFrame = { message: RuntimeWsMessage; raw: string | Uint8Array };
const clients: RuntimeWsClient[] = [];
const stopServers: Array<() => void> = [];

afterEach(async () => {
  try {
    await Promise.all(clients.splice(0).map(client => client.closeAndWait()));
  } finally {
    for (const stop of stopServers.splice(0)) stop();
  }
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};

const envelopeFrom = (sourceRuntimeId: string, targetRuntimeId: string): RuntimeEntityInputsEnvelope =>
  decodeRuntimeEntityInputsEnvelope({
    sourceRuntimeId,
    sourceRuntimeHeight: 7,
    sourceRuntimeTimestamp: 123,
    entityInputs: [{
      entityId: `0x${'21'.repeat(32)}`,
      runtimeId: targetRuntimeId,
      signerId: targetRuntimeId,
      entityTxs: [],
    }],
  });

// This recorder forwards every operation to a real Bun socket. It never
// substitutes a send result, authentication result, or application receipt.
const recordSocket = (ws: NativeSocket, frames: CapturedFrame[]): DirectWebSocket => ({
  get readyState() { return ws.readyState; },
  send(raw) {
    frames.push({ message: deserializeWsMessage(raw), raw: typeof raw === 'string' ? raw : raw.slice() });
    return ws.send(raw);
  },
  close: (code, reason) => ws.close(code, reason),
  getBufferedAmount: () => ws.getBufferedAmount(),
});

const createHarness = (getLocalProfiles?: () => Promise<readonly unknown[]>) => {
  const received: RuntimeEntityInputsEnvelope[] = [];
  const gossip: Array<{ from: string; payload: unknown }> = [];
  const failures: string[] = [];
  const clientFrames: RuntimeWsMessage[] = [];
  const serverFrames: CapturedFrame[] = [];
  const changes: Array<{ runtimeId: string; ready: boolean }> = [];
  const sockets = new Map<NativeSocket, DirectWebSocket>();
  const route = createDirectRuntimeWsRoute({
    runtimeId: SERVER_ID,
    runtimeSeed: SERVER_SEED,
    ...(getLocalProfiles ? { getLocalProfiles } : {}),
    onEntityInputs: (_from, envelope) => { received.push(envelope); },
    onGossipAnnounce: (from, payload) => { gossip.push({ from, payload }); },
    onRecoveryBundleRequest: (from, lookupKey) => ({ from, lookupKey }),
    onDeliveryFailure: failure => { failures.push(failure.error); },
  });
  route.onDeliveryReadyChange((runtimeId, ready) => changes.push({ runtimeId, ready }));
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
        const socket = recordSocket(ws, serverFrames);
        sockets.set(ws, socket);
        route.websocket.open(socket);
      },
      message(ws, raw) {
        clientFrames.push(deserializeWsMessage(raw));
        route.websocket.message(observed(ws), raw);
      },
      drain(ws) { route.websocket.drain(observed(ws)); },
      close(ws, code, reason) {
        route.websocket.close(observed(ws), code, reason);
        sockets.delete(ws);
      },
    },
  });
  stopServers.push(() => server.stop(true));
  const connect = async () => {
    const envelopes: RuntimeEntityInputsEnvelope[] = [];
    const errors: string[] = [];
    const readyChanges: boolean[] = [];
    const announcements: unknown[] = [];
    const client = new RuntimeWsClient({
      url: `ws://127.0.0.1:${server.port}${route.path}`,
      runtimeId: CLIENT_ID,
      helloAudience: directRuntimeWsAudience(SERVER_ID),
      signerId: '1', seed: CLIENT_SEED,
      encryptionKeyPair: deriveEncryptionKeyPair(CLIENT_SEED),
      getTargetEncryptionKey: () => deriveEncryptionKeyPair(SERVER_SEED).publicKey,
      onEntityInputs: (_from, envelope) => { envelopes.push(envelope); },
      onError: error => { errors.push(error.message); },
      onDeliveryReadyChange: ready => { readyChanges.push(ready); },
      onGossipAnnounce: (_from, payload) => { announcements.push(payload); },
    });
    clients.push(client);
    await client.connect();
    await waitFor(() => client.isOpen() && route.hasOpenSession(CLIENT_ID));
    return { client, envelopes, errors, readyChanges, announcements };
  };
  const replayToClient = (raw: string | Uint8Array): void => {
    const native = sockets.keys().next().value;
    if (!native || sockets.size !== 1) throw new Error('TEST_EXPECTS_ONE_REAL_SOCKET');
    expect(native.send(raw)).not.toBe(0);
  };
  return { url: `ws://127.0.0.1:${server.port}${route.path}`, route, connect, received, gossip, failures, changes, clientFrames, serverFrames, replayToClient };
};

describe('authenticated direct delivery readiness', () => {
  test('outgoing RuntimeP2P direct client admits newly adopted signed owner into actual gossip state', async () => {
    let outgoingProfiles: ReturnType<typeof buildCryptographicProfileFixture>[] = [];
    const h = createHarness(async () => outgoingProfiles);
    const hub = certifySingleSignerProfileFixture({
      ...buildCryptographicProfileFixture({
        entityId: deriveSingleSignerFixtureEntityId(SERVER_SEED), signingSeed: SERVER_SEED,
        name: 'direct bootstrap hub', isHub: true, runtimeId: SERVER_ID,
        runtimeEncPubKey: pubKeyToHex(deriveEncryptionKeyPair(SERVER_SEED).publicKey),
      }), wsUrl: h.url,
    }, SERVER_SEED);
    const owner = certifySingleSignerProfileFixture(buildCryptographicProfileFixture({
      entityId: deriveSingleSignerFixtureEntityId(SERVER_SEED, '2'),
      signingSeed: SERVER_SEED, signerId: '2', name: 'newly adopted owner',
      runtimeId: SERVER_ID, runtimeEncPubKey: hub.runtimeEncPubKey,
    }), SERVER_SEED, '2');
    outgoingProfiles = [hub, owner];
    const env = createEmptyEnv(CLIENT_SEED, 1);
    env.runtimeId = CLIENT_ID;
    const p2p = new RuntimeP2P({ env, runtimeId: CLIENT_ID, relayUrls: [],
      onEntityInputs: () => {}, onGossipProfiles: () => {},
    });
    try {
      await p2p.admitSharedProfiles([hub]);
      expect(env.gossip.getProfile(owner.entityId)).toBeUndefined();
      h.route.setReady(true);
      p2p.setReady(true);
      expect(await p2p.bootstrapDirectEntityRoutes([hub.entityId], 2000)).toBe(true);
      await waitFor(() => env.gossip.getProfile(owner.entityId) !== undefined);
      const accepted = env.gossip.getProfile(owner.entityId)!;
      expect(accepted.name).toBe(owner.name);
      expect(accepted.runtimeId).toBe(SERVER_ID);
      expect((await verifyProfileSignature(accepted)).valid).toBe(true);
      expect(h.serverFrames.some(frame => frame.message.type === 'gossip_announce')).toBe(true);
      expect(h.received).toEqual([]);
      expect(h.failures).toEqual([]);
    } finally {
      await p2p.closeAndWait();
    }
  });

  test('a fresh and reconnected idle peer receives signed local profiles without a financial envelope', async () => {
    const profile = certifySingleSignerProfileFixture(buildCryptographicProfileFixture({
      entityId: deriveSingleSignerFixtureEntityId(SERVER_SEED), signingSeed: SERVER_SEED,
      name: 'idle signed peer', isHub: true, lastUpdated: 1,
    }), SERVER_SEED);
    const h = createHarness(async () => [profile]);
    const first = await h.connect();
    await waitFor(() => first.announcements.length === 1);
    const payload = first.announcements[0];
    if (!payload || typeof payload !== 'object' || !('profiles' in payload) || !Array.isArray(payload.profiles)) {
      throw new Error('SIGNED_PROFILE_ANNOUNCEMENT_MISSING');
    }
    expect((await verifyProfileSignature(parseProfile(payload.profiles[0]))).valid).toBe(true);
    expect(h.received).toEqual([]);
    await first.client.closeAndWait();
    await waitFor(() => !h.route.hasOpenSession(CLIENT_ID));
    const second = await h.connect();
    await waitFor(() => second.announcements.length === 1);
    expect(second.announcements).toEqual(first.announcements);
    expect(h.received).toEqual([]);
    const announces = h.serverFrames.filter(frame => frame.message.type === 'gossip_announce');
    expect(announces).toHaveLength(2);
    expect(announces[0]?.message.auth?.nonce).not.toBe(announces[1]?.message.auth?.nonce);
    expect([...first.errors, ...second.errors, ...h.failures]).toEqual([]);
  });

  test('recovery and gossip precede readiness; entity bytes wait in both directions and revoke immediately', async () => {
    const h = createHarness();
    const c = await h.connect();
    const inbound = envelopeFrom(CLIENT_ID, SERVER_ID);
    const outbound = envelopeFrom(SERVER_ID, CLIENT_ID);
    expect(c.client.canDeliver()).toBe(false);
    expect(h.route.canDeliver(CLIENT_ID)).toBe(false);
    expect(c.client.sendEntityInputsRaw(SERVER_ID, inbound)).toBe(false);
    expect(h.route.sendEntityInputsDelivery(CLIENT_ID, outbound)).toMatchObject({
      outcome: 'deferred', code: 'ROUTE_DIRECT_RECIPIENT_NOT_READY', fatal: false, terminal: false,
    });
    expect(c.client.sendGossipAnnounce(SERVER_ID, { profiles: [] })).toBe(true);
    expect(await c.client.requestRecoveryBundles(SERVER_ID, 'early-control')).toEqual({
      from: CLIENT_ID, lookupKey: 'early-control',
    });
    expect(h.gossip).toEqual([{ from: CLIENT_ID, payload: { profiles: [] } }]);
    expect(h.clientFrames.filter(frame => frame.type === 'entity_inputs')).toHaveLength(0);
    expect(h.serverFrames.filter(frame => frame.message.type === 'entity_inputs')).toHaveLength(0);
    for (const type of ['gossip_announce', 'recovery_bundle_request']) {
      expect(h.clientFrames.find(frame => frame.type === type)?.auth?.mac).toBeTruthy();
    }

    c.client.setReady(true);
    h.route.setReady(true);
    await waitFor(() => c.client.canDeliver() && h.route.canDeliver(CLIENT_ID));
    expect(c.readyChanges).toContain(true);
    expect(h.changes).toContainEqual({ runtimeId: CLIENT_ID, ready: true });
    const controls = [
      ...h.clientFrames.filter(frame => frame.type === 'delivery_ready' && frame.payload === true),
      ...h.serverFrames.map(frame => frame.message).filter(frame => frame.type === 'delivery_ready' && frame.payload === true),
    ];
    expect(controls).toHaveLength(2);
    for (const control of controls) {
      expect(control.auth?.mac).toBeTruthy();
      expect(control.auth?.signature).toBeUndefined();
      expect(() => serializeWsMessage({ ...control, payload: 'true' })).toThrow('WS_MESSAGE_DELIVERY_READY_INVALID');
    }
    expect(c.client.sendEntityInputsRaw(SERVER_ID, inbound)).toBe(true);
    expect(h.route.sendEntityInputsDelivery(CLIENT_ID, outbound).outcome).toBe('delivered');
    await waitFor(() => h.received.length === 1 && c.envelopes.length === 1);
    expect(h.received).toEqual([inbound]);
    expect(c.envelopes).toEqual([outbound]);
    expect(h.clientFrames.find(frame => frame.type === 'entity_inputs')?.encSeq).toBe(1);
    expect(h.serverFrames.find(frame => frame.message.type === 'entity_inputs')?.message.encSeq).toBe(1);

    c.client.setReady(false);
    h.route.setReady(false);
    await waitFor(() => !c.client.canDeliver() && !h.route.canDeliver(CLIENT_ID));
    expect(c.readyChanges.at(-1)).toBe(false);
    expect(h.changes.at(-1)).toEqual({ runtimeId: CLIENT_ID, ready: false });
    expect(c.client.sendEntityInputsRaw(SERVER_ID, inbound)).toBe(false);
    expect(h.route.sendEntityInputsDelivery(CLIENT_ID, outbound).outcome).toBe('deferred');
    await c.client.requestRecoveryBundles(SERVER_ID, 'revoked-barrier');
    expect(h.clientFrames.filter(frame => frame.type === 'entity_inputs')).toHaveLength(1);
    expect(h.serverFrames.filter(frame => frame.message.type === 'entity_inputs')).toHaveLength(1);
    expect(c.errors).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  test('a fresh session requires new readiness and rejects the previous session readiness MAC', async () => {
    const h = createHarness();
    const first = await h.connect();
    first.client.setReady(true);
    h.route.setReady(true);
    await waitFor(() => first.client.canDeliver() && h.route.canDeliver(CLIENT_ID));
    const captured = h.serverFrames.find(frame => frame.message.type === 'delivery_ready' && frame.message.payload === true);
    if (!captured) throw new Error('TEST_AUTHENTICATED_READINESS_NOT_CAPTURED');
    expect(captured.message.auth?.mac).toBeTruthy();
    await first.client.closeAndWait();
    await waitFor(() => !h.route.hasOpenSession(CLIENT_ID));
    h.route.setReady(false);
    const fresh = await h.connect();
    await fresh.client.requestRecoveryBundles(SERVER_ID, 'fresh-handshake-barrier');
    expect(fresh.client.canDeliver()).toBe(false);
    expect(h.route.canDeliver(CLIENT_ID)).toBe(false);
    // The old server signed hello and readiness do not confer authority on
    // this new challenge/key pair. Replay crosses the actual server socket.
    h.replayToClient(captured.raw);
    await waitFor(() => fresh.errors.length > 0);
    expect(fresh.errors.some(error => error.includes('AUTH'))).toBe(true);
    expect(fresh.client.canDeliver()).toBe(false);
    expect(fresh.readyChanges).not.toContain(true);
    expect(h.route.canDeliver(CLIENT_ID)).toBe(false);
    expect(fresh.envelopes).toEqual([]);
  });

  test('once ready, an actual rejected encrypted envelope remains a loud correlated failure', async () => {
    const h = createHarness();
    const c = await h.connect();
    c.client.setReady(true);
    h.route.setReady(true);
    await waitFor(() => c.client.canDeliver() && h.route.canDeliver(CLIENT_ID));
    const invalid: RuntimeEntityInputsEnvelope = { ...envelopeFrom(CLIENT_ID, SERVER_ID), entityInputs: [] };
    expect(c.client.sendEntityInputsRaw(SERVER_ID, invalid)).toBe(true);
    await waitFor(() => h.failures.length > 0 && c.errors.length > 0);
    expect(h.failures).toEqual(['P2P_ENTITY_INPUTS_ENVELOPE_EMPTY']);
    const sent = h.clientFrames.find(frame => frame.type === 'entity_inputs');
    expect(sent?.id).toBeTruthy();
    expect(c.errors.some(error => error.includes(`P2P_REMOTE_REJECTED:id=${sent?.id}:`))).toBe(true);
    expect(c.errors.some(error => error.includes('P2P_ENTITY_INPUTS_ENVELOPE_EMPTY'))).toBe(true);
    expect(h.received).toEqual([]);
  });
});
