/**
 * Isolated HLT shard. Child leases its own 20-port slot and never inherits
 * 8080/8082, Anvil RPC, or another test-lane lease.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../protocol/boundary-validation';
import { LOCAL_TEST_LEASE_ENV_NAMES } from '../../scripts/e2e/harness/local-test-port-lease';
import {
  parseHltDashboardConfig,
  previewHltDashboard,
  type HltDashboardConfig,
} from './hlt-dashboard-preview';

const SMOKE_ENTRY = 'core/scripts/operations/production/local-prod-smoke.ts';
const MAX_LOG_TAIL_CHARS = 12_000;
const BOOTSTRAP_BUDGET_MS = 20 * 60_000;
const KILL_GRACE_MS = 15_000;
const KEEP_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'TMP', 'LANG', 'LC_ALL',
  'BUN_INSTALL', 'CI', 'XLN_LOG_LEVEL', 'XLN_LOG_SCOPES',
] as const;
const START_BODY_KEYS = [
  'users', 'usersPerRuntime', 'rate', 'duration', 'mix', 'hubs',
  'marketMakers', 'mode', 'profile', 'paymentMin', 'paymentMax',
] as const;
const FORBIDDEN_CHILD_ENV = [
  'XLN_PORT_BASE', 'XLN_SERVER_PORT', 'XLN_MESH_API_PORT_BASE',
  'XLN_MESH_PUBLIC_PORT_BASE', 'XLN_MESH_CUSTODY_PORT', 'XLN_MESH_CUSTODY_DAEMON_PORT',
  'ANVIL_RPC', 'PUBLIC_RPC', 'PUBLIC_WS_BASE_URL', 'PUBLIC_RELAY_URL',
  'INTERNAL_RELAY_URL', 'RELAY_URL', 'XLN_DB_PATH', 'XLN_RDB_ROOT', 'XLN_MESH_DB_ROOT',
  'XLN_LOCAL_PROD_SMOKE_PORT_BASE', 'XLN_LOCAL_PROD_SMOKE_TEMPLATE_DIR',
  ...LOCAL_TEST_LEASE_ENV_NAMES,
] as const;

export const HLT_RUN_STATUSES = ['idle', 'running', 'green', 'red', 'aborted'] as const;
export type HltRunStatusName = (typeof HLT_RUN_STATUSES)[number];

export type HltIsolatedRunView = Readonly<{
  active: boolean; status: HltRunStatusName; pid: number | null;
  workDir: string | null; logPath: string | null; startedAt: number | null;
  finishedAt: number | null; exitCode: number | null; error: string | null; logTail: string;
}>;

// Narrowed to the one overload actually called below (3-arg, no-stdio-tuple).
// `typeof spawn` pulls in every overload of Node's spawn, which breaks across
// this module boundary whenever two distinct @types/node copies resolve in
// the workspace ("two different types with this name exist, but they are
// unrelated") — this shape needs no cross-module identity to typecheck.
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type ActiveHltRun = {
  proc: ChildProcess;
  startedAt: number;
  workDir: string;
  logPath: string;
  logTail: string;
  aborting: boolean;
  logClosed: boolean;
  closeLog: () => void;
  watchdog: ReturnType<typeof setTimeout>;
  killTimer: ReturnType<typeof setTimeout> | null;
};

const idleRun = (): HltIsolatedRunView => ({
  active: false, status: 'idle', pid: null, workDir: null, logPath: null,
  startedAt: null, finishedAt: null, exitCode: null, error: null, logTail: '',
});

let active: ActiveHltRun | null = null;
let last: HltIsolatedRunView = idleRun();

const assignSearchParam = (params: URLSearchParams, key: string, value: unknown): void => {
  if (value === undefined) return;
  params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
};

export const parseHltStartConfig = (value: unknown): HltDashboardConfig => {
  if (value === null || value === undefined) return parseHltDashboardConfig(new URLSearchParams());
  const record = requireBoundaryRecord(value, 'HLT_DASHBOARD_BODY_INVALID');
  requireExactBoundaryKeys(record, [], START_BODY_KEYS, 'HLT_DASHBOARD_BODY');
  const params = new URLSearchParams();
  for (const key of START_BODY_KEYS) assignSearchParam(params, key, record[key]);
  return parseHltDashboardConfig(params);
};

export const buildHltIsolatedEnv = (
  config: HltDashboardConfig,
  workDir: string,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of KEEP_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env['XLN_LOCAL_PROD_SMOKE_DIR'] = workDir;
  env['XLN_HLT_USERS'] = String(config.users);
  env['XLN_HLT_USERS_PER_RUNTIME'] = String(config.usersPerRuntime);
  env['XLN_HLT_MIX'] = previewHltDashboard(config).config.mix;
  env['XLN_HLT_RATE_PER_USER'] = String(config.ratePerUserPerSecond);
  env['XLN_HLT_DURATION_S'] = String(config.durationSeconds);
  env['XLN_HLT_HUBS'] = config.hubs;
  env['XLN_HLT_MARKET_MAKERS'] = config.marketMakers;
  env['XLN_HLT_PAYMENT_AMOUNT_MIN'] = String(config.paymentAmountMin);
  env['XLN_HLT_PAYMENT_AMOUNT_MAX'] = String(config.paymentAmountMax);
  env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_SMOKE'] = '1';
  env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE'] = config.mode;
  env['XLN_GOSSIP_PROFILE_LOOKUP_PER_CLIENT_LIMIT'] = String(Math.max(64, config.users));
  env['XLN_GOSSIP_PROFILE_LOOKUP_GLOBAL_LIMIT'] = String(Math.max(1_000, config.users * 4));
  if (config.profile) {
    env['XLN_RUNTIME_PROCESS_PROFILE'] = '1';
    env['XLN_ENTITY_FRAME_PROFILE'] = '1';
  }
  return env;
};

export const assertHltIsolatedEnv = (env: NodeJS.ProcessEnv): void => {
  for (const name of FORBIDDEN_CHILD_ENV) {
    if (env[name] !== undefined) throw new Error(`HLT_RUN_ENV_LEAK:${name}`);
  }
};

const appendLog = (run: ActiveHltRun, chunk: string): void => {
  run.logTail = (run.logTail + chunk).slice(-MAX_LOG_TAIL_CHARS);
  last = { ...last, logTail: run.logTail };
};

const finishRun = (
  run: ActiveHltRun,
  status: Exclude<HltRunStatusName, 'idle' | 'running'>,
  exitCode: number | null,
  error: string | null,
): void => {
  if (active !== run) return;
  clearTimeout(run.watchdog);
  if (run.killTimer) clearTimeout(run.killTimer);
  run.closeLog();
  active = null;
  last = {
    active: false,
    status,
    pid: run.proc.pid ?? last.pid,
    workDir: run.workDir,
    logPath: run.logPath,
    startedAt: run.startedAt,
    finishedAt: Date.now(),
    exitCode,
    error,
    logTail: run.logTail,
  };
};

const signalRun = (run: ActiveHltRun, signal: NodeJS.Signals): void => {
  try {
    run.proc.kill(signal);
  } catch {
    // Child already exited; finishRun handles the close path.
  }
};

const armKillGrace = (run: ActiveHltRun): void => {
  if (run.killTimer) return;
  run.killTimer = setTimeout(() => signalRun(run, 'SIGKILL'), KILL_GRACE_MS);
  run.killTimer.unref?.();
};

const bindChild = (run: ActiveHltRun, log: ReturnType<typeof createWriteStream>): void => {
  const writeChunk = (chunk: Buffer | string): void => {
    const text = chunk.toString();
    if (!run.logClosed) log.write(text);
    appendLog(run, text);
  };
  run.proc.stdout?.on('data', writeChunk);
  run.proc.stderr?.on('data', writeChunk);
  run.proc.once('error', error => finishRun(run, 'red', null, error.message));
  run.proc.once('exit', code => {
    const status = run.aborting ? 'aborted' : code === 0 ? 'green' : 'red';
    const error = status === 'red' ? `HLT_RUN_EXIT:${String(code)}` : null;
    finishRun(run, status, code ?? null, error);
  });
};

export const readHltIsolatedRun = (): HltIsolatedRunView => {
  if (!active) return last;
  return {
    ...last,
    active: true,
    status: 'running',
    pid: active.proc.pid ?? last.pid,
    logTail: active.logTail,
  };
};

const runningView = (proc: ChildProcess, workDir: string, logPath: string, startedAt: number): HltIsolatedRunView => ({
  active: true, status: 'running', pid: proc.pid ?? null, workDir, logPath,
  startedAt, finishedAt: null, exitCode: null, error: null, logTail: '',
});

const spawnIsolatedSmoke = (cwd: string, env: NodeJS.ProcessEnv, spawnFn: SpawnFn): ChildProcess =>
  spawnFn('bun', [SMOKE_ENTRY], {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const createActiveRun = (
  proc: ChildProcess,
  workDir: string,
  logPath: string,
  startedAt: number,
  durationSeconds: number,
  log: ReturnType<typeof createWriteStream>,
): ActiveHltRun => {
  const run: ActiveHltRun = {
    proc,
    startedAt,
    workDir,
    logPath,
    logTail: '',
    aborting: false,
    logClosed: false,
    closeLog: () => {
      if (run.logClosed) return;
      run.logClosed = true;
      log.end();
    },
    watchdog: setTimeout(() => {
      if (active !== run) return;
      appendLog(run, '\nHLT_RUN_WATCHDOG\n');
      signalRun(run, 'SIGTERM');
      armKillGrace(run);
    }, BOOTSTRAP_BUDGET_MS + durationSeconds * 1_000),
    killTimer: null,
  };
  run.watchdog.unref?.();
  return run;
};

export const startHltIsolatedRun = (options: {
  config: HltDashboardConfig;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
}): HltIsolatedRunView => {
  if (active) throw new Error('HLT_RUN_ALREADY_RUNNING');
  const preview = previewHltDashboard(options.config);
  if (options.config.mode === 'cross' && preview.hubShare.hubCount < 2) {
    throw new Error('HLT_RUN_CROSS_NEEDS_TWO_HUBS');
  }
  const cwd = options.cwd ?? process.cwd();
  const startedAt = options.now?.() ?? Date.now();
  const workDir = join(tmpdir(), `xln-hlt-dash-${startedAt}-${options.config.users}-${options.config.mode}`);
  const logDir = resolve(cwd, '.logs', 'qa', 'hlt', 'runs');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${startedAt}.log`);
  const env = buildHltIsolatedEnv(options.config, workDir, options.env ?? process.env);
  assertHltIsolatedEnv(env);
  const log = createWriteStream(logPath, { flags: 'w' });
  const proc = spawnIsolatedSmoke(cwd, env, options.spawn ?? spawn);
  const run = createActiveRun(proc, workDir, logPath, startedAt, options.config.durationSeconds, log);
  last = runningView(proc, workDir, logPath, startedAt);
  active = run;
  bindChild(run, log);
  proc.unref?.();
  return readHltIsolatedRun();
};

export const abortHltIsolatedRun = (): HltIsolatedRunView => {
  if (!active) throw new Error('HLT_RUN_NOT_RUNNING');
  active.aborting = true;
  appendLog(active, '\nHLT_RUN_ABORT\n');
  signalRun(active, 'SIGTERM');
  armKillGrace(active);
  return readHltIsolatedRun();
};

export const resetHltIsolatedRunForTests = (): void => {
  if (active) {
    clearTimeout(active.watchdog);
    if (active.killTimer) clearTimeout(active.killTimer);
    active.closeLog();
    active = null;
  }
  last = idleRun();
};
