<script lang="ts">
  import './qa.css';
  import { onMount } from 'svelte';
  import QaAdminEvidenceBoard from '$lib/components/QA/QaAdminEvidenceBoard.svelte';
  import QaProtectedImage from '$lib/components/QA/QaProtectedImage.svelte';
  import QaPerformanceTrend from '$lib/components/QA/QaPerformanceTrend.svelte';
  import QaScenarioPlayer from '$lib/components/QA/QaScenarioPlayer.svelte';
  import QaTestLedgerTable from '$lib/components/QA/QaTestLedgerTable.svelte';
  import {
    qaScenarioDescription,
    qaScenarioSummary,
    qaScenarioTitle,
  } from '$lib/qa/scenarioPlayer';
  import { clearQaToken, consumeQaTokenFromUrl, qaFetch, writeQaToken } from '$lib/qa/apiClient';
  import {
    benchmarkLabel,
    browserHealth,
    browserHealthFromHistory,
    browserIssueDetail,
    browserIssueLabel,
    buildFailureClassOptions,
    buildFailureInbox,
    buildPhaseWaterfall,
    buildVerdictSummary,
    compareRunsForSort,
    finiteSortValue,
    formatBrowserHealth,
    formatCount,
    formatDate,
    formatMs,
    formatPct,
    phaseBudgets,
    phaseValue,
    phaseLimitLabel,
    phaseOrder,
    phaseSegmentWidth,
    regressionLabel,
    runMatchesFailureClass,
    shardBootstrapMs,
    shardBrowserHealth,
    shortHash,
    statusLabel,
    topRegressionMetric,
  } from '$lib/qa/cockpit-helpers';
  import {
    buildAdminStoryCards,
    normalizeQaAdminHealth,
    type QaAdminHealthSnapshot,
  } from '$lib/qa/adminEvidence';
  import { QA } from '@xln/runtime/config/constants';
  import { readJsonUnknown } from '$lib/utils/boundary';
  import {
    decodeQaAuthInfo,
    decodeQaEnvelope,
    isQaCatalogEntry,
    isQaHistoryBackfillResult,
    isQaHistoryEntry,
    isQaRegressionReport,
    isQaRestartAuditEntry,
    isQaRetentionPurgeResult,
    isQaRun,
    isQaRunLedgerEntry,
    isQaStoryScreenshot,
    isQaSummary,
    isQaSystemVerdict,
    isQaTestLedgerEntry,
    isQaUxReleasePackAudit,
    isRestartStatus,
  } from '$lib/qa/boundary';
  import type {
    QaArtifact,
    QaAuthInfo,
    QaCatalogEntry,
    QaFailureClassFilter,
    QaFailureInboxItem,
    QaHistoryBackfillResult,
    QaHistoryEntry,
    QaPhaseKey,
    QaPhaseTimings,
    QaRegressionReport,
    QaRestartAuditEntry,
    QaRetentionPurgeResult,
    QaRun,
    QaRunLedgerEntry,
    QaShard,
    QaStoryScreenshot,
    QaSummary,
    QaSystemVerdict,
    QaTestLedgerEntry,
    QaUxReleasePackAudit,
    QaVerdictSummary,
    QaView,
    RestartStatus,
    RunSortKey,
    ShardSortKey,
  } from '$lib/qa/types';

  const requireDecodedArray = <T>(value: unknown, code: string, guard: (entry: unknown) => entry is T): T[] => {
    if (!Array.isArray(value) || !value.every(guard)) throw new Error(code);
    return value;
  };

  const optionalDecoded = <T>(value: unknown, code: string, guard: (entry: unknown) => entry is T): T | undefined => {
    if (value === undefined) return undefined;
    if (!guard(value)) throw new Error(code);
    return value;
  };

  let runs = $state<QaSummary[]>([]);
  let catalog = $state<QaCatalogEntry[]>([]);
  let stories = $state<QaStoryScreenshot[]>([]);
  let uxReleasePack = $state<QaUxReleasePackAudit | null>(null);
  let uxGalleryGroupFilter = $state('all');
  let history = $state<QaHistoryEntry[]>([]);
  let ledger = $state<QaRunLedgerEntry[]>([]);
  let testLedger = $state<QaTestLedgerEntry[]>([]);
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
  let historyBackfillConfirm = $state('');
  let historyBackfillBusy = $state(false);
  let historyBackfillResult = $state<QaHistoryBackfillResult | null>(null);
  let restartAbortConfirm = $state('');
  let restartAbortBusy = $state(false);
  let selectedLedgerCategory = $state('all');
  let runWindowSize = $state(QA.RUN_WINDOW_STEP);
  let shardWindowSize = $state(QA.SHARD_WINDOW_STEP);
  let historyWindowSize = $state(QA.HISTORY_WINDOW_STEP);
  let ledgerWindowSize = $state(QA.LEDGER_WINDOW_STEP);
  let artifactWindowSize = $state(QA.ARTIFACT_WINDOW_STEP);
  let systemVerdict = $state<QaSystemVerdict | null>(null);
  let showRawLogTail = $state(false);
  let adminHealth = $state<QaAdminHealthSnapshot | null>(null);
  let adminHealthError = $state<string | null>(null);
  let loadingAdminHealth = $state(false);
  let uxSlideshowIndex = $state<number | null>(null);

  type VerdictExplanation = {
    label: string;
    value: string;
    detail: string;
    tone?: 'bad' | 'warn' | 'ok';
  };

  const RUN_WINDOW_STEP = QA.RUN_WINDOW_STEP;
  const SHARD_WINDOW_STEP = QA.SHARD_WINDOW_STEP;
  const HISTORY_WINDOW_STEP = QA.HISTORY_WINDOW_STEP;
  const LEDGER_WINDOW_STEP = QA.LEDGER_WINDOW_STEP;
  const ARTIFACT_WINDOW_STEP = QA.ARTIFACT_WINDOW_STEP;

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
  const latestTrend = $derived(runs.slice(0, QA.RECENT_TREND_LIMIT));
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
    restartConfirm.trim() === QA.RESTART_CONFIRM &&
    restartExpectedGitHead.trim(),
  ));
  const retentionReady = $derived(Boolean(qaCanPlanRestart && retentionConfirm.trim() === QA.RETENTION_CONFIRM && !retentionBusy));
  const historyBackfillReady = $derived(Boolean(qaCanPlanRestart && historyBackfillConfirm.trim() === QA.HISTORY_BACKFILL_CONFIRM && !historyBackfillBusy));
  const restartAbortReady = $derived(Boolean(
    qaCanPlanRestart &&
    restartAllowed &&
    restart.active &&
    restartAbortConfirm.trim() === QA.RESTART_ABORT_CONFIRM &&
    !restartAbortBusy,
  ));
  const filteredRuns = $derived(runs.filter(run => runMatchesFailureClass(run, selectedFailureClass)));
  const sortedRuns = $derived([...filteredRuns].sort((a, b) => compareRunsForSort(a, b, runSortKey)));
  const sortedHistory = $derived([...history].sort((a, b) => compareRunsForSort(a, b, runSortKey)));
  const ledgerCategoryOptions = $derived(Array.from(new Set(ledger.map(row => row.category))).sort());
  const filteredLedger = $derived(
    selectedLedgerCategory === 'all'
      ? ledger
      : ledger.filter(row => row.category === selectedLedgerCategory),
  );
  const sortedLedger = $derived([...filteredLedger].sort((a, b) => compareRunsForSort(a, b, runSortKey)));
  const sortedShardEntries = $derived((selectedRun?.shards ?? [])
    .map((shard, index) => ({ shard, index }))
    .sort((a, b) => compareShardsForSort(a, b, shardSortKey)));
  const visibleRuns = $derived(sortedRuns.slice(0, runWindowSize));
  const visibleHistory = $derived(sortedHistory.slice(0, historyWindowSize));
  const visibleLedger = $derived(sortedLedger.slice(0, ledgerWindowSize));
  const visibleShardEntries = $derived(sortedShardEntries.slice(0, shardWindowSize));
  const selectedShardEvidenceArtifacts = $derived(selectedShard ? shardEvidenceArtifacts(selectedShard) : []);
  const visibleSelectedShardEvidenceArtifacts = $derived(selectedShardEvidenceArtifacts.slice(0, artifactWindowSize));
  const failureInbox = $derived(buildFailureInbox(runs, restartAudit));
  const filteredFailureInbox = $derived(
    selectedFailureClass === 'all'
      ? failureInbox
      : failureInbox.filter(item => item.failureClass === selectedFailureClass),
  );
  const failureClassOptions = $derived(buildFailureClassOptions(runs, failureInbox));
  const verdict = $derived(buildVerdictSummary(systemVerdict, latestRun, failureInbox));
  const verdictExplanations = $derived(buildVerdictExplanations(verdict, latestRun, failureInbox));
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
  const adminStoryCards = $derived(buildAdminStoryCards(selectedRun, uxGalleryStories));
  const uxSlideshowStory = $derived(
    uxSlideshowIndex === null ? null : uxGalleryStories[uxSlideshowIndex] ?? null,
  );

  function trendPillLabel(run: QaSummary): string {
    const total = Math.max(0, Number(run.totalShards || 0));
    if (run.failedShards > 0) return `${run.failedShards}F/${total}`;
    return formatCount(run);
  }

  function trendPillTitle(run: QaSummary): string {
    const browser = browserHealth(run);
    return [
      `${statusLabel(run)} ${formatCount(run)} stacks`,
      `${formatMs(run.totalMs)} wall`,
      `browser ${formatBrowserHealth(browser)}`,
      formatDate(run.createdAt),
    ].join(' · ');
  }

  function buildVerdictExplanations(
    summary: QaVerdictSummary,
    run: QaSummary | null,
    inbox: QaFailureInboxItem[],
  ): VerdictExplanation[] {
    const activeDetails = inbox
      .filter(item => !summary.latestRunId || item.runId === summary.latestRunId || item.failureClass === 'operations')
      .slice(0, 3)
      .map(item => `${item.failureClass}: ${item.title}`);
    return [
      {
        label: 'Root cause',
        value: summary.status,
        detail: activeDetails[0] || summary.reason || 'No blocking QA signal is active.',
        tone: summary.status === 'FAIL' ? 'bad' : summary.status === 'PASS' ? 'ok' : 'warn',
      },
      {
        label: 'Active reasons',
        value: String(summary.activeCount),
        detail: activeDetails.length > 0 ? activeDetails.join(' | ') : 'No blocking QA signal is active.',
        tone: summary.activeCount > 0 ? 'bad' : 'ok',
      },
      {
        label: 'Failing surfaces',
        value: String(summary.failingSurfaceCount),
        detail: 'Distinct areas: run status, browser health, benchmark regression, restart audit, or runtime marker.',
        tone: summary.failingSurfaceCount > 0 ? 'bad' : 'ok',
      },
      {
        label: 'Browser capture',
        value: `${summary.browserErrorCount} err / ${summary.browserWarningCount} warn`,
        detail: 'Console errors, page errors, failed requests, and HTTP failures captured during e2e.',
        tone: summary.browserErrorCount > 0 ? 'bad' : summary.browserWarningCount > 0 ? 'warn' : 'ok',
      },
      {
        label: 'Benchmark',
        value: benchmarkLabel(summary.regressionStatus),
        detail: run?.benchmark?.reason || 'Compared with historical runs for the same test stack.',
        tone: summary.regressionStatus === 'slower' || summary.regressionStatus === 'mixed' ? 'warn' : 'ok',
      },
    ];
  }

  function openUxStoryByIndex(index: number | null): void {
    if (typeof index !== 'number') return;
    if (index < 0 || index >= uxGalleryStories.length) return;
    uxSlideshowIndex = index;
  }

  function openUxStory(story: QaStoryScreenshot): void {
    const index = uxGalleryStories.findIndex(candidate => candidate.id === story.id);
    openUxStoryByIndex(index);
  }

  function closeUxSlideshow(): void {
    uxSlideshowIndex = null;
  }

  function stepUxSlideshow(delta: number): void {
    if (uxGalleryStories.length === 0) return;
    const current = uxSlideshowIndex ?? 0;
    uxSlideshowIndex = (current + delta + uxGalleryStories.length) % uxGalleryStories.length;
  }

  function selectStoryShard(index: number): void {
    if (!selectedRun || !selectedRun.shards[index]) return;
    activeView = 'e2e';
    selectedShardIndex = index;
    showRawLogTail = false;
    rememberRunInUrl(selectedRun.runId, selectedRun.shards[index].shard);
  }

  function applyQaAuth(payload: { qaAuth?: QaAuthInfo } | null | undefined): void {
    const auth = payload?.qaAuth;
    if (!auth) return;
    qaAuthLabel = auth.disabled ? 'open' : auth.scope ?? 'locked';
  }

  function applyDecodedQaAuth(value: unknown): void {
    const qaAuth = decodeQaAuthInfo(value);
    applyQaAuth(qaAuth === undefined ? {} : { qaAuth });
  }

  const selectedShardWaterfall = $derived(
    selectedShard
      ? selectedPhaseP95
        ? buildPhaseWaterfall(selectedShard.phaseMs, selectedPhaseP95)
        : selectedShard.phaseWaterfall ?? buildPhaseWaterfall(selectedShard.phaseMs, null)
      : null,
  );

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
    artifactWindowSize = ARTIFACT_WINDOW_STEP;
    showRawLogTail = false;
    rememberRunInUrl(selectedRun.runId, shard.shard);
  }

  function setFailureClassFilter(failureClass: QaFailureClassFilter): void {
    selectedFailureClass = failureClass;
    runWindowSize = RUN_WINDOW_STEP;
    shardWindowSize = SHARD_WINDOW_STEP;
    artifactWindowSize = ARTIFACT_WINDOW_STEP;
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
    return qaScenarioSummary(shard);
  }

  function artifactCount(shard: QaShard, kind: QaArtifact['kind']): number {
    return shard.artifacts.filter((artifact) => artifact.kind === kind).length;
  }

  function scenarioPlayerOwnsArtifact(artifact: QaArtifact): boolean {
    return artifact.kind === 'video' ||
      artifact.kind === 'image' ||
      artifact.relativePath.includes('/qa-cues/');
  }

  function shardEvidenceArtifacts(shard: QaShard): QaArtifact[] {
    return shard.artifacts.filter((artifact) => !scenarioPlayerOwnsArtifact(artifact));
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
      const payload = decodeQaEnvelope(await readJsonUnknown(response), ['ok', 'qaAuth', 'runs', 'ledger', 'testLedger', 'regression', 'verdict', 'error']);
      if (!response.ok) throw new Error('Failed to load QA runs');
      applyDecodedQaAuth(payload['qaAuth']);
      runs = requireDecodedArray(payload['runs'], 'QA_RUNS_INVALID', isQaSummary);
      ledger = payload['ledger'] === undefined ? [] : requireDecodedArray(payload['ledger'], 'QA_LEDGER_INVALID', isQaRunLedgerEntry);
      testLedger = payload['testLedger'] === undefined ? [] : requireDecodedArray(payload['testLedger'], 'QA_TEST_LEDGER_INVALID', isQaTestLedgerEntry);
      regression = optionalDecoded(payload['regression'], 'QA_REGRESSION_INVALID', isQaRegressionReport) ?? null;
      systemVerdict = optionalDecoded(payload['verdict'], 'QA_VERDICT_INVALID', isQaSystemVerdict) ?? null;
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
      const payload = decodeQaEnvelope(await readJsonUnknown(response), ['ok', 'qaAuth', 'run', 'error']);
      if (!response.ok) throw new Error('Failed to load QA run');
      applyDecodedQaAuth(payload['qaAuth']);
      const run = optionalDecoded(payload['run'], 'QA_RUN_INVALID', isQaRun);
      if (!run) throw new Error('Failed to load QA run');
      selectedRun = run;
      selectedShardIndex = pickUrlShardIndex(run) ?? pickDefaultShard(run);
      showRawLogTail = false;
      rememberRunInUrl(run.runId, run.shards[selectedShardIndex]?.shard);
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
      const catalogPayload = decodeQaEnvelope(await readJsonUnknown(catalogResponse), ['ok', 'qaAuth', 'catalog', 'restart', 'restartAllowed', 'error']);
      const historyPayload = decodeQaEnvelope(await readJsonUnknown(historyResponse), ['ok', 'qaAuth', 'history', 'restart', 'restartAllowed', 'error']);
      const auditPayload = decodeQaEnvelope(await readJsonUnknown(auditResponse), ['ok', 'qaAuth', 'audit', 'error']);
      const storiesPayload = decodeQaEnvelope(await readJsonUnknown(storiesResponse), ['ok', 'qaAuth', 'stories', 'releasePack', 'error']);
      if (!catalogResponse.ok || !historyResponse.ok || !auditResponse.ok || !storiesResponse.ok) throw new Error('Failed to load QA metadata');
      applyDecodedQaAuth(catalogPayload['qaAuth']);
      applyDecodedQaAuth(historyPayload['qaAuth']);
      applyDecodedQaAuth(auditPayload['qaAuth']);
      applyDecodedQaAuth(storiesPayload['qaAuth']);
      catalog = requireDecodedArray(catalogPayload['catalog'], 'QA_CATALOG_INVALID', isQaCatalogEntry);
      stories = requireDecodedArray(storiesPayload['stories'], 'QA_STORIES_INVALID', isQaStoryScreenshot);
      uxReleasePack = optionalDecoded(storiesPayload['releasePack'], 'QA_RELEASE_PACK_INVALID', isQaUxReleasePackAudit) ?? null;
      history = requireDecodedArray(historyPayload['history'], 'QA_HISTORY_INVALID', isQaHistoryEntry);
      restartAudit = requireDecodedArray(auditPayload['audit'], 'QA_RESTART_AUDIT_INVALID', isQaRestartAuditEntry);
      const historyRestart = optionalDecoded(historyPayload['restart'], 'QA_HISTORY_RESTART_INVALID', isRestartStatus);
      const catalogRestart = optionalDecoded(catalogPayload['restart'], 'QA_CATALOG_RESTART_INVALID', isRestartStatus);
      restart = historyRestart ?? catalogRestart ?? { active: false };
      restartAllowed = catalogPayload['restartAllowed'] === true || historyPayload['restartAllowed'] === true;
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      loadingMeta = false;
    }
  }

  async function loadAdminHealth(): Promise<void> {
    loadingAdminHealth = true;
    adminHealthError = null;
    try {
      const response = await qaFetch('/api/health', { cache: 'no-store' });
      const payload = await readJsonUnknown(response);
      if (!response.ok) {
        const message = payload && typeof payload === 'object' && !Array.isArray(payload) && 'error' in payload
          ? String(payload['error'] || '')
          : '';
        throw new Error(message || `Health HTTP ${response.status}`);
      }
      const snapshot = normalizeQaAdminHealth(payload);
      if (!snapshot) throw new Error('Health payload is not an orchestrator snapshot');
      adminHealth = snapshot;
    } catch (err) {
      adminHealth = null;
      adminHealthError = err instanceof Error ? err.message : String(err);
    } finally {
      loadingAdminHealth = false;
    }
  }

  async function selectRun(runId: string): Promise<void> {
    if (!runId || runId === selectedRunId) return;
    selectedRunId = runId;
    shardWindowSize = SHARD_WINDOW_STEP;
    artifactWindowSize = ARTIFACT_WINDOW_STEP;
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
      const payload = decodeQaEnvelope(await readJsonUnknown(response), ['ok', 'command', 'expectedGitHead', 'codeHash', 'dirty', 'error']);
      if (!response.ok || !Array.isArray(payload['command']) || !payload['command'].every((entry) => typeof entry === 'string')) throw new Error('Failed to plan QA restart');
      if (payload['expectedGitHead'] !== undefined && payload['expectedGitHead'] !== null && typeof payload['expectedGitHead'] !== 'string') throw new Error('QA_RESTART_PLAN_HEAD_INVALID');
      if (payload['codeHash'] !== undefined && typeof payload['codeHash'] !== 'string') throw new Error('QA_RESTART_PLAN_HASH_INVALID');
      if (payload['dirty'] !== undefined && typeof payload['dirty'] !== 'boolean') throw new Error('QA_RESTART_PLAN_DIRTY_INVALID');
      restartPlan = payload['command'];
      restartExpectedGitHead = typeof payload['expectedGitHead'] === 'string' ? payload['expectedGitHead'] : '';
      restartCodeHash = typeof payload['codeHash'] === 'string' ? payload['codeHash'] : '';
      restartDirty = payload['dirty'] === true;
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
      const payload = decodeQaEnvelope(await readJsonUnknown(response), ['ok', 'restart', 'error']);
      const nextRestart = optionalDecoded(payload['restart'], 'QA_RESTART_INVALID', isRestartStatus);
      if (!response.ok || !nextRestart) throw new Error('Failed to start QA restart');
      restart = nextRestart;
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
      const payload = decodeQaEnvelope(await readJsonUnknown(response), ['ok', 'result', 'error']);
      const result = optionalDecoded(payload['result'], 'QA_RETENTION_RESULT_INVALID', isQaRetentionPurgeResult);
      if (!response.ok || !result) throw new Error('Failed to purge old QA runs');
      retentionResult = result;
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
        body: JSON.stringify({ confirm: historyBackfillConfirm.trim(), limit: 500 }),
      });
      const payload = decodeQaEnvelope(await readJsonUnknown(response), ['ok', 'result', 'error']);
      const result = optionalDecoded(payload['result'], 'QA_HISTORY_BACKFILL_RESULT_INVALID', isQaHistoryBackfillResult);
      if (!response.ok || !result) throw new Error('Failed to backfill QA history');
      historyBackfillResult = result;
      historyBackfillConfirm = '';
      await Promise.all([loadRuns(false), loadMeta()]);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      historyBackfillBusy = false;
    }
  }

  async function abortActiveRestart(): Promise<void> {
    if (!restartAbortReady) return;
    restartAbortBusy = true;
    actionError = null;
    try {
      const response = await qaFetch('/api/qa/restart/abort', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: restartAbortConfirm.trim() }),
      });
      const payload = decodeQaEnvelope(await readJsonUnknown(response), ['ok', 'restart', 'error']);
      const nextRestart = optionalDecoded(payload['restart'], 'QA_RESTART_ABORT_INVALID', isRestartStatus);
      if (!response.ok || !nextRestart) throw new Error('Failed to abort QA restart');
      restart = nextRestart;
      restartAbortConfirm = '';
      await loadMeta();
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      restartAbortBusy = false;
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
    await Promise.all([loadRuns(false), loadMeta(), loadAdminHealth()]);
    if (selectedRunId) await loadRun(selectedRunId);
  }

  async function forgetQaToken(): Promise<void> {
    clearQaToken();
    qaTokenInput = '';
    qaAuthLabel = 'locked';
    await Promise.all([loadRuns(false), loadMeta(), loadAdminHealth()]);
  }

  onMount(() => {
    qaTokenInput = consumeQaTokenFromUrl();
    void loadRuns(false);
    void loadMeta();
    void loadAdminHealth();
    const timer = setInterval(() => {
      if (!autoRefresh) return;
      void loadRuns(true);
      if (selectedRunId) void loadRun(selectedRunId);
      void loadMeta();
      void loadAdminHealth();
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

    <div class="trend-head">
      <span>Recent runs</span>
      <small>circle = passed/total stacks · F = failed stacks</small>
    </div>

    <div class="trend-strip" data-testid="qa-trend-strip">
      {#each latestTrend as run}
        <button
          type="button"
          class="trend-pill"
          class:pass={run.status === 'passed'}
          class:fail={run.status === 'failed'}
          class:selected={run.runId === selectedRunId}
          title={trendPillTitle(run)}
          aria-label={trendPillTitle(run)}
          data-testid="qa-trend-pill"
          onclick={() => selectRun(run.runId)}
        >
          {trendPillLabel(run)}
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
        {#each visibleRuns as run}
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
              <span>browser {formatMs(run.timing?.playwrightMs)}</span>
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
        {#if visibleRuns.length < sortedRuns.length}
          <button
            class="window-more"
            type="button"
            data-testid="qa-runs-show-more"
            onclick={() => (runWindowSize += RUN_WINDOW_STEP)}
          >
            Show {Math.min(RUN_WINDOW_STEP, sortedRuns.length - visibleRuns.length)} more runs · {visibleRuns.length}/{sortedRuns.length}
          </button>
        {/if}
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
          <span>Admin token</span>
          <input
            bind:value={qaTokenInput}
            type="password"
            autocomplete="off"
            placeholder="optional — admin actions only"
          />
        </label>
        <button class="mini-action" onclick={applyQaToken}>Apply</button>
        <button class="mini-action ghost" onclick={forgetQaToken}>Clear</button>
      {/if}
    </section>

    <QaTestLedgerTable rows={testLedger} />

    <nav class="qa-tabs" data-testid="qa-test-tabs">
      <button class:active={activeView === 'gallery'} onclick={() => (activeView = 'gallery')}>UX Gallery</button>
      <button class:active={activeView === 'e2e'} onclick={() => (activeView = 'e2e')}>Runs Ledger</button>
      <button class:active={activeView === 'scenarios'} onclick={() => (activeView = 'scenarios')}>Scenario Player</button>
      <button class:active={activeView === 'suites'} onclick={() => (activeView = 'suites')}>Suites</button>
      <button class:active={activeView === 'benchmarks'} onclick={() => (activeView = 'benchmarks')}>Benchmarks</button>
      <button class:active={activeView === 'history'} onclick={() => (activeView = 'history')}>Database</button>
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
        <span title="Independent active signals currently keeping the verdict non-green">{verdict.activeCount} active reasons</span>
        <span title="Distinct failing areas: run status, browser health, benchmarks, restart audit, or runtime markers">{verdict.failingSurfaceCount} failing surfaces</span>
        <span title="Runtime benchmark verdict compared with comparable historical runs">benchmark {benchmarkLabel(verdict.regressionStatus)}</span>
        <span title="Browser console, pageerror, network, and HTTP findings captured during Playwright">browser {verdict.browserErrorCount} err / {verdict.browserWarningCount} warn</span>
        <code title={verdict.gitHead ?? ''}>head {shortHash(verdict.gitHead)}</code>
        <code title={verdict.codeHash ?? ''}>code {shortHash(verdict.codeHash)}</code>
        {#if verdict.dirty}<span title="Git working tree was dirty when this run was captured">dirty</span>{/if}
        <span title="Latest evidence timestamp">{formatDate(verdict.latestAt)}</span>
      </div>
    </section>

    <section class="verdict-explain" data-testid="qa-verdict-explain">
      {#each verdictExplanations as item}
        <article class:bad={item.tone === 'bad'} class:warn={item.tone === 'warn'} class:ok={item.tone === 'ok'}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <small>{item.detail}</small>
        </article>
      {/each}
    </section>

    <QaAdminEvidenceBoard
      stories={adminStoryCards}
      health={adminHealth}
      healthError={adminHealthError}
      loadingHealth={loadingAdminHealth}
      onOpenScreenshot={openUxStoryByIndex}
      onSelectShard={selectStoryShard}
    />

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
          {#if uxGalleryStories[0]}
            <button
              type="button"
              class="ux-preview-card hero"
              onclick={() => openUxStoryByIndex(0)}
              title={uxGalleryStories[0].description ?? uxGalleryStories[0].title}
            >
              <QaProtectedImage url={uxGalleryStories[0].url} alt={uxGalleryStories[0].title} loading="lazy" />
              <span>{uxGalleryStories[0].group}</span>
              <strong>{uxGalleryStories[0].title}</strong>
            </button>
          {/if}
          <div class="ux-preview-rail">
            {#each uxGalleryStories.slice(1, 5) as story}
              <button type="button" class="ux-preview-card compact" onclick={() => openUxStory(story)} title={story.description ?? story.title}>
                <QaProtectedImage url={story.url} alt={story.title} loading="lazy" />
                <span>{story.group}</span>
                <strong>{story.title}</strong>
              </button>
            {/each}
          </div>
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
                  <button
                    type="button"
                    class="ux-gallery-card"
                    data-testid="qa-ux-gallery-card"
                    data-platform={story.platform ?? 'unknown'}
                    onclick={() => openUxStory(story)}
                  >
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
                  </button>
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
        {#if restart.active}
          <section class="restart-abort-card" data-testid="qa-restart-abort-card">
            <div>
              <strong>Active restart</strong>
              <span>{restart.target ?? 'restart'} · pid {restart.pid ?? 'n/a'}</span>
            </div>
            <label>
              <span>abort confirm</span>
              <input
                bind:value={restartAbortConfirm}
                autocomplete="off"
                placeholder={QA.RESTART_ABORT_CONFIRM}
                disabled={!qaCanPlanRestart || restartAbortBusy}
              />
            </label>
            <button
              class="mini-action danger"
              disabled={!restartAbortReady}
              title={qaCanPlanRestart ? 'Stops the active restart process with SIGTERM then SIGKILL grace' : 'Admin QA token required'}
              onclick={abortActiveRestart}
              data-testid="qa-restart-abort"
            >
              {restartAbortBusy ? 'Aborting...' : 'Abort restart'}
            </button>
          </section>
        {/if}
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
        <QaPerformanceTrend history={history} />
        <section class="benchmark-trend" data-testid="qa-benchmark-trend">
          <div class="suite-list-head compact-head">
            <div>
              <div class="eyebrow">Recent Load</div>
              <h3>Wall / CPU / Browser Trend</h3>
            </div>
            <span class="chip">{Math.min(QA.HISTORY_PREVIEW_LIMIT, sortedHistory.length)} runs</span>
          </div>
          {#each sortedHistory.slice(0, QA.HISTORY_PREVIEW_LIMIT) as row}
            <article
              class:bad={row.status === 'failed'}
              class:ok={row.status === 'passed'}
              data-testid="qa-benchmark-metric-row"
              data-run-id={row.runId}
            >
              <div>
                <strong>{statusLabel(row)}</strong>
                <code title={row.codeHash ?? ''}>code {shortHash(row.codeHash)}</code>
              </div>
              <div class="benchmark-metric">
                <span>wall</span>
                <b>{formatMs(row.totalMs)}</b>
              </div>
              <div class="benchmark-metric">
                <span>load</span>
                <b>{row.peakLoad1 ?? 'n/a'}</b>
              </div>
              <div class="benchmark-metric">
                <span>cpu</span>
                <b>{row.maxChildCpuPct ?? 'n/a'}%</b>
              </div>
              <div class="benchmark-metric">
                <span>browser</span>
                <b class:warn={row.browserErrorCount > 0}>{formatBrowserHealth(browserHealthFromHistory(row))}</b>
              </div>
              <div class="benchmark-metric">
                <span>bench</span>
                <b class:warn={row.benchmarkStatus === 'slower' || row.benchmarkStatus === 'mixed'}>
                  {benchmarkLabel(row.benchmarkStatus)} {formatPct(row.benchmarkDeltaPct)}
                </b>
              </div>
            </article>
          {/each}
        </section>
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
        <div class="history-table">
          {#each visibleHistory as row}
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
        {#if visibleHistory.length < sortedHistory.length}
          <button
            class="window-more"
            type="button"
            data-testid="qa-history-show-more"
            onclick={() => (historyWindowSize += HISTORY_WINDOW_STEP)}
          >
            Show {Math.min(HISTORY_WINDOW_STEP, sortedHistory.length - visibleHistory.length)} more history rows · {visibleHistory.length}/{sortedHistory.length}
          </button>
        {/if}
        <section class="retention-card" data-testid="qa-history-backfill-card">
          <div>
            <div class="eyebrow">Maintenance</div>
            <h3>Backfill History Index</h3>
            <p>One-shot index rebuild from run manifests already on disk.</p>
          </div>
          <label>
            <span>confirm phrase</span>
            <input bind:value={historyBackfillConfirm} autocomplete="off" placeholder={QA.HISTORY_BACKFILL_CONFIRM} />
          </label>
          <button
            class="mini-action"
            disabled={!historyBackfillReady}
            title={qaCanPlanRestart ? 'Reads run manifests once and records SQLite rows' : 'Admin QA token required'}
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
            <input bind:value={retentionConfirm} autocomplete="off" placeholder={QA.RETENTION_CONFIRM} />
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
      <section class="run-ledger-panel" data-testid="qa-run-ledger">
        <div class="suite-list-head compact-head">
          <div>
            <div class="eyebrow">Canonical Ledger</div>
            <h3>Runs Across Test Surfaces</h3>
          </div>
          <span class="chip">{filteredLedger.length}/{ledger.length} ledger rows</span>
        </div>
        {#if ledgerCategoryOptions.length > 0}
          <div class="filter-chips inline" data-testid="qa-ledger-category-filter">
            <button
              type="button"
              class:active={selectedLedgerCategory === 'all'}
              onclick={() => (selectedLedgerCategory = 'all')}
            >
              all
            </button>
            {#each ledgerCategoryOptions as category}
              <button
                type="button"
                class:active={selectedLedgerCategory === category}
                onclick={() => (selectedLedgerCategory = category)}
              >
                {category}
              </button>
            {/each}
          </div>
        {/if}
        {#if sortedLedger.length === 0}
          <div class="empty">No canonical ledger rows indexed yet</div>
        {:else}
          <div class="history-table ledger-table">
            {#each visibleLedger as row}
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
          {#if visibleLedger.length < sortedLedger.length}
            <button
              class="window-more"
              type="button"
              data-testid="qa-ledger-show-more"
              onclick={() => (ledgerWindowSize += LEDGER_WINDOW_STEP)}
            >
              Show {Math.min(LEDGER_WINDOW_STEP, sortedLedger.length - visibleLedger.length)} more ledger rows · {visibleLedger.length}/{sortedLedger.length}
            </button>
          {/if}
        {/if}
      </section>

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
            <small>{selectedRun.code?.gitHead ? `head ${shortHash(selectedRun.code.gitHead)}` : 'head unrecorded'}</small>
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
        {#each visibleShardEntries as { shard, index }}
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
        {#if visibleShardEntries.length < sortedShardEntries.length}
          <button
            class="window-more"
            type="button"
            data-testid="qa-shards-show-more"
            onclick={() => (shardWindowSize += SHARD_WINDOW_STEP)}
          >
            Show {Math.min(SHARD_WINDOW_STEP, sortedShardEntries.length - visibleShardEntries.length)} more shards · {visibleShardEntries.length}/{sortedShardEntries.length}
          </button>
        {/if}
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
                  <input bind:value={restartConfirm} autocomplete="off" placeholder={QA.RESTART_CONFIRM} />
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
            <aside class="evidence-playlist" data-testid="qa-evidence-playlist">
              <div class="playlist-head">
                <div>
                  <div class="eyebrow">Evidence Playlist</div>
                  <h4>Recorded Scenarios</h4>
                </div>
                <span>{visibleShardEntries.length}/{sortedShardEntries.length}</span>
              </div>
              <div class="playlist-list">
                {#each visibleShardEntries as { shard, index }}
                  <button
                    type="button"
                    class="playlist-row"
                    class:selected={index === selectedShardIndex}
                    class:fail={shard.status === 'failed'}
                    data-testid="qa-playlist-row"
                    data-selected={index === selectedShardIndex ? 'true' : 'false'}
                    data-shard={shard.shard}
                    onclick={() => selectShard(index)}
                  >
                    <div class="playlist-thumb">
                      {#if shardPreviewUrl(shard)}
                        <QaProtectedImage url={shardPreviewUrl(shard)} alt={describeShard(shard)} loading="lazy" />
                      {:else}
                        <span>{artifactCount(shard, 'video') > 0 ? 'Play' : 'No video'}</span>
                      {/if}
                    </div>
                    <div class="playlist-copy">
                      <strong>{describeShard(shard)}</strong>
                      <small>{shardPreviewText(shard)}</small>
                      <span>
                        {shard.status}
                        · {formatMs(shard.durationMs)}
                        · {plural(artifactCount(shard, 'video'), 'video', 'videos')}
                      </span>
                    </div>
                  </button>
                {/each}
              </div>
            </aside>

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
                    {#each (selectedShard.browserIssues ?? []).slice(0, QA.BROWSER_ISSUE_PREVIEW_LIMIT) as issue}
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

            </div>
          </div>

          <section class="panel-block evidence-files-strip" data-testid="qa-evidence-artifacts">
            <div class="evidence-files-head">
              <div>
                <div class="eyebrow">Artifacts Below Playback</div>
                <h4>Evidence Files</h4>
              </div>
              <span>{selectedShardEvidenceArtifacts.length} files</span>
            </div>
            {#if selectedShardEvidenceArtifacts.length > 0}
              <div class="artifact-list">
                {#each visibleSelectedShardEvidenceArtifacts as artifact}
                  <button type="button" onclick={() => openProtectedArtifact(artifact.url)}>
                    <span>{artifactLabel(artifact)}</span>
                    <strong>{artifact.name}</strong>
                    <small>{formatBytes(artifact.sizeBytes)}</small>
                    <small>{artifact.sensitivity}</small>
                  </button>
                {/each}
              </div>
              {#if visibleSelectedShardEvidenceArtifacts.length < selectedShardEvidenceArtifacts.length}
                <button
                  class="window-more"
                  type="button"
                  data-testid="qa-artifacts-show-more"
                  onclick={() => (artifactWindowSize += ARTIFACT_WINDOW_STEP)}
                >
                  Show {Math.min(ARTIFACT_WINDOW_STEP, selectedShardEvidenceArtifacts.length - visibleSelectedShardEvidenceArtifacts.length)} more artifacts · {visibleSelectedShardEvidenceArtifacts.length}/{selectedShardEvidenceArtifacts.length}
                </button>
              {/if}
            {:else}
              <div class="empty">No non-media artifact files captured</div>
            {/if}
          </section>

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

    {#if uxSlideshowStory}
      <div class="ux-slideshow-backdrop" data-testid="qa-ux-slideshow" role="dialog" aria-modal="true" aria-label="UX screenshot slideshow">
        <section class="ux-slideshow">
          <div class="ux-slideshow-head">
            <div>
              <div class="eyebrow">{uxSlideshowStory.group}</div>
              <h2>{uxSlideshowStory.title}</h2>
              <p>{uxSlideshowStory.description ?? uxSlideshowStory.name}</p>
            </div>
            <button type="button" class="mini-action ghost" data-testid="qa-ux-slideshow-close" onclick={closeUxSlideshow}>Close</button>
          </div>
          <div class="ux-slideshow-image">
            <QaProtectedImage url={uxSlideshowStory.url} alt={uxSlideshowStory.title} loading="eager" />
          </div>
          <div class="ux-slideshow-controls">
            <button type="button" class="mini-action" data-testid="qa-ux-slideshow-prev" onclick={() => stepUxSlideshow(-1)}>Prev</button>
            <div class="artifact-chips">
              <span>{(uxSlideshowIndex ?? 0) + 1}/{uxGalleryStories.length}</span>
              <span>{uxSlideshowStory.platform ?? 'screen'}</span>
              <span>{uxSlideshowStory.curated ? 'curated' : uxSlideshowStory.source}</span>
              {#if uxSlideshowStory.runId}<span>run {uxSlideshowStory.runId}</span>{/if}
            </div>
            <button type="button" class="mini-action" data-testid="qa-ux-slideshow-next" onclick={() => stepUxSlideshow(1)}>Next</button>
          </div>
        </section>
      </div>
    {/if}
  </main>
</div>
