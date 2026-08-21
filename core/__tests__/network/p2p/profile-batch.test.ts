import { expect, test } from 'bun:test';

import { decodeGossipProfileBatchRequest, selectProfileBatch } from '../../../network/p2p/gossip/profile-batch';
import { RuntimeP2P } from '../../../network/p2p/p2p';
import type { Profile } from '../../../entity/profile';
import { createEmptyEnv } from '../../../runtime';

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

test('gossip_request rejects an uncapped ids array at decode', () => {
  const ids = Array.from({ length: 1001 }, (_, index) => `0x${index.toString(16).padStart(64, '0')}`);
  expect(() => decodeGossipProfileBatchRequest({ ids })).toThrow('P2P_GOSSIP_REQUEST_IDS_INVALID');
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

test('relay sinceSeq cursor returns exactly what was stored after the cursor, regardless of profile clocks', async () => {
  const { createRelayStore, getProfileBatchPage, storeVerifiedGossipProfile } = await import('../../../network/relay/store');
  const store = createRelayStore('0x' + '1'.repeat(40));
  const older = { ...routedProfile(ALICE, false, [H1]), lastUpdated: 10 };
  const newer = { ...routedProfile(BOB, false, [H1]), lastUpdated: 1_000 };
  storeVerifiedGossipProfile(store, newer);
  const cursorAfterNewer = store.gossipSeq;
  storeVerifiedGossipProfile(store, older);
  expect(getProfileBatchPage(store, { set: 'default', sinceSeq: cursorAfterNewer }).profiles.map(p => p.entityId)).toEqual([ALICE]);
  expect(getProfileBatchPage(store, { set: 'default', sinceSeq: store.gossipSeq })).toEqual({
    profiles: [], cursor: store.gossipSeq, hasMore: false,
  });
});

test('relay sequence pages cannot skip profiles beyond one batch', async () => {
  const { createRelayStore, getProfileBatchPage, storeVerifiedGossipProfile } = await import('../../../network/relay/store');
  const store = createRelayStore('0x' + '1'.repeat(40));
  const count = 1_005;
  for (let index = 0; index < count; index += 1) {
    const entityId = `0x${index.toString(16).padStart(64, '0')}`;
    storeVerifiedGossipProfile(store, { ...routedProfile(entityId, false, []), lastUpdated: index + 1 });
  }
  const first = getProfileBatchPage(store, { set: 'default', sinceSeq: 0 });
  if (first.cursor === undefined) throw new Error('TEST_GOSSIP_CURSOR_MISSING');
  const second = getProfileBatchPage(store, { set: 'default', sinceSeq: first.cursor });
  expect(first.profiles).toHaveLength(1_000);
  expect(first.hasMore).toBe(true);
  expect(second.profiles).toHaveLength(5);
  expect(second.cursor).toBe(store.gossipSeq);
  expect(second.hasMore).toBe(false);
  expect(new Set([...first.profiles, ...second.profiles].map(item => item.entityId)).size).toBe(count);
});

test('a full gossip response rewinds the relay-session cursor before continuing pagination', async () => {
  const p2p = new RuntimeP2P({
    env: createEmptyEnv('gossip-cursor-rewind'),
    runtimeId: `0x${'12'.repeat(20)}`,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  const client = { gossipCursor: 5_000 };
  let incrementalRequests = 0;
  const internals = p2p as unknown as {
    handleGossipResponse: (from: string, payload: unknown, client: { gossipCursor: number }) => void;
    requestSeedGossip: (mode: 'incremental' | 'full') => void;
  };
  internals.requestSeedGossip = mode => {
    if (mode === 'incremental') incrementalRequests += 1;
  };

  internals.handleGossipResponse('relay', {
    profiles: [],
    jurisdictions: [],
    cursor: 41,
    hasMore: true,
  }, client);
  await Promise.resolve();

  expect(client.gossipCursor).toBe(41);
  expect(incrementalRequests).toBe(1);
});

test('explicit gossip lookup never advances the directory cursor', async () => {
  const { createRelayStore, getProfileBatchPage, storeVerifiedGossipProfile } = await import('../../../network/relay/store');
  const store = createRelayStore('0x' + '1'.repeat(40));
  storeVerifiedGossipProfile(store, routedProfile(ALICE, false, []));
  expect(getProfileBatchPage(store, { ids: [ALICE] })).toEqual({ profiles: [expect.objectContaining({ entityId: ALICE })] });
});

test('ids with depth pulls the neighbourhood along publicAccounts, bounded by depth', () => {
  const profiles = [
    routedProfile(ALICE, false, [H1]),
    routedProfile(H1, true, [H2]),
    routedProfile(H2, true, [BOB]),
    routedProfile(BOB, false, []),
  ];
  const ids = (depth: number) => selectProfileBatch(profiles, { ids: [ALICE], depth }).map(p => p.entityId).sort();
  expect(ids(1)).toEqual([ALICE]);
  expect(ids(2)).toEqual([ALICE, H1].sort());
  expect(ids(3)).toEqual([ALICE, H1, H2].sort());
  expect(() => decodeGossipProfileBatchRequest({ ids: [ALICE], depth: 4 })).toThrow();
});

test('prefix lookup pages by entityId with an exclusive after cursor', () => {
  const ids = ['0xaa01', '0xaa02', '0xaa03', '0xab01'].map(p => p + '0'.repeat(66 - p.length));
  const profiles = ids.map(id => routedProfile(id, false, []));
  const page1 = selectProfileBatch(profiles, { prefix: '0xaa', limit: 2 }).map(p => p.entityId);
  expect(page1).toEqual([ids[0], ids[1]]);
  const page2 = selectProfileBatch(profiles, { prefix: '0xaa', limit: 2, after: page1[1] }).map(p => p.entityId);
  expect(page2).toEqual([ids[2]]);
  expect(decodeGossipProfileBatchRequest({ prefix: '0xAA01', limit: 100 }).prefix).toBe('0xaa01');
  expect(() => decodeGossipProfileBatchRequest({ prefix: '0xa' })).toThrow();
});
