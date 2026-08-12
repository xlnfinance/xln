import { expect, test } from 'bun:test';
import {
  MAX_DEBUG_EVENT_BYTES,
  MAX_DEBUG_TIMELINE_BYTES,
  classifyRelayDeliveryEvent,
  clearDebugTimeline,
  createRelayStore,
  pushDebugEvent,
  setDebugIncidentState,
  storeVerifiedGossipProfile,
} from '../../../network/relay/store';
import { classifyWebSocketSendResult } from '../../../network/websocket-send-result';
import type { Profile } from '../../../entity/profile';
import {
  buildCryptographicProfileFixture,
  certifySingleSignerProfileFixture,
  deriveSingleSignerFixtureEntityId,
} from '../../helpers/cryptographic-profile';

test('websocket send result classifier covers the complete server/client matrix', () => {
  const matrix = [
    { result: false, expected: 'dropped' },
    { result: 0, expected: 'dropped' },
    { result: -1, expected: 'backpressured' },
    { result: true, expected: 'accepted' },
    { result: 1, expected: 'accepted' },
    { result: 4096, expected: 'accepted' },
    { result: undefined, expected: 'accepted' },
  ] as const;

  for (const { result, expected } of matrix) {
    expect(classifyWebSocketSendResult(result)).toBe(expected);
  }
  expect(() => classifyWebSocketSendResult(-2)).toThrow('WEBSOCKET_SEND_RESULT_INVALID');
  expect(() => classifyWebSocketSendResult(Number.NaN)).toThrow('WEBSOCKET_SEND_RESULT_INVALID');
  expect(() => classifyWebSocketSendResult(Number.POSITIVE_INFINITY)).toThrow('WEBSOCKET_SEND_RESULT_INVALID');
});

test('relay incidents group repeated root errors and reopen after a new occurrence', () => {
  const store = createRelayStore('relay-test');
  const runtimeId = '0x1111111111111111111111111111111111111111';
  const event = {
    event: 'debug_event',
    from: runtimeId,
    details: {
      payload: {
        category: 'system',
        level: 'error',
        message: 'RUNTIME_LOOP_ERROR',
        data: {
          message: 'RUNTIME_FRAME_STORAGE_NOT-COMMITTED:Database is not open',
        },
      },
    },
  };
  pushDebugEvent(store, event);
  pushDebugEvent(store, event);

  expect(store.debugIncidents.size).toBe(1);
  const incident = Array.from(store.debugIncidents.values())[0]!;
  expect(incident).toMatchObject({
    state: 'unread',
    source: 'system',
    code: 'RUNTIME_FRAME_STORAGE_NOT_COMMITTED',
    runtimeId,
    count: 2,
  });

  setDebugIncidentState(store, incident.fingerprint, 'resolved');
  expect(store.debugIncidents.get(incident.fingerprint)?.state).toBe('resolved');
  pushDebugEvent(store, event);
  expect(store.debugIncidents.get(incident.fingerprint)).toMatchObject({
    state: 'unread',
    count: 3,
  });
});

test('debug timeline enforces per-event and aggregate byte limits', () => {
  const store = createRelayStore('relay-test');
  expect(() => pushDebugEvent(store, {
    event: 'debug_event',
    details: { blob: 'x'.repeat(MAX_DEBUG_EVENT_BYTES) },
  })).toThrow('DEBUG_EVENT_TOO_LARGE');
  expect(store).toMatchObject({ debugId: 0, debugEventBytes: 0 });
  expect(store.debugEvents).toHaveLength(0);
  expect(store.debugEventByteLengths).toHaveLength(0);
  expect(store.debugIncidents.size).toBe(0);

  for (let index = 0; index < 150; index += 1) {
    pushDebugEvent(store, {
      event: 'debug_event',
      reason: `BOUNDED_${index}`,
      details: { blob: 'y'.repeat(60 * 1024) },
    });
  }
  expect(store.debugEventBytes).toBeLessThanOrEqual(MAX_DEBUG_TIMELINE_BYTES);
  expect(store.debugEvents.length).toBeLessThan(150);
  expect(store.debugEvents.length).toBe(store.debugEventByteLengths.length);
  expect(store.debugEvents.at(-1)?.reason).toBe('BOUNDED_149');

  const lastId = store.debugId;
  clearDebugTimeline(store);
  expect(store.debugEvents).toHaveLength(0);
  expect(store.debugEventByteLengths).toHaveLength(0);
  expect(store.debugEventBytes).toBe(0);
  expect(store.debugId).toBe(lastId);
});

