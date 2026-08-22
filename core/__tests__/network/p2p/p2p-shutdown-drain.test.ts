import { expect, test } from 'bun:test';

import { reportDirectClientError, reportRelayClientError, RuntimeP2P } from '../../../network/p2p/p2p';
import { RuntimeWsClient } from '../../../network/p2p/ws-client';
import { deriveEncryptionKeyPair } from '../../../protocol/crypto/p2p-crypto';
import { stopRuntimeP2P, stopRuntimeP2PAndWait } from '../../../runtime/envelope/p2p-lifecycle';
import { createEmptyEnv } from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import { canonicalizeRuntimeWsAudience } from '../../../network/p2p/ws-protocol';

const RUNTIME_ID = `0x${'11'.repeat(20)}`;

test('offline target and ingress rejection are loud transport failures', () => {
  const env = createEmptyEnv('p2p-receipt-target-offline-severity');
  const info: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  env.info = (_category, message) => { info.push(message); };
  env.error = (_category, message) => { errors.push(message); };
  env.warn = (_category, message) => { warnings.push(message); };

  reportRelayClientError(env, 'ws://relay', new Error('ENTITY_INPUT_TARGET_NOT_CONNECTED'));
  expect(errors).toEqual(['WS_RELAY_FATAL']);
  expect(warnings).toEqual([]);

  reportRelayClientError(env, 'ws://relay', new Error('ENTITY_INPUT_RATE_LIMITED'));
  expect(errors).toEqual([
    'WS_RELAY_FATAL',
    'WS_RELAY_FATAL',
  ]);
  expect(warnings).toEqual([]);

  reportRelayClientError(env, 'ws://relay', new Error(
    'P2P_INBOUND_ENTITY_INPUT_REJECTED:INBOUND_ENTITY_RUNTIME_QUIESCING: ' +
      'entity=0x11 signer=0x22 txTypes=consensusOutput',
  ));
  expect(errors).toEqual([
    'WS_RELAY_FATAL',
    'WS_RELAY_FATAL',
    'WS_RELAY_FATAL',
  ]);
  expect(warnings).toEqual([]);

  reportRelayClientError(env, 'ws://relay', new Error('unexpected transport failure'));
  expect(errors).toEqual([
    'WS_RELAY_FATAL',
    'WS_RELAY_FATAL',
    'WS_RELAY_FATAL',
    'WS_RELAY_FATAL',
  ]);
  expect(warnings).toEqual([]);
});

test('direct runtime rejection is a visible transport error, never a retry hint', () => {
  const env = createEmptyEnv('p2p-direct-quiesce-severity');
  const info: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  env.info = (_category, message) => { info.push(message); };
  env.error = (_category, message) => { errors.push(message); };
  env.warn = (_category, message) => { warnings.push(message); };

  expect(reportDirectClientError(
    env,
    'ws://peer/ws',
    `0x${'22'.repeat(20)}`,
    new Error('INBOUND_ENTITY_RUNTIME_QUIESCING: entity=0x11 signer=0x22 txTypes=consensusOutput'),
  )).toBe('transport-error');
  expect(info).toEqual([]);
  expect(errors).toEqual(['WS_DIRECT_FATAL']);
  expect(warnings).toEqual([]);

  expect(reportDirectClientError(env, 'ws://peer/ws', `0x${'22'.repeat(20)}`, new Error('socket failed')))
    .toBe('transport-error');
  expect(errors).toEqual(['WS_DIRECT_FATAL', 'WS_DIRECT_FATAL']);
  expect(warnings).toEqual([]);
});

test('node websocket async send failures retain exact envelope correlation', () => {
  const errors: string[] = [];
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
    helloAudience: RUNTIME_ID,
    signerId: '1',
    seed: 'node-ws-async-send-failure',
    encryptionKeyPair: deriveEncryptionKeyPair('node-ws-async-send-failure'),
    onError: error => errors.push(error.message),
  });
  const socket = {
    readyState: 1,
    bufferedAmount: 77,
    on: () => undefined,
    send: (_payload: string, callback?: (error?: Error) => void) => {
      callback?.(new Error('kernel flush failed'));
    },
    close: () => undefined,
  };
  const internals = client as unknown as {
    ws: typeof socket;
    helloAcknowledged: boolean;
    helloAudience: string;
    helloNonce: string;
  };
  internals.ws = socket;
  internals.helloAcknowledged = true;
  internals.helloAudience = RUNTIME_ID;
  internals.helloNonce = 'node-ws-send-nonce';

  expect(client.sendDebugEvent({ code: 'CORRELATED_SEND' })).toBe(true);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('WS_ASYNC_SEND_FAILED:type=debug_event:id=');
  expect(errors[0]).toContain(':bytes=');
  expect(errors[0]).toContain(':buffered=77:error=kernel flush failed');
});

