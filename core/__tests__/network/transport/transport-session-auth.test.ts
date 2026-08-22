import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { deriveSignerAddressSync, signDigest } from '../../../account/crypto';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../../../protocol/crypto/p2p-crypto';
import { createDirectRuntimeWsRoute } from '../../../network/p2p/direct-runtime-bun';
import { createHelloChallengeRegistry } from '../../../network/p2p/auth/hello-challenge';
import { verifyHelloAuth } from '../../../network/p2p/auth/hello-auth';
import { RuntimeWsClient } from '../../../network/p2p/ws-client';
import {
  canonicalizeRuntimeWsAudience,
  deserializeWsMessage,
  directRuntimeWsAudience,
  hashHelloMessage,
  hashRuntimeWsFrame,
  serializeWsMessage,
  type RuntimeWsMessage,
} from '../../../network/p2p/ws-protocol';
import { relayRoute } from '../../../network/relay/router';
import { createRelayStore } from '../../../network/relay/store';

const SERVER_SEED = 'transport-session-auth-server';
const CLIENT_SEED = 'transport-session-auth-client';
const SERVER_RUNTIME_ID = deriveSignerAddressSync(SERVER_SEED, '1').toLowerCase();
const CLIENT_RUNTIME_ID = deriveSignerAddressSync(CLIENT_SEED, '1').toLowerCase();
const CLIENT_KEY = pubKeyToHex(deriveEncryptionKeyPair(CLIENT_SEED).publicKey);
let authClock = 0;
const nextAuthTimestamp = (): number => {
  authClock = Math.max(Date.now(), authClock + 1);
  return authClock;
};

type FakeSocket = ReturnType<typeof makeSocket>;
const makeSocket = () => {
  const sent: RuntimeWsMessage[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  const ws = {
    readyState: 1,
    send(raw: string | Uint8Array) {
      sent.push(deserializeWsMessage(raw));
      return 1;
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
      this.readyState = 3;
    },
  };
  return { ws, sent, closed };
};

const signHello = (challenge: string, audience: string): RuntimeWsMessage => {
  const timestamp = nextAuthTimestamp();
  return {
    type: 'hello',
    from: CLIENT_RUNTIME_ID,
    fromEncryptionPubKey: CLIENT_KEY,
    timestamp,
    audience,
    auth: {
      nonce: challenge,
      timestamp,
      signature: signDigest(
        CLIENT_SEED,
        '1',
        hashHelloMessage(CLIENT_RUNTIME_ID, CLIENT_KEY, timestamp, challenge, audience),
      ),
    },
  };
};

const signFrame = (
  message: RuntimeWsMessage,
  challenge: string,
  audience: string,
): RuntimeWsMessage => {
  const timestamp = nextAuthTimestamp();
  return {
    ...message,
    auth: {
      nonce: challenge,
      timestamp,
      signature: signDigest(
        CLIENT_SEED,
        '1',
        hashRuntimeWsFrame(message, audience, challenge, timestamp),
      ),
    },
  };
};

const openAuthenticatedDirect = async (
  onRecoveryBundleRequest: () => unknown,
): Promise<{
  route: ReturnType<typeof createDirectRuntimeWsRoute>;
  socket: FakeSocket;
  challenge: string;
  audience: string;
}> => {
  const route = createDirectRuntimeWsRoute({
    runtimeId: SERVER_RUNTIME_ID,
    runtimeSeed: SERVER_SEED,
    onEntityInputs: () => undefined,
    onRecoveryBundleRequest,
  });
  const socket = makeSocket();
  route.websocket.open(socket.ws);
  const challenge = socket.sent[0]?.challenge || '';
  const audience = socket.sent[0]?.audience || '';
  await route.websocket.message(socket.ws, serializeWsMessage(signHello(challenge, audience)));
  expect(socket.sent.at(-1)?.type).toBe('hello_ack');
  return { route, socket, challenge, audience };
};

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const clients: RuntimeWsClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.stop(true);
});

