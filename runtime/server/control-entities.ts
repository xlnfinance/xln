import { resolveEntityProposerId } from '../state-helpers';
import type { Env } from '../types';

export type ControlEntitySummary = {
  entityId: string;
  signerId: string;
  name: string;
  isRoutingEnabled: boolean;
  runtimeId: string | null;
  accountCount: number;
  publicAccountCount: number;
  accountEntityIds: string[];
};

const compareText = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });

const getProfileNameForEntity = (
  env: Env,
  entityId: string,
  getRelayProfileName: (entityId: string) => string | undefined,
): string => {
  const target = entityId.toLowerCase();
  const localReplica = Array.from(env.eReplicas?.values?.() || []).find(replica => String(replica?.entityId || '').toLowerCase() === target);
  const localName = localReplica?.state?.profile?.name;
  const gossipProfile = (env.gossip?.getProfiles?.() || []).find(profile => String(profile?.entityId || '').toLowerCase() === target);
  const rawName = localName ?? gossipProfile?.name ?? getRelayProfileName(target);
  return typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : entityId;
};

export const listLocalControlEntities = (
  env: Env,
  getRelayProfileName: (entityId: string) => string | undefined,
): ControlEntitySummary[] => {
  const seen = new Set<string>();
  const entities: ControlEntitySummary[] = [];
  for (const replica of env.eReplicas?.values?.() || []) {
    const entityId = String(replica?.entityId || '').toLowerCase();
    if (!entityId || seen.has(entityId)) continue;
    let signerId = '';
    try {
      signerId = resolveEntityProposerId(env, entityId, 'daemon-control.list');
    } catch {
      continue;
    }
    seen.add(entityId);
    const profile = replica?.state?.profile as (typeof replica.state.profile & { publicAccounts?: unknown[] }) | undefined;
    entities.push({
      entityId,
      signerId,
      name: getProfileNameForEntity(env, entityId, getRelayProfileName),
      isRoutingEnabled: !!replica?.state?.hubRebalanceConfig,
      runtimeId: typeof env.runtimeId === 'string' && env.runtimeId.trim().length > 0 ? env.runtimeId : null,
      accountCount: replica?.state?.accounts instanceof Map ? replica.state.accounts.size : 0,
      publicAccountCount: Array.isArray(profile?.publicAccounts) ? profile.publicAccounts.length : 0,
      accountEntityIds: replica?.state?.accounts instanceof Map
        ? Array.from(replica.state.accounts.keys()).map(value => String(value).toLowerCase()).sort()
        : [],
    });
  }
  return entities.sort((left, right) => compareText(left.name, right.name));
};
