import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync } from '../account-crypto';
import { deriveEncryptionKeyPair, decryptJSON, pubKeyToHex } from '../networking/p2p-crypto';
import { cacheEncryptionKey, createRelayStore, registerClient } from '../relay-store';
import {
  hasConnectedEncryptedRelayClient,
  sendEntityInputDirectViaRelaySocketDelivery,
} from '../server/relay-direct';
import type { DeliverableEntityInput, Env, RoutedEntityInput } from '../types';

type SentMessage = {
  type?: string;
  id?: string;
  from?: string;
  fromEncryptionPubKey?: string;
  to?: string;
  encrypted?: boolean;
  entityId?: string;
  txs?: number;
  timestamp?: number;
  payload?: string;
};

const makeSocket = (options: { readyState?: number; sendResult?: boolean | number | void } = {}) => {
  const sent: SentMessage[] = [];
  return {
    sent,
    ws: {
      readyState: options.readyState ?? 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as SentMessage);
        return options.sendResult ?? true;
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

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      input,
      (_key, message) => logs.push(message),
      12345,
    );

    expect(delivery).toMatchObject({
      outcome: 'delivered',
      code: 'ROUTE_DIRECT_DELIVERED',
      retryable: false,
      fatal: false,
      terminal: true,
    });
    expect(logs).toEqual([]);
    expect(targetSocket.sent).toHaveLength(1);
    const packet = targetSocket.sent[0]!;
    expect(packet.id).toMatch(/^srv_\d+$/);
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
      delivery: {
        outcome: 'delivered',
        code: 'DELIVERY_ACCEPTED',
        retryable: false,
        fatal: false,
        terminal: true,
      },
      details: {
        entityId: input.entityId,
        txs: 1,
      },
    });
  });

  test('falls back instead of claiming delivery for a stale relay client socket', () => {
    const sourceSeed = 'relay-direct-stale-source';
    const targetSeed = 'relay-direct-stale-target';
    const sourceRuntimeId = deriveSignerAddressSync(sourceSeed, '1').toLowerCase();
    const targetRuntimeId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
    const sourcePubKey = pubKeyToHex(deriveEncryptionKeyPair(sourceSeed).publicKey);
    const targetPubKey = pubKeyToHex(deriveEncryptionKeyPair(targetSeed).publicKey);
    const store = createRelayStore(sourceRuntimeId);
    const targetSocket = makeSocket({ readyState: 3 });

    cacheEncryptionKey(store, sourceRuntimeId, sourcePubKey);
    cacheEncryptionKey(store, targetRuntimeId, targetPubKey);
    expect(registerClient(store, targetRuntimeId, targetSocket.ws)).toBe(true);
    expect(hasConnectedEncryptedRelayClient(store, targetRuntimeId)).toBe(false);

    const input: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: `0x${'aa'.repeat(32)}`,
      entityTxs: [],
    };

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      input,
      () => undefined,
      23456,
    );

    expect(delivery).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_MISS_FALLBACK',
      retryable: true,
      fatal: false,
      terminal: false,
    });
    expect(targetSocket.sent).toEqual([]);
    expect(store.debugEvents.at(-1)).toMatchObject({
      event: 'delivery',
      from: sourceRuntimeId,
      to: targetRuntimeId,
      status: 'direct-miss-fallback',
      delivery: {
        outcome: 'deferred',
        code: 'DELIVERY_DIRECT_MISS_FALLBACK',
        retryable: true,
        fatal: false,
        terminal: false,
      },
    });
  });

  test('falls back when direct relay socket send returns false', () => {
    const sourceSeed = 'relay-direct-send-false-source';
    const targetSeed = 'relay-direct-send-false-target';
    const sourceRuntimeId = deriveSignerAddressSync(sourceSeed, '1').toLowerCase();
    const targetRuntimeId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
    const sourcePubKey = pubKeyToHex(deriveEncryptionKeyPair(sourceSeed).publicKey);
    const targetPubKey = pubKeyToHex(deriveEncryptionKeyPair(targetSeed).publicKey);
    const store = createRelayStore(sourceRuntimeId);
    const targetSocket = makeSocket({ sendResult: false });

    cacheEncryptionKey(store, sourceRuntimeId, sourcePubKey);
    cacheEncryptionKey(store, targetRuntimeId, targetPubKey);
    expect(registerClient(store, targetRuntimeId, targetSocket.ws)).toBe(true);
    expect(hasConnectedEncryptedRelayClient(store, targetRuntimeId)).toBe(true);

    const input: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: `0x${'bb'.repeat(32)}`,
      entityTxs: [],
    };

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      input,
      () => undefined,
      34567,
    );

    expect(delivery).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_SEND_FAILED',
      retryable: true,
      fatal: false,
      terminal: false,
    });
    expect(targetSocket.sent).toHaveLength(1);
    expect(store.debugEvents.at(-1)).toMatchObject({
      event: 'delivery',
      from: sourceRuntimeId,
      to: targetRuntimeId,
      status: 'send-failed',
      reason: 'ROUTE_DIRECT_SEND_FALSE',
      delivery: {
        outcome: 'failed',
        code: 'ROUTE_DIRECT_SEND_FALSE',
        retryable: true,
        fatal: false,
        terminal: false,
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

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      input,
      (_key, message) => logs.push(message),
    );

    expect(delivery).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_SOURCE_KEY_MISSING',
      retryable: true,
      fatal: false,
      terminal: false,
    });
    expect(targetSocket.sent).toEqual([]);
    expect(logs[0]).toContain('missing source encryption key');
  });
});
