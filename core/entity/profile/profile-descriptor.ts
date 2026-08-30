import { keccakBytesHash } from '../../protocol/crypto/keccak-text';
import { deriveDelta } from '../../account/utils';
import { getAccountPerspective } from '../../account/state/perspective';
import type { EntityState } from '../types';
import { PersistentEntityAccountMap } from '../state/persistent-account-map';
import { compareStableText } from '../../protocol/serialization';
import { LIMITS } from '../../config/constants';
import { HANKO_MAX_BYTES } from '../../hanko/codec';
import { encodeCanonicalConsensusBytes } from '../../protocol/serialization/binary-codec';
import { RecencyMemo } from '../../support/collections/recency-memo';
import type {
  Profile,
  ProfileAccount,
  ProfileEntityKind,
  ProfileEntitySector,
  ProfileJurisdiction,
  ProfileTokenCapacity,
} from './';

export type EntityProfileDescriptor = Readonly<{
  entityId: string;
  entityEncryptionPublicKey: string;
  name: string;
  avatar: string;
  bio: string;
  website: string;
  publicAccounts: string[];
  accounts: ProfileAccount[];
  metadata: Readonly<{
    isHub: boolean;
    entityKind?: ProfileEntityKind;
    sectors?: ProfileEntitySector[];
    routingFeePPM: number;
    baseFee: bigint;
    swapTakerFeeBps?: number;
    jurisdiction?: ProfileJurisdiction;
    hubName?: string;
    policyVersion?: number;
    rebalanceBaseFee?: string;
    rebalanceLiquidityFeeBps?: string;
    rebalanceGasFee?: string;
    rebalanceTimeoutMs?: number;
  }>;
}>;

const profileJurisdiction = (state: EntityState): ProfileJurisdiction | undefined => {
  const jurisdiction = state.config.jurisdiction;
  const name = String(jurisdiction?.name || '').trim();
  if (!jurisdiction || !name) return undefined;
  return {
    name,
    ...(jurisdiction.chainId !== undefined ? { chainId: jurisdiction.chainId } : {}),
    ...(jurisdiction.entityProviderAddress
      ? { entityProviderAddress: jurisdiction.entityProviderAddress.toLowerCase() }
      : {}),
    ...(jurisdiction.depositoryAddress
      ? { depositoryAddress: jurisdiction.depositoryAddress.toLowerCase() }
      : {}),
  };
};

const compareTokenId = (left: string, right: string): number => {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return compareStableText(left, right);
};

const MAX_PROFILE_TOKENS_PER_ACCOUNT = 16;
/**
 * Hard ceiling on advertised Accounts, independent of how many an Entity owns.
 *
 * The Profile is gossiped to every peer and stored as one entity-context leaf,
 * so a row per Account made a Hub's Profile grow without bound: at ~34 accounts
 * it already exceeded the 10 KB storage leaf and fatally halted every observing
 * Runtime. Routing only ever needs the hub-to-hub graph, so only pinned
 * Accounts are advertised and never more than this many of them.
 */
export const MAX_PROFILE_ADVERTISED_ACCOUNTS = 100;
const MAX_PROFILE_ROUTE_OVERHEAD_BYTES = encodeCanonicalConsensusBytes({
  lastUpdated: Number.MAX_SAFE_INTEGER,
  runtimeId: 'x'.repeat(128),
  runtimeEncPubKey: `0x${'f'.repeat(64)}`,
  runtimeSignature: `0x${'f'.repeat(130)}`,
  wsUrl: `wss://${'x'.repeat(2042)}`,
  relays: Array.from({ length: 8 }, () => `wss://${'x'.repeat(2042)}`),
  mirrors: Array.from({ length: 16 }, (_, index) => ({
    entityId: `0x${index.toString(16).padStart(64, '0')}`,
    jurisdiction: {
      name: 'x'.repeat(128),
      chainId: Number.MAX_SAFE_INTEGER,
      entityProviderAddress: `0x${'f'.repeat(40)}`,
      depositoryAddress: `0x${'f'.repeat(40)}`,
    },
  })),
  profileHanko: `0x${'ff'.repeat(HANKO_MAX_BYTES)}`,
}).byteLength;

