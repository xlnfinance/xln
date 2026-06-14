#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeBoard, hashBoard } from '../entity-factory';
import { compareStableText, safeStringify } from '../serialization-utils';
import { createStructuredLogger } from '../logger';
import { deriveSignerAddressSync } from '../account-crypto';
import {
  startCustodySupport,
  stopManagedChild,
} from './custody-bootstrap';
import {
  createRelayStore,
  clearPendingMessages,
  normalizeRuntimeKey,
  pushDebugEvent,
  removeClient,
  type RelayStore,
} from '../relay-store';
import { forgetRelaySocketRuntimeId, relayRoute, type RelayRouterConfig } from '../relay-router';
import { type MarketSnapshotPayload } from '../market-snapshot';
import { createMarketSubscriptionStack, isMarketMessageType } from '../relay/market-subscriptions';
import { assertMinDiskFree, getStorageHealth, getStorageHealthSnapshotSync, type StorageHealth } from './storage-monitor';
import { maybeHandleQaRequest } from '../qa/api';
import { handleWatchtowerProxy } from '../server/watchtower-proxy';
import { createHttpDrainTracker, stopServerGracefully } from './graceful-server';
import { isLocalOperatorRequest, publicAggregatedHealth } from '../health-redaction';
import type {
  AggregatedHealth,
  CustodySupportState,
  HubChild,
  HubHealthPayload,
  HubInfoPayload,
  ManagedRuntimeSpec,
  MarketMakerChild,
  MarketMakerHealthPayload,
  MarketMakerInfoPayload,
  OrchestratorWebSocket,
  ResetState,
  TimingMap,
} from './orchestrator-types';
import {
  CHILD_LOG_RING_MAX,
  HUB_BASELINE_TIMEOUT_MS,
  HUB_DIRECT_LINK_BASELINE_GRACE_MS,
  HUB_NAMES,
  HUB_PROFILES_READY_TIMEOUT_MS,
  HUB_REQUIRED_TOKEN_COUNT,
  HUB_SELF_READY_TIMEOUT_MS,
  MARKET_MAKER_READY_TIMEOUT_MS,
  RELAY_MARKET_MAX_SUBSCRIPTION_CELLS,
  RELAY_MARKET_MAX_SUBSCRIPTIONS,
  RELAY_MARKET_MAX_SUBSCRIPTIONS_PER_IP,
  STARTUP_TIMEOUT_MS,
  parseArgs,
} from './orchestrator-config';
import {
  createManagedRuntimeLeaseManager,
  readManagedProcessTable,
  type ManagedProcessTableEntry,
} from './managed-runtime-leases';
import { buildPrometheusMetrics } from './prometheus';
import { deriveHubRuntimeHealth } from './health-model';
import { buildPublicHubDiscoveryPayload } from './public-discovery';
import {
  assertOrchestratorResetAllowed,
  ORCHESTRATOR_RESET_CONFIRMATION,
  OrchestratorResetRejectedError,
  type OrchestratorResetBody,
} from './reset-guard';
import {
  deployRpc2JurisdictionStack,
  readShardJurisdictions,
  resolvePrimaryHubJurisdictionFallback,
  seedShardJurisdictions,
  toPublicJurisdictionsPayload,
  type OrchestratorJurisdictionsConfig,
} from './jurisdictions';
import { createOrchestratorProxyHandlers } from './proxy';
import { maybeHandleOrchestratorDebugApi } from './debug-api';

const buildDiskSummary = (storage: StorageHealth): AggregatedHealth['disk'] => {
  const totalBytes = Number(storage.disk.totalBytes || 0);
  const usedBytes = Number(storage.disk.usedBytes || 0);
  const freeBytes = Number(storage.disk.freeBytes || 0);
  const toGiB = (value: number): number => Math.round((value / 1024 ** 3) * 100) / 100;
  return {
    ok: storage.ok,
    minFreeBytes: storage.minFreeBytes,
    freeBytes,
    usedBytes,
    totalBytes,
    freeGiB: toGiB(freeBytes),
    usedGiB: toGiB(usedBytes),
    totalGiB: toGiB(totalBytes),
    usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10000) / 100 : 0,
  };
};

const args = parseArgs();
const orchestratorOwnerId = `${process.pid}:${Date.now()}:${randomUUID()}`;
const staleReapEnabled = process.env['XLN_SKIP_STALE_REAP'] !== '1';
const relayUrl = (() => {
  const url = new URL(args.publicWsBaseUrl);
  url.pathname = '/relay';
  url.search = '';
  url.hash = '';
  return url.toString();
})();
const shardJurisdictionsPath = join(args.dbRoot, 'jurisdictions.json');
const controlPlaneDir = join(args.dbRoot, '.control-plane');
const managedRuntimeLeases = createManagedRuntimeLeaseManager({
  controlPlaneDir,
  ownerId: orchestratorOwnerId,
});
const jurisdictionsConfig: OrchestratorJurisdictionsConfig = {
  shardJurisdictionsPath,
  rpc2Url: args.rpc2Url,
};

const relayStore: RelayStore = createRelayStore('mesh-relay');
const routerConfig: RelayRouterConfig = {
  store: relayStore,
  localRuntimeId: 'mesh-relay',
  localDeliver: async () => {},
  send: (ws, data) => ws.send(data),
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
};

const resetState: ResetState = {
  inProgress: false,
  lastError: null,
  startedAt: null,
  completedAt: null,
  failedAt: null,
  resolvedAt: null,
};

const readRadapterAuthSeeds = (): Record<string, string> => {
  const raw = String(process.env['XLN_MESH_RADAPTER_AUTH_SEEDS_JSON'] || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) out[key.toUpperCase()] = value.trim();
    }
    return out;
  } catch (error) {
    throw new Error(`MESH_RADAPTER_AUTH_SEEDS_JSON_INVALID: ${(error as Error).message}`);
  }
};

const radapterAuthSeeds = readRadapterAuthSeeds();
const radapterAuthSeedFor = (name: string, fallback: string): string => radapterAuthSeeds[name.toUpperCase()] || fallback;

const hubChildren: HubChild[] = HUB_NAMES.map((name, index) => ({
  name,
  region: 'global',
  seed: `xln-e2e-${name.toLowerCase()}`,
  authSeed: radapterAuthSeedFor(name, `xln-e2e-${name.toLowerCase()}`),
  signerLabel: `${name.toLowerCase()}-hub`,
  apiPort: args.nodeApiPortBase + index,
  publicPort: args.nodePublicPortBase + index,
  dbPath: join(args.dbRoot, name.toLowerCase()),
  deployTokens: index === 0,
  proc: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  restartTimer: null,
  restartCount: 0,
  lastHealth: null,
  lastInfo: null,
  recentStdout: [],
  recentStderr: [],
}));

const marketMakerChild: MarketMakerChild = {
  name: 'MM',
  seed: 'xln-mesh-mm',
  authSeed: radapterAuthSeedFor('MM', 'xln-mesh-mm'),
  signerLabel: 'mm-1',
  apiPort: args.nodeApiPortBase + 3,
  publicPort: args.nodePublicPortBase + 3,
  dbPath: join(args.dbRoot, 'mm'),
  proc: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  exitSignal: null,
  restartTimer: null,
  restartCount: 0,
  lastHealth: null,
  lastInfo: null,
  lastStartupPhase: null,
  recentStdout: [],
  recentStderr: [],
};

const buildPublicDirectWsUrl = (publicPort: number): string => {
  const url = new URL(args.publicWsBaseUrl);
  url.port = String(publicPort);
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
};

let custodySupport: CustodySupportState | null = null;

let resetPromise: Promise<void> | null = null;
const CHILD_GRACEFUL_SHUTDOWN_MS = 20_000;

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

const pushChildLogLines = (target: string[], chunk: Buffer | string): void => {
  const text = chunk.toString();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    target.push(line.slice(0, 1000));
  }
  if (target.length > CHILD_LOG_RING_MAX) {
    target.splice(0, target.length - CHILD_LOG_RING_MAX);
  }
};