test('a socket close never schedules an implicit transport retry', () => {
  const errors: string[] = [];
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
    helloAudience: 'ws://127.0.0.1:1/relay',
    onError: error => errors.push(error.message),
  });
  const internals = client as unknown as {
    closed: boolean;
    connecting: boolean;
    lifecycleGeneration: number;
    ws: { readyState: number; bufferedAmount: number };
    handleSocketClose: (generation: number, code: number, reason: string) => void;
  };

  internals.ws = { readyState: 3, bufferedAmount: 0 };
  internals.connecting = true;
  internals.handleSocketClose(0, 4009, 'duplicate-runtime');

  expect(internals.lifecycleGeneration).toBe(0);
  expect(internals.connecting).toBe(false);
  expect(internals.closed).toBe(false);
  expect(errors).toEqual([
    expect.stringContaining('WS_UNEXPECTED_CLOSE:'),
  ]);
});

test('websocket client remains closed until the authenticated hello settles', async () => {
  let releaseHandshake!: () => void;
  const handshakeGate = new Promise<void>((resolve) => { releaseHandshake = resolve; });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, serverRef) {
      await handshakeGate;
      if (serverRef.upgrade(request)) return;
      return new Response('upgrade rejected', { status: 400 });
    },
    websocket: {
      open() {},
      message() {},
      close() {},
    },
  });
  const client = new RuntimeWsClient({
    url: `ws://127.0.0.1:${server.port}/relay`,
    runtimeId: RUNTIME_ID,
    helloAudience: canonicalizeRuntimeWsAudience(`ws://127.0.0.1:${server.port}/relay`),
    encryptionKeyPair: deriveEncryptionKeyPair('p2p-handshake-lifecycle'),
  });

  await client.connect();
  const connectingDuringHandshake = client.isConnecting();
  const internals = client as unknown as { lifecycleGeneration: number };
  const generationDuringHandshake = internals.lifecycleGeneration;
  const duplicateConnect = client.connect();
  const generationAfterDuplicateConnect = internals.lifecycleGeneration;
  releaseHandshake();
  const duplicateConnectError = await duplicateConnect.then(
    () => null,
    error => error instanceof Error ? error : new Error(String(error)),
  );
  for (let attempt = 0; attempt < 100 && !client.isOpen(); attempt += 1) {
    await Bun.sleep(5);
  }
  const openedAfterHandshake = client.isOpen();
  await client.closeAndWait(1_000);
  server.stop(true);

  expect(connectingDuringHandshake).toBe(true);
  expect(duplicateConnectError).toBeNull();
  expect(generationAfterDuplicateConnect).toBe(generationDuringHandshake);
  expect(openedAfterHandshake).toBe(false);
});

test('websocket shutdown waits for the transport close handshake', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
    helloAudience: 'ws://127.0.0.1:1/relay',
  });
  let closeObserved = false;
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null as ((event: Event) => void) | null,
    onerror: null,
    send: () => {},
    close() {
      setTimeout(() => {
        socket.readyState = 3;
        closeObserved = true;
        socket.onclose?.(new Event('close'));
      }, 25);
    },
  };
  (client as unknown as { ws: typeof socket }).ws = socket;

  const startedAt = performance.now();
  await (client as unknown as { closeAndWait: () => Promise<void> }).closeAndWait();

  expect(closeObserved).toBe(true);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(20);
});

test('websocket shutdown rejects a missing close handshake', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
    helloAudience: 'ws://127.0.0.1:1/relay',
  });
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close: () => {},
  };
  (client as unknown as { ws: typeof socket }).ws = socket;

  await expect(client.closeAndWait(10)).rejects.toThrow('WS_CLOSE_TIMEOUT:10');
});

