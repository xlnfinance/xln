import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { deriveEncryptionKeyPair } from '../../../protocol/crypto/p2p-crypto';
import { RuntimeWsClient } from '../../../network/p2p/ws-client';
import { canonicalizeRuntimeWsAudience, deserializeWsMessage, serializeWsMessage } from '../../../network/p2p/ws-protocol';
import { startStandaloneRelayServer, type StandaloneRelayServer } from '../../../network/relay/standalone-server';
import { createEmptyEnv } from '../../../runtime';
import { signRuntimeEntityInputsEnvelope } from '../../../runtime/admit/entity-input-envelope-auth.ts';

const SERVER_RUNTIME_ID = '0x9999999999999999999999999999999999999999';
const SEED_A = 'runtime-ws-recovery-client-a';
const SEED_B = 'runtime-ws-recovery-client-b';
const RUNTIME_A = deriveSignerAddressSync(SEED_A, '1').toLowerCase();
const RUNTIME_B = deriveSignerAddressSync(SEED_B, '2').toLowerCase();

let servers: StandaloneRelayServer[] = [];
let rawServers: Array<ReturnType<typeof Bun.serve>> = [];
let clients: RuntimeWsClient[] = [];

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`WAIT_TIMEOUT:${label}`);
};

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
}): RuntimeWsClient => {
  const client = new RuntimeWsClient({
    url: options.url,
    runtimeId: options.runtimeId,
    helloAudience: canonicalizeRuntimeWsAudience(options.url),
    signerId: options.signerId,
    seed: options.seed,
    encryptionKeyPair: deriveEncryptionKeyPair(options.seed),
    getTargetEncryptionKey: options.getTargetEncryptionKey,
    onEntityInputs: options.onEntityInputs,
    onOpen: options.onOpen,
    onRecoveryBundleRequest: options.onRecoveryBundleRequest,
    onError: options.onError,
  });
  clients.push(client);
  return client;
};

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.close();
  for (const server of rawServers.splice(0)) server.stop(true);
});

