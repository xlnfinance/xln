import { get, writable } from 'svelte/store';
import type {
  RuntimeAdapter,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterConfig,
  RuntimeAdapterSendResult,
  RuntimeAdapterStatus,
  RuntimeInput,
} from '@xln/runtime/xln-api';
import type { RuntimeAdapterSendOptions } from '@xln/runtime/radapter/types';
import { RemoteRuntimeAdapter } from '../../../../runtime/radapter/remote';
import { sameWsEndpoint } from '$lib/utils/wsUrl';

export type RuntimeHandle = {
  id: string;
  runtimeId: string;
  pendingRuntimeId: string;
  mode: RuntimeAdapterConfig['mode'];
  endpoint: string;
  permissions: 'read' | 'write';
  status: RuntimeAdapterStatus;
  height: number;
  authLevel: RuntimeAdapterAuthLevel | null;
  commandReady: boolean;
  commandReadyReason: string | null;
};

type RuntimeControllerConnectDeps = {
  createEmbeddedAdapter?: () => Promise<RuntimeAdapter> | RuntimeAdapter;
};

const emptyHandle: RuntimeHandle = {
  id: 'embedded',
  runtimeId: 'embedded',
  pendingRuntimeId: '',
  mode: 'embedded',
  endpoint: 'embedded',
  permissions: 'write',
  status: 'disconnected',
  height: 0,
  authLevel: null,
  commandReady: false,
  commandReadyReason: 'adapter-disconnected',
};

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

const configEndpoint = (config: RuntimeAdapterConfig | null): string =>
  config?.mode === 'remote' ? String(config.wsUrl || '') : 'embedded';

const normalizeRuntimeId = (value: unknown): string => String(value || '').trim().toLowerCase();

const configId = (config: RuntimeAdapterConfig | null): string => {
  const runtimeId = normalizeRuntimeId(config?.runtimeId);
  if (runtimeId) return runtimeId;
  return config?.mode === 'remote' ? `radapter:${config.wsUrl || 'remote'}`.toLowerCase() : 'embedded';
};

const adapterRuntimeId = (adapter: RuntimeAdapter | null, config: RuntimeAdapterConfig | null): string =>
  normalizeRuntimeId(adapter?.runtimeId) || configId(config);

const publishRuntimeAdapterState = (adapter: RuntimeAdapter | null = activeAdapter): void => {
  const config = activeConfig;
  const status = adapter?.status ?? 'disconnected';
  const height = Math.max(0, Math.floor(Number(adapter?.currentHeight || 0)));
  const authLevel = adapter?.authLevel ?? null;
  runtimeAdapterStatus.set(status);
  runtimeAdapterHeight.set(height);
  const id = adapterRuntimeId(adapter, config);
  runtimeControllerHandle.set({
    id,
    runtimeId: id,
    pendingRuntimeId,
    mode: config?.mode ?? 'embedded',
    endpoint: configEndpoint(config),
    permissions: config?.mode === 'remote' ? (authLevel === 'admin' ? 'write' : 'read') : 'write',
    status,
    height,
    authLevel,
    commandReady: adapter?.commandReady ?? false,
    commandReadyReason: adapter?.commandReadyReason ?? 'adapter-disconnected',
  });
};

export const setRuntimeControllerPendingRuntimeId = (id: string): void => {
  pendingRuntimeId = normalizeRuntimeId(id);
  runtimeControllerHandle.update((handle) => ({ ...handle, pendingRuntimeId }));
};

export const getRuntimeControllerAdapter = (): RuntimeAdapter | null => activeAdapter;

export const getRuntimeControllerConfig = (): RuntimeAdapterConfig | null => activeConfig;

export const isRuntimeControllerConfigCurrent = (config: RuntimeAdapterConfig): boolean => {
  const current = activeConfig;
  if (!current || current.mode !== config.mode) return false;
  const currentRuntimeId = normalizeRuntimeId(current.runtimeId);
  const nextRuntimeId = normalizeRuntimeId(config.runtimeId);
  if (currentRuntimeId || nextRuntimeId) return currentRuntimeId === nextRuntimeId;
  if (config.mode !== 'remote') return true;
  if (!current.wsUrl || !config.wsUrl) return current.wsUrl === config.wsUrl;
  return sameWsEndpoint(current.wsUrl, config.wsUrl);
};

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
