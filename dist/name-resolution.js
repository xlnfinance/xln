/**
 * Name Resolution & Profile Management System
 *
 * Combines basic name registry with gossip layer for profile storage.
 * Includes autocomplete functionality and hanko-signed profile updates.
 */
import { formatEntityDisplay, generateEntityAvatar } from './utils.js';
// === PROFILE STORAGE ===
/**
 * Store entity profile in gossip layer
 */
export const storeProfile = async (db, profile) => {
    if (!db) {
        console.warn('Database not available for profile storage');
        return;
    }
    try {
        // Store profile
        await db.put(`profile:${profile.entityId}`, JSON.stringify(profile));
        // Update name index for autocomplete
        await updateNameIndex(db, profile.name, profile.entityId);
        console.log(`📝 Stored profile for ${profile.name} (${formatEntityDisplay(profile.entityId)})`);
    }
    catch (error) {
        console.error('Error storing profile:', error);
    }
};
/**
 * Get entity profile from gossip layer
 */
export const getProfile = async (db, entityId) => {
    if (!db)
        return null;
    try {
        const data = await db.get(`profile:${entityId}`);
        return JSON.parse(data);
    }
    catch (error) {
        // Profile doesn't exist - return null
        return null;
    }
};
/**
 * Update name index for autocomplete
 */
const updateNameIndex = async (db, name, entityId) => {
    try {
        // Get existing index
        let nameIndex = {};
        try {
            const data = await db.get('name-index');
            nameIndex = JSON.parse(data);
        }
        catch {
            // Index doesn't exist yet
        }
        // Update index
        nameIndex[name.toLowerCase()] = entityId;
        // Store updated index
        await db.put('name-index', JSON.stringify(nameIndex));
    }
    catch (error) {
        console.error('Error updating name index:', error);
    }
};
// === AUTOCOMPLETE SYSTEM ===
/**
 * Search entity names with autocomplete
 */
export const searchEntityNames = async (db, query, limit = 10) => {
    if (!db || !query.trim())
        return [];
    try {
        // Get name index
        const data = await db.get('name-index');
        const nameIndex = JSON.parse(data);
        const queryLower = query.toLowerCase();
        const results = [];
        // Search through names
        for (const [name, entityId] of Object.entries(nameIndex)) {
            if (name.includes(queryLower)) {
                // Calculate relevance score
                let relevance = 0;
                if (name.startsWith(queryLower)) {
                    relevance = 1.0; // Exact prefix match
                }
                else if (name.includes(queryLower)) {
                    relevance = 0.7; // Contains query
                }
                // Get avatar (generated or custom)
                const profile = await getProfile(db, entityId);
                const avatar = profile?.avatar || generateEntityAvatar(entityId);
                results.push({
                    entityId,
                    name: profile?.name || formatEntityDisplay(entityId),
                    avatar,
                    relevance
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
    }
    catch (error) {
        console.error('Error searching entity names:', error);
        return [];
    }
};
// === PROFILE UPDATES VIA CONSENSUS ===
/**
 * Create profile update transaction
 */
export const createProfileUpdateTx = (updates) => {
    return {
        type: 'profile-update',
        data: updates
    };
};
/**
 * Process profile update transaction
 */
export const processProfileUpdate = async (db, entityId, updates, hankoSignature) => {
    try {
        // Get existing profile or create new one
        let profile = await getProfile(db, entityId);
        if (!profile) {
            // Create new profile with defaults
            profile = {
                entityId,
                name: formatEntityDisplay(entityId), // Default to formatted entity ID
                lastUpdated: Date.now(),
                hankoSignature
            };
        }
        // Apply updates
        if (updates.name !== undefined)
            profile.name = updates.name;
        if (updates.avatar !== undefined)
            profile.avatar = updates.avatar;
        if (updates.bio !== undefined)
            profile.bio = updates.bio;
        if (updates.website !== undefined)
            profile.website = updates.website;
        // Update metadata
        profile.lastUpdated = Date.now();
        profile.hankoSignature = hankoSignature;
        // Store updated profile
        await storeProfile(db, profile);
        console.log(`✅ Updated profile for ${profile.name} (${formatEntityDisplay(entityId)})`);
    }
    catch (error) {
        console.error('Error processing profile update:', error);
    }
};
// === INITIALIZATION & DEMO DATA ===
/**
 * Initialize demo profiles for existing entities
 */
export const initializeDemoProfiles = async (db, env) => {
    if (!db)
        return;
    console.log('🏷️ Initializing demo entity profiles...');
    // Create profiles for existing entities
    const demoProfiles = [
        {
            entityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
            name: 'Trading Collective',
            bio: 'A decentralized trading group focused on DeFi strategies',
            website: 'https://trading-collective.xyz',
            lastUpdated: Date.now(),
            hankoSignature: 'demo_signature_1'
        },
        {
            entityId: '0x0000000000000000000000000000000000000000000000000000000000000002',
            name: 'Governance DAO',
            bio: 'Multi-signature governance entity for protocol decisions',
            website: 'https://governance-dao.org',
            lastUpdated: Date.now(),
            hankoSignature: 'demo_signature_2'
        }
    ];
    // Store demo profiles
    for (const profile of demoProfiles) {
        await storeProfile(db, profile);
    }
    console.log(`✅ Initialized ${demoProfiles.length} demo profiles`);
};
// === NAME RESOLUTION HELPERS ===
/**
 * Resolve entity ID to display name
 */
export const resolveEntityName = async (db, entityId) => {
    const profile = await getProfile(db, entityId);
    return profile?.name || formatEntityDisplay(entityId);
};
/**
 * Get entity display info (name + avatar)
 */
export const getEntityDisplayInfo = async (db, entityId) => {
    const profile = await getProfile(db, entityId);
    return {
        name: profile?.name || formatEntityDisplay(entityId),
        avatar: profile?.avatar || generateEntityAvatar(entityId)
    };
};
