import { writable, derived, get } from 'svelte/store';
import type { Env, RuntimeAdapterConfig } from '@xln/runtime/xln-api';
import { createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
import { registerDebugSurface } from '$lib/utils/debugSurface';
import {
  normalizeRemoteRuntimeWsUrl,
  parseRemoteRuntimeImportSourcePayload,
  persistRemoteRuntimeImports,
  readStoredRemoteRuntimeImports,
  removeStoredRemoteRuntimeImport,
  writeStoredRemoteRuntimeImports,
  type RemoteRuntimeHubJurisdiction,
  type RemoteRuntimeHubSummary,
  type RemoteRuntimeImportAccess,
  type RemoteRuntimeImportEntry,
  type StoredRemoteRuntimeImportEntry,
} from '$lib/utils/remoteRuntimeImport';
import { validateRemoteRuntimeEntry } from '$lib/utils/remoteRuntimeValidation';
import { getXLN } from './xlnRuntimeLoader';
import {
  getRuntimeControllerConfig,
  runtimeControllerHandle,
  setRuntimeControllerPendingRuntimeId,
} from './runtimeControllerStore';

export interface Runtime {
  id: string;                    // Runtime identifier (EOA for local runtimes)
  type: 'local' | 'remote';
  label: string;                 // Display name: "Local" or "CEX Production"
  env: Env | null;               // Active view snapshot for this runtime
  wsUrl?: string;                // Remote runtime adapter endpoint
  seed?: string;                 // BrainVault seed backing this runtime (if any)
  vaultId?: string;              // Vault name bound to this runtime (if any)
  apiKey?: string;               // HMAC(seed, "read"|"write")
  remoteAccess?: 'read' | 'admin';
  permissions: 'read' | 'write';
  status: 'connected' | 'syncing' | 'disconnected' | 'error';
  entityCount?: number;
  hubEntityId?: string;
  hubName?: string;
  hubJurisdiction?: RemoteRuntimeHubJurisdiction;
  hubEntities?: RemoteRuntimeHubSummary[];
  lastSynced?: number;
  latencyMs?: number;            // Connection latency
}

// All runtimes (EOA-keyed for local, URI-keyed for remote)
export const runtimes = writable<Map<string, Runtime>>(new Map());

const normalizeRuntimeId = (id: string | null | undefined): string =>
  String(id || '').trim().toLowerCase();

let remoteImportSourceHydration: Promise<StoredRemoteRuntimeImportEntry[]> | null = null;

export const activeRuntimeId = derived(
  [runtimeControllerHandle, runtimes],
  ([$handle, $runtimes]) => {
    const pendingId = normalizeRuntimeId($handle.pendingRuntimeId);
    if (pendingId && $runtimes.has(pendingId)) {
      return pendingId;
    }
    const controllerId = normalizeRuntimeId($handle.runtimeId || $handle.id);
    if (controllerId && controllerId !== 'embedded' && $runtimes.has(controllerId)) {
      return controllerId;
    }
    return pendingId;
  },
);

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

type RuntimeAdapterStorageSnapshot = {
  mode: string | null;
  wsUrl: string | null;
  access: string | null;
  localKey: string | null;
  sessionKey: string | null;
};

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
  localStorage.setItem('xln-runtime-adapter-access', runtime.remoteAccess ?? (runtime.permissions === 'write' ? 'admin' : 'read'));
  localStorage.removeItem('xln-runtime-adapter-key');
  if (runtime.apiKey) sessionStorage.setItem('xln-runtime-adapter-key', runtime.apiKey);
  else sessionStorage.removeItem('xln-runtime-adapter-key');
  return true;
};

