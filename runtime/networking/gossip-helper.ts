/**
 * Helper functions for gossip profile management
 * Builds and broadcasts entity profiles with account information
 */

import { ethers } from 'ethers';
import type { EntityState, Env } from '../types';
import type {
  BoardMetadata,
  Profile,
  ProfileJurisdiction,
  ProfileMirror,
} from './gossip';
import { compareStableText, safeStringify } from '../protocol/serialization';
import { deriveSignerAddressSync, getSignerAddress, getSignerPrivateKey, getSignerPublicKey } from '../account/crypto';
import { deriveEncryptionKeyPair, pubKeyToHex } from './p2p-crypto';
import { UINT16_MAX } from '../constants';
import { requireCompleteValidatorEncryptionManifest } from '../protocol/htlc/validator-encryption';
import {
  collectLocalProfileEncryptionAnnouncements,
  getProfileEncryptionAttestations,
} from './profile-encryption';
import { buildEntityProfileDescriptor } from './profile-descriptor';

type BuiltProfile = Omit<Profile, 'runtimeId' | 'runtimeEncPubKey'>;

const toUint16 = (value: bigint | number | undefined, fallback = 0): number => {
  const raw = typeof value === 'bigint' ? Number(value) : Number(value ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  if (raw <= 0) return 0;
  return Math.min(UINT16_MAX, Math.floor(raw));
};

const buildProfileJurisdiction = (state: EntityState): ProfileJurisdiction | undefined => {
  const jurisdiction = state.config?.jurisdiction;
  const name = typeof jurisdiction?.name === 'string' ? jurisdiction.name.trim() : '';
  if (!jurisdiction || !name) return undefined;
  return {
    name,
    ...(jurisdiction.chainId !== undefined ? { chainId: jurisdiction.chainId } : {}),
    ...(jurisdiction.entityProviderAddress ? { entityProviderAddress: jurisdiction.entityProviderAddress } : {}),
    ...(jurisdiction.depositoryAddress ? { depositoryAddress: jurisdiction.depositoryAddress } : {}),
  };
};

const buildProfileMirrors = (env: Env, entityState: EntityState): ProfileMirror[] => {
  const mirrors = new Map<string, ProfileMirror>();
  for (const replica of env.eReplicas?.values?.() || []) {
    const entityId = String(replica?.state?.entityId || replica?.entityId || '').trim();
    if (!entityId || entityId.toLowerCase() === entityState.entityId.toLowerCase()) continue;
    try {
      getSignerPrivateKey(env, replica.signerId);
    } catch {
      continue;
    }
    const jurisdiction = buildProfileJurisdiction(replica.state);
    if (!jurisdiction) continue;
    mirrors.set(entityId.toLowerCase(), { entityId, jurisdiction });
  }
  return Array.from(mirrors.values()).sort((a, b) =>
    compareStableText(a.jurisdiction.name, b.jurisdiction.name) || compareStableText(a.entityId, b.entityId),
  );
};

export type ProfileSignerResolver = {
  getSignerAddress: (signerId: string) => string | null;
  getSignerPublicKeyHex: (signerId: string) => string | null;
  getValidatorEncryptionAttestations: (entityId: string) =>
    import('../protocol/htlc/validator-encryption').ValidatorEncryptionAttestation[];
};

const normalizeSignerAddress = (raw: string): string => {
  if (raw.startsWith('0x') && raw.length === 42) {
    return ethers.getAddress(raw).toLowerCase();
  }
  if (raw.startsWith('0x') && raw.length === 66) {
    return ethers.getAddress(`0x${raw.slice(-40)}`).toLowerCase();
  }
  throw new Error(`GOSSIP_PROFILE_SIGNER_ADDRESS_INVALID: ${raw}`);
};

const buildBoardMetadata = (
  entityState: EntityState,
  signerResolver?: ProfileSignerResolver,
): BoardMetadata => {
  const certifiedAttestations = entityState.profileEncryptionManifest?.attestations ?? [];
  const certifiedBySigner = new Map(
    certifiedAttestations.map((attestation) => [attestation.signerId.trim().toLowerCase(), attestation]),
  );
  const validators = entityState.config.validators.map(validatorId => {
    const canonicalSignerId = validatorId.trim().toLowerCase();
    const certified = certifiedBySigner.get(canonicalSignerId);
    const weight = toUint16(entityState.config.shares[validatorId] ?? 1n, 1);
    const signer =
      certified?.signer
      ?? (validatorId.startsWith('0x') ? normalizeSignerAddress(validatorId) : null)
      ?? signerResolver?.getSignerAddress(validatorId)
      ?? null;
    if (!signer) {
      throw new Error(`GOSSIP_PROFILE_SIGNER_ADDRESS_REQUIRED: entity=${entityState.entityId} signerId=${validatorId}`);
    }
    const canonicalSigner = signer.toLowerCase();
    const publicKeyHex = certified?.publicKey
      ?? signerResolver?.getSignerPublicKeyHex(validatorId)
      ?? null;
    if (!publicKeyHex) {
      throw new Error(`GOSSIP_PROFILE_SIGNER_PUBLIC_KEY_REQUIRED: entity=${entityState.entityId} signerId=${validatorId}`);
    }

    return {
      signer: canonicalSigner,
      weight,
      signerId: canonicalSignerId,
      publicKey: publicKeyHex,
    };
  });

  const threshold = toUint16(entityState.config.threshold, 1);
  const manifest = requireCompleteValidatorEncryptionManifest(
    { entityId: entityState.entityId, threshold, validators },
    certifiedAttestations.length > 0
      ? certifiedAttestations
      : signerResolver?.getValidatorEncryptionAttestations(entityState.entityId) ?? [],
  );
  if (entityState.profileEncryptionManifest && entityState.profileEncryptionManifest.hash !== manifest.hash) {
    throw new Error(`GOSSIP_PROFILE_CERTIFIED_MANIFEST_CORRUPTION: entity=${entityState.entityId}`);
  }
  return { threshold, validators, encryptionAttestations: [...manifest.attestations] };
};

/**
 * Build gossip profile from entity state
 * Includes all account capacities for routing
 */
export function buildEntityProfile(
  entityState: EntityState,
  timestamp: number = 0,
  signerResolver?: ProfileSignerResolver,
): BuiltProfile {
  const board = buildBoardMetadata(entityState, signerResolver);
  const descriptor = buildEntityProfileDescriptor(entityState, board);
  const profileName = String(entityState.profile.name || '').trim();
  if (!profileName) {
    throw new Error(`GOSSIP_PROFILE_NAME_REQUIRED: entity=${entityState.entityId}`);
  }

  // Build profile
  const profile: BuiltProfile = {
    entityId: descriptor.entityId,
    name: descriptor.name,
    avatar: descriptor.avatar,
    bio: descriptor.bio,
    website: descriptor.website,
    lastUpdated: timestamp,
    publicAccounts: descriptor.publicAccounts,
    wsUrl: null,
    relays: [],
    metadata: descriptor.metadata,
    accounts: descriptor.accounts,
  };

  return profile;
}

export const createProfileSignerResolver = (env: Env): ProfileSignerResolver => {
  collectLocalProfileEncryptionAnnouncements(env);
  return {
    getSignerAddress: (signerId) => getSignerAddress(env, signerId),
    getSignerPublicKeyHex: (signerId) => {
      const publicKey = getSignerPublicKey(env, signerId);
      return publicKey ? `0x${Buffer.from(publicKey).toString('hex')}` : null;
    },
    getValidatorEncryptionAttestations: (entityId) => getProfileEncryptionAttestations(env, entityId),
  };
};

export const getNextProfileTimestamp = (env: Env, entityId: string, fallbackTimestamp?: number): number => {
  const existingProfile = env.gossip.getProfiles().find((profile) => profile.entityId === entityId);
  const lastTimestamp = existingProfile?.lastUpdated ?? 0;
  const candidate = typeof fallbackTimestamp === 'number' ? fallbackTimestamp : env.timestamp;
  return Math.max(1, lastTimestamp + 1, candidate);
};

const resolveProfileRuntimeId = (env: Env, entityId: string): string => {
  if (typeof env.runtimeId === 'string' && env.runtimeId.trim().length > 0) {
    return env.runtimeId.trim().toLowerCase();
  }
  const runtimeSeed = typeof env.runtimeSeed === 'string' ? env.runtimeSeed.trim() : '';
  if (!runtimeSeed) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ID_REQUIRED: entity=${entityId}`);
  }
  return deriveSignerAddressSync(runtimeSeed, '1').toLowerCase();
};

export const buildLocalEntityProfile = (
  env: Env,
  entityState: EntityState,
  timestamp: number = getNextProfileTimestamp(env, entityState.entityId),
): Profile => {
  const runtimeSeed = String(env.runtimeSeed || '').trim();
  if (!runtimeSeed) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_SEED_REQUIRED: entity=${entityState.entityId}`);
  }
  const profileTimestamp = Math.max(1, timestamp);
  const profile = buildEntityProfile(entityState, profileTimestamp, createProfileSignerResolver(env));
  const jurisdiction = buildProfileJurisdiction(entityState);
  const mirrors = env.runtimeConfig?.advertiseProfileMirrors === true
    ? buildProfileMirrors(env, entityState)
    : [];
  return {
    ...profile,
    metadata: {
      ...profile.metadata,
      ...(jurisdiction ? { jurisdiction } : {}),
      ...(mirrors.length > 0 ? { mirrors } : {}),
    },
    runtimeId: resolveProfileRuntimeId(env, entityState.entityId),
    runtimeEncPubKey: pubKeyToHex(deriveEncryptionKeyPair(runtimeSeed).publicKey),
  };
};

