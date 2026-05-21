import { writable, derived, get } from 'svelte/store';
import type { Env } from '@xln/runtime/xln-api';
import { createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
import { getXLN } from './xlnRuntimeLoader';

export interface Runtime {
  id: string;                    // Runtime identifier (EOA for local runtimes)
  type: 'local' | 'remote';
  label: string;                 // Display name: "Local" or "CEX Production"
  env: Env | null;               // Local: full state, Remote: synced subset
  seed?: string;                 // BrainVault seed backing this runtime (if any)
  vaultId?: string;              // Vault name bound to this runtime (if any)
  connection?: WebSocket;        // For remote runtimes
  apiKey?: string;               // HMAC(seed, "read"|"write")
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

  // Connect to remote runtime
  async connectRemote(uri: string, apiKey: string): Promise<void> {
    const ws = new WebSocket(`ws://${uri}/ws`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', apiKey }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state_update') {
        runtimes.update(r => {
          const runtime = r.get(uri);
          if (!runtime) return r;
          return setRuntimeEntry(r, uri, {
            ...runtime,
            env: publishRuntimeEnvView(msg.env),
            lastSynced: Date.now(),
            status: 'connected',
          });
        });
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      runtimes.update(r => {
        const runtime = r.get(uri);
        if (!runtime) return r;
        return setRuntimeEntry(r, uri, { ...runtime, status: 'error' });
      });
    };

    ws.onclose = () => {
      runtimes.update(r => {
        const runtime = r.get(uri);
        if (!runtime) return r;
        return setRuntimeEntry(r, uri, { ...runtime, status: 'disconnected' });
      });
    };

    runtimes.update(r => setRuntimeEntry(r, uri, {
        id: uri,
        type: 'remote',
        label: uri,
        env: null,
        connection: ws,
        apiKey,
        permissions: 'read', // Default to read-only
        status: 'syncing'
      }));
  },

  // Switch active runtime
  selectRuntime(id: string) {
    activeRuntimeId.set(id);
  },

  // Disconnect runtime
  disconnect(id: string) {
    runtimes.update(r => {
      const runtime = r.get(id);
      if (runtime?.connection) {
        runtime.connection.close();
      }
      const updated = new Map(r);
      updated.delete(id);
      return updated;
    });

    // If we just deleted the active runtime, clear selection.
    if (get(activeRuntimeId) === id) {
      activeRuntimeId.set('');
    }
  },

  resetAll() {
    runtimes.update((currentRuntimes) => {
      for (const runtime of currentRuntimes.values()) {
        runtime.connection?.close();
      }
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
