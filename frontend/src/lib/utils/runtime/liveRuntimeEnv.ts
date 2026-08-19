/**
 * Produces a detached post-commit Runtime view for Svelte consumers.
 * Consensus candidates, live infrastructure, and mutable Gossip maps must not
 * alias the UI projection or render uncommitted financial state. [88/100]
 */

import type { EnvSnapshot, Profile, RuntimeReplica } from '@xln/core/api/public/runtime-module';

const LIVE_RUNTIME_ENV_KEY = '__xlnLiveEnv';

type RuntimeViewEnv = RuntimeReplica & { [LIVE_RUNTIME_ENV_KEY]?: RuntimeReplica };

/**
 * Committed/candidate Patricia maps (PersistentEntityAccountMap,
 * EntityAccountCandidateMap, ...) implement ReadonlyMap but are not
 * `instanceof Map`. Duck-type instead wherever code needs to recognize them.
 */
export const isMapLike = (value: unknown): value is ReadonlyMap<unknown, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ReadonlyMap<unknown, unknown>> & { size?: unknown };
  return typeof candidate.entries === 'function'
    && typeof candidate.get === 'function'
    && typeof candidate.size === 'number';
};

/**
 * UI snapshots cannot `structuredClone` Patricia maps: they are ReadonlyMap
 * classes, not JS Map, so the clone is a prototype-less object without
 * `.entries()`. Walk map-likes into real Maps so Svelte/e2e keep Map APIs.
 */
const cloneForRuntimeView = (value: unknown, seen: Map<object, unknown>): unknown => {
  if (value === null || typeof value !== 'object') return value;
  const cached = seen.get(value);
  if (cached) return cached;
  if (isMapLike(value)) {
    const out = new Map();
    seen.set(value, out);
    for (const [key, entry] of value.entries()) {
      out.set(cloneForRuntimeView(key, seen), cloneForRuntimeView(entry, seen));
    }
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const entry of value) out.add(cloneForRuntimeView(entry, seen));
    return out;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const entry of value) out.push(cloneForRuntimeView(entry, seen));
    return out;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) {
    return structuredClone(value);
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, entry] of Object.entries(value)) {
    out[key] = cloneForRuntimeView(entry, seen);
  }
  return out;
};

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
  return env.state?.eReplicas instanceof Map
    && env.state.jReplicas instanceof Map
    && typeof (value as { gossip?: { getProfiles?: unknown } }).gossip?.getProfiles === 'function';
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
    state: cloneForRuntimeView(liveEnv.state, new Map()) as RuntimeReplica['state'],
    runtimeMempool: structuredClone(liveEnv.runtimeMempool),
    history: structuredClone(liveEnv.history),
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
