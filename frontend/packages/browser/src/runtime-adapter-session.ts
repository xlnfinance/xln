import type { RemoteRuntimeRequest } from '../../runtime-client/src/remote-runtime-request';

export const RUNTIME_ADAPTER_MODE_KEY = 'xln-runtime-adapter-mode';
export const RUNTIME_ADAPTER_WS_KEY = 'xln-runtime-adapter-ws';
export const RUNTIME_ADAPTER_ACCESS_KEY = 'xln-runtime-adapter-access';
export const RUNTIME_ADAPTER_AUTH_KEY = 'xln-runtime-adapter-key';

type RuntimeAdapterStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type RuntimeAdapterSessionStores = Readonly<{
  durable: RuntimeAdapterStorage;
  session: RuntimeAdapterStorage;
}>;

export type RuntimeAdapterStorageSnapshot = Readonly<{
  mode: string | null;
  wsUrl: string | null;
  access: string | null;
  sessionKey: string | null;
}>;

export type RemoteRuntimeAdapterSession = Readonly<{
  wsUrl: string;
  access: string;
  authKey?: string;
}>;

type ValidatedRemoteRuntimeAdapterSession = Readonly<{
  wsUrl: string;
  access: 'admin';
  authKey: string;
}>;

const writeStorageValue = (
  storage: RuntimeAdapterStorage,
  key: string,
  value: string | null,
): void => {
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
};

const validatedRemoteRuntimeSession = (
  input: RemoteRuntimeAdapterSession,
): ValidatedRemoteRuntimeAdapterSession => {
  const wsUrl = input.wsUrl.trim();
  if (!wsUrl) throw new Error('REMOTE_RUNTIME_SESSION_WS_REQUIRED');
  if (input.access !== 'admin') throw new Error('REMOTE_RUNTIME_SESSION_ADMIN_REQUIRED');
  return { wsUrl, access: 'admin', authKey: input.authKey?.trim() || '' };
};

export const writeRemoteRuntimeAdapterSession = (
  stores: RuntimeAdapterSessionStores,
  input: RemoteRuntimeAdapterSession,
): void => {
  const session = validatedRemoteRuntimeSession(input);
  stores.durable.setItem(RUNTIME_ADAPTER_MODE_KEY, 'remote');
  stores.durable.setItem(RUNTIME_ADAPTER_WS_KEY, session.wsUrl);
  stores.durable.setItem(RUNTIME_ADAPTER_ACCESS_KEY, session.access);
  writeRemoteRuntimeAdapterAuth(stores, session.authKey);
};

export const readRemoteRuntimeAdapterAuth = (
  stores: RuntimeAdapterSessionStores,
): string => {
  stores.durable.removeItem(RUNTIME_ADAPTER_AUTH_KEY);
  return stores.session.getItem(RUNTIME_ADAPTER_AUTH_KEY)?.trim() || '';
};

export const writeRemoteRuntimeAdapterAuth = (
  stores: RuntimeAdapterSessionStores,
  authKey: string,
): void => {
  stores.durable.removeItem(RUNTIME_ADAPTER_AUTH_KEY);
  writeStorageValue(stores.session, RUNTIME_ADAPTER_AUTH_KEY, authKey.trim() || null);
};

export const writeEmbeddedRuntimeAdapterSession = (
  stores: RuntimeAdapterSessionStores,
): void => {
  stores.durable.setItem(RUNTIME_ADAPTER_MODE_KEY, 'embedded');
  stores.durable.removeItem(RUNTIME_ADAPTER_WS_KEY);
  stores.durable.removeItem(RUNTIME_ADAPTER_ACCESS_KEY);
  stores.durable.removeItem(RUNTIME_ADAPTER_AUTH_KEY);
  stores.session.removeItem(RUNTIME_ADAPTER_AUTH_KEY);
};

export const readRuntimeAdapterStorageSnapshot = (
  stores: RuntimeAdapterSessionStores,
): RuntimeAdapterStorageSnapshot => ({
  mode: stores.durable.getItem(RUNTIME_ADAPTER_MODE_KEY),
  wsUrl: stores.durable.getItem(RUNTIME_ADAPTER_WS_KEY),
  access: stores.durable.getItem(RUNTIME_ADAPTER_ACCESS_KEY),
  sessionKey: stores.session.getItem(RUNTIME_ADAPTER_AUTH_KEY),
});

export const restoreRuntimeAdapterStorageSnapshot = (
  stores: RuntimeAdapterSessionStores,
  snapshot: RuntimeAdapterStorageSnapshot,
): void => {
  writeStorageValue(stores.durable, RUNTIME_ADAPTER_MODE_KEY, snapshot.mode);
  writeStorageValue(stores.durable, RUNTIME_ADAPTER_WS_KEY, snapshot.wsUrl);
  writeStorageValue(stores.durable, RUNTIME_ADAPTER_ACCESS_KEY, snapshot.access);
  writeRemoteRuntimeAdapterAuth(stores, snapshot.sessionKey || '');
};

export const isRemoteRuntimeAdapterPreferred = (durable: RuntimeAdapterStorage): boolean =>
  durable.getItem(RUNTIME_ADAPTER_MODE_KEY) === 'remote';

export const markRemoteRuntimeRequestAccepted = (
  session: RuntimeAdapterStorage,
  request: RemoteRuntimeRequest,
): void => {
  if (!request.acceptKey.trim()) throw new Error('REMOTE_RUNTIME_ACCEPT_KEY_REQUIRED');
  session.setItem(request.acceptKey, '1');
};

export const hasAcceptedRemoteRuntimeRequest = (
  stores: RuntimeAdapterSessionStores,
  request: RemoteRuntimeRequest,
): boolean => {
  try {
    stores.durable.removeItem(RUNTIME_ADAPTER_AUTH_KEY);
    return stores.session.getItem(request.acceptKey) === '1';
  } catch {
    return false;
  }
};
