import type { Env, ReliableDeliveryReceipt, RoutedEntityInput, RuntimeEntityInputsEnvelope } from '../types';
import { createStructuredLogger, shortId } from '../infra/logger';
import { RuntimeP2P, type P2PConfig } from '../networking/p2p';
import { isRuntimeId } from '../networking/runtime-id';
import { assertLocalEntityCryptoKeys } from '../entity/crypto';
import type { RuntimeInboundEntityInputsResult } from './entity-routing';
import { isDeliveryDelivered } from '../protocol/payments/delivery-result';
import {
  buildLocalProfileCertificationInput,
  collectDueLocalProfileCertificationInputs,
} from '../networking/local-profile-lifecycle';

export type { P2PConfig } from '../networking/p2p';

export type RuntimeP2PLifecycleDeps = {
  ensureRuntimeState: (env: Env) => NonNullable<Env['runtimeState']>;
  notifyEnvChange: (env: Env) => void;
  handleInboundP2PEntityInputs: (
    env: Env,
    from: string,
    envelope: RuntimeEntityInputsEnvelope,
    ingressTimestamp?: number,
  ) => RuntimeInboundEntityInputsResult;
  handleInboundReliableReceipt: (
    env: Env,
    from: string,
    receipt: ReliableDeliveryReceipt,
  ) => void;
  enqueueRuntimeInputs: (env: Env, inputs: RoutedEntityInput[]) => void;
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
    const existingGlobalP2PConnecting =
      typeof existingGlobalP2P.isConnecting === 'function' && existingGlobalP2P.isConnecting();
    if (
      typeof existingGlobalP2P.isConnected === 'function' &&
      !existingGlobalP2P.isConnected() &&
      !existingGlobalP2PConnecting &&
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
      if (!state.p2p.isConnected() && !state.p2p.isConnecting()) {
        state.p2p.connect();
      }
      return state.p2p;
    }
    state.p2p.close();
  }

  const p2pOptions: ConstructorParameters<typeof RuntimeP2P>[0] = {
    env,
    runtimeId: resolvedRuntimeId,
    onEntityInputs: (from, envelope, ingressTimestamp) => {
      const result = deps.handleInboundP2PEntityInputs(env, from, envelope, ingressTimestamp);
      for (const receipt of result.receipts) {
        const delivery = state.p2p?.enqueueReliableReceiptDelivery(from, receipt);
        if (!delivery || !isDeliveryDelivered(delivery)) {
          env.warn('network', 'RELIABLE_RECEIPT_SEND_DEFERRED', {
            targetRuntimeId: from,
            delivery: delivery ?? null,
          });
        }
      }
    },
    onReliableReceipt: (from, receipt) => {
      deps.handleInboundReliableReceipt(env, from, receipt);
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
    onEncryptionManifestComplete: (entityId, encryptionAttestations) => {
      const input = buildLocalProfileCertificationInput(env, entityId, encryptionAttestations);
      if (!input) {
        p2pLifecycleLog.debug('profile.certification_not_due', {
          entity: shortId(entityId, 8),
        });
        return;
      }
      deps.enqueueRuntimeInputs(env, [input]);
      deps.notifyEnvChange(env);
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
  const dueProfileCertifications = collectDueLocalProfileCertificationInputs(env);
  if (dueProfileCertifications.length > 0) {
    deps.enqueueRuntimeInputs(env, dueProfileCertifications);
    deps.notifyEnvChange(env);
  }
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

/**
 * Initiate terminal shutdown without releasing transport ownership.
 * Clearing the singleton here would make a later awaited drain blind to a
 * socket that can still write into Vite's relay proxy during browser teardown.
 */
export const stopRuntimeP2P = (env: Env, deps: RuntimeP2PLifecycleDeps): void => {
  const state = deps.ensureRuntimeState(env);
  state.pendingP2PConfig = null;
  if (state.p2p) {
    state.p2p.close();
    return;
  }
  state.lastP2PConfig = null;
};

export const stopRuntimeP2PAndWait = async (
  env: Env,
  deps: RuntimeP2PLifecycleDeps,
  timeoutMs = 1_000,
): Promise<void> => {
  const state = deps.ensureRuntimeState(env);
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
  const singleton = envRecord(env)[ENV_P2P_SINGLETON_KEY];
  if (singleton === p2p) delete envRecord(env)[ENV_P2P_SINGLETON_KEY];
  if (state.p2p === p2p) state.p2p = null;
  state.lastP2PConfig = null;
};

export const detachRuntimeP2P = (env: Env, deps: RuntimeP2PLifecycleDeps): void => {
  const state = env.runtimeState;
  if (!state?.p2p) return;
  try {
    state.p2p.close();
  } catch (error) {
    p2pLifecycleLog.warn('detach.close_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
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
