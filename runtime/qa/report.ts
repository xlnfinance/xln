import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { compareStableText } from '../protocol/serialization';
import { DISPLAY, QA } from '../constants';
import {
  assertQaSeveritySignal,
  makeQaSeveritySignal,
  normalizeQaSeveritySignal,
  type QaSeveritySignal,
} from './severity';
import {
  qaRunTestCategory as categoryFromTests,
  qaTestCategoryFromTags,
} from './test-categories';

export type { QaSeverity, QaSeverityEvidence, QaSeveritySignal } from './severity';

export type QaSlowStep = {
  label: string;
  ms: number;
  startMs?: number;
  endMs?: number;
};

export type QaAuthoredScenarioStep = {
  title: string;
  text: string;
  ms?: number;
  startMs?: number;
  endMs?: number;
};

export type QaScenarioMetadata = {
  summary10w: string | null;
  steps: QaAuthoredScenarioStep[];
  owner: string | null;
  severityPolicy: string | null;
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

export type QaPhaseKey = keyof QaPhaseTimings;

export type QaPhaseWaterfallSegment = {
  key: QaPhaseKey;
  label: string;
  ms: number;
  pct: number;
  limitMs: number;
  limitKind: 'budget' | 'historical-p95';
  overLimit: boolean;
};

export type QaPhaseWaterfall = {
  totalMs: number;
  overLimitCount: number;
  segments: QaPhaseWaterfallSegment[];
};

export const QA_PHASE_WATERFALL_ORDER = [
  'preflight',
  'anvilBoot',
  'apiBoot',
  'apiHealthy',
  'viteBoot',
  'playwright',
] as const satisfies readonly QaPhaseKey[];

export const QA_PHASE_WATERFALL_LABELS: Record<QaPhaseKey, string> = {
  preflight: 'preflight',
  anvilBoot: 'anvil',
  apiBoot: 'api boot',
  apiHealthy: 'health',
  viteBoot: 'vite',
  playwright: 'playwright',
};

export const QA_PHASE_WATERFALL_BUDGET_MS: Record<QaPhaseKey, number> = {
  preflight: 1_000,
  anvilBoot: 5_000,
  apiBoot: 5_000,
  apiHealthy: 5_000,
  viteBoot: 5_000,
  playwright: 5_000,
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

export type QaRegressionStatus = QaBenchmarkStatus | 'failed';

export type QaRegressionBaselineKind = 'previous' | 'same-code-hash' | 'same-git-head' | 'last-green-main';

export type QaRegressionMetricDelta = {
  metric: string;
  label: string;
  unit: QaBenchmarkMetricDelta['unit'] | 'count';
  current: number;
  baseline: number;
  delta: number;
  deltaPct: number;
  thresholdPct: number;
  verdict: 'ok' | 'faster' | 'slower';
};

export type QaRegressionBaselineComparison = {
  kind: QaRegressionBaselineKind;
  label: string;
  status: QaRegressionStatus;
  comparedRunId: string | null;
  comparedGitHead: string | null;
  comparedCodeHash: string | null;
  reason: string;
  metrics: QaRegressionMetricDelta[];
  newFailingTargets: string[];
  likelyCauses: string[];
};

export type QaRegressionReport = QaSeveritySignal & {
  status: QaRegressionStatus;
  latestRunId: string | null;
  suiteKey: string | null;
  suiteLabel: string | null;
  comparisons: QaRegressionBaselineComparison[];
};

export type QaRunTimingSummary = {
  avgShardMs: number | null;
  maxShardMs: number | null;
  bootstrapMs: number | null;
  apiHealthyMs: number | null;
  playwrightMs: number | null;
  phaseP95: QaPhaseTimings | null;
};

export type QaFatalMarker = {
  shard: number;
  handle: string | null;
  title: string | null;
  target: string | null;
  failureClass: QaFailureClass;
  source: 'error' | 'logTail';
  line: string;
};

export type QaRunCategory = 'unit' | 'contract' | 'e2e' | 'scenario' | 'benchmark' | 'release' | 'unknown';
export type QaTestCategory = 'functional' | 'resilience';
export type QaRunTestCategory = QaTestCategory | 'mixed' | 'unknown';

export type QaFailureCapsule = {
  version: 1;
  reportPath: string;
  file: string;
  title: string;
  line: number;
  column: number;
  project: string;
  error: string;
  stack: string | null;
  attachments: Array<{
    name: string;
    contentType: string;
    path: string | null;
  }>;
  rerunCommand: string;
};

export type QaShardManifest = {
  shard: number;
  status: 'passed' | 'failed' | 'cancelled' | 'unknown';
  resultClass?: 'passed' | 'playwright' | 'runtime-fatal' | 'startup' | 'runner' | 'cancelled';
  durationMs: number | null;
  handle: string | null;
  description: string | null;
  scenario: QaScenarioMetadata | null;
  target: string | null;
  title: string | null;
  tags?: string[];
  testCategory?: QaTestCategory;
  requireMarketMaker: boolean | null;
  logRelativePath: string | null;
  logTail: string | null;
  error: string | null;
  diagnostics?: string[];
  failureCapsule?: QaFailureCapsule | null;
  failureCapsuleRelativePath?: string | null;
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
  testCategory?: QaRunTestCategory;
  totalMs: number | null;
  code?: QaCodeFingerprint;
  perf?: QaPerfSummary;
  browserHealth?: QaBrowserHealthSummary;
  benchmark?: QaBenchmarkComparison;
  totalShards: number;
  passedShards: number;
  failedShards: number;
  cancelledShards?: number;
  primaryFailureShard?: number | null;
  primaryFailureCapsule?: QaFailureCapsule | null;
  failureClasses?: QaFailureClass[];
  args?: Record<string, unknown> | null;
  shards: QaShardManifest[];
} & QaSeveritySignal;

type QaShardManifestDraft = Omit<QaShardManifest, keyof QaSeveritySignal> &
  Partial<QaSeveritySignal>;

type QaRunManifestDraft = Omit<QaRunManifest, keyof QaSeveritySignal | 'shards'> &
  Partial<QaSeveritySignal> & {
    shards: QaShardManifestDraft[];
  };

export type QaShardView = Omit<QaShardManifest, 'perf'> & {
  perf?: QaPerfSummaryView;
  phaseWaterfall?: QaPhaseWaterfall | null;
};

export type QaRunView = Omit<QaRunManifest, 'perf' | 'shards'> & {
  perf?: QaPerfSummaryView;
  shards: QaShardView[];
};

export type QaRunSummary = Omit<QaRunManifest, 'perf' | 'shards'> & {
  perf?: QaPerfSummaryView;
  timing: QaRunTimingSummary;
  suiteKey: string;
  suiteLabel: string;
  category: QaRunCategory;
  testCategory: QaRunTestCategory;
  failingTargets: string[];
  fatalMarkers: QaFatalMarker[];
  artifactBytes: number;
  childCpuP95Pct: number | null;
};

export type QaSystemVerdictStatus = 'PASS' | 'DEGRADED' | 'FAIL' | 'UNKNOWN';

export type QaSystemVerdict = QaSeveritySignal & {
  schemaVersion: 1;
  status: QaSystemVerdictStatus;
  activeCount: number;
  failingSurfaceCount: number;
  latestRunId: string | null;
  latestAt: number | null;
  gitHead: string | null;
  codeHash: string | null;
  dirty: boolean;
  regressionStatus: QaBenchmarkStatus | null;
  browserErrorCount: number;
  browserWarningCount: number;
};

export type QaRunLedgerEntry = QaSeveritySignal & {
  runId: string;
  createdAt: number;
  completedAt: number | null;
  status: QaRunManifest['status'];
  category: QaRunCategory;
  testCategory: QaRunTestCategory;
  suiteKey: string;
  suiteLabel: string;
  gitHead: string | null;
  gitBranch: string | null;
  codeHash: string | null;
  dirty: boolean;
  startedBy: string;
  durationMs: number | null;
  timing: QaRunTimingSummary;
  failedShard: string | null;
  failedTargets: string[];
  artifactBytes: number;
  cpuP95Pct: number | null;
  cpuPeakPct: number | null;
  ramPeakKb: number | null;
  browserErrors: number;
  browserWarnings: number;
  networkFailures: number;
  benchmarkStatus: QaBenchmarkStatus | null;
  benchmarkDeltaPct: number | null;
  benchmarkComparedRunId: string | null;
  auditAction: string | null;
};

export type QaTestLedgerEntry = {
  testId: string;
  category: QaTestCategory | 'unknown';
  target: string;
  title: string;
  description: string;
  status: QaShardManifest['status'];
  durationMs: number | null;
  lastRunId: string;
  lastRunAt: number;
};

type QaShardFailureInput = Pick<QaShardManifest, 'status' | 'error' | 'logTail'> & {
  browserIssues?: QaBrowserIssue[];
};

// QA run evidence (per-run artifacts + the history DB) lives under QA_EVIDENCE_ROOT so
// it can be pinned to a persistent location on prod — outside the git checkout that
// deploy.sh hard-resets/cleans — while defaulting to the local .logs dir for dev.
// Curated story screenshots stay tracked in-repo and ship with the code deploy, so
// their root is intentionally left relative to the checkout.
export const QA_EVIDENCE_ROOT = process.env['QA_EVIDENCE_ROOT']
  ? resolve(process.env['QA_EVIDENCE_ROOT'])
  : resolve(process.cwd(), '.logs');
export const QA_LOGS_ROOT = resolve(QA_EVIDENCE_ROOT, 'e2e-parallel');
export const QA_STORY_SCREENSHOTS_ROOT = resolve(process.cwd(), 'tests', 'e2e', 'screenshots');
export const QA_HISTORY_DB_PATH = resolve(QA_EVIDENCE_ROOT, 'qa-history.sqlite');

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
  childCpuP95Pct: number | null;
  avgShardMs: number | null;
  maxShardMs: number | null;
  bootstrapMs: number | null;
  apiHealthyMs: number | null;
  playwrightMs: number | null;
  phaseP95: QaPhaseTimings | null;
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

const normalizeQaAuthoredScenarioStep = (value: unknown): QaAuthoredScenarioStep | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const title = asNullableString(record['title']);
  const text = asNullableString(record['text']);
  if (!title || !text) return null;
  const ms = asFiniteNumber(record['ms']);
  const startMs = asFiniteNumber(record['startMs']);
  const endMs = asFiniteNumber(record['endMs']);
  return {
    title,
    text,
    ...(ms !== null ? { ms } : {}),
    ...(startMs !== null ? { startMs } : {}),
    ...(endMs !== null ? { endMs } : {}),
  };
};

const normalizeQaScenarioMetadata = (value: unknown): QaScenarioMetadata | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const steps = Array.isArray(record['steps'])
    ? record['steps'].map(normalizeQaAuthoredScenarioStep).filter((step): step is QaAuthoredScenarioStep => Boolean(step))
    : [];
  const scenario = {
    summary10w: asNullableString(record['summary10w']),
    steps,
    owner: asNullableString(record['owner']),
    severityPolicy: asNullableString(record['severityPolicy']),
  };
  return scenario.summary10w || scenario.steps.length > 0 || scenario.owner || scenario.severityPolicy
    ? scenario
    : null;
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
  // Expected negative-path evidence stays in the run manifest for audit/debug,
  // but a test-scoped allowBrowserIssue rule must not poison the strict release
  // gate. The global Playwright fixture adds this tag only after matching the
  // issue type, severity, message, and current test id.
  const unexpectedIssues = issues.filter(issue => !issue.message.startsWith('[expected] '));
  const summary = {
    issueCount: unexpectedIssues.length,
    errorCount: unexpectedIssues.filter(issue => issue.severity === 'error').length,
    warningCount: unexpectedIssues.filter(issue => issue.severity === 'warning').length,
    networkFailureCount: unexpectedIssues.filter(issue => issue.type === 'requestfailed').length,
    httpErrorCount: unexpectedIssues.filter(issue => issue.type === 'http').length,
  };
  return {
    ...summary,
    ...qaBrowserHealthSeverity(summary, qaSeveritySince(since, issues.map(issue => issue.timestamp))),
  };
};

