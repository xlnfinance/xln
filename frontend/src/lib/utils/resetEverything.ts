/**
 * Nuclear reset — single canonical function that clears ALL persistent state.
 * Used by emergency bar (always visible), Settings buttons, and fatal error handler.
 *
 * This is the ONLY place that clears storage. All other code calls this.
 */

import { safeStringify } from './safeStringify';

const FATAL_PATTERNS = [
  'FRAME_CONSENSUS_FAILED',
  'Frame chain broken',
  'prevFrameHash mismatch',
  'FINANCIAL-SAFETY VIOLATION',
  'FinancialDataCorruptionError',
  'TypeSafetyViolationError',
  'loadEnvFromDB failed',
];

const RESET_CHANNEL_NAME = 'xln-global-reset';
const RESET_MARKER_KEY = 'xln-reset-marker';
const RESET_PREPARATION_DELAY_MS = 180;
const RESET_DB_DELETE_RETRIES = 8;
const RESET_DB_DELETE_RETRY_DELAY_MS = 250;
const VAULT_STORAGE_KEY = 'xln-vaults';

type ResetSignal = {
  type: 'begin-reset';
  token: string;
  timestamp: number;
  reason: string;
};

let installedResetListeners = false;
let resetChannel: BroadcastChannel | null = null;
let activeResetPromise: Promise<void> | null = null;
let lastFatalDumpFingerprint = '';
let lastFatalDumpPromise: Promise<void> | null = null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function createResetSignal(triggerError?: unknown): ResetSignal {
  const reason = triggerError instanceof Error ? triggerError.message : String(triggerError ?? 'manual');
  return {
    type: 'begin-reset',
    token: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: Date.now(),
    reason,
  };
}

function readResetMarker(): ResetSignal | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(RESET_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ResetSignal>;
    if (parsed?.type !== 'begin-reset' || typeof parsed.token !== 'string' || typeof parsed.timestamp !== 'number') {
      return null;
    }
    return {
      type: 'begin-reset',
      token: parsed.token,
      timestamp: parsed.timestamp,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'manual',
    };
  } catch {
    return null;
  }
}

function persistResetMarker(signal: ResetSignal): void {
  try {
    localStorage.setItem(RESET_MARKER_KEY, JSON.stringify(signal));
  } catch {
    // ignore storage errors
  }
}

function announceReset(signal: ResetSignal): void {
  persistResetMarker(signal);
  try {
    if (typeof BroadcastChannel === 'undefined') return;
    if (!resetChannel) {
      resetChannel = new BroadcastChannel(RESET_CHANNEL_NAME);
    }
    resetChannel.postMessage(signal);
  } catch {
    // ignore channel errors
  }
}

/** Check if an error is a fatal runtime corruption that requires reset */
export function isFatalRuntimeError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return FATAL_PATTERNS.some(p => msg.includes(p));
}