describe('runtime websocket recovery requests', () => {
  test('standalone relay uses structured startup logging', () => {
    const source = readFileSync(join(process.cwd(), 'core/network/relay/standalone-server.ts'), 'utf8');

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
    });

    await client.connect();
    await waitUntil(() => registeredWhenOpened, 'registered hello acknowledgement');

    expect(registeredWhenOpened).toBe(true);
    expect(errors).toEqual([]);
  });

  test('authenticated socket cannot send gossip before hello acknowledgement', async () => {
    let socket: { send: (payload: string | ArrayBufferView | ArrayBuffer) => number } | null = null;
    const receivedTypes: string[] = [];
    let rawServer: ReturnType<typeof Bun.serve> | null = null;
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
          ws.send(
            serializeWsMessage({
              type: 'hello_challenge',
              challenge: 'runtime-ws-auth-readiness',
              audience: `ws://127.0.0.1:${rawServer!.port}/`,
            }),
          );
        },
        message(_ws, raw) {
          receivedTypes.push(deserializeWsMessage(raw).type);
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

    socket?.send(serializeWsMessage({ type: 'hello_ack', to: RUNTIME_A }));
    await waitUntil(() => client.isOpen(), 'authenticated client ready');
    expect(client.isConnecting()).toBe(false);
  });

  test('failed hello send does not unlock non-hello frames before acknowledgement', async () => {
    const receivedTypes: string[] = [];
    const errors: string[] = [];
    let rawServer: ReturnType<typeof Bun.serve> | null = null;
    rawServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        if (request.headers.get('upgrade') === 'websocket' && server.upgrade(request)) return;
        return new Response('websocket only', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(
            serializeWsMessage({
              type: 'hello_challenge',
              challenge: 'runtime-ws-hello-send-fail',
              audience: `ws://127.0.0.1:${rawServer!.port}/`,
            }),
          );
        },
        message(_ws, raw) {
          receivedTypes.push(deserializeWsMessage(raw).type);
        },
      },
    });
    rawServers.push(rawServer);
    const client = makeClient({
      url: `ws://127.0.0.1:${rawServer.port}`,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
      onError: error => errors.push(error.message),
    });
    const clientState = client as unknown as {
      sendRaw: (msg: { type: string }) => boolean;
      connecting: boolean;
      helloSent: boolean;
      helloNonce: string | null;
      handleSocketError: (generation: number, error: Error) => void;
      lifecycleGeneration: number;
    };
    const originalSendRaw = clientState.sendRaw.bind(client);
    clientState.sendRaw = (msg) => {
      if (msg.type === 'hello') return false;
      return originalSendRaw(msg);
    };

    await client.connect();
    await waitUntil(() => errors.includes('WS_HELLO_SEND_FAILED'), 'hello send failure');
    expect(clientState.helloSent).toBe(false);
    expect(clientState.helloNonce).toBeNull();

    clientState.handleSocketError(clientState.lifecycleGeneration, new Error('spurious'));
    expect(clientState.connecting).toBe(false);
    expect(client.sendDebugEvent({ code: 'PRE_HELLO' })).toBe(false);
    expect(receivedTypes).toEqual([]);
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
    await waitUntil(() => relay.store.clients.has(RUNTIME_A) && relay.store.clients.has(RUNTIME_B), 'relay clients');

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
    await waitUntil(() => relay.store.clients.has(RUNTIME_A), 'requester relay client');

    await expect(requester.requestRecoveryBundles(RUNTIME_B, 'lookup/key', 1_000)).rejects.toThrow(
      'RECOVERY_TARGET_NOT_CONNECTED',
    );
    expect(requesterErrors).toEqual([]);
  });

  test('reports an inbound Account rejection to both ends without hiding it', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const relay = startRelay();
    const url = `ws://127.0.0.1:${relay.server.port}`;
    const receiverErrors: string[] = [];
    const senderErrors: string[] = [];
    let received = 0;
    const sender = makeClient({
      url,
      seed: SEED_A,
      runtimeId: RUNTIME_A,
      signerId: '1',
      getTargetEncryptionKey: runtimeId => (runtimeId === RUNTIME_B ? deriveEncryptionKeyPair(SEED_B).publicKey : null),
      onError: error => senderErrors.push(error.message),
    });
    const receiver = makeClient({
      url,
      seed: SEED_B,
      runtimeId: RUNTIME_B,
      signerId: '2',
      onEntityInputs: () => {
        received += 1;
        throw new Error('INBOUND_ENTITY_RUNTIME_QUIESCING:test-quiesce');
      },
      onError: error => receiverErrors.push(error.message),
    });
    await sender.connect();
    await receiver.connect();
    await waitUntil(() => relay.store.clients.has(RUNTIME_A) && relay.store.clients.has(RUNTIME_B), 'relay clients');
    await waitUntil(() => sender.isOpen() && receiver.isOpen(), 'authenticated clients');

    const source = createEmptyEnv(SEED_A);
    const envelope = signRuntimeEntityInputsEnvelope(source, RUNTIME_B, {
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
    });
    expect(sender.sendEntityInputsRaw(RUNTIME_B, envelope)).toBe(true);
    await waitUntil(
      () => receiverErrors.some(message => message.includes('INBOUND_ENTITY_RUNTIME_QUIESCING')),
      'receiver rejection reported',
    );
    await waitUntil(
      () => senderErrors.some(message => message.includes('P2P_REMOTE_REJECTED')),
      'sender rejection reported',
    );
    expect(received).toBe(1);
    expect(receiver.isOpen()).toBe(true);
    expect(
      consoleError.mock.calls.some(call => call.some(value => String(value).includes('WS-CLIENT-DECRYPT-FAILED'))),
    ).toBe(false);
    consoleError.mockRestore();
  });

  test('requestRecoveryBundles times out when a connected peer never answers', async () => {
    let rawServer: ReturnType<typeof Bun.serve> | null = null;
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
          ws.send(
            serializeWsMessage({
              type: 'hello_challenge',
              challenge: 'runtime-ws-recovery-timeout',
              audience: `ws://127.0.0.1:${rawServer!.port}/`,
            }),
          );
        },
        message(ws, raw) {
          const message = deserializeWsMessage(raw);
          if (message.type === 'hello') {
            ws.send(serializeWsMessage({ type: 'hello_ack', to: RUNTIME_A }));
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
