#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { drainJWatcherBacklog } from '../jurisdiction/adapter/backlog-drain';
import { createDirectRuntimeWsRoute } from '../network/p2p/direct-runtime-bun';
import { requireDeliveryDelivered } from '../protocol/payments/delivery-result';
import { compareStableText, safeStringify } from '../protocol/serialization';
import { decodeRuntimeAdapterRequest } from '../api/runtime-adapter/codec';
import { resolveRuntimeAdapterRead } from '../api/runtime-adapter/resolve';
import {
  attachRuntimeAdapterTicker,
  closeInvalidRuntimeAdapterMessage,
  forgetRuntimeAdapterClient,
  handleRuntimeAdapterMessage,
} from '../api/runtime-adapter/server';
import {
  closeInfraDb,
  closeRuntimeDb,
  enqueueRuntimeInput,
  getP2PState,
  handleInboundP2PEntityInputs,
  handleInboundReliableReceipt,
  listPersistedCheckpointHeights,
  listPersistedEntityIdsAtHeight,
  loadEntityAccountDocFromStorageDb,
  loadEntityStateFromStorageDb,
  loadEntityViewPageFromStorageDb,
  main,
  processRuntime,
  readPersistedRuntimeActivityPage,
  readPersistedStorageFrameRecord,
  readPersistedStorageHead,
  registerRuntimeFrameCommitCallback,
  startJurisdictionWatchers,
  startP2P,
  startRuntimeLoop,
  submitCrossJurisdictionIntent,
  validateRuntimeInputAdmission,
} from '../runtime.ts';
import { registerEnvChangeCallback } from '../runtime/loop-environment';
import { ensurePendingNumberedRegistrationsResumed } from '../runtime/registration/numbered-registration-driver';
import { getReliableOutputIdentity } from '../runtime/output-routing';
import { isLocalOperatorRequest, resolveSocketPeerAddress } from '../api/server/health-redaction';
import { createRuntimeIngressReceiptStore } from '../runtime/ingress-receipts';
import { readRuntimeSecurityIncidentTelemetry } from '../runtime/security-incidents';
import { requiresLocalNodeOperator } from '../api/server/node-http-access';
import { handleRuntimeInputStatus } from '../api/server/runtime-input-control';
import { computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';
import type { ReliableDeliveryReceipt, RuntimeReplica } from '../runtime/types';
import {
  evaluateBootstrapProgressDeadline,
  isBootstrapWorkWithinDeadline,
  updateBootstrapWorkStartedAt,
} from './bootstrap-progress-deadline';
import { createHttpDrainTracker, stopServerGracefully } from './graceful-server';
import { reportManagedChildFatal } from './managed-child-fatal-ipc';
import { deriveMarketMakerChildReadiness } from './market-maker-child-readiness';
import {
  BOOTSTRAP_POLL_MS,
  getAccountReplica,
  getEntityOutCapacity,
  getEntityReplicaById,
  isAccountConsensusReady,
  serializeAccountDelta,
  settleRuntimeFor,
  sleep,
  summarizeRuntimeQuiescence,
} from './mesh-common';
import {
  formatJurisdictionDisplayName,
  requireJurisdictionBlockTimeMs,
  resolveMeshJurisdictionRpcBindings,
  resolveSecondaryJurisdictions,
} from './mesh-jurisdictions';
import { marketMakerBootstrapProgressSignature } from './mm-bootstrap-progress';
import { areMarketMakerHubTransportsReady } from './mm-transport';
import { quiesceNodeRuntime } from './node-runtime-quiesce';
import { MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS } from './orchestrator-config';
import { startParentLivenessWatch } from '../infra/parent-watch';

import {
  activateMarketMakerProcessArgs,
  CrossQuoteJob,
  HubProfile,
  JSON_HEADERS,
  MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK,
  MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK,
  MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE,
  MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL,
  MARKET_MAKER_BOOTSTRAP_LOG_BACKLOG,
  MARKET_MAKER_BOOTSTRAP_LOOP_MS,
  MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK,
  MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK,
  MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK,
  MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE,
  MARKET_MAKER_BOOTSTRAP_START_DELAY_MS,
  MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK,
  MARKET_MAKER_HEALTH_REFRESH_MS,
  MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME,
  MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME,
  MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK,
  MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK,
  MARKET_MAKER_QUOTE_LOOP_MS,
  MARKET_MAKER_RUNTIME_TICK_DELAY_MS,
  MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK,
  MarketMakerConnectivityBudget,
  MarketMakerEntityContext,
  MarketMakerHealth,
  MarketMakerServerSocket,
  SameQuoteJob,
  apiUrl,
  buildLocalMarketMakerSignerLabels,
  buildMarketMakerOfferSpecs,
  buildMarketMakerTokenIdsByContext,
  configureMarketMakerRuntimeLogging,
  countCommittedMarketMakerOffersForHub,
  createMarketMakerEntityContext,
  directWsUrl,
  emitMarketMakerBootstrapDebugEvent,
  ensureJurisdictionReplica,
  ensureMarketMakerHubConnectivity,
  getMarketMakerRuntimeBacklogSnapshot,
  getMarketMakerTokenIds,
  hasMarketMakerAccountBacklog,
  hasMarketMakerRuntimeBacklog,
  importJurisdictionIfNeeded,
  isSameQuoteJobDepthReady,
  maintainMarketMakerQuotes,
  marketMakerContextKey,
  nodeLog,
  readVisibleHubProfiles,
  resolveImportedJurisdictionRpc,
  resolveJurisdictionConfig,
  resolveLocalApiUrl,
  resolvedArgs,
  sameJurisdiction,
  waitForJurisdictionAdapter,
  waitForTokenCatalog,
  yieldMarketMakerApi,
} from './mm-node-core';
import { readBooleanEnv } from '../config/environment';
import {
  assertMarketMakerBootstrapFinalized,
  buildDeferredMarketMakerCrossHealth,
  buildMarketMakerBootstrapEntityStateHash,
  buildMarketMakerBootstrapFingerprint,
  buildMarketMakerCrossDebugSummary,
  buildMarketMakerCrossPlanSummary,
  buildPlannedMarketMakerCrossHealth,
  describeMarketMakerSameHubBlocker,
  getMarketMakerHealth,
  isMarketMakerCrossDepthComplete,
  isMarketMakerDepthComplete,
  isMarketMakerFullDepthComplete,
  isMarketMakerSameDepthComplete,
  maintainMarketMakerCrossQuotes,
} from './mm-node-health';

type DirectEntityInputDebug = {
  at: number;
  fromRuntimeId: string;
  entityIds: string[];
  signerIds: string[];
  txTypes: string[];
  error?: string;
};

type MarketMakerQuoteMode = 'bootstrap' | 'steady';

type BootstrapStallCapsuleArgs = {
  env: RuntimeReplica;
  phase: string;
  idleMs: number;
  lastProgressReason: string;
  lastProgressSignature: string;
  lastProgressCheckpoint: unknown;
  currentCheckpoint: unknown;
  summarizedHealth: Record<string, unknown> | null;
  visibleHubs: readonly HubProfile[];
  lastDirectEntityInput: DirectEntityInputDebug | null;
  lastDirectEntityInputError: DirectEntityInputDebug | null;
};

const buildBootstrapStallCapsule = ({
  env,
  phase,
  idleMs,
  lastProgressReason,
  lastProgressSignature,
  lastProgressCheckpoint,
  currentCheckpoint,
  summarizedHealth,
  visibleHubs,
  lastDirectEntityInput,
  lastDirectEntityInputError,
}: BootstrapStallCapsuleArgs): Record<string, unknown> => {
  const p2p = getP2PState(env);
  return {
    phase,
    idleMs,
    timeoutMs: MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS,
    lastProgressReason,
    lastProgressSignatureHash: createHash('sha256').update(lastProgressSignature).digest('hex'),
    lastProgressCheckpoint,
    currentCheckpoint,
    health: summarizedHealth,
    backlog: getMarketMakerRuntimeBacklogSnapshot(env, { includeQueuedEntityInputs: true }),
    activeProcess: env.infrastructure?.processingPromise
      ? {
          enteredAt: env.lastProcessEnteredAt,
          progressAt: env.activeProcessProgressAt,
          progressStep: env.activeProcessProgressStep,
        }
      : null,
    p2p: {
      connected: p2p.connected,
      reconnect: p2p.reconnect,
      queue: p2p.queue,
      directPeers: p2p.directPeers ?? [],
    },
    directInput: {
      lastSeen: lastDirectEntityInput,
      lastError: lastDirectEntityInputError,
    },
    visibleHubs: visibleHubs.map(profile => ({
      name: profile.name,
      entityId: profile.entityId,
      runtimeId: profile.runtimeId,
    })),
  };
};

const summarizeMarketMakerHealthForDebug = (health: MarketMakerHealth | null): Record<string, unknown> | null => {
  if (!health) return null;
  const accountBlockers = [
    ...health.hubs.flatMap(hub => hub.blockers),
    ...health.cross.routes.flatMap(route => route.blockers),
  ].slice(0, 16);
  return {
    ok: health.ok,
    offers: health.hubs.map(hub => hub.offers),
    hubBlockers: health.hubs.map(hub => hub.blockers.length),
    cross: {
      ok: health.cross.ok,
      expectedRoutes: health.cross.expectedRoutes,
      offers: health.cross.routes.map(route => route.offers),
      blockers: health.cross.routes.map(route => route.blockers.length),
    },
    account: accountBlockers,
    pendingFrame: accountBlockers.some(
      blocker =>
        typeof blocker === 'object' &&
        blocker !== null &&
        (blocker as { pendingFrame?: unknown }).pendingFrame === true,
    ),
  };
};

const summarizeReliableIdentity = (
  identity: ReturnType<typeof getReliableOutputIdentity>,
): Record<string, unknown> | null =>
  identity
    ? {
        kind: identity.kind,
        entityId: identity.entityId,
        signerId: identity.signerId,
        laneKey: identity.laneKey,
        height: identity.height,
        logIndex: identity.logIndex ?? null,
        evidenceKind: identity.evidenceKind,
        evidenceDigest: identity.evidenceDigest,
      }
    : null;

const summarizeReceiptLedger = (ledger: Map<string, ReliableDeliveryReceipt> | undefined): Record<string, unknown>[] =>
  [...(ledger?.values() ?? [])]
    .map(receipt => ({
      coverage: receipt.body.coverage,
      receiverRuntimeId: receipt.body.receiverRuntimeId,
      appliedRuntimeHeight: receipt.body.appliedRuntimeHeight,
      identity: {
        kind: receipt.body.identity.kind,
        entityId: receipt.body.identity.entityId,
        laneKey: receipt.body.identity.laneKey,
        height: receipt.body.identity.height,
        logIndex: receipt.body.identity.logIndex ?? null,
        evidenceKind: receipt.body.identity.evidenceKind,
        evidenceDigest: receipt.body.identity.evidenceDigest,
      },
    }))
    .sort((left, right) => compareStableText(safeStringify(left), safeStringify(right)));

const buildNodeBootstrapCausalCheckpoint = (
  env: RuntimeReplica,
  contexts: readonly MarketMakerEntityContext[],
): Record<string, unknown> => {
  const state = env.infrastructure;
  return {
    quiescence: summarizeRuntimeQuiescence(env),
    pendingReliable: (env.pendingNetworkOutputs ?? [])
      .map(output => ({
        targetRuntimeId: output.runtimeId ?? null,
        targetEntityId: output.entityId,
        txTypes: (output.entityTxs ?? []).map(tx => tx.type),
        txCount: output.entityTxs?.length ?? 0,
        identity: summarizeReliableIdentity(getReliableOutputIdentity(output)),
      }))
      .filter(entry => entry.identity !== null)
      .sort((left, right) => compareStableText(safeStringify(left), safeStringify(right))),
    senderReceipts: {
      active: summarizeReceiptLedger(state?.receivedReliableReceiptLedger),
      terminal: summarizeReceiptLedger(state?.receivedReliableTerminalWatermarks),
    },
    receiverReceipts: {
      active: summarizeReceiptLedger(state?.reliableIngressReceiptLedger),
      terminal: summarizeReceiptLedger(state?.reliableIngressTerminalWatermarks),
      pending: [...(state?.pendingReliableIngress?.values() ?? [])]
        .map(pending => ({
          targetRuntimeIds: [...pending.targetRuntimeIds].sort(compareStableText),
          identity: {
            kind: pending.identity.kind,
            entityId: pending.identity.entityId,
            laneKey: pending.identity.laneKey,
            height: pending.identity.height,
            logIndex: pending.identity.logIndex ?? null,
            evidenceKind: pending.identity.evidenceKind,
            evidenceDigest: pending.identity.evidenceDigest,
          },
        }))
        .sort((left, right) => compareStableText(safeStringify(left), safeStringify(right))),
    },
    entities: contexts
      .map(context => {
        const replica = getEntityReplicaById(env, context.entityId);
        return {
          entityId: context.entityId,
          jurisdiction: context.jurisdictionName,
          consumptionRoot: replica?.state.consumptionAccumulator?.root ?? null,
          consumptionRelationships: replica?.state.consumptionAccumulator?.count ?? 0n,
          accounts: [...(replica?.state.accounts.entries() ?? [])]
            .map(([counterpartyEntityId, account]) => ({
              counterpartyEntityId,
              currentHeight: account.currentHeight,
              pendingFrame: Boolean(account.pendingFrame),
              mempool: account.mempool?.length ?? 0,
            }))
            .sort((left, right) => compareStableText(left.counterpartyEntityId, right.counterpartyEntityId)),
        };
      })
      .sort((left, right) => compareStableText(left.entityId, right.entityId)),
  };
};

const emitNodeBootstrapDebugEvent = (
  env: RuntimeReplica,
  startupPhase: string,
  activeEntityId: string | null,
  event: string,
  fields: Record<string, unknown> = {},
): void => {
  emitMarketMakerBootstrapDebugEvent(event, {
    stage: startupPhase,
    entity: activeEntityId,
    runtimeId: String(env.runtimeId || ''),
    height: env.state.height,
    backlog: getMarketMakerRuntimeBacklogSnapshot(env, { includeQueuedEntityInputs: true }),
    ...fields,
  });
};

type MarketMakerHealthSnapshot = {
  health: MarketMakerHealth | null;
  visibleHubs: HubProfile[];
  allVisibleHubs: HubProfile[];
};

const computeMarketMakerHealthSnapshot = (
  env: RuntimeReplica,
  contexts: readonly MarketMakerEntityContext[],
  activeEntityId: string | null,
  tokenIdsByContext: ReadonlyMap<string, number[]>,
  options: {
    includeCross?: boolean;
    crossOverride?: MarketMakerHealth['cross'];
  } = {},
): MarketMakerHealthSnapshot => {
  const primaryContext = contexts[0] ?? null;
  if (!activeEntityId || !primaryContext) {
    return { health: null, visibleHubs: [], allVisibleHubs: [] };
  }
  const visibleHubs = readVisibleHubProfiles(env).filter(profile => sameJurisdiction(primaryContext, profile));
  const allVisibleHubs = readVisibleHubProfiles(env, true);
  const crossOverride = options.crossOverride;
  const includeCross = !crossOverride && options.includeCross !== false;
  const crossApplicable =
    contexts.length > 1 &&
    allVisibleHubs.some(
      profile =>
        contexts.some(context => sameJurisdiction(context, profile)) && !sameJurisdiction(primaryContext, profile),
    );
  const health = getMarketMakerHealth(
    env,
    primaryContext.entityId,
    visibleHubs.map(profile => profile.entityId),
    getMarketMakerTokenIds(tokenIdsByContext, primaryContext),
    includeCross
      ? {
          contexts: [...contexts],
          visibleHubs: allVisibleHubs,
          tokenIdsByContext: new Map(tokenIdsByContext),
        }
      : undefined,
    crossOverride ?? (includeCross ? undefined : buildDeferredMarketMakerCrossHealth(crossApplicable)),
  );
  return { health, visibleHubs, allVisibleHubs };
};

const summarizeRuntimeInputs = (
  inputs: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> | undefined,
) =>
  (inputs ?? []).slice(-10).map(input => ({
    entityId: String(input.entityId || '').slice(-8),
    txs: (input.entityTxs ?? []).map(tx => String(tx?.type || '')),
  }));

const buildMarketMakerAccountStatusDebug = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyEntityId: string,
  tokenIds: number[],
  lastDirectEntityInput: DirectEntityInputDebug | null,
  lastDirectEntityInputError: DirectEntityInputDebug | null,
): Record<string, unknown> => {
  const account = getAccountReplica(env, entityId, counterpartyEntityId);
  const replica = getEntityReplicaById(env, entityId);
  return {
    success: true,
    entityId,
    counterpartyEntityId,
    hasAccount: Boolean(account),
    ready: Boolean(account && isAccountConsensusReady(account)),
    currentHeight: Number(account?.currentHeight ?? 0),
    pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
    pendingFrameTxs: (account?.pendingFrame?.accountTxs ?? []).map(tx => String(tx?.type || '')),
    mempool: Number(account?.mempool?.length ?? 0),
    mempoolTxs: (account?.mempool ?? []).map(tx => String(tx?.type || '')),
    swapOffers: Number(account?.state.swapOffers?.size || 0),
    tokens: tokenIds.map(tokenId => ({
      tokenId,
      hasDelta: Boolean(account?.state.deltas?.has(tokenId)),
      outCapacity: account ? getEntityOutCapacity(account, entityId, tokenId).toString() : '0',
      delta: serializeAccountDelta(account?.state.deltas?.get(tokenId)),
    })),
    runtime: {
      height: Number(env.state.height ?? 0),
      timestamp: Number(env.state.timestamp ?? 0),
      halted: Boolean(env.infrastructure?.halted),
      fatalDebugPayload: env.infrastructure?.fatalDebugPayload ?? null,
      loopActive: Boolean(env.infrastructure?.loopActive),
      backlog: getMarketMakerRuntimeBacklogSnapshot(env, { includeQueuedEntityInputs: true }),
      runtimeMempool: summarizeRuntimeInputs(env.runtimeMempool?.entityInputs),
    },
    replica: replica
      ? {
          key: `${String(replica.entityId || '').toLowerCase()}:${String(replica.signerId || '').toLowerCase()}`,
          entityId: replica.entityId,
          signerId: replica.signerId,
          mempool: (replica.mempool ?? []).map(tx => String(tx?.type || '')),
          proposalTxs: (replica.proposal?.txs ?? []).map(tx => String(tx?.type || '')),
          lockedFrameTxs: (replica.lockedFrame?.txs ?? []).map(tx => String(tx?.type || '')),
        }
      : null,
    directInput: {
      lastSeen: lastDirectEntityInput,
      lastError: lastDirectEntityInputError,
    },
  };
};

