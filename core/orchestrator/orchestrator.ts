#!/usr/bin/env bun
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { scheduler } from 'node:timers/promises';
import { compareStableText, safeStringify } from '../protocol/serialization';
import { requireBoundaryRecord } from '../protocol/boundary-validation';
import { REMOTE_RUNTIME } from '../config/constants';
import { readBooleanEnv } from '../config/environment';
import { createStructuredLogger, registerStructuredLogSink } from '../support/logger';
import { getTokenIdsForJurisdiction } from '../account/utils';
import { DEFAULT_ACCOUNT_TOKEN_IDS } from '../account/config/defaults';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../orderbook';
import { createHubSpawner } from './process/spawn/hub';
import { createMarketMakerSpawner } from './process/spawn/market-maker';
import { canonicalHubEngine } from './process/hub-engine-plan';
import { parseProfile } from '../entity/profile';
import { verifyProfileSignature } from '../entity/profile/profile-signing';
import { startCustodySupport, stopManagedChild } from './bootstrap/custody-bootstrap';
import {
  clearDebugTimeline,
  createRelayStore,
  normalizeRuntimeKey,
  pushDebugEvent,
  removeClient,
  storeVerifiedGossipProfile,
  type RelayStore,
} from '../network/relay/store';
import { openRelayIncidentJournal } from '../network/relay/incident-journal';
import { forgetRelaySocketRuntimeId, relayRoute, type RelayRouterConfig } from '../network/relay/router';
import { closeRelayClientsForReset } from '../network/relay/reset';
import { canonicalizeRuntimeWsAudience, deserializeWsMessage, resolveRuntimeWsMaxMessageBytes, serializeWsMessage, toRuntimeWsBytes, type RuntimeWsMessage } from '../network/p2p/ws-protocol';
import { createHelloChallengeRegistry } from '../network/p2p/auth/hello-challenge';
import { type MarketSnapshotPayload } from '../network/relay/market/snapshot';
import { createMarketSubscriptionStack } from '../network/relay/market/subscriptions';
import { createMarketCapController } from '../network/relay/market/cap/market-cap-controller';
import { decodeMarketWireRequest, encodeMarketWireMessage, type MarketWireRequest } from '../network/relay/market/wire';
import {
  fetchMarketPairCatalogFromHub,
  fetchMarketSnapshotsFromHub,
  fetchMarketTokensFromHub,
  listConnectedMarketHubEntityIds,
} from './hub/market-client';
import { handleMarketCapRequest } from './hub/market-cap-http';
import { assertMinDiskFree, getStorageHealth, getStorageHealthSnapshotSync } from '../support/storage-monitor';
import { maybeHandleQaRequest } from '../qa/api';
import { serveStaticApp } from '../api/server/static-assets';
import { enforceFaucetPolicy } from '../api/server/faucet/policy';
import { handleWatchtowerProxy } from '../api/server/rpc/watchtower-proxy';
import { createAssistantProxyFromEnv, resolveAssistantDirectClientIp, resolveAssistantRateClientId } from '../api/server/assistant/proxy';
import { createHttpDrainTracker, stopServerGracefully } from './graceful-server';
import { publicAggregatedHealth, resolveSocketPeerAddress } from '../api/server/health/redaction';
import { dumpOpCounters, installGlobalOpCounters, resetOpCounters } from '../support/performance/op-counters';
import {
  isOperatorRequest,
  loadOrCreateOperatorToken,
  operatorPreflightResponse,
  ORCHESTRATOR_JSON_HEADERS,
} from './hub/operator-access';
import {
  type AggregatedHealth,
  type CustodySupportState,
  type HubChild,
  type HubHealthPayload,
  type ManagedRuntimeSpec,
  type MarketMakerChild,
  type MarketMakerHealthPayload,
  type OrchestratorWebSocket,
  type ResetState,
  type TimingMap,
} from './orchestrator-types';
import {
  CHILD_HEALTH_TIMEOUT_MS,
  HEALTH_RESPONSE_REFRESH_TIMEOUT_MS,
  HUB_BASELINE_TIMEOUT_MS,
  HUB_BASELINE_STALL_TIMEOUT_MS,
  HUB_BASELINE_STATUS_LOG_INTERVAL_MS,
  HUB_COUNT,
  HUB_NAMES,
  HUB_REQUIRED_TOKEN_COUNT,
  MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS,
  RELAY_MARKET_MAX_SUBSCRIPTION_CELLS,
  RELAY_MARKET_MAX_SUBSCRIPTIONS,
  RELAY_MARKET_MAX_SUBSCRIPTIONS_PER_IP,
  STARTUP_TIMEOUT_MS,
  parseArgs,
} from './orchestrator-config';
import { evaluateBootstrapProgressDeadline } from './bootstrap/bootstrap-progress-deadline';
import { fetchLoopback } from './server/loopback-fetch';
import { validateHubHealthPayload, validateHubInfoPayload } from './bootstrap/bootstrap-health-validation';
import { getConfiguredOfficialFoundationSignerId } from '../jurisdiction/adapter/kernel/jurisdiction-loader';
import {
  createManagedRuntimeLeaseManager,
  readManagedProcessTable,
  type ManagedProcessTableEntry,
} from './process/managed-runtime-leases';
import { scheduleMarketMakerRecoverySpawn, shouldAbortMarketMakerSpawn } from './market-maker/node/mm-recovery-spawn';
import { buildPrometheusMetrics } from './prometheus';
import { deriveResetHealthOk } from './health/health-model';
import {
  buildAggregatedBootstrapReserveHealth,
  buildAggregatedCustodyHealth,
  buildAggregatedHubHealth,
  buildAggregatedHubMeshHealth,
  buildAggregatedRelayHealth,
  collectAggregatedHubMesh,
  collectBootstrapReserveEntities,
  collectManagedRelayClients,
  deriveAggregatedSystemStatus,
} from './health/aggregated-health-projections';
import {
  buildAggregatedMarketMakerHealth,
  countMarketSnapshotOrderDepth,
  type MarketSnapshotOrderDepth,
} from './market-maker/health/market-maker-aggregated-health';
import { buildPublicMarketMakerHealth } from './market-maker/health/market-maker-public-health';
import { buildPublicHubDiscoveryPayload } from './hub/public-discovery';
import { handleResetHttpRequest } from './server/reset-http';
import {
  deployRpc2JurisdictionStack,
  hasShardRpc2Jurisdiction,
  provisionPrimaryRpcJurisdictionStack,
  readShardJurisdictions,
  resetLocalAnvilChains,
  resolvePrimaryHubJurisdiction,
  seedShardJurisdictions,
  syncCanonicalJurisdictionsFromShard,
  toPublicJurisdictionsPayload,
  type OrchestratorJurisdictionsConfig,
} from './j-select/jurisdictions';
import { createOrchestratorProxyHandlers, resolveRpcProxyIndex } from './proxy';
import { createHubApiRoutes } from './hub/hub-api-routes';
import { findMissingRpcContractCode, type RpcContractAddresses } from './bootstrap/contract-readiness';
import { maybeHandleOrchestratorDebugApi } from './debug-api';
import { areHubChildrenReady } from './hub/hub-mesh-readiness';
import {
  HUB_MESH_CREDIT_AMOUNT,
  HUB_DEFAULT_MIN_TRADE_SIZE,
  HUB_DEFAULT_SUPPORTED_PAIRS,
  getBootstrapCreditAmount,
} from './mesh/mesh-common';
import {
  resolveMeshJurisdictionConfig,
  resolveSecondaryJurisdictions,
} from './mesh/mesh-jurisdictions';
import { normalizeMarketMakerHealthPayload } from './market-maker/health/market-maker-health-payload';
import { createMarketMakerChildPoller } from './market-maker/health/market-maker-child-poll';
import { createMarketMakerIdentityResolver } from './market-maker/identity-resolver';
import { createManagedRuntimeSecurityTelemetrySync } from './health/runtime-security-telemetry';
import {
  createCurrentBootstrapTimelineBuilder,
  createBootstrapTimelineTools,
} from './bootstrap/bootstrap-timeline';
import { createProcessHealthBuilder } from './health/process-health';
import { evaluateHubBaselineDeadlines, type HubBaselineProgressState } from './hub/hub-baseline-progress';
import { handleRuntimeImportHttpRequest } from './replica-import/runtime-import-http';
import { createRuntimeImportController } from './replica-import/runtime-import-controller';
import { persistChildFailureReceipt, type ChildFailureReceipt } from './process/child-failure-diagnostics';
import type { ManagedChildFatalReport } from './process/managed-child-fatal-ipc';
import {
  decideChildFailure,
  type ChildFailureDecision,
  type ChildFailureObservation,
} from './process/child-recovery-policy';
import { buildRuntimeHealthFailures, normalizeRuntimeFailureCode } from '../protocol/errors/failure-taxonomy';
import { STORAGE_WRITER_LOCK_TTL_MS } from '../storage/runtime-dbs';
import { deriveManagedSignerInventory, deriveMeshChildSeed, readMeshSeedOverrides, requireMeshRootSeed, resolveMeshRuntimeSeed } from './mesh/mesh-seeds';
import { deriveManagedEntityIdentity } from './daemon-control';
import { createJAdapter } from '../jurisdiction/adapter';
import type { JAdapter, JTokenInfo } from '../jurisdiction/adapter/types';
import { getBootstrapTokenAmount } from '../jurisdiction/machine/config/bootstrap-economy';
import {
  createResetCoordinator,
  resolveActiveResetOptions,
  type OrchestratorResetOptions,
} from './process/reset-coordinator';
import { buildDiskSummary } from './health/disk-health';
import {
  createBaselineWaitReporter,
  createHealthRecomputer,
  openDirectHubPairCount,
  resolveCurrentCapabilityHealth,
} from './health/orchestrator-health-support';
import {
  projectNativeH1ReserveHealth,
  readOrchestratorCodeFingerprint,
  resolveOrchestratorRelayUpgradeData,
  type NativeH1MeshPair,
  type NativeH1ReserveTarget,
} from './support/runtime-support';

const args = parseArgs();
await installGlobalOpCounters('orchestrator');
const orchestratorOwnerId = `${process.pid}:${Date.now()}:${randomUUID()}`;
const orchestratorCodeFingerprint = readOrchestratorCodeFingerprint();
const staleReapEnabled = process.env['XLN_SKIP_STALE_REAP'] !== '1';
const MARKET_MAKER_FULL_HEALTH_TIMEOUT_MS = Math.max(
  CHILD_HEALTH_TIMEOUT_MS,
  Math.floor(Number(process.env['XLN_MARKET_MAKER_FULL_HEALTH_TIMEOUT_MS'] || '60000')),
);
const marketMakerReadyRestartLimit = Math.max(
  0,
  Math.floor(Number(process.env['XLN_MARKET_MAKER_READY_RESTARTS'] ?? '2')),
);
const MARKET_MAKER_RESTART_FENCING_GRACE_MS = STORAGE_WRITER_LOCK_TTL_MS + 1_000;
const relayUrl = args.relayUrl;
// There is one relay store/process. These are only its explicitly authenticated
// browser-facing proxy names; accepting a Host value never creates another relay.
const relayAudiences = new Set([
  canonicalizeRuntimeWsAudience(relayUrl),
  canonicalizeRuntimeWsAudience(new URL('/relay', args.publicWsBaseUrl).toString()),
  ...args.relayAudienceUrls.map(canonicalizeRuntimeWsAudience),
]);

const resolveRelayUpgradeData = (
  request: Request,
  url: URL,
  peerAddress: string | null,
): OrchestratorWebSocket['data'] | null =>
  resolveOrchestratorRelayUpgradeData(request, url, peerAddress, relayAudiences);
const shardJurisdictionsPath = join(args.dbRoot, 'jurisdictions.json');
const controlPlaneDir = join(args.dbRoot, '.control-plane');
const childDiagnosticsDir = join(controlPlaneDir, 'diagnostics');
const debugIncidentJournalPath = String(
  process.env['XLN_DEBUG_INCIDENT_JOURNAL_PATH'] || `${args.dbRoot}.debug-incidents.jsonl`,
).trim();
const debugIncidentJournal = openRelayIncidentJournal(debugIncidentJournalPath);
const managedRuntimeLeases = createManagedRuntimeLeaseManager({
  controlPlaneDir,
  ownerId: orchestratorOwnerId,
});
const jurisdictionsConfig: OrchestratorJurisdictionsConfig = {
  shardJurisdictionsPath,
  rpc2Url: args.rpc2Url,
  rpcUrls: args.rpcUrls,
  // Reset authority and network isolation are different capabilities. Dev is
  // resettable but must still expose configured public jurisdictions.
  ephemeralTestnet: process.env['XLN_EPHEMERAL_TESTNET'] === '1',
};

const officialFoundationSignerId = getConfiguredOfficialFoundationSignerId();
const relayStore: RelayStore = createRelayStore('mesh-relay', {
  ...(officialFoundationSignerId ? { officialFoundationSignerId } : {}),
  initialDebugId: debugIncidentJournal.debugId,
  initialIncidents: debugIncidentJournal.incidents,
  debugIdAllocator: () => debugIncidentJournal.allocateDebugId(),
  incidentSink: incident => debugIncidentJournal.record(incident),
});
const syncManagedRuntimeSecurityTelemetry = createManagedRuntimeSecurityTelemetrySync(relayStore);
registerStructuredLogSink((entry) => {
  if (entry.level !== 'error') return;
  pushDebugEvent(relayStore, {
    event: 'error',
    status: 'error',
    reason: entry.message,
    details: {
      source: 'orchestrator',
      severity: entry.level,
      ...entry,
    },
  });
});
const relayHelloChallenges = createHelloChallengeRegistry();
const routerConfig: RelayRouterConfig = {
  store: relayStore,
  localRuntimeId: 'mesh-relay',
  localDeliver: async () => {},
  send: (ws, data) => ws.send(data),
  consumeHelloChallenge: (ws, challenge) => relayHelloChallenges.consume(ws, challenge),
};

const timings: TimingMap = {
  reset_total: { startedAt: null, completedAt: null, ms: null },
  reset_stop_children: { startedAt: null, completedAt: null, ms: null },
  reset_clear_state: { startedAt: null, completedAt: null, ms: null },
  reset_spawn_h1: { startedAt: null, completedAt: null, ms: null },
  reset_wait_h1: { startedAt: null, completedAt: null, ms: null },
  reset_spawn_h23: { startedAt: null, completedAt: null, ms: null },
  reset_wait_hubs: { startedAt: null, completedAt: null, ms: null },
  reset_market_maker: { startedAt: null, completedAt: null, ms: null },
  reset_custody: { startedAt: null, completedAt: null, ms: null },
  reset_persist_ready_snapshots: { startedAt: null, completedAt: null, ms: null },
};

