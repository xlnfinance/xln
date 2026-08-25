import { writable } from 'svelte/store';
import type {
  RuntimeAdapter,
  RuntimeAdapterConfig,
  RuntimeAdapterSendResult,
  RuntimeAdapterStatus,
  RuntimeInput,
} from '@xln/core/api/public/runtime-module';
import type { RuntimeAdapterSendOptions } from '@xln/core/api/runtime-adapter/types';
import { RemoteRuntimeAdapter } from '../../../../core/api/runtime-adapter/remote';
import {
  createRuntimeHandle,
  normalizeRuntimeHandleId,
  runtimeAdapterConfigsMatch,
  type RuntimeHandle,
} from '../../../packages/runtime-client/src/runtime-handle';

export type { RuntimeHandle };

type RuntimeControllerConnectDeps = {
  createEmbeddedAdapter?: () => Promise<RuntimeAdapter> | RuntimeAdapter;
};

const emptyHandle = createRuntimeHandle({ adapter: null, config: null, pendingRuntimeId: '' });

export const runtimeAdapter = writable<RuntimeAdapter | null>(null);
export const runtimeControllerHandle = writable<RuntimeHandle>(emptyHandle);
export const runtimeControllerConfig = writable<RuntimeAdapterConfig | null>(null);
export const runtimeAdapterStatus = writable<RuntimeAdapterStatus>('disconnected');
export const runtimeAdapterHeight = writable<number>(0);

let activeAdapter: RuntimeAdapter | null = null;
let activeConfig: RuntimeAdapterConfig | null = null;
let pendingRuntimeId = '';
let unregisterAdapterStatus: (() => void) | null = null;
let unregisterAdapterChange: (() => void) | null = null;
const changeCbs = new Set<(height: number) => void>();
const statusCbs = new Set<(status: RuntimeAdapterStatus) => void>();

const publishRuntimeAdapterState = (adapter: RuntimeAdapter | null = activeAdapter): void => {
  const handle = createRuntimeHandle({
    adapter,
    config: activeConfig,
    pendingRuntimeId,
  });
  runtimeAdapterStatus.set(handle.status);
  runtimeAdapterHeight.set(handle.height);
  runtimeControllerHandle.set(handle);
};

export const setRuntimeControllerPendingRuntimeId = (id: string): void => {
  pendingRuntimeId = normalizeRuntimeHandleId(id);
  runtimeControllerHandle.update((handle) => ({ ...handle, pendingRuntimeId }));
};

export const getRuntimeControllerAdapter = (): RuntimeAdapter | null => activeAdapter;

export const getRuntimeControllerConfig = (): RuntimeAdapterConfig | null => activeConfig;

export const isRuntimeControllerConfigCurrent = (config: RuntimeAdapterConfig): boolean =>
  runtimeAdapterConfigsMatch(activeConfig, config);

export const onRuntimeControllerChange = (cb: (height: number) => void): (() => void) => {
  changeCbs.add(cb);
  return () => changeCbs.delete(cb);
};

export const onRuntimeControllerStatus = (cb: (status: RuntimeAdapterStatus) => void): (() => void) => {
  statusCbs.add(cb);
  return () => statusCbs.delete(cb);
};

const emitStatus = (status: RuntimeAdapterStatus): void => {
  for (const cb of statusCbs) cb(status);
};

const emitChange = (height: number): void => {
  for (const cb of changeCbs) cb(height);
};

export const connectRuntimeAdapter = async (
  config: RuntimeAdapterConfig,
  deps: RuntimeControllerConnectDeps = {},
): Promise<RuntimeAdapter> => {
  const previous = activeAdapter;
  previous?.disconnect();
  unregisterAdapterStatus?.();
  unregisterAdapterChange?.();
  unregisterAdapterStatus = null;
  unregisterAdapterChange = null;
  activeAdapter = null;
  activeConfig = null;
  runtimeAdapter.set(null);
  runtimeControllerConfig.set(null);
  publishRuntimeAdapterState(null);

  const adapter = config.mode === 'remote'
    ? new RemoteRuntimeAdapter()
    : await deps.createEmbeddedAdapter?.();
  if (!adapter) throw new Error('RuntimeController embedded adapter factory is required');

  activeConfig = config;
  activeAdapter = adapter;
  runtimeControllerConfig.set(config);
  runtimeAdapter.set(adapter);
  publishRuntimeAdapterState(adapter);

  unregisterAdapterStatus = adapter.onStatus((status) => {
    publishRuntimeAdapterState(adapter);
    emitStatus(status);
  });
  unregisterAdapterChange = adapter.onChange((height) => {
    publishRuntimeAdapterState(adapter);
    emitChange(height);
  });

  try {
    await adapter.connect(config);
    publishRuntimeAdapterState(adapter);
    return adapter;
  } catch (error) {
    publishRuntimeAdapterState(adapter);
    throw error;
  }
};

export const disconnectRuntimeAdapter = (): void => {
  activeAdapter?.disconnect();
  unregisterAdapterStatus?.();
  unregisterAdapterChange?.();
  unregisterAdapterStatus = null;
  unregisterAdapterChange = null;
  activeAdapter = null;
  activeConfig = null;
  runtimeAdapter.set(null);
  runtimeControllerConfig.set(null);
  publishRuntimeAdapterState(null);
};

export const runtimeAdapterSend = async (
  input: RuntimeInput,
  options: RuntimeAdapterSendOptions = {},
): Promise<RuntimeAdapterSendResult> => {
  const adapter = activeAdapter;
  if (!adapter) throw new Error('Runtime adapter is not connected');
  return adapter.send(input, options);
};
