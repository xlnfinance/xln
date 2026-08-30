import { expect, test } from 'bun:test';
import { LIMITS } from '../../../config/constants';
import { createDefaultDelta } from '../../../account/state/delta';
import {
  buildEntityProfileDescriptor,
  buildChangedEntityProfileHashToSign,
  computeEntityProfileDescriptorHash,
  MAX_ENTITY_PROFILE_DESCRIPTOR_BYTES,
  MAX_PROFILE_ADVERTISED_ACCOUNTS,
} from '../../../entity/profile/profile-descriptor';
import { encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';
import { HANKO_MAX_BYTES } from '../../../hanko/codec';
import type { EntityState } from '../../../entity/types';
import {
  buildCryptographicProfileFixture,
  certifySingleSignerProfileFixture,
  deriveSingleSignerFixtureEntityId,
} from '../../helpers/cryptographic-profile';
import { canonicalizeProfile, parseProfile } from '../../../entity/profile';
import { verifyProfileSignature } from '../../../entity/profile/profile-signing';

const id = (value: number): string => `0x${value.toString(16).padStart(64, '0')}`;
const address = `0x${'11'.repeat(20)}`;
const key = `0x${'22'.repeat(32)}`;

const stateWithAccounts = (entityId: string, accountCount: number, tokenCount: number): EntityState => ({
  entityId,
  entityEncryptionPublicKey: key,
  height: 1,
  timestamp: 1,
  nonces: new Map(),
  proposals: new Map(),
  config: { mode: 'proposer-based', threshold: 1n, validators: [address], shares: { [address]: 1n } },
  reserves: new Map(),
  accounts: new Map(Array.from({ length: accountCount }, (_, accountIndex) => {
    const counterpartyId = id(accountIndex + 2);
    return [counterpartyId, { publicPinned: true, state: {
      leftEntity: entityId < counterpartyId ? entityId : counterpartyId,
      rightEntity: entityId < counterpartyId ? counterpartyId : entityId,
      domain: { chainId: 31_337, depositoryAddress: address },
      deltas: new Map(Array.from({ length: tokenCount }, (_, tokenIndex) => {
        const tokenId = tokenIndex + 1;
        const capacity = 340282366920938463463374607431768211455000n - BigInt(tokenId);
        return [tokenId, createDefaultDelta(tokenId, { left: capacity, right: capacity - 1n })];
      })),
    } }];
  })) as EntityState['accounts'],
  lastFinalizedJHeight: 0,
  profile: { name: 'profile-budget', isHub: false, avatar: '', bio: '', website: '' },
  paybook: { entries: new Map(), feesEarned: 0n },
});

test('profile caps advertised accounts, keeps one best liquid token each, then fills within the byte budget', () => {
  const descriptor = buildEntityProfileDescriptor(stateWithAccounts(id(1), 1_000, 32));
  const bytes = encodeCanonicalConsensusBytes(descriptor).byteLength;
  expect(bytes).toBeLessThanOrEqual(MAX_ENTITY_PROFILE_DESCRIPTOR_BYTES);
  expect(bytes).toBeLessThan(LIMITS.MAX_PROFILE_BYTES);
  expect(descriptor.accounts).toHaveLength(MAX_PROFILE_ADVERTISED_ACCOUNTS);
  expect(descriptor.accounts.every(account => Object.keys(account.tokenCapacities).length >= 1)).toBe(true);
  expect(descriptor.accounts.every(account => Object.keys(account.tokenCapacities).length <= 16)).toBe(true);
  const fullProfile = {
    ...descriptor,
    lastUpdated: Number.MAX_SAFE_INTEGER,
    runtimeId: 'x'.repeat(128),
    runtimeEncPubKey: `0x${'f'.repeat(64)}`,
    runtimeSignature: `0x${'f'.repeat(130)}`,
    wsUrl: `wss://${'x'.repeat(2042)}`,
    relays: Array.from({ length: 8 }, (_, index) => `wss://${index}${'x'.repeat(2041)}`).sort(),
    metadata: {
      ...descriptor.metadata,
      mirrors: Array.from({ length: 16 }, (_, index) => ({
        entityId: id(index + 2_000),
        jurisdiction: {
          name: `${index.toString().padStart(2, '0')}${'x'.repeat(126)}`,
          chainId: Number.MAX_SAFE_INTEGER,
          entityProviderAddress: address,
          depositoryAddress: address,
        },
      })),
      profileHanko: `0x${'ff'.repeat(HANKO_MAX_BYTES)}`,
    },
  };
  expect(encodeCanonicalConsensusBytes(fullProfile).byteLength)
    .toBeLessThanOrEqual(LIMITS.MAX_PROFILE_BYTES);
});

test('profile capacity uses the owning Entity right-side perspective', () => {
  const right = id(9);
  const left = id(1);
  const state = stateWithAccounts(right, 0, 0);
  state.accounts.set(left, { publicPinned: true, state: {
    leftEntity: left,
    rightEntity: right,
    domain: { chainId: 31_337, depositoryAddress: address },
    deltas: new Map([[1, createDefaultDelta(1, { left: 5_432n, right: 20_999n })]]),
  } } as EntityState['accounts'] extends ReadonlyMap<unknown, infer Value> ? Value : never);
  const capacities = buildEntityProfileDescriptor(state).accounts[0]!.tokenCapacities as Record<string, { inCapacity: bigint; outCapacity: bigint }>;
  // Advertised capacities are floored to the profile granularity (000) so a
  // small payment never shows up as a capacity delta.
  expect(capacities['1']).toEqual({ inCapacity: 5_000n, outCapacity: 20_000n });
});

test('profile descriptor canonicalizes configured contract addresses before signing', () => {
  const state = stateWithAccounts(id(1), 0, 0);
  state.config.jurisdiction = {
    name: 'checksum-addresses',
    chainId: 31_337,
    entityProviderAddress: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
    depositoryAddress: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
  };
  expect(buildEntityProfileDescriptor(state).metadata.jurisdiction).toEqual({
    name: 'checksum-addresses',
    chainId: 31_337,
    entityProviderAddress: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0',
    depositoryAddress: '0x0165878a594ca255338adfa4d48449f69242eb8f',
  });
});

test('profile hash witness changes only with the final descriptor, even after in-place state mutation', () => {
  const state = stateWithAccounts(id(1), 1, 1);
  const previous = computeEntityProfileDescriptorHash(buildEntityProfileDescriptor(state));
  expect(buildChangedEntityProfileHashToSign(state, previous)).toBeNull();
  state.profile.name = 'mutated-final-profile';
  const changed = buildChangedEntityProfileHashToSign(state, previous);
  expect(changed?.type).toBe('profile');
  expect(changed?.hash).not.toBe(previous);
  expect(buildChangedEntityProfileHashToSign(state, changed!.hash)).toBeNull();
});

test('certified route authority comes from the verified Hanko claim, never an embedded board copy', async () => {
  const seed = 'profile-authority-option-b';
  const entityId = deriveSingleSignerFixtureEntityId(seed);
  const certified = certifySingleSignerProfileFixture(buildCryptographicProfileFixture({
    entityId,
    signingSeed: seed,
    name: 'authority',
  }), seed);
  expect((await verifyProfileSignature(certified)).valid).toBe(true);
  const forged = structuredClone(certified) as unknown as { metadata: Record<string, unknown> };
  forged.metadata['board'] = {
    threshold: 1,
    validators: [{ signer: address, signerId: address, weight: 1, publicKey: `0x04${'44'.repeat(64)}` }],
  };
  expect(() => parseProfile(forged)).toThrow('GOSSIP_PROFILE_METADATA_UNKNOWN_FIELD');
});

test('signed gossip profile taxonomy accepts only canonical kinds and sorted sectors', () => {
  const profile = structuredClone(buildCryptographicProfileFixture({
    entityId: deriveSingleSignerFixtureEntityId('profile-taxonomy'),
    signingSeed: 'profile-taxonomy',
    name: 'taxonomy',
  })) as unknown as { metadata: Record<string, unknown> };
  profile.metadata['entityKind'] = 'company';
  profile.metadata['sectors'] = ['finance', 'technology'];
  expect(parseProfile(profile).metadata).toMatchObject({
    entityKind: 'company',
    sectors: ['finance', 'technology'],
  });
  profile.metadata['sectors'] = ['technology', 'finance'];
  expect(() => parseProfile(profile)).toThrow('GOSSIP_PROFILE_ENTITY_SECTORS_NONCANONICAL');
  profile.metadata['sectors'] = ['technology'];
  profile.metadata['entityKind'] = 'tech-company';
  expect(() => parseProfile(profile)).toThrow('GOSSIP_PROFILE_ENTITY_KIND_INVALID');
});

test('an Account is advertised only while it is pinned', () => {
  const state = stateWithAccounts(id(1), 3, 2);
  const counterparties = [...state.accounts.keys()];
  expect(buildEntityProfileDescriptor(state).accounts).toHaveLength(3);
  const unpinned = state.accounts.get(counterparties[1]!)!;
  delete (unpinned as { publicPinned?: boolean }).publicPinned;
  const advertised = buildEntityProfileDescriptor(state).accounts.map(account => account.counterpartyId);
  expect(advertised).toEqual([counterparties[0]!, counterparties[2]!].sort());
});

test('over the ceiling the most liquid pinned Accounts win, identically on every replica', () => {
  const state = stateWithAccounts(id(1), MAX_PROFILE_ADVERTISED_ACCOUNTS + 5, 1);
  const starved = [...state.accounts.keys()].slice(0, 5);
  for (const counterpartyId of starved) {
    const account = state.accounts.get(counterpartyId)!;
    (account.state as { deltas: Map<number, unknown> }).deltas = new Map([
      [1, createDefaultDelta(1, { left: 1n, right: 1n })],
    ]);
  }
  const advertised = buildEntityProfileDescriptor(state).accounts.map(account => account.counterpartyId);
  expect(advertised).toHaveLength(MAX_PROFILE_ADVERTISED_ACCOUNTS);
  expect(advertised.some(counterpartyId => starved.includes(counterpartyId))).toBe(false);
});

test('canonicalizeProfile is identity on a gossip-cached output', () => {
  const canonical = buildCryptographicProfileFixture({
    entityId: deriveSingleSignerFixtureEntityId('hlt-profile-cache'),
    signingSeed: 'hlt-profile-cache',
    name: 'cached',
  });
  expect(canonicalizeProfile(canonical)).toBe(canonical);
  expect(Object.isFrozen(canonical)).toBe(true);
  expect(Object.isFrozen(canonical.accounts)).toBe(true);
  expect(Object.isFrozen(canonical.metadata)).toBe(true);
  expect(() => {
    canonical.lastUpdated += 1;
  }).toThrow();
  expect(parseProfile(canonical)).toBe(canonical);
});
