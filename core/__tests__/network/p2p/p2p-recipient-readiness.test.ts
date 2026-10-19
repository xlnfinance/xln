import { expect, test } from 'bun:test';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { RuntimeP2P } from '../../../network/p2p/p2p';
import { decodeRuntimeEntityInputsEnvelope } from '../../../network/p2p/auth/entity-input-envelope';
import { startStandaloneRelayServer } from '../../../network/relay/standalone-server';
import { createEmptyEnv } from '../../../runtime';
import { RuntimeWsClient } from '../../../network/p2p/ws-client';
import { canonicalizeRuntimeWsAudience } from '../../../network/p2p/ws-protocol';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../../../protocol/crypto/p2p-crypto';
import {
  buildCryptographicProfileFixture,
  certifySingleSignerProfileFixture,
  deriveSingleSignerFixtureEntityId,
} from '../../helpers/cryptographic-profile';
import {
  assertRuntimeEntityInputsEnvelopeSource,
  signRuntimeEntityInputsEnvelope,
} from '../../../runtime/admit/entity-input-envelope-auth';
import type { RuntimeEntityInputsEnvelope } from '../../../runtime/types';

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};

test('committed output route bootstrap accepts authenticated endpointless user delivery', async () => {
  const sourceSeed = 'relay-route-source';
  const targetSeed = 'relay-route-target';
  const source = createEmptyEnv(sourceSeed, 1);
  const target = createEmptyEnv(targetSeed, 1);
  source.runtimeId = deriveSignerAddressSync(sourceSeed, '1').toLowerCase();
  target.runtimeId = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
  const profile = certifySingleSignerProfileFixture(
    buildCryptographicProfileFixture({
      entityId: deriveSingleSignerFixtureEntityId(targetSeed),
      signingSeed: targetSeed,
      name: 'endpointless user',
      isHub: false,
      runtimeId: target.runtimeId,
      runtimeEncPubKey: pubKeyToHex(deriveEncryptionKeyPair(targetSeed).publicKey),
    }),
    targetSeed,
  );
  const relay = startStandaloneRelayServer({ host: '127.0.0.1', port: 0, serverId: 'route-test' });
  const relayUrls = [`ws://127.0.0.1:${relay.server.port}`];
  const received: RuntimeEntityInputsEnvelope[] = [];
  const sender = new RuntimeP2P({
    env: source,
    runtimeId: source.runtimeId,
    relayUrls,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  const recipient = new RuntimeP2P({
    env: target,
    runtimeId: target.runtimeId,
    relayUrls,
    onEntityInputs: (_from, envelope) => {
      received.push(envelope);
    },
    onGossipProfiles: () => {},
  });
  try {
    sender.connect();
    recipient.connect();
    await waitFor(() => sender.isConnected() && recipient.isConnected());
    await sender.admitSharedProfiles([profile]);
    expect(sender.canDeliver(target.runtimeId)).toBe(true);
    expect(await sender.bootstrapEntityRoutes([profile.entityId], 100)).toBe(true);
    const envelope = decodeRuntimeEntityInputsEnvelope({
      sourceRuntimeId: source.runtimeId,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 123,
      entityInputs: [
        {
          entityId: profile.entityId,
          runtimeId: target.runtimeId,
          signerId: deriveSignerAddressSync(targetSeed, '1'),
          entityTxs: [],
        },
      ],
    });
    expect(sender.enqueueEntityInputsDelivery(target.runtimeId, envelope).outcome).toBe('delivered');
    await waitFor(() => received.length === 1);
    expect(
      relay.store.debugEvents.some(event => event.msgType === 'entity_inputs' && event.status === 'delivered'),
    ).toBe(true);
  } finally {
    await Promise.all([sender.closeAndWait(), recipient.closeAndWait()]);
    relay.close();
  }
});

test('an authenticated relay cannot authorize delivery without a verified recipient encryption key', async () => {
  const seed = 'p2p-recipient-readiness';
  const env = createEmptyEnv(seed, 1);
  const sourceRuntimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const targetRuntimeId = deriveSignerAddressSync('p2p-recipient-missing', '1').toLowerCase();
  const received: unknown[] = [];
  const profilesReceived: unknown[] = [];
  const relay = startStandaloneRelayServer({
    host: '127.0.0.1',
    port: 0,
    serverId: targetRuntimeId,
    onEntityInput: (_from, message) => {
      received.push(message);
    },
  });
  const gossipRequests = (): number =>
    relay.store.debugEvents.filter(event => event.event === 'gossip_request' && event.from === sourceRuntimeId).length;
  const p2p = new RuntimeP2P({
    env,
    runtimeId: sourceRuntimeId,
    relayUrls: [`ws://127.0.0.1:${relay.server.port}`],
    onEntityInputs: (_from, envelope) => {
      received.push(envelope);
    },
    onGossipProfiles: (_from, profiles) => {
      profilesReceived.push(...profiles);
    },
  });
  try {
    p2p.setReady(true);
    p2p.connect();
    await waitFor(() => p2p.isConnected() && gossipRequests() > 0);
    const envelope = decodeRuntimeEntityInputsEnvelope({
      sourceRuntimeId,
      sourceRuntimeHeight: 57,
      sourceRuntimeTimestamp: 123,
      entityInputs: [
        {
          entityId: `0x${'31'.repeat(32)}`,
          runtimeId: targetRuntimeId,
          signerId: targetRuntimeId,
          entityTxs: [],
        },
      ],
    });
    expect(p2p.canDeliver(targetRuntimeId)).toBe(false);
    expect(p2p.enqueueEntityInputsDelivery(targetRuntimeId, envelope)).toMatchObject({
      outcome: 'deferred',
      code: 'P2P_RELAY_RECIPIENT_NOT_READY',
      retryable: true,
      fatal: false,
      terminal: false,
    });
    const previousRequests = gossipRequests();
    p2p.requestGossip(targetRuntimeId);
    await waitFor(() => gossipRequests() > previousRequests);
    expect(received).toEqual([]);
    expect(relay.store.debugEvents.some(event => event.msgType === 'entity_inputs')).toBe(false);
    expect(env.infrastructure?.operatorStatus).not.toBe('HALTED_REQUIRES_OPERATOR');
  } finally {
    await p2p.closeAndWait();
    relay.close();
  }
});

test('authenticated user-to-user relay delivers only the destination-bound signed envelope', async () => {
  const source = createEmptyEnv('relay-source-user', 1);
  const target = createEmptyEnv('relay-target-user', 1);
  source.runtimeId = deriveSignerAddressSync('relay-source-user', '1').toLowerCase();
  target.runtimeId = deriveSignerAddressSync('relay-target-user', '1').toLowerCase();
  const sourceKey = deriveEncryptionKeyPair('relay-source-user');
  const targetKey = deriveEncryptionKeyPair('relay-target-user');
  const relay = startStandaloneRelayServer({ host: '127.0.0.1', port: 0, serverId: 'test-user-relay' });
  const url = `ws://127.0.0.1:${relay.server.port}/`;
  const received: RuntimeEntityInputsEnvelope[] = [];
  const errors: string[] = [];
  const recipient = new RuntimeWsClient({
    url,
    helloAudience: canonicalizeRuntimeWsAudience(url),
    runtimeId: target.runtimeId,
    signerId: '1',
    seed: 'relay-target-user',
    encryptionKeyPair: targetKey,
    onError: error => {
      errors.push(error.message);
    },
    onEntityInputs: (from, envelope, _at, sessionAuthenticated) => {
      expect(sessionAuthenticated).toBe(false);
      assertRuntimeEntityInputsEnvelopeSource(target, from, envelope);
      received.push(envelope);
    },
  });
  const sender = new RuntimeWsClient({
    url,
    helloAudience: canonicalizeRuntimeWsAudience(url),
    runtimeId: source.runtimeId,
    signerId: '1',
    seed: 'relay-source-user',
    encryptionKeyPair: sourceKey,
    getTargetEncryptionKey: runtimeId => (runtimeId === target.runtimeId ? targetKey.publicKey : null),
    signEnvelope: (to, envelope) => signRuntimeEntityInputsEnvelope(source, to, envelope),
    onError: error => {
      errors.push(error.message);
    },
  });
  try {
    await Promise.all([sender.connect(), recipient.connect()]);
    await waitFor(() => sender.isOpen() && recipient.isOpen());
    const envelope = decodeRuntimeEntityInputsEnvelope({
      sourceRuntimeId: source.runtimeId,
      sourceRuntimeHeight: 7,
      sourceRuntimeTimestamp: 123,
      entityInputs: [
        { entityId: `0x${'31'.repeat(32)}`, runtimeId: target.runtimeId, signerId: target.runtimeId, entityTxs: [] },
      ],
    });
    expect(sender.sendEntityInputsRaw(target.runtimeId, envelope)).toBe(true);
    await waitFor(() => received.length === 1);
    const delivered = received[0];
    if (!delivered) throw new Error('RELAY_ENVELOPE_NOT_DELIVERED');
    expect(delivered).toEqual(signRuntimeEntityInputsEnvelope(source, target.runtimeId, envelope));
    expect(() => assertRuntimeEntityInputsEnvelopeSource(source, source.runtimeId, delivered)).toThrow(
      'INBOUND_ENTITY_INPUTS_SOURCE_SIGNATURE_INVALID',
    );
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([sender.closeAndWait(), recipient.closeAndWait()]);
    relay.close();
  }
});