type MarketMakerInfoProjection = {
  env: RuntimeReplica;
  contexts: readonly MarketMakerEntityContext[];
  tokenIdsByContext: ReadonlyMap<string, number[]>;
  currentHealth: MarketMakerHealth | null;
  activeEntityId: string | null;
  startupPhase: string;
  readyHash: string | null;
  runtimeStateHash: string | null;
  entityStateHash: string | null;
  restoredEntityStateHash: string | null;
  readyAt: number | null;
};

const buildMarketMakerInfoResponseJson = (input: MarketMakerInfoProjection, includeCrossDebug = false): string =>
  safeStringify({
    name: resolvedArgs.name,
    entityId: input.activeEntityId,
    runtimeId: input.env.runtimeId,
    apiUrl,
    relayUrl: resolvedArgs.relayUrl,
    directWsUrl,
    startupPhase: input.startupPhase,
    runtimeBacklog: getMarketMakerRuntimeBacklogSnapshot(input.env, {
      includeQueuedEntityInputs: includeCrossDebug,
    }),
    bootstrap: {
      readyHash: input.readyHash,
      runtimeStateHash: input.runtimeStateHash,
      entityStateHash: input.entityStateHash,
      restoredEntityStateHash: input.restoredEntityStateHash,
      readyAt: input.readyAt,
    },
    currentHealth: input.currentHealth
      ? {
          ok: input.currentHealth.ok,
          depthComplete: isMarketMakerDepthComplete(input.currentHealth),
          sameDepthComplete: isMarketMakerSameDepthComplete(input.currentHealth),
          offers: input.currentHealth.hubs.map(hub => hub.offers),
          hubBlockers: input.currentHealth.hubs.map(hub => hub.blockers.length),
          crossOk: input.currentHealth.cross.ok,
          crossExpectedRoutes: input.currentHealth.cross.expectedRoutes,
          crossOffers: input.currentHealth.cross.routes.map(route => route.offers),
          crossBlockers: input.currentHealth.cross.routes.map(route => route.blockers.length),
        }
      : null,
    ...(includeCrossDebug
      ? {
          crossDebug: buildMarketMakerCrossDebugSummary(
            input.env,
            [...input.contexts],
            readVisibleHubProfiles(input.env, true),
            new Map(input.tokenIdsByContext),
          ),
        }
      : {}),
  });

type MarketMakerHealthProjection = {
  env: RuntimeReplica;
  contexts: readonly MarketMakerEntityContext[];
  cachedHealth: MarketMakerHealth | null;
  visibleHubs: readonly HubProfile[];
  allVisibleHubs: readonly HubProfile[];
  activeEntityId: string | null;
  startupPhase: string;
  expectedHubCount: number;
  readyHash: string | null;
  runtimeStateHash: string | null;
  entityStateHash: string | null;
  restoredEntityStateHash: string | null;
  readyAt: number | null;
  lastDirectEntityInput: DirectEntityInputDebug | null;
  lastDirectEntityInputError: DirectEntityInputDebug | null;
};

const resolveMarketMakerHealthForResponse = (input: MarketMakerHealthProjection): MarketMakerHealth => {
  const unavailableHealth: MarketMakerHealth = {
    enabled: true,
    ok: false,
    entityId: input.activeEntityId,
    expectedOffersPerHub: 0,
    expectedOffersPerPair: 0,
    hubs: input.activeEntityId
      ? input.visibleHubs.map(profile => ({
          hubEntityId: profile.entityId,
          offers: 0,
          ready: false,
          depthReady: false,
          blockers: [],
          pairs: [],
        }))
      : [],
    cross: {
      applicable: input.activeEntityId !== null && input.allVisibleHubs.length > 0 && input.contexts.length > 1,
      ok: false,
      expectedRoutes: 0,
      expectedOffersPerRoute: 0,
      expectedOffersPerPair: 0,
      routes: [],
    },
  };
  const health = input.activeEntityId ? (input.cachedHealth ?? unavailableHealth) : unavailableHealth;
  return input.startupPhase === 'offers-ready' ? health : { ...health, ok: false };
};

const buildMarketMakerHealthResponseJson = (input: MarketMakerHealthProjection): string => {
  const marketMakerHealth = resolveMarketMakerHealthForResponse(input);
  const runtimeHalted = input.env.infrastructure?.halted === true;
  const gossipReady = input.visibleHubs.length === input.expectedHubCount;
  const readiness = deriveMarketMakerChildReadiness({
    runtimeHalted,
    startupPhase: input.startupPhase,
    gossipReady,
    marketMakerReady: marketMakerHealth.ok === true,
  });
  return safeStringify({
    ok: readiness.ready,
    live: readiness.live,
    ready: readiness.ready,
    name: resolvedArgs.name,
    height: Math.max(0, Math.floor(Number(input.env.state.height || 0))),
    entityId: input.activeEntityId,
    runtimeId: String(input.env.runtimeId || '') || null,
    relayUrl: resolvedArgs.relayUrl,
    directWsUrl,
    apiUrl,
    startupPhase: input.startupPhase,
    runtime: {
      halted: runtimeHalted,
      lifecyclePhase: input.env.infrastructure?.lifecyclePhase ?? null,
      fatalDebugPayload: input.env.infrastructure?.fatalDebugPayload ?? null,
      securityIncidents: readRuntimeSecurityIncidentTelemetry(input.env),
    },
    p2p: {
      directPeers: getP2PState(input.env).directPeers || [],
      directInput: {
        lastSeen: input.lastDirectEntityInput,
        lastError: input.lastDirectEntityInputError,
      },
    },
    gossip: {
      visibleHubNames: input.visibleHubs.map(profile => profile.name),
      visibleHubIds: input.visibleHubs.map(profile => profile.entityId),
      ready: gossipReady,
    },
    bootstrap: {
      readyHash: input.readyHash,
      runtimeStateHash: input.runtimeStateHash,
      entityStateHash: input.entityStateHash,
      restoredEntityStateHash: input.restoredEntityStateHash,
      readyAt: input.readyAt,
    },
    marketMaker: {
      ...marketMakerHealth,
      quiescence: summarizeRuntimeQuiescence(input.env),
    },
  });
};

