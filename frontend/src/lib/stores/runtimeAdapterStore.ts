import { get, writable } from 'svelte/store';
import type {
  RuntimeAdapter,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
  RuntimeAdapterStatus,
} from '@xln/runtime/xln-api';
import { RemoteRuntimeAdapter } from '@xln/runtime/radapter/remote';
import { getEnv, getXLN, setXlnEnvironment } from './xlnStore';

type RuntimeReadState<T> = {
  loading: boolean;
  data: T | null;
  error: string | null;
  height: number;
};

export const runtimeAdapter = writable<RuntimeAdapter | null>(null);
export const runtimeAdapterStatus = writable<RuntimeAdapterStatus>('disconnected');
export const runtimeAdapterHeight = writable<number>(0);
export const runtimeAdapterAuthLevel = writable<RuntimeAdapterAuthLevel | null>(null);

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error || 'Runtime adapter error');

export const connectRuntimeAdapter = async (config: RuntimeAdapterConfig): Promise<RuntimeAdapter> => {
  const current = get(runtimeAdapter);
  current?.disconnect();

  let adapter: RuntimeAdapter;
  if (config.mode === 'remote') {
    adapter = new RemoteRuntimeAdapter();
  } else {
    const xln = await getXLN();
    if (!getEnv()) {
      const env = await xln.main();
      setXlnEnvironment(env);
    }
    adapter = new xln.EmbeddedRuntimeAdapter({
      getEnv,
      enqueueRuntimeInput: (env, input) => xln.enqueueRuntimeInput(env, input),
      registerEnvChangeCallback: (env, cb) => xln.registerEnvChangeCallback(env, cb),
    });
  }

  adapter.onStatus((status) => runtimeAdapterStatus.set(status));
  adapter.onChange((height) => runtimeAdapterHeight.set(height));
  await adapter.connect(config);
  runtimeAdapter.set(adapter);
  runtimeAdapterStatus.set(adapter.status);
  runtimeAdapterHeight.set(adapter.currentHeight);
  runtimeAdapterAuthLevel.set(adapter.authLevel);
  return adapter;
};

export const disconnectRuntimeAdapter = (): void => {
  const adapter = get(runtimeAdapter);
  adapter?.disconnect();
  runtimeAdapter.set(null);
  runtimeAdapterStatus.set('disconnected');
  runtimeAdapterHeight.set(0);
  runtimeAdapterAuthLevel.set(null);
};

export const runtimeAdapterRead = async <T = unknown>(
  path: string,
  query?: RuntimeAdapterReadQuery,
): Promise<T> => {
  const adapter = get(runtimeAdapter);
  if (!adapter) throw new Error('Runtime adapter is not connected');
  return adapter.read<T>(path, query);
};

export const createRuntimeReadStore = <T = unknown>(
  path: string,
  query?: RuntimeAdapterReadQuery,
) => {
  const store = writable<RuntimeReadState<T>>({
    loading: true,
    data: null,
    error: null,
    height: get(runtimeAdapterHeight),
  });

  let disposed = false;
  let refreshVersion = 0;
  const refresh = async () => {
    const adapter = get(runtimeAdapter);
    const version = ++refreshVersion;
    if (!adapter) {
      store.set({ loading: false, data: null, error: 'Runtime adapter is not connected', height: 0 });
      return;
    }
    store.update((state) => ({ ...state, loading: true, error: null }));
    try {
      const data = await adapter.read<T>(path, query);
      if (disposed || version !== refreshVersion) return;
      store.set({ loading: false, data, error: null, height: adapter.currentHeight });
    } catch (error) {
      if (disposed || version !== refreshVersion) return;
      store.set({ loading: false, data: null, error: errorMessage(error), height: adapter.currentHeight });
    }
  };

  const unsubscribeHeight = runtimeAdapterHeight.subscribe(() => {
    void refresh();
  });
  const unsubscribeAdapter = runtimeAdapter.subscribe(() => {
    void refresh();
  });
  void refresh();

  return {
    subscribe: store.subscribe,
    refresh,
    destroy: () => {
      disposed = true;
      unsubscribeHeight();
      unsubscribeAdapter();
    },
  };
};