const resolveRequestClientIp = (request: Request): string => {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  const cfIp = request.headers.get('cf-connecting-ip')?.trim();
  return forwarded || realIp || cfIp || 'direct';
};

const stopProcess = async (proc: ChildProcess | null): Promise<void> => {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const deadline = Date.now() + CHILD_GRACEFUL_SHUTDOWN_MS;
  while (proc.exitCode === null && Date.now() < deadline) {
    await delay(100);
  }
  if (proc.exitCode === null) {
    console.warn(`[MESH] child pid=${proc.pid ?? 'unknown'} did not exit after ${CHILD_GRACEFUL_SHUTDOWN_MS}ms; sending SIGKILL`);
    proc.kill('SIGKILL');
    const killDeadline = Date.now() + CHILD_GRACEFUL_SHUTDOWN_MS;
    while (proc.exitCode === null && Date.now() < killDeadline) {
      await delay(100);
    }
    if (proc.exitCode === null) {
      throw new Error(`CHILD_STOP_TIMEOUT pid=${proc.pid ?? 'unknown'}`);
    }
  }
};

const clearRelayState = (): void => {
  for (const [, client] of relayStore.clients.entries()) {
    try {
      client.ws.close?.(4000, 'mesh-reset');
    } catch {
      try { client.ws.close?.(); } catch {}
    }
  }
  relayStore.clients.clear();
  clearPendingMessages(relayStore);
  relayStore.gossipProfiles.clear();
  relayStore.runtimeEncryptionKeys.clear();
  relayStore.activeHubEntityIds = [];
  relayStore.debugEvents.length = 0;
  relayStore.debugId = 0;
  relayStore.wsCounter = 0;
  marketSubscriptionStack.clear();
};

