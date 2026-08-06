import { describe, expect, test } from 'bun:test';

import { createWalletBootController, type WalletBootPorts } from '../../frontend/packages/runtime-client/wallet-boot-controller';
import {
  initialWalletBootSnapshot,
  transitionWalletBoot,
  type WalletAvailability,
  type WalletEnvironment,
} from '../../frontend/packages/runtime-client/wallet-boot-machine';
import { resolveRemoteWalletAvailability } from '../../frontend/packages/runtime-client/wallet-runtime-availability';

const EMPTY: WalletAvailability = {
  activeRuntimeId: null,
  runtimeCount: 0,
  activeRuntimeUnlocked: false,
  runtimeReady: false,
};

const ready = (runtimeReady: boolean): WalletAvailability => ({
  activeRuntimeId: '0xruntime',
  runtimeCount: 1,
  activeRuntimeUnlocked: true,
  runtimeReady,
});

const reachAvailability = (environment: WalletEnvironment, availability: WalletAvailability) => {
  const events = [
    { type: 'start' } as const,
    { type: 'environment-detected', environment } as const,
    { type: 'native-ready' } as const,
    { type: 'tab-acquired' } as const,
    { type: 'settings-loaded' } as const,
    { type: 'vault-loaded' } as const,
    { type: 'availability', availability } as const,
  ];
  return events.reduce(transitionWalletBoot, initialWalletBootSnapshot());
};

describe('wallet boot machine', () => {
  test('remote availability stays connecting across initial boot and adapter hot-swap', () => {
    expect(resolveRemoteWalletAvailability({
      mode: 'embedded', runtimeId: 'embedded', pendingRuntimeId: '', status: 'disconnected',
    }, true)).toEqual({
      activeRuntimeId: null, runtimeCount: 1, activeRuntimeUnlocked: true, runtimeReady: false,
    });
    expect(resolveRemoteWalletAvailability({
      mode: 'embedded', runtimeId: 'embedded', pendingRuntimeId: '0xh2', status: 'disconnected',
    }, true)).toEqual({
      activeRuntimeId: '0xh2', runtimeCount: 1, activeRuntimeUnlocked: true, runtimeReady: false,
    });
    expect(resolveRemoteWalletAvailability({
      mode: 'remote', runtimeId: '0xh2', pendingRuntimeId: '0xh2', status: 'connected',
    }, true)).toEqual({
      activeRuntimeId: '0xh2', runtimeCount: 1, activeRuntimeUnlocked: true, runtimeReady: true,
    });
  });

  test.each(['browser', 'capacitor', 'electron'] as const)('reaches a ready runtime in %s', environment => {
    const snapshot = reachAvailability(environment, ready(true));
    expect(snapshot).toMatchObject({
      phase: 'ready',
      environment,
      ownsActiveTab: true,
      runtimeCount: 1,
      activeRuntimeId: '0xruntime',
    });
  });

  test('maps empty, locked, connecting, and restored runtime evidence explicitly', () => {
    expect(reachAvailability('browser', EMPTY).phase).toBe('empty');
    expect(reachAvailability('browser', { ...ready(false), activeRuntimeUnlocked: false }).phase).toBe('locked');
    expect(reachAvailability('browser', ready(false)).phase).toBe('connecting');
    expect(reachAvailability('browser', ready(true)).phase).toBe('ready');
  });

  test('keeps inactive ownership and fatal/recoverable failures distinct', () => {
    const detecting = transitionWalletBoot(initialWalletBootSnapshot(), { type: 'start' });
    const environment = transitionWalletBoot(detecting, { type: 'environment-detected', environment: 'browser' });
    const native = transitionWalletBoot(environment, { type: 'native-ready' });
    expect(transitionWalletBoot(native, { type: 'tab-inactive' }).phase).toBe('inactive-tab');
    expect(transitionWalletBoot(native, { type: 'failure', error: 'corrupt persisted data', recoverable: true }).phase)
      .toBe('recoverable-error');
    expect(transitionWalletBoot(native, { type: 'failure', error: 'controller invariant', recoverable: false }).phase)
      .toBe('fatal-error');
  });

  test('rejects illegal evidence instead of skipping a lifecycle state', () => {
    expect(() => transitionWalletBoot(initialWalletBootSnapshot(), {
      type: 'availability',
      availability: EMPTY,
    })).toThrow('WALLET_BOOT_TRANSITION_INVALID:cold->availability');
  });
});

