import { Profile } from './gossip';

export async function loadPersistedProfiles(db: any, gossip: { announce: (p: Profile) => void }) {
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
