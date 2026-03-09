/**
 * Helper functions for gossip profile management
 * Builds and broadcasts entity profiles with account information
 */

import { ethers } from 'ethers';
import type { EntityState } from '../types';
import type { BoardMetadata, Profile, ProfileAccount, ProfileTokenCapacity } from './gossip';
import { deriveDelta, isLeft } from '../account-utils';
import { safeStringify } from '../serialization-utils';

type GossipBroadcastTx = {
  type: 'gossipBroadcast';
  data: {
    profile: Profile;
    timestamp: number;
  };
};

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

    return {
      signer,
      weight,
      signerId: validatorId,
      ...(publicKeyHex ? { publicKey: publicKeyHex } : {}),
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
  name?: string,
  timestamp: number = 0,
  signerResolver?: ProfileSignerResolver,
): Profile {
  const accounts: ProfileAccount[] = [];
  const publicAccounts: string[] = [];
  const hubConfig = entityState.hubRebalanceConfig;

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
  const entityPublicKey = board.validators[0]?.publicKey;
  // Include X25519 crypto key for HTLC envelope encryption (if available)
  const cryptoPublicKey = normalizeX25519Hex(entityState.cryptoPublicKey);
  if (!cryptoPublicKey) {
    throw new Error(`GOSSIP_PROFILE_MISSING_ENCRYPTION_KEY: entity=${entityState.entityId}`);
  }
  const profileName = typeof name === 'string' && name.trim().length > 0
    ? name.trim()
    : entityState.profile.name;

  // Build profile
  const profile: Profile = {
    entityId: entityState.entityId,
    name: profileName,
    avatar: entityState.profile.avatar,
    bio: entityState.profile.bio,
    website: entityState.profile.website,
    lastUpdated: timestamp,
    capabilities: [], // Future: Add routing, swap capabilities based on entity config
    publicAccounts,
    hubs: [...publicAccounts], // Legacy alias for compatibility
    endpoints: [],
    relays: [],
    metadata: {
      isHub: !!hubConfig,
      routingFeePPM: hubConfig?.routingFeePPM ?? 100, // Default 100 PPM (0.01%)
      baseFee: hubConfig?.baseFee ?? 0n,
      ...(hubConfig
        ? {
            policyVersion: hubConfig.policyVersion,
            rebalanceBaseFee: String(hubConfig.rebalanceBaseFee ?? 10n ** 17n),
            rebalanceLiquidityFeeBps: String(hubConfig.rebalanceLiquidityFeeBps ?? hubConfig.minFeeBps ?? 1n),
            rebalanceGasFee: String(hubConfig.rebalanceGasFee ?? 0n),
            rebalanceTimeoutMs: hubConfig.rebalanceTimeoutMs ?? 10 * 60 * 1000,
          }
        : {}),
      board,
      threshold: toUint16(entityState.config.threshold, 1),
      ...(entityPublicKey ? { entityPublicKey } : {}),
      cryptoPublicKey, // X25519 key for HTLC encryption
      encryptionPublicKey: cryptoPublicKey, // transport key (runtime-level)
    },
    accounts,
  };

  return profile;
}

type FingerprintTokenCapacity = {
  tokenId: string;
  inCapacity: string;
  outCapacity: string;
};

type FingerprintAccount = {
  counterpartyId: string;
  tokenCapacities: FingerprintTokenCapacity[];
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
  const profile = buildEntityProfile(entityState, undefined, 0, signerResolver);
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
        .sort((left, right) => left.tokenId.localeCompare(right.tokenId));
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
      threshold: metadata.threshold,
      policyVersion: Number(metadata.policyVersion ?? 0),
      rebalanceBaseFee: String(metadata.rebalanceBaseFee ?? ''),
      rebalanceLiquidityFeeBps: String(metadata.rebalanceLiquidityFeeBps ?? ''),
      rebalanceGasFee: String(metadata.rebalanceGasFee ?? ''),
      rebalanceTimeoutMs: Number(metadata.rebalanceTimeoutMs ?? 0),
      entityPublicKey: String(metadata.entityPublicKey ?? ''),
      cryptoPublicKey: metadata.cryptoPublicKey,
      board: metadata.board,
    },
  };

  return safeStringify(fingerprintPayload);
}

/**
 * Merge an updated profile with any existing gossip profile metadata.
 * Preserves hub flags + custom fields while keeping computed fields current.
 */
export function mergeProfileWithExisting(profile: Profile, existing?: Profile | null): Profile {
  return profile;
}

/**
 * Create a RuntimeTx to broadcast profile update
 */
export function createProfileBroadcastTx(entityState: EntityState, timestamp: number): GossipBroadcastTx {
  const profile = buildEntityProfile(entityState, undefined, timestamp);

  return {
    type: 'gossipBroadcast',
    data: {
      profile,
      timestamp,
    },
  };
}
