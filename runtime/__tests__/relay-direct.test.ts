import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync } from '../account-crypto';
import { deriveEncryptionKeyPair, decryptJSON, pubKeyToHex } from '../networking/p2p-crypto';
import { cacheEncryptionKey, createRelayStore, registerClient } from '../relay-store';
import {
  hasConnectedEncryptedRelayClient,
  sendEntityInputDirectViaRelaySocket,
} from '../server/relay-direct';
import type { DeliverableEntityInput, Env, RoutedEntityInput } from '../types';

type SentMessage = {
  type?: string;
  from?: string;
  fromEncryptionPubKey?: string;
  to?: string;
  encrypted?: boolean;
  entityId?: string;
  txs?: number;
  timestamp?: number;
  payload?: string;
};

const makeSocket = () => {
  const sent: SentMessage[] = [];
  return {
    sent,
    ws: {
      readyState: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as SentMessage);
        return true;
      },
    },
  };
};

describe('relay direct entity delivery', () => {
  test('sends a complete encrypted entity_input packet to a live relay client', () => {
    const sourceSeed = 'relay-direct-source';
    const targetSeed = 'relay-direct-target';
    const sourceRuntimeId = deriveSignerAddressSync(sourceSeed, '1').toLowerCase();
    const targetRuntimeId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
    const sourcePubKey = pubKeyToHex(deriveEncryptionKeyPair(sourceSeed).publicKey);
    const targetKeys = deriveEncryptionKeyPair(targetSeed);
    const targetPubKey = pubKeyToHex(targetKeys.publicKey);
    const store = createRelayStore(sourceRuntimeId);
    const targetSocket = makeSocket();
    const logs: string[] = [];

    cacheEncryptionKey(store, sourceRuntimeId, sourcePubKey);
    cacheEncryptionKey(store, targetRuntimeId, targetPubKey);
    expect(registerClient(store, targetRuntimeId, targetSocket.ws)).toBe(true);
    expect(hasConnectedEncryptedRelayClient(store, targetRuntimeId)).toBe(true);

    const input: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: `0x${'ab'.repeat(32)}`,
      entityTxs: [{
        type: 'accountInput',
        data: {
          fromEntityId: `0x${'cd'.repeat(32)}`,
          toEntityId: `0x${'ab'.repeat(32)}`,
          height: 1,
        },
      }],
    };

    const sent = sendEntityInputDirectViaRelaySocket(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      input,
      (_key, message) => logs.push(message),
      12345,
    );

    expect(sent).toBe(true);
    expect(logs).toEqual([]);
    expect(targetSocket.sent).toHaveLength(1);
    const packet = targetSocket.sent[0]!;
    expect(packet).toMatchObject({
      type: 'entity_input',
      from: sourceRuntimeId,
      fromEncryptionPubKey: sourcePubKey,
      to: targetRuntimeId,
      timestamp: 12345,
      encrypted: true,
      entityId: input.entityId,
      txs: 1,
    });
    const decrypted = decryptJSON<RoutedEntityInput>(String(packet.payload || ''), targetKeys.privateKey);
    expect(decrypted).toEqual(input);
    expect(store.debugEvents.at(-1)).toMatchObject({
      event: 'delivery',
      from: sourceRuntimeId,
      to: targetRuntimeId,
      msgType: 'entity_input',
      status: 'delivered-direct-local',
      details: {
        entityId: input.entityId,
        txs: 1,
      },
    });
  });

  test('falls back when the source runtime encryption key is absent', () => {
    const sourceRuntimeId = deriveSignerAddressSync('relay-direct-missing-source', '1').toLowerCase();
    const targetSeed = 'relay-direct-missing-source-target';
    const targetRuntimeId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
    const store = createRelayStore(sourceRuntimeId);
    const targetSocket = makeSocket();
    const logs: string[] = [];

    cacheEncryptionKey(store, targetRuntimeId, pubKeyToHex(deriveEncryptionKeyPair(targetSeed).publicKey));
    expect(registerClient(store, targetRuntimeId, targetSocket.ws)).toBe(true);

    const input: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: `0x${'ef'.repeat(32)}`,
      entityTxs: [],
    };

    const sent = sendEntityInputDirectViaRelaySocket(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      input,
      (_key, message) => logs.push(message),
    );

    expect(sent).toBe(false);
    expect(targetSocket.sent).toEqual([]);
    expect(logs[0]).toContain('missing source encryption key');
  });
});
