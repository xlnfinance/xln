#!/usr/bin/env bun

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { compareStableText, safeStringify } from '../protocol/serialization';
import { REMOTE_RUNTIME } from '../constants';
import { createStructuredLogger } from '../infra/logger';
import { deriveSignerAddressSync } from '../account/crypto';
import { deriveRuntimeAdapterCapabilityToken } from '../radapter/auth';
import { sanitizeChildProcessEnv } from '../server/child-process-env';
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
} from '../relay/store';
import { forgetRelaySocketRuntimeId, relayRoute, type RelayRouterConfig } from '../relay/router';
import { deserializeWsMessage, serializeWsMessage, type RuntimeWsMessage } from '../networking/ws-protocol';
import { createHelloChallengeRegistry } from '../networking/hello-challenge';
import { type MarketSnapshotPayload } from '../relay/market-snapshot';
import { createMarketSubscriptionStack, isMarketMessageType } from '../relay/market-subscriptions';
import { assertMinDiskFree, getStorageHealth, getStorageHealthSnapshotSync, type StorageHealth } from './storage-monitor';
import { maybeHandleQaRequest } from '../qa/api';
import { serveRuntimeBundle, serveStatic } from '../server/static-assets';
import { handleWatchtowerProxy } from '../server/watchtower-proxy';
import {
  createAssistantProxyFromEnv,
  resolveAssistantDirectClientIp,
  resolveAssistantRateClientId,
} from '../server/assistant-proxy';
import { createHttpDrainTracker, stopServerGracefully } from './graceful-server';
import { publicAggregatedHealth, resolveSocketPeerAddress } from '../server/health-redaction';
import { isOperatorRequest, loadOrCreateOperatorToken } from './operator-access';
import {
  normalizeRuntimeImportAccess,
  resolveRuntimeImportAccessForRequest,
  type RuntimeImportAccess,
} from './runtime-import-access';
import type {
  AggregatedHealth,
  CustodySupportState,
  HubChild,
  HubHealthPayload,
  HubInfoPayload,
  ManagedRuntimeSpec,
  MarketMakerChild,
  MarketMakerHealthPayload,
  OrchestratorWebSocket,
  ResetState,
  TimingMap,
} from './orchestrator-types';
import {
  CHILD_HEALTH_TIMEOUT_MS,
  CHILD_LOG_RING_MAX,
  HEALTH_RESPONSE_REFRESH_TIMEOUT_MS,
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
import { deriveHubRuntimeHealth, deriveResetHealthOk } from './health-model';
import { buildPublicHubDiscoveryPayload } from './public-discovery';
import {
  assertOrchestratorResetAllowed,
  ORCHESTRATOR_RESET_CONFIRMATION,
  OrchestratorResetRejectedError,
  type OrchestratorResetBody,
} from './reset-guard';
import {
  deployRpc2JurisdictionStack,
  hasShardRpc2Jurisdiction,
  readShardJurisdictions,
  resolvePrimaryHubJurisdictionFallback,
  seedShardJurisdictions,
  syncCanonicalJurisdictionsFromShard,
  toPublicJurisdictionsPayload,
  type OrchestratorJurisdictionsConfig,
} from './jurisdictions';
import { createOrchestratorProxyHandlers, resolveRpcProxyIndex } from './proxy';
import {
  findMissingRpcContractCode,
  type RpcContractAddresses,
} from './contract-readiness';
import { maybeHandleOrchestratorDebugApi } from './debug-api';
import {
  HUB_MESH_CREDIT_AMOUNT,
  deriveMarketMakerEntityId,
  type MarketMakerEntityJurisdictionConfig,
} from './mesh-common';
import {
  resolveMeshJurisdictionConfig,
  resolveSecondaryJurisdictions,
  type MeshJurisdictionConfig,
} from './mesh-jurisdictions';
import { buildRuntimeImportLogLine } from './runtime-import-log';
import {
  normalizeMarketMakerHealthPayload,
} from './market-maker-health-payload';
import { createMarketMakerChildPoller } from './market-maker-child-poll';
import { buildAggregatedMarketMakerHealth } from './market-maker-aggregated-health';
import { resolveRuntimeImportReadiness } from './runtime-import-readiness';
import { buildRuntimeHealthFailures, classifyRuntimeBootstrapStageFailure } from '../protocol/failure-taxonomy';
import { STORAGE_WRITER_LOCK_TTL_MS } from '../storage/runtime-dbs';
import {
  deriveMeshChildSeed,
  readMeshSeedOverrides,
  requireMeshRootSeed,
} from './mesh-seeds';

const buildDiskSummary = (storage: StorageHealth): AggregatedHealth['disk'] => {
  const totalBytes = Number(storage.disk.totalBytes || 0);
  const usedBytes = Number(storage.disk.usedBytes || 0);
  const freeBytes = Number(storage.disk.freeBytes || 0);
  const shortfallBytes = Number(storage.shortfallBytes || 0);
  const toGiB = (value: number): number => Math.round((value / 1024 ** 3) * 100) / 100;
  return {
    ok: storage.ok,
    minFreeBytes: storage.minFreeBytes,
    shortfallBytes,
    freeBytes,
    usedBytes,
    totalBytes,
    shortfallGiB: toGiB(shortfallBytes),
    freeGiB: toGiB(freeBytes),
    usedGiB: toGiB(usedBytes),
    totalGiB: toGiB(totalBytes),
    usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10000) / 100 : 0,
  };
};

