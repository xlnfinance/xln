import { replaceState } from '$app/navigation';
import { get } from 'svelte/store';
import type { RuntimeHandle } from '$lib/stores/runtimeControllerStore';
import {
  getRuntimeControllerAdapter,
  isRuntimeControllerConfigCurrent,
  onRuntimeControllerStatus,
  runtimeControllerHandle,
} from '$lib/stores/runtimeControllerStore';
import { activeRuntime, vaultOperations } from '$lib/stores/vaultStore';
import { initializeXLN, switchAppRuntimeAdapter } from '$lib/stores/xlnStore';
import {
  REMOTE_RUNTIME_IMPORT_HASH_PARAM,
  persistRemoteRuntimeImports,
  remoteRuntimeIdForWsUrl,
  readRemoteRuntimeTokenAudience,
  resolveStoredRemoteRuntimeAuthKey,
} from './remoteRuntimeImport';
import { normalizeWsConnectUrl } from './wsUrl';

export const REMOTE_ACCEPT_PREFIX = 'xln-remote-runtime-accepted:';

export type RemoteRuntimeRequest = {
  wsUrl: string;
  authKey: string;
  hostLabel: string;
  keyLabel: string;
  acceptKey: string;
  requiresAuthPaste?: boolean;
};

const RUNTIME_PARAM_KEYS = ['runtime', 'adapter', 'ws', 'runtimeWs', 'token', 'authKey', 'key', 'auth'];
const PROJECTION_RUNTIME_CONNECT_TIMEOUT_MS = 6_000;
const PROJECTION_RUNTIME_REQUEST_TIMEOUT_MS = 5_000;
const PROJECTION_RUNTIME_RECONNECT_MAX_MS = 2_000;

let projectionRuntimeBootstrapPromise: Promise<void> | null = null;

export function normalizeRuntimeWsUrl(value: string): string {
  const parsed = new URL(normalizeWsConnectUrl(String(value || '').trim()));
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('REMOTE_RUNTIME_WS_REQUIRED');
  }
  return parsed.toString();
}

export function describeAuthKey(key: string): string {
  if (!key) return 'no key';
  if (key.startsWith('xlnra1.read.')) return 'read capability';
  if (key.startsWith('xlnra1.full.') || key.startsWith('xlnra1.admin.')) return 'full capability';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export function hostLabelForWsUrl(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return wsUrl;
  }
}

export function remoteAcceptKey(wsUrl: string, authKey: string): string {
  return `${REMOTE_ACCEPT_PREFIX}${wsUrl}|${authKey.slice(0, 16)}|${authKey.slice(-16)}`;
}

export function remoteAccessFromAuthKey(authKey: string): 'read' | 'admin' {
  const role = String(authKey || '').split('.')[1]?.toLowerCase() || '';
  return role === 'admin' || role === 'full' || role === 'write' ? 'admin' : 'read';
}

export function readRemoteRuntimeRequestFromUrl(): RemoteRuntimeRequest | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const mode = String(params.get('runtime') || params.get('adapter') || '').trim().toLowerCase();
  const wsParam = String(params.get('ws') || params.get('runtimeWs') || '').trim();
  if (mode !== 'remote' || !wsParam) return null;
  const keyParam = String(params.get('token') || params.get('authKey') || params.get('key') || params.get('auth') || '').trim();
  const wsUrl = normalizeRuntimeWsUrl(wsParam);
  const authKey = keyParam.startsWith('xlnra1.')
    ? keyParam
    : resolveStoredRemoteRuntimeAuthKey(wsUrl).trim();
  const requiresAuthPaste = !authKey;
  return {
    wsUrl,
    authKey,
    hostLabel: hostLabelForWsUrl(wsUrl),
    keyLabel: requiresAuthPaste ? 'capability must be pasted' : describeAuthKey(authKey),
    acceptKey: remoteAcceptKey(wsUrl, authKey),
    requiresAuthPaste,
  };
}

export function runtimeImportPayloadFromParams(params: URLSearchParams): string {
  return String(
    params.get('runtimeList') ||
    params.get('runtime-list') ||
    params.get('runtimeImport') ||
    params.get(REMOTE_RUNTIME_IMPORT_HASH_PARAM) ||
    params.get('runtimes') ||
    params.get('remote-runtimes') ||
    params.get('xlnRemoteRuntimes') ||
    '',
  ).trim();
}

export function readRemoteRuntimeImportPayloadFromUrl(): string {
  if (typeof window === 'undefined') return '';
  return runtimeImportPayloadFromParams(new URLSearchParams(window.location.search));
}

export function readRemoteRuntimeImportPayloadFromHash(): string {
  if (typeof window === 'undefined') return '';
  const rawHash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const hash = rawHash.trim();
  if (!hash) return '';
  const params = new URLSearchParams(hash.startsWith('?') ? hash.slice(1) : hash);
  return runtimeImportPayloadFromParams(params);
}

