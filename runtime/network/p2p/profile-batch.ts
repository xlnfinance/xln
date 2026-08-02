import type { Profile } from '../../entity/profile';
import { compareStableText } from '../../protocol/serialization';

export type GossipProfileBatchRequest = {
  ids?: string[];
  set?: 'default' | 'hubs';
  updatedSince?: number;
  limit?: number;
};

export const DEFAULT_GOSSIP_BATCH_LIMIT = 1000;

const normalizeEntityId = (entityId: unknown): string => String(entityId || '').toLowerCase();

export const isHubProfile = (profile: Profile): boolean =>
  profile.metadata.isHub === true;

export const sortProfilesForBatch = (left: Profile, right: Profile): number => {
  const leftHub = isHubProfile(left);
  const rightHub = isHubProfile(right);
  if (leftHub !== rightHub) return leftHub ? -1 : 1;
  const leftTs = left.lastUpdated;
  const rightTs = right.lastUpdated;
  if (leftTs !== rightTs) return rightTs - leftTs;
  return compareStableText(String(left.entityId), String(right.entityId));
};

export const selectProfileBatch = (
  profiles: readonly Profile[],
  request: GossipProfileBatchRequest = {},
  defaultLimit: number = DEFAULT_GOSSIP_BATCH_LIMIT,
): Profile[] => {
  const maxBatchSize = Math.max(1, Math.floor(defaultLimit));
  const explicitMatches = new Map<string, Profile>();
  const setMatches = new Map<string, Profile>();
  const ids = Array.isArray(request.ids)
    ? Array.from(
        new Set(
          request.ids
            .map(normalizeEntityId)
            .filter((entityId) => entityId.length > 0),
        ),
      ).slice(0, maxBatchSize)
    : [];
  const set = request.set ?? (ids.length === 0 ? 'default' : undefined);
  const updatedSince = typeof request.updatedSince === 'number' && Number.isFinite(request.updatedSince)
    ? request.updatedSince
    : null;
  const boundedLimit = typeof request.limit === 'number' && Number.isFinite(request.limit)
    ? Math.min(maxBatchSize, Math.max(1, Math.floor(request.limit)))
    : maxBatchSize;

  const profilesByEntityId = new Map(
    profiles.map(profile => [normalizeEntityId(profile.entityId), profile] as const),
  );
  for (const entityId of ids) {
    const profile = profilesByEntityId.get(entityId);
    if (profile) {
      explicitMatches.set(entityId, profile);
    }
  }

  let setProfiles: Profile[] = [];
  if (set === 'hubs') {
    setProfiles = [...profiles]
      .filter(isHubProfile)
      .sort(sortProfilesForBatch)
      .slice(0, boundedLimit);
  } else if (set === 'default') {
    setProfiles = [...profiles]
      .sort(sortProfilesForBatch)
      .slice(0, boundedLimit);
  }

  for (const profile of setProfiles) {
    const normalizedEntityId = normalizeEntityId(profile.entityId);
    if (updatedSince !== null && profile.lastUpdated <= updatedSince) {
      continue;
    }
    setMatches.set(normalizedEntityId, profile);
  }

  return Array.from(new Map<string, Profile>([...setMatches, ...explicitMatches]).values())
    .sort(sortProfilesForBatch)
    .slice(0, maxBatchSize);
};
