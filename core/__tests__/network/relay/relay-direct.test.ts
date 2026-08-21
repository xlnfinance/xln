import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { deriveEncryptionKeyPair, decryptJSON, pubKeyToHex } from '../../../protocol/crypto/p2p-crypto';
import { deserializeWsMessage } from '../../../network/p2p/ws-protocol';
import { cacheEncryptionKey, createRelayStore, registerClient } from '../../../network/relay/store';
import { createGossipLayer } from '../../../network/p2p/gossip/index';
import { buildCryptographicProfileFixture } from '../../helpers/cryptographic-profile';
import {
  hasConnectedEncryptedRelayClient,
  resolveRequestClientIp,
  sendEntityInputDirectViaRelaySocketDelivery,
} from '../../../api/server/network/relay-direct';
import type { DeliverableEntityInput, RuntimeReplica, RuntimeEntityInputsEnvelope } from '../../../runtime/types';
import { createEmptyEnv } from '../../../runtime';
import { signRuntimeEntityInputsEnvelope , assertRuntimeEntityInputsEnvelopeSource } from '../../../runtime/admit/entity-input-envelope-auth.ts';
import { decodeRuntimeEntityInputsEnvelope } from '../../../network/p2p/auth/entity-input-envelope';

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

const signedEnvelope = (
  sourceSeed: string,
  targetRuntimeId: string,
  sourceRuntimeHeight: number,
  sourceRuntimeTimestamp: number,
  entityInputs: DeliverableEntityInput[],
): RuntimeEntityInputsEnvelope => {
  const source = createEmptyEnv(sourceSeed);
  return signRuntimeEntityInputsEnvelope(source, targetRuntimeId, {
    sourceRuntimeId: source.runtimeId!,
    sourceRuntimeHeight,
    sourceRuntimeTimestamp,
    entityInputs,
  });
};