const readRuntimeAdapterStorageSnapshot = (): RuntimeAdapterStorageSnapshot | null => {
  if (typeof window === 'undefined') return null;
  return {
    mode: localStorage.getItem('xln-runtime-adapter-mode'),
    wsUrl: localStorage.getItem('xln-runtime-adapter-ws'),
    access: localStorage.getItem('xln-runtime-adapter-access'),
    localKey: localStorage.getItem('xln-runtime-adapter-key'),
    sessionKey: sessionStorage.getItem('xln-runtime-adapter-key'),
  };
};

const writeStorageValue = (
  storage: Storage,
  key: string,
  value: string | null,
): void => {
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
};

const restoreRuntimeAdapterStorageSnapshot = (snapshot: RuntimeAdapterStorageSnapshot | null): void => {
  if (typeof window === 'undefined' || !snapshot) return;
  writeStorageValue(localStorage, 'xln-runtime-adapter-mode', snapshot.mode);
  writeStorageValue(localStorage, 'xln-runtime-adapter-ws', snapshot.wsUrl);
  writeStorageValue(localStorage, 'xln-runtime-adapter-access', snapshot.access);
  writeStorageValue(localStorage, 'xln-runtime-adapter-key', snapshot.localKey);
  writeStorageValue(sessionStorage, 'xln-runtime-adapter-key', snapshot.sessionKey);
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
  localStorage.removeItem('xln-runtime-adapter-access');
  localStorage.removeItem('xln-runtime-adapter-key');
  sessionStorage.removeItem('xln-runtime-adapter-key');
  return true;
};

const persistActiveEmbeddedRuntime = (): void => {
  if (typeof window === 'undefined') return;
  localStorage.setItem('xln-runtime-adapter-mode', 'embedded');
  localStorage.removeItem('xln-runtime-adapter-ws');
  localStorage.removeItem('xln-runtime-adapter-access');
  localStorage.removeItem('xln-runtime-adapter-key');
  sessionStorage.removeItem('xln-runtime-adapter-key');
};

const switchToRuntimeAdapter = async (config: RuntimeAdapterConfig): Promise<void> => {
  const { switchAppRuntimeAdapter } = await import('./xlnStore');
  await switchAppRuntimeAdapter(config);
};

const runtimeControllerAlreadyTargets = (runtime: Runtime, id: string): boolean => {
  const config = getRuntimeControllerConfig();
  const handle = get(runtimeControllerHandle);
  if (handle.status !== 'connected') return false;
  if (String(handle.runtimeId || handle.id || '').toLowerCase() !== id) return false;
  if (runtime.type === 'remote') {
    if (config?.mode !== 'remote' || !runtime.wsUrl || !config.wsUrl) return false;
    const expectedAuth = runtime.remoteAccess === 'admin' ? 'admin' : 'inspect';
    return handle.authLevel === expectedAuth &&
      normalizeRemoteRuntimeWsUrl(config.wsUrl) === normalizeRemoteRuntimeWsUrl(runtime.wsUrl);
  }
  return config?.mode === 'embedded' && String(config.runtimeId || '').toLowerCase() === id;
};

const upsertRemoteImportEntry = (
  current: Map<string, Runtime>,
  entry: StoredRemoteRuntimeImportEntry,
): Map<string, Runtime> => {
  const id = String(entry.runtimeId || `radapter:${entry.wsUrl}`).toLowerCase();
  const existing = current.get(id);
  const lastSynced = existing?.lastSynced;
  const hubEntityId = entry.hubEntityId || existing?.hubEntityId || '';
  const hubName = entry.hubName || existing?.hubName || '';
  const hubJurisdiction = entry.hubJurisdiction ?? existing?.hubJurisdiction;
  const hubEntities = entry.hubEntities?.length ? entry.hubEntities : existing?.hubEntities;
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
    entityCount: Math.max(0, Math.floor(Number(entry.entityCount || existing?.entityCount || 0))),
    ...(hubEntityId ? { hubEntityId } : {}),
    ...(hubName ? { hubName } : {}),
    ...(hubJurisdiction ? { hubJurisdiction } : {}),
    ...(hubEntities?.length ? { hubEntities } : {}),
    ...(existing?.latencyMs !== undefined ? { latencyMs: existing.latencyMs } : {}),
    ...(lastSynced !== undefined ? { lastSynced } : {}),
  });
};