const args = parseArgs();
const orchestratorOwnerId = `${process.pid}:${Date.now()}:${randomUUID()}`;
const readGitValue = (gitArgs: string[]): string | null => {
  try {
    const value = execFileSync('git', gitArgs, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
};
const orchestratorCodeFingerprint = (() => {
  const gitHead = readGitValue(['rev-parse', 'HEAD']);
  const gitBranch = readGitValue(['rev-parse', '--abbrev-ref', 'HEAD']);
  const gitStatus = readGitValue(['status', '--porcelain']) ?? '';
  const dirty = gitStatus.length > 0;
  return {
    gitHead,
    gitBranch,
    dirty,
    codeHash: gitHead ? `${gitHead}${dirty ? '-dirty' : ''}` : null,
    computedAt: Date.now(),
  };
})();
const staleReapEnabled = process.env['XLN_SKIP_STALE_REAP'] !== '1';
const BOOTSTRAP_EVENT_TAIL_BYTES = 64 * 1024;
const MARKET_MAKER_INFO_TIMEOUT_MS = Math.max(
  500,
  Math.min(CHILD_HEALTH_TIMEOUT_MS, Math.floor(Number(process.env['XLN_MARKET_MAKER_INFO_TIMEOUT_MS'] || '1500'))),
);
const MARKET_MAKER_FULL_HEALTH_TIMEOUT_MS = Math.max(
  CHILD_HEALTH_TIMEOUT_MS,
  Math.floor(Number(process.env['XLN_MARKET_MAKER_FULL_HEALTH_TIMEOUT_MS'] || '60000')),
);
const marketMakerReadyRestartLimit = Math.max(
  0,
  Math.floor(Number(process.env['XLN_MARKET_MAKER_READY_RESTARTS'] ?? '2')),
);
const MARKET_MAKER_RESTART_FENCING_GRACE_MS = STORAGE_WRITER_LOCK_TTL_MS + 1_000;
const HUB_BOOTSTRAP_PAUSE_STORAGE = process.env['XLN_HUB_BOOTSTRAP_PAUSE_STORAGE'] ?? '1';
const HUB_READY_SNAPSHOT_TIMEOUT_MS = Math.max(
  5_000,
  Math.floor(Number(process.env['XLN_HUB_READY_SNAPSHOT_TIMEOUT_MS'] || '60000')),
);
const relayUrl = args.relayUrl;
const shardJurisdictionsPath = join(args.dbRoot, 'jurisdictions.json');
const controlPlaneDir = join(args.dbRoot, '.control-plane');
const managedRuntimeLeases = createManagedRuntimeLeaseManager({
  controlPlaneDir,
  ownerId: orchestratorOwnerId,
});
const jurisdictionsConfig: OrchestratorJurisdictionsConfig = {
  shardJurisdictionsPath,
  rpc2Url: args.rpc2Url,
  rpcUrls: args.rpcUrls,
};

const relayStore: RelayStore = createRelayStore('mesh-relay');
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
  resolvedAt: null,
};

const meshRootSeed = requireMeshRootSeed();
const runtimeSeedOverrides = readMeshSeedOverrides(
  process.env['XLN_MESH_RUNTIME_SEEDS_JSON'],
  'XLN_MESH_RUNTIME_SEEDS_JSON',
);
const radapterAuthSeeds = readMeshSeedOverrides(
  process.env['XLN_MESH_RADAPTER_AUTH_SEEDS_JSON'],
  'XLN_MESH_RADAPTER_AUTH_SEEDS_JSON',
);
const runtimeSeedFor = (name: string): string =>
  runtimeSeedOverrides[name.toUpperCase()] || deriveMeshChildSeed(meshRootSeed, `runtime:${name}`);
const radapterAuthSeedFor = (name: string): string =>
  radapterAuthSeeds[name.toUpperCase()] || deriveMeshChildSeed(meshRootSeed, `radapter:${name}`);

const hubChildren: HubChild[] = HUB_NAMES.map((name, index) => ({
  name,
  region: 'global',
  seed: runtimeSeedFor(name),
  authSeed: radapterAuthSeedFor(name),
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
  seed: runtimeSeedFor('MM'),
  authSeed: radapterAuthSeedFor('MM'),
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

type RuntimeImportManifestEntry = {
  label: string;
  access: RuntimeImportAccess;
  wsUrl: string;
  token: string;
};

type RuntimeImportManifest = {
  v: 1;
  issuedAt: number;
  expiresAt: number;
  entries: RuntimeImportManifestEntry[];
};

const runtimeImportAccess = normalizeRuntimeImportAccess(process.env['XLN_RUNTIME_IMPORT_ACCESS']);
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
const runtimeImportLogUrlEnabled = ['1', 'true', 'yes', 'on'].includes(
  String(process.env['XLN_RUNTIME_IMPORT_LOG_URL'] || '').trim().toLowerCase(),
);

const isLoopbackPublicBase = (() => {
  try {
    return /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\])/.test(new URL(args.publicWsBaseUrl).hostname);
  } catch {
    return true;
  }
})();

// Externally-reachable radapter /rpc URL for a hub / market-maker node.
// Prod is fronted by nginx (publicPort -> apiPort, e.g. 8090 -> 18090); local has no proxy,
// so the browser must hit the apiPort directly.
const buildRuntimeNodeRpcUrl = (apiPort: number, publicPort: number): string => {
  const url = new URL(args.publicWsBaseUrl);
  url.port = String(isLoopbackPublicBase ? apiPort : publicPort);
  url.pathname = '/rpc';
  url.search = '';
  url.hash = '';
  return url.toString();
};

// Custody runs server.ts on a daemon port that is not nginx-fronted. On prod it must be exposed
// via a dedicated subdomain set in XLN_CUSTODY_PUBLIC_RPC_URL (e.g. wss://custody.xln.finance/rpc).
// Locally we hit the daemon port directly. Returns null when prod has no public route configured
// yet, so the manifest omits an unreachable custody entry instead of advertising a broken one.
const custodyPublicRpcUrlEnv = String(process.env['XLN_CUSTODY_PUBLIC_RPC_URL'] || '').trim();
const buildCustodyRpcUrl = (daemonPort: number): string | null => {
  if (custodyPublicRpcUrlEnv) return custodyPublicRpcUrlEnv;
  if (!isLoopbackPublicBase) return null;
  const url = new URL(args.publicWsBaseUrl);
  url.port = String(daemonPort);
  url.pathname = '/rpc';
  url.search = '';
  url.hash = '';
  return url.toString();
};

const deriveRuntimeImportToken = (
  seed: string,
  access: 'read' | 'admin',
  audience: string,
  keyId: string,
  expiresAt: number,
): string => deriveRuntimeAdapterCapabilityToken(
  seed,
  access === 'admin' ? 'full' : 'read',
  expiresAt,
  {
    audience,
    keyId,
    tokenId: `bulk-${keyId}-${expiresAt}`,
  },
);

const buildRuntimeImportUrl = (manifest: RuntimeImportManifest): string => {
  const url = new URL(args.walletUrl);
  const accesses = new Set(manifest.entries.map(entry => entry.access));
  if (accesses.size !== 1) {
    throw new Error(`RUNTIME_IMPORT_URL_ACCESS_MISMATCH:${Array.from(accesses).join(',')}`);
  }
  const access = manifest.entries[0]?.access ?? runtimeImportAccess;
  url.pathname = '/app';
  url.search = '';
  url.hash = `${REMOTE_RUNTIME.IMPORT_SOURCE_HASH_PARAM}=${encodeURIComponent(`/api/runtime-import?access=${access}`)}`;
  return url.toString();
};

const runtimeIdFromChild = (child: HubChild | MarketMakerChild): string =>
  String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '').trim().toLowerCase();

const buildRuntimeImportManifest = (access: RuntimeImportAccess = runtimeImportAccess): RuntimeImportManifest | null => {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + runtimeImportTokenTtlMs;
  const entries: RuntimeImportManifestEntry[] = [];
  for (const child of hubChildren) {
    const runtimeId = runtimeIdFromChild(child);
    if (!runtimeId) continue;
    entries.push({
      label: child.name,
      access,
      wsUrl: buildRuntimeNodeRpcUrl(child.apiPort, child.publicPort),
      token: deriveRuntimeImportToken(child.authSeed, access, runtimeId, child.name.toLowerCase(), expiresAt),
    });
  }
  const marketMakerRuntimeId = runtimeIdFromChild(marketMakerChild);
  if (args.mmEnabled && marketMakerRuntimeId) {
    entries.push({
      label: marketMakerChild.name,
      access,
      wsUrl: buildRuntimeNodeRpcUrl(marketMakerChild.apiPort, marketMakerChild.publicPort),
      token: deriveRuntimeImportToken(marketMakerChild.authSeed, access, marketMakerRuntimeId, 'mm', expiresAt),
    });
  }
  if (args.custodyEnabled && custodySupport?.daemonAuthSeed && custodySupport.daemonAuthAudience) {
    const custodyWsUrl = buildCustodyRpcUrl(args.custodyDaemonPort);
    if (custodyWsUrl) {
      entries.push({
        label: 'Custody',
        access,
        wsUrl: custodyWsUrl,
        token: deriveRuntimeImportToken(
          custodySupport.daemonAuthSeed,
          access,
          custodySupport.daemonAuthAudience,
          'custody',
          expiresAt,
        ),
      });
    }
  }
  return entries.length > 0 ? { v: 1, issuedAt, expiresAt, entries } : null;
};

const clearRuntimeImportManifestFile = (): void => {
  rmSync(runtimeImportManifestPath, { force: true });
};

const publishRuntimeImportManifest = async (): Promise<boolean> => {
  const health = await buildAggregatedHealthResponse();
  const readiness = resolveRuntimeImportReadiness(health);
  if (!readiness.ok) {
    clearRuntimeImportManifestFile();
    scheduleRuntimeImportManifestRefresh(null);
    return false;
  }
  const manifest = buildRuntimeImportManifest();
  if (!manifest) {
    clearRuntimeImportManifestFile();
    scheduleRuntimeImportManifestRefresh(null);
    return false;
  }
  const importUrl = buildRuntimeImportUrl(manifest);
  mkdirSync(dirname(runtimeImportManifestPath), { recursive: true });
  writeFileSync(
    runtimeImportManifestPath,
    `${safeStringify({ importUrl, manifest })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  console.log(buildRuntimeImportLogLine({
    manifest,
    importUrl,
    access: runtimeImportAccess,
    manifestPath: runtimeImportManifestPath,
    exposeUrl: runtimeImportLogUrlEnabled,
  }));
  scheduleRuntimeImportManifestRefresh(manifest);
  return true;
};

let runtimeImportRefreshTimer: ReturnType<typeof setTimeout> | null = null;

const scheduleRuntimeImportManifestRefresh = (manifest: RuntimeImportManifest | null): void => {
  if (runtimeImportRefreshTimer) clearTimeout(runtimeImportRefreshTimer);
  const delayMs = manifest
    ? Math.max(10_000, manifest.expiresAt - Date.now() - runtimeImportRefreshMarginMs)
    : 10_000;
  runtimeImportRefreshTimer = setTimeout(() => {
    runtimeImportRefreshTimer = null;
    void publishRuntimeImportManifest().catch((error) => {
      meshLog.warn('runtime_import_manifest.refresh_failed', { error: serializeError(error) });
      clearRuntimeImportManifestFile();
      scheduleRuntimeImportManifestRefresh(null);
    });
  }, delayMs);
};

let resetPromise: Promise<void> | null = null;
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

const readTailText = (path: string, maxBytes: number): string | null => {
  if (!path || !existsSync(path)) return null;
  let fd: number | null = null;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0) return null;
    const length = Math.min(stat.size, Math.max(1, maxBytes));
    const buffer = Buffer.alloc(length);
    fd = openSync(path, 'r');
    const offset = Math.max(0, stat.size - length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return buffer.toString('utf8', 0, bytesRead);
  } catch (error) {
    warnBootstrapTailRead('bootstrap_events_tail_read_failed', path, error);
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch (error) {
        warnBootstrapTailRead('bootstrap_events_tail_close_failed', path, error);
      }
    }
  }
};

const marketMakerBootstrapEventsPath = (): string =>
  String(process.env['XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL'] || '').trim() ||
  join(marketMakerChild.dbPath, 'bootstrap-events.jsonl');

const envFlagEnabled = (value: unknown): boolean => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

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

type PrefixLogState = { pending: string };

const writePrefixedLogChunk = (
  stream: NodeJS.WritableStream,
  prefix: string,
  state: PrefixLogState,
  chunk: Buffer | string,
): void => {
  const text = `${state.pending}${chunk.toString()}`;
  const lines = text.split(/\r?\n/);
  state.pending = lines.pop() ?? '';
  for (const line of lines) {
    stream.write(`${prefix} ${line}\n`);
  }
};

const flushPrefixedLogChunk = (
  stream: NodeJS.WritableStream,
  prefix: string,
  state: PrefixLogState,
): void => {
  if (!state.pending) return;
  stream.write(`${prefix} ${state.pending}\n`);
  state.pending = '';
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
    meshLog.warn('child.stop_timeout_sigkill', {
      pid: proc.pid ?? null,
      timeoutMs: CHILD_GRACEFUL_SHUTDOWN_MS,
    });
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

type ControlOkResponse = {
  ok?: boolean;
  error?: string;
  code?: string;
  [key: string]: unknown;
};

const postJsonExpectOk = async <T extends ControlOkResponse>(url: string, timeoutMs: number): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', signal: controller.signal });
    const bodyText = await response.text().catch(() => '');
    let payload: ControlOkResponse | null = null;
    if (bodyText.trim()) {
      try {
        payload = JSON.parse(bodyText) as ControlOkResponse;
      } catch {
        payload = { error: bodyText.slice(0, 500) };
      }
    }
    if (!response.ok || payload?.ok !== true) {
      throw new Error(`CONTROL_POST_FAILED url=${url} status=${response.status} payload=${safeStringify(payload)}`);
    }
    return payload as T;
  } catch (error) {
    throw new Error(`CONTROL_POST_FAILED url=${url} error=${serializeError(error)}`);
  } finally {
    clearTimeout(timer);
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

const getExitedHubChild = (): HubChild | null =>
  hubChildren.find((child) => child.exitCode !== null || child.proc?.exitCode !== null) || null;

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
  const proc = child.proc;
  if (!proc || child.exitCode !== null || proc.exitCode !== null) return;
  const apiBase = `http://${args.host}:${child.apiPort}`;
  const [info, health] = await Promise.all([
    fetchJson<HubInfoPayload>(`${apiBase}/api/info`, CHILD_HEALTH_TIMEOUT_MS),
    fetchJson<HubHealthPayload>(`${apiBase}/api/health`, CHILD_HEALTH_TIMEOUT_MS),
  ]);
  if (child.proc !== proc || child.exitCode !== null || proc.exitCode !== null) return;
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

const marketMakerPoller = createMarketMakerChildPoller({
  child: marketMakerChild,
  host: args.host,
  infoTimeoutMs: MARKET_MAKER_INFO_TIMEOUT_MS,
  healthTimeoutMs: CHILD_HEALTH_TIMEOUT_MS,
  fullHealthTimeoutMs: MARKET_MAKER_FULL_HEALTH_TIMEOUT_MS,
  fetchJson,
});

const pollMarketMakerInfo = marketMakerPoller.pollInfo;
const pollMarketMakerHealth = marketMakerPoller.pollHealth;
const fetchMarketMakerFullHealthForResponse = marketMakerPoller.fetchFullHealthForResponse;

let lastHealthResponseRefreshMs: number | null = null;
const refreshChildHealthForResponse = async (): Promise<void> => {
  const startedAt = Date.now();
  await Promise.race([
    Promise.allSettled([
      pollAllHubHealth(),
      pollMarketMakerInfo(),
      pollMarketMakerHealth(),
    ]).then(() => undefined),
    delay(HEALTH_RESPONSE_REFRESH_TIMEOUT_MS).then(() => undefined),
  ]);
  lastHealthResponseRefreshMs = Date.now() - startedAt;
};

const getHubSpecsArg = (): string => HUB_NAMES.join(',');

type MarketMakerJurisdictionConfig = MeshJurisdictionConfig & {
  contracts: NonNullable<MeshJurisdictionConfig['contracts']>;
};

type MarketMakerSupportPeerIdentity = {
  name: string;
  entityId: string;
  signerId: string;
  jurisdictionName: string;
  chainId: number;
  depositoryAddress: string;
};

const resolveLocalMarketMakerRpcUrl = (value: string): string => {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/')) return raw;
  const match = raw.match(/^\/(?:api\/)?rpc([2-8])?(?:\?.*)?$/);
  if (match) {
    const index = match[1] ? Number(match[1]) : 1;
    const rpc = String(args.rpcUrls[index] || '').trim();
    if (rpc) return rpc;
  }
  return new URL(raw, `http://${args.host}:${marketMakerChild.apiPort}`).toString();
};

const toMarketMakerEntityJurisdictionConfig = (
  jurisdiction: MarketMakerJurisdictionConfig,
): MarketMakerEntityJurisdictionConfig => {
  if (!jurisdiction.contracts?.entityProvider || !jurisdiction.contracts?.depository) {
    throw new Error(`MARKET_MAKER_JURISDICTION_CONTRACTS_MISSING:${jurisdiction.name || 'unknown'}`);
  }
  return {
    name: jurisdiction.name,
    address: resolveLocalMarketMakerRpcUrl(jurisdiction.rpc),
    entityProviderAddress: jurisdiction.contracts.entityProvider,
    depositoryAddress: jurisdiction.contracts.depository,
    chainId: Number(jurisdiction.chainId || 0),
  };
};

const buildMarketMakerIdentity = (
  jurisdiction: MarketMakerJurisdictionConfig,
  signerLabel: string,
  name: string,
): MarketMakerSupportPeerIdentity => {
  const signerId = deriveSignerAddressSync(marketMakerChild.seed, signerLabel).toLowerCase();
  const entityId = deriveMarketMakerEntityId(signerId, toMarketMakerEntityJurisdictionConfig(jurisdiction));
  return {
    name,
    entityId,
    signerId,
    jurisdictionName: jurisdiction.name,
    chainId: Number(jurisdiction.chainId || 0),
    depositoryAddress: jurisdiction.contracts.depository,
  };
};

const getMarketMakerIdentities = (): MarketMakerSupportPeerIdentity[] => {
  const primary = resolveMeshJurisdictionConfig<MarketMakerJurisdictionConfig>(args.rpcUrl);
  const identities: MarketMakerSupportPeerIdentity[] = [
    buildMarketMakerIdentity(primary, marketMakerChild.signerLabel, marketMakerChild.name),
  ];
  for (const [index, secondary] of resolveSecondaryJurisdictions<MarketMakerJurisdictionConfig>(primary.rpc).entries()) {
    const secondaryName = String(secondary.name || `Secondary ${index + 1}`).trim();
    if (!secondaryName) continue;
    identities.push(buildMarketMakerIdentity(
      secondary,
      `${marketMakerChild.signerLabel}:${secondaryName}`,
      `${marketMakerChild.name} ${secondaryName}`,
    ));
  }
  return identities;
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
    ...buildSecondaryRpcArgs(),
    '--mesh-hub-names', getHubSpecsArg(),
    '--support-peer-identities-json', JSON.stringify(getMarketMakerIdentities()),
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
    env: sanitizeChildProcessEnv({
      ...process.env,
      XLN_DB_PATH: child.dbPath,
      XLN_JURISDICTIONS_PATH: shardJurisdictionsPath,
      ...buildRpcChildEnv(),
      USE_ANVIL: 'true',
      XLN_RADAPTER_AUTH_SEED: child.authSeed,
      XLN_ORCHESTRATOR_PID: String(process.pid),
      XLN_ORCHESTRATOR_OWNER_ID: orchestratorOwnerId,
      XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS: String(STARTUP_TIMEOUT_MS),
      XLN_RUNTIME_EXIT_ON_FATAL: process.env['XLN_RUNTIME_EXIT_ON_FATAL'] ?? '1',
      XLN_STORAGE_WRITE_TIMEOUT_MS: process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] ?? '60000',
      XLN_HUB_BOOTSTRAP_PAUSE_STORAGE: HUB_BOOTSTRAP_PAUSE_STORAGE,
      XLN_LOG_LEVEL: process.env['XLN_HUB_LOG_LEVEL'] ?? process.env['XLN_LOG_LEVEL'] ?? 'warn',
    }),
  });
  child.proc = proc;
  if (!proc.pid) {
    throw new Error(`${child.name}_SPAWN_FAILED_NO_PID`);
  }
  managedRuntimeLeases.writeLease(spec, proc.pid, child.startedAt ?? Date.now());
  const stdoutPrefixState: PrefixLogState = { pending: '' };
  const stderrPrefixState: PrefixLogState = { pending: '' };
  proc.stdout?.on('data', chunk => {
    pushChildLogLines(child.recentStdout, chunk);
    writePrefixedLogChunk(process.stdout, `[${child.name}]`, stdoutPrefixState, chunk);
  });
  proc.stderr?.on('data', chunk => {
    pushChildLogLines(child.recentStderr, chunk);
    writePrefixedLogChunk(process.stderr, `[${child.name}:err]`, stderrPrefixState, chunk);
  });
  proc.once('exit', code => {
    flushPrefixedLogChunk(process.stdout, `[${child.name}]`, stdoutPrefixState);
    flushPrefixedLogChunk(process.stderr, `[${child.name}:err]`, stderrPrefixState);
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
    ...buildSecondaryRpcArgs(),
    '--mesh-hub-names', getHubSpecsArg(),
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
    env: sanitizeChildProcessEnv({
      ...process.env,
      XLN_DB_PATH: marketMakerChild.dbPath,
      XLN_JURISDICTIONS_PATH: shardJurisdictionsPath,
      ...buildRpcChildEnv(),
      USE_ANVIL: 'true',
      XLN_RADAPTER_AUTH_SEED: marketMakerChild.authSeed,
      XLN_ORCHESTRATOR_PID: String(process.pid),
      XLN_ORCHESTRATOR_OWNER_ID: orchestratorOwnerId,
      XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS: String(STARTUP_TIMEOUT_MS),
      XLN_RUNTIME_EXIT_ON_FATAL: process.env['XLN_RUNTIME_EXIT_ON_FATAL'] ?? '1',
      XLN_STORAGE_WRITE_TIMEOUT_MS: process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] ?? '60000',
      XLN_STORAGE_SYNC_WRITES: process.env['XLN_STORAGE_SYNC_WRITES'] ?? '0',
      XLN_MARKET_MAKER_DISABLE_STORAGE: process.env['XLN_MARKET_MAKER_DISABLE_STORAGE'] ?? '1',
      XLN_DISABLE_RUNTIME_RESTORE: process.env['XLN_MARKET_MAKER_DISABLE_RESTORE'] ?? process.env['XLN_DISABLE_RUNTIME_RESTORE'] ?? '1',
      XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT: process.env['XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT'] ?? '1',
      XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL:
        process.env['XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL'] ??
        join(marketMakerChild.dbPath, 'bootstrap-events.jsonl'),
      XLN_LOG_LEVEL: process.env['XLN_MARKET_MAKER_LOG_LEVEL'] ?? process.env['XLN_LOG_LEVEL'] ?? 'warn',
    }),
  });
  marketMakerChild.proc = proc;
  if (!proc.pid) {
    throw new Error('MM_SPAWN_FAILED_NO_PID');
  }
  managedRuntimeLeases.writeLease(spec, proc.pid, marketMakerChild.startedAt ?? Date.now());
  const stdoutPrefixState: PrefixLogState = { pending: '' };
  const stderrPrefixState: PrefixLogState = { pending: '' };
  proc.stdout?.on('data', chunk => {
    pushChildLogLines(marketMakerChild.recentStdout, chunk);
    writePrefixedLogChunk(process.stdout, '[MM]', stdoutPrefixState, chunk);
  });
  proc.stderr?.on('data', chunk => {
    pushChildLogLines(marketMakerChild.recentStderr, chunk);
    writePrefixedLogChunk(process.stderr, '[MM:err]', stderrPrefixState, chunk);
  });
  proc.once('exit', (code, signal) => {
    flushPrefixedLogChunk(process.stdout, '[MM]', stdoutPrefixState);
    flushPrefixedLogChunk(process.stderr, '[MM:err]', stderrPrefixState);
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

const stopAllChildren = async (options: StopAllChildrenOptions = {}): Promise<void> => {
  for (const child of hubChildren) clearChildRestartTimer(child);
  clearChildRestartTimer(marketMakerChild);
  const ownedLiveChildren = hubChildren.filter((child) => child.proc && child.proc.exitCode === null);
  const ownedLiveMarketMaker = marketMakerChild.proc && marketMakerChild.proc.exitCode === null ? marketMakerChild : null;
  const quiesceRounds = options.quiesceRounds ?? 2;
  const quiesceTimeoutMs = options.quiesceTimeoutMs ?? CHILD_RESET_QUIESCE_TIMEOUT_MS;
  const quiescePauseMs = options.quiescePauseMs ?? 150;
  const quiesceUrls = [
    ...ownedLiveChildren.map((child) => `http://${args.host}:${child.apiPort}/api/control/runtime/quiesce`),
    ...(ownedLiveMarketMaker ? [`http://${args.host}:${ownedLiveMarketMaker.apiPort}/api/control/runtime/quiesce`] : []),
  ];
  // Initial reset often has no owned children yet. Do not probe random old listeners on the same ports.
  for (let round = 0; round < quiesceRounds && quiesceUrls.length > 0; round += 1) {
    await Promise.all(quiesceUrls.map((url) => postJson(url, quiesceTimeoutMs)));
    await delay(quiescePauseMs);
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

type LastBootstrapEvent = {
  event: string;
  stage: string | null;
  at: string | null;
  height: number | null;
  backlog: unknown;
  readyHash: string | null;
  runtimeStateHash: string | null;
  entityStateHash: string | null;
};

const readLastMarketMakerBootstrapEvent = (): LastBootstrapEvent | null => {
  const tail = readTailText(marketMakerBootstrapEventsPath(), BOOTSTRAP_EVENT_TAIL_BYTES);
  if (!tail) return null;
  const lines = tail.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]!) as unknown;
      if (!isRecord(parsed)) continue;
      const event = String(parsed['event'] || '').trim();
      if (!event) continue;
      return {
        event,
        stage: String(parsed['stage'] || '').trim() || null,
        at: String(parsed['at'] || '').trim() || null,
        height: toFiniteNumber(parsed['height']),
        backlog: parsed['backlog'],
        readyHash: String(parsed['hash'] || '').trim() || null,
        runtimeStateHash: String(parsed['runtimeStateHash'] || '').trim() || null,
        entityStateHash: String(parsed['entityStateHash'] || '').trim() || null,
      };
    } catch {
      // The bounded tail can start mid-line; keep scanning older complete lines.
    }
  }
  return null;
};

