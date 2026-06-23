import { writable, derived, get } from 'svelte/store';
import type { Env } from '@xln/runtime/xln-api';
import { createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
import {
  normalizeRemoteRuntimeWsUrl,
  persistRemoteRuntimeImports,
  readStoredRemoteRuntimeImports,
  removeStoredRemoteRuntimeImport,
  writeStoredRemoteRuntimeImports,
  type RemoteRuntimeImportAccess,
  type RemoteRuntimeImportEntry,
  type StoredRemoteRuntimeImportEntry,
} from '$lib/utils/remoteRuntimeImport';
import { validateRemoteRuntimeEntry } from '$lib/utils/remoteRuntimeValidation';
import { getXLN } from './xlnRuntimeLoader';

export interface Runtime {
  id: string;                    // Runtime identifier (EOA for local runtimes)
  type: 'local' | 'remote';
  label: string;                 // Display name: "Local" or "CEX Production"
  env: Env | null;               // Local: full state, Remote: synced subset
  wsUrl?: string;                // Remote runtime adapter endpoint
  seed?: string;                 // BrainVault seed backing this runtime (if any)
  vaultId?: string;              // Vault name bound to this runtime (if any)
  connection?: WebSocket;        // For remote runtimes
  apiKey?: string;               // HMAC(seed, "read"|"write")
  remoteAccess?: 'read' | 'admin';
  permissions: 'read' | 'write';
  status: 'connected' | 'syncing' | 'disconnected' | 'error';
  lastSynced?: number;
  latencyMs?: number;            // Connection latency
}

// All runtimes (EOA-keyed for local, URI-keyed for remote)
export const runtimes = writable<Map<string, Runtime>>(new Map());

// Active runtime (which one time machine controls)
export const activeRuntimeId = writable<string>('');

// Derived: Get active runtime's env
export const activeRuntime = derived(
  [runtimes, activeRuntimeId],
  ([$runtimes, $activeId]) => $runtimes.get($activeId) || null
);

// Derived: Get active runtime's env (shorthand)
export const activeEnv = derived(
  activeRuntime,
  ($activeRuntime) => $activeRuntime?.env || null
);

const getEnvRuntimeId = (env: Env | null | undefined): string => {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  const runtimeId = typeof runtimeEnv?.runtimeId === 'string' ? runtimeEnv.runtimeId.trim() : '';
  return runtimeId.toLowerCase();
};

const publishRuntimeEnvView = (env: Env): Env => {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  return createRuntimeViewEnv(runtimeEnv);
};

const setRuntimeEntry = (
  current: Map<string, Runtime>,
  id: string,
  next: Runtime,
): Map<string, Runtime> => {
  const updated = new Map(current);
  updated.set(id, next);
  return updated;
};

const persistActiveRemoteRuntime = (runtime: Runtime): boolean => {
  if (typeof window === 'undefined' || runtime.type !== 'remote' || !runtime.wsUrl) return false;
  localStorage.setItem('xln-runtime-adapter-mode', 'remote');
  localStorage.setItem('xln-runtime-adapter-ws', runtime.wsUrl);
  localStorage.removeItem('xln-runtime-adapter-key');
  if (runtime.apiKey) sessionStorage.setItem('xln-runtime-adapter-key', runtime.apiKey);
  else sessionStorage.removeItem('xln-runtime-adapter-key');
  return true;
};

const clearActiveRemoteRuntimeStorage = (runtime: Runtime | null | undefined): boolean => {
  if (typeof window === 'undefined' || runtime?.type !== 'remote') return false;
  let matchesActiveStorage = false;
  try {
    const storedWs = localStorage.getItem('xln-runtime-adapter-ws') || '';
    matchesActiveStorage = !!runtime.wsUrl && normalizeRemoteRuntimeWsUrl(storedWs) === normalizeRemoteRuntimeWsUrl(runtime.wsUrl);
  } catch {
    matchesActiveStorage = false;
  }
  if (!matchesActiveStorage) return false;
  localStorage.setItem('xln-runtime-adapter-mode', 'embedded');
  localStorage.removeItem('xln-runtime-adapter-ws');
  localStorage.removeItem('xln-runtime-adapter-key');
  sessionStorage.removeItem('xln-runtime-adapter-key');
  return true;
};

const upsertRemoteImportEntry = (
  current: Map<string, Runtime>,
  entry: StoredRemoteRuntimeImportEntry,
): Map<string, Runtime> => {
  const id = String(entry.runtimeId || `radapter:${entry.wsUrl}`).toLowerCase();
  const existing = current.get(id);
  const lastSynced = existing?.lastSynced;
  return setRuntimeEntry(current, id, {
    ...existing,
    id,
    type: 'remote',
    label: entry.label || `Remote ${entry.wsUrl}`,
    env: existing?.env ?? null,
    wsUrl: entry.wsUrl,
    apiKey: entry.token,
    remoteAccess: entry.access,
    permissions: entry.access === 'admin' ? 'write' : 'read',
    status: existing?.status === 'connected' ? 'connected' : 'disconnected',
    ...(existing?.latencyMs !== undefined ? { latencyMs: existing.latencyMs } : {}),
    ...(lastSynced !== undefined ? { lastSynced } : {}),
  });
};

// Operations
export const runtimeOperations = {
  // Add local runtime (for multi-party testing)
  async addLocalRuntime(label: string): Promise<string> {
    const currentRuntimes = get(runtimes);
    const id = `localhost:${8000 + currentRuntimes.size}`;

    const xln = await getXLN();

    runtimes.update(r => setRuntimeEntry(r, id, {
        id,
        type: 'local',
        label,
        env: publishRuntimeEnvView(xln.createEmptyEnv()),
        permissions: 'write',
        status: 'connected'
      }));

    return id;
  },

  async connectRemote(
    uri: string,
    apiKey: string,
    options: { label?: string; access?: RemoteRuntimeImportAccess } = {},
  ): Promise<StoredRemoteRuntimeImportEntry> {
    const wsUrl = normalizeRemoteRuntimeWsUrl(uri);
    const entry: RemoteRuntimeImportEntry = {
      label: options.label || new URL(wsUrl).host,
      access: options.access ?? 'read',
      wsUrl,
      token: apiKey,
    };
    const startedAt = performance.now();
    const validated = await validateRemoteRuntimeEntry(entry, { importedAt: Date.now() });
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    const stored = { ...validated, runtimeId: validated.runtimeId };
    persistRemoteRuntimeImports([stored], { merge: true });
    runtimes.update((current) => {
      const updated = upsertRemoteImportEntry(current, stored);
      const runtime = updated.get(stored.runtimeId);
      if (!runtime) return updated;
      return setRuntimeEntry(updated, stored.runtimeId, { ...runtime, status: 'connected', latencyMs });
    });
    return stored;
  },

  upsertRemoteRuntimeImports(entries: StoredRemoteRuntimeImportEntry[]): StoredRemoteRuntimeImportEntry[] {
    const persisted = persistRemoteRuntimeImports(entries, { merge: true });
    runtimes.update((current) => entries.reduce(upsertRemoteImportEntry, current));
    return persisted;
  },

  // Switch active runtime
  selectRuntime(id: string) {
    const runtime = get(runtimes).get(id);
    if (runtime?.type === 'remote') {
      const activeId = get(activeRuntimeId);
      let storedWsUrl = '';
      try {
        storedWsUrl = localStorage.getItem('xln-runtime-adapter-ws') || '';
      } catch {
        storedWsUrl = '';
      }
      if (activeId !== id || storedWsUrl !== runtime.wsUrl) {
        if (persistActiveRemoteRuntime(runtime)) {
          activeRuntimeId.set(id);
          window.location.reload();
          return;
        }
      }
    }
    activeRuntimeId.set(id);
  },

  activateRemoteRuntime(runtimeId: string): boolean {
    const runtime = get(runtimes).get(runtimeId);
    if (!runtime || runtime.type !== 'remote') return false;
    if (!persistActiveRemoteRuntime(runtime)) return false;
    activeRuntimeId.set(runtimeId);
    if (typeof window !== 'undefined') window.location.reload();
    return true;
  },

  hydrateRemoteRuntimeImports() {
    let entries: StoredRemoteRuntimeImportEntry[] = [];
    try {
      entries = readStoredRemoteRuntimeImports();
    } catch (error) {
      console.error('[runtimeStore] Failed to hydrate remote runtime imports:', error);
      return;
    }
    if (entries.length === 0) return;
    runtimes.update((current) => entries.reduce(upsertRemoteImportEntry, current));
  },

  // Disconnect runtime
  disconnect(id: string) {
    let shouldReload = false;
    runtimes.update(r => {
      const runtime = r.get(id);
      if (runtime?.connection) {
        runtime.connection.close();
      }
      if (runtime?.type === 'remote') {
        removeStoredRemoteRuntimeImport(runtime.id);
        shouldReload = clearActiveRemoteRuntimeStorage(runtime) || get(activeRuntimeId) === id;
      }
      const updated = new Map(r);
      updated.delete(id);
      return updated;
    });

    // If we just deleted the active runtime, clear selection.
    if (get(activeRuntimeId) === id) {
      activeRuntimeId.set('');
    }
    if (shouldReload && typeof window !== 'undefined') window.location.reload();
  },

  resetAll() {
    runtimes.update((currentRuntimes) => {
      for (const runtime of currentRuntimes.values()) {
        runtime.connection?.close();
      }
      writeStoredRemoteRuntimeImports([]);
      return new Map();
    });
    activeRuntimeId.set('');
  },

  // Update active runtime env.
  createRuntimeEnvView(env: Env) {
    return publishRuntimeEnvView(env);
  },

  // Update active runtime env.
  updateLocalEnv(env: Env) {
    const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
    const viewEnv = publishRuntimeEnvView(runtimeEnv);
    runtimes.update(r => {
      const envRuntimeId = getEnvRuntimeId(runtimeEnv);
      if (envRuntimeId && r.has(envRuntimeId)) {
        const runtime = r.get(envRuntimeId)!;
        return setRuntimeEntry(r, envRuntimeId, {
          ...runtime,
          env: viewEnv,
          lastSynced: Date.now(),
        });
      }

      const activeId = String(get(activeRuntimeId) || '').toLowerCase();
      if (activeId && r.has(activeId)) {
        const runtime = r.get(activeId)!;
        const activeEnvRuntimeId = getEnvRuntimeId(runtime.env);
        if (!activeEnvRuntimeId || (envRuntimeId && activeEnvRuntimeId === envRuntimeId)) {
          return setRuntimeEntry(r, activeId, {
            ...runtime,
            env: viewEnv,
            lastSynced: Date.now(),
          });
        } else {
          console.error(
            `[runtimeStore] Refusing cross-runtime env overwrite: active=${activeId} activeEnv=${activeEnvRuntimeId} incoming=${envRuntimeId}`
          );
        }
      }
      return r;
    });
  },

  // Update active runtime metadata.
  setLocalRuntimeMetadata(meta: { label?: string; seed?: string; vaultId?: string }) {
    runtimes.update(r => {
      const activeId = get(activeRuntimeId);
      if (activeId && r.has(activeId)) {
        const runtime = r.get(activeId)!;
        return setRuntimeEntry(r, activeId, {
          ...runtime,
          ...(meta.label !== undefined ? { label: meta.label } : {}),
          ...(meta.seed !== undefined ? { seed: meta.seed } : {}),
          ...(meta.vaultId !== undefined ? { vaultId: meta.vaultId } : {}),
        });
      }
      return r;
    });
  },

  // Update specific runtime's env
  updateRuntimeEnv(runtimeId: string, env: Env) {
    const viewEnv = publishRuntimeEnvView(env);
    runtimes.update(r => {
      const runtime = r.get(runtimeId);
      if (!runtime) return r;
      return setRuntimeEntry(r, runtimeId, {
        ...runtime,
        env: viewEnv,
        lastSynced: Date.now(),
      });
    });
  },

  // Get runtime by ID
  getRuntime(id: string): Runtime | undefined {
    return get(runtimes).get(id);
  },

  // Get all runtimes as array
  getAllRuntimes(): Runtime[] {
    return Array.from(get(runtimes).values());
  }
};
