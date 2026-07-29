import { getSignerPrivateKeyIfAvailable, prewarmSignerKeyCache } from '../account/crypto';
import { createStructuredLogger } from '../infra/logger';
import { extractEntityId, extractSignerId } from '../ids';
import { attachEventEmitters } from './env-events';
import { requireRuntimeMempool } from './input-queue';
import { persistGossipProfileToInfraDb } from './infra-gossip-store';
import { ensureRuntimeState } from './runtime-state';
import { createGossipLayer } from '../networking/gossip';
import type { Profile } from '../entity/profile';
import { buildLocalEntityProfile } from '../networking/gossip-helper';
import { deriveRuntimeIdFromSeed, normalizeDbNamespace } from '../storage/runtime-dbs';
import type { RuntimeState } from '../types';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeStateCreateDeps = {
  ensureRuntimeConfig(env: RuntimeState): NonNullable<RuntimeState['runtimeConfig']>;
  infraGossipDbAccess: Parameters<typeof persistGossipProfileToInfraDb>[1];
  trackInfraDbWrite(env: RuntimeState, promise: Promise<void>): void;
};

export const createRuntimeStateApi = (deps: RuntimeStateCreateDeps) => {
  const prewarmRuntimeSignerCache = (seedText: string, count = 20): string[] => {
    try {
      return prewarmSignerKeyCache(seedText, count);
    } catch (error) {
      runtimeLog.error('signer_cache.prewarm_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const createEmptyEnv = (seed?: Uint8Array | string | null): RuntimeState => {
    const normalizedSeed = Array.isArray(seed) ? new Uint8Array(seed) : seed;
    const seedText =
      normalizedSeed !== undefined && normalizedSeed !== null
        ? typeof normalizedSeed === 'string'
          ? normalizedSeed
          : new TextDecoder().decode(normalizedSeed)
        : '';
    const derivedRuntimeId = seedText ? deriveRuntimeIdFromSeed(seedText) : null;
    const resolvedRuntimeId = derivedRuntimeId?.toLowerCase() ?? null;
    const dbNamespace = resolvedRuntimeId ? normalizeDbNamespace(resolvedRuntimeId) : undefined;

    let env!: RuntimeState;
    const gossip = createGossipLayer({
      onAnnounce: profile => {
        if (!env || env.runtimeState?.infraDbClosing) return;
        const write = persistGossipProfileToInfraDb(env, deps.infraGossipDbAccess, profile).catch(error => {
          runtimeLog.warn('infra_db.gossip_persist_failed', {
            entity: String(profile?.entityId || '').slice(-8),
            error: error instanceof Error ? error.message : String(error),
          });
        });
        deps.trackInfraDbWrite(env, write);
      },
      getLiveProfiles: () => {
        if (!env?.eReplicas?.size) return [];
        const profiles = new Map<string, Profile>();
        for (const [replicaKey, replica] of env.eReplicas) {
          const entityId = extractEntityId(replicaKey);
          const signerId = extractSignerId(replicaKey);
          if (
            !entityId ||
            !signerId ||
            getSignerPrivateKeyIfAvailable(env, signerId) === null ||
            profiles.has(entityId)
          ) {
            continue;
          }
          const existingTimestamp =
            env.gossip?.getProfiles?.().find(profile => profile.entityId === entityId)?.lastUpdated ?? 0;
          profiles.set(
            entityId,
            buildLocalEntityProfile(env, replica.state, Math.max(existingTimestamp + 1, env.timestamp || 1)),
          );
        }
        return [...profiles.values()];
      },
    });

    env = {
      eReplicas: new Map(),
      jReplicas: new Map(),
      height: 0,
      timestamp: 0,
      runtimeSeed: seedText,
      ...(resolvedRuntimeId ? { runtimeId: resolvedRuntimeId } : {}),
      ...(dbNamespace ? { dbNamespace } : {}),
      runtimeMempool: { runtimeTxs: [], entityInputs: [] },
      runtimeConfig: undefined,
      runtimeState: undefined,
      history: [],
      gossip,
      frameLogs: [],
      networkInbox: [],
      pendingNetworkOutputs: [],
      log: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      emit: () => {},
      browserVM: null,
    };

    attachEventEmitters(env);
    requireRuntimeMempool(env);
    deps.ensureRuntimeConfig(env);
    ensureRuntimeState(env);
    if (seedText) prewarmRuntimeSignerCache(seedText, 20);
    return env;
  };

  return { createEmptyEnv, prewarmRuntimeSignerCache };
};
