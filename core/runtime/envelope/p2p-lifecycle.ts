/**
 * Owns the process-local RuntimeP2P lifecycle and binds network callbacks to
 * one Runtime replica. It restores signed discovery records but never moves
 * transport state into deterministic Runtime/Entity/Account state. [91/100]
 */

import type { RuntimeReplica, RoutedEntityInput, RuntimeEntityInputsEnvelope } from '../types';
import { createStructuredLogger, shortId } from '../../support/logger';
import { RuntimeP2P, type P2PConfig } from '../../network/p2p/p2p';
import {
  getConfiguredOfficialFoundationSignerId,
  loadJurisdictions,
} from '../../jurisdiction/adapter/kernel/jurisdiction-loader';
import { isRuntimeId } from '../../network/p2p/auth/runtime-id';
import {
  provisionEntityEncryptionKey,
  requireEntityEncryptionPrivateKey,
} from '../../entity/auth/crypto';
import type { RuntimeInboundEntityInputsResult, RuntimeInboundEntityInputOptions } from '../delivery/topology/entity-routing';

export type { P2PConfig } from '../../network/p2p/p2p';

export type RuntimeP2PLifecycleDeps = {
  ensureRuntimeInfrastructure: (env: RuntimeReplica) => NonNullable<RuntimeReplica['infrastructure']>;
  notifyEnvChange: (env: RuntimeReplica) => void;
  handleInboundP2PEntityInputs: (
    env: RuntimeReplica,
    from: string,
    envelope: RuntimeEntityInputsEnvelope,
    ingressTimestamp?: number,
    options?: RuntimeInboundEntityInputOptions,
  ) => RuntimeInboundEntityInputsResult;
  enqueueRuntimeInputs: (env: RuntimeReplica, inputs: RoutedEntityInput[]) => void;
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
  isConnecting?: () => boolean;
  connect?: () => void;
  close?: () => void;
  closeAndWait?: (timeoutMs?: number) => Promise<void>;
};

const p2pLifecycleLog = createStructuredLogger('p2p.lifecycle');
const ENV_P2P_SINGLETON_KEY = Symbol.for('xln.runtime.env.p2p.singleton');
type RuntimeStateWithP2PSingleton = RuntimeReplica & {
  [ENV_P2P_SINGLETON_KEY]?: P2Pish;
};

const p2pState = (env: RuntimeReplica): RuntimeStateWithP2PSingleton => env;

const reconnectP2P = (p2p: P2Pish): void => {
  const connecting = p2p.isConnecting?.() === true;
  if (p2p.isConnected?.() === false && !connecting) p2p.connect?.();
};

const reuseProcessP2P = (
  env: RuntimeReplica,
  state: NonNullable<RuntimeReplica['infrastructure']>,
  config: P2PConfig,
  runtimeId: string,
): RuntimeP2P | null => {
  const singleton = p2pState(env)[ENV_P2P_SINGLETON_KEY];
  if (!singleton || singleton === state.p2p) return null;
  if (singleton.matchesIdentity?.(runtimeId, config.signerId) !== true) {
    throw new Error(
      `P2P_SINGLETON_VIOLATION: attempted second p2p attachment for env runtimeId=${runtimeId}`,
    );
  }
  singleton.updateConfig?.(config);
  reconnectP2P(singleton);
  state.p2p = singleton as RuntimeP2P;
  return state.p2p;
};

const reuseAttachedP2P = (
  state: NonNullable<RuntimeReplica['infrastructure']>,
  config: P2PConfig,
  runtimeId: string,
): RuntimeP2P | null => {
  const attached = state.p2p;
  if (!attached) return null;
  if (!attached.matchesIdentity(runtimeId, config.signerId)) {
    attached.close();
    return null;
  }
  attached.updateConfig(config);
  reconnectP2P(attached);
  return attached;
};

