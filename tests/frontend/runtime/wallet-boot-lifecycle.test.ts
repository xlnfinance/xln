import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  runWalletBootLifecycle,
  type WalletBootDependencies,
} from '../../../frontend/packages/browser/src/wallet-boot-lifecycle';

type BootHarness = Readonly<{
  calls: string[];
  dependencies: WalletBootDependencies;
  cancel: () => void;
}>;

const createBootHarness = (
  input: Readonly<{ remotePreferred?: boolean; runtimeMode?: 'embedded' | 'remote' }> = {},
): BootHarness => {
  const calls: string[] = [];
  let current = true;
  const record = (name: string): void => {
    calls.push(name);
  };
  return {
    calls,
    cancel: () => {
      current = false;
    },
    dependencies: {
      isCurrent: () => current,
      initializeSettings: () => record('settings'),
      loadTabs: () => record('load-tabs'),
      initializeDefaultTabs: () => record('default-tabs'),
      isRemoteRuntimePreferred: () => {
        record('runtime-preference');
        return input.remotePreferred === true;
      },
      initializeVault: async () => record('vault'),
      initializeRuntime: async () => record('runtime'),
      readRuntimeMode: () => {
        record('runtime-mode');
        return input.runtimeMode ?? 'embedded';
      },
      afterRuntimeReady: async () => record('after-runtime'),
      initializeTime: () => record('time'),
    },
  };
};

describe('browser wallet boot lifecycle', () => {
  test('restores the local vault before Runtime boot and rebinds it afterward', async () => {
    const harness = createBootHarness();

    expect(await runWalletBootLifecycle(harness.dependencies)).toBe('completed');
    expect(harness.calls).toEqual([
      'settings',
      'load-tabs',
      'default-tabs',
      'runtime-preference',
      'vault',
      'runtime',
      'runtime-mode',
      'vault',
      'after-runtime',
      'time',
    ]);
  });

  test('boots a preferred remote Runtime without local vault restoration', async () => {
    const harness = createBootHarness({ remotePreferred: true, runtimeMode: 'remote' });

    expect(await runWalletBootLifecycle(harness.dependencies)).toBe('completed');
    expect(harness.calls).toEqual([
      'settings',
      'load-tabs',
      'default-tabs',
      'runtime-preference',
      'runtime',
      'after-runtime',
      'time',
    ]);
  });

  test('does not rebind a vault when Runtime boot selects remote mode', async () => {
    const harness = createBootHarness({ runtimeMode: 'remote' });

    expect(await runWalletBootLifecycle(harness.dependencies)).toBe('completed');
    expect(harness.calls.filter((call) => call === 'vault')).toHaveLength(1);
    expect(harness.calls).toContain('runtime-mode');
  });

  test('cancels before performing any boot effect', async () => {
    const harness = createBootHarness();
    harness.cancel();

    expect(await runWalletBootLifecycle(harness.dependencies)).toBe('cancelled');
    expect(harness.calls).toEqual([]);
  });

  test('cancels after local vault restore without starting Runtime boot', async () => {
    const harness = createBootHarness();
    const dependencies = {
      ...harness.dependencies,
      initializeVault: async () => {
        harness.calls.push('vault');
        harness.cancel();
      },
    };

    expect(await runWalletBootLifecycle(dependencies)).toBe('cancelled');
    expect(harness.calls).not.toContain('runtime');
  });

  test('cancels after Runtime boot without rebinding or publishing time', async () => {
    const harness = createBootHarness();
    const dependencies = {
      ...harness.dependencies,
      initializeRuntime: async () => {
        harness.calls.push('runtime');
        harness.cancel();
      },
    };

    expect(await runWalletBootLifecycle(dependencies)).toBe('cancelled');
    expect(harness.calls.filter((call) => call === 'vault')).toHaveLength(1);
    expect(harness.calls).not.toContain('after-runtime');
    expect(harness.calls).not.toContain('time');
  });

  test('cancels during the post-Runtime vault rebind before render settlement', async () => {
    const harness = createBootHarness();
    let vaultCalls = 0;
    const dependencies = {
      ...harness.dependencies,
      initializeVault: async () => {
        harness.calls.push('vault');
        vaultCalls += 1;
        if (vaultCalls === 2) harness.cancel();
      },
    };

    expect(await runWalletBootLifecycle(dependencies)).toBe('cancelled');
    expect(harness.calls.filter((call) => call === 'vault')).toHaveLength(2);
    expect(harness.calls).not.toContain('after-runtime');
    expect(harness.calls).not.toContain('time');
  });

  test('cancels during render settlement before publishing time state', async () => {
    const harness = createBootHarness({ remotePreferred: true });
    const dependencies = {
      ...harness.dependencies,
      afterRuntimeReady: async () => {
        harness.calls.push('after-runtime');
        harness.cancel();
      },
    };

    expect(await runWalletBootLifecycle(dependencies)).toBe('cancelled');
    expect(harness.calls).toContain('after-runtime');
    expect(harness.calls).not.toContain('time');
  });

  test('reports cancellation that occurs while publishing time state', async () => {
    const harness = createBootHarness({ remotePreferred: true });
    const dependencies = {
      ...harness.dependencies,
      initializeTime: () => {
        harness.calls.push('time');
        harness.cancel();
      },
    };

    expect(await runWalletBootLifecycle(dependencies)).toBe('cancelled');
    expect(harness.calls.at(-1)).toBe('time');
  });

  test('propagates boot failures without running later phases', async () => {
    const harness = createBootHarness({ remotePreferred: true });
    const dependencies = {
      ...harness.dependencies,
      initializeRuntime: async () => {
        harness.calls.push('runtime');
        throw new Error('RUNTIME_BOOT_FAILED');
      },
    };

    await expect(runWalletBootLifecycle(dependencies)).rejects.toThrow('RUNTIME_BOOT_FAILED');
    expect(harness.calls).not.toContain('after-runtime');
    expect(harness.calls).not.toContain('time');
  });

  test('keeps the canonical app shell on the shared lifecycle boundary', () => {
    const boundary = readFileSync('frontend/packages/browser/src/wallet-boot-lifecycle.ts', 'utf8');
    const layout = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('../../../../core');
    expect(layout).toContain('runWalletBootLifecycle({');
    expect(layout).toContain('isCurrent: isCurrentBoot');
    expect(layout).toContain('initializeVault: () => vaultOperations.initialize()');
    expect(layout).toContain('initializeRuntime: () => initializeXLN()');
    expect(layout).toContain('afterRuntimeReady: () => tick()');
  });
});
