import { afterEach, describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync, signDigest } from '../../../account/crypto';
import { createDirectRuntimeWsRoute as createProductionDirectRuntimeWsRoute } from '../../../network/p2p/direct-runtime-bun';
import { decryptJSON, deriveEncryptionKeyPair, encryptJSON, pubKeyToHex } from '../../../protocol/crypto/p2p-crypto';
import { hashHelloMessage, hashRuntimeWsFrame, serializeWsMessage, deserializeWsMessage, serializeWsMessageForDebug, type RuntimeWsMessage } from '../../../network/p2p/ws-protocol';
import { verifyHelloAuth, verifyRuntimeWsFrameAuth } from '../../../network/p2p/auth/hello-auth';
import { XLN_PROTOCOL_VERSION } from '../../../protocol/version';
import { encodeBinaryPayload } from '../../../storage/codec/binary-codec';
import type { RoutedEntityInput, RuntimeEntityInputsEnvelope } from '../../../runtime/types';

const makeAuthedHello = (
  seed: string,
  runtimeId: string,
  signerId = '1',
  challenge?: string,
  audience = '',
): RuntimeWsMessage => {
  signerByRuntime.set(runtimeId.toLowerCase(), { seed, signerId });
  const timestamp = Date.now();
  const nonce = challenge ?? `nonce-${runtimeId.slice(-6)}-${timestamp}`;
  const encryptionPubKey = pubKeyToHex(deriveEncryptionKeyPair(seed).publicKey);
  const digest = hashHelloMessage(runtimeId, encryptionPubKey, timestamp, nonce, audience);
  const signature = signDigest(seed, signerId, digest);
  return {
    type: 'hello',
    from: runtimeId,
    fromEncryptionPubKey: encryptionPubKey,
    timestamp,
    ...(audience ? { audience } : {}),
    auth: { nonce, signature, timestamp },
  };
};

const signerByRuntime = new Map<string, { seed: string; signerId: string }>();
const socketChallenge = new Map<object, { challenge: string; audience: string }>();
let testAuthClock = 0;
const nextTestAuthTimestamp = (): number => {
  testAuthClock = Math.max(Date.now(), testAuthClock + 1);
  return testAuthClock;
};

afterEach(() => {
  signerByRuntime.clear();
  socketChallenge.clear();
});

const createDirectRuntimeWsRoute = (
  options: Parameters<typeof createProductionDirectRuntimeWsRoute>[0],
): ReturnType<typeof createProductionDirectRuntimeWsRoute> => {
  const route = createProductionDirectRuntimeWsRoute(options);
  const sessions = new Map<object, { challenge: string; audience: string }>();
  const productionMessage = route.websocket.message;
  return {
    ...route,
    websocket: {
      ...route.websocket,
      async message(ws, raw) {
        let message: RuntimeWsMessage;
        try {
          message = deserializeWsMessage(raw);
        } catch {
          await productionMessage(ws, raw);
          return;
        }
        const identity = message.from ? signerByRuntime.get(message.from.toLowerCase()) : undefined;
        if (message.type === 'hello' && identity) {
          const binding = socketChallenge.get(ws);
          if (!binding) throw new Error('TEST_DIRECT_CHALLENGE_MISSING');
          const timestamp = nextTestAuthTimestamp();
          message = {
            ...message,
            timestamp,
            audience: binding.audience,
            auth: {
              nonce: binding.challenge,
              timestamp,
              signature: signDigest(
                identity.seed,
                identity.signerId,
                hashHelloMessage(
                  message.from!,
                  message.fromEncryptionPubKey!,
                  timestamp,
                  binding.challenge,
                  binding.audience,
                ),
              ),
            },
          };
          sessions.set(ws, binding);
        } else if (identity) {
          const binding = sessions.get(ws);
          if (binding) {
            const timestamp = nextTestAuthTimestamp();
            message = {
              ...message,
              auth: {
                nonce: binding.challenge,
                timestamp,
                signature: signDigest(
                  identity.seed,
                  identity.signerId,
                  hashRuntimeWsFrame(message, binding.audience, binding.challenge, timestamp),
                ),
              },
            };
          }
        }
        await productionMessage(ws, serializeWsMessage(message));
      },
    },
  };
};

