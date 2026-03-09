/**
 * Profile lookup helpers.
 *
 * Public profile fields live in entity consensus state and are announced into gossip.
 * We do not keep a second profile source of truth in the runtime DB.
 */

import type { EntityTx, Env, NameSearchResult, ProfileUpdateTx } from './types';
import { formatEntityDisplay, generateEntityAvatar } from './utils';

type DisplayProfile = {
  entityId: string;
  name: string;
  avatar: string;
  lastUpdated: number;
};

const normalizeId = (value: string): string => String(value || '').trim().toLowerCase();

const normalizeName = (value: string, entityId: string): string => {
  const trimmed = String(value || '').trim();
  return trimmed.length > 0 ? trimmed : formatEntityDisplay(entityId);
};

const collectProfiles = (env: Env | null | undefined): Map<string, DisplayProfile> => {
  const profiles = new Map<string, DisplayProfile>();
  if (!env) return profiles;

  const gossipProfiles = env.gossip?.getProfiles?.() || [];
  for (const profile of gossipProfiles) {
    const entityId = normalizeId(profile.entityId);
    if (!entityId) continue;
    profiles.set(entityId, {
      entityId,
      name: normalizeName(profile.name, entityId),
      avatar: typeof profile.avatar === 'string' ? profile.avatar : '',
      lastUpdated: Number.isFinite(profile.lastUpdated) ? profile.lastUpdated : 0,
    });
  }

  for (const replica of env.eReplicas.values()) {
    const entityId = normalizeId(replica.entityId);
    if (!entityId) continue;
    const localProfile = replica.state.profile;
    profiles.set(entityId, {
      entityId,
      name: normalizeName(localProfile.name, entityId),
      avatar: localProfile.avatar,
      lastUpdated: Number.isFinite(replica.state.timestamp) ? replica.state.timestamp : env.timestamp,
    });
  }

  return profiles;
};

export const createProfileUpdateTx = (
  updates: ProfileUpdateTx & { entityId: string; hankoSignature?: string },
): EntityTx => {
  return {
    type: 'profile-update',
    data: {
      profile: updates,
    },
  };
};

export const searchEntityNames = async (
  env: Env | null | undefined,
  query: string,
  limit: number = 10,
): Promise<NameSearchResult[]> => {
  const trimmedQuery = String(query || '').trim().toLowerCase();
  if (!trimmedQuery) return [];

  const matches: NameSearchResult[] = [];
  for (const profile of collectProfiles(env).values()) {
    const loweredName = profile.name.toLowerCase();
    if (!loweredName.includes(trimmedQuery)) continue;
    const relevance = loweredName.startsWith(trimmedQuery) ? 1 : 0.7;
    matches.push({
      entityId: profile.entityId,
      name: profile.name,
      avatar: profile.avatar || generateEntityAvatar(profile.entityId),
      relevance,
    });
  }

  matches.sort((left, right) => {
    if (left.relevance !== right.relevance) return right.relevance - left.relevance;
    return left.name.localeCompare(right.name);
  });

  return matches.slice(0, Math.max(1, Math.floor(limit)));
};

export const resolveEntityName = async (
  env: Env | null | undefined,
  entityId: string,
): Promise<string | null> => {
  const normalizedEntityId = normalizeId(entityId);
  if (!normalizedEntityId) return null;
  return collectProfiles(env).get(normalizedEntityId)?.name ?? formatEntityDisplay(normalizedEntityId);
};

export const getEntityDisplayInfo = async (
  env: Env | null | undefined,
  entityId: string,
): Promise<{ name: string; avatar: string }> => {
  const normalizedEntityId = normalizeId(entityId);
  if (!normalizedEntityId) {
    return {
      name: 'Entity',
      avatar: generateEntityAvatar('entity'),
    };
  }

  const profile = collectProfiles(env).get(normalizedEntityId);
  return {
    name: profile?.name ?? formatEntityDisplay(normalizedEntityId),
    avatar: profile?.avatar || generateEntityAvatar(normalizedEntityId),
  };
};
