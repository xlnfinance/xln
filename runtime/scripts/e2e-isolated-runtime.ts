import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { freemem, loadavg, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { compareStableText } from '../protocol/serialization';
import { sanitizeChildProcessEnv } from '../api/server/child-process-env';

/**
 * Resource isolation and candidate-identity primitives for the E2E runner.
 *
 * Allocation must be known before children start, while drift checks must
 * remain usable after a shard is already running.
 */
const DEV_RESERVED_PORTS = new Set([
  8080, 8081, 8082, 8087, 8088,
  8092, 8093, 8094, 8095,
  8545, 8546, 9100, 17_999,
]);

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
        : [[role, value] as const],
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

export type QaCodeFingerprint = {
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

export type QaPerfSummary = {
  sampleCount: number;
  avgLoad1: number;
  peakLoad1: number;
  minFreeMemBytes: number;
  maxRunnerRssBytes: number;
  maxChildCpuPct: number;
  maxChildRssKb: number;
  samples: QaPerfSample[];
};

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
    return !['frontend/node_modules/', 'frontend/build/', 'frontend/dist/'].some(prefix =>
      path.startsWith(prefix),
    );
  }
  if (path.startsWith('jurisdictions/artifacts/')) return true;
  if (path.startsWith('docs/') || path.startsWith('scenarios/')) return true;
  return ['bun.lock', 'package.json', 'tsconfig.json', 'tsconfig.runtime.json', 'scripts/build-runtime.sh'].includes(
    path,
  );
};

const updateSourceHash = (hash: ReturnType<typeof createHash>, file: string, data: Buffer): void => {
  hash.update(file);
  hash.update('\0');
  hash.update(data);
  hash.update('\0');
};

export const computeE2EBuildInputHash = (files: readonly string[], root = process.cwd()): string => {
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
  return Buffer.from(sourceRaw.stdout).toString('utf8').split('\0').filter(Boolean).sort(compareStableText);
};

export const computeE2ESourceDriftProbe = (files: readonly string[], root = process.cwd()): string => {
  // This cheap metadata probe only decides whether to perform a full content
  // hash. It is never accepted as candidate identity by itself.
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

export const computeRepositorySourceDriftProbe = (): string => computeE2ESourceDriftProbe(listRepositorySourceFiles());

export const computeCodeFingerprint = (): QaCodeFingerprint => {
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

export const assertE2ECodeFingerprintStable = (startCodeHash: string, endCodeHash: string): void => {
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
        // Latch the first mismatch: later filesystem changes cannot make an
        // already-contaminated run valid again.
        driftFailure = error instanceof Error ? error : new Error(String(error));
        throw driftFailure;
      }
    },
  };
};

export const emptyPerfSummary = (): QaPerfSummary => ({
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

export const parseE2EChildPerfOutput = (children: readonly E2EPerfChild[], output: string): QaPerfChildSample[] => {
  const metricsByPid = new Map<number, Omit<QaPerfChildSample, 'name'>>();
  for (const line of output
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)) {
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
  const pids = Array.from(
    new Set(
      children.map(child => child.pid).filter((pid): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0),
    ),
  );
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

export const summarizePerfSamples = (samples: QaPerfSample[]): QaPerfSummary => {
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

export const startPerfMonitor = (
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

export type AsyncLimiter = {
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
      await new Promise<void>(resolve =>
        queue.push(() => {
          queued = Math.max(0, queued - 1);
          resolve();
        }),
      );
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
