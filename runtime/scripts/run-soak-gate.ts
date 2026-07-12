#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { freemem, loadavg, totalmem } from 'node:os';
import type { Readable } from 'node:stream';
import { sanitizeChildProcessEnv } from '../server/child-process-env';

type SoakProfile = 'quick' | 'release' | 'swap' | 'mainnet';

type SoakCommand = {
  name: string;
  command: string;
  timeoutMs: number;
};

type SoakArgs = {
  profile: SoakProfile;
  iterations: number | null;
  minutes: number | null;
  intervalMs: number;
  outputPath: string;
  streamOutput: boolean;
  keepE2eRuns: number;
  minKeepE2eRuns: number;
  minFreeBytes: number;
  sampleMs: number;
};

type SoakPerfSample = {
  ts: number;
  load1: number;
  freeMemBytes: number;
  totalMemBytes: number;
  diskFreeBytes: number;
  processCpuPct: number;
  processRssKb: number;
};

type SoakPerfSummary = {
  sampleCount: number;
  peakLoad1: number;
  minFreeMemBytes: number;
  minDiskFreeBytes: number;
  maxProcessCpuPct: number;
  maxProcessRssKb: number;
  samples: SoakPerfSample[];
};

type SoakCodeFingerprint = {
  gitHead: string | null;
  gitBranch: string | null;
  gitStatus: string;
  dirty: boolean;
  codeHash: string;
  computedAt: number;
  trackedFileCount: number;
  trackedBytes: number;
};

type SoakResultEvidence = {
  passed?: boolean;
  tps?: number;
  sameTps?: number;
  crossTps?: number;
  aggregateTps?: number;
  paymentTps?: number;
  openHtlcLocks?: number;
  currentSnapshotBytes?: number;
  dbBytes?: number;
  storageTotalBytes?: number;
  storageHistoryBytes?: number;
  storageSnapshotBytes?: number;
  storageSnapshotCount?: number;
  storageLatestSnapshotHeight?: number;
  storageEpochCount?: number;
  storageLatestAccountMismatches?: number;
  storageWorstLoadMs?: number;
  storageRecoverySamples?: number;
  crashRecoveryMs?: number;
  crashRecoveredHeight?: number;
  crashRecoveredHubAccountCount?: number;
};

type SoakResult = {
  iteration: number;
  name: string;
  command: string;
  code: number | null;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  perf: SoakPerfSummary;
  evidence?: SoakResultEvidence;
  stdoutTail?: string;
  stderrTail?: string;
};

type SoakRunSummary = {
  generatedAt: string;
  complete: boolean;
  completedCases: number;
  failedCases: number;
  completedFullIterations: number;
  durationMs: number;
  disk: {
    firstFreeBytes: number | null;
    lastFreeBytes: number | null;
    minFreeBytes: number | null;
    deltaBytes: number | null;
  };
  resources: {
    peakLoad1: number;
    maxProcessCpuPct: number;
    maxProcessRssKb: number;
  };
  cases: Array<{
    name: string;
    runs: number;
    failures: number;
    minDurationMs: number;
    maxDurationMs: number;
    avgDurationMs: number;
    lastDurationMs: number;
    lastEvidence?: SoakResultEvidence;
  }>;
};

