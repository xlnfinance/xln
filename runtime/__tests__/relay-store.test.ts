import { expect, test } from 'bun:test';
import {
  classifyRelayDeliveryEvent,
  createRelayStore,
  deliverPendingMessages,
  enqueueMessage,
  flushPendingMessages,
  isRelaySendResultFailure,
  pushDebugEvent,
  storeVerifiedGossipProfile,
} from '../relay/store';
import type { Profile } from '../networking/gossip';

const asRecords = (items: unknown[]): Array<Record<string, unknown>> => items as Array<Record<string, unknown>>;

test('relay send result predicate matches websocket failure contract', () => {
  expect(isRelaySendResultFailure(false)).toBe(true);
  expect(isRelaySendResultFailure(-1)).toBe(true);
  expect(isRelaySendResultFailure(true)).toBe(false);
  expect(isRelaySendResultFailure(0)).toBe(false);
  expect(isRelaySendResultFailure(1)).toBe(false);
  expect(isRelaySendResultFailure()).toBe(false);
});

const makeProfile = (suffix: string, updatedAt = 1): Profile => ({
  entityId: `0x${suffix.padStart(40, '0')}`,
  name: `Entity ${suffix}`,
  avatar: '',
  bio: '',
  website: '',
  lastUpdated: updatedAt,
  runtimeId: `0x${suffix.padStart(40, '1')}`,
  runtimeEncPubKey: `0x${suffix.padStart(64, '2')}`,
  publicAccounts: [],
  wsUrl: null,
  relays: [],
  metadata: {
    entityEncPubKey: `0x${suffix.padStart(64, '3')}`,
    isHub: false,
    routingFeePPM: 1,
    baseFee: 0n,
    board: {
      threshold: 1,
      validators: [{ signer: `0x${suffix.padStart(40, '4')}`, signerId: '1', publicKey: `0x${suffix.padStart(64, '5')}`, weight: 1 }],
    },
  },
  accounts: [],
});

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

  expect(storeVerifiedGossipProfile(store, makeProfile('a', 1))).toBe(true);
  expect(storeVerifiedGossipProfile(store, makeProfile('b', 2))).toBe(true);
  expect(storeVerifiedGossipProfile(store, makeProfile('c', 3))).toBe(false);

  expect(store.gossipProfiles.has('0x000000000000000000000000000000000000000a')).toBe(true);
  expect(store.gossipProfiles.has('0x000000000000000000000000000000000000000b')).toBe(true);
  expect(store.gossipProfiles.has('0x000000000000000000000000000000000000000c')).toBe(false);
  expect(store.debugEvents.some(event => event.reason === 'GOSSIP_PROFILE_CAP_EXCEEDED')).toBe(true);
});
