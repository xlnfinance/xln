#!/usr/bin/env bun

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Level } from 'level';
import { readStorageHead } from '../../../storage';
import type { StorageHead } from '../../../storage/types';
import { RemoteRuntimeAdapter } from '../../../api/runtime-adapter/remote';
import {
  E2E_FATAL_LOG_TAIL_LINES,
  findFirstRuntimeFatalLogHit,
  tailLog,
} from '../../e2e/harness/e2e-fatal-log-monitor';
import { stopProcessGroup } from '../../e2e/runners/process-group';
import { getHubMeshBudgetElapsedMs } from '../bootstrap/bootstrap-stage-budget';
import {
  evaluateMmHealthProbeFailure,
  trackCausalProgress,
  type CausalProgressState,
} from '../bootstrap/bootstrap-progress';
import {
  acquireLocalTestPortLease,
  assertLocalTestPortsFree,
  buildInheritedLocalTestLeaseEnv,
  stripLocalTestLeaseEnv,
} from '../../e2e/harness/local-test-port-lease';
import {
  parseAdversaryProfile,
  runAdversaryProfile,
  type MeshHealthPayload,
} from '../../../scenarios/cross-j/mm-mesh-adversary';
import { parseSameLoadSchedule } from '../hlt/workload/load-schedule';

type ManagedProcess = {
  name: string;
  proc: ChildProcess;
  command: string;
  args: string[];
  env: Record<string, string>;
};

type EpochRotationEvidence = {
  runtime: 'H1' | 'H2' | 'H3' | 'MM';
  currentHeight: number;
  previousHeight: number;
  latestSnapshotHeight: number;
  epochMaxBytes: number;
};

type HealthPayload = {
  coreOk?: boolean;
  systemOk?: boolean;
  system?: { relay?: boolean };
  hubs?: Array<{ online?: boolean; quiescence?: RuntimeQuiescenceHealth | null }>;
  hubMesh?: { ok?: boolean; direct?: { openLinkCount?: number } };
  marketMaker?: {
    ok?: boolean;
    entityId?: string | null;
    quiescence?: RuntimeQuiescenceHealth | null;
    startupPhase?: string | null;
    expectedOffersPerHub?: number;
    hubs?: Array<{
      offers?: number;
      ready?: boolean;
      depthReady?: boolean;
      blockers?: unknown[];
      pairs?: Array<{ offers?: number; ready?: boolean; depthReady?: boolean; expectedOffers?: number }>;
    }>;
    cross?: {
      ok?: boolean;
      expectedRoutes?: number;
      routes?: Array<{
        offers?: number;
        ready?: boolean;
        depthReady?: boolean;
        blockers?: unknown[];
        pairs?: Array<{ offers?: number; ready?: boolean; depthReady?: boolean; expectedOffers?: number }>;
      }>;
    };
  };
  custody?: { ok?: boolean };
  bootstrapReserves?: { ok?: boolean; targetMet?: boolean };
  reset?: {
    inProgress?: boolean;
    lastError?: string | null;
    startedAt?: number | null;
    completedAt?: number | null;
  };
  timings?: {
    reset_spawn_h1?: { startedAt?: number | null };
  };
  degraded?: string[];
  bootstrap?: BootstrapHashInfo;
};

type RuntimeQuiescenceHealth = {
  pendingRuntimeWork?: number;
  pendingAccountFrames?: number;
  accountMempoolTxs?: number;
};

type BootstrapHashInfo = {
  readyHash?: string | null;
  runtimeStateHash?: string | null;
  entityStateHash?: string | null;
  restoredEntityStateHash?: string | null;
  readyAt?: number | null;
};

type MarketMakerInfoPayload = {
  bootstrap?: BootstrapHashInfo;
  runtimeBacklog?: {
    runtimeTxs?: number;
    entityInputs?: number;
    jInputs?: number;
    processing?: boolean;
  };
};

type MarketMakerDirectHealthPayload = {
  ok?: boolean;
  startupPhase?: string | null;
  bootstrap?: BootstrapHashInfo;
  marketMaker?: NonNullable<HealthPayload['marketMaker']>;
};

type BootstrapStage = {
  stage: string;
  elapsedMs: number;
  at: string;
  details?: unknown;
};

type BootstrapMetrics = {
  schema: 'xln-local-prod-bootstrap-benchmark-v1';
  elapsedMs: number;
  stages: BootstrapStage[];
  bootstrapHash: string;
  runtimeStateHash: string;
  entityStateHash: string;
  restoredEntityStateHash: string | null;
  workDir: string;
  eventsJsonl: string;
  marketMakerEventsJsonl: string;
  epochRotations?: EpochRotationEvidence[];
  templateDir?: string;
};

const repoRoot = process.cwd();
const PROFILING_ENV_KEYS = [
  'XLN_RUNTIME_PROCESS_PROFILE', 'XLN_RUNTIME_APPLY_PROFILE',
  'XLN_RUNTIME_PROCESS_SLOW_MS', 'XLN_RUNTIME_APPLY_SLOW_MS',
  'XLN_ENTITY_FRAME_PROFILE', 'XLN_ENTITY_FRAME_SLOW_MS',
  'XLN_ENTITY_STATE_ROOT_PROFILE', 'XLN_ACCOUNT_STATE_ROOT_PROFILE',
  'XLN_STORAGE_VERBOSE', 'XLN_RUNTIME_OP_COUNTERS',
  'XLN_LOG_LEVEL', 'XLN_LOG_SCOPES',
  'XLN_HUB_LOG_LEVEL', 'XLN_LOAD_LANE_LOG_LEVEL', 'XLN_ENTITY_PROPOSAL_TRACE', 'XLN_HEAVY_LOGS',
  'XLN_ACCOUNT_ACK_STRICT_TIMEOUT_MS',
  'XLN_ACCOUNT_PENDING_RESEND_AFTER_MS',
] as const;
if (process.env['XLN_LOCAL_PROD_SMOKE_PORT_BASE'] !== undefined) {
  throw new Error('LOCAL_PROD_SMOKE_PORT_OVERRIDE_FORBIDDEN');
}
const localTestLease = await acquireLocalTestPortLease({
  requiredOffsets: [0, 1, 4, 7, 8, 10, 11, 12, 13],
});
const inheritedProcessEnv = stripLocalTestLeaseEnv(process.env);
const hltUsers = Number(process.env['XLN_HLT_USERS'] || '0');
if (Number.isSafeInteger(hltUsers) && hltUsers > 0) {
  inheritedProcessEnv['XLN_GOSSIP_PROFILE_LOOKUP_PER_CLIENT_LIMIT'] =
    process.env['XLN_GOSSIP_PROFILE_LOOKUP_PER_CLIENT_LIMIT'] || String(Math.max(64, hltUsers));
  inheritedProcessEnv['XLN_GOSSIP_PROFILE_LOOKUP_GLOBAL_LIMIT'] =
    process.env['XLN_GOSSIP_PROFILE_LOOKUP_GLOBAL_LIMIT'] || String(Math.max(1_000, hltUsers * 4));
}
const portBase = localTestLease.basePort;

