/**
 * Helper functions for gossip profile management
 * Builds and broadcasts entity profiles with account information
 */

import type { EntityState } from '../types';
import type { BoardMetadata, Profile } from './gossip';
import { deriveDelta, isLeft } from '../account-utils';
import { getCachedSignerAddress, getCachedSignerPublicKey } from '../account-crypto';

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

const buildBoardMetadata = (entityState: EntityState): BoardMetadata => {
  const validators = entityState.config.validators.map(validatorId => {
    const weight = toUint16(entityState.config.shares[validatorId] ?? 1n, 1);
    const publicKey = getCachedSignerPublicKey(validatorId);
    const publicKeyHex = publicKey ? bytesToHex(publicKey) : undefined;
    const address = getCachedSignerAddress(validatorId);
    const signer = address || validatorId;

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
export function buildEntityProfile(entityState: EntityState, name?: string, timestamp: number = 0): Profile {
  const accounts: Profile['accounts'] = [];
  const publicAccounts: string[] = [];
  const hubConfig = entityState.hubRebalanceConfig;

  // Build account capacities from all accounts
  for (const [counterpartyId, accountMachine] of entityState.accounts.entries()) {
    const tokenCapacities = new Map<number, {
      inCapacity: bigint;
      outCapacity: bigint;
    }>();
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
    const tokenCapacitiesObj: Record<number, { inCapacity: string; outCapacity: string }> = {};
    for (const [tokenId, cap] of tokenCapacities.entries()) {
      tokenCapacitiesObj[tokenId] = {
        inCapacity: cap.inCapacity.toString(),
        outCapacity: cap.outCapacity.toString(),
      };
    }

    accounts.push({
      counterpartyId,
      tokenCapacities: tokenCapacitiesObj as any,  // Plain object for JSON
    });

    if (hasInboundCapacity) {
      publicAccounts.push(counterpartyId);
    }
  }

  const board = buildBoardMetadata(entityState);
  const entityPublicKey = board.validators[0]?.publicKey;
  // Include X25519 crypto key for HTLC envelope encryption (if available)
  const cryptoPublicKey = normalizeX25519Hex(entityState.cryptoPublicKey);
  if (!cryptoPublicKey) {
    throw new Error(`GOSSIP_PROFILE_MISSING_ENCRYPTION_KEY: entity=${entityState.entityId}`);
  }
  const profileName = typeof name === 'string' && name.trim().length > 0
    ? name.trim()
    : `Entity ${entityState.entityId.slice(-4)}`;

  // Build profile
  const profile: Profile = {
    entityId: entityState.entityId,
    capabilities: [], // Future: Add routing, swap capabilities based on entity config
    publicAccounts,
    hubs: [...publicAccounts], // Legacy alias for compatibility
    metadata: {
      lastUpdated: timestamp,
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
      name: profileName,
    },
    accounts,
  };

  return profile;
}

/**
 * Merge an updated profile with any existing gossip profile metadata.
 * Preserves hub flags + custom fields while keeping computed fields current.
 */
export function mergeProfileWithExisting(profile: Profile, existing?: Profile | null): Profile {
  if (!existing) return profile;

  const existingMetadata = existing.metadata || {};
  const mergedMetadata = { ...existingMetadata, ...(profile.metadata || {}) };

  // Preserve hub flag if previously set
  if (existingMetadata.isHub === true) {
    mergedMetadata.isHub = true;
  }

  const mergedProfile: Profile = {
    ...profile,
    metadata: mergedMetadata,
    capabilities: Array.from(new Set([...(existing.capabilities || []), ...(profile.capabilities || [])])),
  };

  // Preserve endpoints/relays if missing on new profile
  if ((mergedProfile.endpoints?.length ?? 0) === 0 && existing.endpoints && existing.endpoints.length > 0) {
    mergedProfile.endpoints = [...existing.endpoints];
  }
  if ((mergedProfile.relays?.length ?? 0) === 0 && existing.relays && existing.relays.length > 0) {
    mergedProfile.relays = [...existing.relays];
  }

  return mergedProfile;
}

/**
 * Create a RuntimeTx to broadcast profile update
 */
export function createProfileBroadcastTx(entityState: EntityState, timestamp: number): any {
  const profile = buildEntityProfile(entityState, undefined, timestamp);

  return {
    type: 'gossipBroadcast',
    data: {
      profile,
      timestamp,
    },
  };
}
