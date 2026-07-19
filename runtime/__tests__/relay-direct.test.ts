import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync } from '../account/crypto';
import { deriveEncryptionKeyPair, decryptJSON, pubKeyToHex } from '../networking/p2p-crypto';
import { deserializeWsMessage } from '../networking/ws-protocol';
import { cacheEncryptionKey, createRelayStore, registerClient } from '../relay/store';
import {
  hasConnectedEncryptedRelayClient,
  sendEntityInputDirectViaRelaySocketDelivery,
} from '../server/relay-direct';
import type { DeliverableEntityInput, Env, RuntimeEntityInputsEnvelope } from '../types';

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

const makeSocket = (options: { readyState?: number; sendResult?: boolean | number | void; sendThrows?: string } = {}) => {
  const sent: SentMessage[] = [];
  return {
    sent,
    ws: {
      readyState: options.readyState ?? 1,
      send(raw: Uint8Array) {
        if (options.sendThrows) throw new Error(options.sendThrows);
        expect(raw[0]).toBe(0x01);
        sent.push(deserializeWsMessage(raw) as SentMessage);
        return options.sendResult ?? true;
      },
    },
  };
};

describe('relay direct entity delivery', () => {
  test('direct relay diagnostics stay machine-readable', () => {
    const source = readFileSync(new URL('../server/relay-direct.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('[RELAY] Direct dispatch');
    expect(source).not.toContain('console.');
    expect(source).toContain('relay.direct.target_key_missing');
    expect(source).toContain('relay.direct.source_key_missing');
    expect(source).toContain('relay.direct.send_failed');
  });

  test('sends a complete encrypted entity_inputs packet to a live relay client', () => {
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
      signerId: targetRuntimeId,
      entityTxs: [{
        type: 'accountInput',
        data: {
          fromEntityId: `0x${'cd'.repeat(32)}`,
          toEntityId: `0x${'ab'.repeat(32)}`,
          height: 1,
        },
      }],
    };
    const envelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId,
      sourceRuntimeHeight: 7,
      sourceRuntimeTimestamp: 12345,
      entityInputs: [input],
    };

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      envelope,
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
      type: 'entity_inputs',
      from: sourceRuntimeId,
      fromEncryptionPubKey: sourcePubKey,
      to: targetRuntimeId,
      timestamp: 12345,
      encrypted: true,
      entityId: input.entityId,
      txs: 1,
    });
    const decrypted = decryptJSON<RuntimeEntityInputsEnvelope>(String(packet.payload || ''), targetKeys.privateKey);
    expect(decrypted).toEqual(envelope);
    expect(store.debugEvents.at(-1)).toMatchObject({
      event: 'delivery',
      from: sourceRuntimeId,
      to: targetRuntimeId,
      msgType: 'entity_inputs',
      status: 'delivered-direct-local',
      delivery: {
        outcome: 'delivered',
        code: 'DELIVERY_ACCEPTED',
        retryable: false,
        fatal: false,
        terminal: true,
      },
      details: {
        sourceRuntimeHeight: 7,
        entityIds: [input.entityId],
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
      signerId: targetRuntimeId,
      entityTxs: [],
    };
    const envelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId,
      sourceRuntimeHeight: 8,
      sourceRuntimeTimestamp: 23456,
      entityInputs: [input],
    };

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      envelope,
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
      signerId: targetRuntimeId,
      entityTxs: [],
    };
    const envelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId,
      sourceRuntimeHeight: 9,
      sourceRuntimeTimestamp: 34567,
      entityInputs: [input],
    };

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      envelope,
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

  test('falls back with typed delivery event when direct relay socket send throws', () => {
    const sourceSeed = 'relay-direct-send-throw-source';
    const targetSeed = 'relay-direct-send-throw-target';
    const sourceRuntimeId = deriveSignerAddressSync(sourceSeed, '1').toLowerCase();
    const targetRuntimeId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
    const sourcePubKey = pubKeyToHex(deriveEncryptionKeyPair(sourceSeed).publicKey);
    const targetPubKey = pubKeyToHex(deriveEncryptionKeyPair(targetSeed).publicKey);
    const store = createRelayStore(sourceRuntimeId);
    const targetSocket = makeSocket({ sendThrows: 'socket exploded' });
    const logs: string[] = [];

    cacheEncryptionKey(store, sourceRuntimeId, sourcePubKey);
    cacheEncryptionKey(store, targetRuntimeId, targetPubKey);
    expect(registerClient(store, targetRuntimeId, targetSocket.ws)).toBe(true);
    expect(hasConnectedEncryptedRelayClient(store, targetRuntimeId)).toBe(true);

    const input: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: `0x${'bc'.repeat(32)}`,
      signerId: targetRuntimeId,
      entityTxs: [],
    };
    const envelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId,
      sourceRuntimeHeight: 10,
      sourceRuntimeTimestamp: 45678,
      entityInputs: [input],
    };

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      envelope,
      (_key, message) => logs.push(message),
      45678,
    );

    expect(delivery).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_SEND_FAILED',
      retryable: true,
      fatal: false,
      terminal: false,
    });
    expect(targetSocket.sent).toEqual([]);
    expect(logs[0]).toBe('relay.direct.send_failed');
    expect(store.debugEvents.at(-1)).toMatchObject({
      event: 'delivery',
      from: sourceRuntimeId,
      to: targetRuntimeId,
      status: 'send-failed',
      reason: 'ROUTE_DIRECT_SEND_THROW',
      delivery: {
        outcome: 'failed',
        code: 'ROUTE_DIRECT_SEND_THROW',
        retryable: true,
        fatal: false,
        terminal: false,
      },
      details: {
        sourceRuntimeHeight: 10,
        entityIds: [input.entityId],
        txs: 0,
        error: 'socket exploded',
      },
    });
  });

  test('falls back with typed delivery event when the target runtime encryption key is absent', () => {
    const sourceSeed = 'relay-direct-missing-target-source';
    const sourceRuntimeId = deriveSignerAddressSync(sourceSeed, '1').toLowerCase();
    const targetRuntimeId = deriveSignerAddressSync('relay-direct-missing-target', '1').toLowerCase();
    const store = createRelayStore(sourceRuntimeId);
    const targetSocket = makeSocket();
    const logs: string[] = [];

    cacheEncryptionKey(store, sourceRuntimeId, pubKeyToHex(deriveEncryptionKeyPair(sourceSeed).publicKey));
    expect(registerClient(store, targetRuntimeId, targetSocket.ws)).toBe(true);
    expect(hasConnectedEncryptedRelayClient(store, targetRuntimeId)).toBe(false);

    const input: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: `0x${'de'.repeat(32)}`,
      signerId: targetRuntimeId,
      entityTxs: [],
    };
    const envelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId,
      sourceRuntimeHeight: 11,
      sourceRuntimeTimestamp: 1,
      entityInputs: [input],
    };

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      envelope,
      (_key, message) => logs.push(message),
    );

    expect(delivery).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_TARGET_KEY_MISSING',
      retryable: true,
      fatal: false,
      terminal: false,
    });
    expect(targetSocket.sent).toEqual([]);
    expect(logs[0]).toBe('relay.direct.target_key_missing');
    expect(store.debugEvents.at(-1)).toMatchObject({
      event: 'delivery',
      from: sourceRuntimeId,
      to: targetRuntimeId,
      status: 'direct-miss-fallback',
      reason: 'ROUTE_DIRECT_TARGET_KEY_MISSING',
      delivery: {
        outcome: 'deferred',
        code: 'ROUTE_DIRECT_TARGET_KEY_MISSING',
        retryable: true,
        fatal: false,
        terminal: false,
      },
      details: {
        sourceRuntimeHeight: 11,
        entityIds: [input.entityId],
        txs: 0,
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
      signerId: targetRuntimeId,
      entityTxs: [],
    };
    const envelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId,
      sourceRuntimeHeight: 12,
      sourceRuntimeTimestamp: 1,
      entityInputs: [input],
    };

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as Env,
      targetRuntimeId,
      envelope,
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
    expect(logs[0]).toBe('relay.direct.source_key_missing');
    expect(store.debugEvents.at(-1)).toMatchObject({
      event: 'delivery',
      from: sourceRuntimeId,
      to: targetRuntimeId,
      status: 'direct-miss-fallback',
      reason: 'ROUTE_DIRECT_SOURCE_KEY_MISSING',
      delivery: {
        outcome: 'deferred',
        code: 'ROUTE_DIRECT_SOURCE_KEY_MISSING',
        retryable: true,
        fatal: false,
        terminal: false,
      },
      details: {
        sourceRuntimeHeight: 12,
        entityIds: [input.entityId],
        txs: 0,
      },
    });
  });
});
