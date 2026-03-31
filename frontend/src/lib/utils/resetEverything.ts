let activeResetPromise: Promise<void> | null = null;
const INDEXED_DB_DELETE_TIMEOUT_MS = 2_500;
const INDEXED_DB_DELETE_RETRY_COUNT = 4;
const INDEXED_DB_DELETE_RETRY_DELAY_MS = 150;
const DEFAULT_RESET_RETURN_TO = '/app';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

function listCookieDomains(hostname: string): string[] {
  const parts = hostname.split('.').filter(Boolean);
  const domains = new Set<string>(['', hostname]);
  for (let index = 0; index < parts.length - 1; index += 1) {
    domains.add(`.${parts.slice(index).join('.')}`);
  }
  return Array.from(domains);
}

function clearAllCookies(): void {
  if (typeof document === 'undefined' || !document.cookie) return;

  const expires = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
  const domains = listCookieDomains(window.location.hostname);

  for (const cookie of document.cookie.split(';')) {
    const eqIndex = cookie.indexOf('=');
    const name = (eqIndex >= 0 ? cookie.slice(0, eqIndex) : cookie).trim();
    if (!name) continue;

    const encodedName = encodeURIComponent(name);
    document.cookie = `${encodedName}=; ${expires}; path=/`;

    for (const domain of domains) {
      if (!domain) continue;
      document.cookie = `${encodedName}=; ${expires}; path=/; domain=${domain}`;
    }
  }
}

async function unregisterServiceWorkers(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
}

async function clearCacheStorage(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const names = await caches.keys();
  await Promise.all(names.map((name) => caches.delete(name).catch(() => false)));
}

async function clearOriginPrivateFileSystem(): Promise<void> {
  const storageWithDirectory = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof storageWithDirectory?.getDirectory !== 'function') return;

  const root = await storageWithDirectory.getDirectory();

  // @ts-ignore DOM typing for async directory iteration is still inconsistent.
  for await (const [name] of root.entries()) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch {
      // best effort
    }
  }
}

function getIndexedDbFactory():
  | (IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> })
  | null {
  if (typeof indexedDB === 'undefined') return null;
  return indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
}

async function listIndexedDbNames(): Promise<string[]> {
  const factory = getIndexedDbFactory();
  if (!factory || typeof factory.databases !== 'function') return [];

  const entries = await factory.databases().catch(() => []);
  const names = new Set<string>();

  for (const entry of entries) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (name) names.add(name);
  }

  return Array.from(names).sort((left, right) => left.localeCompare(right));
}

async function deleteIndexedDb(name: string): Promise<'success' | 'error' | 'blocked'> {
  return new Promise((resolve) => {
    const factory = getIndexedDbFactory();
    if (!factory) {
      resolve('error');
      return;
    }

    let blocked = false;
    let settled = false;
    const finish = (status: 'success' | 'error' | 'blocked'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(status);
    };

    const request = factory.deleteDatabase(name);
    const timeoutId = window.setTimeout(() => finish(blocked ? 'blocked' : 'error'), INDEXED_DB_DELETE_TIMEOUT_MS);
    request.onsuccess = () => finish('success');
    request.onerror = () => finish('error');
    request.onblocked = () => {
      blocked = true;
    };
  });
}

async function clearAllIndexedDB(): Promise<void> {
  const factory = getIndexedDbFactory();
  if (!factory) return;
  if (typeof factory.databases !== 'function') {
    throw new Error('indexedDB.databases() unavailable; cannot enumerate all databases');
  }

  const dbNames = await listIndexedDbNames();
  if (dbNames.length === 0) return;

  console.log('[RESET] deleting IndexedDB databases:', dbNames);
  let remaining = dbNames;
  const blockedNames = new Set<string>();
  const failedNames = new Set<string>();

  for (let attempt = 0; attempt < INDEXED_DB_DELETE_RETRY_COUNT && remaining.length > 0; attempt += 1) {
    const statuses = await Promise.all(remaining.map((name) => deleteIndexedDb(name)));
    blockedNames.clear();
    failedNames.clear();

    for (let index = 0; index < remaining.length; index += 1) {
      const name = remaining[index];
      const status = statuses[index];
      if (status === 'blocked') blockedNames.add(name);
      if (status === 'error') failedNames.add(name);
    }

    await sleep(INDEXED_DB_DELETE_RETRY_DELAY_MS * (attempt + 1));
    const existingNames = new Set(await listIndexedDbNames());
    remaining = remaining.filter((name) => existingNames.has(name));
  }

  if (remaining.length > 0) {
    throw new Error(
      `IndexedDB deletion incomplete: remaining=${remaining.join(', ')} blocked=${Array.from(blockedNames).join(', ')} failed=${Array.from(failedNames).join(', ')}`,
    );
  }
}

