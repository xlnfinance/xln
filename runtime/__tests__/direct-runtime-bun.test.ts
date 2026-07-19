import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync, signDigest } from '../account/crypto';
import { createDirectRuntimeWsRoute } from '../networking/direct-runtime-bun';
import { decryptJSON, deriveEncryptionKeyPair, encryptJSON, pubKeyToHex } from '../networking/p2p-crypto';
import { hashHelloMessage, serializeWsMessage, deserializeWsMessage, serializeWsMessageForDebug, type RuntimeWsMessage } from '../networking/ws-protocol';
import { encodeBinaryPayload } from '../storage/binary-codec';
import type { ReliableDeliveryReceipt, RoutedEntityInput, RuntimeEntityInputsEnvelope } from '../types';

const makeAuthedHello = (
  seed: string,
  runtimeId: string,
  signerId = '1',
  challenge?: string,
): RuntimeWsMessage => {
  const timestamp = Date.now();
  const nonce = challenge ?? `nonce-${runtimeId.slice(-6)}-${timestamp}`;
  const encryptionPubKey = pubKeyToHex(deriveEncryptionKeyPair(seed).publicKey);
  const digest = hashHelloMessage(runtimeId, encryptionPubKey, timestamp, nonce);
  const signature = signDigest(seed, signerId, digest);
  return {
    type: 'hello',
    from: runtimeId,
    fromEncryptionPubKey: encryptionPubKey,
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
  test('marks a successful websocket upgrade handled so HTTP dispatch cannot fall through', () => {
    const route = createDirectRuntimeWsRoute({
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
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      onEntityInputs: () => {},
    });

    const forged = makeFakeWs();
    route.websocket.open(forged.ws);
    const forgedChallenge = forged.sent[0]?.challenge;
    const signed = makeAuthedHello(clientSeed, clientRuntimeId, '1', forgedChallenge);
    await route.websocket.message(forged.ws, serializeWsMessage({
      ...signed,
      fromEncryptionPubKey: `0x${'99'.repeat(32)}`,
    }));
    expect(forged.sent.at(-1)?.error).toContain('signature does not match runtimeId');

    const accepted = makeFakeWs();
    route.websocket.open(accepted.ws);
    const acceptedChallenge = accepted.sent[0]?.challenge;
    const acceptedHello = makeAuthedHello(clientSeed, clientRuntimeId, '1', acceptedChallenge);
    await route.websocket.message(accepted.ws, serializeWsMessage(acceptedHello));
    expect(accepted.sent.at(-1)).toMatchObject({
      type: 'hello_ack',
      from: serverRuntimeId,
      to: clientRuntimeId,
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

  test('accepts a peer debug event without creating a second protocol error', async () => {
    const serverSeed = 'direct-debug-server';
    const clientSeed = 'direct-debug-client';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      requireHelloAuth: false,
      onEntityInputs: () => {},
    });
    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));
    expect(sent.at(-1)?.type).toBe('hello_ack');

    const sentBeforeDebug = sent.length;
    await route.websocket.message(ws, serializeWsMessage({
      type: 'debug_event',
      from: clientRuntimeId,
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
      requireHelloAuth: false,
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

  test('routes signed application receipts in both direct websocket directions', async () => {
    const serverSeed = 'direct-receipt-server';
    const clientSeed = 'direct-receipt-client';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const received: Array<{ from: string; receipt: ReliableDeliveryReceipt }> = [];
    const receiptFor = (receiverRuntimeId: string): ReliableDeliveryReceipt => ({
      body: {
        version: 1,
        receiverRuntimeId,
        identity: {
          kind: 'entity-frame',
          entityId: `0x${'31'.repeat(32)}`,
          signerId: clientRuntimeId,
          laneKey: 'lane',
          height: 3,
          frameHash: `0x${'32'.repeat(32)}`,
          logicalKey: 'logical',
        },
        appliedRuntimeHeight: 8,
      },
      signature: `0x${'33'.repeat(65)}`,
    });
    const outboundReceipt = receiptFor(serverRuntimeId);
    const inboundReceipt = receiptFor(clientRuntimeId);
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      requireHelloAuth: false,
      onEntityInputs: () => {},
      onReliableReceipt: (from, inboundReceipt) => {
        received.push({ from, receipt: inboundReceipt });
      },
    });
    const { ws, sent } = makeFakeWs();
    route.websocket.open(ws);
    await route.websocket.message(ws, serializeWsMessage(makeAuthedHello(clientSeed, clientRuntimeId)));

    expect(route.sendReliableReceiptDelivery(clientRuntimeId, outboundReceipt)).toMatchObject({
      outcome: 'delivered',
      code: 'ROUTE_DIRECT_RECEIPT_DELIVERED',
    });
    expect(sent.at(-1)).toMatchObject({
      type: 'entity_input_receipt',
      from: serverRuntimeId,
      to: clientRuntimeId,
      payload: outboundReceipt,
    });

    await route.websocket.message(ws, encodeBinaryPayload({
      v: 1,
      type: 'entity_input_receipt',
      from: clientRuntimeId,
      to: serverRuntimeId,
      payload: inboundReceipt,
    }, 'msgpack'));
    expect(received).toEqual([{ from: clientRuntimeId, receipt: inboundReceipt }]);
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
      requireHelloAuth: false,
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
      requireHelloAuth: false,
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

  test('rejects duplicate runtime hello without displacing the live socket', async () => {
    const serverSeed = 'direct-route-server-duplicate';
    const clientSeed = 'direct-route-client-duplicate';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      requireHelloAuth: false,
      onEntityInputs: () => {},
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
    expect(route.sendEntityInputsDelivery(clientRuntimeId, {
      sourceRuntimeId: serverRuntimeId,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [outboundInput as RuntimeEntityInputsEnvelope['entityInputs'][number]],
    })).toMatchObject({
      outcome: 'delivered',
      code: 'ROUTE_DIRECT_DELIVERED',
    });
    expect(first.sent.at(-1)?.type).toBe('entity_inputs');
    expect(second.sent).toEqual([]);
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
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [outboundInput as RuntimeEntityInputsEnvelope['entityInputs'][number]],
    })).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_MISS_FALLBACK',
      retryable: true,
      fatal: false,
      terminal: false,
    });
  });

  test('preserves direct socket root errors in a retryable structured delivery result', async () => {
    const serverSeed = 'direct-route-server-send-error';
    const clientSeed = 'direct-route-client-send-error';
    const serverRuntimeId = deriveSignerAddressSync(serverSeed, '1').toLowerCase();
    const clientRuntimeId = deriveSignerAddressSync(clientSeed, '1').toLowerCase();
    const route = createDirectRuntimeWsRoute({
      runtimeId: serverRuntimeId,
      runtimeSeed: serverSeed,
      requireHelloAuth: false,
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
