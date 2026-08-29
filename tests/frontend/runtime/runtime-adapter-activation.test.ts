import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  activateEmbeddedRuntimeTarget,
  activateRemoteRuntimeTarget,
  type RuntimeActivationConfig,
  type RuntimeActivationTarget,
  type EmbeddedRuntimeActivationDependencies,
  type RemoteRuntimeActivationDependencies,
} from '../../../frontend/packages/runtime-client/src/runtime-adapter-activation';

type SessionSnapshot = Readonly<{ id: string }>;

type ActivationHarnessOptions = Readonly<{
  initialPendingRuntimeId?: string;
  current?: boolean;
  switchSetsCurrent?: boolean;
  switchError?: Error;
  remotePersistence?: readonly boolean[];
}>;

type ActivationHarness = Readonly<{
  dependencies: RemoteRuntimeActivationDependencies<SessionSnapshot>
    & EmbeddedRuntimeActivationDependencies;
  events: string[];
  configs: RuntimeActivationConfig[];
  pendingRuntimeId: () => string;
}>;

const createActivationHarness = (
  options: ActivationHarnessOptions = {},
): ActivationHarness => {
  const events: string[] = [];
  const configs: RuntimeActivationConfig[] = [];
  const snapshot = { id: 'session-before' };
  const persistence = [...(options.remotePersistence ?? [true, true])];
  let pendingRuntimeId = options.initialPendingRuntimeId ?? 'runtime-before';
  let current = options.current ?? false;
  const dependencies: RemoteRuntimeActivationDependencies<SessionSnapshot>
    & EmbeddedRuntimeActivationDependencies = {
    readPendingRuntimeId: () => {
      events.push('read-pending');
      return pendingRuntimeId;
    },
    setPendingRuntimeId: (runtimeId) => {
      events.push(`pending:${runtimeId}`);
      pendingRuntimeId = runtimeId;
    },
    readSessionSnapshot: () => {
      events.push('snapshot-session');
      return snapshot;
    },
    restoreSessionSnapshot: (value) => {
      events.push(`restore-session:${value.id}`);
    },
    persistRemote: (target) => {
      events.push(`persist-remote:${target.runtimeId}`);
      return persistence.shift() ?? true;
    },
    persistEmbedded: () => { events.push('persist-embedded'); },
    isCurrent: () => {
      events.push(`current:${current}`);
      return current;
    },
    switchAdapter: async (config) => {
      events.push(`switch:${config.mode}`);
      configs.push(config);
      if (options.switchError) throw options.switchError;
      if (options.switchSetsCurrent !== false) current = true;
    },
  };
  return { dependencies, events, configs, pendingRuntimeId: () => pendingRuntimeId };
};

const remoteTarget = {
  mode: 'remote',
  runtimeId: 'runtime-remote',
  wsUrl: 'ws://127.0.0.1:8080',
  authKey: 'admin-token',
} satisfies RuntimeActivationTarget;

const embeddedTarget = {
  mode: 'embedded',
  runtimeId: 'runtime-local',
  registered: true,
} satisfies RuntimeActivationTarget;