const resetState: ResetState = {
  inProgress: false,
  lastError: null,
  startedAt: null,
  completedAt: null,
  failedAt: null,
};
const configuredResetOptions: OrchestratorResetOptions = {
  enableMarketMaker: args.mmEnabled,
  enableCustody: args.custodyEnabled,
};
let activeResetOptions: OrchestratorResetOptions = {
  enableMarketMaker: false,
  enableCustody: false,
};
let pendingResetOptions: OrchestratorResetOptions | null = null;

const meshRootSeed = requireMeshRootSeed();
const runtimeSeedOverrides = readMeshSeedOverrides(
  process.env['XLN_MESH_RUNTIME_SEEDS_JSON'],
  'XLN_MESH_RUNTIME_SEEDS_JSON',
);
const radapterAuthSeeds = readMeshSeedOverrides(
  process.env['XLN_MESH_RADAPTER_AUTH_SEEDS_JSON'],
  'XLN_MESH_RADAPTER_AUTH_SEEDS_JSON',
);
const runtimeSeedFor = (name: string): string => resolveMeshRuntimeSeed(meshRootSeed, runtimeSeedOverrides, name);
const radapterAuthSeedFor = (name: string): string =>
  radapterAuthSeeds[name.toUpperCase()] || deriveMeshChildSeed(meshRootSeed, `radapter:${name}`);

const hubChildren: HubChild[] = HUB_NAMES.map((name, index) => {
  const engine = canonicalHubEngine(name);
  const apiPort = args.nodeApiPortBase + index;
  const configuredPublicPort = args.nodePublicPortBase + index;
  // TS owns /rpc and /ws on one Bun server. Native H1 currently owns two
  // independent listeners, so its direct socket must use the first free slot
  // after the three hubs and MM when the configured bases coincide.
  const publicPort = engine === 'rust' && configuredPublicPort === apiPort
    ? args.nodePublicPortBase + HUB_COUNT + 1
    : configuredPublicPort;
  return {
    name,
    region: 'global',
    seed: runtimeSeedFor(name),
    authSeed: radapterAuthSeedFor(name),
    signerLabel: `${name.toLowerCase()}-hub`,
    apiPort,
    publicPort,
    dbPath: join(args.dbRoot, name.toLowerCase()),
    deployTokens: index === 0,
    engine,
    proc: null,
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    restartTimer: null,
    restartCount: 0,
    recoveryInProgress: false,
    failureCounts: {},
    lastHealth: null,
    lastInfo: null,
    recentStdout: [],
    recentStderr: [],
  };
});

let nativeH1ReserveTargets: readonly NativeH1ReserveTarget[] = [];
const nativeH1MeshPairs = new Map<string, NativeH1MeshPair>();

const projectNativeH1ReserveHealthForMesh = (health: HubHealthPayload): HubHealthPayload =>
  projectNativeH1ReserveHealth(
    health,
    hubChildren,
    relayStore,
    nativeH1ReserveTargets,
    nativeH1MeshPairs,
    HUB_REQUIRED_TOKEN_COUNT,
  );

const marketMakerChild: MarketMakerChild = {
  name: 'MM',
  seed: runtimeSeedFor('MM'),
  authSeed: radapterAuthSeedFor('MM'),
  signerLabel: 'mm-1',
  // MM sits immediately past the hub block. The literal 3 was "just past the
  // three hubs", which put MM on top of H4 the moment the mesh grew.
  apiPort: args.nodeApiPortBase + HUB_COUNT,
  publicPort: args.nodePublicPortBase + HUB_COUNT,
  dbPath: join(args.dbRoot, 'mm'),
  proc: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  exitSignal: null,
  restartTimer: null,
  restartCount: 0,
  recoveryInProgress: false,
  failureCounts: {},
  lastHealth: null,
  lastInfo: null,
  lastStartupPhase: null,
  recentStdout: [],
  recentStderr: [],
};

let custodySupport: CustodySupportState | null = null;

const orchestratorOperatorTokenPath = process.env['XLN_ORCHESTRATOR_OPERATOR_TOKEN_PATH']?.trim()
  || join(args.dbRoot, 'operator-token');
const orchestratorOperatorToken = loadOrCreateOperatorToken(
  orchestratorOperatorTokenPath,
  process.env['XLN_ORCHESTRATOR_OPERATOR_TOKEN'],
);
const runtimeImportTokenTtlMs = Math.max(
  60_000,
  Math.floor(Number(process.env['XLN_RUNTIME_IMPORT_TOKEN_TTL_MS'] || String(REMOTE_RUNTIME.IMPORT_TOKEN_TTL_MS))),
);
const runtimeImportRefreshMarginMs = Math.max(
  10_000,
  Math.min(
    runtimeImportTokenTtlMs - 1_000,
    Math.floor(Number(process.env['XLN_RUNTIME_IMPORT_REFRESH_MARGIN_MS'] || String(REMOTE_RUNTIME.IMPORT_TOKEN_REFRESH_MARGIN_MS))),
  ),
);
const runtimeImportManifestPath = process.env['XLN_RUNTIME_IMPORT_MANIFEST_PATH']?.trim()
  || join(args.dbRoot, 'runtime-import-manifest.json');
const runtimeImportLogUrlEnabled = readBooleanEnv('XLN_RUNTIME_IMPORT_LOG_URL', false);

const custodyPublicRpcUrlEnv = String(process.env['XLN_CUSTODY_PUBLIC_RPC_URL'] || '').trim();

const CHILD_GRACEFUL_SHUTDOWN_MS = 20_000;
const CHILD_RESET_QUIESCE_TIMEOUT_MS = 45_000;
const CHILD_SHUTDOWN_QUIESCE_TIMEOUT_MS = Math.max(
  1_000,
  Math.floor(Number(process.env['XLN_CHILD_SHUTDOWN_QUIESCE_MS'] || '5000')),
);

type StopAllChildrenOptions = {
  quiesceRounds?: number;
  quiesceTimeoutMs?: number;
  quiescePauseMs?: number;
};

const startTiming = (stage: keyof typeof timings): number => {
  const now = Date.now();
  const timing = timings[stage];
  if (!timing) throw new Error(`Unknown timing stage: ${String(stage)}`);
  timing.startedAt = now;
  timing.completedAt = null;
  timing.ms = null;
  return now;
};

const finishTiming = (stage: keyof typeof timings, startedAt: number): void => {
  const completedAt = Date.now();
  const timing = timings[stage];
  if (!timing) throw new Error(`Unknown timing stage: ${String(stage)}`);
  timing.completedAt = completedAt;
  timing.ms = completedAt - startedAt;
  meshLog.info('timing', { stage, ms: timing.ms });
};

const serializeError = (error: unknown): string => error instanceof Error ? error.message : String(error);
const meshLog = createStructuredLogger('mesh.orchestrator');
const assistantProxy = createAssistantProxyFromEnv(meshLog);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toFiniteNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

let lastBootstrapTailWarning = '';
const warnBootstrapTailRead = (message: string, path: string, error: unknown): void => {
  const errorMessage = serializeError(error);
  const key = `${message}:${path}:${errorMessage}`;
  if (key === lastBootstrapTailWarning) return;
  lastBootstrapTailWarning = key;
  meshLog.warn(message, { path, error: errorMessage });
};

const stopProcess = async (proc: ChildProcess | null): Promise<void> => {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  const deadline = Date.now() + CHILD_GRACEFUL_SHUTDOWN_MS;
  while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) {
    await scheduler.wait(100);
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    meshLog.warn('child.stop_timeout_sigkill', {
      pid: proc.pid ?? null,
      timeoutMs: CHILD_GRACEFUL_SHUTDOWN_MS,
    });
    proc.kill('SIGKILL');
    const killDeadline = Date.now() + CHILD_GRACEFUL_SHUTDOWN_MS;
    while (proc.exitCode === null && proc.signalCode === null && Date.now() < killDeadline) {
      await scheduler.wait(100);
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      throw new Error(`CHILD_STOP_TIMEOUT pid=${proc.pid ?? 'unknown'}`);
    }
  }
};

const clearRelayState = (): void => {
  closeRelayClientsForReset(relayStore);
  relayStore.gossipProfiles.clear();
  marketCapController.clear();
  relayStore.runtimeEncryptionKeys.clear();
  relayStore.activeHubEntityIds = [];
  clearDebugTimeline(relayStore);
  relayStore.wsCounter = 0;
  marketSubscriptionStack.clear();
};

const fetchFailureLog = new Map<string, { fingerprint: string; loggedAt: number }>();

const recordFetchFailure = (
  url: string,
  kind: 'http' | 'transport' | 'decode' | 'payload',
  detail: string,
  expectedPending = false,
): void => {
  const now = Date.now();
  const fingerprint = `${kind}:${detail}`;
  const previous = fetchFailureLog.get(url);
  if (previous?.fingerprint === fingerprint && now - previous.loggedAt < 5_000) return;
  fetchFailureLog.set(url, { fingerprint, loggedAt: now });
  if (expectedPending) {
    meshLog.info('health_fetch.pending', { url, kind, detail });
  } else {
    meshLog.warn('health_fetch.failed', { url, kind, detail });
  }
};

const fetchJson = async <T>(
  url: string,
  timeoutMs = 2_000,
  expectedPending = false,
): Promise<T | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchLoopback(url, { signal: controller.signal });
    if (!response.ok) {
      recordFetchFailure(url, 'http', `status=${response.status}`, expectedPending);
      return null;
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      recordFetchFailure(url, 'decode', serializeError(error), expectedPending);
      return null;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      recordFetchFailure(
        url,
        'payload',
        `type=${Array.isArray(payload) ? 'array' : typeof payload}`,
        expectedPending,
      );
      return null;
    }
    fetchFailureLog.delete(url);
    return payload as T;
  } catch (error) {
    recordFetchFailure(url, 'transport', serializeError(error), expectedPending);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const postJson = async (url: string, timeoutMs = 1_000): Promise<void> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      fetch(url, { method: 'POST', signal: controller.signal }).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    meshLog.warn('quiesce.post_failed', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const getHubChildByEntityId = (hubEntityId: string): HubChild | null => {
  const normalized = String(hubEntityId || '').trim().toLowerCase();
  if (!normalized) return null;
  return hubChildren.find((child) => {
    const primaryEntityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').trim().toLowerCase();
    if (primaryEntityId === normalized) return true;
    return (child.lastInfo?.hubEntities || []).some((entry) =>
      String(entry?.entityId || '').trim().toLowerCase() === normalized
    );
  }) || null;
};

const getConnectedMarketHubEntityIds = (): string[] => listConnectedMarketHubEntityIds(hubChildren);

const getHealthyHubChild = (): HubChild | null =>
  hubChildren.find((candidate) =>
    candidate.proc?.exitCode === null &&
    candidate.proc?.signalCode === null &&
    candidate.lastHealth &&
    candidate.lastHealth.runtime?.halted !== true
  ) || null;

const getExitedHubChild = (): HubChild | null =>
  hubChildren.find((child) =>
    !child.recoveryInProgress &&
    (child.exitCode !== null || child.exitSignal !== null || child.proc?.exitCode !== null || child.proc?.signalCode !== null)
  ) || null;

const fetchHubMarketSnapshots = async (
  child: HubChild,
  hubEntityId: string,
  pairIds: string[],
  depth: number,
): Promise<MarketSnapshotPayload[]> => fetchMarketSnapshotsFromHub(
  { host: args.host, apiPort: child.apiPort, hubEntityId }, pairIds, depth,
);

const fetchHubMarketPairCatalog = async (hubEntityId: string) => {
  const child = getHubChildByEntityId(hubEntityId);
  if (!child) throw new Error(`MARKET_CAP_UNKNOWN_HUB:${hubEntityId}`);
  return fetchMarketPairCatalogFromHub({ host: args.host, apiPort: child.apiPort, hubEntityId });
};

const fetchHubMarketTokens = async (hubEntityId: string) => {
  const child = getHubChildByEntityId(hubEntityId);
  if (!child) throw new Error(`MARKET_CAP_UNKNOWN_HUB:${hubEntityId}`);
  return fetchMarketTokensFromHub({ host: args.host, apiPort: child.apiPort, hubEntityId });
};

const marketSubscriptionStack = createMarketSubscriptionStack<OrchestratorWebSocket>({
  maxSubscriptions: RELAY_MARKET_MAX_SUBSCRIPTIONS,
  maxSubscriptionsPerIp: RELAY_MARKET_MAX_SUBSCRIPTIONS_PER_IP,
  maxCellsPerSubscription: RELAY_MARKET_MAX_SUBSCRIPTION_CELLS,
  getClientIp: ws => String(ws?.data?.clientIp || 'unknown'),
  getConnectedHubEntityIds: getConnectedMarketHubEntityIds,
  fetchSnapshots: async (hubEntityId, pairIds, depth) => {
    const child = getHubChildByEntityId(hubEntityId);
    if (!child) {
      const error = new Error(`Unknown market hub: ${hubEntityId}`) as Error & { code?: string };
      error.code = 'E_UNKNOWN_HUB';
      throw error;
    }
    return fetchHubMarketSnapshots(child, hubEntityId, pairIds, depth);
  },
  onHandlerError: (error, msg) => {
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'MARKET_HANDLER_EXCEPTION',
      details: { error: serializeError(error), msgType: msg['type'] },
    });
  },
});

const marketCapController = createMarketCapController({
  relayStore,
  getConnectedHubEntityIds: getConnectedMarketHubEntityIds,
  fetchPairCatalog: fetchHubMarketPairCatalog,
  fetchTokenCatalog: fetchHubMarketTokens,
  fetchSnapshots: async (hubEntityId, pairIds, depth) => {
    const child = getHubChildByEntityId(hubEntityId);
    if (!child) throw new Error(`MARKET_CAP_UNKNOWN_HUB:${hubEntityId}`);
    return fetchHubMarketSnapshots(child, hubEntityId, pairIds, depth);
  },
});

const reportMarketCapFailure = (event: 'warn' | 'error', reason: string, message: string): void => void pushDebugEvent(relayStore, { event, reason, details: { message } });

const cleanupRpcMarketSubscription = (ws: OrchestratorWebSocket): void => marketSubscriptionStack.cleanup(ws);

