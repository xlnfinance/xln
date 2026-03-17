/**
 * Nuclear reset — single canonical function that clears ALL persistent state.
 * Used by emergency bar (always visible), Settings buttons, and fatal error handler.
 *
 * This is the ONLY place that clears storage. All other code calls this.
 */

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
const RESET_FORCE_NAVIGATION_MS = 1500;

type ResetSignal = {
  type: 'begin-reset';
  token: string;
  timestamp: number;
  reason: string;
};

let installedResetListeners = false;
let resetChannel: BroadcastChannel | null = null;
let activeResetPromise: Promise<void> | null = null;

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
function collectDebugDump(triggerError?: unknown): string {
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
    }
  } catch { /* corrupted state — that's why we're resetting */ }

  return JSON.stringify(dump, null, 2);
}

/** Ship debug dump — log + best-effort ship without keeping client persistence */
async function shipDebugDump(dump: string): Promise<void> {
  // 1. Console (always visible in F12)
  console.log('[RESET] Debug dump:\n', dump);

  // 2. Ship to server relay (best effort, may fail if disconnected)
  try {
    const p2p = (window as any).__xln_env?.runtimeState?.p2p;
    if (p2p && typeof p2p.sendDebugEvent === 'function') {
      p2p.sendDebugEvent({ level: 'error', code: 'CRASH_DUMP', dump: dump.slice(0, 4000) });
    }
  } catch { /* */ }
}

/** Clear all IndexedDB databases (best-effort) */
async function clearAllIndexedDB(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;

  let dbNames: string[] = [];
  try {
    const idb = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
    if (typeof idb.databases === 'function') {
      const dbs = await idb.databases();
      dbNames = dbs.flatMap(db => (typeof db.name === 'string' && db.name.length > 0 ? [db.name] : []));
    }
  } catch { /* databases() not supported */ }

  if (dbNames.length === 0) {
    dbNames = ['db', 'level-js-db', 'level-db', 'xln-db', '_pouch_db'];
  }

  for (const name of dbNames) {
    try {
      let deleted = false;
      for (let attempt = 0; attempt < RESET_DB_DELETE_RETRIES; attempt += 1) {
        const status = await new Promise<'success' | 'error' | 'blocked'>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve('success');
          req.onerror = () => resolve('error');
          req.onblocked = () => resolve('blocked');
        });
        if (status === 'success' || status === 'error') {
          deleted = true;
          break;
        }
        await sleep(RESET_DB_DELETE_RETRY_DELAY_MS * (attempt + 1));
      }
      if (!deleted) {
        console.warn(`[RESET] IndexedDB delete remained blocked: ${name}`);
      }
    } catch {
      // best effort
    }
  }
}

function hardNavigateAfterReset(token: string): void {
  try {
    window.onbeforeunload = null;
  } catch {
    // ignore
  }
  const targetPath = '/app';
  const targetUrl = `${targetPath}?reset=${encodeURIComponent(token)}`;
  if (window.location.pathname === targetPath) {
    window.location.href = targetUrl;
    setTimeout(() => {
      window.location.reload();
    }, 30);
    return;
  }
  window.location.replace(targetUrl);
}

async function clearCacheStorage(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name).catch(() => false)));
  } catch {
    // best effort
  }
}

async function unregisterServiceWorkers(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
  } catch {
    // best effort
  }
}

async function clearOriginPrivateFileSystem(): Promise<void> {
  try {
    const storageWithDirectory = navigator.storage as StorageManager & {
      getDirectory?: () => Promise<FileSystemDirectoryHandle>;
    };
    if (typeof storageWithDirectory?.getDirectory !== 'function') return;
    const root = await storageWithDirectory.getDirectory();
    // TS DOM typing for FileSystemDirectoryHandle iteration is still spotty across toolchains.
    // @ts-ignore
    for await (const [name] of root.entries()) {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
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

async function stopRuntimeBeforeReset(): Promise<void> {
  try {
    const xln = (window as any).__xln_instance;
    const env = (window as any).__xln_env;
    if (xln?.stopP2P && env) {
      await xln.stopP2P(env);
    }
  } catch {
    // best effort
  }

  try {
    const xln = (window as any).__xln_instance;
    const env = (window as any).__xln_env;
    if (xln?.clearDB) {
      await xln.clearDB(env);
    }
  } catch (e) {
    console.warn('[RESET] Runtime clearDB failed (expected if corrupted):', e);
  }
}

async function performReset(triggerError: unknown, signal: ResetSignal, initiatedHere: boolean): Promise<void> {
  if (activeResetPromise) return activeResetPromise;

  activeResetPromise = (async () => {
    const forceNavigationTimer = window.setTimeout(() => {
      console.warn('[RESET] Cleanup watchdog fired; forcing navigation');
      hardNavigateAfterReset(signal.token);
    }, RESET_FORCE_NAVIGATION_MS);

    if (initiatedHere) {
      const dump = collectDebugDump(triggerError);
      await shipDebugDump(dump);
      console.log('[RESET] Starting coordinated reset across all tabs...');
      announceReset(signal);
      await sleep(RESET_PREPARATION_DELAY_MS);
    } else {
      console.log('[RESET] External reset signal received. Clearing local tab state...');
    }

    try {
      await Promise.race([
        (async () => {
          await stopRuntimeBeforeReset();
          await clearAllPersistentClientState();
        })(),
        sleep(RESET_FORCE_NAVIGATION_MS - 100),
      ]);
    } finally {
      clearTimeout(forceNavigationTimer);
    }

    try {
      resetChannel?.close();
    } catch {
      // ignore
    }
    resetChannel = null;

    console.log('[RESET] All state cleared. Reloading...');
    hardNavigateAfterReset(signal.token);
  })();

  return activeResetPromise;
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

  const handleFatal = (error: unknown) => {
    if (prompted || !isFatalRuntimeError(error)) return;
    prompted = true;

    const msg = error instanceof Error ? error.message : String(error);
    const shortMsg = msg.length > 120 ? msg.slice(0, 120) + '...' : msg;

    // Use setTimeout to escape the current call stack (error may be in a catch)
    setTimeout(() => {
      if (confirm(`Runtime error: ${shortMsg}\n\nReset everything to recover?`)) {
        resetEverything(error);
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