/** Collect debug dump for shipping to server before reset */
async function collectPersistedWalDump(): Promise<Record<string, unknown> | null> {
  try {
    let xln = (window as any).__xln_instance;
    if (!xln && typeof window !== 'undefined') {
      const runtimeUrl = new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href;
      xln = await import(/* @vite-ignore */ runtimeUrl).catch(() => null);
      if (xln) {
        (window as any).__xln_instance = xln;
      }
    }
    if (!xln) return null;
    if (
      typeof xln.createEmptyEnv !== 'function' ||
      typeof xln.getPersistedLatestHeight !== 'function' ||
      typeof xln.readPersistedFrameJournals !== 'function'
    ) {
      return null;
    }

    const activeEnv = (window as any).__xln_env;
    const runtimes: Array<{ runtimeId: string; seed: string | null; label: string | null }> = [];
    const seen = new Set<string>();
    const pushRuntime = (runtimeIdRaw: unknown, seedRaw?: unknown, labelRaw?: unknown) => {
      const runtimeId = String(runtimeIdRaw || '').trim().toLowerCase();
      if (!runtimeId || seen.has(runtimeId)) return;
      seen.add(runtimeId);
      runtimes.push({
        runtimeId,
        seed: typeof seedRaw === 'string' && seedRaw.trim().length > 0 ? seedRaw : null,
        label: typeof labelRaw === 'string' && labelRaw.trim().length > 0 ? labelRaw : null,
      });
    };

    if (activeEnv?.runtimeId) {
      pushRuntime(activeEnv.runtimeId, activeEnv.runtimeSeed, 'active-env');
    }

    try {
      const saved = localStorage.getItem(VAULT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as {
          runtimes?: Record<string, { id?: string; seed?: string | null; label?: string | null }>;
        };
        for (const [rawKey, runtime] of Object.entries(parsed?.runtimes || {})) {
          pushRuntime(runtime?.id || rawKey, runtime?.seed, runtime?.label);
        }
      }
    } catch {
      // ignore broken localStorage here; dump should still continue with active env if present
    }

    return {
      runtimes: await Promise.all(runtimes.map(async (runtime) => {
        const tempEnv = xln.createEmptyEnv(runtime.seed ?? null);
        tempEnv.runtimeId = runtime.runtimeId;
        tempEnv.dbNamespace = runtime.runtimeId;
        tempEnv.runtimeSeed = runtime.seed;

        const latestHeight = Number(await xln.getPersistedLatestHeight(tempEnv).catch(() => 0));
        const checkpointHeights = typeof xln.listPersistedCheckpointHeights === 'function'
          ? await xln.listPersistedCheckpointHeights(tempEnv).catch(() => [])
          : [];
        const journals: unknown[] = [];
        if (Number.isFinite(latestHeight) && latestHeight > 0) {
          for (let fromHeight = 1; fromHeight <= latestHeight; fromHeight += 250) {
            const toHeight = Math.min(latestHeight, fromHeight + 249);
            const chunk = await xln.readPersistedFrameJournals(tempEnv, { fromHeight, toHeight, limit: 250 }).catch(() => []);
            if (Array.isArray(chunk)) journals.push(...chunk);
          }
        }

        const checkpoints = typeof xln.readPersistedCheckpointSnapshot === 'function'
          ? await Promise.all(
              (Array.isArray(checkpointHeights) ? checkpointHeights : []).map(async (height: number) => ({
                height,
                snapshot: await xln.readPersistedCheckpointSnapshot(tempEnv, height).catch(() => null),
              })),
            )
          : [];

        const verify =
          typeof xln.verifyRuntimeChain === 'function'
            ? await xln.verifyRuntimeChain(runtime.runtimeId, runtime.seed, {}).catch((error: unknown) => ({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }))
            : null;

        return {
          runtimeId: runtime.runtimeId,
          label: runtime.label,
          latestHeight,
          checkpointHeights,
          checkpoints,
          verify,
          journals,
        };
      })),
    };
  } catch {
    return null;
  }
}

/** Collect debug dump for shipping to server before reset */
async function collectDebugDump(triggerError?: unknown): Promise<string> {
  const dump: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    url: window.location.href,
    userAgent: navigator.userAgent,
    trigger: triggerError instanceof Error
      ? { message: triggerError.message, stack: triggerError.stack }
      : String(triggerError ?? 'manual'),
  };

  // Grab recent console errors from ErrorDisplay if available
  try {
    const errorLog = (window as any).__xln_error_log;
    if (Array.isArray(errorLog)) {
      dump.recentErrors = errorLog.slice(-20);
    }
  } catch { /* */ }

  // Grab runtime state summary if available
  try {
    const env = (window as any).__xln_env;
    if (env) {
      dump.runtimeState = {
        height: env.height,
        timestamp: env.timestamp,
        eReplicaCount: env.eReplicas?.size ?? 0,
        jReplicaCount: env.jReplicas?.size ?? 0,
        runtimeId: env.runtimeId,
      };

      // Per-entity account state for debugging consensus failures
      const accounts: Record<string, unknown> = {};
      if (env.eReplicas) {
        for (const [key, replica] of env.eReplicas.entries()) {
          const state = (replica as any)?.state;
          if (!state?.accounts) continue;
          const entityAccounts: Record<string, unknown> = {};
          for (const [cpId, account] of state.accounts.entries()) {
            const a = account as any;
            entityAccounts[String(cpId).slice(-8)] = {
              currentHeight: a.currentHeight,
              pendingHeight: a.pendingFrame?.height,
              currentHash: a.currentFrame?.stateHash?.slice(0, 20),
              prevHash: a.currentFrame?.prevFrameHash?.slice(0, 20),
              rollbackCount: a.rollbackCount,
              frameHistoryLen: a.frameHistory?.length,
            };
          }
          accounts[String(key).slice(-12)] = entityAccounts;
        }
      }
      dump.accounts = accounts;
      dump.frameLogs = Array.isArray(env.frameLogs) ? env.frameLogs : [];
      dump.cleanLogs = Array.isArray(env.runtimeState?.cleanLogs) ? env.runtimeState.cleanLogs : [];
      dump.historyTail = Array.isArray(env.history) ? env.history.slice(-8) : [];
      dump.liveRuntimeSnapshot = safeStringify(env, 2);
    }
  } catch { /* corrupted state — that's why we're resetting */ }

  try {
    const walDump = await collectPersistedWalDump();
    if (walDump) dump.persistedWal = walDump;
  } catch { /* */ }

  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate) {
      dump.storageEstimate = {
        quota: estimate.quota ?? null,
        usage: estimate.usage ?? null,
      };
    }
  } catch { /* */ }

  return safeStringify(dump, 2);
}