const fetchJson = async <T>(url: string, timeoutMs = 2_000): Promise<T | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const insecureLocalHttps = url.startsWith('https://localhost:') || url.startsWith('https://127.0.0.1:');
    const prevTlsReject = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    if (insecureLocalHttps) {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    }
    const response = await fetch(url, { signal: controller.signal });
    if (insecureLocalHttps) {
      if (prevTlsReject === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = prevTlsReject;
    }
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const fetchText = async (url: string, timeoutMs = 2_000): Promise<string | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.text();
  } catch {
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
  } catch {
    // best effort before hard stop
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

const getHealthyHubChild = (): HubChild | null =>
  hubChildren.find((candidate) => candidate.proc?.exitCode === null && candidate.lastHealth) || null;

const fetchHubMarketSnapshots = async (
  child: HubChild,
  hubEntityId: string,
  pairIds: string[],
  depth: number,
): Promise<MarketSnapshotPayload[]> => {
  const params = new URLSearchParams();
  params.set('hubEntityId', hubEntityId);
  params.set('depth', String(depth));
  for (const pairId of pairIds) params.append('pair', pairId);
  const url = `http://${args.host}:${child.apiPort}/api/market/snapshots?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => null) as {
      error?: unknown;
      code?: unknown;
      snapshots?: unknown;
    } | null;
    if (!response.ok || !Array.isArray(payload?.snapshots)) {
      const message = typeof payload?.error === 'string' && payload.error
        ? payload.error
        : `Market snapshots unavailable for hub: ${hubEntityId}`;
      const error = new Error(message) as Error & { code?: string };
      error.code = typeof payload?.code === 'string' && /^E_[A-Z0-9_]+$/.test(payload.code)
        ? payload.code
        : 'E_MARKET_SNAPSHOT_UNAVAILABLE';
      throw error;
    }
    return payload.snapshots as MarketSnapshotPayload[];
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code) throw error;
    const wrapped = new Error(`Market snapshots unavailable for hub: ${hubEntityId}`) as Error & { code?: string };
    wrapped.code = 'E_MARKET_SNAPSHOT_UNAVAILABLE';
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
};

const marketSubscriptionStack = createMarketSubscriptionStack<OrchestratorWebSocket>({
  maxSubscriptions: RELAY_MARKET_MAX_SUBSCRIPTIONS,
  maxSubscriptionsPerIp: RELAY_MARKET_MAX_SUBSCRIPTIONS_PER_IP,
  maxCellsPerSubscription: RELAY_MARKET_MAX_SUBSCRIPTION_CELLS,
  getClientIp: ws => String(ws?.data?.clientIp || 'unknown'),
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

const cleanupRpcMarketSubscription = (ws: OrchestratorWebSocket): void => marketSubscriptionStack.cleanup(ws);

const pollHubHealth = async (child: HubChild): Promise<void> => {
  const apiBase = `http://${args.host}:${child.apiPort}`;
  const [info, health] = await Promise.all([
    fetchJson<HubInfoPayload>(`${apiBase}/api/info`, 1_500),
    fetchJson<HubHealthPayload>(`${apiBase}/api/health`, 1_500),
  ]);
  if (info) child.lastInfo = info;
  if (health) child.lastHealth = health;
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

const pollAllHubHealth = async (): Promise<void> => {
  await Promise.all(hubChildren.map(child => pollHubHealth(child)));
};

const pollMarketMakerHealth = async (): Promise<void> => {
  if (!marketMakerChild.proc || marketMakerChild.exitCode !== null || marketMakerChild.exitSignal !== null) {
    return;
  }
  const apiBase = `http://${args.host}:${marketMakerChild.apiPort}`;
  marketMakerChild.lastInfo = await fetchJson<MarketMakerInfoPayload>(`${apiBase}/api/info`, 1_500);
  marketMakerChild.lastHealth = await fetchJson<MarketMakerHealthPayload>(`${apiBase}/api/health`, 1_500);
  marketMakerChild.lastStartupPhase = String(
    marketMakerChild.lastHealth?.startupPhase ||
    marketMakerChild.lastInfo?.startupPhase ||
    '',
  ).trim() || null;
};

const getHubSpecsArg = (): string => HUB_NAMES.join(',');

const getMarketMakerIdentity = (): { name: string; entityId: string; signerId: string; creditAmount: string } => {
  const signerId = deriveSignerAddressSync(marketMakerChild.seed, marketMakerChild.signerLabel).toLowerCase();
  const entityId = hashBoard(encodeBoard({
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
  })).toLowerCase();
  return {
    name: marketMakerChild.name,
    entityId,
    signerId,
    creditAmount: '50000000000000000000000000',
  };
};

const getMeshHubIdentitiesArg = (): string => JSON.stringify(
  hubChildren
    .map((child) => ({
      name: child.name,
      entityId: String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').trim().toLowerCase(),
      signerId: deriveSignerAddressSync(child.seed, child.signerLabel).toLowerCase(),
    }))
    .filter((entry) => entry.entityId.length > 0),
);

const sanitizeChildEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = { ...env };
  if (next['FORCE_COLOR'] && next['NO_COLOR']) {
    delete next['NO_COLOR'];
  }
  return next;
};

const clearChildRestartTimer = (child: { restartTimer: ReturnType<typeof setTimeout> | null }): void => {
  if (!child.restartTimer) return;
  clearTimeout(child.restartTimer);
  child.restartTimer = null;
};

const managedSpecForHub = (child: HubChild): ManagedRuntimeSpec => ({
  role: 'hub',
  name: child.name,
  script: 'runtime/orchestrator/hub-node.ts',
  apiPort: child.apiPort,
  dbPath: child.dbPath,
});

const managedSpecForMarketMaker = (): ManagedRuntimeSpec => ({
  role: 'market-maker',
  name: marketMakerChild.name,
  script: 'runtime/orchestrator/mm-node.ts',
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
  if (resetState.inProgress || fatalOrchestratorShutdownStarted) return;
  fatalOrchestratorShutdownStarted = true;
  console.error(`[MESH] ${message}; shutting down instead of restarting`);
  void (async () => {
    try {
      await stopAllChildren();
    } catch (error) {
      console.error(`[MESH] failed while stopping children after fatal exit: ${serializeError(error)}`);
    } finally {
      process.exit(1);
    }
  })();
};

const spawnHub = async (child: HubChild): Promise<void> => {
  await reapStaleHubProcess(child);
  mkdirSync(child.dbPath, { recursive: true });
  clearChildRestartTimer(child);
  const spec = managedSpecForHub(child);
  const cmd = [
    'runtime/orchestrator/hub-node.ts',
    '--name', child.name,
    '--region', child.region,
    '--seed', child.seed,
    '--signer-label', child.signerLabel,
    '--relay-url', relayUrl,
    '--api-host', args.host,
    '--api-port', String(child.apiPort),
    '--direct-ws-url', buildPublicDirectWsUrl(child.publicPort),
    '--rpc-url', args.rpcUrl,
    ...(args.rpc2Url ? ['--rpc2-url', args.rpc2Url] : []),
    '--mesh-hub-names', getHubSpecsArg(),
    '--support-peer-identities-json', JSON.stringify([getMarketMakerIdentity()]),
    '--db-path', child.dbPath,
    ...(child.deployTokens ? ['--deploy-tokens'] : []),
  ];
  child.startedAt = Date.now();
  child.exitedAt = null;
  child.exitCode = null;
  child.restartCount += 1;
  child.lastHealth = null;
  child.lastInfo = null;
  child.recentStdout = [];
  child.recentStderr = [];
  const proc = spawn('bun', cmd, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeChildEnv({
      ...process.env,
      XLN_DB_PATH: child.dbPath,
      XLN_JURISDICTIONS_PATH: shardJurisdictionsPath,
      ANVIL_RPC: args.rpcUrl,
      ANVIL_RPC2: args.rpc2Url,
      USE_ANVIL: 'true',
      XLN_RADAPTER_AUTH_SEED: child.authSeed,
      XLN_ORCHESTRATOR_PID: String(process.pid),
      XLN_ORCHESTRATOR_OWNER_ID: orchestratorOwnerId,
      XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS: String(STARTUP_TIMEOUT_MS),
    }),
  });
  child.proc = proc;
  if (!proc.pid) {
    throw new Error(`${child.name}_SPAWN_FAILED_NO_PID`);
  }
  managedRuntimeLeases.writeLease(spec, proc.pid, child.startedAt ?? Date.now());
  proc.stdout?.on('data', chunk => {
    pushChildLogLines(child.recentStdout, chunk);
    process.stdout.write(`[${child.name}] ${chunk.toString()}`);
  });
  proc.stderr?.on('data', chunk => {
    pushChildLogLines(child.recentStderr, chunk);
    process.stderr.write(`[${child.name}:err] ${chunk.toString()}`);
  });
  proc.once('exit', code => {
    const pid = proc.pid ?? null;
    const controlledStop = consumeControlledStop(pid);
    const isCurrentProc = child.proc === proc;
    managedRuntimeLeases.removeLease(spec, pid);
    if (isCurrentProc) {
      child.exitedAt = Date.now();
      child.exitCode = code;
    }
    if (!controlledStop && isCurrentProc && !resetState.inProgress && code !== 0) {
      failFastUnexpectedChildExit(`${child.name} exited unexpectedly with code=${String(code)}`);
    }
  });
};

const spawnMarketMaker = async (): Promise<void> => {
  await reapStaleMarketMakerProcess();
  mkdirSync(marketMakerChild.dbPath, { recursive: true });
  clearChildRestartTimer(marketMakerChild);
  const spec = managedSpecForMarketMaker();
  const cmd = [
    'runtime/orchestrator/mm-node.ts',
    '--name', marketMakerChild.name,
    '--seed', marketMakerChild.seed,
    '--signer-label', marketMakerChild.signerLabel,
    '--relay-url', relayUrl,
    '--api-host', args.host,
    '--api-port', String(marketMakerChild.apiPort),
    '--direct-ws-url', buildPublicDirectWsUrl(marketMakerChild.publicPort),
    '--rpc-url', args.rpcUrl,
    ...(args.rpc2Url ? ['--rpc2-url', args.rpc2Url] : []),
    '--mesh-hub-names', getHubSpecsArg(),
    '--mesh-hub-identities-json', getMeshHubIdentitiesArg(),
    '--db-path', marketMakerChild.dbPath,
  ];
  marketMakerChild.startedAt = Date.now();
  marketMakerChild.exitedAt = null;
  marketMakerChild.exitCode = null;
  marketMakerChild.exitSignal = null;
  marketMakerChild.restartCount += 1;
  marketMakerChild.lastHealth = null;
  marketMakerChild.lastInfo = null;
  marketMakerChild.lastStartupPhase = null;
  marketMakerChild.recentStdout = [];
  marketMakerChild.recentStderr = [];
  const proc = spawn('bun', cmd, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeChildEnv({
      ...process.env,
      XLN_DB_PATH: marketMakerChild.dbPath,
      XLN_JURISDICTIONS_PATH: shardJurisdictionsPath,
      ANVIL_RPC: args.rpcUrl,
      ANVIL_RPC2: args.rpc2Url,
      USE_ANVIL: 'true',
      XLN_RADAPTER_AUTH_SEED: marketMakerChild.authSeed,
      XLN_ORCHESTRATOR_PID: String(process.pid),
      XLN_ORCHESTRATOR_OWNER_ID: orchestratorOwnerId,
      XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS: String(STARTUP_TIMEOUT_MS),
    }),
  });
  marketMakerChild.proc = proc;
  if (!proc.pid) {
    throw new Error('MM_SPAWN_FAILED_NO_PID');
  }
  managedRuntimeLeases.writeLease(spec, proc.pid, marketMakerChild.startedAt ?? Date.now());
  proc.stdout?.on('data', chunk => {
    pushChildLogLines(marketMakerChild.recentStdout, chunk);
    process.stdout.write(`[MM] ${chunk.toString()}`);
  });
  proc.stderr?.on('data', chunk => {
    pushChildLogLines(marketMakerChild.recentStderr, chunk);
    process.stderr.write(`[MM:err] ${chunk.toString()}`);
  });
  proc.once('exit', (code, signal) => {
    const pid = proc.pid ?? null;
    const controlledStop = consumeControlledStop(pid);
    const isCurrentProc = marketMakerChild.proc === proc;
    managedRuntimeLeases.removeLease(spec, pid);
    if (isCurrentProc) {
      marketMakerChild.exitedAt = Date.now();
      marketMakerChild.exitCode = code ?? null;
      marketMakerChild.exitSignal = signal ?? null;
    }
    if (!controlledStop && isCurrentProc && !resetState.inProgress && code !== 0) {
      failFastUnexpectedChildExit(
        `MM exited unexpectedly code=${String(code)} signal=${String(signal)} phase=${String(marketMakerChild.lastStartupPhase)}`,
      );
    }
  });
};

