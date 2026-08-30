import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  createWalletEmbeddedRuntimeSession,
  type WalletEmbeddedRuntimeResource,
} from '../../../frontend/packages/browser/src/wallet-embedded-runtime-session';

type Adapter = Readonly<{ id: string }>;

type ResourceHarness = Readonly<{
  resource: WalletEmbeddedRuntimeResource<Adapter>;
  adapter: Adapter;
  emitHeight: (height: number) => void;
  emitStatus: (status: string) => void;
  stops: () => number;
}>;

const createResource = (id = 'runtime-a'): ResourceHarness => {
  const heightListeners = new Set<(height: number) => void>();
  const statusListeners = new Set<(status: string) => void>();
  const adapter = { id };
  let height = 7;
  let stopCount = 0;
  return {
    adapter,
    resource: {
      adapter,
      runtimeId: id,
      readHeight: () => height,
      subscribeHeight: (listener) => { heightListeners.add(listener); return () => heightListeners.delete(listener); },
      subscribeStatus: (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
      stop: async () => { stopCount += 1; },
    },
    emitHeight: (next) => { height = next; for (const listener of heightListeners) listener(next); },
    emitStatus: (status) => { for (const listener of statusListeners) listener(status); },
    stops: () => stopCount,
  };
};

describe('wallet embedded Runtime session', () => {
  test('deduplicates app-wide boot and publishes stable external-store snapshots', async () => {
    const harness = createResource();
    let boots = 0;
    const session = createWalletEmbeddedRuntimeSession<Adapter>({
      acquireLock: async () => () => {},
      boot: async () => { boots += 1; return harness.resource; },
    });
    const snapshots: string[] = [];
    session.subscribe(() => { snapshots.push(session.getSnapshot().status); });

    expect(await Promise.all([session.start(), session.start()])).toEqual([harness.adapter, harness.adapter]);
    expect(boots).toBe(1);
    expect(session.requireAdapter()).toBe(harness.adapter);
    expect(session.getSnapshot()).toEqual({ status: 'ready', runtimeId: 'runtime-a', height: 7, message: '' });
    expect(snapshots).toEqual(['booting', 'ready']);
  });

  test('publishes committed height and adapter error notifications', async () => {
    const harness = createResource();
    const session = createWalletEmbeddedRuntimeSession<Adapter>({
      acquireLock: async () => () => {},
      boot: async () => harness.resource,
    });
    await session.start();
    harness.emitHeight(12.9);
    expect(session.getSnapshot().height).toBe(12);
    harness.emitStatus('error');
    expect(session.getSnapshot()).toMatchObject({ status: 'error', height: 12 });
  });

  test('quiesces the Runtime before active-tab ownership is released', async () => {
    const events: string[] = [];
    let loseLock!: () => Promise<void>;
    const harness = createResource();
    const session = createWalletEmbeddedRuntimeSession<Adapter>({
      acquireLock: async (handler) => { loseLock = handler; return () => { events.push('manual-release'); }; },
      boot: async () => ({ ...harness.resource, stop: async () => { events.push('runtime-stop'); } }),
    });
    await session.start();

    await loseLock();
    events.push('controller-release');
    expect(events).toEqual(['runtime-stop', 'controller-release']);
    expect(session.getSnapshot().status).toBe('standby');
    expect(() => session.requireAdapter()).toThrow('EMBEDDED_RUNTIME_NOT_READY');
  });

  test('stops the Runtime before manually releasing its tab lease', async () => {
    const events: string[] = [];
    const harness = createResource();
    const session = createWalletEmbeddedRuntimeSession<Adapter>({
      acquireLock: async () => () => { events.push('lock-release'); },
      boot: async () => ({ ...harness.resource, stop: async () => { events.push('runtime-stop'); } }),
    });
    await session.start();
    await session.stop();
    expect(events).toEqual(['runtime-stop', 'lock-release']);
    expect(session.getSnapshot().status).toBe('idle');
  });

  test('releases a failed lease and permits an explicit retry', async () => {
    const harness = createResource('runtime-b');
    let attempts = 0;
    let releases = 0;
    const session = createWalletEmbeddedRuntimeSession<Adapter>({
      acquireLock: async () => () => { releases += 1; },
      boot: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('BOOT_FAILED');
        return harness.resource;
      },
    });

    await expect(session.start()).rejects.toThrow('BOOT_FAILED');
    expect(session.getSnapshot()).toMatchObject({ status: 'error', message: 'BOOT_FAILED' });
    expect(await session.start()).toBe(harness.adapter);
    expect({ attempts, releases }).toEqual({ attempts: 2, releases: 1 });
  });

  test('retains a failed shutdown resource and lease until cleanup succeeds', async () => {
    const harness = createResource();
    let stopAttempts = 0;
    let releases = 0;
    const session = createWalletEmbeddedRuntimeSession<Adapter>({
      acquireLock: async () => () => { releases += 1; },
      boot: async () => ({
        ...harness.resource,
        stop: async () => {
          stopAttempts += 1;
          if (stopAttempts === 1) throw new Error('QUIESCE_FAILED');
        },
      }),
    });
    await session.start();

    await expect(session.stop()).rejects.toThrow('QUIESCE_FAILED');
    expect({ stopAttempts, releases, status: session.getSnapshot().status })
      .toEqual({ stopAttempts: 1, releases: 0, status: 'error' });
    await session.stop();
    expect({ stopAttempts, releases, status: session.getSnapshot().status })
      .toEqual({ stopAttempts: 2, releases: 1, status: 'idle' });
  });

  test('owns one document-scoped React session behind the canonical tab lock', () => {
    const source = readFileSync('frontend/apps/wallet/src/wallet-embedded-runtime.ts', 'utf8');
    expect(source).toContain('createWalletEmbeddedRuntimeSession');
    expect(source).toContain('activeTabLock.initializeActiveTabLock(handler)');
    expect(source).toContain("await import('./wallet-embedded-runtime-bootstrap')");
    expect(source).not.toContain('new EmbeddedRuntimeAdapter');
  });
});
