/**
 * Exact wire decoder and deterministic selector for bounded Gossip batches.
 * Profiles and jurisdiction discovery share this request so relay and Runtime
 * cannot disagree about filters, limits, or optional discovery authority. [82/100]
 */

import { isHubProfile, type Profile } from '../../../entity/profile';
import { compareStableText } from '../../../protocol/serialization';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary-validation';

export type GossipProfileBatchRequest = {
  ids?: string[];
  set?: 'default' | 'hubs';
  updatedSince?: number;
  limit?: number;
  includeJurisdictions?: boolean;
};

export const DEFAULT_GOSSIP_BATCH_LIMIT = 1000;

export const decodeGossipProfileBatchRequest = (value: unknown): GossipProfileBatchRequest => {
  const request = requireBoundaryRecord(value, 'P2P_GOSSIP_REQUEST_INVALID');
  requireExactBoundaryKeys(
    request,
    [],
    ['ids', 'set', 'updatedSince', 'limit', 'includeJurisdictions'],
    'P2P_GOSSIP_REQUEST_FIELDS_INVALID',
  );
  const ids = request['ids'];
  if (ids !== undefined && (!Array.isArray(ids) || ids.some(
    id => typeof id !== 'string' || id.length > 128,
  ))) throw new Error('P2P_GOSSIP_REQUEST_IDS_INVALID');
  const set = request['set'];
  if (set !== undefined && set !== 'default' && set !== 'hubs') {
    throw new Error('P2P_GOSSIP_REQUEST_SET_INVALID');
  }
  for (const field of ['updatedSince', 'limit'] as const) {
    const candidate = request[field];
    if (candidate !== undefined && (!Number.isSafeInteger(candidate) || Number(candidate) < 0)) {
      throw new Error(`P2P_GOSSIP_REQUEST_${field.toUpperCase()}_INVALID`);
    }
  }
  const includeJurisdictions = request['includeJurisdictions'];
  if (includeJurisdictions !== undefined && typeof includeJurisdictions !== 'boolean') {
    throw new Error('P2P_GOSSIP_REQUEST_INCLUDE_JURISDICTIONS_INVALID');
  }
  return {
    ...(ids === undefined ? {} : { ids: [...ids] }),
    ...(set === undefined ? {} : { set }),
    ...(request['updatedSince'] === undefined ? {} : { updatedSince: Number(request['updatedSince']) }),
    ...(request['limit'] === undefined ? {} : { limit: Number(request['limit']) }),
    ...(includeJurisdictions === undefined ? {} : { includeJurisdictions }),
  };
};

const normalizeEntityId = (entityId: unknown): string => String(entityId || '').toLowerCase();

const sortProfilesForBatch = (left: Profile, right: Profile): number => {
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