/** Ship debug dump — log + best-effort ship without keeping client persistence */
async function shipDebugDump(dump: string): Promise<void> {
  // 1. Console (always visible in F12)
  console.log('[RESET] Debug dump:\n', dump);

  // 2. Ship full dump to debug server (best effort)
  try {
    await fetch('/api/debug/dumps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: dump,
      keepalive: true,
    });
  } catch { /* */ }

  // 3. Emit compact crash marker to relay timeline (best effort)
  try {
    const p2p = (window as any).__xln_env?.runtimeState?.p2p;
    if (p2p && typeof p2p.sendDebugEvent === 'function') {
      p2p.sendDebugEvent({ level: 'error', code: 'CRASH_DUMP', dump: dump.slice(0, 4000) });
    }
  } catch { /* */ }
}

async function collectAndShipDebugDump(triggerError?: unknown): Promise<void> {
  const dump = await collectDebugDump(triggerError);
  await shipDebugDump(dump);
}

function getIndexedDbFactory(): IDBFactory & { databases: () => Promise<Array<{ name?: string }>> } {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB unavailable during reset');
  }
  const idb = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
  if (typeof idb.databases !== 'function') {
    throw new Error('indexedDB.databases() unavailable during reset');
  }
  return idb as IDBFactory & { databases: () => Promise<Array<{ name?: string }>> };
}

async function listIndexedDbNames(): Promise<string[]> {
  const dbs = await getIndexedDbFactory().databases();
  const names = new Set<string>();
  for (const entry of dbs) {
    const name = String(entry && typeof entry.name === 'string' ? entry.name : '').trim();
    if (!name) continue;
    names.add(name);
  }
  return Array.from(names.values()).sort((left, right) => left.localeCompare(right));
}

async function deleteIndexedDb(name: string): Promise<'success' | 'error' | 'blocked'> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve('success');
    req.onerror = () => resolve('error');
    req.onblocked = () => resolve('blocked');
  });
}

async function clearAllIndexedDB(): Promise<void> {
  for (let pass = 0; pass < RESET_DB_DELETE_RETRIES; pass += 1) {
    const dbNames = await listIndexedDbNames();
    if (dbNames.length === 0) {
      return;
    }

    const statuses = await Promise.all(dbNames.map((name) => deleteIndexedDb(name)));
    if (statuses.includes('blocked')) {
      await sleep(RESET_DB_DELETE_RETRY_DELAY_MS * (pass + 1));
      continue;
    }

    const remaining = await listIndexedDbNames();
    if (remaining.length === 0) {
      return;
    }
    await sleep(RESET_DB_DELETE_RETRY_DELAY_MS * (pass + 1));
  }

  const remaining = await listIndexedDbNames();
  throw new Error(`IndexedDB wipe incomplete; remaining databases: ${remaining.join(', ')}`);
}

function hardNavigateAfterReset(): void {
  try {
    window.onbeforeunload = null;
  } catch {
    // ignore
  }
  const targetPath = '/app';
  if (window.location.pathname === targetPath) {
    window.location.reload();
    return;
  }
  window.location.replace(targetPath);
}

async function clearCacheStorage(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const names = await caches.keys();
  const deleted = await Promise.all(names.map((name) => caches.delete(name).catch(() => false)));
  if (deleted.some((result) => result !== true)) {
    throw new Error(`CacheStorage wipe incomplete; failed deletions: ${names.join(', ')}`);
  }
  const remaining = await caches.keys();
  if (remaining.length > 0) {
    throw new Error(`CacheStorage wipe incomplete; remaining caches: ${remaining.join(', ')}`);
  }
}

async function unregisterServiceWorkers(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  const unregistered = await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
  if (unregistered.some((result) => result !== true)) {
    throw new Error('Service worker wipe incomplete; unregister returned false');
  }
  const remaining = await navigator.serviceWorker.getRegistrations();
  if (remaining.length > 0) {
    throw new Error(`Service worker wipe incomplete; remaining registrations: ${remaining.length}`);
  }
}