const pollHubHealth = async (child: HubChild): Promise<void> => {
  const proc = child.proc;
  if (!proc || child.exitCode !== null || child.exitSignal !== null || proc.exitCode !== null || proc.signalCode !== null) return;
  const apiBase = `http://${args.host}:${child.apiPort}`;
  const infoUrl = `${apiBase}/api/info`;
  const healthUrl = `${apiBase}/api/health`;
  const awaitingFirstHealth = child.lastInfo === null && child.lastHealth === null;
  const [rawInfo, rawHealth] = await Promise.all([
    fetchJson<unknown>(infoUrl, CHILD_HEALTH_TIMEOUT_MS, awaitingFirstHealth),
    fetchJson<unknown>(healthUrl, CHILD_HEALTH_TIMEOUT_MS, awaitingFirstHealth),
  ]);
  if (
    child.proc !== proc ||
    child.exitCode !== null ||
    child.exitSignal !== null ||
    proc.exitCode !== null ||
    proc.signalCode !== null
  ) return;
  if (rawInfo) {
    try {
      child.lastInfo = validateHubInfoPayload(rawInfo);
    } catch (error) {
      recordFetchFailure(infoUrl, 'payload', serializeError(error));
    }
  }
  if (rawHealth) {
    try {
      const validatedHealth = validateHubHealthPayload(rawHealth);
      const nextHealth = child.engine === 'rust'
        ? projectNativeH1ReserveHealthForMesh(validatedHealth)
        : validatedHealth;
      syncManagedRuntimeSecurityTelemetry(child.name, nextHealth);
      child.lastHealth = nextHealth;
      observeManagedRuntimeHalt(child, child.lastHealth);
    } catch (error) {
      recordFetchFailure(healthUrl, 'payload', serializeError(error));
    }
  }
  const entityIds = new Set<string>();
  const primaryEntityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').trim().toLowerCase();
  if (primaryEntityId) entityIds.add(primaryEntityId);
  for (const entry of child.lastInfo?.hubEntities || []) {
    const entityId = String(entry?.entityId || '').trim().toLowerCase();
    if (entityId) entityIds.add(entityId);
  }
  if (entityIds.size > 0) {
    relayStore.activeHubEntityIds = Array.from(new Set([
      ...relayStore.activeHubEntityIds,
      ...entityIds,
    ]));
  }
};

let hubHealthPollInFlight: Promise<void> | null = null;
const pollAllHubHealth = async (): Promise<void> => {
  if (hubHealthPollInFlight) return hubHealthPollInFlight;
  hubHealthPollInFlight = Promise.all(hubChildren.map(child => pollHubHealth(child)))
    .then(() => undefined)
    .finally(() => {
      hubHealthPollInFlight = null;
    });
  return hubHealthPollInFlight;
};

const publishNativeHubProfile = async (child: HubChild): Promise<void> => {
  if (child.engine !== 'rust') return;
  await pollHubHealth(child);
  const entityId = String(child.lastInfo?.entityId || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(entityId)) {
    throw new Error(`RUST_HUB_PROFILE_ENTITY_ID_MISSING:${child.name}`);
  }
  const payload = await fetchJson<Record<string, unknown>>(
    `http://${args.host}:${String(child.apiPort)}/api/gossip/profile?entityId=${encodeURIComponent(entityId)}`,
    CHILD_HEALTH_TIMEOUT_MS,
  );
  if (
    !payload || payload['ok'] !== true || payload['found'] !== true ||
    String(payload['entityId'] || '').toLowerCase() !== entityId ||
    !Array.isArray(payload['peers'])
  ) throw new Error(`RUST_HUB_PROFILE_RESPONSE_INVALID:${child.name}`);
  const profile = parseProfile(payload['profile']);
  const verified = await verifyProfileSignature(profile);
  if (!verified.valid) {
    throw new Error(`RUST_HUB_PROFILE_SIGNATURE_INVALID:${child.name}:${verified.reason || 'unknown'}`);
  }
  if (!storeVerifiedGossipProfile(relayStore, profile) && !relayStore.gossipProfiles.has(entityId)) {
    throw new Error(`RUST_HUB_PROFILE_RELAY_REJECTED:${child.name}`);
  }
};

type NativeAccountStatus = Readonly<{
  hasAccount: boolean;
  ready: boolean;
  currentHeight: number;
  pendingFrameHeight: number | null;
  tokens: readonly Readonly<{
    tokenId: number;
    hubGranted: string;
    peerGranted: string;
    delta: null | Readonly<{ leftCreditLimit: string; rightCreditLimit: string }>;
  }>[];
}>;

const logNativeH1Bootstrap = (
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void => {
  meshLog.warn('native_h1.bootstrap_phase', { event, ...fields });
};

const readNativeAccountStatus = async (
  child: HubChild,
  hubEntityId: string,
  counterpartyEntityId: string,
  tokenIds: readonly number[],
): Promise<NativeAccountStatus | null> => {
  const url = new URL(`http://${args.host}:${String(child.apiPort)}/api/account/status`);
  url.searchParams.set('hubEntityId', hubEntityId);
  url.searchParams.set('counterpartyEntityId', counterpartyEntityId);
  url.searchParams.set('tokenIds', tokenIds.join(','));
  const payload = await fetchJson<Record<string, unknown>>(url.toString(), CHILD_HEALTH_TIMEOUT_MS);
  if (!payload) return null;
  if (payload['success'] !== true || !Array.isArray(payload['tokens'])) {
    throw new Error(`RUST_HUB_ACCOUNT_STATUS_INVALID:${counterpartyEntityId}`);
  }
  const tokens = payload['tokens'].map((raw): NativeAccountStatus['tokens'][number] => {
    const row = requireBoundaryRecord(raw, 'RUST_HUB_ACCOUNT_STATUS_TOKEN');
    const tokenId = Number(row['tokenId']);
    const hubGranted = String(row['hubGranted'] || '');
    const peerGranted = String(row['peerGranted'] || '');
    const delta = row['delta'];
    if (!Number.isSafeInteger(tokenId) || tokenId < 1) {
      throw new Error(`RUST_HUB_ACCOUNT_STATUS_TOKEN_ID:${String(row['tokenId'])}`);
    }
    if (!/^-?\d+$/.test(hubGranted) || !/^-?\d+$/.test(peerGranted)) {
      throw new Error(`RUST_HUB_ACCOUNT_STATUS_GRANTED:${tokenId}`);
    }
    if (delta === null) return { tokenId, hubGranted, peerGranted, delta: null };
    const fields = requireBoundaryRecord(delta, 'RUST_HUB_ACCOUNT_STATUS_DELTA');
    const leftCreditLimit = String(fields['leftCreditLimit'] || '');
    const rightCreditLimit = String(fields['rightCreditLimit'] || '');
    if (!/^-?\d+$/.test(leftCreditLimit) || !/^-?\d+$/.test(rightCreditLimit)) {
      throw new Error(`RUST_HUB_ACCOUNT_STATUS_CREDIT:${tokenId}`);
    }
    return { tokenId, hubGranted, peerGranted, delta: { leftCreditLimit, rightCreditLimit } };
  });
  const currentHeight = Number(payload['currentHeight'] || 0);
  const pendingFrameHeight = payload['pendingFrameHeight'] === null
    ? null
    : Number(payload['pendingFrameHeight']);
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 0 ||
      (pendingFrameHeight !== null && (!Number.isSafeInteger(pendingFrameHeight) || pendingFrameHeight < 1))) {
    throw new Error(`RUST_HUB_ACCOUNT_STATUS_HEIGHT:${currentHeight}:${String(pendingFrameHeight)}`);
  }
  return {
    hasAccount: payload['hasAccount'] === true,
    ready: payload['ready'] === true,
    currentHeight,
    pendingFrameHeight,
    tokens,
  };
};

