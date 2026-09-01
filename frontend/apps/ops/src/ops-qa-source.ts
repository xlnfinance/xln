import { normalizeQaAdminHealth, type QaAdminHealthSnapshot } from '../../../packages/runtime-client/src/qa-admin-evidence';
import { clearQaToken, consumeQaTokenFromUrl, qaFetch, writeQaToken } from '../../../packages/browser/src/qa-api-client';
import type {
  QaCatalogEntry,
  QaHistoryEntry,
  QaRegressionReport,
  QaRestartAuditEntry,
  QaRun,
  QaRunLedgerEntry,
  QaStoryScreenshot,
  QaSummary,
  QaSystemVerdict,
  QaTestLedgerEntry,
  QaUxReleasePackAudit,
  RestartStatus,
} from '../../../packages/runtime-client/src/qa-types';
import { readJsonUnknown } from '../../../packages/runtime-client/src/boundary';
import {
  decodeOpsQaMeta,
  decodeOpsQaRun,
  decodeOpsQaRuns,
  opsQaAuthLabel,
  pickOpsQaShardIndex,
  requestedQaSelection,
  strongestOpsQaAuth,
  type OpsQaAuthLabel,
  type OpsQaMetaPayload,
  type OpsQaRunsPayload,
} from './ops-qa-model';

export type OpsQaSourceSnapshot = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'error';
  autoRefresh: boolean;
  refreshing: boolean;
  selecting: boolean;
  auth: OpsQaAuthLabel;
  runs: readonly QaSummary[];
  catalog: readonly QaCatalogEntry[];
  stories: readonly QaStoryScreenshot[];
  releasePack: QaUxReleasePackAudit | null;
  history: readonly QaHistoryEntry[];
  ledger: readonly QaRunLedgerEntry[];
  testLedger: readonly QaTestLedgerEntry[];
  regression: QaRegressionReport | null;
  restartAudit: readonly QaRestartAuditEntry[];
  restart: RestartStatus;
  restartAllowed: boolean;
  systemVerdict: QaSystemVerdict | null;
  selectedRunId: string;
  selectedRun: QaRun | null;
  selectedShardIndex: number;
  adminHealth: QaAdminHealthSnapshot | null;
  adminHealthError: string;
  error: string;
}>;

export type OpsQaBundle = Readonly<{
  runs: OpsQaRunsPayload;
  meta: OpsQaMetaPayload;
  adminHealth: QaAdminHealthSnapshot | null;
  adminHealthError: string;
}>;

export type OpsQaSourceDependencies = Readonly<{
  fetchBundle: (signal: AbortSignal) => Promise<OpsQaBundle>;
  fetchRun: (runId: string, signal: AbortSignal) => Promise<ReturnType<typeof decodeOpsQaRun>>;
  currentUrl: () => URL;
  replaceUrl: (url: URL) => void;
  setTimer: (callback: () => void, milliseconds: number) => number;
  clearTimer: (handle: number) => void;
}>;

export type OpsQaSource = Readonly<{
  getSnapshot: () => OpsQaSourceSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => Promise<void>;
  stop: () => void;
  refresh: () => Promise<void>;
  selectRun: (runId: string) => Promise<void>;
  selectShard: (index: number) => void;
  setAutoRefresh: (enabled: boolean) => void;
  applyToken: (token: string) => Promise<void>;
  clearToken: () => Promise<void>;
}>;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error || 'QA request failed');

const fetchJson = async (url: string, signal: AbortSignal): Promise<unknown> => {
  const response = await qaFetch(url, { cache: 'no-store', signal });
  const value = await readJsonUnknown(response);
  if (!response.ok) throw new Error(`OPS_QA_HTTP_${response.status}:${url}`);
  return value;
};

const fetchBundle = async (signal: AbortSignal): Promise<OpsQaBundle> => {
  const [runs, catalog, history, audit, stories, healthResult] = await Promise.all([
    fetchJson('/api/qa/runs?limit=20', signal),
    fetchJson('/api/qa/catalog', signal),
    fetchJson('/api/qa/history?limit=120', signal),
    fetchJson('/api/qa/restart-audit?limit=25', signal),
    fetchJson('/api/qa/stories?limit=200', signal),
    fetchJson('/api/health', signal).then(
      value => ({ value, error: '' }),
      (error: unknown) => ({ value: null, error: message(error) }),
    ),
  ]);
  const adminHealth = healthResult.value === null ? null : normalizeQaAdminHealth(healthResult.value);
  return {
    runs: decodeOpsQaRuns(runs),
    meta: decodeOpsQaMeta({ catalog, history, audit, stories }),
    adminHealth,
    adminHealthError: healthResult.error || (healthResult.value !== null && !adminHealth ? 'OPS_QA_HEALTH_INVALID' : ''),
  };
};

