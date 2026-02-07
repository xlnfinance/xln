/**
 * Gossip Layer Implementation for XLN
 *
 * This module implements the gossip layer inside the runtime object.
 * It manages entity profiles and their capabilities in a distributed network.
 */

import { FINANCIAL } from '../constants';
import { logDebug } from '../logger';
export type BoardValidator = {
  signer: string; // canonical signer address (0x...) or signerId fallback
  weight: number; // uint16 voting power
  signerId?: string; // optional runtime signerId for routing/debug
  publicKey?: string; // optional hex public key
};

export type BoardMetadata = {
  threshold: number; // uint16 voting threshold
  validators: BoardValidator[];
};

export type Profile = {
  entityId: string;
  runtimeId?: string; // Runtime identity (usually signer1 address)
  capabilities: string[]; // e.g. ["router", "swap:memecoins"]
  publicAccounts?: string[]; // direct peers with inbound capacity
  hubs?: string[]; // legacy alias for publicAccounts
  endpoints?: string[]; // websocket endpoints for this runtime
  relays?: string[]; // preferred relay runtimes
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
    board?: BoardMetadata | string[]; // board metadata (legacy string[] supported)
    threshold?: number; // legacy threshold mirror (uint16)
    // 3D visualization position (for scenarios)
    position?: { x: number; y: number; z: number };
    // Additional fields
    entityPublicKey?: string; // hex public key for signature verification
    encryptionPubKey?: string; // X25519 public key for E2E encryption (hex)
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
  getHubs: () => Profile[];  // Get all profiles with isHub=true
  getProfileBundle?: (entityId: string) => { profile?: Profile; peers: Profile[] };
  getNetworkGraph: () => {
    findPaths: (source: string, target: string, amount?: bigint, tokenId?: number) => Promise<any[]>;
  };
}

const PROFILE_TTL_MS = 5 * 60 * 1000;

