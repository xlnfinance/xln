import type { QaSeveritySignal } from './severity';

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

export type QaShardManifest = {
  shard: number;
  status: 'passed' | 'failed' | 'unknown';
  durationMs: number | null;
  handle: string | null;
  description: string | null;
  scenario: QaScenarioMetadata | null;
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
