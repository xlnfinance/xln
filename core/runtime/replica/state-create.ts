import { getSignerPrivateKeyIfAvailable, prewarmSignerKeyCache } from '../../account/crypto';
import { createStructuredLogger } from '../../support/logger';
import { extractEntityId, extractSignerId } from '../../protocol/identity';
import { attachEventEmitters } from '../observability/env-events';
import { requireRuntimeMempool } from '../mempool/input-queue';
import { persistGossipProfileToInfraDb } from '../envelope/gossip-store';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope';
import { createGossipLayer } from '../../network/p2p/gossip';
import type { Profile } from '../../entity/profile';
import { buildLocalEntityProfile } from '../../network/p2p/gossip/helper';
import { deriveRuntimeIdFromSeed, normalizeDbNamespace } from '../../storage/runtime-dbs';
import type { RuntimeReplica } from '../types';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeStateCreateDeps = {
  ensureRuntimeConfig(env: RuntimeReplica): NonNullable<RuntimeReplica['runtimeConfig']>;
  infraGossipDbAccess: Parameters<typeof persistGossipProfileToInfraDb>[1];
  trackInfraDbWrite(env: RuntimeReplica, promise: Promise<void>): void;
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

  const createEmptyEnv = (seed?: Uint8Array | string | null): RuntimeReplica => {
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

    let env!: RuntimeReplica;
    const gossip = createGossipLayer({
      onAnnounce: profile => {
        if (!env || env.infrastructure?.infraDbClosing) return;
        const write = persistGossipProfileToInfraDb(env, deps.infraGossipDbAccess, profile).catch(error => {
          runtimeLog.warn('infra_db.gossip_persist_failed', {
            entity: String(profile?.entityId || '').slice(-8),
            error: error instanceof Error ? error.message : String(error),
          });
        });
        deps.trackInfraDbWrite(env, write);
      },
      getLiveProfiles: () => {
        if (!env?.state.eReplicas?.size) return [];
        const profiles = new Map<string, Profile>();
        for (const [replicaKey, replica] of env.state.eReplicas) {
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
            buildLocalEntityProfile(env, replica.state, Math.max(existingTimestamp + 1, env.state.timestamp || 1)),
          );
        }
        return [...profiles.values()];
      },
    });

    env = {
      state: {
        eReplicas: new Map(),
        jReplicas: new Map(),
        height: 0,
        timestamp: 0,
      },
      runtimeSeed: seedText,
      ...(resolvedRuntimeId ? { runtimeId: resolvedRuntimeId } : {}),
      ...(dbNamespace ? { dbNamespace } : {}),
      runtimeMempool: { runtimeTxs: [], entityInputs: [] },
      runtimeConfig: undefined,
      infrastructure: undefined,
      gossip,
      networkInbox: [],
      pendingNetworkOutputs: [],
      log: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      emit: () => {},
    };

    attachEventEmitters(env);
    requireRuntimeMempool(env);
    deps.ensureRuntimeConfig(env);
    ensureRuntimeInfrastructure(env);
    if (seedText) prewarmRuntimeSignerCache(seedText, 20);
    return env;
  };

  return { createEmptyEnv, prewarmRuntimeSignerCache };
};