export const MAX_ENTITY_PROFILE_DESCRIPTOR_BYTES = LIMITS.MAX_PROFILE_BYTES - MAX_PROFILE_ROUTE_OVERHEAD_BYTES;

/** Advertised profile capacities are floored to a multiple of this (privacy: no per-payment leak). */
const PROFILE_CAPACITY_GRANULARITY = 1000n;
const floorProfileCapacity = (value: bigint): bigint =>
  value <= 0n ? 0n : value - (value % PROFILE_CAPACITY_GRANULARITY);

const rankedLiquidProfileCapacities = (
  state: EntityState,
  account: EntityState['accounts'] extends ReadonlyMap<unknown, infer Value> ? Value : never,
): Array<{ tokenId: string; capacity: ProfileTokenCapacity; liquidity: bigint }> =>
  [...account.state.deltas.entries()]
    .map(([tokenId, delta]) => {
      const derived = deriveDelta(delta, getAccountPerspective(account.state, state.entityId).iAmLeft);
      // Advertised capacities are floored to the profile granularity so small
      // transfers do not leak through capacity deltas; inclusion still follows
      // the raw liquidity so topology rows stay stable across payments.
      const capacity = {
        inCapacity: floorProfileCapacity(derived.inCapacity),
        outCapacity: floorProfileCapacity(derived.outCapacity),
      };
      return { tokenId: String(tokenId), capacity, liquidity: derived.inCapacity + derived.outCapacity };
    })
    .filter(candidate => candidate.liquidity > 0n)
    .sort((left, right) =>
      left.liquidity === right.liquidity
        ? compareTokenId(left.tokenId, right.tokenId)
        : left.liquidity > right.liquidity ? -1 : 1)
    .slice(0, MAX_PROFILE_TOKENS_PER_ACCOUNT);

const buildProfileAccounts = (state: EntityState): {
  accounts: ProfileAccount[];
  publicAccounts: string[];
  extras: Array<{ counterpartyId: string; tokenId: string; capacity: ProfileTokenCapacity; liquidity: bigint }>;
} => {
  const accounts: ProfileAccount[] = [];
  let publicAccounts: string[] = [];
  let extras: Array<{ counterpartyId: string; tokenId: string; capacity: ProfileTokenCapacity; liquidity: bigint }> = [];
  for (const [counterpartyId, account] of state.accounts.entries()) {
    // Unpinned Accounts are invisible to routing by construction: only the side
    // that opened an Account pins it, so the advertised graph stays hub-to-hub.
    if (account.publicPinned !== true) continue;
    const ranked = rankedLiquidProfileCapacities(state, account);
    if (ranked.length === 0) continue;
    const first = ranked[0]!;
    const capacities = { [first.tokenId]: first.capacity };
    extras.push(...ranked.slice(1).map(candidate => ({ counterpartyId, ...candidate })));
    const hasInboundCapacity = Object.values(capacities).some(capacity => capacity.inCapacity > 0n);
    accounts.push({
      counterpartyId,
      domain: account.state.domain,
      tokenCapacities: capacities,
    });
    if (hasInboundCapacity) publicAccounts.push(counterpartyId);
  }
  // Over the ceiling the most liquid rows are the ones worth routing through,
  // and the tie-break keeps the choice identical on every replica.
  if (accounts.length > MAX_PROFILE_ADVERTISED_ACCOUNTS) {
    const liquidityByCounterparty = new Map(
      accounts.map(entry => [
        entry.counterpartyId,
        Object.values(entry.tokenCapacities as Record<string, ProfileTokenCapacity>)
          .reduce((total, capacity) => total + capacity.inCapacity + capacity.outCapacity, 0n),
      ]),
    );
    accounts.sort((left, right) => {
      const leftLiquidity = liquidityByCounterparty.get(left.counterpartyId)!;
      const rightLiquidity = liquidityByCounterparty.get(right.counterpartyId)!;
      if (leftLiquidity !== rightLiquidity) return leftLiquidity > rightLiquidity ? -1 : 1;
      return compareStableText(left.counterpartyId, right.counterpartyId);
    });
    accounts.length = MAX_PROFILE_ADVERTISED_ACCOUNTS;
    const advertised = new Set(accounts.map(entry => entry.counterpartyId));
    publicAccounts = publicAccounts.filter(counterpartyId => advertised.has(counterpartyId));
    extras = extras.filter(extra => advertised.has(extra.counterpartyId));
  }
  accounts.sort((left, right) => compareStableText(left.counterpartyId, right.counterpartyId));
  publicAccounts.sort(compareStableText);
  extras.sort((left, right) => left.liquidity === right.liquidity
    ? compareStableText(left.counterpartyId, right.counterpartyId) || compareTokenId(left.tokenId, right.tokenId)
    : left.liquidity > right.liquidity ? -1 : 1);
  return { accounts, publicAccounts, extras };
};