describe('bound websocket session authority', () => {
  test('invalid authentication attempts cannot advance verifier time', () => {
    const fixedNow = Date.now() + 10_000;
    const nowSpy = spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect(verifyHelloAuth(
          CLIENT_RUNTIME_ID,
          CLIENT_KEY,
          { nonce: `invalid-${attempt}`, timestamp: fixedNow, signature: '0x00' },
          1,
          'relay:test',
        )).toContain('signature invalid');
      }
      const nonce = 'honest-after-invalid-burst';
      const audience = 'relay:test';
      const signature = signDigest(
        CLIENT_SEED,
        '1',
        hashHelloMessage(CLIENT_RUNTIME_ID, CLIENT_KEY, fixedNow, nonce, audience),
      );
      expect(verifyHelloAuth(
        CLIENT_RUNTIME_ID,
        CLIENT_KEY,
        { nonce, timestamp: fixedNow, signature },
        1,
        audience,
      )).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('send validation failure reports once without recursive debug transport', () => {
    const errors: string[] = [];
    const socket = makeSocket();
    const client = new RuntimeWsClient({
      url: 'ws://unused.invalid',
      runtimeId: CLIENT_RUNTIME_ID,
      helloAudience: 'relay:test',
      encryptionKeyPair: deriveEncryptionKeyPair(CLIENT_SEED),
      onError: error => errors.push(error.message),
    });
    (client as unknown as { ws: FakeSocket['ws'] }).ws = socket.ws;

    expect(client.sendDebugEvent({ code: 'test' })).toBe(false);
    expect(errors).toEqual([]);
    expect(socket.sent).toHaveLength(0);
  });

  test('post-handshake correlated errors retain delivery identity', async () => {
    const errors: string[] = [];
    const client = new RuntimeWsClient({
      url: 'ws://unused.invalid',
      runtimeId: CLIENT_RUNTIME_ID,
      helloAudience: 'relay:test',
      encryptionKeyPair: deriveEncryptionKeyPair(CLIENT_SEED),
      onError: error => errors.push(error.message),
    });
    const internal = client as unknown as {
      helloAcknowledged: boolean;
      handleHandshakeMessage(message: RuntimeWsMessage): boolean;
      handleApplicationMessage(message: RuntimeWsMessage): Promise<boolean>;
    };
    internal.helloAcknowledged = true;
    const rejection: RuntimeWsMessage = {
      type: 'error',
      inReplyTo: 'account-output-7',
      error: 'Direct delivery failed: Runtime rejected ACK H7',
    };

    expect(internal.handleHandshakeMessage(rejection)).toBe(false);
    expect(await internal.handleApplicationMessage(rejection)).toBe(true);
    expect(errors).toEqual([
      'P2P_REMOTE_REJECTED:id=account-output-7:to=:reason=Direct delivery failed: Runtime rejected ACK H7',
    ]);
  });

  test('client refuses a challenge forwarded from another endpoint', async () => {
    const received: RuntimeWsMessage[] = [];
    const errors: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, bunServer) {
        if (request.headers.get('upgrade') === 'websocket' && bunServer.upgrade(request)) return;
        return new Response('websocket only', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(serializeWsMessage({
            type: 'hello_challenge',
            challenge: `0x${'12'.repeat(32)}`,
            audience: 'wss://honest-target.example/relay',
          }));
        },
        message(_ws, raw) {
          received.push(deserializeWsMessage(raw));
        },
      },
    });
    servers.push(server);
    const client = new RuntimeWsClient({
      url: `ws://127.0.0.1:${server.port}`,
      runtimeId: CLIENT_RUNTIME_ID,
      helloAudience: canonicalizeRuntimeWsAudience(`ws://127.0.0.1:${server.port}`),
      signerId: '1',
      seed: CLIENT_SEED,
      encryptionKeyPair: deriveEncryptionKeyPair(CLIENT_SEED),
      onError: error => errors.push(error.message),
    });
    clients.push(client);

    await client.connect();
    for (let attempt = 0; attempt < 100 && errors.length === 0; attempt += 1) await Bun.sleep(5);

    expect(errors.some(error => error.includes('WS_HELLO_AUDIENCE_MISMATCH'))).toBe(true);
    expect(received).toEqual([]);
  });

  test('target rejects a forwarded challenge whose audience was rewritten', async () => {
    const registry = createHelloChallengeRegistry();
    const socket = makeSocket();
    const targetAudience = 'wss://honest-target.example/relay';
    const attackerAudience = 'wss://attacker.example/relay';
    const binding = registry.issue(socket.ws, targetAudience);
    socket.sent.length = 0;

    await relayRoute({
      store: createRelayStore(SERVER_RUNTIME_ID),
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => undefined,
      send: (ws, raw) => ws.send(raw),
      consumeHelloChallenge: (ws, challenge) => registry.consume(ws, challenge),
    }, socket.ws, signHello(binding.challenge, attackerAudience));

    expect(socket.sent.at(-1)).toMatchObject({
      type: 'error',
      error: 'Hello challenge missing, expired, or already consumed',
    });
  });

  test('direct server accepts a signed frame but rejects unsigned injection and key rebinding', async () => {
    let acceptedRequests = 0;
    const accepted = await openAuthenticatedDirect(() => {
      acceptedRequests += 1;
      return { ok: true };
    });
    const request: RuntimeWsMessage = {
      type: 'recovery_bundle_request',
      id: 'signed-request',
      from: CLIENT_RUNTIME_ID,
      fromEncryptionPubKey: CLIENT_KEY,
      to: SERVER_RUNTIME_ID,
      timestamp: Date.now(),
      payload: { lookupKey: 'signed' },
    };
    await accepted.route.websocket.message(
      accepted.socket.ws,
      serializeWsMessage(signFrame(request, accepted.challenge, accepted.audience)),
    );
    expect(acceptedRequests).toBe(1);
    expect(accepted.socket.sent.at(-1)?.type).toBe('recovery_bundle_response');

    let injectedRequests = 0;
    const injected = await openAuthenticatedDirect(() => {
      injectedRequests += 1;
      return {};
    });
    await injected.route.websocket.message(injected.socket.ws, serializeWsMessage({
      ...request,
      id: 'unsigned-injection',
    }));
    expect(injectedRequests).toBe(0);
    expect(injected.socket.closed.at(-1)).toEqual({ code: 4003, reason: 'session-auth-invalid' });

    let reboundRequests = 0;
    const rebound = await openAuthenticatedDirect(() => {
      reboundRequests += 1;
      return {};
    });
    const reboundMessage = { ...request, id: 'key-rebind', fromEncryptionPubKey: `0x${'99'.repeat(32)}` };
    await rebound.route.websocket.message(
      rebound.socket.ws,
      serializeWsMessage(signFrame(reboundMessage, rebound.challenge, rebound.audience)),
    );
    expect(reboundRequests).toBe(0);
    expect(rebound.socket.sent.at(-1)?.error).toBe('Direct session encryption key mismatch');
  });

  test('direct and relay sessions reject an exact captured-frame replay', async () => {
    let directAccepted = 0;
    const direct = await openAuthenticatedDirect(() => {
      directAccepted += 1;
      return { ok: true };
    });
    const request = signFrame({
      type: 'recovery_bundle_request',
      id: 'captured-direct',
      from: CLIENT_RUNTIME_ID,
      fromEncryptionPubKey: CLIENT_KEY,
      to: SERVER_RUNTIME_ID,
      payload: { lookupKey: 'captured' },
    }, direct.challenge, direct.audience);
    const wire = serializeWsMessage(request);
    await direct.route.websocket.message(direct.socket.ws, wire);
    await direct.route.websocket.message(direct.socket.ws, wire);
    expect(directAccepted).toBe(1);
    expect(direct.socket.sent.at(-1)?.error).toBe('Session frame replay or reordering');

    const registry = createHelloChallengeRegistry();
    const relaySocket = makeSocket();
    const binding = registry.issue(relaySocket.ws, 'wss://relay.test/relay');
    relaySocket.sent.length = 0;
    let relayAccepted = 0;
    const config = {
      store: createRelayStore(SERVER_RUNTIME_ID),
      localRuntimeId: SERVER_RUNTIME_ID,
      localDeliver: async () => { relayAccepted += 1; },
      send: (ws: FakeSocket['ws'], raw: Uint8Array) => ws.send(raw),
      consumeHelloChallenge: (ws: object, claim: unknown) => registry.consume(ws, claim),
    };
    await relayRoute(config, relaySocket.ws, signHello(binding.challenge, binding.audience));
    const relayFrame = signFrame({
      type: 'entity_inputs',
      id: 'captured-relay',
      from: CLIENT_RUNTIME_ID,
      fromEncryptionPubKey: CLIENT_KEY,
      to: SERVER_RUNTIME_ID,
      payload: new TextEncoder().encode('captured'),
      encrypted: true,
    }, binding.challenge, binding.audience);
    await relayRoute(config, relaySocket.ws, relayFrame);
    await relayRoute(config, relaySocket.ws, relayFrame);
    expect(relayAccepted).toBe(1);
    expect(relaySocket.sent.at(-1)?.error).toBe('Session frame replay or reordering');
  });

  test('direct client rejects an unsigned acknowledgement from the claimed target runtime', async () => {
    const errors: string[] = [];
    const audience = directRuntimeWsAudience(SERVER_RUNTIME_ID);
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, bunServer) {
        if (request.headers.get('upgrade') === 'websocket' && bunServer.upgrade(request)) return;
        return new Response('websocket only', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(serializeWsMessage({
            type: 'hello_challenge',
            challenge: `0x${'34'.repeat(32)}`,
            audience,
          }));
        },
        message(ws) {
          ws.send(serializeWsMessage({
            type: 'hello_ack',
            from: SERVER_RUNTIME_ID,
            fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(SERVER_SEED).publicKey),
            to: CLIENT_RUNTIME_ID,
          }));
        },
      },
    });
    servers.push(server);
    const client = new RuntimeWsClient({
      url: `ws://127.0.0.1:${server.port}`,
      runtimeId: CLIENT_RUNTIME_ID,
      helloAudience: audience,
      signerId: '1',
      seed: CLIENT_SEED,
      encryptionKeyPair: deriveEncryptionKeyPair(CLIENT_SEED),
      onError: error => errors.push(error.message),
    });
    clients.push(client);
    await client.connect();
    for (let attempt = 0; attempt < 100 && errors.length === 0; attempt += 1) await Bun.sleep(5);
    expect(errors.some(error => error.includes('WS_DIRECT_SERVER_AUTH_INVALID'))).toBe(true);
    expect(client.isOpen()).toBe(false);
  });
});
