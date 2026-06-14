import type { Env, RoutedEntityInput } from './types';
import { createStructuredLogger, shortId } from './logger';
import { RuntimeP2P, type P2PConfig } from './networking/p2p';
import { isRuntimeId } from './networking/runtime-id';
import { assertLocalEntityCryptoKeys } from './runtime-entity-crypto';

export type { P2PConfig } from './networking/p2p';

export type RuntimeP2PLifecycleDeps = {
  ensureRuntimeState: (env: Env) => NonNullable<Env['runtimeState']>;
  notifyEnvChange: (env: Env) => void;
  handleInboundP2PEntityInput: (
    env: Env,
    from: string,
    input: RoutedEntityInput,
    ingressTimestamp?: number,
  ) => void;
};

export type P2PConnectionState = {
  connected: boolean;
  reconnect: { attempt: number; nextAt: number } | null;
  queue: { targetCount: number; totalMessages: number; oldestEntryAge: number; perTarget: Record<string, number> };
  directPeers?: Array<{ runtimeId: string; endpoint: string; open: boolean }>;
};

type P2Pish = {
  matchesIdentity?: (runtimeId: string, signerId?: string) => boolean;
  updateConfig?: (config: P2PConfig) => void;
  isConnected?: () => boolean;
  connect?: () => void;
  close?: () => void;
};

const p2pLifecycleLog = createStructuredLogger('p2p.lifecycle');
const ENV_P2P_SINGLETON_KEY = Symbol.for('xln.runtime.env.p2p.singleton');
const envRecord = (env: Env): Record<PropertyKey, unknown> => env as unknown as Record<PropertyKey, unknown>;

/**
 * Runtime P2P is process-local infrastructure, not consensus state.
 * Keep the singleton outside storage/projection paths: encrypted entity_input
 * enters through RuntimeP2P and is normalized before it reaches Env.
 */
export const startRuntimeP2P = (
  env: Env,
  config: P2PConfig = {},
  deps: RuntimeP2PLifecycleDeps,
): RuntimeP2P | null => {
  p2pLifecycleLog.debug('start', {
    runtime: shortId(config.runtimeId || env.runtimeId || 'none', 8),
    relays: config.relayUrls?.length ?? 0,
  });
  const state = deps.ensureRuntimeState(env);
  state.lastP2PConfig = config;
  assertLocalEntityCryptoKeys(env);
  const resolvedRuntimeId = config.runtimeId || env.runtimeId;
  if (!resolvedRuntimeId || !isRuntimeId(resolvedRuntimeId)) {
    p2pLifecycleLog.debug('start.pending_runtime_id');
    state.pendingP2PConfig = config;
    return null;
  }

  const existingGlobalP2P = envRecord(env)[ENV_P2P_SINGLETON_KEY] as P2Pish | undefined;
  if (existingGlobalP2P && existingGlobalP2P !== state.p2p) {
    const canReuse =
      typeof existingGlobalP2P.matchesIdentity === 'function' &&
      existingGlobalP2P.matchesIdentity(resolvedRuntimeId, config.signerId);
    if (!canReuse) {
      throw new Error(
        `P2P_SINGLETON_VIOLATION: attempted second p2p attachment for env runtimeId=${resolvedRuntimeId}`,
      );
    }
    if (typeof existingGlobalP2P.updateConfig === 'function') {
      existingGlobalP2P.updateConfig(config);
    }
    if (
      typeof existingGlobalP2P.isConnected === 'function' &&
      !existingGlobalP2P.isConnected() &&
      typeof existingGlobalP2P.connect === 'function'
    ) {
      existingGlobalP2P.connect();
    }
    state.p2p = existingGlobalP2P as RuntimeP2P;
    return state.p2p;
  }

  if (state.p2p) {
    if (state.p2p.matchesIdentity(resolvedRuntimeId, config.signerId)) {
      state.p2p.updateConfig(config);
      if (!state.p2p.isConnected()) {
        state.p2p.connect();
      }
      return state.p2p;
    }
    state.p2p.close();
  }

  const p2pOptions: ConstructorParameters<typeof RuntimeP2P>[0] = {
    env,
    runtimeId: resolvedRuntimeId,
    onEntityInput: (from, input, ingressTimestamp) => {
      deps.handleInboundP2PEntityInput(env, from, input, ingressTimestamp);
    },
    onGossipProfiles: (_from, profiles) => {
      if (profiles.length === 0) return;
      deps.notifyEnvChange(env);
      env.info('network', 'GOSSIP_PROFILE_UPDATE', {
        count: profiles.length,
        entityIds: profiles.map(profile => profile.entityId),
      });
      if (env.quietRuntimeLogs !== true) {
        p2pLifecycleLog.info('gossip.accepted', {
          count: profiles.length,
          entities: profiles.map(profile => shortId(profile.entityId, 6)),
        });
      }
    },
  };
  if (config.signerId !== undefined) p2pOptions.signerId = config.signerId;
  if (config.relayUrls !== undefined) p2pOptions.relayUrls = config.relayUrls;
  const configuredWsUrl = (config as P2PConfig & { wsUrl?: string | null }).wsUrl;
  if (configuredWsUrl !== undefined) p2pOptions.wsUrl = configuredWsUrl;
  if (config.allowDirectClients !== undefined) p2pOptions.allowDirectClients = config.allowDirectClients;
  if (config.seedRuntimeIds !== undefined) p2pOptions.seedRuntimeIds = config.seedRuntimeIds;
  if (config.advertiseEntityIds !== undefined) p2pOptions.advertiseEntityIds = config.advertiseEntityIds;
  if (config.gossipPollMs !== undefined) p2pOptions.gossipPollMs = config.gossipPollMs;

  state.p2p = new RuntimeP2P(p2pOptions);

  envRecord(env)[ENV_P2P_SINGLETON_KEY] = state.p2p;
  state.p2p.connect();
  return state.p2p;
};

