#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { drainJWatcherBacklog } from '../jadapter/backlog-drain';
import { createDirectRuntimeWsRoute } from '../networking/direct-runtime-bun';
import { requireDeliveryDelivered } from '../protocol/payments/delivery-result';
import { compareStableText, safeStringify } from '../protocol/serialization';
import { decodeRuntimeAdapterRequest } from '../radapter/codec';
import { resolveRuntimeAdapterRead } from '../radapter/resolve';
import {
  attachRuntimeAdapterTicker,
  closeInvalidRuntimeAdapterMessage,
  forgetRuntimeAdapterClient,
  handleRuntimeAdapterMessage,
} from '../radapter/server';
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
  registerEnvChangeCallback,
  registerRuntimeFrameCommitCallback,
  startJurisdictionWatchers,
  startP2P,
  startRuntimeLoop,
  submitCrossJurisdictionIntent,
  validateRuntimeInputAdmission,
} from '../runtime.ts';
import { getReliableOutputIdentity } from '../runtime/output-routing';
import { isLocalOperatorRequest, resolveSocketPeerAddress } from '../server/health-redaction';
import { createRuntimeIngressReceiptStore } from '../server/ingress-receipts';
import { requiresLocalNodeOperator } from '../server/node-http-access';
import { handleRuntimeInputStatus } from '../server/runtime-input-control';
import { computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';
import type { RuntimeState } from '../types';
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
  getAccountState,
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
  envFlagEnabled,
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
  env: RuntimeState;
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
    activeProcess: env.runtimeState?.processingPromise
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
  const restoredEntityStateHash = env.eReplicas.size > 0 ? buildMarketMakerBootstrapEntityStateHash(env) : null;
  const runtimeIngressReceipts = createRuntimeIngressReceiptStore();
  const currentRuntimeHeight = (targetEnv: RuntimeState | null): number =>
    Math.max(0, Math.floor(Number(targetEnv?.height ?? 0)));
  const runtimeInputStatusUrl = (id: string): string => `/api/control/runtime-input/${encodeURIComponent(id)}/status`;
  registerRuntimeFrameCommitCallback(env, ({ height, runtimeInput }) => {
    runtimeIngressReceipts.observeRuntimeInput(height, runtimeInput);
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
  let startupPhase = 'boot';
  let externalIngressReady = false;
  let activeMmEntityId: string | null = null;
  let mmContexts: MarketMakerEntityContext[] = [];
  let mmTokenIdsByContext: Map<string, number[]> = new Map();
  let cachedMarketMakerHealth: MarketMakerHealth | null = null;
  let cachedVisibleHubProfiles: HubProfile[] = [];
  let cachedAllVisibleHubProfiles: HubProfile[] = [];
  let cachedHealthResponseJson: string | null = null;
  let cachedInfoResponseJson: string | null = null;
  let bootstrapReadyHash: string | null = null;
  let bootstrapRuntimeStateHash: string | null = null;
  let bootstrapEntityStateHash: string | null = null;
  let bootstrapReadyAt: number | null = null;
  let bootstrapCrossStarted = false;
  let bootstrapCrossPlanJobCount: number | null = null;
  let bootstrapCrossProducerAttempted = false;
  let lastDirectEntityInput: DirectEntityInputDebug | null = null;
  let lastDirectEntityInputError: DirectEntityInputDebug | null = null;

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

  const summarizeReceiptLedger = (
    ledger: Map<string, import('../types').ReliableDeliveryReceipt> | undefined,
  ): Record<string, unknown>[] =>
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

  const buildBootstrapCausalCheckpoint = (): Record<string, unknown> => {
    const state = env.runtimeState;
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
      entities: mmContexts
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

  const emitBootstrapDebugEvent = (event: string, fields: Record<string, unknown> = {}): void => {
    emitMarketMakerBootstrapDebugEvent(event, {
      stage: startupPhase,
      entity: activeMmEntityId,
      runtimeId: String(env.runtimeId || ''),
      height: env.height,
      backlog: getMarketMakerRuntimeBacklogSnapshot(env, { includeQueuedEntityInputs: true }),
      ...fields,
    });
  };

  const buildMarketMakerHealthSnapshot = (
    options: {
      includeCross?: boolean;
      crossOverride?: MarketMakerHealth['cross'];
    } = {},
  ): MarketMakerHealth | null => {
    const primaryContext = mmContexts[0] ?? null;
    const activeEntityId = activeMmEntityId;
    if (!activeEntityId || !primaryContext) return null;
    const visibleHubs = readVisibleHubProfiles(env).filter(profile => sameJurisdiction(primaryContext, profile));
    const allVisibleHubs = readVisibleHubProfiles(env, true);
    cachedVisibleHubProfiles = visibleHubs;
    cachedAllVisibleHubProfiles = allVisibleHubs;
    const crossOverride = options.crossOverride;
    const includeCross = !crossOverride && options.includeCross !== false;
    const crossApplicable =
      mmContexts.length > 1 &&
      allVisibleHubs.some(
        profile =>
          mmContexts.some(context => sameJurisdiction(context, profile)) && !sameJurisdiction(primaryContext, profile),
      );
    return getMarketMakerHealth(
      env,
      primaryContext.entityId,
      visibleHubs.map(profile => profile.entityId),
      getMarketMakerTokenIds(mmTokenIdsByContext, primaryContext),
      includeCross
        ? {
            contexts: mmContexts,
            visibleHubs: allVisibleHubs,
            tokenIdsByContext: mmTokenIdsByContext,
          }
        : undefined,
      crossOverride ?? (includeCross ? undefined : buildDeferredMarketMakerCrossHealth(crossApplicable)),
    );
  };

  const buildInfoResponseJson = (includeCrossDebug = false): string => {
    const currentHealth = cachedMarketMakerHealth;
    return safeStringify({
      name: resolvedArgs.name,
      entityId: activeMmEntityId,
      runtimeId: env.runtimeId,
      apiUrl,
      relayUrl: resolvedArgs.relayUrl,
      directWsUrl,
      startupPhase,
      runtimeBacklog: getMarketMakerRuntimeBacklogSnapshot(env, {
        includeQueuedEntityInputs: includeCrossDebug,
      }),
      bootstrap: {
        readyHash: bootstrapReadyHash,
        runtimeStateHash: bootstrapRuntimeStateHash,
        entityStateHash: bootstrapEntityStateHash,
        restoredEntityStateHash,
        readyAt: bootstrapReadyAt,
      },
      currentHealth: currentHealth
        ? {
            ok: currentHealth.ok,
            depthComplete: isMarketMakerDepthComplete(currentHealth),
            sameDepthComplete: isMarketMakerSameDepthComplete(currentHealth),
            offers: currentHealth.hubs.map(hub => hub.offers),
            hubBlockers: currentHealth.hubs.map(hub => hub.blockers.length),
            crossOk: currentHealth.cross.ok,
            crossExpectedRoutes: currentHealth.cross.expectedRoutes,
            crossOffers: currentHealth.cross.routes.map(route => route.offers),
            crossBlockers: currentHealth.cross.routes.map(route => route.blockers.length),
          }
        : null,
      ...(includeCrossDebug
        ? {
            crossDebug: buildMarketMakerCrossDebugSummary(
              env,
              mmContexts,
              readVisibleHubProfiles(env, true),
              mmTokenIdsByContext,
            ),
          }
        : {}),
    });
  };

  const rebuildCachedInfoResponseJson = (): void => {
    cachedInfoResponseJson = buildInfoResponseJson(false);
  };

  const rebuildCachedHealthResponseJson = (): void => {
    const primaryContext = mmContexts[0] ?? null;
    const visibleHubs = cachedVisibleHubProfiles.filter(profile =>
      primaryContext ? sameJurisdiction(primaryContext, profile) : true,
    );
    const allVisibleHubs = cachedAllVisibleHubProfiles;
    const activeEntityId = activeMmEntityId;
    const rawMarketMakerHealth = activeEntityId
      ? (cachedMarketMakerHealth ?? {
          enabled: true,
          ok: false,
          entityId: activeEntityId,
          expectedOffersPerHub: 0,
          expectedOffersPerPair: 0,
          hubs: visibleHubs.map(profile => ({
            hubEntityId: profile.entityId,
            offers: 0,
            ready: false,
            blockers: [],
            pairs: [],
          })),
          cross: {
            applicable: allVisibleHubs.length > 0 && mmContexts.length > 1,
            ok: false,
            expectedRoutes: 0,
            expectedOffersPerRoute: 0,
            expectedOffersPerPair: 0,
            routes: [],
          },
        })
      : {
          enabled: true,
          ok: false,
          entityId: null,
          expectedOffersPerHub: 0,
          expectedOffersPerPair: 0,
          hubs: [],
          cross: {
            applicable: false,
            ok: false,
            expectedRoutes: 0,
            expectedOffersPerRoute: 0,
            expectedOffersPerPair: 0,
            routes: [],
          },
        };
    const marketMakerHealth =
      startupPhase === 'offers-ready' ? rawMarketMakerHealth : { ...rawMarketMakerHealth, ok: false };
    const runtimeHalted = env.runtimeState?.halted === true;
    const gossipReady = visibleHubs.length === resolvedArgs.meshHubNames.length;
    const readiness = deriveMarketMakerChildReadiness({
      runtimeHalted,
      startupPhase,
      gossipReady,
      marketMakerReady: marketMakerHealth.ok === true,
    });
    cachedHealthResponseJson = safeStringify({
      ok: readiness.ready,
      live: readiness.live,
      ready: readiness.ready,
      name: resolvedArgs.name,
      height: Math.max(0, Math.floor(Number(env.height || 0))),
      entityId: activeEntityId,
      runtimeId: String(env.runtimeId || '') || null,
      relayUrl: resolvedArgs.relayUrl,
      directWsUrl,
      apiUrl,
      startupPhase,
      runtime: {
        halted: runtimeHalted,
        lifecyclePhase: env.runtimeState?.lifecyclePhase ?? null,
        fatalDebugPayload: env.runtimeState?.fatalDebugPayload ?? null,
      },
      p2p: {
        directPeers: getP2PState(env).directPeers || [],
        directInput: {
          lastSeen: lastDirectEntityInput,
          lastError: lastDirectEntityInputError,
        },
      },
      gossip: {
        visibleHubNames: visibleHubs.map(profile => profile.name),
        visibleHubIds: visibleHubs.map(profile => profile.entityId),
        ready: gossipReady,
      },
      bootstrap: {
        readyHash: bootstrapReadyHash,
        runtimeStateHash: bootstrapRuntimeStateHash,
        entityStateHash: bootstrapEntityStateHash,
        restoredEntityStateHash,
        readyAt: bootstrapReadyAt,
      },
      marketMaker: {
        ...marketMakerHealth,
        quiescence: summarizeRuntimeQuiescence(env),
      },
    });
    rebuildCachedInfoResponseJson();
  };

  const publishMarketMakerHealthSnapshot = (
    options: {
      includeCross?: boolean;
      crossOverride?: MarketMakerHealth['cross'];
    } = {},
  ): MarketMakerHealth | null => {
    const health = buildMarketMakerHealthSnapshot(options);
    if (health) cachedMarketMakerHealth = health;
    rebuildCachedHealthResponseJson();
    return health;
  };

  const buildBootstrapCrossHealthOverride = (): MarketMakerHealth['cross'] => {
    const visibleHubs = readVisibleHubProfiles(env, true);
    const plan = buildMarketMakerCrossPlanSummary(mmContexts, visibleHubs, mmTokenIdsByContext);
    return buildPlannedMarketMakerCrossHealth(plan);
  };

  const publishBootstrapHealthSnapshot = (): MarketMakerHealth | null =>
    publishMarketMakerHealthSnapshot(
      bootstrapCrossStarted
        ? { includeCross: false, crossOverride: buildBootstrapCrossHealthOverride() }
        : { includeCross: false },
    );

  const publishReadyHealthSnapshot = (): MarketMakerHealth | null => {
    const currentHealth = cachedMarketMakerHealth;
    if (!currentHealth || !isMarketMakerCrossDepthComplete(currentHealth)) {
      return publishMarketMakerHealthSnapshot({ includeCross: true });
    }
    return publishMarketMakerHealthSnapshot({
      includeCross: false,
      crossOverride: currentHealth.cross,
    });
  };

  const buildAccountStatusDebug = (
    entityId: string,
    counterpartyEntityId: string,
    tokenIds: number[],
  ): Record<string, unknown> => {
    const account = getAccountState(env, entityId, counterpartyEntityId);
    const replica = getEntityReplicaById(env, entityId);
    const summarizeRuntimeInputs = (
      inputs: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> | undefined,
    ) =>
      (inputs || []).slice(-10).map(input => ({
        entityId: String(input.entityId || '').slice(-8),
        txs: (input.entityTxs || []).map(tx => String(tx?.type || '')),
      }));
    return {
      success: true,
      entityId,
      counterpartyEntityId,
      hasAccount: Boolean(account),
      ready: Boolean(account && isAccountConsensusReady(account)),
      currentHeight: Number(account?.currentHeight ?? 0),
      pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
      pendingFrameTxs: (account?.pendingFrame?.accountTxs || []).map(tx => String(tx?.type || '')),
      mempool: Number(account?.mempool?.length ?? 0),
      mempoolTxs: (account?.mempool || []).map(tx => String(tx?.type || '')),
      swapOffers: Number(account?.swapOffers?.size || 0),
      tokens: tokenIds.map(tokenId => ({
        tokenId,
        hasDelta: Boolean(account?.deltas?.has(tokenId)),
        outCapacity: account ? getEntityOutCapacity(account, entityId, tokenId).toString() : '0',
        delta: serializeAccountDelta(account?.deltas?.get(tokenId)),
      })),
      runtime: {
        height: Number(env.height ?? 0),
        timestamp: Number(env.timestamp ?? 0),
        halted: Boolean(env.runtimeState?.halted),
        fatalDebugPayload: env.runtimeState?.fatalDebugPayload ?? null,
        loopActive: Boolean(env.runtimeState?.loopActive),
        backlog: getMarketMakerRuntimeBacklogSnapshot(env, { includeQueuedEntityInputs: true }),
        runtimeMempool: summarizeRuntimeInputs(env.runtimeMempool?.entityInputs),
      },
      replica: replica
        ? {
            key: `${String(replica.entityId || '').toLowerCase()}:${String(replica.signerId || '').toLowerCase()}`,
            entityId: replica.entityId,
            signerId: replica.signerId,
            mempool: (replica.mempool || []).map(tx => String(tx?.type || '')),
            proposalTxs: (replica.proposal?.txs || []).map(tx => String(tx?.type || '')),
            lockedFrameTxs: (replica.lockedFrame?.txs || []).map(tx => String(tx?.type || '')),
          }
        : null,
      directInput: {
        lastSeen: lastDirectEntityInput,
        lastError: lastDirectEntityInputError,
      },
    };
  };

  const jurisdiction = resolveJurisdictionConfig(resolvedArgs.rpcUrl);
  nodeLog.info('startup phase', { phase: startupPhase });
  emitBootstrapDebugEvent('startup', { phase: startupPhase });

  const directRuntimeWs = createDirectRuntimeWsRoute({
    runtimeId: String(env.runtimeId || ''),
    runtimeSeed: resolvedArgs.seed,
    onRecoveryBundleRequest: async (_from, lookupKey) =>
      resolveRuntimeAdapterRead({ env }, `recovery/bundles/${encodeURIComponent(lookupKey)}`),
    onEntityInputs: async (from, envelope, ingressTimestamp) => {
      if (!externalIngressReady) throw new Error('RUNTIME_STARTUP_J_CATCHUP_PENDING');
      const debugEntry: DirectEntityInputDebug = {
        at: Date.now(),
        fromRuntimeId: String(from || ''),
        entityIds: envelope.entityInputs.map(input => String(input.entityId || '')),
        signerIds: envelope.entityInputs.map(input => String(input.signerId || '')),
        txTypes: envelope.entityInputs.flatMap(input => (input.entityTxs || []).map(tx => String(tx?.type || ''))),
      };
      lastDirectEntityInput = debugEntry;
      try {
        const inbound = handleInboundP2PEntityInputs(env, from, envelope, ingressTimestamp);
        for (const receipt of inbound.receipts) {
          requireDeliveryDelivered(
            directRuntimeWs.sendReliableReceiptDelivery(from, receipt),
            delivery => `DIRECT_RELIABLE_RECEIPT_NOT_DELIVERED:${delivery.code}`,
          );
        }
      } catch (error) {
        lastDirectEntityInputError = {
          ...debugEntry,
          error: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
    },
    onReliableReceipt: (from, receipt) => {
      if (!externalIngressReady) throw new Error('RUNTIME_STARTUP_J_CATCHUP_PENDING');
      handleInboundReliableReceipt(env, from, receipt);
    },
  });
  env.runtimeState = env.runtimeState ?? {};
  // Keep Entity inputs and reliable receipts on the same authenticated direct
  // websocket when available. output-routing retains reliable inputs until a
  // durable receipt and falls back to P2P if this direct send is unavailable.
  env.runtimeState.directEntityInputsDispatch = (targetRuntimeId, envelope, ingressTimestamp) =>
    directRuntimeWs.sendEntityInputsDelivery(targetRuntimeId, envelope, ingressTimestamp);
  env.runtimeState.directReliableReceiptDispatch = (targetRuntimeId, receipt) =>
    directRuntimeWs.sendReliableReceiptDelivery(targetRuntimeId, receipt);
  const handleRadapterWsMessage = (ws: MarketMakerServerSocket, raw: string | Buffer | ArrayBuffer): void => {
    let msg: import('../radapter/types').RuntimeAdapterRequest;
    try {
      msg = decodeRuntimeAdapterRequest(raw);
    } catch (error) {
      closeInvalidRuntimeAdapterMessage(ws, error);
      return;
    }
    Promise.resolve(
      handleRuntimeAdapterMessage(ws, msg, env, {
        enqueueRuntimeInput,
        submitCrossJurisdictionIntent: async (targetEnv, route) => {
          await submitCrossJurisdictionIntent(targetEnv, route);
        },
        validateRuntimeInputAdmission,
        registerReceipt: receipt => runtimeIngressReceipts.register(receipt),
        readReceipt: id => runtimeIngressReceipts.get(id),
        buildRuntimeInputStatusUrl: runtimeInputStatusUrl,
        isMutatingIngressReady: () => externalIngressReady,
        readHead: targetEnv => readPersistedStorageHead(targetEnv),
        readFrame: (targetEnv, height) => readPersistedStorageFrameRecord(targetEnv, height),
        listCheckpoints: targetEnv => listPersistedCheckpointHeights(targetEnv),
        loadEntityState: (targetEnv, entityId, height) => loadEntityStateFromStorageDb(targetEnv, entityId, height),
        loadEntityAccountDoc: (targetEnv, entityId, counterpartyId, height) =>
          loadEntityAccountDocFromStorageDb(targetEnv, entityId, counterpartyId, height),
        loadEntityViewPage: (targetEnv, entityId, height, query) =>
          loadEntityViewPageFromStorageDb(targetEnv, entityId, height, query),
        listEntityIdsAtHeight: (targetEnv, height) => listPersistedEntityIdsAtHeight(targetEnv, height),
        readActivityPage: (targetEnv, opts) => readPersistedRuntimeActivityPage(targetEnv, opts),
      }),
    ).catch(error => {
      ws.send(safeStringify({ type: 'error', error: `Runtime adapter failed: ${(error as Error).message}` }));
    });
  };

  // Bun exposes fetch handlers as soon as Bun.serve returns. Teardown may
  // therefore arrive while jurisdiction/bootstrap initialization below is
  // still awaiting. Keep every lifecycle handle used by control routes
  // initialized before the server becomes reachable.
  let shuttingDown = false;
  let loop: ReturnType<typeof setInterval> | null = null;
  let healthRefreshLoop: ReturnType<typeof setInterval> | null = null;
  const httpDrain = createHttpDrainTracker();
  const server = Bun.serve({
    hostname: resolvedArgs.apiHost,
    port: resolvedArgs.apiPort,
    idleTimeout: 120,
    async fetch(request, serverRef) {
      const releaseHttp = httpDrain.begin();
      try {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const operatorAuthorized = isLocalOperatorRequest(request, resolveSocketPeerAddress(serverRef, request));

        if (request.headers.get('upgrade') === 'websocket' && pathname === '/rpc') {
          const upgraded = serverRef.upgrade(request, { data: { type: 'rpc' } });
          if (upgraded) return;
          return new Response('WebSocket upgrade failed', { status: 400 });
        }

        const directUpgrade = directRuntimeWs.maybeUpgrade(request, serverRef);
        if (directUpgrade.handled) return directUpgrade.response;

        if (requiresLocalNodeOperator(url) && !operatorAuthorized) {
          return new Response(safeStringify({ error: 'Operator access required' }), {
            status: 403,
            headers: JSON_HEADERS,
          });
        }

        if (pathname === '/api/account/status' && request.method === 'GET') {
          const entityId = String(
            url.searchParams.get('entityId') || url.searchParams.get('mmEntityId') || activeMmEntityId || '',
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
          return new Response(safeStringify(buildAccountStatusDebug(entityId, counterpartyEntityId, tokenIds)), {
            headers: JSON_HEADERS,
          });
        }

        if (pathname === '/api/info') {
          const includeCrossDebug =
            url.searchParams.get('crossDebug') === '1' || url.searchParams.get('debug') === 'cross';
          if (includeCrossDebug) {
            return new Response(buildInfoResponseJson(true), { headers: JSON_HEADERS });
          }
          if (!cachedInfoResponseJson) rebuildCachedInfoResponseJson();
          return new Response(cachedInfoResponseJson ?? '{}', { headers: JSON_HEADERS });
        }

        if (pathname === '/api/health/full' || (pathname === '/api/health' && url.searchParams.get('full') === '1')) {
          const health = buildMarketMakerHealthSnapshot({ includeCross: true });
          return new Response(health ? safeStringify(health) : '{}', { headers: JSON_HEADERS });
        }

        if (pathname === '/api/health') {
          if (!cachedHealthResponseJson) rebuildCachedHealthResponseJson();
          return new Response(cachedHealthResponseJson ?? '{}', { headers: JSON_HEADERS });
        }

        const runtimeInputStatusMatch = pathname.match(/^\/api\/control\/runtime-input\/([^/]+)\/status$/);
        if (runtimeInputStatusMatch && request.method === 'GET') {
          const receiptId = decodeURIComponent(runtimeInputStatusMatch[1] || '');
          return handleRuntimeInputStatus(receiptId, JSON_HEADERS, env, {
            receipts: runtimeIngressReceipts,
            getCurrentRuntimeHeight: currentRuntimeHeight,
          });
        }

        if (pathname === '/api/control/p2p/stop' && request.method === 'POST') {
          shuttingDown = true;
          if (loop) clearInterval(loop);
          if (healthRefreshLoop) clearInterval(healthRefreshLoop);
          try {
            const result = await quiesceNodeRuntime(env, {
              workTimeoutMs: 10_000,
              loopTimeoutMs: 5_000,
            });
            return new Response(safeStringify({ ok: true, ...result }), { headers: JSON_HEADERS });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${resolvedArgs.name}] p2p stop failed: ${message}`);
            return new Response(safeStringify({ ok: false, error: message }), {
              status: 503,
              headers: JSON_HEADERS,
            });
          }
        }

        if (pathname === '/api/control/runtime/quiesce' && request.method === 'POST') {
          shuttingDown = true;
          if (loop) clearInterval(loop);
          if (healthRefreshLoop) clearInterval(healthRefreshLoop);
          try {
            const result = await quiesceNodeRuntime(env, {
              workTimeoutMs: 20_000,
              loopTimeoutMs: 5_000,
              quietMs: 750,
            });
            return new Response(safeStringify({ ok: true, ...result }), { headers: JSON_HEADERS });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${resolvedArgs.name}] runtime quiesce failed: ${message}`);
            return new Response(safeStringify({ ok: false, error: message }), {
              status: 503,
              headers: JSON_HEADERS,
            });
          }
        }

        return new Response(safeStringify({ error: 'Not found' }), {
          status: 404,
          headers: JSON_HEADERS,
        });
      } finally {
        releaseHttp();
      }
    },
    websocket: {
      open(ws: MarketMakerServerSocket) {
        if (ws.data?.type === 'rpc') {
          attachRuntimeAdapterTicker(env, registerEnvChangeCallback);
          return;
        }
        directRuntimeWs.websocket.open(ws);
      },
      message(ws: MarketMakerServerSocket, raw: string | Buffer | ArrayBuffer) {
        if (ws.data?.type === 'rpc') {
          handleRadapterWsMessage(ws, raw);
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
    },
  });

  startupPhase = 'import-jurisdiction';
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
  startupPhase = 'token-catalog';
  const tokenCatalog = await waitForTokenCatalog(jadapter);
  startupPhase = 'import-replica';
  const primaryMmContext = await createMarketMakerEntityContext(
    env,
    jurisdiction,
    resolvedArgs.signerLabel,
    resolvedArgs.name,
    { x: 0, y: -40, z: 120, jurisdiction: jurisdiction.name },
  );
  activeMmEntityId = primaryMmContext.entityId;
  mmContexts = [primaryMmContext];

  const secondaryJurisdictions = resolveSecondaryJurisdictions(jurisdiction.rpc);
  for (const [index, secondary] of secondaryJurisdictions.entries()) {
    const secondaryName = String(secondary.name || `Secondary ${index + 1}`).trim();
    const secondaryDisplayName = formatJurisdictionDisplayName(secondaryName) || secondaryName;
    if (!secondaryName) continue;
    startupPhase = `import-jurisdiction-${secondaryName}`;
    await importJurisdictionIfNeeded(env, secondary);
    startupPhase = `import-replica-${secondaryName}`;
    const siblingContext = await createMarketMakerEntityContext(
      env,
      secondary,
      `${resolvedArgs.signerLabel}:${secondaryName}`,
      `${resolvedArgs.name} ${secondaryDisplayName}`,
      { x: 160 + index * 80, y: -40, z: 120, jurisdiction: secondaryName },
    );
    mmContexts.push(siblingContext);
    nodeLog.debug('sibling_mm.ready', {
      jurisdiction: secondaryName,
      entityId: siblingContext.entityId,
    });
  }
  mmTokenIdsByContext = buildMarketMakerTokenIdsByContext(tokenCatalog, mmContexts);
  nodeLog.debug('token_universe.ready', {
    jurisdictions: mmContexts.map(context => ({
      jurisdiction: formatJurisdictionDisplayName(context.jurisdictionName) || context.jurisdictionName,
      tokenIds: getMarketMakerTokenIds(mmTokenIdsByContext, context),
    })),
  });

  startupPhase = 'j-catchup';
  startJurisdictionWatchers(env);
  const watcherDrain = await drainJWatcherBacklog(env, async currentEnv => processRuntime(currentEnv));
  externalIngressReady = true;
  nodeLog.info('startup.j_catchup_ready', {
    jurisdictions: watcherDrain.length,
    cursors: watcherDrain.map(status => `${status.chainId}:${status.committedCursor}/${status.targetBlock}`),
  });

  startupPhase = 'start-p2p';
  const p2p = startP2P(env, {
    relayUrls: [resolvedArgs.relayUrl],
    wsUrl: directWsUrl,
    allowDirectClients: false,
    preferRelayForEntityInput: true,
    advertiseEntityIds: mmContexts.map(context => context.entityId),
    gossipPollMs: BOOTSTRAP_POLL_MS * 5 || 250,
  });
  if (!p2p) throw new Error('P2P_START_FAILED');

  let loopInFlight = false;
  let bootstrapSameCursor = 0;
  let bootstrapCrossCursor = 0;
  let steadyCrossCursor = 0;
  const attemptedBootstrapIntentOrderIds = new Set<string>();
  let lastSameQuoteProgressLogAt = 0;
  let lastSameQuoteProgressKey = '';
  const hubsForContext = (visibleHubs: HubProfile[], context: MarketMakerEntityContext): HubProfile[] =>
    visibleHubs
      .filter(profile => sameJurisdiction(context, profile))
      .sort(
        (left, right) =>
          compareStableText(left.jurisdictionRef, right.jurisdictionRef) ||
          compareStableText(left.entityId, right.entityId),
      );
  const buildSameQuoteJobs = (visibleHubs: HubProfile[]): SameQuoteJob[] => {
    const jobs: SameQuoteJob[] = [];
    for (const context of mmContexts) {
      const tokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, context);
      for (const hub of hubsForContext(visibleHubs, context)) {
        jobs.push({ context, hub, tokenIds });
      }
    }
    return jobs.sort(
      (left, right) =>
        compareStableText(left.context.jurisdictionRef, right.context.jurisdictionRef) ||
        compareStableText(left.context.entityId, right.context.entityId) ||
        compareStableText(left.hub.entityId, right.hub.entityId),
    );
  };
  const isAllSameQuoteDepthReady = (visibleHubs: HubProfile[]): boolean => {
    const sameQuoteJobs = buildSameQuoteJobs(visibleHubs);
    return sameQuoteJobs.length > 0 && sameQuoteJobs.every(job => isSameQuoteJobDepthReady(env, job));
  };
  const hasBootstrapCrossAccountBacklog = (visibleHubs: HubProfile[]): boolean => {
    for (const sourceContext of mmContexts) {
      const sourceHubs = hubsForContext(visibleHubs, sourceContext);
      for (const sourceHub of sourceHubs) {
        if (hasMarketMakerAccountBacklog(env, sourceContext.entityId, sourceHub.entityId)) return true;
      }
      for (const targetContext of mmContexts) {
        if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext))
          continue;
        const targetHubs = hubsForContext(visibleHubs, targetContext);
        for (const targetHub of targetHubs) {
          if (hasMarketMakerAccountBacklog(env, targetContext.entityId, targetHub.entityId)) return true;
        }
      }
    }
    return false;
  };
  const describeSameQuoteJobProgress = (job: SameQuoteJob): Record<string, unknown> => {
    const account = getAccountState(env, job.context.entityId, job.hub.entityId);
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
  const emitSameQuoteProgress = (reason: string, jobs: SameQuoteJob[], selectedJob?: SameQuoteJob): void => {
    if (!MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL) return;
    const now = Date.now();
    if (now - lastSameQuoteProgressLogAt < 2_000) return;
    const incomplete = jobs.filter(job => !isSameQuoteJobDepthReady(env, job));
    const key = incomplete
      .map(
        job =>
          `${job.context.entityId}:${job.hub.entityId}:${countCommittedMarketMakerOffersForHub(env, job.context.entityId, job.hub.entityId)}`,
      )
      .join('|');
    if (key === lastSameQuoteProgressKey) return;
    lastSameQuoteProgressKey = key;
    lastSameQuoteProgressLogAt = now;
    emitBootstrapDebugEvent('same-quote-progress', {
      reason,
      selected: selectedJob ? describeSameQuoteJobProgress(selectedJob) : null,
      incomplete: incomplete.slice(0, 8).map(describeSameQuoteJobProgress),
      incompleteCount: incomplete.length,
    });
  };
  const isBootstrapDepthComplete = (health: MarketMakerHealth | null): boolean =>
    isAllSameQuoteDepthReady(readVisibleHubProfiles(env, true)) && isMarketMakerDepthComplete(health);
  let bootstrapCompletionHealthHeight = -1;
  let bootstrapCompletionHealth: MarketMakerHealth | null = null;
  const buildBootstrapCompletionHealth = (): MarketMakerHealth | null => {
    if (bootstrapCompletionHealthHeight === env.height) return bootstrapCompletionHealth;
    bootstrapCompletionHealthHeight = env.height;
    bootstrapCompletionHealth = buildMarketMakerHealthSnapshot({ includeCross: true });
    if (bootstrapCompletionHealth) {
      cachedMarketMakerHealth = bootstrapCompletionHealth;
      rebuildCachedHealthResponseJson();
    }
    return bootstrapCompletionHealth;
  };
  const hasExpectedBootstrapCrossRoutes = (visibleHubs: HubProfile[]): boolean =>
    buildMarketMakerCrossPlanSummary(mmContexts, visibleHubs, mmTokenIdsByContext).expectedRoutes > 0;
  const canCheckBootstrapCompletion = (): boolean => {
    if (!bootstrapCrossStarted || hasMarketMakerRuntimeBacklog(env)) return false;
    const visibleHubs = readVisibleHubProfiles(env, true);
    const hasCrossPlan = hasExpectedBootstrapCrossRoutes(visibleHubs);
    if (hasCrossPlan && !bootstrapCrossProducerAttempted) return false;
    return !hasCrossPlan || !hasBootstrapCrossAccountBacklog(visibleHubs);
  };
  const driveBootstrapSameQuotes = async (
    visibleHubs: HubProfile[],
    connectivityBudget: MarketMakerConnectivityBudget,
    shouldContinue: () => boolean,
  ): Promise<boolean | null> => {
    const sameQuoteJobs = buildSameQuoteJobs(visibleHubs);
    emitSameQuoteProgress('scan', sameQuoteJobs);
    const orderedIncompleteJobs: SameQuoteJob[] = [];
    for (let offset = 0; offset < sameQuoteJobs.length; offset += 1) {
      const selectedIndex = (bootstrapSameCursor + offset) % sameQuoteJobs.length;
      const job = sameQuoteJobs[selectedIndex];
      if (job && !isSameQuoteJobDepthReady(env, job)) orderedIncompleteJobs.push(job);
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
    const groupedEntries = Array.from(jobsByContext.values()).sort(
      (left, right) =>
        compareStableText(left.context.jurisdictionRef, right.context.jurisdictionRef) ||
        compareStableText(left.context.entityId, right.context.entityId),
    );
    const runnableHubEntityIdsFor = (entry: {
      context: MarketMakerEntityContext;
      jobs: SameQuoteJob[];
    }): string[] =>
      entry.jobs
        .map(job => job.hub.entityId)
        .filter(hubEntityId => !hasMarketMakerAccountBacklog(env, entry.context.entityId, hubEntityId))
        .sort(compareStableText);

    let enqueuedConnectivity = false;
    for (const entry of groupedEntries) {
      const runnableHubEntityIds = runnableHubEntityIdsFor(entry);
      if (runnableHubEntityIds.length === 0) continue;
      const selectedJob =
        entry.jobs.find(job => runnableHubEntityIds.includes(job.hub.entityId)) ?? entry.jobs[0]!;
      bootstrapSameCursor = sameQuoteJobs.indexOf(selectedJob);
      emitSameQuoteProgress('selected', sameQuoteJobs, selectedJob);
      await yieldMarketMakerApi();
      if (!shouldContinue()) return false;
      if (
        await ensureMarketMakerHubConnectivity(
          env,
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
      const selectedJob =
        entry.jobs.find(job => runnableHubEntityIds.includes(job.hub.entityId)) ?? entry.jobs[0]!;
      bootstrapSameCursor = sameQuoteJobs.indexOf(selectedJob);
      emitSameQuoteProgress('selected', sameQuoteJobs, selectedJob);
      await yieldMarketMakerApi();
      if (!shouldContinue()) return false;
      if (
        await maintainMarketMakerQuotes(
          env,
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
      orderedIncompleteJobs.every(job =>
        hasMarketMakerAccountBacklog(env, job.context.entityId, job.hub.entityId),
      )
    )
      await yieldMarketMakerApi();
    return false;
  };
  const maintainSameContextQuotes = async (
    mode: MarketMakerQuoteMode,
    visibleHubs: HubProfile[],
    connectivityBudget: MarketMakerConnectivityBudget,
    shouldContinue: () => boolean,
    context: MarketMakerEntityContext,
  ): Promise<boolean> => {
    await yieldMarketMakerApi();
    if (!shouldContinue()) return false;
    const hubEntityIds = hubsForContext(visibleHubs, context)
      .filter(profile => !hasMarketMakerAccountBacklog(env, context.entityId, profile.entityId))
      .map(profile => profile.entityId);
    if (hubEntityIds.length === 0) return false;
    const contextTokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, context);
    const enqueued = await maintainMarketMakerQuotes(
      env,
      context.entityId,
      context.signerId,
      hubEntityIds,
      contextTokenIds,
      mode === 'bootstrap'
        ? MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK
        : MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK,
      mode === 'bootstrap' ? MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK : MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK,
      connectivityBudget,
      shouldContinue,
    );
    await yieldMarketMakerApi();
    return enqueued;
  };
  const buildCrossQuoteJobs = async (
    mode: MarketMakerQuoteMode,
    visibleHubs: HubProfile[],
    shouldContinue: () => boolean,
  ): Promise<CrossQuoteJob[] | null> => {
    const jobs: CrossQuoteJob[] = [];
    for (const sourceContext of mmContexts) {
      await yieldMarketMakerApi();
      if (!shouldContinue()) return null;
      const sourceHubs = hubsForContext(visibleHubs, sourceContext).filter(
        profile =>
          mode === 'bootstrap' ||
          !hasMarketMakerAccountBacklog(env, sourceContext.entityId, profile.entityId),
      );
      if (sourceHubs.length === 0) continue;
      const sourceTokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, sourceContext);
      for (const targetContext of mmContexts) {
        await yieldMarketMakerApi();
        if (!shouldContinue()) return null;
        if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext))
          continue;
        const targetHubs = hubsForContext(visibleHubs, targetContext).filter(
          profile =>
            mode === 'bootstrap' ||
            !hasMarketMakerAccountBacklog(env, targetContext.entityId, profile.entityId),
        );
        if (targetHubs.length === 0) continue;
        jobs.push({
          sourceContext,
          targetContext,
          sourceHubs,
          targetHubs,
          sourceTokenIds,
          targetTokenIds: getMarketMakerTokenIds(mmTokenIdsByContext, targetContext),
        });
      }
    }
    return jobs;
  };
  const selectCrossQuoteJobs = (
    mode: MarketMakerQuoteMode,
    jobs: CrossQuoteJob[],
  ): Array<{ index: number; job: CrossQuoteJob }> => {
    if (jobs.length === 0) return [];
    const cursor = mode === 'bootstrap' ? bootstrapCrossCursor : steadyCrossCursor;
    const jobCount =
      mode === 'bootstrap' ? jobs.length : Math.min(MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK, jobs.length);
    const selected: Array<{ index: number; job: CrossQuoteJob }> = [];
    let nextCursor = cursor;
    for (let offset = 0; offset < jobCount; offset += 1) {
      const index = (cursor + offset) % jobs.length;
      const job = jobs[index];
      if (!job) continue;
      selected.push({ index, job });
      nextCursor = (index + 1) % jobs.length;
    }
    if (mode === 'steady') steadyCrossCursor = nextCursor;
    return selected;
  };
  const driveQuotes = async (mode: MarketMakerQuoteMode = 'steady'): Promise<boolean> => {
    if (shuttingDown) return false;
    if (loopInFlight) return false;
    loopInFlight = true;
    try {
      if (hasMarketMakerRuntimeBacklog(env)) return false;
      const connectivityBudget: MarketMakerConnectivityBudget = {
        remainingTxs:
          mode === 'bootstrap'
            ? MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK
            : MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK,
      };
      const visibleHubs = readVisibleHubProfiles(env, true);
      const shouldContinue = () => !shuttingDown;
      if (visibleHubs.length === 0) return false;
      if (!shouldContinue()) return false;
      if (!areMarketMakerHubTransportsReady(getP2PState(env), visibleHubs)) return false;
      await yieldMarketMakerApi();
      const healthBeforeQuotes = mode === 'bootstrap' ? buildMarketMakerHealthSnapshot({ includeCross: false }) : null;
      const primarySameDepthReady = isMarketMakerSameDepthComplete(healthBeforeQuotes);

      if (mode === 'bootstrap') {
        const sameQuoteResult = await driveBootstrapSameQuotes(visibleHubs, connectivityBudget, shouldContinue);
        if (sameQuoteResult !== null) return sameQuoteResult;
      }

      if (mode !== 'bootstrap') {
        for (const context of mmContexts) {
          if (await maintainSameContextQuotes(mode, visibleHubs, connectivityBudget, shouldContinue, context))
            return true;
          if (!shouldContinue()) return false;
        }
      }
      if (mode === 'bootstrap') {
        const sameDepthReady = isAllSameQuoteDepthReady(visibleHubs);
        const sameSettledDepthReady = primarySameDepthReady && sameDepthReady;
        if (!sameSettledDepthReady) return false;
        if (!bootstrapCrossStarted) {
          bootstrapCrossStarted = true;
          startupPhase = 'bootstrap-cross';
          rebuildCachedHealthResponseJson();
          emitBootstrapDebugEvent('phase', {
            phase: startupPhase,
            health: summarizeMarketMakerHealthForDebug(healthBeforeQuotes),
          });
          await yieldMarketMakerApi();
        }
        if (hasBootstrapCrossAccountBacklog(visibleHubs)) {
          await yieldMarketMakerApi();
          return false;
        }
      }

      const crossQuoteJobs = await buildCrossQuoteJobs(mode, visibleHubs, shouldContinue);
      if (!crossQuoteJobs) return false;
      if (mode === 'bootstrap' && bootstrapCrossStarted) {
        const crossPlan = buildMarketMakerCrossPlanSummary(mmContexts, visibleHubs, mmTokenIdsByContext);
        if (bootstrapCrossPlanJobCount !== crossPlan.expectedJobs) {
          bootstrapCrossPlanJobCount = crossPlan.expectedJobs;
          bootstrapCompletionHealthHeight = -1;
          emitBootstrapDebugEvent('cross-plan', {
            expectedJobs: crossPlan.expectedJobs,
            expectedRoutes: crossPlan.expectedRoutes,
          });
        }
        if (crossQuoteJobs.length > 0) bootstrapCrossProducerAttempted = true;
      }
      const selectedCrossQuoteJobs = selectCrossQuoteJobs(mode, crossQuoteJobs);
      const advanceCrossCursorAfterEnqueue = (index: number): void => {
        const nextCursor = (index + 1) % crossQuoteJobs.length;
        if (mode === 'bootstrap') {
          bootstrapCrossCursor = nextCursor;
        }
        if (mode === 'steady') steadyCrossCursor = nextCursor;
      };
      for (const entry of selectedCrossQuoteJobs) {
        const job = entry.job;
        await yieldMarketMakerApi();
        if (!shouldContinue()) return false;
        if (
          await maintainMarketMakerCrossQuotes(
            env,
            job.sourceContext,
            job.targetContext,
            job.sourceHubs,
            job.targetHubs,
            job.sourceTokenIds,
            job.targetTokenIds,
            mode === 'bootstrap'
              ? MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK
              : Math.max(2, Math.floor(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK / 2)),
            mode === 'bootstrap'
              ? MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK
              : Math.max(2, Math.floor(MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK / 2)),
            connectivityBudget,
            shouldContinue,
            mode === 'bootstrap' ? MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE : Number.MAX_SAFE_INTEGER,
            mode === 'bootstrap',
            attemptedBootstrapIntentOrderIds,
          )
        ) {
          advanceCrossCursorAfterEnqueue(entry.index);
          await yieldMarketMakerApi();
          if (mode === 'steady') return true;
        }
        await yieldMarketMakerApi();
      }
      if (!shouldContinue()) return false;
      await yieldMarketMakerApi();
      return false;
    } finally {
      loopInFlight = false;
    }
  };

  type MarketMakerBootstrapFinalization = {
    health: MarketMakerHealth;
    fingerprint: ReturnType<typeof buildMarketMakerBootstrapFingerprint>;
    runtimeStateHash: string;
    entityStateHash: string;
  };

  const buildMarketMakerBootstrapFinalization = (): MarketMakerBootstrapFinalization => {
    const visibleHubs = readVisibleHubProfiles(env, true);
    if (!isAllSameQuoteDepthReady(visibleHubs)) {
      throw new Error(
        `MARKET_MAKER_BOOTSTRAP_INCOMPLETE: ${safeStringify({
          scope: 'same-chain-all-contexts-depth',
          incomplete: buildSameQuoteJobs(visibleHubs)
            .filter(job => !isSameQuoteJobDepthReady(env, job))
            .map(job => ({
              mmEntityId: job.context.entityId,
              jurisdiction: job.context.jurisdictionName,
              hubEntityId: job.hub.entityId,
              committedOffers: countCommittedMarketMakerOffersForHub(env, job.context.entityId, job.hub.entityId),
              expectedOffers: buildMarketMakerOfferSpecs([job.hub.entityId], job.tokenIds).length,
              blocker: describeMarketMakerSameHubBlocker(env, job.context.entityId, job.hub.entityId),
            })),
        })}`,
      );
    }
    const assertStartedAt = Date.now();
    const health = assertMarketMakerBootstrapFinalized(env, publishMarketMakerHealthSnapshot({ includeCross: true }));
    emitBootstrapDebugEvent('finalize-step', {
      step: 'assert-finalized',
      durationMs: Date.now() - assertStartedAt,
    });
    const fingerprintStartedAt = Date.now();
    const fingerprint = buildMarketMakerBootstrapFingerprint(env, mmContexts, visibleHubs, mmTokenIdsByContext, health);
    emitBootstrapDebugEvent('finalize-step', {
      step: 'fingerprint',
      durationMs: Date.now() - fingerprintStartedAt,
    });
    const hashStartedAt = Date.now();
    const runtimeStateHash = computeCanonicalStateHashFromEnv(env);
    const entityStateHash = buildMarketMakerBootstrapEntityStateHash(env);
    emitBootstrapDebugEvent('finalize-step', {
      step: 'canonical-hashes',
      durationMs: Date.now() - hashStartedAt,
    });
    return { health, fingerprint, runtimeStateHash, entityStateHash };
  };

  const publishMarketMakerBootstrapFinalization = (finalization: MarketMakerBootstrapFinalization): void => {
    bootstrapReadyHash = finalization.fingerprint.hash;
    bootstrapRuntimeStateHash = finalization.runtimeStateHash;
    bootstrapEntityStateHash = finalization.entityStateHash;
    bootstrapReadyAt = Date.now();
    startupPhase = 'offers-ready';
    cachedMarketMakerHealth = finalization.health;
    rebuildCachedHealthResponseJson();
  };

  const finalizeMarketMakerBootstrapState = (): MarketMakerBootstrapFinalization => {
    // The live RuntimeState advances only after the canonical runtime commit point has
    // persisted the finalized frame and its durable outbox. READY therefore
    // describes an already-durable state; it must never create a second,
    // bootstrap-specific snapshot protocol.
    const finalization = buildMarketMakerBootstrapFinalization();
    publishMarketMakerBootstrapFinalization(finalization);
    return finalization;
  };

  const markOffersReady = async (): Promise<boolean> => {
    if (startupPhase === 'offers-ready') return true;
    if (!canCheckBootstrapCompletion()) return false;
    // Let already-accepted ingress declare itself before erecting the final
    // checkpoint fence. A transient backlog means "drain and retry", not a
    // corrupt bootstrap and not a reason to terminate the market maker.
    await yieldMarketMakerApi();
    if (!canCheckBootstrapCompletion()) return false;

    const finalizeStartedAt = Date.now();
    const publishStartedAt = Date.now();
    const finalization = finalizeMarketMakerBootstrapState();
    const { health, fingerprint, runtimeStateHash, entityStateHash } = finalization;
    emitBootstrapDebugEvent('finalize-step', {
      step: 'publish-ready-state',
      durationMs: Date.now() - publishStartedAt,
    });
    emitBootstrapDebugEvent('ready-hash', {
      hash: fingerprint.hash,
      runtimeStateHash,
      entityStateHash,
      health: summarizeMarketMakerHealthForDebug(health),
      finalizeDurationMs: Date.now() - finalizeStartedAt,
    });
    nodeLog.info('bootstrap.ready_hash', {
      hash: fingerprint.hash,
      runtimeStateHash,
      entityStateHash,
    });
    if (envFlagEnabled(process.env['XLN_MARKET_MAKER_LOG_READY_HASH_PAYLOAD'])) {
      console.log(`[MESH-MM] BOOTSTRAP_READY_HASH_PAYLOAD payload=${safeStringify(fingerprint.payload)}`);
    }
    nodeLog.info('offers.ready', {
      entityId: primaryMmContext.entityId,
      runtimeId: String(env.runtimeId || ''),
      api: apiUrl,
      relay: resolvedArgs.relayUrl,
    });
    return true;
  };

  const refreshBootstrapPhase = (health: MarketMakerHealth | null): void => {
    if (isBootstrapDepthComplete(health)) return;
    const previousPhase = startupPhase;
    if (bootstrapCrossStarted) {
      startupPhase = 'bootstrap-cross';
    } else {
      const visibleHubs = readVisibleHubProfiles(env, true);
      const sameReady = isAllSameQuoteDepthReady(visibleHubs) && isMarketMakerSameDepthComplete(health);
      if (sameReady) {
        bootstrapCrossStarted = true;
        startupPhase = 'bootstrap-cross';
      } else {
        startupPhase = 'bootstrap-same-chain';
      }
    }
    if (startupPhase === previousPhase) return;
    emitBootstrapDebugEvent('phase', {
      phase: startupPhase,
      health: summarizeMarketMakerHealthForDebug(health),
    });
    rebuildCachedHealthResponseJson();
  };

  const waitForBootstrapOffers = async (): Promise<MarketMakerHealth | null> => {
    let lastProgressAt = Date.now();
    let lastProgressSignature = '';
    let lastProgressReason = 'startup';
    let lastProgressCheckpoint = buildBootstrapCausalCheckpoint();
    let lastBacklogLogAt = 0;
    let bootstrapCompletionCheckArmed = false;
    let bootstrapWorkStartedAt: number | null = null;
    const markProgress = (
      reason: string,
      health: MarketMakerHealth | null,
      now: number,
      checkpoint: ReturnType<typeof buildBootstrapCausalCheckpoint>,
    ): void => {
      lastProgressAt = now;
      lastProgressReason = reason;
      lastProgressCheckpoint = checkpoint;
      emitBootstrapDebugEvent('progress', {
        reason,
        idleMs: 0,
        health: summarizeMarketMakerHealthForDebug(health),
      });
    };
    const observeProgress = (
      reason: string,
      health: MarketMakerHealth | null,
    ): ReturnType<typeof evaluateBootstrapProgressDeadline> => {
      const checkpoint = buildBootstrapCausalCheckpoint();
      const signature = marketMakerBootstrapProgressSignature(health, checkpoint);
      const evaluation = evaluateBootstrapProgressDeadline(
        { signature: lastProgressSignature, lastProgressAt },
        signature,
        Date.now(),
        MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS,
      );
      if (evaluation.progressed) {
        lastProgressSignature = evaluation.signature;
        markProgress(reason, health, evaluation.lastProgressAt, checkpoint);
      }
      return evaluation;
    };
    const assertBootstrapNotStalled = (health: MarketMakerHealth | null): void => {
      const now = Date.now();
      const evaluation = observeProgress('deadline-checkpoint', health);
      const { idleMs } = evaluation;
      if (!evaluation.stalled) return;
      if (
        hasMarketMakerRuntimeBacklog(env) &&
        isBootstrapWorkWithinDeadline(bootstrapWorkStartedAt, now, MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS)
      )
        return;
      const visibleHubs = readVisibleHubProfiles(env).filter(profile => sameJurisdiction(primaryMmContext, profile));
      const currentCheckpoint = buildBootstrapCausalCheckpoint();
      const capsule = buildBootstrapStallCapsule({
        env,
        phase: startupPhase,
        idleMs,
        lastProgressReason,
        lastProgressSignature,
        lastProgressCheckpoint,
        currentCheckpoint,
        summarizedHealth: summarizeMarketMakerHealthForDebug(health),
        visibleHubs,
        lastDirectEntityInput,
        lastDirectEntityInputError,
      });
      console.error(`[MESH-MM] BOOTSTRAP_STALLED capsule=${safeStringify(capsule)}`);
      emitBootstrapDebugEvent('timeout', {
        capsule,
      });
      throw new Error(
        `MARKET_MAKER_BOOTSTRAP_STALLED:phase=${startupPhase}:idleMs=${idleMs}:` +
          `pendingReliable=${summarizeRuntimeQuiescence(env).pendingReliableOutputs}`,
      );
    };
    while (!shuttingDown) {
      const bootstrapLoopNow = Date.now();
      bootstrapWorkStartedAt = updateBootstrapWorkStartedAt(
        bootstrapWorkStartedAt,
        hasMarketMakerRuntimeBacklog(env),
        bootstrapLoopNow,
        env.runtimeState?.processingPromise
          ? Math.max(env.lastProcessEnteredAt ?? 0, env.activeProcessProgressAt ?? 0)
          : undefined,
      );
      assertBootstrapNotStalled(cachedMarketMakerHealth);
      if (hasMarketMakerRuntimeBacklog(env)) {
        observeProgress('runtime-backlog', cachedMarketMakerHealth);
        bootstrapCompletionCheckArmed = false;
        await yieldMarketMakerApi();
        await sleep(MARKET_MAKER_BOOTSTRAP_LOOP_MS);
        continue;
      }
      const beforeDrive = publishBootstrapHealthSnapshot();
      observeProgress('health', beforeDrive);
      refreshBootstrapPhase(beforeDrive);
      await yieldMarketMakerApi();
      if (isBootstrapDepthComplete(beforeDrive) && canCheckBootstrapCompletion()) return beforeDrive;
      if (bootstrapCompletionCheckArmed && canCheckBootstrapCompletion()) {
        const completionStartedAt = Date.now();
        const completionHealth = buildBootstrapCompletionHealth();
        emitBootstrapDebugEvent('completion-health', {
          durationMs: Date.now() - completionStartedAt,
          health: summarizeMarketMakerHealthForDebug(completionHealth),
        });
        observeProgress('completion-health', completionHealth);
        await yieldMarketMakerApi();
        if (isBootstrapDepthComplete(completionHealth) && canCheckBootstrapCompletion()) return completionHealth;
        bootstrapCompletionCheckArmed = false;
      }
      const enqueued = await driveQuotes('bootstrap');
      await yieldMarketMakerApi();
      if (enqueued) {
        bootstrapWorkStartedAt = updateBootstrapWorkStartedAt(bootstrapWorkStartedAt, true, Date.now());
        bootstrapCompletionCheckArmed = false;
      }
      if (hasMarketMakerRuntimeBacklog(env)) {
        observeProgress('runtime-backlog', cachedMarketMakerHealth);
        bootstrapCompletionCheckArmed = false;
        await sleep(MARKET_MAKER_BOOTSTRAP_LOOP_MS);
        continue;
      }
      bootstrapWorkStartedAt = updateBootstrapWorkStartedAt(bootstrapWorkStartedAt, false, Date.now());
      const health = publishBootstrapHealthSnapshot();
      observeProgress('health', health);
      refreshBootstrapPhase(health);
      if (!enqueued && canCheckBootstrapCompletion()) {
        bootstrapCompletionCheckArmed = true;
        await yieldMarketMakerApi();
        const now = Date.now();
        if (now - lastBacklogLogAt >= 5_000) {
          lastBacklogLogAt = now;
          const backlog = getMarketMakerRuntimeBacklogSnapshot(env);
          emitBootstrapDebugEvent('backlog', { backlog });
          if (MARKET_MAKER_BOOTSTRAP_LOG_BACKLOG) {
            console.log(`[MESH-MM] BOOTSTRAP_WAIT_BACKLOG ${safeStringify(backlog)}`);
          }
        }
      }
      await sleep(MARKET_MAKER_BOOTSTRAP_LOOP_MS);
    }
    if (shuttingDown) return null;
    throw new Error('MARKET_MAKER_BOOTSTRAP_STOPPED_WITHOUT_SHUTDOWN');
  };

  let healthRefreshInFlight = false;
  const refreshCachedHealth = (): void => {
    if (shuttingDown || healthRefreshInFlight) return;
    if (hasMarketMakerRuntimeBacklog(env)) return;
    healthRefreshInFlight = true;
    try {
      if (startupPhase === 'offers-ready') {
        publishReadyHealthSnapshot();
      } else {
        publishBootstrapHealthSnapshot();
      }
    } finally {
      healthRefreshInFlight = false;
    }
  };
  const runQuoteMaintenance = async (): Promise<void> => {
    if (hasMarketMakerRuntimeBacklog(env)) return;
    if (startupPhase === 'offers-ready') {
      const before = publishReadyHealthSnapshot();
      if (isMarketMakerFullDepthComplete(before)) return;
      await driveQuotes('steady');
      const after = publishReadyHealthSnapshot();
      if (!isMarketMakerFullDepthComplete(after)) publishMarketMakerHealthSnapshot({ includeCross: true });
      return;
    }
    const enqueued = await driveQuotes();
    publishBootstrapHealthSnapshot();
    if (startupPhase !== 'offers-ready' && !enqueued && canCheckBootstrapCompletion()) {
      const completionHealth = buildBootstrapCompletionHealth();
      if (isBootstrapDepthComplete(completionHealth)) {
        await markOffersReady();
      }
    }
  };
  const failQuoteLoop = (error: unknown): void => {
    if (shuttingDown) return;
    const message = error instanceof Error ? error.message : String(error);
    emitBootstrapDebugEvent('fatal', { error: message });
    console.error(`[MM] quote loop failed; shutting down:`, message);
    if (loop) clearInterval(loop);
    if (healthRefreshLoop) clearInterval(healthRefreshLoop);
    process.exit(1);
  };
  const startQuoteLoop = (): void => {
    if (loop) return;
    loop = setInterval(() => {
      if (shuttingDown) return;
      void runQuoteMaintenance().catch(failQuoteLoop);
    }, MARKET_MAKER_QUOTE_LOOP_MS);
  };
  const startHealthRefreshLoop = (): void => {
    if (healthRefreshLoop) return;
    healthRefreshLoop = setInterval(() => {
      try {
        refreshCachedHealth();
      } catch (error) {
        failQuoteLoop(error);
      }
    }, MARKET_MAKER_HEALTH_REFRESH_MS);
  };
  startupPhase = 'runtime-ready';
  publishMarketMakerHealthSnapshot({ includeCross: false });
  startHealthRefreshLoop();
  emitBootstrapDebugEvent('phase', { phase: startupPhase });
  nodeLog.info('runtime.ready', {
    entityId: primaryMmContext.entityId,
    runtimeId: String(env.runtimeId || ''),
    api: apiUrl,
    relay: resolvedArgs.relayUrl,
  });

  void (async () => {
    await sleep(MARKET_MAKER_BOOTSTRAP_START_DELAY_MS);
    if (shuttingDown) return;
    startupPhase = 'bootstrap-same-chain';
    publishBootstrapHealthSnapshot();
    emitBootstrapDebugEvent('phase', { phase: startupPhase });
    while (!shuttingDown) {
      const bootstrapHealth = await waitForBootstrapOffers();
      if (!bootstrapHealth) break;
      if (await markOffersReady()) {
        startQuoteLoop();
        return;
      }
    }
    if (!shuttingDown) {
      throw new Error('MARKET_MAKER_BOOTSTRAP_STOPPED_WITHOUT_READY');
    }
  })().catch(failQuoteLoop);

  let shutdownStarted = false;
  const shutdown = async (code: number = 0): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;
    if (loop) clearInterval(loop);
    if (healthRefreshLoop) clearInterval(healthRefreshLoop);
    const failures: string[] = [];
    const runCleanup = async (label: string, cleanup: () => Promise<unknown>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        failures.push(`${label}:${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await runCleanup('quiesce', () =>
      quiesceNodeRuntime(env, {
        workTimeoutMs: 10_000,
        loopTimeoutMs: 10_000,
      }),
    );
    await runCleanup('server', () => stopServerGracefully(server, httpDrain, resolvedArgs.name, 5_000));
    await runCleanup('runtime_db', () => closeRuntimeDb(env));
    await runCleanup('infra_db', () => closeInfraDb(env));
    if (failures.length > 0) {
      console.error(`[${resolvedArgs.name}] shutdown failed: ${failures.join('|')}`);
      process.exit(code || 1);
    }
    process.exit(code);
  };
  const stopParentWatch = startParentLivenessWatch(resolvedArgs.name, process.env['XLN_ORCHESTRATOR_PID'], () => {
    void shutdown(1);
  });

  process.on('SIGTERM', () => {
    stopParentWatch();
    void shutdown();
  });
  process.on('SIGINT', () => {
    stopParentWatch();
    void shutdown();
  });
  await new Promise<void>(() => {});
};
