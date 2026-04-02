import { existsSync, readdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

export type QaSlowStep = {
  label: string;
  ms: number;
};

export type QaArtifactKind = 'video' | 'image' | 'trace' | 'json' | 'text' | 'archive' | 'other';

export type QaArtifact = {
  name: string;
  relativePath: string;
  sizeBytes: number;
  kind: QaArtifactKind;
  contentType: string;
  url?: string;
};

export type QaPhaseTimings = {
  preflight: number;
  anvilBoot: number;
  apiBoot: number;
  apiHealthy: number;
  viteBoot: number;
  playwright: number;
};

export type QaShardManifest = {
  shard: number;
  status: 'passed' | 'failed' | 'unknown';
  durationMs: number | null;
  target: string | null;
  title: string | null;
  requireMarketMaker: boolean | null;
  logRelativePath: string | null;
  logTail: string | null;
  error: string | null;
  phaseMs: QaPhaseTimings | null;
  slowSteps: QaSlowStep[];
  artifacts: QaArtifact[];
  hasVideo: boolean;
  hasTrace: boolean;
};

export type QaRunManifest = {
  manifestVersion: number;
  runId: string;
  createdAt: number;
  completedAt: number | null;
  status: 'passed' | 'failed' | 'unknown';
  totalMs: number | null;
  totalShards: number;
  passedShards: number;
  failedShards: number;
  args?: Record<string, unknown> | null;
  shards: QaShardManifest[];
};

export const QA_LOGS_ROOT = resolve(process.cwd(), '.logs', 'e2e-parallel');

const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
};

const parseRunIdTimestamp = (runId: string): number | null => {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/.exec(runId);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, ms] = match;
  const parsed = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(ms),
  );
  return Number.isFinite(parsed) ? parsed : null;
};

const detectArtifactKind = (name: string): QaArtifactKind => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.webm')) return 'video';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image';
  if (lower.endsWith('.zip')) return 'trace';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'text';
  if (lower.endsWith('.tar') || lower.endsWith('.gz')) return 'archive';
  return 'other';
};

const detectContentType = (name: string): string => MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';

const shortTail = (text: string, lines = 80): string => text.split('\n').slice(-lines).join('\n');

const parseSlowSteps = (text: string): QaSlowStep[] => {
  const out: QaSlowStep[] = [];
  const re = /\[(E2E-TIMING|MESH-TIMING)\]\s+(.+?)\s+(\d+)ms/g;
  let match: RegExpExecArray | null = null;
  while ((match = re.exec(text)) !== null) {
    const prefix = String(match[1] || '').trim();
    const label = `${prefix}:${String(match[2] || '').trim()}`;
    const ms = Number(match[3] || '0');
    if (!label || !Number.isFinite(ms)) continue;
    out.push({ label, ms });
  }
  return out.sort((a, b) => b.ms - a.ms);
};

const parsePhaseTimings = (text: string): QaPhaseTimings | null => {
  const phases: Partial<QaPhaseTimings> = {};
  const re = /^\[timing\]\s+(\w+)=(\d+)ms/mg;
  let match: RegExpExecArray | null = null;
  while ((match = re.exec(text)) !== null) {
    const phase = String(match[1] || '').trim();
    const ms = Number(match[2] || '0');
    if (!Number.isFinite(ms)) continue;
    if (phase === 'preflight') phases.preflight = ms;
    if (phase === 'anvilBoot') phases.anvilBoot = ms;
    if (phase === 'apiBoot') phases.apiBoot = ms;
    if (phase === 'apiHealthy') phases.apiHealthy = ms;
    if (phase === 'viteBoot') phases.viteBoot = ms;
    if (phase === 'playwright') phases.playwright = ms;
  }
  if (
    typeof phases.preflight !== 'number' ||
    typeof phases.anvilBoot !== 'number' ||
    typeof phases.apiBoot !== 'number' ||
    typeof phases.apiHealthy !== 'number' ||
    typeof phases.viteBoot !== 'number' ||
    typeof phases.playwright !== 'number'
  ) {
    return null;
  }
  return phases as QaPhaseTimings;
};