export function createGossipLayer(): GossipLayer {
  const profiles = new Map<string, Profile>();

  const getLastUpdated = (profile: Profile): number => {
    const ts = profile.metadata?.lastUpdated;
    return typeof ts === 'number' ? ts : 0;
  };

  const getExpiresAt = (profile: Profile): number => {
    const explicit = profile.metadata?.expiresAt;
    if (typeof explicit === 'number') return explicit;
    return getLastUpdated(profile) + PROFILE_TTL_MS;
  };

  const pruneExpiredProfiles = (): void => {
    const now = Date.now();
    for (const [entityId, profile] of profiles.entries()) {
      if (getExpiresAt(profile) <= now) {
        profiles.delete(entityId);
      }
    }
  };

  const announce = (profile: Profile): void => {
    logDebug('GOSSIP', `📢 gossip.announce INPUT: ${profile.entityId.slice(-4)} accounts=${profile.accounts?.length || 0}`);

    const normalizedProfile: Profile = {
      ...profile,
      publicAccounts: profile.publicAccounts || profile.hubs || [],
      hubs: profile.hubs || profile.publicAccounts || [],
      endpoints: profile.endpoints || [],
      relays: profile.relays || [],
      metadata: {
        ...(profile.metadata || {}),
        expiresAt:
          typeof profile.metadata?.expiresAt === 'number'
            ? profile.metadata.expiresAt
            : (profile.metadata?.lastUpdated || Date.now()) + PROFILE_TTL_MS,
        // Compatibility: treat capability-tagged hubs as hubs even if metadata.isHub was omitted upstream.
        isHub:
          profile.metadata?.isHub === true ||
          profile.capabilities?.includes('hub') === true ||
          profile.capabilities?.includes('routing') === true,
      },
    };

    logDebug('GOSSIP', `📢 After normalize: ${profile.entityId.slice(-4)} accounts=${normalizedProfile.accounts?.length || 0}`);
    // Only update if newer timestamp or no existing profile
    const existing = profiles.get(profile.entityId);
    const newTimestamp = normalizedProfile.metadata?.lastUpdated || 0;
    const existingTimestamp = existing?.metadata?.lastUpdated || 0;

    const shouldUpdate =
      !existing ||
      newTimestamp > existingTimestamp ||
      (newTimestamp === existingTimestamp && (
        (!existing.runtimeId && !!normalizedProfile.runtimeId) ||
        (existing.runtimeId !== normalizedProfile.runtimeId) ||
        (!!normalizedProfile.metadata?.entityPublicKey && existing.metadata?.entityPublicKey !== normalizedProfile.metadata?.entityPublicKey) ||
        ((existing.accounts?.length || 0) !== (normalizedProfile.accounts?.length || 0))  // Accept if accounts changed
      ));

    if (shouldUpdate) {
      profiles.set(profile.entityId, normalizedProfile);
      logDebug('GOSSIP', `📡 Gossip SAVED: ${profile.entityId.slice(-4)} ts=${newTimestamp} accounts=${normalizedProfile.accounts?.length || 0}`);

      // VERIFY: Check что profile действительно сохранился
      const verify = profiles.get(profile.entityId);
      logDebug('GOSSIP', `✅ VERIFY after SET: ${profile.entityId.slice(-4)} accounts=${verify?.accounts?.length || 0} (should be ${normalizedProfile.accounts?.length})`);
    } else {
      logDebug('GOSSIP', `📡 Gossip REJECTED: ${profile.entityId.slice(-4)} ts=${newTimestamp}<=${existingTimestamp}`);
    }
  };

  const getProfiles = (): Profile[] => {
    pruneExpiredProfiles();
    const result = Array.from(profiles.values());
    logDebug('GOSSIP', `🔍 getProfiles(): Returning ${result.length} profiles`);
    for (const p of result) {
      logDebug('GOSSIP', `  - ${p.entityId.slice(-4)}: accounts=${p.accounts?.length || 0} ts=${p.metadata?.lastUpdated}`);
    }
    return result;
  };

  // Get all hubs (profiles with isHub=true)
  const getHubs = (): Profile[] => {
    pruneExpiredProfiles();
    const hubs = Array.from(profiles.values()).filter(
      p =>
        p.metadata?.isHub === true ||
        p.capabilities?.includes('hub') === true ||
        p.capabilities?.includes('routing') === true
    );
    logDebug('GOSSIP', `🏠 getHubs(): Found ${hubs.length} hubs`);
    for (const h of hubs) {
      logDebug('GOSSIP', `  - ${h.entityId.slice(-4)}: ${h.metadata?.name || 'unnamed'} region=${h.metadata?.region || 'unknown'}`);
    }
    return hubs;
  };

  const getProfileBundle = (entityId: string): { profile?: Profile; peers: Profile[] } => {
    pruneExpiredProfiles();
    const profile = profiles.get(entityId);
    if (!profile) {
      return { peers: [] };
    }
    const peerIds = profile.publicAccounts || profile.hubs || [];
    const peers = peerIds.map(id => profiles.get(id)).filter(Boolean) as Profile[];
    return { profile, peers };
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
        const minAmount = amount ?? FINANCIAL.MIN_PAYMENT_AMOUNT;

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
    getHubs,
    getProfileBundle,
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
          runtimeId: profile.runtimeId,
          capabilities: profile.capabilities || [],
          publicAccounts: profile.publicAccounts || profile.hubs || [],
          hubs: profile.hubs || profile.publicAccounts || [],
          endpoints: profile.endpoints || [],
          relays: profile.relays || [],
          metadata: {
            name: profile.name,
            avatar: profile.avatar,
            bio: profile.bio,
            website: profile.website,
            lastUpdated: profile.lastUpdated,
            hankoSignature: profile.hankoSignature,
            entityPublicKey: profile.entityPublicKey,
          },
        });
        profileCount++;
      } catch (parseError) {
        console.warn(`⚠️ Failed to parse profile from key ${key}:`, parseError);
      }
    }

    logDebug('GOSSIP', `📡 Restored ${profileCount} profiles from DB into gossip`);
    return profileCount;
  } catch (error) {
    console.error('❌ Failed to load persisted profiles:', error);
    return 0;
  }
}
