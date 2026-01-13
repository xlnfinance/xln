/**
 * Helper functions for gossip profile management
 * Builds and broadcasts entity profiles with account information
 */

import type { EntityState } from './types';
import type { Profile } from './gossip';
import { deriveDelta, isLeft } from './account-utils';

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

    accounts.push({
      counterpartyId,
      tokenCapacities,
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
      board: [...entityState.config.validators],
      threshold: entityState.config.threshold,
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
