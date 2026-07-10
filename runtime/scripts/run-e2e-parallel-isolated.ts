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
 */

import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
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
import { basename, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
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
import type {
  QaArtifact,
  QaArtifactKind,
  QaBrowserIssue,
  QaRunManifest,
  QaScenarioMetadata,
  QaSlowStep,
} from '../qa/types';
import { assertMinDiskFree } from '../orchestrator/storage-monitor';
import { compareStableText } from '../serialization-utils';
import { sanitizeChildProcessEnv } from '../child-process-env';
import { findFirstRuntimeFatalLogHit, findRuntimeFatalLogLines, tailLog } from './e2e-fatal-log-monitor';
import { cleanupTestArtifactsBeforeRun } from './test-artifact-cleanup';

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
  pwGrep?: string | undefined;
  pwProject?: string | undefined;
  pwFiles: string[];
  includeAllSpecs: boolean;
  excludeMarketMaker: boolean;
  marketMakerOnly: boolean;
  skipBuild: boolean;
  prewaitHealth: 'reset' | 'http' | 'full';
};

type RunResult = {
  shard: number;
  status: 'passed' | 'failed';
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
};

type ManagedChildProcess = ChildProcessByStdio<null, Readable, Readable>;
type JsonRecord = Record<string, unknown>;
type HealthPayload = JsonRecord;
const RESET_CONFIRMATION = 'RESET_MESH_STATE';