export const startPendingRuntimeP2PIfReady = (
  env: Env,
  deps: RuntimeP2PLifecycleDeps,
): void => {
  const state = deps.ensureRuntimeState(env);
  if (!state.pendingP2PConfig || !env.runtimeId) return;
  const config = state.pendingP2PConfig;
  state.pendingP2PConfig = null;
  p2pLifecycleLog.debug('start.pending_config_ready', {
    runtime: shortId(env.runtimeId, 8),
    relays: config.relayUrls?.length ?? 0,
  });
  startRuntimeP2P(env, config, deps);
};

export const stopRuntimeP2P = (env: Env, deps: RuntimeP2PLifecycleDeps): void => {
  const state = deps.ensureRuntimeState(env);
  if (state.p2p) {
    state.p2p.close();
    const singleton = envRecord(env)[ENV_P2P_SINGLETON_KEY];
    if (singleton === state.p2p) {
      delete envRecord(env)[ENV_P2P_SINGLETON_KEY];
    }
    state.p2p = null;
  }
  state.lastP2PConfig = null;
};

export const detachRuntimeP2P = (env: Env, deps: RuntimeP2PLifecycleDeps): void => {
  const state = env.runtimeState;
  if (!state?.p2p) return;
  try {
    state.p2p.close();
  } catch (error) {
    console.warn('⚠️ Failed to close P2P during runtime detach:', error instanceof Error ? error.message : error);
  }
  const singleton = envRecord(env)[ENV_P2P_SINGLETON_KEY];
  if (singleton === state.p2p) {
    delete envRecord(env)[ENV_P2P_SINGLETON_KEY];
  }
  state.p2p = null;
  deps.ensureRuntimeState(env);
};

export const getRuntimeP2P = (env: Env, deps: RuntimeP2PLifecycleDeps): RuntimeP2P | null =>
  deps.ensureRuntimeState(env).p2p ?? null;

export const getRuntimeP2PState = (env: Env, deps: RuntimeP2PLifecycleDeps): P2PConnectionState => {
  const p2p = getRuntimeP2P(env, deps);
  if (!p2p) {
    return {
      connected: false,
      reconnect: null,
      queue: { targetCount: 0, totalMessages: 0, oldestEntryAge: 0, perTarget: {} },
      directPeers: [],
    };
  }
  return {
    connected: p2p.isConnected(),
    reconnect: p2p.getReconnectState(),
    queue: p2p.getQueueState(),
    directPeers: typeof (p2p as RuntimeP2P & { getDirectPeerState?: () => Array<{ runtimeId: string; endpoint: string; open: boolean }> }).getDirectPeerState === 'function'
      ? (p2p as RuntimeP2P & { getDirectPeerState: () => Array<{ runtimeId: string; endpoint: string; open: boolean }> }).getDirectPeerState()
      : [],
  };
};

export const refreshRuntimeGossip = (env: Env, deps: RuntimeP2PLifecycleDeps): void => {
  const state = deps.ensureRuntimeState(env);
  if (state.p2p) {
    state.p2p.refreshGossip();
  }
};

export const ensureRuntimeGossipProfiles = async (
  env: Env,
  deps: RuntimeP2PLifecycleDeps,
  entityIds: string[],
): Promise<boolean> => {
  const state = deps.ensureRuntimeState(env);
  if (!state.p2p) return false;
  return state.p2p.ensureProfiles(entityIds);
};
