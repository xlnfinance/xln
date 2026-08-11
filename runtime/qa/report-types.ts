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

type QaFailureCapsule = {
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
  candidateId?: string;
  gateConfigHash?: string;
  shard: number;
  portBase?: number | null;
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
  candidate?: QaCandidateIdentity;
  gateConfig?: Record<string, unknown>;
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

export type QaShardManifestDraft = Omit<QaShardManifest, keyof QaSeveritySignal> &
  Partial<QaSeveritySignal>;

export type QaRunManifestDraft = Omit<QaRunManifest, keyof QaSeveritySignal | 'shards'> &
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

export const QA_RUN_MANIFEST_VERSION = 5;

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

export type QaShardFailureInput = Pick<QaShardManifest, 'status' | 'error' | 'logTail'> & {
  browserIssues?: QaBrowserIssue[];
};

// QA run evidence (per-run artifacts + the history DB) lives under QA_EVIDENCE_ROOT so
// it can be pinned to a persistent location on prod — outside the git checkout that
// the canonical platform deploy hard-resets/cleans — while defaulting to local .logs for dev.
// Curated story screenshots stay tracked in-repo and ship with the code deploy, so
// their root is intentionally left relative to the checkout.
const QA_EVIDENCE_ROOT = process.env['QA_EVIDENCE_ROOT']
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
import { resolve } from 'node:path';
import type { QaCandidateIdentity } from './candidate';
import type { QaSeveritySignal } from './severity';
