import { expect, test } from 'bun:test';

import {
  createRelayStartupMessageGate,
  decodeRelayStartupHello,
  MAX_PENDING_RELAY_STARTUP_HELLOS,
  MAX_RELAY_STARTUP_HELLO_BYTES,
} from '../api/server/relay-startup-gate';
import { deriveSignerAddressSync, signDigest } from '../account/crypto';
import { verifyHelloAuth } from '../network/p2p/hello-auth';
import {
  hashHelloMessage,
  serializeWsMessage,
  type RuntimeWsMessage,
} from '../network/p2p/ws-protocol';

const signedHello = (audience: string, responderRole: 'relay-server' | 'direct-runtime-server') => {
  const seed = 'relay-startup-size-fixture';
  const from = deriveSignerAddressSync(seed, '1');
  const fromEncryptionPubKey = `0x${'22'.repeat(32)}`;
  const responderRuntimeId = responderRole === 'direct-runtime-server' ? `0x${'55'.repeat(20)}` : '';
  const responderEncryptionPubKey = responderRole === 'direct-runtime-server' ? `0x${'66'.repeat(32)}` : '';
  const challenge = `0x${'33'.repeat(32)}`;
  const timestamp = Date.now();
  const signature = signDigest(seed, '1', hashHelloMessage({
    audience,
    initiatorRole: 'runtime-client',
    responderRole,
    responderRuntimeId,
    responderEncryptionPubKey,
    challenge,
    challengeTimestamp: timestamp,
    initiatorRuntimeId: from,
    initiatorEncryptionPubKey: fromEncryptionPubKey,
    timestamp,
  }));
  return {
    type: 'hello',
    from,
    fromEncryptionPubKey,
    ...(responderRuntimeId ? { to: responderRuntimeId } : {}),
    audience,
    initiatorRole: 'runtime-client',
    responderRole,
    timestamp,
    auth: { nonce: challenge, signature, timestamp },
  } satisfies RuntimeWsMessage;
};

test('startup hello byte budget leaves ample signed-handshake margin and is exact', () => {
  const relayHello = serializeWsMessage(signedHello('wss://relay.example/relay', 'relay-server'));
  const directHello = serializeWsMessage(signedHello(
    'wss://runtime-node.example:443/ws',
    'direct-runtime-server',
  ));
  const atBudget = serializeWsMessage(signedHello(
    `wss://relay.example/${'a'.repeat(3_586)}`,
    'relay-server',
  ));
  const overBudget = serializeWsMessage(signedHello(
    `wss://relay.example/${'a'.repeat(3_587)}`,
    'relay-server',
  ));

  expect({ relay: relayHello.byteLength, direct: directHello.byteLength }).toEqual({ relay: 513, direct: 578 });
  expect(atBudget.byteLength).toBe(MAX_RELAY_STARTUP_HELLO_BYTES);
  expect(overBudget.byteLength).toBe(MAX_RELAY_STARTUP_HELLO_BYTES + 1);
  expect(decodeRelayStartupHello(atBudget).type).toBe('hello');
  expect(() => decodeRelayStartupHello(overBudget)).toThrow(
    `WS_MESSAGE_TOO_LARGE:bytes=${MAX_RELAY_STARTUP_HELLO_BYTES + 1}:max=${MAX_RELAY_STARTUP_HELLO_BYTES}`,
  );
});

test('legitimate signed relay hello queues and authenticates after startup', async () => {
  let releaseStartup!: () => void;
  const startupBarrier = new Promise<void>(resolve => { releaseStartup = resolve; });
  const gate = createRelayStartupMessageGate();
  const hello = decodeRelayStartupHello(serializeWsMessage(
    signedHello('wss://relay.example/relay', 'relay-server'),
  ));
  let authResult: string | null = 'not-dispatched';

  gate.deferHello(
    startupBarrier,
    {},
    hello.type,
    () => {
      authResult = verifyHelloAuth({
        audience: String(hello.audience),
        initiatorRole: 'runtime-client',
        responderRole: 'relay-server',
        responderRuntimeId: '',
        responderEncryptionPubKey: '',
        challenge: String(hello.auth?.nonce),
        challengeTimestamp: Number(hello.auth?.timestamp),
        initiatorRuntimeId: String(hello.from),
        initiatorEncryptionPubKey: String(hello.fromEncryptionPubKey),
        timestamp: Number(hello.timestamp),
      }, hello.auth, 5_000);
    },
    () => undefined,
  );

  expect(authResult).toBe('not-dispatched');
  releaseStartup();
  await startupBarrier;
  await Promise.resolve();
  expect(authResult).toBeNull();
});