export const announceLocalEntityProfile = (
  env: Env,
  entityState: EntityState,
  timestamp?: number,
): Profile => {
  const profile = buildLocalEntityProfile(
    env,
    entityState,
    timestamp ?? getNextProfileTimestamp(env, entityState.entityId),
  );
  env.gossip.announce(profile);
  return profile;
};

type FingerprintTokenCapacity = {
  tokenId: string;
  inCapacity: string;
  outCapacity: string;
};

type FingerprintAccount = {
  counterpartyId: string;
  tokenCapacities: FingerprintTokenCapacity[];
};

const compareTokenIdStrings = (left: string, right: string): number => {
  const leftNum = Number(left);
  const rightNum = Number(right);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
    return leftNum - rightNum;
  }
  return compareStableText(left, right);
};

/**
 * Deterministic fingerprint of the public routing state we advertise via gossip.
 * Excludes volatile fields like lastUpdated/signatures so we only re-announce
 * when the visible profile meaningfully changes.
 */
export function buildEntityAdvertisedStateFingerprint(
  entityState: EntityState,
  signerResolver?: ProfileSignerResolver,
): string {
  const profile = buildEntityProfile(entityState, 0, signerResolver);
  const accounts: FingerprintAccount[] = profile.accounts
    .map((account) => {
      const tokenEntries =
        account.tokenCapacities instanceof Map
          ? Array.from(account.tokenCapacities.entries())
          : Object.entries(account.tokenCapacities);
      const tokenCapacities = tokenEntries
        .map(([tokenId, capacity]) => ({
          tokenId: String(tokenId),
          inCapacity: String(capacity.inCapacity),
          outCapacity: String(capacity.outCapacity),
        }))
        .sort((left, right) => compareTokenIdStrings(left.tokenId, right.tokenId));
      return {
        counterpartyId: account.counterpartyId,
        tokenCapacities,
      };
    })
    .sort((left, right) => compareStableText(left.counterpartyId, right.counterpartyId));

  const metadata = profile.metadata;
  const fingerprintPayload = {
    entityId: profile.entityId,
    publicAccounts: [...profile.publicAccounts].sort(),
    accounts,
    metadata: {
      isHub: metadata.isHub,
      routingFeePPM: metadata.routingFeePPM,
      baseFee: String(metadata.baseFee),
      swapTakerFeeBps: Number(metadata.swapTakerFeeBps ?? 0),
      policyVersion: Number(metadata.policyVersion ?? 0),
      rebalanceBaseFee: String(metadata.rebalanceBaseFee ?? ''),
      rebalanceLiquidityFeeBps: String(metadata.rebalanceLiquidityFeeBps ?? ''),
      rebalanceGasFee: String(metadata.rebalanceGasFee ?? ''),
      rebalanceTimeoutMs: Number(metadata.rebalanceTimeoutMs ?? 0),
      board: metadata.board,
    },
  };

  return safeStringify(fingerprintPayload);
}