const DEFAULT_OUTPUT = join('.logs', 'soak', `soak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const DEFAULT_KEEP_E2E_RUNS = 64;
const DEFAULT_MIN_KEEP_E2E_RUNS = 4;
const DEFAULT_MIN_FREE_BYTES = 8 * 1024 ** 3;
const OUTPUT_TAIL_CHARS = 16_384;

const profileCommands: Record<SoakProfile, SoakCommand[]> = {
  quick: [
    { name: 'persistence WAL smoke', command: 'bun run test:persistence:cli', timeoutMs: 120_000 },
    { name: 'fast E2E matrix', command: 'bun run test:e2e:fast', timeoutMs: 900_000 },
  ],
  release: [
    { name: 'CI gate', command: 'bun run gate:ci', timeoutMs: 1_800_000 },
    { name: 'hub 10k storage benchmark', command: 'bun run bench:radapter:hub10k', timeoutMs: 1_200_000 },
  ],
  swap: [
    { name: 'orderbook core TPS', command: 'bun run bench:swap:orderbook', timeoutMs: 120_000 },
    { name: 'same/cross account TPS', command: 'bun run bench:swap:runtime', timeoutMs: 120_000 },
    { name: 'swap scenario TPS', command: 'bun run bench:swap:scenarios', timeoutMs: 180_000 },
  ],
  mainnet: [
    {
      name: '100-user HTLC storage recovery',
      command:
        'SOAK_DB_ROOT="${SOAK_MAINNET_DB_ROOT:-.logs/soak/db/mainnet-hub}"; ' +
        'XLN_DB_PATH="$SOAK_DB_ROOT" ' +
        'bun runtime/scripts/bench-storage-hub.ts ' +
        '--accounts 100 --payments 100 --payment-kind htlc --min-payment-tps 100 ' +
        '--persist --storage --storage-snapshot 2 --storage-epoch-mb 2 ' +
        '--import-batch 64 --open-batch 50 --payment-batch 100 --recovery-scan-step 5 ' +
        '--recovery-budget-ms 10000 --crash-recover --crash-recovery-budget-ms 10000 ' +
        '--db-root "$SOAK_DB_ROOT"',
      timeoutMs: 600_000,
    },
    {
      name: 'same/cross account swap 100 TPS',
      command: 'bun runtime/scripts/bench-swap-runtime-tps.ts --swaps 1000 --warmup 100 --min-tps 100',
      timeoutMs: 120_000,
    },
    {
      name: 'swap scenarios 100 TPS',
      command: 'bun runtime/scripts/bench-swap-scenarios-tps.ts --swaps 1000 --warmup 100 --min-tps 100',
      timeoutMs: 180_000,
    },
    {
      name: '100-user hub consensus swap 100 TPS',
      command: 'bun runtime/scripts/bench-swap-hub-consensus-tps.ts --swaps 300 --warmup 30 --min-tps 100 --batch-size 100 --users 100 --processes 2',
      timeoutMs: 240_000,
    },
  ],
};

const parseArgs = (): SoakArgs => {
  const flags = new Map<string, string | true>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const current = process.argv[index];
    if (!current) continue;
    if (!current.startsWith('--')) continue;
    const [inlineKeyRaw, inlineValue] = current.split('=', 2);
    const inlineKey = inlineKeyRaw || current;
    if (inlineValue !== undefined) {
      flags.set(inlineKey, inlineValue);
      continue;
    }
    const next = process.argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(current, true);
      continue;
    }
    flags.set(current, next);
    index += 1;
  }

  const rawProfile = String(flags.get('--profile') || 'quick');
  if (rawProfile !== 'quick' && rawProfile !== 'release' && rawProfile !== 'swap' && rawProfile !== 'mainnet') {
    throw new Error(`Invalid --profile=${rawProfile}; expected quick, release, swap, or mainnet`);
  }

  const iterationsRaw = flags.get('--iterations');
  const minutesRaw = flags.get('--minutes');
  const iterations = iterationsRaw === undefined ? (rawProfile === 'quick' ? 2 : null) : Number(iterationsRaw);
  const minutes = minutesRaw === undefined
    ? (rawProfile === 'release' ? 240 : rawProfile === 'swap' ? 10 : rawProfile === 'mainnet' ? 1440 : null)
    : Number(minutesRaw);
  if (iterations !== null && (!Number.isFinite(iterations) || iterations <= 0)) {
    throw new Error(`Invalid --iterations=${String(iterationsRaw)}`);
  }
  if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0)) {
    throw new Error(`Invalid --minutes=${String(minutesRaw)}`);
  }

  const intervalMs = Math.max(0, Math.floor(Number(flags.get('--interval-ms') || 0)));
  const outputPath = String(flags.get('--out') || DEFAULT_OUTPUT);
  const streamOutput = flags.has('--stream-output');
  const keepE2eRunsRaw = Number(flags.get('--keep-e2e-runs') || process.env['SOAK_KEEP_E2E_RUNS'] || DEFAULT_KEEP_E2E_RUNS);
  const minKeepE2eRunsRaw = Number(flags.get('--min-keep-e2e-runs') || process.env['SOAK_MIN_KEEP_E2E_RUNS'] || DEFAULT_MIN_KEEP_E2E_RUNS);
  const minFreeBytesRaw = Number(
    flags.get('--min-free-bytes')
      || process.env['SOAK_MIN_FREE_BYTES']
      || process.env['XLN_MIN_DISK_FREE_BYTES']
      || DEFAULT_MIN_FREE_BYTES,
  );
  const sampleMsRaw = Number(flags.get('--sample-ms') || process.env['SOAK_SAMPLE_MS'] || 5_000);
  return {
    profile: rawProfile,
    iterations: iterations === null ? null : Math.floor(iterations),
    minutes: minutes === null ? null : Math.floor(minutes),
    intervalMs,
    outputPath,
    streamOutput,
    keepE2eRuns: Number.isFinite(keepE2eRunsRaw) && keepE2eRunsRaw >= 0
      ? Math.floor(keepE2eRunsRaw)
      : DEFAULT_KEEP_E2E_RUNS,
    minKeepE2eRuns: Number.isFinite(minKeepE2eRunsRaw) && minKeepE2eRunsRaw >= 0
      ? Math.floor(minKeepE2eRunsRaw)
      : DEFAULT_MIN_KEEP_E2E_RUNS,
    minFreeBytes: Number.isFinite(minFreeBytesRaw) && minFreeBytesRaw > 0
      ? Math.max(Math.floor(minFreeBytesRaw), DEFAULT_MIN_FREE_BYTES)
      : DEFAULT_MIN_FREE_BYTES,
    sampleMs: Number.isFinite(sampleMsRaw) && sampleMsRaw >= 1_000
      ? Math.floor(sampleMsRaw)
      : 5_000,
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const appendTail = (tail: string, chunk: string): string =>
  `${tail}${chunk}`.slice(-OUTPUT_TAIL_CHARS);

const prefixedOutput = (iteration: number, command: SoakCommand, chunk: string): string =>
  `[soak:${iteration}:${command.name}] ${chunk}`;

const compareStableText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

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

const computeCodeFingerprint = (): SoakCodeFingerprint => {
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
    throw new Error(`SOAK_GIT_LS_FILES_FAILED:${String(sourceRaw.stderr || '').trim()}`);
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const numberOf = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const booleanOf = (record: Record<string, unknown>, key: string): boolean | undefined =>
  typeof record[key] === 'boolean' ? record[key] : undefined;

const parseLastJsonObject = (text: string): Record<string, unknown> | null => {
  const trimmed = text.trim();
  const starts: number[] = [];
  for (let index = trimmed.lastIndexOf('\n{'); index >= 0; index = trimmed.lastIndexOf('\n{', index - 1)) {
    starts.push(index + 1);
  }
  if (trimmed.startsWith('{')) starts.push(0);
  for (const start of starts) {
    try {
      const parsed = JSON.parse(trimmed.slice(start));
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next candidate; stdout tails can contain earlier pretty JSON.
    }
  }
  return null;
};

const extractResultEvidence = (stdoutTail: string): SoakResultEvidence | undefined => {
  const parsed = parseLastJsonObject(stdoutTail);
  if (!parsed) return undefined;
  const storageStats = isRecord(parsed['storageStats']) ? parsed['storageStats'] : null;
  const storageHead = storageStats && isRecord(storageStats['head']) ? storageStats['head'] : null;
  const snapshotHeights = storageStats && Array.isArray(storageStats['snapshotHeights'])
    ? storageStats['snapshotHeights'].filter((height): height is number => typeof height === 'number' && Number.isFinite(height))
    : [];
  const epochDbs = storageStats && Array.isArray(storageStats['epochDbs']) ? storageStats['epochDbs'] : [];
  const evidence: SoakResultEvidence = {};
  const setNumber = (key: keyof SoakResultEvidence, value: number | undefined): void => {
    if (value !== undefined) {
      (evidence as Record<string, unknown>)[key] = value;
    }
  };
  const passed = booleanOf(parsed, 'passed');
  if (passed !== undefined) evidence.passed = passed;
  setNumber('tps', numberOf(parsed, 'tps'));
  setNumber('sameTps', numberOf(parsed, 'sameTps'));
  setNumber('crossTps', numberOf(parsed, 'crossTps'));
  setNumber('aggregateTps', numberOf(parsed, 'aggregateTps'));
  setNumber('paymentTps', numberOf(parsed, 'paymentTps'));
  setNumber('openHtlcLocks', numberOf(parsed, 'openHtlcLocks'));
  setNumber('currentSnapshotBytes', numberOf(parsed, 'currentSnapshotBytes'));
  setNumber('dbBytes', numberOf(parsed, 'dbBytes'));
  if (storageStats) {
    setNumber('storageTotalBytes', numberOf(storageStats, 'totalBytes'));
    setNumber('storageHistoryBytes', numberOf(storageStats, 'historyBytes'));
    setNumber('storageSnapshotBytes', numberOf(storageStats, 'snapshotBytes'));
    evidence.storageSnapshotCount = snapshotHeights.length;
    evidence.storageEpochCount = epochDbs.length;
  }
  if (storageHead) setNumber('storageLatestSnapshotHeight', numberOf(storageHead, 'latestSnapshotHeight'));
  setNumber('storageLatestAccountMismatches', numberOf(parsed, 'storageLatestAccountMismatches'));
  setNumber('storageWorstLoadMs', numberOf(parsed, 'storageWorstLoadMs'));
  setNumber('storageRecoverySamples', numberOf(parsed, 'storageRecoverySamples'));
  setNumber('crashRecoveryMs', numberOf(parsed, 'crashRecoveryMs'));
  setNumber('crashRecoveredHeight', numberOf(parsed, 'crashRecoveredHeight'));
  setNumber('crashRecoveredHubAccountCount', numberOf(parsed, 'crashRecoveredHubAccountCount'));
  return Object.keys(evidence).length > 0 ? evidence : undefined;
};

type ProcessRow = { pid: number; ppid: number; cpuPct: number; rssKb: number };

const readProcessRows = (): ProcessRow[] => {
  try {
    const text = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss='], { encoding: 'utf8' });
    return text
      .trim()
      .split('\n')
      .map((line): ProcessRow | null => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) return null;
        const pid = Number(parts[0]);
        const ppid = Number(parts[1]);
        const cpuPct = Number(parts[2]);
        const rssKb = Number(parts[3]);
        if (![pid, ppid, cpuPct, rssKb].every(Number.isFinite)) return null;
        return { pid, ppid, cpuPct, rssKb };
      })
      .filter((row): row is ProcessRow => row !== null);
  } catch {
    return [];
  }
};

const summarizeProcessTree = (rootPid: number): { cpuPct: number; rssKb: number } => {
  const rows = readProcessRows();
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    childrenByParent.set(row.ppid, [...(childrenByParent.get(row.ppid) ?? []), row]);
  }
  const stack = [rootPid];
  const pids = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || pids.has(pid)) continue;
    pids.add(pid);
    for (const child of childrenByParent.get(pid) ?? []) stack.push(child.pid);
  }
  let cpuPct = 0;
  let rssKb = 0;
  for (const row of rows) {
    if (!pids.has(row.pid)) continue;
    cpuPct += row.cpuPct;
    rssKb += row.rssKb;
  }
  return { cpuPct: Number(cpuPct.toFixed(2)), rssKb };
};

const readSoakPerfSample = (pid: number): SoakPerfSample => {
  const tree = summarizeProcessTree(pid);
  return {
    ts: Date.now(),
    load1: loadavg()[0] ?? 0,
    freeMemBytes: freemem(),
    totalMemBytes: totalmem(),
    diskFreeBytes: readDiskFreeBytes(),
    processCpuPct: tree.cpuPct,
    processRssKb: tree.rssKb,
  };
};

const summarizePerf = (samples: SoakPerfSample[]): SoakPerfSummary => ({
  sampleCount: samples.length,
  peakLoad1: samples.reduce((max, sample) => Math.max(max, sample.load1), 0),
  minFreeMemBytes: samples.reduce((min, sample) => Math.min(min, sample.freeMemBytes), Number.POSITIVE_INFINITY),
  minDiskFreeBytes: samples.reduce((min, sample) => Math.min(min, sample.diskFreeBytes), Number.POSITIVE_INFINITY),
  maxProcessCpuPct: samples.reduce((max, sample) => Math.max(max, sample.processCpuPct), 0),
  maxProcessRssKb: samples.reduce((max, sample) => Math.max(max, sample.processRssKb), 0),
  samples,
});

const buildSoakRunSummary = (options: {
  commands: SoakCommand[];
  complete: boolean;
  results: SoakResult[];
  startedAtMs: number;
}): SoakRunSummary => {
  const samples = options.results.flatMap(result => result.perf.samples);
  const diskValues = samples.map(sample => sample.diskFreeBytes).filter(Number.isFinite);
  const byIteration = new Map<number, SoakResult[]>();
  const byCase = new Map<string, SoakResult[]>();
  for (const result of options.results) {
    byIteration.set(result.iteration, [...(byIteration.get(result.iteration) ?? []), result]);
    byCase.set(result.name, [...(byCase.get(result.name) ?? []), result]);
  }
  const completedFullIterations = [...byIteration.values()].filter((results) => {
    if (results.length < options.commands.length) return false;
    return options.commands.every(command =>
      results.some(result => result.name === command.name && result.code === 0),
    );
  }).length;
  return {
    generatedAt: new Date().toISOString(),
    complete: options.complete,
    completedCases: options.results.length,
    failedCases: options.results.filter(result => result.code !== 0).length,
    completedFullIterations,
    durationMs: Date.now() - options.startedAtMs,
    disk: {
      firstFreeBytes: diskValues[0] ?? null,
      lastFreeBytes: diskValues.at(-1) ?? null,
      minFreeBytes: diskValues.length > 0 ? Math.min(...diskValues) : null,
      deltaBytes: diskValues.length > 0 ? (diskValues.at(-1) ?? 0) - diskValues[0]! : null,
    },
    resources: {
      peakLoad1: options.results.reduce((max, result) => Math.max(max, result.perf.peakLoad1), 0),
      maxProcessCpuPct: options.results.reduce((max, result) => Math.max(max, result.perf.maxProcessCpuPct), 0),
      maxProcessRssKb: options.results.reduce((max, result) => Math.max(max, result.perf.maxProcessRssKb), 0),
    },
    cases: [...byCase.entries()].map(([name, results]) => {
      const durations = results.map(result => result.durationMs);
      const latest = results.at(-1);
      return {
        name,
        runs: results.length,
        failures: results.filter(result => result.code !== 0).length,
        minDurationMs: Math.min(...durations),
        maxDurationMs: Math.max(...durations),
        avgDurationMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
        lastDurationMs: latest?.durationMs ?? 0,
        ...(latest?.evidence ? { lastEvidence: latest.evidence } : {}),
      };
    }),
  };
};

const runCommand = async (command: SoakCommand, iteration: number, streamOutput: boolean, sampleMs: number): Promise<SoakResult> => {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  console.log(`[soak:${iteration}] ${command.name}`);
  console.log(`[soak:${iteration}] ${command.command}`);
  let stdoutTail = '';
  let stderrTail = '';

  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn('sh', ['-lc', command.command], {
    cwd: process.cwd(),
    env: sanitizeChildProcessEnv(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const perfSamples: SoakPerfSample[] = [];
  if (proc.pid) {
    perfSamples.push(readSoakPerfSample(proc.pid));
  }
  const sampleTimer = setInterval(() => {
    if (!proc.pid || proc.exitCode !== null) return;
    perfSamples.push(readSoakPerfSample(proc.pid));
  }, sampleMs);
  sampleTimer.unref();
  proc.stdout.on('data', chunk => {
    const text = chunk.toString();
    stdoutTail = appendTail(stdoutTail, text);
    if (streamOutput) process.stdout.write(prefixedOutput(iteration, command, text));
  });
  proc.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderrTail = appendTail(stderrTail, text);
    if (streamOutput) process.stderr.write(prefixedOutput(iteration, command, text));
  });

  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }, 5_000).unref();
  }, command.timeoutMs);
  timer.unref();

  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', resolve);
  });
  clearTimeout(timer);
  clearInterval(sampleTimer);
  if (proc.pid) {
    perfSamples.push(readSoakPerfSample(proc.pid));
  }
  const durationMs = Date.now() - startedAtMs;
  if (code !== 0) {
    if (stdoutTail) process.stdout.write(prefixedOutput(iteration, command, `stdout tail:\n${stdoutTail}`));
    if (stderrTail) process.stderr.write(prefixedOutput(iteration, command, `stderr tail:\n${stderrTail}`));
  }
  console.log(`[soak:${iteration}] ${command.name} code=${code ?? 'signal'} durationMs=${durationMs}`);
  const perf = summarizePerf(perfSamples);
  console.log(
    `[soak:${iteration}] perf samples=${perf.sampleCount} peakLoad1=${perf.peakLoad1.toFixed(2)} ` +
      `maxCpu=${perf.maxProcessCpuPct.toFixed(1)} maxRssKb=${perf.maxProcessRssKb} minDiskFree=${perf.minDiskFreeBytes}`,
  );
  const evidence = stdoutTail ? extractResultEvidence(stdoutTail) : undefined;

  return {
    iteration,
    name: command.name,
    command: command.command,
    code,
    durationMs,
    startedAt,
    finishedAt: new Date().toISOString(),
    perf,
    ...(evidence ? { evidence } : {}),
    ...(stdoutTail ? { stdoutTail } : {}),
    ...(stderrTail ? { stderrTail } : {}),
  };
};

const writeSummary = (path: string, payload: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
};

type E2eRunForPrune = {
  path: string;
  runId: string;
  completedAtMs: number;
};

const readDiskFreeBytes = (): number => {
  const stat = statfsSync(process.cwd());
  return Number(stat.bavail) * Number(stat.bsize);
};

const readPassedE2eRunForPrune = (path: string, runId: string): E2eRunForPrune | null => {
  const manifestPath = join(path, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { status?: unknown; completedAt?: unknown };
    if (manifest.status !== 'passed') return null;
    const completedAtMs =
      typeof manifest.completedAt === 'number' && Number.isFinite(manifest.completedAt)
        ? manifest.completedAt
        : statSync(path).mtimeMs;
    return { path, runId, completedAtMs };
  } catch {
    return null;
  }
};

const pruneSuccessfulE2eRuns = (keepRuns: number, minFreeBytes: number, minKeepRuns: number): void => {
  const root = resolve(process.cwd(), '.logs', 'e2e-parallel');
  if (keepRuns < 0 || !existsSync(root)) {
    const freeBytes = readDiskFreeBytes();
    if (freeBytes < minFreeBytes) {
      throw new Error(`SOAK_INSUFFICIENT_DISK_FREE: free=${String(freeBytes)} required=${String(minFreeBytes)}`);
    }
    return;
  }
  const passedRuns = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => readPassedE2eRunForPrune(join(root, entry.name), entry.name))
    .filter((entry): entry is E2eRunForPrune => entry !== null)
    .sort((a, b) => b.completedAtMs - a.completedAtMs || compareStableText(b.runId, a.runId));

  const protectedRunCount = Math.max(0, Math.min(minKeepRuns, passedRuns.length));
  const effectiveKeepRuns = Math.max(keepRuns, protectedRunCount);
  const removableByCount = passedRuns.slice(effectiveKeepRuns);
  const removableForDisk = passedRuns.slice(protectedRunCount, effectiveKeepRuns);
  const removable: E2eRunForPrune[] = [...removableByCount];
  let freeBytes = readDiskFreeBytes();
  for (const run of removableForDisk.reverse()) {
    if (freeBytes >= minFreeBytes) break;
    if (removable.some(candidate => candidate.runId === run.runId)) continue;
    removable.push(run);
    rmSync(run.path, { recursive: true, force: true });
    freeBytes = readDiskFreeBytes();
  }
  let removed = 0;
  for (const run of removableByCount) {
    rmSync(run.path, { recursive: true, force: true });
    removed += 1;
  }
  removed += removable.length - removableByCount.length;
  freeBytes = readDiskFreeBytes();
  if (removed > 0) {
    const retained = Math.max(0, passedRuns.length - removed);
    console.log(`[soak] pruned ${removed} successful E2E run(s); retained=${retained} free=${freeBytes} minFree=${minFreeBytes}`);
  }
  if (freeBytes < minFreeBytes) {
    throw new Error(
      `SOAK_INSUFFICIENT_DISK_FREE_AFTER_PRUNE: free=${String(freeBytes)} required=${String(minFreeBytes)} ` +
      `successfulRuns=${String(passedRuns.length)} minKeep=${String(protectedRunCount)}`,
    );
  }
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const commands = profileCommands[args.profile];
  const startedAt = Date.now();
  const deadline = args.minutes === null ? null : startedAt + args.minutes * 60_000;
  const results: SoakResult[] = [];
  const code = computeCodeFingerprint();

  console.log('');
  console.log('='.repeat(76));
  console.log(`XLN soak gate: ${args.profile}`);
  console.log(`gitHead=${code.gitHead?.slice(0, 12) ?? 'unknown'}${code.dirty ? ' dirty' : ''}`);
  console.log(`codeHash=${code.codeHash.slice(0, 16)} trackedFiles=${code.trackedFileCount} trackedBytes=${code.trackedBytes}`);
  console.log(`mode=${args.iterations !== null ? `${args.iterations} iteration(s)` : `${args.minutes} minute(s)`}`);
  console.log(`summary=${args.outputPath}`);
  console.log(`streamOutput=${args.streamOutput}`);
  console.log(`keepE2eRuns=${args.keepE2eRuns}`);
  console.log(`minKeepE2eRuns=${args.minKeepE2eRuns}`);
  console.log(`minFreeBytes=${args.minFreeBytes}`);
  console.log(`sampleMs=${args.sampleMs}`);
  console.log('='.repeat(76));

  pruneSuccessfulE2eRuns(args.keepE2eRuns, args.minFreeBytes, args.minKeepE2eRuns);

  let iteration = 1;
  while (true) {
    if (args.iterations !== null && iteration > args.iterations) break;
    if (deadline !== null && Date.now() >= deadline) break;

    for (const command of commands) {
      pruneSuccessfulE2eRuns(args.keepE2eRuns, args.minFreeBytes, args.minKeepE2eRuns);
      const result = await runCommand(command, iteration, args.streamOutput, args.sampleMs);
      results.push(result);
      writeSummary(args.outputPath, {
        profile: args.profile,
        code,
        startedAt: new Date(startedAt).toISOString(),
        updatedAt: new Date().toISOString(),
        complete: false,
        summary: buildSoakRunSummary({ commands, complete: false, results, startedAtMs: startedAt }),
        results,
      });
      if (result.code !== 0) {
        console.error(`[soak] failed: ${command.name} code=${result.code ?? 'signal'}`);
        process.exit(result.code ?? 1);
      }
      pruneSuccessfulE2eRuns(args.keepE2eRuns, args.minFreeBytes, args.minKeepE2eRuns);
      if (deadline !== null && Date.now() >= deadline) break;
    }

    iteration += 1;
    if (args.intervalMs > 0 && (args.iterations === null || iteration <= args.iterations)) {
      await sleep(args.intervalMs);
    }
  }

  const payload = {
    profile: args.profile,
    code,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    complete: true,
    iterationsCompleted: Math.max(0, iteration - 1),
    durationMs: Date.now() - startedAt,
    summary: buildSoakRunSummary({ commands, complete: true, results, startedAtMs: startedAt }),
    results,
  };
  writeSummary(args.outputPath, payload);
  console.log('');
  console.log('='.repeat(76));
  console.log(`XLN soak gate passed: ${results.length} command run(s)`);
  console.log(`summary=${args.outputPath}`);
  console.log('='.repeat(76));
};

main().catch((error) => {
  console.error('soak gate failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
