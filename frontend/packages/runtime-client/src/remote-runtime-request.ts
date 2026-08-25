import { REMOTE_RUNTIME } from '../../../../core/config/constants';
import { normalizeWsConnectUrl } from './ws-url';

export const REMOTE_ACCEPT_PREFIX = 'xln-remote-runtime-accepted:';
export const REMOTE_RUNTIME_IMPORT_HASH_PARAM = REMOTE_RUNTIME.IMPORT_HASH_PARAM;
export const REMOTE_RUNTIME_IMPORT_SOURCE_HASH_PARAM = REMOTE_RUNTIME.IMPORT_SOURCE_HASH_PARAM;

export type RemoteRuntimeRequest = Readonly<{
  wsUrl: string;
  authKey: string;
  hostLabel: string;
  keyLabel: string;
  acceptKey: string;
  requiresAuthPaste?: boolean;
}>;

export type RemoteRuntimeLocation = Readonly<{
  search: string;
  hash: string;
}>;

export type RemoteRuntimeRequestDependencies = Readonly<{
  resolveStoredAuthKey: (wsUrl: string) => string;
}>;

const RUNTIME_IMPORT_PARAM_KEYS = [
  REMOTE_RUNTIME_IMPORT_HASH_PARAM,
  REMOTE_RUNTIME_IMPORT_SOURCE_HASH_PARAM,
] as const;

export const normalizeRuntimeWsUrl = (value: string): string => {
  const parsed = new URL(normalizeWsConnectUrl(String(value || '').trim()));
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('REMOTE_RUNTIME_WS_REQUIRED');
  }
  return parsed.toString();
};

export const describeAuthKey = (key: string): string => {
  if (!key) return 'no key';
  if (key.startsWith('xlnra1.full.') || key.startsWith('xlnra1.admin.')) {
    return 'full capability';
  }
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
};

export const hostLabelForWsUrl = (wsUrl: string): string => {
  try {
    const parsed = new URL(wsUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return wsUrl;
  }
};

export const remoteAcceptKey = (wsUrl: string, authKey: string): string =>
  `${REMOTE_ACCEPT_PREFIX}${wsUrl}|${authKey.slice(0, 16)}|${authKey.slice(-16)}`;

export const remoteAccessFromAuthKey = (authKey: string): 'admin' => {
  const role = String(authKey || '').split('.')[1]?.toLowerCase() || '';
  if (role !== 'admin' && role !== 'full' && role !== 'write') {
    throw new Error('REMOTE_RUNTIME_ADMIN_CAPABILITY_REQUIRED');
  }
  return 'admin';
};

export const hasRemoteRuntimeQueryBootstrap = (search: string): boolean => {
  const query = new URLSearchParams(search);
  return RUNTIME_IMPORT_PARAM_KEYS.some((key) => query.has(key));
};

export const decodeRemoteRuntimeRequest = (
  location: RemoteRuntimeLocation,
  dependencies: RemoteRuntimeRequestDependencies,
): RemoteRuntimeRequest | null => {
  if (hasRemoteRuntimeQueryBootstrap(location.search)) {
    throw new Error('REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN');
  }

  const hash = new URLSearchParams(location.hash.replace(/^#\??/, ''));
  const mode = String(hash.get('runtime') || hash.get('adapter') || '').trim().toLowerCase();
  const wsParam = String(hash.get('ws') || hash.get('runtimeWs') || '').trim();
  if (mode !== 'remote' || !wsParam) return null;

  const keyParam = String(
    hash.get('token') || hash.get('authKey') || hash.get('key') || hash.get('auth') || '',
  ).trim();
  const wsUrl = normalizeRuntimeWsUrl(wsParam);
  const authKey = keyParam.startsWith('xlnra1.')
    ? keyParam
    : dependencies.resolveStoredAuthKey(wsUrl).trim();
  const requiresAuthPaste = !authKey;
  return {
    wsUrl,
    authKey,
    hostLabel: hostLabelForWsUrl(wsUrl),
    keyLabel: requiresAuthPaste ? 'capability must be pasted' : describeAuthKey(authKey),
    acceptKey: remoteAcceptKey(wsUrl, authKey),
    requiresAuthPaste,
  };
};

export const runtimeImportPayloadFromParams = (params: URLSearchParams): string =>
  String(params.get(REMOTE_RUNTIME_IMPORT_HASH_PARAM) || '').trim();

export const runtimeImportSourceFromParams = (params: URLSearchParams): string =>
  String(params.get(REMOTE_RUNTIME_IMPORT_SOURCE_HASH_PARAM) || '').trim();

const runtimeImportParamsFromHash = (rawHash: string): URLSearchParams | null => {
  const hash = rawHash.replace(/^#/, '').trim();
  if (!hash) return null;
  return new URLSearchParams(hash.startsWith('?') ? hash.slice(1) : hash);
};

export const runtimeImportPayloadFromHash = (rawHash: string): string => {
  const params = runtimeImportParamsFromHash(rawHash);
  return params ? runtimeImportPayloadFromParams(params) : '';
};

export const runtimeImportSourceFromHash = (rawHash: string): string => {
  const params = runtimeImportParamsFromHash(rawHash);
  return params ? runtimeImportSourceFromParams(params) : '';
};

export const remoteRuntimeRequestRequiresConsent = (
  request: RemoteRuntimeRequest,
  accepted: boolean,
): boolean => request.requiresAuthPaste === true || !accepted;

export const removeRemoteRuntimeImportParams = (rawHref: string): string => {
  const url = new URL(rawHref);
  for (const key of RUNTIME_IMPORT_PARAM_KEYS) url.searchParams.delete(key);

  const rawHash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  if (rawHash.trim()) {
    const hashParams = new URLSearchParams(rawHash);
    let changed = false;
    for (const key of RUNTIME_IMPORT_PARAM_KEYS) {
      if (!hashParams.has(key)) continue;
      hashParams.delete(key);
      changed = true;
    }
    if (changed) {
      const nextHash = hashParams.toString();
      url.hash = nextHash ? `#${nextHash}` : '';
    }
  }
  return `${url.pathname}${url.search}${url.hash}`;
};
