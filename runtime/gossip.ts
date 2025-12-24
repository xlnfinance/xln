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

  const getNetworkGraph = (): Map<string, Set<string>> => {
    // Build adjacency graph from gossip profiles
    // For lazy mode: return empty graph (all entities are islands)
    // For full mode: would parse accounts from replicas
    return new Map();
  };

  return {
    profiles,
    announce,
    getProfiles,
    // getNetworkGraph, // TODO: implement
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