const summarizeBootstrapBacklog = (value: unknown): AggregatedHealth['bootstrapTimeline']['backlog'] => {
  if (!isRecord(value)) return null;
  const queuedInputs = Array.isArray(value['queuedEntityInputs']) ? value['queuedEntityInputs'] : [];
  const queuedEntityTxCount = queuedInputs.reduce((sum, entry) => {
    if (!isRecord(entry)) return sum;
    return sum + Math.max(0, Math.floor(Number(entry['txCount'] || 0)));
  }, 0);
  const runtimeTxs = Math.max(0, Math.floor(Number(value['runtimeTxs'] || 0)));
  const entityInputs = Math.max(0, Math.floor(Number(value['entityInputs'] || 0)));
  const jInputs = Math.max(0, Math.floor(Number(value['jInputs'] || 0)));
  const processing = value['processing'] === true;
  return {
    processing,
    runtimeTxs,
    entityInputs,
    jInputs,
    queuedEntityInputCount: queuedInputs.length,
    queuedEntityTxCount,
    total: runtimeTxs + entityInputs + jInputs + (processing ? 1 : 0),
  };
};

const emptyBootstrapBacklog = (): NonNullable<AggregatedHealth['bootstrapTimeline']['backlog']> => ({
  processing: false,
  runtimeTxs: 0,
  entityInputs: 0,
  jInputs: 0,
  queuedEntityInputCount: 0,
  queuedEntityTxCount: 0,
  total: 0,
});