export const summarizeQaRunBrowserHealth = (
  run: { shards: readonly Pick<QaShardManifest, 'browserIssues'>[] },
): QaBrowserHealthSummary =>
  summarizeQaBrowserIssues(run.shards.flatMap(shard => normalizeQaBrowserIssues(shard.browserIssues)));

const classifyQaFailureText = (value: string): QaFailureClass | null => {
  const lower = value.toLowerCase();
  if (!lower.trim()) return null;
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('timeoutexceeded')) return 'timeout';
  if (
    lower.includes('e2e_fatal_runtime_log') ||
    lower.includes('fatal runtime') ||
    lower.includes('segmentation fault') ||
    lower.includes('page crashed') ||
    lower.includes('sigsegv')
  ) return 'crash';
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

const fatalMarkerLine = (value: string): string | null => {
  for (const line of value.split('\n')) {
    const normalized = line.trim();
    const lower = normalized.toLowerCase();
    if (!normalized) continue;
    if (
      lower.includes('e2e_fatal_runtime_log') ||
      lower.includes('fatal runtime') ||
      lower.includes('segmentation fault') ||
      lower.includes('sigsegv')
    ) return redactQaSecretText(normalized).slice(0, 500);
  }
  return null;
};

export const summarizeQaFatalMarkers = (run: Pick<QaRunManifest, 'shards'>): QaFatalMarker[] => {
  const markers: QaFatalMarker[] = [];
  for (const shard of run.shards) {
    const sources = [
      ['error', shard.error ?? ''],
      ['logTail', shard.logTail ?? ''],
    ] as const;
    for (const [source, text] of sources) {
      const line = fatalMarkerLine(text);
      if (!line) continue;
      markers.push({
        shard: shard.shard,
        handle: shard.handle ?? null,
        title: shard.title ?? null,
        target: shard.target ?? null,
        failureClass: classifyQaFailureText(line) ?? 'crash',
        source,
        line,
      });
      break;
    }
  }
  return markers.slice(0, 10);
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
  if (shard.status === 'cancelled') {
    return makeQaSeveritySignal({
      severity: 'UNKNOWN',
      reason: `${label} was cancelled after another shard failed`,
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
    ...(run.code?.gitHead ? [{ label: 'git head', value: run.code.gitHead.slice(0, DISPLAY.SHORT_HASH_HEX_CHARS) }] : []),
    ...(run.code?.codeHash ? [{ label: 'code hash', value: run.code.codeHash.slice(0, DISPLAY.SHORT_HASH_HEX_CHARS) }] : []),
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

const qaSystemVerdictStatusFromSeverity = (severity: QaSeveritySignal['severity']): QaSystemVerdictStatus => {
  if (severity === 'OK') return 'PASS';
  if (severity === 'WARN' || severity === 'DEGRADED') return 'DEGRADED';
  if (severity === 'FAIL' || severity === 'BLOCKED') return 'FAIL';
  return 'UNKNOWN';
};

const qaSystemVerdictReason = (run: QaRunSummary): string => {
  if (run.failedShards > 0 || run.status === 'failed') {
    return run.failingTargets.length > 0 ? run.failingTargets.join(' · ') : run.reason;
  }
  if (run.browserHealth?.severity === 'FAIL' || run.browserHealth?.severity === 'WARN') return run.browserHealth.reason;
  if (run.benchmark?.status === 'slower' || run.benchmark?.status === 'mixed') return run.benchmark.reason;
  if (run.code?.dirty) return 'Worktree was dirty during QA run';
  return run.reason;
};

export const buildQaSystemVerdict = (runs: readonly QaRunSummary[]): QaSystemVerdict => {
  const latest = runs[0] ?? null;
  if (!latest) {
    return {
      ...makeQaSeveritySignal({
        severity: 'UNKNOWN',
        reason: 'No QA runs yet',
        since: 0,
        owner: 'qa-system',
        evidence: [{ label: 'runs', value: 0 }],
      }),
      schemaVersion: 1,
      status: 'UNKNOWN',
      activeCount: 0,
      failingSurfaceCount: 0,
      latestRunId: null,
      latestAt: null,
      gitHead: null,
      codeHash: null,
      dirty: false,
      regressionStatus: null,
      browserErrorCount: 0,
      browserWarningCount: 0,
    };
  }

  const browser = latest.browserHealth;
  const regressionStatus = latest.benchmark?.status ?? null;
  const regressionActive = regressionStatus === 'slower' || regressionStatus === 'mixed';
  const failedShardSurface = latest.failedShards > 0 || latest.status === 'failed';
  const browserSurface = Boolean(browser && browser.issueCount > 0);
  const browserBlocking = browser?.severity === 'FAIL' || (browser?.errorCount ?? 0) > 0;
  const browserWarning = browser?.severity === 'WARN' || (browser?.warningCount ?? 0) > 0;
  const dirtySurface = latest.code?.dirty === true;
  const unknownSurface = latest.status === 'unknown' || latest.severity === 'UNKNOWN';
  const effectiveSeverity: QaSeveritySignal['severity'] =
    failedShardSurface || browserBlocking
      ? 'FAIL'
      : unknownSurface
        ? 'UNKNOWN'
        : regressionActive || dirtySurface
          ? 'DEGRADED'
          : browserWarning
            ? 'WARN'
            : latest.severity;
  const surfaceCount = [
    failedShardSurface,
    browserSurface,
    regressionActive,
    dirtySurface,
    unknownSurface,
  ].filter(Boolean).length;
  const activeCount = surfaceCount > 0 ? surfaceCount : latest.severity === 'OK' ? 0 : 1;
  const reason = qaSystemVerdictReason(latest);
  const evidence = [
    { label: 'run', value: latest.runId },
    { label: 'status', value: latest.status },
    { label: 'failed shards', value: latest.failedShards },
    { label: 'total shards', value: latest.totalShards },
    ...(browser ? [
      { label: 'browser errors', value: browser.errorCount },
      { label: 'browser warnings', value: browser.warningCount },
    ] : []),
    ...(regressionStatus ? [{ label: 'benchmark', value: regressionStatus }] : []),
    ...(latest.code?.gitHead ? [{ label: 'git head', value: latest.code.gitHead.slice(0, DISPLAY.SHORT_HASH_HEX_CHARS) }] : []),
    ...(latest.code?.codeHash ? [{ label: 'code hash', value: latest.code.codeHash.slice(0, DISPLAY.SHORT_HASH_HEX_CHARS) }] : []),
    ...(dirtySurface ? [{ label: 'dirty', value: true }] : []),
  ];

  return {
    ...makeQaSeveritySignal({
      severity: effectiveSeverity,
      reason,
      since: latest.since || latest.createdAt,
      owner: 'qa-system',
      evidence,
    }),
    schemaVersion: 1,
    status: qaSystemVerdictStatusFromSeverity(effectiveSeverity),
    activeCount,
    failingSurfaceCount: activeCount,
    latestRunId: latest.runId,
    latestAt: latest.createdAt,
    gitHead: latest.code?.gitHead ?? null,
    codeHash: latest.code?.codeHash ?? null,
    dirty: dirtySurface,
    regressionStatus,
    browserErrorCount: browser?.errorCount ?? 0,
    browserWarningCount: browser?.warningCount ?? 0,
  };
};

export const buildQaRunLedger = (runs: readonly QaRunSummary[]): QaRunLedgerEntry[] =>
  runs.map((run): QaRunLedgerEntry => {
    const browserHealth = run.browserHealth;
    const benchmarkDeltaPct = run.benchmark?.metrics.find(metric => metric.metric === 'totalMs')?.deltaPct ?? null;
    return {
      severity: run.severity,
      reason: run.reason,
      since: run.since,
      owner: run.owner,
      evidence: run.evidence,
      runId: run.runId,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      status: run.status,
      category: run.category,
      testCategory: run.testCategory,
      suiteKey: run.suiteKey,
      suiteLabel: run.suiteLabel,
      gitHead: run.code?.gitHead ?? null,
      gitBranch: run.code?.gitBranch ?? null,
      codeHash: run.code?.codeHash ?? null,
      dirty: run.code?.dirty === true,
      startedBy: qaRunStartedBy(run),
      durationMs: run.totalMs,
      timing: run.timing,
      failedShard: run.failingTargets[0] ?? null,
      failedTargets: run.failingTargets,
      artifactBytes: run.artifactBytes,
      cpuP95Pct: run.childCpuP95Pct,
      cpuPeakPct: run.perf?.maxChildCpuPct ?? null,
      ramPeakKb: run.perf?.maxChildRssKb ?? null,
      browserErrors: browserHealth?.errorCount ?? 0,
      browserWarnings: browserHealth?.warningCount ?? 0,
      networkFailures: (browserHealth?.networkFailureCount ?? 0) + (browserHealth?.httpErrorCount ?? 0),
      benchmarkStatus: run.benchmark?.status ?? null,
      benchmarkDeltaPct,
      benchmarkComparedRunId: run.benchmark?.comparedRunId ?? null,
      auditAction: qaRunAuditAction(run),
    };
  });

const regressionMetric = (
  metric: string,
  label: string,
  unit: QaRegressionMetricDelta['unit'],
  current: number | null | undefined,
  baseline: number | null | undefined,
  thresholdPct: number,
): QaRegressionMetricDelta | null => {
  if (
    typeof current !== 'number' ||
    typeof baseline !== 'number' ||
    !Number.isFinite(current) ||
    !Number.isFinite(baseline) ||
    baseline <= 0
  ) return null;
  const delta = current - baseline;
  const deltaPct = (delta / baseline) * 100;
  const verdict: QaRegressionMetricDelta['verdict'] =
    deltaPct >= thresholdPct ? 'slower' : deltaPct <= -thresholdPct ? 'faster' : 'ok';
  return {
    metric,
    label,
    unit,
    current: Math.round(current * 100) / 100,
    baseline: Math.round(baseline * 100) / 100,
    delta: Math.round(delta * 100) / 100,
    deltaPct: Math.round(deltaPct * 100) / 100,
    thresholdPct,
    verdict,
  };
};

const regressionMetrics = (current: QaRunSummary, baseline: QaRunSummary): QaRegressionMetricDelta[] =>
  [
    regressionMetric('totalMs', 'wall time', 'ms', current.totalMs, baseline.totalMs, 20),
    regressionMetric('avgShardMs', 'avg shard', 'ms', current.timing.avgShardMs, baseline.timing.avgShardMs, 20),
    regressionMetric('maxShardMs', 'max shard', 'ms', current.timing.maxShardMs, baseline.timing.maxShardMs, 25),
    regressionMetric('bootstrapMs', 'bootstrap', 'ms', current.timing.bootstrapMs, baseline.timing.bootstrapMs, 25),
    regressionMetric('apiHealthyMs', 'health wait', 'ms', current.timing.apiHealthyMs, baseline.timing.apiHealthyMs, 25),
    regressionMetric('playwrightMs', 'browser test', 'ms', current.timing.playwrightMs, baseline.timing.playwrightMs, 25),
    regressionMetric('peakLoad1', 'peak load1', 'load', current.perf?.peakLoad1, baseline.perf?.peakLoad1, 50),
    regressionMetric('maxChildCpuPct', 'peak child CPU', 'percent', current.perf?.maxChildCpuPct, baseline.perf?.maxChildCpuPct, 40),
    regressionMetric('childCpuP95Pct', 'p95 child CPU', 'percent', current.childCpuP95Pct, baseline.childCpuP95Pct, 40),
    regressionMetric('maxRunnerRssBytes', 'runner RSS', 'bytes', current.perf?.maxRunnerRssBytes, baseline.perf?.maxRunnerRssBytes, 30),
    regressionMetric('maxChildRssKb', 'child RSS', 'kb', current.perf?.maxChildRssKb, baseline.perf?.maxChildRssKb, 30),
    regressionMetric('artifactBytes', 'artifact bytes', 'bytes', current.artifactBytes, baseline.artifactBytes, 50),
  ].filter((metric): metric is QaRegressionMetricDelta => metric !== null);

const compareQaRegressionBaseline = (
  current: QaRunSummary,
  baseline: QaRunSummary | null,
  kind: QaRegressionBaselineKind,
  label: string,
): QaRegressionBaselineComparison => {
  if (!baseline) {
    return {
      kind,
      label,
      status: 'insufficient',
      comparedRunId: null,
      comparedGitHead: null,
      comparedCodeHash: null,
      reason: `No ${label} baseline found`,
      metrics: [],
      newFailingTargets: [],
      likelyCauses: [],
    };
  }
  const metrics = regressionMetrics(current, baseline);
  const slower = metrics.filter(metric => metric.verdict === 'slower').sort((a, b) => b.deltaPct - a.deltaPct);
  const blockingSlower = slower.filter(metric => metric.metric !== 'peakLoad1');
  const fasterTiming = metrics.filter(metric => metric.verdict === 'faster' && metric.unit === 'ms').sort((a, b) => a.deltaPct - b.deltaPct);
  const baselineFailures = new Set(baseline.failingTargets);
  const newFailingTargets = current.failingTargets.filter(target => !baselineFailures.has(target));
  const status: QaRegressionStatus =
    newFailingTargets.length > 0 || (current.status === 'failed' && baseline.status !== 'failed')
      ? 'failed'
      : blockingSlower.length > 0 && fasterTiming.length > 0
        ? 'mixed'
        : blockingSlower.length > 0
          ? 'slower'
          : fasterTiming.length > 0
            ? 'faster'
            : 'ok';
  const top = blockingSlower[0] ?? fasterTiming[0] ?? null;
  const hostLoadOnly = slower.length > 0 && blockingSlower.length === 0;
  const reason =
    status === 'failed'
      ? `New failing target${newFailingTargets.length === 1 ? '' : 's'} vs ${baseline.runId}: ${newFailingTargets.join(', ') || current.failingTargets.join(', ') || current.status}`
      : top
        ? `${top.label} ${top.deltaPct > 0 ? '+' : ''}${top.deltaPct}% vs ${baseline.runId}`
        : hostLoadOnly
          ? `Timing within thresholds; host load changed vs ${baseline.runId}`
          : fasterTiming.length > 0
            ? `Timing improved vs ${baseline.runId}`
            : `Within thresholds vs ${baseline.runId}`;
  const likelyCauses = [
    ...(current.code?.codeHash && baseline.code?.codeHash && current.code.codeHash !== baseline.code.codeHash ? ['code hash changed'] : []),
    ...(current.code?.gitHead && baseline.code?.gitHead && current.code.gitHead !== baseline.code.gitHead ? ['git HEAD changed'] : []),
    ...(current.code?.dirty ? ['current worktree is dirty'] : []),
    ...(newFailingTargets.length > 0 ? [`new failing target: ${newFailingTargets.join(', ')}`] : []),
    ...(hostLoadOnly ? ['host load changed without app timing regression'] : []),
    ...(top ? [`largest delta: ${top.label} ${top.deltaPct > 0 ? '+' : ''}${top.deltaPct}%`] : []),
  ];
  return {
    kind,
    label,
    status,
    comparedRunId: baseline.runId,
    comparedGitHead: baseline.code?.gitHead ?? null,
    comparedCodeHash: baseline.code?.codeHash ?? null,
    reason,
    metrics,
    newFailingTargets,
    likelyCauses,
  };
};

const regressionStatusRank: Record<QaRegressionStatus, number> = {
  faster: 0,
  ok: 0,
  insufficient: 1,
  slower: 2,
  mixed: 3,
  failed: 4,
};

export const buildQaRegressionReport = (runs: readonly QaRunSummary[]): QaRegressionReport => {
  const latest = runs[0] ?? null;
  if (!latest) {
    return {
      ...makeQaSeveritySignal({
        severity: 'UNKNOWN',
        reason: 'No QA runs yet',
        since: 0,
        owner: 'qa-regression',
        evidence: [{ label: 'runs', value: 0 }],
      }),
      status: 'insufficient',
      latestRunId: null,
      suiteKey: null,
      suiteLabel: null,
      comparisons: [],
    };
  }
  const candidates = runs
    .slice(1)
    .filter(run => run.suiteKey === latest.suiteKey && run.createdAt < latest.createdAt);
  const previous = candidates[0] ?? null;
  const sameCodeHash = latest.code?.codeHash
    ? candidates.find(run => run.code?.codeHash === latest.code?.codeHash) ?? null
    : null;
  const sameGitHead = latest.code?.gitHead
    ? candidates.find(run => run.code?.gitHead === latest.code?.gitHead) ?? null
    : null;
  const lastGreenMain = candidates.find(run =>
    run.status === 'passed' &&
    run.failedShards === 0 &&
    run.code?.dirty !== true &&
    run.code?.gitBranch === 'main'
  ) ?? null;
  const comparisons = [
    compareQaRegressionBaseline(latest, previous, 'previous', 'previous comparable'),
    compareQaRegressionBaseline(latest, sameCodeHash, 'same-code-hash', 'previous same code hash'),
    compareQaRegressionBaseline(latest, sameGitHead, 'same-git-head', 'previous same HEAD'),
    compareQaRegressionBaseline(latest, lastGreenMain, 'last-green-main', 'last green on main'),
  ];
  const blocking = comparisons
    .filter(comparison => comparison.status !== 'insufficient')
    .sort((a, b) => regressionStatusRank[b.status] - regressionStatusRank[a.status])[0] ?? comparisons[0]!;
  const status = blocking.status;
  const severity = status === 'failed' ? 'FAIL' : status === 'slower' || status === 'mixed' ? 'DEGRADED' : status === 'insufficient' ? 'UNKNOWN' : 'OK';
  return {
    ...makeQaSeveritySignal({
      severity,
      reason: blocking.reason,
      since: latest.createdAt,
      owner: 'qa-regression',
      evidence: [
        { label: 'run', value: latest.runId },
        { label: 'suite', value: latest.suiteLabel },
        { label: 'status', value: status },
        ...comparisons.map(comparison => ({
          label: comparison.kind,
          value: comparison.comparedRunId ?? 'missing',
        })),
      ],
    }),
    status,
    latestRunId: latest.runId,
    suiteKey: latest.suiteKey,
    suiteLabel: latest.suiteLabel,
    comparisons,
  };
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

const explicitRunTestCategory = (value: unknown): QaRunTestCategory | null =>
  value === 'functional' || value === 'resilience' || value === 'mixed' || value === 'unknown'
    ? value
    : null;

export const qaRunTestCategory = (
  run: Pick<QaRunManifest, 'testCategory' | 'args' | 'shards'>,
): QaRunTestCategory => {
  const explicit = explicitRunTestCategory(run.testCategory);
  if (explicit) return explicit;
  const shardCategories = run.shards.map((shard) =>
    shard.testCategory ?? qaTestCategoryFromTags(shard.tags ?? []));
  if (shardCategories.length > 0 && shardCategories.every(Boolean)) {
    return categoryFromTests(shardCategories as QaTestCategory[]);
  }
  const args = run.args ?? {};
  const argCategory = explicitRunTestCategory(args['qaCategory'] ?? args['testCategory']);
  if (argCategory === 'functional' || argCategory === 'resilience') return argCategory;
  const grep = normalizeSuiteText(args['pwGrep']);
  if (grep === '@functional') return 'functional';
  if (grep === '@resilience') return 'resilience';
  return 'unknown';
};

export const qaRunSuiteKey = (run: Pick<QaRunManifest, 'testCategory' | 'args' | 'shards'>): string => {
  const args = run.args ?? {};
  const source = {
    pwProject: normalizeSuiteText(args['pwProject']),
    pwGrep: normalizeSuiteText(args['pwGrep']),
    pwFiles: Array.isArray(args['pwFiles'])
      ? args['pwFiles'].map(normalizeSuiteText).sort(compareStableText)
      : normalizeSuiteText(args['pwFiles']),
    testCategory: qaRunTestCategory(run),
    shards: run.shards.map(runShardIdentity).sort(compareStableText),
  };
  return createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 24);
};

export const qaRunSuiteLabel = (run: Pick<QaRunManifest, 'testCategory' | 'args' | 'shards'>): string => {
  const testCategory = qaRunTestCategory(run);
  const prefix = testCategory === 'unknown' ? '' : `${testCategory} · `;
  if (run.shards.length === 1) {
    const shard = run.shards[0]!;
    const label = normalizeSuiteText(shard.handle) || normalizeSuiteText(shard.title) || normalizeSuiteText(shard.target) || 'single shard';
    return `${prefix}${label}`;
  }
  const args = run.args ?? {};
  const pwGrep = normalizeSuiteText(args['pwGrep']);
  if (pwGrep) return `${prefix}grep:${pwGrep}`;
  const pwFiles = Array.isArray(args['pwFiles']) ? args['pwFiles'].map(normalizeSuiteText).filter(Boolean) : [];
  if (pwFiles.length > 0) return `${prefix}${pwFiles.length === 1 ? pwFiles[0]! : `${pwFiles.length} files`}`;
  return `${prefix}${run.shards.length} shards`;
};

const normalizeArgsArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(normalizeSuiteText).filter(Boolean);
  const normalized = normalizeSuiteText(value);
  return normalized ? [normalized] : [];
};

const qaRunArgText = (run: Pick<QaRunManifest, 'args'>, keys: readonly string[]): string | null => {
  const args = run.args ?? {};
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

const qaRunCategory = (run: Pick<QaRunManifest, 'args' | 'shards' | 'benchmark'>): QaRunCategory => {
  const explicit = qaRunArgText(run, ['category', 'suiteCategory', 'runCategory']);
  if (
    explicit === 'unit' ||
    explicit === 'contract' ||
    explicit === 'e2e' ||
    explicit === 'scenario' ||
    explicit === 'benchmark' ||
    explicit === 'release'
  ) return explicit;
  const args = run.args ?? {};
  const files = normalizeArgsArray(args['pwFiles']);
  const targets = run.shards.map(shard => normalizeSuiteText(shard.target));
  const text = [...files, ...targets, normalizeSuiteText(args['pwGrep'])].join(' ').toLowerCase();
  if (text.includes('benchmark') || text.includes('bench:')) return 'benchmark';
  if (text.includes('runtime/__tests__') || text.includes('bun test')) return 'unit';
  if (text.includes('jurisdictions') || text.includes('contract')) return 'contract';
  if (text.includes('scenario') || text.includes('/scenarios')) return 'scenario';
  if (text.includes('release')) return 'release';
  if (text.includes('tests/e2e') || run.shards.length > 0) return 'e2e';
  return 'unknown';
};

const qaRunArtifactBytes = (run: Pick<QaRunManifest, 'shards'>): number =>
  run.shards
    .flatMap(shard => shard.artifacts ?? [])
    .reduce((sum, artifact) => sum + Math.max(0, Math.floor(artifact.sizeBytes || 0)), 0);

const percentile95 = (values: number[]): number | null => {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return Math.round(sorted[index]! * 100) / 100;
};

const phaseValue = (phaseMs: QaPhaseTimings, key: QaPhaseKey): number =>
  Math.max(0, Math.floor(Number(phaseMs[key]) || 0));

export const buildQaPhaseWaterfall = (
  phaseMs: QaPhaseTimings | null,
  historicalP95: Partial<Record<QaPhaseKey, number | null>> | null = null,
): QaPhaseWaterfall | null => {
  if (!phaseMs) return null;
  const totalMs = QA_PHASE_WATERFALL_ORDER.reduce((sum, key) => sum + phaseValue(phaseMs, key), 0);
  const denominator = totalMs > 0 ? totalMs : 1;
  const segments = QA_PHASE_WATERFALL_ORDER.map((key): QaPhaseWaterfallSegment => {
    const ms = phaseValue(phaseMs, key);
    const p95 = historicalP95?.[key];
    const hasHistoricalP95 = typeof p95 === 'number' && Number.isFinite(p95) && p95 > 0;
    const limitMs = Math.max(0, Math.floor(hasHistoricalP95 ? p95 : QA_PHASE_WATERFALL_BUDGET_MS[key]));
    return {
      key,
      label: QA_PHASE_WATERFALL_LABELS[key],
      ms,
      pct: Math.round((ms / denominator) * 10_000) / 100,
      limitMs,
      limitKind: hasHistoricalP95 ? 'historical-p95' : 'budget',
      overLimit: limitMs > 0 && ms > limitMs,
    };
  });
  return {
    totalMs,
    overLimitCount: segments.filter(segment => segment.overLimit).length,
    segments,
  };
};

const qaRunChildCpuP95 = (run: Pick<QaRunManifest, 'perf'>): number | null =>
  percentile95((run.perf?.samples ?? []).flatMap(sample => sample.children.map(child => child.cpuPct)));

const qaRunStartedBy = (run: Pick<QaRunManifest, 'args'>): string =>
  qaRunArgText(run, ['startedBy', 'operatorId', 'actor', 'user']) ?? 'runner';

const qaRunAuditAction = (run: Pick<QaRunManifest, 'args'>): string | null =>
  qaRunArgText(run, ['auditAction', 'action']);

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

const p95PhaseMs = (run: QaRunManifest, key: QaPhaseKey): number | null =>
  percentile95(run.shards
    .map(shard => shard.phaseMs?.[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));

const summarizeQaRunPhaseP95 = (run: QaRunManifest): QaPhaseTimings | null => {
  const entries = QA_PHASE_WATERFALL_ORDER.map((key): [QaPhaseKey, number | null] => [key, p95PhaseMs(run, key)]);
  if (entries.some(([, value]) => value === null)) return null;
  return Object.fromEntries(entries) as QaPhaseTimings;
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
  phaseP95: summarizeQaRunPhaseP95(run),
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

const normalizeQaShardSeverity = (shard: QaShardManifestDraft, since: number): QaShardManifest => {
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

export const applyQaRunSeverity = (run: QaRunManifestDraft): QaRunManifest => {
  const since = run.createdAt;
  const shards = run.shards.map(shard => normalizeQaShardSeverity(shard, since));
  const browserHealth = normalizeQaBrowserHealthSummary(
    run.browserHealth ?? summarizeQaRunBrowserHealth({ shards }),
    since,
  );
  const benchmark = normalizeQaBenchmarkSeverity(run.benchmark, since);
  const failureClasses = run.failureClasses ?? summarizeQaFailureClasses(shards);
  const normalizedRun = {
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
  if (run.manifestVersion < 4) return;
  const shardCategories = run.shards.map((shard) =>
    shard.testCategory ?? qaTestCategoryFromTags(shard.tags ?? []));
  if (shardCategories.some((category) => category === null)) {
    throw new Error('QA_RUN_TEST_CATEGORY_REQUIRED');
  }
  const derived = categoryFromTests(shardCategories as QaTestCategory[]);
  if (run.testCategory !== derived) throw new Error('QA_RUN_TEST_CATEGORY_MISMATCH');
};

const parseManifestJson = (value: unknown): QaRunManifest | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return applyQaRunSeverity(JSON.parse(value) as QaRunManifest);
  } catch {
    return null;
  }
};

const readQaHistoryManifest = (runId: string): QaRunManifest | null => {
  if (!existsSync(QA_HISTORY_DB_PATH)) return null;
  const db = openQaHistoryDb();
  try {
    const row = db.query(`
      SELECT manifest_json
      FROM qa_runs
      WHERE run_id = $runId
      LIMIT 1
    `).get({ $runId: runId }) as Record<string, unknown> | null;
    if (!row) return null;
    const run = parseManifestJson(row['manifest_json']);
    if (!run || run.runId !== runId || !Array.isArray(run.shards)) {
      throw new Error('QA_RUN_HISTORY_MANIFEST_INVALID');
    }
    assertQaReleaseRunSeverity(run);
    return run;
  } finally {
    db.close();
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
      child_cpu_p95_pct REAL,
      avg_shard_ms REAL,
      max_shard_ms REAL,
      bootstrap_ms REAL,
      api_healthy_ms REAL,
      playwright_ms REAL,
      phase_p95_preflight_ms REAL,
      phase_p95_anvil_boot_ms REAL,
      phase_p95_api_boot_ms REAL,
      phase_p95_api_healthy_ms REAL,
      phase_p95_vite_boot_ms REAL,
      phase_p95_playwright_ms REAL,
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
  addColumn('child_cpu_p95_pct', 'REAL');
  addColumn('avg_shard_ms', 'REAL');
  addColumn('max_shard_ms', 'REAL');
  addColumn('bootstrap_ms', 'REAL');
  addColumn('api_healthy_ms', 'REAL');
  addColumn('playwright_ms', 'REAL');
  addColumn('phase_p95_preflight_ms', 'REAL');
  addColumn('phase_p95_anvil_boot_ms', 'REAL');
  addColumn('phase_p95_api_boot_ms', 'REAL');
  addColumn('phase_p95_api_healthy_ms', 'REAL');
  addColumn('phase_p95_vite_boot_ms', 'REAL');
  addColumn('phase_p95_playwright_ms', 'REAL');
  db.exec(`CREATE INDEX IF NOT EXISTS qa_runs_suite_key_idx ON qa_runs(suite_key, created_at DESC);`);
  return db;
};

const toNullableNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const rowToPhaseP95 = (row: Record<string, unknown>): QaPhaseTimings | null => {
  const phase = {
    preflight: toNullableNumber(row['phase_p95_preflight_ms']),
    anvilBoot: toNullableNumber(row['phase_p95_anvil_boot_ms']),
    apiBoot: toNullableNumber(row['phase_p95_api_boot_ms']),
    apiHealthy: toNullableNumber(row['phase_p95_api_healthy_ms']),
    viteBoot: toNullableNumber(row['phase_p95_vite_boot_ms']),
    playwright: toNullableNumber(row['phase_p95_playwright_ms']),
  };
  if (QA_PHASE_WATERFALL_ORDER.some(key => phase[key] === null)) return null;
  return phase as QaPhaseTimings;
};

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
        child_cpu_p95_pct,
        avg_shard_ms,
        max_shard_ms,
        bootstrap_ms,
        api_healthy_ms,
        playwright_ms,
        phase_p95_preflight_ms,
        phase_p95_anvil_boot_ms,
        phase_p95_api_boot_ms,
        phase_p95_api_healthy_ms,
        phase_p95_vite_boot_ms,
        phase_p95_playwright_ms,
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
        $childCpuP95Pct,
        $avgShardMs,
        $maxShardMs,
        $bootstrapMs,
        $apiHealthyMs,
        $playwrightMs,
        $phaseP95PreflightMs,
        $phaseP95AnvilBootMs,
        $phaseP95ApiBootMs,
        $phaseP95ApiHealthyMs,
        $phaseP95ViteBootMs,
        $phaseP95PlaywrightMs,
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
        child_cpu_p95_pct = excluded.child_cpu_p95_pct,
        avg_shard_ms = excluded.avg_shard_ms,
        max_shard_ms = excluded.max_shard_ms,
        bootstrap_ms = excluded.bootstrap_ms,
        api_healthy_ms = excluded.api_healthy_ms,
        playwright_ms = excluded.playwright_ms,
        phase_p95_preflight_ms = excluded.phase_p95_preflight_ms,
        phase_p95_anvil_boot_ms = excluded.phase_p95_anvil_boot_ms,
        phase_p95_api_boot_ms = excluded.phase_p95_api_boot_ms,
        phase_p95_api_healthy_ms = excluded.phase_p95_api_healthy_ms,
        phase_p95_vite_boot_ms = excluded.phase_p95_vite_boot_ms,
        phase_p95_playwright_ms = excluded.phase_p95_playwright_ms,
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
      $childCpuP95Pct: qaRunChildCpuP95(normalizedRun),
      $avgShardMs: timing.avgShardMs,
      $maxShardMs: timing.maxShardMs,
      $bootstrapMs: timing.bootstrapMs,
      $apiHealthyMs: timing.apiHealthyMs,
      $playwrightMs: timing.playwrightMs,
      $phaseP95PreflightMs: timing.phaseP95?.preflight ?? null,
      $phaseP95AnvilBootMs: timing.phaseP95?.anvilBoot ?? null,
      $phaseP95ApiBootMs: timing.phaseP95?.apiBoot ?? null,
      $phaseP95ApiHealthyMs: timing.phaseP95?.apiHealthy ?? null,
      $phaseP95ViteBootMs: timing.phaseP95?.viteBoot ?? null,
      $phaseP95PlaywrightMs: timing.phaseP95?.playwright ?? null,
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
  childCpuP95Pct: toNullableNumber(row['child_cpu_p95_pct']),
  avgShardMs: toNullableNumber(row['avg_shard_ms']),
  maxShardMs: toNullableNumber(row['max_shard_ms']),
  bootstrapMs: toNullableNumber(row['bootstrap_ms']),
  apiHealthyMs: toNullableNumber(row['api_healthy_ms']),
  playwrightMs: toNullableNumber(row['playwright_ms']),
  phaseP95: rowToPhaseP95(row),
  logsDir: String(row['logs_dir'] || ''),
});

const historyTimingSummary = (history: QaHistoryEntry): QaRunTimingSummary => ({
  avgShardMs: history.avgShardMs,
  maxShardMs: history.maxShardMs,
  bootstrapMs: history.bootstrapMs,
  apiHealthyMs: history.apiHealthyMs,
  playwrightMs: history.playwrightMs,
  phaseP95: history.phaseP95,
});

const rowToQaRunSummary = (row: Record<string, unknown>): QaRunSummary => {
  const parsed = parseManifestJson(row['manifest_json']);
  const history = rowToQaHistoryEntry(row);
  if (parsed) {
    const summary = summarizeQaRun(parsed);
    return {
      ...summary,
      timing: {
        ...summary.timing,
        phaseP95: history.phaseP95 ?? summary.timing.phaseP95,
      },
      childCpuP95Pct: history.childCpuP95Pct ?? summary.childCpuP95Pct,
    };
  }
  const browserHealth = normalizeQaBrowserHealthSummary({
    issueCount: history.browserIssueCount,
    errorCount: history.browserErrorCount,
    warningCount: history.browserWarningCount,
    networkFailureCount: history.networkFailureCount,
    httpErrorCount: history.httpErrorCount,
  } as QaBrowserHealthSummary, history.createdAt);
  const summary = summarizeQaRun(applyQaRunSeverity({
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
  return {
    ...summary,
    timing: historyTimingSummary(history),
    childCpuP95Pct: history.childCpuP95Pct ?? summary.childCpuP95Pct,
  };
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

export const listQaHistory = async (limit: number = QA.HISTORY_DEFAULT_LIMIT): Promise<QaHistoryEntry[]> => {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(QA.HISTORY_MAX_LIMIT, Math.floor(limit)))
    : QA.HISTORY_DEFAULT_LIMIT;
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
        child_cpu_p95_pct,
        avg_shard_ms,
        max_shard_ms,
        bootstrap_ms,
        api_healthy_ms,
        playwright_ms,
        phase_p95_preflight_ms,
        phase_p95_anvil_boot_ms,
        phase_p95_api_boot_ms,
        phase_p95_api_healthy_ms,
        phase_p95_vite_boot_ms,
        phase_p95_playwright_ms,
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
        child_cpu_p95_pct,
        avg_shard_ms,
        max_shard_ms,
        bootstrap_ms,
        api_healthy_ms,
        playwright_ms,
        phase_p95_preflight_ms,
        phase_p95_anvil_boot_ms,
        phase_p95_api_boot_ms,
        phase_p95_api_healthy_ms,
        phase_p95_vite_boot_ms,
        phase_p95_playwright_ms,
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

export const listQaTestLedger = async (limit = 500): Promise<QaTestLedgerEntry[]> => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(2_000, Math.floor(limit))) : 500;
  const db = openQaHistoryDb();
  try {
    const rows = db.query(`
      SELECT manifest_json
      FROM qa_runs
      WHERE manifest_json IS NOT NULL
      ORDER BY
        CASE WHEN created_at > $latestRealCreatedAt THEN 1 ELSE 0 END ASC,
        created_at DESC
      LIMIT $limit
    `).all({ $limit: safeLimit, $latestRealCreatedAt: Date.now() + FUTURE_RUN_SKEW_MS }) as Array<Record<string, unknown>>;
    const runs = rows
      .map((row) => parseManifestJson(row['manifest_json']))
      .filter((run): run is QaRunManifest => run !== null);
    return buildQaTestLedger(runs);
  } finally {
    db.close();
  }
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

export const purgeQaRunsOlderThan = (retentionDays = QA.RETENTION_MIN_DAYS, now = Date.now()): QaRetentionPurgeResult => {
  const safeRetentionDays = Number.isFinite(retentionDays)
    ? Math.max(QA.RETENTION_MIN_DAYS, Math.floor(retentionDays))
    : QA.RETENTION_MIN_DAYS;
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
      .slice(0, QA.STORY_TAG_LIMIT);
    if (!title && !group && !description && !platform && tags.length === 0) return null;
    return { title, group, description, platform, tags };
  } catch {
    return null;
  }
};

export const makeQaStoryImageUrl = (source: QaStorySource, relativePath: string): string =>
  `/api/qa/story-image?source=${encodeURIComponent(source)}&path=${encodeURIComponent(relativePath)}`;

const shortTail = (text: string, lines: number = QA.LOG_TAIL_LINES): string => text.split('\n').slice(-lines).join('\n');

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

const shortQaTestDescription = (description: string): string => {
  const words = description.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return words.length <= 9 ? words.join(' ') : `${words.slice(0, 9).join(' ')}…`;
};

export const buildQaTestLedger = (runs: readonly QaRunManifest[]): QaTestLedgerEntry[] => {
  const latest = new Map<string, QaTestLedgerEntry>();
  const ordered = [...runs].sort((a, b) => b.createdAt - a.createdAt || b.runId.localeCompare(a.runId));
  for (const run of ordered) {
    for (const shard of run.shards) {
      const target = String(shard.target ?? '').trim();
      const title = String(shard.title ?? shard.handle ?? '').trim();
      if (!target || !title) continue;
      const testId = `${target}::${title}`;
      if (latest.has(testId)) continue;
      latest.set(testId, {
        testId,
        category: shard.testCategory ?? qaTestCategoryFromTags(shard.tags ?? []) ?? 'unknown',
        target,
        title,
        description: shortQaTestDescription(shard.description ?? deriveQaTestDescription(target, title)),
        status: shard.status,
        durationMs: shard.durationMs,
        lastRunId: run.runId,
        lastRunAt: run.createdAt,
      });
    }
  }
  return [...latest.values()].sort((a, b) => a.title.localeCompare(b.title) || a.target.localeCompare(b.target));
};

type QaTargetMetadata = {
  shard: number;
  target: string | null;
  title: string | null;
  handle: string | null;
  description: string | null;
  scenario: QaScenarioMetadata | null;
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
        scenario: normalizeQaScenarioMetadata(entry.scenario) ?? normalizeQaScenarioMetadata(entry),
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
  const timelineSteps = parseQaTimelineSteps(logText).slice(0, QA.SHARD_TIMELINE_STEP_LIMIT);
  const slowSteps = parseQaSlowSteps(logText).slice(0, QA.SHARD_SLOW_STEP_LIMIT);
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
    scenario: metadata?.scenario ?? null,
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

const buildCorruptManifestRun = async (
  runId: string,
  runDir: string,
  cause: unknown,
  rawManifest: string,
): Promise<QaRunManifest> => {
  const runStat = await stat(runDir);
  const createdAt = parseRunIdTimestamp(runId) ?? runStat.mtimeMs;
  const causeText = cause instanceof Error ? cause.message : String(cause || 'unknown manifest parse error');
  const rawPreview = rawManifest.trim() ? `\n${redactQaSecretText(rawManifest).slice(0, 1_000)}` : '';
  const error = redactQaSecretText(`QA_CORRUPT_MANIFEST: ${causeText}${rawPreview}`);
  const shard = normalizeQaShardSeverity({
    shard: 0,
    status: 'failed',
    durationMs: null,
    handle: 'qa.corrupt-manifest',
    description: 'QA run manifest could not be parsed or did not contain a shard list.',
    scenario: null,
    target: null,
    title: 'corrupt QA manifest',
    requireMarketMaker: null,
    logRelativePath: 'manifest.json',
    logTail: error,
    error,
    failureClass: 'infra',
    phaseMs: null,
    browserIssues: [],
    browserHealth: summarizeQaBrowserIssues([], createdAt),
    timelineSteps: [],
    slowSteps: [],
    artifacts: [],
    hasVideo: false,
    hasTrace: false,
    severity: 'FAIL',
    reason: 'QA run manifest is corrupt',
    since: createdAt,
    owner: 'qa',
    evidence: [
      { label: 'failure class', value: 'infra' },
      { label: 'artifact', value: 'manifest.json' },
    ],
  }, createdAt);

  return applyQaRunSeverity({
    manifestVersion: 1,
    runId,
    createdAt,
    completedAt: runStat.mtimeMs,
    status: 'failed',
    totalMs: null,
    totalShards: 1,
    passedShards: 0,
    failedShards: 1,
    failureClasses: ['infra'],
    args: null,
    browserHealth: summarizeQaRunBrowserHealth({ shards: [shard] }),
    shards: [shard],
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
    const archivedRun = readQaHistoryManifest(runId);
    if (archivedRun) return archivedRun;
    throw new Error('QA_RUN_NOT_FOUND');
  }

  const manifestPath = join(runDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const raw = await readFile(manifestPath, 'utf8');
    let parsed: QaRunManifest;
    try {
      parsed = JSON.parse(raw) as QaRunManifest;
      if (!Array.isArray(parsed.shards)) throw new Error('QA_MANIFEST_SHARDS_MISSING');
    } catch (error) {
      return await buildCorruptManifestRun(runId, runDir, error, raw);
    }
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
            ? parseQaTimelineSteps(logText).slice(0, QA.SHARD_TIMELINE_STEP_LIMIT)
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
          scenario: normalizeQaScenarioMetadata(shard.scenario) ?? metadata?.scenario ?? null,
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
            : timelineSteps.slice().sort((a, b) => b.ms - a.ms).slice(0, QA.SHARD_SLOW_STEP_LIMIT),
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

const enrichQaArtifactUrl = async (runId: string, artifact: QaArtifact): Promise<QaArtifact> => {
  const normalized = {
    ...artifact,
    sensitivity: artifact.sensitivity ?? classifyQaArtifactSensitivity(artifact),
  };
  try {
    await resolveQaArtifactPath(runId, artifact.relativePath);
    return {
      ...normalized,
      url: makeQaArtifactUrl(runId, artifact.relativePath),
    };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'QA_ARTIFACT_NOT_FOUND') throw error;
    const { url: _missingUrl, ...withoutUrl } = normalized;
    return withoutUrl;
  }
};

export const enrichQaRunUrls = async (run: QaRunManifest): Promise<QaRunManifest> => ({
  ...run,
  shards: await Promise.all(run.shards.map(async shard => ({
    ...shard,
    artifacts: await Promise.all(
      sortArtifacts([...(shard.artifacts ?? [])]).map(artifact => enrichQaArtifactUrl(run.runId, artifact)),
    ),
  }))),
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
    phaseWaterfall: buildQaPhaseWaterfall(shard.phaseMs),
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

export const summarizeQaRun = (run: QaRunManifest): QaRunSummary => ({
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
  suiteKey: qaRunSuiteKey(run),
  suiteLabel: qaRunSuiteLabel(run),
  category: qaRunCategory(run),
  testCategory: qaRunTestCategory(run),
  ...(run.code ? { code: run.code } : {}),
  ...(run.perf ? { perf: summarizeQaPerf(run.perf) } : {}),
  browserHealth: run.browserHealth ?? summarizeQaRunBrowserHealth(run),
  ...(run.benchmark ? { benchmark: run.benchmark } : {}),
  totalShards: run.totalShards,
  passedShards: run.passedShards,
  failedShards: run.failedShards,
  failureClasses: Array.from(new Set([...(run.failureClasses ?? []), ...summarizeQaFailureClasses(run.shards)])).sort(compareStableText),
  args: run.args ?? null,
  failingTargets: run.shards
    .filter(shard => shard.status === 'failed')
    .map(shard => shard.handle || shard.target || shard.title || `shard-${shard.shard}`)
    .slice(0, 5),
  fatalMarkers: summarizeQaFatalMarkers(run),
  artifactBytes: qaRunArtifactBytes(run),
  childCpuP95Pct: qaRunChildCpuP95(run),
});

export const qaArtifactContentType = (filePath: string): string => detectContentType(basename(filePath));