test('websocket shutdown observes a close racing listener registration', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
    helloAudience: 'ws://127.0.0.1:1/relay',
  });
  let closeCalls = 0;
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 2,
    send: () => {},
    close: () => { closeCalls += 1; },
    on(event: string, _listener: (...args: unknown[]) => void) {
      if (event === 'close') socket.readyState = 3;
    },
  };
  (client as unknown as { ws: typeof socket }).ws = socket;

  await client.closeAndWait(25);

  expect(socket.readyState).toBe(3);
  expect(closeCalls).toBe(0);
});

test('connect racing terminal shutdown cannot publish a late socket', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
    helloAudience: 'ws://127.0.0.1:1/relay',
  });
  const internals = client as unknown as { ws: { close: () => void } | null };
  const connecting = client.connect().catch(() => {});

  try {
    await client.closeAndWait(50);
    await connecting;
    expect(internals.ws).toBeNull();
  } finally {
    internals.ws?.close();
  }
});

test('failed stale-socket drain retains the handle for retry', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
    helloAudience: 'ws://127.0.0.1:1/relay',
  });
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close: () => {},
  };
  const internals = client as unknown as {
    ws: typeof socket | null;
    terminalCloseTimeoutMs: number;
  };
  internals.ws = socket;
  internals.terminalCloseTimeoutMs = 10;

  await expect(client.connect()).rejects.toThrow('WS_CLOSE_TIMEOUT:10');
  expect(internals.ws).toBe(socket);

  socket.readyState = 3;
  await client.closeAndWait(10);
  expect(internals.ws).toBeNull();
});

test('concurrent websocket shutdown callers await the same drain', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
    helloAudience: 'ws://127.0.0.1:1/relay',
  });
  let closeObserved = false;
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null as ((event: Event) => void) | null,
    onerror: null,
    send: () => {},
    close() {
      setTimeout(() => {
        socket.readyState = 3;
        closeObserved = true;
        socket.onclose?.(new Event('close'));
      }, 25);
    },
  };
  (client as unknown as { ws: typeof socket }).ws = socket;

  const first = client.closeAndWait();
  const second = client.closeAndWait();
  await second;

  expect(closeObserved).toBe(true);
  await first;
});

test('synchronous websocket close retains ownership for a later awaited drain', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
    helloAudience: 'ws://127.0.0.1:1/relay',
  });
  let closeObserved = false;
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null as ((event: Event) => void) | null,
    onerror: null,
    send: () => {},
    close() {
      socket.readyState = 2;
      setTimeout(() => {
        socket.readyState = 3;
        closeObserved = true;
        socket.onclose?.(new Event('close'));
      }, 25);
    },
  };
  const internals = client as unknown as { ws: typeof socket | null };
  internals.ws = socket;

  client.close();
  const startedAt = performance.now();
  await client.closeAndWait(1_000);

  expect(closeObserved).toBe(true);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(20);
  expect(internals.ws).toBeNull();
});

test('synchronous websocket close keeps a missing handshake loud during awaited drain', async () => {
  const client = new RuntimeWsClient({
    url: 'ws://127.0.0.1:1/relay',
    runtimeId: RUNTIME_ID,
    helloAudience: 'ws://127.0.0.1:1/relay',
  });
  const socket = {
    binaryType: 'arraybuffer',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close() {
      socket.readyState = 2;
    },
  };
  const internals = client as unknown as { ws: typeof socket | null };
  internals.ws = socket;

  client.close();

  await expect(client.closeAndWait(10)).rejects.toThrow('WS_CLOSE_TIMEOUT:10');
  expect(internals.ws).toBe(socket);
});

test('p2p start has no duplicate bootstrap poll before slow reconciliation', async () => {
  const env = createEmptyEnv('p2p-shutdown-drain');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  let gossipPolls = 0;
  const internals = p2p as unknown as {
    requestSeedGossip: () => void;
    startPolling: () => void;
    closeAndWait: () => Promise<void>;
  };
  internals.requestSeedGossip = () => {
    gossipPolls += 1;
  };

  internals.startPolling();
  await internals.closeAndWait();
  await Bun.sleep(150);

  expect(gossipPolls).toBe(0);
});

test('p2p shutdown aborts an in-flight retry delay', async () => {
  const env = createEmptyEnv('p2p-shutdown-retry-delay');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  const internals = p2p as unknown as {
    waitForActiveDelay: (delayMs: number) => Promise<boolean>;
  };
  const startedAt = performance.now();
  const waiting = internals.waitForActiveDelay(1_000);

  await p2p.closeAndWait();

  expect(await waiting).toBe(false);
  expect(performance.now() - startedAt).toBeLessThan(100);
});