const timingFor = (stage: keyof typeof timings): TimingMap[string] => timings[stage] ?? { startedAt: null, completedAt: null, ms: null };

const stageStatus = (
  ok: boolean | null,
  options: { active?: boolean; disabled?: boolean } = {},
): AggregatedHealth['bootstrapTimeline']['stages'][number]['status'] => {
  if (options.disabled) return 'disabled';
  if (ok === true) return 'done';
  if (options.active) return 'active';
  if (ok === false) return 'blocked';
  return 'pending';
};

const withBootstrapStageFailure = (
  stage: Omit<AggregatedHealth['bootstrapTimeline']['stages'][number], 'failure'>,
): AggregatedHealth['bootstrapTimeline']['stages'][number] => ({
  ...stage,
  failure: classifyRuntimeBootstrapStageFailure(stage.key, stage.status, stage.reason),
});

const buildBootstrapTimeline = (params: {
  storageOk: boolean;
  resetOk: boolean;
  hubsOnline: boolean;
  onlineHubs: number;
  totalHubs: number;
  hubMeshOk: boolean;
  directOpenLinks: number;
  mmEnabled: boolean;
  marketMakerActive: boolean;
  sameChainOk: boolean;
  crossOk: boolean;
  mmOk: boolean;
  mmStartupPhase: string | null;
  mmOfferTotal: number;
  mmExpectedTotal: number;
  crossRouteCount: number;
  expectedCrossRoutes: number;
  custodyEnabled: boolean;
  custodyOk: boolean;
  bootstrapReservesOk: boolean;
  bootstrapReserveTargetsMet: boolean;
  reserveEntityCount: number;
}): AggregatedHealth['bootstrapTimeline'] => {
  const lastEvent = readLastMarketMakerBootstrapEvent();
  const mmBootstrap = marketMakerChild.lastHealth?.bootstrap ?? marketMakerChild.lastInfo?.bootstrap ?? null;
  const readyHash = String(mmBootstrap?.readyHash || '').trim() || lastEvent?.readyHash || null;
  const runtimeStateHash = String(mmBootstrap?.runtimeStateHash || '').trim() || lastEvent?.runtimeStateHash || null;
  const entityStateHash = String(mmBootstrap?.entityStateHash || '').trim() || lastEvent?.entityStateHash || null;
  const eventReadyAt = lastEvent?.event === 'ready-hash' && lastEvent.at ? Date.parse(lastEvent.at) : null;
  const readyAt = toFiniteNumber(mmBootstrap?.readyAt) ?? (Number.isFinite(eventReadyAt) ? eventReadyAt : null);
  const infoBacklog = (marketMakerChild.lastInfo as { runtimeBacklog?: unknown } | null)?.runtimeBacklog;
  const backlog = summarizeBootstrapBacklog(lastEvent?.backlog ?? infoBacklog);
  const resetClear = timingFor('reset_clear_state');
  const resetTotal = timingFor('reset_total');
  const resetHubs = timingFor('reset_wait_hubs');
  const resetMarketMaker = timingFor('reset_market_maker');
  const resetCustody = timingFor('reset_custody');
  const fallbackLastEvent = resetTotal.completedAt
    ? {
      event: resetState.lastError ? 'reset-failed' : 'reset-complete',
      stage: 'orchestrator',
      at: new Date(resetTotal.completedAt).toISOString(),
      height: null,
    }
    : null;

  return {
    readyHash,
    runtimeStateHash,
    entityStateHash,
    readyAt,
    healthPoll: {
      actualMs: lastHealthResponseRefreshMs,
      budgetMs: HEALTH_RESPONSE_REFRESH_TIMEOUT_MS,
    },
    backlog: backlog ?? emptyBootstrapBacklog(),
    lastEvent: lastEvent
      ? {
        event: lastEvent.event,
        stage: lastEvent.stage,
        at: lastEvent.at,
        height: lastEvent.height,
      }
      : fallbackLastEvent,
    stages: [
      {
        key: 'preflight',
        label: 'Preflight',
        status: stageStatus(params.resetOk && params.storageOk, { active: resetState.inProgress }),
        reason: resetState.lastError || (params.storageOk ? 'Reset and storage preflight clear' : 'Storage gate blocked'),
        budgetMs: STARTUP_TIMEOUT_MS,
        actualMs: resetClear.ms,
        startedAt: resetClear.startedAt,
        completedAt: resetClear.completedAt,
        evidence: [
          { label: 'storage ok', value: params.storageOk },
          { label: 'reset ok', value: params.resetOk },
        ],
      },
      {
        key: 'hub-mesh',
        label: 'Hub Mesh',
        status: stageStatus(params.hubMeshOk, { active: params.hubsOnline && !params.hubMeshOk }),
        reason: params.hubMeshOk ? 'All hub mesh accounts and credits are ready' : 'Hub mesh is still converging',
        budgetMs: HUB_BASELINE_TIMEOUT_MS,
        actualMs: resetHubs.ms,
        startedAt: resetHubs.startedAt,
        completedAt: resetHubs.completedAt,
        evidence: [
          { label: 'online hubs', value: params.onlineHubs },
          { label: 'total hubs', value: params.totalHubs },
          { label: 'direct links', value: params.directOpenLinks },
        ],
      },
      {
        key: 'same-chain',
        label: 'Same-Chain Books',
        status: stageStatus(params.sameChainOk, { active: params.marketMakerActive && !params.sameChainOk, disabled: !params.mmEnabled }),
        reason: params.mmEnabled ? 'Market maker same-chain orderbooks have full configured depth' : 'Market maker disabled',
        budgetMs: MARKET_MAKER_READY_TIMEOUT_MS,
        actualMs: null,
        startedAt: resetMarketMaker.startedAt,
        completedAt: null,
        evidence: [
          { label: 'offers', value: params.mmOfferTotal },
          { label: 'expected', value: params.mmExpectedTotal },
        ],
      },
      {
        key: 'cross-chain',
        label: 'Cross-Chain Routes',
        status: stageStatus(params.crossOk, { active: params.marketMakerActive && !params.crossOk, disabled: !params.mmEnabled }),
        reason: params.mmEnabled ? 'Cross-jurisdiction routes have full configured depth' : 'Market maker disabled',
        budgetMs: MARKET_MAKER_READY_TIMEOUT_MS,
        actualMs: null,
        startedAt: resetMarketMaker.startedAt,
        completedAt: null,
        evidence: [
          { label: 'routes', value: params.crossRouteCount },
          { label: 'expected', value: params.expectedCrossRoutes },
        ],
      },
      {
        key: 'market-maker',
        label: 'Market Maker',
        status: stageStatus(params.mmOk, { active: params.marketMakerActive && !params.mmOk, disabled: !params.mmEnabled }),
        reason: params.mmEnabled ? `Market maker phase ${params.mmStartupPhase || 'unknown'}` : 'Market maker disabled',
        budgetMs: MARKET_MAKER_READY_TIMEOUT_MS,
        actualMs: resetMarketMaker.ms,
        startedAt: resetMarketMaker.startedAt,
        completedAt: resetMarketMaker.completedAt,
        evidence: [
          { label: 'phase', value: params.mmStartupPhase || 'unknown' },
          { label: 'ready hash', value: readyHash ? 'present' : 'missing' },
        ],
      },
      {
        key: 'custody',
        label: 'Custody',
        status: stageStatus(params.custodyOk, { active: params.custodyEnabled && !params.custodyOk, disabled: !params.custodyEnabled }),
        reason: params.custodyEnabled ? 'Custody daemon and service health' : 'Custody disabled for this boot',
        budgetMs: null,
        actualMs: resetCustody.ms,
        startedAt: resetCustody.startedAt,
        completedAt: resetCustody.completedAt,
        evidence: [
          { label: 'enabled', value: params.custodyEnabled },
        ],
      },
      {
        key: 'health-poll',
        label: 'Health Poll',
        status: stageStatus(lastHealthResponseRefreshMs !== null, { active: lastHealthResponseRefreshMs === null }),
        reason: 'Latest /api/health child refresh window',
        budgetMs: HEALTH_RESPONSE_REFRESH_TIMEOUT_MS,
        actualMs: lastHealthResponseRefreshMs,
        startedAt: null,
        completedAt: null,
        evidence: [
          { label: 'budget', value: HEALTH_RESPONSE_REFRESH_TIMEOUT_MS, unit: 'ms' },
          { label: 'actual', value: lastHealthResponseRefreshMs, unit: 'ms' },
        ],
      },
      {
        key: 'ready-hash',
        label: 'Ready Hash',
        status: stageStatus(Boolean(readyHash), { active: params.mmEnabled && params.mmOk && !readyHash, disabled: !params.mmEnabled }),
        reason: readyHash ? 'Market maker persisted bootstrap-ready fingerprint' : 'Ready hash is not available yet',
        budgetMs: null,
        actualMs: null,
        startedAt: null,
        completedAt: readyAt,
        evidence: [
          { label: 'ready at', value: readyAt },
          { label: 'reserve entities', value: params.reserveEntityCount },
          { label: 'reserve targets', value: params.bootstrapReservesOk && params.bootstrapReserveTargetsMet },
        ],
      },
    ].map(withBootstrapStageFailure),
  };
};