const stopAllChildren = async (): Promise<void> => {
  for (const child of hubChildren) clearChildRestartTimer(child);
  clearChildRestartTimer(marketMakerChild);
  const ownedLiveChildren = hubChildren.filter((child) => child.proc && child.proc.exitCode === null);
  const ownedLiveMarketMaker = marketMakerChild.proc && marketMakerChild.proc.exitCode === null ? marketMakerChild : null;
  const quiesceUrls = [
    ...ownedLiveChildren.map((child) => `http://${args.host}:${child.apiPort}/api/control/runtime/quiesce`),
    ...(ownedLiveMarketMaker ? [`http://${args.host}:${ownedLiveMarketMaker.apiPort}/api/control/runtime/quiesce`] : []),
  ];
  // Initial reset often has no owned children yet. Do not probe random old listeners on the same ports.
  for (let round = 0; round < 2 && quiesceUrls.length > 0; round += 1) {
    await Promise.all(quiesceUrls.map((url) => postJson(url, 45_000)));
    await delay(150);
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

const buildChildProcessHealth = (): AggregatedHealth['process']['children'] => {
  const hubEntries = hubChildren.map((child) => {
    const spec = managedSpecForHub(child);
    const lease = managedRuntimeLeases.readLease(spec);
    return {
      role: spec.role,
      name: spec.name,
      pid: child.proc?.pid ?? null,
      leasePid: lease?.pid ?? null,
      leaseOwnerId: lease?.ownerId ?? null,
      online: child.proc?.exitCode === null,
      exitCode: child.exitCode,
      startedAt: child.startedAt,
      exitedAt: child.exitedAt,
      restartCount: child.restartCount,
      apiPort: spec.apiPort,
      dbPath: spec.dbPath,
      lastErrorLine: child.recentStderr.at(-1) ?? null,
      recentStdout: child.recentStdout.slice(-10),
      recentStderr: child.recentStderr.slice(-10),
    };
  });
  const mmSpec = managedSpecForMarketMaker();
  const mmLease = managedRuntimeLeases.readLease(mmSpec);
  return [
    ...hubEntries,
    {
      role: mmSpec.role,
      name: mmSpec.name,
      pid: marketMakerChild.proc?.pid ?? null,
      leasePid: mmLease?.pid ?? null,
      leaseOwnerId: mmLease?.ownerId ?? null,
      online: marketMakerChild.proc?.exitCode === null,
      exitCode: marketMakerChild.exitCode,
      exitSignal: marketMakerChild.exitSignal,
      startedAt: marketMakerChild.startedAt,
      exitedAt: marketMakerChild.exitedAt,
      restartCount: marketMakerChild.restartCount,
      apiPort: mmSpec.apiPort,
      dbPath: mmSpec.dbPath,
      lastErrorLine: marketMakerChild.recentStderr.at(-1) ?? null,
      recentStdout: marketMakerChild.recentStdout.slice(-10),
      recentStderr: marketMakerChild.recentStderr.slice(-10),
    },
  ];
};

const buildProcessHealth = (): AggregatedHealth['process'] => {
  const mem = process.memoryUsage();
  const totalMemory = totalmem();
  const freeMemory = freemem();
  return {
    pid: process.pid,
    ownerId: orchestratorOwnerId,
    uptimeSec: Math.round(process.uptime()),
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    loadavg: loadavg(),
    cpuCount: cpus().length,
    memory: {
      freeBytes: freeMemory,
      totalBytes: totalMemory,
      freePct: totalMemory > 0 ? Math.round((freeMemory / totalMemory) * 10000) / 100 : 0,
    },
    children: buildChildProcessHealth(),
  };
};

const computeAggregatedHealth = (): AggregatedHealth => {
  const storage = getStorageHealthSnapshotSync();
  const managedRuntimeIds = new Set<string>();
  for (const child of hubChildren) {
    const runtimeId = normalizeRuntimeKey(String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || ''));
    if (runtimeId) managedRuntimeIds.add(runtimeId);
  }
  const marketMakerRuntimeId = normalizeRuntimeKey(String(marketMakerChild.lastInfo?.runtimeId || marketMakerChild.lastHealth?.runtimeId || ''));
  if (marketMakerRuntimeId) managedRuntimeIds.add(marketMakerRuntimeId);
  const relayClientIds = Array.from(relayStore.clients.keys()).map(normalizeRuntimeKey).filter(Boolean);
  const externalClientIds = relayClientIds.filter((runtimeId) => !managedRuntimeIds.has(runtimeId));
  const hubs = hubChildren.map((child) => {
    const entityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '');
    const runtimeId = String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '');
    const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
    const relayOnline = normalizedRuntimeId ? relayStore.clients.has(normalizedRuntimeId) : false;
    const hubRuntimeHealth = deriveHubRuntimeHealth({
      processExitCode: child.proc?.exitCode,
      hasHealth: Boolean(child.lastHealth),
      hasSelfRelayPresence: relayOnline,
    });
    return {
      entityId,
      name: child.name,
      online: hubRuntimeHealth.online,
      runtimeId,
      selfRelayPresence: hubRuntimeHealth.selfRelayPresence,
      pid: child.proc?.pid ?? null,
      apiPort: child.apiPort,
      apiUrl: String(child.lastInfo?.apiUrl || `http://${args.host}:${child.apiPort}`),
      dbPath: child.dbPath,
      startedAt: child.startedAt,
      exitedAt: child.exitedAt,
      exitCode: child.exitCode,
      restartCount: child.restartCount,
      lastErrorLine: child.recentStderr.at(-1) ?? null,
    };
  });

  const hubIds = hubs
    .map(hub => hub.entityId.toLowerCase())
    .filter(entityId => entityId.length > 0);

  const pairSet = new Map<string, { left: string; right: string; ok: boolean }>();
  const directLinkMap = new Map<string, { fromRuntimeId: string; toRuntimeId: string; endpoint: string }>();
  for (const child of hubChildren) {
    const left = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').toLowerCase();
    for (const pair of child.lastHealth?.mesh?.pairs ?? []) {
      const right = String(pair.counterpartyId || '').toLowerCase();
      if (!left || !right) continue;
      const key = [left, right].sort().join(':');
      pairSet.set(key, {
        left: [left, right].sort()[0]!,
        right: [left, right].sort()[1]!,
        ok: pair.ready === true,
      });
    }
    const fromRuntimeId = String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '').toLowerCase();
    for (const peer of child.lastHealth?.p2p?.directPeers ?? []) {
      const toRuntimeId = String(peer.runtimeId || '').toLowerCase();
      const endpoint = String(peer.endpoint || '');
      if (!fromRuntimeId || !toRuntimeId || !endpoint || peer.open !== true) continue;
      directLinkMap.set(`${fromRuntimeId}->${toRuntimeId}`, {
        fromRuntimeId,
        toRuntimeId,
        endpoint,
      });
    }
  }

  const reserveEntities = hubChildren
    .flatMap((child) => {
      const nestedEntities = child.lastHealth?.bootstrapReserves?.entities;
      if (Array.isArray(nestedEntities) && nestedEntities.length > 0) {
        return nestedEntities
          .map((entity) => {
            const entityId = String(entity.entityId || '').trim().toLowerCase();
            if (!entityId) return null;
            return {
              entityId,
              role: 'hub' as const,
              ready: entity.ready === true,
              targetMet: entity.targetMet === true,
              tokens: entity.tokens ?? [],
            };
          })
          .filter((value): value is NonNullable<typeof value> => value !== null);
      }
      const entityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '');
      if (!entityId) return null;
      return {
        entityId,
        role: 'hub' as const,
        ready: child.lastHealth?.bootstrapReserves?.ok === true,
        targetMet: child.lastHealth?.bootstrapReserves?.targetMet === true,
        tokens: child.lastHealth?.bootstrapReserves?.tokens ?? [],
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  const marketMakerOnline = marketMakerChild.proc?.exitCode === null && marketMakerChild.exitCode === null && marketMakerChild.exitSignal === null;
  const marketMakerActive = args.mmEnabled && marketMakerOnline;
  const mmEntityId = marketMakerActive
    ? String(marketMakerChild.lastInfo?.entityId || marketMakerChild.lastHealth?.entityId || '').trim() || null
    : null;
  const mmExpectedOffersPerHub = Number(marketMakerChild.lastHealth?.marketMaker?.expectedOffersPerHub || 0);
  const mmHubsById = new Map<string, {
    hubEntityId: string;
    offers: number;
    ready: boolean;
    pairs: Array<{ pairId: string; offers: number; ready: boolean }>;
  }>();
  for (const hub of marketMakerChild.lastHealth?.marketMaker?.hubs ?? []) {
    const hubEntityId = String(hub.hubEntityId || '').toLowerCase();
    if (!hubEntityId) continue;
    mmHubsById.set(hubEntityId, {
      hubEntityId,
      offers: Number(hub.offers || 0),
      ready: hub.ready === true,
      pairs: Array.isArray(hub.pairs)
        ? hub.pairs.map((pair) => ({
            pairId: String(pair.pairId || ''),
            offers: Number(pair.offers || 0),
            ready: pair.ready === true,
          }))
      : [],
    });
  }
  const rawMmCross = marketMakerChild.lastHealth?.marketMaker?.cross;
  const mmCross = {
    applicable: rawMmCross?.applicable === true || Number(rawMmCross?.expectedRoutes || 0) > 0,
    ok: rawMmCross?.ok === true,
    expectedRoutes: Number(rawMmCross?.expectedRoutes || 0),
    expectedOffersPerRoute: Number(rawMmCross?.expectedOffersPerRoute || 0),
    expectedOffersPerPair: Number(rawMmCross?.expectedOffersPerPair || 0),
    routes: Array.isArray(rawMmCross?.routes)
      ? rawMmCross.routes.map((route) => ({
          sourceJurisdiction: String(route.sourceJurisdiction || ''),
          targetJurisdiction: String(route.targetJurisdiction || ''),
          sourceHubEntityId: String(route.sourceHubEntityId || '').toLowerCase(),
          targetHubEntityId: String(route.targetHubEntityId || '').toLowerCase(),
          offers: Number(route.offers || 0),
          ready: route.ready === true,
          pairs: Array.isArray(route.pairs)
            ? route.pairs.map((pair) => ({
                pairId: String(pair.pairId || ''),
                offers: Number(pair.offers || 0),
                ready: pair.ready === true,
                sourceTokenIds: Array.isArray(pair.sourceTokenIds)
                  ? pair.sourceTokenIds.map(Number).filter(tokenId => Number.isFinite(tokenId) && tokenId > 0)
                  : [],
                targetTokenIds: Array.isArray(pair.targetTokenIds)
                  ? pair.targetTokenIds.map(Number).filter(tokenId => Number.isFinite(tokenId) && tokenId > 0)
                  : [],
              }))
            : [],
        }))
      : [],
  };
  const mmHubs = hubIds.map((hubEntityId) => {
    const existing = mmHubsById.get(hubEntityId);
    return {
      hubEntityId,
      offers: existing?.offers ?? 0,
      ready: existing?.ready === true || (!!mmExpectedOffersPerHub && (existing?.offers ?? 0) >= mmExpectedOffersPerHub),
      pairs: existing?.pairs ?? [],
    };
  });
  const mmCrossReady = !marketMakerActive || (Boolean(rawMmCross) && mmCross.ok);
  const mmOk = !marketMakerActive
    ? true
    : mmHubs.length === HUB_NAMES.length && mmHubs.every((hub) => hub.ready) && mmCrossReady;
  const hubMeshOk =
    hubIds.length === HUB_NAMES.length &&
    hubChildren.every((child) => child.lastHealth?.mesh?.ready === true);
  const hubsOnline = hubs.length === HUB_NAMES.length && hubs.every((hub) => hub.online);
  const custodyOk = args.custodyEnabled
    ? Boolean(custodySupport?.identity.entityId && custodySupport?.daemonChild.proc.exitCode === null && custodySupport?.custodyChild.proc.exitCode === null)
    : true;
  const bootstrapReservesOk =
    reserveEntities.length >= HUB_NAMES.length &&
    reserveEntities.every((entity) => entity.ready);
  const bootstrapReserveTargetsMet =
    reserveEntities.length >= HUB_NAMES.length &&
    reserveEntities.every((entity) => entity.targetMet);
  const coreOk = storage.ok && hubsOnline && hubMeshOk;
  const systemOk = coreOk && mmOk && custodyOk && bootstrapReservesOk;
  if (!resetState.inProgress && resetState.lastError && coreOk && !resetState.resolvedAt) {
    resetState.resolvedAt = Date.now();
  }
  const degraded = [
    storage.ok ? null : 'storage',
    hubsOnline ? null : 'hubs',
    hubMeshOk ? null : 'hubMesh',
    mmOk ? null : 'marketMaker',
    custodyOk ? null : 'custody',
    bootstrapReservesOk ? null : 'bootstrapReserves',
    bootstrapReserveTargetsMet ? null : 'bootstrapReserveTargets',
  ].filter((value): value is string => Boolean(value));

  return {
    timestamp: Date.now(),
    coreOk,
    systemOk,
    degraded,
    reset: { ...resetState },
    system: {
      runtime: true,
      relay: true,
    },
    relay: {
      clientCount: relayClientIds.length,
      managedRuntimeIds: Array.from(managedRuntimeIds).sort(),
      externalClientIds: externalClientIds.sort(),
      marketSubscriptions: marketSubscriptionStack.snapshot(),
    },
    process: buildProcessHealth(),
    disk: buildDiskSummary(storage),
    storage,
    hubMesh: {
      ok: hubMeshOk,
      hubIds,
      pairs: Array.from(pairSet.values()).sort((left, right) =>
        compareStableText(`${left.left}:${left.right}`, `${right.left}:${right.right}`),
      ),
      direct: {
        openLinkCount: directLinkMap.size,
        links: Array.from(directLinkMap.values()).sort((left, right) =>
          compareStableText(`${left.fromRuntimeId}:${left.toRuntimeId}`, `${right.fromRuntimeId}:${right.toRuntimeId}`),
        ),
      },
    },
    marketMaker: {
      enabled: marketMakerActive,
      ok: mmOk,
      entityId: mmEntityId,
      startupPhase: marketMakerChild.lastStartupPhase,
      expectedOffersPerHub: mmExpectedOffersPerHub,
      expectedOffersPerPair: Number(marketMakerChild.lastHealth?.marketMaker?.expectedOffersPerPair || 0),
      cross: mmCross,
      hubs: mmHubs,
    },
    custody: {
      enabled: args.custodyEnabled,
      ok: custodyOk,
      entityId: custodySupport?.identity.entityId ?? null,
      daemonPort: args.custodyEnabled ? args.custodyDaemonPort : null,
      servicePort: args.custodyEnabled ? args.custodyPort : null,
    },
    bootstrapReserves: {
      ok: bootstrapReservesOk,
      targetMet: bootstrapReserveTargetsMet,
      requiredTokenCount: HUB_REQUIRED_TOKEN_COUNT,
      entityCount: reserveEntities.length,
      entities: reserveEntities,
    },
    hubs,
    timings,
  };
};

const countSnapshotOrders = (snapshot: MarketSnapshotPayload | undefined): number => {
  const countSide = (levels: MarketSnapshotPayload['bids'] | undefined): number =>
    (levels ?? []).reduce((sum, level) => {
      const orderCount = Number(level.orderCount);
      return sum + (Number.isFinite(orderCount) && orderCount > 0 ? Math.floor(orderCount) : 1);
    }, 0);
  return countSide(snapshot?.bids) + countSide(snapshot?.asks);
};

const fetchRouteMarketSnapshots = async (
  hubEntityId: string,
  pairIds: string[],
): Promise<Map<string, number>> => {
  const child = getHubChildByEntityId(hubEntityId);
  if (!child || pairIds.length === 0) return new Map();
  const snapshots = await fetchHubMarketSnapshots(child, hubEntityId, pairIds, 20);
  return new Map(snapshots.map((snapshot) => [snapshot.pairId, countSnapshotOrders(snapshot)]));
};

const recomputeHealthWithMarketMaker = (
  health: AggregatedHealth,
  marketMaker: AggregatedHealth['marketMaker'],
): AggregatedHealth => {
  const systemOk = health.coreOk &&
    marketMaker.ok === true &&
    health.custody.ok === true &&
    health.bootstrapReserves.ok === true;
  const degraded = [
    health.storage.ok ? null : 'storage',
    health.hubs.every((hub) => hub.online) ? null : 'hubs',
    health.hubMesh.ok ? null : 'hubMesh',
    marketMaker.ok ? null : 'marketMaker',
    health.custody.ok ? null : 'custody',
    health.bootstrapReserves.ok ? null : 'bootstrapReserves',
    health.bootstrapReserves.targetMet ? null : 'bootstrapReserveTargets',
  ].filter((value): value is string => Boolean(value));
  return {
    ...health,
    systemOk,
    degraded,
    marketMaker,
  };
};

const enrichMarketMakerCrossFromHubSnapshots = async (health: AggregatedHealth): Promise<AggregatedHealth> => {
  const cross = health.marketMaker.cross;
  if (!args.mmEnabled || cross.routes.length === 0) return health;

  const routes = await Promise.all(cross.routes.map(async (route) => {
    const pairIds = Array.from(new Set((route.pairs ?? []).map(pair => String(pair.pairId || '')).filter(Boolean)));
    const [sourceSnapshots, targetSnapshots] = await Promise.all([
      fetchRouteMarketSnapshots(route.sourceHubEntityId, pairIds),
      fetchRouteMarketSnapshots(route.targetHubEntityId, pairIds),
    ]);
    const pairs = (route.pairs ?? []).map((pair) => {
      const pairId = String(pair.pairId || '');
      const sourceOffers = sourceSnapshots.get(pairId) ?? 0;
      const targetOffers = targetSnapshots.get(pairId) ?? 0;
      const offers = Math.max(Number(pair.offers || 0), sourceOffers, targetOffers);
      return {
        ...pair,
        offers,
        ready: offers >= Math.max(1, health.marketMaker.cross.expectedOffersPerPair || 1),
      };
    });
    const offers = pairs.reduce((sum, pair) => sum + pair.offers, 0);
    return {
      ...route,
      offers,
      ready: pairs.length > 0 &&
        offers >= Math.max(1, cross.expectedOffersPerRoute || 1) &&
        pairs.every(pair => pair.ready),
      pairs,
    };
  }));
  const enrichedCross = {
    ...cross,
    routes,
    ok: (cross.expectedRoutes > 0 ? routes.length >= cross.expectedRoutes : routes.length > 0) &&
      routes.every(route => route.ready),
  };
  const sameChainReady = !health.marketMaker.enabled ||
    (health.marketMaker.hubs.length === HUB_NAMES.length && health.marketMaker.hubs.every(hub => hub.ready));
  const marketMaker = {
    ...health.marketMaker,
    ok: !health.marketMaker.enabled || (sameChainReady && enrichedCross.ok),
    cross: enrichedCross,
  };
  return recomputeHealthWithMarketMaker(health, marketMaker);
};

type CustodyMePayload = {
  custody?: {
    entityId?: string | null;
  };
};

const buildAggregatedHealthResponse = async (): Promise<AggregatedHealth> => {
  const health = await enrichMarketMakerCrossFromHubSnapshots(computeAggregatedHealth());
  if (!health.custody.enabled || health.custody.ok || !health.custody.servicePort) {
    return health;
  }

  const liveCustody =
    await fetchJson<CustodyMePayload>(`https://127.0.0.1:${health.custody.servicePort}/api/me`, 1_500)
    ?? await fetchJson<CustodyMePayload>(`http://127.0.0.1:${health.custody.servicePort}/api/me`, 1_500);
  const liveEntityId = String(liveCustody?.custody?.entityId || '').trim();
  if (!liveEntityId) {
    return health;
  }

  const degraded = health.degraded.filter((entry) => entry !== 'custody');
  const systemOk = health.coreOk &&
    health.marketMaker.ok === true &&
    health.bootstrapReserves.ok === true;

  return {
    ...health,
    systemOk,
    degraded,
    custody: {
      ...health.custody,
      ok: true,
      entityId: liveEntityId,
    },
  };
};

const waitForHubBaseline = async (): Promise<void> => {
  const deadline = Date.now() + HUB_BASELINE_TIMEOUT_MS;
  const directRequired = HUB_NAMES.length * Math.max(0, HUB_NAMES.length - 1);
  const requireDirectLinks = process.env['XLN_REQUIRE_DIRECT_BASELINE'] === '1';
  let directGraceStartedAt = 0;
  let lastStatus: Record<string, unknown> | null = null;
  let warnedDirectGrace = false;
  while (Date.now() < deadline) {
    await pollAllHubHealth();
    const health = computeAggregatedHealth();
    const coreReady =
      health.hubMesh.ok &&
      health.bootstrapReserves.ok &&
      health.hubs.every(hub => hub.online);
    const directReady = health.hubMesh.direct.openLinkCount >= directRequired;
    lastStatus = {
      coreReady,
      directReady,
      directOpen: health.hubMesh.direct.openLinkCount,
      directRequired,
      requireDirectLinks,
      bootstrapReserves: health.bootstrapReserves.ok,
      hubsOnline: health.hubs.map(hub => ({ name: hub.name, online: hub.online, selfRelayPresence: hub.selfRelayPresence })),
      degraded: health.degraded,
    };
    if (coreReady) {
      if (directReady || !requireDirectLinks) {
        if (!directReady) {
          if (!directGraceStartedAt) directGraceStartedAt = Date.now();
          const waitedMs = Date.now() - directGraceStartedAt;
          if (waitedMs < HUB_DIRECT_LINK_BASELINE_GRACE_MS) {
            await delay(250);
            continue;
          }
          if (!warnedDirectGrace) {
            warnedDirectGrace = true;
            console.warn(
              `[MESH] baseline proceeding after direct-link grace: open=${health.hubMesh.direct.openLinkCount}/${directRequired} graceMs=${HUB_DIRECT_LINK_BASELINE_GRACE_MS}`,
            );
          }
        }
        return;
      }
    }
    await delay(250);
  }
  throw new Error(`HUB_BASELINE_TIMEOUT ${safeStringify({ status: lastStatus, health: computeAggregatedHealth() })}`);
};

const waitForHubProfilesReady = async (): Promise<void> => {
  const deadline = Date.now() + HUB_PROFILES_READY_TIMEOUT_MS;
  let lastVisibleByHub: Record<string, string[]> = {};
  while (Date.now() < deadline) {
    await pollAllHubHealth();
    const allVisible = hubChildren.every((child) => {
      const visibleNames = new Set(child.lastHealth?.gossip?.visibleHubNames ?? []);
      return HUB_NAMES.every((name) => visibleNames.has(name));
    });
    if (allVisible) {
      return;
    }
    lastVisibleByHub = Object.fromEntries(hubChildren.map(child => [
      child.name,
      child.lastHealth?.gossip?.visibleHubNames ?? [],
    ]));
    if (hubChildren.some((child) => child.proc?.exitCode !== null)) {
      throw new Error(`HUB_PROFILES_READY_EXIT ${safeStringify(computeAggregatedHealth().hubs)}`);
    }
    await delay(250);
  }
  console.warn(
    `[MESH] continuing after gossip profile grace: timeoutMs=${HUB_PROFILES_READY_TIMEOUT_MS} visible=${safeStringify(lastVisibleByHub)}`,
  );
};

const waitForMarketMakerReady = async (): Promise<void> => {
  const deadline = Date.now() + MARKET_MAKER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await pollMarketMakerHealth();
    const health = await buildAggregatedHealthResponse();
    if (
      !args.mmEnabled ||
      health.marketMaker.ok
    ) {
      return;
    }
    if (marketMakerChild.exitCode !== null || marketMakerChild.exitSignal !== null) {
      throw new Error(
        `MM_EXITED_EARLY code=${String(marketMakerChild.exitCode)} signal=${String(marketMakerChild.exitSignal)} phase=${String(marketMakerChild.lastStartupPhase)} marketMaker=${safeStringify(health.marketMaker)}`,
      );
    }
    await delay(250);
  }
  throw new Error(
    `MM_READY_TIMEOUT phase=${String(marketMakerChild.lastStartupPhase)} marketMaker=${safeStringify((await buildAggregatedHealthResponse()).marketMaker)}`,
  );
};

