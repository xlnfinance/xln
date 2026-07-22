/**
 * Parallel Playwright runner with fully isolated local stacks per shard:
 * - dedicated anvil RPCs (/rpc + /rpc2)
 * - dedicated runtime server
 * - dedicated vite preview server (single frontend build shared by all shards)
 *
 * Usage:
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts --shards=3
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts --base-port=20000
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts --all
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts --video=on --trace=on-first-retry --max-failures=1
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts --all --start-at=18 --preserve-artifacts
 */

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  applyQaRunSeverity,
  assertQaReleaseRunSeverity,
  compareQaRunWithHistory,
  classifyQaArtifactSensitivity,
  classifyQaShardFailure,
  deriveQaTestDescription,
  deriveQaTestHandle,
  formatQaRunIdUtc,
  normalizeQaBrowserIssues,
  parseQaTimelineSteps,
  redactQaSecretText,
  recordQaRunHistory,
  summarizeQaFailureClasses,
  summarizeQaBrowserIssues,
  summarizeQaRunBrowserHealth,
} from '../qa/report';
import {
  QA_TEST_CATEGORY_TAGS,
  formatQaTestCategoryViolations,
  inspectQaTestCategory,
  qaRunTestCategory,
  qaTestCategoryFromTags,
} from '../qa/test-categories';
import type {
  QaArtifact,
  QaArtifactKind,
  QaBrowserIssue,
  QaFailureCapsule,
  QaRunManifest,
  QaScenarioMetadata,
  QaSlowStep,
  QaTestCategory,
} from '../qa/types';
import { assertMinDiskFree } from '../orchestrator/storage-monitor';
import { compareStableText } from '../protocol/serialization';
import { sanitizeChildProcessEnv } from '../server/child-process-env';
import {
  createIncrementalRuntimeFatalLogScanner,
  findRuntimeFatalLogLines,
  tailLog,
} from './e2e-fatal-log-monitor';
import {
  stopProcessDependencyChain,
  type ManagedChildProcess,
} from './e2e-managed-process';
import {
  buildIsolatedE2ERerunCommand,
  parseJsonLinesStrict,
  parseJsonStrict,
  readPlaywrightFailureReport,
} from './e2e-failure-capsule';
import { cleanupTestArtifactsBeforeRun } from './test-artifact-cleanup';
import { listPlaywrightTestMetadata } from './playwright-test-metadata';

type CliArgs = {
  shards: number;
  basePort: number;
  stackTimeoutMs: number;
  testTimeoutMs: number;
  phaseWarnMs: number;
  anvilBin: string;
  maxFailures: number;
  maxMmConcurrency: number;
  maxResetConcurrency: number;
  workersPerShard: number;
  videoMode: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
  traceMode: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
  screenshotMode: 'off' | 'on' | 'only-on-failure';
  reporter: 'line' | 'list' | 'dot';
  qaCategory?: QaTestCategory | undefined;
  pwGrep?: string | undefined;
  pwProject?: string | undefined;
  pwFiles: string[];
  batchFiles: boolean;
  includeAllSpecs: boolean;
  excludeMarketMaker: boolean;
  marketMakerOnly: boolean;
  strictBrowserHealth: boolean;
  skipBuild: boolean;
  startAt: number;
  preserveArtifacts: boolean;
  prewaitHealth: 'reset' | 'http' | 'full';
};

export type E2EShardRunStatus = 'passed' | 'failed' | 'cancelled';
export type E2EShardRunClass =
  | 'passed'
  | 'playwright'
  | 'runtime-fatal'
  | 'startup'
  | 'runner'
  | 'cancelled';

export type E2EPrimaryFailureIdentity = Readonly<{
  shard: number;
  resultClass: Exclude<E2EShardRunClass, 'passed' | 'cancelled'>;
  error: string;
  failureCapsule: QaFailureCapsule | null;
  failureCapsulePath: string | null;
}>;

export type E2ERunFailureState = Readonly<{
  failedCount: number;
  primaryFailure: E2EPrimaryFailureIdentity | null;
}>;

type E2ERunOutcome = Readonly<{
  shard: number;
  status: E2EShardRunStatus;
  resultClass: E2EShardRunClass;
  error?: string | undefined;
  failureCapsule?: QaFailureCapsule | null | undefined;
  failureCapsulePath?: string | null | undefined;
}>;

export const initialE2ERunFailureState = (): E2ERunFailureState => ({
  failedCount: 0,
  primaryFailure: null,
});

export const advanceE2ERunFailureState = (
  state: E2ERunFailureState,
  outcome: E2ERunOutcome,
  maxFailures: number,
): { state: E2ERunFailureState; shouldAbort: boolean } => {
  if (outcome.status !== 'failed') {
    const expectedClass = outcome.status;
    if (outcome.resultClass !== expectedClass) {
      throw new Error(
        `E2E_RUN_OUTCOME_CLASS_INVALID:status=${outcome.status}:class=${outcome.resultClass}`,
      );
    }
    return { state, shouldAbort: false };
  }
  if (outcome.resultClass === 'passed' || outcome.resultClass === 'cancelled') {
    throw new Error(`E2E_RUN_FAILURE_CLASS_INVALID:${outcome.resultClass}`);
  }
  if (!outcome.error) throw new Error(`E2E_RUN_FAILURE_ERROR_REQUIRED:shard=${outcome.shard}`);
  const identity: E2EPrimaryFailureIdentity = {
    shard: outcome.shard,
    resultClass: outcome.resultClass,
    error: outcome.error,
    failureCapsule: outcome.failureCapsule ?? null,
    failureCapsulePath: outcome.failureCapsulePath ?? null,
  };
  const nextState: E2ERunFailureState = {
    failedCount: state.failedCount + 1,
    primaryFailure: state.primaryFailure ?? identity,
  };
  return {
    state: nextState,
    shouldAbort: maxFailures > 0 && nextState.failedCount >= maxFailures,
  };
};

export type E2EGlobalFailFastAbortReason = Readonly<{
  kind: 'e2e-global-fail-fast';
  primaryFailure: E2EPrimaryFailureIdentity;
}>;

export const createE2EGlobalFailFastAbortReason = (
  primaryFailure: E2EPrimaryFailureIdentity,
): E2EGlobalFailFastAbortReason => ({ kind: 'e2e-global-fail-fast', primaryFailure });

export const isE2EGlobalFailFastAbortSignal = (signal?: AbortSignal): boolean => {
  const reason: unknown = signal?.reason;
  if (!reason || typeof reason !== 'object') return false;
  const candidate = reason as Partial<E2EGlobalFailFastAbortReason>;
  return candidate.kind === 'e2e-global-fail-fast' &&
    typeof candidate.primaryFailure?.shard === 'number';
};

type RunResult = {
  shard: number;
  status: E2EShardRunStatus;
  resultClass: E2EShardRunClass;
  durationMs: number;
  logPath: string;
  target: string;
  title: string;
  requireMarketMaker: boolean;
  requireCustody: boolean;
  scenario: QaScenarioMetadata | null;
  phaseMs: {
    preflight: number;
    anvilBoot: number;
    apiBoot: number;
    apiHealthy: number;
    viteBoot: number;
    playwright: number;
  };
  error?: string;
  diagnostics?: string[];
  failureCapsule?: QaFailureCapsule | null;
  failureCapsulePath?: string | null;
  perf: QaPerfSummary;
};

type RunTask = {
  shard: number;
  totalShards: number;
  pwTargets: string[];
  requireMarketMaker: boolean;
  requireCustody: boolean;
  usePlaywrightShard: boolean;
  scenario: QaScenarioMetadata | null;
  title?: string | undefined;
  grep?: string | undefined;
  tags: string[];
  testCategory: QaTestCategory;
};

type JsonRecord = Record<string, unknown>;
type HealthPayload = JsonRecord;
type E2EBrowserHealthCounters = {
  issueCount: number;
  errorCount: number;
  warningCount: number;
  networkFailureCount: number;
  httpErrorCount: number;
};
const RESET_CONFIRMATION = 'RESET_MESH_STATE';
const E2E_ANVIL_HISTORY_STATES = 256;
const DEFAULT_E2E_TEST_TIMEOUT_MS = 660_000;
const DEV_RESERVED_PORTS = new Set([8080, 8081, 8082, 8087, 8088, 8545, 8546, 9100]);

export type E2EShardPorts = {
  rpc: number;
  rpc2: number;
  api: number;
  web: number;
  custody: number;
  custodyDaemon: number;
  runtimeChildren: number[];
};

export type E2EShardPaths = {
  root: string;
  rdbRoot: string;
  jdbRoot: string;
  dbRoot: string;
  logsRoot: string;
  artifactsRoot: string;
  logPath: string;
  resultsDir: string;
  browserEventsPath: string;
};

export type E2EBuildArtifacts = {
  cacheRoot: string;
  publicDir: string;
  runtimeBundlePath: string;
  svelteKitOutDir: string;
  frontendBuildDir: string;
};

export const deriveE2EShardPorts = (basePort: number, shard: number): E2EShardPorts => {
  const offset = basePort + shard * 20;
  return {
    rpc: offset,
    rpc2: offset + 1,
    api: offset + 2,
    web: offset + 4,
    custody: offset + 7,
    custodyDaemon: offset + 8,
    runtimeChildren: [offset + 12, offset + 13, offset + 14, offset + 15],
  };
};

export const assertE2EShardPortsIsolated = (basePort: number, shardCount: number): void => {
  for (let shard = 0; shard < shardCount; shard += 1) {
    const ports = deriveE2EShardPorts(basePort, shard);
    for (const [role, port] of Object.entries(ports).flatMap(([role, value]) =>
      Array.isArray(value)
        ? value.map((childPort, index) => [`${role}[${index}]`, childPort] as const)
        : [[role, value] as const]
    )) {
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`E2E_PORT_INVALID:shard=${shard}:role=${role}:port=${port}`);
      }
      if (DEV_RESERVED_PORTS.has(port)) {
        throw new Error(`E2E_DEV_PORT_OVERLAP:shard=${shard}:role=${role}:port=${port}`);
      }
    }
  }
};

export const deriveE2EShardPaths = (runRoot: string, shard: number): E2EShardPaths => {
  const root = resolve(runRoot, `shard-${shard}`);
  const rdbRoot = join(root, 'rdb');
  const jdbRoot = join(root, 'jdb');
  const logsRoot = join(root, 'logs');
  const artifactsRoot = join(root, 'artifacts');
  return {
    root,
    rdbRoot,
    jdbRoot,
    dbRoot: join(rdbRoot, 'mesh'),
    logsRoot,
    artifactsRoot,
    logPath: join(logsRoot, 'e2e.log'),
    resultsDir: join(artifactsRoot, 'playwright'),
    browserEventsPath: join(logsRoot, 'browser-events.jsonl'),
  };
};

type QaCodeFingerprint = {
  gitHead: string | null;
  gitBranch: string | null;
  gitStatus: string;
  dirty: boolean;
  codeHash: string;
  buildInputHash: string;
  computedAt: number;
  trackedFileCount: number;
  trackedBytes: number;
};

type QaPerfChildSample = {
  name: string;
  pid: number;
  cpuPct: number;
  memPct: number;
  rssKb: number;
};

type QaPerfSample = {
  ts: number;
  load1: number;
  load5: number;
  load15: number;
  freeMemBytes: number;
  totalMemBytes: number;
  runnerRssBytes: number;
  children: QaPerfChildSample[];
};

type QaPerfSummary = {
  sampleCount: number;
  avgLoad1: number;
  peakLoad1: number;
  minFreeMemBytes: number;
  maxRunnerRssBytes: number;
  maxChildCpuPct: number;
  maxChildRssKb: number;
  samples: QaPerfSample[];
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null;

const recordOrEmpty = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

const arrayOf = (record: JsonRecord, key: string): unknown[] =>
  Array.isArray(record[key]) ? record[key] : [];

const recordArrayOf = (record: JsonRecord, key: string): JsonRecord[] =>
  arrayOf(record, key).filter(isRecord);

const spawnText = (cmd: string, args: string[]): string => {
  const result = spawnSync(cmd, args, {
    cwd: process.cwd(),
    env: sanitizeChildProcessEnv(process.env),
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
};

export const isE2EBuildInputPath = (file: string): boolean => {
  const path = file.replaceAll('\\', '/').replace(/^\.\//, '');
  if (path.startsWith('runtime/')) {
    return !path.startsWith('runtime/__tests__/') && !path.startsWith('runtime/scripts/');
  }
  if (path.startsWith('frontend/')) {
    return ![
      'frontend/node_modules/',
      'frontend/.svelte-kit/',
      'frontend/build/',
      'frontend/dist/',
    ].some(prefix => path.startsWith(prefix));
  }
  if (path.startsWith('jurisdictions/artifacts/')) return true;
  if (path.startsWith('docs/') || path.startsWith('scenarios/')) return true;
  return [
    'bun.lock',
    'package.json',
    'tsconfig.json',
    'tsconfig.runtime.json',
    'scripts/build-runtime.sh',
  ].includes(path);
};

const updateSourceHash = (
  hash: ReturnType<typeof createHash>,
  file: string,
  data: Buffer,
): void => {
  hash.update(file);
  hash.update('\0');
  hash.update(data);
  hash.update('\0');
};

export const computeE2EBuildInputHash = (
  files: readonly string[],
  root = process.cwd(),
): string => {
  const hash = createHash('sha256');
  for (const file of files.filter(isE2EBuildInputPath).slice().sort(compareStableText)) {
    const data = readFileSync(resolve(root, file));
    updateSourceHash(hash, file, data);
  }
  return hash.digest('hex');
};

const listRepositorySourceFiles = (): string[] => {
  const sourceRaw = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: process.cwd(),
    env: sanitizeChildProcessEnv(process.env),
    stdio: 'pipe',
    encoding: 'buffer',
  });
  if (sourceRaw.status !== 0) {
    throw new Error(`GIT_LS_FILES_FAILED:${String(sourceRaw.stderr || '').trim()}`);
  }
  return Buffer.from(sourceRaw.stdout)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort(compareStableText);
};

export const computeE2ESourceDriftProbe = (
  files: readonly string[],
  root = process.cwd(),
): string => {
  const hash = createHash('sha256');
  for (const file of files.slice().sort(compareStableText)) {
    hash.update(file).update('\0');
    const path = resolve(root, file);
    if (!existsSync(path)) {
      hash.update('missing\0');
      continue;
    }
    const stats = statSync(path, { bigint: true });
    hash.update(String(stats.size)).update('\0');
    hash.update(String(stats.mtimeNs)).update('\0');
  }
  return hash.digest('hex');
};

const computeRepositorySourceDriftProbe = (): string =>
  computeE2ESourceDriftProbe(listRepositorySourceFiles());

const computeCodeFingerprint = (): QaCodeFingerprint => {
  const gitHead = spawnText('git', ['rev-parse', 'HEAD']) || null;
  const gitBranch = spawnText('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || null;
  const gitStatus = spawnText('git', ['status', '--short', '--untracked-files=all']);
  const files = listRepositorySourceFiles();
  const hash = createHash('sha256');
  const buildInputHash = createHash('sha256');
  let trackedBytes = 0;
  for (const file of files) {
    const absolutePath = resolve(process.cwd(), file);
    if (!existsSync(absolutePath)) continue;
    const data = readFileSync(absolutePath);
    trackedBytes += data.length;
    updateSourceHash(hash, file, data);
    if (isE2EBuildInputPath(file)) updateSourceHash(buildInputHash, file, data);
  }
  return {
    gitHead,
    gitBranch,
    gitStatus,
    dirty: gitStatus.length > 0,
    codeHash: hash.digest('hex'),
    buildInputHash: buildInputHash.digest('hex'),
    computedAt: Date.now(),
    trackedFileCount: files.length,
    trackedBytes,
  };
};

export const assertE2ECodeFingerprintStable = (
  startCodeHash: string,
  endCodeHash: string,
): void => {
  if (startCodeHash === endCodeHash) return;
  throw new Error(`E2E_CODE_DRIFT:start=${startCodeHash}:end=${endCodeHash}`);
};

export type E2ECodeDriftGuard = {
  assertStable: (force?: boolean) => void;
};

export const createE2ECodeDriftGuard = (options: {
  expectedCodeHash: string;
  minIntervalMs?: number;
  computeCodeHash: () => string;
  now?: () => number;
}): E2ECodeDriftGuard => {
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 5_000);
  const now = options.now ?? Date.now;
  let lastCheckAt: number | null = null;
  let driftFailure: Error | null = null;
  return {
    assertStable(force = false): void {
      if (driftFailure) throw driftFailure;
      const checkedAt = now();
      if (!force && lastCheckAt !== null && checkedAt - lastCheckAt < minIntervalMs) return;
      lastCheckAt = checkedAt;
      try {
        assertE2ECodeFingerprintStable(options.expectedCodeHash, options.computeCodeHash());
      } catch (error) {
        driftFailure = error instanceof Error ? error : new Error(String(error));
        throw driftFailure;
      }
    },
  };
};

const emptyPerfSummary = (): QaPerfSummary => ({
  sampleCount: 0,
  avgLoad1: 0,
  peakLoad1: 0,
  minFreeMemBytes: 0,
  maxRunnerRssBytes: 0,
  maxChildCpuPct: 0,
  maxChildRssKb: 0,
  samples: [],
});

type E2EPerfChild = { name: string; pid: number | undefined };

export const parseE2EChildPerfOutput = (
  children: readonly E2EPerfChild[],
  output: string,
): QaPerfChildSample[] => {
  const metricsByPid = new Map<number, Omit<QaPerfChildSample, 'name'>>();
  for (const line of output.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const parts = line.split(/\s+/).map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) {
      throw new Error(`E2E_PS_OUTPUT_INVALID:${line.slice(0, 200)}`);
    }
    const [pid, cpuPct, memPct, rssKb] = parts as [number, number, number, number];
    if (!Number.isSafeInteger(pid) || pid <= 0 || metricsByPid.has(pid)) {
      throw new Error(`E2E_PS_OUTPUT_INVALID:${line.slice(0, 200)}`);
    }
    metricsByPid.set(pid, { pid, cpuPct, memPct, rssKb });
  }
  return children.flatMap(({ name, pid }) => {
    if (!pid || pid <= 0) return [];
    const metrics = metricsByPid.get(pid);
    return metrics ? [{ name, ...metrics }] : [];
  });
};

export const readE2EChildrenPerf = (children: readonly E2EPerfChild[]): QaPerfChildSample[] => {
  const pids = Array.from(new Set(children
    .map(child => child.pid)
    .filter((pid): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0)));
  if (pids.length === 0) return [];
  const result = spawnSync('ps', ['-p', pids.join(','), '-o', 'pid=,%cpu=,%mem=,rss='], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const output = String(result.stdout || '').trim();
  if (!output && result.status === 1) return [];
  if (result.error || result.status !== 0) {
    throw new Error(
      `E2E_PS_SAMPLE_FAILED:status=${String(result.status)}:` +
      `${result.error?.message || String(result.stderr || '').trim() || 'unknown'}`,
    );
  }
  return parseE2EChildPerfOutput(children, output);
};

const summarizePerfSamples = (samples: QaPerfSample[]): QaPerfSummary => {
  if (samples.length === 0) return emptyPerfSummary();
  const childSamples = samples.flatMap(sample => sample.children);
  const avgLoad1 = samples.reduce((sum, sample) => sum + sample.load1, 0) / samples.length;
  const peakLoad1 = samples.reduce((max, sample) => Math.max(max, sample.load1), 0);
  const minFreeMemBytes = samples.reduce((min, sample) => Math.min(min, sample.freeMemBytes), Number.MAX_SAFE_INTEGER);
  const maxRunnerRssBytes = samples.reduce((max, sample) => Math.max(max, sample.runnerRssBytes), 0);
  const maxChildCpuPct = childSamples.reduce((max, sample) => Math.max(max, sample.cpuPct), 0);
  const maxChildRssKb = childSamples.reduce((max, sample) => Math.max(max, sample.rssKb), 0);
  return {
    sampleCount: samples.length,
    avgLoad1: Math.round(avgLoad1 * 100) / 100,
    peakLoad1: Math.round(peakLoad1 * 100) / 100,
    minFreeMemBytes,
    maxRunnerRssBytes,
    maxChildCpuPct: Math.round(maxChildCpuPct * 100) / 100,
    maxChildRssKb,
    samples,
  };
};

const startPerfMonitor = (
  getChildren: () => Array<{ name: string; pid: number | undefined }>,
): { stop: () => QaPerfSummary } => {
  const samples: QaPerfSample[] = [];
  const sample = (): void => {
    const [load1 = 0, load5 = 0, load15 = 0] = loadavg();
    samples.push({
      ts: Date.now(),
      load1,
      load5,
      load15,
      freeMemBytes: freemem(),
      totalMemBytes: totalmem(),
      runnerRssBytes: process.memoryUsage().rss,
      children: readE2EChildrenPerf(getChildren()),
    });
  };
  sample();
  const timer = setInterval(sample, 1000);
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return summarizePerfSamples(samples);
    },
  };
};

