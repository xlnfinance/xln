/**
 * Gossip Layer Implementation for XLN
 *
 * This module implements the gossip layer inside the server object.
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
    // Additional fields
    [key: string]: unknown;
  };
};

export interface GossipLayer {
  profiles: Map<string, Profile>;
  announce: (profile: Profile) => void;
  getProfiles: () => Profile[];
}

export function createGossipLayer(): GossipLayer {
  const profiles = new Map<string, Profile>();

  const announce = (profile: Profile): void => {
    profiles.set(profile.entityId, profile);
    console.log('📡 Gossip updated:', profile);
  };

  const getProfiles = (): Profile[] => {
    return Array.from(profiles.values());
  };

  return {
    profiles,
    announce,
    getProfiles,
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
