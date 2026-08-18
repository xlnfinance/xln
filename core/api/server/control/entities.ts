import { resolveEntityProposerId } from '../../../runtime/delivery/entity-output-signer';
import { compareStableText } from '../../../protocol/serialization';
import type { RuntimeReplica } from '../../../runtime/types';

export type ControlEntitySummary = {
  entityId: string;
  signerId: string;
  name: string;
  isRoutingEnabled: boolean;
  /** Exact role committed in the local Entity state root. */
  isHub: boolean;
  runtimeId: string | null;
  accountCount: number;
  publicAccountCount: number;
  accountEntityIds: string[];
};

const getProfileNameForEntity = (
  env: RuntimeReplica,
  entityId: string,
  getRelayProfileName: (entityId: string) => string | undefined,
): string => {
  const target = entityId.toLowerCase();
  const localReplica = Array.from(env.state.eReplicas?.values?.() || []).find(replica => String(replica?.entityId || '').toLowerCase() === target);
  const localName = localReplica?.state?.profile?.name;
  const gossipProfile = (env.gossip?.getProfiles?.() || []).find(profile => String(profile?.entityId || '').toLowerCase() === target);
  const rawName = localName ?? gossipProfile?.name ?? getRelayProfileName(target);
  return typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : entityId;
};

export const listLocalControlEntities = (
  env: RuntimeReplica,
  getRelayProfileName: (entityId: string) => string | undefined,
): ControlEntitySummary[] => {
  const seen = new Set<string>();
  const entities: ControlEntitySummary[] = [];
  for (const replica of env.state.eReplicas?.values?.() || []) {
    const entityId = String(replica?.entityId || '').toLowerCase();
    if (!entityId || seen.has(entityId)) continue;
    const signerId = resolveEntityProposerId(env, entityId, 'daemon-control.list');
    seen.add(entityId);
    const profile = replica?.state?.profile as (typeof replica.state.profile & { publicAccounts?: unknown[] }) | undefined;
    // Entity Accounts are a typed Patricia-backed ReadonlyMap, not a native
    // Map. `instanceof Map` silently reported zero Accounts after the storage
    // cutover even though the committed Entity root contained them.
    const accounts = replica.state.accounts;
    entities.push({
      entityId,
      signerId,
      name: getProfileNameForEntity(env, entityId, getRelayProfileName),
      isRoutingEnabled: !!replica?.state?.hubRebalanceConfig,
      isHub: replica?.state?.profile?.isHub === true,
      runtimeId: typeof env.runtimeId === 'string' && env.runtimeId.trim().length > 0 ? env.runtimeId : null,
      accountCount: accounts.size,
      publicAccountCount: Array.isArray(profile?.publicAccounts) ? profile.publicAccounts.length : 0,
      accountEntityIds: Array.from(accounts.keys())
        .map(value => String(value).toLowerCase())
        .sort(compareStableText),
    });
  }
  return entities.sort((left, right) => compareStableText(left.name, right.name));
};
