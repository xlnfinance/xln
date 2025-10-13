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
    getNetworkGraph,
  };
}

// Demo usage (commented out)
/*
const gossipLayer = createGossipLayer();

// Announce Alice's profile
gossipLayer.announce({
  entityId: "alice",
  capabilities: ["trader", "swap:memecoins"],
  hubs: ["hubX1"],
  metadata: { region: "US", version: "1.0.0" }
});

// Announce hubX1's profile
gossipLayer.announce({
  entityId: "hubX1",
  capabilities: ["router", "hub", "swap:all"],
  hubs: [],
  metadata: { capacity: 1000, uptime: "99.9%" }
});

// List all profiles
console.log("All profiles:", gossipLayer.getProfiles());
*/