describe('relay direct entity delivery', () => {
  test('trusts proxy client headers only from a loopback peer', () => {
    const request = new Request('http://xln.local/relay', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    expect(resolveRequestClientIp(request, '198.51.100.9')).toBe('198.51.100.9');
    expect(resolveRequestClientIp(request, '::ffff:127.0.0.1')).toBe('203.0.113.7');
    expect(resolveRequestClientIp(new Request('http://xln.local/relay', {
      headers: { 'x-forwarded-for': '192.0.2.99, 203.0.113.8' },
    }), '127.0.0.1')).toBe('203.0.113.8');
    expect(resolveRequestClientIp(new Request('http://xln.local/relay', {
      headers: {
        'x-real-ip': '192.0.2.44',
        'cf-connecting-ip': '192.0.2.45',
        'x-forwarded-for': '192.0.2.46, 203.0.113.9',
      },
    }), '127.0.0.1')).toBe('203.0.113.9');
    expect(resolveRequestClientIp(request, null)).toBe('unknown');
  });

  test('direct relay diagnostics stay machine-readable', () => {
    const source = readFileSync(new URL('../../../api/server/network/relay-direct.ts', import.meta.url), 'utf8');

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
    const targetSocket = makeSocket({ sendResult: -1 });
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
        type: 'entityCommand',
        data: {},
      } as never],
    };
    const envelope = signedEnvelope(sourceSeed, targetRuntimeId, 7, 12345, [input]);

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as RuntimeReplica,
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
    const recipient = createEmptyEnv(targetSeed);
    expect(assertRuntimeEntityInputsEnvelopeSource(
      recipient,
      String(packet.from || ''),
      decodeRuntimeEntityInputsEnvelope(decrypted),
    )).toEqual({ sourceRuntimeId, localRuntimeId: targetRuntimeId });
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

  test('delivers raw AccountInput through the canonical direct relay path', () => {
    const sourceSeed = 'relay-direct-account-source';
    const targetSeed = 'relay-direct-account-target';
    const sourceRuntimeId = deriveSignerAddressSync(sourceSeed, '1').toLowerCase();
    const targetRuntimeId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
    const store = createRelayStore(sourceRuntimeId);
    const targetSocket = makeSocket();

    cacheEncryptionKey(store, sourceRuntimeId, pubKeyToHex(deriveEncryptionKeyPair(sourceSeed).publicKey));
    cacheEncryptionKey(store, targetRuntimeId, pubKeyToHex(deriveEncryptionKeyPair(targetSeed).publicKey));
    expect(registerClient(store, targetRuntimeId, targetSocket.ws)).toBe(true);

    const input: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: `0x${'ab'.repeat(32)}`,
      signerId: targetRuntimeId,
      entityTxs: [{
        type: 'accountInput',
        data: {},
      } as never],
    };
    const envelope = signedEnvelope(sourceSeed, targetRuntimeId, 7, 12345, [input]);

    expect(sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as RuntimeReplica,
      targetRuntimeId,
      envelope,
      () => undefined,
      12345,
    )).toMatchObject({
      outcome: 'delivered',
      code: 'ROUTE_DIRECT_DELIVERED',
      retryable: false,
      terminal: true,
    });
    expect(targetSocket.sent).toHaveLength(1);
    const decrypted = decryptJSON<RuntimeEntityInputsEnvelope>(
      String(targetSocket.sent[0]?.payload || ''),
      deriveEncryptionKeyPair(targetSeed).privateKey,
    );
    expect(decrypted).toEqual(envelope);
  });

  test('fails over instead of claiming delivery for a stale relay client socket', () => {
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
    const envelope = signedEnvelope(sourceSeed, targetRuntimeId, 8, 23456, [input]);

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as RuntimeReplica,
      targetRuntimeId,
      envelope,
      () => undefined,
      23456,
    );

    expect(delivery).toMatchObject({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_MISS_FAILOVER',
      retryable: true,
      fatal: false,
      terminal: false,
    });
    expect(targetSocket.sent).toEqual([]);
    expect(store.debugEvents.at(-1)).toMatchObject({
      event: 'delivery',
      from: sourceRuntimeId,
      to: targetRuntimeId,
      status: 'direct-miss-failover',
      delivery: {
        outcome: 'deferred',
        code: 'DELIVERY_DIRECT_MISS_FAILOVER',
        retryable: true,
        fatal: false,
        terminal: false,
      },
    });
  });

  test('fails over when direct relay socket send reports zero bytes', () => {
    const sourceSeed = 'relay-direct-send-false-source';
    const targetSeed = 'relay-direct-send-false-target';
    const sourceRuntimeId = deriveSignerAddressSync(sourceSeed, '1').toLowerCase();
    const targetRuntimeId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
    const sourcePubKey = pubKeyToHex(deriveEncryptionKeyPair(sourceSeed).publicKey);
    const targetPubKey = pubKeyToHex(deriveEncryptionKeyPair(targetSeed).publicKey);
    const store = createRelayStore(sourceRuntimeId);
    const targetSocket = makeSocket({ sendResult: 0 });

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
    const envelope = signedEnvelope(sourceSeed, targetRuntimeId, 9, 34567, [input]);

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as RuntimeReplica,
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
      reason: 'ROUTE_DIRECT_SEND_DROPPED',
      delivery: {
        outcome: 'failed',
        code: 'ROUTE_DIRECT_SEND_DROPPED',
        retryable: true,
        fatal: false,
        terminal: false,
      },
    });
  });

  test('fails loud when direct relay socket returns an invalid numeric result', () => {
    const sourceSeed = 'relay-direct-invalid-source';
    const targetSeed = 'relay-direct-invalid-target';
    const sourceRuntimeId = deriveSignerAddressSync(sourceSeed, '1').toLowerCase();
    const targetRuntimeId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
    const store = createRelayStore(sourceRuntimeId);
    const targetSocket = makeSocket({ sendResult: Number.POSITIVE_INFINITY });

    cacheEncryptionKey(
      store,
      sourceRuntimeId,
      pubKeyToHex(deriveEncryptionKeyPair(sourceSeed).publicKey),
    );
    cacheEncryptionKey(
      store,
      targetRuntimeId,
      pubKeyToHex(deriveEncryptionKeyPair(targetSeed).publicKey),
    );
    expect(registerClient(store, targetRuntimeId, targetSocket.ws)).toBe(true);
    const envelope = signedEnvelope(sourceSeed, targetRuntimeId, 10, 45678, [{
        runtimeId: targetRuntimeId,
        entityId: `0x${'bd'.repeat(32)}`,
        signerId: targetRuntimeId,
        entityTxs: [],
      }]);

    expect(() => sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as RuntimeReplica,
      targetRuntimeId,
      envelope,
      () => undefined,
      45678,
    )).toThrow('WEBSOCKET_SEND_RESULT_INVALID');
    expect(store.debugEvents.some(event => event.status === 'send-failed')).toBe(false);
  });

  test('fails over with typed delivery event when direct relay socket send throws', () => {
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
    const envelope = signedEnvelope(sourceSeed, targetRuntimeId, 10, 45678, [input]);

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as RuntimeReplica,
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

  test('fails over with typed delivery event when the target runtime encryption key is absent', () => {
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
    const envelope = signedEnvelope(sourceSeed, targetRuntimeId, 11, 1, [input]);

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as RuntimeReplica,
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
      status: 'direct-miss-failover',
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

  test('fails over when the source runtime encryption key is absent', () => {
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
    const envelope = signedEnvelope('relay-direct-missing-source', targetRuntimeId, 12, 1, [input]);

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      { runtimeId: sourceRuntimeId } as RuntimeReplica,
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
      status: 'direct-miss-failover',
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

  test('profile-keyed send: gossip profile supplies both peer and own X25519 keys', () => {
    const sourceSeed = 'relay-direct-profile-source';
    const targetSeed = 'relay-direct-profile-target';
    const sourceRuntimeId = deriveSignerAddressSync(sourceSeed, '1').toLowerCase();
    const targetRuntimeId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
    const sourceKeyPair = deriveEncryptionKeyPair(sourceSeed);
    const targetKeyPair = deriveEncryptionKeyPair(targetSeed);
    const store = createRelayStore(sourceRuntimeId);
    const targetSocket = makeSocket();
    const logs: string[] = [];

    // No WS-hello key cache at all: the only key source is admitted profiles.
    expect(registerClient(store, targetRuntimeId, targetSocket.ws)).toBe(true);
    const gossip = createGossipLayer({});
    gossip.announce(buildCryptographicProfileFixture({
      entityId: `0x${'ce'.repeat(32)}`,
      runtimeId: targetRuntimeId,
      runtimeEncPubKey: pubKeyToHex(targetKeyPair.publicKey),
      name: 'ProfileTarget',
      signingSeed: 'relay-direct-profile-target',
    }));
    gossip.announce(buildCryptographicProfileFixture({
      entityId: `0x${'cd'.repeat(32)}`,
      runtimeId: sourceRuntimeId,
      runtimeEncPubKey: pubKeyToHex(sourceKeyPair.publicKey),
      name: 'ProfileSource',
      signingSeed: 'relay-direct-profile-source',
    }));

    const input: DeliverableEntityInput = {
      runtimeId: targetRuntimeId,
      entityId: `0x${'de'.repeat(32)}`,
      signerId: targetRuntimeId,
      entityTxs: [],
    };
    const envelope = signedEnvelope(sourceSeed, targetRuntimeId, 12, 1, [input]);
    const env = { runtimeId: sourceRuntimeId, gossip } as unknown as RuntimeReplica;

    const delivery = sendEntityInputDirectViaRelaySocketDelivery(
      store,
      env,
      targetRuntimeId,
      envelope,
      (_key, message) => logs.push(message),
    );

    expect(delivery).toMatchObject({ outcome: 'delivered', code: 'ROUTE_DIRECT_DELIVERED' });
    expect(targetSocket.sent.length).toBe(1);
    const message = targetSocket.sent[0]!;
    expect(message.fromEncryptionPubKey).toBe(pubKeyToHex(sourceKeyPair.publicKey));
    const decrypted = decryptJSON(message.payload as string, targetKeyPair.privateKey, pubKeyToHex(sourceKeyPair.publicKey));
    expect((decrypted as { entityInputs: unknown[] }).entityInputs.length).toBe(1);
    expect(logs).toEqual([]);
    // Reachability gate agrees once the profile key exists.
    expect(hasConnectedEncryptedRelayClient(store, targetRuntimeId, gossip.encryptionKeyForRuntime)).toBe(true);
    expect(hasConnectedEncryptedRelayClient(store, targetRuntimeId)).toBe(false);
  });

  test('profile without a valid runtime key never reaches the directory', () => {
    const targetRuntimeId = deriveSignerAddressSync('relay-direct-profile-nokey', '1').toLowerCase();
    const gossip = createGossipLayer({});
    expect(gossip.encryptionKeyForRuntime(targetRuntimeId)).toBeNull();
    // Canonicalization rejects an invalid X25519 binding outright, so the
    // send-ready directory can only ever hold well-formed keys.
    expect(() => gossip.announce(buildCryptographicProfileFixture({
      entityId: `0x${'cf'.repeat(32)}`,
      runtimeId: targetRuntimeId,
      runtimeEncPubKey: 'not-a-key',
      name: 'NoKey',
      signingSeed: 'relay-direct-profile-nokey',
    }))).toThrow('GOSSIP_PROFILE_RUNTIME_ENC_PUBKEY_REQUIRED');
    expect(gossip.encryptionKeyForRuntime(targetRuntimeId)).toBeNull();
  });
});
