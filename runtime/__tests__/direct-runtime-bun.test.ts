import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync, signDigest } from '../account-crypto';
import { createDirectRuntimeWsRoute } from '../networking/direct-runtime-bun';
import { decryptJSON, deriveEncryptionKeyPair, encryptJSON, pubKeyToHex } from '../networking/p2p-crypto';
import { hashHelloMessage, serializeWsMessage, deserializeWsMessage, type RuntimeWsMessage } from '../networking/ws-protocol';
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
  const ws = {
    readyState: 1,
    send(raw: string) {
      sent.push(deserializeWsMessage(raw));
      return true;
    },
    close() {
      this.readyState = 3;
    },
  };
  return { ws, sent };
};

describe('direct runtime websocket route', () => {
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
    expect(route.sendEntityInput(clientRuntimeId, outboundInput, 123)).toBe(true);

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
});
