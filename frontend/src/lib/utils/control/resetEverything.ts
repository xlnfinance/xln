import { broadcastHardResetRequest } from './activeTabLock';
import { shutdownRuntimeResumeListener, vaultOperations } from '../../stores/vault/vaultStore';

let activeResetPromise: Promise<void> | null = null;

const RESET_TAB_SETTLE_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type ResetEverythingRequest = {
  confirmed: true;
  reason: string;
};

const assertResetConfirmed = (request: unknown): ResetEverythingRequest => {
  if (
    request
    && typeof request === 'object'
    && (request as ResetEverythingRequest).confirmed === true
    && typeof (request as ResetEverythingRequest).reason === 'string'
    && (request as ResetEverythingRequest).reason.trim().length > 0
  ) {
    return request as ResetEverythingRequest;
  }
  throw new Error('RESET_CONFIRMATION_REQUIRED');
};

async function stopCurrentRuntimeActivity(): Promise<void> {
  await vaultOperations.suspendAllRuntimeActivity?.();
  shutdownRuntimeResumeListener?.();
}

function requestOtherTabsShutdown(): void {
  broadcastHardResetRequest();
}

const deleteIndexedDb = (name: string): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase(name);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error ?? new Error(`RESET_INDEXED_DB_DELETE_FAILED:${name}`));
  request.onblocked = () => reject(new Error(`RESET_INDEXED_DB_DELETE_BLOCKED:${name}`));
});

const clearIndexedDatabases = async (): Promise<void> => {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    throw new Error('RESET_INDEXED_DB_ENUMERATION_UNAVAILABLE');
  }
  const databases = await indexedDB.databases();
  const names = databases
    .map(database => database.name?.trim() || '')
    .filter((name): name is string => name.length > 0);
  await Promise.all(names.map(deleteIndexedDb));
};

const clearBrowserCaches = async (): Promise<void> => {
  if (typeof caches === 'undefined') return;
  const names = await caches.keys();
  const deleted = await Promise.all(names.map(name => caches.delete(name)));
  if (deleted.some(result => result !== true)) throw new Error('RESET_CACHE_DELETE_FAILED');
};

const unregisterServiceWorkers = async (): Promise<void> => {
  if (!('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  const deleted = await Promise.all(registrations.map(registration => registration.unregister()));
  if (deleted.some(result => result !== true)) throw new Error('RESET_SERVICE_WORKER_UNREGISTER_FAILED');
};

export const clearBrowserRuntimeData = async (): Promise<void> => {
  await Promise.all([clearIndexedDatabases(), clearBrowserCaches(), unregisterServiceWorkers()]);
  localStorage.clear();
  sessionStorage.clear();
};

export async function resetEverything(request: ResetEverythingRequest): Promise<void> {
  assertResetConfirmed(request);
  if (activeResetPromise) return activeResetPromise;

  const resetPromise = (async () => {
    await stopCurrentRuntimeActivity();
    requestOtherTabsShutdown();
    await sleep(RESET_TAB_SETTLE_MS);
    await clearBrowserRuntimeData();
    window.location.replace('/app');
  })();
  activeResetPromise = resetPromise;

  try {
    await resetPromise;
  } finally {
    if (activeResetPromise === resetPromise) activeResetPromise = null;
  }
}
