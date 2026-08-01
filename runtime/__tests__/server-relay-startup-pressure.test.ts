import { expect, test } from 'bun:test';

import {
  createRelayStartupMessageGate,
  decodeRelayStartupHello,
  MAX_PENDING_RELAY_STARTUP_HELLOS,
  MAX_RELAY_STARTUP_HELLO_BYTES,
} from '../api/server/relay-startup-gate';
import { serializeWsMessage, type RuntimeWsMessage } from '../network/p2p/ws-protocol';

const PRESSURE_SOCKET_COUNT = 400;

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`WAIT_TIMEOUT:${label}`);
};

const maxSizeStartupHello = (): Uint8Array =>
  serializeWsMessage({
    type: 'hello',
    from: `0x${'11'.repeat(20)}`,
    fromEncryptionPubKey: `0x${'22'.repeat(32)}`,
    audience: `wss://relay.example/${'a'.repeat(3_586)}`,
    initiatorRole: 'runtime-client',
    responderRole: 'relay-server',
    timestamp: Number.MAX_SAFE_INTEGER,
    auth: {
      nonce: `0x${'33'.repeat(32)}`,
      signature: `0x${'44'.repeat(65)}`,
      timestamp: Number.MAX_SAFE_INTEGER,
    },
  } satisfies RuntimeWsMessage);

const oversizedStartupHello = (): Uint8Array => serializeWsMessage({
  ...decodeRelayStartupHello(maxSizeStartupHello()),
  audience: `wss://relay.example/${'a'.repeat(59_526)}`,
});

const connectAndSend = async (
  port: number,
  payload: Uint8Array,
  clients: WebSocket[],
): Promise<void> => {
  await Promise.all(Array.from({ length: PRESSURE_SOCKET_COUNT }, () => new Promise<void>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(client);
    client.addEventListener('open', () => {
      client.send(payload);
      resolve();
    }, { once: true });
    client.addEventListener('error', () => reject(new Error('STARTUP_PRESSURE_SOCKET_ERROR')), { once: true });
  })));
};

test('400 oversized startup hellos are rejected before decode retention', async () => {
  const payload = oversizedStartupHello();
  const clients: WebSocket[] = [];
  let rejected = 0;
  let decoded = 0;
  let closed = 0;
  let rejection = '';
  let server!: ReturnType<typeof Bun.serve>;

  expect(payload.byteLength).toBe(60_036);
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (server.upgrade(request)) return undefined;
      return new Response('WebSocket upgrade required', { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        try {
          decodeRelayStartupHello(raw as Buffer);
          decoded += 1;
        } catch (error) {
          rejected += 1;
          rejection ||= error instanceof Error ? error.message : String(error);
          ws.close(4003, 'protocol-invalid');
        }
      },
      close() {
        closed += 1;
      },
    },
  });

  try {
    Bun.gc(true);
    const rssBefore = process.memoryUsage().rss;
    await connectAndSend(server.port, payload, clients);
    await waitUntil(() => closed === PRESSURE_SOCKET_COUNT, 'oversized-startup-closes');
    Bun.gc(true);
    const rssDelta = Math.max(0, process.memoryUsage().rss - rssBefore);

    expect({ decoded, rejected, closed }).toEqual({
      decoded: 0,
      rejected: PRESSURE_SOCKET_COUNT,
      closed: PRESSURE_SOCKET_COUNT,
    });
    expect(rejection).toBe(
      `WS_MESSAGE_TOO_LARGE:bytes=${payload.byteLength}:max=${MAX_RELAY_STARTUP_HELLO_BYTES}`,
    );
    console.info(JSON.stringify({
      test: 'relay-startup-oversized-pressure',
      sockets: PRESSURE_SOCKET_COUNT,
      rejected,
      retainedBytes: 0,
      rssDelta,
    }));
  } finally {
    for (const client of clients) client.close();
    server.stop(true);
  }
}, 20_000);

test('400 real startup sockets retain at most 64 four-KiB hellos', async () => {
  let releaseStartup!: () => void;
  const startupBarrier = new Promise<void>(resolve => {
    releaseStartup = resolve;
  });
  const gate = createRelayStartupMessageGate();
  const payload = maxSizeStartupHello();
  const clients: WebSocket[] = [];
  let accepted = 0;
  let rejected = 0;
  let dispatched = 0;
  let retainedBytes = 0;
  let server!: ReturnType<typeof Bun.serve>;

  expect(payload.byteLength).toBe(MAX_RELAY_STARTUP_HELLO_BYTES);
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (server.upgrade(request)) return undefined;
      return new Response('WebSocket upgrade required', { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        const message = decodeRelayStartupHello(raw as Buffer);
        const result = gate.deferHello(
          startupBarrier,
          ws,
          message.type,
          () => {
            if (message.type === 'hello') dispatched += 1;
          },
          reason => {
            rejected += 1;
            ws.close(4003, reason);
          },
        );
        if (result === 'deferred') {
          accepted += 1;
          retainedBytes += (raw as Buffer).byteLength;
        }
      },
      close(ws) {
        gate.forget(ws);
      },
    },
  });

  try {
    Bun.gc(true);
    const rssBefore = process.memoryUsage().rss;
    await connectAndSend(server.port, payload, clients);
    await waitUntil(() => accepted + rejected === PRESSURE_SOCKET_COUNT, 'startup-pressure-decisions');
    await Bun.sleep(50);
    Bun.gc(true);
    const rssDelta = Math.max(0, process.memoryUsage().rss - rssBefore);

    expect({ accepted, rejected, pending: gate.pendingCount() }).toEqual({
      accepted: MAX_PENDING_RELAY_STARTUP_HELLOS,
      rejected: PRESSURE_SOCKET_COUNT - MAX_PENDING_RELAY_STARTUP_HELLOS,
      pending: MAX_PENDING_RELAY_STARTUP_HELLOS,
    });
    expect(retainedBytes).toBe(MAX_PENDING_RELAY_STARTUP_HELLOS * MAX_RELAY_STARTUP_HELLO_BYTES);
    expect(retainedBytes).toBeLessThan(1024 * 1024);

    console.info(
      JSON.stringify({
        test: 'relay-startup-pressure',
        sockets: PRESSURE_SOCKET_COUNT,
        accepted,
        rejected,
        retainedBytes,
        rssDelta,
      }),
    );

    releaseStartup();
    await startupBarrier;
    await Promise.resolve();
    expect(dispatched).toBe(MAX_PENDING_RELAY_STARTUP_HELLOS);
    expect(gate.pendingCount()).toBe(0);
  } finally {
    for (const client of clients) client.close();
    server.stop(true);
  }
}, 20_000);