async function collectRuntimeEnvs(): Promise<unknown[]> {
  const envs: unknown[] = [];
  const seen = new Set<string>();

  const pushEnv = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return;

    const runtimeId =
      typeof (candidate as { runtimeId?: unknown }).runtimeId === 'string'
        ? (candidate as { runtimeId: string }).runtimeId.trim().toLowerCase()
        : '';
    const dbNamespace =
      typeof (candidate as { dbNamespace?: unknown }).dbNamespace === 'string'
        ? (candidate as { dbNamespace: string }).dbNamespace.trim().toLowerCase()
        : '';
    const key = `${runtimeId}|${dbNamespace}`;

    if (key !== '|' && seen.has(key)) return;
    if (key !== '|') seen.add(key);
    envs.push(candidate);
  };

  pushEnv((window as any).__xln_env);

  try {
    const runtimeStore = await import('../stores/runtimeStore');
    const operations = runtimeStore.runtimeOperations;
    if (!operations || typeof operations.getAllRuntimes !== 'function') return envs;

    for (const runtime of operations.getAllRuntimes()) {
      if (runtime?.connection) {
        try {
          runtime.connection.close();
        } catch {
          // best effort
        }
      }
      pushEnv(runtime && 'env' in runtime ? runtime.env : null);
    }
  } catch {
    // best effort
  }

  return envs;
}

async function stopRuntimeBeforeReset(): Promise<void> {
  try {
    const vaultStore = await import('../stores/vaultStore');
    await vaultStore.vaultOperations.suspendAllRuntimeActivity?.();
    vaultStore.shutdownRuntimeResumeListener?.();
  } catch {
    // best effort
  }

  const xln = (window as any).__xln_instance;
  const envs = await collectRuntimeEnvs();

  for (const env of envs) {
    try {
      if (xln && typeof xln.stopP2P === 'function') {
        await xln.stopP2P(env);
      }
    } catch {
      // best effort
    }

    try {
      if (xln && typeof xln.closeRuntimeDb === 'function') {
        await xln.closeRuntimeDb(env);
      }
    } catch {
      // best effort
    }

    try {
      if (xln && typeof xln.closeInfraDb === 'function') {
        await xln.closeInfraDb(env);
      }
    } catch {
      // best effort
    }
  }

  try {
    (window as any).__xln_env = null;
    (window as any).__xln_instance = null;
  } catch {
    // best effort
  }

  try {
    const runtimeStore = await import('../stores/runtimeStore');
    runtimeStore.runtimeOperations.resetAll?.();
  } catch {
    // best effort
  }
}

async function runResetStep(
  errors: string[],
  label: string,
  step: () => Promise<void> | void,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    errors.push(`${label}: ${getErrorMessage(error)}`);
  }
}

function navigateAfterReset(returnTo = DEFAULT_RESET_RETURN_TO): void {
  try {
    window.onbeforeunload = null;
  } catch {
    // ignore
  }
  window.location.replace(returnTo);
}

function navigateToResetPage(returnTo = DEFAULT_RESET_RETURN_TO): void {
  const url = new URL('/resetdb', window.location.origin);
  url.searchParams.set('returnTo', returnTo);
  window.location.replace(url.toString());
}

export async function clearAllPersistentClientState(): Promise<void> {
  const errors: string[] = [];

  await runResetStep(errors, 'window.name', () => {
    window.name = '';
  });
  await runResetStep(errors, 'localStorage', () => {
    localStorage.clear();
  });
  await runResetStep(errors, 'sessionStorage', () => {
    sessionStorage.clear();
  });
  await runResetStep(errors, 'cookies', () => {
    clearAllCookies();
  });
  await runResetStep(errors, 'serviceWorkers', () => unregisterServiceWorkers());
  await runResetStep(errors, 'cacheStorage', () => clearCacheStorage());
  await runResetStep(errors, 'opfs', () => clearOriginPrivateFileSystem());
  await runResetStep(errors, 'indexedDB', () => clearAllIndexedDB());

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

export async function resetEverything(_trigger?: unknown): Promise<void> {
  if (activeResetPromise) return activeResetPromise;

  activeResetPromise = (async () => {
    if (window.location.pathname !== '/resetdb') {
      try {
        await stopRuntimeBeforeReset();
        await sleep(100);
      } catch (error) {
        console.error('[RESET] pre-navigation cleanup failed:', error);
      }
      navigateToResetPage();
      return new Promise<void>(() => {});
    }

    const searchParams = new URLSearchParams(window.location.search);
    const returnTo = String(searchParams.get('returnTo') || DEFAULT_RESET_RETURN_TO).trim() || DEFAULT_RESET_RETURN_TO;
    try {
      await clearAllPersistentClientState();
    } catch (error) {
      console.error('[RESET] cleanup failed:', error);
      activeResetPromise = null;
      throw error;
    }
    activeResetPromise = null;
    navigateAfterReset(returnTo);
  })();

  return activeResetPromise;
}
