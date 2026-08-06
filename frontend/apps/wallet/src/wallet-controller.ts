import { Capacitor } from '@capacitor/core';

import { createWalletBootController } from '../../../packages/runtime-client/wallet-boot-controller';
import type { WalletEnvironment } from '../../../packages/runtime-client/wallet-boot-machine';
import { initializeNativeShell } from '$lib/native/capacitor';
import {
  clearInactiveTabStandby,
  initializeActiveTabLock,
  isInactiveTabStandby,
} from '$lib/utils/activeTabLock';
import { errorLog } from '$lib/stores/errorLogStore';
import { runtimeControllerHandleExternalStore } from '$lib/stores/runtimeControllerStore';
import { settingsOperations } from '$lib/stores/settingsStore';
import { tabOperations } from '$lib/stores/tabStore';
import { timeOperations } from '$lib/stores/timeStore';
import {
  runtimesStateExternalStore,
  vaultOperations,
} from '$lib/stores/vaultStore';
import {
  initializeXLN,
  suspendClientActivity,
} from '$lib/stores/xlnStore';
import { classifyRuntimeFailure } from '$lib/utils/runtimeFailure';

let nativeInitializationPromise: Promise<void> | null = null;

export const detectWalletEnvironment = (): WalletEnvironment => {
  if (window.xlnDesktop) return 'electron';
  if (Capacitor.isNativePlatform()) return 'capacitor';
  return 'browser';
};

const initializeNativeOnce = (): Promise<void> => {
  nativeInitializationPromise ??= initializeNativeShell();
  return nativeInitializationPromise;
};

const bootingRemoteRuntime = (): boolean =>
  localStorage.getItem('xln-runtime-adapter-mode') === 'remote';

const initializeVault = async (): Promise<void> => {
  if (!bootingRemoteRuntime()) await vaultOperations.initialize();
};

const initializeRuntime = async (): Promise<void> => {
  tabOperations.loadFromStorage();
  tabOperations.initializeDefaultTabs();
  await initializeXLN();
  const handle = runtimeControllerHandleExternalStore.getSnapshot();
  if (!bootingRemoteRuntime() && handle.mode !== 'remote') await vaultOperations.initialize();
  timeOperations.initialize();
};

const readAvailability = () => {
  const vault = runtimesStateExternalStore.getSnapshot();
  const handle = runtimeControllerHandleExternalStore.getSnapshot();
  if (handle.mode === 'remote') {
    return {
      activeRuntimeId: handle.runtimeId || null,
      runtimeCount: handle.runtimeId ? 1 : 0,
      activeRuntimeUnlocked: Boolean(handle.runtimeId),
      runtimeReady: handle.status === 'connected',
    };
  }
  if (bootingRemoteRuntime()) {
    // The boot machine checks availability before initializeRuntime(). A stored
    // remote preference is complete boot intent, even before its adapter has
    // published a handle; otherwise the empty local vault incorrectly wins and
    // remote links fall through to wallet onboarding.
    return {
      activeRuntimeId: null,
      runtimeCount: 1,
      activeRuntimeUnlocked: true,
      runtimeReady: false,
    };
  }
  const activeRuntime = vault.activeRuntimeId ? vault.runtimes[vault.activeRuntimeId] : null;
  return {
    activeRuntimeId: vault.activeRuntimeId,
    runtimeCount: Object.keys(vault.runtimes).length,
    activeRuntimeUnlocked: Boolean(activeRuntime?.seed),
    runtimeReady: handle.status === 'connected' && handle.mode === 'embedded',
  };
};

const suspend = async (): Promise<void> => {
  await vaultOperations.suspendAllRuntimeActivity();
  await suspendClientActivity();
};

export const walletBootController = createWalletBootController({
  detectEnvironment: detectWalletEnvironment,
  initializeNative: initializeNativeOnce,
  isInactiveStandby: isInactiveTabStandby,
  clearInactiveStandby: clearInactiveTabStandby,
  acquireActiveTab: initializeActiveTabLock,
  initializeSettings: settingsOperations.initialize.bind(settingsOperations),
  initializeVault,
  initializeRuntime,
  readAvailability,
  suspend,
  reportError: (message, error) => errorLog.log(message, 'React Wallet Boot', error),
  isRecoverableError: error => classifyRuntimeFailure(error).retryable,
});

runtimesStateExternalStore.subscribe(walletBootController.reconcile);
runtimeControllerHandleExternalStore.subscribe(walletBootController.reconcile);
