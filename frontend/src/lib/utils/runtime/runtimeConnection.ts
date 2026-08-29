import { replaceState } from '$app/navigation';
import { get } from 'svelte/store';
import {
  getRuntimeControllerAdapter,
  isRuntimeControllerConfigCurrent,
  onRuntimeControllerStatus,
  runtimeControllerHandle,
} from '$lib/stores/runtimeControllerStore';
import { activeRuntime, vaultOperations } from '$lib/stores/vault/vaultStore';
import { initializeXLN, suspendClientActivity, switchAppRuntimeAdapter } from '$lib/stores/xlnStore';
import {
  adoptActiveTabLock,
  ownsActiveTabLock,
  tryInitializeActiveTabLock,
  waitForActiveTabLockLoss,
} from '../control/activeTabLock';
import {
  persistRemoteRuntimeImports,
  remoteRuntimeIdForWsUrl,
  readRemoteRuntimeTokenAudience,
  resolveStoredRemoteRuntimeAuthKey,
} from '../onboarding/remoteRuntimeImport';
import {
  decodeRemoteRuntimeRequest,
  hasRemoteRuntimeQueryBootstrap,
  remoteAccessFromAuthKey,
  remoteRuntimeRequestRequiresConsent,
  removeRemoteRuntimeImportParams,
  runtimeImportPayloadFromHash,
  runtimeImportSourceFromHash,
} from '../../../../packages/runtime-client/src/remote-runtime-request';
import type { RemoteRuntimeRequest } from '../../../../packages/runtime-client/src/remote-runtime-request';
import type { RuntimeHandle } from '../../../../packages/runtime-client/src/runtime-handle';
import {
  hasAcceptedRemoteRuntimeRequest,
  isRemoteRuntimeAdapterPreferred,
  markRemoteRuntimeRequestAccepted,
  writeRemoteRuntimeAdapterSession,
} from '../../../../packages/browser/src/runtime-adapter-session';

export {
  REMOTE_ACCEPT_PREFIX,
  describeAuthKey,
  hostLabelForWsUrl,
  normalizeRuntimeWsUrl,
  remoteAcceptKey,
  remoteAccessFromAuthKey,
  runtimeImportPayloadFromParams,
  runtimeImportSourceFromParams,
} from '../../../../packages/runtime-client/src/remote-runtime-request';
export type { RemoteRuntimeRequest } from '../../../../packages/runtime-client/src/remote-runtime-request';

const PROJECTION_RUNTIME_CONNECT_TIMEOUT_MS = 6_000;
const PROJECTION_RUNTIME_REQUEST_TIMEOUT_MS = 5_000;
const PROJECTION_RUNTIME_RECONNECT_MAX_MS = 2_000;

let projectionRuntimeBootstrapPromise: Promise<void> | null = null;
let projectionRuntimeLockPromise: Promise<void> | null = null;
let projectionRuntimeLockRelease: (() => void) | null = null;

const suspendProjectionRuntime = async (): Promise<void> => {
  await vaultOperations.suspendAllRuntimeActivity();
  await suspendClientActivity();
};

const ensureProjectionEmbeddedRuntimeOwnership = async (): Promise<void> => {
  await waitForActiveTabLockLoss();
  if (ownsActiveTabLock()) {
    projectionRuntimeLockRelease = adoptActiveTabLock(suspendProjectionRuntime)
      ?? projectionRuntimeLockRelease;
    return;
  }
  if (projectionRuntimeLockRelease) {
    projectionRuntimeLockRelease();
    projectionRuntimeLockRelease = null;
  }
  projectionRuntimeLockPromise ??= (async () => {
    const release = adoptActiveTabLock(suspendProjectionRuntime)
      ?? await tryInitializeActiveTabLock(suspendProjectionRuntime);
    if (!release) {
      await suspendProjectionRuntime();
      throw new Error('LOCAL_RUNTIME_ACTIVE_IN_ANOTHER_TAB');
    }
    projectionRuntimeLockRelease = release;
  })().finally(() => {
    projectionRuntimeLockPromise = null;
  });
  await projectionRuntimeLockPromise;
};

