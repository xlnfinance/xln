import { probeRpcHealth, type RpcHealthProbeResult } from '../../../packages/runtime-client/src/rpc-health';
import { readJsonUnknown } from '../../../packages/runtime-client/src/boundary';
import { decodeOpsHealthEvidence, type OpsHealthEvidence } from './ops-health-model';

export type OpsHealthSourceSnapshot = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'error';
  autoRefresh: boolean;
  refreshing: boolean;
  health: OpsHealthEvidence | null;
  rpc: RpcHealthProbeResult | null;
  error: string;
}>;

export type OpsHealthSourceDependencies = Readonly<{
  fetchHealth: (signal: AbortSignal) => Promise<OpsHealthEvidence>;
  probeRpc: () => Promise<RpcHealthProbeResult>;
  setTimer: (callback: () => void, milliseconds: number) => number;
  clearTimer: (handle: number) => void;
}>;

export type OpsHealthSource = Readonly<{
  getSnapshot: () => OpsHealthSourceSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => Promise<void>;
  stop: () => void;
  refresh: () => Promise<void>;
  setAutoRefresh: (enabled: boolean) => void;
}>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'Health request failed');

const defaultFetchHealth = async (signal: AbortSignal): Promise<OpsHealthEvidence> => {
  const response = await fetch('/api/health', { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`OPS_HEALTH_HTTP_${response.status}`);
  return decodeOpsHealthEvidence(await readJsonUnknown(response), Date.now());
};

const defaultDependencies = (): OpsHealthSourceDependencies => ({
  fetchHealth: defaultFetchHealth,
  probeRpc: () => probeRpcHealth(),
  setTimer: (callback, milliseconds) => window.setInterval(callback, milliseconds),
  clearTimer: handle => window.clearInterval(handle),
});

const initialSnapshot = (): OpsHealthSourceSnapshot => ({
  status: 'idle',
  autoRefresh: true,
  refreshing: false,
  health: null,
  rpc: null,
  error: '',
});

export const createOpsHealthSource = (
  dependencies: OpsHealthSourceDependencies = defaultDependencies(),
): OpsHealthSource => {
  const listeners = new Set<() => void>();
  let snapshot = initialSnapshot();
  let started = false;
  let generation = 0;
  let timer: number | null = null;
  let controller: AbortController | null = null;
  let refreshInFlight: Promise<void> | null = null;

  const publish = (patch: Partial<OpsHealthSourceSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const runRefresh = async (): Promise<void> => {
    const ownedGeneration = generation;
    controller = new AbortController();
    publish({
      status: snapshot.health ? snapshot.status : 'loading',
      refreshing: true,
      error: '',
    });
    try {
      const [health, rpc] = await Promise.all([
        dependencies.fetchHealth(controller.signal),
        dependencies.probeRpc(),
      ]);
      if (!started || ownedGeneration !== generation) return;
      publish({ status: 'ready', refreshing: false, health, rpc, error: '' });
    } catch (error: unknown) {
      if (!started || ownedGeneration !== generation) return;
      publish({ status: 'error', refreshing: false, error: errorMessage(error) });
    } finally {
      controller = null;
    }
  };

  const refresh = async (): Promise<void> => {
    if (!started) return;
    if (!refreshInFlight) refreshInFlight = runRefresh();
    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  };

  const start = async (): Promise<void> => {
    if (started) return refreshInFlight ?? Promise.resolve();
    started = true;
    generation += 1;
    timer = dependencies.setTimer(() => {
      if (snapshot.autoRefresh) void refresh();
    }, 4_000);
    await refresh();
  };

  const stop = (): void => {
    if (!started) return;
    started = false;
    generation += 1;
    controller?.abort();
    controller = null;
    if (timer !== null) dependencies.clearTimer(timer);
    timer = null;
    refreshInFlight = null;
    publish({ ...initialSnapshot(), autoRefresh: snapshot.autoRefresh });
  };

  const setAutoRefresh = (enabled: boolean): void => {
    if (snapshot.autoRefresh === enabled) return;
    publish({ autoRefresh: enabled });
    if (enabled) void refresh();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start,
    stop,
    refresh,
    setAutoRefresh,
  };
};
