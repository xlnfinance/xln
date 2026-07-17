import type {
  QaArtifact,
  QaBenchmarkComparison,
  QaBenchmarkMetricDelta,
  QaBrowserHealthSummary,
  QaBrowserIssue,
  QaCodeFingerprint,
  QaFatalMarker as RuntimeQaFatalMarker,
  QaHistoryBackfillResult,
  QaHistoryEntry,
  QaPerfSummaryView,
  QaPhaseKey,
  QaPhaseTimings,
  QaPhaseWaterfall,
  QaPhaseWaterfallSegment,
  QaRegressionBaselineComparison,
  QaRegressionBaselineKind,
  QaRegressionMetricDelta,
  QaRegressionReport,
  QaRegressionStatus,
  QaRetentionPurgeResult,
  QaRunCategory,
  QaRunLedgerEntry,
  QaRunTestCategory,
  QaRunSummary,
  QaRunTimingSummary,
  QaRunView,
  QaScenarioMetadata,
  QaShardView,
  QaSlowStep,
  QaStoryScreenshot,
  QaTestCategory,
  QaTestLedgerEntry,
  QaSystemVerdict,
  QaSystemVerdictStatus,
  QaUxReleasePackAudit,
} from '@xln/runtime/qa/types';
import type { QaSeveritySignal } from '@xln/runtime/qa/severity';

export type {
  QaArtifact,
  QaBenchmarkComparison,
  QaBenchmarkMetricDelta,
  QaBrowserHealthSummary,
  QaBrowserIssue,
  QaCodeFingerprint,
  QaHistoryBackfillResult,
  QaHistoryEntry,
  QaPhaseKey,
  QaPhaseTimings,
  QaPhaseWaterfall,
  QaPhaseWaterfallSegment,
  QaRegressionBaselineComparison,
  QaRegressionBaselineKind,
  QaRegressionMetricDelta,
  QaRegressionReport,
  QaRegressionStatus,
  QaRetentionPurgeResult,
  QaRunCategory,
  QaRunLedgerEntry,
  QaRunTestCategory,
  QaRunTimingSummary,
  QaScenarioMetadata,
  QaSeveritySignal,
  QaSlowStep,
  QaStoryScreenshot,
  QaTestCategory,
  QaTestLedgerEntry,
  QaSystemVerdict,
  QaUxReleasePackAudit,
};

export type QaPerfSummary = QaPerfSummaryView;

export type QaAuthInfo = {
  scope?: 'read' | 'admin';
  disabled?: boolean;
};

export type QaFailureClass =
  | RuntimeQaFatalMarker['failureClass']
  | 'performance'
  | 'browser'
  | 'network'
  | 'operations';

export type QaFailureClassFilter = QaFailureClass | 'all';

export type QaFatalMarker = Omit<RuntimeQaFatalMarker, 'failureClass'> & {
  failureClass: QaFailureClass;
};

export type QaSummary = Omit<QaRunSummary, 'failureClasses' | 'fatalMarkers'> & {
  failureClasses?: QaFailureClass[];
  fatalMarkers?: QaFatalMarker[];
};

export type QaShard = Omit<QaShardView, 'failureClass'> & {
  failureClass?: QaFailureClass | null;
};

export type QaRun = Omit<QaRunView, 'failureClasses' | 'fatalMarkers' | 'shards'> & {
  failureClasses?: QaFailureClass[];
  fatalMarkers?: QaFatalMarker[];
  shards: QaShard[];
};

export type QaCatalogEntry = {
  id: string;
  group: string;
  label: string;
  command: string;
  description: string;
};

export type QaRestartAuditEntry = QaSeveritySignal & {
  auditId: string;
  status: 'started' | 'finished' | 'spawn_error' | 'watchdog_timeout' | 'aborted' | 'orphaned';
  actorKeyId: string;
  scope: 'read' | 'admin';
  operatorId: string;
  action: 'restart-run';
  target: string;
  title: string;
  reason: string;
  expectedGitHead: string | null;
  actualGitHead: string | null;
  gitBranch: string | null;
  codeHash: string | null;
  dirty: boolean;
  startedAt: number;
  finishedAt: number | null;
  pid: number | null;
  exitCode: number | null;
  logPath: string;
  requestIp: string | null;
  userAgent: string | null;
};

export type RestartStatus = Partial<QaSeveritySignal> & {
  active: boolean;
  target?: string;
  title?: string;
  pid?: number | null;
  command?: string[];
  logPath?: string;
  timeoutMs?: number;
  watchdogAt?: number;
  killGraceMs?: number;
  terminating?: boolean;
  terminalStatus?: string | null;
  cooldownUntil?: number;
  cooldownRemainingMs?: number;
  last?: {
    startedAt: number;
    target: string;
    title: string;
    exitCode: number | null;
    logPath: string;
  };
};

export type QaView = 'e2e' | 'scenarios' | 'gallery' | 'suites' | 'benchmarks' | 'history';

export type RunSortKey =
  | 'date-desc'
  | 'date-asc'
  | 'stack-fast'
  | 'stack-slow'
  | 'bootstrap-fast'
  | 'bootstrap-slow'
  | 'playwright-fast'
  | 'playwright-slow'
  | 'test-fast'
  | 'test-slow';

export type ShardSortKey =
  | 'index'
  | 'duration-fast'
  | 'duration-slow'
  | 'bootstrap-fast'
  | 'bootstrap-slow'
  | 'playwright-fast'
  | 'playwright-slow';

export type QaVerdictStatus = QaSystemVerdictStatus;
export type QaFailureSeverity = 'FAIL' | 'DEGRADED' | 'WARN';

export type QaFailureInboxItem = {
  id: string;
  severity: QaFailureSeverity;
  failureClass: QaFailureClass;
  title: string;
  detail: string;
  runId: string | null;
  createdAt: number;
  shard?: number;
  phaseKey?: QaPhaseKey;
  phaseLimitMs?: number;
};

export type QaVerdictSummary = {
  status: QaVerdictStatus;
  reason: string;
  activeCount: number;
  failingSurfaceCount: number;
  latestRunId: string | null;
  latestAt: number | null;
  gitHead: string | null;
  codeHash: string | null;
  dirty: boolean;
  regressionStatus: QaBenchmarkComparison['status'] | null;
  browserErrorCount: number;
  browserWarningCount: number;
};
