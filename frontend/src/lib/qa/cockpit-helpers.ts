import type { QaSeverity } from '@xln/runtime/qa/severity';
import { DISPLAY, QA } from '@xln/runtime/constants';
import type {
  QaBenchmarkComparison,
  QaBrowserHealthSummary,
  QaBrowserIssue,
  QaFailureClass,
  QaFailureClassFilter,
  QaFailureInboxItem,
  QaFailureSeverity,
  QaHistoryEntry,
  QaPhaseKey,
  QaPhaseTimings,
  QaPhaseWaterfall,
  QaPhaseWaterfallSegment,
  QaRegressionBaselineComparison,
  QaRegressionMetricDelta,
  QaRegressionStatus,
  QaRestartAuditEntry,
  QaRun,
  QaRunLedgerEntry,
  QaSeveritySignal,
  QaShard,
  QaSummary,
  QaSystemVerdict,
  QaVerdictStatus,
  QaVerdictSummary,
  RunSortKey,
} from './types';

export const phaseOrder: QaPhaseKey[] = ['preflight', 'anvilBoot', 'apiBoot', 'apiHealthy', 'viteBoot', 'playwright'];

export const phaseLabels: Record<QaPhaseKey, string> = {
  preflight: 'preflight',
  anvilBoot: 'anvil',
  apiBoot: 'api boot',
  apiHealthy: 'health',
  viteBoot: 'vite',
  playwright: 'playwright',
};

export const phaseBudgets: Record<QaPhaseKey, number> = {
  preflight: QA.PHASE_BUDGET_MS.preflight,
  anvilBoot: QA.PHASE_BUDGET_MS.anvilBoot,
  apiBoot: QA.PHASE_BUDGET_MS.apiBoot,
  apiHealthy: QA.PHASE_BUDGET_MS.apiHealthy,
  viteBoot: QA.PHASE_BUDGET_MS.viteBoot,
  playwright: QA.PHASE_BUDGET_MS.playwright,
};