export const buildEntityProfileDescriptor = (
  state: EntityState,
): EntityProfileDescriptor => {
  const { accounts, publicAccounts, extras } = buildProfileAccounts(state);
  const hubConfig = state.hubRebalanceConfig;
  const isHub = state.profile.isHub === true;
  const jurisdiction = profileJurisdiction(state);
  const base = {
    entityId: state.entityId.toLowerCase(),
    entityEncryptionPublicKey: state.entityEncryptionPublicKey,
    name: String(state.profile.name || '').trim(),
    avatar: state.profile.avatar,
    bio: state.profile.bio,
    website: state.profile.website,
    publicAccounts,
    accounts,
    metadata: {
      isHub,
      ...(state.profile.entityKind ? { entityKind: state.profile.entityKind } : {}),
      ...(state.profile.sectors?.length ? { sectors: [...state.profile.sectors] } : {}),
      routingFeePPM: hubConfig?.routingFeePPM ?? 1,
      baseFee: hubConfig?.baseFee ?? 0n,
      ...(hubConfig?.swapTakerFeeBps !== undefined ? { swapTakerFeeBps: hubConfig.swapTakerFeeBps } : {}),
      ...(jurisdiction ? { jurisdiction } : {}),
      ...(isHub && hubConfig
        ? {
            ...(hubConfig.hubName ? { hubName: hubConfig.hubName } : {}),
            policyVersion: hubConfig.policyVersion,
            ...(hubConfig.rebalanceBaseFee !== undefined
              ? { rebalanceBaseFee: String(hubConfig.rebalanceBaseFee) }
              : {}),
            rebalanceLiquidityFeeBps: String(hubConfig.rebalanceLiquidityFeeBps),
            rebalanceGasFee: String(hubConfig.rebalanceGasFee ?? 0n),
            rebalanceTimeoutMs: hubConfig.rebalanceTimeoutMs ?? 10 * 60 * 1000,
          }
        : {}),
    },
  } satisfies EntityProfileDescriptor;
  const withExtraPrefix = (count: number): EntityProfileDescriptor => {
    const byCounterparty = new Map(base.accounts.map(account => [account.counterpartyId, {
      ...account,
      tokenCapacities: { ...(account.tokenCapacities as Record<string, ProfileTokenCapacity>) },
    }]));
    for (const extra of extras.slice(0, count)) {
      (byCounterparty.get(extra.counterpartyId)!.tokenCapacities as Record<string, ProfileTokenCapacity>)[extra.tokenId] = extra.capacity;
    }
    return { ...base, accounts: [...byCounterparty.values()].map(account => ({
      ...account,
      tokenCapacities: Object.fromEntries(Object.entries(account.tokenCapacities).sort(([left], [right]) => compareTokenId(left, right))),
    })) };
  };
  const bytes = (descriptor: EntityProfileDescriptor): number =>
    encodeCanonicalConsensusBytes(descriptor).byteLength;
  // Common case: every ranked capacity fits. This is exactly the value the
  // binary search below converges to, found with one encode instead of log2(n)+1.
  const full = withExtraPrefix(extras.length);
  if (bytes(full) <= MAX_ENTITY_PROFILE_DESCRIPTOR_BYTES) return full;
  if (bytes(base) > MAX_ENTITY_PROFILE_DESCRIPTOR_BYTES) {
    throw new Error(`ENTITY_PROFILE_REQUIRED_CAPACITY_BUDGET_EXCEEDED:${bytes(base)}:${MAX_ENTITY_PROFILE_DESCRIPTOR_BYTES}`);
  }
  let low = 0;
  let high = extras.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(withExtraPrefix(middle)) <= MAX_ENTITY_PROFILE_DESCRIPTOR_BYTES) low = middle;
    else high = middle - 1;
  }
  return withExtraPrefix(low);
};