const waitForHubSelfReady = async (child: HubChild): Promise<void> => {
  const deadline = Date.now() + HUB_SELF_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await pollHubHealth(child);
    if (child.lastInfo !== null || child.lastHealth !== null) {
      return;
    }
    if (child.proc?.exitCode !== null) {
      throw new Error(`${child.name}_SELF_READY_EXITED_EARLY code=${String(child.proc?.exitCode)} stderr=${safeStringify(child.recentStderr.slice(-8))}`);
    }
    await delay(250);
  }
  throw new Error(`${child.name}_SELF_READY_TIMEOUT ${safeStringify({ health: child.lastHealth, stderr: child.recentStderr.slice(-8) })}`);
};

const waitForShardJurisdictions = async (child: HubChild): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(shardJurisdictionsPath)) {
      return;
    }
    const payload = await fetchText(`http://${args.host}:${child.apiPort}/api/jurisdictions`);
    if (payload) {
      writeFileSync(shardJurisdictionsPath, payload, 'utf8');
      return;
    }
    if (child.proc?.exitCode !== null) {
      throw new Error(`${child.name}_EXITED_BEFORE_JURISDICTIONS code=${String(child.proc?.exitCode)}`);
    }
    await delay(150);
  }
  throw new Error(`${child.name}_JURISDICTIONS_TIMEOUT path=${shardJurisdictionsPath}`);
};