type MarketMakerHealthControllerDeps = {
  env: RuntimeReplica;
  contexts: () => readonly MarketMakerEntityContext[];
  tokenIdsByContext: () => ReadonlyMap<string, number[]>;
  activeEntityId: () => string | null;
  startupPhase: () => string;
  bootstrapCrossStarted: () => boolean;
  bootstrap: () => {
    readyHash: string | null;
    runtimeStateHash: string | null;
    entityStateHash: string | null;
    restoredEntityStateHash: string | null;
    readyAt: number | null;
  };
  directInput: () => {
    lastSeen: DirectEntityInputDebug | null;
    lastError: DirectEntityInputDebug | null;
  };
};

const createMarketMakerHealthController = (deps: MarketMakerHealthControllerDeps) => {
  let currentHealth: MarketMakerHealth | null = null;
  let visibleHubs: HubProfile[] = [];
  let allVisibleHubs: HubProfile[] = [];
  let healthResponseJson: string | null = null;
  let infoResponseJson: string | null = null;
  const buildSnapshot = (
    options: { includeCross?: boolean; crossOverride?: MarketMakerHealth['cross'] } = {},
  ): MarketMakerHealth | null => {
    const snapshot = computeMarketMakerHealthSnapshot(
      deps.env,
      [...deps.contexts()],
      deps.activeEntityId(),
      new Map(deps.tokenIdsByContext()),
      options,
    );
    visibleHubs = snapshot.visibleHubs;
    allVisibleHubs = snapshot.allVisibleHubs;
    return snapshot.health;
  };
  const buildInfoResponse = (includeCrossDebug = false): string => {
    const bootstrap = deps.bootstrap();
    return buildMarketMakerInfoResponseJson(
      {
        env: deps.env,
        contexts: deps.contexts(),
        tokenIdsByContext: deps.tokenIdsByContext(),
        currentHealth,
        activeEntityId: deps.activeEntityId(),
        startupPhase: deps.startupPhase(),
        readyHash: bootstrap.readyHash,
        runtimeStateHash: bootstrap.runtimeStateHash,
        entityStateHash: bootstrap.entityStateHash,
        restoredEntityStateHash: bootstrap.restoredEntityStateHash,
        readyAt: bootstrap.readyAt,
      },
      includeCrossDebug,
    );
  };
  const rebuildInfoResponse = (): void => {
    infoResponseJson = buildInfoResponse(false);
  };
  const rebuildHealthResponse = (): void => {
    const contexts = deps.contexts();
    const primaryContext = contexts[0] ?? null;
    const filteredVisibleHubs = visibleHubs.filter(profile =>
      primaryContext ? sameJurisdiction(primaryContext, profile) : true,
    );
    const bootstrap = deps.bootstrap();
    const directInput = deps.directInput();
    healthResponseJson = buildMarketMakerHealthResponseJson({
      env: deps.env,
      contexts,
      cachedHealth: currentHealth,
      visibleHubs: filteredVisibleHubs,
      allVisibleHubs,
      activeEntityId: deps.activeEntityId(),
      startupPhase: deps.startupPhase(),
      expectedHubCount: resolvedArgs.meshHubNames.length,
      readyHash: bootstrap.readyHash,
      runtimeStateHash: bootstrap.runtimeStateHash,
      entityStateHash: bootstrap.entityStateHash,
      restoredEntityStateHash: bootstrap.restoredEntityStateHash,
      readyAt: bootstrap.readyAt,
      lastDirectEntityInput: directInput.lastSeen,
      lastDirectEntityInputError: directInput.lastError,
    });
    rebuildInfoResponse();
  };
  const publish = (
    options: { includeCross?: boolean; crossOverride?: MarketMakerHealth['cross'] } = {},
  ): MarketMakerHealth | null => {
    const health = buildSnapshot(options);
    if (health) currentHealth = health;
    rebuildHealthResponse();
    return health;
  };
  const publishBootstrap = (): MarketMakerHealth | null => {
    if (!deps.bootstrapCrossStarted()) return publish({ includeCross: false });
    const hubs = readVisibleHubProfiles(deps.env, true);
    const plan = buildMarketMakerCrossPlanSummary([...deps.contexts()], hubs, new Map(deps.tokenIdsByContext()));
    return publish({ includeCross: false, crossOverride: buildPlannedMarketMakerCrossHealth(plan) });
  };
  const publishReady = (): MarketMakerHealth | null => {
    if (!currentHealth || !isMarketMakerCrossDepthComplete(currentHealth)) return publish({ includeCross: true });
    return publish({ includeCross: false, crossOverride: currentHealth.cross });
  };
  return {
    buildSnapshot,
    buildInfoResponse,
    rebuildInfoResponse,
    rebuildHealthResponse,
    publish,
    publishBootstrap,
    publishReady,
    readCurrentHealth: (): MarketMakerHealth | null => currentHealth,
    setCurrentHealth: (health: MarketMakerHealth): void => {
      currentHealth = health;
    },
    readHealthResponseJson: (): string | null => healthResponseJson,
    readInfoResponseJson: (): string | null => infoResponseJson,
  };
};

type MarketMakerHttpHandlerDeps = {
  env: RuntimeReplica;
  httpDrain: ReturnType<typeof createHttpDrainTracker>;
  directRuntimeWs: ReturnType<typeof createDirectRuntimeWsRoute>;
  runtimeIngressReceipts: ReturnType<typeof createRuntimeIngressReceiptStore>;
  currentRuntimeHeight: (env: RuntimeReplica | null) => number;
  getActiveEntityId: () => string | null;
  buildAccountStatusDebug: (
    entityId: string,
    counterpartyEntityId: string,
    tokenIds: number[],
  ) => Record<string, unknown>;
  buildInfoResponseJson: (includeCrossDebug?: boolean) => string;
  readCachedInfoResponseJson: () => string | null;
  rebuildCachedInfoResponseJson: () => void;
  buildHealthSnapshot: () => MarketMakerHealth | null;
  readCachedHealthResponseJson: () => string | null;
  rebuildCachedHealthResponseJson: () => void;
  stopRuntimeLoops: () => void;
};