const rpcPort = portBase;
const rpc2Port = portBase + 1;
const apiPort = portBase + 4;
const custodyPort = portBase + 7;
const custodyDaemonPort = portBase + 8;
const nodePortBase = portBase + 10;
const marketMakerApiPort = nodePortBase + 3;
const workDir = process.env['XLN_LOCAL_PROD_SMOKE_DIR'] || join(tmpdir(), `xln-local-prod-smoke-${portBase}`);
const templateDir = String(process.env['XLN_LOCAL_PROD_SMOKE_TEMPLATE_DIR'] || '').trim();
const useSnapshotTemplate = templateDir.length > 0;
const children: ManagedProcess[] = [];
const marketMakerInfoLatencyMaxMs = Math.max(
  250,
  Number(process.env['XLN_LOCAL_PROD_SMOKE_MM_INFO_MAX_MS'] || '5000'),
);
const postBootstrapStabilityMs = Math.max(
  0,
  Number(process.env['XLN_LOCAL_PROD_SMOKE_POST_BOOTSTRAP_STABILITY_MS'] || '2000'),
);
const requireEpochRotation = process.env['XLN_LOCAL_PROD_SMOKE_REQUIRE_EPOCH_ROTATION'] === '1';
const expectedEpochMaxBytes = Number(process.env['XLN_STORAGE_EPOCH_MAX_BYTES'] || '0');
if (
  requireEpochRotation &&
  (!Number.isSafeInteger(expectedEpochMaxBytes) || expectedEpochMaxBytes < 1)
) {
  throw new Error(`LOCAL_PROD_SMOKE_EPOCH_MAX_BYTES_INVALID:${String(expectedEpochMaxBytes)}`);
}
const smokeStartedAt = Date.now();
const stages: BootstrapStage[] = [];
const recordedStages = new Set<string>();
let fatalStageBudgetError: string | null = null;
const fatalLogScannedLinesByPath = new Map<string, number>();
const eventsJsonlPath = process.env['XLN_LOCAL_PROD_SMOKE_EVENTS_JSONL'] || join(workDir, 'bootstrap-events.jsonl');
const marketMakerEventsJsonlPath =
  process.env['XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL'] || join(workDir, 'mm-bootstrap-events.jsonl');