async function clearOriginPrivateFileSystem(): Promise<void> {
  const storageWithDirectory = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof storageWithDirectory?.getDirectory !== 'function') return;
  const root = await storageWithDirectory.getDirectory();
  const failedEntries: string[] = [];
  // TS DOM typing for FileSystemDirectoryHandle iteration is still spotty across toolchains.
  // @ts-ignore
  for await (const [name] of root.entries()) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch {
      failedEntries.push(String(name));
    }
  }
  if (failedEntries.length > 0) {
    throw new Error(`OPFS wipe incomplete; failed entries: ${failedEntries.join(', ')}`);
  }
  const remainingEntries: string[] = [];
  // @ts-ignore
  for await (const [name] of root.entries()) {
    remainingEntries.push(String(name));
  }
  if (remainingEntries.length > 0) {
    throw new Error(`OPFS wipe incomplete; remaining entries: ${remainingEntries.join(', ')}`);
  }
}

function clearAllCookies(): void {
  if (typeof document === 'undefined' || !document.cookie) return;
  const cookies = document.cookie.split(';');
  const host = window.location.hostname;
  const parts = host.split('.').filter(Boolean);
  const domains = new Set<string>(['', host]);
  for (let i = 0; i < parts.length - 1; i += 1) {
    domains.add(`.${parts.slice(i).join('.')}`);
  }
  for (const cookie of cookies) {
    const eqIndex = cookie.indexOf('=');
    const name = (eqIndex >= 0 ? cookie.slice(0, eqIndex) : cookie).trim();
    if (!name) continue;
    const encodedName = encodeURIComponent(name);
    const expires = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
    document.cookie = `${encodedName}=; ${expires}; path=/`;
    for (const domain of domains) {
      if (!domain) continue;
      document.cookie = `${encodedName}=; ${expires}; path=/; domain=${domain}`;
    }
  }
}

export async function clearAllPersistentClientState(): Promise<void> {
  try { window.name = ''; } catch { /* */ }
  try { localStorage.clear(); } catch { /* */ }
  try { sessionStorage.clear(); } catch { /* */ }
  clearAllCookies();
  await unregisterServiceWorkers();
  await clearCacheStorage();
  await clearOriginPrivateFileSystem();
  await clearAllIndexedDB();
}

async function verifyPersistentClientStateCleared(): Promise<void> {
  if (typeof localStorage !== 'undefined' && localStorage.length > 0) {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) || '').filter(Boolean);
    throw new Error(`localStorage wipe incomplete; remaining keys: ${keys.join(', ')}`);
  }

  if (typeof sessionStorage !== 'undefined' && sessionStorage.length > 0) {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index) || '').filter(Boolean);
    throw new Error(`sessionStorage wipe incomplete; remaining keys: ${keys.join(', ')}`);
  }

  const remainingDbNames = await listIndexedDbNames();
  if (remainingDbNames.length > 0) {
    throw new Error(`IndexedDB verification failed; remaining databases: ${remainingDbNames.join(', ')}`);
  }
}

async function collectRuntimeEnvs(): Promise<unknown[]> {
  const envs: unknown[] = [];
  const seenKeys = new Set<string>();

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
    if (key !== '|' && seenKeys.has(key)) return;
    if (key !== '|') seenKeys.add(key);
    envs.push(candidate);
  };

  pushEnv((window as any).__xln_env);

  try {
    const runtimeStoreModule = await import('../stores/runtimeStore');
    const operations = runtimeStoreModule.runtimeOperations;
    if (operations && typeof operations.getAllRuntimes === 'function') {
      const runtimes = operations.getAllRuntimes();
      for (const runtime of runtimes) {
        if (runtime && runtime.connection) {
          try {
            runtime.connection.close();
          } catch {
            // best effort
          }
        }
        pushEnv(runtime && 'env' in runtime ? runtime.env : null);
      }
    }
  } catch {
    // best effort
  }

  return envs;
}

async function stopRuntimeBeforeReset(): Promise<void> {
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
    } catch (e) {
      console.warn('[RESET] closeRuntimeDb failed:', e);
    }

    try {
      if (xln && typeof xln.closeInfraDb === 'function') {
        await xln.closeInfraDb(env);
      }
    } catch (e) {
      console.warn('[RESET] closeInfraDb failed:', e);
    }
  }

  try {
    (window as any).__xln_env = null;
    (window as any).__xln_instance = null;
  } catch {
    // best effort
  }
}

