import type { Profile } from '../networking/gossip';

export type GossipProfileBatchRequest = {
  ids?: string[];
  set?: 'default' | 'hubs';
  updatedSince?: number;
  limit?: number;
};

export const DEFAULT_GOSSIP_BATCH_LIMIT = 1000;

const normalizeEntityId = (entityId: unknown): string => String(entityId || '').toLowerCase();

export const isHubProfile = (profile: Profile): boolean =>
  profile.metadata?.isHub === true ||
  profile.capabilities.includes('hub') ||
  profile.capabilities.includes('routing');

export const sortProfilesForBatch = (left: Profile, right: Profile): number => {
  const leftHub = isHubProfile(left);
  const rightHub = isHubProfile(right);
  if (leftHub !== rightHub) return leftHub ? -1 : 1;
  const leftTs = Number(left.metadata?.lastUpdated || 0);
  const rightTs = Number(right.metadata?.lastUpdated || 0);
  if (leftTs !== rightTs) return rightTs - leftTs;
  return String(left.entityId).localeCompare(String(right.entityId));
};

export const selectProfileBatch = (
  profiles: readonly Profile[],
  request: GossipProfileBatchRequest = {},
  defaultLimit: number = DEFAULT_GOSSIP_BATCH_LIMIT,
): Profile[] => {
  const result = new Map<string, Profile>();
  const ids = Array.isArray(request.ids)
    ? Array.from(
        new Set(
          request.ids
            .map(normalizeEntityId)
            .filter((entityId) => entityId.length > 0),
        ),
      )
    : [];
  const set = request.set ?? (ids.length === 0 ? 'default' : undefined);
  const updatedSince = typeof request.updatedSince === 'number' && Number.isFinite(request.updatedSince)
    ? request.updatedSince
    : null;
  const boundedLimit = typeof request.limit === 'number' && Number.isFinite(request.limit)
    ? Math.max(1, Math.floor(request.limit))
    : defaultLimit;

  for (const entityId of ids) {
    const profile = profiles.find((candidate) => normalizeEntityId(candidate.entityId) === entityId);
    if (profile) {
      result.set(entityId, profile);
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
    result.set(normalizeEntityId(profile.entityId), profile);
  }

  return Array.from(result.values())
    .filter((profile) => {
      if (updatedSince === null) return true;
      return Number(profile.metadata?.lastUpdated || 0) > updatedSince;
    })
    .sort(sortProfilesForBatch);
};
