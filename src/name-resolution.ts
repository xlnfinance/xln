/**
 * Name Resolution & Profile Management System
 *
 * Combines basic name registry with gossip layer for profile storage.
 * Includes autocomplete functionality and hanko-signed profile updates.
 */

import { decode, encode } from './snapshot-coder';
import { EntityProfile, EntityTx, Env, NameIndex, NameSearchResult, ProfileUpdateTx } from './types';
import { formatEntityDisplay, generateEntityAvatar } from './utils';

// === PROFILE STORAGE ===

/**
 * Store entity profile in gossip layer
 */
export const storeProfile = async (db: any, profile: EntityProfile): Promise<void> => {
  if (!db) return;

  try {
    // Store profile (using encode for BigInt safety)
    await db.put(`profile:${profile.entityId}`, encode(profile));

    // Update name index for autocomplete
    await updateNameIndex(db, profile.name, profile.entityId);

    console.log(`📝 Stored profile for ${profile.name} (${formatEntityDisplay(profile.entityId)})`);
  } catch {
    // Silent skip - DB unavailable or in-memory mode
  }
};

/**
 * Get entity profile from gossip layer
 */
export const getProfile = async (db: any, entityId: string): Promise<EntityProfile | null> => {
  if (!db) return null;

  try {
    const data = await db.get(`profile:${entityId}`);
    return decode(data) as EntityProfile;
  } catch (error) {
    // Profile doesn't exist - return null
    return null;
  }
};

/**
 * Update name index for autocomplete
 */
const updateNameIndex = async (db: any, name: string, entityId: string): Promise<void> => {
  try {
    // Get existing index
    let nameIndex: NameIndex = {};
    try {
      const data = await db.get('name-index');
      nameIndex = decode(data);
    } catch {
      // Index doesn't exist yet
    }

    // Update index
    nameIndex[name.toLowerCase()] = entityId;

    // Store updated index (using encode for BigInt safety)
    await db.put('name-index', encode(nameIndex));
  } catch (error) {
    console.error('Error updating name index:', error);
  }
};

// === AUTOCOMPLETE SYSTEM ===

/**
 * Search entity names with autocomplete
 */
export const searchEntityNames = async (db: any, query: string, limit: number = 10): Promise<NameSearchResult[]> => {
  if (!db || !query.trim()) return [];

  try {
    // Get name index
    const data = await db.get('name-index');
    const nameIndex: NameIndex = decode(data);

    const queryLower = query.toLowerCase();
    const results: NameSearchResult[] = [];

    // Search through names
    for (const [name, entityId] of Object.entries(nameIndex)) {
      if (name.includes(queryLower)) {
        // Calculate relevance score
        let relevance = 0;
        if (name.startsWith(queryLower)) {
          relevance = 1.0; // Exact prefix match
        } else if (name.includes(queryLower)) {
          relevance = 0.7; // Contains query
        }

        // Get avatar (generated or custom)
        const profile = await getProfile(db, entityId);
        const avatar = profile?.avatar || generateEntityAvatar(entityId);

        results.push({
          entityId,
          name: profile?.name || formatEntityDisplay(entityId),
          avatar,
          relevance,
        });
      }
    }

    // Sort by relevance and name
    results.sort((a, b) => {
      if (a.relevance !== b.relevance) {
        return b.relevance - a.relevance; // Higher relevance first
      }
      return a.name.localeCompare(b.name); // Alphabetical
    });

    return results.slice(0, limit);
  } catch (error) {
    console.error('Error searching entity names:', error);
    return [];
  }
};

// === PROFILE UPDATES VIA CONSENSUS ===

/**
 * Create profile update transaction
 */
export const createProfileUpdateTx = (updates: ProfileUpdateTx): EntityTx => {
  return {
    type: 'profile-update' as const,
    data: updates, // Remove unsafe type assertion
  } as EntityTx;
};

/**
 * Process profile update transaction
 */
export const processProfileUpdate = async (
  db: any,
  entityId: string,
  updates: ProfileUpdateTx,
  hankoSignature: string,
  env?: Env,
): Promise<void> => {
  console.log(`🏷️ processProfileUpdate called for ${entityId} with updates:`, updates);
  try {
    // Get existing profile or create new one
    let profile = await getProfile(db, entityId);

    if (!profile) {
      // Create new profile with defaults
      profile = {
        entityId,
        name: formatEntityDisplay(entityId), // Default to formatted entity ID
        lastUpdated: Date.now(),
        hankoSignature,
      };
    }

    // Apply updates
    if (updates.name !== undefined) profile.name = updates.name;
    if (updates.avatar !== undefined) profile.avatar = updates.avatar;
    if (updates.bio !== undefined) profile.bio = updates.bio;
    if (updates.website !== undefined) profile.website = updates.website;

    // Update metadata
    profile.lastUpdated = Date.now();
    profile.hankoSignature = hankoSignature;

    // Sync to gossip layer FIRST (before storing) to ensure it's captured in snapshots
    if (env?.gossip?.announce) {
      try {
        env.gossip.announce({
          entityId,
          capabilities: [], // ProfileUpdateTx doesn't include capabilities - use empty default
          hubs: [], // ProfileUpdateTx doesn't include hubs - use empty default
          metadata: {
            name: profile.name,
            avatar: profile.avatar,
            bio: profile.bio,
            website: profile.website,
            lastUpdated: profile.lastUpdated,
            hankoSignature: profile.hankoSignature,
          },
        });
        console.log(`📡 Synced profile update to gossip: ${entityId}`);
      } catch (gossipError) {
        console.error(`❌ Failed to sync profile to gossip layer for ${entityId}:`, gossipError);
      }
    }

    // Store updated profile to database after gossip sync
    await storeProfile(db, profile);

    console.log(`✅ Updated profile for ${profile.name} (${formatEntityDisplay(entityId)})`);
  } catch (error) {
    console.error('Error processing profile update:', error);
  }
};
// === NAME RESOLUTION HELPERS ===

/**
 * Resolve entity ID to display name
 */
export const resolveEntityName = async (db: any, entityId: string): Promise<string> => {
  const profile = await getProfile(db, entityId);
  return profile?.name || formatEntityDisplay(entityId);
};

/**
 * Get entity display info (name + avatar)
 */
export const getEntityDisplayInfo = async (db: any, entityId: string): Promise<{ name: string; avatar: string }> => {
  const profile = await getProfile(db, entityId);
  return {
    name: profile?.name || formatEntityDisplay(entityId),
    avatar: profile?.avatar || generateEntityAvatar(entityId),
  };
};
