import type { RuntimeReplica } from '../types.ts';
import { clearInfraGossipProfiles } from '../infra-gossip-store.ts';
import {
  drainInfraDbWrites,
  infraGossipDbAccess,
} from './loop-infrastructure.ts';

/**
 * Gossip is infrastructure state. Clear its durable records before publishing
 * the in-memory change so observers never see a state that persistence rejected.
 */
export const clearRuntimeGossip = async (
  env: RuntimeReplica,
  notifyEnvChange: (env: RuntimeReplica) => void,
  options: { runtimeId?: string } = {},
): Promise<void> => {
  await drainInfraDbWrites(env);
  await clearInfraGossipProfiles(env, infraGossipDbAccess, options);
  const runtimeId = String(options.runtimeId || '').trim().toLowerCase();
  if (!runtimeId) {
    env.gossip?.profiles?.clear();
  } else {
    for (const [entityId, profile] of env.gossip?.profiles ?? []) {
      if (String(profile.runtimeId || '').trim().toLowerCase() === runtimeId) {
        env.gossip.profiles.delete(entityId);
      }
    }
  }
  notifyEnvChange(env);
};