const quiesceMarketMakerRuntime = async (
  deps: MarketMakerHttpHandlerDeps,
  label: string,
  options: { workTimeoutMs: number; loopTimeoutMs: number; quietMs?: number },
): Promise<Response> => {
  deps.stopRuntimeLoops();
  try {
    const result = await quiesceNodeRuntime(deps.env, options);
    return new Response(safeStringify({ ok: true, ...result }), { headers: JSON_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${resolvedArgs.name}] ${label} failed: ${message}`);
    return new Response(safeStringify({ ok: false, error: message }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }
};

const createMarketMakerHttpHandler =
  (deps: MarketMakerHttpHandlerDeps): ((request: Request, server: Bun.Server<{ type?: string }>) => Promise<Response | undefined>) =>
  async (request, server) => {
    const releaseHttp = deps.httpDrain.begin();
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const operatorAuthorized = isLocalOperatorRequest(request, resolveSocketPeerAddress(server, request));
      if (request.headers.get('upgrade') === 'websocket' && pathname === '/rpc') {
        if (server.upgrade(request, { data: { type: 'rpc' } })) return;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      const directUpgrade = deps.directRuntimeWs.maybeUpgrade(request, server);
      if (directUpgrade.handled) return directUpgrade.response;
      if (requiresLocalNodeOperator(url) && !operatorAuthorized) {
        return new Response(safeStringify({ error: 'Operator access required' }), {
          status: 403,
          headers: JSON_HEADERS,
        });
      }
      if (pathname === '/api/account/status' && request.method === 'GET') {
        const entityId = String(
          url.searchParams.get('entityId') || url.searchParams.get('mmEntityId') || deps.getActiveEntityId() || '',
        ).toLowerCase();
        const counterpartyEntityId = String(url.searchParams.get('counterpartyEntityId') || '').toLowerCase();
        if (!entityId || !counterpartyEntityId) {
          return new Response(
            safeStringify({
              success: false,
              code: 'MM_ACCOUNT_STATUS_BAD_REQUEST',
              error: 'entityId/mmEntityId and counterpartyEntityId are required',
            }),
            { status: 400, headers: JSON_HEADERS },
          );
        }
        const tokenIds = String(url.searchParams.get('tokenIds') || '')
          .split(',')
          .map(value => Number(value.trim()))
          .filter(value => Number.isInteger(value) && value > 0);
        return new Response(safeStringify(deps.buildAccountStatusDebug(entityId, counterpartyEntityId, tokenIds)), {
          headers: JSON_HEADERS,
        });
      }
      if (pathname === '/api/info') {
        const includeCrossDebug =
          url.searchParams.get('crossDebug') === '1' || url.searchParams.get('debug') === 'cross';
        if (includeCrossDebug) {
          return new Response(deps.buildInfoResponseJson(true), { headers: JSON_HEADERS });
        }
        if (!deps.readCachedInfoResponseJson()) deps.rebuildCachedInfoResponseJson();
        return new Response(deps.readCachedInfoResponseJson() ?? '{}', { headers: JSON_HEADERS });
      }
      if (pathname === '/api/health/full' || (pathname === '/api/health' && url.searchParams.get('full') === '1')) {
        const health = deps.buildHealthSnapshot();
        return new Response(health ? safeStringify(health) : '{}', { headers: JSON_HEADERS });
      }
      if (pathname === '/api/health') {
        if (!deps.readCachedHealthResponseJson()) deps.rebuildCachedHealthResponseJson();
        return new Response(deps.readCachedHealthResponseJson() ?? '{}', { headers: JSON_HEADERS });
      }
      const runtimeInputStatusMatch = pathname.match(/^\/api\/control\/runtime-input\/([^/]+)\/status$/);
      if (runtimeInputStatusMatch && request.method === 'GET') {
        return handleRuntimeInputStatus(decodeURIComponent(runtimeInputStatusMatch[1] || ''), JSON_HEADERS, deps.env, {
          receipts: deps.runtimeIngressReceipts,
          getCurrentRuntimeHeight: deps.currentRuntimeHeight,
        });
      }
      if (pathname === '/api/control/p2p/stop' && request.method === 'POST') {
        return quiesceMarketMakerRuntime(deps, 'p2p stop', {
          workTimeoutMs: 10_000,
          loopTimeoutMs: 5_000,
        });
      }
      if (pathname === '/api/control/runtime/quiesce' && request.method === 'POST') {
        return quiesceMarketMakerRuntime(deps, 'runtime quiesce', {
          workTimeoutMs: 20_000,
          loopTimeoutMs: 5_000,
          quietMs: 750,
        });
      }
      return new Response(safeStringify({ error: 'Not found' }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    } finally {
      releaseHttp();
    }
  };

type MarketMakerRuntimeAdapterDeps = {
  env: RuntimeReplica;
  runtimeIngressReceipts: ReturnType<typeof createRuntimeIngressReceiptStore>;
  runtimeInputStatusUrl: (id: string) => string;
  isMutatingIngressReady: () => boolean;
};

const createMarketMakerRuntimeAdapterHandler =
  (deps: MarketMakerRuntimeAdapterDeps): ((ws: MarketMakerServerSocket, raw: string | Buffer | ArrayBuffer) => void) =>
  (ws, raw) => {
    let request: import('../api/runtime-adapter/types').RuntimeAdapterRequest;
    try {
      request = decodeRuntimeAdapterRequest(raw);
    } catch (error) {
      closeInvalidRuntimeAdapterMessage(ws, error);
      return;
    }
    Promise.resolve(
      handleRuntimeAdapterMessage(ws, request, deps.env, {
        enqueueRuntimeInput,
        submitCrossJurisdictionIntent: async (env, route) => {
          await submitCrossJurisdictionIntent(env, route);
        },
        validateRuntimeInputAdmission,
        registerReceipt: receipt => deps.runtimeIngressReceipts.register(receipt),
        readReceipt: id => deps.runtimeIngressReceipts.get(id),
        buildRuntimeInputStatusUrl: deps.runtimeInputStatusUrl,
        isMutatingIngressReady: deps.isMutatingIngressReady,
        readHead: env => readPersistedStorageHead(env),
        readFrame: (env, height) => readPersistedStorageFrameRecord(env, height),
        listCheckpoints: env => listPersistedCheckpointHeights(env),
        loadEntityState: (env, entityId, height) => loadEntityStateFromStorageDb(env, entityId, height),
        loadEntityAccountDoc: (env, entityId, counterpartyId, height) =>
          loadEntityAccountDocFromStorageDb(env, entityId, counterpartyId, height),
        loadEntityViewPage: (env, entityId, height, query) =>
          loadEntityViewPageFromStorageDb(env, entityId, height, query),
        listEntityIdsAtHeight: (env, height) => listPersistedEntityIdsAtHeight(env, height),
        readActivityPage: (env, options) => readPersistedRuntimeActivityPage(env, options),
      }),
    ).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      ws.send(safeStringify({ type: 'error', error: `Runtime adapter failed: ${message}` }));
    });
  };

const createMarketMakerWebSocketHandler = (
  env: RuntimeReplica,
  directRuntimeWs: ReturnType<typeof createDirectRuntimeWsRoute>,
  handleRuntimeAdapterMessage: (ws: MarketMakerServerSocket, raw: string | Buffer | ArrayBuffer) => void,
) => ({
  open(ws: MarketMakerServerSocket) {
    if (ws.data?.type === 'rpc') {
      attachRuntimeAdapterTicker(env, registerEnvChangeCallback);
      return;
    }
    directRuntimeWs.websocket.open(ws);
  },
  message(ws: MarketMakerServerSocket, raw: string | Buffer | ArrayBuffer) {
    if (ws.data?.type === 'rpc') {
      handleRuntimeAdapterMessage(ws, raw);
      return;
    }
    return directRuntimeWs.websocket.message(ws, raw);
  },
  close(ws: MarketMakerServerSocket) {
    if (ws.data?.type === 'rpc') {
      forgetRuntimeAdapterClient(ws);
      return;
    }
    directRuntimeWs.websocket.close(ws);
  },
});

type MarketMakerContextInitialization = {
  env: RuntimeReplica;
  jurisdiction: ReturnType<typeof resolveJurisdictionConfig>;
  contexts: MarketMakerEntityContext[];
  setStartupPhase: (phase: string) => void;
  setActiveEntityId: (entityId: string) => void;
};

const initializeMarketMakerContexts = async (
  input: MarketMakerContextInitialization,
): Promise<Map<string, number[]>> => {
  const { env, jurisdiction, contexts, setStartupPhase, setActiveEntityId } = input;
  setStartupPhase('import-jurisdiction');
  enqueueRuntimeInput(env, {
    runtimeTxs: [
      {
        type: 'importJ',
        data: {
          name: jurisdiction.name,
          chainId: jurisdiction.chainId,
          ticker: 'XLN',
          rpcs: [resolveImportedJurisdictionRpc(jurisdiction)],
          entityProviderDeploymentBlock: jurisdiction.entityProviderDeploymentBlock,
          blockTimeMs: requireJurisdictionBlockTimeMs(jurisdiction),
          contracts: jurisdiction.contracts,
          startAtCurrentBlock: false,
        },
      },
    ],
    entityInputs: [],
  });
  await settleRuntimeFor(env, 35);
  const jadapter = await waitForJurisdictionAdapter(env, jurisdiction);
  ensureJurisdictionReplica(env, jadapter, resolveImportedJurisdictionRpc(jurisdiction));
  setStartupPhase('token-catalog');
  const tokenCatalog = await waitForTokenCatalog(jadapter);
  setStartupPhase('import-replica');
  const primaryContext = await createMarketMakerEntityContext(
    env,
    jurisdiction,
    resolvedArgs.signerLabel,
    resolvedArgs.name,
    { x: 0, y: -40, z: 120, jurisdiction: jurisdiction.name },
  );
  setActiveEntityId(primaryContext.entityId);
  contexts.push(primaryContext);

  for (const [index, secondary] of resolveSecondaryJurisdictions(jurisdiction.rpc).entries()) {
    const secondaryName = String(secondary.name || `Secondary ${index + 1}`).trim();
    if (!secondaryName) continue;
    const secondaryDisplayName = formatJurisdictionDisplayName(secondaryName) || secondaryName;
    setStartupPhase(`import-jurisdiction-${secondaryName}`);
    await importJurisdictionIfNeeded(env, secondary);
    setStartupPhase(`import-replica-${secondaryName}`);
    const context = await createMarketMakerEntityContext(
      env,
      secondary,
      `${resolvedArgs.signerLabel}:${secondaryName}`,
      `${resolvedArgs.name} ${secondaryDisplayName}`,
      { x: 160 + index * 80, y: -40, z: 120, jurisdiction: secondaryName },
    );
    contexts.push(context);
    nodeLog.debug('sibling_mm.ready', {
      jurisdiction: secondaryName,
      entityId: context.entityId,
    });
  }
  const tokenIdsByContext = buildMarketMakerTokenIdsByContext(tokenCatalog, contexts);
  nodeLog.debug('token_universe.ready', {
    jurisdictions: contexts.map(context => ({
      jurisdiction: formatJurisdictionDisplayName(context.jurisdictionName) || context.jurisdictionName,
      tokenIds: getMarketMakerTokenIds(tokenIdsByContext, context),
    })),
  });
  return tokenIdsByContext;
};

const selectMarketMakerHubsForContext = (
  visibleHubs: readonly HubProfile[],
  context: MarketMakerEntityContext,
): HubProfile[] =>
  visibleHubs
    .filter(profile => sameJurisdiction(context, profile))
    .sort(
      (left, right) =>
        compareStableText(left.jurisdictionRef, right.jurisdictionRef) ||
        compareStableText(left.entityId, right.entityId),
    );

const buildMarketMakerSameQuoteJobs = (
  contexts: readonly MarketMakerEntityContext[],
  tokenIdsByContext: ReadonlyMap<string, number[]>,
  visibleHubs: readonly HubProfile[],
): SameQuoteJob[] =>
  contexts
    .flatMap(context => {
      const tokenIds = getMarketMakerTokenIds(tokenIdsByContext, context);
      return selectMarketMakerHubsForContext(visibleHubs, context).map(hub => ({ context, hub, tokenIds }));
    })
    .sort(
      (left, right) =>
        compareStableText(left.context.jurisdictionRef, right.context.jurisdictionRef) ||
        compareStableText(left.context.entityId, right.context.entityId) ||
        compareStableText(left.hub.entityId, right.hub.entityId),
    );

const hasMarketMakerCrossAccountBacklog = (
  env: RuntimeReplica,
  contexts: readonly MarketMakerEntityContext[],
  visibleHubs: readonly HubProfile[],
): boolean => {
  for (const sourceContext of contexts) {
    for (const sourceHub of selectMarketMakerHubsForContext(visibleHubs, sourceContext)) {
      if (hasMarketMakerAccountBacklog(env, sourceContext.entityId, sourceHub.entityId)) return true;
    }
    for (const targetContext of contexts) {
      if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext)) continue;
      for (const targetHub of selectMarketMakerHubsForContext(visibleHubs, targetContext)) {
        if (hasMarketMakerAccountBacklog(env, targetContext.entityId, targetHub.entityId)) return true;
      }
    }
  }
  return false;
};

const describeMarketMakerSameQuoteProgress = (env: RuntimeReplica, job: SameQuoteJob): Record<string, unknown> => {
  const account = getAccountReplica(env, job.context.entityId, job.hub.entityId);
  return {
    mmEntityId: job.context.entityId,
    jurisdiction: job.context.jurisdictionName,
    hubEntityId: job.hub.entityId,
    tokenIds: job.tokenIds,
    committedOffers: countCommittedMarketMakerOffersForHub(env, job.context.entityId, job.hub.entityId),
    expectedOffers: buildMarketMakerOfferSpecs([job.hub.entityId], job.tokenIds).length,
    account: account
      ? {
          height: Number(account.currentHeight ?? 0),
          pendingFrame: Boolean(account.pendingFrame),
          mempoolLength: Number(account.mempool?.length || 0),
        }
      : null,
    blocker: describeMarketMakerSameHubBlocker(env, job.context.entityId, job.hub.entityId),
  };
};

type BootstrapSameQuoteDriverDeps = {
  env: RuntimeReplica;
  buildJobs: (visibleHubs: HubProfile[]) => SameQuoteJob[];
  emitProgress: (reason: string, jobs: SameQuoteJob[], selectedJob?: SameQuoteJob) => void;
  getCursor: () => number;
  setCursor: (cursor: number) => void;
};

const createBootstrapSameQuoteDriver =
  (deps: BootstrapSameQuoteDriverDeps) =>
  async (
    visibleHubs: HubProfile[],
    connectivityBudget: MarketMakerConnectivityBudget,
    shouldContinue: () => boolean,
  ): Promise<boolean | null> => {
    const sameQuoteJobs = deps.buildJobs(visibleHubs);
    deps.emitProgress('scan', sameQuoteJobs);
    const orderedIncompleteJobs: SameQuoteJob[] = [];
    for (let offset = 0; offset < sameQuoteJobs.length; offset += 1) {
      const selectedIndex = (deps.getCursor() + offset) % sameQuoteJobs.length;
      const job = sameQuoteJobs[selectedIndex];
      if (job && !isSameQuoteJobDepthReady(deps.env, job)) orderedIncompleteJobs.push(job);
    }
    if (orderedIncompleteJobs.length === 0) return null;

    const jobsByContext = new Map<
      string,
      {
        context: MarketMakerEntityContext;
        tokenIds: number[];
        jobs: SameQuoteJob[];
      }
    >();
    for (const job of orderedIncompleteJobs) {
      const key = marketMakerContextKey(job.context);
      const entry = jobsByContext.get(key) ?? {
        context: job.context,
        tokenIds: job.tokenIds,
        jobs: [],
      };
      entry.jobs.push(job);
      jobsByContext.set(key, entry);
    }
    const groupedEntries = [...jobsByContext.values()].sort(
      (left, right) =>
        compareStableText(left.context.jurisdictionRef, right.context.jurisdictionRef) ||
        compareStableText(left.context.entityId, right.context.entityId),
    );
    const runnableHubEntityIdsFor = (entry: { context: MarketMakerEntityContext; jobs: SameQuoteJob[] }): string[] =>
      entry.jobs
        .map(job => job.hub.entityId)
        .filter(hubEntityId => !hasMarketMakerAccountBacklog(deps.env, entry.context.entityId, hubEntityId))
        .sort(compareStableText);
    const selectJob = (entry: { jobs: SameQuoteJob[] }, runnableHubEntityIds: string[]): SameQuoteJob | null =>
      entry.jobs.find(job => runnableHubEntityIds.includes(job.hub.entityId)) ?? entry.jobs[0] ?? null;

    let enqueuedConnectivity = false;
    for (const entry of groupedEntries) {
      const runnableHubEntityIds = runnableHubEntityIdsFor(entry);
      if (runnableHubEntityIds.length === 0) continue;
      const selectedJob = selectJob(entry, runnableHubEntityIds);
      if (!selectedJob) continue;
      deps.setCursor(sameQuoteJobs.indexOf(selectedJob));
      deps.emitProgress('selected', sameQuoteJobs, selectedJob);
      await yieldMarketMakerApi();
      if (!shouldContinue()) return false;
      if (
        await ensureMarketMakerHubConnectivity(
          deps.env,
          entry.context.entityId,
          entry.context.signerId,
          runnableHubEntityIds,
          entry.tokenIds,
          connectivityBudget,
        )
      )
        enqueuedConnectivity = true;
    }
    if (enqueuedConnectivity) {
      await yieldMarketMakerApi();
      return true;
    }

    let enqueuedQuotes = false;
    for (const entry of groupedEntries) {
      const runnableHubEntityIds = runnableHubEntityIdsFor(entry).slice(
        0,
        MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE,
      );
      if (runnableHubEntityIds.length === 0) continue;
      const selectedJob = selectJob(entry, runnableHubEntityIds);
      if (!selectedJob) continue;
      deps.setCursor(sameQuoteJobs.indexOf(selectedJob));
      deps.emitProgress('selected', sameQuoteJobs, selectedJob);
      await yieldMarketMakerApi();
      if (!shouldContinue()) return false;
      if (
        await maintainMarketMakerQuotes(
          deps.env,
          entry.context.entityId,
          entry.context.signerId,
          runnableHubEntityIds,
          entry.tokenIds,
          MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK,
          MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK,
          connectivityBudget,
          shouldContinue,
        )
      )
        enqueuedQuotes = true;
    }
    if (enqueuedQuotes) {
      await yieldMarketMakerApi();
      return true;
    }
    if (
      orderedIncompleteJobs.every(job => hasMarketMakerAccountBacklog(deps.env, job.context.entityId, job.hub.entityId))
    )
      await yieldMarketMakerApi();
    return false;
  };

const buildMarketMakerCrossQuoteJobs = async (
  env: RuntimeReplica,
  contexts: readonly MarketMakerEntityContext[],
  tokenIdsByContext: ReadonlyMap<string, number[]>,
  mode: MarketMakerQuoteMode,
  visibleHubs: readonly HubProfile[],
  shouldContinue: () => boolean,
): Promise<CrossQuoteJob[] | null> => {
  const jobs: CrossQuoteJob[] = [];
  for (const sourceContext of contexts) {
    await yieldMarketMakerApi();
    if (!shouldContinue()) return null;
    const sourceHubs = selectMarketMakerHubsForContext(visibleHubs, sourceContext).filter(
      profile => mode === 'bootstrap' || !hasMarketMakerAccountBacklog(env, sourceContext.entityId, profile.entityId),
    );
    if (sourceHubs.length === 0) continue;
    const sourceTokenIds = getMarketMakerTokenIds(tokenIdsByContext, sourceContext);
    for (const targetContext of contexts) {
      await yieldMarketMakerApi();
      if (!shouldContinue()) return null;
      if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext)) continue;
      const targetHubs = selectMarketMakerHubsForContext(visibleHubs, targetContext).filter(
        profile => mode === 'bootstrap' || !hasMarketMakerAccountBacklog(env, targetContext.entityId, profile.entityId),
      );
      if (targetHubs.length === 0) continue;
      jobs.push({
        sourceContext,
        targetContext,
        sourceHubs,
        targetHubs,
        sourceTokenIds,
        targetTokenIds: getMarketMakerTokenIds(tokenIdsByContext, targetContext),
      });
    }
  }
  return jobs;
};

type SelectedCrossQuoteJobs = {
  jobs: Array<{ index: number; job: CrossQuoteJob }>;
  nextCursor: number;
};

const selectMarketMakerCrossQuoteJobs = (
  jobs: readonly CrossQuoteJob[],
  cursor: number,
  limit: number,
): SelectedCrossQuoteJobs => {
  if (jobs.length === 0) return { jobs: [], nextCursor: cursor };
  const selected: SelectedCrossQuoteJobs['jobs'] = [];
  let nextCursor = cursor;
  for (let offset = 0; offset < Math.min(limit, jobs.length); offset += 1) {
    const index = (cursor + offset) % jobs.length;
    const job = jobs[index];
    if (!job) continue;
    selected.push({ index, job });
    nextCursor = (index + 1) % jobs.length;
  }
  return { jobs: selected, nextCursor };
};

type MarketMakerShutdownDeps = {
  env: RuntimeReplica;
  server: Bun.Server<{ type?: string }>;
  httpDrain: ReturnType<typeof createHttpDrainTracker>;
  stopRuntimeLoops: () => void;
};

const createMarketMakerShutdown = (deps: MarketMakerShutdownDeps): ((code?: number) => Promise<void>) => {
  let started = false;
  return async (code = 0) => {
    if (started) return;
    started = true;
    deps.stopRuntimeLoops();
    const failures: string[] = [];
    const runCleanup = async (label: string, cleanup: () => Promise<unknown>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        failures.push(`${label}:${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await runCleanup('quiesce', () =>
      quiesceNodeRuntime(deps.env, {
        workTimeoutMs: 10_000,
        loopTimeoutMs: 10_000,
      }),
    );
    await runCleanup('server', () => stopServerGracefully(deps.server, deps.httpDrain, resolvedArgs.name, 5_000));
    await runCleanup('runtime_db', () => closeRuntimeDb(deps.env));
    await runCleanup('infra_db', () => closeInfraDb(deps.env));
    if (failures.length > 0) {
      console.error(`[${resolvedArgs.name}] shutdown failed: ${failures.join('|')}`);
      process.exit(code || 1);
    }
    process.exit(code);
  };
};

const installMarketMakerShutdownSignals = (shutdown: (code?: number) => Promise<void>): void => {
  const stopParentWatch = startParentLivenessWatch(
    resolvedArgs.name,
    process.env['XLN_ORCHESTRATOR_PID'],
    () => void shutdown(1),
  );
  const shutdownFromSignal = (): void => {
    stopParentWatch();
    void shutdown();
  };
  process.on('SIGTERM', shutdownFromSignal);
  process.on('SIGINT', shutdownFromSignal);
};

type BootstrapProgressMonitorDeps = {
  env: RuntimeReplica;
  primaryContext: MarketMakerEntityContext;
  phase: () => string;
  checkpoint: () => Record<string, unknown>;
  directInput: () => {
    lastSeen: DirectEntityInputDebug | null;
    lastError: DirectEntityInputDebug | null;
  };
  emit: (event: string, fields?: Record<string, unknown>) => void;
};

/**
 * Separates causal-progress accounting from quote production.
 *
 * A busy Runtime is not stalled merely because market depth is unchanged: its
 * accepted inputs may still be advancing toward a durable frame. Conversely,
 * unchanged health and Runtime checkpoints mean startup is truly stuck.
 */
const createBootstrapProgressMonitor = (deps: BootstrapProgressMonitorDeps) => {
  let lastProgressAt = Date.now();
  let lastProgressSignature = '';
  let lastProgressReason = 'startup';
  let lastProgressCheckpoint = deps.checkpoint();
  let workStartedAt: number | null = null;
  const observe = (
    reason: string,
    health: MarketMakerHealth | null,
  ): ReturnType<typeof evaluateBootstrapProgressDeadline> => {
    const checkpoint = deps.checkpoint();
    const signature = marketMakerBootstrapProgressSignature(health, checkpoint);
    const evaluation = evaluateBootstrapProgressDeadline(
      { signature: lastProgressSignature, lastProgressAt },
      signature,
      Date.now(),
      MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS,
    );
    if (!evaluation.progressed) return evaluation;
    lastProgressSignature = evaluation.signature;
    lastProgressAt = evaluation.lastProgressAt;
    lastProgressReason = reason;
    lastProgressCheckpoint = checkpoint;
    deps.emit('progress', {
      reason,
      idleMs: 0,
      health: summarizeMarketMakerHealthForDebug(health),
    });
    return evaluation;
  };
  const updateWork = (active: boolean): void => {
    const now = Date.now();
    workStartedAt = updateBootstrapWorkStartedAt(
      workStartedAt,
      active,
      now,
      deps.env.infrastructure?.processingPromise
        ? Math.max(deps.env.lastProcessEnteredAt ?? 0, deps.env.activeProcessProgressAt ?? 0)
        : undefined,
    );
  };
  const assertNotStalled = (health: MarketMakerHealth | null): void => {
    const now = Date.now();
    const evaluation = observe('deadline-checkpoint', health);
    if (!evaluation.stalled) return;
    if (
      hasMarketMakerRuntimeBacklog(deps.env) &&
      isBootstrapWorkWithinDeadline(workStartedAt, now, MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS)
    )
      return;
    const visibleHubs = readVisibleHubProfiles(deps.env).filter(profile =>
      sameJurisdiction(deps.primaryContext, profile),
    );
    const directInput = deps.directInput();
    const capsule = buildBootstrapStallCapsule({
      env: deps.env,
      phase: deps.phase(),
      idleMs: evaluation.idleMs,
      lastProgressReason,
      lastProgressSignature,
      lastProgressCheckpoint,
      currentCheckpoint: deps.checkpoint(),
      summarizedHealth: summarizeMarketMakerHealthForDebug(health),
      visibleHubs,
      lastDirectEntityInput: directInput.lastSeen,
      lastDirectEntityInputError: directInput.lastError,
    });
    console.error(`[MESH-MM] BOOTSTRAP_STALLED capsule=${safeStringify(capsule)}`);
    deps.emit('timeout', { capsule });
    throw new Error(
      `MARKET_MAKER_BOOTSTRAP_STALLED:phase=${deps.phase()}:idleMs=${evaluation.idleMs}:` +
        `pendingReliable=${summarizeRuntimeQuiescence(deps.env).pendingReliableOutputs}`,
    );
  };
  return { assertNotStalled, observe, updateWork };
};

type WaitForBootstrapOffersDeps = {
  env: RuntimeReplica;
  isShuttingDown: () => boolean;
  health: ReturnType<typeof createMarketMakerHealthController>;
  progress: ReturnType<typeof createBootstrapProgressMonitor>;
  refreshPhase: (health: MarketMakerHealth | null) => void;
  isDepthComplete: (health: MarketMakerHealth | null) => boolean;
  canCheckCompletion: () => boolean;
  buildCompletionHealth: () => MarketMakerHealth | null;
  driveQuotes: (mode: MarketMakerQuoteMode) => Promise<boolean>;
  emit: (event: string, fields?: Record<string, unknown>) => void;
};

const waitForBootstrapOffers = async (deps: WaitForBootstrapOffersDeps): Promise<MarketMakerHealth | null> => {
  let completionCheckArmed = false;
  let lastBacklogLogAt = 0;
  while (!deps.isShuttingDown()) {
    const hasBacklog = hasMarketMakerRuntimeBacklog(deps.env);
    deps.progress.updateWork(hasBacklog);
    deps.progress.assertNotStalled(deps.health.readCurrentHealth());
    if (hasBacklog) {
      deps.progress.observe('runtime-backlog', deps.health.readCurrentHealth());
      completionCheckArmed = false;
      await yieldMarketMakerApi();
      await sleep(MARKET_MAKER_BOOTSTRAP_LOOP_MS);
      continue;
    }
    const beforeDrive = deps.health.publishBootstrap();
    deps.progress.observe('health', beforeDrive);
    deps.refreshPhase(beforeDrive);
    await yieldMarketMakerApi();
    if (deps.isDepthComplete(beforeDrive) && deps.canCheckCompletion()) return beforeDrive;
    if (completionCheckArmed && deps.canCheckCompletion()) {
      const startedAt = Date.now();
      const completionHealth = deps.buildCompletionHealth();
      deps.emit('completion-health', {
        durationMs: Date.now() - startedAt,
        health: summarizeMarketMakerHealthForDebug(completionHealth),
      });
      deps.progress.observe('completion-health', completionHealth);
      await yieldMarketMakerApi();
      if (deps.isDepthComplete(completionHealth) && deps.canCheckCompletion()) return completionHealth;
      completionCheckArmed = false;
    }
    const enqueued = await deps.driveQuotes('bootstrap');
    await yieldMarketMakerApi();
    if (enqueued) {
      deps.progress.updateWork(true);
      completionCheckArmed = false;
    }
    if (hasMarketMakerRuntimeBacklog(deps.env)) {
      deps.progress.observe('runtime-backlog', deps.health.readCurrentHealth());
      completionCheckArmed = false;
      await sleep(MARKET_MAKER_BOOTSTRAP_LOOP_MS);
      continue;
    }
    deps.progress.updateWork(false);
    const health = deps.health.publishBootstrap();
    deps.progress.observe('health', health);
    deps.refreshPhase(health);
    if (!enqueued && deps.canCheckCompletion()) {
      completionCheckArmed = true;
      await yieldMarketMakerApi();
      const now = Date.now();
      if (now - lastBacklogLogAt >= 5_000) {
        lastBacklogLogAt = now;
        const backlog = getMarketMakerRuntimeBacklogSnapshot(deps.env);
        deps.emit('backlog', { backlog });
        if (MARKET_MAKER_BOOTSTRAP_LOG_BACKLOG) {
          console.log(`[MESH-MM] BOOTSTRAP_WAIT_BACKLOG ${safeStringify(backlog)}`);
        }
      }
    }
    await sleep(MARKET_MAKER_BOOTSTRAP_LOOP_MS);
  }
  return null;
};

type MarketMakerBootstrapFinalization = {
  health: MarketMakerHealth;
  fingerprint: ReturnType<typeof buildMarketMakerBootstrapFingerprint>;
  runtimeStateHash: string;
  entityStateHash: string;
};

type MarketMakerBootstrapFinalizerDeps = {
  env: RuntimeReplica;
  contexts: () => readonly MarketMakerEntityContext[];
  tokenIdsByContext: () => ReadonlyMap<string, number[]>;
  health: ReturnType<typeof createMarketMakerHealthController>;
  buildSameQuoteJobs: (visibleHubs: HubProfile[]) => SameQuoteJob[];
  allSameQuoteDepthReady: (visibleHubs: HubProfile[]) => boolean;
  isReady: () => boolean;
  canCheckCompletion: () => boolean;
  publish: (finalization: MarketMakerBootstrapFinalization) => void;
  emit: (event: string, fields?: Record<string, unknown>) => void;
  logReadyHash: (fields: Record<string, unknown>) => void;
  logOffersReady: (fields: Record<string, unknown>) => void;
  primaryContext: MarketMakerEntityContext;
  apiUrl: string;
};

const createMarketMakerBootstrapFinalizer = (deps: MarketMakerBootstrapFinalizerDeps) => {
  const build = (): MarketMakerBootstrapFinalization => {
    const visibleHubs = readVisibleHubProfiles(deps.env, true);
    if (!deps.allSameQuoteDepthReady(visibleHubs)) {
      throw new Error(
        `MARKET_MAKER_BOOTSTRAP_INCOMPLETE: ${safeStringify({
          scope: 'same-chain-all-contexts-depth',
          incomplete: deps
            .buildSameQuoteJobs(visibleHubs)
            .filter(job => !isSameQuoteJobDepthReady(deps.env, job))
            .map(job => ({
              mmEntityId: job.context.entityId,
              jurisdiction: job.context.jurisdictionName,
              hubEntityId: job.hub.entityId,
              committedOffers: countCommittedMarketMakerOffersForHub(deps.env, job.context.entityId, job.hub.entityId),
              expectedOffers: buildMarketMakerOfferSpecs([job.hub.entityId], job.tokenIds).length,
              blocker: describeMarketMakerSameHubBlocker(deps.env, job.context.entityId, job.hub.entityId),
            })),
        })}`,
      );
    }
    const assertStartedAt = Date.now();
    const health = assertMarketMakerBootstrapFinalized(deps.env, deps.health.publish({ includeCross: true }));
    deps.emit('finalize-step', { step: 'assert-finalized', durationMs: Date.now() - assertStartedAt });
    const fingerprintStartedAt = Date.now();
    const fingerprint = buildMarketMakerBootstrapFingerprint(
      deps.env,
      [...deps.contexts()],
      visibleHubs,
      new Map(deps.tokenIdsByContext()),
      health,
    );
    deps.emit('finalize-step', { step: 'fingerprint', durationMs: Date.now() - fingerprintStartedAt });
    const hashStartedAt = Date.now();
    const runtimeStateHash = computeCanonicalStateHashFromEnv(deps.env);
    const entityStateHash = buildMarketMakerBootstrapEntityStateHash(deps.env);
    deps.emit('finalize-step', { step: 'canonical-hashes', durationMs: Date.now() - hashStartedAt });
    return { health, fingerprint, runtimeStateHash, entityStateHash };
  };
  const markReady = async (): Promise<boolean> => {
    if (deps.isReady()) return true;
    if (!deps.canCheckCompletion()) return false;
    // Accepted ingress gets one event-loop turn to enter the Runtime mempool.
    // READY is published only if the completion fence remains true afterwards.
    await yieldMarketMakerApi();
    if (!deps.canCheckCompletion()) return false;
    // RuntimeReplica advances only after the canonical commit point has persisted
    // the frame and durable outbox. READY therefore describes committed state;
    // it must never invent a bootstrap-specific snapshot or second commit path.
    const finalizeStartedAt = Date.now();
    const publishStartedAt = Date.now();
    const finalization = build();
    deps.publish(finalization);
    deps.emit('finalize-step', { step: 'publish-ready-state', durationMs: Date.now() - publishStartedAt });
    const { health, fingerprint, runtimeStateHash, entityStateHash } = finalization;
    deps.emit('ready-hash', {
      hash: fingerprint.hash,
      runtimeStateHash,
      entityStateHash,
      health: summarizeMarketMakerHealthForDebug(health),
      finalizeDurationMs: Date.now() - finalizeStartedAt,
    });
    deps.logReadyHash({ hash: fingerprint.hash, runtimeStateHash, entityStateHash });
    if (readBooleanEnv('XLN_MARKET_MAKER_LOG_READY_HASH_PAYLOAD', false)) {
      console.log(`[MESH-MM] BOOTSTRAP_READY_HASH_PAYLOAD payload=${safeStringify(fingerprint.payload)}`);
    }
    deps.logOffersReady({
      entityId: deps.primaryContext.entityId,
      runtimeId: String(deps.env.runtimeId || ''),
      api: deps.apiUrl,
      relay: resolvedArgs.relayUrl,
    });
    return true;
  };
  return { markReady };
};

type MarketMakerMaintenanceLoopDeps = {
  env: RuntimeReplica;
  isShuttingDown: () => boolean;
  phase: () => string;
  health: ReturnType<typeof createMarketMakerHealthController>;
  driveQuotes: (mode?: MarketMakerQuoteMode) => Promise<boolean>;
  canCheckCompletion: () => boolean;
  buildCompletionHealth: () => MarketMakerHealth | null;
  isBootstrapDepthComplete: (health: MarketMakerHealth | null) => boolean;
  markReady: () => Promise<boolean>;
  emit: (event: string, fields?: Record<string, unknown>) => void;
};

const createMarketMakerMaintenanceLoops = (deps: MarketMakerMaintenanceLoopDeps) => {
  let quoteTimer: ReturnType<typeof setInterval> | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let healthRefreshInFlight = false;
  const fail = (error: unknown): void => {
    if (deps.isShuttingDown()) return;
    const message = error instanceof Error ? error.message : String(error);
    deps.emit('fatal', { error: message });
    console.error('[MM] quote loop failed; shutting down:', message);
    stop();
    process.exit(1);
  };
  const refreshHealth = (): void => {
    if (deps.isShuttingDown() || healthRefreshInFlight || hasMarketMakerRuntimeBacklog(deps.env)) return;
    healthRefreshInFlight = true;
    try {
      if (deps.phase() === 'offers-ready') deps.health.publishReady();
      else deps.health.publishBootstrap();
    } finally {
      healthRefreshInFlight = false;
    }
  };
  const maintainQuotes = async (): Promise<void> => {
    if (hasMarketMakerRuntimeBacklog(deps.env)) return;
    if (deps.phase() === 'offers-ready') {
      const before = deps.health.publishReady();
      if (isMarketMakerFullDepthComplete(before)) return;
      await deps.driveQuotes('steady');
      const after = deps.health.publishReady();
      if (!isMarketMakerFullDepthComplete(after)) deps.health.publish({ includeCross: true });
      return;
    }
    const enqueued = await deps.driveQuotes();
    deps.health.publishBootstrap();
    if (!enqueued && deps.canCheckCompletion()) {
      const completionHealth = deps.buildCompletionHealth();
      if (deps.isBootstrapDepthComplete(completionHealth)) await deps.markReady();
    }
  };
  const startQuotes = (): void => {
    if (quoteTimer) return;
    quoteTimer = setInterval(() => {
      if (!deps.isShuttingDown()) void maintainQuotes().catch(fail);
    }, MARKET_MAKER_QUOTE_LOOP_MS);
  };
  const startHealth = (): void => {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      try {
        refreshHealth();
      } catch (error) {
        fail(error);
      }
    }, MARKET_MAKER_HEALTH_REFRESH_MS);
  };
  function stop(): void {
    if (quoteTimer) clearInterval(quoteTimer);
    if (healthTimer) clearInterval(healthTimer);
    quoteTimer = null;
    healthTimer = null;
  }
  return { fail, startHealth, startQuotes, stop };
};