const computeAggregatedHealth = (options: {
  marketMakerHealthOverride?: MarketMakerHealthPayload | null | undefined;
} = {}): AggregatedHealth => {
  const storage = getStorageHealthSnapshotSync();
  const marketMakerHealth = normalizeMarketMakerHealthPayload(options.marketMakerHealthOverride ?? marketMakerChild.lastHealth);
  const managedRuntimeIds = new Set<string>();
  for (const child of hubChildren) {
    const runtimeId = normalizeRuntimeKey(String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || ''));
    if (runtimeId) managedRuntimeIds.add(runtimeId);
  }
  const marketMakerRuntimeId = normalizeRuntimeKey(String(marketMakerChild.lastInfo?.runtimeId || marketMakerHealth?.runtimeId || ''));
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

  const pairSet = new Map<string, { left: string; right: string; ok: boolean; expectedCreditAmount: string }>();
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
        expectedCreditAmount: HUB_MESH_CREDIT_AMOUNT.toString(),
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
  const marketMakerBootstrapEvent = readLastMarketMakerBootstrapEvent();
  const eventStartupPhase = String(marketMakerBootstrapEvent?.stage || '').trim() || null;
  const mmStartupPhase = eventStartupPhase || marketMakerChild.lastStartupPhase;
  const mmEntityId = marketMakerActive
    ? String(marketMakerChild.lastInfo?.entityId || marketMakerHealth?.entityId || '').trim() || null
    : null;
  const aggregatedMarketMakerHealth = buildAggregatedMarketMakerHealth({
    mmEnabled: args.mmEnabled,
    marketMakerActive,
    marketMakerHealth,
    hubEntityIds: hubIds,
    expectedHubCount: HUB_NAMES.length,
    entityId: mmEntityId,
    startupPhase: mmStartupPhase,
  });
  const mmExpectedOffersPerHub = aggregatedMarketMakerHealth.expectedOffersPerHub;
  const mmHubs = aggregatedMarketMakerHealth.hubs;
  const mmCross = aggregatedMarketMakerHealth.cross;
  const mmOk = aggregatedMarketMakerHealth.ok;
  const hubsOnline = hubs.length === HUB_NAMES.length && hubs.every((hub) => hub.online);
  const hubMeshOk =
    hubsOnline &&
    hubIds.length === HUB_NAMES.length &&
    hubChildren.every((child) => child.lastHealth?.mesh?.ready === true);
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
  const resetOk = deriveResetHealthOk(resetState);
  const systemOk = coreOk && resetOk && mmOk && custodyOk && bootstrapReservesOk;
  if (!resetState.inProgress && resetState.lastError && coreOk && !resetState.resolvedAt) {
    resetState.resolvedAt = Date.now();
  }
  const degraded = [
    storage.ok ? null : 'storage',
    hubsOnline ? null : 'hubs',
    hubMeshOk ? null : 'hubMesh',
    resetOk ? null : 'reset',
    mmOk ? null : 'marketMaker',
    custodyOk ? null : 'custody',
    bootstrapReservesOk ? null : 'bootstrapReserves',
    bootstrapReserveTargetsMet ? null : 'bootstrapReserveTargets',
  ].filter((value): value is string => Boolean(value));
  const failures = buildRuntimeHealthFailures(degraded).map(failure =>
    failure.code === 'MARKET_MAKER_NOT_READY' && aggregatedMarketMakerHealth.failure
      ? aggregatedMarketMakerHealth.failure
      : failure
  );
  const sourceHeights = [
    ...hubChildren.map(child => Number(child.lastHealth?.height || 0)),
    Number(marketMakerHealth?.height || 0),
  ].filter(height => Number.isFinite(height) && height > 0);
  const mmOfferTotal = mmHubs.reduce((sum, hub) => sum + Number(hub.offers || 0), 0);
  const mmExpectedTotal = mmExpectedOffersPerHub * Math.max(1, mmHubs.length || HUB_NAMES.length);
  const sameChainOk = !args.mmEnabled ||
    (mmHubs.length === HUB_NAMES.length && mmHubs.every((hub) => hub.depthReady === true));
  const crossOk = !args.mmEnabled || !mmCross.applicable || mmCross.ok === true;
  const bootstrapTimeline = buildBootstrapTimeline({
    storageOk: storage.ok,
    resetOk,
    hubsOnline,
    onlineHubs: hubs.filter((hub) => hub.online).length,
    totalHubs: hubs.length,
    hubMeshOk,
    directOpenLinks: directLinkMap.size,
    mmEnabled: args.mmEnabled,
    marketMakerActive,
    sameChainOk,
    crossOk,
    mmOk,
    mmStartupPhase,
    mmOfferTotal,
    mmExpectedTotal,
    crossRouteCount: Number(mmCross.routeCount || 0),
    expectedCrossRoutes: mmCross.expectedRoutes,
    custodyEnabled: args.custodyEnabled,
    custodyOk,
    bootstrapReservesOk,
    bootstrapReserveTargetsMet,
    reserveEntityCount: reserveEntities.length,
  });

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
    marketMaker: aggregatedMarketMakerHealth,
    bootstrapTimeline,
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
  if (child.proc?.exitCode !== null || !child.lastHealth) return new Map();
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
  return new Map(snapshots.map((snapshot) => [snapshot.pairId, countSnapshotOrders(snapshot)]));
};

