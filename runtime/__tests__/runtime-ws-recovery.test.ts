import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { deriveSignerAddressSync } from '../account/crypto';
import { deriveEncryptionKeyPair } from '../protocol/p2p-crypto';
import { RuntimeWsClient } from '../network/p2p/ws-client';
import { deserializeWsMessage, serializeWsMessage, type RuntimeWsMessage } from '../network/p2p/ws-protocol';
import { createHelloChallengeRegistry } from '../network/p2p/hello-challenge';
import { createRelayHandshakeBinding, type RuntimeWsChallengeTranscript } from '../network/p2p/hello-transcript';
import { handshakeWireFields } from '../network/p2p/ws-client-handshake';
import { startStandaloneRelayServer, type StandaloneRelayServer } from '../network/relay/standalone-server';

const SERVER_RUNTIME_ID = '0x9999999999999999999999999999999999999999';
const SEED_A = 'runtime-ws-recovery-client-a';
const SEED_B = 'runtime-ws-recovery-client-b';
const RUNTIME_A = deriveSignerAddressSync(SEED_A, '1').toLowerCase();
const RUNTIME_B = deriveSignerAddressSync(SEED_B, '2').toLowerCase();

let servers: StandaloneRelayServer[] = [];
let rawServers: Array<ReturnType<typeof Bun.serve>> = [];
let rawTcpServers: Server[] = [];
let rawTcpSockets: Socket[] = [];
let clients: RuntimeWsClient[] = [];

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`WAIT_TIMEOUT:${label}`);
};

const relayAck = (
  hello: ReturnType<typeof deserializeWsMessage>,
  challenge: RuntimeWsChallengeTranscript,
) => ({
  type: 'hello_ack' as const,
  to: String(hello.from || ''),
  ...handshakeWireFields(challenge),
  challenge: challenge.challenge,
  helloTimestamp: Number(hello.timestamp),
  timestamp: Date.now(),
});

const startRelay = (): StandaloneRelayServer => {
  const server = startStandaloneRelayServer({
    host: '127.0.0.1',
    port: 0,
    serverId: SERVER_RUNTIME_ID,
  });
  servers.push(server);
  return server;
};

const makeClient = (options: {
  url: string;
  seed: string;
  runtimeId: string;
  signerId: string;
  onOpen?: () => void;
  getTargetEncryptionKey?: (runtimeId: string) => Uint8Array | null;
  onEntityInputs?: (from: string) => Promise<void> | void;
  onRecoveryBundleRequest?: (from: string, lookupKey: string) => Promise<unknown> | unknown;
  onError?: (error: Error) => void;
  connectTimeoutMs?: number;
  helloTimeoutMs?: number;
}): RuntimeWsClient => {
  const client = new RuntimeWsClient({
    url: options.url,
    runtimeId: options.runtimeId,
    signerId: options.signerId,
    seed: options.seed,
    useHelloAuth: true,
    encryptionKeyPair: deriveEncryptionKeyPair(options.seed),
    getTargetEncryptionKey: options.getTargetEncryptionKey,
    onEntityInputs: options.onEntityInputs,
    onOpen: options.onOpen,
    onRecoveryBundleRequest: options.onRecoveryBundleRequest,
    onError: options.onError,
    connectTimeoutMs: options.connectTimeoutMs,
    helloTimeoutMs: options.helloTimeoutMs,
  });
  clients.push(client);
  return client;
};

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.close();
  for (const server of rawServers.splice(0)) server.stop(true);
  for (const socket of rawTcpSockets.splice(0)) socket.destroy();
  for (const server of rawTcpServers.splice(0)) server.close();
});