const defaultDependencies = (): OpsQaSourceDependencies => ({
  fetchBundle,
  fetchRun: async (runId, signal) => decodeOpsQaRun(await fetchJson(`/api/qa/run?runId=${encodeURIComponent(runId)}`, signal)),
  currentUrl: () => new URL(window.location.href),
  replaceUrl: url => window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`),
  setTimer: (callback, milliseconds) => window.setInterval(callback, milliseconds),
  clearTimer: handle => window.clearInterval(handle),
});

const initialSnapshot = (): OpsQaSourceSnapshot => ({
  status: 'idle', autoRefresh: true, refreshing: false, selecting: false, auth: 'locked',
  runs: [], catalog: [], stories: [], releasePack: null, history: [], ledger: [], testLedger: [],
  regression: null, restartAudit: [], restart: { active: false }, restartAllowed: false,
  systemVerdict: null, selectedRunId: '', selectedRun: null, selectedShardIndex: 0,
  adminHealth: null, adminHealthError: '', error: '',
});

export const createOpsQaSource = (dependencies: OpsQaSourceDependencies = defaultDependencies()): OpsQaSource => {
  const listeners = new Set<() => void>();
  let snapshot = initialSnapshot();
  let started = false;
  let generation = 0;
  let timer: number | null = null;
  let refreshController: AbortController | null = null;
  let selectionController: AbortController | null = null;
  let refreshInFlight: Promise<void> | null = null;

  const publish = (patch: Partial<OpsQaSourceSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const rememberSelection = (): void => {
    const url = dependencies.currentUrl();
    if (snapshot.selectedRunId) url.searchParams.set('runId', snapshot.selectedRunId);
    else url.searchParams.delete('runId');
    const shard = snapshot.selectedRun?.shards[snapshot.selectedShardIndex]?.shard;
    if (shard === undefined) url.searchParams.delete('shard');
    else url.searchParams.set('shard', String(shard));
    dependencies.replaceUrl(url);
  };

  const loadSelectedRun = async (runId: string, requestedShard: number | null, signal: AbortSignal): Promise<void> => {
    const result = await dependencies.fetchRun(runId, signal);
    if (!started || signal.aborted) return;
    publish({
      auth: strongestOpsQaAuth([snapshot.auth, result.auth]),
      selectedRunId: result.run.runId,
      selectedRun: result.run,
      selectedShardIndex: pickOpsQaShardIndex(result.run, requestedShard),
    });
    rememberSelection();
  };

  const runRefresh = async (): Promise<void> => {
    const ownedGeneration = generation;
    refreshController = new AbortController();
    publish({ status: snapshot.runs.length > 0 ? snapshot.status : 'loading', refreshing: true, error: '' });
    try {
      const bundle = await dependencies.fetchBundle(refreshController.signal);
      if (!started || ownedGeneration !== generation) return;
      const requested = requestedQaSelection(dependencies.currentUrl());
      const selectedRunId = snapshot.selectedRunId && bundle.runs.runs.some(run => run.runId === snapshot.selectedRunId)
        ? snapshot.selectedRunId
        : requested.runId && bundle.runs.runs.some(run => run.runId === requested.runId)
          ? requested.runId
          : bundle.runs.runs[0]?.runId ?? '';
      publish({
        status: 'ready', refreshing: false,
        auth: strongestOpsQaAuth([opsQaAuthLabel(bundle.runs.auth), bundle.meta.auth]),
        runs: bundle.runs.runs, ledger: bundle.runs.ledger, testLedger: bundle.runs.testLedger,
        regression: bundle.runs.regression, systemVerdict: bundle.runs.systemVerdict,
        catalog: bundle.meta.catalog, history: bundle.meta.history, restartAudit: bundle.meta.audit,
        stories: bundle.meta.stories, releasePack: bundle.meta.releasePack,
        restart: bundle.meta.restart, restartAllowed: bundle.meta.restartAllowed,
        adminHealth: bundle.adminHealth, adminHealthError: bundle.adminHealthError, error: '',
        ...(selectedRunId ? { selectedRunId } : { selectedRunId: '', selectedRun: null, selectedShardIndex: 0 }),
      });
      if (selectedRunId) await loadSelectedRun(selectedRunId, requested.shard, refreshController.signal);
    } catch (error: unknown) {
      if (!started || ownedGeneration !== generation) return;
      publish({ status: 'error', refreshing: false, error: message(error) });
    } finally {
      refreshController = null;
    }
  };

  const refresh = async (): Promise<void> => {
    if (!started) return;
    if (!refreshInFlight) refreshInFlight = runRefresh();
    try { await refreshInFlight; } finally { refreshInFlight = null; }
  };

  const selectRun = async (runId: string): Promise<void> => {
    if (!started || !runId || runId === snapshot.selectedRunId) return;
    selectionController?.abort();
    selectionController = new AbortController();
    publish({ selecting: true, error: '', selectedRunId: runId });
    try {
      await loadSelectedRun(runId, null, selectionController.signal);
    } catch (error: unknown) {
      if (!selectionController.signal.aborted) publish({ error: message(error) });
    } finally {
      selectionController = null;
      if (started) publish({ selecting: false });
    }
  };

  const start = async (): Promise<void> => {
    if (started) return refreshInFlight ?? Promise.resolve();
    started = true;
    generation += 1;
    consumeQaTokenFromUrl();
    timer = dependencies.setTimer(() => { if (snapshot.autoRefresh) void refresh(); }, 15_000);
    await refresh();
  };

  const stop = (): void => {
    if (!started) return;
    started = false;
    generation += 1;
    refreshController?.abort();
    selectionController?.abort();
    refreshController = null;
    selectionController = null;
    if (timer !== null) dependencies.clearTimer(timer);
    timer = null;
    refreshInFlight = null;
    publish({ ...initialSnapshot(), autoRefresh: snapshot.autoRefresh });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start, stop, refresh, selectRun,
    selectShard: index => {
      if (!snapshot.selectedRun?.shards[index]) return;
      publish({ selectedShardIndex: index });
      rememberSelection();
    },
    setAutoRefresh: autoRefresh => { publish({ autoRefresh }); if (autoRefresh) void refresh(); },
    applyToken: async token => { writeQaToken(token); await refresh(); },
    clearToken: async () => { clearQaToken(); await refresh(); },
  };
};
