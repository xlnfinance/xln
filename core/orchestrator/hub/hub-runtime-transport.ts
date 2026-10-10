import { findPaymentRoutes, readFrameReceipts } from '../../api/server/network/rpc-ws';
import type { DirectWebSocket } from '../../network/p2p/direct-runtime-bun';
import {
  createDirectRuntimeWsRoute,
  hasUndeliveredDirectRuntimeSessionBytes,
} from '../../network/p2p/direct-runtime-bun';
import { safeStringify } from '../../protocol/serialization';
import { decodeRuntimeAdapterRequest } from '../../api/runtime-adapter/codec';
import { resolveRuntimeAdapterRead } from '../../api/runtime-adapter/resolve';
import {
  closeInvalidRuntimeAdapterMessage,
  handleRuntimeAdapterMessage,
  type RuntimeAdapterSocket,
} from '../../api/runtime-adapter/server';
import { assertRuntimeEntityInputsEnvelopeSource, signRuntimeEntityInputsEnvelope } from '../../runtime/admit/entity-input-envelope-auth.ts';
import {
  enqueueRuntimeInput,
  handleInboundP2PEntityInputs,
  listPersistedCheckpointHeights,
  listPersistedEntityIdsAtHeight,
  loadEntityAccountDocFromStorageDb,
  loadEntityStateFromStorageDb,
  loadEntityViewPageFromStorageDb,
  readPersistedRuntimeActivityPage,
  readPersistedStorageFrameRecord,
  readPersistedStorageHead,
  submitCrossJurisdictionIntent,
  validateRuntimeInputAdmission,
} from '../../runtime';
import type { RuntimeReplica } from '../../runtime/types';
import { applyTransportPeerFailurePolicy } from '../../network/p2p/transport-peer-failure-policy';
import { requestRuntimeLoopWake } from '../../runtime/mempool/input-queue';
import { enqueuePeerReadyProposeAccountsNow } from '../../runtime/mempool/propose-accounts-now';
import { getEffectiveEntityInputTxs } from '../../entity/consensus/output/envelope';
import { getEntityReplicaById } from '../../entity/replica/replica-lookup';
import {
  crossJurisdictionRouteProfileEntityIds,
  extractCrossJurisdictionRouteFromTx,
} from '../../extensions/cross-j/boundary';
import type { BrainVaultOwnerController } from '../../api/server/ownership/brainvault';
import { resolveRuntimeAdminControl } from '../../api/server/control/runtime-admin';

export type HubServerSocket = DirectWebSocket &
  RuntimeAdapterSocket & { data?: { type?: string } };

export type DirectEntityInputDebug = {
  at: number;
  fromRuntimeId: string;
  entityIds: string[];
  signerIds: string[];
  txTypes: string[];
  stage?: 'received' | 'profiles' | 'validation' | 'queued' | 'ignored' | 'rejected';
  queuedInputs?: number;
  completedAt?: number;
  error?: string;
};

export type DirectInputDebugState = {
  lastSeen: DirectEntityInputDebug | null;
  lastError: DirectEntityInputDebug | null;
};

const collectCrossJProfileIds = (
  envelope: import('../../runtime/types').RuntimeEntityInputsEnvelope,
): string[] => [...new Set(envelope.entityInputs.flatMap(input =>
  getEffectiveEntityInputTxs(input).flatMap(tx => {
    if (tx.type !== 'prepareCrossJurisdictionSwap') return [];
    const route = extractCrossJurisdictionRouteFromTx(tx);
    return route ? crossJurisdictionRouteProfileEntityIds(route) : [];
  }),
))];

