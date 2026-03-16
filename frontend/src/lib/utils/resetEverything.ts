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

/** Ship debug dump — log + save for later retrieval */
async function shipDebugDump(dump: string): Promise<void> {
  // 1. Console (always visible in F12)
  console.log('[RESET] Debug dump:\n', dump);

  // 2. Save to a key that WON'T be cleared (we clear localStorage, not this specific key)
  try {
    // Use a fixed key so latest crash is always retrievable
    const crashKey = 'xln-last-crash-dump';
    // We'll re-set this AFTER localStorage.clear() in resetEverything
    (window as any).__xln_pending_crash_dump = { key: crashKey, value: dump };
  } catch { /* */ }

  // 3. Ship to server relay (best effort, may fail if disconnected)
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
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    } catch { /* best effort */ }
  }
}

/**
 * Reset everything and reload.
 * Works even when runtime is corrupted / entities won't load.
 */
export async function resetEverything(triggerError?: unknown): Promise<void> {
  // Ship debug dump BEFORE clearing (so we have state to analyze)
  const dump = collectDebugDump(triggerError);
  await shipDebugDump(dump);

  console.log('[RESET] Clearing all persistent state...');

  // 1. Web storage
  try { localStorage.clear(); } catch { /* */ }
  try { sessionStorage.clear(); } catch { /* */ }

  // Re-save crash dump after clear (so it's retrievable on next load)
  try {
    const pending = (window as any).__xln_pending_crash_dump;
    if (pending) {
      localStorage.setItem(pending.key, pending.value);
    }
  } catch { /* */ }

  // 2. IndexedDB (LevelDB backing store in browser)
  await clearAllIndexedDB();

  // 3. Runtime DB (if runtime is loaded and accessible)
  try {
    const xln = (window as any).__xln_instance;
    const env = (window as any).__xln_env;
    if (xln?.clearDB) {
      await xln.clearDB(env);
    }
  } catch (e) {
    console.warn('[RESET] Runtime clearDB failed (expected if corrupted):', e);
  }

  console.log('[RESET] All state cleared. Reloading...');
  window.location.href = '/app';
}

/**
 * Install global fatal error interceptor.
 * Catches FRAME_CONSENSUS_FAILED and similar — shows confirm → resets.
 * Must be called once at app startup (layout level).
 */
export function installFatalErrorInterceptor(): void {
  if (typeof window === 'undefined') return;

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
