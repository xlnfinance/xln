/**
 * Gossip Layer Implementation for XLN
 *
 * This module implements the gossip layer inside the runtime object.
 * It manages entity profiles and their capabilities in a distributed network.
 */

export type Profile = {
  entityId: string;
  capabilities: string[]; // e.g. ["router", "swap:memecoins"]
  hubs: string[]; // entityIds of hubs this entity is connected to
  metadata?: {
    // Consensus profile fields (from name-resolution.ts)
    name?: string;
    avatar?: string;
    bio?: string;
    website?: string;
    lastUpdated?: number;
    hankoSignature?: string;
    // Network-specific fields
    region?: string;
    version?: string;
    capacity?: number;
    uptime?: string;
    isHub?: boolean;
    // Fee configuration (PPM = parts per million)
    routingFeePPM?: number; // 0-10000 (0% - 1%)
    baseFee?: bigint; // Base fee in smallest unit (e.g., wei for ETH)
    // 3D visualization position (for scenarios)
    position?: { x: number; y: number; z: number };
    // Additional fields
    [key: string]: unknown;
  };
  // Account capacities for routing
  accounts?: Array<{
    counterpartyId: string;
    tokenCapacities: Map<number, {
      inCapacity: bigint;
      outCapacity: bigint;
    }>;
  }>;
};

export interface GossipLayer {
  profiles: Map<string, Profile>;
  announce: (profile: Profile) => void;
  getProfiles: () => Profile[];
  getNetworkGraph: () => {
    findPaths: (source: string, target: string, amount?: bigint, tokenId?: number) => Promise<any[]>;
  };
}

export function createGossipLayer(): GossipLayer {
  const profiles = new Map<string, Profile>();

  const announce = (profile: Profile): void => {
    // Only update if newer timestamp or no existing profile
    const existing = profiles.get(profile.entityId);
    const newTimestamp = profile.metadata?.lastUpdated || 0;
    const existingTimestamp = existing?.metadata?.lastUpdated || 0;

    if (!existing || newTimestamp > existingTimestamp) {
      profiles.set(profile.entityId, profile);
      console.log(`📡 Gossip updated for ${profile.entityId} (timestamp: ${newTimestamp})`);
    } else {
      console.log(`📡 Gossip ignored older update for ${profile.entityId} (${newTimestamp} <= ${existingTimestamp})`);
    }
  };

  const getProfiles = (): Profile[] => {
    return Array.from(profiles.values());
  };

  /**
   * Get network graph with pathfinding capabilities
   * Returns object with findPaths() method using Dijkstra algorithm
   *
   * TODO: Wire to PathFinder class - currently using simple BFS for stability
   */
  const getNetworkGraph = () => {
    return {
      findPaths: async (source: string, target: string, amount?: bigint, tokenId: number = 1) => {
        // Simple BFS pathfinding from profiles
        // Full Dijkstra in routing/pathfinding.ts (to be integrated)

        const adjacency = new Map<string, Set<string>>();

        // Build adjacency from profiles (capacity-aware)
        const minAmount = amount || 1n; // Use specified amount or 1 as minimum

        for (const profile of profiles.values()) {
          if (profile.accounts) {
            const neighbors = new Set<string>();
            for (const account of profile.accounts) {
              const tokenCap = account.tokenCapacities.get(tokenId);
              // Filter by capacity >= required amount (not just > 0)
              if (tokenCap && tokenCap.outCapacity >= minAmount) {
                neighbors.add(account.counterpartyId);
              }
            }
            if (neighbors.size > 0) {
              adjacency.set(profile.entityId, neighbors);
            }
          }
        }

        // BFS to find path
        const queue: string[][] = [[source]];
        const visited = new Set<string>([source]);

        while (queue.length > 0) {
          const path = queue.shift()!;
          const current = path[path.length - 1];
          if (!current) continue; // Safety check

          if (current === target) {
            return [{ path }]; // Found!
          }

          const neighbors = adjacency.get(current);
          if (neighbors) {
            for (const neighbor of neighbors) {
              if (neighbor && !visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push([...path, neighbor]);
              }
            }
          }
        }

        return []; // No path found
      }
    };
  };

  return {
    profiles,
    announce,
    getProfiles,
    getNetworkGraph,
  };
}

// === PERSISTENCE (from gossip-loader.ts) ===

/**
 * Load persisted profiles from database into gossip layer
 * @param db - LevelDB-like database instance
 * @param gossip - Gossip layer to announce profiles to
 * @returns Number of profiles loaded
 */
export async function loadPersistedProfiles(db: any, gossip: { announce: (p: Profile) => void }): Promise<number> {
  try {
    let profileCount = 0;
    const iterator = db.iterator({ gte: 'profile:', lt: 'profile:\xFF' });

    for await (const [key, value] of iterator) {
      try {
        const profile = JSON.parse(value);
        gossip.announce({
          entityId: profile.entityId,
          capabilities: profile.capabilities || [],
          hubs: profile.hubs || [],
          metadata: {
            name: profile.name,
            avatar: profile.avatar,
            bio: profile.bio,
            website: profile.website,
            lastUpdated: profile.lastUpdated,
            hankoSignature: profile.hankoSignature,
          },
        });
        profileCount++;
      } catch (parseError) {
        console.warn(`⚠️ Failed to parse profile from key ${key}:`, parseError);
      }
    }

    console.log(`📡 Restored ${profileCount} profiles from DB into gossip`);
    return profileCount;
  } catch (error) {
    console.error('❌ Failed to load persisted profiles:', error);
    return 0;
  }
}
