import { keccak256 } from 'ethers';
import { deriveDelta } from '../../account/utils';
import { getAccountPerspective } from '../../account/state/perspective';
import type { EntityState } from '../types';
import { compareStableText, serializeTaggedJson } from '../../protocol/serialization';
import { LIMITS } from '../../config/constants';
import { HANKO_MAX_BYTES } from '../../hanko/codec';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import type {
  Profile,
  ProfileAccount,
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
    ...(jurisdiction.entityProviderAddress ? { entityProviderAddress: jurisdiction.entityProviderAddress } : {}),
    ...(jurisdiction.depositoryAddress ? { depositoryAddress: jurisdiction.depositoryAddress } : {}),
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

const MAX_PROFILE_ROUTE_OVERHEAD_BYTES = new TextEncoder().encode(encodeCanonicalConsensusValue({
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
})).byteLength;

export const MAX_ENTITY_PROFILE_DESCRIPTOR_BYTES = LIMITS.MAX_PROFILE_BYTES - MAX_PROFILE_ROUTE_OVERHEAD_BYTES;

const rankedLiquidProfileCapacities = (
  state: EntityState,
  account: EntityState['accounts'] extends Map<unknown, infer Value> ? Value : never,
): Array<{ tokenId: string; capacity: ProfileTokenCapacity; liquidity: bigint }> =>
  [...account.state.deltas.entries()]
    .map(([tokenId, delta]) => {
      const derived = deriveDelta(delta, getAccountPerspective(account.state, state.entityId).iAmLeft);
      const capacity = { inCapacity: derived.inCapacity, outCapacity: derived.outCapacity };
      return { tokenId: String(tokenId), capacity, liquidity: capacity.inCapacity + capacity.outCapacity };
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
  const publicAccounts: string[] = [];
  const extras: Array<{ counterpartyId: string; tokenId: string; capacity: ProfileTokenCapacity; liquidity: bigint }> = [];
  for (const [counterpartyId, account] of state.accounts.entries()) {
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
    new TextEncoder().encode(encodeCanonicalConsensusValue(descriptor)).byteLength;
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
  keccak256(new TextEncoder().encode(serializeTaggedJson(descriptor)));

export const buildChangedEntityProfileHashToSign = (
  state: EntityState,
  previousProfileHash: string | null,
): { hash: string; type: 'profile'; context: string } | null => {
  const hash = computeEntityProfileDescriptorHash(buildEntityProfileDescriptor(state));
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
