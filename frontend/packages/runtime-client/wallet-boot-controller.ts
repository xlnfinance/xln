import { createExternalStore, type ExternalStore } from '../client-core/external-store';
import {
  initialWalletBootSnapshot,
  transitionWalletBoot,
  type WalletAvailability,
  type WalletBootEvent,
  type WalletBootSnapshot,
  type WalletEnvironment,
} from './wallet-boot-machine';

export type WalletBootPorts = Readonly<{
  detectEnvironment: () => WalletEnvironment;
  initializeNative: () => Promise<void>;
  isInactiveStandby: () => boolean;
  clearInactiveStandby: () => void;
  acquireActiveTab: (onLoseLock: () => Promise<void>) => Promise<() => void>;
  initializeSettings: () => void;
  initializeVault: () => Promise<void>;
  initializeRuntime: () => Promise<void>;
  readAvailability: () => WalletAvailability;
  suspend: () => Promise<void>;
  reportError: (message: string, error: unknown) => void;
  isRecoverableError: (error: unknown) => boolean;
}>;

export type WalletBootController = Readonly<{
  store: ExternalStore<WalletBootSnapshot>;
  start: () => Promise<void>;
  retry: () => Promise<void>;
  claimActiveTab: () => Promise<void>;
  activateRuntime: () => Promise<void>;
  reconcile: () => void;
  dispose: () => Promise<void>;
}>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'Wallet initialization failed');

export const createWalletBootController = (ports: WalletBootPorts): WalletBootController => {
  const binding = createExternalStore(initialWalletBootSnapshot());
  let releaseActiveTab: (() => void) | null = null;
  let runPromise: Promise<void> | null = null;

  const dispatch = (event: WalletBootEvent): void => {
    binding.controller.update(snapshot => transitionWalletBoot(snapshot, event));
  };
  const currentGeneration = (): number => binding.store.getSnapshot().generation;
  const isAlive = (generation: number): boolean => (
    currentGeneration() === generation && binding.store.getSnapshot().phase !== 'disposed'
  );
  const isCurrentOwner = (generation: number): boolean => (
    isAlive(generation) && binding.store.getSnapshot().ownsActiveTab
  );
  const fail = (error: unknown): void => {
    ports.reportError('Wallet boot failed', error);
    dispatch({ type: 'failure', error: errorMessage(error), recoverable: ports.isRecoverableError(error) });
  };
  const loseActiveTab = async (): Promise<void> => {
    if (binding.store.getSnapshot().phase === 'disposed') return;
    dispatch({ type: 'tab-inactive' });
    await ports.suspend();
  };
  const acquireTab = async (generation: number): Promise<boolean> => {
    releaseActiveTab?.();
    releaseActiveTab = null;
    const acquiredRelease = await ports.acquireActiveTab(loseActiveTab);
    if (!isAlive(generation)) {
      acquiredRelease();
      return false;
    }
    releaseActiveTab = acquiredRelease;
    dispatch({ type: 'tab-acquired' });
    return true;
  };
  const initializeOwnedWallet = async (generation: number): Promise<void> => {
    ports.initializeSettings();
    dispatch({ type: 'settings-loaded' });
    await ports.initializeVault();
    if (!isCurrentOwner(generation)) return;
    dispatch({ type: 'vault-loaded' });
    const availability = ports.readAvailability();
    if (availability.runtimeCount === 0 || !availability.activeRuntimeUnlocked) {
      dispatch({ type: 'availability', availability });
      return;
    }
    await ports.initializeRuntime();
    if (!isCurrentOwner(generation)) return;
    dispatch({ type: 'availability', availability: ports.readAvailability() });
  };
  const run = async (event: Extract<WalletBootEvent, { type: 'start' | 'retry' }>): Promise<void> => {
    dispatch(event);
    const generation = currentGeneration();
    try {
      const environment = ports.detectEnvironment();
      dispatch({ type: 'environment-detected', environment });
      await ports.initializeNative();
      if (!isAlive(generation)) return;
      dispatch({ type: 'native-ready' });
      if (ports.isInactiveStandby()) {
        dispatch({ type: 'tab-inactive' });
        return;
      }
      if (!await acquireTab(generation)) return;
      await initializeOwnedWallet(generation);
    } catch (error) {
      if (isAlive(generation) && binding.store.getSnapshot().phase !== 'inactive-tab') fail(error);
    }
  };
  const startRun = (event: Extract<WalletBootEvent, { type: 'start' | 'retry' }>): Promise<void> => {
    if (runPromise) return runPromise;
    runPromise = run(event).finally(() => {
      runPromise = null;
    });
    return runPromise;
  };

  return Object.freeze({
    store: binding.store,
    start: () => {
      const phase = binding.store.getSnapshot().phase;
      return phase === 'cold' ? startRun({ type: 'start' }) : Promise.resolve();
    },
    retry: () => startRun({ type: 'retry' }),
    claimActiveTab: () => {
      if (runPromise) return runPromise;
      if (binding.store.getSnapshot().phase !== 'inactive-tab') {
        return Promise.reject(new Error('WALLET_BOOT_ACTIVE_TAB_CLAIM_INVALID'));
      }
      const generation = currentGeneration();
      ports.clearInactiveStandby();
      runPromise = (async () => {
        try {
          if (!await acquireTab(generation)) return;
          await initializeOwnedWallet(generation);
        } catch (error) {
          if (isAlive(generation)) fail(error);
        }
      })().finally(() => {
        runPromise = null;
      });
      return runPromise;
    },
    activateRuntime: () => {
      if (runPromise) return runPromise;
      const snapshot = binding.store.getSnapshot();
      if (!snapshot.ownsActiveTab || !['empty', 'locked', 'connecting', 'ready'].includes(snapshot.phase)) {
        return Promise.reject(new Error('WALLET_BOOT_RUNTIME_ACTIVATION_INVALID'));
      }
      const generation = snapshot.generation;
      runPromise = (async () => {
        try {
          dispatch({ type: 'runtime-loading' });
          await ports.initializeRuntime();
          if (!isCurrentOwner(generation)) return;
          dispatch({ type: 'availability', availability: ports.readAvailability() });
        } catch (error) {
          if (isAlive(generation)) fail(error);
        }
      })().finally(() => {
        runPromise = null;
      });
      return runPromise;
    },
    reconcile: () => {
      const phase = binding.store.getSnapshot().phase;
      if (phase !== 'connecting' && phase !== 'ready') return;
      dispatch({ type: 'availability', availability: ports.readAvailability() });
    },
    dispose: async () => {
      if (binding.store.getSnapshot().phase === 'disposed') return;
      releaseActiveTab?.();
      releaseActiveTab = null;
      await ports.suspend();
      dispatch({ type: 'dispose' });
    },
  });
};