async function performReset(
  triggerError: unknown,
  signal: ResetSignal,
  initiatedHere: boolean,
  options?: { skipDebugDump?: boolean },
): Promise<void> {
  if (activeResetPromise) return activeResetPromise;

  const resetPromise = (async () => {
    if (initiatedHere) {
      if (!options?.skipDebugDump) {
        await collectAndShipDebugDump(triggerError);
      }
      console.log('[RESET] Starting coordinated reset across all tabs...');
      announceReset(signal);
      await sleep(RESET_PREPARATION_DELAY_MS);
    } else {
      console.log('[RESET] External reset signal received. Clearing local tab state...');
    }

    await stopRuntimeBeforeReset();
    await clearAllPersistentClientState();
    await verifyPersistentClientStateCleared();

    try {
      if (resetChannel) resetChannel.close();
    } catch {
      // ignore
    }
    resetChannel = null;

    console.log('[RESET] All state cleared. Reloading...');
    hardNavigateAfterReset();
  })();

  activeResetPromise = resetPromise;

  try {
    await resetPromise;
  } catch (error) {
    activeResetPromise = null;
    console.error('[RESET] Full wipe failed:', error);
    throw error;
  }

  return resetPromise;
}

/**
 * Reset everything and reload.
 * Works even when runtime is corrupted / entities won't load.
 */
export async function resetEverything(triggerError?: unknown): Promise<void> {
  const signal = createResetSignal(triggerError);
  await performReset(triggerError, signal, true);
}

async function handleIncomingResetSignal(signal: ResetSignal): Promise<void> {
  if (!signal?.token) return;
  await performReset(signal.reason, signal, false);
}

function installGlobalResetListeners(): void {
  if (typeof window === 'undefined' || installedResetListeners) return;
  installedResetListeners = true;

  window.addEventListener('storage', (event) => {
    if (event.key !== RESET_MARKER_KEY || !event.newValue) return;
    const signal = readResetMarker();
    if (signal) {
      void handleIncomingResetSignal(signal);
    }
  });

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      resetChannel = new BroadcastChannel(RESET_CHANNEL_NAME);
      resetChannel.onmessage = (event: MessageEvent<ResetSignal>) => {
        const signal = event.data;
        if (signal?.type === 'begin-reset') {
          void handleIncomingResetSignal(signal);
        }
      };
    }
  } catch {
    resetChannel = null;
  }

  const existingMarker = readResetMarker();
  if (existingMarker) {
    void handleIncomingResetSignal(existingMarker);
  }
}

/**
 * Install global fatal error interceptor.
 * Catches FRAME_CONSENSUS_FAILED and similar — shows confirm → resets.
 * Must be called once at app startup (layout level).
 */
export function installFatalErrorInterceptor(): void {
  if (typeof window === 'undefined') return;
  installGlobalResetListeners();

  let prompted = false; // prevent multiple dialogs

  const queueFatalDump = (error: unknown) => {
    const key = error instanceof Error
      ? `${error.name}:${error.message}:${error.stack || ''}`
      : String(error ?? '');
    if (key && key === lastFatalDumpFingerprint) return;
    lastFatalDumpFingerprint = key;
    void collectDebugDump(error).then(shipDebugDump).catch(() => {});
  };

  const handleFatal = (error: unknown) => {
    if (prompted || !isFatalRuntimeError(error)) return;
    prompted = true;

    const msg = error instanceof Error ? error.message : String(error);
    const shortMsg = msg.length > 120 ? msg.slice(0, 120) + '...' : msg;

    // Use setTimeout to escape the current call stack (error may be in a catch)
    setTimeout(async () => {
      try {
        lastFatalDumpPromise = queueFatalDump(error);
        await lastFatalDumpPromise;
      } catch {
        // best effort only
      }
      if (confirm(`Runtime error: ${shortMsg}\n\nReset everything to recover?`)) {
        const signal = createResetSignal(error);
        await performReset(error, signal, true, { skipDebugDump: true });
      } else {
        prompted = false; // allow re-prompting if user declines
      }
    }, 0);
  };

  // Catch unhandled promise rejections (async runtime errors)
  window.addEventListener('unhandledrejection', (event) => {
    handleFatal(event.reason);
  });

  // Catch synchronous errors
  window.addEventListener('error', (event) => {
    handleFatal(event.error);
  });

  // Intercept console.error to catch runtime errors that are logged but not thrown
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    origConsoleError.apply(console, args);
    const joined = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
    if (isFatalRuntimeError(joined)) {
      handleFatal(new Error(joined));
    }
  };
}
