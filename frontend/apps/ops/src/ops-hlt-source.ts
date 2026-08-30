import { readJsonUnknown } from '../../../src/lib/utils/boundary';
import { consumeQaTokenFromUrl, qaFetch } from '../../../src/lib/qa/apiClient';
import { decodeHltDashboardPayload, type HltDashboardPayload } from '../../../src/lib/qa/hlt';
import type { OpsHltStartRequest } from './ops-hlt-model';

export type OpsHltSourceSnapshot = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'error';
  busy: boolean;
  data: HltDashboardPayload | null;
  error: string;
}>;

type OpsHltSourceDependencies = Readonly<{
  fetchSnapshot: (signal: AbortSignal) => Promise<HltDashboardPayload>;
  postAction: (path: '/api/qa/hlt/start' | '/api/qa/hlt/abort', body: unknown, signal: AbortSignal) => Promise<void>;
  setTimer: (callback: () => void, milliseconds: number) => number;
  clearTimer: (handle: number) => void;
}>;

export type OpsHltSource = Readonly<{
  getSnapshot: () => OpsHltSourceSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => Promise<void>;
  stop: () => void;
  refresh: () => Promise<void>;
  startRun: (request: OpsHltStartRequest) => Promise<void>;
  abortRun: () => Promise<void>;
}>;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error || 'HLT request failed');

const responseError = async (response: Response): Promise<string> => {
  const payload = await readJsonUnknown(response);
  return typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
    ? payload.error
    : `HLT_HTTP_${response.status}`;
};

const defaultDependencies = (): OpsHltSourceDependencies => ({
  fetchSnapshot: async signal => {
    const response = await qaFetch('/api/qa/hlt', { cache: 'no-store', signal });
    if (!response.ok) throw new Error(await responseError(response));
    return decodeHltDashboardPayload(await readJsonUnknown(response));
  },
  postAction: async (path, body, signal) => {
    const init: RequestInit = body === null ? {
      method: 'POST',
      signal,
    } : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    };
    const response = await qaFetch(path, init);
    if (!response.ok) throw new Error(await responseError(response));
  },
  setTimer: (callback, milliseconds) => window.setInterval(callback, milliseconds),
  clearTimer: handle => window.clearInterval(handle),
});

export const createOpsHltSource = (
  dependencies: OpsHltSourceDependencies = defaultDependencies(),
): OpsHltSource => {
  const listeners = new Set<() => void>();
  let snapshot: OpsHltSourceSnapshot = { status: 'idle', busy: false, data: null, error: '' };
  let active = false;
  let generation = 0;
  let timer: number | null = null;
  let refreshController: AbortController | null = null;
  let actionController: AbortController | null = null;
  let refreshInFlight: Promise<void> | null = null;

  const publish = (patch: Partial<OpsHltSourceSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const runRefresh = async (): Promise<void> => {
    const ownedGeneration = generation;
    refreshController = new AbortController();
    publish({ status: snapshot.data ? snapshot.status : 'loading', error: '' });
    try {
      const data = await dependencies.fetchSnapshot(refreshController.signal);
      if (active && ownedGeneration === generation) publish({ status: 'ready', data, error: '' });
    } catch (error: unknown) {
      if (active && ownedGeneration === generation) publish({ status: 'error', error: message(error) });
    } finally {
      refreshController = null;
    }
  };

  const refresh = async (): Promise<void> => {
    if (!active) return;
    if (!refreshInFlight) refreshInFlight = runRefresh();
    try { await refreshInFlight; } finally { refreshInFlight = null; }
  };

  const action = async (path: '/api/qa/hlt/start' | '/api/qa/hlt/abort', body: unknown): Promise<void> => {
    if (!active || snapshot.busy) return;
    const ownedGeneration = generation;
    actionController = new AbortController();
    publish({ busy: true, error: '' });
    try {
      await dependencies.postAction(path, body, actionController.signal);
      if (active && ownedGeneration === generation) await refresh();
    } catch (error: unknown) {
      if (active && ownedGeneration === generation) publish({ status: 'error', error: message(error) });
    } finally {
      actionController = null;
      if (active && ownedGeneration === generation) publish({ busy: false });
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start: async () => {
      if (active) return refreshInFlight ?? Promise.resolve();
      active = true;
      generation += 1;
      consumeQaTokenFromUrl();
      timer = dependencies.setTimer(() => { if (snapshot.data?.run.active) void refresh(); }, 1_000);
      await refresh();
    },
    stop: () => {
      if (!active) return;
      active = false;
      generation += 1;
      refreshController?.abort();
      actionController?.abort();
      refreshController = null;
      actionController = null;
      if (timer !== null) dependencies.clearTimer(timer);
      timer = null;
      refreshInFlight = null;
      publish({ status: 'idle', busy: false, data: null, error: '' });
    },
    refresh,
    startRun: request => action('/api/qa/hlt/start', request),
    abortRun: () => action('/api/qa/hlt/abort', null),
  };
};
