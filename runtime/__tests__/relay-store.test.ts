import { expect, test } from 'bun:test';
import { createRelayStore, enqueueMessage, flushPendingMessages, storeVerifiedGossipProfile } from '../relay-store';
import type { Profile } from '../networking/gossip';

const asRecords = (items: unknown[]): Array<Record<string, unknown>> => items as Array<Record<string, unknown>>;

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