const recomputeHealthWithMarketMaker = (
  health: AggregatedHealth,
  marketMaker: AggregatedHealth['marketMaker'],
): AggregatedHealth => {
  const resetOk = deriveResetHealthOk(health.reset);
  const systemOk = health.coreOk &&
    resetOk &&
    marketMaker.ok === true &&
    health.custody.ok === true &&
    health.bootstrapReserves.ok === true;
  const degraded = [
    health.storage.ok ? null : 'storage',
    health.hubs.every((hub) => hub.online) ? null : 'hubs',
    health.hubMesh.ok ? null : 'hubMesh',
    resetOk ? null : 'reset',
    marketMaker.ok ? null : 'marketMaker',
    health.custody.ok ? null : 'custody',
    health.bootstrapReserves.ok ? null : 'bootstrapReserves',
    health.bootstrapReserves.targetMet ? null : 'bootstrapReserveTargets',
  ].filter((value): value is string => Boolean(value));
  const failures = buildRuntimeHealthFailures(degraded);
  return {
    ...health,
    systemOk,
    degraded,
    failures,
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
      const expectedOffers = Math.max(1, Number(pair.expectedOffers || health.marketMaker.cross.expectedOffersPerPair || 1));
      return {
        ...pair,
        offers,
        ready: offers > 0,
        depthReady: offers >= expectedOffers,
        expectedOffers,
      };
    });
    const offers = pairs.reduce((sum, pair) => sum + pair.offers, 0);
    const expectedOffers = pairs.reduce((sum, pair) => sum + Number(pair.expectedOffers || 0), 0);
    return {
      ...route,
      offers,
      ready: route.ready === true || (pairs.length > 0 && pairs.every(pair => pair.ready)),
      depthReady: expectedOffers > 0 &&
        offers >= expectedOffers &&
        pairs.every(pair => pair.depthReady),
      pairs,
    };
  }));
  const enrichedCross = {
    ...cross,
    routes,
    ok: (cross.expectedRoutes > 0 ? routes.length >= cross.expectedRoutes : routes.length > 0) &&
      routes.every(route => route.depthReady),
  };
  const sameChainReady = !health.marketMaker.enabled ||
    (health.marketMaker.hubs.length === HUB_NAMES.length && health.marketMaker.hubs.every(hub => hub.depthReady));
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
    ? await enrichMarketMakerCrossFromHubSnapshots(baseHealth)
    : baseHealth;
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
  let restartAttempts = 0;
  while (Date.now() < deadline) {
    await pollMarketMakerHealth();
    const health = computeAggregatedHealth();
    const exitedHub = getExitedHubChild();
    if (exitedHub) {
      throw new Error(
        `HUB_EXITED_DURING_MM_READY name=${exitedHub.name} code=${String(exitedHub.exitCode ?? exitedHub.proc?.exitCode)} ` +
        `stderr=${safeStringify(exitedHub.recentStderr.slice(-8))}`,
      );
    }
    if (marketMakerChild.exitCode !== null || marketMakerChild.exitSignal !== null) {
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
        await delay(MARKET_MAKER_RESTART_FENCING_GRACE_MS);
        await spawnMarketMaker();
        await delay(500);
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
    await delay(250);
  }
  throw new Error(
    `MM_READY_TIMEOUT phase=${String(marketMakerChild.lastStartupPhase)} marketMaker=${safeStringify(computeAggregatedHealth().marketMaker)}`,
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
  const deadline = Date.now() + HUB_SELF_READY_TIMEOUT_MS;
  let lastStatus: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const hasRpc2 = hasShardRpc2Jurisdiction(jurisdictionsConfig);
    const primary = resolvePrimaryHubJurisdictionFallback(jurisdictionsConfig);
    let contracts: RpcContractAddresses | null = null;
    if (primary) {
      try {
        const payload = JSON.parse(readShardJurisdictions(jurisdictionsConfig)) as {
          jurisdictions?: Record<string, { contracts?: RpcContractAddresses }>;
        };
        contracts = payload.jurisdictions?.[primary.key]?.contracts ?? null;
      } catch {
        contracts = null;
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
    lastStatus = { hasRpc2, primary: primary?.key ?? null, missingCode, probeError };
    if (hasRpc2 && missingCode.length === 0 && !probeError) {
      return;
    }
    if (child.proc?.exitCode !== null) {
      throw new Error(
        `${child.name}_EXITED_BEFORE_JURISDICTIONS code=${String(child.proc?.exitCode)} status=${safeStringify(lastStatus)}`,
      );
    }
    await delay(250);
  }
  throw new Error(
    `${child.name}_JURISDICTIONS_TIMEOUT path=${shardJurisdictionsPath} status=${safeStringify(lastStatus)}`,
  );
};

const persistHubReadySnapshots = async (): Promise<void> => {
  if (!envFlagEnabled(HUB_BOOTSTRAP_PAUSE_STORAGE)) return;
  const startedAt = startTiming('reset_persist_ready_snapshots');
  try {
    const results = await Promise.all(hubChildren.map(async (child) => {
      const payload = await postJsonExpectOk(
        `http://${args.host}:${child.apiPort}/api/control/runtime/persist-ready-snapshot`,
        HUB_READY_SNAPSHOT_TIMEOUT_MS,
      );
      return {
        name: child.name,
        height: payload['height'] ?? null,
        wasPaused: payload['wasPaused'] ?? null,
        persistencePaused: payload['persistencePaused'] ?? null,
      };
    }));
    meshLog.info('hub_ready_snapshots.persisted', { results });
  } finally {
    finishTiming('reset_persist_ready_snapshots', startedAt);
  }
};

const runReset = async (options: { enableMarketMaker: boolean } = { enableMarketMaker: args.mmEnabled }): Promise<void> => {
  resetState.inProgress = true;
  resetState.lastError = null;
  resetState.startedAt = Date.now();
  resetState.completedAt = null;
  resetState.failedAt = null;
  resetState.resolvedAt = null;
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
      await deployRpc2JurisdictionStack(jurisdictionsConfig);
      syncCanonicalJurisdictionsFromShard(jurisdictionsConfig);
    }
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

    if (marketMakerReady) await marketMakerReady;
    if (marketMakerBootstrapError) throw marketMakerBootstrapError;

    let custodyBootstrapError: unknown = null;
    if (args.custodyEnabled) {
      const custodyStartedAt = startTiming('reset_custody');
      try {
        const primaryJurisdiction = resolvePrimaryHubJurisdictionFallback(jurisdictionsConfig);
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
          profileName: 'Custody',
          jurisdictionId: primaryJurisdiction.key,
        });
      } catch (error) {
        custodyBootstrapError = error;
        meshLog.error('custody.bootstrap_failed', { error: serializeError(error) });
      } finally {
        finishTiming('reset_custody', custodyStartedAt);
      }
    }

    if (custodyBootstrapError) throw custodyBootstrapError;

    await persistHubReadySnapshots();

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
  await publishRuntimeImportManifest();
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

