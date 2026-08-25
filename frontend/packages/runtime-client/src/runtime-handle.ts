import { sameWsEndpoint } from './ws-url';

export type RuntimeAdapterMode = 'embedded' | 'remote';
export type RuntimeAdapterStatus = 'connected' | 'connecting' | 'disconnected' | 'error';
export type RuntimeAdapterAuthLevel = 'inspect' | 'admin';

export type RuntimeAdapterConfigSnapshot = Readonly<{
  mode: RuntimeAdapterMode;
  runtimeId?: string;
  wsUrl?: string;
}>;

export type RuntimeHandle = Readonly<{
  id: string;
  runtimeId: string;
  pendingRuntimeId: string;
  mode: RuntimeAdapterMode;
  endpoint: string;
  permissions: 'read' | 'write';
  status: RuntimeAdapterStatus;
  height: number;
  authLevel: RuntimeAdapterAuthLevel | null;
  commandReady: boolean;
  commandReadyReason: string | null;
}>;

export type RuntimeAdapterHandleSnapshot = Readonly<{
  runtimeId: string;
  status: RuntimeAdapterStatus;
  currentHeight: number;
  authLevel: RuntimeAdapterAuthLevel | null;
  commandReady: boolean;
  commandReadyReason: string | null;
}>;

export type RuntimeHandleInput = Readonly<{
  adapter: RuntimeAdapterHandleSnapshot | null;
  config: RuntimeAdapterConfigSnapshot | null;
  pendingRuntimeId: string;
}>;

export const normalizeRuntimeHandleId = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

export const runtimeAdapterConfigEndpoint = (
  config: RuntimeAdapterConfigSnapshot | null,
): string => config?.mode === 'remote' ? String(config.wsUrl || '') : 'embedded';

export const runtimeAdapterConfigId = (
  config: RuntimeAdapterConfigSnapshot | null,
): string => {
  const runtimeId = normalizeRuntimeHandleId(config?.runtimeId);
  if (runtimeId) return runtimeId;
  return config?.mode === 'remote'
    ? `radapter:${config.wsUrl || 'remote'}`.toLowerCase()
    : 'embedded';
};

export const runtimeAdapterId = (
  adapter: RuntimeAdapterHandleSnapshot | null,
  config: RuntimeAdapterConfigSnapshot | null,
): string => normalizeRuntimeHandleId(adapter?.runtimeId) || runtimeAdapterConfigId(config);

export const runtimeAdapterConfigsMatch = (
  current: RuntimeAdapterConfigSnapshot | null,
  next: RuntimeAdapterConfigSnapshot,
): boolean => {
  if (!current || current.mode !== next.mode) return false;
  const currentRuntimeId = normalizeRuntimeHandleId(current.runtimeId);
  const nextRuntimeId = normalizeRuntimeHandleId(next.runtimeId);
  if (currentRuntimeId || nextRuntimeId) return currentRuntimeId === nextRuntimeId;
  if (next.mode !== 'remote') return true;
  if (!current.wsUrl || !next.wsUrl) return current.wsUrl === next.wsUrl;
  return sameWsEndpoint(current.wsUrl, next.wsUrl);
};

export const createRuntimeHandle = ({
  adapter,
  config,
  pendingRuntimeId,
}: RuntimeHandleInput): RuntimeHandle => {
  const status = adapter?.status ?? 'disconnected';
  const authLevel = adapter?.authLevel ?? null;
  const id = runtimeAdapterId(adapter, config);
  return {
    id,
    runtimeId: id,
    pendingRuntimeId: normalizeRuntimeHandleId(pendingRuntimeId),
    mode: config?.mode ?? 'embedded',
    endpoint: runtimeAdapterConfigEndpoint(config),
    permissions: config?.mode === 'remote' && authLevel !== 'admin' ? 'read' : 'write',
    status,
    height: Math.max(0, Math.floor(Number(adapter?.currentHeight || 0))),
    authLevel,
    commandReady: adapter?.commandReady ?? false,
    commandReadyReason: adapter?.commandReadyReason ?? 'adapter-disconnected',
  };
};
