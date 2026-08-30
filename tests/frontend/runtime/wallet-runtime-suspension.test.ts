import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { suspendWalletRuntimeActivity } from '../../../frontend/packages/browser/src/wallet-runtime-suspension';

type Target = {
  infrastructure: { persistenceQuiescing: boolean; persistencePaused: boolean };
};

const createTarget = (): Target => ({
  infrastructure: { persistenceQuiescing: false, persistencePaused: false },
});

describe('wallet Runtime suspension boundary', () => {
  test('fences ingress, drains accepted work, then stops loop and transport', async () => {
    const target = createTarget();
    const events: string[] = [];
    await suspendWalletRuntimeActivity(target, {
      stopWatchers: async () => { events.push(`watchers:${target.infrastructure.persistenceQuiescing}`); },
      waitForWorkDrained: async (_target, timeout) => { events.push(`work:${timeout}`); return true; },
      stopRuntimeLoop: async (_target, timeout) => {
        events.push(`loop:${target.infrastructure.persistencePaused}:${timeout}`);
        return true;
      },
      stopP2P: async (_target, timeout) => { events.push(`p2p:${timeout}`); },
      describeTarget: () => 'runtime=a',
    }, { runtimeDrainTimeoutMs: 31, p2pShutdownTimeoutMs: 17 });

    expect(events).toEqual(['watchers:true', 'work:31', 'loop:true:31', 'p2p:17']);
    expect(target.infrastructure).toEqual({ persistenceQuiescing: true, persistencePaused: true });
  });

  test('reports every recoverable quiesce failure after preserving shutdown order', async () => {
    const target = createTarget();
    const events: string[] = [];
    const action = suspendWalletRuntimeActivity(target, {
      stopWatchers: async () => { events.push('watchers'); throw new Error('WATCHER_FAILED'); },
      waitForWorkDrained: async () => { events.push('work'); return false; },
      stopRuntimeLoop: async () => { events.push('loop'); return false; },
      stopP2P: async () => { events.push('p2p'); throw new Error('P2P_FAILED'); },
      describeTarget: () => 'runtime=a;height=8',
    });

    await expect(action).rejects.toThrow(
      'RUNTIME_QUIESCE_FAILED:watchers:WATCHER_FAILED|runtime_work:drain_timeout:runtime=a;height=8|runtime_loop:drain_timeout|p2p:P2P_FAILED',
    );
    expect(events).toEqual(['watchers', 'work', 'loop', 'p2p']);
  });

  test('records thrown drain diagnostics and still stops the Runtime', async () => {
    const target = createTarget();
    const events: string[] = [];
    await expect(suspendWalletRuntimeActivity(target, {
      stopWatchers: async () => { events.push('watchers'); },
      waitForWorkDrained: async () => { events.push('work'); throw new Error('DRAIN_FAILED'); },
      stopRuntimeLoop: async () => { events.push('loop'); return true; },
      stopP2P: async () => { events.push('p2p'); },
      describeTarget: () => 'runtime=b',
    })).rejects.toThrow('runtime_work:DRAIN_FAILED:runtime=b');
    expect(events).toEqual(['watchers', 'work', 'loop', 'p2p']);
  });

  test('is the canonical suspension sequence for Svelte and React adapters', () => {
    const svelte = readFileSync('frontend/src/lib/stores/vault/vaultStore.ts', 'utf8');
    const react = readFileSync('frontend/apps/wallet/src/wallet-embedded-runtime-adapter.ts', 'utf8');
    for (const source of [svelte, react]) expect(source).toContain('suspendWalletRuntimeActivity');
    expect(svelte).toContain('safeStringify(runtimeQuiesceWorkSummary(target))');
    expect(react).toContain('describeTarget: describeRuntime');
  });
});