export function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return 'n/a';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return 'n/a';
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return [
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`,
    'UTC',
  ].join(' ');
}

export function formatMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function formatCount(run: QaSummary | QaRun | null): string {
  if (!run) return '0/0';
  return `${run.passedShards}/${run.totalShards}`;
}

export function okSeverity(owner: string, reason: string, since = 0): QaSeveritySignal {
  return {
    severity: 'OK',
    reason,
    since,
    owner,
    evidence: [],
  };
}

export function emptyBrowserHealth(): QaBrowserHealthSummary {
  return {
    ...okSeverity('browser', 'Browser event stream is clean'),
    issueCount: 0,
    errorCount: 0,
    warningCount: 0,
    networkFailureCount: 0,
    httpErrorCount: 0,
  };
}

export function browserHealth(run: QaSummary | QaRun | null | undefined): QaBrowserHealthSummary {
  return run?.browserHealth ?? emptyBrowserHealth();
}

export function browserHealthFromHistory(row: QaHistoryEntry): QaBrowserHealthSummary {
  const severity: QaSeverity = row.browserErrorCount > 0 ? 'FAIL' : row.browserWarningCount > 0 ? 'WARN' : 'OK';
  return {
    severity,
    reason: severity === 'FAIL'
      ? `${row.browserErrorCount} browser error(s) captured`
      : severity === 'WARN'
        ? `${row.browserWarningCount} browser warning(s) captured`
        : 'Browser event stream is clean',
    since: row.createdAt,
    owner: 'browser',
    evidence: [
      { label: 'errors', value: row.browserErrorCount },
      { label: 'warnings', value: row.browserWarningCount },
    ],
    issueCount: row.browserIssueCount,
    errorCount: row.browserErrorCount,
    warningCount: row.browserWarningCount,
    networkFailureCount: row.networkFailureCount,
    httpErrorCount: row.httpErrorCount,
  };
}

export function formatBrowserHealth(health: QaBrowserHealthSummary | null | undefined): string {
  const value = health ?? emptyBrowserHealth();
  if (value.issueCount <= 0) return 'clean';
  return `${value.errorCount} err / ${value.warningCount} warn`;
}

export function browserIssueDetail(health: QaBrowserHealthSummary): string {
  return `${health.errorCount} browser errors, ${health.warningCount} warnings, ${health.networkFailureCount} network failures, ${health.httpErrorCount} HTTP responses`;
}

export function shardBrowserHealth(shard: QaShard | null | undefined): QaBrowserHealthSummary {
  if (shard?.browserHealth) return shard.browserHealth;
  const issues = shard?.browserIssues ?? [];
  const errorCount = issues.filter(issue => issue.severity === 'error').length;
  const warningCount = issues.filter(issue => issue.severity === 'warning').length;
  const severity: QaSeverity = errorCount > 0 ? 'FAIL' : warningCount > 0 ? 'WARN' : 'OK';
  return {
    severity,
    reason: severity === 'FAIL'
      ? `${errorCount} browser error(s) captured`
      : severity === 'WARN'
        ? `${warningCount} browser warning(s) captured`
        : 'Browser event stream is clean',
    since: issues.map(issue => issue.timestamp).sort((a, b) => a - b)[0] ?? 0,
    owner: 'browser',
    evidence: [
      { label: 'errors', value: errorCount },
      { label: 'warnings', value: warningCount },
    ],
    issueCount: issues.length,
    errorCount,
    warningCount,
    networkFailureCount: issues.filter(issue => issue.type === 'requestfailed').length,
    httpErrorCount: issues.filter(issue => issue.type === 'http').length,
  };
}

export function browserIssueLabel(issue: QaBrowserIssue): string {
  const status = issue.status ? ` ${issue.status}` : '';
  return `${issue.type}${status}`;
}

export function shortHash(value: string | null | undefined, len = DISPLAY.SHORT_HASH_HEX_CHARS): string {
  const raw = String(value || '').trim();
  return raw ? raw.slice(0, len) : 'n/a';
}

export function statusLabel(entry: { status: 'passed' | 'failed' | 'unknown' }): string {
  if (entry.status === 'passed') return 'PASS';
  if (entry.status === 'failed') return 'FAIL';
  return 'UNKNOWN';
}

export function benchmarkLabel(status: QaBenchmarkComparison['status'] | null | undefined): string {
  if (!status) return 'n/a';
  if (status === 'insufficient') return 'NEW';
  return status.toUpperCase();
}

export function regressionLabel(status: QaRegressionStatus | null | undefined): string {
  if (!status) return 'n/a';
  if (status === 'failed') return 'FAIL';
  return benchmarkLabel(status);
}

export function topRegressionMetric(comparison: QaRegressionBaselineComparison): QaRegressionMetricDelta | null {
  return comparison.metrics
    .filter(metric => metric.verdict !== 'ok' && metric.metric !== 'peakLoad1')
    .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))[0] ?? null;
}

export function formatPct(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function classifyFailureText(value: string): QaFailureClass {
  const lower = value.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('timeoutexceeded')) return 'timeout';
  if (lower.includes('page crashed') || lower.includes('sigsegv') || lower.includes('fatal runtime')) return 'crash';
  if (lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('token') || lower.includes('cors')) return 'security';
  if (lower.includes('flake') || lower.includes('retry')) return 'flake';
  if (lower.includes('boot') || lower.includes('health') || lower.includes('anvil') || lower.includes('vite') || lower.includes('econnrefused') || lower.includes('http 5')) return 'infra';
  if (lower.includes('expect') || lower.includes('assert') || lower.includes('expected:')) return 'assertion';
  return 'unknown';
}

export function finiteSortValue(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function phaseObservedMs(run: QaSummary, key: QaPhaseKey): number | null {
  const p95 = run.timing?.phaseP95?.[key];
  if (typeof p95 === 'number' && Number.isFinite(p95)) return p95;
  if (key === 'apiHealthy') return finiteSortValue(run.timing?.apiHealthyMs, Number.NaN);
  if (key === 'playwright') return finiteSortValue(run.timing?.playwrightMs, Number.NaN);
  return null;
}

export function runMatchesFailureClass(run: QaSummary, failureClass: QaFailureClassFilter): boolean {
  if (failureClass === 'all') return true;
  if ((run.failureClasses ?? []).includes(failureClass)) return true;
  if ((run.fatalMarkers ?? []).some((marker) => marker.failureClass === failureClass)) return true;
  const health = browserHealth(run);
  if (failureClass === 'performance') {
    return (
      run.benchmark?.status === 'slower' ||
      run.benchmark?.status === 'mixed' ||
      phaseOrder.some((key) => {
        const ms = phaseObservedMs(run, key);
        return typeof ms === 'number' && Number.isFinite(ms) && ms > phaseBudgets[key];
      })
    );
  }
  if (failureClass === 'network') return health.networkFailureCount > 0 || health.httpErrorCount > 0;
  if (failureClass === 'browser') return health.issueCount > 0 && health.networkFailureCount === 0 && health.httpErrorCount === 0;
  if (failureClass === 'unknown') return run.status === 'failed' && (run.failureClasses ?? []).length === 0;
  return false;
}

export function buildFailureClassOptions(runRows: QaSummary[], inbox: QaFailureInboxItem[]): QaFailureClass[] {
  const classes = new Set<QaFailureClass>();
  for (const run of runRows) {
    for (const failureClass of run.failureClasses ?? []) classes.add(failureClass);
  }
  for (const item of inbox) classes.add(item.failureClass);
  return [...classes].sort((a, b) => a.localeCompare(b));
}

function runFailureItem(run: QaSummary): QaFailureInboxItem | null {
  if (run.status !== 'failed' && run.failedShards <= 0) return null;
  const detail = run.failingTargets.length > 0 ? run.failingTargets.join(' · ') : `run ${run.runId}`;
  return {
    id: `run-fail:${run.runId}`,
    severity: 'FAIL',
    failureClass: run.failureClasses?.[0] ?? classifyFailureText(detail),
    title: `${run.failedShards || 1} failing shard`,
    detail,
    runId: run.runId,
    createdAt: run.createdAt,
  };
}

function benchmarkFailureItem(run: QaSummary): QaFailureInboxItem | null {
  const status = run.benchmark?.status;
  if (status !== 'slower' && status !== 'mixed') return null;
  return {
    id: `bench:${run.runId}`,
    severity: 'DEGRADED',
    failureClass: 'performance',
    title: benchmarkLabel(status),
    detail: run.benchmark?.reason || 'Performance regression',
    runId: run.runId,
    createdAt: run.createdAt,
  };
}

function browserFailureItem(run: QaSummary): QaFailureInboxItem | null {
  const health = browserHealth(run);
  if (health.issueCount <= 0) return null;
  const severity: QaFailureSeverity = health.errorCount > 0 ? 'FAIL' : 'WARN';
  return {
    id: `browser:${run.runId}`,
    severity,
    failureClass: health.networkFailureCount > 0 || health.httpErrorCount > 0 ? 'network' : 'browser',
    title: health.errorCount > 0 ? 'Browser health failed' : 'Browser warnings',
    detail: browserIssueDetail(health),
    runId: run.runId,
    createdAt: run.createdAt,
  };
}

function fatalMarkerFailureItems(run: QaSummary): QaFailureInboxItem[] {
  return (run.fatalMarkers ?? []).slice(0, 3).map((marker, index) => ({
    id: `fatal:${run.runId}:${marker.shard}:${index}`,
    severity: 'FAIL',
    failureClass: marker.failureClass,
    title: 'Fatal runtime marker',
    detail: `${marker.handle || marker.target || marker.title || `shard-${marker.shard}`}: ${marker.line}`,
    runId: run.runId,
    createdAt: run.createdAt,
    shard: marker.shard,
  }));
}

function historicalPhaseLimit(runRows: QaSummary[], run: QaSummary, key: QaPhaseKey): number | null {
  if (!run.suiteKey) return null;
  const samples = runRows
    .filter((candidate) =>
      candidate.runId !== run.runId &&
      candidate.suiteKey === run.suiteKey &&
      candidate.createdAt < run.createdAt
    )
    .map((candidate) => candidate.timing?.phaseP95?.[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (samples.length === 0) return null;
  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * 0.95) - 1));
  return samples[index]!;
}

function phaseBudgetFailureItem(run: QaSummary, runRows: QaSummary[]): QaFailureInboxItem | null {
  const breaches = phaseOrder
    .map((key) => {
      const ms = phaseObservedMs(run, key);
      if (ms === null || !Number.isFinite(ms)) return null;
      const historicalLimit = historicalPhaseLimit(runRows, run, key);
      const limitMs = Math.floor(historicalLimit ?? phaseBudgets[key]);
      if (limitMs <= 0 || ms <= limitMs) return null;
      return {
        key,
        ms,
        limitMs,
        limitKind: historicalLimit === null ? 'budget' : 'p95',
        deltaMs: ms - limitMs,
      };
    })
    .filter((item): item is { key: QaPhaseKey; ms: number; limitMs: number; limitKind: 'budget' | 'p95'; deltaMs: number } => Boolean(item))
    .sort((a, b) => b.deltaMs - a.deltaMs);
  const breach = breaches[0];
  if (!breach) return null;
  return {
    id: `phase:${run.runId}:${breach.key}`,
    severity: 'DEGRADED',
    failureClass: 'performance',
    title: 'Phase budget exceeded',
    detail: `${phaseLabels[breach.key]} ${formatMs(breach.ms)} > ${breach.limitKind} ${formatMs(breach.limitMs)}`,
    runId: run.runId,
    createdAt: run.createdAt,
    phaseKey: breach.key,
    phaseLimitMs: breach.limitMs,
  };
}

function restartFailureItem(row: QaRestartAuditEntry): QaFailureInboxItem | null {
  const failed = row.status === 'spawn_error' || (row.exitCode !== null && row.exitCode !== 0);
  if (!failed) return null;
  return {
    id: `restart:${row.auditId}`,
    severity: 'FAIL',
    failureClass: 'operations',
    title: 'Restart failed',
    detail: `${row.operatorId}: ${row.reason}`,
    runId: null,
    createdAt: row.startedAt,
  };
}

export function buildFailureInbox(runRows: QaSummary[], auditRows: QaRestartAuditEntry[]): QaFailureInboxItem[] {
  const runItems = runRows.flatMap((run) => [
    runFailureItem(run),
    browserFailureItem(run),
    benchmarkFailureItem(run),
    phaseBudgetFailureItem(run, runRows),
    ...fatalMarkerFailureItems(run),
  ].filter(Boolean) as QaFailureInboxItem[]);
  const restartItems = auditRows.map(restartFailureItem).filter(Boolean) as QaFailureInboxItem[];
  return [...runItems, ...restartItems].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
}

export function verdictStatusFromSeverity(severity: QaSeverity): QaVerdictStatus {
  if (severity === 'OK') return 'PASS';
  if (severity === 'WARN' || severity === 'DEGRADED') return 'DEGRADED';
  if (severity === 'FAIL' || severity === 'BLOCKED') return 'FAIL';
  return 'UNKNOWN';
}

export function emptyVerdict(activeCount: number): QaVerdictSummary {
  return {
    status: 'UNKNOWN',
    reason: 'No QA runs yet',
    activeCount,
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

export function buildVerdictSummary(
  source: QaSystemVerdict | null,
  run: QaSummary | null,
  inbox: QaFailureInboxItem[],
): QaVerdictSummary {
  const operationIssues = inbox.filter(item => item.failureClass === 'operations');
  if (source) {
    const hasOperationFail = operationIssues.some(item => item.severity === 'FAIL');
    return {
      status: hasOperationFail ? 'FAIL' : source.status,
      reason: operationIssues[0]?.detail || source.reason,
      activeCount: source.activeCount + operationIssues.length,
      failingSurfaceCount: source.failingSurfaceCount + operationIssues.length,
      latestRunId: source.latestRunId,
      latestAt: source.latestAt,
      gitHead: source.gitHead,
      codeHash: source.codeHash,
      dirty: source.dirty,
      regressionStatus: source.regressionStatus,
      browserErrorCount: source.browserErrorCount,
      browserWarningCount: source.browserWarningCount,
    };
  }
  if (!run) {
    return emptyVerdict(inbox.length);
  }
  const latestIssues = inbox.filter(item => item.runId === run.runId || item.failureClass === 'operations');
  const issueOverride = latestIssues.some(item => item.severity === 'FAIL')
    ? 'FAIL'
    : latestIssues.length > 0 && run.severity === 'OK'
      ? 'DEGRADED'
      : null;
  const status: QaVerdictStatus = issueOverride ?? verdictStatusFromSeverity(run.severity);
  return {
    status,
    reason: latestIssues[0]?.detail || run.reason,
    activeCount: latestIssues.length,
    failingSurfaceCount: latestIssues.length,
    latestRunId: run.runId,
    latestAt: run.createdAt,
    gitHead: run.code?.gitHead ?? null,
    codeHash: run.code?.codeHash ?? null,
    dirty: run.code?.dirty === true,
    regressionStatus: run.benchmark?.status ?? null,
    browserErrorCount: browserHealth(run).errorCount,
    browserWarningCount: browserHealth(run).warningCount,
  };
}

export function runTimingValue(run: QaSummary | QaHistoryEntry | QaRunLedgerEntry, key: RunSortKey): number {
  const timing = 'timing' in run ? run.timing : null;
  if (key.startsWith('stack')) return finiteSortValue('durationMs' in run ? run.durationMs : run.totalMs, Number.POSITIVE_INFINITY);
  if (key.startsWith('bootstrap')) {
    return finiteSortValue(timing?.bootstrapMs ?? ('bootstrapMs' in run ? run.bootstrapMs : null), Number.POSITIVE_INFINITY);
  }
  if (key.startsWith('playwright')) {
    return finiteSortValue(timing?.playwrightMs ?? ('playwrightMs' in run ? run.playwrightMs : null), Number.POSITIVE_INFINITY);
  }
  if (key.startsWith('test')) {
    return finiteSortValue(timing?.avgShardMs ?? ('avgShardMs' in run ? run.avgShardMs : null), Number.POSITIVE_INFINITY);
  }
  return finiteSortValue(run.createdAt, 0);
}

export function compareRunsForSort(
  a: QaSummary | QaHistoryEntry | QaRunLedgerEntry,
  b: QaSummary | QaHistoryEntry | QaRunLedgerEntry,
  key: RunSortKey,
): number {
  if (key === 'date-asc') return a.createdAt - b.createdAt || a.runId.localeCompare(b.runId);
  if (key === 'date-desc') return b.createdAt - a.createdAt || b.runId.localeCompare(a.runId);
  const descending = key.endsWith('slow');
  const av = runTimingValue(a, key);
  const bv = runTimingValue(b, key);
  return descending ? bv - av || b.createdAt - a.createdAt : av - bv || b.createdAt - a.createdAt;
}

export function shardBootstrapMs(shard: QaShard): number | null {
  const phase = shard.phaseMs;
  if (!phase) return null;
  return phase.preflight + phase.anvilBoot + phase.apiBoot + phase.apiHealthy + phase.viteBoot;
}

export function phaseValue(phaseMs: QaPhaseTimings, key: QaPhaseKey): number {
  return Math.max(0, Math.floor(Number(phaseMs[key]) || 0));
}

export function buildPhaseWaterfall(
  phaseMs: QaPhaseTimings | null,
  historicalP95: QaPhaseTimings | null = null,
): QaPhaseWaterfall | null {
  if (!phaseMs) return null;
  const totalMs = phaseOrder.reduce((sum, key) => sum + phaseValue(phaseMs, key), 0);
  const denominator = totalMs > 0 ? totalMs : 1;
  const segments = phaseOrder.map((key): QaPhaseWaterfallSegment => {
    const ms = phaseValue(phaseMs, key);
    const p95 = historicalP95?.[key];
    const hasHistoricalP95 = typeof p95 === 'number' && Number.isFinite(p95) && p95 > 0;
    const limitMs = Math.max(0, Math.floor(hasHistoricalP95 ? p95 : phaseBudgets[key]));
    return {
      key,
      label: phaseLabels[key],
      ms,
      pct: Math.round((ms / denominator) * 10_000) / 100,
      limitMs,
      limitKind: hasHistoricalP95 ? 'historical-p95' : 'budget',
      overLimit: limitMs > 0 && ms > limitMs,
    };
  });
  return {
    totalMs,
    overLimitCount: segments.filter((segment) => segment.overLimit).length,
    segments,
  };
}

export function phaseSegmentWidth(segment: QaPhaseWaterfallSegment): string {
  if (segment.ms <= 0) return '0%';
  return `${Math.max(3, segment.pct)}%`;
}

export function phaseLimitLabel(segment: QaPhaseWaterfallSegment): string {
  const prefix = segment.limitKind === 'historical-p95' ? 'p95' : 'budget';
  return `${prefix} ${formatMs(segment.limitMs)}`;
}