/**
 * Persist a runtime adapter session opened outside the URL-import flow (the
 * /health adapter panel). Same confinement contract as the import flow: the
 * capability lives only in sessionStorage, so it survives same-tab navigation
 * to /app but never outlives the tab.
 */
export function persistRuntimeAdapterSession(wsUrl: string, authKey: string): void {
  if (typeof window === 'undefined') return;
  writeRemoteRuntimeAdapterSession({ durable: localStorage, session: sessionStorage }, {
    wsUrl,
    access: remoteAccessFromAuthKey(authKey),
    authKey,
  });
}

export function readRemoteRuntimeRequestFromUrl(): RemoteRuntimeRequest | null {
  if (typeof window === 'undefined') return null;
  if (hasRemoteRuntimeQueryBootstrap(window.location.search)) {
    stripRemoteRuntimeParamsFromHistory();
    throw new Error('REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN');
  }
  return decodeRemoteRuntimeRequest(
    { search: window.location.search, hash: window.location.hash },
    { resolveStoredAuthKey: resolveStoredRemoteRuntimeAuthKey },
  );
}

export function readRemoteRuntimeImportPayloadFromHash(): string {
  if (typeof window === 'undefined') return '';
  return runtimeImportPayloadFromHash(window.location.hash);
}

export function readRemoteRuntimeImportSourceFromHash(): string {
  if (typeof window === 'undefined') return '';
  return runtimeImportSourceFromHash(window.location.hash);
}

export function persistRemoteRuntimeRequest(request: RemoteRuntimeRequest): void {
  const access = remoteAccessFromAuthKey(request.authKey);
  writeRemoteRuntimeAdapterSession({ durable: localStorage, session: sessionStorage }, {
    wsUrl: request.wsUrl,
    access,
    ...(request.authKey ? { authKey: request.authKey } : {}),
  });
  if (request.authKey) {
    persistRemoteRuntimeImports([{
      label: request.hostLabel,
      access,
      wsUrl: request.wsUrl,
      token: request.authKey,
      runtimeId: readRemoteRuntimeTokenAudience(request.authKey) || remoteRuntimeIdForWsUrl(request.wsUrl),
      authLevel: 'admin',
      height: 0,
      entityCount: 0,
      importedAt: Date.now(),
    }], { merge: true });
  }
  markRemoteRuntimeRequestAccepted(sessionStorage, request);
}

export function hasAcceptedRemoteRuntime(request: RemoteRuntimeRequest): boolean {
  return hasAcceptedRemoteRuntimeRequest(
    { durable: localStorage, session: sessionStorage },
    request,
  );
}

export function remoteRuntimeRequiresConsent(request: RemoteRuntimeRequest): boolean {
  return remoteRuntimeRequestRequiresConsent(request, hasAcceptedRemoteRuntime(request));
}

export function stripRemoteRuntimeParamsFromHistory(): void {
  if (typeof window === 'undefined') return;
  const nextPath = removeRemoteRuntimeImportParams(window.location.href);
  try {
    replaceState(nextPath, {});
  } catch {
    window.history.replaceState(window.history.state, '', nextPath);
  }
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
  return isRemoteRuntimeAdapterPreferred(localStorage);
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
    throw new Error('Remote runtime link is missing a capability token. Open /app and paste a fresh capability.');
  }
  // A valid capability authenticates the remote Runtime; it does not prove the
  // user chose to switch this tab to it. Only /app owns that consent UI. If a
  // projection route persisted first, it would also set the accept bit and
  // turn an attacker-supplied /address or /health link into durable consent.
  if (request && remoteRuntimeRequiresConsent(request)) {
    throw new Error('REMOTE_RUNTIME_CONSENT_REQUIRED: Open /app and confirm this remote runtime first.');
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
  if (currentAdapter?.mode === 'embedded') {
    await ensureProjectionEmbeddedRuntimeOwnership();
  }
  if (currentAdapter && currentHandle.status === 'connected') return currentHandle;
  if (currentAdapter) return waitForRuntimeConnected();

  if (!hasStoredRemoteRuntimePreference()) {
    await runProjectionRuntimeBootstrap(async () => {
      await ensureProjectionEmbeddedRuntimeOwnership();
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