const makeFakeWs = () => {
  const sent: RuntimeWsMessage[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  const ws = {
    readyState: 1,
    send(raw: string | Uint8Array) {
      const message = deserializeWsMessage(raw);
      if (message.type === 'hello_challenge') {
        socketChallenge.set(this, { challenge: message.challenge!, audience: message.audience! });
      } else {
        sent.push(message);
      }
      return true;
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
      this.readyState = 3;
    },
  };
  return { ws, sent, closed };
};

const signSessionFrame = (
  seed: string,
  runtimeId: string,
  audience: string,
  nonce: string,
  timestamp: number,
): { message: RuntimeWsMessage; auth: NonNullable<RuntimeWsMessage['auth']> } => {
  const message: RuntimeWsMessage = {
    type: 'ping',
    id: `frame-${timestamp}`,
    from: runtimeId,
    fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(seed).publicKey),
  };
  return {
    message,
    auth: {
      nonce,
      timestamp,
      signature: signDigest(seed, '1', hashRuntimeWsFrame(message, audience, nonce, timestamp)),
    },
  };
};

describe('websocket session replay fence', () => {
  test('keeps wall-clock freshness on hello only', () => {
    const seed = 'stale-hello-peer';
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const encryptionPubKey = pubKeyToHex(deriveEncryptionKeyPair(seed).publicKey);
    const audience = 'xln-relay:test';
    const nonce = 'stale-hello-challenge';
    const timestamp = Date.now() - 5 * 60 * 1000 - 1;
    const signature = signDigest(
      seed,
      '1',
      hashHelloMessage(runtimeId, encryptionPubKey, timestamp, nonce, audience),
    );

    expect(verifyHelloAuth(runtimeId, encryptionPubKey, { nonce, timestamp, signature }, 5 * 60 * 1000, audience))
      .toContain('Hello timestamp skew too large');
  });

  test('accepts a far-future signed session counter once and rejects its replay', () => {
    const seed = 'future-session-peer';
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const audience = 'xln-relay:test';
    const nonce = 'future-session-challenge';
    const timestamp = Date.now() + 24 * 60 * 60 * 1000;
    const { message, auth } = signSessionFrame(seed, runtimeId, audience, nonce, timestamp);

    expect(verifyRuntimeWsFrameAuth(runtimeId, message, auth, audience, nonce, 0)).toBeNull();
    expect(verifyRuntimeWsFrameAuth(runtimeId, message, auth, audience, nonce, timestamp))
      .toBe('Session frame replay or reordering');
  });

  test('keeps signed counters isolated between sessions', () => {
    const seed = 'isolated-session-peer';
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const audience = 'xln-relay:test';
    const flooded = signSessionFrame(seed, runtimeId, audience, 'session-a', 1_000_000);
    const fresh = signSessionFrame(seed, runtimeId, audience, 'session-b', 1);

    expect(verifyRuntimeWsFrameAuth(runtimeId, flooded.message, flooded.auth, audience, 'session-a', 999_999))
      .toBeNull();
    expect(verifyRuntimeWsFrameAuth(runtimeId, fresh.message, fresh.auth, audience, 'session-b', 0))
      .toBeNull();
    expect(verifyRuntimeWsFrameAuth(runtimeId, fresh.message, fresh.auth, audience, 'session-a', 0))
      .toBe('Missing or invalid session frame auth');
  });
});

