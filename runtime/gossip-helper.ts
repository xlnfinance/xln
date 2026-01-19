/**
 * Helper functions for gossip profile management
 * Builds and broadcasts entity profiles with account information
 */

import type { EntityState } from './types';
import type { BoardMetadata, Profile } from './gossip';
import { deriveDelta, isLeft } from './account-utils';
import { getCachedSignerAddress, getCachedSignerPublicKey } from './account-crypto';

const toUint16 = (value: bigint | number | undefined, fallback = 0): number => {
  const raw = typeof value === 'bigint' ? Number(value) : Number(value ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  if (raw <= 0) return 0;
  return Math.min(65535, Math.floor(raw));
};

const bytesToHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;

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

  // Build profile
  const profile: Profile = {
    entityId: entityState.entityId,
    capabilities: [], // Future: Add routing, swap capabilities based on entity config
    publicAccounts,
    hubs: [...publicAccounts], // Legacy alias for compatibility
    metadata: {
      lastUpdated: timestamp,
      isHub: false, // Future: Determine from entity capabilities or manual config
      routingFeePPM: 100, // Default 100 PPM (0.01%)
      baseFee: 0n,
      board: buildBoardMetadata(entityState),
      threshold: toUint16(entityState.config.threshold, 1),
      ...(name ? { name } : {}), // Include name if provided
    },
    accounts,
  };

  return profile;
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
