import { expect, test } from 'bun:test';
import {
  classifyRelayDeliveryEvent,
  createRelayStore,
  deliverPendingMessages,
  enqueueMessage,
  flushPendingMessages,
  isRelaySendResultFailure,
  pushDebugEvent,
  setDebugIncidentState,
  storeVerifiedGossipProfile,
} from '../relay/store';
import type { Profile } from '../networking/gossip';
import {
  buildCryptographicProfileFixture,
  certifySingleSignerProfileFixture,
  deriveSingleSignerFixtureEntityId,
} from './helpers/cryptographic-profile';

const asRecords = (items: unknown[]): Array<Record<string, unknown>> => items as Array<Record<string, unknown>>;

test('relay send result predicate matches websocket failure contract', () => {
  expect(isRelaySendResultFailure(false)).toBe(true);
  expect(isRelaySendResultFailure(-1)).toBe(true);
  expect(isRelaySendResultFailure(true)).toBe(false);
  expect(isRelaySendResultFailure(0)).toBe(false);
  expect(isRelaySendResultFailure(1)).toBe(false);
  expect(isRelaySendResultFailure()).toBe(false);
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

test('relay pending queue enforces total bytes and target caps', () => {
  const store = createRelayStore('relay-test', {
    pendingLimits: {
      maxPerTarget: 2,
      maxTargets: 2,
      maxTotalBytes: 90,
    },
  });

  expect(enqueueMessage(store, 'runtime-a', { n: 1, payload: 'aaaaa' })).toBe(1);
  expect(enqueueMessage(store, 'runtime-a', { n: 2, payload: 'bbbbb' })).toBe(2);
  expect(enqueueMessage(store, 'runtime-a', { n: 3, payload: 'ccccc' })).toBe(2);
  expect(asRecords(flushPendingMessages(store, 'runtime-a')).map(msg => msg['n'])).toEqual([2, 3]);
  expect(store.pendingMessageBytes).toBe(0);

  enqueueMessage(store, 'runtime-a', { payload: 'x'.repeat(20) });
  enqueueMessage(store, 'runtime-b', { payload: 'y'.repeat(20) });
  expect(enqueueMessage(store, 'runtime-c', { payload: 'z'.repeat(20) })).toBe(0);
  expect(store.pendingMessages.has('runtime-a')).toBe(true);
  expect(store.pendingMessages.has('runtime-b')).toBe(true);
  expect(store.pendingMessages.has('runtime-c')).toBe(false);

  expect(enqueueMessage(store, 'runtime-a', { payload: 'too-large-for-cap'.repeat(10) })).toBe(1);
  expect(store.debugEvents.some(event => event.reason === 'PENDING_MESSAGE_TOO_LARGE')).toBe(true);
});

test('relay pending queue rejects payloads that cannot be measured canonically', () => {
  const store = createRelayStore('relay-test');
  const unreadable = new Proxy({}, {
    ownKeys: () => {
      throw new Error('PAYLOAD_KEYS_UNREADABLE');
    },
  });

  expect(() => enqueueMessage(store, 'runtime-a', unreadable)).toThrow('SAFE_STRINGIFY_FAILED');
  expect(store.pendingMessages.size).toBe(0);
  expect(store.pendingMessageBytes).toBe(0);
});

test('relay pending delivery retains current and later messages when send fails', () => {
  const store = createRelayStore('relay-test');
  const delivered: unknown[] = [];

  enqueueMessage(store, 'runtime-a', { n: 1 });
  enqueueMessage(store, 'runtime-a', { n: 2 });
  enqueueMessage(store, 'runtime-a', { n: 3 });

  const failed = deliverPendingMessages(store, 'runtime-a', (msg) => {
    const record = msg as { n?: number };
    if (record.n === 2) return false;
    delivered.push(msg);
    return true;
  });

  expect(failed).toMatchObject({
    delivered: 1,
    expired: 0,
    retained: 2,
    failure: {
      reason: 'RELAY_PENDING_SEND_FAILED',
    },
  });
  expect(asRecords(delivered).map(msg => msg['n'])).toEqual([1]);
  expect(asRecords(flushPendingMessages(store, 'runtime-a')).map(msg => msg['n'])).toEqual([2, 3]);
  expect(store.pendingMessageBytes).toBe(0);
});

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
    status: 'direct-miss-fallback',
  });
  expect(store.debugEvents.at(-1)?.delivery).toMatchObject({
    outcome: 'deferred',
    code: 'DELIVERY_DIRECT_MISS_FALLBACK',
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