const warmCrossJProfileRoutes = async (
  env: RuntimeReplica,
  envelope: import('../../runtime/types').RuntimeEntityInputsEnvelope,
): Promise<void> => {
  const required = collectCrossJProfileIds(envelope);
  if (required.length === 0) return;
  // Entities this Runtime itself signs for never arrive through gossip; their
  // route is local. Only remote parties need a verified profile route.
  const missing = required.filter(entityId =>
    !env.infrastructure?.verifiedProfileRoutes?.has(entityId)
    && getEntityReplicaById(env, entityId) === null);
  if (missing.length === 0) return;
  const p2p = env.infrastructure?.p2p;
  if (!p2p) throw new Error(`CROSS_J_PROFILE_WARMUP_UNAVAILABLE:${missing.join(',')}`);
  await p2p.ensureProfiles(missing, 1);
  const unresolved = missing.filter(entityId =>
    !env.infrastructure?.verifiedProfileRoutes?.has(entityId));
  if (unresolved.length > 0) {
    throw new Error(`CROSS_J_PROFILE_WARMUP_FAILED:${unresolved.join(',')}`);
  }
};

type DirectRuntimeRoute = ReturnType<typeof createDirectRuntimeWsRoute>;

/**
 * The peer refused a committed output this route actually sent it (the route
 * correlates every peer error against its outstanding ids). The reject policy is
 * applied exactly once here: tests and dev halt so the contradiction surfaces;
 * production logs, closes that peer session and leaves the outbox rows for the
 * outbox owner. Never a retry.
 */
export const handleDirectDeliveryFailure = (
  env: RuntimeReplica,
  debug: DirectInputDebugState,
  getRoute: () => DirectRuntimeRoute,
  failure: Parameters<NonNullable<Parameters<typeof createDirectRuntimeWsRoute>[0]['onDeliveryFailure']>>[0],
): void => {
  const code = failure.direction === 'inbound' ? 'DIRECT_INBOUND_REJECTED' : 'DIRECT_OUTPUT_REJECTED_BY_PEER';
  const now = Date.now();
  debug.lastError = {
    at: now,
    stage: 'rejected',
    completedAt: now,
    fromRuntimeId: failure.peerRuntimeId,
    entityIds: failure.envelope?.entityInputs.map(input => String(input.entityId || '')) ?? [],
    signerIds: failure.envelope?.entityInputs.map(input => String(input.signerId || '')) ?? [],
    txTypes: failure.envelope?.entityInputs.flatMap(input =>
      (input.entityTxs || []).map(tx => String(tx?.type || ''))
    ) ?? [],
    error: `${code}:${safeStringify(failure)}`,
  };
  // An inbound failure is a rejected Account input: the session already got the
  // typed rejection, and genuine internal contradictions halt through their own
  // halt paths during apply.
  if (failure.direction === 'inbound') {
    env.error?.('network', code, failure);
    return;
  }
  applyTransportPeerFailurePolicy(env, code, failure, () => {
    getRoute().closeSession(failure.peerRuntimeId, 4005, 'peer-rejected-output');
  });
};

export const handleDirectSessionClose = (
  env: RuntimeReplica,
  failure: Parameters<NonNullable<Parameters<typeof createDirectRuntimeWsRoute>[0]['onSessionClose']>>[0],
): void => {
  if (!hasUndeliveredDirectRuntimeSessionBytes(failure)) {
    env.warn?.('network', 'DIRECT_RUNTIME_PEER_OFFLINE', failure);
    return;
  }
  // Bytes Bun accepted but never flushed before the peer closed are an audit
  // line, not a Hub fault: the session is already gone and the outbox owner
  // decides what to do with the rows behind those bytes.
  env.error?.('network', 'DIRECT_RUNTIME_SESSION_CLOSED_UNDELIVERED', failure);
};