test('p2p shutdown drains every client before reporting aggregate failure', async () => {
  const env = createEmptyEnv('p2p-shutdown-all-settled');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  let slowDone = false;
  const failedClient = {
    close: () => {},
    closeAndWait: async () => {
      throw new Error('relay-close-failed');
    },
  };
  const slowClient = {
    close: () => {},
    closeAndWait: async () => {
      await Bun.sleep(40);
      slowDone = true;
    },
  };
  const internals = p2p as unknown as {
    clients: Array<typeof failedClient | typeof slowClient>;
    retiringClients: Map<typeof failedClient | typeof slowClient, unknown>;
    closeAndWait: () => Promise<void>;
  };
  internals.clients = [failedClient, slowClient];

  const startedAt = performance.now();
  const error = await internals.closeAndWait().then(() => null, (caught: Error) => caught);

  expect(error?.message).toContain('relay-close-failed');
  expect(slowDone).toBe(true);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(35);
  expect(internals.clients).toEqual([]);
  expect(internals.retiringClients.has(failedClient)).toBe(true);
  expect(internals.retiringClients.has(slowClient)).toBe(false);
});

test('relay reconfiguration removes active ownership and final shutdown drains the retiree', async () => {
  const env = createEmptyEnv('p2p-relay-reconfigure-retire');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  let closeCalls = 0;
  let drained = false;
  const oldClient = {
    close: () => { closeCalls += 1; },
    closeAndWait: async () => { drained = true; },
  };
  const internals = p2p as unknown as {
    clients: Array<typeof oldClient>;
    retiringClients: Map<typeof oldClient, unknown>;
    closeClients: () => void;
    drainAllClients: (timeoutMs: number) => Promise<void>;
  };
  internals.clients = [oldClient];

  internals.closeClients();

  expect(internals.clients).toEqual([]);
  expect(internals.retiringClients.has(oldClient)).toBe(true);
  expect(closeCalls).toBe(1);
  await internals.drainAllClients(100);
  expect(drained).toBe(true);
  expect(internals.retiringClients.size).toBe(0);
});

test('direct endpoint removal retires the exact client before transport selection can reuse it', () => {
  const env = createEmptyEnv('p2p-direct-endpoint-removal');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  const targetRuntimeId = `0x${'22'.repeat(20)}`;
  let closeCalls = 0;
  const oldClient = { close: () => { closeCalls += 1; } };
  const internals = p2p as unknown as {
    directClients: Map<string, typeof oldClient>;
    directClientUrls: Map<string, string>;
    directClientErrors: Map<string, unknown>;
    retiringClients: Map<typeof oldClient, unknown>;
    getDirectPeerEndpoint: () => null;
    ensureDirectClientForRuntime: (runtimeId: string) => void;
  };
  internals.directClients.set(targetRuntimeId, oldClient);
  internals.directClientUrls.set(targetRuntimeId, 'ws://127.0.0.1:9001/relay');
  internals.directClientErrors.set(targetRuntimeId, { error: 'old' });
  internals.getDirectPeerEndpoint = () => null;

  internals.ensureDirectClientForRuntime(targetRuntimeId);

  expect(closeCalls).toBe(1);
  expect(internals.directClients.has(targetRuntimeId)).toBe(false);
  expect(internals.directClientUrls.has(targetRuntimeId)).toBe(false);
  expect(internals.directClientErrors.has(targetRuntimeId)).toBe(false);
  expect(internals.retiringClients.has(oldClient)).toBe(true);
});

test('closing p2p rejects late direct-client creation', () => {
  const env = createEmptyEnv('p2p-shutdown-late-direct');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  const internals = p2p as unknown as {
    closing: boolean;
    directClients: Map<string, unknown>;
    getDirectPeerEndpoint: () => string;
    ensureDirectClientForRuntime: (runtimeId: string) => void;
  };
  internals.closing = true;
  internals.getDirectPeerEndpoint = () => 'ws://127.0.0.1:1/relay';

  try {
    internals.ensureDirectClientForRuntime(`0x${'22'.repeat(20)}`);
    expect(internals.directClients.size).toBe(0);
  } finally {
    p2p.close();
  }
});

