import { keccak256 } from 'ethers';
import { deriveDelta, isLeft } from '../account/utils';
import type { EntityState } from '../types';
import { compareStableText, serializeTaggedJson } from '../protocol/serialization';
import type { BoardMetadata, Profile, ProfileAccount, ProfileJurisdiction, ProfileTokenCapacity } from './gossip';
import {
  computeEntityProfileCertificationHash,
  requireCompleteValidatorEncryptionManifest,
} from '../protocol/htlc/validator-encryption';

export const ENTITY_PROFILE_DESCRIPTOR_VERSION = 'xln:entity-profile:v2' as const;

export type EntityProfileDescriptor = Readonly<{
  version: typeof ENTITY_PROFILE_DESCRIPTOR_VERSION;
  entityId: string;
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
    board: BoardMetadata;
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

const buildProfileAccounts = (state: EntityState): { accounts: ProfileAccount[]; publicAccounts: string[] } => {
  const accounts: ProfileAccount[] = [];
  const publicAccounts: string[] = [];
  for (const [counterpartyId, account] of state.accounts.entries()) {
    const capacities: Record<string, ProfileTokenCapacity> = {};
    let hasInboundCapacity = false;
    const deltas = [...account.deltas.entries()].sort(([left], [right]) => compareTokenId(String(left), String(right)));
    for (const [tokenId, delta] of deltas) {
      const derived = deriveDelta(delta, isLeft(account.proofHeader.fromEntity, account.proofHeader.toEntity));
      capacities[String(tokenId)] = { inCapacity: derived.inCapacity.toString(), outCapacity: derived.outCapacity.toString() };
      if (derived.inCapacity > 0n) hasInboundCapacity = true;
    }
    accounts.push({ counterpartyId, tokenCapacities: capacities });
    if (hasInboundCapacity) publicAccounts.push(counterpartyId);
  }
  accounts.sort((left, right) => compareStableText(left.counterpartyId, right.counterpartyId));
  publicAccounts.sort(compareStableText);
  return { accounts, publicAccounts };
};

export const buildEntityProfileDescriptor = (
  state: EntityState,
  board: BoardMetadata,
): EntityProfileDescriptor => {
  const { accounts, publicAccounts } = buildProfileAccounts(state);
  const hubConfig = state.hubRebalanceConfig;
  const isHub = state.profile.isHub === true;
  const jurisdiction = profileJurisdiction(state);
  return {
    version: ENTITY_PROFILE_DESCRIPTOR_VERSION,
    entityId: state.entityId.toLowerCase(),
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
      board,
      ...(isHub && hubConfig
        ? {
            ...(hubConfig.hubName ? { hubName: hubConfig.hubName } : {}),
            policyVersion: hubConfig.policyVersion,
            ...(hubConfig.rebalanceBaseFee !== undefined
              ? { rebalanceBaseFee: String(hubConfig.rebalanceBaseFee) }
              : {}),
            rebalanceLiquidityFeeBps: String(hubConfig.rebalanceLiquidityFeeBps ?? hubConfig.minFeeBps ?? 1n),
            rebalanceGasFee: String(hubConfig.rebalanceGasFee ?? 0n),
            rebalanceTimeoutMs: hubConfig.rebalanceTimeoutMs ?? 10 * 60 * 1000,
          }
        : {}),
    },
  };
};

export type EntityProfileCertificationComponents = Readonly<{
  profileHash: string;
  manifestHash: string;
  routingStateHash: string;
}>;

export const computeEntityProfileCertificationComponents = (
  descriptor: EntityProfileDescriptor,
): EntityProfileCertificationComponents => {
  const { board, ...routingMetadata } = descriptor.metadata;
  const manifest = requireCompleteValidatorEncryptionManifest(
    {
      entityId: descriptor.entityId,
      threshold: board.threshold,
      validators: board.validators,
    },
    board.encryptionAttestations,
  );
  const routingStateHash = keccak256(new TextEncoder().encode(serializeTaggedJson({
    ...descriptor,
    metadata: routingMetadata,
  })));
  return {
    manifestHash: manifest.hash,
    routingStateHash,
    profileHash: computeEntityProfileCertificationHash(manifest.hash, routingStateHash),
  };
};

export const computeEntityProfileDescriptorHash = (descriptor: EntityProfileDescriptor): string =>
  computeEntityProfileCertificationComponents(descriptor).profileHash;

export const profileToEntityProfileDescriptor = (profile: Profile): EntityProfileDescriptor => {
  const metadata = profile.metadata;
  return {
    version: ENTITY_PROFILE_DESCRIPTOR_VERSION,
    entityId: profile.entityId,
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
      board: metadata.board,
      ...(metadata.hubName ? { hubName: metadata.hubName } : {}),
      ...(metadata.policyVersion !== undefined ? { policyVersion: metadata.policyVersion } : {}),
      ...(metadata.rebalanceBaseFee ? { rebalanceBaseFee: metadata.rebalanceBaseFee } : {}),
      ...(metadata.rebalanceLiquidityFeeBps ? { rebalanceLiquidityFeeBps: metadata.rebalanceLiquidityFeeBps } : {}),
      ...(metadata.rebalanceGasFee ? { rebalanceGasFee: metadata.rebalanceGasFee } : {}),
      ...(metadata.rebalanceTimeoutMs !== undefined ? { rebalanceTimeoutMs: metadata.rebalanceTimeoutMs } : {}),
    },
  };
};