const admitDirectEntityInputs = async (
  env: RuntimeReplica,
  isIngressReady: () => boolean,
  debug: DirectInputDebugState,
  from: string,
  envelope: import('../../runtime/types').RuntimeEntityInputsEnvelope,
  ingressTimestamp: number | undefined,
  sessionAuthenticated: boolean,
): Promise<void> => {
  if (!isIngressReady()) throw new Error('RUNTIME_STARTUP_J_CATCHUP_PENDING');
  const entry: DirectEntityInputDebug = {
    at: Date.now(),
    stage: 'received',
    fromRuntimeId: String(from || ''),
    entityIds: envelope.entityInputs.map(input => String(input.entityId || '')),
    signerIds: envelope.entityInputs.map(input => String(input.signerId || '')),
    txTypes: envelope.entityInputs.flatMap(input => (input.entityTxs || []).map(tx => String(tx?.type || ''))),
  };
  debug.lastSeen = entry;
  try {
    assertRuntimeEntityInputsEnvelopeSource(env, from, envelope, sessionAuthenticated);
    entry.stage = 'profiles';
    await warmCrossJProfileRoutes(env, envelope);
    entry.stage = 'validation';
    const admission = handleInboundP2PEntityInputs(env, from, envelope, ingressTimestamp, {
      envelopeSourceVerified: true,
      entityInputsValidated: true,
    });
    entry.stage = admission.kind;
    entry.queuedInputs = admission.queuedInputs.length;
    entry.completedAt = Date.now();
  } catch (error) {
    entry.stage = 'rejected';
    entry.completedAt = Date.now();
    debug.lastError = { ...entry, error: error instanceof Error ? error.message : String(error) };
    throw error;
  }
};

/**
 * A sovereign user dials the Hub, so its authenticated inbound uWS session is the
 * canonical user route. Hubs dial each other from signed Profiles, so Hub-to-Hub
 * output uses that already-open outbound direct P2P socket. Route selection
 * happens before the only send attempt: this is not a retry and must never fall
 * through after either transport accepted bytes.
 */
const wireDirectRuntimeInfrastructure = (env: RuntimeReplica, route: DirectRuntimeRoute): void => {
  env.infrastructure = env.infrastructure ?? {};
  env.infrastructure.canDeliverEntityInputs = targetRuntimeId => route.hasOpenSession(targetRuntimeId)
    ? route.canDeliver(targetRuntimeId)
    : (env.infrastructure?.p2p?.canDeliver(targetRuntimeId) ?? false);
  env.infrastructure.observeDirectOnlineEntityIds = entityIds => {
    const online = new Set<string>();
    for (const rawEntityId of entityIds) {
      const entityId = rawEntityId.toLowerCase();
      const runtimeId = env.infrastructure?.verifiedProfileRoutes?.get(entityId)?.runtimeId;
      if (runtimeId && route.hasOpenSession(runtimeId)) online.add(entityId);
    }
    return online;
  };
  env.infrastructure.directEntityInputsDispatch = (targetRuntimeId, envelope, ingressTimestamp) => {
    if (route.hasOpenSession(targetRuntimeId)) {
      return route.sendEntityInputsDelivery(targetRuntimeId, envelope, ingressTimestamp);
    }
    const p2p = env.infrastructure?.p2p;
    if (p2p) return p2p.enqueueEntityInputsDelivery(targetRuntimeId, envelope, ingressTimestamp);
    return route.sendEntityInputsDelivery(targetRuntimeId, envelope, ingressTimestamp);
  };
};

export const createHubDirectRuntimeRoute = (
  env: RuntimeReplica,
  runtimeSeed: string,
  isIngressReady: () => boolean,
  debug: DirectInputDebugState,
): DirectRuntimeRoute => {
  let route: DirectRuntimeRoute;
  route = createDirectRuntimeWsRoute({
    runtimeId: String(env.runtimeId || ''),
    runtimeSeed,
    signEnvelope: (to, envelope) => signRuntimeEntityInputsEnvelope(env, to, envelope),
    getLocalProfiles: async () => {
      const p2p = env.infrastructure?.p2p;
      if (!p2p) throw new Error('DIRECT_GOSSIP_P2P_UNAVAILABLE');
      return p2p.getLocalProfilesForEntities();
    },
    onGossipAnnounce: async (from, payload) => {
      const p2p = env.infrastructure?.p2p;
      if (!p2p) throw new Error('DIRECT_GOSSIP_P2P_UNAVAILABLE');
      await p2p.admitGossipAnnouncement(from, payload);
    },
    onRecoveryBundleRequest: async (_from, lookupKey) =>
      resolveRuntimeAdapterRead({ env }, `recovery/bundles/${encodeURIComponent(lookupKey)}`),
    onDeliveryFailure: failure => handleDirectDeliveryFailure(env, debug, () => route, failure),
    onSessionClose: failure => handleDirectSessionClose(env, failure),
    onEntityInputs: async (from, envelope, ingressTimestamp, sessionAuthenticated) =>
      admitDirectEntityInputs(env, isIngressReady, debug, from, envelope, ingressTimestamp, sessionAuthenticated === true),
  });
  route.setReady(isIngressReady());
  // Offline -> online edge only (see core/runtime/mempool/propose-accounts-now.ts).
  route.onDeliveryReadyChange((peerRuntimeId, ready) => {
    enqueuePeerReadyProposeAccountsNow(env, peerRuntimeId, ready);
    requestRuntimeLoopWake(env);
  });
  wireDirectRuntimeInfrastructure(env, route);
  return route;
};