type MarketMakerQuoteReadModelDeps = {
  env: RuntimeReplica;
  contexts: () => readonly MarketMakerEntityContext[];
  tokenIdsByContext: () => ReadonlyMap<string, number[]>;
  health: ReturnType<typeof createMarketMakerHealthController>;
  bootstrapCross: () => {
    started: boolean;
    producerAttempted: boolean;
  };
  emit: (event: string, fields?: Record<string, unknown>) => void;
};

const createMarketMakerQuoteReadModel = (deps: MarketMakerQuoteReadModelDeps) => {
  let lastProgressLogAt = 0;
  let lastProgressKey = '';
  let completionHealthHeight = -1;
  let completionHealth: MarketMakerHealth | null = null;
  const buildSameJobs = (visibleHubs: HubProfile[]): SameQuoteJob[] =>
    buildMarketMakerSameQuoteJobs([...deps.contexts()], new Map(deps.tokenIdsByContext()), visibleHubs);
  const allSameDepthReady = (visibleHubs: HubProfile[]): boolean => {
    const jobs = buildSameJobs(visibleHubs);
    return jobs.length > 0 && jobs.every(job => isSameQuoteJobDepthReady(deps.env, job));
  };
  const hasCrossAccountBacklog = (visibleHubs: HubProfile[]): boolean =>
    hasMarketMakerCrossAccountBacklog(deps.env, [...deps.contexts()], visibleHubs);
  const emitSameProgress = (reason: string, jobs: SameQuoteJob[], selectedJob?: SameQuoteJob): void => {
    if (!MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL) return;
    const now = Date.now();
    if (now - lastProgressLogAt < 2_000) return;
    const incomplete = jobs.filter(job => !isSameQuoteJobDepthReady(deps.env, job));
    const key = incomplete
      .map(
        job =>
          `${job.context.entityId}:${job.hub.entityId}:` +
          countCommittedMarketMakerOffersForHub(deps.env, job.context.entityId, job.hub.entityId),
      )
      .join('|');
    if (key === lastProgressKey) return;
    lastProgressKey = key;
    lastProgressLogAt = now;
    deps.emit('same-quote-progress', {
      reason,
      selected: selectedJob ? describeMarketMakerSameQuoteProgress(deps.env, selectedJob) : null,
      incomplete: incomplete.slice(0, 8).map(job => describeMarketMakerSameQuoteProgress(deps.env, job)),
      incompleteCount: incomplete.length,
    });
  };
  const isBootstrapDepthComplete = (health: MarketMakerHealth | null): boolean =>
    allSameDepthReady(readVisibleHubProfiles(deps.env, true)) && isMarketMakerDepthComplete(health);
  const buildCompletionHealth = (): MarketMakerHealth | null => {
    if (completionHealthHeight === deps.env.state.height) return completionHealth;
    completionHealthHeight = deps.env.state.height;
    completionHealth = deps.health.buildSnapshot({ includeCross: true });
    if (completionHealth) {
      deps.health.setCurrentHealth(completionHealth);
      deps.health.rebuildHealthResponse();
    }
    return completionHealth;
  };
  const invalidateCompletionHealth = (): void => {
    completionHealthHeight = -1;
  };
  const canCheckCompletion = (): boolean => {
    const bootstrapCross = deps.bootstrapCross();
    if (!bootstrapCross.started || hasMarketMakerRuntimeBacklog(deps.env)) return false;
    const visibleHubs = readVisibleHubProfiles(deps.env, true);
    const plan = buildMarketMakerCrossPlanSummary([...deps.contexts()], visibleHubs, new Map(deps.tokenIdsByContext()));
    if (plan.expectedRoutes > 0 && !bootstrapCross.producerAttempted) return false;
    return plan.expectedRoutes === 0 || !hasCrossAccountBacklog(visibleHubs);
  };
  return {
    allSameDepthReady,
    buildCompletionHealth,
    buildSameJobs,
    canCheckCompletion,
    emitSameProgress,
    hasCrossAccountBacklog,
    invalidateCompletionHealth,
    isBootstrapDepthComplete,
  };
};