type RunnerLockPayload = {
  pid: number;
  startedAt: number;
  cwd: string;
  logsDir?: string;
};

type AsyncLimiter = {
  run: <T>(fn: () => Promise<T>) => Promise<T>;
};

export const createAsyncLimiter = (limit: number): AsyncLimiter => {
  const maxActive = Math.max(1, Math.floor(limit));
  let active = 0;
  let queued = 0;
  const queue: Array<() => void> = [];

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= maxActive) {
      queued += 1;
      await new Promise<void>(resolve => queue.push(() => {
        queued = Math.max(0, queued - 1);
        resolve();
      }));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active = Math.max(0, active - 1);
      queue.shift()?.();
    }
  };

  return { run };
};

export const parsePlaywrightFilesFlag = (raw: string): string[] => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).map(s => s.trim()).filter(Boolean);
    } catch (error) {
      throw new Error(`--pw-files JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (trimmed.includes('::')) return [trimmed];
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
};

const parseArgs = (): CliArgs => {
  const args = process.argv.slice(2);
  const longMode = process.env['E2E_LONG'] === '1';
  const cpu = (() => {
    try {
      return Math.max(1, availableParallelism());
    } catch {
      return 8;
    }
  })();
  const defaultShards = Math.max(2, Math.min(16, Math.floor(cpu / 2)));
  const getFlag = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const eq = args.find(a => a.startsWith(prefix));
    if (eq) return eq.slice(prefix.length);
    const i = args.findIndex(a => a === `--${name}`);
    if (i >= 0 && i + 1 < args.length) {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) return next;
    }
    return undefined;
  };
  const hasFlag = (name: string): boolean => args.includes(`--${name}`);

  const shardsRaw = Number(getFlag('shards') || String(defaultShards));
  const basePortRaw = Number(getFlag('base-port') || '20000');
  const defaultStackTimeoutMs = Math.min(420000, 180000 + Math.max(0, shardsRaw - 8) * 15000);
  const stackTimeoutRaw = Number(getFlag('stack-timeout-ms') || String(defaultStackTimeoutMs));
  const testTimeoutRaw = Number(
    getFlag('test-timeout-ms') || String(longMode ? 1_200_000 : DEFAULT_E2E_TEST_TIMEOUT_MS),
  );
  const phaseWarnRaw = Number(getFlag('phase-warn-ms') || '30000');
  const maxFailuresRaw = Number(getFlag('max-failures') || '1');
  const maxMmConcurrencyRaw = Number(getFlag('max-mm-concurrency') || String(Math.min(2, shardsRaw || defaultShards)));
  const maxResetConcurrencyRaw = Number(getFlag('max-reset-concurrency') || String(Math.min(4, shardsRaw || defaultShards)));
  const workersPerShardRaw = Number(getFlag('workers-per-shard') || '1');
  const startAtRaw = Number(getFlag('start-at') || '0');
  const videoRaw = String(getFlag('video') || 'on').toLowerCase();
  const traceRaw = String(getFlag('trace') || 'on-first-retry').toLowerCase();
  const screenshotRaw = String(getFlag('screenshot') || 'only-on-failure').toLowerCase();
  const reporterRaw = String(getFlag('reporter') || 'line').toLowerCase();
  const pwFilesRaw = getFlag('pw-files') || '';
  const pwFiles = parsePlaywrightFilesFlag(pwFilesRaw);

  const coerceVideo = (mode: string): CliArgs['videoMode'] =>
    mode === 'off' || mode === 'retain-on-failure' || mode === 'on-first-retry' ? mode : 'on';
  const coerceTrace = (mode: string): CliArgs['traceMode'] =>
    mode === 'off' || mode === 'on' || mode === 'retain-on-failure' ? mode : 'on-first-retry';
  const coerceScreenshot = (mode: string): CliArgs['screenshotMode'] =>
    mode === 'off' || mode === 'on' ? mode : 'only-on-failure';
  const coerceReporter = (mode: string): CliArgs['reporter'] => (mode === 'list' || mode === 'dot' ? mode : 'line');
  const pwGrep = getFlag('pw-grep');
  const pwProject = getFlag('pw-project');
  const qaCategoryRaw = getFlag('qa-category');
  if (qaCategoryRaw && qaCategoryRaw !== 'functional' && qaCategoryRaw !== 'resilience') {
    throw new Error(`INVALID_QA_TEST_CATEGORY:${qaCategoryRaw}`);
  }
  const prewaitHealthRaw = String(getFlag('prewait-health') || 'reset').trim().toLowerCase();

  return {
    shards: Number.isFinite(shardsRaw) && shardsRaw > 0 ? Math.floor(shardsRaw) : 2,
    basePort: Number.isFinite(basePortRaw) && basePortRaw > 0 ? Math.floor(basePortRaw) : 20000,
    stackTimeoutMs: Number.isFinite(stackTimeoutRaw) && stackTimeoutRaw > 0 ? Math.floor(stackTimeoutRaw) : 180000,
    testTimeoutMs:
      Number.isFinite(testTimeoutRaw) && testTimeoutRaw > 0
        ? Math.floor(testTimeoutRaw)
        : longMode
          ? 1_200_000
          : DEFAULT_E2E_TEST_TIMEOUT_MS,
    phaseWarnMs: Number.isFinite(phaseWarnRaw) && phaseWarnRaw > 0 ? Math.floor(phaseWarnRaw) : 30000,
    anvilBin: getFlag('anvil-bin') || 'anvil',
    maxFailures: Number.isFinite(maxFailuresRaw) && maxFailuresRaw >= 0 ? Math.floor(maxFailuresRaw) : 1,
    maxMmConcurrency:
      Number.isFinite(maxMmConcurrencyRaw) && maxMmConcurrencyRaw > 0 ? Math.floor(maxMmConcurrencyRaw) : 2,
    maxResetConcurrency:
      Number.isFinite(maxResetConcurrencyRaw) && maxResetConcurrencyRaw > 0 ? Math.floor(maxResetConcurrencyRaw) : 4,
    workersPerShard: Number.isFinite(workersPerShardRaw) && workersPerShardRaw > 0 ? Math.floor(workersPerShardRaw) : 1,
    videoMode: coerceVideo(videoRaw),
    traceMode: coerceTrace(traceRaw),
    screenshotMode: coerceScreenshot(screenshotRaw),
    reporter: coerceReporter(reporterRaw),
    qaCategory: qaCategoryRaw as QaTestCategory | undefined,
    pwGrep,
    pwProject,
    pwFiles,
    batchFiles: hasFlag('batch-files'),
    includeAllSpecs: hasFlag('all') || hasFlag('include-all') || process.env['E2E_ALL'] === '1',
    excludeMarketMaker: hasFlag('exclude-market-maker') || hasFlag('no-market-maker-heavy'),
    marketMakerOnly: hasFlag('market-maker-only') || hasFlag('only-market-maker-heavy'),
    strictBrowserHealth: hasFlag('strict-browser-health'),
    skipBuild: args.includes('--skip-build'),
    startAt: Number.isSafeInteger(startAtRaw) && startAtRaw >= 0 ? startAtRaw : 0,
    preserveArtifacts: hasFlag('preserve-artifacts'),
    prewaitHealth:
      prewaitHealthRaw === 'http' || prewaitHealthRaw === 'full' || prewaitHealthRaw === 'reset'
        ? prewaitHealthRaw
        : 'reset',
  };
};

const RUNNER_LOCK_PATH = resolve(process.cwd(), '.logs', 'e2e-parallel', '.runner-lock.json');

const readRunnerLock = (): RunnerLockPayload | null => {
  try {
    return JSON.parse(readFileSync(RUNNER_LOCK_PATH, 'utf8')) as RunnerLockPayload;
  } catch {
    return null;
  }
};

const pidIsAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const acquireRunnerLock = (logsDir: string): (() => void) => {
  mkdirSync(resolve(process.cwd(), '.logs', 'e2e-parallel'), { recursive: true });
  const current: RunnerLockPayload = {
    pid: process.pid,
    startedAt: Date.now(),
    cwd: process.cwd(),
    logsDir,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(RUNNER_LOCK_PATH, JSON.stringify(current, null, 2), { flag: 'wx' });
      const release = () => {
        const active = readRunnerLock();
        if (!active || active.pid !== process.pid) return;
        try {
          unlinkSync(RUNNER_LOCK_PATH);
        } catch (error) {
          console.warn(`[runner-lock] release failed path=${RUNNER_LOCK_PATH}`, error);
        }
      };
      process.once('exit', release);
      process.once('SIGINT', () => {
        release();
        process.exit(130);
      });
      process.once('SIGTERM', () => {
        release();
        process.exit(143);
      });
      return release;
    } catch {
      const existing = readRunnerLock();
      if (existing && pidIsAlive(existing.pid)) {
        throw new Error(`RUNNER_LOCKED pid=${existing.pid} startedAt=${existing.startedAt} path=${RUNNER_LOCK_PATH}`);
      }
      try {
        unlinkSync(RUNNER_LOCK_PATH);
      } catch (error) {
        console.warn(`[runner-lock] stale lock removal failed path=${RUNNER_LOCK_PATH}`, error);
      }
    }
  }

  throw new Error(`RUNNER_LOCK_FAILED path=${RUNNER_LOCK_PATH}`);
};

const tsTag = (): string => {
  return formatQaRunIdUtc(Date.now());
};

const startFailFastLogMonitor = (
  logPath: string,
  onFatal: (message: string) => void,
): (() => void) => {
  let stopped = false;
  const fatalScanner = createIncrementalRuntimeFatalLogScanner(logPath);
  const scan = (): void => {
    if (stopped) return;
    const hit = fatalScanner.scan();
    if (hit) {
      stopped = true;
      onFatal(
        `E2E_FATAL_RUNTIME_LOG marker=${hit.pattern} file=${logPath} line=${hit.lineNumber}\n` +
        `${hit.lineNumber}: ${hit.line}\n` +
        `--- last 80 lines (${logPath}) ---\n${tailLog(logPath, 80)}`,
      );
      return;
    }
  };
  const interval = setInterval(scan, 500);
  scan();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
};

const flushLog = async (log: ReturnType<typeof createWriteStream>, marker: string): Promise<void> => {
  await new Promise<void>(resolve => {
    log.write(marker, () => resolve());
  });
};

const assertRunnerPreflight = async (): Promise<void> => {
  assertMinDiskFree();
  const typechainIndex = resolve(process.cwd(), 'jurisdictions', 'typechain-types', 'index.ts');
  if (!existsSync(typechainIndex)) {
    throw new Error(`RUNNER_PREFLIGHT_FAILED missing ${typechainIndex}`);
  }
  await import(resolve(process.cwd(), 'runtime', 'jadapter', 'browservm.ts'));
};

const parseStepTimings = (path: string): QaSlowStep[] => {
  try {
    return parseQaTimelineSteps(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
};

const detectArtifactKind = (name: string): QaArtifactKind => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.webm')) return 'video';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image';
  if (lower.endsWith('.zip')) return 'trace';
  if (lower.endsWith('.vtt')) return 'text';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'text';
  if (lower.endsWith('.tar') || lower.endsWith('.gz')) return 'archive';
  return 'other';
};

const detectArtifactContentType = (name: string): string => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
};

const artifactKindRank = (kind: QaArtifactKind): number => {
  if (kind === 'video') return 0;
  if (kind === 'image') return 1;
  if (kind === 'trace') return 2;
  if (kind === 'text') return 3;
  if (kind === 'json') return 4;
  if (kind === 'archive') return 5;
  return 6;
};

const collectShardArtifacts = (
  logsDir: string,
  shard: number,
): QaArtifact[] => {
  const resultsDir = deriveE2EShardPaths(logsDir, shard).resultsDir;
  if (!existsSync(resultsDir)) return [];
  const artifacts: QaArtifact[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      const fileStat = statSync(absolutePath);
      const relativePath = absolutePath.slice(logsDir.length + 1);
      const kind = detectArtifactKind(entry.name);
      const contentType = detectArtifactContentType(entry.name);
      artifacts.push({
        name: entry.name,
        relativePath,
        sizeBytes: fileStat.size,
        kind,
        sensitivity: classifyQaArtifactSensitivity({ name: entry.name, relativePath, kind, contentType }),
        contentType,
      });
    }
  };

  walk(resultsDir);
  return artifacts.sort((a, b) => artifactKindRank(a.kind) - artifactKindRank(b.kind) || compareStableText(a.name, b.name));
};

const formatWebVttTime = (ms: number): string => {
  const safeMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1000);
  const millis = safeMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
};

const cleanCueText = (label: string): string =>
  String(label || '')
    .replace(/^(E2E-TIMING|MESH-TIMING):/i, '')
    .replace(/[_./:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const writeShardCueArtifacts = (logsDir: string, shard: number, steps: QaSlowStep[]): void => {
  const cues = steps
    .filter(step => Number.isFinite(Number(step.startMs)) && Number.isFinite(Number(step.endMs)))
    .map((step, index) => ({
      id: `cue-${String(index + 1).padStart(2, '0')}`,
      label: step.label,
      text: cleanCueText(step.label) || step.label,
      startMs: Math.max(0, Math.floor(Number(step.startMs))),
      endMs: Math.max(0, Math.floor(Number(step.endMs))),
      durationMs: Math.max(0, Math.floor(Number(step.ms))),
    }))
    .filter(cue => cue.endMs >= cue.startMs);
  if (cues.length === 0) return;

  const dir = join(deriveE2EShardPaths(logsDir, shard).resultsDir, 'qa-cues');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cues.json'), `${JSON.stringify({ cues }, null, 2)}\n`);
  const vtt = [
    'WEBVTT',
    '',
    ...cues.flatMap((cue) => [
      cue.id,
      `${formatWebVttTime(cue.startMs)} --> ${formatWebVttTime(cue.endMs)}`,
      cue.text,
      '',
    ]),
  ].join('\n');
  writeFileSync(join(dir, 'cues.vtt'), vtt);
};

export const readShardLastRunStatus = (logsDir: string, shard: number): 'passed' | 'failed' | 'unknown' => {
  const lastRunPath = join(deriveE2EShardPaths(logsDir, shard).resultsDir, '.last-run.json');
  if (!existsSync(lastRunPath)) return 'unknown';
  const parsed = parseJsonStrict(readFileSync(lastRunPath, 'utf8'), lastRunPath);
  const status = isRecord(parsed) ? String(parsed['status'] ?? 'missing') : 'invalid-shape';
  if (status === 'passed' || status === 'failed') return status;
  throw new Error(`E2E_LAST_RUN_STATUS_INVALID:path=${lastRunPath}:status=${status}`);
};

export const resolveE2EShardManifestStatus = (
  resultStatus: E2EShardRunStatus,
  playwrightStatus: 'passed' | 'failed' | 'unknown',
): E2EShardRunStatus => {
  if (resultStatus !== 'passed') return resultStatus;
  return playwrightStatus === 'unknown' ? resultStatus : playwrightStatus;
};

const shardBrowserEventsPath = (logsDir: string, shard: number): string =>
  deriveE2EShardPaths(logsDir, shard).browserEventsPath;

export const readShardBrowserIssues = (logsDir: string, shard: number): QaBrowserIssue[] => {
  const eventsPath = shardBrowserEventsPath(logsDir, shard);
  if (!existsSync(eventsPath)) return [];
  const events = parseJsonLinesStrict(readFileSync(eventsPath, 'utf8'), eventsPath);
  const invalidIndex = events.findIndex(event => !isRecord(event));
  if (invalidIndex >= 0) {
    throw new Error(`E2E_BROWSER_EVENT_INVALID:path=${eventsPath}:record=${invalidIndex + 1}`);
  }
  return normalizeQaBrowserIssues(events).slice(0, 200);
};

export const assertE2EBrowserHealthGate = (
  health: E2EBrowserHealthCounters | undefined,
  strict: boolean,
): void => {
  if (!strict) return;
  if (!health) throw new Error('E2E_BROWSER_HEALTH_MANIFEST_MISSING');
  const counters = [
    health.issueCount,
    health.errorCount,
    health.warningCount,
    health.networkFailureCount,
    health.httpErrorCount,
  ];
  if (counters.some(value => !Number.isInteger(value) || value < 0)) {
    throw new Error(`E2E_BROWSER_HEALTH_MANIFEST_INVALID:${JSON.stringify(health)}`);
  }
  if (counters.some(value => value > 0)) {
    throw new Error(
      `E2E_BROWSER_HEALTH_GATE_FAILED:issues=${health.issueCount} errors=${health.errorCount} ` +
      `warnings=${health.warningCount} network=${health.networkFailureCount} http=${health.httpErrorCount}`,
    );
  }
};

const readShardTitle = (logsDir: string, shard: number): string | null => {
  const resultsDir = deriveE2EShardPaths(logsDir, shard).resultsDir;
  if (!existsSync(resultsDir)) return null;
  const entry = readdirSync(resultsDir, { withFileTypes: true }).find(
    item => item.isDirectory() && !item.name.startsWith('.'),
  );
  return entry?.name ?? null;
};

const writeRunManifest = (
  logsDir: string,
  args: CliArgs,
  results: RunResult[],
  tasks: readonly RunTask[],
  totalMs: number,
  createdAt: number,
  codeFingerprint: QaCodeFingerprint,
  primaryFailure: E2EPrimaryFailureIdentity | null,
): QaRunManifest => {
  const taskByShard = new Map(tasks.map(task => [task.shard, task] as const));
  const shards = results
    .slice()
    .sort((a, b) => a.shard - b.shard)
    .map(result => {
      const task = taskByShard.get(result.shard);
      if (!task) throw new Error(`QA_RUN_TASK_MISSING:${result.shard}`);
      const timelineSteps = parseStepTimings(result.logPath).slice(0, 80);
      const slowSteps = timelineSteps.slice().sort((a, b) => b.ms - a.ms).slice(0, 12);
      writeShardCueArtifacts(logsDir, result.shard, timelineSteps);
      const artifacts = collectShardArtifacts(logsDir, result.shard);
      const browserIssues = readShardBrowserIssues(logsDir, result.shard);
      const lastRunStatus = readShardLastRunStatus(logsDir, result.shard);
      const status = resolveE2EShardManifestStatus(result.status, lastRunStatus);
      const logTail = redactQaSecretText(tailLog(result.logPath));
      const error = result.error ? redactQaSecretText(result.error) : null;
      return {
        shard: result.shard,
        status,
        resultClass: result.resultClass,
        durationMs: result.durationMs,
        handle: deriveQaTestHandle(result.target, result.title),
        description: deriveQaTestDescription(result.target, result.title),
        scenario: result.scenario,
        target: result.target,
        title: result.title || readShardTitle(logsDir, result.shard),
        tags: [...task.tags],
        testCategory: task.testCategory,
        requireMarketMaker: result.requireMarketMaker,
        requireCustody: result.requireCustody,
        error,
        diagnostics: (result.diagnostics ?? []).map(message => redactQaSecretText(message)),
        failureCapsule: result.failureCapsule ?? null,
        failureCapsuleRelativePath: result.failureCapsulePath
          ? relative(logsDir, result.failureCapsulePath)
          : null,
        failureClass: status === 'cancelled'
          ? null
          : classifyQaShardFailure({ status, error, logTail, browserIssues }),
        phaseMs: result.phaseMs,
        perf: result.perf,
        browserIssues,
        browserHealth: summarizeQaBrowserIssues(browserIssues, createdAt),
        timelineSteps,
        logRelativePath: result.logPath.slice(logsDir.length + 1),
        logTail,
        slowSteps,
        artifacts,
        hasVideo: artifacts.some(artifact => artifact.kind === 'video'),
        hasTrace: artifacts.some(artifact => artifact.kind === 'trace'),
      };
    });
  const passedShards = shards.filter(shard => shard.status === 'passed').length;
  const failedShards = shards.filter(shard => shard.status === 'failed').length;
  const cancelledShards = shards.filter(shard => shard.status === 'cancelled').length;
  const status: QaRunManifest['status'] = failedShards > 0 ? 'failed' : 'passed';
  const testCategories: QaTestCategory[] = [];
  for (const shard of shards) {
    if (!shard.testCategory) throw new Error(`QA_RUN_TEST_CATEGORY_REQUIRED:shard=${shard.shard}`);
    testCategories.push(shard.testCategory);
  }
  let manifest: QaRunManifest = applyQaRunSeverity({
    manifestVersion: 4,
    runId: logsDir.split('/').at(-1) || logsDir,
    createdAt,
    completedAt: Date.now(),
    status,
    testCategory: qaRunTestCategory(testCategories),
    totalMs,
    code: codeFingerprint,
    perf: summarizePerfSamples(shards.flatMap(shard => shard.perf?.samples ?? [])),
    browserHealth: summarizeQaRunBrowserHealth({ shards }),
    totalShards: shards.length,
    passedShards,
    failedShards,
    cancelledShards,
    primaryFailureShard: primaryFailure?.shard ?? null,
    primaryFailureCapsule: primaryFailure?.failureCapsule ?? null,
    failureClasses: summarizeQaFailureClasses(shards),
    args: {
      shards: args.shards,
      basePort: args.basePort,
      workersPerShard: args.workersPerShard,
      maxFailures: args.maxFailures,
      phaseWarnMs: args.phaseWarnMs,
      videoMode: args.videoMode,
      traceMode: args.traceMode,
      screenshotMode: args.screenshotMode,
      pwFiles: args.pwFiles,
      pwGrep: args.pwGrep ?? null,
      pwProject: args.pwProject ?? null,
      qaCategory: args.qaCategory ?? null,
      strictBrowserHealth: args.strictBrowserHealth,
    },
    shards,
  });
  manifest.benchmark = compareQaRunWithHistory(manifest);
  manifest = applyQaRunSeverity(manifest);
  assertQaReleaseRunSeverity(manifest);
  writeFileSync(join(logsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  recordQaRunHistory(manifest, logsDir);
  return manifest;
};

type QaRunBenchmark = NonNullable<QaRunManifest['benchmark']>;

const formatBenchmarkMetric = (metric: QaRunBenchmark['metrics'][number]): string =>
  `${metric.label} ${metric.deltaPct > 0 ? '+' : ''}${metric.deltaPct}% (${metric.baseline}->${metric.current}${metric.unit})`;

const printBenchmarkComparison = (benchmark: QaRunManifest['benchmark']): void => {
  if (!benchmark) return;
  console.log('-'.repeat(72));
  console.log(`Benchmark: ${benchmark.status.toUpperCase()} suite=${benchmark.suiteLabel}`);
  if (benchmark.comparedRunId) {
    console.log(
      `Compared : ${benchmark.comparedRunId} ` +
      `head=${benchmark.comparedGitHead?.slice(0, 12) ?? 'n/a'} ` +
      `code=${benchmark.comparedCodeHash?.slice(0, 16) ?? 'n/a'}`,
    );
  }
  console.log(`Reason   : ${benchmark.reason}`);
  const important = benchmark.metrics
    .filter(metric => metric.verdict !== 'ok')
    .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
    .slice(0, 6);
  if (important.length > 0) {
    console.log(`Deltas   : ${important.map(formatBenchmarkMetric).join(' | ')}`);
  }
  if (benchmark.likelyCauses.length > 0) {
    console.log(`Causes   : ${benchmark.likelyCauses.join(' | ')}`);
  }
};

const publishQaRunIfConfigured = (logsDir: string): void => {
  const remoteBase = String(process.env['XLN_QA_PUBLISH_REMOTE'] || '').trim();
  if (!remoteBase) return;

  const runId = logsDir.split('/').at(-1) || 'run';
  const remoteTarget = `${remoteBase.replace(/\/+$/, '')}/${runId}/`;
  const startedAt = Date.now();
  const remoteMatch = remoteBase.match(/^([^:]+):(.+)$/);
  if (remoteMatch) {
    const remoteHost = remoteMatch[1];
    const remotePath = remoteMatch[2];
    if (!remoteHost || !remotePath) return;
    const mkdirResult = spawnSync('ssh', [remoteHost, 'mkdir', '-p', remotePath], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (mkdirResult.status !== 0) {
      const stderr = String(mkdirResult.stderr || '').trim();
      const stdout = String(mkdirResult.stdout || '').trim();
      console.warn(`[qa] publish mkdir failed target=${remoteBase} status=${mkdirResult.status ?? 'null'}`);
      if (stdout) console.warn(`[qa] publish mkdir stdout: ${stdout}`);
      if (stderr) console.warn(`[qa] publish mkdir stderr: ${stderr}`);
      return;
    }
  } else {
    mkdirSync(remoteBase, { recursive: true });
  }
  const result = spawnSync('rsync', ['-az', `${logsDir}/`, remoteTarget], {
    stdio: 'pipe',
    encoding: 'utf8',
  });

  if (result.status === 0) {
    console.log(`[qa] publish=${Date.now() - startedAt}ms target=${remoteTarget}`);
    return;
  }

  const stderr = String(result.stderr || '').trim();
  const stdout = String(result.stdout || '').trim();
  console.warn(`[qa] publish failed target=${remoteTarget} status=${result.status ?? 'null'}`);
  if (stdout) console.warn(`[qa] publish stdout: ${stdout}`);
  if (stderr) console.warn(`[qa] publish stderr: ${stderr}`);
};

type PlaywrightTarget = {
  target: string;
  requireMarketMaker: boolean;
  requireCustody: boolean;
  scenario: QaScenarioMetadata | null;
  title?: string;
  grep?: string;
  tags?: string[];
  testCategory?: QaTestCategory;
};

export const batchPlaywrightTargetsByFile = (
  targets: readonly PlaywrightTarget[],
): PlaywrightTarget[] => {
  const groups = new Map<string, PlaywrightTarget>();
  for (const target of targets) {
    if (!target.testCategory) {
      throw new Error(`QA_TEST_CATEGORY_MISSING:${target.target}:${target.title ?? ''}`);
    }
    const key = [
      target.target,
      target.requireMarketMaker ? 'mm' : 'no-mm',
      target.requireCustody ? 'custody' : 'no-custody',
      target.testCategory,
    ].join('|');
    if (groups.has(key)) continue;
    groups.set(key, {
      target: target.target,
      requireMarketMaker: target.requireMarketMaker,
      requireCustody: target.requireCustody,
      scenario: target.scenario,
      title: `${target.target} [${target.testCategory} batch]`,
      tags: [QA_TEST_CATEGORY_TAGS[target.testCategory]],
      testCategory: target.testCategory,
    });
  }
  return [...groups.values()];
};

const extractTopLevelTestTitle = (line: string): string | undefined => {
  const match = line.match(/^\s*test(?:\.(?:only|fail))?\(\s*(['"`])((?:\\.|.)*?)\1/);
  return match?.[2]?.replace(/\\(['"`])/g, '$1').trim() || undefined;
};

const buildGrepMatcher = (grep: string): ((entry: PlaywrightTarget) => boolean) => {
  try {
    const pattern = new RegExp(grep);
    return entry => pattern.test(entry.title || entry.target);
  } catch {
    const needle = grep.toLowerCase();
    return entry => `${entry.title || ''} ${entry.target}`.toLowerCase().includes(needle);
  }
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const collectSpecsFromSuite = (suite: unknown, out: Array<{ title: string; file?: string; line?: number }>): void => {
  const suiteRecord = recordOrEmpty(suite);
  for (const spec of recordArrayOf(suiteRecord, 'specs')) {
    const title = String(spec['title'] || '').trim();
    if (!title) continue;
    const entry: { title: string; file?: string; line?: number } = { title };
    if (typeof spec['file'] === 'string') entry.file = spec['file'];
    if (Number.isFinite(Number(spec['line']))) entry.line = Number(spec['line']);
    out.push(entry);
  }
  for (const child of arrayOf(suiteRecord, 'suites')) collectSpecsFromSuite(child, out);
};

const listDynamicPlaywrightTargets = (
  file: string,
  requiresMarketMaker: (file: string, title?: string) => boolean,
  requiresCustody: (file: string, title?: string) => boolean,
): PlaywrightTarget[] => {
  const env = {
    ...process.env,
    PW_SKIP_WEBSERVER: '1',
    PW_BASE_URL: process.env['PW_BASE_URL'] || 'https://localhost:1',
    E2E_BASE_URL: process.env['E2E_BASE_URL'] || 'https://localhost:1',
    E2E_API_BASE_URL: process.env['E2E_API_BASE_URL'] || 'http://127.0.0.1:1',
    E2E_ANVIL_RPC: process.env['E2E_ANVIL_RPC'] || 'http://127.0.0.1:1',
    E2E_RESET_BASE_URL: process.env['E2E_RESET_BASE_URL'] || 'http://127.0.0.1:1',
  };
  const res = spawnSync(
    'bunx',
    ['playwright', 'test', '--config', 'playwright.config.ts', '--list', '--reporter=json', file],
    {
      cwd: process.cwd(),
      env,
      stdio: 'pipe',
      encoding: 'utf8',
    },
  );
  const stdout = String(res.stdout || '').trim();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const stderr = String(res.stderr || '').trim();
    throw new Error(`Failed to list tests for ${file}: ${stderr || stdout || `exit=${String(res.status)}`}`);
  }
  const specs: Array<{ title: string; file?: string; line?: number }> = [];
  for (const suite of arrayOf(recordOrEmpty(parsed), 'suites')) collectSpecsFromSuite(suite, specs);
  if (specs.length === 0) {
    throw new Error(`No isolated tests discovered for ${file}`);
  }
  return specs.map(spec => ({
    target: file,
    requireMarketMaker: requiresMarketMaker(file, spec.title),
    requireCustody: requiresCustody(file, spec.title),
    scenario: null,
    title: spec.title,
    grep: escapeRegExp(spec.title),
  }));
};

const expandPlaywrightTargets = (pwFiles: string[]): PlaywrightTarget[] => {
  const out: PlaywrightTarget[] = [];
  const sourcePathForTarget = (file: string): string =>
    file.match(/^(.+\.spec\.ts)(?:::.*|:\d+(?::\d+)?)?$/)?.[1] || file;
  const sourceNeedsMarketMakerByDefault = (file: string): boolean => {
    const sourcePath = sourcePathForTarget(file);
    if (/e2e-swap\.spec\.ts$/.test(sourcePath)) return true;
    return false;
  };
  const unsplittableSpecs = new Set<string>();
  const updateBraceDepth = (line: string, depth: number): number => {
    let next = depth;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let escaped = false;

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i] || '';
      const nxt = line[i + 1] || '';

      if (!inSingle && !inDouble && !inTemplate && ch === '/' && nxt === '/') break;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (!inDouble && !inTemplate && ch === "'") {
        inSingle = !inSingle;
        continue;
      }
      if (!inSingle && !inTemplate && ch === '"') {
        inDouble = !inDouble;
        continue;
      }
      if (!inSingle && !inDouble && ch === '`') {
        inTemplate = !inTemplate;
        continue;
      }
      if (inSingle || inDouble || inTemplate) continue;
      if (ch === '{') next += 1;
      else if (ch === '}') next = Math.max(0, next - 1);
    }

    return next;
  };
  const collectTestBlock = (lines: string[], startIndex: number, initialDepth: number): { text: string; endIndex: number; depthAfter: number } => {
    const block: string[] = [];
    let depth = initialDepth;
    let endIndex = startIndex;
    for (let i = startIndex; i < lines.length; i += 1) {
      const line = lines[i] || '';
      block.push(line);
      depth = updateBraceDepth(line, depth);
      endIndex = i;
      if (i > startIndex && depth <= initialDepth) break;
    }
    return { text: block.join('\n'), endIndex, depthAfter: depth };
  };
  const findStaticTestBlock = (sourcePath: string, title: string): string | null => {
    const absolute = resolve(process.cwd(), sourcePath);
    const text = readFileSync(absolute, 'utf8');
    const lines = text.split('\n');
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] || '';
      const matchesTopLevelTest = braceDepth <= 1 && /^\s*test(?:\.(?:only|fail))?\(/.test(line);
      if (matchesTopLevelTest && extractTopLevelTestTitle(line) === title) {
        return collectTestBlock(lines, i, braceDepth).text;
      }
      braceDepth = updateBraceDepth(line, braceDepth);
    }
    return null;
  };
  const requiresMarketMaker = (file: string, title?: string, testBlock?: string): boolean => {
    const sourcePath = sourcePathForTarget(file);
    if (sourceNeedsMarketMakerByDefault(sourcePath)) return true;
    const block = testBlock ?? (title ? findStaticTestBlock(sourcePath, title) : null);
    if (block !== null) return /requireMarketMaker\s*:\s*true/.test(block);
    return false;
  };
  const requiresCustody = (file: string, title?: string, testBlock?: string): boolean => {
    const block = testBlock ?? (title ? findStaticTestBlock(sourcePathForTarget(file), title) : null);
    return block !== null && /requireCustody\s*:\s*true/.test(block);
  };

  for (const file of pwFiles) {
    const explicitTitleTarget = file.match(/^(.+\.spec\.ts)::(.+)$/);
    if (explicitTitleTarget) {
      const sourceFile = explicitTitleTarget[1]!;
      const title = explicitTitleTarget[2]!;
      out.push({
        target: sourceFile,
        requireMarketMaker: requiresMarketMaker(sourceFile, title),
        requireCustody: requiresCustody(sourceFile, title),
        scenario: null,
        title,
        grep: escapeRegExp(title),
      });
      continue;
    }

    const explicitLineTarget = file.match(/^(.+\.spec\.ts):\d+(?::\d+)?$/);
    if (explicitLineTarget) {
      const sourceFile = explicitLineTarget[1]!;
      throw new Error(`Line-pinned Playwright target is not supported: ${file}. Use ${sourceFile}::exact test title.`);
    }

    if (unsplittableSpecs.has(file)) {
      out.push({
        target: file,
        requireMarketMaker: requiresMarketMaker(file),
        requireCustody: requiresCustody(file),
        scenario: null,
        title: file,
      });
      continue;
    }

    const absolute = resolve(process.cwd(), file);
    const text = readFileSync(absolute, 'utf8');
    const lines = text.split('\n');
    let added = 0;
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      const matchesTopLevelTest = braceDepth <= 1 && /^\s*test(?:\.(?:only|fail))?\(/.test(line);
      if (matchesTopLevelTest) {
        const title = extractTopLevelTestTitle(line);
        if (!title) continue;
        const block = collectTestBlock(lines, i, braceDepth);
        out.push({
          target: file,
          requireMarketMaker: requiresMarketMaker(file, title, block.text),
          requireCustody: requiresCustody(file, title, block.text),
          scenario: null,
          title,
          grep: escapeRegExp(title),
        });
        added += 1;
        braceDepth = block.depthAfter;
        i = block.endIndex;
        continue;
      }
      braceDepth = updateBraceDepth(line, braceDepth);
    }
    if (added === 0) {
      out.push(...listDynamicPlaywrightTargets(file, requiresMarketMaker, requiresCustody));
    }
  }
  return out;
};

