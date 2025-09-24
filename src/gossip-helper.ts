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
export function buildEntityProfile(entityState: EntityState): Profile {
  const accounts: Profile['accounts'] = [];

  // Build account capacities from all accounts
  for (const [counterpartyId, accountMachine] of entityState.accounts.entries()) {
    const tokenCapacities = new Map<number, {
      inCapacity: bigint;
      outCapacity: bigint;
    }>();

    // Calculate capacities for each token
    for (const [tokenId, delta] of accountMachine.deltas.entries()) {
      const isLeftEntity = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
      const derived = deriveDelta(delta, isLeftEntity);
      tokenCapacities.set(tokenId, {
        inCapacity: derived.inCapacity,
        outCapacity: derived.outCapacity,
      });
    }

    accounts.push({
      counterpartyId,
      tokenCapacities,
    });
  }

  // Build profile
  const profile: Profile = {
    entityId: entityState.entityId,
    capabilities: [], // TODO: Add capabilities based on entity features
    hubs: [], // TODO: Track hub connections
    metadata: {
      lastUpdated: Date.now(),
      isHub: false, // TODO: Determine from capabilities
      routingFeePPM: 100, // Default 100 PPM (0.01%)
      baseFee: 0n,
    },
    accounts,
  };

  return profile;
}

/**
 * Create a ServerTx to broadcast profile update
 */
export function createProfileBroadcastTx(entityState: EntityState): any {
  const profile = buildEntityProfile(entityState);

  return {
    type: 'gossipBroadcast',
    data: {
      profile,
      timestamp: Date.now(),
    },
  };
}