test('runtime lifecycle clears attachment only through drained shutdown', async () => {
  let drained = false;
  const env = {
    infrastructure: {
      p2p: {
        closeAndWait: async () => {
          await Bun.sleep(5);
          drained = true;
        },
      },
      lastP2PConfig: { runtimeId: RUNTIME_ID },
    },
  } as unknown as RuntimeReplica;

  await stopRuntimeP2PAndWait(env, {
    ensureRuntimeInfrastructure: (target) => target.infrastructure!,
    notifyEnvChange: () => {},
    handleInboundP2PEntityInput: () => ({ kind: 'accepted' }),
    enqueueRuntimeInputs: () => {},
  });

  expect(drained).toBe(true);
  expect(env.infrastructure?.p2p).toBeNull();
  expect(env.infrastructure?.lastP2PConfig).toBeNull();
});

test('synchronous stop retains transport ownership for a later awaited drain', async () => {
  let closeStarted = false;
  let drained = false;
  const p2p = {
    close: () => { closeStarted = true; },
    closeAndWait: async () => { drained = true; },
  };
  const env = {
    infrastructure: {
      p2p,
      lastP2PConfig: { runtimeId: RUNTIME_ID },
    },
  } as unknown as RuntimeReplica;
  const deps = {
    ensureRuntimeInfrastructure: (target: RuntimeReplica) => target.infrastructure!,
    notifyEnvChange: () => {},
    handleInboundP2PEntityInput: () => ({ kind: 'accepted' as const }),
    enqueueRuntimeInputs: () => {},
  };

  stopRuntimeP2P(env, deps);
  expect(closeStarted).toBe(true);
  expect(env.infrastructure?.p2p).toBe(p2p);

  await stopRuntimeP2PAndWait(env, deps);
  expect(drained).toBe(true);
  expect(env.infrastructure?.p2p).toBeNull();
});

test('synchronous runtime stop preserves actual P2P clients until awaited drain', async () => {
  const env = createEmptyEnv('p2p-sync-then-awaited-drain');
  const p2p = new RuntimeP2P({
    env,
    runtimeId: RUNTIME_ID,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  let closeStarted = false;
  let drained = false;
  const client = {
    close: () => { closeStarted = true; },
    closeAndWait: async () => {
      await Bun.sleep(25);
      drained = true;
    },
  };
  const internals = p2p as unknown as {
    clients: Array<typeof client>;
    retiringClients: Map<typeof client, unknown>;
  };
  internals.clients = [client];
  env.infrastructure = {
    ...env.infrastructure,
    p2p,
    lastP2PConfig: { runtimeId: RUNTIME_ID },
  };
  const deps = {
    ensureRuntimeInfrastructure: (target: RuntimeReplica) => target.infrastructure!,
    notifyEnvChange: () => {},
    handleInboundP2PEntityInput: () => ({ kind: 'accepted' as const }),
    enqueueRuntimeInputs: () => {},
  };

  stopRuntimeP2P(env, deps);
  expect(closeStarted).toBe(true);
  expect(internals.clients).toEqual([]);
  expect(internals.retiringClients.has(client)).toBe(true);

  const startedAt = performance.now();
  await stopRuntimeP2PAndWait(env, deps);

  expect(drained).toBe(true);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(20);
  expect(internals.clients).toEqual([]);
  expect(internals.retiringClients.size).toBe(0);
  expect(env.infrastructure?.p2p).toBeNull();
});

test('runtime lifecycle retains the quiesced handle when drain fails', async () => {
  const p2p = {
    closeAndWait: async () => {
      throw new Error('drain-failed');
    },
  };
  const env = {
    infrastructure: {
      p2p,
      lastP2PConfig: { runtimeId: RUNTIME_ID },
    },
  } as unknown as RuntimeReplica;

  await expect(stopRuntimeP2PAndWait(env, {
    ensureRuntimeInfrastructure: (target) => target.infrastructure!,
    notifyEnvChange: () => {},
    handleInboundP2PEntityInput: () => ({ kind: 'accepted' }),
    enqueueRuntimeInputs: () => {},
  })).rejects.toThrow('drain-failed');

  expect(env.infrastructure?.p2p).toBe(p2p);
  expect(env.infrastructure?.lastP2PConfig).toEqual({ runtimeId: RUNTIME_ID });
});