const listPlaywrightSpecFiles = (includeAllSpecs: boolean): string[] => {
  const excludedDefaultSpecs = new Set<string>([
    // Legacy shared-page AHB flow. Useful assertions were ported into
    // tests/e2e-ahb-isolated.spec.ts; keep this out of the canonical isolated bar.
    'tests/e2e-ahb-payment.spec.ts',
    // Keep the default bar focused on fast isolated product checks.
    'tests/e2e-multiroute-load.spec.ts',
  ]);
  const res = spawnSync('rg', ['--files', 'tests'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  const text = String(res.stdout || '');
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.endsWith('.spec.ts'))
    .filter(line => includeAllSpecs || !excludedDefaultSpecs.has(line))
    .sort();
};

const playwrightSourcePath = (target: string): string =>
  target.match(/^(.+\.spec\.ts)(?:::.*|:\d+(?::\d+)?)?$/)?.[1] || target;

const attachPlaywrightMetadata = (
  targets: readonly PlaywrightTarget[],
  sourceTargets: readonly string[],
  args: Pick<CliArgs, 'pwProject'>,
): PlaywrightTarget[] => {
  const sourceFiles = Array.from(new Set(sourceTargets.map(playwrightSourcePath))).sort();
  const tests = listPlaywrightTestMetadata(sourceFiles, {
    ...(args.pwProject ? { project: args.pwProject } : {}),
    ...(args.pwProject === 'brainvault' ? { profile: 'brainvault' } : {}),
  });
  const violations = tests.flatMap((test) => {
    const violation = inspectQaTestCategory(test);
    return violation ? [violation] : [];
  });
  if (violations.length > 0) {
    throw new Error(`QA_E2E_CATEGORY_GATE_FAILED:${violations.length}/${tests.length}\n${formatQaTestCategoryViolations(violations)}`);
  }
  return targets.map((target) => {
    const source = playwrightSourcePath(target.target);
    const sameFile = tests.filter((test) => test.file === source);
    const exact = sameFile.filter((test) => test.title === target.title);
    const compatible = exact.length > 0
      ? exact
      : sameFile.filter((test) => test.title.includes(target.title ?? '') || (target.title ?? '').includes(test.title));
    if (compatible.length !== 1) {
      throw new Error(`PLAYWRIGHT_TEST_METADATA_MATCH_FAILED:${source}:${target.title ?? ''}:matches=${compatible.length}`);
    }
    const metadata = compatible[0]!;
    const testCategory = qaTestCategoryFromTags(metadata.tags);
    if (!testCategory) throw new Error(`QA_TEST_CATEGORY_MISSING:${source}:${metadata.line ?? 0}`);
    return {
      ...target,
      title: metadata.title,
      grep: escapeRegExp(metadata.title),
      tags: metadata.tags,
      testCategory,
    };
  });
};

const stopShardRuntimePorts = async (
  apiPort: number,
  log: ReturnType<typeof createWriteStream>,
): Promise<void> => {
  await freeE2EPorts([apiPort, apiPort + 10, apiPort + 11, apiPort + 12, apiPort + 13], log);
};

export const parseE2EListeningPortOutput = (output: string): Map<number, number[]> => {
  const pidsByPort = new Map<number, Set<number>>();
  let currentPid: number | null = null;
  for (const field of output.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    if (field.startsWith('p')) {
      const pid = Number(field.slice(1));
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`E2E_LSOF_OUTPUT_INVALID:${field.slice(0, 200)}`);
      }
      currentPid = pid;
      continue;
    }
    if (!field.startsWith('n')) continue;
    const portMatch = field.match(/:(\d+)$/);
    if (currentPid === null || !portMatch) {
      throw new Error(`E2E_LSOF_OUTPUT_INVALID:${field.slice(0, 200)}`);
    }
    const port = Number(portMatch[1]);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`E2E_LSOF_OUTPUT_INVALID:${field.slice(0, 200)}`);
    }
    const pids = pidsByPort.get(port) ?? new Set<number>();
    pids.add(currentPid);
    pidsByPort.set(port, pids);
  }
  return new Map(Array.from(pidsByPort.entries())
    .sort(([left], [right]) => left - right)
    .map(([port, pids]) => [port, Array.from(pids).sort((left, right) => left - right)]));
};

