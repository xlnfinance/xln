import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { compareStableText } from '../serialization-utils';
import {
  assertQaSeveritySignal,
  makeQaSeveritySignal,
  normalizeQaSeveritySignal,
  type QaSeveritySignal,
} from './severity';

export type { QaSeverity, QaSeverityEvidence, QaSeveritySignal } from './severity';

export type QaSlowStep = {
  label: string;
  ms: number;
  startMs?: number;
  endMs?: number;
};

export type QaArtifactKind = 'video' | 'image' | 'trace' | 'json' | 'text' | 'archive' | 'other';
export type QaArtifactSensitivity = 'public' | 'internal' | 'secret-bearing';

export type QaArtifact = {
  name: string;
  relativePath: string;
  sizeBytes: number;
  kind: QaArtifactKind;
  sensitivity: QaArtifactSensitivity;
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

export type QaCodeFingerprint = {
  gitHead: string | null;
  gitBranch: string | null;
  gitStatus: string;
  dirty: boolean;
  codeHash: string;
  computedAt: number;
  trackedFileCount: number;
  trackedBytes: number;
};

export type QaPerfChildSample = {
  name: string;
  pid: number;
  cpuPct: number;
  memPct: number;
  rssKb: number;
};

export type QaPerfSample = {
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

export type QaPerfSummaryView = Omit<QaPerfSummary, 'samples'>;

export type QaBrowserIssueType = 'console' | 'pageerror' | 'requestfailed' | 'http';

export type QaBrowserIssueSeverity = 'error' | 'warning';

export type QaBrowserIssue = {
  type: QaBrowserIssueType;
  severity: QaBrowserIssueSeverity;
  message: string;
  url: string | null;
  method: string | null;
  status: number | null;
  testId: string | null;
  timestamp: number;
};

export type QaBrowserHealthSummary = {
  issueCount: number;
  errorCount: number;
  warningCount: number;
  networkFailureCount: number;
  httpErrorCount: number;
} & QaSeveritySignal;

export type QaFailureClass = 'assertion' | 'infra' | 'timeout' | 'flake' | 'crash' | 'security' | 'unknown';

export type QaBenchmarkStatus = 'ok' | 'faster' | 'slower' | 'mixed' | 'insufficient';

export type QaBenchmarkMetricDelta = {
  metric: string;
  label: string;
  unit: 'ms' | 'load' | 'percent' | 'kb' | 'bytes';
  current: number;
  baseline: number;
  delta: number;
  deltaPct: number;
  thresholdPct: number;
  verdict: 'ok' | 'faster' | 'slower';
};

export type QaBenchmarkComparison = {
  status: QaBenchmarkStatus;
  suiteKey: string;
  suiteLabel: string;
  comparedRunId: string | null;
  comparedGitHead: string | null;
  comparedCodeHash: string | null;
  sameGitHead: boolean | null;
  sameCodeHash: boolean | null;
  reason: string;
  metrics: QaBenchmarkMetricDelta[];
  likelyCauses: string[];
} & QaSeveritySignal;

export type QaRunTimingSummary = {
  avgShardMs: number | null;
  maxShardMs: number | null;
  bootstrapMs: number | null;
  apiHealthyMs: number | null;
  playwrightMs: number | null;
};

export type QaShardManifest = {
  shard: number;
  status: 'passed' | 'failed' | 'unknown';
  durationMs: number | null;
  handle: string | null;
  description: string | null;
  target: string | null;
  title: string | null;
  requireMarketMaker: boolean | null;
  logRelativePath: string | null;
  logTail: string | null;
  error: string | null;
  failureClass: QaFailureClass | null;
  phaseMs: QaPhaseTimings | null;
  perf?: QaPerfSummary;
  browserIssues?: QaBrowserIssue[];
  browserHealth?: QaBrowserHealthSummary;
  timelineSteps: QaSlowStep[];
  slowSteps: QaSlowStep[];
  artifacts: QaArtifact[];
  hasVideo: boolean;
  hasTrace: boolean;
} & QaSeveritySignal;

export type QaRunManifest = {
  manifestVersion: number;
  runId: string;
  createdAt: number;
  completedAt: number | null;
  status: 'passed' | 'failed' | 'unknown';
  totalMs: number | null;
  code?: QaCodeFingerprint;
  perf?: QaPerfSummary;
  browserHealth?: QaBrowserHealthSummary;
  benchmark?: QaBenchmarkComparison;
  totalShards: number;
  passedShards: number;
  failedShards: number;
  failureClasses?: QaFailureClass[];
  args?: Record<string, unknown> | null;
  shards: QaShardManifest[];
} & QaSeveritySignal;

export type QaShardView = Omit<QaShardManifest, 'perf'> & {
  perf?: QaPerfSummaryView;
};

export type QaRunView = Omit<QaRunManifest, 'perf' | 'shards'> & {
  perf?: QaPerfSummaryView;
  shards: QaShardView[];
};

export type QaRunSummary = Omit<QaRunManifest, 'perf' | 'shards'> & {
  perf?: QaPerfSummaryView;
  timing: QaRunTimingSummary;
  failingTargets: string[];
};

type QaShardFailureInput = Pick<QaShardManifest, 'status' | 'error' | 'logTail'> & {
  browserIssues?: QaBrowserIssue[];
};

export const QA_LOGS_ROOT = resolve(process.cwd(), '.logs', 'e2e-parallel');
export const QA_STORY_SCREENSHOTS_ROOT = resolve(process.cwd(), 'tests', 'e2e', 'screenshots');
export const QA_HISTORY_DB_PATH = resolve(process.cwd(), '.logs', 'qa-history.sqlite');

export type QaHistoryEntry = {
  runId: string;
  createdAt: number;
  completedAt: number | null;
  status: QaRunManifest['status'];
  totalMs: number | null;
  totalShards: number;
  passedShards: number;
  failedShards: number;
  gitHead: string | null;
  gitBranch: string | null;
  dirty: boolean;
  codeHash: string | null;
  avgLoad1: number | null;
  peakLoad1: number | null;
  maxChildCpuPct: number | null;
  maxChildRssKb: number | null;
  suiteKey: string | null;
  benchmarkStatus: QaBenchmarkStatus | null;
  benchmarkDeltaPct: number | null;
  benchmarkComparedRunId: string | null;
  browserIssueCount: number;
  browserErrorCount: number;
  browserWarningCount: number;
  networkFailureCount: number;
  httpErrorCount: number;
  avgShardMs: number | null;
  maxShardMs: number | null;
  bootstrapMs: number | null;
  apiHealthyMs: number | null;
  playwrightMs: number | null;
  logsDir: string;
};

export type QaHistoryBackfillResult = {
  scannedRuns: number;
  recordedRuns: number;
  failedRuns: Array<{ runId: string; error: string }>;
};

export type QaRetentionPurgeResult = {
  retentionDays: number;
  cutoff: number;
  deletedRunIds: string[];
  deletedLogDirs: number;
  deletedHistoryRows: number;
};

export type QaStorySource = 'e2e-screenshots' | 'qa-run';

export type QaStoryScreenshot = {
  id: string;
  source: QaStorySource;
  title: string;
  group: string;
  description: string | null;
  platform: string | null;
  tags: string[];
  curated: boolean;
  name: string;
  relativePath: string;
  sizeBytes: number;
  updatedAt: number;
  url: string;
  runId?: string;
  shard?: number;
  status?: QaShardManifest['status'];
};

export const QA_UX_RELEASE_PACK_MIN_SCREENS = 30;
export const QA_UX_RELEASE_REQUIRED_GROUPS = [
  'Onboarding',
  'Portfolio',
  'Accounts',
  'Payments',
  'Swap',
  'On-chain Batch',
  'Disputes',
  'History',
  'Settings',
  'QA Cockpit',
  'Health',
  'Remote Runtime Import',
  'Time Machine',
] as const;

export type QaUxReleasePackAudit = {
  status: 'ready' | 'missing';
  minScreens: number;
  curatedCount: number;
  desktopCount: number;
  mobileCount: number;
  requiredGroups: string[];
  presentGroups: string[];
  missingGroups: string[];
  missingReasons: string[];
};

export const auditQaUxReleasePack = (stories: QaStoryScreenshot[]): QaUxReleasePackAudit => {
  const curated = stories.filter(story => story.curated);
  const presentGroups = Array.from(new Set(curated.map(story => story.group))).sort(compareStableText);
  const presentGroupSet = new Set(presentGroups);
  const missingGroups = QA_UX_RELEASE_REQUIRED_GROUPS.filter(group => !presentGroupSet.has(group));
  const desktopCount = curated.filter(story => story.platform === 'desktop').length;
  const mobileCount = curated.filter(story => story.platform === 'mobile').length;
  const missingReasons = [
    curated.length < QA_UX_RELEASE_PACK_MIN_SCREENS
      ? `needs ${QA_UX_RELEASE_PACK_MIN_SCREENS - curated.length} more curated screen(s)`
      : '',
    desktopCount <= 0 ? 'missing desktop viewport' : '',
    mobileCount <= 0 ? 'missing mobile viewport' : '',
    ...missingGroups.map(group => `missing ${group}`),
  ].filter(Boolean);
  return {
    status: missingReasons.length === 0 ? 'ready' : 'missing',
    minScreens: QA_UX_RELEASE_PACK_MIN_SCREENS,
    curatedCount: curated.length,
    desktopCount,
    mobileCount,
    requiredGroups: [...QA_UX_RELEASE_REQUIRED_GROUPS],
    presentGroups,
    missingGroups,
    missingReasons,
  };
};

type QaUxScreenshotMetadata = {
  title: string | null;
  group: string | null;
  description: string | null;
  platform: string | null;
  tags: string[];
};

const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
};

const STORY_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const QA_BROWSER_ISSUE_TYPES = new Set<QaBrowserIssueType>(['console', 'pageerror', 'requestfailed', 'http']);
const QA_BROWSER_ISSUE_SEVERITIES = new Set<QaBrowserIssueSeverity>(['error', 'warning']);

const asNullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const QA_SECRET_LABEL_PATTERN = String.raw`(?:authorization|x-xln-qa-token|xln_qa_read_token|xln_qa_admin_token|adminToken|readToken|accessToken|refreshToken|privateKey|private_key|mnemonic|authSeed|auth_seed|seed|apiKey|api_key|secret|token)`;
const QA_SECRET_QUOTED_FIELD_PATTERN = new RegExp(
  String.raw`(["']${QA_SECRET_LABEL_PATTERN}["']\s*:\s*)(["'])(.*?)\2`,
  'gi',
);
const QA_SECRET_QUOTED_VALUE_PATTERN = new RegExp(
  String.raw`\b(${QA_SECRET_LABEL_PATTERN}\s*[:=]\s*)(["'])(.*?)\2`,
  'gi',
);
const QA_SECRET_BARE_VALUE_PATTERN = new RegExp(
  String.raw`\b(${QA_SECRET_LABEL_PATTERN}\s*[:=]\s*)[^"'\s,;)}\]]+`,
  'gi',
);

export const redactQaSecretText = (value: string): string => {
  const secret = '[REDACTED]';
  return value
    .replace(/\b((?:https?|wss?):\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${secret}@`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${secret}`)
    .replace(/\bxlnra1\.[A-Za-z0-9._~+/=-]+/g, `xlnra1.${secret}`)
    .replace(
      /([?&#](?:runtime-import|remote-runtimes|xlnRemoteRuntimes|token|adminToken|readToken|access_token|refresh_token|privateKey|mnemonic|seed|secret)=)[^&#\s"')]+/gi,
      `$1${secret}`,
    )
    .replace(QA_SECRET_QUOTED_FIELD_PATTERN, (_match, prefix: string, quote: string) => `${prefix}${quote}${secret}${quote}`)
    .replace(QA_SECRET_QUOTED_VALUE_PATTERN, (_match, prefix: string, quote: string) => `${prefix}${quote}${secret}${quote}`)
    .replace(QA_SECRET_BARE_VALUE_PATTERN, `$1${secret}`);
};

export const isQaTextArtifactPath = (filePath: string): boolean => {
  const contentType = detectContentType(basename(filePath));
  return contentType.startsWith('text/') || contentType.startsWith('application/json');
};

export const classifyQaArtifactSensitivity = (artifact: {
  name?: string | null;
  relativePath?: string | null;
  kind?: QaArtifactKind | null;
  contentType?: string | null;
}): QaArtifactSensitivity => {
  const name = String(artifact.name || '').toLowerCase();
  const relativePath = String(artifact.relativePath || '').replace(/\\/g, '/').toLowerCase();
  const kind = artifact.kind ?? detectArtifactKind(name || basename(relativePath));
  const contentType = String(artifact.contentType || '').toLowerCase();
  if (
    relativePath.endsWith('/qa-cues/cues.vtt') ||
    relativePath.endsWith('/qa-cues/cues.json') ||
    name === 'cues.vtt' ||
    name === 'cues.json'
  ) {
    return 'public';
  }
  if (kind === 'trace' || kind === 'archive') return 'secret-bearing';
  if (kind === 'text' || kind === 'json') return 'secret-bearing';
  if (contentType.startsWith('text/') || contentType.startsWith('application/json')) return 'secret-bearing';
  if (kind === 'video' || kind === 'image') return 'internal';
  return 'internal';
};

const asFiniteNumber = (value: unknown): number | null => {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const trimIssueMessage = (value: unknown): string => {
  const message = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return message.slice(0, 2_000);
};

const normalizeQaBrowserIssue = (value: unknown): QaBrowserIssue | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const rawType = record['type'];
  const rawSeverity = record['severity'];
  const message = trimIssueMessage(record['message']);
  const timestamp = asFiniteNumber(record['timestamp']) ?? Date.now();
  if (!QA_BROWSER_ISSUE_TYPES.has(rawType as QaBrowserIssueType) || !message) return null;
  return {
    type: rawType as QaBrowserIssueType,
    severity: QA_BROWSER_ISSUE_SEVERITIES.has(rawSeverity as QaBrowserIssueSeverity)
      ? rawSeverity as QaBrowserIssueSeverity
      : 'error',
    message,
    url: asNullableString(record['url']),
    method: asNullableString(record['method']),
    status: asFiniteNumber(record['status']),
    testId: asNullableString(record['testId']),
    timestamp,
  };
};

export const normalizeQaBrowserIssues = (value: unknown): QaBrowserIssue[] => {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeQaBrowserIssue).filter((item): item is QaBrowserIssue => Boolean(item));
};

const qaSeveritySince = (fallback: number, values: readonly unknown[]): number => {
  const timestamps = values
    .map(asFiniteNumber)
    .filter((value): value is number => value !== null && value >= 0);
  return timestamps.length > 0 ? Math.min(...timestamps) : Math.max(0, fallback);
};

const qaBrowserHealthSeverity = (
  summary: Omit<QaBrowserHealthSummary, keyof QaSeveritySignal>,
  since: number,
): QaSeveritySignal => {
  if (summary.errorCount > 0) {
    return makeQaSeveritySignal({
      severity: 'FAIL',
      reason: `${summary.errorCount} browser error(s) captured`,
      since,
      owner: 'browser',
      evidence: [
        { label: 'errors', value: summary.errorCount },
        { label: 'warnings', value: summary.warningCount },
        { label: 'network failures', value: summary.networkFailureCount },
        { label: 'http errors', value: summary.httpErrorCount },
      ],
    });
  }
  if (summary.warningCount > 0) {
    return makeQaSeveritySignal({
      severity: 'WARN',
      reason: `${summary.warningCount} browser warning(s) captured`,
      since,
      owner: 'browser',
      evidence: [
        { label: 'warnings', value: summary.warningCount },
        { label: 'http warnings', value: summary.httpErrorCount },
      ],
    });
  }
  return makeQaSeveritySignal({
    severity: 'OK',
    reason: 'Browser event stream is clean',
    since,
    owner: 'browser',
    evidence: [{ label: 'issues', value: 0 }],
  });
};

const normalizeQaBrowserHealthSummary = (
  value: QaBrowserHealthSummary,
  since: number,
): QaBrowserHealthSummary => {
  const summary = {
    issueCount: Number(value.issueCount || 0),
    errorCount: Number(value.errorCount || 0),
    warningCount: Number(value.warningCount || 0),
    networkFailureCount: Number(value.networkFailureCount || 0),
    httpErrorCount: Number(value.httpErrorCount || 0),
  };
  return {
    ...summary,
    ...normalizeQaSeveritySignal(value, qaBrowserHealthSeverity(summary, since)),
  };
};

export const summarizeQaBrowserIssues = (issues: readonly QaBrowserIssue[], since = 0): QaBrowserHealthSummary => {
  const summary = {
    issueCount: issues.length,
    errorCount: issues.filter(issue => issue.severity === 'error').length,
    warningCount: issues.filter(issue => issue.severity === 'warning').length,
    networkFailureCount: issues.filter(issue => issue.type === 'requestfailed').length,
    httpErrorCount: issues.filter(issue => issue.type === 'http').length,
  };
  return {
    ...summary,
    ...qaBrowserHealthSeverity(summary, qaSeveritySince(since, issues.map(issue => issue.timestamp))),
  };
};

export const summarizeQaRunBrowserHealth = (run: Pick<QaRunManifest, 'shards'>): QaBrowserHealthSummary =>
  summarizeQaBrowserIssues(run.shards.flatMap(shard => normalizeQaBrowserIssues(shard.browserIssues)));

const classifyQaFailureText = (value: string): QaFailureClass | null => {
  const lower = value.toLowerCase();
  if (!lower.trim()) return null;
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('timeoutexceeded')) return 'timeout';
  if (lower.includes('e2e_fatal_runtime_log') || lower.includes('segmentation fault') || lower.includes('page crashed') || lower.includes('sigsegv')) return 'crash';
  if (lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('token') || lower.includes('secret') || lower.includes('cors')) return 'security';
  if (lower.includes('flake') || lower.includes('retry')) return 'flake';
  if (
    lower.includes('health') ||
    lower.includes('anvil') ||
    lower.includes('vite') ||
    lower.includes('boot') ||
    lower.includes('spawn') ||
    lower.includes('econnrefused') ||
    lower.includes('net::') ||
    lower.includes('request failed') ||
    lower.includes('http 5')
  ) return 'infra';
  if (lower.includes('expect(') || lower.includes('expected:') || lower.includes('assert') || lower.includes('matcherresult')) return 'assertion';
  return null;
};

export const classifyQaShardFailure = (options: {
  status: QaShardManifest['status'];
  error?: string | null;
  logTail?: string | null;
  browserIssues?: QaBrowserIssue[];
}): QaFailureClass | null => {
  if (options.status !== 'failed') return null;
  const browserIssues = normalizeQaBrowserIssues(options.browserIssues);
  const textClass = classifyQaFailureText([
    options.error ?? '',
    options.logTail ?? '',
    ...browserIssues.map(issue => `${issue.type} ${issue.status ?? ''} ${issue.message} ${issue.url ?? ''}`),
  ].join('\n'));
  if (textClass) return textClass;
  if (browserIssues.some(issue => issue.type === 'requestfailed' || issue.type === 'http')) return 'infra';
  if (browserIssues.some(issue => issue.type === 'pageerror')) return 'crash';
  return 'unknown';
};

export const summarizeQaFailureClasses = (shards: readonly QaShardFailureInput[]): QaFailureClass[] =>
  Array.from(new Set(shards.flatMap(shard => classifyQaShardFailure(shard) ?? []))).sort(compareStableText);

const buildQaShardSeveritySignal = (shard: {
  status: QaShardManifest['status'];
  shard: number;
  handle?: string | null;
  title?: string | null;
  target?: string | null;
  error?: string | null;
  failureClass?: QaFailureClass | null;
  browserHealth?: QaBrowserHealthSummary | null;
  durationMs?: number | null;
}, since: number): QaSeveritySignal => {
  const label = shard.handle || shard.title || shard.target || `shard-${shard.shard}`;
  const evidence = [
    { label: 'shard', value: shard.shard },
    ...(shard.durationMs !== null && shard.durationMs !== undefined ? [{ label: 'duration', value: shard.durationMs, unit: 'ms' }] : []),
    ...(shard.failureClass ? [{ label: 'failure class', value: shard.failureClass }] : []),
    ...(shard.browserHealth?.issueCount ? [{ label: 'browser issues', value: shard.browserHealth.issueCount }] : []),
  ];
  if (shard.status === 'failed') {
    return makeQaSeveritySignal({
      severity: 'FAIL',
      reason: `${label} failed${shard.failureClass ? ` (${shard.failureClass})` : ''}`,
      since,
      owner: 'qa-shard',
      evidence,
    });
  }
  if (shard.status === 'unknown') {
    return makeQaSeveritySignal({
      severity: 'UNKNOWN',
      reason: `${label} did not report a final status`,
      since,
      owner: 'qa-shard',
      evidence,
    });
  }
  if (shard.browserHealth?.severity === 'FAIL') {
    return makeQaSeveritySignal({
      severity: 'FAIL',
      reason: `${label} has blocking browser errors`,
      since: shard.browserHealth.since,
      owner: 'qa-shard',
      evidence,
    });
  }
  if (shard.browserHealth?.severity === 'WARN') {
    return makeQaSeveritySignal({
      severity: 'WARN',
      reason: `${label} has browser warnings`,
      since: shard.browserHealth.since,
      owner: 'qa-shard',
      evidence,
    });
  }
  return makeQaSeveritySignal({
    severity: 'OK',
    reason: `${label} passed`,
    since,
    owner: 'qa-shard',
    evidence,
  });
};

const buildQaBenchmarkSeveritySignal = (
  benchmark: Pick<QaBenchmarkComparison, 'status' | 'reason' | 'metrics' | 'suiteLabel'>,
  since: number,
): QaSeveritySignal => {
  const evidence = [
    { label: 'suite', value: benchmark.suiteLabel },
    ...benchmark.metrics
      .filter(metric => metric.verdict !== 'ok')
      .slice(0, 6)
      .map(metric => ({ label: metric.label, value: metric.deltaPct, unit: 'percent' })),
  ];
  if (benchmark.status === 'slower' || benchmark.status === 'mixed') {
    return makeQaSeveritySignal({
      severity: 'DEGRADED',
      reason: benchmark.reason || 'Benchmark regression detected',
      since,
      owner: 'benchmark',
      evidence,
    });
  }
  if (benchmark.status === 'insufficient') {
    return makeQaSeveritySignal({
      severity: 'UNKNOWN',
      reason: benchmark.reason || 'Benchmark has no comparable baseline',
      since,
      owner: 'benchmark',
      evidence,
    });
  }
  return makeQaSeveritySignal({
    severity: 'OK',
    reason: benchmark.reason || 'Benchmark is within thresholds',
    since,
    owner: 'benchmark',
    evidence,
  });
};

const buildQaRunSeveritySignal = (run: Pick<QaRunManifest,
  'runId' | 'createdAt' | 'status' | 'failedShards' | 'totalShards' | 'browserHealth' | 'benchmark' | 'code' | 'failureClasses'
>): QaSeveritySignal => {
  const evidence = [
    { label: 'run', value: run.runId },
    { label: 'failed shards', value: run.failedShards },
    { label: 'total shards', value: run.totalShards },
    ...(run.failureClasses?.length ? [{ label: 'failure classes', value: run.failureClasses.join(',') }] : []),
    ...(run.browserHealth?.issueCount ? [{ label: 'browser issues', value: run.browserHealth.issueCount }] : []),
    ...(run.benchmark ? [{ label: 'benchmark', value: run.benchmark.status }] : []),
    ...(run.code?.gitHead ? [{ label: 'git head', value: run.code.gitHead.slice(0, 12) }] : []),
    ...(run.code?.codeHash ? [{ label: 'code hash', value: run.code.codeHash.slice(0, 16) }] : []),
  ];
  if (run.status === 'failed' || run.failedShards > 0 || run.browserHealth?.severity === 'FAIL') {
    return makeQaSeveritySignal({
      severity: 'FAIL',
      reason: run.failedShards > 0
        ? `${run.failedShards}/${run.totalShards} shard(s) failed`
        : run.browserHealth?.reason || 'QA run failed',
      since: run.createdAt,
      owner: 'qa',
      evidence,
    });
  }
  if (run.status === 'unknown') {
    return makeQaSeveritySignal({
      severity: 'UNKNOWN',
      reason: 'QA run status is unknown',
      since: run.createdAt,
      owner: 'qa',
      evidence,
    });
  }
  if (run.benchmark?.severity === 'DEGRADED' || run.code?.dirty) {
    return makeQaSeveritySignal({
      severity: 'DEGRADED',
      reason: run.code?.dirty ? 'Worktree was dirty during QA run' : run.benchmark?.reason || 'QA benchmark degraded',
      since: run.createdAt,
      owner: 'qa',
      evidence,
    });
  }
  if (run.browserHealth?.severity === 'WARN') {
    return makeQaSeveritySignal({
      severity: 'WARN',
      reason: run.browserHealth.reason,
      since: run.browserHealth.since,
      owner: 'qa',
      evidence,
    });
  }
  return makeQaSeveritySignal({
    severity: 'OK',
    reason: 'QA run is green',
    since: run.createdAt,
    owner: 'qa',
    evidence,
  });
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

export const formatQaRunIdUtc = (timestamp: number): string => {
  const d = new Date(timestamp);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const p3 = (n: number): string => String(n).padStart(3, '0');
  return [
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`,
    `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`,
    p3(d.getUTCMilliseconds()),
  ].join('-');
};

const FUTURE_RUN_SKEW_MS = 60_000;

const compareQaRunIdsForOperator = (a: string, b: string, now = Date.now()): number => {
  const latestUtcRunId = formatQaRunIdUtc(now + FUTURE_RUN_SKEW_MS);
  const aFuture = compareStableText(a, latestUtcRunId) > 0;
  const bFuture = compareStableText(b, latestUtcRunId) > 0;
  if (aFuture !== bFuture) return aFuture ? 1 : -1;
  return compareStableText(b, a);
};

const normalizeSuiteText = (value: unknown): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const runShardIdentity = (shard: QaShardManifest): string =>
  [
    normalizeSuiteText(shard.target),
    normalizeSuiteText(shard.title),
    normalizeSuiteText(shard.handle),
  ].filter(Boolean).join('::') || `shard-${shard.shard}`;

export const qaRunSuiteKey = (run: Pick<QaRunManifest, 'args' | 'shards'>): string => {
  const args = run.args ?? {};
  const source = {
    pwProject: normalizeSuiteText(args['pwProject']),
    pwGrep: normalizeSuiteText(args['pwGrep']),
    pwFiles: Array.isArray(args['pwFiles'])
      ? args['pwFiles'].map(normalizeSuiteText).sort(compareStableText)
      : normalizeSuiteText(args['pwFiles']),
    shards: run.shards.map(runShardIdentity).sort(compareStableText),
  };
  return createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 24);
};

export const qaRunSuiteLabel = (run: Pick<QaRunManifest, 'args' | 'shards'>): string => {
  if (run.shards.length === 1) {
    const shard = run.shards[0]!;
    return normalizeSuiteText(shard.handle) || normalizeSuiteText(shard.title) || normalizeSuiteText(shard.target) || 'single shard';
  }
  const args = run.args ?? {};
  const pwGrep = normalizeSuiteText(args['pwGrep']);
  if (pwGrep) return `grep:${pwGrep}`;
  const pwFiles = Array.isArray(args['pwFiles']) ? args['pwFiles'].map(normalizeSuiteText).filter(Boolean) : [];
  if (pwFiles.length > 0) return pwFiles.length === 1 ? pwFiles[0]! : `${pwFiles.length} files`;
  return `${run.shards.length} shards`;
};

type BenchmarkMetricSnapshot = {
  metric: string;
  label: string;
  unit: QaBenchmarkMetricDelta['unit'];
  value: number | null;
  thresholdPct: number;
};

const finiteMetric = (
  metric: string,
  label: string,
  unit: QaBenchmarkMetricDelta['unit'],
  value: unknown,
  thresholdPct: number,
): BenchmarkMetricSnapshot => ({
  metric,
  label,
  unit,
  value: typeof value === 'number' && Number.isFinite(value) ? value : null,
  thresholdPct,
});

const averagePhaseMs = (run: QaRunManifest, key: keyof QaPhaseTimings): number | null => {
  const values = run.shards
    .map(shard => shard.phaseMs?.[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const averageShardMs = (run: QaRunManifest): number | null => {
  const values = run.shards
    .map(shard => shard.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const maxShardMs = (run: QaRunManifest): number | null => {
  const values = run.shards
    .map(shard => shard.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
};

const averageBootstrapMs = (run: QaRunManifest): number | null => {
  const values = run.shards
    .map((shard): number | null => {
      const phase = shard.phaseMs;
      if (!phase) return null;
      return phase.preflight + phase.anvilBoot + phase.apiBoot + phase.apiHealthy + phase.viteBoot;
    })
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

export const summarizeQaRunTiming = (run: QaRunManifest): QaRunTimingSummary => ({
  avgShardMs: averageShardMs(run),
  maxShardMs: maxShardMs(run),
  bootstrapMs: averageBootstrapMs(run),
  apiHealthyMs: averagePhaseMs(run, 'apiHealthy'),
  playwrightMs: averagePhaseMs(run, 'playwright'),
});

const benchmarkSnapshot = (run: QaRunManifest): BenchmarkMetricSnapshot[] => [
  finiteMetric('totalMs', 'wall time', 'ms', run.totalMs, 20),
  finiteMetric('avgShardMs', 'avg shard', 'ms', averageShardMs(run), 20),
  finiteMetric('phase.apiHealthy', 'health wait', 'ms', averagePhaseMs(run, 'apiHealthy'), 25),
  finiteMetric('phase.playwright', 'browser test', 'ms', averagePhaseMs(run, 'playwright'), 25),
  finiteMetric('phase.viteBoot', 'vite boot', 'ms', averagePhaseMs(run, 'viteBoot'), 30),
  finiteMetric('phase.apiBoot', 'api boot', 'ms', averagePhaseMs(run, 'apiBoot'), 30),
  finiteMetric('peakLoad1', 'peak load1', 'load', run.perf?.peakLoad1, 50),
  finiteMetric('maxChildCpuPct', 'max child CPU', 'percent', run.perf?.maxChildCpuPct, 40),
  finiteMetric('maxChildRssKb', 'max child RSS', 'kb', run.perf?.maxChildRssKb, 30),
];

export const compareQaBenchmarkRuns = (
  current: QaRunManifest,
  baseline: QaRunManifest | null,
): QaBenchmarkComparison => {
  const suiteKey = qaRunSuiteKey(current);
  const suiteLabel = qaRunSuiteLabel(current);
  if (!baseline) {
    const status = 'insufficient' as const;
    const reason = 'No previous comparable E2E run found.';
    return {
      ...buildQaBenchmarkSeveritySignal({ status, reason, metrics: [], suiteLabel }, current.createdAt),
      status: 'insufficient',
      suiteKey,
      suiteLabel,
      comparedRunId: null,
      comparedGitHead: null,
      comparedCodeHash: null,
      sameGitHead: null,
      sameCodeHash: null,
      reason,
      metrics: [],
      likelyCauses: [],
    };
  }

  const baselineByMetric = new Map(benchmarkSnapshot(baseline).map(item => [item.metric, item]));
  const metrics = benchmarkSnapshot(current).flatMap((item): QaBenchmarkMetricDelta[] => {
    const base = baselineByMetric.get(item.metric);
    if (item.value === null || !base || base.value === null || base.value <= 0) return [];
    const delta = item.value - base.value;
    const deltaPct = (delta / base.value) * 100;
    const verdict: QaBenchmarkMetricDelta['verdict'] =
      deltaPct >= item.thresholdPct ? 'slower' : deltaPct <= -item.thresholdPct ? 'faster' : 'ok';
    return [{
      metric: item.metric,
      label: item.label,
      unit: item.unit,
      current: Math.round(item.value * 100) / 100,
      baseline: Math.round(base.value * 100) / 100,
      delta: Math.round(delta * 100) / 100,
      deltaPct: Math.round(deltaPct * 100) / 100,
      thresholdPct: item.thresholdPct,
      verdict,
    }];
  });

  const slower = metrics.filter(metric => metric.verdict === 'slower').sort((a, b) => b.deltaPct - a.deltaPct);
  const blockingSlower = slower.filter(metric => metric.metric !== 'peakLoad1');
  const faster = metrics.filter(metric => metric.verdict === 'faster').sort((a, b) => a.deltaPct - b.deltaPct);
  const fasterTiming = faster.filter(metric => metric.unit === 'ms');
  const status: QaBenchmarkStatus =
    blockingSlower.length > 0 && fasterTiming.length > 0 ? 'mixed'
      : blockingSlower.length > 0 ? 'slower'
        : fasterTiming.length > 0 ? 'faster'
          : 'ok';
  const top = blockingSlower[0] ?? fasterTiming[0] ?? null;
  const hostLoadOnly = slower.length > 0 && blockingSlower.length === 0;
  const hostLoadDelta = slower.find(metric => metric.metric === 'peakLoad1') ?? null;
  const sameGitHead = Boolean(current.code?.gitHead && baseline.code?.gitHead)
    ? current.code!.gitHead === baseline.code!.gitHead
    : null;
  const sameCodeHash = Boolean(current.code?.codeHash && baseline.code?.codeHash)
    ? current.code!.codeHash === baseline.code!.codeHash
    : null;
  const likelyCauses = [
    ...(sameCodeHash === false ? ['code hash changed'] : []),
    ...(sameGitHead === false ? ['git HEAD changed'] : []),
    ...(current.code?.dirty ? ['current worktree is dirty'] : []),
    ...(hostLoadOnly ? ['host load increased without app timing regression'] : []),
    ...(top ? [`largest delta: ${top.label} ${top.deltaPct > 0 ? '+' : ''}${top.deltaPct}%`] : []),
  ];
  const reason = top
    ? `${top.label} ${top.deltaPct > 0 ? '+' : ''}${top.deltaPct}% vs ${baseline.runId}`
    : hostLoadOnly && hostLoadDelta
      ? `Timing within thresholds; host load ${hostLoadDelta.deltaPct > 0 ? '+' : ''}${hostLoadDelta.deltaPct}% vs ${baseline.runId}`
    : faster.length > 0
      ? `Timing within thresholds; resource usage improved vs ${baseline.runId}`
      : `Within thresholds vs ${baseline.runId}`;

  return {
    ...buildQaBenchmarkSeveritySignal({ status, reason, metrics, suiteLabel }, current.createdAt),
    status,
    suiteKey,
    suiteLabel,
    comparedRunId: baseline.runId,
    comparedGitHead: baseline.code?.gitHead ?? null,
    comparedCodeHash: baseline.code?.codeHash ?? null,
    sameGitHead,
    sameCodeHash,
    reason,
    metrics,
    likelyCauses,
  };
};

const normalizeQaShardSeverity = (shard: QaShardManifest, since: number): QaShardManifest => {
  const fallback = buildQaShardSeveritySignal(shard, since);
  return {
    ...shard,
    ...normalizeQaSeveritySignal(shard, fallback),
  };
};

const normalizeQaBenchmarkSeverity = (
  benchmark: QaBenchmarkComparison | undefined,
  since: number,
): QaBenchmarkComparison | undefined => {
  if (!benchmark) return undefined;
  const fallback = buildQaBenchmarkSeveritySignal(benchmark, since);
  return {
    ...benchmark,
    ...normalizeQaSeveritySignal(benchmark, fallback),
  };
};

export const applyQaRunSeverity = (run: QaRunManifest): QaRunManifest => {
  const since = run.createdAt;
  const shards = run.shards.map(shard => normalizeQaShardSeverity(shard, since));
  const browserHealth = normalizeQaBrowserHealthSummary(
    run.browserHealth ?? summarizeQaRunBrowserHealth({ shards }),
    since,
  );
  const benchmark = normalizeQaBenchmarkSeverity(run.benchmark, since);
  const failureClasses = run.failureClasses ?? summarizeQaFailureClasses(shards);
  const normalizedRun: QaRunManifest = {
    ...run,
    shards,
    browserHealth,
    ...(benchmark ? { benchmark } : {}),
    failureClasses,
  };
  return {
    ...normalizedRun,
    ...normalizeQaSeveritySignal(normalizedRun, buildQaRunSeveritySignal(normalizedRun)),
  };
};

export const assertQaReleaseRunSeverity = (run: QaRunManifest): void => {
  if (run.manifestVersion < 3) return;
  assertQaSeveritySignal(run, 'QA_RUN');
  for (const shard of run.shards) {
    assertQaSeveritySignal(shard, `QA_SHARD_${shard.shard}`);
  }
  if (run.benchmark) assertQaSeveritySignal(run.benchmark, 'QA_BENCHMARK');
  if (run.browserHealth) assertQaSeveritySignal(run.browserHealth, 'QA_BROWSER_HEALTH');
};

const parseManifestJson = (value: unknown): QaRunManifest | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return applyQaRunSeverity(JSON.parse(value) as QaRunManifest);
  } catch {
    return null;
  }
};

const openQaHistoryDb = (): Database => {
  mkdirSync(resolve(process.cwd(), '.logs'), { recursive: true });
  const db = new Database(QA_HISTORY_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS qa_runs (
      run_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL,
      total_ms INTEGER,
      total_shards INTEGER NOT NULL,
      passed_shards INTEGER NOT NULL,
      failed_shards INTEGER NOT NULL,
      git_head TEXT,
      git_branch TEXT,
      dirty INTEGER NOT NULL DEFAULT 0,
      code_hash TEXT,
      avg_load1 REAL,
      peak_load1 REAL,
      max_child_cpu_pct REAL,
      max_child_rss_kb INTEGER,
      suite_key TEXT,
      benchmark_status TEXT,
      benchmark_delta_pct REAL,
      benchmark_compared_run_id TEXT,
      browser_issue_count INTEGER NOT NULL DEFAULT 0,
      browser_error_count INTEGER NOT NULL DEFAULT 0,
      browser_warning_count INTEGER NOT NULL DEFAULT 0,
      network_failure_count INTEGER NOT NULL DEFAULT 0,
      http_error_count INTEGER NOT NULL DEFAULT 0,
      avg_shard_ms REAL,
      max_shard_ms REAL,
      bootstrap_ms REAL,
      api_healthy_ms REAL,
      playwright_ms REAL,
      logs_dir TEXT NOT NULL,
      manifest_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS qa_runs_created_at_idx ON qa_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS qa_runs_code_hash_idx ON qa_runs(code_hash);
    CREATE INDEX IF NOT EXISTS qa_runs_git_head_idx ON qa_runs(git_head);
  `);
  const columns = new Set((db.query(`PRAGMA table_info(qa_runs)`).all() as Array<Record<string, unknown>>).map(row => String(row['name'])));
  const addColumn = (name: string, ddl: string): void => {
    if (columns.has(name)) return;
    db.exec(`ALTER TABLE qa_runs ADD COLUMN ${name} ${ddl}`);
  };
  addColumn('suite_key', 'TEXT');
  addColumn('benchmark_status', 'TEXT');
  addColumn('benchmark_delta_pct', 'REAL');
  addColumn('benchmark_compared_run_id', 'TEXT');
  addColumn('browser_issue_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('browser_error_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('browser_warning_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('network_failure_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('http_error_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('avg_shard_ms', 'REAL');
  addColumn('max_shard_ms', 'REAL');
  addColumn('bootstrap_ms', 'REAL');
  addColumn('api_healthy_ms', 'REAL');
  addColumn('playwright_ms', 'REAL');
  db.exec(`CREATE INDEX IF NOT EXISTS qa_runs_suite_key_idx ON qa_runs(suite_key, created_at DESC);`);
  return db;
};

const toNullableNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const stripQaHistoryPerfSamples = (run: QaRunManifest): QaRunManifest => ({
  ...run,
  ...(run.perf ? { perf: { ...run.perf, samples: [] } } : {}),
  shards: run.shards.map(shard => ({
    ...shard,
    ...(shard.perf ? { perf: { ...shard.perf, samples: [] } } : {}),
  })),
});

export const recordQaRunHistory = (run: QaRunManifest, logsDir: string): void => {
  const normalizedRun = applyQaRunSeverity(run);
  assertQaReleaseRunSeverity(normalizedRun);
  const timing = summarizeQaRunTiming(normalizedRun);
  const browserHealth = normalizedRun.browserHealth ?? summarizeQaRunBrowserHealth(normalizedRun);
  const db = openQaHistoryDb();
  try {
    db.query(`
      INSERT INTO qa_runs (
        run_id,
        created_at,
        completed_at,
        status,
        total_ms,
        total_shards,
        passed_shards,
        failed_shards,
        git_head,
        git_branch,
        dirty,
        code_hash,
        avg_load1,
        peak_load1,
        max_child_cpu_pct,
        max_child_rss_kb,
        suite_key,
        benchmark_status,
        benchmark_delta_pct,
        benchmark_compared_run_id,
        browser_issue_count,
        browser_error_count,
        browser_warning_count,
        network_failure_count,
        http_error_count,
        avg_shard_ms,
        max_shard_ms,
        bootstrap_ms,
        api_healthy_ms,
        playwright_ms,
        logs_dir,
        manifest_json
      ) VALUES (
        $runId,
        $createdAt,
        $completedAt,
        $status,
        $totalMs,
        $totalShards,
        $passedShards,
        $failedShards,
        $gitHead,
        $gitBranch,
        $dirty,
        $codeHash,
        $avgLoad1,
        $peakLoad1,
        $maxChildCpuPct,
        $maxChildRssKb,
        $suiteKey,
        $benchmarkStatus,
        $benchmarkDeltaPct,
        $benchmarkComparedRunId,
        $browserIssueCount,
        $browserErrorCount,
        $browserWarningCount,
        $networkFailureCount,
        $httpErrorCount,
        $avgShardMs,
        $maxShardMs,
        $bootstrapMs,
        $apiHealthyMs,
        $playwrightMs,
        $logsDir,
        $manifestJson
      )
      ON CONFLICT(run_id) DO UPDATE SET
        created_at = excluded.created_at,
        completed_at = excluded.completed_at,
        status = excluded.status,
        total_ms = excluded.total_ms,
        total_shards = excluded.total_shards,
        passed_shards = excluded.passed_shards,
        failed_shards = excluded.failed_shards,
        git_head = excluded.git_head,
        git_branch = excluded.git_branch,
        dirty = excluded.dirty,
        code_hash = excluded.code_hash,
        avg_load1 = excluded.avg_load1,
        peak_load1 = excluded.peak_load1,
        max_child_cpu_pct = excluded.max_child_cpu_pct,
        max_child_rss_kb = excluded.max_child_rss_kb,
        suite_key = excluded.suite_key,
        benchmark_status = excluded.benchmark_status,
        benchmark_delta_pct = excluded.benchmark_delta_pct,
        benchmark_compared_run_id = excluded.benchmark_compared_run_id,
        browser_issue_count = excluded.browser_issue_count,
        browser_error_count = excluded.browser_error_count,
        browser_warning_count = excluded.browser_warning_count,
        network_failure_count = excluded.network_failure_count,
        http_error_count = excluded.http_error_count,
        avg_shard_ms = excluded.avg_shard_ms,
        max_shard_ms = excluded.max_shard_ms,
        bootstrap_ms = excluded.bootstrap_ms,
        api_healthy_ms = excluded.api_healthy_ms,
        playwright_ms = excluded.playwright_ms,
        logs_dir = excluded.logs_dir,
        manifest_json = excluded.manifest_json
    `).run({
      $runId: normalizedRun.runId,
      $createdAt: normalizedRun.createdAt,
      $completedAt: normalizedRun.completedAt,
      $status: normalizedRun.status,
      $totalMs: normalizedRun.totalMs,
      $totalShards: normalizedRun.totalShards,
      $passedShards: normalizedRun.passedShards,
      $failedShards: normalizedRun.failedShards,
      $gitHead: normalizedRun.code?.gitHead ?? null,
      $gitBranch: normalizedRun.code?.gitBranch ?? null,
      $dirty: normalizedRun.code?.dirty ? 1 : 0,
      $codeHash: normalizedRun.code?.codeHash ?? null,
      $avgLoad1: toNullableNumber(normalizedRun.perf?.avgLoad1),
      $peakLoad1: toNullableNumber(normalizedRun.perf?.peakLoad1),
      $maxChildCpuPct: toNullableNumber(normalizedRun.perf?.maxChildCpuPct),
      $maxChildRssKb: toNullableNumber(normalizedRun.perf?.maxChildRssKb),
      $suiteKey: qaRunSuiteKey(normalizedRun),
      $benchmarkStatus: normalizedRun.benchmark?.status ?? null,
      $benchmarkDeltaPct: normalizedRun.benchmark?.metrics.find(metric => metric.metric === 'totalMs')?.deltaPct ?? null,
      $benchmarkComparedRunId: normalizedRun.benchmark?.comparedRunId ?? null,
      $browserIssueCount: browserHealth.issueCount,
      $browserErrorCount: browserHealth.errorCount,
      $browserWarningCount: browserHealth.warningCount,
      $networkFailureCount: browserHealth.networkFailureCount,
      $httpErrorCount: browserHealth.httpErrorCount,
      $avgShardMs: timing.avgShardMs,
      $maxShardMs: timing.maxShardMs,
      $bootstrapMs: timing.bootstrapMs,
      $apiHealthyMs: timing.apiHealthyMs,
      $playwrightMs: timing.playwrightMs,
      $logsDir: logsDir,
      $manifestJson: JSON.stringify(stripQaHistoryPerfSamples(normalizedRun)),
    });
  } finally {
    db.close();
  }
};

const rowToQaHistoryEntry = (row: Record<string, unknown>): QaHistoryEntry => ({
  runId: String(row['run_id'] || ''),
  createdAt: Number(row['created_at'] || 0),
  completedAt: toNullableNumber(row['completed_at']),
  status: row['status'] === 'passed' || row['status'] === 'failed' ? row['status'] : 'unknown',
  totalMs: toNullableNumber(row['total_ms']),
  totalShards: Number(row['total_shards'] || 0),
  passedShards: Number(row['passed_shards'] || 0),
  failedShards: Number(row['failed_shards'] || 0),
  gitHead: typeof row['git_head'] === 'string' ? row['git_head'] : null,
  gitBranch: typeof row['git_branch'] === 'string' ? row['git_branch'] : null,
  dirty: Number(row['dirty'] || 0) === 1,
  codeHash: typeof row['code_hash'] === 'string' ? row['code_hash'] : null,
  avgLoad1: toNullableNumber(row['avg_load1']),
  peakLoad1: toNullableNumber(row['peak_load1']),
  maxChildCpuPct: toNullableNumber(row['max_child_cpu_pct']),
  maxChildRssKb: toNullableNumber(row['max_child_rss_kb']),
  suiteKey: typeof row['suite_key'] === 'string' ? row['suite_key'] : null,
  benchmarkStatus: (
    row['benchmark_status'] === 'ok' ||
    row['benchmark_status'] === 'faster' ||
    row['benchmark_status'] === 'slower' ||
    row['benchmark_status'] === 'mixed' ||
    row['benchmark_status'] === 'insufficient'
  ) ? row['benchmark_status'] : null,
  benchmarkDeltaPct: toNullableNumber(row['benchmark_delta_pct']),
  benchmarkComparedRunId: typeof row['benchmark_compared_run_id'] === 'string' ? row['benchmark_compared_run_id'] : null,
  browserIssueCount: Number(row['browser_issue_count'] || 0),
  browserErrorCount: Number(row['browser_error_count'] || 0),
  browserWarningCount: Number(row['browser_warning_count'] || 0),
  networkFailureCount: Number(row['network_failure_count'] || 0),
  httpErrorCount: Number(row['http_error_count'] || 0),
  avgShardMs: toNullableNumber(row['avg_shard_ms']),
  maxShardMs: toNullableNumber(row['max_shard_ms']),
  bootstrapMs: toNullableNumber(row['bootstrap_ms']),
  apiHealthyMs: toNullableNumber(row['api_healthy_ms']),
  playwrightMs: toNullableNumber(row['playwright_ms']),
  logsDir: String(row['logs_dir'] || ''),
});

const rowToQaRunSummary = (row: Record<string, unknown>): QaRunSummary => {
  const parsed = parseManifestJson(row['manifest_json']);
  if (parsed) return summarizeQaRun(parsed);
  const history = rowToQaHistoryEntry(row);
  const browserHealth = normalizeQaBrowserHealthSummary({
    issueCount: history.browserIssueCount,
    errorCount: history.browserErrorCount,
    warningCount: history.browserWarningCount,
    networkFailureCount: history.networkFailureCount,
    httpErrorCount: history.httpErrorCount,
  } as QaBrowserHealthSummary, history.createdAt);
  return summarizeQaRun(applyQaRunSeverity({
    manifestVersion: 1,
    runId: history.runId,
    createdAt: history.createdAt,
    completedAt: history.completedAt,
    status: history.status,
    totalMs: history.totalMs,
    browserHealth,
    totalShards: history.totalShards,
    passedShards: history.passedShards,
    failedShards: history.failedShards,
    failureClasses: [],
    args: null,
    shards: [],
  } as unknown as QaRunManifest));
};

export const findComparableQaBenchmarkRun = (run: QaRunManifest): QaRunManifest | null => {
  const db = openQaHistoryDb();
  try {
    const row = db.query(`
      SELECT manifest_json
      FROM qa_runs
      WHERE suite_key = $suiteKey
        AND run_id != $runId
        AND total_ms IS NOT NULL
        AND created_at < $createdAt
      ORDER BY created_at DESC
      LIMIT 1
    `).get({
      $suiteKey: qaRunSuiteKey(run),
      $runId: run.runId,
      $createdAt: run.createdAt,
    }) as Record<string, unknown> | null;
    const direct = parseManifestJson(row?.['manifest_json']);
    if (direct) return direct;
    const fallbackRows = db.query(`
      SELECT manifest_json
      FROM qa_runs
      WHERE run_id != $runId
        AND total_ms IS NOT NULL
        AND created_at < $createdAt
      ORDER BY created_at DESC
      LIMIT 200
    `).all({
      $runId: run.runId,
      $createdAt: run.createdAt,
    }) as Array<Record<string, unknown>>;
    const suiteKey = qaRunSuiteKey(run);
    for (const candidate of fallbackRows) {
      const parsed = parseManifestJson(candidate['manifest_json']);
      if (parsed && qaRunSuiteKey(parsed) === suiteKey) return parsed;
    }
    return null;
  } finally {
    db.close();
  }
};

export const compareQaRunWithHistory = (run: QaRunManifest): QaBenchmarkComparison => {
  const baseline = findComparableQaBenchmarkRun(run);
  return compareQaBenchmarkRuns(run, baseline);
};

export const listQaHistory = async (limit = 100): Promise<QaHistoryEntry[]> => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
  const db = openQaHistoryDb();
  try {
    const rows = db.query(`
      SELECT
        run_id,
        created_at,
        completed_at,
        status,
        total_ms,
        total_shards,
        passed_shards,
        failed_shards,
        git_head,
        git_branch,
        dirty,
        code_hash,
        avg_load1,
        peak_load1,
        max_child_cpu_pct,
        max_child_rss_kb,
        suite_key,
        benchmark_status,
        benchmark_delta_pct,
        benchmark_compared_run_id,
        browser_issue_count,
        browser_error_count,
        browser_warning_count,
        network_failure_count,
        http_error_count,
        avg_shard_ms,
        max_shard_ms,
        bootstrap_ms,
        api_healthy_ms,
        playwright_ms,
        logs_dir
      FROM qa_runs
      ORDER BY
        CASE WHEN created_at > $latestRealCreatedAt THEN 1 ELSE 0 END ASC,
        created_at DESC
      LIMIT $limit
    `).all({ $limit: safeLimit, $latestRealCreatedAt: Date.now() + FUTURE_RUN_SKEW_MS }) as Array<Record<string, unknown>>;
    return rows.map(rowToQaHistoryEntry);
  } finally {
    db.close();
  }
};

export const listQaRunSummaries = async (limit = 20): Promise<QaRunSummary[]> => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20;
  const db = openQaHistoryDb();
  try {
    const rows = db.query(`
      SELECT
        run_id,
        created_at,
        completed_at,
        status,
        total_ms,
        total_shards,
        passed_shards,
        failed_shards,
        git_head,
        git_branch,
        dirty,
        code_hash,
        avg_load1,
        peak_load1,
        max_child_cpu_pct,
        max_child_rss_kb,
        suite_key,
        benchmark_status,
        benchmark_delta_pct,
        benchmark_compared_run_id,
        browser_issue_count,
        browser_error_count,
        browser_warning_count,
        network_failure_count,
        http_error_count,
        avg_shard_ms,
        max_shard_ms,
        bootstrap_ms,
        api_healthy_ms,
        playwright_ms,
        logs_dir,
        manifest_json
      FROM qa_runs
      ORDER BY
        CASE WHEN created_at > $latestRealCreatedAt THEN 1 ELSE 0 END ASC,
        created_at DESC
      LIMIT $limit
    `).all({ $limit: safeLimit, $latestRealCreatedAt: Date.now() + FUTURE_RUN_SKEW_MS }) as Array<Record<string, unknown>>;
    if (rows.length > 0) return rows.map(rowToQaRunSummary);
  } finally {
    db.close();
  }
  const runs = await listQaRuns(safeLimit);
  return runs.map(summarizeQaRun);
};

export const backfillQaHistoryFromLogs = async (limit = 500): Promise<QaHistoryBackfillResult> => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(2_000, Math.floor(limit))) : 500;
  const runIds = await listQaRunIds(safeLimit);
  const failedRuns: QaHistoryBackfillResult['failedRuns'] = [];
  let recordedRuns = 0;
  for (const runId of runIds) {
    try {
      const run = await readQaRun(runId);
      recordQaRunHistory(run, join(QA_LOGS_ROOT, run.runId));
      recordedRuns += 1;
    } catch (error) {
      failedRuns.push({
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    scannedRuns: runIds.length,
    recordedRuns,
    failedRuns,
  };
};

export const purgeQaRunsOlderThan = (retentionDays = 30, now = Date.now()): QaRetentionPurgeResult => {
  const safeRetentionDays = Number.isFinite(retentionDays) ? Math.max(30, Math.floor(retentionDays)) : 30;
  const cutoff = now - safeRetentionDays * 24 * 60 * 60 * 1000;
  const deletedRunIds: string[] = [];
  let deletedLogDirs = 0;

  if (existsSync(QA_LOGS_ROOT)) {
    for (const entry of readdirSync(QA_LOGS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{8}-\d{6}-\d{3}$/.test(entry.name)) continue;
      const createdAt = parseRunIdTimestamp(entry.name);
      if (createdAt === null || createdAt >= cutoff) continue;
      rmSync(join(QA_LOGS_ROOT, entry.name), { recursive: true, force: true });
      deletedRunIds.push(entry.name);
      deletedLogDirs += 1;
    }
  }

  const db = openQaHistoryDb();
  try {
    const result = db.query(`DELETE FROM qa_runs WHERE created_at < $cutoff`).run({ $cutoff: cutoff }) as { changes?: number };
    return {
      retentionDays: safeRetentionDays,
      cutoff,
      deletedRunIds: deletedRunIds.sort(compareStableText),
      deletedLogDirs,
      deletedHistoryRows: typeof result.changes === 'number' ? result.changes : 0,
    };
  } finally {
    db.close();
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

const detectContentType = (name: string): string =>
  MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';

const storyTitle = (name: string): string => {
  const stem = name.replace(/\.[^.]+$/, '');
  const words = stem
    .replace(/^\d+[-_]/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : stem;
};

const storyGroup = (name: string): string => {
  const stem = name.replace(/\.[^.]+$/, '').toLowerCase();
  const firstToken = stem.split(/[-_]/).find(Boolean) || 'screens';
  if (/^\d+$/.test(firstToken)) return 'journey';
  if (firstToken === 'step') return 'proposal flow';
  if (firstToken === 'working') return 'working path';
  if (firstToken === 'selection') return 'selection';
  if (firstToken === 'proposal') return 'proposal';
  if (firstToken === 'execution') return 'execution';
  if (firstToken === 'zero') return 'empty state';
  if (firstToken === 'debug') return 'debug';
  if (firstToken === 'fast') return 'fast path';
  if (firstToken === 'final') return 'final state';
  if (firstToken === 'full') return 'full flow';
  return firstToken;
};

const readUxScreenshotMetadata = async (imagePath: string): Promise<QaUxScreenshotMetadata | null> => {
  const metadataPath = `${imagePath}.json`;
  if (!existsSync(metadataPath)) return null;
  try {
    const parsed = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    const title = asNullableString(parsed['title']);
    const group = asNullableString(parsed['group']);
    const description = asNullableString(parsed['description']);
    const platform = asNullableString(parsed['platform']);
    const rawTags = Array.isArray(parsed['tags']) ? parsed['tags'] : [];
    const tags = rawTags
      .map((tag) => String(tag || '').trim())
      .filter(Boolean)
      .slice(0, 12);
    if (!title && !group && !description && !platform && tags.length === 0) return null;
    return { title, group, description, platform, tags };
  } catch {
    return null;
  }
};

export const makeQaStoryImageUrl = (source: QaStorySource, relativePath: string): string =>
  `/api/qa/story-image?source=${encodeURIComponent(source)}&path=${encodeURIComponent(relativePath)}`;

const shortTail = (text: string, lines = 80): string => text.split('\n').slice(-lines).join('\n');

const humanizeSlug = (value: string): string =>
  value
    .replace(/^e2e-/, '')
    .replace(/\.spec\.ts$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

const titleSlug = (title: string): string => {
  const cleaned = title
    .replace(/['"]/g, '')
    .replace(/->/g, ' to ')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const words = cleaned.split('-').filter(Boolean);
  return words.slice(0, 5).join('-') || 'case';
};

const parseTargetFile = (target: string | null | undefined): string => {
  const raw = String(target || '').trim();
  const match = raw.match(/^(.*?\.spec\.ts)(?::\d+)?/);
  return match?.[1] || raw;
};

const normalizedQaText = (target: string | null | undefined, title: string | null | undefined): string =>
  `${target || ''} ${title || ''}`
    .replace(/[_./:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();

export const deriveQaTestHandle = (target: string | null | undefined, title: string | null | undefined): string => {
  const key = normalizedQaText(target, title);
  if (key.includes('dispute') && key.includes('lifecycle') && key.includes('reserve')) {
    return 'dispute.lifecycle-return';
  }
  if (key.includes('dispute') && key.includes('sign') && key.includes('broadcast')) {
    return 'dispute.sign-broadcast';
  }
  if (key.includes('payment') && key.includes('smoke')) {
    return 'payment.smoke';
  }
  if (key.includes('baseline') || key.includes('cold reset provisions')) {
    return 'baseline.mesh-reserves';
  }
  if (key.includes('connect')) {
    return 'wallet.connect';
  }
  const file = parseTargetFile(target);
  const suite = humanizeSlug(basename(file || 'e2e'));
  const titlePart = titleSlug(String(title || target || 'case'));
  return `${suite}.${titlePart}`;
};

export const deriveQaTestDescription = (
  target: string | null | undefined,
  title: string | null | undefined,
): string => {
  const key = normalizedQaText(target, title);
  if (key.includes('dispute') && key.includes('lifecycle') && key.includes('reserve')) {
    return 'Opens a disputed account, waits through the dispute window, finalizes it, and verifies that the reserve is returned.';
  }
  if (key.includes('dispute') && key.includes('sign') && key.includes('broadcast')) {
    return 'Builds a settlement workspace, signs the dispute batch, broadcasts it, and verifies that the hub accepts the result.';
  }
  if (key.includes('payment') && key.includes('smoke')) {
    return 'Creates users, opens the hub route, sends a payment, and verifies that the receipt path is usable.';
  }
  if (key.includes('baseline')) {
    return 'Starts an isolated stack, logs in, checks health, and confirms account opening reaches the first frame.';
  }
  if (key.includes('connect')) {
    return 'Checks that the browser wallet connects to the isolated runtime and reaches the account workspace.';
  }
  const text = String(title || target || '').trim();
  if (!text) return 'No test description recorded.';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
};

type QaTargetMetadata = {
  shard: number;
  target: string | null;
  title: string | null;
  handle: string | null;
  description: string | null;
  requireMarketMaker: boolean | null;
};

const readTargetsMetadata = async (runDir: string): Promise<Map<number, QaTargetMetadata>> => {
  const out = new Map<number, QaTargetMetadata>();
  try {
    const raw = await readFile(join(runDir, 'targets.json'), 'utf8');
    const parsed = JSON.parse(raw) as Array<Partial<QaTargetMetadata>>;
    if (!Array.isArray(parsed)) return out;
    for (const entry of parsed) {
      const shard = Number(entry.shard);
      if (!Number.isFinite(shard)) continue;
      const target = typeof entry.target === 'string' ? entry.target : null;
      const title = typeof entry.title === 'string' ? entry.title : target;
      out.set(shard, {
        shard,
        target,
        title,
        handle: typeof entry.handle === 'string' ? entry.handle : deriveQaTestHandle(target, title),
        description: typeof entry.description === 'string' ? entry.description : deriveQaTestDescription(target, title),
        requireMarketMaker: typeof entry.requireMarketMaker === 'boolean' ? entry.requireMarketMaker : null,
      });
    }
  } catch {
    return out;
  }
  return out;
};

export const parseQaTimelineSteps = (text: string): QaSlowStep[] => {
  const out: QaSlowStep[] = [];
  const pendingTimingByLabel = new Map<string, number>();
  const cueRe = /^\[(E2E-CUE|MESH-CUE)\]\s+(.+?)\s+start=(\d+)ms\s+end=(\d+)ms\s+duration=(\d+)ms(?:\s.*)?$/;
  const timingRe = /^\[(E2E-TIMING|MESH-TIMING)\]\s+(.+?)\s+(\d+)ms(?:\s.*)?$/;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const cue = cueRe.exec(line);
    if (cue) {
      const prefix = cue[1] === 'MESH-CUE' ? 'MESH-TIMING' : 'E2E-TIMING';
      const label = `${prefix}:${String(cue[2] || '').trim()}`;
      const startMs = Number(cue[3] || '0');
      const endMs = Number(cue[4] || '0');
      const ms = Number(cue[5] || '0');
      if (!label || !Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(ms)) continue;
      const step = {
        label,
        ms: Math.max(0, Math.floor(ms)),
        startMs: Math.max(0, Math.floor(startMs)),
        endMs: Math.max(Math.max(0, Math.floor(startMs)), Math.floor(endMs)),
      };
      const pendingIndex = pendingTimingByLabel.get(label);
      if (pendingIndex !== undefined && out[pendingIndex]?.startMs === undefined) {
        out[pendingIndex] = step;
      } else {
        out.push(step);
      }
      pendingTimingByLabel.delete(label);
      continue;
    }

    const timing = timingRe.exec(line);
    if (!timing) continue;
    const label = `${String(timing[1] || '').trim()}:${String(timing[2] || '').trim()}`;
    const ms = Number(timing[3] || '0');
    if (!label || !Number.isFinite(ms)) continue;
    pendingTimingByLabel.set(label, out.length);
    out.push({ label, ms: Math.max(0, Math.floor(ms)) });
  }
  return out;
};

export const parseQaSlowSteps = (text: string): QaSlowStep[] => {
  const out = parseQaTimelineSteps(text);
  return out.sort((a, b) => b.ms - a.ms);
};

const parsePhaseTimings = (text: string): QaPhaseTimings | null => {
  const phases: Partial<QaPhaseTimings> = {};
  const re = /^\[timing\]\s+(\w+)=(\d+)ms/gm;
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
    phaseMs.preflight + phaseMs.anvilBoot + phaseMs.apiBoot + phaseMs.apiHealthy + phaseMs.viteBoot + phaseMs.playwright
  );
};

const artifactKindRank: Record<QaArtifactKind, number> = {
  video: 0,
  image: 1,
  trace: 2,
  text: 3,
  json: 4,
  archive: 5,
  other: 6,
};

const sortArtifacts = (artifacts: QaArtifact[]): QaArtifact[] =>
  artifacts.sort((a, b) => artifactKindRank[a.kind] - artifactKindRank[b.kind] || compareStableText(a.name, b.name));

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
    const kind = detectArtifactKind(entry.name);
    const contentType = detectContentType(entry.name);
    const relativePath = absolutePath.slice(baseDir.length + 1);
    out.push({
      name: entry.name,
      relativePath,
      sizeBytes: fileStat.size,
      kind,
      sensitivity: classifyQaArtifactSensitivity({ name: entry.name, relativePath, kind, contentType }),
      contentType,
    });
  }
};

const walkStoryScreenshots = async (
  baseDir: string,
  currentDir: string,
  out: QaStoryScreenshot[],
): Promise<void> => {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkStoryScreenshots(baseDir, absolutePath, out);
      continue;
    }
    if (!STORY_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const fileStat = await stat(absolutePath);
    const relativePath = absolutePath.slice(baseDir.length + 1);
    const metadata = await readUxScreenshotMetadata(absolutePath);
    out.push({
      id: `e2e-screenshots:${relativePath}`,
      source: 'e2e-screenshots',
      title: metadata?.title ?? storyTitle(entry.name),
      group: metadata?.group ?? storyGroup(entry.name),
      description: metadata?.description ?? null,
      platform: metadata?.platform ?? null,
      tags: metadata?.tags ?? [],
      curated: Boolean(metadata),
      name: entry.name,
      relativePath,
      sizeBytes: fileStat.size,
      updatedAt: fileStat.mtimeMs,
      url: makeQaStoryImageUrl('e2e-screenshots', relativePath),
    });
  }
};

const listRepositoryStoryScreenshots = async (): Promise<QaStoryScreenshot[]> => {
  const rootStat = await stat(QA_STORY_SCREENSHOTS_ROOT).catch(() => null);
  if (!rootStat?.isDirectory()) return [];
  const stories: QaStoryScreenshot[] = [];
  await walkStoryScreenshots(QA_STORY_SCREENSHOTS_ROOT, QA_STORY_SCREENSHOTS_ROOT, stories);
  return stories.sort((a, b) => compareStableText(a.group, b.group) || compareStableText(a.name, b.name));
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

const collectLegacyShard = async (
  _runId: string,
  runDir: string,
  shard: number,
  targetMetadata: Map<number, QaTargetMetadata>,
): Promise<QaShardManifest> => {
  const logRelativePath = `e2e-shard-${String(shard).padStart(2, '0')}.log`;
  const logPath = join(runDir, logRelativePath);
  const resultsDir = join(runDir, `test-results-shard-${shard}`);
  const logText = existsSync(logPath) ? await readFile(logPath, 'utf8') : '';
  const phaseMs = parsePhaseTimings(logText);
  const timelineSteps = parseQaTimelineSteps(logText).slice(0, 80);
  const slowSteps = parseQaSlowSteps(logText).slice(0, 12);
  const browserIssues: QaBrowserIssue[] = [];
  const artifacts: QaArtifact[] = [];
  const metadata = targetMetadata.get(shard) ?? null;
  let title: string | null = metadata?.title ?? null;
  let status: 'passed' | 'failed' | 'unknown' = 'unknown';

  if (existsSync(resultsDir)) {
    status = await readLastRunStatus(resultsDir);
    const entries = await readdir(resultsDir, { withFileTypes: true });
    const caseDir = entries.find(entry => entry.isDirectory() && !entry.name.startsWith('.'));
    if (!title && caseDir) title = caseDir.name;
    await walkArtifacts(runDir, resultsDir, artifacts);
    sortArtifacts(artifacts);
  }
  const logTail = logText ? redactQaSecretText(shortTail(logText)) : null;
  const error = status === 'failed' ? redactQaSecretText(shortTail(logText, 40)) : null;

  const browserHealth = summarizeQaBrowserIssues(browserIssues);
  return normalizeQaShardSeverity({
    shard,
    status,
    durationMs: sumPhaseTimings(phaseMs),
    target: metadata?.target ?? null,
    title,
    requireMarketMaker: metadata?.requireMarketMaker ?? null,
    logRelativePath: existsSync(logPath) ? logRelativePath : null,
    logTail,
    error,
    failureClass: classifyQaShardFailure({ status, error, logTail, browserIssues }),
    phaseMs,
    browserIssues,
    browserHealth,
    timelineSteps,
    slowSteps,
    artifacts,
    hasVideo: artifacts.some(artifact => artifact.kind === 'video'),
    hasTrace: artifacts.some(artifact => artifact.kind === 'trace'),
    handle: metadata?.handle ?? deriveQaTestHandle(metadata?.target ?? null, title),
    description: metadata?.description ?? deriveQaTestDescription(metadata?.target ?? null, title),
  } as QaShardManifest, parseRunIdTimestamp(_runId) ?? 0);
};

const buildLegacyManifest = async (runId: string, runDir: string): Promise<QaRunManifest> => {
  const runStat = await stat(runDir);
  const allEntries = await readdir(runDir);
  const targetMetadata = await readTargetsMetadata(runDir);
  const shardIds = Array.from(
    new Set([
      ...Array.from(targetMetadata.keys()),
      ...allEntries.flatMap(entry => {
        const logMatch = /^e2e-shard-(\d+)\.log$/.exec(entry);
        if (logMatch) return [Number(logMatch[1])];
        const resultsMatch = /^test-results-shard-(\d+)$/.exec(entry);
        if (resultsMatch) return [Number(resultsMatch[1])];
        return [];
      }),
    ]),
  ).sort((a, b) => a - b);

  const shards = await Promise.all(shardIds.map(shard => collectLegacyShard(runId, runDir, shard, targetMetadata)));
  const passedShards = shards.filter(shard => shard.status === 'passed').length;
  const failedShards = shards.filter(shard => shard.status === 'failed').length;
  const totalMs = null;
  const browserHealth = summarizeQaRunBrowserHealth({ shards });
  const failureClasses = summarizeQaFailureClasses(shards);

  return applyQaRunSeverity({
    manifestVersion: 1,
    runId,
    createdAt: parseRunIdTimestamp(runId) ?? runStat.mtimeMs,
    completedAt: runStat.mtimeMs,
    status: failedShards > 0 ? 'failed' : passedShards === shards.length && shards.length > 0 ? 'passed' : 'unknown',
    totalMs,
    totalShards: shards.length,
    passedShards,
    failedShards,
    failureClasses,
    args: null,
    browserHealth,
    shards,
  } as QaRunManifest);
};

const listQaRunIds = async (limit: number): Promise<string[]> => {
  if (!existsSync(QA_LOGS_ROOT)) return [];
  const entries = await readdir(QA_LOGS_ROOT, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && /^\d{8}-\d{6}-\d{3}$/.test(entry.name))
    .map(entry => entry.name)
    .sort(compareQaRunIdsForOperator)
    .slice(0, limit);
};

export const listQaRuns = async (limit = 20): Promise<QaRunManifest[]> => {
  const runIds = await listQaRunIds(limit);
  return await Promise.all(runIds.map(runId => readQaRun(runId)));
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
    const targetMetadata = await readTargetsMetadata(runDir);
    const shards = await Promise.all(
      parsed.shards.map(async shard => {
        const metadata = targetMetadata.get(shard.shard) ?? null;
        const target = shard.target ?? metadata?.target ?? null;
        const title = shard.title ?? metadata?.title ?? readShardTitleFromResults(runDir, shard.shard);
        const hasStoredTimelineSteps = Array.isArray((shard as { timelineSteps?: unknown }).timelineSteps);
        const hasStoredLogTail = Object.prototype.hasOwnProperty.call(shard, 'logTail');
        const logText =
          shard.logRelativePath && (!hasStoredTimelineSteps || !hasStoredLogTail) && existsSync(join(runDir, shard.logRelativePath))
            ? await readFile(join(runDir, shard.logRelativePath), 'utf8')
            : '';
        const timelineSteps = hasStoredTimelineSteps
          ? shard.timelineSteps
          : logText
            ? parseQaTimelineSteps(logText).slice(0, 80)
            : [];
        const browserIssues = normalizeQaBrowserIssues(shard.browserIssues);
        const logTail = shard.logTail ? redactQaSecretText(shard.logTail) : logText ? redactQaSecretText(shortTail(logText)) : null;
        const error = shard.error ? redactQaSecretText(shard.error) : null;
        const browserHealth = summarizeQaBrowserIssues(browserIssues, parsed.createdAt);
        return normalizeQaShardSeverity({
          ...shard,
          target,
          title,
          handle: shard.handle ?? metadata?.handle ?? deriveQaTestHandle(target, title),
          description: metadata?.description ?? deriveQaTestDescription(target, title) ?? shard.description,
          artifacts: sortArtifacts([...(shard.artifacts ?? [])]).map(artifact => ({
            ...artifact,
            sensitivity: artifact.sensitivity ?? classifyQaArtifactSensitivity(artifact),
          })),
          browserIssues,
          browserHealth,
          error,
          failureClass: shard.failureClass ?? classifyQaShardFailure({
            status: shard.status,
            error,
            logTail,
            browserIssues,
          }),
          timelineSteps,
          slowSteps: Array.isArray(shard.slowSteps) && shard.slowSteps.length > 0
            ? shard.slowSteps
            : timelineSteps.slice().sort((a, b) => b.ms - a.ms).slice(0, 12),
          logTail,
        } as QaShardManifest, parsed.createdAt);
      }),
    );
    return applyQaRunSeverity({
      ...parsed,
      browserHealth: parsed.browserHealth ?? summarizeQaRunBrowserHealth({ shards }),
      failureClasses: parsed.failureClasses ?? summarizeQaFailureClasses(shards),
      shards,
    } as QaRunManifest);
  }
  return await buildLegacyManifest(runId, runDir);
};

const readShardTitleFromResults = (runDir: string, shard: number): string | null => {
  const resultsDir = join(runDir, `test-results-shard-${shard}`);
  if (!existsSync(resultsDir)) return null;
  try {
    const entry = readdirSync(resultsDir, { withFileTypes: true }).find(
      item => item.isDirectory() && !item.name.startsWith('.'),
    );
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
  const realRunDir = await realpath(runDir).catch(() => null);
  const realArtifactPath = await realpath(absolutePath).catch(() => null);
  if (!realRunDir || !realArtifactPath) {
    throw new Error('QA_ARTIFACT_NOT_FOUND');
  }
  if (!realArtifactPath.startsWith(`${realRunDir}/`) && realArtifactPath !== realRunDir) {
    throw new Error('INVALID_QA_ARTIFACT_PATH');
  }
  return realArtifactPath;
};

export const makeQaArtifactUrl = (runId: string, relativePath: string): string =>
  `/api/qa/artifact?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(relativePath)}`;

export const enrichQaRunUrls = (run: QaRunManifest): QaRunManifest => ({
  ...run,
  shards: run.shards.map(shard => ({
    ...shard,
    artifacts: sortArtifacts([...(shard.artifacts ?? [])]).map(artifact => {
      const sensitivity = artifact.sensitivity ?? classifyQaArtifactSensitivity(artifact);
      return {
        ...artifact,
        sensitivity,
        url: makeQaArtifactUrl(run.runId, artifact.relativePath),
      };
    }),
  })),
});

export const summarizeQaPerf = (perf: QaPerfSummary): QaPerfSummaryView => ({
  sampleCount: perf.sampleCount,
  avgLoad1: perf.avgLoad1,
  peakLoad1: perf.peakLoad1,
  minFreeMemBytes: perf.minFreeMemBytes,
  maxRunnerRssBytes: perf.maxRunnerRssBytes,
  maxChildCpuPct: perf.maxChildCpuPct,
  maxChildRssKb: perf.maxChildRssKb,
});

export const stripQaRunPerfSamples = (run: QaRunManifest): QaRunView => ({
  ...run,
  ...(run.perf ? { perf: summarizeQaPerf(run.perf) } : {}),
  shards: run.shards.map(shard => ({
    ...shard,
    ...(shard.perf ? { perf: summarizeQaPerf(shard.perf) } : {}),
  })),
});

const listQaRunStoryScreenshots = async (runLimit: number): Promise<QaStoryScreenshot[]> => {
  const runs = await listQaRuns(runLimit);
  const stories: QaStoryScreenshot[] = [];
  for (const run of runs) {
    for (const shard of run.shards) {
      const imageArtifacts = (shard.artifacts ?? []).filter(artifact => artifact.kind === 'image');
      for (const artifact of imageArtifacts) {
        const absoluteImagePath = join(QA_LOGS_ROOT, run.runId, artifact.relativePath);
        const metadata = await readUxScreenshotMetadata(absoluteImagePath);
        stories.push({
          id: `qa-run:${run.runId}:${artifact.relativePath}`,
          source: 'qa-run',
          title: metadata?.title ?? storyTitle(artifact.name),
          group: metadata?.group ?? shard.handle ?? shard.title ?? `shard-${shard.shard}`,
          description: metadata?.description ?? shard.description ?? null,
          platform: metadata?.platform ?? null,
          tags: metadata?.tags ?? [],
          curated: Boolean(metadata),
          name: artifact.name,
          relativePath: artifact.relativePath,
          sizeBytes: artifact.sizeBytes,
          updatedAt: run.completedAt ?? run.createdAt,
          url: makeQaArtifactUrl(run.runId, artifact.relativePath),
          runId: run.runId,
          shard: shard.shard,
          status: shard.status,
        });
      }
    }
  }
  return stories.sort((a, b) => b.updatedAt - a.updatedAt || compareStableText(a.id, b.id));
};

export const listQaStoryScreenshots = async (limit = 200): Promise<QaStoryScreenshot[]> => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 200;
  const [repoStories, runStories] = await Promise.all([
    listRepositoryStoryScreenshots(),
    listQaRunStoryScreenshots(5),
  ]);
  return [...repoStories, ...runStories].slice(0, safeLimit);
};

export const resolveQaStoryScreenshotPath = async (
  source: QaStorySource,
  relativePath: string,
): Promise<string> => {
  if (source !== 'e2e-screenshots') {
    throw new Error('INVALID_QA_STORY_SOURCE');
  }
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\0')) {
    throw new Error('INVALID_QA_STORY_IMAGE_PATH');
  }
  const root = QA_STORY_SCREENSHOTS_ROOT;
  const absolutePath = resolve(root, relativePath);
  if (!absolutePath.startsWith(`${root}/`) && absolutePath !== root) {
    throw new Error('INVALID_QA_STORY_IMAGE_PATH');
  }
  const fileStat = await stat(absolutePath).catch(() => null);
  if (!fileStat?.isFile() || !STORY_IMAGE_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
    throw new Error('QA_STORY_IMAGE_NOT_FOUND');
  }
  const realRoot = await realpath(root).catch(() => null);
  const realImagePath = await realpath(absolutePath).catch(() => null);
  if (!realRoot || !realImagePath) {
    throw new Error('QA_STORY_IMAGE_NOT_FOUND');
  }
  if (!realImagePath.startsWith(`${realRoot}/`) && realImagePath !== realRoot) {
    throw new Error('INVALID_QA_STORY_IMAGE_PATH');
  }
  return realImagePath;
};

export const summarizeQaRun = (run: QaRunManifest): Omit<QaRunManifest, 'perf' | 'shards'> & {
  perf?: QaPerfSummaryView;
  timing: QaRunTimingSummary;
  failingTargets: string[];
} => ({
  manifestVersion: run.manifestVersion,
  severity: run.severity,
  reason: run.reason,
  since: run.since,
  owner: run.owner,
  evidence: run.evidence,
  runId: run.runId,
  createdAt: run.createdAt,
  completedAt: run.completedAt,
  status: run.status,
  totalMs: run.totalMs,
  timing: summarizeQaRunTiming(run),
  ...(run.code ? { code: run.code } : {}),
  ...(run.perf ? { perf: summarizeQaPerf(run.perf) } : {}),
  browserHealth: run.browserHealth ?? summarizeQaRunBrowserHealth(run),
  ...(run.benchmark ? { benchmark: run.benchmark } : {}),
  totalShards: run.totalShards,
  passedShards: run.passedShards,
  failedShards: run.failedShards,
  failureClasses: run.failureClasses ?? summarizeQaFailureClasses(run.shards),
  args: run.args ?? null,
  failingTargets: run.shards
    .filter(shard => shard.status === 'failed')
    .map(shard => shard.handle || shard.target || shard.title || `shard-${shard.shard}`)
    .slice(0, 5),
});

export const qaArtifactContentType = (filePath: string): string => detectContentType(basename(filePath));