const submitNativeBootstrapCredit = async (
  child: HubChild,
  entityId: string,
  signerId: string,
  counterpartyEntityId: string,
  tokenIds: readonly number[],
): Promise<void> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchLoopback(
      `http://${args.host}:${String(child.apiPort)}/api/control/runtime/entity-inputs`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: safeStringify({
          commandId: `bootstrap-credit:${counterpartyEntityId}:${tokenIds.join(',')}`,
          entityInputs: [{
            entityId,
            signerId,
            entityTxs: tokenIds.map(tokenId => ({
              type: 'extendCredit',
              data: {
                counterpartyEntityId,
                tokenId,
                amount: getBootstrapCreditAmount(tokenId),
              },
            })),
          }],
        }),
      },
    );
    const payload = requireBoundaryRecord(await response.json(), 'RUST_HUB_BOOTSTRAP_CREDIT_RESPONSE');
    if (!response.ok || payload['ok'] !== true || !Number.isSafeInteger(payload['height'])) {
      throw new Error(
        `RUST_HUB_BOOTSTRAP_CREDIT_FAILED:${counterpartyEntityId}:${response.status}:${safeStringify(payload)}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
};

const configureNativeH1Entity = async (
  child: HubChild,
  entityId: string,
  signerId: string,
): Promise<void> => {
  const quoteAuthority = getMarketMakerIdentities()[0];
  if (!quoteAuthority) throw new Error('RUST_HUB_QUOTE_AUTHORITY_MISSING:H1');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchLoopback(
      `http://${args.host}:${String(child.apiPort)}/api/control/runtime/entity-inputs`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: safeStringify({
          commandId: 'bootstrap-hub-policy:H1',
          entityInputs: [{
            entityId,
            signerId,
            entityTxs: [
              {
                type: 'setHubConfig',
                data: {
                  matchingStrategy: 'amount',
                  policyVersion: 1,
                  routingFeePPM: 1,
                  baseFee: 0n,
                  swapTakerFeeBps: 1,
                  rebalanceLiquidityFeeBps: 1n,
                  rebalanceTimeoutMs: 10 * 60 * 1_000,
                },
              },
              {
                type: 'initOrderbookExt',
                data: {
                  name: child.name,
                  spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
                  referenceTokenId: 1,
                  usdQuoteAuthorityEntityId: quoteAuthority.entityId,
                  minTradeSize: HUB_DEFAULT_MIN_TRADE_SIZE,
                  supportedPairs: [...HUB_DEFAULT_SUPPORTED_PAIRS],
                },
              },
            ],
          }],
        }),
      },
    );
    const payload = requireBoundaryRecord(await response.json(), 'RUST_HUB_BOOTSTRAP_POLICY_RESPONSE');
    if (!response.ok || payload['ok'] !== true || !Number.isSafeInteger(payload['height'])) {
      throw new Error(`RUST_HUB_BOOTSTRAP_POLICY_FAILED:${response.status}:${safeStringify(payload)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
};

const creditGrantedByNativeHub = (
  status: NativeAccountStatus,
  tokenId: number,
): bigint => {
  const row = status.tokens.find(token => token.tokenId === tokenId);
  return row ? BigInt(row.hubGranted) : 0n;
};

const fundLocalJOperator = async (
  rpcUrl: string,
  chainId: number,
  signerId: string,
): Promise<void> => {
  if (chainId !== 31_337 && chainId !== 31_338) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: safeStringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'anvil_setBalance',
        params: [signerId, '0x8ac7230489e80000'],
      }),
      signal: controller.signal,
    });
    const payload = requireBoundaryRecord(
      await response.json(),
      'RUST_HUB_J_OPERATOR_FUND_RESPONSE',
    );
    if (!response.ok || payload['error'] !== undefined || payload['result'] !== null) {
      throw new Error(`RUST_HUB_J_OPERATOR_FUND_FAILED:${safeStringify(payload)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
};

const fundNativeH1BootstrapReserves = async (
  entityId: string,
  signerId: string,
): Promise<void> => {
  const startedAt = Date.now();
  const primary = resolveMeshJurisdictionConfig(args.rpcUrl);
  const jurisdictions = [primary, ...resolveSecondaryJurisdictions(primary.rpc)];
  // Native H1 becomes ready before the TS hubs have necessarily published
  // their complete multi-jurisdiction Entity inventory. Funding from that
  // partial snapshot silently leaves H2/H3 reserves at zero. Wait for the
  // authoritative child /api/info rows; the reset stall detector owns the
  // deadline and any exited child fails the reset through the normal path.
  while (hubChildren.slice(1).some(child => (child.lastInfo?.hubEntities?.length ?? 0) === 0)) {
    await scheduler.wait(25);
  }
  const hubEntities = hubChildren.flatMap(child => child.lastInfo?.hubEntities ?? []);
  logNativeH1Bootstrap('bootstrap_funding_inventory_ready', {
    elapsedMs: Date.now() - startedAt,
    entities: new Set([entityId, ...hubEntities.map(entry => entry.entityId)]).size,
    jurisdictions: jurisdictions.length,
  });
  const targets = jurisdictions.map(jurisdiction => ({
    jurisdiction,
    entityIds: Array.from(new Set([
      ...(jurisdiction.name === primary.name ? [entityId] : []),
      ...hubEntities
        .filter(entry => String(entry.jurisdictionName || '').trim() === jurisdiction.name)
        .map(entry => String(entry.entityId || '').trim().toLowerCase())
        .filter(candidate => /^0x[0-9a-f]{64}$/.test(candidate)),
    ])),
  }));
  for (const { jurisdiction, entityIds } of targets) {
    if (entityIds.length === 0) continue;
    const rpcUrl = resolveLocalMarketMakerRpcUrl(jurisdiction.rpc);
    await fundLocalJOperator(rpcUrl, jurisdiction.chainId, signerId);
    const adapter: JAdapter = await createJAdapter({
      mode: 'rpc',
      chainId: jurisdiction.chainId,
      rpcUrl,
      fromReplica: {
        chainId: jurisdiction.chainId,
        name: jurisdiction.name,
        entityProviderDeploymentBlock: jurisdiction.entityProviderDeploymentBlock,
        contracts: { ...jurisdiction.contracts },
      },
    });
    logNativeH1Bootstrap('bootstrap_funding_adapter_ready', {
      elapsedMs: Date.now() - startedAt,
      jurisdiction: jurisdiction.name,
      entities: entityIds.length,
    });
    try {
    const catalog = await adapter.getTokenRegistry();
    logNativeH1Bootstrap('bootstrap_funding_catalog_ready', {
      elapsedMs: Date.now() - startedAt,
      jurisdiction: jurisdiction.name,
      tokens: catalog.length,
    });
    const configured = getTokenIdsForJurisdiction({
      name: jurisdiction.name,
      chainId: jurisdiction.chainId,
    });
    const desired = new Set(
      configured.length >= HUB_REQUIRED_TOKEN_COUNT
        ? configured
        : DEFAULT_ACCOUNT_TOKEN_IDS,
    );
    const selected = catalog.filter(token => desired.has(Number(token.tokenId)));
    const bootstrapCatalog = selected.length >= HUB_REQUIRED_TOKEN_COUNT
      ? selected
      : catalog.slice(0, HUB_REQUIRED_TOKEN_COUNT);
    if (bootstrapCatalog.length < HUB_REQUIRED_TOKEN_COUNT) {
      throw new Error(
        `RUST_HUB_TOKEN_CATALOG_INCOMPLETE:required=${HUB_REQUIRED_TOKEN_COUNT}:actual=${bootstrapCatalog.length}`,
      );
    }
    if (jurisdiction.name === primary.name) {
      nativeH1ReserveTargets = bootstrapCatalog.map((token: JTokenInfo) => ({
        tokenId: Number(token.tokenId),
        symbol: String(token.symbol || `token-${String(token.tokenId)}`),
        decimals: Number(token.decimals),
        expectedMin: getBootstrapTokenAmount(Number(token.tokenId), Number(token.decimals)),
      }));
    }
    const mints: Array<{ entityId: string; tokenId: number; amount: bigint }> = [];
    for (const targetEntityId of entityIds) {
      for (const token of bootstrapCatalog) {
        const tokenId = Number(token.tokenId);
        const expectedMin = getBootstrapTokenAmount(tokenId, Number(token.decimals));
        const current = await adapter.getReserves(targetEntityId, tokenId);
        if (current < expectedMin) {
          mints.push({
            entityId: targetEntityId,
            tokenId,
            amount: expectedMin - current,
          });
        }
      }
    }
    if (mints.length > 0) await adapter.debugFundReservesBatch(mints);
    logNativeH1Bootstrap('bootstrap_funding_mints_ready', {
      elapsedMs: Date.now() - startedAt,
      jurisdiction: jurisdiction.name,
      mints: mints.length,
    });
    } finally {
      await adapter.close();
    }
  }
};

const driveNativeH1Bootstrap = async (
  h1: HubChild,
  includeMarketMaker: boolean,
): Promise<void> => {
  if (h1.engine !== 'rust') return;
  const entityId = String(h1.lastInfo?.entityId || '').trim().toLowerCase();
  const signerId = String(h1.lastInfo?.hubEntities?.[0]?.signerId || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(entityId) || !/^0x[0-9a-f]{40}$/.test(signerId)) {
    throw new Error('RUST_HUB_BOOTSTRAP_IDENTITY_MISSING:H1');
  }
  const bootstrapStartedAt = Date.now();
  await configureNativeH1Entity(h1, entityId, signerId);
  await publishNativeHubProfile(h1);
  logNativeH1Bootstrap('bootstrap_policy_committed', {
    elapsedMs: Date.now() - bootstrapStartedAt,
    entityId,
  });
  await fundNativeH1BootstrapReserves(entityId, signerId);
  logNativeH1Bootstrap('bootstrap_reserves_funded', {
    elapsedMs: Date.now() - bootstrapStartedAt,
    entityId,
  });
  const hubPeers = hubChildren.slice(1).map(peer => ({
    name: peer.name,
    isHub: true,
    entityId: deriveManagedEntityIdentity({
      name: peer.name,
      seed: peer.seed,
      signerLabel: peer.signerLabel,
    }).entityId,
    tokenIds: [...DEFAULT_ACCOUNT_TOKEN_IDS] as number[],
  }));
  const primaryJurisdiction = resolveMeshJurisdictionConfig(args.rpcUrl).name;
  const supportPeers = includeMarketMaker ? getMarketMakerIdentities()
    .filter(peer => peer.jurisdictionName === primaryJurisdiction)
    .map(peer => {
    const configured = getTokenIdsForJurisdiction({
      name: peer.jurisdictionName,
      chainId: peer.chainId,
    });
    return {
      name: peer.name,
      isHub: false,
      entityId: peer.entityId,
      tokenIds: configured.length >= HUB_REQUIRED_TOKEN_COUNT
        ? configured
        : [...DEFAULT_ACCOUNT_TOKEN_IDS],
    };
    }) : [];
  const peers = [...hubPeers, ...supportPeers];
  let lastProgress = {
    complete: 0,
    observed: 0,
    ready: 0,
    awaitingHubCredit: 0,
  };
  let lastProgressLogAt = 0;
  while (resetState.inProgress && h1.proc && h1.exitCode === null && h1.exitSignal === null) {
    let complete = 0;
    let observed = 0;
    let ready = 0;
    let awaitingHubCredit = 0;
    for (const peer of peers) {
      const status = await readNativeAccountStatus(h1, entityId, peer.entityId, peer.tokenIds);
      if (!status) continue;
      observed += 1;
      const referenceToken = peer.tokenIds[0];
      const reference = referenceToken === undefined
        ? undefined
        : status.tokens.find(token => token.tokenId === referenceToken);
      const bilateralReady = status.hasAccount && status.ready && peer.tokenIds.every(tokenId => {
        const row = status.tokens.find(token => token.tokenId === tokenId);
        const target = getBootstrapCreditAmount(tokenId);
        return row !== undefined && BigInt(row.hubGranted) >= target && BigInt(row.peerGranted) >= target;
      });
      if (peer.isHub) {
        nativeH1MeshPairs.set(peer.entityId, {
          counterpartyId: peer.entityId,
          counterpartyName: peer.name,
          hasAccount: status.hasAccount,
          currentHeight: status.currentHeight,
          pendingFrameHeight: status.pendingFrameHeight,
          pendingFrameHash: null,
          grantedByMe: reference?.hubGranted ?? '0',
          grantedByPeer: reference?.peerGranted ?? '0',
          ready: bilateralReady,
        });
      }
      if (!status.hasAccount || !status.ready) continue;
      ready += 1;
      const missing = peer.tokenIds.filter(tokenId =>
        creditGrantedByNativeHub(status, tokenId) <
        getBootstrapCreditAmount(tokenId));
      if (missing.length > 0) {
        awaitingHubCredit += 1;
        logNativeH1Bootstrap('bootstrap_credit_submit', {
          counterpartyEntityId: peer.entityId,
          peer: peer.name,
          tokenIds: missing,
        });
        await submitNativeBootstrapCredit(h1, entityId, signerId, peer.entityId, missing);
        logNativeH1Bootstrap('bootstrap_credit_committed', {
          counterpartyEntityId: peer.entityId,
          peer: peer.name,
          tokenIds: missing,
        });
        continue;
      }
      if (bilateralReady) complete += 1;
    }
    lastProgress = { complete, observed, ready, awaitingHubCredit };
    if (Date.now() - lastProgressLogAt >= 1_000) {
      lastProgressLogAt = Date.now();
      logNativeH1Bootstrap('bootstrap_progress', {
        ...lastProgress,
        elapsedMs: Date.now() - bootstrapStartedAt,
        peers: peers.length,
      });
    }
    const reservesReady = h1.lastHealth?.bootstrapReserves?.targetMet === true;
    if (complete === peers.length && reservesReady) return;
    await scheduler.wait(50);
  }
  throw new Error(
    `RUST_HUB_BOOTSTRAP_STOPPED:complete=${lastProgress.complete}/${peers.length}` +
    `:observed=${lastProgress.observed}:ready=${lastProgress.ready}` +
    `:awaitingHubCredit=${lastProgress.awaitingHubCredit}`,
  );
};

const marketMakerPoller = createMarketMakerChildPoller({
  child: marketMakerChild,
  host: args.host,
  healthTimeoutMs: CHILD_HEALTH_TIMEOUT_MS,
  fullHealthTimeoutMs: MARKET_MAKER_FULL_HEALTH_TIMEOUT_MS,
  fetchJson: <T>(url: string, timeoutMs?: number) =>
    fetchJson<T>(url, timeoutMs, marketMakerChild.lastHealth === null),
});

const pollMarketMakerHealth = async (): Promise<void> => {
  await marketMakerPoller.pollHealth();
  if (marketMakerChild.lastHealth) {
    syncManagedRuntimeSecurityTelemetry(marketMakerChild.name, marketMakerChild.lastHealth);
    observeManagedRuntimeHalt(marketMakerChild, marketMakerChild.lastHealth);
  }
};
const fetchMarketMakerFullHealthForResponse = marketMakerPoller.fetchFullHealthForResponse;

let lastHealthResponseRefreshMs: number | null = null;
const refreshChildHealthForResponse = async (): Promise<void> => {
  const startedAt = Date.now();
  await Promise.race([
    Promise.allSettled([
      pollAllHubHealth(),
      pollMarketMakerHealth(),
    ]).then(() => undefined),
    scheduler.wait(HEALTH_RESPONSE_REFRESH_TIMEOUT_MS).then(() => undefined),
  ]);
  lastHealthResponseRefreshMs = Date.now() - startedAt;
};

const getHubSpecsArg = (): string => HUB_NAMES.join(',');

const {
  getMarketMakerIdentities,
  resolveLocalMarketMakerRpcUrl,
} = createMarketMakerIdentityResolver({
  args,
  marketMakerChild,
  requiredTokenCount: HUB_REQUIRED_TOKEN_COUNT,
});

const clearChildRestartTimer = (child: { restartTimer: ReturnType<typeof setTimeout> | null }): void => {
  if (!child.restartTimer) return;
  clearTimeout(child.restartTimer);
  child.restartTimer = null;
};

const managedSpecForHub = (child: HubChild): ManagedRuntimeSpec => ({
  role: 'hub',
  name: child.name,
  script: child.engine === 'rust'
    ? 'rscore/target/release/xlnrs'
    : 'core/orchestrator/hub-node.ts',
  apiPort: child.apiPort,
  dbPath: child.dbPath,
});

const managedSpecForMarketMaker = (): ManagedRuntimeSpec => ({
  role: 'market-maker',
  name: marketMakerChild.name,
  script: 'core/orchestrator/mm-node.ts',
  apiPort: marketMakerChild.apiPort,
  dbPath: marketMakerChild.dbPath,
});

const reapStaleHubProcess = async (child: HubChild, processTable?: ManagedProcessTableEntry[]): Promise<void> => {
  if (!staleReapEnabled) return;
  await managedRuntimeLeases.reapStale(managedSpecForHub(child), child.proc?.pid ?? -1, processTable);
};

const reapStaleMarketMakerProcess = async (processTable?: ManagedProcessTableEntry[]): Promise<void> => {
  if (!staleReapEnabled) return;
  await managedRuntimeLeases.reapStale(managedSpecForMarketMaker(), marketMakerChild.proc?.pid ?? -1, processTable);
};

const reapStaleManagedChildren = async (): Promise<void> => {
  if (!staleReapEnabled) return;
  const processTable = await readManagedProcessTable();
  await Promise.all(hubChildren.map(child => reapStaleHubProcess(child, processTable)));
  if (args.mmEnabled) {
    await reapStaleMarketMakerProcess(processTable);
  }
};

let fatalOrchestratorShutdownStarted = false;
let orchestratorShutdownStarted = false;
const controlledStopPids = new Set<number>();

const rememberControlledStop = (proc: ChildProcess | null): void => {
  if (typeof proc?.pid === 'number') {
    controlledStopPids.add(proc.pid);
  }
};

const consumeControlledStop = (pid: number | null | undefined): boolean => (
  typeof pid === 'number' ? controlledStopPids.delete(pid) : false
);

const failFastUnexpectedChildExit = (message: string): void => {
  if (fatalOrchestratorShutdownStarted) return;
  fatalOrchestratorShutdownStarted = true;
  meshLog.error('child.unexpected_exit', { message });
  void (async () => {
    try {
      await stopAllChildren();
    } catch (error) {
      meshLog.error('child.unexpected_exit.stop_failed', { error: serializeError(error) });
    } finally {
      process.exit(1);
    }
  })();
};

type RecoverableChild = HubChild | MarketMakerChild;
const managedChildFatalRoot = new Map<string, string>();

const persistManagedChildFailure = (
  child: RecoverableChild,
  observation: ChildFailureObservation,
  decision: ChildFailureDecision,
  action: ChildFailureReceipt['action'] = decision.action,
): string => {
  const receipt: ChildFailureReceipt = {
    schema: 'xln-child-failure-v1',
    recordedAt: new Date().toISOString(),
    role: observation.role,
    name: observation.name,
    pid: child.proc?.pid ?? null,
    code: observation.code,
    signal: observation.signal,
    reason: observation.reason,
    reasonCode: decision.reasonCode,
    fingerprint: decision.fingerprint,
    identicalFailureCount: decision.count,
    action,
    backoffMs: action === 'recover' ? decision.backoffMs : 0,
    startedAt: child.startedAt,
    exitedAt: child.exitedAt ?? Date.now(),
    reset: { ...resetState },
    codeFingerprint: orchestratorCodeFingerprint,
    lastHealth: child.lastHealth,
    lastInfo: child.lastInfo,
    recentStdout: [...child.recentStdout],
    recentStderr: [...child.recentStderr],
  };
  return persistChildFailureReceipt(childDiagnosticsDir, receipt, randomUUID()).receiptPath;
};

const persistedRuntimeHaltFingerprints = new Set<string>();

const pushManagedChildIncident = (
  child: RecoverableChild,
  code: string,
  message: string,
  details: Record<string, unknown>,
): string => {
  const runtimeId = String(child.lastHealth?.runtimeId || child.lastInfo?.runtimeId || '').trim() || undefined;
  const incident = pushDebugEvent(relayStore, {
    event: 'error',
    ...(managedChildFatalRoot.get(child.name)
      ? { rootFingerprint: managedChildFatalRoot.get(child.name) }
      : {}),
    runtimeId,
    status: 'fatal',
    reason: code,
    details: {
      source: 'orchestrator',
      severity: 'fatal',
      message,
      child: child.name,
      ...details,
    },
  });
  if (!incident) throw new Error(`MANAGED_CHILD_FATAL_INCIDENT_NOT_CLASSIFIED:${child.name}:${code}`);
  return incident.fingerprint;
};

const persistManagedChildFatalReport = (
  child: RecoverableChild,
  report: ManagedChildFatalReport,
): string => {
  const incident = pushDebugEvent(relayStore, {
    event: 'error',
    runtimeId: report.runtimeId || undefined,
    status: 'fatal',
    reason: report.code,
    details: {
      source: 'runtime',
      severity: 'fatal',
      message: report.message,
      child: child.name,
      height: report.height,
      timestamp: report.timestamp,
      transport: 'local-ipc',
    },
  });
  if (!incident) throw new Error(`MANAGED_CHILD_FATAL_INCIDENT_NOT_CLASSIFIED:${child.name}:${report.code}`);
  managedChildFatalRoot.set(child.name, incident.fingerprint);
  return incident.fingerprint;
};

const MANAGED_CHILD_ERROR_LINE_MAX = 8_192;
const MANAGED_CHILD_ERROR_MESSAGE_MAX = 2_000;

const captureManagedChildErrorLine = (child: RecoverableChild, line: string): void => {
  // One oversized child stderr record must not crash the orchestrator: the
  // previous path threw DEBUG_EVENT_TOO_LARGE out of the stream handler and
  // took down the whole mesh mid-E2E.
  const boundedLine = line.length > MANAGED_CHILD_ERROR_LINE_MAX
    ? line.slice(0, MANAGED_CHILD_ERROR_LINE_MAX)
    : line;
  const match = boundedLine.match(/^\[ERROR\]\[([^\]]+)\]\s+([^\s{]+)/);
  if (!match) return;
  const [, scope = 'runtime', phase = 'MANAGED_CHILD_ERROR'] = match;
  const jsonStart = boundedLine.indexOf('{', match[0].length);
  let structuredError = '';
  if (jsonStart >= 0) {
    try {
      const parsed = requireBoundaryRecord(JSON.parse(boundedLine.slice(jsonStart)), 'MANAGED_CHILD_ERROR_JSON_INVALID');
      const error = parsed['error'];
      const detail = parsed['message'];
      structuredError = String(error || detail || '').trim();
    } catch {
      structuredError = '';
    }
  }
  const message = (structuredError || phase).slice(0, MANAGED_CHILD_ERROR_MESSAGE_MAX);
  try {
    pushManagedChildIncident(child, normalizeRuntimeFailureCode(message), message, {
      scope,
      phase,
      truncated: line.length > MANAGED_CHILD_ERROR_LINE_MAX,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    meshLog.warn('managed_child.error_line_incident_dropped', {
      child: child.name,
      scope,
      phase,
      reason: reason.slice(0, 500),
    });
  }
};

const observeManagedRuntimeHalt = (
  child: RecoverableChild,
  health: { runtime?: { halted?: boolean; fatalDebugPayload?: unknown } },
): void => {
  if (health.runtime?.halted !== true) return;
  const reason = safeStringify(health.runtime.fatalDebugPayload ?? { message: 'RUNTIME_HALTED' });
  const observation: ChildFailureObservation = {
    role: child === marketMakerChild ? 'market-maker' : 'hub',
    name: child.name,
    code: null,
    signal: null,
    reason,
  };
  const decision = decideChildFailure({}, observation);
  if (persistedRuntimeHaltFingerprints.has(decision.fingerprint)) return;
  const receiptPath = persistManagedChildFailure(child, observation, decision, 'fail-stop');
  persistedRuntimeHaltFingerprints.add(decision.fingerprint);
  meshLog.error('runtime.halted', {
    child: child.name,
    receiptPath,
    fatal: health.runtime.fatalDebugPayload ?? null,
  });
  pushManagedChildIncident(child, 'RUNTIME_HALTED', reason, {
    receiptPath,
    fatal: health.runtime.fatalDebugPayload ?? null,
  });
};

const persistOrchestratorFailure = (error: unknown): string => {
  const exitedAt = Date.now();
  const reason = serializeError(error);
  const observation: ChildFailureObservation = {
    role: 'orchestrator',
    name: 'mesh-orchestrator',
    code: 1,
    signal: null,
    reason,
  };
  const decision = decideChildFailure({}, observation);
  const receipt: ChildFailureReceipt = {
    schema: 'xln-child-failure-v1',
    recordedAt: new Date(exitedAt).toISOString(),
    ...observation,
    pid: process.pid,
    reasonCode: decision.reasonCode,
    fingerprint: decision.fingerprint,
    identicalFailureCount: decision.count,
    action: 'fail-stop',
    backoffMs: 0,
    startedAt: null,
    exitedAt,
    reset: { ...resetState },
    codeFingerprint: orchestratorCodeFingerprint,
    lastHealth: null,
    lastInfo: null,
    recentStdout: [],
    recentStderr: [error instanceof Error && error.stack ? error.stack : reason],
  };
  return persistChildFailureReceipt(childDiagnosticsDir, receipt, randomUUID()).receiptPath;
};

const handleUnexpectedHubFailure = (
  child: HubChild,
  observation: ChildFailureObservation,
): void => {
  if (fatalOrchestratorShutdownStarted) return;
  const decision = decideChildFailure(child.failureCounts, observation);
  child.failureCounts = decision.counts;
  let receiptPath: string;
  try {
    receiptPath = persistManagedChildFailure(child, observation, decision);
  } catch (error) {
    const diagnosticError = serializeError(error);
    meshLog.error('child.failure_receipt_write_failed', {
      child: child.name,
      error: diagnosticError,
      originalFailure: observation.reason,
    });
    failFastUnexpectedChildExit(`${child.name} diagnostics persistence failed: ${diagnosticError}`);
    return;
  }
  meshLog.error('child.unexpected_exit', {
    child: child.name,
    code: observation.code,
    signal: observation.signal,
    reasonCode: decision.reasonCode,
    fingerprint: decision.fingerprint,
    identicalFailureCount: decision.count,
    action: decision.action,
    receiptPath,
  });
  pushManagedChildIncident(child, decision.reasonCode, observation.reason, {
    code: observation.code,
    signal: observation.signal,
    fingerprint: decision.fingerprint,
    identicalFailureCount: decision.count,
    action: decision.action,
    receiptPath,
  });
  if (decision.action === 'fail-stop') {
    failFastUnexpectedChildExit(
      `${child.name} repeated ${decision.reasonCode} ${decision.count} times; receipt=${receiptPath}`,
    );
    return;
  }

  child.recoveryInProgress = true;
  child.restartTimer = setTimeout(() => {
    child.restartTimer = null;
    void spawnHub(child).then(async () => {
      await waitForHubSelfReady(child);
      await publishNativeHubProfile(child);
      child.recoveryInProgress = false;
      meshLog.info('child.respawned_from_checkpoint', {
        child: child.name,
        fingerprint: decision.fingerprint,
        identicalFailureCount: decision.count,
        receiptPath,
      });
    }).catch(async (error) => {
      if (child.recoveryInProgress && child.restartTimer) return;
      const failedProc = child.proc;
      child.proc = null;
      rememberControlledStop(failedProc);
      await stopProcess(failedProc);
      child.recoveryInProgress = false;
      handleUnexpectedHubFailure(child, {
        role: 'hub',
        name: child.name,
        code: null,
        signal: null,
        reason: `HUB_RECOVERY_SPAWN_FAILED:${serializeError(error)}`,
      });
    });
  }, decision.backoffMs);
};

const waitForMarketMakerSelfReady = async (): Promise<void> => {
  const startedAt = Date.now();
  while (true) {
    await pollMarketMakerHealth();
    if (marketMakerChild.lastInfo !== null || marketMakerChild.lastHealth !== null) {
      return;
    }
    if (marketMakerChild.proc?.exitCode !== null || marketMakerChild.proc?.signalCode !== null) {
      throw new Error(
        `MM_SELF_READY_EXITED_EARLY code=${String(marketMakerChild.proc?.exitCode)} ` +
        `stderr=${safeStringify(marketMakerChild.recentStderr.slice(-8))}`,
      );
    }
    if (Date.now() - startedAt > STARTUP_TIMEOUT_MS) {
      throw new Error('MM_SELF_READY_TIMEOUT');
    }
    await scheduler.wait(250);
  }
};

const handleUnexpectedMarketMakerFailure = (
  observation: ChildFailureObservation,
): void => {
  if (fatalOrchestratorShutdownStarted) return;
  const decision = decideChildFailure(marketMakerChild.failureCounts, observation);
  marketMakerChild.failureCounts = decision.counts;
  let receiptPath: string;
  try {
    receiptPath = persistManagedChildFailure(
      marketMakerChild,
      observation,
      decision,
      resetState.inProgress && decision.action === 'recover' ? 'recover' : undefined,
    );
  } catch (error) {
    const diagnosticError = serializeError(error);
    meshLog.error('child.failure_receipt_write_failed', {
      child: marketMakerChild.name,
      error: diagnosticError,
      originalFailure: observation.reason,
    });
    failFastUnexpectedChildExit(`MM diagnostics persistence failed: ${diagnosticError}`);
    return;
  }
  meshLog.error('child.unexpected_exit', {
    child: marketMakerChild.name,
    code: observation.code,
    signal: observation.signal,
    reasonCode: decision.reasonCode,
    fingerprint: decision.fingerprint,
    identicalFailureCount: decision.count,
    action: decision.action,
    receiptPath,
  });
  pushManagedChildIncident(
    marketMakerChild,
    decision.reasonCode,
    observation.reason,
    {
      code: observation.code,
      signal: observation.signal,
      fingerprint: decision.fingerprint,
      identicalFailureCount: decision.count,
      action: decision.action,
      receiptPath,
    },
  );
  if (decision.action === 'fail-stop') {
    failFastUnexpectedChildExit(
      `MM repeated ${decision.reasonCode} ${decision.count} times; receipt=${receiptPath}`,
    );
    return;
  }
  // Reset owns MM lifecycle — do not race a supervised respawn into stopAllChildren.
  if (resetState.inProgress) return;

  scheduleMarketMakerRecoverySpawn({
    marketMakerChild,
    fencingGraceMs: MARKET_MAKER_RESTART_FENCING_GRACE_MS,
    backoffMs: decision.backoffMs,
    shouldAbortSpawn: () => shouldAbortMarketMakerSpawn({
      fatalShutdown: fatalOrchestratorShutdownStarted,
      orchestratorShutdown: orchestratorShutdownStarted,
      resetInProgress: resetState.inProgress,
    }),
    spawnMarketMaker,
    waitForMarketMakerSelfReady,
    rememberControlledStop: (proc) => rememberControlledStop(proc ?? null),
    stopProcess: async (proc) => stopProcess(proc ?? null),
    onSpawned: () => {
      meshLog.info('child.respawned_from_checkpoint', {
        child: marketMakerChild.name,
        fingerprint: decision.fingerprint,
        identicalFailureCount: decision.count,
        receiptPath,
      });
    },
    onSpawnFailed: (error) => {
      handleUnexpectedMarketMakerFailure({
        role: 'market-maker',
        name: marketMakerChild.name,
        code: null,
        signal: null,
        reason: `MM_RECOVERY_SPAWN_FAILED:${serializeError(error)}`,
      });
    },
  });
};

const buildSecondaryRpcArgs = (): string[] => {
  const result: string[] = [];
  for (let index = 2; index <= 8; index += 1) {
    const url = args.rpcUrls[index];
    if (url) result.push(`--rpc${index}-url`, url);
  }
  return result;
};

const buildRpcChildEnv = (): Record<string, string> => {
  const result: Record<string, string> = {};
  for (let index = 1; index <= 8; index += 1) {
    const url = args.rpcUrls[index];
    if (!url) continue;
    result[index === 1 ? 'ANVIL_RPC' : `ANVIL_RPC${index}`] = url;
  }
  return result;
};

const resetSupervisedChildForSpawn = (child: HubChild | MarketMakerChild): void => {
  child.startedAt = Date.now();
  child.exitedAt = null;
  child.exitCode = null;
  child.exitSignal = null;
  child.restartCount += 1;
  child.lastHealth = null;
  child.lastInfo = null;
  child.recentStdout = [];
  child.recentStderr = [];
  managedChildFatalRoot.delete(child.name);
};

const spawnHub = createHubSpawner({
  args,
  relayUrl,
  shardJurisdictionsPath,
  orchestratorOwnerId,
  startupTimeoutMs: STARTUP_TIMEOUT_MS,
  hubChildren,
  marketMakerChild,
  getHubSpecsArg,
  getMarketMakerIdentities,
  runtimeSeedFor,
  buildSecondaryRpcArgs,
  buildRpcChildEnv,
  managedSpecForHub,
  reapStaleHubProcess,
  resetSupervisedChildForSpawn,
  managedRuntimeLeases,
  persistManagedChildFatalReport,
  captureManagedChildErrorLine,
  consumeControlledStop,
  isOrchestratorShutdownStarted: () => orchestratorShutdownStarted,
  handleUnexpectedHubFailure,
});
const spawnMarketMaker = createMarketMakerSpawner({
  args,
  relayUrl,
  shardJurisdictionsPath,
  orchestratorOwnerId,
  startupTimeoutMs: STARTUP_TIMEOUT_MS,
  marketMakerChild,
  buildSecondaryRpcArgs,
  buildRpcChildEnv,
  getHubSpecsArg,
  managedSpecForMarketMaker,
  reapStaleMarketMakerProcess,
  resetSupervisedChildForSpawn,
  managedRuntimeLeases,
  persistManagedChildFatalReport,
  captureManagedChildErrorLine,
  consumeControlledStop,
  isOrchestratorShutdownStarted: () => orchestratorShutdownStarted,
  handleUnexpectedMarketMakerFailure,
});

const stopAllChildren = async (options: StopAllChildrenOptions = {}): Promise<void> => {
  for (const child of hubChildren) {
    clearChildRestartTimer(child);
    child.recoveryInProgress = false;
  }
  clearChildRestartTimer(marketMakerChild);
  marketMakerChild.recoveryInProgress = false;
  const ownedLiveChildren = hubChildren.filter((child) =>
    child.proc && child.proc.exitCode === null && child.proc.signalCode === null
  );
  const ownedLiveMarketMaker = marketMakerChild.proc &&
    marketMakerChild.proc.exitCode === null &&
    marketMakerChild.proc.signalCode === null
    ? marketMakerChild
    : null;
  const quiesceRounds = options.quiesceRounds ?? 2;
  const quiesceTimeoutMs = options.quiesceTimeoutMs ?? CHILD_RESET_QUIESCE_TIMEOUT_MS;
  const quiescePauseMs = options.quiescePauseMs ?? 150;
  const quiesceUrls = [
    ...ownedLiveChildren.map((child) => `http://${args.host}:${child.apiPort}/api/control/core/quiesce`),
    ...(ownedLiveMarketMaker ? [`http://${args.host}:${ownedLiveMarketMaker.apiPort}/api/control/core/quiesce`] : []),
  ];
  // Initial reset often has no owned children yet. Do not probe random old listeners on the same ports.
  for (let round = 0; round < quiesceRounds && quiesceUrls.length > 0; round += 1) {
    await Promise.all(quiesceUrls.map((url) => postJson(url, quiesceTimeoutMs)));
    await scheduler.wait(quiescePauseMs);
  }

  const hubProcs = hubChildren.map((child) => {
    const proc = child.proc;
    child.proc = null;
    return proc;
  });
  const mmProc = marketMakerChild.proc;
  marketMakerChild.proc = null;
  marketMakerChild.lastHealth = null;
  marketMakerChild.lastInfo = null;
  marketMakerChild.lastStartupPhase = null;
  const currentCustody = custodySupport;
  custodySupport = null;

  for (const proc of hubProcs) rememberControlledStop(proc);
  rememberControlledStop(mmProc);

  await Promise.all([
    ...hubProcs.map((proc) => stopProcess(proc)),
    stopProcess(mmProc),
    currentCustody ? stopManagedChild(currentCustody.custodyChild) : Promise.resolve(),
    currentCustody ? stopManagedChild(currentCustody.daemonChild) : Promise.resolve(),
  ]);
  for (const child of hubChildren) managedRuntimeLeases.removeLease(managedSpecForHub(child));
  managedRuntimeLeases.removeLease(managedSpecForMarketMaker());
};

const buildProcessHealth = createProcessHealthBuilder({
  hubChildren,
  marketMakerChild,
  ownerId: orchestratorOwnerId,
  managedSpecForHub,
  managedSpecForMarketMaker,
  readLease: (spec) => managedRuntimeLeases.readLease(spec),
});

const {
  buildBootstrapTimeline,
  readLastMarketMakerBootstrapEvent,
} = createBootstrapTimelineTools({
  getLastHealthResponseRefreshMs: () => lastHealthResponseRefreshMs,
  isRecord,
  marketMakerChild,
  resetState,
  timings,
  toFiniteNumber,
  warnTailRead: warnBootstrapTailRead,
});

const buildCurrentBootstrapTimeline = createCurrentBootstrapTimelineBuilder(
  buildBootstrapTimeline,
  HUB_NAMES.length,
);

const resolveCurrentCapabilityHealthForMesh = () => resolveCurrentCapabilityHealth(
  marketMakerChild,
  custodySupport,
  activeResetOptions,
  pendingResetOptions,
  resetState.inProgress,
);

const computeAggregatedHealth = (options: {
  marketMakerHealthOverride?: MarketMakerHealthPayload | null | undefined;
} = {}): AggregatedHealth => {
  const storage = getStorageHealthSnapshotSync();
  const marketMakerHealth = normalizeMarketMakerHealthPayload(options.marketMakerHealthOverride ?? marketMakerChild.lastHealth);
  const normalizedRelayClientIds = Array.from(relayStore.clients.keys())
    .map(normalizeRuntimeKey)
    .filter(Boolean);
  const {
    managedRuntimeIds,
    relayClientIds,
    externalClientIds,
  } = collectManagedRelayClients(
    hubChildren,
    marketMakerChild,
    marketMakerHealth,
    normalizedRelayClientIds,
  );
  const hubs = buildAggregatedHubHealth(
    hubChildren,
    new Set(normalizedRelayClientIds),
    args.host,
  );
  const hubIds = hubs
    .map(hub => hub.entityId.toLowerCase())
    .filter(entityId => entityId.length > 0);
  const { pairs: pairSet, directLinks: directLinkMap } =
    collectAggregatedHubMesh(hubChildren, HUB_MESH_CREDIT_AMOUNT);
  const reserveEntities = collectBootstrapReserveEntities(hubChildren);
  const capabilityHealth = resolveCurrentCapabilityHealthForMesh();
  const marketMakerActive = capabilityHealth.marketMakerActive;
  const marketMakerBootstrapEvent = readLastMarketMakerBootstrapEvent();
  const eventStartupPhase = String(marketMakerBootstrapEvent?.stage || '').trim() || null;
  const mmStartupPhase = eventStartupPhase || marketMakerChild.lastStartupPhase;
  const mmEntityId = marketMakerActive
    ? String(marketMakerChild.lastInfo?.entityId || marketMakerHealth?.entityId || '').trim() || null
    : null;
  const aggregatedMarketMakerHealth = buildAggregatedMarketMakerHealth({
    mmEnabled: capabilityHealth.marketMakerEnabled,
    marketMakerActive,
    marketMakerHealth,
    hubEntityIds: hubIds,
    expectedHubCount: HUB_NAMES.length,
    entityId: mmEntityId,
    startupPhase: mmStartupPhase,
  });
  const mmOk = aggregatedMarketMakerHealth.ok;
  const hubsOnline = hubs.length === HUB_NAMES.length && hubs.every((hub) => hub.online);
  const hubMeshOk =
    hubsOnline &&
    hubIds.length === HUB_NAMES.length &&
    areHubChildrenReady(hubChildren);
  const custodyOk = capabilityHealth.custodyOk;
  const bootstrapReservesOk =
    reserveEntities.length >= HUB_NAMES.length &&
    reserveEntities.every((entity) => entity.ready);
  const bootstrapReserveTargetsMet =
    reserveEntities.length >= HUB_NAMES.length &&
    reserveEntities.every((entity) => entity.targetMet);
  const resetOk = deriveResetHealthOk(resetState);
  const { coreOk, systemOk, degraded } = deriveAggregatedSystemStatus({
    storageOk: storage.ok,
    hubsOnline,
    hubMeshOk,
    resetOk,
    marketMakerOk: mmOk,
    custodyOk,
    bootstrapReservesOk,
    bootstrapReserveTargetsMet,
  });
  const failures = buildRuntimeHealthFailures(degraded).map(failure =>
    failure.code === 'MARKET_MAKER_NOT_READY' && aggregatedMarketMakerHealth.failure
      ? aggregatedMarketMakerHealth.failure
      : failure
  );
  const sourceHeights = [
    ...hubChildren.map(child => Number(child.lastHealth?.height || 0)),
    Number(marketMakerHealth?.height || 0),
  ].filter(height => Number.isFinite(height) && height > 0);
  const bootstrapTimeline = buildCurrentBootstrapTimeline({
    storageOk: storage.ok,
    resetOk,
    hubs,
    hubsOnline,
    hubMeshOk,
    directOpenLinks: directLinkMap.size,
    capabilities: capabilityHealth,
    marketMakerActive,
    marketMaker: aggregatedMarketMakerHealth,
    marketMakerStartupPhase: mmStartupPhase,
    bootstrapReservesOk,
    bootstrapReserveTargetsMet,
    reserveEntityCount: reserveEntities.length,
  });
  const relay = buildAggregatedRelayHealth(
    relayClientIds,
    managedRuntimeIds,
    externalClientIds,
    marketSubscriptionStack.snapshot(),
  );
  const hubMesh = buildAggregatedHubMeshHealth(
    hubMeshOk,
    hubIds,
    { pairs: pairSet, directLinks: directLinkMap },
  );
  const custody = buildAggregatedCustodyHealth(
    capabilityHealth.custodyEnabled,
    custodyOk,
    custodySupport?.identity.entityId ?? null,
    args.custodyDaemonPort,
    args.custodyPort,
  );
  const bootstrapReserves = buildAggregatedBootstrapReserveHealth(
    bootstrapReservesOk,
    bootstrapReserveTargetsMet,
    HUB_REQUIRED_TOKEN_COUNT,
    reserveEntities,
  );

  return {
    timestamp: Date.now(),
    source: {
      height: sourceHeights.length > 0 ? Math.max(...sourceHeights) : null,
      ...orchestratorCodeFingerprint,
      owner: 'orchestrator',
    },
    coreOk,
    systemOk,
    degraded,
    failures,
    reset: { ...resetState },
    system: {
      runtime: true,
      relay: true,
    },
    relay,
    process: buildProcessHealth(),
    disk: buildDiskSummary(storage),
    storage,
    hubMesh,
    marketMaker: aggregatedMarketMakerHealth,
    bootstrapTimeline,
    custody,
    bootstrapReserves,
    hubs,
    timings,
  };
};

const fetchRouteMarketSnapshots = async (
  hubEntityId: string,
  pairIds: string[],
): Promise<Map<string, MarketSnapshotOrderDepth>> => {
  const child = getHubChildByEntityId(hubEntityId);
  if (!child || pairIds.length === 0) return new Map();
  if (child.proc?.exitCode !== null || child.proc?.signalCode !== null || !child.lastHealth) return new Map();
  let snapshots: MarketSnapshotPayload[];
  try {
    snapshots = await fetchHubMarketSnapshots(child, hubEntityId, pairIds, 20);
  } catch (error) {
    meshLog.warn('market_snapshot.enrichment_unavailable', {
      hubEntityId,
      error: serializeError(error),
    });
    return new Map();
  }
  return new Map(snapshots.map((snapshot) => [
    snapshot.pairId,
    countMarketSnapshotOrderDepth(snapshot),
  ]));
};

const recomputeHealthWithMarketMaker = createHealthRecomputer(details => {
  meshLog.warn('health.system_ok_blocked_by_cross_only', details);
});

const enrichMarketMakerFromHubSnapshots = async (health: AggregatedHealth): Promise<AggregatedHealth> => {
  const marketMaker = await buildPublicMarketMakerHealth(
    health.marketMaker,
    fetchRouteMarketSnapshots,
  );
  return recomputeHealthWithMarketMaker({ ...health, marketMaker }, marketMaker);
};

type CustodyMePayload = {
  custody?: {
    entityId?: string | null;
  };
};

const buildAggregatedHealthResponse = async (
  options: {
    includeMarketSnapshots?: boolean;
    marketMakerHealthOverride?: MarketMakerHealthPayload | null | undefined;
  } = {},
): Promise<AggregatedHealth> => {
  const baseHealth = computeAggregatedHealth({
    marketMakerHealthOverride: options.marketMakerHealthOverride,
  });
  const health = options.includeMarketSnapshots
    ? await enrichMarketMakerFromHubSnapshots(baseHealth)
    : baseHealth;
  if (!health.custody.enabled || health.custody.ok || !health.custody.servicePort) {
    return health;
  }

  const custodyBootstrapPending = custodySupport === null;
  const liveCustody =
    await fetchJson<CustodyMePayload>(
      `https://127.0.0.1:${health.custody.servicePort}/api/me`,
      1_500,
      custodyBootstrapPending,
    )
    ?? await fetchJson<CustodyMePayload>(
      `http://127.0.0.1:${health.custody.servicePort}/api/me`,
      1_500,
      custodyBootstrapPending,
    );
  const liveEntityId = String(liveCustody?.custody?.entityId || '').trim();
  if (!liveEntityId) {
    return health;
  }

  const nextHealth = {
    ...health,
    custody: {
      ...health.custody,
      ok: true,
      entityId: liveEntityId,
    },
  };
  return recomputeHealthWithMarketMaker(nextHealth, nextHealth.marketMaker);
};

const {
  buildRuntimeImportManifest,
  clearRuntimeImportManifestFile,
  publishRuntimeImportManifest,
  resolveWalletRuntimeImportUrl,
} = createRuntimeImportController({
  publicWsBaseUrl: args.publicWsBaseUrl,
  walletUrl: args.walletUrl,
  custodyDaemonPort: args.custodyDaemonPort,
  custodyPublicRpcUrl: custodyPublicRpcUrlEnv,
  manifestPath: runtimeImportManifestPath,
  exposeUrl: runtimeImportLogUrlEnabled,
  tokenTtlMs: runtimeImportTokenTtlMs,
  refreshMarginMs: runtimeImportRefreshMarginMs,
  hubChildren,
  marketMakerChild,
  getActiveResetOptions: () => activeResetOptions,
  getCustodySupport: () => custodySupport,
  buildAggregatedHealthResponse,
  warnRefreshFailed: error => {
    meshLog.warn('runtime_import_manifest.refresh_failed', { error: serializeError(error) });
  },
});

const reportBaselineWait = createBaselineWaitReporter(HUB_BASELINE_STATUS_LOG_INTERVAL_MS);

/**
 * A direct link is one WebSocket, and only the dialing side registers it: a
 * peer this runtime never dialed is served over its inbound socket and never
 * appears in `directPeers`. Mesh bootstrap dials from the left side of each
 * account pair, so a fully connected mesh of n hubs settles at n*(n-1)/2 open
 * links, not n*(n-1). Counting directed edges makes the requirement unreachable.
 * Count unordered pairs so the gate asks for connectivity, not for both sides
 * to have happened to dial.
 */

const waitForHubBaseline = async (): Promise<void> => {
  const hubCount = HUB_NAMES.length;
  const directRequired = (hubCount * Math.max(0, hubCount - 1)) / 2;
  const baselineStartedAt = Date.now();
  let lastReportedAt = baselineStartedAt;
  let lastStatus: Record<string, unknown> | null = null;
  let progressState: HubBaselineProgressState = {};
  while (true) {
    await pollAllHubHealth();
    const now = Date.now();
    const progress = evaluateHubBaselineDeadlines(hubChildren.map(child => ({
      name: child.name,
      health: child.lastHealth,
    })), progressState, now, HUB_BASELINE_STALL_TIMEOUT_MS);
    progressState = progress.state;
    const health = computeAggregatedHealth();
    const coreReady =
      health.hubMesh.ok &&
      health.bootstrapReserves.ok &&
      health.hubs.every(hub => hub.online);
    const directOpen = openDirectHubPairCount(health);
    const directReady = directOpen >= directRequired;
    lastStatus = {
      coreReady,
      directReady,
      directOpen,
      directRequired,
      bootstrapReserves: health.bootstrapReserves.ok,
      hubsOnline: health.hubs.map(hub => ({ name: hub.name, online: hub.online, selfRelayPresence: hub.selfRelayPresence })),
      degraded: health.degraded,
    };
    lastReportedAt = reportBaselineWait(baselineStartedAt, lastReportedAt, now, lastStatus);
    if (coreReady && directReady) {
      console.log(
        `[MESH] baseline ready: direct=${directOpen}/${directRequired} elapsedMs=${Date.now() - baselineStartedAt}`,
      );
      return;
    }
    if (progress.stalledNames.length > 0) {
      const stalled = Object.fromEntries(progress.stalledNames.map(name => [
        name,
        progress.evaluations[name],
      ]));
      throw new Error(
        `HUB_BASELINE_STALLED hubs=${progress.stalledNames.join(',')} ` +
        `timeoutMs=${HUB_BASELINE_STALL_TIMEOUT_MS} progress=${safeStringify(stalled)} ` +
        `status=${safeStringify(lastStatus)} health=${safeStringify(health)}`,
      );
    }
    await scheduler.wait(250);
  }
};

const waitForMarketMakerReady = async (): Promise<void> => {
  let restartAttempts = 0;
  let publicDepthSignature = '';
  let publicDepthLastProgressAt = Date.now();
  // The MM child owns the progress-aware bootstrap watchdog. A second absolute
  // deadline here used to kill healthy bootstraps that were still advancing,
  // discard their in-memory work, and restart the same phase from zero.
  while (true) {
    await pollMarketMakerHealth();
    const internalHealth = computeAggregatedHealth();
    const health = internalHealth.marketMaker.ok
      ? await enrichMarketMakerFromHubSnapshots(internalHealth)
      : internalHealth;
    const exitedHub = getExitedHubChild();
    if (exitedHub) {
      throw new Error(
        `HUB_EXITED_DURING_MM_READY name=${exitedHub.name} code=${String(exitedHub.exitCode ?? exitedHub.proc?.exitCode)} ` +
        `stderr=${safeStringify(exitedHub.recentStderr.slice(-8))}`,
      );
    }
    if (marketMakerChild.exitCode !== null || marketMakerChild.exitSignal !== null) {
      // Supervised recovery already owns the respawn; do not race a second spawn.
      if (marketMakerChild.recoveryInProgress) {
        await scheduler.wait(250);
        continue;
      }
      if (restartAttempts < marketMakerReadyRestartLimit) {
        restartAttempts += 1;
        console.warn(
          `[MESH] restarting MM during readiness attempt=${restartAttempts}/${marketMakerReadyRestartLimit} ` +
          `code=${String(marketMakerChild.exitCode)} signal=${String(marketMakerChild.exitSignal)} ` +
          `phase=${String(marketMakerChild.lastStartupPhase)}`,
        );
        // A crashed writer may leave a valid lease behind until its fencing TTL
        // expires. Reusing the namespace sooner would correctly fail closed and
        // waste the retry, so wait out the lease before spawning its successor.
        await scheduler.wait(MARKET_MAKER_RESTART_FENCING_GRACE_MS);
        if (shouldAbortMarketMakerSpawn({
          fatalShutdown: fatalOrchestratorShutdownStarted,
          orchestratorShutdown: orchestratorShutdownStarted,
          resetInProgress: resetState.inProgress,
        })) {
          return;
        }
        await spawnMarketMaker();
        await scheduler.wait(500);
        continue;
      }
      throw new Error(
        `MM_EXITED_EARLY code=${String(marketMakerChild.exitCode)} signal=${String(marketMakerChild.exitSignal)} phase=${String(marketMakerChild.lastStartupPhase)} marketMaker=${safeStringify(health.marketMaker)}`,
      );
    }
    if (
      !args.mmEnabled ||
      health.marketMaker.ok
    ) {
      return;
    }
    if (internalHealth.marketMaker.ok) {
      const publicDepth = {
        hubs: health.marketMaker.hubs.map(hub => ({
          hubEntityId: hub.hubEntityId,
          pairs: hub.pairs.map(pair => ({
            pairId: pair.pairId,
            bids: pair.bidOffers ?? 0,
            asks: pair.askOffers ?? 0,
          })),
        })),
        cross: health.marketMaker.cross.routes.map(route => ({
          sourceHubEntityId: route.sourceHubEntityId,
          targetHubEntityId: route.targetHubEntityId,
          pairs: (route.pairs ?? []).map(pair => ({
            pairId: pair.pairId,
            bids: pair.bidOffers ?? 0,
            asks: pair.askOffers ?? 0,
          })),
        })),
      };
      const nextSignature = safeStringify(publicDepth);
      const now = Date.now();
      if (nextSignature !== publicDepthSignature) {
        publicDepthSignature = nextSignature;
        publicDepthLastProgressAt = now;
      } else if (now - publicDepthLastProgressAt >= MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS) {
        throw new Error(
          `MARKET_MAKER_PUBLICATION_STALLED:idleMs=${now - publicDepthLastProgressAt}:` +
          `depth=${nextSignature}:health=${safeStringify(health.marketMaker)}`,
        );
      }
    }
    await scheduler.wait(250);
  }
};

const waitForHubSelfReady = async (child: HubChild): Promise<void> => {
  const startedAt = Date.now();
  while (true) {
    await pollHubHealth(child);
    if (child.lastInfo !== null || child.lastHealth !== null) {
      return;
    }
    if (child.proc?.exitCode !== null || child.proc?.signalCode !== null) {
      throw new Error(`${child.name}_SELF_READY_EXITED_EARLY code=${String(child.proc?.exitCode)} stderr=${safeStringify(child.recentStderr.slice(-8))}`);
    }
    const idleMs = Date.now() - startedAt;
    if (idleMs >= HUB_BASELINE_TIMEOUT_MS) {
      throw new Error(
        `${child.name}_SELF_READY_TIMEOUT idleMs=${idleMs} ` +
        `timeoutMs=${HUB_BASELINE_TIMEOUT_MS} stderr=${safeStringify(child.recentStderr.slice(-8))}`,
      );
    }
    await scheduler.wait(250);
  }
};

const waitForShardJurisdictions = async (child: HubChild): Promise<void> => {
  let progress = { signature: '', lastProgressAt: Date.now() };
  let lastStatus: Record<string, unknown> = {};
  while (true) {
    const hasRpc2 = hasShardRpc2Jurisdiction(jurisdictionsConfig);
    const primary = resolvePrimaryHubJurisdiction(jurisdictionsConfig);
    let contracts: RpcContractAddresses | null = null;
    if (primary) {
      const payload = requireBoundaryRecord(
        JSON.parse(readShardJurisdictions(jurisdictionsConfig)),
        'SHARD_JURISDICTIONS_INVALID',
      );
      const jurisdictions = requireBoundaryRecord(payload['jurisdictions'], 'SHARD_JURISDICTIONS_ENTRIES_INVALID');
      const entryRaw = jurisdictions[primary.key];
      if (entryRaw !== undefined) {
        const entry = requireBoundaryRecord(entryRaw, `SHARD_JURISDICTION_INVALID:${primary.key}`);
        const rawContracts = entry['contracts'];
        if (rawContracts !== undefined) {
          const record = requireBoundaryRecord(rawContracts, `SHARD_JURISDICTION_CONTRACTS_INVALID:${primary.key}`);
          const allowed = ['account', 'depository', 'entityProvider', 'deltaTransformer'] as const;
          if (Object.keys(record).some(key => !allowed.some(allowedKey => allowedKey === key)) ||
              Object.values(record).some(value => typeof value !== 'string')) {
            throw new Error(`SHARD_JURISDICTION_CONTRACTS_INVALID:${primary.key}`);
          }
          contracts = Object.fromEntries(allowed.flatMap(key => {
            const address = record[key];
            return address === undefined ? [] : [[key, address] as const];
          }));
        }
      }
    }
    let missingCode: string[] = ['primary:unavailable'];
    let probeError = '';
    if (contracts) {
      try {
        missingCode = await findMissingRpcContractCode(args.rpcUrl, contracts);
      } catch (error) {
        probeError = serializeError(error);
      }
    }
    missingCode = [...missingCode].sort(compareStableText);
    lastStatus = { hasRpc2, primary: primary?.key ?? null, missingCode, probeError };
    if (hasRpc2 && missingCode.length === 0 && !probeError) {
      return;
    }
    if (!child.recoveryInProgress && (child.proc?.exitCode !== null || child.proc?.signalCode !== null)) {
      throw new Error(
        `${child.name}_EXITED_BEFORE_JURISDICTIONS code=${String(child.proc?.exitCode)} status=${safeStringify(lastStatus)}`,
      );
    }
    const signature = safeStringify({
      hasRpc2,
      primary: primary?.key ?? null,
      missingCode,
    });
    const evaluation = evaluateBootstrapProgressDeadline(
      progress,
      signature,
      Date.now(),
      HUB_BASELINE_STALL_TIMEOUT_MS,
    );
    progress = {
      signature: evaluation.signature,
      lastProgressAt: evaluation.lastProgressAt,
    };
    if (evaluation.stalled) {
      throw new Error(
        `${child.name}_JURISDICTIONS_STALLED idleMs=${evaluation.idleMs} ` +
        `timeoutMs=${HUB_BASELINE_STALL_TIMEOUT_MS} path=${shardJurisdictionsPath} ` +
        `status=${safeStringify(lastStatus)}`,
      );
    }
    await scheduler.wait(250);
  }
};

const runReset = async (options: OrchestratorResetOptions = configuredResetOptions): Promise<void> => {
  if (options.enableMarketMaker && !configuredResetOptions.enableMarketMaker) {
    throw new Error('RESET_MARKET_MAKER_NOT_CONFIGURED');
  }
  if (options.enableCustody && !configuredResetOptions.enableCustody) {
    throw new Error('RESET_CUSTODY_NOT_CONFIGURED');
  }
  pendingResetOptions = options;
  resetState.inProgress = true;
  resetState.lastError = null;
  resetState.startedAt = Date.now();
  resetState.completedAt = null;
  resetState.failedAt = null;
  nativeH1ReserveTargets = [];
  nativeH1MeshPairs.clear();
  activeResetOptions = { enableMarketMaker: false, enableCustody: false };
  clearRuntimeImportManifestFile();
  const preserveState = process.env['XLN_MESH_PRESERVE_STATE_ON_RESET'] === '1';

  const resetTotalStartedAt = startTiming('reset_total');
  try {
    const stopStartedAt = startTiming('reset_stop_children');
    await stopAllChildren();
    finishTiming('reset_stop_children', stopStartedAt);

    const clearStartedAt = startTiming('reset_clear_state');
    clearRelayState();
    await reapStaleManagedChildren();
    if (!preserveState && process.env['USE_ANVIL'] === 'true') {
      await resetLocalAnvilChains(jurisdictionsConfig);
      meshLog.info('local_anvil.reset_complete', {
        rpcUrls: Object.values(jurisdictionsConfig.rpcUrls ?? {}).filter(Boolean).length,
      });
    }
    if (preserveState) {
      if (!existsSync(args.dbRoot)) {
        throw new Error(`PRESERVE_STATE_DB_ROOT_MISSING:${args.dbRoot}`);
      }
      if (!existsSync(shardJurisdictionsPath)) {
        throw new Error(`PRESERVE_STATE_JURISDICTIONS_MISSING:${shardJurisdictionsPath}`);
      }
    } else if (existsSync(args.dbRoot)) {
      rmSync(args.dbRoot, { recursive: true, force: true });
    }
    mkdirSync(args.dbRoot, { recursive: true });
    if (!preserveState) {
      seedShardJurisdictions(jurisdictionsConfig);
      const primaryProvision = await provisionPrimaryRpcJurisdictionStack(jurisdictionsConfig);
      meshLog.info('primary_jurisdiction.ready', {
        chainId: primaryProvision.chainId,
        deployed: primaryProvision.deployed,
        jurisdiction: primaryProvision.key,
      });
      await deployRpc2JurisdictionStack(jurisdictionsConfig);
      syncCanonicalJurisdictionsFromShard(jurisdictionsConfig);
    }
    finishTiming('reset_clear_state', clearStartedAt);

    const h1 = hubChildren[0]!;
    const h23 = hubChildren.slice(1);

    const spawnH1StartedAt = startTiming('reset_spawn_h1');
    const spawnH23StartedAt = startTiming('reset_spawn_h23');
    await Promise.all([
      spawnHub(h1).finally(() => finishTiming('reset_spawn_h1', spawnH1StartedAt)),
      Promise.all(h23.map(child => spawnHub(child)))
        .finally(() => finishTiming('reset_spawn_h23', spawnH23StartedAt)),
    ]);

    const waitH1StartedAt = startTiming('reset_wait_h1');
    await Promise.all(hubChildren.map(child => waitForHubSelfReady(child)));
    await publishNativeHubProfile(h1);
    finishTiming('reset_wait_h1', waitH1StartedAt);
    await waitForShardJurisdictions(h1);

    const waitForMesh = async (): Promise<void> => {
      const waitStartedAt = startTiming('reset_wait_hubs');
      try {
        await waitForHubBaseline();
      } finally {
        finishTiming('reset_wait_hubs', waitStartedAt);
      }
    };

    const shouldStartMarketMaker = args.mmEnabled && options.enableMarketMaker;
    const startConfiguredMarketMaker = async (): Promise<void> => {
      if (!shouldStartMarketMaker) return;
      const marketMakerStartedAt = startTiming('reset_market_maker');
      try {
        await spawnMarketMaker();
        await waitForMarketMakerReady();
      } finally {
        finishTiming('reset_market_maker', marketMakerStartedAt);
      }
    };

    const startConfiguredCustody = async (): Promise<void> => {
      if (!args.custodyEnabled || !options.enableCustody) return;
      const custodyStartedAt = startTiming('reset_custody');
      try {
        const primaryJurisdiction = resolvePrimaryHubJurisdiction(jurisdictionsConfig);
        if (!primaryJurisdiction?.key) {
          throw new Error('CUSTODY_PRIMARY_JURISDICTION_MISSING');
        }
        custodySupport = await startCustodySupport({
          apiBaseUrl: `http://${args.host}:${args.port}`,
          daemonPort: args.custodyDaemonPort,
          custodyPort: args.custodyPort,
          relayUrl,
          rpcUrl: args.rpcUrl,
          walletUrl: args.walletUrl,
          dbRoot: args.custodyDbRoot,
          seed: runtimeSeedFor('CUSTODY'),
          signerLabel: 'custody-mesh-1',
          additionalStartupSigners: deriveManagedSignerInventory(runtimeSeedFor('CUSTODY'),
            process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_SMOKE'] === '1' &&
            process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE'] === 'cross'
              ? ['production-load-source', 'production-load-target'] : []),
          profileName: 'Custody',
          jurisdictionId: primaryJurisdiction.key,
        });
      } catch (error) {
        meshLog.error('custody.bootstrap_failed', { error: serializeError(error) });
        throw error;
      } finally {
        finishTiming('reset_custody', custodyStartedAt);
      }
    };

    await Promise.all([
      waitForMesh(),
      driveNativeH1Bootstrap(h1, shouldStartMarketMaker),
      startConfiguredMarketMaker(),
      startConfiguredCustody(),
    ]);

    activeResetOptions = resolveActiveResetOptions(configuredResetOptions, options);
    finishTiming('reset_total', resetTotalStartedAt);
    resetState.completedAt = Date.now();
  } catch (error) {
    resetState.lastError = serializeError(error);
    resetState.failedAt = Date.now();
    resetState.completedAt = null;
    throw error;
  } finally {
    resetState.inProgress = false;
    pendingResetOptions = null;
  }
  await publishRuntimeImportManifest();
};

const resetCoordinator = createResetCoordinator(runReset);

const ensureReset = (): Promise<void> =>
  resetCoordinator.ensure(configuredResetOptions);

const ensureResetWithOptions = (options: OrchestratorResetOptions): Promise<void> =>
  resetCoordinator.ensure(options);
const {
  proxyAnyHubGet,
  proxyAnyHubRequest,
  proxyEntityHubApi,
  proxyHubApi,
  proxyRpc,
} = createOrchestratorProxyHandlers({
  host: args.host,
  defaultRpcUrl: args.rpcUrl,
  pollAllHubHealth,
  getHubChildByEntityId,
  getHealthyHub: getHealthyHubChild,
});
const { handleHubApiRequest, handleHubAccountRequest } = createHubApiRoutes({
  host: args.host,
  getHubChildByEntityId,
  pollAllHubHealth,
  proxyHubApi,
});

const handleHealthRequest = async (
  url: URL,
  operatorAuthorized: boolean,
  headers: Record<string, string>,
): Promise<Response | null> => {
  const { pathname } = url;
  const fullHealth =
    pathname === '/api/health/full' ||
    (pathname === '/api/health' && url.searchParams.get('full') === '1');
  if (fullHealth) {
    await getStorageHealth();
    await refreshChildHealthForResponse();
    const marketMakerHealthOverride = activeResetOptions.enableMarketMaker
      ? await fetchMarketMakerFullHealthForResponse()
      : null;
    const health = await buildAggregatedHealthResponse({
      marketMakerHealthOverride,
      includeMarketSnapshots:
        url.searchParams.get('marketSnapshots') === '1',
    });
    return new Response(
      safeStringify(
        operatorAuthorized ? health : publicAggregatedHealth(health),
      ),
      { headers },
    );
  }
  if (pathname === '/api/health') {
    await getStorageHealth();
    await refreshChildHealthForResponse();
    const health = await buildAggregatedHealthResponse();
    return new Response(
      safeStringify(
        operatorAuthorized ? health : publicAggregatedHealth(health),
      ),
      { headers },
    );
  }
  if (pathname === '/api/metrics') {
    await getStorageHealth();
    await refreshChildHealthForResponse();
    const health = await buildAggregatedHealthResponse();
    return new Response(buildPrometheusMetrics(health), {
      headers: {
        ...headers,
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      },
    });
  }
  return null;
};

const handleRuntimeImportRequest = (
  request: Request,
  url: URL,
  operatorAuthorized: boolean,
  headers: Record<string, string>,
): Promise<Response | null> =>
  handleRuntimeImportHttpRequest(request, url, operatorAuthorized, headers, {
    refreshChildHealthForResponse,
    buildAggregatedHealthResponse,
    buildRuntimeImportManifest,
    buildRuntimeImportUrl: resolveWalletRuntimeImportUrl,
  });

const handleResetRequest = (
  request: Request,
  pathname: string,
  operatorAuthorized: boolean,
  headers: Record<string, string>,
): Promise<Response | null> =>
  handleResetHttpRequest(request, pathname, operatorAuthorized, headers, {
    resetAllowed: args.resetAllowed,
    bindHost: args.host,
    resetToken: args.resetToken,
    mmEnabled: args.mmEnabled,
    custodyEnabled: args.custodyEnabled,
    ensureResetWithOptions,
    pollAllHubHealth,
    pollMarketMakerHealth,
    buildAggregatedHealthResponse,
    serializeError,
  });

const handleMetadataRequest = (
  url: URL,
  headers: Record<string, string>,
): Response | null => {
  if (url.pathname === '/api/info') {
    return new Response(
      safeStringify({
        name: 'mesh-control',
        relayUrl,
        rpcUrl: args.rpcUrl,
        host: args.host,
        port: args.port,
        mmEnabled: args.mmEnabled,
        resetAllowed: args.resetAllowed,
      }),
      { headers },
    );
  }
  if (url.pathname !== '/api/jurisdictions') return null;
  try {
    const payload = toPublicJurisdictionsPayload(
      jurisdictionsConfig,
      readShardJurisdictions(jurisdictionsConfig),
    );
    return new Response(payload, {
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error) {
    return new Response(safeStringify({ error: serializeError(error) }), {
      status: 500,
      headers,
    });
  }
};

const httpDrain = createHttpDrainTracker();
const FRONTEND_STATIC_DIR = './frontend/build';

const handlePerformanceControl = (
  request: Request,
  pathname: string,
  operatorAuthorized: boolean,
  headers: HeadersInit,
): Response | null => {
  if (pathname !== '/api/control/performance/op-counters/reset' || request.method !== 'POST') return null;
  if (!operatorAuthorized) {
    return new Response(safeStringify({ error: 'Operator access required' }), { status: 403, headers });
  }
  resetOpCounters();
  return new Response(safeStringify({ ok: true }), { headers });
};

const server = Bun.serve<OrchestratorWebSocket['data']>({
  hostname: args.host,
  port: args.port,
  idleTimeout: 120,
  maxRequestBodySize: 1024 * 1024,
  async fetch(request, serverRef) {
    const releaseHttp = httpDrain.begin();
    try {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const operatorAuthorized = isOperatorRequest(
      request,
      resolveSocketPeerAddress(serverRef, request),
      orchestratorOperatorToken,
    );
    const headers = ORCHESTRATOR_JSON_HEADERS;
    const preflightResponse = operatorPreflightResponse(request, url, operatorAuthorized);
    if (preflightResponse) return preflightResponse;

    const performanceResponse = handlePerformanceControl(request, pathname, operatorAuthorized, headers);
    if (performanceResponse) return performanceResponse;
    const faucetPolicyResponse = await enforceFaucetPolicy(request, operatorAuthorized, process.env, headers);
    if (faucetPolicyResponse) return faucetPolicyResponse;

    const directClientIp = resolveAssistantDirectClientIp(serverRef, request);
    const assistantClientId = resolveAssistantRateClientId(request, directClientIp);
    const assistantResponse = await assistantProxy.handle(request, pathname, assistantClientId);
    if (assistantResponse) return assistantResponse;

    if (request.headers.get('upgrade') === 'websocket' && pathname === '/relay') {
      const socketData = resolveRelayUpgradeData(request, url, resolveSocketPeerAddress(serverRef, request));
      if (!socketData) {
        return new Response('WebSocket audience not configured', { status: 400 });
      }
      const upgraded = serverRef.upgrade(request, {
        data: socketData,
      });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    const rpcProxyIndex = resolveRpcProxyIndex(pathname);
    if (rpcProxyIndex !== null && request.method === 'POST') {
      return await proxyRpc(request, args.rpcUrls[rpcProxyIndex] || '', operatorAuthorized);
    }

    const hubApiResponse = await handleHubApiRequest(request, url, headers);
    if (hubApiResponse) return hubApiResponse;
    const hubAccountResponse = await handleHubAccountRequest(
      request,
      url,
      headers,
    );
    if (hubAccountResponse) return hubAccountResponse;

    if (pathname === '/api/lending/state' && request.method === 'GET') {
      return await proxyAnyHubGet(request, `${pathname}${url.search}`);
    }

    if (
      (
        pathname === '/api/faucet/erc20' ||
        pathname === '/api/faucet/gas' ||
        pathname === '/api/faucet/reserve'
      )
      && request.method === 'POST'
    ) {
      return await proxyAnyHubRequest(request, pathname);
    }

    if (pathname === '/api/external-wallet/snapshot' && request.method === 'POST') {
      return await proxyEntityHubApi(request, '/api/external-wallet/snapshot');
    }

    const healthResponse = await handleHealthRequest(
      url,
      operatorAuthorized,
      headers,
    );
    if (healthResponse) return healthResponse;
    const runtimeImportResponse = await handleRuntimeImportRequest(
      request,
      url,
      operatorAuthorized,
      headers,
    );
    if (runtimeImportResponse) return runtimeImportResponse;

    const qaResponse = await maybeHandleQaRequest(request, pathname, headers, { operatorAuthorized });
    if (qaResponse) return qaResponse;

    if (pathname === '/api/hubs') {
      await pollAllHubHealth();
      return new Response(safeStringify(buildPublicHubDiscoveryPayload({
        hubChildren,
        relayStore,
        defaultJurisdiction: resolvePrimaryHubJurisdiction(jurisdictionsConfig),
      })), { headers });
    }

    if (pathname === '/api/market-cap' && request.method === 'GET') {
      return handleMarketCapRequest({ url, headers, controller: marketCapController, report: reportMarketCapFailure });
    }

    const debugResponse = await maybeHandleOrchestratorDebugApi({
      request,
      pathname,
      url,
      headers,
      hubApiHost: args.host,
      relayStore,
      hubChildren,
      marketMakerChild,
      operatorAuthorized,
      pollAllHubHealth,
      pollMarketMakerHealth,
      proxyAnyHubGet,
    });
    if (debugResponse) return debugResponse;

    const resetResponse = await handleResetRequest(
      request,
      pathname,
      operatorAuthorized,
      headers,
    );
    if (resetResponse) return resetResponse;
    const metadataResponse = handleMetadataRequest(url, headers);
    if (metadataResponse) return metadataResponse;

    if (pathname === '/api/tokens' && request.method === 'GET') {
      return await proxyAnyHubRequest(request, `${pathname}${url.search}`);
    }

    if (pathname === '/api/watchtower-proxy' && (request.method === 'GET' || request.method === 'POST' || request.method === 'PUT')) {
      return await handleWatchtowerProxy(request);
    }

    if (pathname.startsWith('/api/')) {
      return await proxyAnyHubRequest(request, `${pathname}${url.search}`);
    }

    const staticResponse = await serveStaticApp(request, pathname, FRONTEND_STATIC_DIR);
    if (staticResponse) return staticResponse;

    return new Response(safeStringify({
      error: `Unhandled mesh-control route: ${request.method} ${pathname}`,
    }), {
      status: 404,
      headers,
    });
    } finally {
      releaseHttp();
    }
  },
  websocket: {
    maxPayloadLength: resolveRuntimeWsMaxMessageBytes(),
    open(ws) {
      const relayWs = ws;
      if (relayWs.data.type === 'relay') relayHelloChallenges.issue(relayWs, relayWs.data.audience);
      pushDebugEvent(relayStore, {
        event: 'ws_open',
        details: { wsType: relayWs.data.type },
      });
    },
    message(ws, raw) {
      try {
        let peerMessage: RuntimeWsMessage | null = null;
        let marketMessage: MarketWireRequest | null = null;
        try {
          peerMessage = deserializeWsMessage(raw as string | Buffer | ArrayBuffer);
        } catch (binaryError) {
          try {
            marketMessage = decodeMarketWireRequest(raw.toString());
          } catch {
            throw binaryError;
          }
        }
        if (marketMessage) {
          Promise.resolve(marketSubscriptionStack.handleMessage(ws, marketMessage)).catch(error => {
            const reason = serializeError(error);
            pushDebugEvent(relayStore, {
              event: 'error',
              reason: 'MARKET_HANDLER_EXCEPTION',
              details: { error: reason, msgType: marketMessage?.type },
            });
            try {
              ws.send(encodeMarketWireMessage({ type: 'error', error: reason }));
            } catch (sendError) {
              meshLog.warn('relay.market_error_send_failed', { error: serializeError(sendError) });
            }
          });
          return;
        }
        if (!peerMessage) throw new Error('RELAY_MESSAGE_DECODE_INVARIANT');
        Promise.resolve(relayRoute(routerConfig, ws, peerMessage, typeof raw === 'string' ? undefined : toRuntimeWsBytes(raw as Buffer | ArrayBuffer))).catch(error => {
          const reason = serializeError(error);
          pushDebugEvent(relayStore, {
            event: 'error',
            reason: 'RELAY_HANDLER_EXCEPTION',
            details: {
              error: reason,
              msgType: peerMessage?.type,
              from: peerMessage?.from,
              to: peerMessage?.to,
            },
          });
          try {
            ws.send(serializeWsMessage({ type: 'error', error: reason }));
          } catch (sendError) {
            meshLog.warn('relay.error_send_failed', { error: serializeError(sendError) });
          }
        });
      } catch (error) {
        pushDebugEvent(relayStore, {
          event: 'error',
          reason: 'INVALID_RELAY_MESSAGE',
          details: { error: serializeError(error) },
        });
        try {
          ws.send(serializeWsMessage({ type: 'error', error: 'Invalid relay message' }));
        } catch (sendError) {
          meshLog.warn('relay.invalid_message_send_failed', { error: serializeError(sendError) });
        }
      }
    },
    close(ws) {
      const relayWs = ws;
      relayHelloChallenges.forget(relayWs);
      cleanupRpcMarketSubscription(relayWs);
      forgetRelaySocketRuntimeId(relayWs);
      removeClient(relayStore, relayWs);
    },
  },
});

const shutdown = async (): Promise<void> => {
  dumpOpCounters('orchestrator', 'shutdown');
  await stopServerGracefully(server, httpDrain, 'orchestrator', 5_000);
  await stopAllChildren({
    quiesceRounds: 1,
    quiesceTimeoutMs: CHILD_SHUTDOWN_QUIESCE_TIMEOUT_MS,
  });
  process.exit(0);
};

const requestShutdown = (signal: NodeJS.Signals): void => {
  if (orchestratorShutdownStarted) return;
  orchestratorShutdownStarted = true;
  if (resetState.inProgress) {
    meshLog.warn('reset.signal_during_reset', { signal });
  }
  void shutdown();
};

process.on('SIGTERM', () => { requestShutdown('SIGTERM'); });
process.on('SIGINT', () => { requestShutdown('SIGINT'); });

console.log(
  `CONTROL_READY host=${args.host} port=${args.port} relay=${relayUrl} rpc=${args.rpcUrl} mm=${args.mmEnabled ? 'on' : 'off'} custody=${args.custodyEnabled ? 'on' : 'off'} reset=${args.resetAllowed ? 'on' : 'off'} deferInitialReset=${args.deferInitialReset ? 'on' : 'off'}`,
);

assertMinDiskFree();

if (!args.deferInitialReset) {
  void ensureReset().catch(async (error) => {
    let receiptPath: string | null = null;
    try {
      receiptPath = persistOrchestratorFailure(error);
    } catch (receiptError) {
      meshLog.error('reset.failure_receipt_write_failed', {
        error: serializeError(receiptError),
        originalFailure: serializeError(error),
      });
    }
    meshLog.error('reset.initial_failed', { error: serializeError(error), receiptPath });
    await stopAllChildren({
      quiesceRounds: 1,
      quiesceTimeoutMs: CHILD_SHUTDOWN_QUIESCE_TIMEOUT_MS,
    });
    process.exit(1);
  });
}