export const readE2EListeningPortPids = (ports: readonly number[]): Map<number, number[]> => {
  const normalizedPorts = Array.from(new Set(ports))
    .filter(port => Number.isSafeInteger(port) && port > 0 && port <= 65_535)
    .sort((left, right) => left - right);
  if (normalizedPorts.length === 0) return new Map();
  const res = spawnSync('lsof', [
    '-nP',
    '-a',
    '-sTCP:LISTEN',
    '-FnP',
    ...normalizedPorts.map(port => `-iTCP:${port}`),
  ], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 2_000,
    killSignal: 'SIGKILL',
  });
  const output = String(res.stdout || '').trim();
  if (!output && res.status === 1 && !res.error) return new Map();
  if (res.error || res.status !== 0) {
    throw new Error(
      `E2E_PORT_SCAN_FAILED:ports=${normalizedPorts.join(',')}:status=${String(res.status)}:` +
      `${res.error?.message || 'unknown'}`,
    );
  }
  const requested = new Set(normalizedPorts);
  return new Map(Array.from(parseE2EListeningPortOutput(output).entries())
    .filter(([port]) => requested.has(port)));
};

export const isIsolatedE2EProcessCommand = (command: string): boolean => {
  const normalized = command.replaceAll('\\', '/');
  return normalized.includes('/.logs/e2e-parallel/') || normalized.includes('--mode xln-e2e-');
};

const signalOwnedE2EPid = (pid: number, signal: NodeJS.Signals, port: number): void => {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new Error(`E2E_PORT_SIGNAL_FAILED:port=${port}:pid=${pid}:signal=${signal}`, { cause: error });
  }
};

const assertE2EPortOwners = (pidsByPort: ReadonlyMap<number, readonly number[]>): Map<number, number[]> => {
  const commandsByPid = new Map(readProcessTable().map(({ pid, command }) => [pid, command]));
  const active = new Map<number, number[]>();
  for (const [port, pids] of pidsByPort) {
    const externalPids = pids.filter(pid => pid !== process.pid);
    if (externalPids.length > 0) active.set(port, externalPids);
  }
  const foreign = Array.from(active.entries()).flatMap(([port, pids]) =>
    pids.filter(pid => !isIsolatedE2EProcessCommand(commandsByPid.get(pid) || ''))
      .map(pid => `${port}:${pid}`));
  if (foreign.length > 0) {
    throw new Error(
      `E2E_PORT_OWNERSHIP_CONFLICT:portPids=${foreign.join(',')}:` +
      'refusing to kill a process not owned by an isolated E2E run',
    );
  }
  return active;
};

const signalE2EPortOwners = (
  pidsByPort: ReadonlyMap<number, readonly number[]>,
  signal: NodeJS.Signals,
  log?: ReturnType<typeof createWriteStream>,
): void => {
  const firstPortByPid = new Map<number, number>();
  for (const [port, pids] of pidsByPort) {
    if (pids.length > 0) log?.write(`[preflight] port ${port} busy by pids=${pids.join(',')} -> ${signal}\n`);
    for (const pid of pids) if (!firstPortByPid.has(pid)) firstPortByPid.set(pid, port);
  }
  for (const [pid, port] of firstPortByPid) signalOwnedE2EPid(pid, signal, port);
};

export const freeE2EPorts = async (
  ports: readonly number[],
  log?: ReturnType<typeof createWriteStream>,
): Promise<void> => {
  const normalizedPorts = Array.from(new Set(ports)).sort((left, right) => left - right);
  const first = assertE2EPortOwners(readE2EListeningPortPids(normalizedPorts));
  if (first.size === 0) return;
  signalE2EPortOwners(first, 'SIGTERM', log);
  await delay(300);

  const second = assertE2EPortOwners(readE2EListeningPortPids(normalizedPorts));
  if (second.size > 0) {
    signalE2EPortOwners(second, 'SIGKILL', log);
    await delay(150);
  }

  const remain = assertE2EPortOwners(readE2EListeningPortPids(normalizedPorts));
  if (remain.size > 0) {
    const details = Array.from(remain.entries()).map(([port, pids]) => `${port}:${pids.join(',')}`);
    throw new Error(`E2E_PORTS_STILL_IN_USE_AFTER_CLEANUP:${details.join(';')}`);
  }
};

type ProcessTableEntry = { pid: number; command: string };

const readProcessTable = (): ProcessTableEntry[] => {
  const res = spawnSync('ps', ['-axo', 'pid=,command='], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  return String(res.stdout || '')
    .split(/\r?\n/)
    .map((line): ProcessTableEntry | null => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) return null;
      const pid = Number.parseInt(match[1]!, 10);
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
      return { pid, command: match[2]!.trim() };
    })
    .filter((row): row is ProcessTableEntry => row !== null);
};

const killPids = async (pids: number[], label: string): Promise<void> => {
  const unique = Array.from(new Set(pids)).filter(pid => pid > 0 && pid !== process.pid);
  if (unique.length === 0) return;
  console.warn(`[preflight] killing stale ${label}: ${unique.join(',')}`);
  for (const pid of unique) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      console.warn(`[preflight] SIGTERM failed pid=${pid}`, error);
    }
  }
  await delay(1_000);
  for (const pid of unique) {
    if (!pidIsAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      console.warn(`[preflight] SIGKILL failed pid=${pid}`, error);
    }
  }
  await delay(250);
};

const reapStaleIsolatedE2EProcesses = async (currentLogsDir: string): Promise<void> => {
  const marker = `${resolve(process.cwd(), '.logs', 'e2e-parallel')}/`;
  const currentMarker = `${currentLogsDir}/`;
  const stalePids = readProcessTable()
    .filter(
      ({ command }) =>
        (command.includes(marker) || command.includes('--mode xln-e2e-')) &&
        !command.includes(currentMarker),
    )
    .filter(
      ({ command }) =>
        command.includes('runtime/orchestrator/orchestrator.ts') ||
        command.includes('runtime/orchestrator/hub-node.ts') ||
        command.includes('runtime/orchestrator/mm-node.ts') ||
        command.includes(' --state ') ||
        command.includes('--mode xln-e2e-'),
    )
    .map(({ pid }) => pid);
  await killPids(stalePids, 'isolated e2e process(es)');
};

const fetchWithTimeout = async (url: string, init: RequestInit = {}, timeoutMs = 2_000): Promise<Response> => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...init, signal });
};

const assertE2EShardNotAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw new Error('E2E_ABORTED_AFTER_FIRST_FAILURE', { cause: signal.reason });
};

const e2eRetryDelay = async (ms: number, signal?: AbortSignal): Promise<void> => {
  assertE2EShardNotAborted(signal);
  try {
    if (signal) await delay(ms, undefined, { signal });
    else await delay(ms);
  } catch (error) {
    assertE2EShardNotAborted(signal);
    throw error;
  }
};

const formatErrorForLog = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const code = (error as Error & { code?: unknown }).code;
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : cause === undefined
      ? ''
      : String(cause);
  return [
    `${error.name}: ${error.message}`,
    code === undefined ? '' : `code=${String(code)}`,
    causeText ? `cause=${causeText}` : '',
  ].filter(Boolean).join(' ');
};

