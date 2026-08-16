/**
 * Produces a detached post-commit Runtime view for Svelte consumers.
 * Consensus candidates, live infrastructure, and mutable Gossip maps must not
 * alias the UI projection or render uncommitted financial state. [88/100]
 */

import type { RuntimeReplica, EnvSnapshot } from '@xln/runtime/api/public/runtime-module';
import type { Profile } from '@xln/runtime/api/public/runtime-module';

const LIVE_RUNTIME_ENV_KEY = '__xlnLiveEnv';

type RuntimeViewEnv = RuntimeReplica & { [LIVE_RUNTIME_ENV_KEY]?: RuntimeReplica };

const detachedMutation = (): never => {
  throw new Error('DETACHED_RUNTIME_VIEW_MUTATION_FORBIDDEN');
};

const createDetachedGossip = (liveEnv: RuntimeReplica): RuntimeReplica['gossip'] => {
  const profiles = new Map<string, Profile>(
    structuredClone(Array.from(liveEnv.gossip.profiles.entries())),
  );
  const getProfiles = (): Profile[] => Array.from(profiles.values());
  const jurisdictions = new Map(structuredClone(Array.from(liveEnv.gossip.jurisdictions.entries())));
  const hubProfiles = structuredClone(liveEnv.gossip.getHubs());
  return {
    profiles,
    jurisdictions,
    announce: detachedMutation,
    announceJurisdiction: detachedMutation,
    setProfiles: detachedMutation,
    getProfiles,
    getJurisdictions: () => Array.from(jurisdictions.values()),
    getHubs: () => [...hubProfiles],
    getProfileBundle: (entityId: string) => {
      const profile = profiles.get(entityId);
      if (!profile) return { peers: [] };
      return {
        profile,
        peers: profile.publicAccounts
          .map(peerId => profiles.get(peerId))
          .filter((peer): peer is Profile => peer !== undefined),
      };
    },
    getNetworkGraph: detachedMutation,
  };
};

export function isRuntimeLikeEnv(value: unknown): value is RuntimeReplica {
  if (!value || typeof value !== 'object') return false;
  const env = value as {
    state?: { eReplicas?: unknown; jReplicas?: unknown };
  };
  return env.state?.eReplicas instanceof Map && env.state.jReplicas instanceof Map;
}

export function attachLiveRuntimeEnv<T extends object>(viewEnv: T, liveEnv: RuntimeReplica): T {
  Object.defineProperty(viewEnv, LIVE_RUNTIME_ENV_KEY, {
    value: liveEnv,
    enumerable: false,
    configurable: true,
  });
  return viewEnv;
}

export function createDetachedRuntimeViewEnv(liveEnv: RuntimeReplica): RuntimeReplica {
  const { infrastructure: _liveInfrastructure, ...visibleLiveFields } = liveEnv;
  return {
    ...visibleLiveFields,
    // Runtime mutates the H+1 candidate in place for hub-scale performance.
    // A shallow Map copy would still alias every nested Entity/Account and let
    // an unrelated Svelte render expose candidate balances before WAL commit.
    // This UI-only projection is published after commit; cloning it does not
    // add work to headless hubs or to the consensus transition.
    state: structuredClone(liveEnv.state),
    runtimeMempool: structuredClone(liveEnv.runtimeMempool),
    gossip: createDetachedGossip(liveEnv),
    ...(liveEnv.overlay ? { overlay: structuredClone(liveEnv.overlay) } : {}),
    ...(liveEnv.runtimeConfig ? { runtimeConfig: structuredClone(liveEnv.runtimeConfig) } : {}),
    ...(liveEnv.browserVMState ? { browserVMState: structuredClone(liveEnv.browserVMState) } : {}),
    ...(liveEnv.pendingOutputs ? { pendingOutputs: structuredClone(liveEnv.pendingOutputs) } : {}),
    ...(liveEnv.networkInbox ? { networkInbox: structuredClone(liveEnv.networkInbox) } : {}),
    ...(liveEnv.pendingNetworkOutputs
      ? { pendingNetworkOutputs: structuredClone(liveEnv.pendingNetworkOutputs) }
      : {}),
    ...(liveEnv.extra ? { extra: structuredClone(liveEnv.extra) } : {}),
    log: detachedMutation,
    info: detachedMutation,
    warn: detachedMutation,
    error: detachedMutation,
    emit: detachedMutation,
  };
}

export function createRuntimeViewEnv(liveEnv: RuntimeReplica): RuntimeReplica {
  return attachLiveRuntimeEnv(createDetachedRuntimeViewEnv(liveEnv), liveEnv);
}

export function unwrapLiveRuntimeEnv(env: RuntimeReplica | EnvSnapshot | null | undefined): RuntimeReplica | null {
  if (!env || typeof env !== 'object') return null;
  const liveEnv = (env as RuntimeViewEnv)[LIVE_RUNTIME_ENV_KEY];
  if (isRuntimeLikeEnv(liveEnv)) return liveEnv;
  return isRuntimeLikeEnv(env) ? env : null;
}
