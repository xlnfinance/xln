import type { Profile as GossipProfile, RuntimeAdapterEntitySummary } from '@xln/runtime/xln-api';

import { compareStableText } from '$lib/utils/stableSort';

export type GossipDirectoryProfile = {
  entityId: string;
  name: string;
  runtimeId: string;
  lastUpdated: number;
  isHub: boolean;
  height?: number;
  jurisdictionName?: string;
};

export type GossipDirectoryView = {
  profiles: GossipDirectoryProfile[];
  profileCount: number;
  hubCount: number;
  lastRefreshAt: number;
};

export const emptyGossipDirectoryView = (): GossipDirectoryView => ({
  profiles: [],
  profileCount: 0,
  hubCount: 0,
  lastRefreshAt: 0,
});

const normalizeEntityId = (value: string): string => String(value || '').trim().toLowerCase();

function projectProfile(profile: GossipProfile): GossipDirectoryProfile {
  return {
    entityId: String(profile.entityId || '').trim(),
    name: String(profile.name || '').trim(),
    runtimeId: String(profile.runtimeId || '').trim(),
    lastUpdated: Number(profile.lastUpdated || 0),
    isHub: profile.metadata.isHub === true,
  };
}

function projectRuntimeEntitySummary(
  summary: RuntimeAdapterEntitySummary,
  runtimeId: string,
): GossipDirectoryProfile {
  const height = Math.max(0, Math.floor(Number(summary.height || 0)));
  const jurisdictionName = String(summary.jurisdiction?.name || '').trim();
  return {
    entityId: String(summary.entityId || '').trim(),
    name: String(summary.label || summary.entityId || '').trim(),
    runtimeId,
    lastUpdated: 0,
    isHub: summary.isHub === true,
    ...(height > 0 ? { height } : {}),
    ...(jurisdictionName ? { jurisdictionName } : {}),
  };
}

function compareProfiles(a: GossipDirectoryProfile, b: GossipDirectoryProfile): number {
  if (a.isHub !== b.isHub) return a.isHub ? -1 : 1;
  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  if (aName && bName && aName !== bName) return compareStableText(aName, bName);
  return compareStableText(a.entityId, b.entityId);
}

export function buildGossipDirectoryView(input: {
  profiles: GossipProfile[];
  blockedCounterpartyIds?: Set<string>;
}): GossipDirectoryView {
  const blocked = new Set(
    [...(input.blockedCounterpartyIds ?? new Set<string>())]
      .map(normalizeEntityId)
      .filter(Boolean),
  );
  const projected = input.profiles
    .map(projectProfile)
    .filter((profile) => profile.entityId && !blocked.has(normalizeEntityId(profile.entityId)));

  projected.sort(compareProfiles);

  return {
    profiles: projected,
    profileCount: projected.length,
    hubCount: projected.filter((profile) => profile.isHub).length,
    lastRefreshAt: projected.reduce((max, profile) => Math.max(max, profile.lastUpdated), 0),
  };
}

export function buildGossipDirectoryViewFromRuntimeEntities(input: {
  entities: RuntimeAdapterEntitySummary[];
  runtimeId?: string | null;
  blockedCounterpartyIds?: Set<string>;
}): GossipDirectoryView {
  const blocked = new Set(
    [...(input.blockedCounterpartyIds ?? new Set<string>())]
      .map(normalizeEntityId)
      .filter(Boolean),
  );
  const runtimeId = String(input.runtimeId || '').trim();
  const projected = input.entities
    .map((summary) => projectRuntimeEntitySummary(summary, runtimeId))
    .filter((profile) => profile.entityId && !blocked.has(normalizeEntityId(profile.entityId)));

  projected.sort(compareProfiles);

  return {
    profiles: projected,
    profileCount: projected.length,
    hubCount: projected.filter((profile) => profile.isHub).length,
    lastRefreshAt: 0,
  };
}