const recordE2EShardSecondaryFailure = (
  primaryFailure: string,
  label: string,
  cause: unknown,
): { error: string; secondary: string } => {
  const secondary = `E2E_SHARD_SECONDARY_FAILURE:${label}:${formatErrorForLog(cause)}`;
  return {
    error: primaryFailure ? `${primaryFailure}\n${secondary}` : secondary,
    secondary,
  };
};

type E2EShardCleanupResult = Readonly<{
  status: E2EShardRunStatus;
  resultClass: E2EShardRunClass;
  error?: string;
  diagnostics?: string[];
}>;

type E2EShardCleanupResolution = Readonly<{
  result: E2EShardCleanupResult | null;
  secondaryFailures: string[];
  unhandledError: AggregateError | null;
}>;

/**
 * Cleanup runs from `finally`, after JavaScript has already evaluated a shard's
 * return value. Throwing there would replace the product failure, its class and
 * its Playwright capsule. Reconcile cleanup as secondary evidence whenever a
 * completed result exists; only cleanup without any result is an unhandled
 * runner failure.
 */
export const reconcileE2EShardCleanupFailures = (
  result: E2EShardCleanupResult | null,
  cleanupFailures: readonly Error[],
  shard: number,
): E2EShardCleanupResolution => {
  if (cleanupFailures.length === 0) {
    return { result, secondaryFailures: [], unhandledError: null };
  }
  const aggregate = new AggregateError(
    cleanupFailures,
    `E2E_SHARD_CLEANUP_FAILED:shard=${String(shard)}`,
  );
  if (!result) {
    return { result: null, secondaryFailures: [], unhandledError: aggregate };
  }
  const secondaryFailures = cleanupFailures.map(cause =>
    recordE2EShardSecondaryFailure('', 'cleanup', cause).secondary,
  );
  const reconciled: E2EShardCleanupResult = {
    ...result,
    ...(result.status === 'passed'
      ? { status: 'failed' as const, resultClass: 'runner' as const }
      : {}),
    error: [result.error, ...secondaryFailures].filter(Boolean).join('\n'),
    diagnostics: [...(result.diagnostics ?? []), ...secondaryFailures],
  };
  return { result: reconciled, secondaryFailures, unhandledError: null };
};

export const runE2EShardFailureDiagnostic = async (
  primaryFailure: string,
  label: string,
  diagnostic: () => Promise<void>,
  reportSecondary: (secondary: string) => void,
): Promise<string> => {
  try {
    await diagnostic();
    return primaryFailure;
  } catch (cause) {
    const recorded = recordE2EShardSecondaryFailure(primaryFailure, label, cause);
    reportSecondary(recorded.secondary);
    return recorded.error;
  }
};

type FatalMonitorChild = Pick<ManagedChildProcess, 'exitCode' | 'pid' | 'kill'>;

export const signalE2EFatalMonitorChild = (
  primaryFailure: string,
  label: string,
  child: FatalMonitorChild | null,
  reportSecondary: (secondary: string) => void,
): string => {
  if (!child || child.exitCode !== null) return primaryFailure;
  try {
    if (child.kill('SIGTERM')) return primaryFailure;
    throw new Error('CHILD_SIGTERM_RETURNED_FALSE');
  } catch (cause) {
    const recorded = recordE2EShardSecondaryFailure(
      primaryFailure,
      `fatal-monitor-signal:${label}:pid=${String(child.pid ?? 'unknown')}`,
      cause,
    );
    reportSecondary(recorded.secondary);
    return recorded.error;
  }
};

const waitForRpcReady = async (
  rpcUrl: string,
  timeoutMs: number,
  expectedChainId: number,
  signal?: AbortSignal,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    assertE2EShardNotAborted(signal);
    try {
      const res = await fetchWithTimeout(
        rpcUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          ...(signal ? { signal } : {}),
        },
        2_000,
      );
      if (res.ok) {
        const body = recordOrEmpty(await res.json());
        const chainId = Number.parseInt(String(body['result'] || '0x0'), 16);
        if (chainId === expectedChainId) return;
        lastError = `unexpected_chainId=${String(body['result'] || 'missing')}`;
      }
    } catch (error) {
      assertE2EShardNotAborted(signal);
      lastError = formatErrorForLog(error);
      // retry
    }
    await e2eRetryDelay(200, signal);
  }
  throw new Error(`RPC_NOT_READY rpc=${rpcUrl} expectedChainId=${expectedChainId} timeoutMs=${timeoutMs} last=${lastError || 'none'}`);
};

const waitForHttpReady = async (url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    assertE2EShardNotAborted(signal);
    try {
      const res = await fetchWithTimeout(url, signal ? { signal } : {}, 2_000);
      if (res.status < 500) return;
      lastError = `status=${res.status}`;
    } catch (error) {
      assertE2EShardNotAborted(signal);
      lastError = formatErrorForLog(error);
      // retry
    }
    await e2eRetryDelay(250, signal);
  }
  throw new Error(`HTTP_ENDPOINT_NOT_READY url=${url} timeoutMs=${timeoutMs} last=${lastError || 'none'}`);
};

export const waitForE2EServerHealthy = async (
  apiUrl: string,
  timeoutMs: number,
  requireMarketMaker = false,
  requireCustody = false,
  signal?: AbortSignal,
): Promise<HealthPayload> => {
  const deadline = Date.now() + timeoutMs;
  let lastHealth: HealthPayload | null = null;
  let lastError = '';
  while (Date.now() < deadline) {
    assertE2EShardNotAborted(signal);
    try {
      const res = await fetchWithTimeout(`${apiUrl}/api/health`, signal ? { signal } : {}, 2_000);
      if (res.ok) {
        const body = recordOrEmpty(await res.json());
        lastHealth = body;
        const reset = recordOrEmpty(body['reset']);
        const hubMesh = recordOrEmpty(body['hubMesh']);
        const marketMaker = recordOrEmpty(body['marketMaker']);
        const custody = recordOrEmpty(body['custody']);
        const bootstrapReserves = recordOrEmpty(body['bootstrapReserves']);
        const resetDone = reset['inProgress'] !== true;
        const meshReady = hubMesh['ok'] === true;
        const mmEnabled = marketMaker['enabled'] === true;
        const mmReady = requireMarketMaker
          ? mmEnabled && marketMaker['ok'] === true
          : (mmEnabled ? marketMaker['ok'] === true : true);
        const reservesReady = bootstrapReserves['ok'] === true;
        const custodyReady = requireCustody
          ? custody['enabled'] === true && custody['ok'] === true
          : true;
        const hasTs = typeof body['timestamp'] === 'number';
        if (hasTs && resetDone && meshReady && mmReady && reservesReady && custodyReady) return body;
      } else {
        lastError = `status=${res.status}`;
      }
    } catch (error) {
      assertE2EShardNotAborted(signal);
      lastError = formatErrorForLog(error);
      // retry
    }
    await e2eRetryDelay(250, signal);
  }
  const marketMakerPhase =
    typeof recordOrEmpty(lastHealth?.['marketMaker'])['startupPhase'] === 'string'
      ? recordOrEmpty(lastHealth?.['marketMaker'])['startupPhase']
      : null;
  const snapshot = lastHealth
    ? JSON.stringify(
        {
          reset: lastHealth['reset'] || null,
          hubMesh: lastHealth['hubMesh'] || null,
          marketMaker: lastHealth['marketMaker'] || null,
          custody: lastHealth['custody'] || null,
          bootstrapReserves: lastHealth['bootstrapReserves'] || null,
          hubs: recordArrayOf(lastHealth, 'hubs')
            .map((h) => ({
                entityId: h['entityId'],
                name: h['name'],
                online: h['online'],
              }))
        },
        null,
        2,
      )
    : 'no-health-payload';
  throw new Error(
    `SERVER_HEALTH_TIMEOUT phase=${String(marketMakerPhase)} api=${apiUrl} timeoutMs=${timeoutMs} last=${lastError || 'none'}\n${snapshot}`,
  );
};

const hardResetShardBaseline = async (
  apiUrl: string,
  timeoutMs: number,
  requireMarketMaker: boolean,
  requireCustody: boolean,
  signal?: AbortSignal,
): Promise<HealthPayload> => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiUrl}/api/reset`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xln-reset-confirm': RESET_CONFIRMATION,
      },
      body: JSON.stringify({
        confirm: RESET_CONFIRMATION,
        requireMarketMaker,
        enableMarketMaker: requireMarketMaker,
      }),
      signal: signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal,
    });
    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch (error) {
        console.warn(`[shard-reset] response body read failed status=${response.status}`, error);
      }
      throw new Error(`SHARD_BASELINE_RESET_FAILED status=${response.status} body=${body.slice(0, 800)}`);
    }
    const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));
    return await waitForE2EServerHealthy(
      apiUrl,
      remainingMs,
      requireMarketMaker,
      requireCustody,
      signal,
    );
  } catch (error) {
    assertE2EShardNotAborted(signal);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`SHARD_BASELINE_RESET_TIMEOUT api=${apiUrl} timeoutMs=${timeoutMs}`);
    }
    throw new Error(
      `SHARD_BASELINE_RESET_ERROR api=${apiUrl} timeoutMs=${timeoutMs} requireMarketMaker=${requireMarketMaker} requireCustody=${requireCustody} cause=${formatErrorForLog(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
};

const waitForWebReady = async (url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    assertE2EShardNotAborted(signal);
    const ok = await new Promise<boolean>(resolve => {
      const p = spawn('curl', [
        ...(url.startsWith('https:') ? ['-k'] : []),
        '-sSf',
        url,
      ], { stdio: 'ignore' });
      const abort = (): void => {
        if (p.exitCode === null) p.kill('SIGTERM');
      };
      signal?.addEventListener('abort', abort, { once: true });
      p.once('exit', code => resolve(code === 0));
      p.once('error', error => {
        lastError = formatErrorForLog(error);
        resolve(false);
      });
      p.once('close', () => signal?.removeEventListener('abort', abort));
    });
    assertE2EShardNotAborted(signal);
    if (ok) return;
    if (!lastError) lastError = 'curl_exit_nonzero';
    await e2eRetryDelay(250, signal);
  }
  throw new Error(`WEB_ENDPOINT_NOT_READY url=${url} timeoutMs=${timeoutMs} last=${lastError || 'none'}`);
};

export type E2ECommandResult = {
  kind: 'exit' | 'timeout' | 'aborted';
  code: number | null;
  signal: NodeJS.Signals | null;
};

const e2eCommandSucceeded = (result: E2ECommandResult): boolean =>
  result.kind === 'exit' && result.code === 0;

const formatE2ECommandResult = (result: E2ECommandResult): string =>
  `${result.kind}:code=${String(result.code)}:signal=${String(result.signal)}`;

export const runE2ECommand = async (
  cmd: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    log?: ReturnType<typeof createWriteStream>;
    timeoutMs?: number;
    signal?: AbortSignal | undefined;
    onSpawn?: (pid: number) => void;
    onExit?: () => void;
  },
): Promise<E2ECommandResult> => {
  const proc = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeChildProcessEnv(opts.env ?? process.env),
    cwd: opts.cwd,
  });
  if (proc.pid) opts.onSpawn?.(proc.pid);

  proc.stdout.on('data', chunk => opts.log?.write(chunk.toString()));
  proc.stderr.on('data', chunk => opts.log?.write(chunk.toString()));

  let requestedTermination: E2ECommandResult['kind'] | null = null;
  let abortKillTimer: ReturnType<typeof setTimeout> | null = null;
  const abortChild = (): void => {
    requestedTermination ??= 'aborted';
    opts.log?.write(`[runner] aborting child pid=${proc.pid ?? 'unknown'} cmd=${cmd}\n`);
    try {
      if (proc.exitCode === null) proc.kill('SIGTERM');
    } catch (error) {
      opts.log?.write(`[runner] SIGTERM failed pid=${proc.pid ?? 'unknown'} error=${String(error)}\n`);
    }
    abortKillTimer = setTimeout(() => {
      try {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      } catch (error) {
        opts.log?.write(`[runner] SIGKILL failed pid=${proc.pid ?? 'unknown'} error=${String(error)}\n`);
      }
    }, 1500);
  };
  if (opts.signal?.aborted) abortChild();
  opts.signal?.addEventListener('abort', abortChild, { once: true });

  const timeout = opts.timeoutMs
    ? setTimeout(() => {
        requestedTermination ??= 'timeout';
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, opts.timeoutMs)
    : null;

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    proc.once('error', rejectExit);
    proc.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  if (timeout) clearTimeout(timeout);
  if (abortKillTimer) clearTimeout(abortKillTimer);
  opts.signal?.removeEventListener('abort', abortChild);
  opts.onExit?.();
  return {
    kind: requestedTermination ?? 'exit',
    code: exit.code,
    signal: exit.signal,
  };
};

export const materializeSvelteKitShardOutDir = (sourceOutDir: string, shardOutDir: string): void => {
  const sourceManifest = join(sourceOutDir, 'output', 'server', 'manifest.js');
  if (!existsSync(sourceManifest)) {
    throw new Error(`E2E_SVELTE_KIT_OUTPUT_MISSING:${sourceManifest}`);
  }

  rmSync(shardOutDir, { recursive: true, force: true });
  mkdirSync(shardOutDir, { recursive: true });

  for (const entry of readdirSync(sourceOutDir, { withFileTypes: true })) {
    const sourcePath = join(sourceOutDir, entry.name);
    const shardPath = join(shardOutDir, entry.name);
    const linkType = entry.isDirectory() ? 'dir' : 'file';
    symlinkSync(sourcePath, shardPath, linkType);
  }

  const shardManifest = join(shardOutDir, 'output', 'server', 'manifest.js');
  if (!existsSync(shardManifest)) {
    throw new Error(`E2E_SVELTE_KIT_SHARD_LINK_FAILED:${shardManifest}`);
  }
};

const prepareShardSvelteKitOutDir = (
  sourceOutDir: string,
  logsDir: string,
  shard: number,
  log: ReturnType<typeof createWriteStream>,
): string => {
  const frontendRoot = resolve(process.cwd(), 'frontend');
  const sourceManifest = join(sourceOutDir, 'output', 'server', 'manifest.js');
  if (!existsSync(sourceManifest)) {
    throw new Error(`E2E_SVELTE_KIT_OUTPUT_MISSING:${sourceManifest}`);
  }

  const shardOutDir = join(deriveE2EShardPaths(logsDir, shard).root, 'svelte-kit');
  materializeSvelteKitShardOutDir(sourceOutDir, shardOutDir);

  const outDirForFrontend = relative(frontendRoot, shardOutDir);
  const linkedEntries = readdirSync(shardOutDir, { withFileTypes: true })
    .filter(entry => lstatSync(join(shardOutDir, entry.name)).isSymbolicLink())
    .length;
  log.write(`[runner] shard-local SvelteKit output: ${outDirForFrontend} (${linkedEntries} linked entries)\n`);
  return outDirForFrontend;
};

const E2E_BUILD_CACHE_ROOT = resolve(process.cwd(), '.logs', 'e2e-build-cache');
const E2E_BUILD_CACHE_MANIFEST_VERSION = 2;

export const deriveE2EBuildArtifacts = (
  cacheRoot = E2E_BUILD_CACHE_ROOT,
): E2EBuildArtifacts => ({
  cacheRoot,
  publicDir: join(cacheRoot, 'public'),
  runtimeBundlePath: join(cacheRoot, 'public', 'runtime.js'),
  svelteKitOutDir: join(cacheRoot, 'svelte-kit'),
  frontendBuildDir: join(cacheRoot, 'frontend'),
});

type E2EBuildCacheManifest = {
  version: number;
  buildInputHash: string;
  artifactHash: string;
  createdAt: string;
};

const requiredE2EBuildArtifactPaths = (artifacts: E2EBuildArtifacts): string[] => [
  artifacts.runtimeBundlePath,
  join(artifacts.svelteKitOutDir, 'output', 'server', 'manifest.js'),
  join(artifacts.frontendBuildDir, 'index.html'),
];

const assertRequiredE2EBuildArtifacts = (artifacts: E2EBuildArtifacts): void => {
  for (const path of requiredE2EBuildArtifactPaths(artifacts)) {
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`E2E_BUILD_CACHE_ARTIFACT_MISSING:${path}`);
    }
  }
};

export const computeE2EBuildArtifactHash = (artifacts: E2EBuildArtifacts): string => {
  const hash = createHash('sha256');
  const hashDirectory = (label: string, directory: string, prefix = ''): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => compareStableText(a.name, b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hashDirectory(label, path, relativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`E2E_BUILD_CACHE_UNSUPPORTED_ENTRY:${path}`);
      const data = readFileSync(path);
      hash.update(label).update('\0').update(relativePath).update('\0');
      hash.update(String(data.length)).update('\0').update(data).update('\0');
    }
  };
  hashDirectory('public', artifacts.publicDir);
  hashDirectory('svelte-kit', artifacts.svelteKitOutDir);
  hashDirectory('frontend', artifacts.frontendBuildDir);
  return hash.digest('hex');
};