describe('runtime websocket recovery requests', () => {
  test('standalone relay uses structured startup logging', () => {
    const source = readFileSync(join(process.cwd(), 'runtime/network/relay/standalone-server.ts'), 'utf8');

    expect(source).toContain("createStructuredLogger('relay.standalone')");
    expect(source).toContain("relayStandaloneLog.info('service.listen'");
    expect(source).not.toContain('console.');
    expect(source).not.toContain('[WS] Runtime relay');
  });

  test('authenticated client becomes ready only after relay registration is acknowledged', async () => {
    const relay = startRelay();
    const errors: string[] = [];
    let registeredWhenOpened = false;
    const client = makeClient({
      url: `ws://127.0.0.1:${relay.server.port}`,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
      onOpen: () => {
        registeredWhenOpened = relay.store.clients.has(RUNTIME_A);
      },
      onError: error => errors.push(error.message),
      helloTimeoutMs: 25,
    });

    await client.connect();
    await waitUntil(() => registeredWhenOpened, 'registered hello acknowledgement');
    await Bun.sleep(50);

    expect(registeredWhenOpened).toBe(true);
    expect(client.isOpen()).toBe(true);
    expect(errors).toEqual([]);
  });

  test('authenticated socket cannot send gossip before hello acknowledgement', async () => {
    let socket: { send: (payload: string | ArrayBufferView | ArrayBuffer) => number } | null = null;
    const receivedTypes: string[] = [];
    let rawServer: ReturnType<typeof Bun.serve> | null = null;
    const challenges = createHelloChallengeRegistry();
    let issuedChallenge: RuntimeWsChallengeTranscript | null = null;
    let receivedHello: RuntimeWsMessage | null = null;
    rawServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        if (request.headers.get('upgrade') === 'websocket' && server.upgrade(request)) return;
        return new Response('websocket only', { status: 400 });
      },
      websocket: {
        open(ws) {
          socket = ws;
          issuedChallenge = challenges.issue(
            ws,
            createRelayHandshakeBinding(`ws://127.0.0.1:${rawServer?.port}`),
          );
        },
        message(_ws, raw) {
          const message = deserializeWsMessage(raw);
          receivedTypes.push(message.type);
          if (message.type === 'hello') receivedHello = message;
        },
      },
    });
    rawServers.push(rawServer);
    const client = makeClient({
      url: `ws://127.0.0.1:${rawServer.port}`,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
    });

    await client.connect();
    await waitUntil(() => receivedTypes.includes('hello'), 'client hello');

    expect(client.isConnecting()).toBe(true);
    expect(client.isOpen()).toBe(false);
    expect(client.sendGossipAnnounce(RUNTIME_A, { profiles: [] })).toBe(false);
    expect(receivedTypes).toEqual(['hello']);

    if (!receivedHello || !issuedChallenge) throw new Error('TEST_RELAY_HELLO_MISSING');
    socket?.send(serializeWsMessage(relayAck(receivedHello, issuedChallenge)));
    await waitUntil(() => client.isOpen(), 'authenticated client ready');
    expect(client.isConnecting()).toBe(false);
  });

  test('a queued ACK cannot revive a generation after the handshake fails', async () => {
    const challenges = createHelloChallengeRegistry();
    let issuedChallenge: RuntimeWsChallengeTranscript | null = null;
    let rawServer: ReturnType<typeof Bun.serve> | null = null;
    rawServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (request.headers.get('upgrade') === 'websocket' && rawServer?.upgrade(request)) return undefined;
        return new Response('websocket only', { status: 400 });
      },
      websocket: {
        open(ws) {
          issuedChallenge = challenges.issue(
            ws,
            createRelayHandshakeBinding(`ws://127.0.0.1:${rawServer?.port}`),
          );
        },
        message(ws, raw) {
          const hello = deserializeWsMessage(raw);
          if (!issuedChallenge) throw new Error('TEST_RELAY_CHALLENGE_MISSING');
          ws.send(serializeWsMessage({ type: 'error', error: 'reject-before-ack' }));
          ws.send(serializeWsMessage(relayAck(hello, issuedChallenge)));
        },
      },
    });
    rawServers.push(rawServer);
    const errors: string[] = [];
    let opens = 0;
    const client = makeClient({
      url: `ws://127.0.0.1:${rawServer.port}`,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
      onOpen: () => { opens += 1; },
      onError: error => errors.push(error.message),
    });

    await client.connect();
    await waitUntil(() => errors.some(error => error.includes('WS_ERROR_BEFORE_HANDSHAKE_ACK')), 'failed handshake');
    await Bun.sleep(25);

    expect(opens).toBe(0);
    expect(client.isOpen()).toBe(false);
  });

  test('silent relay handshake times out and reconnects instead of wedging', async () => {
    let opens = 0;
    let rawServer: ReturnType<typeof Bun.serve> | null = null;
    rawServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (request.headers.get('upgrade') === 'websocket' && rawServer?.upgrade(request)) return undefined;
        return new Response('websocket only', { status: 400 });
      },
      websocket: {
        open() { opens += 1; },
        message() {},
      },
    });
    rawServers.push(rawServer);
    const errors: string[] = [];
    const client = makeClient({
      url: `ws://127.0.0.1:${rawServer.port}`,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
      helloTimeoutMs: 25,
      onError: error => errors.push(error.message),
    });

    await client.connect();
    await waitUntil(() => opens >= 2, 'silent relay reconnect');

    expect(errors.some(error => error.includes('WS_HELLO_TIMEOUT'))).toBe(true);
    expect(client.isOpen()).toBe(false);
  });

  test('a TCP peer that never upgrades times out and reconnects instead of wedging', async () => {
    let acceptedConnections = 0;
    const blackhole = createServer(socket => {
      acceptedConnections += 1;
      rawTcpSockets.push(socket);
    });
    rawTcpServers.push(blackhole);
    await new Promise<void>((resolve, reject) => {
      blackhole.once('error', reject);
      blackhole.listen(0, '127.0.0.1', resolve);
    });
    const address = blackhole.address();
    if (!address || typeof address === 'string') throw new Error('TEST_TCP_BLACKHOLE_ADDRESS_MISSING');
    const errors: string[] = [];
    const client = makeClient({
      url: `ws://127.0.0.1:${address.port}`,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
      connectTimeoutMs: 25,
      onError: error => errors.push(error.message),
    });

    await client.connect();
    await waitUntil(() => acceptedConnections >= 2, 'TCP-upgrade blackhole reconnect');

    expect(errors.some(error => error.includes('WS_CONNECT_TIMEOUT'))).toBe(true);
    expect(client.isOpen()).toBe(false);
  });

  test('two consecutive clean relay closes each reconnect the authenticated client', async () => {
    const relay = startRelay();
    const client = makeClient({
      url: `ws://127.0.0.1:${relay.server.port}`,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
    });
    await client.connect();
    await waitUntil(() => client.isOpen(), 'initial authenticated relay client');
    const first = relay.store.clients.get(RUNTIME_A);
    if (!first?.ws.close) throw new Error('TEST_RELAY_SOCKET_CLOSE_UNAVAILABLE');

    first.ws.close(1001, 'clean-cycle-one');
    await waitUntil(
      () => {
        const current = relay.store.clients.get(RUNTIME_A);
        return Boolean(client.isOpen() && current && current.ws !== first.ws);
      },
      'first clean-close reconnect',
    );
    const second = relay.store.clients.get(RUNTIME_A);
    if (!second?.ws.close) throw new Error('TEST_RELAY_SOCKET_CLOSE_UNAVAILABLE');

    second.ws.close(1001, 'clean-cycle-two');
    await waitUntil(
      () => {
        const current = relay.store.clients.get(RUNTIME_A);
        return Boolean(client.isOpen() && current && current.ws !== second.ws);
      },
      'second clean-close reconnect',
    );

    expect(client.isOpen()).toBe(true);
  });

  test('requestRecoveryBundles resolves a correlated peer response through relay', async () => {
    const relay = startRelay();
    const url = `ws://127.0.0.1:${relay.server.port}`;
    const seenRequests: Array<{ from: string; lookupKey: string }> = [];
    const requesterErrors: string[] = [];
    const responderErrors: string[] = [];
    const requester = makeClient({
      url,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
      onError: error => requesterErrors.push(error.message),
    });
    const responder = makeClient({
      url,
      seed: SEED_B,
      runtimeId: RUNTIME_B,
      signerId: '2',
      onRecoveryBundleRequest: (from, lookupKey) => {
        seenRequests.push({ from: from.toLowerCase(), lookupKey });
        return { ok: true, runtimeId: RUNTIME_B, lookupKey, bundles: [{ lookupKey, height: 7 }] };
      },
      onError: error => responderErrors.push(error.message),
    });

    await requester.connect();
    await responder.connect();
    await waitUntil(() => requester.isOpen() && responder.isOpen(), 'authenticated relay clients');

    const response = await requester.requestRecoveryBundles(RUNTIME_B, 'lookup/key', 1_000);

    expect(response).toMatchObject({
      ok: true,
      runtimeId: RUNTIME_B,
      lookupKey: 'lookup/key',
      bundles: [{ lookupKey: 'lookup/key', height: 7 }],
    });
    expect(seenRequests).toEqual([{ from: RUNTIME_A, lookupKey: 'lookup/key' }]);
    expect(requesterErrors).toEqual([]);
    expect(responderErrors).toEqual([]);
  });

  test('requestRecoveryBundles rejects relay offline-target errors by request id', async () => {
    const relay = startRelay();
    const url = `ws://127.0.0.1:${relay.server.port}`;
    const requesterErrors: string[] = [];
    const requester = makeClient({
      url,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
      onError: error => requesterErrors.push(error.message),
    });

    await requester.connect();
    await waitUntil(() => requester.isOpen(), 'authenticated requester relay client');

    await expect(requester.requestRecoveryBundles(RUNTIME_B, 'lookup/key', 1_000)).rejects.toThrow(
      'RECOVERY_TARGET_NOT_CONNECTED',
    );
    expect(requesterErrors).toEqual([]);
  });

  test('reports a retryable inbound entity rejection without killing the websocket consumer', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const relay = startRelay();
    const url = `ws://127.0.0.1:${relay.server.port}`;
    const receiverErrors: string[] = [];
    let received = 0;
    const sender = makeClient({
      url,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
      getTargetEncryptionKey: runtimeId => (runtimeId === RUNTIME_B ? deriveEncryptionKeyPair(SEED_B).publicKey : null),
    });
    const receiver = makeClient({
      url,
      seed: SEED_B,
      runtimeId: RUNTIME_B,
      signerId: '2',
      onEntityInputs: () => {
        received += 1;
        throw new Error('INBOUND_ENTITY_RUNTIME_QUIESCING');
      },
      onError: error => receiverErrors.push(error.message),
    });
    await sender.connect();
    await receiver.connect();
    await waitUntil(() => sender.isOpen() && receiver.isOpen(), 'authenticated relay clients');

    expect(
      sender.sendEntityInputsRaw(RUNTIME_B, {
        sourceRuntimeId: RUNTIME_A,
        sourceRuntimeHeight: 7,
        sourceRuntimeTimestamp: 7000,
        entityInputs: [
          {
            entityId: `0x${'44'.repeat(32)}`,
            signerId: '2',
            runtimeId: RUNTIME_B,
            entityTxs: [],
          },
        ],
      }),
    ).toBe(true);
    await waitUntil(() => receiverErrors.includes('INBOUND_ENTITY_RUNTIME_QUIESCING'), 'retryable rejection reported');

    expect(received).toBe(1);
    expect(receiver.isOpen()).toBe(true);
    expect(
      consoleError.mock.calls.some(call => call.some(value => String(value).includes('WS-CLIENT-DECRYPT-FAILED'))),
    ).toBe(false);
    consoleError.mockRestore();
  });

  test('requestRecoveryBundles times out when a connected peer never answers', async () => {
    let rawServer: ReturnType<typeof Bun.serve> | null = null;
    const challenges = createHelloChallengeRegistry();
    let issuedChallenge: RuntimeWsChallengeTranscript | null = null;
    rawServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (request.headers.get('upgrade') === 'websocket' && rawServer?.upgrade(request)) {
          return undefined;
        }
        return new Response('websocket only', { status: 400 });
      },
      websocket: {
        open(ws) {
          issuedChallenge = challenges.issue(
            ws,
            createRelayHandshakeBinding(`ws://127.0.0.1:${rawServer?.port}`),
          );
        },
        message(ws, raw) {
          const message = deserializeWsMessage(raw);
          if (message.type === 'hello') {
            if (!issuedChallenge) throw new Error('TEST_RELAY_CHALLENGE_MISSING');
            ws.send(serializeWsMessage(relayAck(message, issuedChallenge)));
          }
        },
      },
    });
    rawServers.push(rawServer);
    const client = makeClient({
      url: `ws://127.0.0.1:${rawServer.port}`,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
    });

    await client.connect();
    await waitUntil(() => client.isOpen(), 'dummy ws open');

    await expect(client.requestRecoveryBundles(RUNTIME_B, 'lookup/key', 50)).rejects.toThrow(
      'RECOVERY_REQUEST_TIMEOUT',
    );
  });
});