const runReset = async (options: { enableMarketMaker: boolean } = { enableMarketMaker: args.mmEnabled }): Promise<void> => {
  resetState.inProgress = true;
  resetState.lastError = null;
  resetState.startedAt = Date.now();
  resetState.completedAt = null;
  resetState.failedAt = null;
  resetState.resolvedAt = null;

  const resetTotalStartedAt = startTiming('reset_total');
  try {
    const stopStartedAt = startTiming('reset_stop_children');
    await stopAllChildren();
    finishTiming('reset_stop_children', stopStartedAt);

    const clearStartedAt = startTiming('reset_clear_state');
    clearRelayState();
    await reapStaleManagedChildren();
    if (existsSync(args.dbRoot)) {
      rmSync(args.dbRoot, { recursive: true, force: true });
    }
    mkdirSync(args.dbRoot, { recursive: true });
    seedShardJurisdictions(jurisdictionsConfig);
    await deployRpc2JurisdictionStack(jurisdictionsConfig);
    finishTiming('reset_clear_state', clearStartedAt);

    const h1 = hubChildren[0]!;
    const h23 = hubChildren.slice(1);

    const spawnH1StartedAt = startTiming('reset_spawn_h1');
    await spawnHub(h1);
    finishTiming('reset_spawn_h1', spawnH1StartedAt);

    const waitH1StartedAt = startTiming('reset_wait_h1');
    await waitForHubSelfReady(h1);
    finishTiming('reset_wait_h1', waitH1StartedAt);
    await waitForShardJurisdictions(h1);

    const spawnH23StartedAt = startTiming('reset_spawn_h23');
    for (const child of h23) {
      await spawnHub(child);
      await waitForHubSelfReady(child);
    }
    finishTiming('reset_spawn_h23', spawnH23StartedAt);

    const waitStartedAt = startTiming('reset_wait_hubs');
    await waitForHubProfilesReady();
    await waitForHubBaseline();
    finishTiming('reset_wait_hubs', waitStartedAt);

    let marketMakerBootstrapError: unknown = null;
    const shouldStartMarketMaker = args.mmEnabled && options.enableMarketMaker;
    const marketMakerReady = shouldStartMarketMaker ? (async (): Promise<void> => {
      const marketMakerStartedAt = startTiming('reset_market_maker');
      try {
        await spawnMarketMaker();
        await waitForMarketMakerReady();
      } catch (error) {
        marketMakerBootstrapError = error;
      } finally {
        finishTiming('reset_market_maker', marketMakerStartedAt);
      }
    })() : null;

    let custodyBootstrapError: unknown = null;
    if (args.custodyEnabled) {
      const custodyStartedAt = startTiming('reset_custody');
      try {
        custodySupport = await startCustodySupport({
          apiBaseUrl: `http://${args.host}:${args.port}`,
          daemonPort: args.custodyDaemonPort,
          custodyPort: args.custodyPort,
          relayUrl,
          rpcUrl: args.rpcUrl,
          walletUrl: args.walletUrl,
          dbRoot: args.custodyDbRoot,
          seed: 'xln-mesh-custody-seed',
          signerLabel: 'custody-mesh-1',
          profileName: 'Custody',
          jurisdictionId: 'arrakis',
        });
      } catch (error) {
        custodyBootstrapError = error;
        console.error('[MESH] custody bootstrap failed; continuing market maker startup before failing reset:', serializeError(error));
      } finally {
        finishTiming('reset_custody', custodyStartedAt);
      }
    }

    if (marketMakerReady) await marketMakerReady;
    if (marketMakerBootstrapError) throw marketMakerBootstrapError;
    if (custodyBootstrapError) throw custodyBootstrapError;

    finishTiming('reset_total', resetTotalStartedAt);
    resetState.completedAt = Date.now();
  } catch (error) {
    resetState.lastError = serializeError(error);
    resetState.failedAt = Date.now();
    resetState.completedAt = null;
    throw error;
  } finally {
    resetState.inProgress = false;
  }
};