const sumPhaseTimings = (phaseMs: QaPhaseTimings | null): number | null => {
  if (!phaseMs) return null;
  return (
    phaseMs.preflight +
    phaseMs.anvilBoot +
    phaseMs.apiBoot +
    phaseMs.apiHealthy +
    phaseMs.viteBoot +
    phaseMs.playwright
  );
};

const walkArtifacts = async (baseDir: string, currentDir: string, out: QaArtifact[]): Promise<void> => {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkArtifacts(baseDir, absolutePath, out);
      continue;
    }
    const fileStat = await stat(absolutePath);
    out.push({
      name: entry.name,
      relativePath: absolutePath.slice(baseDir.length + 1),
      sizeBytes: fileStat.size,
      kind: detectArtifactKind(entry.name),
      contentType: detectContentType(entry.name),
    });
  }
};

const readLastRunStatus = async (resultsDir: string): Promise<'passed' | 'failed' | 'unknown'> => {
  try {
    const raw = await readFile(join(resultsDir, '.last-run.json'), 'utf8');
    const parsed = JSON.parse(raw) as { status?: unknown };
    return parsed.status === 'passed' || parsed.status === 'failed' ? parsed.status : 'unknown';
  } catch {
    return 'unknown';
  }
};

const collectLegacyShard = async (runId: string, runDir: string, shard: number): Promise<QaShardManifest> => {
  const logRelativePath = `e2e-shard-${String(shard).padStart(2, '0')}.log`;
  const logPath = join(runDir, logRelativePath);
  const resultsDir = join(runDir, `test-results-shard-${shard}`);
  const logText = existsSync(logPath) ? await readFile(logPath, 'utf8') : '';
  const phaseMs = parsePhaseTimings(logText);
  const slowSteps = parseSlowSteps(logText).slice(0, 12);
  const artifacts: QaArtifact[] = [];
  let title: string | null = null;
  let status: 'passed' | 'failed' | 'unknown' = 'unknown';

  if (existsSync(resultsDir)) {
    status = await readLastRunStatus(resultsDir);
    const entries = await readdir(resultsDir, { withFileTypes: true });
    const caseDir = entries.find((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    if (caseDir) title = caseDir.name;
    await walkArtifacts(runDir, resultsDir, artifacts);
  }

  return {
    shard,
    status,
    durationMs: sumPhaseTimings(phaseMs),
    target: null,
    title,
    requireMarketMaker: null,
    logRelativePath: existsSync(logPath) ? logRelativePath : null,
    logTail: logText ? shortTail(logText) : null,
    error: status === 'failed' ? shortTail(logText, 40) : null,
    phaseMs,
    slowSteps,
    artifacts,
    hasVideo: artifacts.some((artifact) => artifact.kind === 'video'),
    hasTrace: artifacts.some((artifact) => artifact.kind === 'trace'),
  };
};

const buildLegacyManifest = async (runId: string, runDir: string): Promise<QaRunManifest> => {
  const runStat = await stat(runDir);
  const allEntries = await readdir(runDir);
  const shardIds = Array.from(new Set(
    allEntries.flatMap((entry) => {
      const logMatch = /^e2e-shard-(\d+)\.log$/.exec(entry);
      if (logMatch) return [Number(logMatch[1])];
      const resultsMatch = /^test-results-shard-(\d+)$/.exec(entry);
      if (resultsMatch) return [Number(resultsMatch[1])];
      return [];
    }),
  )).sort((a, b) => a - b);

  const shards = await Promise.all(shardIds.map((shard) => collectLegacyShard(runId, runDir, shard)));
  const passedShards = shards.filter((shard) => shard.status === 'passed').length;
  const failedShards = shards.filter((shard) => shard.status === 'failed').length;
  const totalMs = null;

  return {
    manifestVersion: 1,
    runId,
    createdAt: parseRunIdTimestamp(runId) ?? runStat.mtimeMs,
    completedAt: runStat.mtimeMs,
    status: failedShards > 0 ? 'failed' : passedShards === shards.length && shards.length > 0 ? 'passed' : 'unknown',
    totalMs,
    totalShards: shards.length,
    passedShards,
    failedShards,
    args: null,
    shards,
  };
};

export const listQaRuns = async (limit = 20): Promise<QaRunManifest[]> => {
  if (!existsSync(QA_LOGS_ROOT)) return [];
  const entries = await readdir(QA_LOGS_ROOT, { withFileTypes: true });
  const runIds = entries
    .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}-\d{3}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit);
  return await Promise.all(runIds.map((runId) => readQaRun(runId)));
};

