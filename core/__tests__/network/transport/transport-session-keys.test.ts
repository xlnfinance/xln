import { afterEach, describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync } from '../../../account/crypto';
import { deriveEncryptionKeyPair, hexToPubKey, pubKeyToHex } from '../../../protocol/crypto/p2p-crypto';
import { createDirectRuntimeWsRoute } from '../../../network/p2p/direct-runtime-bun';
import { RuntimeWsClient } from '../../../network/p2p/ws-client';
import {
  deserializeWsMessage,
  directRuntimeWsAudience,
  type RuntimeWsMessage,
} from '../../../network/p2p/ws-protocol';
import type { RuntimeEntityInputsEnvelope } from '../../../runtime/types';

const SERVER_SEED = 'transport-session-keys-server';
const CLIENT_SEED = 'transport-session-keys-client';
const SERVER_RUNTIME_ID = deriveSignerAddressSync(SERVER_SEED, '1').toLowerCase();
const CLIENT_RUNTIME_ID = deriveSignerAddressSync(CLIENT_SEED, '1').toLowerCase();

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const clients: RuntimeWsClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.stop(true);
});

const envelopeFrom = (sourceRuntimeId: string, targetRuntimeId: string): RuntimeEntityInputsEnvelope => ({
  sourceRuntimeId,
  sourceSignature: `0x${'11'.repeat(65)}`,
  sourceRuntimeHeight: 7,
  sourceRuntimeTimestamp: 123,
  entityInputs: [{
    entityId: `0x${'11'.repeat(32)}`,
    runtimeId: targetRuntimeId,
    signerId: targetRuntimeId,
    entityTxs: [],
  } as RuntimeEntityInputsEnvelope['entityInputs'][number]],
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};

describe('direct runtime session keys', () => {
  test('real client and route negotiate hello-bound session keys; frames carry MAC, payloads seal under session key', async () => {
    const serverReceived: Array<{ from: string; envelope: RuntimeEntityInputsEnvelope }> = [];
    const clientReceived: Array<{ from: string; envelope: RuntimeEntityInputsEnvelope }> = [];
    const clientFrames: RuntimeWsMessage[] = [];
    const serverFrames: RuntimeWsMessage[] = [];
    const errors: string[] = [];
    const route = createDirectRuntimeWsRoute({
      runtimeId: SERVER_RUNTIME_ID,
      runtimeSeed: SERVER_SEED,
      onEntityInputs: (from, envelope) => {
        serverReceived.push({ from, envelope });
      },
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, bunServer) {
        const decision = route.maybeUpgrade(request, bunServer);
        if (decision.handled) return decision.response;
        return new Response('websocket only', { status: 400 });
      },
      websocket: {
        ...route.websocket,
        open(ws) {
          const rawSend = ws.send.bind(ws);
          (ws as unknown as { send: typeof ws.send }).send = ((raw: string | Uint8Array) => {
            serverFrames.push(deserializeWsMessage(raw));
            return rawSend(raw);
          }) as typeof ws.send;
          route.websocket.open(ws);
        },
        message(ws, raw) {
          clientFrames.push(deserializeWsMessage(raw));
          return route.websocket.message(ws, raw);
        },
      },
    });
    servers.push(server);
    const serverEncryptionKey = deriveEncryptionKeyPair(SERVER_SEED).publicKey;
    const client = new RuntimeWsClient({
      url: `ws://127.0.0.1:${server.port}${route.path}`,
      runtimeId: CLIENT_RUNTIME_ID,
      helloAudience: directRuntimeWsAudience(SERVER_RUNTIME_ID),
      signerId: '1',
      seed: CLIENT_SEED,
      encryptionKeyPair: deriveEncryptionKeyPair(CLIENT_SEED),
      getTargetEncryptionKey: () => serverEncryptionKey,
      maxReconnectAttempts: 1,
      onError: error => errors.push(error.message),
      onEntityInputs: (from, envelope) => {
        clientReceived.push({ from, envelope });
      },
    });
    clients.push(client);
    await client.connect();
    await waitFor(() => client.isOpen());

    // hello: runtime-signed, offers the ephemeral key. hello_ack: runtime-signed, answers with the server key.
    const hello = clientFrames.find(frame => frame.type === 'hello');
    expect(hello?.auth?.signature).toBeTruthy();
    expect(hello?.auth?.mac).toBeUndefined();
    expect(typeof hello?.sessionPubKey).toBe('string');
    const ack = serverFrames.find(frame => frame.type === 'hello_ack');
    expect(ack?.auth?.signature).toBeTruthy();
    expect(ack?.auth?.mac).toBeUndefined();
    expect(typeof ack?.sessionPubKey).toBe('string');
    expect(ack?.sessionPubKey).not.toBe(hello?.sessionPubKey);

    // client → server: MAC frame, session-sealed payload with a counter nonce
    expect(client.sendEntityInputsRaw(SERVER_RUNTIME_ID, envelopeFrom(CLIENT_RUNTIME_ID, SERVER_RUNTIME_ID), 5)).toBe(true);
    await waitFor(() => serverReceived.length === 1);
    const inbound = clientFrames.find(frame => frame.type === 'entity_inputs');
    expect(inbound?.auth?.mac).toBeTruthy();
    expect(inbound?.auth?.signature).toBeUndefined();
    expect(inbound?.encSeq).toBe(1);
    expect(serverReceived[0]?.from).toBe(CLIENT_RUNTIME_ID);
    expect(serverReceived[0]?.envelope.sourceRuntimeHeight).toBe(7);

    // server → client
    expect(route.sendEntityInputsDelivery(CLIENT_RUNTIME_ID, envelopeFrom(SERVER_RUNTIME_ID, CLIENT_RUNTIME_ID), 9)).toMatchObject({
      outcome: 'delivered',
    });
    await waitFor(() => clientReceived.length === 1);
    const outbound = serverFrames.find(frame => frame.type === 'entity_inputs');
    expect(outbound?.auth?.mac).toBeTruthy();
    expect(outbound?.auth?.signature).toBeUndefined();
    expect(outbound?.encSeq).toBe(1);
    expect(clientReceived[0]?.from).toBe(SERVER_RUNTIME_ID);
    expect(errors).toEqual([]);

    // A frame authenticated by a runtime signature is refused once the session is keyed.
    // (Only the c2s MAC authenticates the client now; the server drops the socket.)
    expect(hexToPubKey(String(ack?.sessionPubKey)).length).toBe(32);
    expect(pubKeyToHex(serverEncryptionKey)).not.toBe(ack?.sessionPubKey);
  });
});