const readE2EBuildCacheManifest = (manifestPath: string): E2EBuildCacheManifest => {
  try {
    const value: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!value || typeof value !== 'object') throw new Error('MANIFEST_NOT_OBJECT');
    const manifest = value as Partial<E2EBuildCacheManifest>;
    if (
      manifest.version !== E2E_BUILD_CACHE_MANIFEST_VERSION ||
      typeof manifest.buildInputHash !== 'string' ||
      typeof manifest.artifactHash !== 'string' ||
      typeof manifest.createdAt !== 'string'
    ) throw new Error('MANIFEST_SHAPE_INVALID');
    return manifest as E2EBuildCacheManifest;
  } catch (error) {
    throw new Error(`E2E_BUILD_CACHE_MANIFEST_INVALID:${manifestPath}`, { cause: error });
  }
};

export const assertE2EBuildArtifactsComplete = (
  artifacts: E2EBuildArtifacts,
  expectedBuildInputHash: string,
): void => {
  const manifestPath = join(artifacts.cacheRoot, 'manifest.json');
  const manifest = readE2EBuildCacheManifest(manifestPath);
  if (manifest.buildInputHash !== expectedBuildInputHash) {
    throw new Error(
      `E2E_BUILD_CACHE_STALE:expected=${expectedBuildInputHash}:` +
      `actual=${String(manifest.buildInputHash || 'missing')}`,
    );
  }
  assertRequiredE2EBuildArtifacts(artifacts);
  const actualArtifactHash = computeE2EBuildArtifactHash(artifacts);
  if (manifest.artifactHash !== actualArtifactHash) {
    throw new Error(
      `E2E_BUILD_CACHE_CORRUPT:expected=${manifest.artifactHash}:actual=${actualArtifactHash}`,
    );
  }
};

export type E2EBuildCacheDecision =
  | { action: 'reuse' }
  | { action: 'rebuild'; reason: string };

export const decideE2EBuildCache = (
  artifacts: E2EBuildArtifacts,
  expectedBuildInputHash: string,
  cacheOnly: boolean,
): E2EBuildCacheDecision => {
  try {
    assertE2EBuildArtifactsComplete(artifacts, expectedBuildInputHash);
    return { action: 'reuse' };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (cacheOnly) throw error;
    return { action: 'rebuild', reason: error.message };
  }
};