const ensureReset = async (): Promise<void> => {
  if (resetPromise) {
    await resetPromise;
    if (!resetState.lastError || resetState.resolvedAt) {
      return;
    }
  }
  resetPromise = runReset().finally(() => {
    resetPromise = null;
  });
  await resetPromise;
};

const ensureResetWithOptions = async (options: { enableMarketMaker: boolean }): Promise<void> => {
  if (resetPromise) await resetPromise;
  resetPromise = runReset(options).finally(() => {
    resetPromise = null;
  });
  await resetPromise;
};
const {
  proxyAnyHubGet,
  proxyAnyHubRequest,
  proxyHubApi,
  proxyRpc,
} = createOrchestratorProxyHandlers({
  host: args.host,
  defaultRpcUrl: args.rpcUrl,
  pollAllHubHealth,
  getHubChildByEntityId,
  getHealthyHub: getHealthyHubChild,
});

const httpDrain = createHttpDrainTracker();
const server = Bun.serve({
  hostname: args.host,
  port: args.port,
  idleTimeout: 120,
  async fetch(request, serverRef) {
    const releaseHttp = httpDrain.begin();
    try {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (request.headers.get('upgrade') === 'websocket' && pathname === '/relay') {
      const upgraded = serverRef.upgrade(request, { data: { type: 'relay', clientIp: resolveRequestClientIp(request) } });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    if ((pathname === '/rpc' || pathname === '/api/rpc') && request.method === 'POST') {
      return await proxyRpc(request);
    }

    if ((pathname === '/rpc2' || pathname === '/api/rpc2') && request.method === 'POST') {
      return await proxyRpc(request, args.rpc2Url);
    }

    if (pathname === '/api/faucet/offchain' && request.method === 'POST') {
      return await proxyHubApi(request, '/api/faucet/offchain');
    }

    if (pathname === '/api/hub/account-status' && request.method === 'GET') {
      await pollAllHubHealth();
      const hubEntityId = String(url.searchParams.get('hubEntityId') || '').toLowerCase();
      const counterpartyEntityId = String(url.searchParams.get('counterpartyEntityId') || '').toLowerCase();
      const child = getHubChildByEntityId(hubEntityId);
      if (!child) {
        return new Response(safeStringify({
          success: false,
          code: 'HUB_ACCOUNT_STATUS_HUB_NOT_FOUND',
          error: `Hub not found for hubEntityId=${hubEntityId || 'missing'}`,
        }), { status: 404, headers });
      }
      const childUrl = new URL(`http://${args.host}:${child.apiPort}/api/account/status`);
      childUrl.searchParams.set('hubEntityId', hubEntityId);
      childUrl.searchParams.set('counterpartyEntityId', counterpartyEntityId);
      const tokenIds = String(url.searchParams.get('tokenIds') || '').trim();
      if (tokenIds) childUrl.searchParams.set('tokenIds', tokenIds);
      try {
        const response = await fetch(childUrl);
        const text = await response.text();
        return new Response(text, {
          status: response.status,
          headers: {
            ...headers,
            'content-type': response.headers.get('content-type') || 'application/json',
          },
        });
      } catch (error) {
        return new Response(safeStringify({
          success: false,
          code: 'HUB_ACCOUNT_STATUS_PROXY_FAILED',
          error: error instanceof Error ? error.message : String(error),
        }), { status: 502, headers });
      }
    }

    if (pathname === '/api/lending/state' && request.method === 'GET') {
      return await proxyAnyHubGet(request, `${pathname}${url.search}`);
    }

    if (pathname === '/api/lending/offer' && request.method === 'POST') {
      return await proxyHubApi(request, '/api/lending/offer');
    }
    if (pathname === '/api/lending/borrow' && request.method === 'POST') {
      return await proxyHubApi(request, '/api/lending/borrow');
    }
    if (pathname === '/api/lending/repay' && request.method === 'POST') {
      return await proxyHubApi(request, '/api/lending/repay');
    }

    if (
      (pathname === '/api/faucet/erc20' || pathname === '/api/faucet/gas' || pathname === '/api/faucet/reserve')
      && request.method === 'POST'
    ) {
      return await proxyAnyHubRequest(request, pathname);
    }

    if (pathname === '/api/health') {
      void getStorageHealth().catch(() => {});
      void pollAllHubHealth().catch(() => {});
      void pollMarketMakerHealth().catch(() => {});
      const health = await buildAggregatedHealthResponse();
      return new Response(safeStringify(isLocalOperatorRequest(request) ? health : publicAggregatedHealth(health)), { headers });
    }

    if (pathname === '/api/metrics') {
      void getStorageHealth().catch(() => {});
      void pollAllHubHealth().catch(() => {});
      void pollMarketMakerHealth().catch(() => {});
      const health = await buildAggregatedHealthResponse();
      return new Response(buildPrometheusMetrics(health), {
        headers: {
          ...headers,
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        },
      });
    }

    const qaResponse = await maybeHandleQaRequest(request, pathname, headers);
    if (qaResponse) return qaResponse;

    if (pathname === '/api/hubs') {
      await pollAllHubHealth();
      return new Response(safeStringify(buildPublicHubDiscoveryPayload({
        hubChildren,
        relayStore,
        primaryJurisdictionFallback: resolvePrimaryHubJurisdictionFallback(jurisdictionsConfig),
      })), { headers });
    }

    const debugResponse = await maybeHandleOrchestratorDebugApi({
      request,
      pathname,
      url,
      headers,
      relayStore,
      hubChildren,
      marketMakerChild,
      pollAllHubHealth,
      pollMarketMakerHealth,
      proxyAnyHubGet,
    });
    if (debugResponse) return debugResponse;

    if (pathname === '/api/reset' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => null) as OrchestratorResetBody | null;
        assertOrchestratorResetAllowed(request, body, {
          resetAllowed: args.resetAllowed,
          bindHost: args.host,
          resetToken: args.resetToken,
        });
        const requestedMarketMaker = body?.enableMarketMaker ?? body?.requireMarketMaker;
        const enableMarketMaker = typeof requestedMarketMaker === 'boolean'
          ? requestedMarketMaker
          : args.mmEnabled;
        await ensureResetWithOptions({ enableMarketMaker });
        await pollAllHubHealth();
        if (enableMarketMaker) await pollMarketMakerHealth();
        return new Response(safeStringify(await buildAggregatedHealthResponse()), { headers });
      } catch (error) {
        if (error instanceof OrchestratorResetRejectedError) {
          return new Response(
            safeStringify({
              error: error.code,
              ...(error.code === 'RESET_CONFIRMATION_REQUIRED' ? { requiredConfirmation: ORCHESTRATOR_RESET_CONFIRMATION } : {}),
            }),
            { status: error.status, headers },
          );
        }
        let health: AggregatedHealth | null = null;
        let healthError: string | null = null;
        try {
          health = await buildAggregatedHealthResponse();
        } catch (healthBuildError) {
          healthError = serializeError(healthBuildError);
        }
        return new Response(
          safeStringify({
            error: serializeError(error),
            ...(health ? { health } : {}),
            ...(healthError ? { healthError } : {}),
          }),
          { status: 500, headers },
        );
      }
    }

    if (pathname === '/api/info') {
      return new Response(safeStringify({
        name: 'mesh-control',
        relayUrl,
        rpcUrl: args.rpcUrl,
        host: args.host,
        port: args.port,
        mmEnabled: args.mmEnabled,
        resetAllowed: args.resetAllowed,
      }), { headers });
    }

    if (pathname === '/api/jurisdictions') {
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
    }

    if (pathname === '/api/tokens' && request.method === 'GET') {
      return await proxyAnyHubRequest(request, `${pathname}${url.search}`);
    }

    if (pathname === '/api/watchtower-proxy' && (request.method === 'GET' || request.method === 'POST' || request.method === 'PUT')) {
      return await handleWatchtowerProxy(request);
    }

    if (pathname.startsWith('/api/')) {
      return await proxyAnyHubRequest(request, `${pathname}${url.search}`);
    }

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
    open(_ws) {
      pushDebugEvent(relayStore, {
        event: 'ws_open',
        details: { wsType: 'relay' },
      });
    },
    message(ws, raw) {
      const msgStr = raw.toString();
      try {
        const msg = JSON.parse(msgStr);
        if (isMarketMessageType(msg?.type)) {
          Promise.resolve(marketSubscriptionStack.handleMessage(ws as OrchestratorWebSocket, msg as Record<string, unknown>)).catch(error => {
            const reason = serializeError(error);
            pushDebugEvent(relayStore, {
              event: 'error',
              reason: 'MARKET_HANDLER_EXCEPTION',
              details: { error: reason, msgType: msg?.type },
            });
            try {
              ws.send(safeStringify({ type: 'error', error: reason }));
            } catch {}
          });
          return;
        }
        Promise.resolve(relayRoute(routerConfig, ws as OrchestratorWebSocket, msg)).catch(error => {
          const reason = serializeError(error);
          pushDebugEvent(relayStore, {
            event: 'error',
            reason: 'RELAY_HANDLER_EXCEPTION',
            details: { error: reason, msgType: msg?.type, from: msg?.from, to: msg?.to },
          });
          try {
            ws.send(safeStringify({ type: 'error', error: reason }));
          } catch {}
        });
      } catch (error) {
        pushDebugEvent(relayStore, {
          event: 'error',
          reason: 'INVALID_JSON',
          details: { error: serializeError(error) },
        });
        try {
          ws.send(safeStringify({ type: 'error', error: 'Invalid JSON' }));
        } catch {}
      }
    },
    close(ws) {
      const relayWs = ws as OrchestratorWebSocket;
      cleanupRpcMarketSubscription(relayWs);
      forgetRelaySocketRuntimeId(relayWs);
      removeClient(relayStore, relayWs);
    },
  },
});

const shutdown = async (): Promise<void> => {
  await stopServerGracefully(server, httpDrain, 'orchestrator', 5_000);
  await stopAllChildren();
  process.exit(0);
};

process.on('SIGTERM', () => {
  if (resetState.inProgress) {
    console.warn('[MESH] received SIGTERM from parent during reset');
  }
  void shutdown();
});
process.on('SIGINT', () => { void shutdown(); });

console.log(
  `[MESH] CONTROL ready host=${args.host} port=${args.port} relay=${relayUrl} rpc=${args.rpcUrl} mm=${args.mmEnabled ? 'on' : 'off'} custody=${args.custodyEnabled ? 'on' : 'off'} reset=${args.resetAllowed ? 'on' : 'off'} deferInitialReset=${args.deferInitialReset ? 'on' : 'off'}`,
);

assertMinDiskFree();

if (!args.deferInitialReset) {
  void ensureReset().catch(error => {
    console.error('[MESH] initial reset failed:', serializeError(error));
  });
}
