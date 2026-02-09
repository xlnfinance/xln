import { writable, derived, get } from 'svelte/store';
import type { Env } from '@xln/runtime/xln-api';

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

// Operations
export const runtimeOperations = {
  // Add local runtime (for multi-party testing)
  async addLocalRuntime(label: string): Promise<string> {
    const currentRuntimes = get(runtimes);
    const id = `localhost:${8000 + currentRuntimes.size}`;

    // Import runtime functions dynamically
    const { getXLN } = await import('./xlnStore');
    const xln = await getXLN();

    runtimes.update(r => {
      r.set(id, {
        id,
        type: 'local',
        label,
        env: xln.createEmptyEnv(),
        permissions: 'write',
        status: 'connected'
      });
      return r;
    });

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
          if (runtime) {
            runtime.env = msg.env;
            runtime.lastSynced = Date.now();
            runtime.status = 'connected';
          }
          return r;
        });
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      runtimes.update(r => {
        const runtime = r.get(uri);
        if (runtime) {
          runtime.status = 'error';
        }
        return r;
      });
    };

    ws.onclose = () => {
      runtimes.update(r => {
        const runtime = r.get(uri);
        if (runtime) {
          runtime.status = 'disconnected';
        }
        return r;
      });
    };

    runtimes.update(r => {
      r.set(uri, {
        id: uri,
        type: 'remote',
        label: uri,
        env: null,
        connection: ws,
        apiKey,
        permissions: 'read', // Default to read-only
        status: 'syncing'
      });
      return r;
    });
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
      r.delete(id);
      return r;
    });

    // If we just deleted the active runtime, clear selection.
    if (get(activeRuntimeId) === id) {
      activeRuntimeId.set('');
    }
  },

  // Update active runtime env (legacy name kept for compatibility).
  updateLocalEnv(env: Env) {
    runtimes.update(r => {
      const envRuntimeId = String((env as any)?.runtimeId || '').toLowerCase();
      if (envRuntimeId && r.has(envRuntimeId)) {
        const runtime = r.get(envRuntimeId)!;
        runtime.env = env;
        runtime.lastSynced = Date.now();
        return r;
      }

      const activeId = String(get(activeRuntimeId) || '').toLowerCase();
      if (activeId && r.has(activeId)) {
        const runtime = r.get(activeId)!;
        const activeEnvRuntimeId = String((runtime.env as any)?.runtimeId || '').toLowerCase();
        if (!activeEnvRuntimeId || activeEnvRuntimeId === envRuntimeId || !envRuntimeId) {
          runtime.env = env;
          runtime.lastSynced = Date.now();
        } else {
          console.error(
            `[runtimeStore] Refusing cross-runtime env overwrite: active=${activeId} activeEnv=${activeEnvRuntimeId} incoming=${envRuntimeId}`
          );
        }
      }
      return r;
    });
  },

  // Update active runtime metadata (legacy name kept for compatibility).
  setLocalRuntimeMetadata(meta: { label?: string; seed?: string; vaultId?: string }) {
    runtimes.update(r => {
      const activeId = get(activeRuntimeId);
      if (activeId && r.has(activeId)) {
        const runtime = r.get(activeId)!;
        if (meta.label !== undefined) runtime.label = meta.label;
        if (meta.seed !== undefined) runtime.seed = meta.seed;
        if (meta.vaultId !== undefined) runtime.vaultId = meta.vaultId;
      }
      return r;
    });
  },

  // Update specific runtime's env
  updateRuntimeEnv(runtimeId: string, env: Env) {
    runtimes.update(r => {
      const runtime = r.get(runtimeId);
      if (runtime) {
        runtime.env = env;
        runtime.lastSynced = Date.now();
      }
      return r;
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