test('relay startup gate retains only one hello and rejects every other pre-auth frame', async () => {
  let releaseStartup!: () => void;
  const startupBarrier = new Promise<void>(resolve => { releaseStartup = resolve; });
  const gate = createRelayStartupMessageGate();
  const dispatched: string[] = [];
  const rejected: string[] = [];
  const legitimateSocket = {};
  const arbitraryFrameSocket = {};
  const duplicateHelloSocket = {};

  expect(gate.deferHello(
    startupBarrier,
    legitimateSocket,
    'hello',
    () => { dispatched.push('legitimate'); },
    reason => { rejected.push(`legitimate:${reason}`); },
  )).toBe('deferred');

  expect(gate.deferHello(
    startupBarrier,
    arbitraryFrameSocket,
    'entity_inputs',
    () => { dispatched.push('arbitrary'); },
    reason => { rejected.push(`arbitrary:${reason}`); },
  )).toBe('rejected');

  expect(gate.deferHello(
    startupBarrier,
    duplicateHelloSocket,
    'hello',
    () => { dispatched.push('duplicate'); },
    reason => { rejected.push(`duplicate-first:${reason}`); },
  )).toBe('deferred');
  expect(gate.deferHello(
    startupBarrier,
    duplicateHelloSocket,
    'hello',
    () => { dispatched.push('duplicate-second'); },
    reason => { rejected.push(`duplicate-second:${reason}`); },
  )).toBe('rejected');

  expect(dispatched).toEqual([]);
  expect(gate.pendingCount()).toBe(1);
  expect(rejected).toEqual([
    'arbitrary:startup-hello-required',
    'duplicate-second:startup-hello-pending',
  ]);

  releaseStartup();
  await startupBarrier;
  await Promise.resolve();
  expect(dispatched).toEqual(['legitimate']);
  expect(gate.pendingCount()).toBe(0);
});

test('closing a startup socket cancels its deferred hello', async () => {
  let releaseStartup!: () => void;
  const startupBarrier = new Promise<void>(resolve => { releaseStartup = resolve; });
  const gate = createRelayStartupMessageGate();
  const ws = {};
  let dispatched = false;

  gate.deferHello(
    startupBarrier,
    ws,
    'hello',
    () => { dispatched = true; },
    () => undefined,
  );
  gate.forget(ws);
  releaseStartup();
  await startupBarrier;
  await Promise.resolve();

  expect(dispatched).toBe(false);
  expect(gate.pendingCount()).toBe(0);
});

test('malformed second startup frame cancels its deferred hello before the barrier', async () => {
  let releaseStartup!: () => void;
  const startupBarrier = new Promise<void>(resolve => { releaseStartup = resolve; });
  const gate = createRelayStartupMessageGate();
  const ws = {};
  let dispatched = 0;

  gate.deferHello(startupBarrier, ws, 'hello', () => { dispatched += 1; }, () => undefined);
  expect(gate.pendingCount()).toBe(1);
  expect(() => decodeRelayStartupHello(new Uint8Array([0x01, 0xff]))).toThrow();
  // Mirrors the server parse catch: malformed follow-up traffic owns no
  // deferred hello, even when the socket close races startup completion.
  gate.forget(ws);
  expect(gate.pendingCount()).toBe(0);

  releaseStartup();
  await startupBarrier;
  await Promise.resolve();
  expect(dispatched).toBe(0);
});

test('relay startup gate caps pending hellos without retaining closed-socket churn', async () => {
  let releaseStartup!: () => void;
  const startupBarrier = new Promise<void>(resolve => { releaseStartup = resolve; });
  const gate = createRelayStartupMessageGate(2);
  const dispatched: number[] = [];
  const rejected: string[] = [];

  for (let index = 0; index < 100; index += 1) {
    const ws = {};
    gate.deferHello(
      startupBarrier,
      ws,
      'hello',
      () => { dispatched.push(index); },
      reason => { rejected.push(reason); },
    );
    if (index < 99) gate.forget(ws);
  }

  expect(gate.pendingCount()).toBe(1);
  expect(rejected).toEqual([]);
  const second = {};
  const overCapacity = {};
  expect(gate.deferHello(startupBarrier, second, 'hello', () => { dispatched.push(100); }, reason => {
    rejected.push(reason);
  })).toBe('deferred');
  expect(gate.deferHello(startupBarrier, overCapacity, 'hello', () => { dispatched.push(101); }, reason => {
    rejected.push(reason);
  })).toBe('rejected');
  expect(gate.pendingCount()).toBe(2);
  expect(rejected).toEqual(['startup-hello-capacity']);

  releaseStartup();
  await startupBarrier;
  await Promise.resolve();
  expect(dispatched).toEqual([99, 100]);
  expect(gate.pendingCount()).toBe(0);
});

test('default startup capacity admits 64 peers and rejects excess peers for reconnect', () => {
  const startupBarrier = new Promise<void>(() => undefined);
  const gate = createRelayStartupMessageGate();
  let accepted = 0;
  let rejected = 0;

  for (let index = 0; index < MAX_PENDING_RELAY_STARTUP_HELLOS + 16; index += 1) {
    const result = gate.deferHello(
      startupBarrier,
      {},
      'hello',
      () => undefined,
      reason => {
        expect(reason).toBe('startup-hello-capacity');
        rejected += 1;
      },
    );
    if (result === 'deferred') accepted += 1;
  }

  expect({ accepted, rejected, pending: gate.pendingCount() }).toEqual({
    accepted: MAX_PENDING_RELAY_STARTUP_HELLOS,
    rejected: 16,
    pending: MAX_PENDING_RELAY_STARTUP_HELLOS,
  });
});