type MarketMakerQuoteEngineState = {
  inFlight: boolean;
  bootstrapCrossCursor: number;
  steadyCrossCursor: number;
  attemptedBootstrapIntentOrderIds: Set<string>;
};

type MarketMakerQuoteEngineDeps = {
  env: RuntimeReplica;
  contexts: () => readonly MarketMakerEntityContext[];
  tokenIdsByContext: () => ReadonlyMap<string, number[]>;
  health: ReturnType<typeof createMarketMakerHealthController>;
  readModel: ReturnType<typeof createMarketMakerQuoteReadModel>;
  isShuttingDown: () => boolean;
  driveBootstrapSameQuotes: (
    visibleHubs: HubProfile[],
    budget: MarketMakerConnectivityBudget,
    shouldContinue: () => boolean,
  ) => Promise<boolean | null>;
  bootstrapCross: {
    isStarted: () => boolean;
    markStarted: (health: MarketMakerHealth | null) => void;
    planJobCount: () => number | null;
    recordPlan: (expectedJobs: number, expectedRoutes: number) => void;
    markProducerAttempted: () => void;
  };
};

type SameContextQuoteInput = {
  deps: MarketMakerQuoteEngineDeps;
  mode: MarketMakerQuoteMode;
  visibleHubs: HubProfile[];
  connectivityBudget: MarketMakerConnectivityBudget;
  shouldContinue: () => boolean;
  context: MarketMakerEntityContext;
};

const maintainSameContextQuotes = async (input: SameContextQuoteInput): Promise<boolean> => {
  await yieldMarketMakerApi();
  if (!input.shouldContinue()) return false;
  const hubEntityIds = selectMarketMakerHubsForContext(input.visibleHubs, input.context)
    .filter(profile => !hasMarketMakerAccountBacklog(input.deps.env, input.context.entityId, profile.entityId))
    .map(profile => profile.entityId);
  if (hubEntityIds.length === 0) return false;
  const tokenIds = getMarketMakerTokenIds(new Map(input.deps.tokenIdsByContext()), input.context);
  const enqueued = await maintainMarketMakerQuotes(
    input.deps.env,
    input.context.entityId,
    input.context.signerId,
    hubEntityIds,
    tokenIds,
    input.mode === 'bootstrap'
      ? MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK
      : MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK,
    input.mode === 'bootstrap' ? MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK : MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK,
    input.connectivityBudget,
    input.shouldContinue,
  );
  await yieldMarketMakerApi();
  return enqueued;
};

