/**
 * Helper functions for gossip profile management
 * Builds and broadcasts entity profiles with account information
 */

import { ethers } from 'ethers';
import type { EntityState, Env } from '../types';
import type { BoardMetadata, Profile, ProfileAccount, ProfileTokenCapacity } from './gossip';
import { deriveDelta, isLeft } from '../account-utils';
import { safeStringify } from '../serialization-utils';
import { deriveSignerAddressSync, getSignerAddress, getSignerPublicKey } from '../account-crypto';
import { deriveEncryptionKeyPair, pubKeyToHex } from './p2p-crypto';

type BuiltProfile = Omit<Profile, 'runtimeEncPubKey'>;

const toUint16 = (value: bigint | number | undefined, fallback = 0): number => {
  const raw = typeof value === 'bigint' ? Number(value) : Number(value ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  if (raw <= 0) return 0;
  return Math.min(65535, Math.floor(raw));
};

const bytesToHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;

const normalizeX25519Hex = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return /^0x[0-9a-fA-F]{64}$/.test(prefixed) ? prefixed.toLowerCase() : null;
};

export type ProfileSignerResolver = {
  getSignerAddress: (signerId: string) => string | null;
  getSignerPublicKeyHex: (signerId: string) => string | null;
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
  const validators = entityState.config.validators.map(validatorId => {
    const weight = toUint16(entityState.config.shares[validatorId] ?? 1n, 1);
    const signer =
      (validatorId.startsWith('0x') ? normalizeSignerAddress(validatorId) : null)
      ?? signerResolver?.getSignerAddress(validatorId)
      ?? null;
    if (!signer) {
      throw new Error(`GOSSIP_PROFILE_SIGNER_ADDRESS_REQUIRED: entity=${entityState.entityId} signerId=${validatorId}`);
    }
    const publicKeyHex = signerResolver?.getSignerPublicKeyHex(validatorId) ?? null;
    if (!publicKeyHex) {
      throw new Error(`GOSSIP_PROFILE_SIGNER_PUBLIC_KEY_REQUIRED: entity=${entityState.entityId} signerId=${validatorId}`);
    }

    return {
      signer,
      weight,
      signerId: validatorId,
      publicKey: publicKeyHex,
    };
  });

  return {
    threshold: toUint16(entityState.config.threshold, 1),
    validators,
  };
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
  const accounts: ProfileAccount[] = [];
  const publicAccounts: string[] = [];
  const hubConfig = entityState.hubRebalanceConfig;
  const isHub = entityState.profile.isHub === true;

  // Build account capacities from all accounts
  for (const [counterpartyId, accountMachine] of entityState.accounts.entries()) {
    const tokenCapacities = new Map<number, ProfileTokenCapacity>();
    let hasInboundCapacity = false;

    // Calculate capacities for each token
    for (const [tokenId, delta] of accountMachine.deltas.entries()) {
      const isLeftEntity = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
      const derived = deriveDelta(delta, isLeftEntity);
      tokenCapacities.set(tokenId, {
        inCapacity: derived.inCapacity,
        outCapacity: derived.outCapacity,
      });
      if (derived.inCapacity > 0n) {
        hasInboundCapacity = true;
      }
    }

    // Convert tokenCapacities Map to plain object for JSON serialization
    const tokenCapacitiesObj: Record<string, { inCapacity: string; outCapacity: string }> = {};
    for (const [tokenId, cap] of tokenCapacities.entries()) {
      tokenCapacitiesObj[String(tokenId)] = {
        inCapacity: cap.inCapacity.toString(),
        outCapacity: cap.outCapacity.toString(),
      };
    }

    accounts.push({
      counterpartyId,
      tokenCapacities: tokenCapacitiesObj,
    });

    if (hasInboundCapacity) {
      publicAccounts.push(counterpartyId);
    }
  }

  const board = buildBoardMetadata(entityState, signerResolver);
  // Include X25519 crypto key for HTLC envelope encryption (if available)
  const entityEncPubKey = normalizeX25519Hex(entityState.entityEncPubKey);
  if (!entityEncPubKey) {
    throw new Error(`GOSSIP_PROFILE_MISSING_ENTITY_ENC_PUBKEY: entity=${entityState.entityId}`);
  }
  const profileName = String(entityState.profile.name || '').trim();
  if (!profileName) {
    throw new Error(`GOSSIP_PROFILE_NAME_REQUIRED: entity=${entityState.entityId}`);
  }

  // Build profile
  const profile: BuiltProfile = {
    entityId: entityState.entityId,
    name: profileName,
    avatar: entityState.profile.avatar,
    bio: entityState.profile.bio,
    website: entityState.profile.website,
    lastUpdated: timestamp,
    publicAccounts,
    endpoints: [],
    relays: [],
    metadata: {
      isHub,
      routingFeePPM: hubConfig?.routingFeePPM ?? 1,
      baseFee: hubConfig?.baseFee ?? 0n,
      ...(isHub && hubConfig
        ? {
            policyVersion: hubConfig.policyVersion,
            rebalanceBaseFee: String(hubConfig.rebalanceBaseFee ?? 10n ** 17n),
            rebalanceLiquidityFeeBps: String(hubConfig.rebalanceLiquidityFeeBps ?? hubConfig.minFeeBps ?? 1n),
            rebalanceGasFee: String(hubConfig.rebalanceGasFee ?? 0n),
            rebalanceTimeoutMs: hubConfig.rebalanceTimeoutMs ?? 10 * 60 * 1000,
          }
        : {}),
      board,
      entityEncPubKey,
    },
    accounts,
  };

  return profile;
}

export const createProfileSignerResolver = (env: Env): ProfileSignerResolver => ({
  getSignerAddress: (signerId) => getSignerAddress(env, signerId),
  getSignerPublicKeyHex: (signerId) => {
    const publicKey = getSignerPublicKey(env, signerId);
    return publicKey ? `0x${Buffer.from(publicKey).toString('hex')}` : null;
  },
});

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
  profile.runtimeId = resolveProfileRuntimeId(env, entityState.entityId);
  profile.runtimeEncPubKey = pubKeyToHex(deriveEncryptionKeyPair(runtimeSeed).publicKey);
  return profile;
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
  return left.localeCompare(right);
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
    .sort((left, right) => left.counterpartyId.localeCompare(right.counterpartyId));

  const metadata = profile.metadata;
  const fingerprintPayload = {
    entityId: profile.entityId,
    publicAccounts: [...profile.publicAccounts].sort(),
    accounts,
    metadata: {
      isHub: metadata.isHub,
      routingFeePPM: metadata.routingFeePPM,
      baseFee: String(metadata.baseFee),
      policyVersion: Number(metadata.policyVersion ?? 0),
      rebalanceBaseFee: String(metadata.rebalanceBaseFee ?? ''),
      rebalanceLiquidityFeeBps: String(metadata.rebalanceLiquidityFeeBps ?? ''),
      rebalanceGasFee: String(metadata.rebalanceGasFee ?? ''),
      rebalanceTimeoutMs: Number(metadata.rebalanceTimeoutMs ?? 0),
      entityEncPubKey: metadata.entityEncPubKey,
      board: metadata.board,
    },
  };

  return safeStringify(fingerprintPayload);
}