describe('runtime-client adapter activation boundary', () => {
  test('persists remote authority before switching and reaffirms it afterward', async () => {
    const harness = createActivationHarness();

    expect(await activateRemoteRuntimeTarget(remoteTarget, harness.dependencies)).toBe(true);
    expect(harness.events).toEqual([
      'snapshot-session',
      'read-pending',
      'persist-remote:runtime-remote',
      'pending:runtime-remote',
      'current:false',
      'switch:remote',
      'current:true',
      'persist-remote:runtime-remote',
    ]);
    expect(harness.configs).toEqual([{
      mode: 'remote',
      runtimeId: 'runtime-remote',
      wsUrl: 'ws://127.0.0.1:8080',
      authKey: 'admin-token',
    }]);
  });

  test('does not reconnect an already-current remote adapter', async () => {
    const harness = createActivationHarness({ current: true });

    expect(await activateRemoteRuntimeTarget(remoteTarget, harness.dependencies)).toBe(true);
    expect(harness.configs).toEqual([]);
    expect(harness.events.filter((event) => event.startsWith('persist-remote'))).toHaveLength(2);
  });

  test('does not mutate pending selection when initial remote persistence is unavailable', async () => {
    const harness = createActivationHarness({ remotePersistence: [false] });

    expect(await activateRemoteRuntimeTarget(remoteTarget, harness.dependencies)).toBe(false);
    expect(harness.pendingRuntimeId()).toBe('runtime-before');
    expect(harness.configs).toEqual([]);
  });

  test('restores remote session and pending selection when switching fails', async () => {
    const harness = createActivationHarness({ switchError: new Error('SWITCH_FAILED') });

    await expect(activateRemoteRuntimeTarget(remoteTarget, harness.dependencies))
      .rejects.toThrow('SWITCH_FAILED');
    expect(harness.pendingRuntimeId()).toBe('runtime-before');
    expect(harness.events.indexOf('restore-session:session-before'))
      .toBeLessThan(harness.events.indexOf('pending:runtime-before'));
  });

  test('rejects a remote switch that resolves without selecting its target', async () => {
    const harness = createActivationHarness({ switchSetsCurrent: false });

    await expect(activateRemoteRuntimeTarget(remoteTarget, harness.dependencies))
      .rejects.toThrow('REMOTE_RUNTIME_SWITCH_TARGET_MISMATCH:runtime-remote');
    expect(harness.pendingRuntimeId()).toBe('runtime-remote');
    expect(harness.events).not.toContain('restore-session:session-before');
  });

  test('sets embedded pending selection before switching and persists afterward', async () => {
    const harness = createActivationHarness();

    expect(await activateEmbeddedRuntimeTarget(embeddedTarget, harness.dependencies)).toBe(true);
    expect(harness.events).toEqual([
      'read-pending',
      'pending:runtime-local',
      'current:false',
      'switch:embedded',
      'persist-embedded',
    ]);
    expect(harness.configs).toEqual([{ mode: 'embedded', runtimeId: 'runtime-local' }]);
  });

  test('does not reconnect an already-current registered embedded adapter', async () => {
    const harness = createActivationHarness({ current: true });

    expect(await activateEmbeddedRuntimeTarget(embeddedTarget, harness.dependencies)).toBe(true);
    expect(harness.configs).toEqual([]);
    expect(harness.events.at(-1)).toBe('persist-embedded');
  });

  test('always switches an unregistered embedded target', async () => {
    const harness = createActivationHarness({ current: true });
    const target = { ...embeddedTarget, registered: false };

    expect(await activateEmbeddedRuntimeTarget(target, harness.dependencies)).toBe(true);
    expect(harness.configs).toEqual([{ mode: 'embedded', runtimeId: 'runtime-local' }]);
    expect(harness.events).not.toContain('current:true');
  });

  test('restores pending selection when an embedded switch fails', async () => {
    const harness = createActivationHarness({ switchError: new Error('EMBEDDED_SWITCH_FAILED') });

    await expect(activateEmbeddedRuntimeTarget(embeddedTarget, harness.dependencies))
      .rejects.toThrow('EMBEDDED_SWITCH_FAILED');
    expect(harness.pendingRuntimeId()).toBe('runtime-before');
    expect(harness.events).not.toContain('persist-embedded');
  });

  test('rejects a remote target without a WebSocket endpoint before mutation', async () => {
    const harness = createActivationHarness();
    const target = { ...remoteTarget, wsUrl: '' };

    await expect(activateRemoteRuntimeTarget(target, harness.dependencies))
      .rejects.toThrow('REMOTE_RUNTIME_WS_MISSING:runtime-remote');
    expect(harness.events).toEqual([]);
  });

  test('keeps browser storage and Svelte stores in the canonical adapter', () => {
    const boundary = readFileSync(
      'frontend/packages/runtime-client/src/runtime-adapter-activation.ts',
      'utf8',
    );
    const store = readFileSync('frontend/src/lib/stores/runtimeStore.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('localStorage');
    expect(boundary).not.toContain('sessionStorage');
    expect(store).toContain('activateRemoteRuntimeTarget({');
    expect(store).toContain('activateEmbeddedRuntimeTarget(target, {');
    expect(store).toContain('readSessionSnapshot: readRuntimeAdapterStorageSnapshot');
    expect(store).toContain('switchAdapter: switchToRuntimeAdapter');
  });
});