describe('direct runtime websocket route', () => {
  test('marks a successful websocket upgrade handled so HTTP dispatch cannot fall through', () => {
    const route = createProductionDirectRuntimeWsRoute({
      runtimeId: deriveSignerAddressSync('direct-upgrade-server', '1').toLowerCase(),
      runtimeSeed: 'direct-upgrade-server',
      onEntityInputs: () => undefined,
    });
    const upgradedRequests: Request[] = [];
    const server = {
      upgrade(request: Request) {
        upgradedRequests.push(request);
        return true;
      },
    };

    const decision = route.maybeUpgrade(
      new Request('http://127.0.0.1/ws', { headers: { upgrade: 'websocket' } }),
      server,
    );

    expect(decision).toEqual({ handled: true });
    expect(upgradedRequests).toHaveLength(1);
  });

  test('challenge binds authenticated hello to this socket and encryption key', async () => {
    const serverSeed = 'direct-challenge-server';
    const clientSeed = 'direct-challenge-client';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const route = createProductionDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: () => {},
    });

    const forged = makeFakeWs();
    route.websocket.open(forged.ws);
    const forgedBinding = socketChallenge.get(forged.ws)!;
    const forgedChallenge = forgedBinding.challenge;
    const forgedAudience = forgedBinding.audience;
    const signed = makeAuthedHello(clientSeed, clientRuntimeId, '1', forgedChallenge, forgedAudience);
    await route.websocket.message(forged.ws, serializeWsMessage({
      ...signed,
      fromEncryptionPubKey: `0x${'99'.repeat(32)}`,
    }));
    expect(forged.sent.at(-1)?.error).toContain('signature does not match runtimeId');

    const accepted = makeFakeWs();
    route.websocket.open(accepted.ws);
    const acceptedBinding = socketChallenge.get(accepted.ws)!;
    const acceptedChallenge = acceptedBinding.challenge;
    const acceptedAudience = acceptedBinding.audience;
    const acceptedHello = makeAuthedHello(clientSeed, clientRuntimeId, '1', acceptedChallenge, acceptedAudience);
    await route.websocket.message(accepted.ws, serializeWsMessage(acceptedHello));
    expect(accepted.sent.at(-1)).toMatchObject({
      type: 'hello_ack',
      from: serverRuntimeId,
      to: clientRuntimeId,
      auth: expect.objectContaining({ nonce: acceptedChallenge }),
    });
    route.websocket.close(accepted.ws);

    const replayed = makeFakeWs();
    route.websocket.open(replayed.ws);
    await route.websocket.message(replayed.ws, serializeWsMessage(acceptedHello));
    expect(replayed.sent.at(-1)?.error).toContain('challenge missing, expired, or already consumed');
  });

  test('uses MessagePack on the wire and tagged JSON only for debug', () => {
    const message: RuntimeWsMessage = {
      type: 'debug_event',
      payload: { amount: 7n, values: new Map([['token', 1]]) },
    };
    const binary = serializeWsMessage(message);

    expect(binary).toBeInstanceOf(Uint8Array);
    expect(binary[0]).toBe(0x01);
    expect(deserializeWsMessage(binary)).toEqual(message);
    expect(serializeWsMessageForDebug(message)).toContain('debug_event');
    expect(() => deserializeWsMessage(serializeWsMessageForDebug(message))).toThrow('WS_WIRE_BINARY_REQUIRED');
  });

  test('rejects oversized UTF-8 routing metadata before relay telemetry', () => {
    const oversizedFrom = 'é'.repeat(65);
    const encoded = encodeBinaryPayload({
      v: XLN_PROTOCOL_VERSION,
      type: 'ping',
      from: oversizedFrom,
    });

    expect(() => deserializeWsMessage(encoded)).toThrow(
      'WS_MESSAGE_FIELD_TOO_LONG:field=from:bytes=130:max=128',
    );
    expect(() => serializeWsMessage({
      type: 'error',
      error: 'x'.repeat(4 * 1024 + 1),
    })).toThrow('WS_MESSAGE_FIELD_TOO_LONG:field=error');
    expect(() => serializeWsMessage({
      type: 'hello',
      from: '0x1234',
      fromEncryptionPubKey: '0xabcd',
      timestamp: 1,
      auth: { nonce: 'n', signature: 's'.repeat(257), timestamp: 1 },
    })).toThrow('WS_MESSAGE_FIELD_TOO_LONG:field=signature:bytes=257:max=256');
  });

  test('accepts a peer debug event without creating a second protocol error', async () => {
    const serverSeed = 'direct-debug-server';
    const clientSeed = 'direct-debug-client';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const received: unknown[] = [];
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: (_from, envelope) => {
        received.push(envelope);
      },
    });
    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    expect(sent.at(-1)?.type).toBe('hello_ack');

    const sentBeforeDebug = sent.length;
    await route.websocket.message(ws, serializeWsMessage({
      type: 'debug_event',
      id: 'client-debug',
      from: clientRuntimeId,
      fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(clientSeed).publicKey),
      to: serverRuntimeId,
      payload: { level: 'info', code: 'RECEIPT_DEFERRED' },
    }));

    expect(sent).toHaveLength(sentBeforeDebug);
  });

  test('routes encrypted entity input back through a live direct socket', async () => {
    const serverSeed = 'direct-route-server';
    const clientSeed = 'direct-route-client';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const received: Array<{ from: string; envelope: RuntimeEntityInputsEnvelope; timestamp?: number }> = [];

    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: (from, envelope, timestamp) => {
        received.push({ from, envelope, timestamp });
      },
    });

    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));

    expect(sent[0]?.type).toBe('hello_ack');
    expect(sent[0]?.from).toBe(serverRuntimeId);
    expect(sent[0]?.to).toBe(clientRuntimeId);
    expect(route.getSessionState()).toEqual([
      expect.objectContaining({ runtimeId: clientRuntimeId, open: true }),
    ]);

    const outboundInput: RoutedEntityInput = {
      entityId: `0x${'11'.repeat(32)}`,
      runtimeId: clientRuntimeId,
      signerId: clientRuntimeId,
      entityTxs: [],
    };
    const outboundEnvelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId: serverRuntimeId,
      sourceSignature: `0x${'11'.repeat(65)}`,
      sourceRuntimeHeight: 7,
      sourceRuntimeTimestamp: 123,
      entityInputs: [outboundInput as RuntimeEntityInputsEnvelope['entityInputs'][number]],
    };
    expect(route.sendEntityInputsDelivery(clientRuntimeId, outboundEnvelope, 123)).toMatchObject({
      outcome: 'delivered',
      code: 'ROUTE_DIRECT_DELIVERED',
      retryable: false,
      fatal: false,
      terminal: true,
    });

    const outbound = sent[1];
    expect(outbound?.type).toBe('entity_inputs');
    expect(outbound?.from).toBe(serverRuntimeId);
    expect(outbound?.to).toBe(clientRuntimeId);
    expect(outbound?.encrypted).toBe(true);
    const decryptedOutbound = decryptJSON<RuntimeEntityInputsEnvelope>(
      String(outbound?.payload || ''),
      deriveEncryptionKeyPair(clientSeed).privateKey,
    );
    expect(decryptedOutbound).toEqual(outboundEnvelope);

    const inboundInput: RoutedEntityInput = {
      entityId: `0x${'22'.repeat(32)}`,
      runtimeId: serverRuntimeId,
      signerId: serverRuntimeId,
      entityTxs: [],
    };
    const inboundEnvelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId: clientRuntimeId,
      sourceSignature: `0x${'11'.repeat(65)}`,
      sourceRuntimeHeight: 9,
      sourceRuntimeTimestamp: 456,
      entityInputs: [inboundInput as RuntimeEntityInputsEnvelope['entityInputs'][number]],
    };
    await route.websocket.message(ws, serializeWsMessage({
      type: 'entity_inputs',
      id: 'client-to-server',
      from: clientRuntimeId,
      fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(clientSeed).publicKey),
      to: serverRuntimeId,
      timestamp: 456,
      encrypted: true,
      payload: encryptJSON(inboundEnvelope, deriveEncryptionKeyPair(serverSeed).publicKey),
    }));

    expect(received).toEqual([
      {
        from: clientRuntimeId,
        envelope: inboundEnvelope,
        timestamp: 456,
      },
    ]);
  });

  test('rejects unencrypted entity inputs on a direct socket', async () => {
    const serverSeed = 'direct-route-server-plaintext';
    const clientSeed = 'direct-route-client-plaintext';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const received: Array<{ from: string; envelope: RuntimeEntityInputsEnvelope; timestamp?: number }> = [];

    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: (from, envelope, timestamp) => {
        received.push({ from, envelope, timestamp });
      },
    });

    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    await route.websocket.message(ws, encodeBinaryPayload({
      v: 1,
      type: 'entity_inputs',
      id: 'client-to-server-plaintext',
      from: clientRuntimeId,
      fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(clientSeed).publicKey),
      to: serverRuntimeId,
      timestamp: 456,
      encrypted: false,
      payload: {
        sourceRuntimeId: clientRuntimeId,
        sourceSignature: `0x${'11'.repeat(65)}`,
        sourceRuntimeHeight: 9,
        sourceRuntimeTimestamp: 456,
        entityInputs: [{
          entityId: `0x${'22'.repeat(32)}`,
          runtimeId: serverRuntimeId,
          signerId: serverRuntimeId,
          entityTxs: [],
        }],
      },
    }, 'msgpack'));

    expect(sent.at(-1)).toMatchObject({
      type: 'error',
      error: 'Invalid wire message: WS_MESSAGE_ENTITY_INPUTS_ENCRYPTION_INVALID',
    });
    expect(received).toEqual([]);
  });

  test('rejects malformed decrypted envelopes before the Runtime callback', async () => {
    const serverSeed = 'direct-route-server-malformed-envelope';
    const clientSeed = 'direct-route-client-malformed-envelope';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    let received = 0;
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: () => {
        received += 1;
      },
    });
    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));

    await route.websocket.message(ws, serializeWsMessage({
      type: 'entity_inputs',
      id: 'malformed-encrypted-envelope',
      from: clientRuntimeId,
      fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(clientSeed).publicKey),
      to: serverRuntimeId,
      timestamp: 456,
      encrypted: true,
      payload: encryptJSON({
        sourceRuntimeId: clientRuntimeId,
        sourceSignature: `0x${'11'.repeat(65)}`,
        sourceRuntimeHeight: -1,
        sourceRuntimeTimestamp: 456,
        entityInputs: [],
      }, deriveEncryptionKeyPair(serverSeed).publicKey),
    }));

    expect(sent.at(-1)).toMatchObject({
      type: 'error',
      error: 'Direct delivery failed: P2P_ENTITY_INPUTS_ENVELOPE_EMPTY',
    });
    expect(received).toBe(0);
  });

  test('answers read-only recovery bundle requests over the authenticated direct socket', async () => {
    const serverSeed = 'direct-route-server-recovery';
    const clientSeed = 'direct-route-client-recovery';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const requests: Array<{ from: string; lookupKey: string }> = [];

    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onRecoveryBundleRequest: (from, lookupKey) => {
        requests.push({ from, lookupKey });
        return {
          ok: true,
          runtimeId: serverRuntimeId,
          lookupKey,
          bundle: { lookupKey, encryptedBundle: 'ciphertext' },
          bundles: [{ lookupKey, encryptedBundle: 'ciphertext' }],
        };
      },
      onEntityInputs: () => {},
    });

    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    await route.websocket.message(ws, serializeWsMessage({
      type: 'recovery_bundle_request',
      id: 'recovery-request-1',
      from: clientRuntimeId,
      fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(clientSeed).publicKey),
      to: serverRuntimeId,
      payload: { lookupKey: 'lookup/key' },
    }));

    expect(requests).toEqual([{ from: clientRuntimeId, lookupKey: 'lookup/key' }]);
    expect(sent.at(-1)).toMatchObject({
      type: 'recovery_bundle_response',
      inReplyTo: 'recovery-request-1',
      from: serverRuntimeId,
      to: clientRuntimeId,
      payload: {
        ok: true,
        runtimeId: serverRuntimeId,
        lookupKey: 'lookup/key',
      },
    });
  });

  test('rejects malformed recovery bundle requests without calling the resolver', async () => {
    const serverSeed = 'direct-route-server-recovery-bad';
    const clientSeed = 'direct-route-client-recovery-bad';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    let calls = 0;

    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onRecoveryBundleRequest: () => {
        calls += 1;
        return {};
      },
      onEntityInputs: () => {},
    });

    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    await route.websocket.message(ws, serializeWsMessage({
      type: 'recovery_bundle_request',
      id: 'recovery-request-empty',
      from: clientRuntimeId,
      fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(clientSeed).publicKey),
      to: serverRuntimeId,
      payload: {},
    }));

    expect(calls).toBe(0);
    expect(sent.at(-1)).toMatchObject({
      type: 'recovery_bundle_response',
      inReplyTo: 'recovery-request-empty',
      from: serverRuntimeId,
      to: clientRuntimeId,
      error: 'Recovery lookupKey is required',
    });
  });

  test('rejects same-runtime direct websocket peers', async () => {
    const serverSeed = 'direct-route-server-same-runtime';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const received: unknown[] = [];
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: (_from, envelope) => {
        received.push(envelope);
      },
    });

    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(serverSeed, serverRuntimeId)));

    expect(ws.readyState).toBe(3);
    expect(sent.at(-1)).toMatchObject({
      type: 'error',
      error: 'Direct runtime websocket only accepts inter-runtime peers',
    });
    expect(received).toEqual([]);
    expect(route.getSessionState()).toEqual([]);
  });

  test('a fresh authenticated hello atomically replaces a stale direct socket', async () => {
    const serverSeed = 'direct-route-server-duplicate';
    const clientSeed = 'direct-route-client-duplicate';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const received: unknown[] = [];
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: (_from, envelope) => {
        received.push(envelope);
      },
    });

    const first = makeFakeWs();
    const second = makeFakeWs();
    route.websocket.open(first.ws);
    route.websocket.open(second.ws);

    await route.websocket.message(first.ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    await route.websocket.message(second.ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));

    expect(first.ws.readyState).toBe(3);
    expect(second.ws.readyState).toBe(1);
    expect(first.closed.at(-1)).toEqual({ code: 4009, reason: 'session-replaced' });
    expect(second.sent.at(-1)?.type).toBe('hello_ack');
    expect(route.getSessionState()).toEqual([
      expect.objectContaining({ runtimeId: clientRuntimeId, open: true }),
    ]);

    const outboundInput: RoutedEntityInput = {
      entityId: `0x${'33'.repeat(32)}`,
      runtimeId: clientRuntimeId,
      signerId: clientRuntimeId,
      entityTxs: [],
    };
    expect(route.sendEntityInputsDelivery(clientRuntimeId, {
      sourceRuntimeId: serverRuntimeId,
      sourceSignature: `0x${'11'.repeat(65)}`,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [outboundInput as RuntimeEntityInputsEnvelope['entityInputs'][number]],
    })).toMatchObject({
      outcome: 'delivered',
      code: 'ROUTE_DIRECT_DELIVERED',
    });
    expect(second.sent.at(-1)?.type).toBe('entity_inputs');
    const firstSentCount = first.sent.length;
    first.ws.readyState = 1;
    await route.websocket.message(first.ws, 'late-frame-from-replaced-socket');
    expect(first.sent).toHaveLength(firstSentCount);
    expect(received).toEqual([]);
  });

  test('reports typed miss delivery when target direct socket is absent', () => {
    const serverSeed = 'direct-route-server-miss';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const targetRuntimeId = deriveSignerAddressSync('direct-route-missing-client', '1').toLowerCase();
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: () => undefined,
    });
    const outboundInput: RoutedEntityInput = {
      entityId: `0x${'44'.repeat(32)}`,
      runtimeId: targetRuntimeId,
      signerId: targetRuntimeId,
      entityTxs: [],
    };

    expect(route.sendEntityInputsDelivery(targetRuntimeId, {
      sourceRuntimeId: serverRuntimeId,
      sourceSignature: `0x${'11'.repeat(65)}`,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [outboundInput as RuntimeEntityInputsEnvelope['entityInputs'][number]],
    })).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_MISS_FAILOVER',
      retryable: true,
      fatal: false,
      terminal: false,
    });
  });

  test('defers on Bun backpressure/ambiguous-zero sends but keeps a still-open socket', async () => {
    const serverSeed = 'direct-route-server-send-contract';
    const clientSeed = 'direct-route-client-send-contract';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: () => undefined,
    });
    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    const envelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId: serverRuntimeId,
      sourceSignature: `0x${'11'.repeat(65)}`,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [{
        entityId: `0x${'46'.repeat(32)}`,
        runtimeId: clientRuntimeId,
        signerId: clientRuntimeId,
        entityTxs: [],
      }],
    };

    // -1 means Bun only queued the write against its own backpressure limit; it did
    // NOT confirm the bytes reached the peer. Treating that as delivered stranded a
    // resent accountInput forever at 1000-user scale: the entity-output router's P2P
    // failover only fires when direct reports non-delivered, so a -1 that never
    // actually flushes must still be retryable, not a terminal success. The socket
    // itself must still survive (asserted below) since readyState reads OPEN.
    ws.send = (raw) => {
      sent.push(deserializeWsMessage(raw));
      return -1;
    };
    expect(route.sendEntityInputsDelivery(clientRuntimeId, envelope)).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_SEND_FAILED',
      retryable: true,
      terminal: false,
    });
    expect(route.getSessionState()).toEqual([
      expect.objectContaining({ runtimeId: clientRuntimeId, open: true }),
    ]);

    ws.send = (raw) => {
      sent.push(deserializeWsMessage(raw));
      return -2;
    };
    expect(() => route.sendEntityInputsDelivery(clientRuntimeId, envelope)).toThrow(
      'WEBSOCKET_SEND_RESULT_INVALID',
    );
    expect(route.getSessionState()).toEqual([
      expect.objectContaining({ runtimeId: clientRuntimeId, open: true }),
    ]);

    // Bun reports 0 both for a truly dead peer and for a transient
    // backpressure/queue-full drop on an otherwise healthy socket. Since
    // readyState still reads OPEN here, the session must survive so the
    // client's next authenticated frame on this same socket is not bounced.
    ws.send = (raw) => {
      sent.push(deserializeWsMessage(raw));
      return 0;
    };
    expect(route.sendEntityInputsDelivery(clientRuntimeId, envelope)).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_SEND_FAILED',
      retryable: true,
      terminal: false,
    });
    expect(route.getSessionState()).toEqual([
      expect.objectContaining({ runtimeId: clientRuntimeId, open: true }),
    ]);

    // Once the transport itself confirms the socket is gone, a dropped send
    // still forgets the session as before.
    ws.readyState = 3;
    ws.send = (raw) => {
      sent.push(deserializeWsMessage(raw));
      return 0;
    };
    expect(route.sendEntityInputsDelivery(clientRuntimeId, envelope)).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_MISS_FAILOVER',
      retryable: true,
      terminal: false,
    });
    expect(route.getSessionState()).toEqual([]);
  });

  test('a transient zero-byte send does not forget a still-open session', async () => {
    // Bun's ServerWebSocket.send() returns 0 both when the connection is
    // truly gone AND when an otherwise-healthy socket hits a transient
    // backpressure/queue-full condition (github.com/oven-sh/bun#9368).
    // Forgetting the session unconditionally on `0` orphans a live client:
    // its very next authenticated frame arrives on the same still-open
    // socket, finds no session, and gets bounced as "Handshake required"
    // even though the client never saw a close/error and never re-sent hello.
    const serverSeed = 'direct-route-server-transient-drop';
    const clientSeed = 'direct-route-client-transient-drop';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const received: unknown[] = [];
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: (_from, envelope) => {
        received.push(envelope);
      },
    });
    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    expect(sent.at(-1)?.type).toBe('hello_ack');

    // The socket stays fully open (readyState untouched); only this one
    // send reports the ambiguous "dropped" result.
    ws.send = () => 0;
    expect(route.sendEntityInputsDelivery(clientRuntimeId, {
      sourceRuntimeId: serverRuntimeId,
      sourceSignature: `0x${'11'.repeat(65)}`,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [],
    })).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_SEND_FAILED',
      retryable: true,
      terminal: false,
    });
    expect(ws.readyState).toBe(1);
    expect(route.getSessionState()).toEqual([
      expect.objectContaining({ runtimeId: clientRuntimeId, open: true }),
    ]);

    // Restore real sending and prove the still-authenticated socket accepts
    // the client's next entity_inputs frame without re-sending hello.
    ws.send = (raw: string | Uint8Array) => {
      const message = deserializeWsMessage(raw);
      sent.push(message);
      return true;
    };
    const inboundEnvelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId: clientRuntimeId,
      sourceSignature: `0x${'11'.repeat(65)}`,
      sourceRuntimeHeight: 2,
      sourceRuntimeTimestamp: 2,
      entityInputs: [{
        entityId: `0x${'22'.repeat(32)}`,
        runtimeId: serverRuntimeId,
        signerId: serverRuntimeId,
        entityTxs: [],
      } as unknown as RuntimeEntityInputsEnvelope['entityInputs'][number]],
    };
    await route.websocket.message(ws, serializeWsMessage({
      type: 'entity_inputs',
      id: 'client-after-transient-drop',
      from: clientRuntimeId,
      fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(clientSeed).publicKey),
      to: serverRuntimeId,
      timestamp: 2,
      encrypted: true,
      payload: encryptJSON(inboundEnvelope, deriveEncryptionKeyPair(serverSeed).publicKey),
    }));

    expect(sent.at(-1)?.type).not.toBe('error');
    expect(received).toEqual([inboundEnvelope]);
  });

  test('force-closes a session after 4 consecutive failed-while-open sends', async () => {
    // A correctly-classified retry (see the two tests above) still does
    // nothing if it keeps landing on the SAME wedged pipe (oven-sh/bun#9368:
    // a socket that reports failed writes indefinitely while readyState
    // keeps reading OPEN). After STUCK_SEND_THRESHOLD consecutive
    // failed-while-open sends to one session, the route must force-close it
    // so the peer's own reconnect logic re-establishes a fresh socket.
    const serverSeed = 'direct-route-server-stuck-backpressure';
    const clientSeed = 'direct-route-client-stuck-backpressure';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: () => undefined,
    });
    const { ws, sent, closed } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    const envelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId: serverRuntimeId,
      sourceSignature: `0x${'11'.repeat(65)}`,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [],
    };
    ws.send = (raw) => {
      sent.push(deserializeWsMessage(raw));
      return -1; // Bun backpressure: always classified as failed-while-open.
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(route.sendEntityInputsDelivery(clientRuntimeId, envelope)).toMatchObject({
        outcome: 'deferred',
        code: 'ROUTE_DIRECT_SEND_FAILED',
      });
      expect(closed).toEqual([]);
      expect(route.getSessionState()).toEqual([
        expect.objectContaining({ runtimeId: clientRuntimeId, open: true }),
      ]);
    }

    // 4th consecutive failure trips the watchdog.
    expect(route.sendEntityInputsDelivery(clientRuntimeId, envelope)).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_SEND_FAILED',
    });
    expect(closed).toEqual([{ code: 4010, reason: 'stuck-backpressure' }]);
    expect(route.getSessionState()).toEqual([]);
  });

  test('an accepted send resets the failed-while-open streak', async () => {
    const serverSeed = 'direct-route-server-streak-reset';
    const clientSeed = 'direct-route-client-streak-reset';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: () => undefined,
    });
    const { ws, sent, closed } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    const envelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId: serverRuntimeId,
      sourceSignature: `0x${'11'.repeat(65)}`,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [],
    };

    // 3 failures, then a genuine success, then 3 more failures: the streak
    // must never accumulate across the successful send.
    ws.send = (raw) => {
      sent.push(deserializeWsMessage(raw));
      return -1;
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      route.sendEntityInputsDelivery(clientRuntimeId, envelope);
    }
    ws.send = (raw) => {
      sent.push(deserializeWsMessage(raw));
      return 1;
    };
    expect(route.sendEntityInputsDelivery(clientRuntimeId, envelope)).toMatchObject({
      outcome: 'delivered',
    });
    ws.send = (raw) => {
      sent.push(deserializeWsMessage(raw));
      return -1;
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      route.sendEntityInputsDelivery(clientRuntimeId, envelope);
    }
    expect(closed).toEqual([]);
    expect(route.getSessionState()).toEqual([
      expect.objectContaining({ runtimeId: clientRuntimeId, open: true }),
    ]);
  });

  test('preserves direct socket root errors in a retryable structured delivery result', async () => {
    const serverSeed = 'direct-route-server-send-error';
    const clientSeed = 'direct-route-client-send-error';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: () => undefined,
    });
    const { ws } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    ws.send = () => {
      throw new Error('socket write exploded');
    };

    const delivery = route.sendEntityInputsDelivery(clientRuntimeId, {
      sourceRuntimeId: serverRuntimeId,
      sourceSignature: `0x${'11'.repeat(65)}`,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [{
        entityId: `0x${'45'.repeat(32)}`,
        runtimeId: clientRuntimeId,
        signerId: clientRuntimeId,
        entityTxs: [],
      }],
    });

    expect(delivery).toMatchObject({
      outcome: 'failed',
      code: 'ROUTE_DIRECT_SEND_FAILED',
      retryable: true,
      fatal: false,
      terminal: false,
      failure: {
        category: 'TransientRace',
        message: 'socket write exploded',
      },
    });
  });
});
