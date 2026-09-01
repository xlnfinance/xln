// Framework-neutral view model for the workspace Gossip panel. Runtime reads
// stay with the owning client adapter; this module only projects typed Runtime
// evidence and applies deterministic directory presentation rules.

import type { Profile as GossipProfile, RuntimeAdapterEntitySummary } from '@xln/core/api/public/runtime-module';

import { compareStableText } from '../../ui/src/stable-compare';

export type GossipDirectoryProfile = Readonly<{
  entityId: string;
  name: string;
  runtimeId: string;
  lastUpdated: number;
  isHub: boolean;
  height?: number;
  jurisdictionName?: string;
}>;

export type GossipDirectoryView = Readonly<{
  profiles: GossipDirectoryProfile[];
  profileCount: number;
  hubCount: number;
  lastRefreshAt: number;
}>;

export const emptyGossipDirectoryView = (): GossipDirectoryView => ({
  profiles: [],
  profileCount: 0,
  hubCount: 0,
  lastRefreshAt: 0,
});

const normalizeEntityId = (value: string): string => value.trim().toLowerCase();

const projectProfile = (profile: GossipProfile): GossipDirectoryProfile => ({
  entityId: String(profile.entityId || '').trim(),
  name: String(profile.name || '').trim(),
  runtimeId: String(profile.runtimeId || '').trim(),
  lastUpdated: Number(profile.lastUpdated || 0),
  isHub: profile.metadata.isHub === true,
});

const projectRuntimeEntitySummary = (
  summary: RuntimeAdapterEntitySummary,
  runtimeId: string,
): GossipDirectoryProfile => {
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
};

const compareProfiles = (left: GossipDirectoryProfile, right: GossipDirectoryProfile): number => {
  if (left.isHub !== right.isHub) return left.isHub ? -1 : 1;
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  if (leftName && rightName && leftName !== rightName) return compareStableText(leftName, rightName);
  return compareStableText(left.entityId, right.entityId);
};

const buildDirectoryView = (profiles: readonly GossipDirectoryProfile[]): GossipDirectoryView => {
  const sortedProfiles = [...profiles].sort(compareProfiles);
  return {
    profiles: sortedProfiles,
    profileCount: sortedProfiles.length,
    hubCount: sortedProfiles.filter((profile) => profile.isHub).length,
    lastRefreshAt: sortedProfiles.reduce((latest, profile) => Math.max(latest, profile.lastUpdated), 0),
  };
};

const projectUnblockedProfiles = <T>(
  values: readonly T[],
  project: (value: T) => GossipDirectoryProfile,
  blockedCounterpartyIds: ReadonlySet<string> = new Set<string>(),
): GossipDirectoryProfile[] => {
  const blocked = new Set([...blockedCounterpartyIds].map(normalizeEntityId).filter(Boolean));
  return values
    .map(project)
    .filter((profile) => profile.entityId && !blocked.has(normalizeEntityId(profile.entityId)));
};

export const buildGossipDirectoryView = (input: {
  profiles: readonly GossipProfile[];
  blockedCounterpartyIds?: ReadonlySet<string>;
}): GossipDirectoryView => buildDirectoryView(
  projectUnblockedProfiles(input.profiles, projectProfile, input.blockedCounterpartyIds),
);

export const buildGossipDirectoryViewFromRuntimeEntities = (input: {
  entities: readonly RuntimeAdapterEntitySummary[];
  runtimeId?: string | null;
  blockedCounterpartyIds?: ReadonlySet<string>;
}): GossipDirectoryView => {
  const runtimeId = String(input.runtimeId || '').trim();
  return buildDirectoryView(projectUnblockedProfiles(
    input.entities,
    (summary) => projectRuntimeEntitySummary(summary, runtimeId),
    input.blockedCounterpartyIds,
  ));
};

export const filterGossipDirectoryProfiles = (
  profiles: readonly GossipDirectoryProfile[],
  search: string,
): GossipDirectoryProfile[] => {
  const needle = search.trim().toLowerCase();
  if (!needle) return [...profiles];
  return profiles.filter((profile) => [
    profile.name,
    profile.entityId,
    profile.runtimeId,
    profile.jurisdictionName ?? '',
  ].some((value) => value.toLowerCase().includes(needle)));
};

export const getGossipDirectoryDisplayName = (profile: GossipDirectoryProfile): string =>
  profile.name || profile.entityId;