export const createHubRadapterMessageHandler = (
  env: RuntimeReplica,
  isIngressReady: () => boolean,
  brainVaultOwner: BrainVaultOwnerController,
  isBrainVaultReady: () => boolean,
): ((
  ws: HubServerSocket,
  raw: string | Buffer | ArrayBuffer,
) => void) =>
  (ws, raw) => {
    let message: import('../../api/runtime-adapter/types').RuntimeAdapterRequest;
    try {
      message = decodeRuntimeAdapterRequest(raw);
    } catch (error) {
      closeInvalidRuntimeAdapterMessage(ws, error);
      return;
    }
    void Promise.resolve(
      handleRuntimeAdapterMessage(ws, message, env, {
        enqueueRuntimeInput,
        submitCrossJurisdictionIntent: async (targetEnv, route) => {
          await submitCrossJurisdictionIntent(targetEnv, route);
        },
        validateRuntimeInputAdmission,
        controlRuntime: resolveRuntimeAdminControl,
        isMutatingIngressReady: isIngressReady,
        deriveBrainVault: async (targetEnv, input, options) => {
          if (!isBrainVaultReady()) throw new Error('BRAINVAULT_OWNER_STARTUP_PENDING');
          return brainVaultOwner.deriveAndInstall(targetEnv, input, options);
        },
        // Intentional recovery boundary: a trusted node owner may explicitly
        // reveal its own mnemonic over an authenticated admin capability.
        // Ordinary derive is public-only, and /api/runtime-import must never
        // mint that capability for an untrusted caller. Removing this hook
        // would destroy node-owner recovery rather than improve isolation.
        revealBrainVaultMnemonic: async () => {
          if (!isBrainVaultReady()) throw new Error('BRAINVAULT_OWNER_STARTUP_PENDING');
          return brainVaultOwner.revealMnemonic();
        },
        findPaymentRoutes,
        readFrameReceipts,
        readHead: targetEnv => readPersistedStorageHead(targetEnv),
        readFrame: (targetEnv, height) =>
          readPersistedStorageFrameRecord(targetEnv, height),
        listCheckpoints: targetEnv =>
          listPersistedCheckpointHeights(targetEnv),
        loadEntityState: (targetEnv, entityId, height) =>
          loadEntityStateFromStorageDb(targetEnv, entityId, height),
        loadEntityAccountDoc: (
          targetEnv,
          entityId,
          counterpartyId,
          height,
        ) => loadEntityAccountDocFromStorageDb(
          targetEnv,
          entityId,
          counterpartyId,
          height,
        ),
        loadEntityViewPage: (targetEnv, entityId, height, query) =>
          loadEntityViewPageFromStorageDb(
            targetEnv,
            entityId,
            height,
            query,
          ),
        listEntityIdsAtHeight: (targetEnv, height) =>
          listPersistedEntityIdsAtHeight(targetEnv, height),
        readActivityPage: (targetEnv, options) =>
          readPersistedRuntimeActivityPage(targetEnv, options),
      }),
    ).catch(error => {
      ws.send(
        safeStringify({
          type: 'error',
          error: `Runtime adapter failed: ${(error as Error).message}`,
        }),
      );
    });
  };