const buildRuntimeP2POptions = (
  env: RuntimeReplica,
  config: P2PConfig,
  runtimeId: string,
  deps: RuntimeP2PLifecycleDeps,
): ConstructorParameters<typeof RuntimeP2P>[0] => {
  const discovery = typeof window === 'undefined' ? loadJurisdictions() : null;
  const officialFoundationSignerId = typeof window === 'undefined'
    ? getConfiguredOfficialFoundationSignerId()
    : undefined;
  for (const announcement of discovery?.jurisdictionAnnouncements ?? []) {
    env.gossip.announceJurisdiction(announcement, officialFoundationSignerId);
  }
  const options: ConstructorParameters<typeof RuntimeP2P>[0] = {
    env,
    runtimeId,
    onEntityInputs: (from, envelope, ingressTimestamp, options) => {
      deps.handleInboundP2PEntityInputs(env, from, envelope, ingressTimestamp, options);
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
    onGossipJurisdictions: (_from, announcements) => {
      if (announcements.length === 0) return;
      deps.notifyEnvChange(env);
      env.info('network', 'GOSSIP_JURISDICTION_UPDATE', {
        count: announcements.length,
        keys: announcements.map(announcement => announcement.key),
      });
    },
  };
  if (officialFoundationSignerId !== undefined) {
    options.officialFoundationSignerId = officialFoundationSignerId;
  }
  if (config.signerId !== undefined) options.signerId = config.signerId;
  if (config.relayUrls !== undefined) options.relayUrls = config.relayUrls;
  const wsUrl = (config as P2PConfig & { wsUrl?: string | null }).wsUrl;
  if (wsUrl !== undefined) options.wsUrl = wsUrl;
  if (config.seedRuntimeIds !== undefined) options.seedRuntimeIds = config.seedRuntimeIds;
  if (config.advertiseEntityIds !== undefined) options.advertiseEntityIds = config.advertiseEntityIds;
  if (config.gossipPollMs !== undefined) options.gossipPollMs = config.gossipPollMs;
  if (config.gossipSet !== undefined) options.gossipSet = config.gossipSet;
  if (config.profileHeartbeatMs !== undefined) options.profileHeartbeatMs = config.profileHeartbeatMs;
  return options;
};


/**
 * Runtime P2P is process-local infrastructure, not consensus state.
 * Keep the singleton outside storage/projection paths: encrypted entity_input
 * enters through RuntimeP2P and is normalized before it reaches RuntimeReplica.
 */
export const startRuntimeP2P = (
  env: RuntimeReplica,
  config: P2PConfig = {},
  deps: RuntimeP2PLifecycleDeps,
): RuntimeP2P | null => {
  p2pLifecycleLog.debug('start', {
    runtime: shortId(config.runtimeId || env.runtimeId || 'none', 8),
    relays: config.relayUrls?.length ?? 0,
  });
  const state = deps.ensureRuntimeInfrastructure(env);
  state.lastP2PConfig = config;
  for (const replica of env.state.eReplicas.values()) {
    const publicKey = provisionEntityEncryptionKey(
      env,
      replica.entityId,
      requireEntityEncryptionPrivateKey(env, replica.entityId),
    );
    if (publicKey !== replica.state.entityEncryptionPublicKey) {
      throw new Error(`ENTITY_ENCRYPTION_KEY_MISMATCH:entity=${replica.entityId}`);
    }
  }
  const resolvedRuntimeId = config.runtimeId || env.runtimeId;
  if (!resolvedRuntimeId || !isRuntimeId(resolvedRuntimeId)) {
    p2pLifecycleLog.debug('start.pending_runtime_id');
    state.pendingP2PConfig = config;
    return null;
  }

  const reusable = reuseProcessP2P(env, state, config, resolvedRuntimeId) ??
    reuseAttachedP2P(state, config, resolvedRuntimeId);
  if (reusable) return reusable;

  state.p2p = new RuntimeP2P(buildRuntimeP2POptions(env, config, resolvedRuntimeId, deps));
  state.observeOnlineEntityIds = entityIds => {
    const online = new Set(state.p2p?.observeOnlineEntityIds(entityIds) ?? []);
    for (const entityId of state.observeDirectOnlineEntityIds?.(entityIds) ?? []) {
      online.add(entityId);
    }
    return online;
  };
  p2pState(env)[ENV_P2P_SINGLETON_KEY] = state.p2p;
  state.p2p.connect();
  return state.p2p;
};

export const startPendingRuntimeP2PIfReady = (
  env: RuntimeReplica,
  deps: RuntimeP2PLifecycleDeps,
): void => {
  const state = deps.ensureRuntimeInfrastructure(env);
  if (!state.pendingP2PConfig || !env.runtimeId) return;
  const config = state.pendingP2PConfig;
  state.pendingP2PConfig = null;
  p2pLifecycleLog.debug('start.pending_config_ready', {
    runtime: shortId(env.runtimeId, 8),
    relays: config.relayUrls?.length ?? 0,
  });
  startRuntimeP2P(env, config, deps);
};

/**
 * Initiate terminal shutdown without releasing transport ownership.
 * Clearing the singleton here would make a later awaited drain blind to a
 * socket that can still write into Vite's relay proxy during browser teardown.
 */
export const stopRuntimeP2P = (env: RuntimeReplica, deps: RuntimeP2PLifecycleDeps): void => {
  const state = deps.ensureRuntimeInfrastructure(env);
  state.pendingP2PConfig = null;
  if (state.p2p) {
    state.p2p.close();
    return;
  }
  state.lastP2PConfig = null;
};

export const stopRuntimeP2PAndWait = async (
  env: RuntimeReplica,
  deps: RuntimeP2PLifecycleDeps,
  timeoutMs = 1_000,
): Promise<void> => {
  const state = deps.ensureRuntimeInfrastructure(env);
  const p2p = state.p2p;
  state.pendingP2PConfig = null;
  if (!p2p) {
    state.lastP2PConfig = null;
    return;
  }
  if (typeof p2p.closeAndWait !== 'function') {
    throw new Error('P2P_CLOSE_AND_WAIT_UNAVAILABLE');
  }
  await p2p.closeAndWait(timeoutMs);
  const singleton = p2pState(env)[ENV_P2P_SINGLETON_KEY];
  if (singleton === p2p) delete p2pState(env)[ENV_P2P_SINGLETON_KEY];
  if (state.p2p === p2p) state.p2p = null;
  state.lastP2PConfig = null;
};

export const detachRuntimeP2P = (env: RuntimeReplica, deps: RuntimeP2PLifecycleDeps): void => {
  const state = env.infrastructure;
  if (!state?.p2p) return;
  try {
    state.p2p.close();
  } catch (error) {
    p2pLifecycleLog.warn('detach.close_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const singleton = p2pState(env)[ENV_P2P_SINGLETON_KEY];
  if (singleton === state.p2p) {
    delete p2pState(env)[ENV_P2P_SINGLETON_KEY];
  }
  state.p2p = null;
  deps.ensureRuntimeInfrastructure(env);
};

export const getRuntimeP2P = (env: RuntimeReplica, deps: RuntimeP2PLifecycleDeps): RuntimeP2P | null =>
  deps.ensureRuntimeInfrastructure(env).p2p ?? null;

export const getRuntimeP2PState = (env: RuntimeReplica, deps: RuntimeP2PLifecycleDeps): P2PConnectionState => {
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

export const refreshRuntimeGossip = (env: RuntimeReplica, deps: RuntimeP2PLifecycleDeps): void => {
  const state = deps.ensureRuntimeInfrastructure(env);
  if (state.p2p) {
    state.p2p.refreshGossip();
  }
};

export const ensureRuntimeGossipProfiles = async (
  env: RuntimeReplica,
  deps: RuntimeP2PLifecycleDeps,
  entityIds: string[],
): Promise<boolean> => {
  const state = deps.ensureRuntimeInfrastructure(env);
  if (!state.p2p) return false;
  return state.p2p.ensureProfiles(entityIds);
};
