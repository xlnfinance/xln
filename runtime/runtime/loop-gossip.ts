import type { RuntimeState } from '../types';
import { clearInfraGossipProfiles } from './infra-gossip-store';
import {
  drainInfraDbWrites,
  infraGossipDbAccess,
} from './loop-infrastructure';

/**
 * Gossip is infrastructure state. Clear its durable records before publishing
 * the in-memory change so observers never see a state that persistence rejected.
 */
export const clearRuntimeGossip = async (
  env: RuntimeState,
  notifyEnvChange: (env: RuntimeState) => void,
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