type QaCodeFingerprint = {
  gitHead: string | null;
  gitBranch: string | null;
  gitStatus: string;
  dirty: boolean;
  codeHash: string;
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

const computeCodeFingerprint = (): QaCodeFingerprint => {
  const gitHead = spawnText('git', ['rev-parse', 'HEAD']) || null;
  const gitBranch = spawnText('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || null;
  const gitStatus = spawnText('git', ['status', '--short', '--untracked-files=all']);
  const sourceRaw = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: process.cwd(),
    env: sanitizeChildProcessEnv(process.env),
    stdio: 'pipe',
    encoding: 'buffer',
  });
  if (sourceRaw.status !== 0) {
    throw new Error(`GIT_LS_FILES_FAILED:${String(sourceRaw.stderr || '').trim()}`);
  }
  const files = Buffer.from(sourceRaw.stdout)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort(compareStableText);
  const hash = createHash('sha256');
  let trackedBytes = 0;
  for (const file of files) {
    const absolutePath = resolve(process.cwd(), file);
    if (!existsSync(absolutePath)) continue;
    const data = readFileSync(absolutePath);
    trackedBytes += data.length;
    hash.update(file);
    hash.update('\0');
    hash.update(data);
    hash.update('\0');
  }
  return {
    gitHead,
    gitBranch,
    gitStatus,
    dirty: gitStatus.length > 0,
    codeHash: hash.digest('hex'),
    computedAt: Date.now(),
    trackedFileCount: files.length,
    trackedBytes,
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

const readChildPerf = (name: string, pid: number | undefined): QaPerfChildSample | null => {
  if (!pid || pid <= 0) return null;
  const result = spawnSync('ps', ['-p', String(pid), '-o', '%cpu=,%mem=,rss='], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const parts = String(result.stdout || '').trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return {
    name,
    pid,
    cpuPct: parts[0]!,
    memPct: parts[1]!,
    rssKb: parts[2]!,
  };
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
      children: getChildren()
        .map(child => readChildPerf(child.name, child.pid))
        .filter((child): child is QaPerfChildSample => child !== null),
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
  drain: () => Promise<void>;
};

const createAsyncLimiter = (limit: number): AsyncLimiter => {
  const maxActive = Math.max(1, Math.floor(limit));
  let active = 0;
  let queued = 0;
  const queue: Array<() => void> = [];
  const drainWaiters: Array<() => void> = [];
  const notifyDrain = (): void => {
    if (active > 0 || queued > 0) return;
    while (drainWaiters.length > 0) drainWaiters.shift()?.();
  };

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
      notifyDrain();
    }
  };

  const drain = async (): Promise<void> => {
    if (active === 0 && queued === 0) return;
    await new Promise<void>(resolve => drainWaiters.push(resolve));
  };

  return { run, drain };
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
  const testTimeoutRaw = Number(getFlag('test-timeout-ms') || (longMode ? '1200000' : '360000'));
  const phaseWarnRaw = Number(getFlag('phase-warn-ms') || '30000');
  const maxFailuresRaw = Number(getFlag('max-failures') || '1');
  const maxMmConcurrencyRaw = Number(getFlag('max-mm-concurrency') || String(Math.min(2, shardsRaw || defaultShards)));
  const maxResetConcurrencyRaw = Number(getFlag('max-reset-concurrency') || String(Math.min(4, shardsRaw || defaultShards)));
  const workersPerShardRaw = Number(getFlag('workers-per-shard') || '1');
  const videoRaw = String(getFlag('video') || 'on').toLowerCase();
  const traceRaw = String(getFlag('trace') || 'on-first-retry').toLowerCase();
  const screenshotRaw = String(getFlag('screenshot') || 'only-on-failure').toLowerCase();
  const reporterRaw = String(getFlag('reporter') || 'line').toLowerCase();
  const pwFilesRaw = getFlag('pw-files') || '';
  const pwFiles = (() => {
    const trimmed = pwFilesRaw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String).map(s => s.trim()).filter(Boolean);
      } catch (error) {
        throw new Error(`--pw-files JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  })();

  const coerceVideo = (mode: string): CliArgs['videoMode'] =>
    mode === 'off' || mode === 'retain-on-failure' || mode === 'on-first-retry' ? mode : 'on';
  const coerceTrace = (mode: string): CliArgs['traceMode'] =>
    mode === 'off' || mode === 'on' || mode === 'retain-on-failure' ? mode : 'on-first-retry';
  const coerceScreenshot = (mode: string): CliArgs['screenshotMode'] =>
    mode === 'off' || mode === 'on' ? mode : 'only-on-failure';
  const coerceReporter = (mode: string): CliArgs['reporter'] => (mode === 'list' || mode === 'dot' ? mode : 'line');
  const pwGrep = getFlag('pw-grep');
  const pwProject = getFlag('pw-project');
  const prewaitHealthRaw = String(getFlag('prewait-health') || 'reset').trim().toLowerCase();

  return {
    shards: Number.isFinite(shardsRaw) && shardsRaw > 0 ? Math.floor(shardsRaw) : 2,
    basePort: Number.isFinite(basePortRaw) && basePortRaw > 0 ? Math.floor(basePortRaw) : 20000,
    stackTimeoutMs: Number.isFinite(stackTimeoutRaw) && stackTimeoutRaw > 0 ? Math.floor(stackTimeoutRaw) : 180000,
    testTimeoutMs:
      Number.isFinite(testTimeoutRaw) && testTimeoutRaw > 0 ? Math.floor(testTimeoutRaw) : longMode ? 1200000 : 360000,
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
    pwGrep,
    pwProject,
    pwFiles,
    includeAllSpecs: hasFlag('all') || hasFlag('include-all') || process.env['E2E_ALL'] === '1',
    excludeMarketMaker: hasFlag('exclude-market-maker') || hasFlag('no-market-maker-heavy'),
    marketMakerOnly: hasFlag('market-maker-only') || hasFlag('only-market-maker-heavy'),
    skipBuild: args.includes('--skip-build'),
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
        } catch {}
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
      } catch {}
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
  let scannedLines = 0;
  const scan = (): void => {
    if (stopped) return;
    const hit = findFirstRuntimeFatalLogHit(logPath, scannedLines);
    if (hit) {
      stopped = true;
      onFatal(
        `E2E_FATAL_RUNTIME_LOG marker=${hit.pattern} file=${logPath} line=${hit.lineNumber}\n` +
        `${hit.lineNumber}: ${hit.line}\n` +
        `--- last 80 lines (${logPath}) ---\n${tailLog(logPath, 80)}`,
      );
      return;
    }
    try {
      scannedLines = readFileSync(logPath, 'utf8').split('\n').length;
    } catch {
      scannedLines = 0;
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
  const resultsDir = join(logsDir, `test-results-shard-${shard}`);
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

  const dir = join(logsDir, `test-results-shard-${shard}`, 'qa-cues');
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

const readShardLastRunStatus = (logsDir: string, shard: number): 'passed' | 'failed' | 'unknown' => {
  const lastRunPath = join(logsDir, `test-results-shard-${shard}`, '.last-run.json');
  if (!existsSync(lastRunPath)) return 'unknown';
  try {
    const parsed = JSON.parse(readFileSync(lastRunPath, 'utf8')) as { status?: unknown };
    return parsed.status === 'passed' || parsed.status === 'failed' ? parsed.status : 'unknown';
  } catch {
    return 'unknown';
  }
};

const shardBrowserEventsPath = (logsDir: string, shard: number): string =>
  join(logsDir, `browser-events-shard-${shard}.jsonl`);

const readShardBrowserIssues = (logsDir: string, shard: number): QaBrowserIssue[] => {
  const eventsPath = shardBrowserEventsPath(logsDir, shard);
  if (!existsSync(eventsPath)) return [];
  const events = readFileSync(eventsPath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  return normalizeQaBrowserIssues(events).slice(0, 200);
};

const readShardTitle = (logsDir: string, shard: number): string | null => {
  const resultsDir = join(logsDir, `test-results-shard-${shard}`);
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
  totalMs: number,
  createdAt: number,
  codeFingerprint: QaCodeFingerprint,
): QaRunManifest => {
  const shards = results
    .slice()
    .sort((a, b) => a.shard - b.shard)
    .map(result => {
      const timelineSteps = parseStepTimings(result.logPath).slice(0, 80);
      const slowSteps = timelineSteps.slice().sort((a, b) => b.ms - a.ms).slice(0, 12);
      writeShardCueArtifacts(logsDir, result.shard, timelineSteps);
      const artifacts = collectShardArtifacts(logsDir, result.shard);
      const browserIssues = readShardBrowserIssues(logsDir, result.shard);
      const lastRunStatus = readShardLastRunStatus(logsDir, result.shard);
      const status = lastRunStatus === 'unknown' ? result.status : lastRunStatus;
      const logTail = redactQaSecretText(tailLog(result.logPath));
      const error = result.error ? redactQaSecretText(result.error) : null;
      return {
        shard: result.shard,
        status,
        durationMs: result.durationMs,
        handle: deriveQaTestHandle(result.target, result.title),
        description: deriveQaTestDescription(result.target, result.title),
        scenario: result.scenario,
        target: result.target,
        title: result.title || readShardTitle(logsDir, result.shard),
        requireMarketMaker: result.requireMarketMaker,
        requireCustody: result.requireCustody,
        error,
        failureClass: classifyQaShardFailure({ status, error, logTail, browserIssues }),
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
    }) as unknown as QaRunManifest['shards'];
  const passedShards = shards.filter(shard => shard.status === 'passed').length;
  const failedShards = shards.filter(shard => shard.status === 'failed').length;
  const status: QaRunManifest['status'] = failedShards > 0 ? 'failed' : 'passed';
  let manifest: QaRunManifest = applyQaRunSeverity({
    manifestVersion: 3,
    runId: logsDir.split('/').at(-1) || logsDir,
    createdAt,
    completedAt: Date.now(),
    status,
    totalMs,
    code: codeFingerprint,
    perf: summarizePerfSamples(shards.flatMap(shard => shard.perf?.samples ?? [])),
    browserHealth: summarizeQaRunBrowserHealth({ shards }),
    totalShards: shards.length,
    passedShards,
    failedShards,
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
    },
    shards,
  } as unknown as QaRunManifest);
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

const waitForProcessExit = async (proc: ManagedChildProcess, timeoutMs: number): Promise<boolean> => {
  if (proc.exitCode !== null) return true;
  return await new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('exit', onExit);
      proc.off('close', onClose);
      resolve(value);
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(proc.exitCode !== null), timeoutMs);
    proc.once('exit', onExit);
    proc.once('close', onClose);
  });
};

const stopProcess = async (proc: ManagedChildProcess | null, termTimeoutMs = 1200): Promise<void> => {
  if (!proc || proc.exitCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    return;
  }
  const exitedAfterTerm = await waitForProcessExit(proc, termTimeoutMs);
  if (exitedAfterTerm || proc.exitCode !== null) return;
  try {
    proc.kill('SIGKILL');
  } catch {
    return;
  }
  await waitForProcessExit(proc, 1200);
};

const stopShardRuntimePorts = async (
  apiPort: number,
  log: ReturnType<typeof createWriteStream>,
): Promise<void> => {
  await freePort(apiPort, log);
  await freePort(apiPort + 10, log);
  await freePort(apiPort + 11, log);
  await freePort(apiPort + 12, log);
  await freePort(apiPort + 13, log);
};

const pidsOnPort = (port: number, log?: ReturnType<typeof createWriteStream>): number[] => {
  const res = spawnSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 2_000,
    killSignal: 'SIGKILL',
  });
  if (res.error) {
    log?.write(`[preflight] lsof tcp:${port} failed: ${res.error.message}\n`);
    return [];
  }
  const text = String(res.stdout || '').trim();
  if (!text) return [];
  return text
    .split(/\s+/)
    .map(v => Number(v))
    .filter(v => Number.isFinite(v) && v > 0);
};

const freePort = async (port: number, log?: ReturnType<typeof createWriteStream>): Promise<void> => {
  const first = pidsOnPort(port, log).filter(pid => pid !== process.pid);
  if (first.length === 0) return;

  log?.write(`[preflight] port ${port} busy by pids=${first.join(',')} -> SIGTERM\n`);
  for (const pid of first) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  await delay(300);

  const second = pidsOnPort(port, log).filter(pid => pid !== process.pid);
  if (second.length > 0) {
    log?.write(`[preflight] port ${port} still busy by pids=${second.join(',')} -> SIGKILL\n`);
    for (const pid of second) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await delay(150);
  }

  const remain = pidsOnPort(port, log).filter(pid => pid !== process.pid);
  if (remain.length > 0) {
    throw new Error(`Port ${port} still in use after cleanup: ${remain.join(',')}`);
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
    } catch {}
  }
  await delay(1_000);
  for (const pid of unique) {
    if (!pidIsAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  await delay(250);
};

const reapStaleIsolatedE2EProcesses = async (currentLogsDir: string): Promise<void> => {
  const marker = `${resolve(process.cwd(), '.logs', 'e2e-parallel')}/`;
  const currentMarker = `${currentLogsDir}/`;
  const stalePids = readProcessTable()
    .filter(({ command }) => command.includes(marker) && !command.includes(currentMarker))
    .filter(
      ({ command }) =>
        command.includes('runtime/orchestrator/orchestrator.ts') ||
        command.includes('runtime/orchestrator/hub-node.ts') ||
        command.includes('runtime/orchestrator/mm-node.ts') ||
        command.includes(' --state ') ||
        command.includes('vite-cache-shard-'),
    )
    .map(({ pid }) => pid);
  await killPids(stalePids, 'isolated e2e process(es)');
};

const fetchWithTimeout = async (url: string, init: RequestInit = {}, timeoutMs = 2_000): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
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

const waitForRpcReady = async (rpcUrl: string, timeoutMs: number, expectedChainId: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(
        rpcUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
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
      lastError = formatErrorForLog(error);
      // retry
    }
    await delay(200);
  }
  throw new Error(`RPC_NOT_READY rpc=${rpcUrl} expectedChainId=${expectedChainId} timeoutMs=${timeoutMs} last=${lastError || 'none'}`);
};

const waitForHttpReady = async (url: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(url, {}, 2_000);
      if (res.status < 500) return;
      lastError = `status=${res.status}`;
    } catch (error) {
      lastError = formatErrorForLog(error);
      // retry
    }
    await delay(250);
  }
  throw new Error(`HTTP_ENDPOINT_NOT_READY url=${url} timeoutMs=${timeoutMs} last=${lastError || 'none'}`);
};

const waitForServerHealthy = async (
  apiUrl: string,
  timeoutMs: number,
  requireMarketMaker = false,
  requireCustody = false,
): Promise<HealthPayload> => {
  const deadline = Date.now() + timeoutMs;
  let lastHealth: HealthPayload | null = null;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(`${apiUrl}/api/health`, {}, 2_000);
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
      lastError = formatErrorForLog(error);
      // retry
    }
    await delay(250);
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
      signal: controller.signal,
    });
    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {}
      throw new Error(`SHARD_BASELINE_RESET_FAILED status=${response.status} body=${body.slice(0, 800)}`);
    }
    const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));
    return await waitForServerHealthy(apiUrl, remainingMs, requireMarketMaker, requireCustody);
  } catch (error) {
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

const waitForHttpsReady = async (url: string, timeoutMs: number): Promise<void> => {
  // Use curl -k for self-signed local certs.
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const p = spawn('curl', ['-k', '-sSf', url], { stdio: 'ignore' });
      p.once('exit', code => resolve(code === 0));
      p.once('error', error => {
        lastError = formatErrorForLog(error);
        resolve(false);
      });
    });
    if (ok) return;
    if (!lastError) lastError = 'curl_exit_nonzero';
    await delay(250);
  }
  throw new Error(`HTTPS_ENDPOINT_NOT_READY url=${url} timeoutMs=${timeoutMs} last=${lastError || 'none'}`);
};

const runCmd = async (
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
): Promise<number | null> => {
  const proc = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeChildProcessEnv(opts.env ?? process.env),
    cwd: opts.cwd,
  });
  if (proc.pid) opts.onSpawn?.(proc.pid);

  proc.stdout.on('data', chunk => opts.log?.write(chunk.toString()));
  proc.stderr.on('data', chunk => opts.log?.write(chunk.toString()));

  let abortKillTimer: ReturnType<typeof setTimeout> | null = null;
  const abortChild = (): void => {
    opts.log?.write(`[runner] aborting child pid=${proc.pid ?? 'unknown'} cmd=${cmd}\n`);
    try {
      if (proc.exitCode === null) proc.kill('SIGTERM');
    } catch {}
    abortKillTimer = setTimeout(() => {
      try {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      } catch {}
    }, 1500);
  };
  if (opts.signal?.aborted) abortChild();
  opts.signal?.addEventListener('abort', abortChild, { once: true });

  const timeout = opts.timeoutMs
    ? setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, opts.timeoutMs)
    : null;

  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    proc.once('error', rejectExit);
    proc.once('exit', resolveExit);
  });
  if (timeout) clearTimeout(timeout);
  if (abortKillTimer) clearTimeout(abortKillTimer);
  opts.signal?.removeEventListener('abort', abortChild);
  opts.onExit?.();
  return code;
};

const fetchJsonWithTimeout = async (url: string, timeoutMs = 2000): Promise<unknown | null> => {
  try {
    const response = await fetchWithTimeout(url, {}, timeoutMs);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
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

  const shardOutDir = resolve(frontendRoot, '.svelte-kit-e2e', basename(logsDir), `shard-${shard}`);
  materializeSvelteKitShardOutDir(sourceOutDir, shardOutDir);

  const outDirForFrontend = relative(frontendRoot, shardOutDir);
  const linkedEntries = readdirSync(shardOutDir, { withFileTypes: true })
    .filter(entry => lstatSync(join(shardOutDir, entry.name)).isSymbolicLink())
    .length;
  log.write(`[runner] shard-local SvelteKit output: ${outDirForFrontend} (${linkedEntries} linked entries)\n`);
  return outDirForFrontend;
};

const prepareE2eSvelteKitSourceOutDir = (logsDir: string): string => {
  const frontendRoot = resolve(process.cwd(), 'frontend');
  const buildOutDir = resolve(frontendRoot, '.svelte-kit');
  const buildManifest = join(buildOutDir, 'output', 'server', 'manifest.js');
  if (!existsSync(buildManifest)) {
    throw new Error(`E2E_SVELTE_KIT_OUTPUT_MISSING:${buildManifest}`);
  }

  const runOutRoot = resolve(frontendRoot, '.svelte-kit-e2e', basename(logsDir));
  const sourceOutDir = join(runOutRoot, 'source');
  rmSync(runOutRoot, { recursive: true, force: true });
  cpSync(buildOutDir, sourceOutDir, { recursive: true });

  const sourceManifest = join(sourceOutDir, 'output', 'server', 'manifest.js');
  if (!existsSync(sourceManifest)) {
    throw new Error(`E2E_SVELTE_KIT_SNAPSHOT_FAILED:${sourceManifest}`);
  }
  return sourceOutDir;
};

const FAILURE_RECEIPT_DUMP_TIMEOUT_MS = 2_000;
const FAILURE_RECEIPT_DUMP_MAX_RUNTIMES = 10;

const captureShardFailureForensics = async (options: {
  logsDir: string;
  shard: number;
  apiUrl: string;
  log: ReturnType<typeof createWriteStream>;
}): Promise<void> => {
  const outputDir = join(options.logsDir, `test-results-shard-${options.shard}`, 'failure-debug');
  mkdirSync(outputDir, { recursive: true });

  const health = await fetchJsonWithTimeout(`${options.apiUrl}/api/health`);
  if (health) {
    writeFileSync(join(outputDir, 'health.json'), JSON.stringify(health, null, 2));
  }

  const entities = await fetchJsonWithTimeout(`${options.apiUrl}/api/debug/entities?limit=5000`);
  if (entities) {
    writeFileSync(join(outputDir, 'entities.json'), JSON.stringify(entities, null, 2));
  }

  const events = await fetchJsonWithTimeout(`${options.apiUrl}/api/debug/events?last=500`);
  if (events) {
    writeFileSync(join(outputDir, 'events.json'), JSON.stringify(events, null, 2));
  }

  const entityEntries = Array.isArray((entities as { entities?: unknown })?.entities)
    ? (entities as { entities: Array<Record<string, unknown>> }).entities
    : [];

  const receiptTargets = Array.from(new Map(entityEntries.map(entry => {
    const runtimeId = typeof entry['runtimeId'] === 'string' ? entry['runtimeId'].trim() : '';
    const dbPath = typeof entry['dbPath'] === 'string' ? entry['dbPath'].trim() : '';
    const entityId = typeof entry['entityId'] === 'string' ? entry['entityId'].trim().toLowerCase() : 'unknown';
    return [`${runtimeId}\0${dbPath}`, { runtimeId, dbPath, entityId }] as const;
  }).filter(([, target]) => target.runtimeId && target.dbPath)).values())
    .slice(0, FAILURE_RECEIPT_DUMP_MAX_RUNTIMES);

  for (const { runtimeId, dbPath, entityId } of receiptTargets) {
    const receiptDump = spawnSync(
      'bun',
      ['runtime/scripts/read-frame-receipts.ts', '--runtime-id', runtimeId, '--tail', '20', '--json'],
      {
        cwd: process.cwd(),
        env: sanitizeChildProcessEnv({
          ...process.env,
          XLN_DB_PATH: dbPath,
        }),
        encoding: 'utf8',
        timeout: FAILURE_RECEIPT_DUMP_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );

    if (receiptDump.status === 0 && receiptDump.stdout) {
      writeFileSync(join(outputDir, `receipts-${entityId.slice(-8)}.json`), receiptDump.stdout);
      continue;
    }

    const failure = String(
      receiptDump.error?.message
      || receiptDump.stderr
      || `exit=${String(receiptDump.status)} signal=${String(receiptDump.signal)}`,
    ).trim();
    writeFileSync(join(outputDir, `receipts-${entityId.slice(-8)}.error.txt`), failure);
  }

  options.log.write(`[forensics] wrote failure debug bundle: ${outputDir}\n`);
};

const runShard = async (
  task: RunTask,
  args: CliArgs,
  logsDir: string,
  svelteKitSourceOutDir: string,
  resetLimiter: AsyncLimiter,
  signal?: AbortSignal,
): Promise<RunResult> => {
  const shard = task.shard;
  const totalShards = task.totalShards;
  const startedAt = Date.now();
  const logPath = join(logsDir, `e2e-shard-${String(shard).padStart(2, '0')}.log`);
  const log = createWriteStream(logPath, { flags: 'w' });

  let anvil: ManagedChildProcess | null = null;
  let anvil2: ManagedChildProcess | null = null;
  let api: ManagedChildProcess | null = null;
  let vite: ManagedChildProcess | null = null;
  let playwrightPid: number | undefined;
  let teardownReason: string | null = null;
  const shardAbortController = new AbortController();
  const forwardOuterAbort = (): void => shardAbortController.abort();
  signal?.addEventListener('abort', forwardOuterAbort, { once: true });
  if (signal?.aborted) shardAbortController.abort();
  let stopFatalMonitor: (() => void) | null = null;
  const rpcPort = args.basePort + shard * 20 + 0;
  const rpc2Port = args.basePort + shard * 20 + 1;
  const apiPort = args.basePort + shard * 20 + 2;
  const webPort = args.basePort + shard * 20 + 4;
  const custodyPort = args.basePort + shard * 20 + 7;
  const custodyDaemonPort = args.basePort + shard * 20 + 8;
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const rpc2Url = `http://127.0.0.1:${rpc2Port}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `https://localhost:${webPort}`;
  const dbPath = join(logsDir, `db-e2e-shard-${shard}`);
  const runtimeImportManifestPath = join(dbPath, 'runtime-import-manifest.json');
  // Keep anvil's live state outside orchestrator dbRoot. Reset intentionally rm -rf's dbRoot.
  const anvilStatePath = join(logsDir, `anvil-state-shard-${shard}.json`);
  const anvil2StatePath = join(logsDir, `anvil2-state-shard-${shard}.json`);
  mkdirSync(dbPath, { recursive: true });
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
  const finishResult = (result: Omit<RunResult, 'perf'>): RunResult => {
    const perf = perfStopped ? emptyPerfSummary() : perfMonitor.stop();
    perfStopped = true;
    return { ...result, perf };
  };

  try {
    stopFatalMonitor = startFailFastLogMonitor(logPath, (message) => {
      if (!teardownReason) teardownReason = message;
      log.write(`[runner] fail-fast monitor hit -> aborting shard\n${message}\n`);
      shardAbortController.abort();
      for (const child of [api, vite, anvil, anvil2]) {
        try {
          if (child?.exitCode === null) child.kill('SIGTERM');
        } catch {}
      }
    });
    log.write(`shard=${shard}/${totalShards}\nrpc=${rpcUrl}\nrpc2=${rpc2Url}\napi=${apiUrl}\nweb=${webUrl}\ndb=${dbPath}\n\n`);
    throwIfAborted();

    // Hard preflight: kill stale processes that kept shard ports occupied
    // from previous crashed/aborted runs.
    // Layout:
    // - rpc: anvil
    // - rpc2: secondary anvil for cross-j local simulation
    // - api: production runtime/server.ts on an isolated shard port
    // - web: vite preview
    // - extra reserved ports kept for any local child APIs the server may spawn
    const preflightStart = Date.now();
    await freePort(rpcPort, log);
    await freePort(rpc2Port, log);
    await freePort(apiPort, log);
    await freePort(webPort, log);
    await freePort(apiPort + 10, log);
    await freePort(apiPort + 11, log);
    await freePort(apiPort + 12, log);
    await freePort(apiPort + 13, log);
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
        '--state',
        anvilStatePath,
        '--silent',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: sanitizeChildProcessEnv(process.env) },
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
        '--state',
        anvil2StatePath,
        '--silent',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: sanitizeChildProcessEnv(process.env) },
    );
    anvil2.stdout.on('data', c => log.write(`[anvil2] ${c.toString()}`));
    anvil2.stderr.on('data', c => log.write(`[anvil2:err] ${c.toString()}`));
    await Promise.all([
      waitForRpcReady(rpcUrl, args.stackTimeoutMs, 31337),
      waitForRpcReady(rpc2Url, args.stackTimeoutMs, 31338),
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
          XLN_JURISDICTIONS_PATH: join(dbPath, 'jurisdictions.json'),
          XLN_SKIP_STALE_REAP: '1',
          XLN_RUNTIME_IMPORT_MANIFEST_PATH: runtimeImportManifestPath,
          XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS: String(args.stackTimeoutMs),
          XLN_AUTO_PROVISION_EXTERNAL_FAUCET: process.env['XLN_AUTO_PROVISION_EXTERNAL_FAUCET'] ?? '1',
          ...(process.env['XLN_MIN_DISK_FREE_BYTES']
            ? { XLN_MIN_DISK_FREE_BYTES: process.env['XLN_MIN_DISK_FREE_BYTES'] }
            : {}),
        }),
      },
    );
    api.stdout.on('data', c => log.write(`[api] ${c.toString()}`));
    api.stderr.on('data', c => log.write(`[api:err] ${c.toString()}`));
    await waitForHttpReady(`${apiUrl}/api`, args.stackTimeoutMs);
    markPhase('apiBoot', apiStart);
    throwIfAborted();
    if (args.prewaitHealth === 'reset') {
      const resetQueuedAt = Date.now();
      await resetLimiter.run(async () => {
        const resetStartedAt = Date.now();
        const queueMs = resetStartedAt - resetQueuedAt;
        if (queueMs > 0) log.write(`[timing] resetQueue=${queueMs}ms\n`);
        throwIfAborted();
        baselineHealth = await hardResetShardBaseline(apiUrl, args.stackTimeoutMs, task.requireMarketMaker, task.requireCustody);
      });
      await resetLimiter.drain();
      const remainingHealthMs = Math.max(1_000, args.stackTimeoutMs - (Date.now() - resetQueuedAt));
      baselineHealth = await waitForServerHealthy(apiUrl, remainingHealthMs, task.requireMarketMaker, task.requireCustody);
      markPhase('apiHealthy', resetQueuedAt);
      throwIfAborted();
    } else if (args.prewaitHealth === 'full') {
      const healthStart = Date.now();
      baselineHealth = await waitForServerHealthy(apiUrl, args.stackTimeoutMs, task.requireMarketMaker, task.requireCustody);
      markPhase('apiHealthy', healthStart);
      throwIfAborted();
    } else {
      log.write('[timing] apiHealthy=0ms (prewait-health=http; baseline waits inside tests that need it)\n');
    }

    const shardViteCacheDir = join(logsDir, `vite-cache-shard-${shard}`);
    const shardSvelteKitOutDir = prepareShardSvelteKitOutDir(svelteKitSourceOutDir, logsDir, shard, log);
    const viteStart = Date.now();
    // Spawn Vite directly. `bun run preview` starts an extra child node
    // process, so killing the Bun wrapper can leave `node .../vite preview`
    // alive until the next global preflight cleanup.
    vite = spawn(
      'node',
      [
        resolve(process.cwd(), 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'),
        'preview',
        '--host',
        '0.0.0.0',
        '--port',
        String(webPort),
        '--strictPort',
      ],
      {
        cwd: resolve(process.cwd(), 'frontend'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizeChildProcessEnv({
          ...process.env,
          ANVIL_RPC: rpcUrl,
          ANVIL_RPC2: rpc2Url,
          RPC_ETHEREUM: rpcUrl,
          RPC_TRON: rpc2Url,
          VITE_DEV_PORT: String(webPort),
          VITE_API_PROXY_TARGET: apiUrl,
          VITE_CACHE_DIR: shardViteCacheDir,
          XLN_SVELTE_KIT_OUT_DIR: shardSvelteKitOutDir,
        }),
      },
    );
    vite.stdout.on('data', c => log.write(`[vite] ${c.toString()}`));
    vite.stderr.on('data', c => log.write(`[vite:err] ${c.toString()}`));
    await waitForHttpsReady(webUrl, args.stackTimeoutMs);
    markPhase('viteBoot', viteStart);
    throwIfAborted();

    const shardArg = `${shard + 1}/${totalShards}`;
    const playwrightArgs = ['playwright', 'test', '--config', 'playwright.config.ts'];
    if (task.usePlaywrightShard) {
      playwrightArgs.push('--shard', shardArg);
    }
    const grep = task.grep || args.pwGrep;
    if (grep) {
      playwrightArgs.push('--grep', grep);
    }
    if (args.pwProject) {
      playwrightArgs.push(`--project=${args.pwProject}`);
    }
    playwrightArgs.push(`--workers=${args.workersPerShard}`);
    playwrightArgs.push(`--reporter=${args.reporter}`);
    if (args.maxFailures > 0) playwrightArgs.push(`--max-failures=${args.maxFailures}`);
    for (const target of task.pwTargets) playwrightArgs.push(target);
    log.write(`[runner] playwright args: ${JSON.stringify(playwrightArgs)}\n`);

    const playwrightStart = Date.now();
    const code = await runCmd('bunx', playwrightArgs, {
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
        PW_OUTPUT_DIR: join(logsDir, `test-results-shard-${shard}`),
        E2E_BASE_URL: webUrl,
        E2E_API_BASE_URL: apiUrl,
        E2E_ANVIL_RPC: rpcUrl,
        E2E_ANVIL_RPC2: rpc2Url,
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

    if (code !== 0) {
      teardownReason = `playwright_exit_${code}`;
      await captureShardFailureForensics({
        logsDir,
        shard,
        apiUrl,
        log,
      });
      return finishResult({
        shard,
        status: 'failed',
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
      await captureShardFailureForensics({
        logsDir,
        shard,
        apiUrl,
        log,
      });
      return finishResult({
        shard,
        status: 'failed',
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

    await flushLog(log, '[runner] playwright passed; stopping api before final runtime fatal scan\n');
    await stopProcess(api, 35_000);
    await stopShardRuntimePorts(apiPort, log);
    await delay(250);
    await flushLog(log, '[runner] api stopped; scanning runtime fatal markers\n');
    const postTeardownFatalLines = findRuntimeFatalLogLines(logPath);
    const monitorFatalReason = String(teardownReason || '').startsWith('E2E_FATAL_RUNTIME_LOG')
      ? String(teardownReason)
      : null;
    if (monitorFatalReason || postTeardownFatalLines.length > 0) {
      teardownReason = monitorFatalReason ?? `E2E_FATAL_RUNTIME_LOG:\n${postTeardownFatalLines.join('\n')}`;
      await captureShardFailureForensics({
        logsDir,
        shard,
        apiUrl,
        log,
      });
      return finishResult({
        shard,
        status: 'failed',
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
    teardownReason = teardownReason || formatErrorForLog(error);
    try {
      await captureShardFailureForensics({
        logsDir,
        shard,
        apiUrl,
        log,
      });
    } catch {
      // Best effort only.
    }
    return finishResult({
      shard,
      status: 'failed',
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
      log.write('[runner] playwright passed; stopping api with runtime quiesce before teardown\n');
    }
    await stopProcess(api, 35_000);
    await stopShardRuntimePorts(apiPort, log);
    await stopProcess(vite);
    await Promise.all([stopProcess(anvil), stopProcess(anvil2)]);
    log.end();
  }
};

async function main(): Promise<void> {
  const args = parseArgs();
  cleanupTestArtifactsBeforeRun({ reason: 'e2e', scope: 'e2e', skipIfAlreadyDone: false });
  const logsDir = resolve(process.cwd(), '.logs', 'e2e-parallel', tsTag());
  const releaseRunnerLock = acquireRunnerLock(logsDir);
  mkdirSync(logsDir, { recursive: true });
  const codeFingerprint = computeCodeFingerprint();

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
  console.log(`Artifacts    : video=${args.videoMode}, trace=${args.traceMode}, screenshot=${args.screenshotMode}`);
  console.log(`Git HEAD     : ${codeFingerprint.gitHead?.slice(0, 12) ?? 'unknown'}${codeFingerprint.dirty ? ' dirty' : ''}`);
  console.log(`Code hash    : ${codeFingerprint.codeHash.slice(0, 16)}`);
  console.log(`Logs     : ${logsDir}`);
  console.log('='.repeat(72) + '\n');

  try {
    if (!args.skipBuild) {
      const buildLogPath = join(logsDir, 'build-runtime.log');
      const buildLog = createWriteStream(buildLogPath, { flags: 'w' });
      const buildCode = await runCmd('bash', ['-lc', './scripts/build-runtime.sh'], {
        env: sanitizeChildProcessEnv(process.env),
        log: buildLog,
        timeoutMs: 300000,
      });
      buildLog.write('\n=== frontend build ===\n');
      const frontendBuildCode = await runCmd('bun', ['run', 'build'], {
        cwd: resolve(process.cwd(), 'frontend'),
        env: sanitizeChildProcessEnv(process.env),
        log: buildLog,
        timeoutMs: 300000,
      });
      buildLog.end();
      if (buildCode !== 0 || frontendBuildCode !== 0) {
        console.error(`❌ prebuild failed (runtime/frontend). See log: ${buildLogPath}`);
        process.exit(1);
      }
    } else {
      console.log('⏩ skip-build enabled');
    }

    try {
      await assertRunnerPreflight();
      await reapStaleIsolatedE2EProcesses(logsDir);
    } catch (error) {
      console.error(`❌ runner preflight failed: ${String(error instanceof Error ? error.message : error)}`);
      process.exit(1);
    }

    const startedAt = Date.now();
    const sourceFiles = args.pwFiles.length > 0 ? args.pwFiles : listPlaywrightSpecFiles(args.includeAllSpecs);
    let expandedTargets = expandPlaywrightTargets(sourceFiles);
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
    const tasks: RunTask[] = expandedTargets.map((entry, index, entries) => ({
      shard: index,
      totalShards: entries.length,
      pwTargets: [entry.target],
      requireMarketMaker: entry.requireMarketMaker,
      requireCustody: entry.requireCustody,
      usePlaywrightShard: false,
      scenario: entry.scenario,
      title: entry.title,
      grep: entry.grep,
    }));
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
        })),
        null,
        2,
      ),
    );
    console.log(`Targets  : ${tasks.length} isolated test stack${tasks.length === 1 ? '' : 's'}`);

    const maxConcurrency = Math.max(1, Math.min(args.shards, tasks.length));
    const svelteKitSourceOutDir = prepareE2eSvelteKitSourceOutDir(logsDir);
    console.log(`SvelteKit: ${relative(resolve(process.cwd(), 'frontend'), svelteKitSourceOutDir)}`);
    const resetLimiter = createAsyncLimiter(Math.max(1, Math.min(args.maxResetConcurrency, maxConcurrency)));
    const results: Array<RunResult | undefined> = new Array(tasks.length);
    const claimed = new Array<boolean>(tasks.length).fill(false);
    const abortController = new AbortController();
    let claimedCount = 0;
    let activeMarketMakerTasks = 0;
    let failedCount = 0;
    const claimTask = async (): Promise<{ taskIndex: number; task: RunTask } | null> => {
      if (abortController.signal.aborted) return null;
      while (claimedCount < tasks.length) {
        if (abortController.signal.aborted) return null;
        for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
          if (claimed[taskIndex]) continue;
          const task = tasks[taskIndex];
          if (!task) continue;
          if (task.requireMarketMaker && activeMarketMakerTasks >= args.maxMmConcurrency) continue;
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
            svelteKitSourceOutDir,
            resetLimiter,
            abortController.signal,
          );
          results[claim.taskIndex] = result;
          if (result.status === 'failed' && args.maxFailures > 0) {
            failedCount += 1;
            if (failedCount >= args.maxFailures && !abortController.signal.aborted) {
              console.error(
                `❌ max failures reached (${failedCount}/${args.maxFailures}); aborting active E2E stacks immediately`,
              );
              abortController.abort();
            }
          }
        } finally {
          if (claim.task.requireMarketMaker) activeMarketMakerTasks = Math.max(0, activeMarketMakerTasks - 1);
        }
      }
    };
    await Promise.all(Array.from({ length: maxConcurrency }, () => runWorker()));
    const totalMs = Date.now() - startedAt;
    const completedResults = results.filter((result): result is RunResult => Boolean(result));
    const failed = completedResults.filter(r => r.status === 'failed');
    const manifest = writeRunManifest(logsDir, args, completedResults, totalMs, startedAt, codeFingerprint);
    publishQaRunIfConfigured(logsDir);

    console.log('\n' + '='.repeat(72));
    console.log('E2E Summary');
    console.log('='.repeat(72));
    for (const r of completedResults.sort((a, b) => a.shard - b.shard)) {
      const sec = (r.durationMs / 1000).toFixed(1);
      const p = r.phaseMs;
      const browserHealth = manifest.shards.find(shard => shard.shard === r.shard)?.browserHealth ?? null;
      console.log(
        `${r.status === 'passed' ? 'PASS' : 'FAIL'}  shard=${r.shard}  ${sec.padStart(8)}s  ` +
          `phases[pre=${p.preflight} anvil=${p.anvilBoot} api=${p.apiBoot} health=${p.apiHealthy} vite=${p.viteBoot} pw=${p.playwright}]  ` +
          `log=${r.logPath}`,
      );
      if (browserHealth?.issueCount) {
        console.log(
          `      browser: errors=${browserHealth.errorCount} warnings=${browserHealth.warningCount} ` +
            `network=${browserHealth.networkFailureCount} http=${browserHealth.httpErrorCount}`,
        );
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
    console.log(`Logs: ${logsDir}`);
    printBenchmarkComparison(manifest.benchmark);

    if (failed.length > 0) {
      for (const f of failed) {
        console.log(`\n--- shard ${f.shard} (tail: ${f.logPath}) ---`);
        console.log(tailLog(f.logPath, 80));
      }
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