const fetchRemoteRuntimeImportSource = async (
  source = '/api/runtime-import',
): Promise<RemoteRuntimeImportEntry[]> => {
  if (typeof window === 'undefined') return [];
  const url = new URL(source, window.location.href);
  if (url.origin !== window.location.origin) {
    throw new Error(`REMOTE_RUNTIME_IMPORT_SOURCE_ORIGIN_INVALID:${url.origin}`);
  }
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`REMOTE_RUNTIME_IMPORT_SOURCE_FAILED:${response.status}`);
  return parseRemoteRuntimeImportSourcePayload(await response.json());
};

// Operations
export const runtimeOperations = {
  setActiveRuntimeId(id: string): void {
    setRuntimeControllerPendingRuntimeId(id);
  },

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
    const persisted = persistRemoteRuntimeImports([stored], { merge: true });
    const persistedStored = persisted.find(candidate => candidate.runtimeId === stored.runtimeId) ?? stored;
    runtimes.update((current) => {
      const updated = upsertRemoteImportEntry(current, persistedStored);
      const runtime = updated.get(persistedStored.runtimeId);
      if (!runtime) return updated;
      return setRuntimeEntry(updated, persistedStored.runtimeId, { ...runtime, status: 'connected', latencyMs });
    });
    return persistedStored;
  },

  upsertRemoteRuntimeImports(entries: StoredRemoteRuntimeImportEntry[]): StoredRemoteRuntimeImportEntry[] {
    const persisted = persistRemoteRuntimeImports(entries, { merge: true });
    runtimes.update((current) => persisted.reduce(upsertRemoteImportEntry, current));
    return persisted;
  },

  // Switch active runtime
  async selectRuntime(id: string): Promise<boolean> {
    const runtime = get(runtimes).get(id);
    if (runtime?.type === 'remote') {
      if (!runtime.wsUrl) throw new Error(`REMOTE_RUNTIME_WS_MISSING:${id}`);
      const previousStorage = readRuntimeAdapterStorageSnapshot();
      const previousPendingRuntimeId = get(runtimeControllerHandle).pendingRuntimeId;
      const persisted = persistActiveRemoteRuntime(runtime);
      if (!persisted) return false;
      setRuntimeControllerPendingRuntimeId(id);
      if (!runtimeControllerAlreadyTargets(runtime, id)) {
        try {
          await switchToRuntimeAdapter({
            mode: 'remote',
            runtimeId: id,
            wsUrl: runtime.wsUrl,
            ...(runtime.apiKey ? { authKey: runtime.apiKey } : {}),
          });
        } catch (error) {
          restoreRuntimeAdapterStorageSnapshot(previousStorage);
          setRuntimeControllerPendingRuntimeId(previousPendingRuntimeId);
          throw error;
        }
      }
      if (!runtimeControllerAlreadyTargets(runtime, id)) {
        throw new Error(`REMOTE_RUNTIME_SWITCH_TARGET_MISMATCH:${id}`);
      }
      return persistActiveRemoteRuntime(runtime);
    }
    const previousPendingRuntimeId = get(runtimeControllerHandle).pendingRuntimeId;
    setRuntimeControllerPendingRuntimeId(id);
    try {
      if (runtime && !runtimeControllerAlreadyTargets(runtime, id)) {
        await switchToRuntimeAdapter({ mode: 'embedded', runtimeId: id });
      } else if (!runtime) {
        await switchToRuntimeAdapter({ mode: 'embedded', runtimeId: id });
      }
    } catch (error) {
      setRuntimeControllerPendingRuntimeId(previousPendingRuntimeId);
      throw error;
    }
    persistActiveEmbeddedRuntime();
    return true;
  },

  async activateRemoteRuntime(runtimeId: string, _options: { href?: string } = {}): Promise<boolean> {
    const runtime = get(runtimes).get(runtimeId);
    if (!runtime || runtime.type !== 'remote') return false;
    return runtimeOperations.selectRuntime(runtimeId);
  },

  hydrateRemoteRuntimeImports() {
    let entries: StoredRemoteRuntimeImportEntry[] = [];
    try {
      entries = readStoredRemoteRuntimeImports({ dropExpired: true });
    } catch (error) {
      console.error('[runtimeStore] Failed to hydrate remote runtime imports:', error);
      return;
    }
    if (entries.length === 0) return;
    runtimes.update((current) => entries.reduce(upsertRemoteImportEntry, current));
  },

  async hydrateRemoteRuntimeImportSource(source = '/api/runtime-import'): Promise<StoredRemoteRuntimeImportEntry[]> {
    if (typeof window === 'undefined') return [];
    if (remoteImportSourceHydration) return remoteImportSourceHydration;
    remoteImportSourceHydration = (async () => {
      const importedAt = Date.now();
      const entries = await fetchRemoteRuntimeImportSource(source);
      if (entries.length === 0) return [];
      const results = await Promise.allSettled(entries.map((entry, index) =>
        validateRemoteRuntimeEntry(entry, { index, importedAt })
      ));
      const validated = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      if (validated.length === 0) return [];
      return runtimeOperations.upsertRemoteRuntimeImports(validated);
    })().catch((error) => {
      console.warn('[runtimeStore] Remote runtime import source hydration failed:', error);
      return [];
    }).finally(() => {
      remoteImportSourceHydration = null;
    });
    return remoteImportSourceHydration;
  },

  // Disconnect runtime
  async disconnect(id: string): Promise<void> {
    let shouldSwitchToEmbedded = false;
    runtimes.update(r => {
      const runtime = r.get(id);
      if (runtime?.type === 'remote') {
        removeStoredRemoteRuntimeImport(runtime.id);
        shouldSwitchToEmbedded = clearActiveRemoteRuntimeStorage(runtime) || get(activeRuntimeId) === id;
      }
      const updated = new Map(r);
      updated.delete(id);
      return updated;
    });

    // If we just deleted the active runtime, clear selection.
    if (get(activeRuntimeId) === id) {
      setRuntimeControllerPendingRuntimeId('');
    }
    if (shouldSwitchToEmbedded) await switchToRuntimeAdapter({ mode: 'embedded' });
  },

  resetAll() {
    runtimes.update(() => {
      writeStoredRemoteRuntimeImports([]);
      return new Map();
    });
    setRuntimeControllerPendingRuntimeId('');
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

registerDebugSurface('registry', () => runtimeOperations.getAllRuntimes().map((runtime) => ({
  id: runtime.id,
  type: runtime.type,
  label: runtime.label,
  wsUrl: runtime.wsUrl,
  remoteAccess: runtime.remoteAccess,
  permissions: runtime.permissions,
  status: runtime.status,
  entityCount: runtime.entityCount,
  hubEntityId: runtime.hubEntityId,
  hubName: runtime.hubName,
  hubJurisdiction: runtime.hubJurisdiction,
  hubEntities: runtime.hubEntities,
  lastSynced: runtime.lastSynced,
  latencyMs: runtime.latencyMs,
})));

registerDebugSurface('runtimeSelection', () => ({
  activeRuntimeId: get(activeRuntimeId),
  controller: get(runtimeControllerHandle),
  config: getRuntimeControllerConfig(),
  runtimes: runtimeOperations.getAllRuntimes().map((runtime) => ({
    id: runtime.id,
    type: runtime.type,
    status: runtime.status,
    envRuntimeId: getEnvRuntimeId(runtime.env),
    hasEnv: Boolean(runtime.env),
  })),
}));