export const computeEntityProfileDescriptorHash = (descriptor: EntityProfileDescriptor): string =>
  keccakBytesHash(encodeCanonicalConsensusBytes(descriptor));

/**
 * The descriptor walks every Account; the hub rebuilt it four times per
 * R-frame (before/after apply, dispatch witness check, gossip). Committed
 * Account maps are immutable, so the hash is memoized by the exact inputs the
 * descriptor reads; a live candidate map is never cached.
 */
type ProfileHashMemo = { accounts: unknown; profile: unknown; hubConfig: unknown; config: unknown; key: unknown; hash: string };
const profileHashMemos = new RecencyMemo<EntityState, ProfileHashMemo>(256);

export const computeEntityProfileHash = (state: EntityState): string => {
  const accounts = state.accounts;
  const cacheable = accounts instanceof PersistentEntityAccountMap;
  const memo = cacheable ? profileHashMemos.get(state) : undefined;
  if (
    memo &&
    memo.accounts === accounts &&
    memo.profile === state.profile &&
    memo.hubConfig === state.hubRebalanceConfig &&
    memo.config === state.config &&
    memo.key === state.entityEncryptionPublicKey
  ) return memo.hash;
  const hash = computeEntityProfileDescriptorHash(buildEntityProfileDescriptor(state));
  if (cacheable) {
    profileHashMemos.set(state, {
      accounts,
      profile: state.profile,
      hubConfig: state.hubRebalanceConfig,
      config: state.config,
      key: state.entityEncryptionPublicKey,
      hash,
    });
  }
  return hash;
};

export const buildChangedEntityProfileHashToSign = (
  state: EntityState,
  previousProfileHash: string | null,
): { hash: string; type: 'profile'; context: string } | null => {
  const hash = computeEntityProfileHash(state);
  return previousProfileHash === hash ? null : { hash, type: 'profile', context: `profile:${hash}` };
};

export const profileToEntityProfileDescriptor = (profile: Profile): EntityProfileDescriptor => {
  const metadata = profile.metadata;
  return {
    entityId: profile.entityId,
    entityEncryptionPublicKey: profile.entityEncryptionPublicKey,
    name: profile.name,
    avatar: profile.avatar,
    bio: profile.bio,
    website: profile.website,
    publicAccounts: profile.publicAccounts,
    accounts: profile.accounts,
    metadata: {
      isHub: metadata.isHub,
      ...(metadata.entityKind ? { entityKind: metadata.entityKind } : {}),
      ...(metadata.sectors?.length ? { sectors: [...metadata.sectors] } : {}),
      routingFeePPM: metadata.routingFeePPM,
      baseFee: metadata.baseFee,
      ...(metadata.swapTakerFeeBps !== undefined ? { swapTakerFeeBps: metadata.swapTakerFeeBps } : {}),
      ...(metadata.jurisdiction ? { jurisdiction: metadata.jurisdiction } : {}),
      ...(metadata.hubName ? { hubName: metadata.hubName } : {}),
      ...(metadata.policyVersion !== undefined ? { policyVersion: metadata.policyVersion } : {}),
      ...(metadata.rebalanceBaseFee ? { rebalanceBaseFee: metadata.rebalanceBaseFee } : {}),
      ...(metadata.rebalanceLiquidityFeeBps ? { rebalanceLiquidityFeeBps: metadata.rebalanceLiquidityFeeBps } : {}),
      ...(metadata.rebalanceGasFee ? { rebalanceGasFee: metadata.rebalanceGasFee } : {}),
      ...(metadata.rebalanceTimeoutMs !== undefined ? { rebalanceTimeoutMs: metadata.rebalanceTimeoutMs } : {}),
    },
  };
};