const httpDrain = createHttpDrainTracker();
const FRONTEND_STATIC_DIR = './frontend/build';
const server = Bun.serve({
  hostname: args.host,
  port: args.port,
  idleTimeout: 120,
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
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    const directClientIp = resolveAssistantDirectClientIp(serverRef, request);
    const assistantClientId = resolveAssistantRateClientId(request, directClientIp);
    const assistantResponse = await assistantProxy.handle(request, pathname, assistantClientId);
    if (assistantResponse) return assistantResponse;

    if (request.headers.get('upgrade') === 'websocket' && pathname === '/relay') {
      const upgraded = serverRef.upgrade(request, { data: { type: 'relay', clientIp: resolveRequestClientIp(request) } });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    const rpcProxyIndex = resolveRpcProxyIndex(pathname);
    if (rpcProxyIndex !== null && request.method === 'POST') {
      return await proxyRpc(request, args.rpcUrls[rpcProxyIndex] || '', operatorAuthorized);
    }

    const hubRuntimeInputStatusMatch = pathname.match(/^\/api\/hub\/runtime-input\/([^/]+)\/status$/);
    if (hubRuntimeInputStatusMatch && request.method === 'GET') {
      const hubEntityId = String(url.searchParams.get('hubEntityId') || '').toLowerCase();
      if (!hubEntityId) {
        return new Response(safeStringify({
          ok: false,
          error: 'hubEntityId is required',
          code: 'HUB_RUNTIME_INPUT_STATUS_HUB_REQUIRED',
        }), { status: 400, headers });
      }
      let child = getHubChildByEntityId(hubEntityId);
      if (!child) {
        await pollAllHubHealth();
        child = getHubChildByEntityId(hubEntityId);
      }
      if (!child) {
        return new Response(safeStringify({
          ok: false,
          error: `Hub not found for hubEntityId=${hubEntityId}`,
          code: 'HUB_RUNTIME_INPUT_STATUS_HUB_NOT_FOUND',
        }), { status: 404, headers });
      }
      const receiptId = encodeURIComponent(decodeURIComponent(hubRuntimeInputStatusMatch[1] || ''));
      try {
        const response = await fetch(`http://${args.host}:${child.apiPort}/api/control/runtime-input/${receiptId}/status`);
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
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'HUB_RUNTIME_INPUT_STATUS_PROXY_FAILED',
        }), { status: 502, headers });
      }
    }

    if (pathname === '/api/faucet/offchain' && request.method === 'POST') {
      return await proxyHubApi(request, '/api/faucet/offchain');
    }

    if (pathname === '/api/hub/account-status' && request.method === 'GET') {
      const hubEntityId = String(url.searchParams.get('hubEntityId') || '').toLowerCase();
      const counterpartyEntityId = String(url.searchParams.get('counterpartyEntityId') || '').toLowerCase();
      let child = getHubChildByEntityId(hubEntityId);
      if (!child) {
        await pollAllHubHealth();
        child = getHubChildByEntityId(hubEntityId);
      }
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

    if (pathname === '/api/health/full' || (pathname === '/api/health' && url.searchParams.get('full') === '1')) {
      void getStorageHealth().catch(() => {});
      await refreshChildHealthForResponse();
      const marketMakerHealthOverride = args.mmEnabled ? await fetchMarketMakerFullHealthForResponse() : null;
      const health = await buildAggregatedHealthResponse({
        marketMakerHealthOverride,
        includeMarketSnapshots: url.searchParams.get('marketSnapshots') === '1',
      });
      return new Response(safeStringify(operatorAuthorized ? health : publicAggregatedHealth(health)), { headers });
    }

    if (pathname === '/api/health') {
      void getStorageHealth().catch(() => {});
      await refreshChildHealthForResponse();
      const health = await buildAggregatedHealthResponse();
      return new Response(safeStringify(operatorAuthorized ? health : publicAggregatedHealth(health)), { headers });
    }

    if (pathname === '/api/runtime-import' && request.method === 'GET') {
      void getStorageHealth().catch(() => {});
      await refreshChildHealthForResponse();
      const health = await buildAggregatedHealthResponse();
      const readiness = resolveRuntimeImportReadiness(health);
      if (!readiness.ok) {
        const allowPartial = url.searchParams.get('allowPartial') === '1' && operatorAuthorized;
        if (allowPartial) {
          const access = resolveRuntimeImportAccessForRequest(
            url.searchParams.get('access'),
            runtimeImportAccess,
            operatorAuthorized,
          );
          if (!access.ok) {
            return new Response(safeStringify({ error: access.error }), { status: access.status, headers });
          }
          const partialManifest = buildRuntimeImportManifest(access.access);
          if (partialManifest) {
            return new Response(safeStringify({
              ok: true,
              ready: false,
              partial: true,
              error: readiness.error,
              reason: readiness.reason,
              category: readiness.category,
              code: readiness.code,
              retryable: readiness.retryable,
              fatal: readiness.fatal,
              failure: readiness.failure,
              degraded: readiness.degraded,
              importUrl: buildRuntimeImportUrl(partialManifest),
              manifest: partialManifest,
            }), { headers: { ...headers, 'Retry-After': '2' } });
          }
        }
        return new Response(safeStringify({
          ok: false,
          ready: false,
          error: readiness.error,
          reason: readiness.reason,
          category: readiness.category,
          code: readiness.code,
          retryable: readiness.retryable,
          fatal: readiness.fatal,
          failure: readiness.failure,
          degraded: readiness.degraded,
          manifest: {
            issuedAt: 0,
            expiresAt: 0,
            entries: [],
          },
        }), { headers: { ...headers, 'Retry-After': '2' } });
      }
      const access = resolveRuntimeImportAccessForRequest(
        url.searchParams.get('access'),
        runtimeImportAccess,
        operatorAuthorized,
      );
      if (!access.ok) {
        return new Response(safeStringify({ error: access.error }), { status: access.status, headers });
      }
      const manifest = buildRuntimeImportManifest(access.access);
      if (!manifest) {
        return new Response(safeStringify({
          ok: false,
          ready: false,
          error: 'RUNTIME_IMPORT_NOT_READY',
          manifest: {
            issuedAt: 0,
            expiresAt: 0,
            entries: [],
          },
        }), { headers: { ...headers, 'Retry-After': '2' } });
      }
      return new Response(safeStringify({ ok: true, ready: true, importUrl: buildRuntimeImportUrl(manifest), manifest }), { headers });
    }

    if (pathname === '/api/metrics') {
      void getStorageHealth().catch(() => {});
      await refreshChildHealthForResponse();
      const health = await buildAggregatedHealthResponse();
      return new Response(buildPrometheusMetrics(health), {
        headers: {
          ...headers,
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        },
      });
    }

    const qaResponse = await maybeHandleQaRequest(request, pathname, headers, { operatorAuthorized });
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
      hubApiHost: args.host,
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

    if (request.method === 'GET' || request.method === 'HEAD') {
      if (pathname === '/runtime.js') {
        const runtimeBundle = await serveRuntimeBundle();
        if (runtimeBundle) return runtimeBundle;
      }

      if (pathname === '/') {
        const index = await serveStatic('/index.html', FRONTEND_STATIC_DIR);
        if (index) return index;
      }

      const file = await serveStatic(pathname, FRONTEND_STATIC_DIR);
      if (file) return file;

      const fallback = await serveStatic('/index.html', FRONTEND_STATIC_DIR);
      if (fallback) return fallback;
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
    open(ws) {
      relayHelloChallenges.issue(ws as OrchestratorWebSocket);
      pushDebugEvent(relayStore, {
        event: 'ws_open',
        details: { wsType: 'relay' },
      });
    },
    message(ws, raw) {
      try {
        let msg: RuntimeWsMessage | Record<string, unknown>;
        try {
          msg = deserializeWsMessage(raw as string | Buffer | ArrayBuffer);
        } catch (binaryError) {
          const candidate = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (!isMarketMessageType(candidate['type'])) throw binaryError;
          msg = candidate;
        }
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
        Promise.resolve(relayRoute(routerConfig, ws as OrchestratorWebSocket, msg as RuntimeWsMessage)).catch(error => {
          const reason = serializeError(error);
          pushDebugEvent(relayStore, {
            event: 'error',
            reason: 'RELAY_HANDLER_EXCEPTION',
            details: { error: reason, msgType: msg?.type, from: msg?.from, to: msg?.to },
          });
          try {
            ws.send(serializeWsMessage({ type: 'error', error: reason }));
          } catch {}
        });
      } catch (error) {
        pushDebugEvent(relayStore, {
          event: 'error',
          reason: 'INVALID_RELAY_MESSAGE',
          details: { error: serializeError(error) },
        });
        try {
          ws.send(serializeWsMessage({ type: 'error', error: 'Invalid relay message' }));
        } catch {}
      }
    },
    close(ws) {
      const relayWs = ws as OrchestratorWebSocket;
      relayHelloChallenges.forget(relayWs);
      cleanupRpcMarketSubscription(relayWs);
      forgetRelaySocketRuntimeId(relayWs);
      removeClient(relayStore, relayWs);
    },
  },
});