const selectQuoteEngineCrossJobs = (
  state: MarketMakerQuoteEngineState,
  mode: MarketMakerQuoteMode,
  jobs: CrossQuoteJob[],
): Array<{ index: number; job: CrossQuoteJob }> => {
  const cursor = mode === 'bootstrap' ? state.bootstrapCrossCursor : state.steadyCrossCursor;
  const limit =
    mode === 'bootstrap' ? jobs.length : Math.min(MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK, jobs.length);
  const selection = selectMarketMakerCrossQuoteJobs(jobs, cursor, limit);
  if (mode === 'steady') state.steadyCrossCursor = selection.nextCursor;
  return selection.jobs;
};

type SelectedCrossQuoteInput = {
  deps: MarketMakerQuoteEngineDeps;
  state: MarketMakerQuoteEngineState;
  mode: MarketMakerQuoteMode;
  jobs: CrossQuoteJob[];
  selected: Array<{ index: number; job: CrossQuoteJob }>;
  connectivityBudget: MarketMakerConnectivityBudget;
  shouldContinue: () => boolean;
};

const maintainSelectedCrossQuotes = async (input: SelectedCrossQuoteInput): Promise<boolean> => {
  for (const { index, job } of input.selected) {
    await yieldMarketMakerApi();
    if (!input.shouldContinue()) return false;
    const enqueued = await maintainMarketMakerCrossQuotes(
      input.deps.env,
      job.sourceContext,
      job.targetContext,
      job.sourceHubs,
      job.targetHubs,
      job.sourceTokenIds,
      job.targetTokenIds,
      input.mode === 'bootstrap'
        ? MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK
        : Math.max(2, Math.floor(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK / 2)),
      input.mode === 'bootstrap'
        ? MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK
        : Math.max(2, Math.floor(MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK / 2)),
      input.connectivityBudget,
      input.shouldContinue,
      input.mode === 'bootstrap' ? MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE : Number.MAX_SAFE_INTEGER,
      input.mode === 'bootstrap',
      input.state.attemptedBootstrapIntentOrderIds,
    );
    if (enqueued) {
      const nextCursor = (index + 1) % input.jobs.length;
      if (input.mode === 'bootstrap') input.state.bootstrapCrossCursor = nextCursor;
      if (input.mode === 'steady') input.state.steadyCrossCursor = nextCursor;
      await yieldMarketMakerApi();
      if (input.mode === 'steady') return true;
    }
    await yieldMarketMakerApi();
  }
  return false;
};

const driveMarketMakerQuotes = async (
  deps: MarketMakerQuoteEngineDeps,
  state: MarketMakerQuoteEngineState,
  mode: MarketMakerQuoteMode = 'steady',
): Promise<boolean> => {
  if (deps.isShuttingDown() || state.inFlight) return false;
  state.inFlight = true;
  try {
    if (hasMarketMakerRuntimeBacklog(deps.env)) return false;
    const connectivityBudget: MarketMakerConnectivityBudget = {
      remainingTxs:
        mode === 'bootstrap'
          ? MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK
          : MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK,
    };
    const visibleHubs = readVisibleHubProfiles(deps.env, true);
    const shouldContinue = () => !deps.isShuttingDown();
    if (visibleHubs.length === 0 || !shouldContinue()) return false;
    if (!areMarketMakerHubTransportsReady(getP2PState(deps.env), visibleHubs)) return false;
    await yieldMarketMakerApi();
    const healthBeforeQuotes = mode === 'bootstrap' ? deps.health.buildSnapshot({ includeCross: false }) : null;
    const primarySameDepthReady = isMarketMakerSameDepthComplete(healthBeforeQuotes);
    if (mode === 'bootstrap') {
      const result = await deps.driveBootstrapSameQuotes(visibleHubs, connectivityBudget, shouldContinue);
      if (result !== null) return result;
    } else {
      for (const context of deps.contexts()) {
        if (
          await maintainSameContextQuotes({
            deps,
            mode,
            visibleHubs,
            connectivityBudget,
            shouldContinue,
            context,
          })
        )
          return true;
        if (!shouldContinue()) return false;
      }
    }
    if (mode === 'bootstrap') {
      if (!(primarySameDepthReady && deps.readModel.allSameDepthReady(visibleHubs))) return false;
      if (!deps.bootstrapCross.isStarted()) {
        deps.bootstrapCross.markStarted(healthBeforeQuotes);
        await yieldMarketMakerApi();
      }
      if (deps.readModel.hasCrossAccountBacklog(visibleHubs)) {
        await yieldMarketMakerApi();
        return false;
      }
    }
    const jobs = await buildMarketMakerCrossQuoteJobs(
      deps.env,
      [...deps.contexts()],
      new Map(deps.tokenIdsByContext()),
      mode,
      visibleHubs,
      shouldContinue,
    );
    if (!jobs) return false;
    if (mode === 'bootstrap' && deps.bootstrapCross.isStarted()) {
      const plan = buildMarketMakerCrossPlanSummary(
        [...deps.contexts()],
        visibleHubs,
        new Map(deps.tokenIdsByContext()),
      );
      if (deps.bootstrapCross.planJobCount() !== plan.expectedJobs) {
        deps.bootstrapCross.recordPlan(plan.expectedJobs, plan.expectedRoutes);
      }
      if (jobs.length > 0) deps.bootstrapCross.markProducerAttempted();
    }
    const selected = selectQuoteEngineCrossJobs(state, mode, jobs);
    const enqueued = await maintainSelectedCrossQuotes({
      deps,
      state,
      mode,
      jobs,
      selected,
      connectivityBudget,
      shouldContinue,
    });
    if (!shouldContinue()) return false;
    await yieldMarketMakerApi();
    return enqueued;
  } finally {
    state.inFlight = false;
  }
};

type MarketMakerNodeState = {
  phase: string;
  externalIngressReady: boolean;
  activeEntityId: string | null;
  contexts: MarketMakerEntityContext[];
  tokenIdsByContext: Map<string, number[]>;
  bootstrapReadyHash: string | null;
  bootstrapRuntimeStateHash: string | null;
  bootstrapEntityStateHash: string | null;
  bootstrapReadyAt: number | null;
  bootstrapCrossStarted: boolean;
  bootstrapCrossPlanJobCount: number | null;
  bootstrapCrossProducerAttempted: boolean;
  lastDirectInput: DirectEntityInputDebug | null;
  lastDirectInputError: DirectEntityInputDebug | null;
  shuttingDown: boolean;
  stopRuntimeLoops: () => void;
};

type MarketMakerNodeContext = {
  env: RuntimeReplica;
  state: MarketMakerNodeState;
  ingressReceipts: ReturnType<typeof createRuntimeIngressReceiptStore>;
  health: ReturnType<typeof createMarketMakerHealthController>;
  emit: (event: string, fields?: Record<string, unknown>) => void;
  checkpoint: () => Record<string, unknown>;
};

const createMarketMakerNodeContext = (
  env: RuntimeReplica,
  restoredEntityStateHash: string | null,
): MarketMakerNodeContext => {
  const state: MarketMakerNodeState = {
    phase: 'boot',
    externalIngressReady: false,
    activeEntityId: null,
    contexts: [],
    tokenIdsByContext: new Map(),
    bootstrapReadyHash: null,
    bootstrapRuntimeStateHash: null,
    bootstrapEntityStateHash: null,
    bootstrapReadyAt: null,
    bootstrapCrossStarted: false,
    bootstrapCrossPlanJobCount: null,
    bootstrapCrossProducerAttempted: false,
    lastDirectInput: null,
    lastDirectInputError: null,
    shuttingDown: false,
    stopRuntimeLoops: () => {
      state.shuttingDown = true;
    },
  };
  const ingressReceipts = createRuntimeIngressReceiptStore();
  const emit = (event: string, fields: Record<string, unknown> = {}): void =>
    emitNodeBootstrapDebugEvent(env, state.phase, state.activeEntityId, event, fields);
  const checkpoint = (): Record<string, unknown> => buildNodeBootstrapCausalCheckpoint(env, state.contexts);
  const health = createMarketMakerHealthController({
    env,
    contexts: () => state.contexts,
    tokenIdsByContext: () => state.tokenIdsByContext,
    activeEntityId: () => state.activeEntityId,
    startupPhase: () => state.phase,
    bootstrapCrossStarted: () => state.bootstrapCrossStarted,
    bootstrap: () => ({
      readyHash: state.bootstrapReadyHash,
      runtimeStateHash: state.bootstrapRuntimeStateHash,
      entityStateHash: state.bootstrapEntityStateHash,
      restoredEntityStateHash,
      readyAt: state.bootstrapReadyAt,
    }),
    directInput: () => ({
      lastSeen: state.lastDirectInput,
      lastError: state.lastDirectInputError,
    }),
  });
  return { env, state, ingressReceipts, health, emit, checkpoint };
};

type StartedMarketMakerServices = {
  server: Bun.Server<{ type?: string }>;
  httpDrain: ReturnType<typeof createHttpDrainTracker>;
  primaryContext: MarketMakerEntityContext;
};

