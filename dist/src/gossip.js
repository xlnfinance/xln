/**
 * Gossip Layer Implementation for XLN
 *
 * This module implements the gossip layer inside the server object.
 * It manages entity profiles and their capabilities in a distributed network.
 */
export function createGossipLayer() {
    const profiles = new Map();
    const announce = (profile) => {
        profiles.set(profile.entityId, profile);
        console.log('📡 Gossip updated:', profile);
    };
    const getProfiles = () => {
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