export const readQaRun = async (runId: string): Promise<QaRunManifest> => {
  if (!/^\d{8}-\d{6}-\d{3}$/.test(runId)) {
    throw new Error('INVALID_QA_RUN_ID');
  }
  const runDir = join(QA_LOGS_ROOT, runId);
  const runStat = await stat(runDir).catch(() => null);
  if (!runStat?.isDirectory()) {
    throw new Error('QA_RUN_NOT_FOUND');
  }

  const manifestPath = join(runDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as QaRunManifest;
    const shards = await Promise.all(parsed.shards.map(async (shard) => {
      const logText =
        shard.logRelativePath && existsSync(join(runDir, shard.logRelativePath))
          ? await readFile(join(runDir, shard.logRelativePath), 'utf8')
          : '';
      return {
        ...shard,
        title: shard.title ?? readShardTitleFromResults(runDir, shard.shard),
        logTail: shard.logTail ?? (logText ? shortTail(logText) : null),
      };
    }));
    return { ...parsed, shards };
  }
  return await buildLegacyManifest(runId, runDir);
};

const readShardTitleFromResults = (runDir: string, shard: number): string | null => {
  const resultsDir = join(runDir, `test-results-shard-${shard}`);
  if (!existsSync(resultsDir)) return null;
  try {
    const entry = readdirSync(resultsDir, { withFileTypes: true }).find((item) => item.isDirectory() && !item.name.startsWith('.'));
    return entry?.name ?? null;
  } catch {
    return null;
  }
};

export const resolveQaArtifactPath = async (runId: string, relativePath: string): Promise<string> => {
  if (!/^\d{8}-\d{6}-\d{3}$/.test(runId)) {
    throw new Error('INVALID_QA_RUN_ID');
  }
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\0')) {
    throw new Error('INVALID_QA_ARTIFACT_PATH');
  }
  const runDir = join(QA_LOGS_ROOT, runId);
  const absolutePath = resolve(runDir, relativePath);
  if (!absolutePath.startsWith(`${runDir}/`) && absolutePath !== runDir) {
    throw new Error('INVALID_QA_ARTIFACT_PATH');
  }
  const fileStat = await stat(absolutePath).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error('QA_ARTIFACT_NOT_FOUND');
  }
  return absolutePath;
};

export const makeQaArtifactUrl = (runId: string, relativePath: string): string =>
  `/api/qa/artifact?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(relativePath)}`;

export const enrichQaRunUrls = (run: QaRunManifest): QaRunManifest => ({
  ...run,
  shards: run.shards.map((shard) => ({
    ...shard,
    artifacts: shard.artifacts.map((artifact) => ({
      ...artifact,
      url: makeQaArtifactUrl(run.runId, artifact.relativePath),
    })),
  })),
});

export const summarizeQaRun = (run: QaRunManifest): Omit<QaRunManifest, 'shards'> & { failingTargets: string[] } => ({
  manifestVersion: run.manifestVersion,
  runId: run.runId,
  createdAt: run.createdAt,
  completedAt: run.completedAt,
  status: run.status,
  totalMs: run.totalMs,
  totalShards: run.totalShards,
  passedShards: run.passedShards,
  failedShards: run.failedShards,
  args: run.args ?? null,
  failingTargets: run.shards
    .filter((shard) => shard.status === 'failed')
    .map((shard) => shard.target || shard.title || `shard-${shard.shard}`)
    .slice(0, 5),
});

export const qaArtifactContentType = (filePath: string): string => detectContentType(basename(filePath));