type PortHarness = Readonly<{
  ports: WalletBootPorts;
  calls: Record<string, number>;
  loseLock: () => Promise<void>;
}>;

const createPorts = (overrides: Partial<WalletBootPorts> = {}): PortHarness => {
  const calls: Record<string, number> = {};
  let onLoseLock = async (): Promise<void> => undefined;
  const count = (name: string): void => { calls[name] = (calls[name] ?? 0) + 1; };
  const ports: WalletBootPorts = {
    detectEnvironment: () => { count('detect'); return 'browser'; },
    initializeNative: async () => { count('native'); },
    isInactiveStandby: () => false,
    clearInactiveStandby: () => count('clearStandby'),
    acquireActiveTab: async callback => {
      count('acquire');
      onLoseLock = callback;
      return () => count('release');
    },
    initializeSettings: () => count('settings'),
    initializeVault: async () => { count('vault'); },
    initializeRuntime: async () => { count('runtime'); },
    readAvailability: () => ready(true),
    suspend: async () => { count('suspend'); },
    reportError: () => count('error'),
    isRecoverableError: () => true,
    ...overrides,
  };
  return { ports, calls, loseLock: () => onLoseLock() };
};

describe('wallet boot controller', () => {
  test('is Strict Mode safe when start is requested twice', async () => {
    const harness = createPorts();
    const controller = createWalletBootController(harness.ports);
    await Promise.all([controller.start(), controller.start()]);
    expect(controller.store.getSnapshot().phase).toBe('ready');
    expect(harness.calls).toMatchObject({ detect: 1, native: 1, acquire: 1, settings: 1, vault: 1, runtime: 1 });
  });

  test('stops in inactive standby without touching wallet storage or runtime', async () => {
    const harness = createPorts({ isInactiveStandby: () => true });
    const controller = createWalletBootController(harness.ports);
    await controller.start();
    expect(controller.store.getSnapshot().phase).toBe('inactive-tab');
    expect(harness.calls.acquire).toBeUndefined();
    expect(harness.calls.vault).toBeUndefined();
  });

  test('does not boot a runtime for an empty vault and activates once after wallet creation', async () => {
    let availability = EMPTY;
    let runtimeCalls = 0;
    const harness = createPorts({
      readAvailability: () => availability,
      initializeRuntime: async () => {
        runtimeCalls += 1;
        availability = ready(true);
      },
    });
    const controller = createWalletBootController(harness.ports);
    await controller.start();
    expect(controller.store.getSnapshot().phase).toBe('empty');
    expect(runtimeCalls).toBe(0);
    availability = ready(false);
    await Promise.all([controller.activateRuntime(), controller.activateRuntime()]);
    expect(controller.store.getSnapshot().phase).toBe('ready');
    expect(runtimeCalls).toBe(1);
  });

  test('suspends on lock loss and reinitializes only after an explicit claim', async () => {
    const harness = createPorts();
    const controller = createWalletBootController(harness.ports);
    await controller.start();
    await harness.loseLock();
    expect(controller.store.getSnapshot().phase).toBe('inactive-tab');
    expect(harness.calls.suspend).toBe(1);
    await controller.claimActiveTab();
    expect(controller.store.getSnapshot().phase).toBe('ready');
    expect(harness.calls.clearStandby).toBe(1);
    expect(harness.calls.acquire).toBe(2);
  });

  test('reports controller failures and keeps their retry classification', async () => {
    const harness = createPorts({ initializeVault: async () => { throw new Error('CORRUPT_VAULT'); } });
    const controller = createWalletBootController(harness.ports);
    await controller.start();
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'recoverable-error', error: 'CORRUPT_VAULT' });
    expect(harness.calls.error).toBe(1);
  });

  test('fences late native completion after reload disposal', async () => {
    let releaseNative = (): void => undefined;
    const native = new Promise<void>(resolve => { releaseNative = resolve; });
    const harness = createPorts({ initializeNative: () => native });
    const controller = createWalletBootController(harness.ports);
    const boot = controller.start();
    const disposal = controller.dispose();
    releaseNative();
    await Promise.all([boot, disposal]);
    expect(controller.store.getSnapshot().phase).toBe('disposed');
    expect(harness.calls.acquire).toBeUndefined();
    expect(harness.calls.runtime).toBeUndefined();
  });
});