test('transient delivery failures do not become unresolved incidents', () => {
  const store = createRelayStore('relay-test');
  pushDebugEvent(store, {
    event: 'delivery',
    status: 'rejected',
    reason: 'ENTITY_INPUT_TARGET_NOT_CONNECTED',
  });
  expect(store.debugIncidents.size).toBe(0);
});

const makeProfile = (suffix: string, updatedAt = 1): Profile => {
  const signingSeed = `relay-store-profile:${suffix}`;
  const entityId = deriveSingleSignerFixtureEntityId(signingSeed);
  const profile = buildCryptographicProfileFixture({
    entityId,
    signingSeed,
    name: `Entity ${suffix}`,
    lastUpdated: updatedAt,
  });
  return certifySingleSignerProfileFixture(profile, signingSeed);
};

test('relay delivery events expose typed retry and fatal semantics', () => {
  expect(classifyRelayDeliveryEvent({ status: 'delivered' })).toMatchObject({
    outcome: 'delivered',
    code: 'DELIVERY_ACCEPTED',
    retryable: false,
    fatal: false,
    terminal: true,
  });
  expect(classifyRelayDeliveryEvent({ status: 'queued' })).toMatchObject({
    outcome: 'queued',
    code: 'DELIVERY_QUEUED',
    retryable: true,
    fatal: false,
    terminal: false,
  });
  expect(classifyRelayDeliveryEvent({
    status: 'rejected',
    reason: 'ENTITY_INPUT_TARGET_NOT_CONNECTED',
  })).toMatchObject({
    outcome: 'failed',
    code: 'ENTITY_INPUT_TARGET_NOT_CONNECTED',
    retryable: true,
    fatal: false,
    terminal: false,
    failure: {
      category: 'TransientRace',
      code: 'ENTITY_INPUT_TARGET_NOT_CONNECTED',
    },
  });
  expect(classifyRelayDeliveryEvent({
    status: 'rejected',
    reason: 'ENTITY_INPUT_RECEIPT_TARGET_NOT_CONNECTED',
  })).toMatchObject({
    outcome: 'failed',
    code: 'ENTITY_INPUT_RECEIPT_TARGET_NOT_CONNECTED',
    retryable: true,
    fatal: false,
    terminal: false,
    failure: {
      category: 'TransientRace',
      code: 'ENTITY_INPUT_RECEIPT_TARGET_NOT_CONNECTED',
    },
  });
  expect(classifyRelayDeliveryEvent({
    status: 'local-delivery-failed',
    reason: 'NO_LOCAL_REPLICA: entityId=0xabc',
  })).toMatchObject({
    outcome: 'failed',
    code: 'NO_LOCAL_REPLICA',
    retryable: false,
    fatal: true,
    terminal: true,
    failure: {
      category: 'Contradiction',
      code: 'NO_LOCAL_REPLICA',
    },
  });

  const store = createRelayStore('relay-test');
  pushDebugEvent(store, {
    event: 'delivery',
    status: 'direct-miss-failover',
  });
  expect(store.debugEvents.at(-1)?.delivery).toMatchObject({
    outcome: 'deferred',
    code: 'DELIVERY_DIRECT_MISS_FAILOVER',
    retryable: true,
    fatal: false,
  });
});

test('relay gossip profile cap rejects new profiles without evicting existing ones', () => {
  const store = createRelayStore('relay-test', { maxGossipProfiles: 2 });
  const profileA = makeProfile('a', 1);
  const profileB = makeProfile('b', 2);
  const profileC = makeProfile('c', 3);

  expect(storeVerifiedGossipProfile(store, profileA)).toBe(true);
  expect(storeVerifiedGossipProfile(store, profileB)).toBe(true);
  expect(storeVerifiedGossipProfile(store, profileC)).toBe(false);

  expect(store.gossipProfiles.has(profileA.entityId)).toBe(true);
  expect(store.gossipProfiles.has(profileB.entityId)).toBe(true);
  expect(store.gossipProfiles.has(profileC.entityId)).toBe(false);
  expect(store.debugEvents.some(event => event.reason === 'GOSSIP_PROFILE_CAP_EXCEEDED')).toBe(true);
});