const prepareIsolatedE2EBuild = async (
  logsDir: string,
  buildInputHash: string,
  skipBuild: boolean,
): Promise<E2EBuildArtifacts> => {
  const artifacts = deriveE2EBuildArtifacts();
  const cacheDecision = decideE2EBuildCache(artifacts, buildInputHash, skipBuild);
  if (cacheDecision.action === 'reuse') {
    console.log(`⏩ isolated build cache hit: ${artifacts.cacheRoot}`);
    return artifacts;
  }
  console.warn(`♻️ isolated build cache rebuild: ${cacheDecision.reason}`);

  rmSync(artifacts.cacheRoot, { recursive: true, force: true });
  mkdirSync(artifacts.cacheRoot, { recursive: true });
  const frontendRoot = resolve(process.cwd(), 'frontend');
  symlinkSync(join(frontendRoot, 'node_modules'), join(artifacts.cacheRoot, 'node_modules'), 'dir');
  cpSync(join(frontendRoot, 'static'), artifacts.publicDir, { recursive: true });
  const buildLogPath = join(logsDir, 'build-runtime.log');
  const buildLog = createWriteStream(buildLogPath, { flags: 'w' });
  try {
    const staticResult = await runE2ECommand('node', ['copy-static-files.js'], {
      cwd: frontendRoot,
      env: sanitizeChildProcessEnv({
        ...process.env,
        XLN_STATIC_DIR: artifacts.publicDir,
      }),
      log: buildLog,
      timeoutMs: 300000,
    });
    const buildResult = await runE2ECommand('bash', ['-lc', './scripts/build-runtime.sh'], {
      env: sanitizeChildProcessEnv({
        ...process.env,
        XLN_RUNTIME_BUNDLE_OUT: artifacts.runtimeBundlePath,
      }),
      log: buildLog,
      timeoutMs: 300000,
    });
    buildLog.write('\n=== isolated frontend build ===\n');
    const frontendBuildResult = await runE2ECommand(
      'node',
      [resolve(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
      {
        cwd: frontendRoot,
        env: sanitizeChildProcessEnv({
          ...process.env,
          XLN_RUNTIME_BUNDLE_PATH: artifacts.runtimeBundlePath,
          XLN_SVELTE_KIT_OUT_DIR: relative(frontendRoot, artifacts.svelteKitOutDir),
          XLN_SVELTE_BUILD_DIR: relative(frontendRoot, artifacts.frontendBuildDir),
          VITE_PUBLIC_DIR: relative(frontendRoot, artifacts.publicDir),
          VITE_CACHE_DIR: relative(frontendRoot, join(artifacts.cacheRoot, 'vite-cache')),
        }),
        log: buildLog,
        timeoutMs: 300000,
      },
    );
    if (
      !e2eCommandSucceeded(staticResult)
      || !e2eCommandSucceeded(buildResult)
      || !e2eCommandSucceeded(frontendBuildResult)
    ) {
      throw new Error(
        `E2E_ISOLATED_PREBUILD_FAILED:static=${formatE2ECommandResult(staticResult)}:` +
        `runtime=${formatE2ECommandResult(buildResult)}:` +
        `frontend=${formatE2ECommandResult(frontendBuildResult)}:log=${buildLogPath}`,
      );
    }
  } finally {
    buildLog.end();
    await finished(buildLog);
  }

  assertRequiredE2EBuildArtifacts(artifacts);
  const manifest: E2EBuildCacheManifest = {
    version: E2E_BUILD_CACHE_MANIFEST_VERSION,
    buildInputHash,
    artifactHash: computeE2EBuildArtifactHash(artifacts),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(artifacts.cacheRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return artifacts;
};

const forensicEndpoints = [
  { name: 'health', path: '/api/health' },
  { name: 'entities', path: '/api/debug/entities?limit=5000' },
  // The relay keeps a bounded 5k ring. Capture all of it: high-volume gossip
  // after a failure must not hide the earlier command/delivery transition.
  { name: 'events', path: '/api/debug/events?last=5000' },
  { name: 'activity', path: '/api/debug/activity?limit=500' },
] as const;

const timeoutForensicError = (error: unknown, timeoutMs: number): unknown => {
  const description = formatErrorForLog(error);
  return /abort|timeout/i.test(description)
    ? new Error(`Timeout after ${timeoutMs}ms`, { cause: error })
    : error;
};

export const captureE2EHttpForensics = async (options: {
  apiUrl: string;
  outputDir: string;
  timeoutMs?: number;
}): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 2_000;
  mkdirSync(options.outputDir, { recursive: true });
  const failures = await Promise.all(forensicEndpoints.map(async endpoint => {
    const url = `${options.apiUrl}${endpoint.path}`;
    try {
      const response = await fetchWithTimeout(url, {}, timeoutMs);
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP_${response.status}:body=${body.slice(0, 500)}`);
      }
      const payload = parseJsonStrict(body, url);
      writeFileSync(
        join(options.outputDir, `${endpoint.name}.json`),
        `${JSON.stringify(payload, null, 2)}\n`,
      );
      return null;
    } catch (error) {
      const normalized = timeoutForensicError(error, timeoutMs);
      const message =
        `E2E_FORENSIC_ENDPOINT_FAILED:name=${endpoint.name}:url=${url}:` +
        formatErrorForLog(normalized);
      writeFileSync(join(options.outputDir, `${endpoint.name}.error.txt`), `${message}\n`);
      return message;
    }
  }));
  const errors = failures.filter((failure): failure is string => failure !== null);
  if (errors.length > 0) {
    throw new Error(`E2E_FAILURE_FORENSICS_INCOMPLETE:${errors.join(' | ')}`);
  }
};

const captureShardFailureForensics = async (options: {
  logsDir: string;
  shard: number;
  apiUrl: string;
  log: ReturnType<typeof createWriteStream>;
}): Promise<void> => {
  const outputDir = join(deriveE2EShardPaths(options.logsDir, options.shard).resultsDir, 'failure-debug');
  try {
    await captureE2EHttpForensics({ apiUrl: options.apiUrl, outputDir });
  } finally {
    options.log.write(`[forensics] wrote failure debug bundle: ${outputDir}\n`);
  }
};

const writePlaywrightFailureCapsule = (options: {
  reportPath: string;
  capsulePath: string;
  logsDir: string;
  args: CliArgs;
}): QaFailureCapsule | null => {
  const failure = readPlaywrightFailureReport(options.reportPath);
  if (!failure) return null;
  const capsule: QaFailureCapsule = {
    version: 1,
    ...failure,
    reportPath: relative(options.logsDir, failure.reportPath),
    rerunCommand: buildIsolatedE2ERerunCommand(failure, {
      videoMode: options.args.videoMode,
      traceMode: 'retain-on-failure',
      screenshotMode: options.args.screenshotMode,
      prewaitHealth: options.args.prewaitHealth,
      strictBrowserHealth: options.args.strictBrowserHealth,
    }),
  };
  mkdirSync(dirname(options.capsulePath), { recursive: true });
  writeFileSync(options.capsulePath, `${JSON.stringify(capsule, null, 2)}\n`);
  return capsule;
};

const runShard = async (
  task: RunTask,
  args: CliArgs,
  logsDir: string,
  buildArtifacts: E2EBuildArtifacts,
  resetLimiter: AsyncLimiter,
  signal?: AbortSignal,
): Promise<RunResult> => {
  const shard = task.shard;
  const totalShards = task.totalShards;
  const startedAt = Date.now();
  const shardPaths = deriveE2EShardPaths(logsDir, shard);
  mkdirSync(shardPaths.logsRoot, { recursive: true });
  mkdirSync(shardPaths.artifactsRoot, { recursive: true });
  const logPath = shardPaths.logPath;
  const log = createWriteStream(logPath, { flags: 'w' });

  let anvil: ManagedChildProcess | null = null;
  let anvil2: ManagedChildProcess | null = null;
  let api: ManagedChildProcess | null = null;
  let vite: ManagedChildProcess | null = null;
  let playwrightPid: number | undefined;
  let teardownReason: string | null = null;
  const diagnostics: string[] = [];
  let failureCapsule: QaFailureCapsule | null = null;
  let failureCapsulePath: string | null = null;
  const shardAbortController = new AbortController();
  const forwardOuterAbort = (): void => shardAbortController.abort();
  signal?.addEventListener('abort', forwardOuterAbort, { once: true });
  if (signal?.aborted) shardAbortController.abort();
  let stopFatalMonitor: (() => void) | null = null;
  const shardPorts = deriveE2EShardPorts(args.basePort, shard);
  const rpcPort = shardPorts.rpc;
  const rpc2Port = shardPorts.rpc2;
  const apiPort = shardPorts.api;
  const webPort = shardPorts.web;
  const custodyPort = shardPorts.custody;
  const custodyDaemonPort = shardPorts.custodyDaemon;
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const rpc2Url = `http://127.0.0.1:${rpc2Port}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const frontendRoot = resolve(process.cwd(), 'frontend');
  const webUrl = `http://localhost:${webPort}`;
  const dbPath = shardPaths.dbRoot;
  const runtimeImportManifestPath = join(dbPath, 'runtime-import-manifest.json');
  // Keep anvil's live state outside orchestrator dbRoot. Reset intentionally rm -rf's dbRoot.
  const anvilStatePath = join(shardPaths.jdbRoot, 'anvil-state.json');
  const anvil2StatePath = join(shardPaths.jdbRoot, 'anvil2-state.json');
  const anvilTmpDir = join(shardPaths.jdbRoot, 'tmp', 'anvil');
  const anvil2TmpDir = join(shardPaths.jdbRoot, 'tmp', 'anvil2');
  mkdirSync(dbPath, { recursive: true });
  mkdirSync(anvilTmpDir, { recursive: true });
  mkdirSync(anvil2TmpDir, { recursive: true });
  let baselineHealth: unknown | null = null;

  const phaseMs: RunResult['phaseMs'] = {
    preflight: 0,
    anvilBoot: 0,
    apiBoot: 0,
    apiHealthy: 0,
    viteBoot: 0,
    playwright: 0,
  };
  const markPhase = (phase: keyof RunResult['phaseMs'], started: number): void => {
    const ms = Date.now() - started;
    phaseMs[phase] = ms;
    const warn = ms > args.phaseWarnMs;
    log.write(`[timing] ${phase}=${ms}ms${warn ? ` (>${args.phaseWarnMs}ms)` : ''}\n`);
  };
  const throwIfAborted = (): void => {
    if (teardownReason?.startsWith('E2E_FATAL_RUNTIME_LOG')) throw new Error(teardownReason);
    if (shardAbortController.signal.aborted || signal?.aborted) throw new Error('E2E_ABORTED_AFTER_FIRST_FAILURE');
  };
  const perfMonitor = startPerfMonitor(() => [
    { name: 'anvil', pid: anvil?.pid },
    { name: 'anvil2', pid: anvil2?.pid },
    { name: 'api', pid: api?.pid },
    { name: 'vite', pid: vite?.pid },
    { name: 'playwright', pid: playwrightPid },
  ]);
  let perfStopped = false;
  let completedResult: RunResult | null = null;
  const finishResult = (result: Omit<RunResult, 'perf'>): RunResult => {
    const perf = perfStopped ? emptyPerfSummary() : perfMonitor.stop();
    perfStopped = true;
    completedResult = {
      ...result,
      diagnostics: [...diagnostics],
      failureCapsule,
      failureCapsulePath,
      perf,
    };
    return completedResult;
  };
  const reportSecondary = (secondary: string): void => {
    diagnostics.push(secondary);
    log.write(`[runner:error] ${secondary}\n`);
  };
  const captureFailureDiagnostics = (primaryFailure: string): Promise<string> =>
    runE2EShardFailureDiagnostic(
      primaryFailure,
      'failure-forensics',
      async () => captureShardFailureForensics({ logsDir, shard, apiUrl, log }),
      reportSecondary,
    );
  const finishCancelled = (): RunResult => {
    const reason = signal?.reason as E2EGlobalFailFastAbortReason;
    teardownReason =
      `E2E_CANCELLED_AFTER_PRIMARY_FAILURE:primaryShard=${reason.primaryFailure.shard}:` +
      `primaryClass=${reason.primaryFailure.resultClass}`;
    log.write(`[runner] ${teardownReason}\n`);
    return finishResult({
      shard,
      status: 'cancelled',
      resultClass: 'cancelled',
      durationMs: Date.now() - startedAt,
      logPath,
      target: task.pwTargets[0] || `shard-${task.shard}`,
      title: task.title || task.pwTargets[0] || `shard-${task.shard}`,
      requireMarketMaker: task.requireMarketMaker,
      requireCustody: task.requireCustody,
      scenario: task.scenario,
      phaseMs,
      error: teardownReason,
    });
  };

  try {
    stopFatalMonitor = startFailFastLogMonitor(logPath, (message) => {
      if (!teardownReason) teardownReason = message;
      log.write(`[runner] fail-fast monitor hit -> aborting shard\n${message}\n`);
      shardAbortController.abort();
      for (const [label, child] of [
        ['api', api],
        ['vite', vite],
        ['anvil', anvil],
        ['anvil2', anvil2],
      ] as const) {
        teardownReason = signalE2EFatalMonitorChild(
          teardownReason ?? '',
          label,
          child,
          secondary => { log.write(`[runner:error] ${secondary}\n`); },
        );
      }
    });
    log.write(`shard=${shard}/${totalShards}\nrpc=${rpcUrl}\nrpc2=${rpc2Url}\napi=${apiUrl}\nweb=${webUrl}\ndb=${dbPath}\n\n`);
    throwIfAborted();

    // Hard preflight: kill stale processes that kept shard ports occupied
    // from previous crashed/aborted runs.
    // Layout:
    // - rpc: anvil
    // - rpc2: secondary anvil for cross-j local simulation
    // - api: production runtime/server/index.ts on an isolated shard port
    // - web: vite preview
    // - extra reserved ports kept for any local child APIs the server may spawn
    const preflightStart = Date.now();
    await freeE2EPorts([
      rpcPort,
      rpc2Port,
      apiPort,
      webPort,
      apiPort + 10,
      apiPort + 11,
      apiPort + 12,
      apiPort + 13,
    ], log);
    markPhase('preflight', preflightStart);
    throwIfAborted();

    const anvilStart = Date.now();
    anvil = spawn(
      args.anvilBin,
      [
        '--host',
        '127.0.0.1',
        '--port',
        String(rpcPort),
        '--chain-id',
        '31337',
        '--block-gas-limit',
        '60000000',
        '--code-size-limit',
        '65536',
        '--prune-history',
        String(E2E_ANVIL_HISTORY_STATES),
        '--state',
        anvilStatePath,
        '--silent',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizeChildProcessEnv({ ...process.env, TMPDIR: anvilTmpDir }),
      },
    );
    anvil.stdout.on('data', c => log.write(`[anvil] ${c.toString()}`));
    anvil.stderr.on('data', c => log.write(`[anvil:err] ${c.toString()}`));
    anvil2 = spawn(
      args.anvilBin,
      [
        '--host',
        '127.0.0.1',
        '--port',
        String(rpc2Port),
        '--chain-id',
        '31338',
        '--block-gas-limit',
        '60000000',
        '--code-size-limit',
        '65536',
        '--prune-history',
        String(E2E_ANVIL_HISTORY_STATES),
        '--state',
        anvil2StatePath,
        '--silent',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizeChildProcessEnv({ ...process.env, TMPDIR: anvil2TmpDir }),
      },
    );
    anvil2.stdout.on('data', c => log.write(`[anvil2] ${c.toString()}`));
    anvil2.stderr.on('data', c => log.write(`[anvil2:err] ${c.toString()}`));
    await Promise.all([
      waitForRpcReady(rpcUrl, args.stackTimeoutMs, 31337, shardAbortController.signal),
      waitForRpcReady(rpc2Url, args.stackTimeoutMs, 31338, shardAbortController.signal),
    ]);
    markPhase('anvilBoot', anvilStart);
    throwIfAborted();

    const apiStart = Date.now();
    api = spawn(
      'bun',
      [
        'runtime/orchestrator/orchestrator.ts',
        '--host',
        '127.0.0.1',
        '--port',
        String(apiPort),
        '--public-ws-base-url',
        `ws://127.0.0.1:${apiPort}`,
        '--rpc-url',
        rpcUrl,
        '--rpc2-url',
        rpc2Url,
        '--db-root',
        dbPath,
        '--wallet-url',
        `${webUrl}/app`,
        '--allow-reset',
        ...(args.prewaitHealth === 'reset' ? ['--defer-initial-reset'] : []),
        ...(task.requireMarketMaker ? ['--mm'] : []),
        ...(task.requireCustody ? [
          '--custody',
          '--custody-port',
          String(custodyPort),
          '--custody-daemon-port',
          String(custodyDaemonPort),
          '--custody-db-root',
          join(dbPath, 'custody'),
        ] : []),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizeChildProcessEnv({
          ...process.env,
          USE_ANVIL: 'true',
          ANVIL_RPC: rpcUrl,
          ANVIL_RPC2: rpc2Url,
          XLN_RDB_ROOT: shardPaths.rdbRoot,
          XLN_JDB_ROOT: shardPaths.jdbRoot,
          XLN_STORAGE_HISTORY_PATH: join(shardPaths.rdbRoot, 'storage-health-history.json'),
          XLN_JURISDICTIONS_PATH: join(dbPath, 'jurisdictions.json'),
          XLN_MESH_ROOT_SEED: `xln-e2e-mesh-root:${dbPath}`,
          XLN_MESH_RUNTIME_SEEDS_JSON: JSON.stringify({
            H1: 'xln-e2e-h1',
            H2: 'xln-e2e-h2',
            H3: 'xln-e2e-h3',
            MM: 'xln-mesh-mm',
            CUSTODY: 'xln-mesh-custody-seed',
          }),
          XLN_SKIP_STALE_REAP: '1',
          XLN_RUNTIME_IMPORT_MANIFEST_PATH: runtimeImportManifestPath,
          XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS: String(args.stackTimeoutMs),
          MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS:
            process.env['MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS'] ?? '15000',
          XLN_AUTO_PROVISION_EXTERNAL_FAUCET: process.env['XLN_AUTO_PROVISION_EXTERNAL_FAUCET'] ?? '1',
          ...(process.env['XLN_MIN_DISK_FREE_BYTES']
            ? { XLN_MIN_DISK_FREE_BYTES: process.env['XLN_MIN_DISK_FREE_BYTES'] }
            : {}),
        }),
      },
    );
    api.stdout.on('data', c => log.write(`[api] ${c.toString()}`));
    api.stderr.on('data', c => log.write(`[api:err] ${c.toString()}`));
    await waitForHttpReady(`${apiUrl}/api`, args.stackTimeoutMs, shardAbortController.signal);
    markPhase('apiBoot', apiStart);
    throwIfAborted();
    if (args.prewaitHealth === 'reset') {
      const resetQueuedAt = Date.now();
      await resetLimiter.run(async () => {
        const resetStartedAt = Date.now();
        const queueMs = resetStartedAt - resetQueuedAt;
        if (queueMs > 0) log.write(`[timing] resetQueue=${queueMs}ms\n`);
        throwIfAborted();
        baselineHealth = await hardResetShardBaseline(
          apiUrl,
          args.stackTimeoutMs,
          task.requireMarketMaker,
          task.requireCustody,
          shardAbortController.signal,
        );
      });
      const remainingHealthMs = Math.max(1_000, args.stackTimeoutMs - (Date.now() - resetQueuedAt));
      baselineHealth = await waitForE2EServerHealthy(
        apiUrl,
        remainingHealthMs,
        task.requireMarketMaker,
        task.requireCustody,
        shardAbortController.signal,
      );
      markPhase('apiHealthy', resetQueuedAt);
      throwIfAborted();
    } else if (args.prewaitHealth === 'full') {
      const healthStart = Date.now();
      baselineHealth = await waitForE2EServerHealthy(
        apiUrl,
        args.stackTimeoutMs,
        task.requireMarketMaker,
        task.requireCustody,
        shardAbortController.signal,
      );
      markPhase('apiHealthy', healthStart);
      throwIfAborted();
    } else {
      log.write('[timing] apiHealthy=0ms (prewait-health=http; baseline waits inside tests that need it)\n');
    }

    const shardViteCacheDir = join(shardPaths.root, 'vite-cache');
    const shardSvelteKitOutDir = prepareShardSvelteKitOutDir(buildArtifacts.svelteKitOutDir, logsDir, shard, log);
    const viteStart = Date.now();
    // Spawn Vite directly. `bun run preview` starts an extra child node
    // process, so killing the Bun wrapper can leave `node .../vite preview`
    // alive until the next global preflight cleanup.
    vite = spawn(
      'node',
      [
        resolve(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
        'preview',
        '--mode',
        `xln-e2e-${basename(logsDir)}-${shard}`,
        '--host',
        '0.0.0.0',
        '--port',
        String(webPort),
        '--strictPort',
      ],
      {
        cwd: frontendRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizeChildProcessEnv({
          ...process.env,
          ANVIL_RPC: rpcUrl,
          ANVIL_RPC2: rpc2Url,
          RPC_ETHEREUM: rpcUrl,
          RPC_TRON: rpc2Url,
          VITE_DEV_PORT: String(webPort),
          VITE_API_PROXY_TARGET: apiUrl,
          XLN_VITE_FORCE_HTTP: '1',
          VITE_CACHE_DIR: shardViteCacheDir,
          XLN_SVELTE_KIT_OUT_DIR: shardSvelteKitOutDir,
          XLN_SVELTE_BUILD_DIR: relative(frontendRoot, buildArtifacts.frontendBuildDir),
          XLN_RUNTIME_BUNDLE_PATH: buildArtifacts.runtimeBundlePath,
          VITE_PUBLIC_DIR: relative(frontendRoot, buildArtifacts.publicDir),
        }),
      },
    );
    vite.stdout.on('data', c => log.write(`[vite] ${c.toString()}`));
    vite.stderr.on('data', c => log.write(`[vite:err] ${c.toString()}`));
    await waitForWebReady(webUrl, Math.min(args.stackTimeoutMs, 30_000), shardAbortController.signal);
    markPhase('viteBoot', viteStart);
    throwIfAborted();

    const playwrightReportPath = join(shardPaths.resultsDir, 'playwright-report.json');
    const plannedFailureCapsulePath = join(shardPaths.resultsDir, 'failure-capsule.json');
    const failureCapsuleErrorPath = join(shardPaths.resultsDir, 'failure-capsule.error.txt');
    const shardArg = `${shard + 1}/${totalShards}`;
    const playwrightArgs = ['playwright', 'test', '--config', 'playwright.config.ts'];
    if (task.usePlaywrightShard) {
      playwrightArgs.push('--shard', shardArg);
    }
    const titleGrep = task.grep || args.pwGrep;
    const categoryGrep = escapeRegExp(QA_TEST_CATEGORY_TAGS[task.testCategory]);
    const grep = titleGrep
      ? `(?=.*(?:${titleGrep}))(?=.*(?:${categoryGrep}))`
      : categoryGrep;
    if (grep) {
      playwrightArgs.push('--grep', grep);
    }
    if (args.pwProject) {
      playwrightArgs.push(`--project=${args.pwProject}`);
    }
    playwrightArgs.push(`--workers=${args.workersPerShard}`);
    playwrightArgs.push(`--reporter=${args.reporter},json`);
    if (args.maxFailures > 0) playwrightArgs.push(`--max-failures=${args.maxFailures}`);
    for (const target of task.pwTargets) playwrightArgs.push(target);
    log.write(`[runner] playwright args: ${JSON.stringify(playwrightArgs)}\n`);

    const playwrightStart = Date.now();
    const playwrightResult = await runE2ECommand('bunx', playwrightArgs, {
      env: {
        ...process.env,
        // Keep isolated CI-style runs headless even if the parent shell has
        // debugging/browser-opening variables set.
        CI: process.env['CI'] || '1',
        HEADED: 'false',
        PWDEBUG: '0',
        PLAYWRIGHT_HTML_OPEN: 'never',
        PW_BASE_URL: webUrl,
        PW_SKIP_WEBSERVER: '1',
        PW_WORKERS: String(args.workersPerShard),
        PW_TEST_TIMEOUT: String(args.testTimeoutMs),
        PW_VIDEO: args.videoMode,
        PW_TRACE: args.traceMode,
        PW_SCREENSHOT: args.screenshotMode,
        PW_SIMPLE_REPORTER: '1',
        PW_REPORTER: args.reporter,
        PLAYWRIGHT_JSON_OUTPUT_FILE: playwrightReportPath,
        PW_OUTPUT_DIR: shardPaths.resultsDir,
        E2E_BASE_URL: webUrl,
        E2E_API_BASE_URL: apiUrl,
        E2E_ANVIL_RPC: rpcUrl,
        E2E_ANVIL_RPC2: rpc2Url,
        XLN_JURISDICTIONS_PATH: join(dbPath, 'jurisdictions.json'),
        E2E_RESET_BASE_URL: apiUrl,
        E2E_BASELINE_HEALTH_JSON: baselineHealth ? JSON.stringify(baselineHealth) : '',
        E2E_RUNTIME_IMPORT_MANIFEST_PATH: runtimeImportManifestPath,
        E2E_BROWSER_EVENTS_PATH: shardBrowserEventsPath(logsDir, shard),
        E2E_PLAYWRIGHT_STARTED_AT_MS: String(playwrightStart),
        E2E_FAST: process.env['E2E_FAST'] ?? '1',
        E2E_ISOLATED_STACK: '1',
        E2E_ISOLATED_BASELINE_READY: args.prewaitHealth === 'http' ? '0' : '1',
        XLN_TEST_ARTIFACT_CLEANUP_DONE: '1',
        XLN_INCLUDE_MARKET_MAKER: task.requireMarketMaker ? '1' : '0',
        XLN_INCLUDE_CUSTODY: task.requireCustody ? '1' : '0',
      },
      log,
      timeoutMs: args.testTimeoutMs,
      signal: shardAbortController.signal,
      onSpawn: (pid) => {
        playwrightPid = pid;
      },
      onExit: () => {
        playwrightPid = undefined;
      },
    });
    markPhase('playwright', playwrightStart);
    if (
      playwrightResult.kind === 'aborted' &&
      isE2EGlobalFailFastAbortSignal(signal) &&
      !String(teardownReason || '').startsWith('E2E_FATAL_RUNTIME_LOG')
    ) {
      return finishCancelled();
    }
    const playwrightFailed = !e2eCommandSucceeded(playwrightResult);
    if (playwrightFailed && !teardownReason) {
      teardownReason = `playwright_${formatE2ECommandResult(playwrightResult)}`;
    }

    let playwrightReportError: Error | null = null;
    try {
      failureCapsule = writePlaywrightFailureCapsule({
        reportPath: playwrightReportPath,
        capsulePath: plannedFailureCapsulePath,
        logsDir,
        args,
      });
      if (playwrightFailed && !failureCapsule) {
        throw new Error(`E2E_PLAYWRIGHT_FAILURE_MISSING:path=${playwrightReportPath}`);
      }
      if (!playwrightFailed && failureCapsule) {
        throw new Error(`E2E_PLAYWRIGHT_REPORT_EXIT_MISMATCH:path=${playwrightReportPath}:exit=0`);
      }
      failureCapsulePath = failureCapsule ? plannedFailureCapsulePath : null;
    } catch (error) {
      playwrightReportError = error instanceof Error ? error : new Error(String(error));
      mkdirSync(shardPaths.resultsDir, { recursive: true });
      try {
        writeFileSync(failureCapsuleErrorPath, `${formatErrorForLog(playwrightReportError)}\n`);
      } catch (writeError) {
        const recorded = recordE2EShardSecondaryFailure(
          formatErrorForLog(playwrightReportError),
          'playwright-report-error-write',
          writeError,
        );
        reportSecondary(recorded.secondary);
        playwrightReportError = new Error(recorded.error);
      }
      if (!playwrightFailed) throw playwrightReportError;
    }

    if (playwrightFailed) {
      if (!teardownReason) throw new Error('E2E_PLAYWRIGHT_PRIMARY_FAILURE_MISSING');
      if (playwrightReportError) {
        const recorded = recordE2EShardSecondaryFailure(
          teardownReason,
          'playwright-report',
          playwrightReportError,
        );
        teardownReason = recorded.error;
        reportSecondary(recorded.secondary);
      }
      teardownReason = await captureFailureDiagnostics(teardownReason);
      return finishResult({
        shard,
        status: 'failed',
        resultClass: 'playwright',
        durationMs: Date.now() - startedAt,
        logPath,
        target: task.pwTargets[0] || `shard-${task.shard}`,
        title: task.title || task.pwTargets[0] || `shard-${task.shard}`,
        requireMarketMaker: task.requireMarketMaker,
        requireCustody: task.requireCustody,
        scenario: task.scenario,
        phaseMs,
        error: teardownReason,
      });
    }

    await delay(250);
    await flushLog(log, '[runner] playwright passed; scanning runtime fatal markers\n');
    const runtimeFatalLines = findRuntimeFatalLogLines(logPath);
    if (runtimeFatalLines.length > 0) {
      teardownReason = `E2E_FATAL_RUNTIME_LOG:\n${runtimeFatalLines.join('\n')}`;
      teardownReason = await captureFailureDiagnostics(teardownReason);
      return finishResult({
        shard,
        status: 'failed',
        resultClass: 'runtime-fatal',
        durationMs: Date.now() - startedAt,
        logPath,
        target: task.pwTargets[0] || `shard-${task.shard}`,
        title: task.title || task.pwTargets[0] || `shard-${task.shard}`,
        requireMarketMaker: task.requireMarketMaker,
        requireCustody: task.requireCustody,
        scenario: task.scenario,
        phaseMs,
        error: teardownReason,
      });
    }

    // Vite owns the browser-facing WebSocket proxy. Closing its upstream first
    // turns a normal Playwright socket close into noisy proxy socket failures.
    await flushLog(log, '[runner] playwright passed; closing vite ingress before api quiesce\n');
    await stopProcessDependencyChain([
      { label: 'vite', proc: vite },
      { label: 'api', proc: api, termTimeoutMs: 35_000 },
    ]);
    await stopShardRuntimePorts(apiPort, log);
    await delay(250);
    await flushLog(log, '[runner] api stopped; scanning runtime fatal markers\n');
    const postTeardownFatalLines = findRuntimeFatalLogLines(logPath);
    const monitorFatalReason = String(teardownReason || '').startsWith('E2E_FATAL_RUNTIME_LOG')
      ? String(teardownReason)
      : null;
    if (monitorFatalReason || postTeardownFatalLines.length > 0) {
      teardownReason = monitorFatalReason ?? `E2E_FATAL_RUNTIME_LOG:\n${postTeardownFatalLines.join('\n')}`;
      teardownReason = await captureFailureDiagnostics(teardownReason);
      return finishResult({
        shard,
        status: 'failed',
        resultClass: 'runtime-fatal',
        durationMs: Date.now() - startedAt,
        logPath,
        target: task.pwTargets[0] || `shard-${task.shard}`,
        title: task.title || task.pwTargets[0] || `shard-${task.shard}`,
        requireMarketMaker: task.requireMarketMaker,
        requireCustody: task.requireCustody,
        scenario: task.scenario,
        phaseMs,
        error: teardownReason,
      });
    }

    return finishResult({
      shard,
      status: 'passed',
      resultClass: 'passed',
      durationMs: Date.now() - startedAt,
      logPath,
      target: task.pwTargets[0] || `shard-${task.shard}`,
      title: task.title || task.pwTargets[0] || `shard-${task.shard}`,
      requireMarketMaker: task.requireMarketMaker,
      requireCustody: task.requireCustody,
      scenario: task.scenario,
      phaseMs,
    });
  } catch (error) {
    if (isE2EGlobalFailFastAbortSignal(signal) &&
      !String(teardownReason || '').startsWith('E2E_FATAL_RUNTIME_LOG')) {
      return finishCancelled();
    }
    teardownReason = teardownReason || formatErrorForLog(error);
    teardownReason = await captureFailureDiagnostics(teardownReason);
    return finishResult({
      shard,
      status: 'failed',
      resultClass: phaseMs.playwright === 0 ? 'startup' : 'runner',
      durationMs: Date.now() - startedAt,
      logPath,
      target: task.pwTargets[0] || `shard-${task.shard}`,
      title: task.title || task.pwTargets[0] || `shard-${task.shard}`,
      requireMarketMaker: task.requireMarketMaker,
      requireCustody: task.requireCustody,
      scenario: task.scenario,
      phaseMs,
      error: teardownReason,
    });
  } finally {
    if (!perfStopped) {
      perfMonitor.stop();
      perfStopped = true;
    }
    stopFatalMonitor?.();
    signal?.removeEventListener('abort', forwardOuterAbort);
    if (teardownReason && api && api.exitCode === null) {
      const teardownLabel = phaseMs.apiHealthy > 0 ? 'shard teardown' : 'startup failure';
      const normalizedReason = teardownReason.replace(/\n/g, '\n[runner]   ');
      log.write(`[runner] ${teardownLabel} -> SIGTERM api pid=${api.pid} reason=${normalizedReason}\n`);
    }
    if (!teardownReason && api && api.exitCode === null) {
      log.write('[runner] playwright passed; closing vite ingress before api quiesce\n');
    }
    const cleanupFailures: Error[] = [];
    const attemptCleanup = async (label: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (cause) {
        cleanupFailures.push(new Error(`E2E_SHARD_CLEANUP_FAILED:${label}`, { cause }));
      }
    };
    await attemptCleanup('processes', async () => {
      await stopProcessDependencyChain([
        { label: 'vite', proc: vite },
        { label: 'api', proc: api, termTimeoutMs: 35_000 },
        { label: 'anvil', proc: anvil },
        { label: 'anvil2', proc: anvil2 },
      ]);
    });
    await attemptCleanup('api-ports', async () => stopShardRuntimePorts(apiPort, log));
    try {
      rmSync(anvilTmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      rmSync(anvil2TmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (cause) {
      cleanupFailures.push(new Error('E2E_SHARD_CLEANUP_FAILED:anvil-temp', { cause }));
    }
    log.end();
    await attemptCleanup('log-finish', async () => {
      await finished(log);
    });
    const cleanupResolution = reconcileE2EShardCleanupFailures(
      completedResult,
      cleanupFailures,
      shard,
    );
    for (const secondary of cleanupResolution.secondaryFailures) {
      console.error(`[e2e:cleanup] shard=${String(shard)} ${secondary}`);
    }
    if (cleanupResolution.result && completedResult) {
      Object.assign(completedResult, cleanupResolution.result);
    }
    if (cleanupResolution.unhandledError) {
      throw cleanupResolution.unhandledError;
    }
  }
};

async function main(): Promise<void> {
  const args = parseArgs();
  // Artifact retention changes only deletion policy. Every top-level run must
  // still acquire a fresh lease so Playwright children can prove that their
  // parent owns the shared evidence workspace.
  cleanupTestArtifactsBeforeRun({
    reason: 'e2e',
    scope: 'e2e',
    skipIfAlreadyDone: false,
    argv: args.preserveArtifacts ? ['--keep-test-artifacts'] : [],
  });
  const logsDir = resolve(process.cwd(), '.logs', 'e2e-parallel', tsTag());
  const releaseRunnerLock = acquireRunnerLock(logsDir);
  mkdirSync(logsDir, { recursive: true });
  const codeFingerprint = computeCodeFingerprint();
  const sourceDriftProbe = computeRepositorySourceDriftProbe();
  const codeDriftGuard = createE2ECodeDriftGuard({
    expectedCodeHash: sourceDriftProbe,
    computeCodeHash: computeRepositorySourceDriftProbe,
  });

  console.log('\n' + '='.repeat(72));
  console.log('E2E Parallel Runner (isolated stack per shard)');
  console.log('='.repeat(72));
  console.log(`Shards   : ${args.shards}`);
  console.log(`BasePort : ${args.basePort}`);
  console.log(`Workers/shard: ${args.workersPerShard}`);
  console.log(`MM concurrency: ${args.maxMmConcurrency}`);
  console.log(`Reset concurrency: ${args.maxResetConcurrency}`);
  console.log(`Max failures : ${args.maxFailures}`);
  console.log(`Phase warn ms: ${args.phaseWarnMs}`);
  console.log(`Prewait health: ${args.prewaitHealth}`);
  console.log(`Browser health: ${args.strictBrowserHealth ? 'strict' : 'report-only'}`);
  console.log(`QA category  : ${args.qaCategory ?? 'all'}`);
  console.log(`File batching: ${args.batchFiles ? 'yes' : 'no'}`);
  console.log(`Start target : ${args.startAt}`);
  console.log(`Keep prior logs: ${args.preserveArtifacts ? 'yes' : 'no'}`);
  console.log(`Artifacts    : video=${args.videoMode}, trace=${args.traceMode}, screenshot=${args.screenshotMode}`);
  console.log(`Git HEAD     : ${codeFingerprint.gitHead?.slice(0, 12) ?? 'unknown'}${codeFingerprint.dirty ? ' dirty' : ''}`);
  console.log(`Code hash    : ${codeFingerprint.codeHash.slice(0, 16)}`);
  console.log(`Build inputs : ${codeFingerprint.buildInputHash.slice(0, 16)}`);
  console.log(`Logs     : ${logsDir}`);
  console.log('='.repeat(72) + '\n');

  try {
    const buildArtifacts = await prepareIsolatedE2EBuild(
      logsDir,
      codeFingerprint.buildInputHash,
      args.skipBuild,
    );

    try {
      await assertRunnerPreflight();
      await reapStaleIsolatedE2EProcesses(logsDir);
    } catch (error) {
      console.error(`❌ runner preflight failed: ${String(error instanceof Error ? error.message : error)}`);
      process.exit(1);
    }

    const startedAt = Date.now();
    const sourceFiles = args.pwFiles.length > 0 ? args.pwFiles : listPlaywrightSpecFiles(args.includeAllSpecs);
    let expandedTargets = attachPlaywrightMetadata(expandPlaywrightTargets(sourceFiles), sourceFiles, args);
    if (args.pwGrep) {
      const matchesGrep = buildGrepMatcher(args.pwGrep);
      expandedTargets = expandedTargets.filter(matchesGrep);
      if (expandedTargets.length === 0) {
        throw new Error(`No isolated test targets matched --pw-grep=${args.pwGrep}`);
      }
    }
    if (args.excludeMarketMaker) {
      expandedTargets = expandedTargets.filter(entry => !entry.requireMarketMaker);
      if (expandedTargets.length === 0) {
        throw new Error('No isolated test targets remain after --exclude-market-maker');
      }
    }
    if (args.marketMakerOnly) {
      expandedTargets = expandedTargets.filter(entry => entry.requireMarketMaker);
      if (expandedTargets.length === 0) {
        throw new Error('No isolated test targets remain after --market-maker-only');
      }
    }
    if (args.qaCategory) {
      expandedTargets = expandedTargets.filter((entry) => entry.testCategory === args.qaCategory);
      if (expandedTargets.length === 0) {
        throw new Error(`No isolated test targets matched --qa-category=${args.qaCategory}`);
      }
    }
    if (args.batchFiles) {
      expandedTargets = batchPlaywrightTargetsByFile(expandedTargets);
    }
    const totalTargetCount = expandedTargets.length;
    if (args.startAt >= totalTargetCount) {
      throw new Error(`E2E_START_AT_OUT_OF_RANGE:${args.startAt}:${totalTargetCount}`);
    }
    expandedTargets = expandedTargets.slice(args.startAt);
    const tasks: RunTask[] = expandedTargets.map((entry, index) => ({
      shard: args.startAt + index,
      totalShards: totalTargetCount,
      pwTargets: [entry.target],
      requireMarketMaker: entry.requireMarketMaker,
      requireCustody: entry.requireCustody,
      usePlaywrightShard: false,
      scenario: entry.scenario,
      title: entry.title,
      grep: entry.grep,
      tags: entry.tags ?? [],
      testCategory: entry.testCategory ?? (() => { throw new Error(`QA_TEST_CATEGORY_MISSING:${entry.target}:${entry.title ?? ''}`); })(),
    }));
    assertE2EShardPortsIsolated(args.basePort, totalTargetCount);
    writeFileSync(
      join(logsDir, 'targets.json'),
      JSON.stringify(
        tasks.map(task => ({
          shard: task.shard,
          target: task.pwTargets[0],
          title: task.title || task.pwTargets[0],
          handle: deriveQaTestHandle(task.pwTargets[0], task.title || task.pwTargets[0]),
          description: deriveQaTestDescription(task.pwTargets[0], task.title || task.pwTargets[0]),
          scenario: task.scenario,
          requireMarketMaker: task.requireMarketMaker,
          requireCustody: task.requireCustody,
          grep: task.grep,
          tags: task.tags,
          testCategory: task.testCategory,
        })),
        null,
        2,
      ),
    );
    console.log(
      `Targets  : ${tasks.length}/${totalTargetCount} isolated test stack${tasks.length === 1 ? '' : 's'} ` +
      `(starting at ${args.startAt})`,
    );

    const maxConcurrency = Math.max(1, Math.min(args.shards, tasks.length));
    console.log(`Build    : ${buildArtifacts.cacheRoot}`);
    const resetLimiter = createAsyncLimiter(Math.max(1, Math.min(args.maxResetConcurrency, maxConcurrency)));
    const results: Array<RunResult | undefined> = new Array(tasks.length);
    const claimed = new Array<boolean>(tasks.length).fill(false);
    const abortController = new AbortController();
    let claimedCount = 0;
    let activeMarketMakerTasks = 0;
    let failureState = initialE2ERunFailureState();
    const claimTask = async (): Promise<{ taskIndex: number; task: RunTask } | null> => {
      if (abortController.signal.aborted) return null;
      while (claimedCount < tasks.length) {
        if (abortController.signal.aborted) return null;
        const prioritizedMarketMakerIndex = activeMarketMakerTasks < args.maxMmConcurrency
          ? tasks.findIndex((task, index) => !claimed[index] && task.requireMarketMaker)
          : -1;
        const plainTaskIndex = tasks.findIndex((task, index) => !claimed[index] && !task.requireMarketMaker);
        const taskIndex = prioritizedMarketMakerIndex >= 0 ? prioritizedMarketMakerIndex : plainTaskIndex;
        if (taskIndex >= 0) {
          const task = tasks[taskIndex];
          if (!task) throw new Error(`E2E_TASK_MISSING: index=${taskIndex}`);
          claimed[taskIndex] = true;
          claimedCount += 1;
          if (task.requireMarketMaker) activeMarketMakerTasks += 1;
          return { taskIndex, task };
        }
        await delay(250);
      }
      return null;
    };
    const runWorker = async (): Promise<void> => {
      while (true) {
        const claim = await claimTask();
        if (!claim) break;
        try {
          const result = await runShard(
            claim.task,
            args,
            logsDir,
            buildArtifacts,
            resetLimiter,
            abortController.signal,
          );
          try {
            codeDriftGuard.assertStable();
          } catch (error) {
            if (!abortController.signal.aborted) abortController.abort();
            throw error;
          }
          results[claim.taskIndex] = result;
          const failureAdvance = advanceE2ERunFailureState(failureState, result, args.maxFailures);
          failureState = failureAdvance.state;
          if (failureAdvance.shouldAbort && !abortController.signal.aborted) {
            const primaryFailure = failureState.primaryFailure;
            if (!primaryFailure) throw new Error('E2E_PRIMARY_FAILURE_IDENTITY_MISSING');
              console.error(
                `❌ max failures reached (${failureState.failedCount}/${args.maxFailures}); ` +
                `primary shard=${primaryFailure.shard}; aborting active E2E stacks immediately`,
              );
              abortController.abort(createE2EGlobalFailFastAbortReason(primaryFailure));
          }
        } finally {
          if (claim.task.requireMarketMaker) activeMarketMakerTasks = Math.max(0, activeMarketMakerTasks - 1);
        }
      }
    };
    await Promise.all(Array.from({ length: maxConcurrency }, () => runWorker()));
    codeDriftGuard.assertStable(true);
    const endCodeFingerprint = computeCodeFingerprint();
    assertE2ECodeFingerprintStable(codeFingerprint.codeHash, endCodeFingerprint.codeHash);
    const totalMs = Date.now() - startedAt;
    const completedResults = results.filter((result): result is RunResult => Boolean(result));
    const failed = completedResults.filter(r => r.status === 'failed');
    const manifest = writeRunManifest(
      logsDir,
      args,
      completedResults,
      tasks,
      totalMs,
      startedAt,
      codeFingerprint,
      failureState.primaryFailure,
    );
    publishQaRunIfConfigured(logsDir);

    console.log('\n' + '='.repeat(72));
    console.log('E2E Summary');
    console.log('='.repeat(72));
    for (const r of completedResults.sort((a, b) => a.shard - b.shard)) {
      const sec = (r.durationMs / 1000).toFixed(1);
      const p = r.phaseMs;
      const shardManifest = manifest.shards.find(shard => shard.shard === r.shard);
      const browserHealth = shardManifest?.browserHealth ?? null;
      console.log(
        `${r.status === 'passed' ? 'PASS' : r.status === 'cancelled' ? 'CANCEL' : 'FAIL'}  ` +
          `shard=${r.shard}  ${sec.padStart(8)}s  ` +
          `phases[pre=${p.preflight} anvil=${p.anvilBoot} api=${p.apiBoot} health=${p.apiHealthy} vite=${p.viteBoot} pw=${p.playwright}]  ` +
          `${r.status === 'failed' ? `class=${shardManifest?.failureClass ?? 'unknown'}  ` : ''}` +
          `log=${r.logPath}`,
      );
      if (browserHealth?.issueCount) {
        console.log(
          `      browser: errors=${browserHealth.errorCount} warnings=${browserHealth.warningCount} ` +
            `network=${browserHealth.networkFailureCount} http=${browserHealth.httpErrorCount}`,
        );
      }
      if (shardManifest?.failureCapsule) {
        const capsule = shardManifest.failureCapsule;
        console.log(
          `      first-failure: ${capsule.file}:${capsule.line}:${capsule.column} ${capsule.title}`,
        );
        console.log(`      rerun: ${capsule.rerunCommand}`);
        if (shardManifest.failureCapsuleRelativePath) {
          console.log(`      capsule: ${resolve(logsDir, shardManifest.failureCapsuleRelativePath)}`);
        }
        for (const attachment of capsule.attachments) {
          if (attachment.path) console.log(`      attachment[${attachment.name}]: ${attachment.path}`);
        }
      }
      const steps = parseStepTimings(r.logPath)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 8);
      if (steps.length > 0) {
        console.log(`      slow-steps: ${steps.map(s => `${s.label}=${s.ms}ms`).join(' | ')}`);
      }
    }
    console.log('-'.repeat(72));
    console.log(`Total wall time: ${(totalMs / 1000).toFixed(1)}s (${totalMs}ms)`);
    console.log(`Git HEAD: ${codeFingerprint.gitHead ?? 'unknown'}`);
    console.log(`Code hash: ${codeFingerprint.codeHash}`);
    console.log(`Build input hash: ${codeFingerprint.buildInputHash}`);
    console.log(`Logs: ${logsDir}`);
    if (failureState.primaryFailure) {
      console.log(
        `Primary failure: shard=${failureState.primaryFailure.shard} ` +
        `class=${failureState.primaryFailure.resultClass}`,
      );
    }
    printBenchmarkComparison(manifest.benchmark);

    if (failed.length > 0) {
      for (const f of failed) {
        console.log(`\n--- shard ${f.shard} (tail: ${f.logPath}) ---`);
        console.log(tailLog(f.logPath, 80));
      }
      process.exit(1);
    }

    try {
      assertE2EBrowserHealthGate(manifest.browserHealth, args.strictBrowserHealth);
    } catch (error) {
      console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }

    process.exit(0);
  } finally {
    releaseRunnerLock();
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error('E2E isolated parallel runner failed:', (err as Error).message);
    process.exit(1);
  });
}
