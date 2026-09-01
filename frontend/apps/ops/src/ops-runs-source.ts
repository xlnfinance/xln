import { clearQaToken, consumeQaTokenFromUrl, qaFetch, writeQaToken } from '../../../packages/browser/src/qa-api-client';
import { readJsonUnknown } from '../../../packages/runtime-client/src/boundary';
import type { QaRunLedgerEntry } from '../../../packages/runtime-client/src/qa-types';
import { decodeOpsRuns, requestedOpsRunId, type OpsRunsPayload } from './ops-runs-model';
import type { OpsQaAuthLabel } from './ops-qa-model';

export type OpsRunsSnapshot = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'error';
  refreshing: boolean;
  auth: OpsQaAuthLabel;
  rows: readonly QaRunLedgerEntry[];
  selectedRunId: string;
  error: string;
}>;

export type OpsRunsDependencies = Readonly<{
  fetchRuns: (signal: AbortSignal) => Promise<OpsRunsPayload>;
  currentUrl: () => URL;
  replaceUrl: (url: URL) => void;
}>;

export type OpsRunsSource = Readonly<{
  getSnapshot: () => OpsRunsSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => Promise<void>;
  stop: () => void;
  refresh: () => Promise<void>;
  selectRun: (runId: string) => void;
  applyToken: (token: string) => Promise<void>;
  clearToken: () => Promise<void>;
}>;

const fetchRuns = async (signal: AbortSignal): Promise<OpsRunsPayload> => {
  const response = await qaFetch('/api/qa/runs?limit=50', { cache: 'no-store', signal });
  const payload = await readJsonUnknown(response);
  if (!response.ok) throw new Error(`OPS_RUNS_HTTP_${response.status}`);
  return decodeOpsRuns(payload);
};

const dependencies = (): OpsRunsDependencies => ({
  fetchRuns,
  currentUrl: () => new URL(window.location.href),
  replaceUrl: url => window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`),
});

const initialSnapshot = (): OpsRunsSnapshot => ({
  status: 'idle', refreshing: false, auth: 'locked', rows: [], selectedRunId: '', error: '',
});

export const createOpsRunsSource = (deps: OpsRunsDependencies = dependencies()): OpsRunsSource => {
  const listeners = new Set<() => void>();
  let snapshot = initialSnapshot();
  let started = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let inFlight: Promise<void> | null = null;

  const publish = (patch: Partial<OpsRunsSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const rememberSelection = (runId: string): void => {
    const url = deps.currentUrl();
    if (runId) url.searchParams.set('runId', runId);
    else url.searchParams.delete('runId');
    deps.replaceUrl(url);
  };

  const runRefresh = async (): Promise<void> => {
    const ownedGeneration = generation;
    controller = new AbortController();
    publish({ status: snapshot.rows.length === 0 ? 'loading' : snapshot.status, refreshing: true, error: '' });
    try {
      const result = await deps.fetchRuns(controller.signal);
      if (!started || ownedGeneration !== generation) return;
      const requested = requestedOpsRunId(deps.currentUrl());
      const selectedRunId = [snapshot.selectedRunId, requested].find(runId => result.rows.some(row => row.runId === runId))
        ?? result.rows[0]?.runId ?? '';
      publish({ status: 'ready', refreshing: false, auth: result.auth, rows: result.rows, selectedRunId, error: '' });
      rememberSelection(selectedRunId);
    } catch (error: unknown) {
      if (!started || ownedGeneration !== generation) return;
      publish({ status: 'error', refreshing: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      controller = null;
    }
  };

  const refresh = async (): Promise<void> => {
    if (!started) return;
    if (!inFlight) inFlight = runRefresh();
    try { await inFlight; } finally { inFlight = null; }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start: async () => {
      if (started) return inFlight ?? Promise.resolve();
      started = true; generation += 1; consumeQaTokenFromUrl(); await refresh();
    },
    stop: () => {
      if (!started) return;
      started = false; generation += 1; controller?.abort(); controller = null; inFlight = null;
      publish(initialSnapshot());
    },
    refresh,
    selectRun: runId => {
      if (!snapshot.rows.some(row => row.runId === runId)) return;
      publish({ selectedRunId: runId }); rememberSelection(runId);
    },
    applyToken: async token => { writeQaToken(token); await refresh(); },
    clearToken: async () => { clearQaToken(); await refresh(); },
  };
};