export function persistRemoteRuntimeRequest(request: RemoteRuntimeRequest): void {
  localStorage.setItem('xln-runtime-adapter-mode', 'remote');
  localStorage.setItem('xln-runtime-adapter-ws', request.wsUrl);
  const access = remoteAccessFromAuthKey(request.authKey);
  localStorage.setItem('xln-runtime-adapter-access', access);
  localStorage.removeItem('xln-runtime-adapter-key');
  if (request.authKey) {
    sessionStorage.setItem('xln-runtime-adapter-key', request.authKey);
    persistRemoteRuntimeImports([{
      label: request.hostLabel,
      access,
      wsUrl: request.wsUrl,
      token: request.authKey,
      runtimeId: readRemoteRuntimeTokenAudience(request.authKey) || remoteRuntimeIdForWsUrl(request.wsUrl),
      authLevel: access === 'admin' ? 'admin' : 'inspect',
      height: 0,
      entityCount: 0,
      importedAt: Date.now(),
    }], { merge: true });
  } else {
    sessionStorage.removeItem('xln-runtime-adapter-key');
  }
  sessionStorage.setItem(request.acceptKey, '1');
}

export function hasAcceptedRemoteRuntime(request: RemoteRuntimeRequest): boolean {
  try {
    localStorage.removeItem('xln-runtime-adapter-key');
    return sessionStorage.getItem(request.acceptKey) === '1';
  } catch {
    return false;
  }
}

export function stripRemoteRuntimeParamsFromHistory(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  for (const key of RUNTIME_PARAM_KEYS) {
    url.searchParams.delete(key);
  }
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  setTimeout(() => {
    try {
      replaceState(nextPath, {});
    } catch {
      window.history.replaceState(window.history.state, '', nextPath);
    }
  }, 0);
}

function waitForRuntimeConnected(timeoutMs = PROJECTION_RUNTIME_CONNECT_TIMEOUT_MS): Promise<RuntimeHandle> {
  const current = get(runtimeControllerHandle);
  if (current.status === 'connected') return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      const handle = get(runtimeControllerHandle);
      reject(new Error(`Runtime adapter did not connect within ${timeoutMs}ms; status=${handle.status}`));
    }, timeoutMs);
    const unsubscribe = onRuntimeControllerStatus((status) => {
      if (status !== 'connected') return;
      clearTimeout(timer);
      unsubscribe();
      resolve(get(runtimeControllerHandle));
    });
  });
}

function hasStoredRemoteRuntimePreference(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const rawMode = String(
    params.get('runtime') ||
    params.get('adapter') ||
    localStorage.getItem('xln-runtime-adapter-mode') ||
    '',
  ).trim().toLowerCase();
  return rawMode === 'remote' || rawMode === 'ws' || params.has('ws') || params.has('runtimeWs');
}

async function runProjectionRuntimeBootstrap(task: () => Promise<void>): Promise<void> {
  if (!projectionRuntimeBootstrapPromise) {
    projectionRuntimeBootstrapPromise = task().finally(() => {
      projectionRuntimeBootstrapPromise = null;
    });
  }
  await projectionRuntimeBootstrapPromise;
}

export async function ensureProjectionRuntimeConnected(): Promise<RuntimeHandle> {
  const request = readRemoteRuntimeRequestFromUrl();
  if (request?.requiresAuthPaste) {
    throw new Error('Remote runtime link is missing a capability token. Open /app to paste the token, or pass token=xlnra1...');
  }
  if (request) {
    persistRemoteRuntimeRequest(request);
    stripRemoteRuntimeParamsFromHistory();
    const config = {
      mode: 'remote' as const,
      wsUrl: request.wsUrl,
      ...(request.authKey ? { authKey: request.authKey } : {}),
      requestTimeoutMs: PROJECTION_RUNTIME_REQUEST_TIMEOUT_MS,
      reconnectMaxMs: PROJECTION_RUNTIME_RECONNECT_MAX_MS,
    };
    if (!isRuntimeControllerConfigCurrent(config) || get(runtimeControllerHandle).status !== 'connected') {
      await runProjectionRuntimeBootstrap(async () => {
        await switchAppRuntimeAdapter(config);
      });
    }
    return waitForRuntimeConnected();
  }

  const currentAdapter = getRuntimeControllerAdapter();
  const currentHandle = get(runtimeControllerHandle);
  if (currentAdapter && currentHandle.status === 'connected') return currentHandle;
  if (currentAdapter) return waitForRuntimeConnected();

  if (!hasStoredRemoteRuntimePreference()) {
    await runProjectionRuntimeBootstrap(async () => {
      await vaultOperations.initialize();
      const runtime = get(activeRuntime);
      if (!runtime?.id) {
        await initializeXLN();
        return;
      }
      await switchAppRuntimeAdapter({
        mode: 'embedded',
        runtimeId: runtime.id,
        seed: runtime.seed,
      });
    });
    const vaultAdapter = getRuntimeControllerAdapter();
    if (vaultAdapter) return waitForRuntimeConnected();
  }

  await runProjectionRuntimeBootstrap(async () => {
    await initializeXLN();
  });
  const nextAdapter = getRuntimeControllerAdapter();
  if (!nextAdapter) throw new Error('Runtime adapter is not connected');
  return waitForRuntimeConnected();
}
