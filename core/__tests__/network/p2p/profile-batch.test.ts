import { expect, test } from 'bun:test';

import { decodeGossipProfileBatchRequest, selectProfileBatch } from '../../../network/p2p/gossip/profile-batch';
import type { Profile } from '../../../entity/profile';

const profile = (index: number): Profile => ({
  entityId: `entity-${index}`,
  runtimeId: `runtime-${index}`,
  wsUrl: null,
  relays: [],
  lastUpdated: index,
  metadata: { isHub: false },
}) as Profile;

test('gossip batch caps explicit ids and never exceeds the server limit', () => {
  const profiles = Array.from({ length: 8 }, (_, index) => profile(index));
  const selected = selectProfileBatch(
    profiles,
    { ids: profiles.map(item => item.entityId), limit: 100 },
    3,
  );

  expect(selected).toHaveLength(3);
  expect(selected.map(item => item.entityId)).toEqual(['entity-2', 'entity-1', 'entity-0']);
});

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const H1 = '0x1111111111111111111111111111111111111111111111111111111111111111';
const H2 = '0x2222222222222222222222222222222222222222222222222222222222222222';

const routedProfile = (
  entityId: string,
  isHub: boolean,
  peers: string[],
): Profile => ({
  entityId,
  entityEncryptionPublicKey: `0x${entityId.slice(2, 66)}`,
  runtimeId: entityId.slice(0, 42),
  name: entityId.slice(0, 6),
  avatar: '',
  bio: '',
  website: '',
  lastUpdated: 1,
  runtimeEncPubKey: `0x${entityId.slice(2, 66)}`,
  publicAccounts: peers,
  wsUrl: null,
  relays: [],
  metadata: { routingFeePPM: 10, baseFee: 0n, isHub },
  accounts: peers.map(counterpartyId => ({
    counterpartyId,
    domain: { chainId: 31_337, depositoryAddress: '0x1111111111111111111111111111111111111111' },
    tokenCapacities: { 1: { outCapacity: 1_000_000n, inCapacity: 1_000_000n } },
  })),
});

test('routeTo returns the profile chains that route source to target (and nothing else)', () => {
  const profiles = [
    routedProfile(ALICE, false, [H1]),
    routedProfile(BOB, false, [H1]),
    routedProfile(CAROL, false, [H2]),
    routedProfile(H1, true, []),
    routedProfile(H2, true, []),
  ];
  const selected = selectProfileBatch(profiles, {
    routeTo: { source: ALICE, target: BOB, tokenId: 1, amount: 10n, maxRoutes: 50 },
  });
  expect(selected.map(item => item.entityId).sort()).toEqual([H1, BOB].sort());
});

test('routeTo with unknown route still returns the target profile', () => {
  const profiles = [routedProfile(ALICE, false, [H1]), routedProfile(CAROL, false, [H2]), routedProfile(H1, true, [])];
  const selected = selectProfileBatch(profiles, { routeTo: { source: ALICE, target: CAROL } });
  expect(selected.map(item => item.entityId)).toEqual([CAROL]);
});

test('routeTo decodes from the wire with a decimal amount and rejects unknown keys', () => {
  const decoded = decodeGossipProfileBatchRequest({
    routeTo: { source: ALICE.toUpperCase(), target: BOB, tokenId: 1, amount: '123', maxRoutes: 500 },
  });
  expect(decoded.routeTo).toEqual({ source: ALICE, target: BOB, tokenId: 1, amount: 123n, maxRoutes: 50 });
  expect(() => decodeGossipProfileBatchRequest({ routeTo: { source: ALICE, target: BOB, extra: 1 } })).toThrow();
  expect(() => decodeGossipProfileBatchRequest({ routeTo: { source: ALICE, target: BOB, amount: -1 } })).toThrow();
});