const startMarketMakerServices = async (context: MarketMakerNodeContext): Promise<StartedMarketMakerServices> => {
  const { env, state, ingressReceipts, health } = context;
  const runtimeInputStatusUrl = (id: string): string => `/api/control/runtime-input/${encodeURIComponent(id)}/status`;
  const directRuntimeWs = createDirectRuntimeWsRoute({
    runtimeId: String(env.runtimeId || ''),
    runtimeSeed: resolvedArgs.seed,
    onRecoveryBundleRequest: async (_from, lookupKey) =>
      resolveRuntimeAdapterRead({ env }, `recovery/bundles/${encodeURIComponent(lookupKey)}`),
    onEntityInputs: async (from, envelope, ingressTimestamp) => {
      if (!state.externalIngressReady) throw new Error('RUNTIME_STARTUP_J_CATCHUP_PENDING');
      const debugEntry: DirectEntityInputDebug = {
        at: Date.now(),
        fromRuntimeId: String(from || ''),
        entityIds: envelope.entityInputs.map(input => String(input.entityId || '')),
        signerIds: envelope.entityInputs.map(input => String(input.signerId || '')),
        txTypes: envelope.entityInputs.flatMap(input => (input.entityTxs || []).map(tx => String(tx?.type || ''))),
      };
      state.lastDirectInput = debugEntry;
      try {
        const inbound = handleInboundP2PEntityInputs(env, from, envelope, ingressTimestamp);
        for (const receipt of inbound.receipts) {
          requireDeliveryDelivered(
            directRuntimeWs.sendReliableReceiptDelivery(from, receipt),
            delivery => `DIRECT_RELIABLE_RECEIPT_NOT_DELIVERED:${delivery.code}`,
          );
        }
      } catch (error) {
        state.lastDirectInputError = {
          ...debugEntry,
          error: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
    },
    onReliableReceipt: (from, receipt) => {
      if (!state.externalIngressReady) throw new Error('RUNTIME_STARTUP_J_CATCHUP_PENDING');
      handleInboundReliableReceipt(env, from, receipt);
    },
  });
  env.infrastructure = env.infrastructure ?? {};
  // Direct dispatch is process infrastructure. It is deliberately installed
  // outside every Runtime frame and excluded from canonical state roots.
  env.infrastructure.directEntityInputsDispatch = (targetRuntimeId, envelope, ingressTimestamp) =>
    directRuntimeWs.sendEntityInputsDelivery(targetRuntimeId, envelope, ingressTimestamp);
  env.infrastructure.directReliableReceiptDispatch = (targetRuntimeId, receipt) =>
    directRuntimeWs.sendReliableReceiptDelivery(targetRuntimeId, receipt);
  const handleRuntimeAdapterWsMessage = createMarketMakerRuntimeAdapterHandler({
    env,
    runtimeIngressReceipts: ingressReceipts,
    runtimeInputStatusUrl,
    isMutatingIngressReady: () => state.externalIngressReady,
  });
  const httpDrain = createHttpDrainTracker();
  const server = Bun.serve<{ type?: string }>({
    hostname: resolvedArgs.apiHost,
    port: resolvedArgs.apiPort,
    idleTimeout: 120,
    fetch: createMarketMakerHttpHandler({
      env,
      httpDrain,
      directRuntimeWs,
      runtimeIngressReceipts: ingressReceipts,
      currentRuntimeHeight: target => Math.max(0, Math.floor(Number(target?.state.height ?? 0))),
      getActiveEntityId: () => state.activeEntityId,
      buildAccountStatusDebug: (entityId, counterpartyEntityId, tokenIds) =>
        buildMarketMakerAccountStatusDebug(
          env,
          entityId,
          counterpartyEntityId,
          tokenIds,
          state.lastDirectInput,
          state.lastDirectInputError,
        ),
      buildInfoResponseJson: health.buildInfoResponse,
      readCachedInfoResponseJson: health.readInfoResponseJson,
      rebuildCachedInfoResponseJson: health.rebuildInfoResponse,
      buildHealthSnapshot: () => health.buildSnapshot({ includeCross: true }),
      readCachedHealthResponseJson: health.readHealthResponseJson,
      rebuildCachedHealthResponseJson: health.rebuildHealthResponse,
      stopRuntimeLoops: () => state.stopRuntimeLoops(),
    }),
    websocket: createMarketMakerWebSocketHandler(env, directRuntimeWs, handleRuntimeAdapterWsMessage),
  });
  state.tokenIdsByContext = await initializeMarketMakerContexts({
    env,
    jurisdiction: resolveJurisdictionConfig(resolvedArgs.rpcUrl),
    contexts: state.contexts,
    setStartupPhase: phase => {
      state.phase = phase;
    },
    setActiveEntityId: entityId => {
      state.activeEntityId = entityId;
    },
  });
  const primaryContext = state.contexts[0];
  if (!primaryContext) throw new Error('MARKET_MAKER_PRIMARY_CONTEXT_MISSING');
  state.phase = 'j-catchup';
  startJurisdictionWatchers(env);
  const watcherDrain = await drainJWatcherBacklog(env, async currentEnv => processRuntime(currentEnv));
  await ensurePendingNumberedRegistrationsResumed(env);
  state.externalIngressReady = true;
  nodeLog.info('startup.j_catchup_ready', {
    jurisdictions: watcherDrain.length,
    cursors: watcherDrain.map(status => `${status.chainId}:${status.committedCursor}/${status.targetBlock}`),
  });
  state.phase = 'start-p2p';
  const p2p = startP2P(env, {
    relayUrls: [resolvedArgs.relayUrl],
    wsUrl: directWsUrl,
    allowDirectClients: false,
    preferRelayForEntityInput: true,
    advertiseEntityIds: state.contexts.map(item => item.entityId),
    gossipPollMs: BOOTSTRAP_POLL_MS * 5 || 250,
  });
  if (!p2p) throw new Error('P2P_START_FAILED');
  return { server, httpDrain, primaryContext };
};

type MarketMakerQuoteLifecycle = {
  driveQuotes: (mode?: MarketMakerQuoteMode) => Promise<boolean>;
  markOffersReady: () => Promise<boolean>;
  refreshBootstrapPhase: (health: MarketMakerHealth | null) => void;
  progress: ReturnType<typeof createBootstrapProgressMonitor>;
  loops: ReturnType<typeof createMarketMakerMaintenanceLoops>;
  readModel: ReturnType<typeof createMarketMakerQuoteReadModel>;
};

const createMarketMakerQuoteLifecycle = (
  context: MarketMakerNodeContext,
  primaryContext: MarketMakerEntityContext,
): MarketMakerQuoteLifecycle => {
  const { env, state, health, emit } = context;
  let bootstrapSameCursor = 0;
  const readModel = createMarketMakerQuoteReadModel({
    env,
    contexts: () => state.contexts,
    tokenIdsByContext: () => state.tokenIdsByContext,
    health,
    bootstrapCross: () => ({
      started: state.bootstrapCrossStarted,
      producerAttempted: state.bootstrapCrossProducerAttempted,
    }),
    emit,
  });
  const driveBootstrapSameQuotes = createBootstrapSameQuoteDriver({
    env,
    buildJobs: readModel.buildSameJobs,
    emitProgress: readModel.emitSameProgress,
    getCursor: () => bootstrapSameCursor,
    setCursor: cursor => {
      bootstrapSameCursor = cursor;
    },
  });
  const quoteEngineState: MarketMakerQuoteEngineState = {
    inFlight: false,
    bootstrapCrossCursor: 0,
    steadyCrossCursor: 0,
    attemptedBootstrapIntentOrderIds: new Set(),
  };
  const quoteEngineDeps: MarketMakerQuoteEngineDeps = {
    env,
    contexts: () => state.contexts,
    tokenIdsByContext: () => state.tokenIdsByContext,
    health,
    readModel,
    isShuttingDown: () => state.shuttingDown,
    driveBootstrapSameQuotes,
    bootstrapCross: {
      isStarted: () => state.bootstrapCrossStarted,
      markStarted: currentHealth => {
        state.bootstrapCrossStarted = true;
        state.phase = 'bootstrap-cross';
        health.rebuildHealthResponse();
        emit('phase', {
          phase: state.phase,
          health: summarizeMarketMakerHealthForDebug(currentHealth),
        });
      },
      planJobCount: () => state.bootstrapCrossPlanJobCount,
      recordPlan: (expectedJobs, expectedRoutes) => {
        state.bootstrapCrossPlanJobCount = expectedJobs;
        readModel.invalidateCompletionHealth();
        emit('cross-plan', { expectedJobs, expectedRoutes });
      },
      markProducerAttempted: () => {
        state.bootstrapCrossProducerAttempted = true;
      },
    },
  };
  const driveQuotes = (mode: MarketMakerQuoteMode = 'steady'): Promise<boolean> =>
    driveMarketMakerQuotes(quoteEngineDeps, quoteEngineState, mode);
  const publish = (finalization: MarketMakerBootstrapFinalization): void => {
    state.bootstrapReadyHash = finalization.fingerprint.hash;
    state.bootstrapRuntimeStateHash = finalization.runtimeStateHash;
    state.bootstrapEntityStateHash = finalization.entityStateHash;
    state.bootstrapReadyAt = Date.now();
    state.phase = 'offers-ready';
    health.setCurrentHealth(finalization.health);
    health.rebuildHealthResponse();
  };
  const markOffersReady = createMarketMakerBootstrapFinalizer({
    env,
    contexts: () => state.contexts,
    tokenIdsByContext: () => state.tokenIdsByContext,
    health,
    buildSameQuoteJobs: readModel.buildSameJobs,
    allSameQuoteDepthReady: readModel.allSameDepthReady,
    isReady: () => state.phase === 'offers-ready',
    canCheckCompletion: readModel.canCheckCompletion,
    publish,
    emit,
    logReadyHash: fields => nodeLog.info('bootstrap.ready_hash', fields),
    logOffersReady: fields => nodeLog.info('offers.ready', fields),
    primaryContext,
    apiUrl,
  }).markReady;
  const refreshBootstrapPhase = (currentHealth: MarketMakerHealth | null): void => {
    if (readModel.isBootstrapDepthComplete(currentHealth)) return;
    const previousPhase = state.phase;
    if (state.bootstrapCrossStarted) {
      state.phase = 'bootstrap-cross';
    } else if (
      readModel.allSameDepthReady(readVisibleHubProfiles(env, true)) &&
      isMarketMakerSameDepthComplete(currentHealth)
    ) {
      state.bootstrapCrossStarted = true;
      state.phase = 'bootstrap-cross';
    } else {
      state.phase = 'bootstrap-same-chain';
    }
    if (state.phase === previousPhase) return;
    emit('phase', { phase: state.phase, health: summarizeMarketMakerHealthForDebug(currentHealth) });
    health.rebuildHealthResponse();
  };
  const progress = createBootstrapProgressMonitor({
    env,
    primaryContext,
    phase: () => state.phase,
    checkpoint: context.checkpoint,
    directInput: () => ({ lastSeen: state.lastDirectInput, lastError: state.lastDirectInputError }),
    emit,
  });
  const loops = createMarketMakerMaintenanceLoops({
    env,
    isShuttingDown: () => state.shuttingDown,
    phase: () => state.phase,
    health,
    driveQuotes,
    canCheckCompletion: readModel.canCheckCompletion,
    buildCompletionHealth: readModel.buildCompletionHealth,
    isBootstrapDepthComplete: readModel.isBootstrapDepthComplete,
    markReady: markOffersReady,
    emit,
  });
  state.stopRuntimeLoops = () => {
    state.shuttingDown = true;
    loops.stop();
  };
  return { driveQuotes, markOffersReady, refreshBootstrapPhase, progress, loops, readModel };
};

const startMarketMakerBootstrapWorker = (
  context: MarketMakerNodeContext,
  lifecycle: MarketMakerQuoteLifecycle,
): void => {
  const { env, state, health, emit } = context;
  void (async () => {
    await sleep(MARKET_MAKER_BOOTSTRAP_START_DELAY_MS);
    if (state.shuttingDown) return;
    state.phase = 'bootstrap-same-chain';
    health.publishBootstrap();
    emit('phase', { phase: state.phase });
    while (!state.shuttingDown) {
      const bootstrapHealth = await waitForBootstrapOffers({
        env,
        isShuttingDown: () => state.shuttingDown,
        health,
        progress: lifecycle.progress,
        refreshPhase: lifecycle.refreshBootstrapPhase,
        isDepthComplete: lifecycle.readModel.isBootstrapDepthComplete,
        canCheckCompletion: lifecycle.readModel.canCheckCompletion,
        buildCompletionHealth: lifecycle.readModel.buildCompletionHealth,
        driveQuotes: lifecycle.driveQuotes,
        emit,
      });
      if (!bootstrapHealth) break;
      if (await lifecycle.markOffersReady()) {
        lifecycle.loops.startQuotes();
        return;
      }
    }
    if (!state.shuttingDown) throw new Error('MARKET_MAKER_BOOTSTRAP_STOPPED_WITHOUT_READY');
  })().catch(lifecycle.loops.fail);
};

export const runMarketMakerNode = async (): Promise<void> => {
  activateMarketMakerProcessArgs();
  if (resolvedArgs.dbPath) process.env['XLN_DB_PATH'] = resolvedArgs.dbPath;

  const localSignerLabels = buildLocalMarketMakerSignerLabels();
  const env = await main(resolvedArgs.seed, {
    localSigners: localSignerLabels.map(label => ({ label })),
    trustedJurisdictionRpcBindings: resolveMeshJurisdictionRpcBindings(resolvedArgs.rpcUrl, resolveLocalApiUrl),
  });
  nodeLog.info('signer_keys.ready', { name: resolvedArgs.name, count: localSignerLabels.length });
  // Capture the persistence oracle before the runtime loop or jurisdiction
  // watchers can apply new, legitimate inputs. A post-startup raw Entity hash
  // is not a restore oracle: even an empty finalized J range advances the
  // certified anchor, Entity height, timestamp, and frame hash.
  const restoredEntityStateHash = env.state.eReplicas.size > 0 ? buildMarketMakerBootstrapEntityStateHash(env) : null;
  const context = createMarketMakerNodeContext(env, restoredEntityStateHash);
  const { state, health: healthController, emit: emitBootstrapDebugEvent } = context;
  registerRuntimeFrameCommitCallback(env, ({ height, runtimeInput }) => {
    context.ingressReceipts.observeRuntimeInput(height, runtimeInput);
  });
  configureMarketMakerRuntimeLogging(env);
  // Bootstrap the local state machine before exposing this runtime to remote
  // entity_input delivery. Persisted hub routes can send immediately when P2P
  // connects, so every advertised MM entity must already exist at that point.
  startRuntimeLoop(env, {
    tickDelayMs: MARKET_MAKER_RUNTIME_TICK_DELAY_MS,
    maxEntityInputsPerFrame: MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME,
    maxEntityTxsPerFrame: MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME,
    onFatal: async payload => {
      await reportManagedChildFatal({
        runtimeId: String(env.runtimeId || ''),
        ...payload,
      });
    },
  });
  nodeLog.info('startup phase', { phase: state.phase });
  emitBootstrapDebugEvent('startup', { phase: state.phase });
  const { server, httpDrain, primaryContext: primaryMmContext } = await startMarketMakerServices(context);

  const quoteLifecycle = createMarketMakerQuoteLifecycle(context, primaryMmContext);
  state.phase = 'runtime-ready';
  healthController.publish({ includeCross: false });
  quoteLifecycle.loops.startHealth();
  emitBootstrapDebugEvent('phase', { phase: state.phase });
  nodeLog.info('runtime.ready', {
    entityId: primaryMmContext.entityId,
    runtimeId: String(env.runtimeId || ''),
    api: apiUrl,
    relay: resolvedArgs.relayUrl,
  });
  startMarketMakerBootstrapWorker(context, quoteLifecycle);

  const shutdown = createMarketMakerShutdown({
    env,
    server,
    httpDrain,
    stopRuntimeLoops: state.stopRuntimeLoops,
  });
  installMarketMakerShutdownSignals(shutdown);
  await new Promise<void>(() => {});
};