const shutdown = async (): Promise<void> => {
  await stopServerGracefully(server, httpDrain, 'orchestrator', 5_000);
  await stopAllChildren({
    quiesceRounds: 1,
    quiesceTimeoutMs: CHILD_SHUTDOWN_QUIESCE_TIMEOUT_MS,
  });
  process.exit(0);
};

process.on('SIGTERM', () => {
  if (resetState.inProgress) {
    meshLog.warn('reset.sigterm_during_reset');
  }
  void shutdown();
});
process.on('SIGINT', () => { void shutdown(); });

console.log(
  `CONTROL_READY host=${args.host} port=${args.port} relay=${relayUrl} rpc=${args.rpcUrl} mm=${args.mmEnabled ? 'on' : 'off'} custody=${args.custodyEnabled ? 'on' : 'off'} reset=${args.resetAllowed ? 'on' : 'off'} deferInitialReset=${args.deferInitialReset ? 'on' : 'off'}`,
);

assertMinDiskFree();

if (!args.deferInitialReset) {
  void ensureReset().catch(async (error) => {
    meshLog.error('reset.initial_failed', { error: serializeError(error) });
    await stopAllChildren({
      quiesceRounds: 1,
      quiesceTimeoutMs: CHILD_SHUTDOWN_QUIESCE_TIMEOUT_MS,
    });
    process.exit(1);
  });
}