const enforceStageBudgets = process.env['XLN_LOCAL_PROD_SMOKE_ENFORCE_STAGE_BUDGETS'] === '1';
const healthPollMaxMs = Math.max(
  250,
  Number(process.env['XLN_LOCAL_PROD_SMOKE_HEALTH_POLL_MAX_MS'] || '2000'),
);
const marketMakerHealthPollMaxMs = Math.max(
  250,
  Number(process.env['XLN_LOCAL_PROD_SMOKE_MM_HEALTH_POLL_MAX_MS'] || '5000'),
);
const bootstrapNoProgressFatalMs = Math.max(
  1_000,
  Number(process.env['XLN_LOCAL_PROD_SMOKE_NO_PROGRESS_FATAL_MS'] || '60000'),
);
const healthPollIntervalMs = Math.max(
  100,
  Number(process.env['XLN_LOCAL_PROD_SMOKE_HEALTH_POLL_INTERVAL_MS'] || '250'),
);
const stageBudgetsMs = {
  hubMesh: Math.max(1, Number(process.env['XLN_LOCAL_PROD_SMOKE_HUB_MESH_BUDGET_MS'] || '20000')),
  sameChain: Math.max(1, Number(process.env['XLN_LOCAL_PROD_SMOKE_SAME_CHAIN_BUDGET_MS'] || '30000')),
  cross: Math.max(1, Number(process.env['XLN_LOCAL_PROD_SMOKE_CROSS_BUDGET_MS'] || '300000')),
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type RestartProcessIds = Readonly<{ before: number; after: number }>;

/**
 * Population flags for HLT. When `XLN_HLT_USERS` is set the run is described as
 * an economy and every derived quantity comes from it; the raw lane spelling is
 * left for the legacy schedule ladder and the cross-j single-swap workloads.
 */
const hltEconomyArgs = (): string[] => {
  const users = process.env['XLN_HLT_USERS'];
  if (!users) return [];
  const optional = ([
    ['--rate-per-user', 'XLN_HLT_RATE_PER_USER'],
    ['--duration-s', 'XLN_HLT_DURATION_S'],
    ['--mix', 'XLN_HLT_MIX'],
    ['--base-token', 'XLN_HLT_BASE_TOKEN'],
    ['--quote-token', 'XLN_HLT_QUOTE_TOKEN'],
    ['--hubs', 'XLN_HLT_HUBS'],
    ['--market-makers', 'XLN_HLT_MARKET_MAKERS'],
    ['--payment-amount-min', 'XLN_HLT_PAYMENT_AMOUNT_MIN'],
    ['--payment-amount-max', 'XLN_HLT_PAYMENT_AMOUNT_MAX'],
  ] as const).flatMap(([flag, variable]) => {
    const value = process.env[variable];
    return value ? [flag, value] : [];
  });
  return ['--users', users, ...optional];
};

const runProductionSwapWorker = (
  mode: string,
  swaps: string,
  lanes: string,
  rounds: string,
  cadenceMs: string,
  laneOffset = '0',
  restartProcessIds?: RestartProcessIds,
): void => {
  const worker = join(
    repoRoot,
    'core/scripts/operations/hlt/hlt.ts',
  );
  const economy = mode === 'same' || mode === 'payments' || mode === 'mixed' ? hltEconomyArgs() : [];
  const result = spawnSync(process.execPath, [
    worker,
    '--work-dir', workDir,
    '--port-base', String(portBase),
    '--mode', mode,
    ...(economy.length > 0 ? economy : [
      '--swaps', swaps,
      '--lanes', lanes,
      '--rounds', rounds,
      '--cadence-ms', cadenceMs,
    ]),
    '--lane-offset', laneOffset,
    ...(restartProcessIds ? [
      '--server-pid-before-restart', String(restartProcessIds.before),
      '--server-pid-after-restart', String(restartProcessIds.after),
    ] : []),
  ], { cwd: repoRoot, env: inheritedProcessEnv, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`LOCAL_PROD_SMOKE_SWAP_LOAD_FAILED:${mode}:${String(result.status)}`);
  }
};

const runProductionSwapLoadSmoke = async (): Promise<void> => {
  if (process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_SMOKE'] !== '1') return;
  const swaps = process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_SWAPS'] || '1';
  const lanes = process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_LANES'] || '1';
  const rounds = process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_ROUNDS'] || '1';
  const cadenceMs = process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_CADENCE_MS'] || '1000';
  const mode = process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE'] || 'same';
  if (mode !== 'same' && mode !== 'cross' && mode !== 'payments' && mode !== 'mixed') {
    throw new Error(`LOCAL_PROD_SMOKE_SWAP_LOAD_MODE_INVALID:${mode}`);
  }
  const scheduleRaw = process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_SCHEDULE'];
  if (scheduleRaw !== undefined) {
    if (mode !== 'same') throw new Error('LOCAL_PROD_SMOKE_SWAP_LOAD_SCHEDULE_REQUIRES_SAME');
    if (process.env['XLN_HLT_USERS']) throw new Error('LOCAL_PROD_SMOKE_SWAP_LOAD_SCHEDULE_CONFLICTS_WITH_ECONOMY');
    for (const stage of parseSameLoadSchedule(scheduleRaw)) {
      recordStage('production-swap-load:start', stage);
      runProductionSwapWorker(mode, String(stage.swaps), String(stage.lanes), rounds, cadenceMs, String(stage.laneOffset));
      const source = join(workDir, 'production-swap-load-report.json');
      const target = join(workDir, `production-swap-load-report-${stage.swaps}-${stage.lanes}.json`);
      renameSync(source, target);
      recordStage('production-swap-load:complete', { ...stage, report: target });
    }
    return;
  }
  recordStage('production-swap-load:start', { mode, burstSize: swaps, lanes });
  runProductionSwapWorker(mode, swaps, lanes, rounds, cadenceMs);
  recordStage('production-swap-load:complete', { mode, burstSize: swaps, lanes });
  if (process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_RECOVERY'] !== '1') return;
  if (mode !== 'cross' || swaps !== '1') {
    throw new Error('LOCAL_PROD_SMOKE_SWAP_LOAD_RECOVERY_REQUIRES_CROSS_N1');
  }
  recordStage('production-swap-load:restart-start');
  const restartProcessIds = await restartManaged('server');
  await waitForHealth();
  recordStage('production-swap-load:restart-ready');
  runProductionSwapWorker('cross-recovery', '1', '1', '1', '1000', '0', restartProcessIds);
  recordStage('production-swap-load:recovery-complete');
};

const recordStage = (stage: string, details?: unknown): void => {
  const entry: BootstrapStage = {
    stage,
    elapsedMs: Date.now() - smokeStartedAt,
    at: new Date().toISOString(),
    ...(details === undefined ? {} : { details }),
  };
  stages.push(entry);
  emitDebugEvent('stage', { stage, details });
  console.log(`[local-prod-smoke] stage ${JSON.stringify(entry)}`);
};

const recordStageOnce = (stage: string, details?: unknown): void => {
  if (recordedStages.has(stage)) return;
  recordedStages.add(stage);
  recordStage(stage, details);
};

const isHash64 = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:0x)?[a-f0-9]{64}$/i.test(value);

const normalizeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
};

function emitDebugEvent(event: string, fields: Record<string, unknown> = {}): void {
  const record = {
    schema: 'xln-bootstrap-debug-event-v1',
    at: new Date().toISOString(),
    elapsedMs: Date.now() - smokeStartedAt,
    event,
    ...fields,
  };
  try {
    mkdirSync(workDir, { recursive: true });
    appendFileSync(eventsJsonlPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    console.error(
      `[local-prod-smoke] DEBUG_EVENT_WRITE_FAILED path=${eventsJsonlPath} ` +
      `error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const isPortOpen = async (port: number): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(750);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
};

const assertPortsFree = async (ports: number[]): Promise<void> => {
  const busy: number[] = [];
  for (const port of ports) {
    if (await isPortOpen(port)) busy.push(port);
  }
  if (busy.length > 0) {
    throw new Error(`LOCAL_PROD_SMOKE_PORTS_BUSY: ${busy.join(',')}`);
  }
};

const logPath = (name: string): string => join(workDir, `${name}.log`);

const assertNoFatalChildLogs = (stage: string): void => {
  for (const child of children) {
    const path = logPath(child.name);
    let fromLine = fatalLogScannedLinesByPath.get(path) ?? 0;
    let hit = findFirstRuntimeFatalLogHit(path, fromLine);
    while (hit) {
      const tail = tailLog(path, E2E_FATAL_LOG_TAIL_LINES);
      emitDebugEvent('fatal-log-hit', {
        stage,
        process: child.name,
        file: path,
        lineNumber: hit.lineNumber,
        pattern: hit.pattern,
        line: hit.line,
        tail,
      });
      throw new Error(
        `LOCAL_PROD_SMOKE_FATAL_LOG marker=${hit.pattern} process=${child.name} ` +
        `file=${path} line=${hit.lineNumber} events=${eventsJsonlPath}\n` +
        `${hit.lineNumber}: ${hit.line}\n` +
        `--- last ${E2E_FATAL_LOG_TAIL_LINES} lines (${path}) ---\n${tail}`,
      );
    }
    fatalLogScannedLinesByPath.set(path, readFileSync(path, 'utf8').split('\n').length);
  }
};

const startManaged = (
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
): ManagedProcess => {
  mkdirSync(workDir, { recursive: true });
  const out = openSync(logPath(name), 'a');
  const proc = spawn(command, args, {
    cwd: repoRoot,
    detached: true,
    env: {
      ...inheritedProcessEnv,
      ...env,
    },
    stdio: ['ignore', out, out],
  });
  closeSync(out);
  const managed = { name, proc, command, args: [...args], env: { ...env } };
  children.push(managed);
  return managed;
};

const restartManaged = async (name: string): Promise<RestartProcessIds> => {
  const current = children.findLast(child => child.name === name && child.proc.exitCode === null);
  if (!current?.proc.pid) throw new Error(`LOCAL_PROD_SMOKE_PROCESS_NOT_RUNNING:${name}`);
  const before = current.proc.pid;
  await stopProcessGroup({
    pid: before,
    termTimeoutMs: 5_000,
    killTimeoutMs: 5_000,
    timeoutError: `LOCAL_PROD_SMOKE_RESTART_TIMEOUT:name=${name}:pid=${current.proc.pid}`,
  });
  const restarted = startManaged(current.name, current.command, current.args, current.env);
  const after = restarted.proc.pid;
  if (!after || after === before) throw new Error(`LOCAL_PROD_SMOKE_PROCESS_NOT_REPLACED:${name}:${before}`);
  return { before, after };
};

const readClosedStorageHead = async (path: string): Promise<StorageHead> => {
  const db = new Level<Buffer, Buffer>(path, {
    valueEncoding: 'buffer',
    keyEncoding: 'binary',
  });
  await db.open();
  try {
    const head = await readStorageHead(db);
    if (!head) throw new Error(`LOCAL_PROD_SMOKE_STORAGE_HEAD_MISSING:${path}`);
    return head;
  } finally {
    await db.close();
  }
};

const inspectEpochRotations = async (): Promise<EpochRotationEvidence[]> => {
  const runtimes = [
    ['H1', 'h1'],
    ['H2', 'h2'],
    ['H3', 'h3'],
    ['MM', 'mm'],
  ] as const;
  const evidence: EpochRotationEvidence[] = [];
  for (const [runtime, directory] of runtimes) {
    const runtimeDir = join(workDir, 'prod-mesh', directory);
    const currentEntry = readdirSync(runtimeDir).find(entry => entry.endsWith('-storage-current'));
    if (!currentEntry) {
      throw new Error(`LOCAL_PROD_SMOKE_STORAGE_CURRENT_MISSING:${runtime}:${runtimeDir}`);
    }
    const currentPath = join(runtimeDir, currentEntry);
    const previousPath = `${currentPath.slice(0, -'-storage-current'.length)}-storage-previous`;
    if (!existsSync(previousPath)) {
      throw new Error(`LOCAL_PROD_SMOKE_STORAGE_ROTATION_MISSING:${runtime}:${previousPath}`);
    }
    const [current, previous] = await Promise.all([
      readClosedStorageHead(currentPath),
      readClosedStorageHead(previousPath),
    ]);
    if (current.epochMaxBytes !== expectedEpochMaxBytes || previous.epochMaxBytes !== expectedEpochMaxBytes) {
      throw new Error(
        `LOCAL_PROD_SMOKE_STORAGE_EPOCH_CONFIG_DRIFT:${runtime}:` +
        `expected=${expectedEpochMaxBytes}:current=${current.epochMaxBytes}:previous=${previous.epochMaxBytes}`,
      );
    }
    if (current.latestHeight <= previous.latestHeight) {
      throw new Error(
        `LOCAL_PROD_SMOKE_STORAGE_POST_ROTATION_FRAME_MISSING:${runtime}:` +
        `current=${current.latestHeight}:previous=${previous.latestHeight}`,
      );
    }
    evidence.push({
      runtime,
      currentHeight: current.latestHeight,
      previousHeight: previous.latestHeight,
      latestSnapshotHeight: current.latestSnapshotHeight,
      epochMaxBytes: current.epochMaxBytes,
    });
  }
  return evidence;
};

const commitPostRotationProofFrames = async (): Promise<void> => {
  // Rotation deliberately saturates the storage worker while its new epoch is
  // published. A normal control request uses 5s, but the proof frame must be
  // allowed to wait for that bounded durability barrier; timing out first
  // would report a red gate after the system and rotation were already green.
  const proofRequestTimeoutMs = 30_000;
  const proofObservationTimeoutMs = 60_000;
  const manifestPath = join(workDir, 'prod-mesh', 'runtime-import-manifest.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    manifest?: {
      entries?: Array<{ access?: string; label?: string; token?: string; wsUrl?: string }>;
    };
  };
  const entries = parsed.manifest?.entries ?? [];
  await Promise.all((['H1', 'H2', 'H3', 'MM'] as const).map(async (label) => {
    const entry = entries.find(candidate =>
      candidate.label === label &&
      candidate.access === 'admin' &&
      typeof candidate.token === 'string' &&
      typeof candidate.wsUrl === 'string'
    );
    if (!entry?.token || !entry.wsUrl) {
      throw new Error(`LOCAL_PROD_SMOKE_EPOCH_ADMIN_RUNTIME_MISSING:${label}`);
    }
    const adapter = new RemoteRuntimeAdapter();
    try {
      await adapter.connect({
        mode: 'remote',
        wsUrl: entry.wsUrl,
        authKey: entry.token,
        requestTimeoutMs: proofRequestTimeoutMs,
      });
      const commandSequence = adapter.nextCommandSequence;
      if (!commandSequence) {
        throw new Error(`LOCAL_PROD_SMOKE_EPOCH_COMMAND_FRONTIER_MISSING:${label}`);
      }
      // The first marker may itself be the byte-threshold rotation frame. The
      // second must therefore commit through the newly published live handle.
      for (let proofIndex = 0; proofIndex < 2; proofIndex++) {
        const sequence = commandSequence + proofIndex;
        const commandId = `epoch-rotation-proof-${label.toLowerCase()}-${proofIndex + 1}`;
        const deadline = Date.now() + proofObservationTimeoutMs;
        let result = await adapter.send(
          { runtimeTxs: [], entityInputs: [] },
          { commandId, commandSequence: sequence },
        );
        while (result.status !== 'observed' && Date.now() < deadline) {
          // The production admin lane intentionally replenishes five sends per
          // second. Poll below that rate instead of weakening the real limiter.
          await sleep(250);
          result = await adapter.send(
            { runtimeTxs: [], entityInputs: [] },
            { commandId, commandSequence: sequence },
          );
        }
        if (result.status !== 'observed') {
          throw new Error(
            `LOCAL_PROD_SMOKE_EPOCH_PROOF_FRAME_NOT_OBSERVED:` +
            `${label}:proof=${proofIndex + 1}:height=${result.height}`,
          );
        }
      }
    } finally {
      adapter.disconnect();
    }
  }));
  recordStage('storage-epoch:post-rotation-wal-committed');
};

const copySnapshotTemplate = (sourceDir: string, targetDir: string): void => {
  const requiredEntries = [
    'anvil-state.json',
    'anvil2-state.json',
    'secrets',
    'prod-main',
    'prod-mesh',
  ] as const;
  for (const entry of requiredEntries) {
    const source = join(sourceDir, entry);
    if (!existsSync(source)) {
      throw new Error(`LOCAL_PROD_SMOKE_TEMPLATE_ENTRY_MISSING:${source}`);
    }
    cpSync(source, join(targetDir, entry), { recursive: true, force: true });
  }
};

const performStopManaged = async (): Promise<void> => {
  // Mark intentional cleanup so induced child exits never overwrite the original root cause.
  emitDebugEvent('cleanup', { stage: 'stop-managed', intentional: true });
  await Promise.all([...children].reverse().map(({ name, proc }) => (
    proc.pid
      ? stopProcessGroup({
        pid: proc.pid,
        termTimeoutMs: 2_000,
        killTimeoutMs: 2_000,
        timeoutError: `LOCAL_PROD_SMOKE_GROUP_EXIT_TIMEOUT:name=${name}:pid=${proc.pid}`,
      })
      : Promise.resolve()
  )));
};

let stopManagedPromise: Promise<void> | null = null;
const stopManaged = (): Promise<void> => {
  stopManagedPromise ??= performStopManaged();
  return stopManagedPromise;
};

let shutdownSignal: NodeJS.Signals | null = null;
const handleShutdownSignal = (signal: NodeJS.Signals): void => {
  if (shutdownSignal) return;
  shutdownSignal = signal;
  void stopManaged()
    .then(() => process.exit(signal === 'SIGINT' ? 130 : 143))
    .catch(error => {
      console.error(`[local-prod-smoke] signal cleanup failed signal=${signal}`, error);
      process.exit(1);
    });
};
const handleSigint = (): void => handleShutdownSignal('SIGINT');
const handleSigterm = (): void => handleShutdownSignal('SIGTERM');
process.on('SIGINT', handleSigint);
process.on('SIGTERM', handleSigterm);

const rpcChainId = async (port: number): Promise<string> => {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  });
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`);
  const payload = await response.json() as { result?: unknown };
  return String(payload.result || '');
};

const waitForRpc = async (port: number, expectedChainId: string, label: string): Promise<void> => {
  const deadline = Date.now() + 45_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = await rpcChainId(port);
      if (last === expectedChainId) {
        console.log(`[local-prod-smoke] ${label} chainId=${expectedChainId}`);
        recordStageOnce(`rpc:${label.toLowerCase()}-ready`, { port, chainId: expectedChainId });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('LOCAL_PROD_SMOKE_STAGE_BUDGET_EXCEEDED')) {
        throw error;
      }
      last = message;
    }
    assertNoFatalChildLogs(`rpc:${label.toLowerCase()}`);
    await sleep(healthPollIntervalMs);
  }
  throw new Error(`${label} RPC not ready on :${port}; last=${last}`);
};

const fetchJsonWithCurl = <T>(url: string, maxMs: number, label: string): T => {
  const startedAt = Date.now();
  const maxTimeSeconds = (Math.max(250, maxMs) / 1000).toFixed(3);
  const result = spawnSync('curl', ['-sS', '--max-time', maxTimeSeconds, url], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: Math.max(1000, maxMs + 500),
  });
  const elapsedMs = Date.now() - startedAt;
  if (result.error) {
    throw new Error(`${label}_UNRESPONSIVE elapsedMs=${elapsedMs} maxMs=${maxMs} error=${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    throw new Error(`${label}_UNRESPONSIVE elapsedMs=${elapsedMs} maxMs=${maxMs} status=${String(result.status)} stderr=${stderr}`);
  }
  try {
    return JSON.parse(String(result.stdout || '')) as T;
  } catch (error) {
    throw new Error(
      `${label}_JSON_INVALID elapsedMs=${elapsedMs} maxMs=${maxMs} error=${
        error instanceof Error ? error.message : String(error)
      } body=${String(result.stdout || '').slice(0, 500)}`,
    );
  }
};

const fetchHealth = async (): Promise<HealthPayload> => {
  const startedAt = Date.now();
  try {
    const payload = fetchJsonWithCurl<HealthPayload>(
      `http://127.0.0.1:${apiPort}/api/health`,
      healthPollMaxMs,
      'HEALTH_POLL',
    );
    const elapsedMs = Date.now() - startedAt;
    emitDebugEvent('health-poll', { stage: 'health-poll', elapsedMs, ok: true });
    return payload;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    throw new Error(
      `LOCAL_PROD_SMOKE_HEALTH_POLL_FAILED elapsedMs=${elapsedMs} maxMs=${healthPollMaxMs} error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const directMarketMakerHealthPhases = new Set([
  'bootstrap-same-chain',
  'bootstrap-cross',
  'offers-ready',
  'bootstrap-degraded',
]);

const shouldFetchMarketMakerHealth = (health: HealthPayload): boolean =>
  directMarketMakerHealthPhases.has(String(health.marketMaker?.startupPhase || ''));

type MarketMakerHealthProbe = {
  payload: MarketMakerDirectHealthPayload | null;
  transientError: string | null;
};

const fetchMarketMakerHealthProbe = (health: HealthPayload): MarketMakerHealthProbe => {
  if (!shouldFetchMarketMakerHealth(health)) {
    emitDebugEvent('mm-health-poll', {
      stage: 'mm-health-poll',
      ok: false,
      skipped: true,
      startupPhase: health.marketMaker?.startupPhase ?? null,
    });
    return { payload: null, transientError: null };
  }
  const startedAt = Date.now();
  try {
    const payload = fetchJsonWithCurl<MarketMakerDirectHealthPayload>(
      `http://127.0.0.1:${marketMakerApiPort}/api/health`,
      marketMakerHealthPollMaxMs,
      'MM_HEALTH',
    );
    emitDebugEvent('mm-health-poll', {
      stage: 'mm-health-poll',
      durationMs: Date.now() - startedAt,
      ok: true,
    });
    return { payload, transientError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitDebugEvent('mm-health-poll', {
      stage: 'mm-health-poll',
      durationMs: Date.now() - startedAt,
      ok: false,
      transient: true,
      error: message,
    });
    return { payload: null, transientError: message };
  }
};

const fetchMarketMakerHealth = (health: HealthPayload): MarketMakerDirectHealthPayload | null => {
  const probe = fetchMarketMakerHealthProbe(health);
  const message = probe.transientError;
  if (message !== null) {
    throw new Error(`LOCAL_PROD_SMOKE_MM_HEALTH_FAILED error=${message}`);
  }
  return probe.payload;
};

const assertMarketMakerInfoResponsive = async (): Promise<MarketMakerInfoPayload> => {
  const startedAt = Date.now();
  try {
    const payload = fetchJsonWithCurl<MarketMakerInfoPayload>(
      `http://127.0.0.1:${marketMakerApiPort}/api/info`,
      marketMakerInfoLatencyMaxMs,
      'MM_INFO',
    );
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > marketMakerInfoLatencyMaxMs) {
      throw new Error(`MM_INFO_SLOW elapsedMs=${elapsedMs} maxMs=${marketMakerInfoLatencyMaxMs}`);
    }
    return payload;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MM_INFO_UNRESPONSIVE elapsedMs=${elapsedMs} maxMs=${marketMakerInfoLatencyMaxMs} error=${message}`);
  }
};

const assertNoMarketMakerBootstrapBacklog = (payload: MarketMakerInfoPayload): void => {
  const runtimeTxs = Number(payload.runtimeBacklog?.runtimeTxs ?? 0);
  const entityInputs = Number(payload.runtimeBacklog?.entityInputs ?? 0);
  if (runtimeTxs !== 0 || entityInputs !== 0) {
    throw new Error(
      `LOCAL_PROD_SMOKE_POST_BOOTSTRAP_BACKLOG runtimeTxs=${runtimeTxs} entityInputs=${entityInputs}`,
    );
  }
};

const marketMakerSameChainReady = (health: HealthPayload): boolean => {
  const hubs = health.marketMaker?.hubs ?? [];
  const expectedOffersPerHub = Number(health.marketMaker?.expectedOffersPerHub || 0);
  return health.marketMaker?.startupPhase === 'offers-ready' &&
    expectedOffersPerHub > 0 &&
    hubs.length >= 3 &&
    hubs.every(hub =>
      hub.ready === true &&
      hub.depthReady === true &&
      Number(hub.offers || 0) >= expectedOffersPerHub &&
      (hub.blockers ?? []).length === 0 &&
      (hub.pairs ?? []).every(pair =>
        pair.ready === true &&
        pair.depthReady === true &&
        Number(pair.offers || 0) >= Number(pair.expectedOffers || 1)
      )
    );
};

const marketMakerFullDepthReady = (health: HealthPayload): boolean => {
  const routes = health.marketMaker?.cross?.routes ?? [];
  const expectedRoutes = Number(health.marketMaker?.cross?.expectedRoutes || 0);
  return health.marketMaker?.ok === true &&
    marketMakerSameChainReady(health) &&
    expectedRoutes > 0 &&
    health.marketMaker?.cross?.ok === true &&
    routes.length >= expectedRoutes &&
    routes.every(route =>
      route.ready === true &&
      route.depthReady === true &&
      Number(route.offers || 0) > 0 &&
      (route.blockers ?? []).length === 0 &&
      (route.pairs ?? []).every(pair =>
        pair.ready === true &&
        pair.depthReady === true &&
        Number(pair.offers || 0) >= Number(pair.expectedOffers || 1)
      )
    );
};

const marketMakerDepthReadyForSmoke = (health: HealthPayload): boolean =>
  marketMakerFullDepthReady(health);

const healthReady = (health: HealthPayload): boolean => {
  return health.coreOk === true &&
    health.systemOk === true &&
    Number(health.hubs?.length || 0) >= 3 &&
    health.system?.relay === true &&
    health.hubMesh?.ok === true &&
    marketMakerDepthReadyForSmoke(health) &&
    Boolean(health.marketMaker?.entityId) &&
    health.custody?.ok === true &&
    health.bootstrapReserves?.ok === true;
};

const summarizeBlockers = (blockers: unknown[] | undefined): unknown[] =>
  (blockers ?? []).slice(0, 3);

const summarizeHealth = (health: HealthPayload): Record<string, unknown> => ({
  coreOk: health.coreOk ?? null,
  systemOk: health.systemOk ?? null,
  hubs: health.hubs?.length ?? 0,
  quiescence: {
    hubs: health.hubs?.map(hub => hub.quiescence ?? null) ?? [],
    marketMaker: health.marketMaker?.quiescence ?? null,
  },
  relay: health.system?.relay ?? null,
  hubMesh: health.hubMesh?.ok ?? null,
  directOpen: health.hubMesh?.direct?.openLinkCount ?? null,
  marketMaker: {
    ok: health.marketMaker?.ok ?? null,
    entity: Boolean(health.marketMaker?.entityId),
    expectedOffersPerHub: health.marketMaker?.expectedOffersPerHub ?? null,
    offers: health.marketMaker?.hubs?.map(hub => hub.offers ?? 0) ?? [],
    depthReady: health.marketMaker?.hubs?.map(hub => hub.depthReady === true) ?? [],
    blockers: health.marketMaker?.hubs?.map(hub => hub.blockers?.length ?? 0) ?? [],
    blockerDetails: health.marketMaker?.hubs?.map(hub => summarizeBlockers(hub.blockers)) ?? [],
    cross: {
      ok: health.marketMaker?.cross?.ok ?? null,
      expectedRoutes: health.marketMaker?.cross?.expectedRoutes ?? null,
      depthReady: health.marketMaker?.cross?.routes?.map(route => route.depthReady === true) ?? [],
      blockers: health.marketMaker?.cross?.routes?.map(route => route.blockers?.length ?? 0) ?? [],
      blockerDetails: health.marketMaker?.cross?.routes?.map(route => summarizeBlockers(route.blockers)) ?? [],
    },
    startupPhase: health.marketMaker?.startupPhase ?? null,
  },
  custody: health.custody?.ok ?? null,
  bootstrapReserves: health.bootstrapReserves?.ok ?? null,
  degraded: health.degraded ?? [],
  reset: {
    inProgress: health.reset?.inProgress ?? null,
    completed: Boolean(health.reset?.completedAt),
    lastError: health.reset?.lastError ?? null,
  },
});

const healthWithDirectMarketMaker = (
  health: HealthPayload,
  directHealth: MarketMakerDirectHealthPayload | null,
): HealthPayload => {
  if (!directHealth?.marketMaker) return health;
  return {
    ...health,
    ...(directHealth.bootstrap ?? health.bootstrap
      ? { bootstrap: directHealth.bootstrap ?? health.bootstrap }
      : {}),
    marketMaker: {
      ...directHealth.marketMaker,
      startupPhase:
        directHealth.startupPhase ??
        directHealth.marketMaker.startupPhase ??
        health.marketMaker?.startupPhase ??
        null,
    },
  };
};

const stageElapsed = (stage: string): number | null =>
  stages.find(entry => entry.stage === stage)?.elapsedMs ?? null;

const requireStageBudget = (
  stage: string,
  elapsedMs: number,
  maxMs: number,
  snapshot: unknown,
): void => {
  if (!enforceStageBudgets || elapsedMs <= maxMs) return;
  emitDebugEvent('stage-budget-exceeded', {
    stage,
    elapsedMs,
    maxMs,
    snapshot,
  });
  fatalStageBudgetError =
    `LOCAL_PROD_SMOKE_STAGE_BUDGET_EXCEEDED stage=${stage} elapsedMs=${elapsedMs} maxMs=${maxMs} ` +
    `events=${eventsJsonlPath} snapshot=${JSON.stringify(snapshot)}`;
  throw new Error(fatalStageBudgetError);
};

const enforceBootstrapStageBudgets = (health: HealthPayload, snapshot: Record<string, unknown>): void => {
  if (!enforceStageBudgets) return;
  const nowElapsedMs = Date.now() - smokeStartedAt;
  const hubMeshReadyAt = stageElapsed('hubMesh:ready');
  const hubMeshBudgetElapsedMs = getHubMeshBudgetElapsedMs({
    nowMs: smokeStartedAt + nowElapsedMs,
    resetStartedAt: health.reset?.startedAt,
    spawnH1StartedAt: health.timings?.reset_spawn_h1?.startedAt,
    readyAt: hubMeshReadyAt === null ? null : smokeStartedAt + hubMeshReadyAt,
  });
  if (hubMeshBudgetElapsedMs !== null) {
    requireStageBudget('hubMesh', hubMeshBudgetElapsedMs, stageBudgetsMs.hubMesh, snapshot);
  }

  const sameStartedAt = stageElapsed('marketMaker:bootstrap-same-chain');
  const crossStartedAt = stageElapsed('marketMaker:bootstrap-cross');
  const crossReadyAt = stageElapsed('marketMaker:cross-ready');
  const phase = String(health.marketMaker?.startupPhase || '');
  if (sameStartedAt !== null && crossStartedAt === null && phase === 'bootstrap-same-chain') {
    requireStageBudget('marketMaker:same-chain', nowElapsedMs - sameStartedAt, stageBudgetsMs.sameChain, snapshot);
  }
  if (sameStartedAt !== null && crossStartedAt !== null) {
    requireStageBudget('marketMaker:same-chain', crossStartedAt - sameStartedAt, stageBudgetsMs.sameChain, snapshot);
  }
  if (crossStartedAt !== null && crossReadyAt === null) {
    requireStageBudget('marketMaker:cross', nowElapsedMs - crossStartedAt, stageBudgetsMs.cross, snapshot);
  }
  if (crossStartedAt !== null && crossReadyAt !== null) {
    requireStageBudget('marketMaker:cross', crossReadyAt - crossStartedAt, stageBudgetsMs.cross, snapshot);
  }
};

const waitForHealth = async (): Promise<HealthPayload> => {
  const deadline = Date.now() + 420_000;
  let last: unknown = null;
  let iteration = 0;
  let lastMarketMakerPhase: string | null = null;
  let causalProgress: CausalProgressState | null = null;
  while (Date.now() < deadline) {
    try {
      assertNoFatalChildLogs('health-poll');
      const health = await fetchHealth();
      const marketMakerProbe = fetchMarketMakerHealthProbe(health);
      const directMarketMakerHealth = marketMakerProbe.payload;
      const stageHealth = healthWithDirectMarketMaker(health, directMarketMakerHealth);
      last = summarizeHealth(stageHealth);
      emitDebugEvent('health-snapshot', { stage: 'health-poll', snapshot: last });
      const nowMs = Date.now();
      causalProgress = trackCausalProgress(causalProgress, JSON.stringify(last), nowMs);
      if (marketMakerProbe.transientError !== null) {
        // Stale MM view: never counts as ready and never advances stages.
        // Continue only while the rest of bootstrap still shows causal progress.
        const decision = evaluateMmHealthProbeFailure({
          nowMs,
          lastProgressAtMs: causalProgress.lastProgressAtMs,
          noProgressFatalMs: bootstrapNoProgressFatalMs,
        });
        emitDebugEvent('mm-health-transient', {
          stage: 'health-poll',
          action: decision.action,
          msSinceProgress: decision.msSinceProgress,
          noProgressFatalMs: bootstrapNoProgressFatalMs,
          error: marketMakerProbe.transientError,
        });
        console.warn(
          `[local-prod-smoke] WARN mm-health transient failure action=${decision.action} ` +
          `msSinceProgress=${decision.msSinceProgress} error=${marketMakerProbe.transientError}`,
        );
        if (decision.action === 'fatal') {
          throw new Error(
            `LOCAL_PROD_SMOKE_MM_HEALTH_FAILED msSinceProgress=${decision.msSinceProgress} ` +
            `noProgressFatalMs=${bootstrapNoProgressFatalMs} error=${marketMakerProbe.transientError}`,
          );
        }
      } else {
        const msSinceProgress = nowMs - causalProgress.lastProgressAtMs;
        if (msSinceProgress > bootstrapNoProgressFatalMs) {
          throw new Error(
            `LOCAL_PROD_SMOKE_NO_CAUSAL_PROGRESS msSinceProgress=${msSinceProgress} ` +
            `noProgressFatalMs=${bootstrapNoProgressFatalMs} last=${JSON.stringify(last)}`,
          );
        }
        const marketMakerPhase = String(stageHealth.marketMaker?.startupPhase || '');
        if (marketMakerPhase && marketMakerPhase !== lastMarketMakerPhase) {
          lastMarketMakerPhase = marketMakerPhase;
          recordStage(`marketMaker:${marketMakerPhase}`, last);
        }
        if (health.custody?.ok === true) recordStageOnce('custody:ready', last);
        if (health.bootstrapReserves?.ok === true) recordStageOnce('bootstrap-reserves:ready', last);
        if (health.hubMesh?.ok === true) recordStageOnce('hubMesh:ready', last);
        if (
          stageHealth.marketMaker?.cross?.ok === true &&
          Number(stageHealth.marketMaker?.cross?.expectedRoutes || 0) > 0
        ) {
          recordStageOnce('marketMaker:cross-ready', last);
        }
        if (stageHealth.marketMaker?.ok === true) recordStageOnce('marketMaker:ready', last);
        enforceBootstrapStageBudgets(stageHealth, last as Record<string, unknown>);
        if (iteration % 10 === 0 || healthReady(stageHealth)) {
          console.log(`[local-prod-smoke] health ${JSON.stringify(last)}`);
        }
        if (healthReady(stageHealth)) {
          recordStageOnce('system:ready', last);
          return stageHealth;
        }
      }
    } catch (error) {
      if (fatalStageBudgetError) throw new Error(fatalStageBudgetError);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('LOCAL_PROD_SMOKE_STAGE_BUDGET_EXCEEDED')) throw error;
      if (message.includes('LOCAL_PROD_SMOKE_FATAL_LOG')) throw error;
      if (message.includes('LOCAL_PROD_SMOKE_MM_HEALTH_FAILED')) throw error;
      if (message.includes('LOCAL_PROD_SMOKE_NO_CAUSAL_PROGRESS')) throw error;
      last = message;
    }
    iteration += 1;
    await sleep(healthPollIntervalMs);
  }
  throw new Error(`LOCAL_PROD_SMOKE_HEALTH_TIMEOUT last=${JSON.stringify(last)}`);
};

const main = async (): Promise<void> => {
  await assertPortsFree([
    rpcPort,
    rpc2Port,
    apiPort,
    custodyPort,
    custodyDaemonPort,
    nodePortBase,
    nodePortBase + 1,
    nodePortBase + 2,
    nodePortBase + 3,
  ]);
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  console.log(`[local-prod-smoke] workDir=${workDir} portBase=${portBase}`);
  recordStage('smoke:start', { workDir, portBase, strictBudgets: enforceStageBudgets, stageBudgetsMs, healthPollIntervalMs });
  if (useSnapshotTemplate) {
    copySnapshotTemplate(templateDir, workDir);
    recordStage('snapshot:copied', { templateDir, workDir });
  } else {
    const resetMarker = join(workDir, 'core', '.mesh-reset-once');
    mkdirSync(join(workDir, 'core'), { recursive: true });
    writeFileSync(resetMarker, 'local-prod-smoke fresh bootstrap\n');
    recordStage('reset:armed', { resetMarker });
  }
  startManaged('anvil', 'scripts/operations/start-anvil.sh', useSnapshotTemplate ? [] : ['--reset'], {
    XLN_PORT_BASE: String(portBase),
    ANVIL_STATE: join(workDir, 'anvil-state.json'),
    ANVIL_LOG: join(workDir, 'anvil.log'),
    ANVIL_TMPDIR: join(workDir, 'anvil-tmp'),
  });
  await waitForRpc(rpcPort, '0x7a69', 'Testnet');

  // Anvil persists state through a process-global Foundry temp directory.
  // Starting two stateful chains concurrently can collide on the same
  // timestamp-derived temp path and kill both before either binds its port.
  startManaged('anvil2', 'scripts/operations/start-anvil2.sh', useSnapshotTemplate ? [] : ['--reset'], {
    XLN_PORT_BASE: String(portBase),
    ANVIL2_STATE: join(workDir, 'anvil2-state.json'),
    ANVIL2_LOG: join(workDir, 'anvil2.log'),
    ANVIL_TMPDIR: join(workDir, 'anvil2-tmp'),
  });
  await waitForRpc(rpc2Port, '0x7a6a', 'Tron');

  startManaged('server', 'scripts/operations/start-server.sh', [], {
    ...buildInheritedLocalTestLeaseEnv(localTestLease, repoRoot),
    // Perf-diagnostics passthrough: explicit allowlist only, so a polluted
    // parent environment cannot silently change hub behavior between runs.
    ...PROFILING_ENV_KEYS.reduce<Record<string, string>>((forward, name) => {
      const value = process.env[name];
      return value === undefined ? forward : { ...forward, [name]: value };
    }, {}),
    // Per-hub engine flags (e.g. XLN_HUB_ENGINE_ARGS_H1="--cpu-prof --cpu-prof-dir=...")
    // forward the operator's profiler choice to the hub child unchanged.
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.startsWith('XLN_HUB_ENGINE_ARGS_')),
    ),
    XLN_SERVER_PORT: String(apiPort),
    XLN_RDB_ROOT: workDir,
    XLN_DB_PATH: join(workDir, 'prod-main'),
    XLN_JURISDICTIONS_PATH: join(workDir, 'prod-main', 'jurisdictions.json'),
    XLN_MESH_DB_ROOT: join(workDir, 'prod-mesh'),
    XLN_MESH_API_PORT_BASE: String(nodePortBase),
    XLN_MESH_PUBLIC_PORT_BASE: String(nodePortBase),
    XLN_MESH_CUSTODY_PORT: String(custodyPort),
    XLN_MESH_CUSTODY_DAEMON_PORT: String(custodyDaemonPort),
    PUBLIC_WS_BASE_URL: `ws://127.0.0.1:${apiPort}`,
    PUBLIC_RELAY_URL: `ws://127.0.0.1:${apiPort}/relay`,
    INTERNAL_RELAY_URL: `ws://127.0.0.1:${apiPort}/relay`,
    RELAY_URL: `ws://127.0.0.1:${apiPort}/relay`,
    PUBLIC_RPC: `http://127.0.0.1:${apiPort}/rpc`,
    XLN_MIN_DISK_FREE_BYTES: '1',
    // The load driver is the only client of this local mesh and observes the
    // Hub's committed book to decide when a round completed. The public
    // per-client budget would rate-limit that observation and report a driver
    // limit instead of the Hub's settlement capacity.
    XLN_RADAPTER_READ_BURST: process.env['XLN_RADAPTER_READ_BURST'] || '2000',
    XLN_RADAPTER_READ_PER_SEC: process.env['XLN_RADAPTER_READ_PER_SEC'] || '1000',
    XLN_RADAPTER_CONTROL_BURST: process.env['XLN_RADAPTER_CONTROL_BURST'] || '2000',
    XLN_RADAPTER_CONTROL_PER_SEC: process.env['XLN_RADAPTER_CONTROL_PER_SEC'] || '1000',
    XLN_RADAPTER_SEND_BURST: process.env['XLN_RADAPTER_SEND_BURST'] || '2000',
    XLN_RADAPTER_SEND_PER_SEC: process.env['XLN_RADAPTER_SEND_PER_SEC'] || '1000',
    ...(inheritedProcessEnv['XLN_GOSSIP_PROFILE_LOOKUP_PER_CLIENT_LIMIT'] ? {
      XLN_GOSSIP_PROFILE_LOOKUP_PER_CLIENT_LIMIT:
        inheritedProcessEnv['XLN_GOSSIP_PROFILE_LOOKUP_PER_CLIENT_LIMIT'],
      XLN_GOSSIP_PROFILE_LOOKUP_GLOBAL_LIMIT:
        inheritedProcessEnv['XLN_GOSSIP_PROFILE_LOOKUP_GLOBAL_LIMIT'] || '',
    } : {}),
    MARKET_MAKER_BOOTSTRAP_LOOP_MS: process.env['MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '1',
    XLN_RUNTIME_TICK_DELAY_MS: process.env['XLN_RUNTIME_TICK_DELAY_MS'] || '0',
    MARKET_MAKER_RUNTIME_TICK_DELAY_MS:
      process.env['MARKET_MAKER_RUNTIME_TICK_DELAY_MS'] || '0',
    MARKET_MAKER_API_YIELD_MS: process.env['MARKET_MAKER_API_YIELD_MS'] || '25',
    XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME:
      process.env['XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '0',
    XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME:
      process.env['XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '0',
    MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME:
      process.env['MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '0',
    MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME:
      process.env['MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '0',
    XLN_RUNTIME_PROCESS_SLOW_MS: process.env['XLN_RUNTIME_PROCESS_SLOW_MS'] || '250',
    XLN_ENTITY_FRAME_SLOW_MS: process.env['XLN_ENTITY_FRAME_SLOW_MS'] || '250',
    MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE:
      process.env['MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE'] || '1000',
    XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL: marketMakerEventsJsonlPath,
    ...(useSnapshotTemplate ? { XLN_MESH_PRESERVE_STATE_ON_RESET: '1' } : {}),
    ...(useSnapshotTemplate ? {
      XLN_MARKET_MAKER_DISABLE_RESTORE:
        process.env['XLN_MARKET_MAKER_DISABLE_RESTORE'] || '0',
    } : {}),
  });
  recordStage('server:started', { apiPort, marketMakerApiPort });

  const readyHealth = await waitForHealth();
  const marketMakerInfo = process.env['XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO'] === '1'
    ? await assertMarketMakerInfoResponsive()
    : null;
  const bootstrap = marketMakerInfo?.bootstrap ?? readyHealth.bootstrap;
  if (!bootstrap) {
    throw new Error('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_MISSING');
  }
  if (!isHash64(bootstrap.readyHash)) {
    throw new Error('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_HASH_MISSING');
  }
  if (!isHash64(bootstrap.runtimeStateHash)) {
    throw new Error('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_RUNTIME_HASH_MISSING');
  }
  if (!isHash64(bootstrap.entityStateHash)) {
    throw new Error('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_ENTITY_HASH_MISSING');
  }
  emitDebugEvent('bootstrap-hash', {
    stage: 'bootstrap-ready',
    hash: bootstrap.readyHash,
    runtimeStateHash: bootstrap.runtimeStateHash,
    entityStateHash: bootstrap.entityStateHash,
  });
  if (marketMakerInfo && process.env['XLN_LOCAL_PROD_SMOKE_REQUIRE_IDLE_AFTER_READY'] === '1') {
    assertNoMarketMakerBootstrapBacklog(marketMakerInfo);
  }
  if (postBootstrapStabilityMs > 0) {
    recordStage('post-bootstrap:observed', { stabilityMs: postBootstrapStabilityMs });
    await sleep(postBootstrapStabilityMs);
    assertNoFatalChildLogs('post-bootstrap-stability');
    const rawPostBootstrapHealth = await fetchHealth();
    const postBootstrapDirectMarketMakerHealth = fetchMarketMakerHealth(rawPostBootstrapHealth);
    const postBootstrapHealth = healthWithDirectMarketMaker(rawPostBootstrapHealth, postBootstrapDirectMarketMakerHealth);
    if (!healthReady(postBootstrapHealth)) {
      throw new Error(
        `LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HEALTH_REGRESSED last=${JSON.stringify(summarizeHealth(postBootstrapHealth))}`,
      );
    }
    const postBootstrapInfo = process.env['XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO'] === '1'
      ? await assertMarketMakerInfoResponsive()
      : null;
    if (!marketMakerDepthReadyForSmoke(postBootstrapHealth)) {
      throw new Error(
        `LOCAL_PROD_SMOKE_POST_BOOTSTRAP_DEPTH_REGRESSED last=${JSON.stringify(summarizeHealth(postBootstrapHealth))}`,
      );
    }
    const postBootstrapHash = postBootstrapInfo?.bootstrap?.readyHash ?? postBootstrapHealth.bootstrap?.readyHash ?? bootstrap.readyHash;
    if (postBootstrapHash !== bootstrap.readyHash) {
      throw new Error(
        `LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HASH_CHANGED before=${String(bootstrap.readyHash)} after=${String(postBootstrapHash)}`,
      );
    }
    recordStage('post-bootstrap:stable', summarizeHealth(postBootstrapHealth));
  }

  await runProductionSwapLoadSmoke();

  // Optional adversary branch AFTER same+cross books are green. Profiles only
  // exercise orchestrator recovery — they never alter MM quote formulas.
  const adversaryProfile = parseAdversaryProfile(
    process.env['XLN_ADVERSARY_PROFILE'] || process.env['XLN_LOCAL_PROD_SMOKE_ADVERSARY'],
  );
  if (adversaryProfile !== 'none') {
    recordStage('adversary:start', { profile: adversaryProfile });
    console.log(`CROSS_J_PHASE_BOOKS_READY adversary=${adversaryProfile}`);
    await runAdversaryProfile(adversaryProfile, {
      apiBaseUrl: `http://127.0.0.1:${apiPort}`,
      fetchHealth: async () => {
        // Soft polls only: SIGKILL of MM (or brief control-plane bounce during
        // child replace) can make /api/health and MM /api/health unresponsive.
        // Returning a degraded snapshot keeps the adversary wait loop alive so
        // orchestrator restart/replace remains observable.
        try {
          const raw = await fetchHealth();
          const probe = fetchMarketMakerHealthProbe(raw);
          return healthWithDirectMarketMaker(raw, probe.payload) as MeshHealthPayload;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`[mm-mesh-adversary] health soft-fail: ${message}`);
          return {
            systemOk: false,
            marketMaker: { ok: false, startupPhase: null, cross: { ok: false } },
            process: { children: [] },
            hubs: [],
          };
        }
      },
      booksReady: (health) => {
        const mmChild = (health.process?.children ?? []).find(
          (child) => child.role === 'market-maker' && String(child.name || '').toUpperCase() === 'MM',
        );
        return mmChild?.online === true && marketMakerDepthReadyForSmoke(health as HealthPayload);
      },
      timeoutMs: 180_000,
    });
    // Post-adversary: hard fail — stack must be fully responsive again.
    let afterAdversary: HealthPayload | null = null;
    const afterDeadline = Date.now() + 60_000;
    while (Date.now() < afterDeadline) {
      try {
        const rawAfter = await fetchHealth();
        const afterProbe = fetchMarketMakerHealthProbe(rawAfter);
        if (afterProbe.transientError !== null) {
          throw new Error(afterProbe.transientError);
        }
        const candidate = healthWithDirectMarketMaker(rawAfter, afterProbe.payload);
        if (marketMakerFullDepthReady(candidate)) {
          afterAdversary = candidate;
          break;
        }
      } catch (error) {
        console.log(
          `[mm-mesh-adversary] post-check soft-fail: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!afterAdversary) {
      throw new Error(
        `LOCAL_PROD_SMOKE_ADVERSARY_BOOKS_NOT_READY profile=${adversaryProfile}`,
      );
    }
    recordStage('adversary:done', { profile: adversaryProfile, ...summarizeHealth(afterAdversary) });
    console.log(`[OK] phase=ADVERSARY profile=${adversaryProfile} books=ready`);
  }
  let epochRotations: EpochRotationEvidence[] | undefined;
  if (requireEpochRotation) {
    assertNoFatalChildLogs('pre-epoch-inspection');
    await commitPostRotationProofFrames();
    await stopManaged();
    epochRotations = await inspectEpochRotations();
    recordStage('storage-epoch:verified', epochRotations);
  }
  const metrics: BootstrapMetrics = {
    schema: 'xln-local-prod-bootstrap-benchmark-v1',
    elapsedMs: Date.now() - smokeStartedAt,
    stages,
    bootstrapHash: bootstrap.readyHash,
    runtimeStateHash: bootstrap.runtimeStateHash,
    entityStateHash: bootstrap.entityStateHash,
    restoredEntityStateHash: isHash64(bootstrap.restoredEntityStateHash)
      ? bootstrap.restoredEntityStateHash
      : null,
    workDir,
    eventsJsonl: eventsJsonlPath,
    marketMakerEventsJsonl: marketMakerEventsJsonlPath,
    ...(epochRotations ? { epochRotations } : {}),
    ...(useSnapshotTemplate ? { templateDir } : {}),
  };
  const metricsPath = process.env['XLN_LOCAL_PROD_SMOKE_METRICS_JSON'] || join(workDir, 'bootstrap-metrics.json');
  writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(
    `[local-prod-smoke] bootstrapHash=${metrics.bootstrapHash} runtimeStateHash=${metrics.runtimeStateHash} entityStateHash=${metrics.entityStateHash} metrics=${metricsPath}`,
  );
  console.log('[local-prod-smoke] green');
};

try {
  await main();
} catch (error) {
  emitDebugEvent('fatal', { stage: 'local-prod-smoke', error: normalizeError(error) });
  throw error;
} finally {
  try {
    await stopManaged();
    assertLocalTestPortsFree(localTestLease.ports);
  } finally {
    localTestLease.release();
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
  }
}
