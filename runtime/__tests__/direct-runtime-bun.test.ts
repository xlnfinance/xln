import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync, signDigest } from '../account-crypto';
import { createDirectRuntimeWsRoute } from '../networking/direct-runtime-bun';
import { decryptJSON, deriveEncryptionKeyPair, encryptJSON, pubKeyToHex } from '../networking/p2p-crypto';
import { hashHelloMessage, serializeWsMessage, deserializeWsMessage, serializeWsMessageForDebug, type RuntimeWsMessage } from '../networking/ws-protocol';
import type { RoutedEntityInput } from '../types';

const makeAuthedHello = (seed: string, runtimeId: string, signerId = '1'): RuntimeWsMessage => {
  const timestamp = Date.now();
  const nonce = `nonce-${runtimeId.slice(-6)}-${timestamp}`;
  const digest = hashHelloMessage(runtimeId, timestamp, nonce);
  const signature = signDigest(seed, signerId, digest);
  return {
    type: 'hello',
    from: runtimeId,
    fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(seed).publicKey),
    timestamp,
    auth: { nonce, signature, timestamp },
  };
};

const makeFakeWs = () => {
  const sent: RuntimeWsMessage[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  const ws = {
    readyState: 1,
    send(raw: string | Uint8Array) {
      sent.push(deserializeWsMessage(raw));
      return true;
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
      this.readyState = 3;
    },
  };
  return { ws, sent, closed };
};

describe('direct runtime websocket route', () => {
  test('uses MessagePack on the wire and tagged JSON only for debug', () => {
    const message: RuntimeWsMessage = {
      type: 'debug_event',
      payload: { amount: 7n, values: new Map([['token', 1]]) },
    };
    const binary = serializeWsMessage(message);

    expect(binary).toBeInstanceOf(Uint8Array);
    expect(binary[0]).toBe(0x01);
    expect(deserializeWsMessage(binary)).toEqual(message);
    expect(deserializeWsMessage(serializeWsMessageForDebug(message))).toEqual(message);
  });

  test('routes encrypted entity input back through a live direct socket', async () => {
    const serverSeed = 'direct-route-server';
    const clientSeed = 'direct-route-client';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const received: Array<{ from: string; input: RoutedEntityInput; timestamp?: number }> = [];

    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      requireHelloAuth: false,
      onEntityInput: (from, input, timestamp) => {
        received.push({ from, input, timestamp });
      },
    });

    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));

    expect(sent[0]?.type).toBe('hello');
    expect(sent[0]?.from).toBe(serverRuntimeId);
    expect(route.getSessionState()).toEqual([
      expect.objectContaining({ runtimeId: clientRuntimeId, open: true }),
    ]);

    const outboundInput: RoutedEntityInput = {
      entityId: `0x${'11'.repeat(32)}`,
      runtimeId: clientRuntimeId,
      signerId: clientRuntimeId,
      entityTxs: [],
    };
    expect(route.sendEntityInputDelivery(clientRuntimeId, outboundInput, 123)).toMatchObject({
      outcome: 'delivered',
      code: 'ROUTE_DIRECT_DELIVERED',
      retryable: false,
      fatal: false,
      terminal: true,
    });

    const outbound = sent[1];
    expect(outbound?.type).toBe('entity_input');
    expect(outbound?.from).toBe(serverRuntimeId);
    expect(outbound?.to).toBe(clientRuntimeId);
    expect(outbound?.encrypted).toBe(true);
    const decryptedOutbound = decryptJSON<RoutedEntityInput>(
      String(outbound?.payload || ''),
      deriveEncryptionKeyPair(clientSeed).privateKey,
    );
    expect(decryptedOutbound.entityId).toBe(outboundInput.entityId);

    const inboundInput: RoutedEntityInput = {
      entityId: `0x${'22'.repeat(32)}`,
      runtimeId: serverRuntimeId,
      signerId: serverRuntimeId,
      entityTxs: [],
    };
    await route.websocket.message(ws, serializeWsMessage({
      type: 'entity_input',
      id: 'client-to-server',
      from: clientRuntimeId,
      fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(clientSeed).publicKey),
      to: serverRuntimeId,
      timestamp: 456,
      encrypted: true,
      payload: encryptJSON(inboundInput, deriveEncryptionKeyPair(serverSeed).publicKey),
    }));

    expect(received).toEqual([
      {
        from: clientRuntimeId,
        input: inboundInput,
        timestamp: 456,
      },
    ]);
  });

  test('rejects unencrypted entity input on a direct socket', async () => {
    const serverSeed = 'direct-route-server-plaintext';
    const clientSeed = 'direct-route-client-plaintext';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const received: Array<{ from: string; input: RoutedEntityInput; timestamp?: number }> = [];

    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      requireHelloAuth: false,
      onEntityInput: (from, input, timestamp) => {
        received.push({ from, input, timestamp });
      },
    });

    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    await route.websocket.message(ws, serializeWsMessage({
      type: 'entity_input',
      id: 'client-to-server-plaintext',
      from: clientRuntimeId,
      fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(clientSeed).publicKey),
      to: serverRuntimeId,
      timestamp: 456,
      encrypted: false,
      payload: {
        entityId: `0x${'22'.repeat(32)}`,
        runtimeId: serverRuntimeId,
        signerId: serverRuntimeId,
        entityTxs: [],
      },
    }));

    expect(sent.at(-1)).toMatchObject({
      type: 'error',
      error: 'Direct entity_input must be encrypted',
    });
    expect(received).toEqual([]);
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
      requireHelloAuth: false,
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
      onEntityInput: () => {},
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
      requireHelloAuth: false,
      onRecoveryBundleRequest: () => {
        calls += 1;
        return {};
      },
      onEntityInput: () => {},
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
    const received: RoutedEntityInput[] = [];
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInput: (_from, input) => {
        received.push(input);
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

  test('rejects duplicate runtime hello without displacing the live socket', async () => {
    const serverSeed = 'direct-route-server-duplicate';
    const clientSeed = 'direct-route-client-duplicate';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      requireHelloAuth: false,
      onEntityInput: () => {},
    });

    const first = makeFakeWs();
    const second = makeFakeWs();
    route.websocket.open(first.ws);
    route.websocket.open(second.ws);

    await route.websocket.message(first.ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    await route.websocket.message(second.ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));

    expect(first.ws.readyState).toBe(1);
    expect(second.ws.readyState).toBe(3);
    expect(second.closed.at(-1)).toEqual({ code: 4009, reason: 'duplicate-runtime' });
    expect(second.sent).toEqual([]);
    expect(route.getSessionState()).toEqual([
      expect.objectContaining({ runtimeId: clientRuntimeId, open: true }),
    ]);

    const outboundInput: RoutedEntityInput = {
      entityId: `0x${'33'.repeat(32)}`,
      runtimeId: clientRuntimeId,
      signerId: clientRuntimeId,
      entityTxs: [],
    };
    expect(route.sendEntityInputDelivery(clientRuntimeId, outboundInput)).toMatchObject({
      outcome: 'delivered',
      code: 'ROUTE_DIRECT_DELIVERED',
    });
    expect(first.sent.at(-1)?.type).toBe('entity_input');
    expect(second.sent).toEqual([]);
  });

  test('reports typed miss delivery when target direct socket is absent', () => {
    const serverSeed = 'direct-route-server-miss';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const targetRuntimeId = deriveSignerAddressSync('direct-route-missing-client', '1').toLowerCase();
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInput: () => undefined,
    });
    const outboundInput: RoutedEntityInput = {
      entityId: `0x${'44'.repeat(32)}`,
      runtimeId: targetRuntimeId,
      signerId: targetRuntimeId,
      entityTxs: [],
    };

    expect(route.sendEntityInputDelivery(targetRuntimeId, outboundInput)).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_MISS_FALLBACK',
      retryable: true,
      fatal: false,
      terminal: false,
    });
  });
});
