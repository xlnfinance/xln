<script lang="ts">
  import { onMount } from 'svelte';
  import QaProtectedImage from '$lib/components/QA/QaProtectedImage.svelte';
  import QaScenarioPlayer from '$lib/components/QA/QaScenarioPlayer.svelte';
  import {
    qaScenarioDescription,
    qaScenarioTitle,
    tenWordScenarioSummary,
  } from '$lib/qa/scenarioPlayer';
  import { clearQaToken, consumeQaTokenFromUrl, qaFetch, writeQaToken } from '$lib/qa/apiClient';
  import type { QaSeverity, QaSeverityEvidence } from '@xln/runtime/qa/severity';

  type QaAuthInfo = {
    scope?: 'read' | 'admin';
    disabled?: boolean;
  };

  type QaSeveritySignal = {
    severity: QaSeverity;
    reason: string;
    since: number;
    owner: string;
    evidence: QaSeverityEvidence[];
  };

  type QaSummary = QaSeveritySignal & {
    manifestVersion: number;
    runId: string;
    createdAt: number;
    completedAt: number | null;
    status: 'passed' | 'failed' | 'unknown';
    totalMs: number | null;
    timing?: QaRunTimingSummary;
    code?: QaCodeFingerprint;
    perf?: QaPerfSummary;
    browserHealth?: QaBrowserHealthSummary;
    benchmark?: QaBenchmarkComparison;
    totalShards: number;
    passedShards: number;
    failedShards: number;
    failureClasses?: QaFailureClass[];
    args?: Record<string, unknown> | null;
    suiteKey?: string;
    suiteLabel?: string;
    failingTargets: string[];
    fatalMarkers?: QaFatalMarker[];
  };

  type QaArtifact = {
    name: string;
    relativePath: string;
    sizeBytes: number;
    kind: 'video' | 'image' | 'trace' | 'json' | 'text' | 'archive' | 'other';
    sensitivity: 'public' | 'internal' | 'secret-bearing';
    contentType: string;
    url?: string;
  };

  type QaStoryScreenshot = {
    id: string;
    source: 'e2e-screenshots' | 'qa-run';
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
    status?: 'passed' | 'failed' | 'unknown';
  };

  type QaUxReleasePackAudit = {
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

  type QaSlowStep = {
    label: string;
    ms: number;
    startMs?: number;
    endMs?: number;
  };

  type QaPhaseTimings = {
    preflight: number;
    anvilBoot: number;
    apiBoot: number;
    apiHealthy: number;
    viteBoot: number;
    playwright: number;
  };

  type QaPhaseKey = keyof QaPhaseTimings;

  type QaPhaseWaterfallSegment = {
    key: QaPhaseKey;
    label: string;
    ms: number;
    pct: number;
    limitMs: number;
    limitKind: 'budget' | 'historical-p95';
    overLimit: boolean;
  };

  type QaPhaseWaterfall = {
    totalMs: number;
    overLimitCount: number;
    segments: QaPhaseWaterfallSegment[];
  };

  type QaShard = QaSeveritySignal & {
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
    failureClass?: QaFailureClass | null;
    phaseMs: QaPhaseTimings | null;
    phaseWaterfall?: QaPhaseWaterfall | null;
    perf?: QaPerfSummary;
    browserIssues?: QaBrowserIssue[];
    browserHealth?: QaBrowserHealthSummary;
    timelineSteps?: QaSlowStep[];
    slowSteps: QaSlowStep[];
    artifacts: QaArtifact[];
    hasVideo: boolean;
    hasTrace: boolean;
  };

  type QaRun = QaSeveritySignal & {
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
    fatalMarkers?: QaFatalMarker[];
    args?: Record<string, unknown> | null;
    shards: QaShard[];
  };

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

  type QaPerfSummary = {
    sampleCount: number;
    avgLoad1: number;
    peakLoad1: number;
    minFreeMemBytes: number;
    maxRunnerRssBytes: number;
    maxChildCpuPct: number;
    maxChildRssKb: number;
  };

  type QaBrowserIssue = {
    type: 'console' | 'pageerror' | 'requestfailed' | 'http';
    severity: 'error' | 'warning';
    message: string;
    url: string | null;
    method: string | null;
    status: number | null;
    testId: string | null;
    timestamp: number;
  };

  type QaBrowserHealthSummary = QaSeveritySignal & {
    issueCount: number;
    errorCount: number;
    warningCount: number;
    networkFailureCount: number;
    httpErrorCount: number;
  };

  type QaRunTimingSummary = {
    avgShardMs: number | null;
    maxShardMs: number | null;
    bootstrapMs: number | null;
    apiHealthyMs: number | null;
    playwrightMs: number | null;
    phaseP95?: QaPhaseTimings | null;
  };

  type QaBenchmarkMetricDelta = {
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

  type QaBenchmarkComparison = QaSeveritySignal & {
    status: 'ok' | 'faster' | 'slower' | 'mixed' | 'insufficient';
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
  };

  type QaRegressionStatus = QaBenchmarkComparison['status'] | 'failed';
  type QaRegressionBaselineKind = 'previous' | 'same-code-hash' | 'same-git-head' | 'last-green-main';
  type QaRegressionMetricDelta = {
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
  type QaRegressionBaselineComparison = {
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
  type QaRegressionReport = QaSeveritySignal & {
    status: QaRegressionStatus;
    latestRunId: string | null;
    suiteKey: string | null;
    suiteLabel: string | null;
    comparisons: QaRegressionBaselineComparison[];
  };

  type QaCatalogEntry = {
    id: string;
    group: string;
    label: string;
    command: string;
    description: string;
  };

  type QaHistoryEntry = {
    runId: string;
    createdAt: number;
    completedAt: number | null;
    status: 'passed' | 'failed' | 'unknown';
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
    benchmarkStatus: QaBenchmarkComparison['status'] | null;
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
  };

  type QaRestartAuditEntry = QaSeveritySignal & {
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

  type RestartStatus = Partial<QaSeveritySignal> & {
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

  type QaRetentionPurgeResult = {
    retentionDays: number;
    cutoff: number;
    deletedRunIds: string[];
    deletedLogDirs: number;
    deletedHistoryRows: number;
  };

  type QaHistoryBackfillResult = {
    scannedRuns: number;
    recordedRuns: number;
    failedRuns: Array<{ runId: string; error: string }>;
  };

  type QaView = 'e2e' | 'scenarios' | 'gallery' | 'suites' | 'benchmarks' | 'history';
  type QaRunCategory = 'unit' | 'contract' | 'e2e' | 'scenario' | 'benchmark' | 'release' | 'unknown';
  type RunSortKey =
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
  type ShardSortKey =
    | 'index'
    | 'duration-fast'
    | 'duration-slow'
    | 'bootstrap-fast'
    | 'bootstrap-slow'
    | 'playwright-fast'
    | 'playwright-slow';
  type QaVerdictStatus = 'PASS' | 'DEGRADED' | 'FAIL' | 'UNKNOWN';
  type QaFailureSeverity = 'FAIL' | 'DEGRADED' | 'WARN';
  type QaFailureClass =
    | 'assertion'
    | 'infra'
    | 'timeout'
    | 'flake'
    | 'crash'
    | 'security'
    | 'performance'
    | 'browser'
    | 'network'
    | 'operations'
    | 'unknown';
  type QaFailureClassFilter = QaFailureClass | 'all';
  type QaFatalMarker = {
    shard: number;
    handle: string | null;
    title: string | null;
    target: string | null;
    failureClass: QaFailureClass;
    source: 'error' | 'logTail';
    line: string;
  };
  type QaFailureInboxItem = {
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
  type QaVerdictSummary = {
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
  type QaRunLedgerEntry = QaSeveritySignal & {
    runId: string;
    createdAt: number;
    completedAt: number | null;
    status: 'passed' | 'failed' | 'unknown';
    category: QaRunCategory;
    suiteKey: string;
    suiteLabel: string;
    gitHead: string | null;
    gitBranch: string | null;
    codeHash: string | null;
    dirty: boolean;
    startedBy: string;
    durationMs: number | null;
    totalMs?: number | null;
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
    benchmarkStatus: QaBenchmarkComparison['status'] | null;
    benchmarkDeltaPct: number | null;
    benchmarkComparedRunId: string | null;
    auditAction: string | null;
  };
  type QaSystemVerdict = QaSeveritySignal & {
    schemaVersion: 1;
    status: QaVerdictStatus;
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

  let runs = $state<QaSummary[]>([]);
  let catalog = $state<QaCatalogEntry[]>([]);
  let stories = $state<QaStoryScreenshot[]>([]);
  let uxReleasePack = $state<QaUxReleasePackAudit | null>(null);
  let uxGalleryGroupFilter = $state('all');
  let history = $state<QaHistoryEntry[]>([]);
  let ledger = $state<QaRunLedgerEntry[]>([]);
  let regression = $state<QaRegressionReport | null>(null);
  let restartAudit = $state<QaRestartAuditEntry[]>([]);
  let restart = $state<RestartStatus>({ active: false });
  let selectedRunId = $state('');
  let selectedRun = $state<QaRun | null>(null);
  let selectedShardIndex = $state(0);
  let loadingRuns = $state(true);
  let loadingMeta = $state(true);
  let loadingRun = $state(false);
  let error = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let restartPlan = $state<string[]>([]);
  let restartAllowed = $state(false);
  let activeView = $state<QaView>('gallery');
  let runSortKey = $state<RunSortKey>('date-desc');
  let shardSortKey = $state<ShardSortKey>('index');
  let selectedFailureClass = $state<QaFailureClassFilter>('all');
  let failureCueFocusKey = $state('');
  let failureCueFocusSeq = $state(0);
  let autoRefresh = $state(true);
  let qaTokenInput = $state('');
  let qaAuthLabel = $state('locked');
  let restartOperatorId = $state('');
  let restartReason = $state('');
  let restartConfirm = $state('');
  let restartExpectedGitHead = $state('');
  let restartCodeHash = $state('');
  let restartDirty = $state(false);
  let retentionConfirm = $state('');
  let retentionBusy = $state(false);
  let retentionResult = $state<QaRetentionPurgeResult | null>(null);
  let historyBackfillBusy = $state(false);
  let historyBackfillResult = $state<QaHistoryBackfillResult | null>(null);
  let systemVerdict = $state<QaSystemVerdict | null>(null);
  let showRawLogTail = $state(false);

  const phaseOrder: QaPhaseKey[] = ['preflight', 'anvilBoot', 'apiBoot', 'apiHealthy', 'viteBoot', 'playwright'];
  const phaseLabels: Record<QaPhaseKey, string> = {
    preflight: 'preflight',
    anvilBoot: 'anvil',
    apiBoot: 'api boot',
    apiHealthy: 'health',
    viteBoot: 'vite',
    playwright: 'playwright',
  };
  const phaseBudgets: Record<QaPhaseKey, number> = {
    preflight: 1_000,
    anvilBoot: 5_000,
    apiBoot: 5_000,
    apiHealthy: 5_000,
    viteBoot: 5_000,
    playwright: 5_000,
  };

  const selectedShard = $derived(
    selectedRun?.shards?.[selectedShardIndex] ?? null,
  );
  const selectedSummary = $derived(
    runs.find((run) => run.runId === selectedRunId) ?? null,
  );
  const selectedPhaseP95 = $derived.by(() => {
    const summary = selectedSummary;
    if (!summary?.suiteKey) return null;
    const previous = runs.filter((run) =>
      run.runId !== summary.runId &&
      run.suiteKey === summary.suiteKey &&
      run.createdAt < summary.createdAt &&
      run.timing?.phaseP95
    );
    if (previous.length === 0) return null;
    const values = Object.fromEntries(phaseOrder.map((key) => {
      const samples = previous
        .map((run) => run.timing?.phaseP95?.[key])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        .sort((a, b) => a - b);
      if (samples.length === 0) return [key, null];
      const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * 0.95) - 1));
      return [key, samples[index]];
    })) as Partial<Record<QaPhaseKey, number | null>>;
    return phaseOrder.every((key) => typeof values[key] === 'number') ? values as QaPhaseTimings : null;
  });
  const latestRun = $derived(runs[0] ?? null);
  const previousRun = $derived(runs[1] ?? null);
  const recentPassRate = $derived(
    runs.length === 0 ? 0 : Math.round((runs.filter((run) => run.status === 'passed').length / runs.length) * 100),
  );
  const durationDeltaMs = $derived(
    latestRun?.totalMs && previousRun?.totalMs ? latestRun.totalMs - previousRun.totalMs : null,
  );
  const latestTrend = $derived(runs.slice(0, 12));
  const hashChanged = $derived(Boolean(latestRun?.code?.codeHash && previousRun?.code?.codeHash && latestRun.code.codeHash !== previousRun.code.codeHash));
  const selectedHistoryPrevious = $derived.by(() => {
    const run = selectedRun;
    if (!run) return null;
    return history.find((row) => row.runId !== run.runId && row.createdAt < run.createdAt && Boolean(row.codeHash)) ?? null;
  });
  const selectedHashDelta = $derived(
    selectedRun?.code?.codeHash && selectedHistoryPrevious?.codeHash
      ? selectedRun.code.codeHash === selectedHistoryPrevious.codeHash
        ? 'same'
        : 'changed'
      : 'unknown',
  );
  const catalogGroups = $derived(Array.from(new Set(catalog.map(item => item.group))));
  const benchmarkCatalog = $derived(catalog.filter(item => item.group === 'Benchmark'));
  const qaCanPlanRestart = $derived(qaAuthLabel === 'admin' || qaAuthLabel === 'open');
  const restartReady = $derived(Boolean(
    restartAllowed &&
    !restart.active &&
    restartOperatorId.trim() &&
    restartReason.trim() &&
    restartConfirm.trim() === 'RUN' &&
    restartExpectedGitHead.trim(),
  ));
  const retentionReady = $derived(Boolean(qaCanPlanRestart && retentionConfirm.trim() === 'DELETE_OLDER_THAN_30_DAYS' && !retentionBusy));
  const historyBackfillReady = $derived(Boolean(qaCanPlanRestart && !historyBackfillBusy));
  const filteredRuns = $derived(runs.filter(run => runMatchesFailureClass(run, selectedFailureClass)));
  const sortedRuns = $derived([...filteredRuns].sort((a, b) => compareRunsForSort(a, b, runSortKey)));
  const sortedHistory = $derived([...history].sort((a, b) => compareRunsForSort(a, b, runSortKey)));
  const sortedLedger = $derived([...ledger].sort((a, b) => compareRunsForSort(a, b, runSortKey)));
  const sortedShardEntries = $derived((selectedRun?.shards ?? [])
    .map((shard, index) => ({ shard, index }))
    .sort((a, b) => compareShardsForSort(a, b, shardSortKey)));
  const failureInbox = $derived(buildFailureInbox(runs, restartAudit));
  const filteredFailureInbox = $derived(
    selectedFailureClass === 'all'
      ? failureInbox
      : failureInbox.filter(item => item.failureClass === selectedFailureClass),
  );
  const failureClassOptions = $derived(buildFailureClassOptions(runs, failureInbox));
  const verdict = $derived(buildVerdictSummary(systemVerdict, latestRun, failureInbox));
  const uxGalleryStories = $derived([
    ...stories.filter(story => story.curated),
    ...stories.filter(story => !story.curated),
  ]);
  const uxGalleryGroups = $derived(Array.from(new Set(uxGalleryStories.map(story => story.group))));
  const uxGalleryVisibleGroups = $derived(
    uxGalleryGroupFilter === 'all'
      ? uxGalleryGroups
      : uxGalleryGroups.filter(group => group === uxGalleryGroupFilter),
  );
  const uxGalleryCuratedCount = $derived(uxGalleryStories.filter(story => story.curated).length);
  const uxGalleryDesktopCount = $derived(uxGalleryStories.filter(story => story.platform === 'desktop').length);
  const uxGalleryMobileCount = $derived(uxGalleryStories.filter(story => story.platform === 'mobile').length);

  function applyQaAuth(payload: { qaAuth?: QaAuthInfo } | null | undefined): void {
    const auth = payload?.qaAuth;
    if (!auth) return;
    qaAuthLabel = auth.disabled ? 'open' : auth.scope ?? 'locked';
  }

  function formatDate(timestamp: number | null | undefined): string {
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

  function formatMs(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a';
    if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${ms}ms`;
  }

  function formatCount(run: QaSummary | QaRun | null): string {
    if (!run) return '0/0';
    return `${run.passedShards}/${run.totalShards}`;
  }

  function okSeverity(owner: string, reason: string, since = 0): QaSeveritySignal {
    return {
      severity: 'OK',
      reason,
      since,
      owner,
      evidence: [],
    };
  }

  function emptyBrowserHealth(): QaBrowserHealthSummary {
    return {
      ...okSeverity('browser', 'Browser event stream is clean'),
      issueCount: 0,
      errorCount: 0,
      warningCount: 0,
      networkFailureCount: 0,
      httpErrorCount: 0,
    };
  }

  function browserHealth(run: QaSummary | QaRun | null | undefined): QaBrowserHealthSummary {
    return run?.browserHealth ?? emptyBrowserHealth();
  }

  function browserHealthFromHistory(row: QaHistoryEntry): QaBrowserHealthSummary {
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

  function formatBrowserHealth(health: QaBrowserHealthSummary | null | undefined): string {
    const value = health ?? emptyBrowserHealth();
    if (value.issueCount <= 0) return 'clean';
    return `${value.errorCount} err / ${value.warningCount} warn`;
  }

  function browserIssueDetail(health: QaBrowserHealthSummary): string {
    return `${health.errorCount} browser errors, ${health.warningCount} warnings, ${health.networkFailureCount} network failures, ${health.httpErrorCount} HTTP responses`;
  }

  function shardBrowserHealth(shard: QaShard | null | undefined): QaBrowserHealthSummary {
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

  function browserIssueLabel(issue: QaBrowserIssue): string {
    const status = issue.status ? ` ${issue.status}` : '';
    return `${issue.type}${status}`;
  }

  function shortHash(value: string | null | undefined, len = 12): string {
    const raw = String(value || '').trim();
    return raw ? raw.slice(0, len) : 'n/a';
  }

  function statusLabel(entry: { status: 'passed' | 'failed' | 'unknown' }): string {
    if (entry.status === 'passed') return 'PASS';
    if (entry.status === 'failed') return 'FAIL';
    return 'UNKNOWN';
  }

  function benchmarkLabel(status: QaBenchmarkComparison['status'] | null | undefined): string {
    if (!status) return 'n/a';
    if (status === 'insufficient') return 'NEW';
    return status.toUpperCase();
  }

  function regressionLabel(status: QaRegressionStatus | null | undefined): string {
    if (!status) return 'n/a';
    if (status === 'failed') return 'FAIL';
    return benchmarkLabel(status);
  }

  function topRegressionMetric(comparison: QaRegressionBaselineComparison): QaRegressionMetricDelta | null {
    return comparison.metrics
      .filter(metric => metric.verdict !== 'ok' && metric.metric !== 'peakLoad1')
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))[0] ?? null;
  }

  function formatPct(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
  }

  function classifyFailureText(value: string): QaFailureClass {
    const lower = value.toLowerCase();
    if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('timeoutexceeded')) return 'timeout';
    if (lower.includes('page crashed') || lower.includes('sigsegv') || lower.includes('fatal runtime')) return 'crash';
    if (lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('token') || lower.includes('cors')) return 'security';
    if (lower.includes('flake') || lower.includes('retry')) return 'flake';
    if (lower.includes('boot') || lower.includes('health') || lower.includes('anvil') || lower.includes('vite') || lower.includes('econnrefused') || lower.includes('http 5')) return 'infra';
    if (lower.includes('expect') || lower.includes('assert') || lower.includes('expected:')) return 'assertion';
    return 'unknown';
  }

  function runMatchesFailureClass(run: QaSummary, failureClass: QaFailureClassFilter): boolean {
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

  function buildFailureClassOptions(runRows: QaSummary[], inbox: QaFailureInboxItem[]): QaFailureClass[] {
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

  function phaseObservedMs(run: QaSummary, key: QaPhaseKey): number | null {
    const p95 = run.timing?.phaseP95?.[key];
    if (typeof p95 === 'number' && Number.isFinite(p95)) return p95;
    if (key === 'apiHealthy') return finiteSortValue(run.timing?.apiHealthyMs, Number.NaN);
    if (key === 'playwright') return finiteSortValue(run.timing?.playwrightMs, Number.NaN);
    return null;
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

  function buildFailureInbox(runRows: QaSummary[], auditRows: QaRestartAuditEntry[]): QaFailureInboxItem[] {
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

  function verdictStatusFromSeverity(severity: QaSeverity): QaVerdictStatus {
    if (severity === 'OK') return 'PASS';
    if (severity === 'WARN' || severity === 'DEGRADED') return 'DEGRADED';
    if (severity === 'FAIL' || severity === 'BLOCKED') return 'FAIL';
    return 'UNKNOWN';
  }

  function emptyVerdict(activeCount: number): QaVerdictSummary {
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

  function buildVerdictSummary(
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

  async function openFailure(item: QaFailureInboxItem): Promise<void> {
    selectedFailureClass = item.failureClass;
    if (!item.runId) {
      activeView = 'history';
      return;
    }
    activeView = 'e2e';
    if (item.runId === selectedRunId && selectedRun) {
      selectedShardIndex = pickFailureShardIndex(selectedRun, item);
      showRawLogTail = false;
      rememberRunInUrl(selectedRun.runId, selectedRun.shards[selectedShardIndex]?.shard);
      focusFailureCue(item, selectedRun, selectedShardIndex);
      return;
    }
    await selectRun(item.runId);
    if (selectedRun) {
      selectedShardIndex = pickFailureShardIndex(selectedRun, item);
      showRawLogTail = false;
      rememberRunInUrl(selectedRun.runId, selectedRun.shards[selectedShardIndex]?.shard);
      focusFailureCue(item, selectedRun, selectedShardIndex);
    }
  }

  function finiteSortValue(value: number | null | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  function runTimingValue(run: QaSummary | QaHistoryEntry | QaRunLedgerEntry, key: RunSortKey): number {
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

  function compareRunsForSort(
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

  function shardBootstrapMs(shard: QaShard): number | null {
    const phase = shard.phaseMs;
    if (!phase) return null;
    return phase.preflight + phase.anvilBoot + phase.apiBoot + phase.apiHealthy + phase.viteBoot;
  }

  function phaseValue(phaseMs: QaPhaseTimings, key: QaPhaseKey): number {
    return Math.max(0, Math.floor(Number(phaseMs[key]) || 0));
  }

  function buildPhaseWaterfall(
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

  function shardPhaseWaterfall(shard: QaShard | null): QaPhaseWaterfall | null {
    if (!shard) return null;
    if (selectedPhaseP95) return buildPhaseWaterfall(shard.phaseMs, selectedPhaseP95);
    if (shard.phaseWaterfall) return shard.phaseWaterfall;
    return buildPhaseWaterfall(shard.phaseMs, selectedPhaseP95);
  }

  function phaseSegmentWidth(segment: QaPhaseWaterfallSegment): string {
    if (segment.ms <= 0) return '0%';
    return `${Math.max(3, segment.pct)}%`;
  }

  function phaseLimitLabel(segment: QaPhaseWaterfallSegment): string {
    const prefix = segment.limitKind === 'historical-p95' ? 'p95' : 'budget';
    return `${prefix} ${formatMs(segment.limitMs)}`;
  }

  const selectedShardWaterfall = $derived(shardPhaseWaterfall(selectedShard));

  function shardLogText(shard: QaShard | null): string {
    if (!shard) return '';
    return shard.logTail || shard.error || '';
  }

  function fatalMarkerLineFromText(value: string): string | null {
    for (const line of value.split('\n')) {
      const trimmed = line.trim();
      const lower = trimmed.toLowerCase();
      if (
        lower.includes('e2e_fatal_runtime_log') ||
        lower.includes('fatal runtime') ||
        lower.includes('segmentation fault') ||
        lower.includes('sigsegv')
      ) return trimmed;
    }
    return null;
  }

  function selectedShardFatalLine(): string | null {
    if (!selectedRun || !selectedShard) return null;
    const marker = (selectedRun.fatalMarkers ?? []).find((item) => item.shard === selectedShard.shard);
    return marker?.line ?? fatalMarkerLineFromText(shardLogText(selectedShard));
  }

  function selectedShardPrimaryError(): string | null {
    if (!selectedShard?.error) return null;
    return selectedShard.error.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
  }

  function shardSortValue(shard: QaShard, key: ShardSortKey): number {
    if (key.startsWith('bootstrap')) return finiteSortValue(shardBootstrapMs(shard), Number.POSITIVE_INFINITY);
    if (key.startsWith('playwright')) return finiteSortValue(shard.phaseMs?.playwright, Number.POSITIVE_INFINITY);
    return finiteSortValue(shard.durationMs, Number.POSITIVE_INFINITY);
  }

  function compareShardsForSort(
    a: { shard: QaShard; index: number },
    b: { shard: QaShard; index: number },
    key: ShardSortKey,
  ): number {
    if (key === 'index') return a.index - b.index;
    const descending = key.endsWith('slow');
    const av = shardSortValue(a.shard, key);
    const bv = shardSortValue(b.shard, key);
    return descending ? bv - av || a.index - b.index : av - bv || a.index - b.index;
  }

  function runArg(run: QaRun, key: string): unknown {
    return run.args && typeof run.args === 'object' ? run.args[key] : undefined;
  }

  function getRunLabel(run: QaSummary): string {
    const parts = run.runId.split('-');
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : run.runId;
  }

  function pickDefaultShard(run: QaRun, failureClass: QaFailureClassFilter = selectedFailureClass): number {
    const classIndex = failureClass === 'all'
      ? -1
      : run.shards.findIndex((shard) => shard.status === 'failed' && shard.failureClass === failureClass);
    if (classIndex >= 0) return classIndex;
    const failedIndex = run.shards.findIndex((shard) => shard.status === 'failed');
    return failedIndex >= 0 ? failedIndex : 0;
  }

  function pickFailureShardIndex(run: QaRun, item: QaFailureInboxItem): number {
    if (typeof item.shard === 'number' && Number.isSafeInteger(item.shard)) {
      const shardIndex = run.shards.findIndex((shard) => shard.shard === item.shard);
      if (shardIndex >= 0) return shardIndex;
    }
    if (item.phaseKey) {
      const limitMs = typeof item.phaseLimitMs === 'number' && Number.isFinite(item.phaseLimitMs)
        ? item.phaseLimitMs
        : phaseBudgets[item.phaseKey];
      const phaseIndex = run.shards.findIndex((shard) =>
        Boolean(shard.phaseMs && phaseValue(shard.phaseMs, item.phaseKey!) > limitMs)
      );
      if (phaseIndex >= 0) return phaseIndex;
    }
    return pickDefaultShard(run, item.failureClass);
  }

  function focusFailureCue(item: QaFailureInboxItem, run: QaRun, shardIndex: number): void {
    const shard = run.shards[shardIndex];
    if (!shard || shard.status !== 'failed') return;
    failureCueFocusSeq += 1;
    failureCueFocusKey = `${item.id}:${run.runId}:${shard.shard}:${failureCueFocusSeq}`;
  }

  function shardNumberFromUrl(): number | null {
    if (typeof window === 'undefined') return null;
    const raw = new URL(window.location.href).searchParams.get('shard')?.trim() || '';
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }

  function pickUrlShardIndex(run: QaRun): number | null {
    const shardNumber = shardNumberFromUrl();
    if (shardNumber === null) return null;
    const index = run.shards.findIndex((shard) => shard.shard === shardNumber);
    return index >= 0 ? index : null;
  }

  function rememberRunInUrl(runId: string, shardNumber: number | null | undefined = selectedShard?.shard): void {
    if (typeof window === 'undefined' || !runId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('runId', runId);
    if (typeof shardNumber === 'number' && Number.isSafeInteger(shardNumber)) {
      url.searchParams.set('shard', String(shardNumber));
    } else {
      url.searchParams.delete('shard');
    }
    window.history.replaceState(null, '', url);
  }

  function selectShard(index: number): void {
    if (!selectedRun || index < 0 || index >= selectedRun.shards.length) return;
    const shard = selectedRun.shards[index];
    if (!shard) return;
    selectedShardIndex = index;
    showRawLogTail = false;
    rememberRunInUrl(selectedRun.runId, shard.shard);
  }

  function setFailureClassFilter(failureClass: QaFailureClassFilter): void {
    selectedFailureClass = failureClass;
    if (selectedRun) {
      selectedShardIndex = pickDefaultShard(selectedRun, failureClass);
      showRawLogTail = false;
      rememberRunInUrl(selectedRun.runId, selectedRun.shards[selectedShardIndex]?.shard);
    }
  }

  function requestedRunIdFromUrl(): string {
    if (typeof window === 'undefined') return '';
    return new URL(window.location.href).searchParams.get('runId')?.trim() || '';
  }

  function readableText(raw: string | null | undefined): string {
    const value = String(raw || '').trim();
    if (!value) return '';
    const withoutPath = value
      .replace(/^.*\//, '')
      .replace(/\.spec\.ts(?::\d+)?/g, '')
      .replace(/^e2e[-_.]/i, '')
      .replace(/[-_.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!withoutPath) return '';
    return `${withoutPath.charAt(0).toUpperCase()}${withoutPath.slice(1)}`;
  }

  function testHandle(shard: QaShard): string {
    return shard.handle || readableText(shard.target) || `shard-${shard.shard}`;
  }

  function describeShard(shard: QaShard): string {
    return qaScenarioTitle(shard);
  }

  function shardDescription(shard: QaShard): string {
    return qaScenarioDescription(shard);
  }

  function shardPreviewImage(shard: QaShard): QaArtifact | null {
    return shard.artifacts.find((artifact) => artifact.kind === 'image' && artifact.url) ?? null;
  }

  function shardPreviewUrl(shard: QaShard): string {
    return shardPreviewImage(shard)?.url ?? '';
  }

  function shardPreviewText(shard: QaShard): string {
    return tenWordScenarioSummary(shardDescription(shard));
  }

  function artifactCount(shard: QaShard, kind: QaArtifact['kind']): number {
    return shard.artifacts.filter((artifact) => artifact.kind === kind).length;
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function artifactLabel(artifact: QaArtifact): string {
    if (artifact.kind === 'video') return 'Video';
    if (artifact.kind === 'image') return 'Screenshot';
    if (artifact.kind === 'trace') return 'Trace';
    if (artifact.kind === 'text') return 'Log';
    return artifact.kind;
  }

  function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
  }

  function isolatedTestLabel(count: number): string {
    return plural(count, 'isolated test', 'isolated tests');
  }

  async function loadRuns(preserveSelection = true): Promise<void> {
    loadingRuns = true;
    error = null;
    try {
      const response = await qaFetch('/api/qa/runs?limit=20', { cache: 'no-store' });
      const payload = await response.json() as {
        ok?: boolean;
        qaAuth?: QaAuthInfo;
        runs?: QaSummary[];
        ledger?: QaRunLedgerEntry[];
        regression?: QaRegressionReport;
        verdict?: QaSystemVerdict;
        error?: string;
      };
      applyQaAuth(payload);
      if (!response.ok || !payload.ok || !Array.isArray(payload.runs)) {
        throw new Error(payload.error || 'Failed to load QA runs');
      }
      runs = payload.runs;
      ledger = payload.ledger ?? [];
      regression = payload.regression ?? null;
      systemVerdict = payload.verdict ?? null;
      const requestedRunId = requestedRunIdFromUrl();
      const nextRunId = preserveSelection && selectedRunId && runs.some((run) => run.runId === selectedRunId)
        ? selectedRunId
        : requestedRunId && runs.some((run) => run.runId === requestedRunId)
          ? requestedRunId
        : runs[0]?.runId || '';
      if (nextRunId && nextRunId !== selectedRunId) {
        selectedRunId = nextRunId;
        await loadRun(nextRunId);
      } else if (!selectedRunId && nextRunId) {
        selectedRunId = nextRunId;
        await loadRun(nextRunId);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loadingRuns = false;
    }
  }

  async function loadRun(runId: string): Promise<void> {
    loadingRun = true;
    error = null;
    try {
      const response = await qaFetch(`/api/qa/run?runId=${encodeURIComponent(runId)}`, { cache: 'no-store' });
      const payload = await response.json() as { ok?: boolean; qaAuth?: QaAuthInfo; run?: QaRun; error?: string };
      applyQaAuth(payload);
      if (!response.ok || !payload.ok || !payload.run) {
        throw new Error(payload.error || 'Failed to load QA run');
      }
      selectedRun = payload.run;
      selectedShardIndex = pickUrlShardIndex(payload.run) ?? pickDefaultShard(payload.run);
      showRawLogTail = false;
      rememberRunInUrl(payload.run.runId, payload.run.shards[selectedShardIndex]?.shard);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loadingRun = false;
    }
  }

  async function loadMeta(): Promise<void> {
    loadingMeta = true;
    try {
      const [catalogResponse, historyResponse, auditResponse, storiesResponse] = await Promise.all([
        qaFetch('/api/qa/catalog', { cache: 'no-store' }),
        qaFetch('/api/qa/history?limit=120', { cache: 'no-store' }),
        qaFetch('/api/qa/restart-audit?limit=25', { cache: 'no-store' }),
        qaFetch('/api/qa/stories?limit=200', { cache: 'no-store' }),
      ]);
      const catalogPayload = await catalogResponse.json() as {
        ok?: boolean;
        qaAuth?: QaAuthInfo;
        catalog?: QaCatalogEntry[];
        restart?: RestartStatus;
        restartAllowed?: boolean;
        error?: string;
      };
      if (!catalogResponse.ok || !catalogPayload.ok || !Array.isArray(catalogPayload.catalog)) {
        throw new Error(catalogPayload.error || 'Failed to load QA catalog');
      }
      applyQaAuth(catalogPayload);
      const historyPayload = await historyResponse.json() as {
        ok?: boolean;
        qaAuth?: QaAuthInfo;
        history?: QaHistoryEntry[];
        restart?: RestartStatus;
        restartAllowed?: boolean;
        error?: string;
      };
      if (!historyResponse.ok || !historyPayload.ok || !Array.isArray(historyPayload.history)) {
        throw new Error(historyPayload.error || 'Failed to load QA history');
      }
      applyQaAuth(historyPayload);
      const auditPayload = await auditResponse.json() as {
        ok?: boolean;
        qaAuth?: QaAuthInfo;
        audit?: QaRestartAuditEntry[];
        error?: string;
      };
      if (!auditResponse.ok || !auditPayload.ok || !Array.isArray(auditPayload.audit)) {
        throw new Error(auditPayload.error || 'Failed to load QA restart audit');
      }
      applyQaAuth(auditPayload);
      const storiesPayload = await storiesResponse.json() as {
        ok?: boolean;
        qaAuth?: QaAuthInfo;
        stories?: QaStoryScreenshot[];
        releasePack?: QaUxReleasePackAudit;
        error?: string;
      };
      if (!storiesResponse.ok || !storiesPayload.ok || !Array.isArray(storiesPayload.stories)) {
        throw new Error(storiesPayload.error || 'Failed to load UX screenshots');
      }
      applyQaAuth(storiesPayload);
      catalog = catalogPayload.catalog;
      stories = storiesPayload.stories;
      uxReleasePack = storiesPayload.releasePack ?? null;
      history = historyPayload.history;
      restartAudit = auditPayload.audit;
      restart = historyPayload.restart ?? catalogPayload.restart ?? { active: false };
      restartAllowed = Boolean(catalogPayload.restartAllowed || historyPayload.restartAllowed);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      loadingMeta = false;
    }
  }

  async function selectRun(runId: string): Promise<void> {
    if (!runId || runId === selectedRunId) return;
    selectedRunId = runId;
    rememberRunInUrl(runId, null);
    await loadRun(runId);
  }

  async function planRestartSelectedShard(): Promise<void> {
    if (!selectedRun || !selectedShard) return;
    actionError = null;
    restartPlan = [];
    try {
      const response = await qaFetch('/api/qa/restart?mode=plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: selectedRun.runId, shard: selectedShard.shard }),
      });
      const payload = await response.json() as {
        ok?: boolean;
        command?: string[];
        expectedGitHead?: string | null;
        codeHash?: string;
        dirty?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok || !Array.isArray(payload.command)) {
        throw new Error(payload.error || 'Failed to plan QA restart');
      }
      restartPlan = payload.command;
      restartExpectedGitHead = payload.expectedGitHead ?? '';
      restartCodeHash = payload.codeHash ?? '';
      restartDirty = Boolean(payload.dirty);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    }
  }

  async function runRestartSelectedShard(): Promise<void> {
    if (!selectedRun || !selectedShard || !restartReady) return;
    actionError = null;
    restartPlan = [];
    try {
      const response = await qaFetch('/api/qa/restart?mode=run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: selectedRun.runId,
          shard: selectedShard.shard,
          operatorId: restartOperatorId.trim(),
          reason: restartReason.trim(),
          confirm: restartConfirm.trim(),
          expectedGitHead: restartExpectedGitHead.trim(),
        }),
      });
      const payload = await response.json() as { ok?: boolean; restart?: RestartStatus; error?: string };
      if (!response.ok || !payload.ok || !payload.restart) {
        throw new Error(payload.error || 'Failed to start QA restart');
      }
      restart = payload.restart;
      await loadMeta();
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    }
  }

  async function purgeOldQaRuns(): Promise<void> {
    if (!retentionReady) return;
    retentionBusy = true;
    actionError = null;
    retentionResult = null;
    try {
      const response = await qaFetch('/api/qa/retention', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: retentionConfirm.trim() }),
      });
      const payload = await response.json() as { ok?: boolean; result?: QaRetentionPurgeResult; error?: string };
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || 'Failed to purge old QA runs');
      }
      retentionResult = payload.result;
      retentionConfirm = '';
      await Promise.all([loadRuns(false), loadMeta()]);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      retentionBusy = false;
    }
  }

  async function backfillQaHistory(): Promise<void> {
    if (!historyBackfillReady) return;
    historyBackfillBusy = true;
    actionError = null;
    historyBackfillResult = null;
    try {
      const response = await qaFetch('/api/qa/history/backfill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'BACKFILL_QA_HISTORY', limit: 500 }),
      });
      const payload = await response.json() as { ok?: boolean; result?: QaHistoryBackfillResult; error?: string };
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || 'Failed to backfill QA history');
      }
      historyBackfillResult = payload.result;
      await Promise.all([loadRuns(false), loadMeta()]);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      historyBackfillBusy = false;
    }
  }

  async function openProtectedArtifact(url: string | null | undefined): Promise<void> {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl) return;
    actionError = null;
    try {
      const response = await qaFetch(cleanUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`QA artifact HTTP ${response.status}`);
      const blobUrl = URL.createObjectURL(await response.blob());
      window.open(blobUrl, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    }
  }

  function selectedLogArtifactUrl(): string {
    if (!selectedRun || !selectedShard?.logRelativePath) return '';
    return `/api/qa/artifact?runId=${encodeURIComponent(selectedRun.runId)}&path=${encodeURIComponent(selectedShard.logRelativePath)}`;
  }

  async function applyQaToken(): Promise<void> {
    writeQaToken(qaTokenInput);
    error = null;
    actionError = null;
    await Promise.all([loadRuns(false), loadMeta()]);
    if (selectedRunId) await loadRun(selectedRunId);
  }

  async function forgetQaToken(): Promise<void> {
    clearQaToken();
    qaTokenInput = '';
    qaAuthLabel = 'locked';
    await Promise.all([loadRuns(false), loadMeta()]);
  }

  onMount(() => {
    qaTokenInput = consumeQaTokenFromUrl();
    void loadRuns(false);
    void loadMeta();
    const timer = setInterval(() => {
      if (!autoRefresh) return;
      void loadRuns(true);
      if (selectedRunId) void loadRun(selectedRunId);
      void loadMeta();
    }, 15000);
    return () => clearInterval(timer);
  });
</script>

<svelte:head>
  <title>QA Cockpit</title>
</svelte:head>

<div class="qa-shell">
  <aside class="sidebar">
    <div class="sidebar-head">
      <div>
        <div class="eyebrow">XLN QA</div>
        <h1>Test Cockpit</h1>
      </div>
      <label class="refresh-toggle">
        <input bind:checked={autoRefresh} type="checkbox" />
        <span>Auto</span>
      </label>
    </div>

    <div class="metric-stack">
      <article class="metric-card">
        <span class="metric-label">Latest</span>
        <strong class:selectedPass={latestRun?.status === 'passed'} class:selectedFail={latestRun?.status === 'failed'}>
          {latestRun?.status ?? 'n/a'}
        </strong>
        <small>{latestRun ? formatMs(latestRun.totalMs) : 'n/a'}</small>
      </article>
      <article class="metric-card">
        <span class="metric-label">Pass Rate</span>
        <strong>{recentPassRate}%</strong>
        <small>{runs.length} recent runs</small>
      </article>
      <article class="metric-card">
        <span class="metric-label">Trend</span>
        <strong class:trendUp={typeof durationDeltaMs === 'number' && durationDeltaMs > 0} class:trendDown={typeof durationDeltaMs === 'number' && durationDeltaMs < 0}>
          {durationDeltaMs === null ? 'n/a' : `${durationDeltaMs > 0 ? '+' : ''}${formatMs(durationDeltaMs)}`}
        </strong>
        <small>vs previous wall time</small>
      </article>
    </div>

    <div class="trend-strip">
      {#each latestTrend as run}
        <button
          class="trend-pill"
          class:pass={run.status === 'passed'}
          class:fail={run.status === 'failed'}
          class:selected={run.runId === selectedRunId}
          onclick={() => selectRun(run.runId)}
        >
          {run.failedShards > 0 ? run.failedShards : run.passedShards}
        </button>
      {/each}
    </div>

    <label class="sort-control">
      <span>Sort runs</span>
      <select bind:value={runSortKey} data-testid="qa-run-sort">
        <option value="date-desc">Newest first</option>
        <option value="date-asc">Oldest first</option>
        <option value="stack-fast">Stack fastest</option>
        <option value="stack-slow">Stack slowest</option>
        <option value="bootstrap-fast">Bootstrap fastest</option>
        <option value="bootstrap-slow">Bootstrap slowest</option>
        <option value="playwright-fast">Browser fastest</option>
        <option value="playwright-slow">Browser slowest</option>
        <option value="test-fast">Test fastest</option>
        <option value="test-slow">Test slowest</option>
      </select>
    </label>

    {#if failureClassOptions.length > 0}
      <div class="failure-filter" data-testid="qa-failure-class-filter">
        <span>Failure class</span>
        <div class="filter-chips">
          <button
            type="button"
            class:active={selectedFailureClass === 'all'}
            onclick={() => setFailureClassFilter('all')}
          >
            all
          </button>
          {#each failureClassOptions as failureClass}
            <button
              type="button"
              class:active={selectedFailureClass === failureClass}
              onclick={() => setFailureClassFilter(failureClass)}
            >
              {failureClass}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="run-list">
      {#if loadingRuns && runs.length === 0}
        <div class="empty">Loading runs…</div>
      {:else if sortedRuns.length === 0}
        <div class="empty">No runs for {selectedFailureClass}</div>
      {:else}
        {#each sortedRuns as run}
          <button
            class="run-row"
            class:selected={run.runId === selectedRunId}
            data-testid="qa-run-row"
            data-run-id={run.runId}
            onclick={() => selectRun(run.runId)}
          >
            <div class="run-row-top">
              <span class="status-dot" class:pass={run.status === 'passed'} class:fail={run.status === 'failed'}></span>
              <strong>{getRunLabel(run)}</strong>
              <span class="run-duration">{formatMs(run.totalMs)}</span>
            </div>
            <div class="run-row-meta">
              <span>{formatCount(run)}</span>
              <span>{formatDate(run.createdAt)}</span>
            </div>
            <div class="run-row-timing">
              <span>stack {formatMs(run.totalMs)}</span>
              <span>boot {formatMs(run.timing?.bootstrapMs)}</span>
              <span>pw {formatMs(run.timing?.playwrightMs)}</span>
              <span>test {formatMs(run.timing?.avgShardMs)}</span>
              <span class:warn={browserHealth(run).errorCount > 0}>browser {formatBrowserHealth(browserHealth(run))}</span>
            </div>
            {#if (run.failureClasses ?? []).length > 0}
              <div class="artifact-chips failure-class-row" data-testid="qa-run-failure-classes">
                {#each run.failureClasses ?? [] as failureClass}
                  <span class="fail-chip">{failureClass}</span>
                {/each}
              </div>
            {/if}
            {#if run.failingTargets.length > 0}
              <div class="run-row-failures">{run.failingTargets.join(' · ')}</div>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </aside>

  <main class="content">
    <section class="auth-strip" class:open={qaAuthLabel === 'open'} data-testid="qa-auth-panel">
      <div>
        <span>QA access</span>
        <strong>{qaAuthLabel}</strong>
      </div>
      {#if qaAuthLabel !== 'open'}
        <label>
          <span>Bearer token</span>
          <input
            bind:value={qaTokenInput}
            type="password"
            autocomplete="off"
            placeholder="read/admin token"
          />
        </label>
        <button class="mini-action" onclick={applyQaToken}>Apply</button>
        <button class="mini-action ghost" onclick={forgetQaToken}>Clear</button>
      {/if}
    </section>

    <nav class="qa-tabs" data-testid="qa-test-tabs">
      <button class:active={activeView === 'gallery'} onclick={() => (activeView = 'gallery')}>UX Gallery</button>
      <button class:active={activeView === 'e2e'} onclick={() => (activeView = 'e2e')}>E2E Runs</button>
      <button class:active={activeView === 'scenarios'} onclick={() => (activeView = 'scenarios')}>Scenario Player</button>
      <button class:active={activeView === 'suites'} onclick={() => (activeView = 'suites')}>Suites</button>
      <button class:active={activeView === 'benchmarks'} onclick={() => (activeView = 'benchmarks')}>Benchmarks</button>
      <button class:active={activeView === 'history'} onclick={() => (activeView = 'history')}>History</button>
    </nav>

    <section
      class="verdict-banner"
      class:pass={verdict.status === 'PASS'}
      class:degraded={verdict.status === 'DEGRADED'}
      class:fail={verdict.status === 'FAIL'}
      data-testid="qa-verdict-banner"
    >
      <div>
        <div class="eyebrow">System Verdict</div>
        <h2>{verdict.status}</h2>
        <p>{verdict.reason}</p>
      </div>
      <div class="verdict-meta">
        <span>{verdict.activeCount} active reasons</span>
        <span>{verdict.failingSurfaceCount} failing surfaces</span>
        <span>benchmark {benchmarkLabel(verdict.regressionStatus)}</span>
        <span>browser {verdict.browserErrorCount} err / {verdict.browserWarningCount} warn</span>
        <code title={verdict.gitHead ?? ''}>head {shortHash(verdict.gitHead)}</code>
        <code title={verdict.codeHash ?? ''}>code {shortHash(verdict.codeHash)}</code>
        {#if verdict.dirty}<span>dirty</span>{/if}
        <span>{formatDate(verdict.latestAt)}</span>
      </div>
    </section>

    {#if uxGalleryStories.length > 0}
      <section class="ux-gallery-preview" data-testid="qa-ux-gallery-preview">
        <div class="suite-list-head">
          <div>
            <div class="eyebrow">UX Screenshot Gallery</div>
            <h3>{uxGalleryCuratedCount || uxGalleryStories.length} curated screens</h3>
          </div>
          <button class="mini-action" type="button" onclick={() => (activeView = 'gallery')}>Open gallery</button>
        </div>
        {#if uxReleasePack}
          <div class="artifact-chips release-pack" data-testid="qa-ux-release-pack">
            <span class:warn={uxReleasePack.status === 'missing'}>{uxReleasePack.status === 'ready' ? 'READY' : 'MISSING'}</span>
            <span>{uxReleasePack.curatedCount}/{uxReleasePack.minScreens} screens</span>
            <span>{uxReleasePack.desktopCount} desktop</span>
            <span>{uxReleasePack.mobileCount} mobile</span>
            <span>{uxReleasePack.presentGroups.length}/{uxReleasePack.requiredGroups.length} groups</span>
          </div>
          {#if uxReleasePack.missingReasons.length > 0}
            <div class="release-pack-warnings" data-testid="qa-ux-gallery-missing">
              {#each uxReleasePack.missingReasons.slice(0, 6) as reason}
                <span>{reason}</span>
              {/each}
            </div>
          {/if}
        {/if}
        <div class="ux-preview-strip">
          {#each uxGalleryStories.slice(0, 6) as story}
            <button type="button" class="ux-preview-card" onclick={() => (activeView = 'gallery')} title={story.description ?? story.title}>
              <QaProtectedImage url={story.url} alt={story.title} loading="lazy" />
              <span>{story.group}</span>
              <strong>{story.title}</strong>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if failureInbox.length > 0}
      <section class="failure-inbox" data-testid="qa-failure-inbox">
        <div class="suite-list-head">
          <div>
            <div class="eyebrow">Failure Inbox</div>
            <h3>{filteredFailureInbox.length} / {failureInbox.length} reasons</h3>
          </div>
          <span class="chip warn">latest first</span>
        </div>
        {#if failureClassOptions.length > 0}
          <div class="filter-chips inline" data-testid="qa-failure-inbox-filter">
            <button
              type="button"
              class:active={selectedFailureClass === 'all'}
              onclick={() => setFailureClassFilter('all')}
            >
              all
            </button>
            {#each failureClassOptions as failureClass}
              <button
                type="button"
                class:active={selectedFailureClass === failureClass}
                onclick={() => setFailureClassFilter(failureClass)}
              >
                {failureClass}
              </button>
            {/each}
          </div>
        {/if}
        <div class="failure-list">
          {#each filteredFailureInbox.slice(0, 6) as item}
            <button type="button" onclick={() => openFailure(item)} data-testid="qa-failure-item">
              <strong class:fail={item.severity === 'FAIL'}>{item.severity}</strong>
              <span>{item.failureClass}</span>
              <div>
                <b>{item.title}</b>
                <small>{item.detail}</small>
              </div>
              <time>{formatDate(item.createdAt)}</time>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if error}
      <div class="error-banner">{error}</div>
    {/if}
    {#if actionError}
      <div class="error-banner">{actionError}</div>
    {/if}

    {#if activeView === 'scenarios'}
      <section class="admin-card">
        <div class="suite-list-head">
          <div>
            <div class="eyebrow">Deterministic Scenarios</div>
            <h2>Scenario Player</h2>
            <p>Visual runtime scenarios with wallet preview and frame scrubbing.</p>
          </div>
          <a class="player-action-link" href="/scenarios" target="_blank" rel="noreferrer">Open full</a>
        </div>
        <iframe
          class="scenario-frame"
          title="Scenario Player"
          src="/scenarios"
          loading="lazy"
          allowfullscreen
          data-testid="qa-scenario-player-frame"
        ></iframe>
      </section>
    {:else if activeView === 'gallery'}
      <section class="admin-card" data-testid="qa-ux-gallery">
        <div class="suite-list-head">
          <div>
            <div class="eyebrow">Application Screens</div>
            <h2>UX Gallery</h2>
            <p>{uxGalleryStories.length} screenshots from e2e runs and curated fixtures.</p>
          </div>
          <div class="artifact-chips" data-testid="qa-ux-gallery-count">
            <span>{uxGalleryCuratedCount || uxGalleryStories.length} curated</span>
            <span>{uxGalleryDesktopCount} desktop</span>
            <span>{uxGalleryMobileCount} mobile</span>
            <span>{uxGalleryGroups.length} groups</span>
          </div>
        </div>
        {#if uxReleasePack}
          <div class="artifact-chips release-pack" data-testid="qa-ux-gallery-release-pack">
            <span class:warn={uxReleasePack.status === 'missing'}>{uxReleasePack.status === 'ready' ? 'release ready' : 'release incomplete'}</span>
            <span>{uxReleasePack.curatedCount}/{uxReleasePack.minScreens}</span>
            <span>{uxReleasePack.desktopCount} desktop</span>
            <span>{uxReleasePack.mobileCount} mobile</span>
          </div>
        {/if}
        {#if uxGalleryGroups.length > 1}
          <div class="filter-chips inline" data-testid="qa-ux-gallery-filter">
            <button
              type="button"
              class:active={uxGalleryGroupFilter === 'all'}
              onclick={() => (uxGalleryGroupFilter = 'all')}
            >
              all
            </button>
            {#each uxGalleryGroups as group}
              <button
                type="button"
                class:active={uxGalleryGroupFilter === group}
                onclick={() => (uxGalleryGroupFilter = group)}
              >
                {group}
              </button>
            {/each}
          </div>
        {/if}
        {#if loadingMeta && uxGalleryStories.length === 0}
          <div class="empty">Loading screenshots...</div>
        {:else if uxGalleryStories.length === 0}
          <div class="empty">No UX screenshots captured yet</div>
        {:else}
          {#each uxGalleryVisibleGroups as group}
            <div class="ux-gallery-group">
              <h3>{group}</h3>
              <div class="ux-gallery-grid">
                {#each uxGalleryStories.filter(story => story.group === group) as story}
                  <article class="ux-gallery-card" data-testid="qa-ux-gallery-card" data-platform={story.platform ?? 'unknown'}>
                    <div class="ux-shot">
                      <QaProtectedImage url={story.url} alt={story.title} loading="lazy" />
                    </div>
                    <div class="ux-shot-meta">
                      <div>
                        <strong>{story.title}</strong>
                        <p>{story.description ?? story.name}</p>
                      </div>
                      <div class="artifact-chips">
                        <span>{story.platform ?? 'screen'}</span>
                        <span>{story.curated ? 'curated' : story.source}</span>
                        {#if story.runId}<span>run {story.runId}</span>{/if}
                      </div>
                    </div>
                  </article>
                {/each}
              </div>
            </div>
          {/each}
        {/if}
      </section>
    {:else if activeView === 'suites'}
      <section class="admin-card" data-testid="qa-system-suites">
        <div class="suite-list-head">
          <div>
            <div class="eyebrow">System Test Catalog</div>
            <h2>All Test Surfaces</h2>
            <p>{catalog.length} commands grouped for operators.</p>
          </div>
          <div class="artifact-chips">
            {#if restart.active}
              <span class="chip warn">restart running</span>
              {#if restart.terminating}<span class="chip bad">{restart.terminalStatus ?? 'terminating'}</span>{/if}
              {#if restart.timeoutMs}<span>watchdog {formatMs(restart.timeoutMs)}</span>{/if}
            {:else if restart.cooldownRemainingMs}
              <span class="chip warn">restart cooldown {formatMs(restart.cooldownRemainingMs)}</span>
            {/if}
          </div>
        </div>
        {#if loadingMeta && catalog.length === 0}
          <div class="empty">Loading test catalog...</div>
        {:else}
          {#each catalogGroups as group}
            <div class="catalog-group">
              <h3>{group}</h3>
              <div class="catalog-grid">
                {#each catalog.filter(item => item.group === group) as item}
                  <article class="catalog-card">
                    <span>{item.group}</span>
                    <strong>{item.label}</strong>
                    <p>{item.description}</p>
                    <code>{item.command}</code>
                  </article>
                {/each}
              </div>
            </div>
          {/each}
        {/if}
      </section>
    {:else if activeView === 'benchmarks'}
      <section class="admin-card" data-testid="qa-benchmarks">
        <div class="suite-list-head">
          <div>
            <div class="eyebrow">Performance</div>
            <h2>Benchmarks + Run Load</h2>
            <p>Runner wall time, host load, child CPU, and memory by code hash.</p>
          </div>
          <span class="chip">{benchmarkCatalog.length} benchmark commands</span>
        </div>
        <div class="catalog-grid">
          {#each benchmarkCatalog as item}
            <article class="catalog-card benchmark">
              <span>{item.group}</span>
              <strong>{item.label}</strong>
              <p>{item.description}</p>
              <code>{item.command}</code>
            </article>
          {/each}
        </div>
        {#if regression}
          <section class="regression-panel" data-testid="qa-regression-comparator">
            <div class="suite-list-head compact-head">
              <div>
                <div class="eyebrow">Regression Comparator</div>
                <h3>
                  <span class:fail={regression.status === 'failed'} class:warn={regression.status === 'slower' || regression.status === 'mixed'}>
                    {regressionLabel(regression.status)}
                  </span>
                  {regression.suiteLabel ?? 'latest suite'}
                </h3>
                <p>{regression.reason}</p>
              </div>
              <span class="chip">{regression.comparisons.length} baselines</span>
            </div>
            <div class="regression-grid">
              {#each regression.comparisons as comparison}
                {@const topMetric = topRegressionMetric(comparison)}
                <article
                  class:bad={comparison.status === 'failed'}
                  class:warn={comparison.status === 'slower' || comparison.status === 'mixed'}
                  class:ok={comparison.status === 'ok' || comparison.status === 'faster'}
                  data-testid="qa-regression-row"
                  data-kind={comparison.kind}
                >
                  <strong>{regressionLabel(comparison.status)}</strong>
                  <span>{comparison.label}</span>
                  <code>{comparison.comparedRunId ?? 'missing'}</code>
                  <small>{comparison.reason}</small>
                  {#if topMetric}
                    <b>{topMetric.label} {formatPct(topMetric.deltaPct)}</b>
                  {/if}
                  {#if comparison.newFailingTargets.length > 0}
                    <b>new fail {comparison.newFailingTargets.join(', ')}</b>
                  {/if}
                  {#if comparison.likelyCauses.length > 0}
                    <em>{comparison.likelyCauses.slice(0, 2).join(' · ')}</em>
                  {/if}
                </article>
              {/each}
            </div>
          </section>
        {/if}
        <div class="history-table compact">
          {#each sortedHistory.slice(0, 12) as row}
            <article class:bad={row.status === 'failed'} class:ok={row.status === 'passed'}>
              <strong>{statusLabel(row)}</strong>
              <span>{formatMs(row.totalMs)}</span>
              <span>load {row.peakLoad1 ?? 'n/a'}</span>
              <span>cpu {row.maxChildCpuPct ?? 'n/a'}%</span>
              <span class:warn={row.browserErrorCount > 0}>browser {formatBrowserHealth(browserHealthFromHistory(row))}</span>
              <span class:warn={row.benchmarkStatus === 'slower' || row.benchmarkStatus === 'mixed'}>
                {benchmarkLabel(row.benchmarkStatus)} {formatPct(row.benchmarkDeltaPct)}
              </span>
              <code>{shortHash(row.codeHash)}</code>
            </article>
          {/each}
        </div>
      </section>
    {:else if activeView === 'history'}
      <section class="admin-card" data-testid="qa-history">
        <div class="suite-list-head">
          <div>
            <div class="eyebrow">Persistent History</div>
            <h2>QA Run Database</h2>
            <p>SQLite-backed run index with git HEAD, code hash, status, and perf.</p>
          </div>
          <div class="history-actions">
            <label class="sort-control inline">
              <span>Sort</span>
              <select bind:value={runSortKey} data-testid="qa-history-sort">
                <option value="date-desc">Newest</option>
                <option value="date-asc">Oldest</option>
                <option value="stack-fast">Stack fastest</option>
                <option value="stack-slow">Stack slowest</option>
                <option value="bootstrap-fast">Bootstrap fastest</option>
                <option value="bootstrap-slow">Bootstrap slowest</option>
                <option value="playwright-fast">Browser fastest</option>
                <option value="playwright-slow">Browser slowest</option>
                <option value="test-fast">Test fastest</option>
                <option value="test-slow">Test slowest</option>
              </select>
            </label>
            <span class="chip">{history.length} rows</span>
          </div>
        </div>
        <section class="run-ledger-panel" data-testid="qa-run-ledger">
          <div class="suite-list-head compact-head">
            <div>
              <div class="eyebrow">Canonical Ledger</div>
              <h3>Runs Across Test Surfaces</h3>
            </div>
            <span class="chip">{ledger.length} ledger rows</span>
          </div>
          {#if sortedLedger.length === 0}
            <div class="empty">No canonical ledger rows indexed yet</div>
          {:else}
            <div class="history-table ledger-table">
              {#each sortedLedger as row}
                <article
                  class:bad={row.status === 'failed'}
                  class:ok={row.status === 'passed'}
                  data-testid="qa-ledger-row"
                  data-run-id={row.runId}
                >
                  <strong>{statusLabel(row)}</strong>
                  <span>{row.category}</span>
                  <span title={row.suiteKey}>{row.suiteLabel}</span>
                  <span>by {row.startedBy}</span>
                  <span>{formatMs(row.durationMs)}</span>
                  <span class:warn={Boolean(row.failedShard)}>{row.failedShard ?? 'no failed shard'}</span>
                  <span>{formatBytes(row.artifactBytes)} artifacts</span>
                  <span>cpu p95 {row.cpuP95Pct ?? 'n/a'}%</span>
                  <span>cpu peak {row.cpuPeakPct ?? 'n/a'}%</span>
                  <span>ram {row.ramPeakKb ? formatBytes(row.ramPeakKb * 1024) : 'n/a'}</span>
                  <span class:warn={row.browserErrors > 0}>browser {row.browserErrors} err / {row.browserWarnings} warn</span>
                  <span class:warn={row.networkFailures > 0}>network {row.networkFailures}</span>
                  <span class:warn={row.benchmarkStatus === 'slower' || row.benchmarkStatus === 'mixed'}>
                    {benchmarkLabel(row.benchmarkStatus)} {formatPct(row.benchmarkDeltaPct)}
                  </span>
                  <code title={row.gitHead ?? ''}>head {shortHash(row.gitHead)}</code>
                  <code title={row.codeHash ?? ''}>code {shortHash(row.codeHash)}</code>
                  {#if row.auditAction}<em>{row.auditAction}</em>{/if}
                  {#if row.dirty}<em>dirty</em>{/if}
                </article>
              {/each}
            </div>
          {/if}
        </section>
        <div class="history-table">
          {#each sortedHistory as row}
            <article
              class:bad={row.status === 'failed'}
              class:ok={row.status === 'passed'}
              data-testid="qa-history-row"
              data-run-id={row.runId}
            >
              <strong>{statusLabel(row)}</strong>
              <span>{formatDate(row.createdAt)}</span>
              <span>{formatMs(row.totalMs)}</span>
              <span>{row.passedShards}/{row.totalShards}</span>
              <span class:warn={row.browserErrorCount > 0}>browser {formatBrowserHealth(browserHealthFromHistory(row))}</span>
              <span class:warn={row.benchmarkStatus === 'slower' || row.benchmarkStatus === 'mixed'}>
                {benchmarkLabel(row.benchmarkStatus)} {formatPct(row.benchmarkDeltaPct)}
              </span>
              <code title={row.gitHead ?? ''}>head {shortHash(row.gitHead)}</code>
              <code title={row.codeHash ?? ''}>code {shortHash(row.codeHash)}</code>
              {#if row.dirty}<em>dirty</em>{/if}
            </article>
          {/each}
        </div>
        <section class="retention-card" data-testid="qa-history-backfill-card">
          <div>
            <div class="eyebrow">Maintenance</div>
            <h3>Backfill History Index</h3>
            <p>One-shot manifest import for legacy runs.</p>
          </div>
          <button
            class="mini-action"
            disabled={!historyBackfillReady}
            title={qaCanPlanRestart ? 'Reads legacy manifests once and records SQLite rows' : 'Admin QA token required'}
            onclick={backfillQaHistory}
            data-testid="qa-history-backfill"
          >
            {historyBackfillBusy ? 'Backfilling...' : 'Backfill index'}
          </button>
          {#if historyBackfillResult}
            <small data-testid="qa-history-backfill-result">
              scanned {historyBackfillResult.scannedRuns} / recorded {historyBackfillResult.recordedRuns} / failed {historyBackfillResult.failedRuns.length}
            </small>
          {/if}
        </section>
        <section class="retention-card" data-testid="qa-retention-card">
          <div>
            <div class="eyebrow">Maintenance</div>
            <h3>Delete Runs Older Than 30 Days</h3>
            <p>Manual cleanup only. New runs and current audit history stay untouched.</p>
          </div>
          <label>
            <span>confirm phrase</span>
            <input bind:value={retentionConfirm} autocomplete="off" placeholder="DELETE_OLDER_THAN_30_DAYS" />
          </label>
          <button
            class="mini-action danger"
            disabled={!retentionReady}
            title={qaCanPlanRestart ? 'Deletes QA run logs and history rows older than 30 days' : 'Admin QA token required'}
            onclick={purgeOldQaRuns}
            data-testid="qa-retention-purge"
          >
            {retentionBusy ? 'Deleting...' : 'Delete old runs'}
          </button>
          {#if retentionResult}
            <small data-testid="qa-retention-result">
              deleted {retentionResult.deletedLogDirs} log dirs / {retentionResult.deletedHistoryRows} history rows
            </small>
          {/if}
        </section>
        <div class="suite-list-head restart-audit-head">
          <div>
            <div class="eyebrow">Operations Audit</div>
            <h3>Restart Trail</h3>
          </div>
          <span class="chip">{restartAudit.length} actions</span>
        </div>
        <div class="restart-audit-table">
          {#each restartAudit as row}
            <article
              class:bad={row.status === 'spawn_error' || row.status === 'watchdog_timeout' || row.status === 'aborted' || row.status === 'orphaned' || (row.exitCode !== null && row.exitCode !== 0)}
              class:ok={row.status === 'finished' && row.exitCode === 0}
            >
              <strong>{row.status}</strong>
              <span>{formatDate(row.startedAt)}</span>
              <span>{row.operatorId}</span>
              <span>{row.reason}</span>
              <code title={row.actualGitHead ?? ''}>head {shortHash(row.actualGitHead)}</code>
              <code title={row.codeHash ?? ''}>code {shortHash(row.codeHash)}</code>
              <span>{row.exitCode === null ? 'running' : `exit ${row.exitCode}`}</span>
            </article>
          {/each}
        </div>
      </section>
    {:else if selectedRun}
      <section class="run-summary">
        <div>
          <div class="eyebrow">Selected Run</div>
          <h2>{selectedRun.runId}</h2>
          <p>{formatDate(selectedRun.createdAt)}</p>
        </div>
        <div class="summary-grid">
          <article class="summary-card">
            <span>Status</span>
            <strong class:pass={selectedRun.status === 'passed'} class:fail={selectedRun.status === 'failed'}>
              {selectedRun.status}
            </strong>
          </article>
          <article class="summary-card">
            <span>Wall</span>
            <strong>{formatMs(selectedRun.totalMs)}</strong>
          </article>
          <article class="summary-card">
            <span>Shards</span>
            <strong>{formatCount(selectedRun)}</strong>
          </article>
          <article class="summary-card">
            <span>Parallel</span>
            <strong>{String(runArg(selectedRun, 'shards') ?? 'n/a')}</strong>
          </article>
          <article class="summary-card" class:bad={hashChanged}>
            <span>Code Hash</span>
            <strong>{shortHash(selectedRun.code?.codeHash)}</strong>
            <small>{selectedRun.code?.gitHead ? `head ${shortHash(selectedRun.code.gitHead)}` : 'legacy run'}</small>
          </article>
          <article class="summary-card">
            <span>Peak Load</span>
            <strong>{selectedRun.perf?.peakLoad1 ?? 'n/a'}</strong>
            <small>child cpu {selectedRun.perf?.maxChildCpuPct ?? 'n/a'}%</small>
          </article>
          <article class="summary-card" class:bad={browserHealth(selectedRun).errorCount > 0}>
            <span>Browser Health</span>
            <strong>{formatBrowserHealth(browserHealth(selectedRun))}</strong>
            <small>{browserIssueDetail(browserHealth(selectedRun))}</small>
          </article>
          <article class="summary-card" class:bad={selectedRun.benchmark?.status === 'slower' || selectedRun.benchmark?.status === 'mixed'}>
            <span>Benchmark</span>
            <strong>{benchmarkLabel(selectedRun.benchmark?.status)}</strong>
            <small>{selectedRun.benchmark?.reason ?? 'No baseline yet'}</small>
          </article>
        </div>
      </section>

      <section class="suite-list">
        <div class="suite-list-head">
          <div>
            <div class="eyebrow">E2E Suite</div>
            <h3>{isolatedTestLabel(selectedRun.totalShards)}</h3>
          </div>
          <div class="suite-list-meta">
            <label class="sort-control inline">
              <span>Sort tests</span>
              <select bind:value={shardSortKey} data-testid="qa-shard-sort">
                <option value="index">Recorded order</option>
                <option value="duration-fast">Test fastest</option>
                <option value="duration-slow">Test slowest</option>
                <option value="bootstrap-fast">Bootstrap fastest</option>
                <option value="bootstrap-slow">Bootstrap slowest</option>
                <option value="playwright-fast">Browser fastest</option>
                <option value="playwright-slow">Browser slowest</option>
              </select>
            </label>
            <span>{selectedRun.passedShards} passed</span>
            <span>{selectedRun.failedShards} failed</span>
          </div>
        </div>
        {#each sortedShardEntries as { shard, index }}
          <button
            class="suite-row"
            class:selected={index === selectedShardIndex}
            class:pass={shard.status === 'passed'}
            class:fail={shard.status === 'failed'}
            data-testid="qa-suite-row"
            data-has-video={shard.hasVideo}
            data-shard={shard.shard}
            onclick={() => selectShard(index)}
          >
            <div class="suite-preview" data-testid="scenario-preview-card">
              {#if shardPreviewUrl(shard)}
                <QaProtectedImage url={shardPreviewUrl(shard)} alt={describeShard(shard)} loading="lazy" />
              {:else}
                <span class="preview-play">Play</span>
              {/if}
              <i
                class="status-dot"
                class:pass={shard.status === 'passed'}
                class:fail={shard.status === 'failed'}
              ></i>
            </div>
            <div class="suite-row-main">
              <div class="suite-row-title">
                <strong>{describeShard(shard)}</strong>
                <code>{testHandle(shard)}</code>
              </div>
              <p>{shardPreviewText(shard)}</p>
              <div class="artifact-chips">
                <span class:muted={artifactCount(shard, 'video') === 0}>{plural(artifactCount(shard, 'video'), 'video', 'videos')}</span>
                <span class:muted={artifactCount(shard, 'image') === 0}>{plural(artifactCount(shard, 'image'), 'screenshot', 'screenshots')}</span>
                <span class:muted={artifactCount(shard, 'trace') === 0}>{plural(artifactCount(shard, 'trace'), 'trace', 'traces')}</span>
                <span class:warn={shardBrowserHealth(shard).errorCount > 0} class:muted={shardBrowserHealth(shard).issueCount === 0}>browser {formatBrowserHealth(shardBrowserHealth(shard))}</span>
                {#if shard.failureClass}
                  <span class="fail-chip">{shard.failureClass}</span>
                {/if}
                {#if shard.logRelativePath}
                  <span>Log</span>
                {/if}
              </div>
            </div>
            <div class="suite-row-side">
              <span>{shard.status}</span>
              <strong>{formatMs(shard.durationMs)}</strong>
              <small>#{shard.shard}</small>
            </div>
          </button>
        {/each}
      </section>

      {#if selectedShard}
        <section class="shard-detail">
          <div class="detail-head">
            <div>
              <div class="eyebrow">Shard {selectedShard.shard}</div>
              <h3>{describeShard(selectedShard)}</h3>
              <code class="detail-handle">{testHandle(selectedShard)}</code>
              <p>{shardDescription(selectedShard)}</p>
              <div class="artifact-chips detail-artifacts">
                <span class:muted={artifactCount(selectedShard, 'video') === 0}>{plural(artifactCount(selectedShard, 'video'), 'video', 'videos')}</span>
                <span class:muted={artifactCount(selectedShard, 'image') === 0}>{plural(artifactCount(selectedShard, 'image'), 'screenshot', 'screenshots')}</span>
                <span class:muted={artifactCount(selectedShard, 'trace') === 0}>{plural(artifactCount(selectedShard, 'trace'), 'trace', 'traces')}</span>
                <span class:warn={shardBrowserHealth(selectedShard).errorCount > 0} class:muted={shardBrowserHealth(selectedShard).issueCount === 0}>browser {formatBrowserHealth(shardBrowserHealth(selectedShard))}</span>
                {#if selectedShard.failureClass}
                  <span class="fail-chip">{selectedShard.failureClass}</span>
                {/if}
                {#if selectedShard.logRelativePath}
                  <span>log</span>
                {/if}
              </div>
              {#if selectedShard.target}
                <small>{selectedShard.target}</small>
              {/if}
            </div>
            <div class="detail-meta">
              <span>{selectedShard.status}</span>
              <span>{formatMs(selectedShard.durationMs)}</span>
              <button
                class="mini-action"
                disabled={!qaCanPlanRestart}
                title={qaCanPlanRestart ? 'Plan isolated rerun' : 'Admin QA token required'}
                onclick={planRestartSelectedShard}
              >Restart plan</button>
              <button
                class="mini-action"
                disabled={!restartReady}
                title={restartAllowed ? 'Requires operator, reason, confirm RUN, and expected HEAD' : 'Set XLN_QA_RESTART_ALLOWED=1 on the API process'}
                onclick={runRestartSelectedShard}
              >Restart run</button>
            </div>
          </div>

          {#if restartPlan.length > 0}
            <section class="restart-plan" data-testid="qa-restart-plan">
              <strong>Restart command</strong>
              <code>{restartPlan.join(' ')}</code>
              <small>
                Code hash {selectedHashDelta}
                {#if selectedHistoryPrevious?.codeHash}
                  vs previous {shortHash(selectedHistoryPrevious.codeHash)}
                {:else}
                  vs previous n/a
                {/if}
              </small>
              <div class="restart-confirm-grid" data-testid="qa-restart-confirm">
                <label>
                  <span>operator</span>
                  <input bind:value={restartOperatorId} autocomplete="off" placeholder="operator id" />
                </label>
                <label>
                  <span>reason</span>
                  <input bind:value={restartReason} autocomplete="off" placeholder="why this rerun is needed" />
                </label>
                <label>
                  <span>confirm</span>
                  <input bind:value={restartConfirm} autocomplete="off" placeholder="RUN" />
                </label>
                <label>
                  <span>expected HEAD</span>
                  <input bind:value={restartExpectedGitHead} autocomplete="off" />
                </label>
              </div>
              <small>
                Current code {shortHash(restartCodeHash)}
                {#if restartDirty} dirty{/if}
              </small>
            </section>
          {/if}

          <div class="detail-layout">
            <div class="media-panel">
              <QaScenarioPlayer
                runId={selectedRun.runId}
                shard={selectedShard}
                failureCueFocusKey={failureCueFocusKey}
              />
            </div>

            <div class="info-panel">
              <section class="panel-block">
                <h4>Phases</h4>
                {#if selectedShardWaterfall}
                  <div class="phase-waterfall" data-testid="qa-phase-waterfall">
                    <div class="phase-waterfall-head">
                      <strong>{formatMs(selectedShardWaterfall.totalMs)}</strong>
                      <span class:warn={selectedShardWaterfall.overLimitCount > 0}>
                        {selectedShardWaterfall.overLimitCount > 0 ? `${selectedShardWaterfall.overLimitCount} over budget` : 'within budget'}
                      </span>
                    </div>
                    <div class="phase-stack" aria-label="QA phase time waterfall">
                      {#each selectedShardWaterfall.segments as segment}
                        <div
                          class="phase-segment"
                          class:overLimit={segment.overLimit}
                          data-phase={segment.key}
                          style={`width: ${phaseSegmentWidth(segment)}`}
                          title={`${segment.label}: ${formatMs(segment.ms)} (${phaseLimitLabel(segment)})`}
                        ></div>
                      {/each}
                    </div>
                    <div class="phase-rows">
                      {#each selectedShardWaterfall.segments as segment}
                        <div
                          class="phase-row"
                          class:overLimit={segment.overLimit}
                          data-testid="qa-phase-row"
                          data-phase={segment.key}
                        >
                          <span>{segment.label}</span>
                          <strong>{formatMs(segment.ms)}</strong>
                          <small>{segment.pct.toFixed(1)}%</small>
                          <small>{phaseLimitLabel(segment)}</small>
                          {#if segment.overLimit}<em>over budget</em>{/if}
                        </div>
                      {/each}
                    </div>
                  </div>
                {:else}
                  <div class="empty">No phase timings</div>
                {/if}
              </section>

              <section class="panel-block" data-testid="qa-browser-health">
                <h4>Browser Health</h4>
                <dl class="phase-list">
                  <div><dt>errors</dt><dd>{shardBrowserHealth(selectedShard).errorCount}</dd></div>
                  <div><dt>warnings</dt><dd>{shardBrowserHealth(selectedShard).warningCount}</dd></div>
                  <div><dt>network</dt><dd>{shardBrowserHealth(selectedShard).networkFailureCount}</dd></div>
                  <div><dt>http</dt><dd>{shardBrowserHealth(selectedShard).httpErrorCount}</dd></div>
                </dl>
                {#if (selectedShard.browserIssues ?? []).length > 0}
                  <ul class="browser-issue-list">
                    {#each (selectedShard.browserIssues ?? []).slice(0, 8) as issue}
                      <li class:error={issue.severity === 'error'}>
                        <strong>{browserIssueLabel(issue)}</strong>
                        <span>{issue.message}</span>
                        {#if issue.url}<small>{issue.method ?? 'GET'} {issue.url}</small>{/if}
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <div class="empty">No browser issues captured</div>
                {/if}
              </section>

              <section class="panel-block">
                <h4>Slow Steps</h4>
                {#if selectedShard.slowSteps.length > 0}
                  <ul class="slow-step-list">
                    {#each selectedShard.slowSteps.slice(0, 10) as step}
                      <li><span>{step.label}</span><strong>{formatMs(step.ms)}</strong></li>
                    {/each}
                  </ul>
                {:else}
                  <div class="empty">No slow-step data</div>
                {/if}
              </section>

              <section class="panel-block">
                <h4>Artifacts</h4>
                {#if selectedShard.artifacts.length > 0}
                  <div class="artifact-list">
                    {#each selectedShard.artifacts as artifact}
                      <button type="button" onclick={() => openProtectedArtifact(artifact.url)}>
                        <span>{artifactLabel(artifact)}</span>
                        <strong>{artifact.name}</strong>
                        <small>{formatBytes(artifact.sizeBytes)}</small>
                        <small>{artifact.sensitivity}</small>
                      </button>
                    {/each}
                  </div>
                {:else}
                  <div class="empty">No artifact files captured</div>
                {/if}
              </section>
            </div>
          </div>

          <section class="log-panel">
            <div class="log-head">
              <h4>Evidence Summary</h4>
              {#if selectedShard.logRelativePath}
                <button
                  class="inline-link"
                  type="button"
                  onclick={() => openProtectedArtifact(selectedLogArtifactUrl())}
                >
                  Open full log
                </button>
              {/if}
            </div>
            <div class="log-summary" data-testid="qa-log-summary">
              <dl class="phase-list">
                <div><dt>status</dt><dd>{selectedShard.status}</dd></div>
                <div><dt>class</dt><dd>{selectedShard.failureClass ?? 'none'}</dd></div>
                <div><dt>browser</dt><dd>{formatBrowserHealth(shardBrowserHealth(selectedShard))}</dd></div>
                <div><dt>raw lines</dt><dd>{shardLogText(selectedShard) ? 'captured' : 'none'}</dd></div>
              </dl>
              {#if selectedShardFatalLine()}
                <div class="log-summary-line fatal">
                  <strong>fatal marker</strong>
                  <span>{selectedShardFatalLine()}</span>
                </div>
              {/if}
              {#if selectedShardPrimaryError()}
                <div class="log-summary-line">
                  <strong>primary error</strong>
                  <span>{selectedShardPrimaryError()}</span>
                </div>
              {/if}
            </div>
            <button
              class="raw-log-toggle"
              type="button"
              data-testid="qa-raw-log-toggle"
              onclick={() => showRawLogTail = !showRawLogTail}
            >
              {showRawLogTail ? 'Hide raw log tail' : 'Show raw log tail'}
            </button>
            {#if showRawLogTail}
              <pre data-testid="qa-raw-log">{shardLogText(selectedShard) || 'No log tail available.'}</pre>
            {/if}
          </section>
        </section>
      {/if}
    {:else if loadingRun || loadingRuns}
      <div class="empty-state">Loading QA cockpit…</div>
    {:else}
      <div class="empty-state">No runs found yet.</div>
    {/if}
  </main>
</div>

<style>
  :global(body) {
    background:
      radial-gradient(circle at top, rgba(196, 155, 71, 0.12), transparent 32%),
      #09090b;
  }

  .qa-shell {
    min-height: 100vh;
    width: 100%;
    overflow-x: hidden;
    display: grid;
    grid-template-columns: 340px minmax(0, 1fr);
    color: #f1efe7;
  }

  .sidebar {
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(10, 10, 14, 0.88);
    backdrop-filter: blur(18px);
    padding: 1.25rem;
    display: grid;
    gap: 1rem;
    align-content: start;
  }

  .sidebar-head,
  .run-row-top,
  .run-row-meta,
  .detail-head,
  .log-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .eyebrow {
    color: #d8af4f;
    font-size: 0.72rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  h4,
  p {
    margin: 0;
  }

  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.4rem; }
  h3 { font-size: 1.15rem; }
  h4 { font-size: 0.92rem; text-transform: uppercase; letter-spacing: 0.12em; color: #cfc6af; }

  .refresh-toggle,
  .metric-card,
  .run-row,
  .summary-card,
  .suite-row,
  .panel-block,
  .log-panel,
  .empty-state,
  .error-banner {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    border-radius: 10px;
  }

  .refresh-toggle {
    padding: 0.45rem 0.7rem;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    cursor: pointer;
  }

  .metric-stack,
  .summary-grid {
    display: grid;
    gap: 0.75rem;
  }

  .metric-stack {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .metric-card,
  .summary-card {
    padding: 0.9rem;
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }

  .metric-label {
    font-size: 0.72rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #8f8b80;
  }

  .trend-strip {
    display: flex;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .sort-control {
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }

  .sort-control.inline {
    grid-auto-flow: column;
    grid-template-columns: auto minmax(150px, 1fr);
    align-items: center;
  }

  .sort-control span {
    color: #9b978a;
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .sort-control select {
    min-height: 34px;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    padding: 0 0.65rem;
    color: #f1efe7;
    background: rgba(0, 0, 0, 0.22);
    font: inherit;
    font-size: 0.82rem;
  }

  .failure-filter {
    display: grid;
    gap: 0.45rem;
    min-width: 0;
  }

  .failure-filter > span {
    color: #9b978a;
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .filter-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    min-width: 0;
  }

  .filter-chips.inline {
    margin-bottom: 0.35rem;
  }

  .filter-chips button {
    min-height: 30px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 999px;
    padding: 0 0.65rem;
    color: #c8c2b6;
    background: rgba(255, 255, 255, 0.04);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }

  .filter-chips button.active {
    border-color: rgba(255, 146, 132, 0.38);
    color: #ffb1a6;
    background: rgba(255, 146, 132, 0.1);
    font-weight: 800;
  }

  .trend-pill {
    min-width: 2.1rem;
    height: 2rem;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
    cursor: pointer;
  }

  .trend-pill.pass,
  .status-dot.pass,
  strong.pass,
  strong.selectedPass {
    color: #84e0a1;
  }

  .trend-pill.fail,
  .status-dot.fail,
  strong.fail,
  strong.selectedFail {
    color: #ff9284;
  }

  .trend-pill.selected,
  .run-row.selected,
  .suite-row.selected {
    border-color: rgba(216, 175, 79, 0.56);
    box-shadow: 0 0 0 1px rgba(216, 175, 79, 0.26) inset;
  }

  .run-list {
    display: grid;
    gap: 0.7rem;
    align-content: start;
    max-height: calc(100vh - 18rem);
    overflow: auto;
    padding-right: 0.15rem;
  }

  .run-row,
  .suite-row {
    width: 100%;
    text-align: left;
    color: inherit;
    padding: 0.95rem;
    cursor: pointer;
  }

  .run-row-failures,
  .run-row-meta,
  .run-row-timing,
  .run-duration,
  .detail-meta,
  .suite-list-meta,
  .suite-row-title code,
  small,
  p {
    color: #9b978a;
  }

  .run-row-timing {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.3rem 0.5rem;
    margin-top: 0.45rem;
    font-size: 0.74rem;
  }

  .run-row-timing span {
    overflow-wrap: anywhere;
  }

  .status-dot {
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 999px;
    background: #888;
    flex: 0 0 auto;
  }

  .content {
    padding: 1.5rem;
    display: grid;
    gap: 1rem;
    align-content: start;
    min-width: 0;
  }

  .auth-strip {
    display: grid;
    grid-template-columns: minmax(140px, 0.3fr) minmax(240px, 1fr) auto auto;
    gap: 0.7rem;
    align-items: end;
    padding: 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
  }

  .auth-strip.open {
    grid-template-columns: max-content;
    justify-content: start;
  }

  .auth-strip div,
  .auth-strip label {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
  }

  .auth-strip span {
    color: #9b978a;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
  }

  .auth-strip strong {
    color: #f1efe7;
    font-size: 0.92rem;
  }

  .auth-strip input {
    min-height: 34px;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    padding: 0 0.75rem;
    color: #f1efe7;
    background: rgba(0, 0, 0, 0.22);
    font: inherit;
  }

  .qa-tabs {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    z-index: 5;
    padding: 0.35rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(10, 10, 14, 0.92);
    backdrop-filter: blur(12px);
  }

  .qa-tabs button,
  .mini-action,
  .player-action-link {
    min-height: 34px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 7px;
    padding: 0 0.75rem;
    color: #f1efe7;
    background: rgba(255, 255, 255, 0.04);
    font: inherit;
    font-size: 0.8rem;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
  }

  .qa-tabs button.active,
  .mini-action:hover,
  .player-action-link:hover {
    border-color: rgba(216, 175, 79, 0.58);
    background: rgba(216, 175, 79, 0.12);
    color: #fff4d8;
  }

  .mini-action:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .mini-action.ghost {
    color: #b7b1a4;
    background: transparent;
  }

  .ux-gallery-preview {
    display: grid;
    gap: 0.85rem;
    padding: 1rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.03);
  }

  .ux-preview-strip {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .ux-preview-card {
    display: grid;
    grid-template-rows: 96px auto auto;
    gap: 0.35rem;
    min-width: 0;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: inherit;
    background: rgba(0, 0, 0, 0.16);
    text-align: left;
    overflow: hidden;
    cursor: pointer;
  }

  .ux-preview-card :global(img) {
    width: 100%;
    height: 96px;
    object-fit: cover;
    object-position: top center;
    background: #101014;
  }

  .ux-preview-card span,
  .ux-preview-card strong {
    padding: 0 0.55rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ux-preview-card span {
    color: #9b978a;
    font-size: 0.7rem;
    font-weight: 800;
    text-transform: uppercase;
  }

  .ux-preview-card strong {
    padding-bottom: 0.55rem;
    font-size: 0.78rem;
  }

  .release-pack {
    margin-top: 0.75rem;
  }

  .release-pack-warnings {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin-top: 0.55rem;
  }

  .release-pack-warnings span {
    border: 1px solid rgba(248, 113, 113, 0.28);
    border-radius: 999px;
    padding: 0.32rem 0.55rem;
    background: rgba(248, 113, 113, 0.08);
    color: #fecaca;
    font-size: 0.72rem;
  }

  .ux-gallery-group {
    display: grid;
    gap: 0.75rem;
    margin-top: 1.25rem;
  }

  .ux-gallery-group h3 {
    margin: 0;
    color: #f1efe7;
    font-size: 0.95rem;
  }

  .ux-gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 0.9rem;
  }

  .ux-gallery-card {
    display: grid;
    grid-template-rows: 180px auto;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
    overflow: hidden;
  }

  .ux-shot {
    min-width: 0;
    background: #101014;
  }

  .ux-shot :global(img) {
    width: 100%;
    height: 180px;
    object-fit: cover;
    object-position: top center;
    display: block;
  }

  .ux-shot-meta {
    display: grid;
    gap: 0.65rem;
    padding: 0.8rem;
  }

  .ux-shot-meta strong,
  .ux-shot-meta p {
    margin: 0;
  }

  .ux-shot-meta p {
    min-height: 2.2em;
    font-size: 0.78rem;
    line-height: 1.35;
  }

  .run-summary,
  .shard-detail {
    display: grid;
    gap: 1rem;
  }

  .summary-grid {
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }

  .admin-card,
  .verdict-banner,
  .failure-inbox,
  .restart-plan {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
    padding: 1rem;
    display: grid;
    gap: 1rem;
  }

  .verdict-banner {
    position: sticky;
    top: 3.6rem;
    z-index: 4;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    border-left-width: 4px;
    backdrop-filter: blur(12px);
  }

  .verdict-banner.pass {
    border-left-color: #3fb950;
  }

  .verdict-banner.degraded {
    border-left-color: #d8af4f;
  }

  .verdict-banner.fail {
    border-left-color: #ff7b72;
  }

  .verdict-banner h2 {
    font-size: 1.8rem;
  }

  .verdict-meta {
    display: flex;
    justify-content: flex-end;
    gap: 0.55rem;
    flex-wrap: wrap;
    max-width: 520px;
    color: #b7b1a4;
    font-size: 0.8rem;
  }

  .verdict-meta span,
  .verdict-meta code {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 999px;
    padding: 0.28rem 0.5rem;
    background: rgba(0, 0, 0, 0.18);
  }

  .failure-list {
    display: grid;
    gap: 0.5rem;
  }

  .failure-list button {
    display: grid;
    grid-template-columns: 90px 110px minmax(0, 1fr) minmax(140px, auto);
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    min-height: 54px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 0.7rem;
    color: inherit;
    background: rgba(0, 0, 0, 0.16);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .failure-list button:hover {
    border-color: rgba(216, 175, 79, 0.45);
  }

  .failure-list b,
  .failure-list small {
    display: block;
    overflow-wrap: anywhere;
  }

  .failure-list strong.fail {
    color: #ff9284;
  }

  .scenario-frame {
    width: 100%;
    min-height: 720px;
    height: calc(100vh - 220px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: #050506;
  }

  .catalog-group {
    display: grid;
    gap: 0.75rem;
  }

  .catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 0.75rem;
  }

  .catalog-card {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 1rem;
    background: rgba(0, 0, 0, 0.18);
    display: grid;
    gap: 0.55rem;
  }

  .catalog-card.benchmark {
    border-color: rgba(112, 165, 255, 0.18);
  }

  .catalog-card span,
  .restart-plan strong {
    color: #d8af4f;
    font-size: 0.72rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .catalog-card code,
  .restart-plan code {
    white-space: pre-wrap;
    word-break: break-word;
    color: #b9d2ff;
    font-size: 0.78rem;
  }

  .restart-plan small {
    color: #b7b2a4;
  }

  .history-table,
  .restart-audit-table {
    display: grid;
    gap: 0.5rem;
  }

  .run-ledger-panel {
    display: grid;
    gap: 0.65rem;
    margin-bottom: 0.8rem;
  }

  .regression-panel {
    display: grid;
    gap: 0.75rem;
    margin: 0.8rem 0;
  }

  .regression-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 0.65rem;
  }

  .regression-grid article {
    display: grid;
    gap: 0.35rem;
    min-width: 0;
    border-left: 3px solid #6b7280;
    border-radius: 8px;
    padding: 0.75rem;
    background: rgba(0, 0, 0, 0.2);
  }

  .regression-grid article.ok {
    border-left-color: #3fb950;
  }

  .regression-grid article.warn {
    border-left-color: #d8af4f;
  }

  .regression-grid article.bad {
    border-left-color: #ff7b72;
  }

  .regression-grid code,
  .regression-grid em,
  .regression-grid small {
    color: #9b978a;
    font-style: normal;
    overflow-wrap: anywhere;
  }

  .restart-audit-head {
    margin-top: 0.65rem;
  }

  .history-table article,
  .restart-audit-table article {
    display: grid;
    align-items: center;
    gap: 0.75rem;
    border-left: 3px solid #6b7280;
    border-radius: 8px;
    padding: 0.75rem;
    background: rgba(0, 0, 0, 0.2);
  }

  .history-table article {
    grid-template-columns: 80px minmax(170px, 1fr) repeat(6, minmax(86px, auto));
  }

  .restart-audit-table article {
    grid-template-columns: 92px minmax(160px, 0.8fr) minmax(120px, 0.5fr) minmax(180px, 1fr) repeat(3, minmax(90px, auto));
  }

  .history-table.compact article {
    grid-template-columns: 80px repeat(6, minmax(76px, auto));
  }

  .history-table.ledger-table article {
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  }

  .history-table article.ok,
  .restart-audit-table article.ok {
    border-left-color: #3fb950;
  }

  .history-table article.bad,
  .restart-audit-table article.bad,
  .summary-card.bad {
    border-left-color: #ff7b72;
  }

  .history-table code,
  .history-table em,
  .restart-audit-table code {
    color: #9ec2ff;
    font-style: normal;
    overflow-wrap: anywhere;
  }

  .restart-audit-table span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .history-table .warn,
  .run-row-timing .warn,
  .artifact-chips span.warn {
    color: #f1d48a;
    font-weight: 800;
  }

  .restart-confirm-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(180px, 1fr));
    gap: 0.7rem;
  }

  .restart-confirm-grid label {
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }

  .restart-confirm-grid span {
    color: #9b978a;
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .restart-confirm-grid input {
    min-height: 34px;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    padding: 0 0.65rem;
    color: #f1efe7;
    background: rgba(0, 0, 0, 0.22);
    font: inherit;
  }

  .retention-card {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) minmax(260px, 0.8fr) auto;
    align-items: end;
    gap: 0.85rem;
    border: 1px solid rgba(255, 146, 132, 0.16);
    border-radius: 8px;
    padding: 0.9rem;
    background: rgba(255, 146, 132, 0.035);
  }

  .retention-card label {
    display: grid;
    gap: 0.35rem;
    min-width: 0;
  }

  .retention-card label span {
    color: #9b978a;
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .retention-card input {
    min-height: 34px;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    padding: 0 0.65rem;
    color: #f1efe7;
    background: rgba(0, 0, 0, 0.22);
    font: inherit;
  }

  .mini-action.danger {
    border-color: rgba(255, 146, 132, 0.35);
    color: #ffb1a6;
  }

  .retention-card small {
    color: #b7b2a4;
    grid-column: 1 / -1;
  }

  .chip.warn {
    border-color: rgba(216, 175, 79, 0.35);
    color: #f1d48a;
  }

  .suite-list {
    display: grid;
    gap: 0.75rem;
  }

  .suite-list-head,
  .suite-row,
  .suite-row-title,
  .suite-row-side,
  .artifact-chips,
  .phase-list div,
  .slow-step-list li,
  .artifact-list button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .suite-list-head {
    padding: 0.2rem 0.1rem 0.3rem;
  }

  .history-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .detail-head > div {
    display: grid;
    gap: 0.35rem;
    min-width: 0;
  }

  .suite-list-meta,
  .suite-row-title,
  .suite-row-side,
  .artifact-chips {
    display: flex;
    align-items: center;
    gap: 0.65rem;
  }

  .suite-row {
    display: grid;
    grid-template-columns: 112px minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.85rem;
  }

  .suite-preview {
    position: relative;
    overflow: hidden;
    width: 112px;
    aspect-ratio: 16 / 9;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: #08090a;
    display: grid;
    place-items: center;
  }

  .suite-preview :global(img) {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .suite-preview .status-dot {
    position: absolute;
    top: 7px;
    right: 7px;
    box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.54);
  }

  .preview-play {
    color: #d8af4f;
    font-size: 0.76rem;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .suite-row.pass {
    border-color: rgba(132, 224, 161, 0.14);
  }

  .suite-row.fail {
    border-color: rgba(255, 146, 132, 0.35);
  }

  .suite-row-main {
    display: grid;
    gap: 0.45rem;
    min-width: 0;
  }

  .suite-row-title {
    justify-content: flex-start;
    min-width: 0;
    flex-wrap: wrap;
  }

  .suite-row-title strong {
    color: #f6f2e8;
    overflow-wrap: anywhere;
  }

  .suite-row-title code,
  .detail-handle {
    color: #8f8b80;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 0.76rem;
    overflow-wrap: anywhere;
  }

  .suite-row-main p {
    font-size: 0.9rem;
    line-height: 1.45;
  }

  .suite-row-side {
    flex-direction: column;
    align-items: flex-end;
    color: #9b978a;
    font-size: 0.86rem;
  }

  .artifact-chips {
    flex-wrap: wrap;
    justify-content: flex-start;
  }

  .detail-artifacts {
    margin-top: 0.4rem;
  }

  .artifact-chips span {
    border: 1px solid rgba(112, 165, 255, 0.24);
    background: rgba(112, 165, 255, 0.08);
    border-radius: 999px;
    color: #b9d2ff;
    font-size: 0.74rem;
    line-height: 1;
    padding: 0.34rem 0.48rem;
  }

  .artifact-chips span.muted {
    border-color: rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.025);
    color: #6f6b61;
  }

  .artifact-chips span.fail-chip {
    border-color: rgba(255, 146, 132, 0.32);
    background: rgba(255, 146, 132, 0.08);
    color: #ffb1a6;
    font-weight: 800;
  }

  .failure-class-row {
    margin-top: 0.45rem;
  }

  .detail-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(320px, 0.44fr);
    gap: 1rem;
    align-items: start;
  }

  .media-panel,
  .info-panel {
    display: grid;
    gap: 1rem;
  }

  .empty-state {
    display: grid;
    place-items: center;
    color: #9b978a;
    padding: 2rem;
  }

  .panel-block,
  .log-panel {
    padding: 1rem;
    display: grid;
    gap: 0.85rem;
  }

  .phase-list,
  .browser-issue-list,
  .slow-step-list,
  .artifact-list {
    display: grid;
    gap: 0.65rem;
  }

  .phase-waterfall {
    display: grid;
    gap: 0.65rem;
  }

  .phase-waterfall-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .phase-waterfall-head span {
    color: #8f8b80;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .phase-waterfall-head span.warn {
    color: #f1d48a;
  }

  .phase-stack {
    display: flex;
    width: 100%;
    height: 0.72rem;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .phase-segment {
    min-width: 0;
    background: #6d8dff;
    border-right: 1px solid rgba(7, 8, 10, 0.7);
  }

  .phase-segment[data-phase="preflight"] {
    background: #7ec8a3;
  }

  .phase-segment[data-phase="anvilBoot"] {
    background: #f1c15f;
  }

  .phase-segment[data-phase="apiBoot"] {
    background: #70b8e8;
  }

  .phase-segment[data-phase="apiHealthy"] {
    background: #9ec46b;
  }

  .phase-segment[data-phase="viteBoot"] {
    background: #c29af2;
  }

  .phase-segment[data-phase="playwright"] {
    background: #8da1ff;
  }

  .phase-segment.overLimit {
    background: #ff8a70;
  }

  .phase-rows {
    display: grid;
    gap: 0.45rem;
  }

  .phase-row {
    display: grid;
    grid-template-columns: minmax(5.5rem, 1fr) max-content max-content max-content;
    align-items: center;
    gap: 0.65rem;
    min-height: 1.65rem;
    padding-bottom: 0.45rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .phase-row span {
    color: #d8d1c1;
    min-width: 0;
  }

  .phase-row strong {
    font-variant-numeric: tabular-nums;
  }

  .phase-row small {
    color: #8f8b80;
    white-space: nowrap;
  }

  .phase-row em {
    grid-column: 1 / -1;
    color: #ffad9b;
    font-style: normal;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .phase-list div,
  .browser-issue-list li,
  .slow-step-list li,
  .artifact-list button {
    padding-bottom: 0.55rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .phase-list dt,
  .artifact-list span {
    color: #8f8b80;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.72rem;
  }

  .phase-list dd,
  .slow-step-list strong {
    margin: 0;
  }

  .browser-issue-list li {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
  }

  .browser-issue-list strong {
    color: #f1d48a;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.72rem;
  }

  .browser-issue-list li.error strong {
    color: #ff9284;
  }

  .browser-issue-list span,
  .browser-issue-list small {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .browser-issue-list small {
    color: #8f8b80;
    font-size: 0.76rem;
  }

  .artifact-list button {
    color: inherit;
    display: grid;
    grid-template-columns: 90px minmax(0, 1fr) auto;
    align-items: center;
    width: 100%;
    border-top: 0;
    border-right: 0;
    border-left: 0;
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .artifact-list strong {
    overflow-wrap: anywhere;
  }

  .inline-link {
    border: 0;
    padding: 0;
    color: #d8af4f;
    background: transparent;
    font: inherit;
    cursor: pointer;
  }

  .log-panel pre {
    margin: 0;
    max-height: 420px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.85rem;
    line-height: 1.55;
    color: #d8d4c8;
  }

  .log-summary {
    display: grid;
    gap: 0.7rem;
  }

  .log-summary-line {
    display: grid;
    gap: 0.25rem;
    padding: 0.7rem 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.035);
  }

  .log-summary-line strong {
    color: #8f8b80;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.72rem;
  }

  .log-summary-line span {
    color: #d8d4c8;
    line-height: 1.45;
    word-break: break-word;
  }

  .log-summary-line.fatal {
    border-color: rgba(255, 146, 132, 0.26);
    background: rgba(255, 91, 76, 0.07);
  }

  .raw-log-toggle {
    justify-self: start;
    min-height: 34px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    padding: 0 0.75rem;
    color: #f1efe7;
    background: rgba(255, 255, 255, 0.04);
    font: inherit;
    cursor: pointer;
  }

  .error-banner {
    padding: 0.9rem 1rem;
    color: #ffb2a7;
    border-color: rgba(255, 108, 84, 0.24);
  }

  .trendUp { color: #ffb2a7; }
  .trendDown { color: #84e0a1; }

  @media (max-width: 1100px) {
    .qa-shell {
      grid-template-columns: 1fr;
    }

    .sidebar {
      border-right: 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .detail-layout,
    .auth-strip,
    .verdict-banner,
    .restart-confirm-grid,
    .summary-grid,
    .metric-stack {
      grid-template-columns: 1fr;
    }

    .verdict-banner {
      position: static;
    }

    .verdict-meta {
      justify-content: flex-start;
      max-width: none;
    }

    .history-table article,
    .history-table.compact article,
    .failure-list button,
    .retention-card,
    .restart-audit-table article {
      grid-template-columns: 1fr;
      align-items: start;
    }

    .suite-row {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .suite-row-side {
      grid-column: 2;
      align-items: flex-start;
      flex-direction: row;
    }

    .ux-preview-strip,
    .ux-gallery-grid {
      grid-template-columns: 1fr;
    }

    .ux-preview-card {
      grid-template-rows: 150px auto auto;
    }

    .ux-preview-card :global(img),
    .ux-shot :global(img) {
      height: 150px;
    }

    .ux-gallery-card {
      grid-template-rows: 150px auto;
    }
  }
</style>
