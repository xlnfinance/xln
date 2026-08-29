import {
  ACTIVE_TAB_HARD_RESET_KEY,
  ACTIVE_TAB_OWNED_KEY,
  type ActiveTabLockChannelMessage,
} from './hard-reset-request';
import {
  ACTIVE_TAB_WEB_LOCK_NAME,
  INACTIVE_TAB_STANDBY_KEY,
  createDeferred,
  deferActiveTabLockError,
  hardResetSourceTabId,
  readDefaultActiveTabLockBrowser,
  setActiveTabStandby,
  type ActiveTabLockBrowser,
  type ActiveTabLockController,
  type ActiveTabLockControllerDependencies,
  type ActiveTabLockControllerOptions,
  type ActiveTabLockControllerState,
  type ActiveTabLockState,
} from './active-tab-lock-support';

export { ACTIVE_TAB_WEB_LOCK_NAME, INACTIVE_TAB_STANDBY_KEY };
export type {
  ActiveTabLockBrowser,
  ActiveTabLockController,
  ActiveTabLockControllerOptions,
  ActiveTabLockState,
};

const createControllerState = (): ActiveTabLockControllerState => ({
  activeChannel: null,
  onLoseLockHandler: null,
  releaseHeldLock: null,
  ownsWebLock: false,
  lossInFlight: null,
  activeStorageHandler: null,
  acquireInFlight: false,
});

const releaseWebLock = (state: ActiveTabLockControllerState): void => {
  if (!state.releaseHeldLock) return;
  const release = state.releaseHeldLock;
  state.releaseHeldLock = null;
  release();
};

const postChannelMessage = (
  state: ActiveTabLockControllerState,
  message: ActiveTabLockChannelMessage,
): void => {
  state.activeChannel?.postMessage(message);
};

const markLockAcquired = (
  state: ActiveTabLockControllerState,
  dependencies: ActiveTabLockControllerDependencies,
  browser: ActiveTabLockBrowser,
  tabId: string,
): void => {
  state.ownsWebLock = true;
  setActiveTabStandby(browser, false);
  browser.session.setItem(ACTIVE_TAB_OWNED_KEY, tabId);
  dependencies.publishState({ tabId, ownerTabId: tabId, isOwner: true });
};

const holdWebLock = (state: ActiveTabLockControllerState): Promise<void> =>
  new Promise((resolve) => {
    state.releaseHeldLock = resolve;
  });

const loseWebLockTo = async (
  state: ActiveTabLockControllerState,
  dependencies: ActiveTabLockControllerDependencies,
  requesterTabId: string,
): Promise<void> => {
  const browser = dependencies.readBrowser();
  if (!browser) return;
  const tabId = browser.getTabId();
  if (!state.ownsWebLock || !requesterTabId || requesterTabId === tabId) return;
  if (state.lossInFlight) return state.lossInFlight;
  state.lossInFlight = (async () => {
    setActiveTabStandby(browser, true);
    await state.onLoseLockHandler?.();
    state.ownsWebLock = false;
    browser.session.removeItem(ACTIVE_TAB_OWNED_KEY);
    dependencies.publishState({ tabId, ownerTabId: requesterTabId, isOwner: false });
    releaseWebLock(state);
  })();
  try {
    await state.lossInFlight;
  } finally {
    state.lossInFlight = null;
  }
};

const handleHardResetRequest = async (
  state: ActiveTabLockControllerState,
  dependencies: ActiveTabLockControllerDependencies,
  sourceTabId: string,
): Promise<void> => {
  const browser = dependencies.readBrowser();
  if (!browser || !sourceTabId || sourceTabId === browser.getTabId()) return;
  await loseWebLockTo(state, dependencies, sourceTabId);
  browser.defer(() => browser.replaceLocation('about:blank'), 50);
};

const acquireWebLock = async (
  state: ActiveTabLockControllerState,
  dependencies: ActiveTabLockControllerDependencies,
  browser: ActiveTabLockBrowser,
  tabId: string,
): Promise<void> => {
  const acquired = createDeferred<void>();
  let acquiredLock = false;
  void browser.requestLock(ACTIVE_TAB_WEB_LOCK_NAME, { mode: 'exclusive' }, async (lock) => {
    if (!lock) throw new Error('ACTIVE_TAB_WEB_LOCK_MISSING');
    acquiredLock = true;
    markLockAcquired(state, dependencies, browser, tabId);
    acquired.resolve(undefined);
    await holdWebLock(state);
  }).catch((error) => {
    if (!acquiredLock) acquired.reject(error);
    else deferActiveTabLockError(browser, error);
  });
  await acquired.promise;
};

const tryAcquireWebLock = async (
  state: ActiveTabLockControllerState,
  dependencies: ActiveTabLockControllerDependencies,
  browser: ActiveTabLockBrowser,
  tabId: string,
): Promise<boolean> => {
  const attempted = createDeferred<boolean>();
  let acquiredLock = false;
  void browser.requestLock(
    ACTIVE_TAB_WEB_LOCK_NAME,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) {
        attempted.resolve(false);
        return;
      }
      acquiredLock = true;
      markLockAcquired(state, dependencies, browser, tabId);
      attempted.resolve(true);
      await holdWebLock(state);
    },
  ).catch((error) => {
    if (!acquiredLock) attempted.reject(error);
    else deferActiveTabLockError(browser, error);
  });
  return attempted.promise;
};

const installCoordination = (
  state: ActiveTabLockControllerState,
  dependencies: ActiveTabLockControllerDependencies,
  browser: ActiveTabLockBrowser,
  handler: () => void | Promise<void>,
): { tabId: string; onStorage: (event: StorageEvent) => void } => {
  const tabId = browser.getTabId();
  state.onLoseLockHandler = handler;
  state.activeChannel = browser.createChannel();
  state.activeChannel.onmessage = (event: MessageEvent<unknown>) => {
    if (!event.data || typeof event.data !== 'object') return;
    const message = event.data as Record<string, unknown>;
    const sourceTabId = typeof message['tabId'] === 'string' ? message['tabId'] : '';
    if (message['type'] === 'takeover-request') void loseWebLockTo(state, dependencies, sourceTabId).catch((error) => deferActiveTabLockError(browser, error));
    else if (message['type'] === 'hard-reset') void handleHardResetRequest(state, dependencies, sourceTabId).catch((error) => deferActiveTabLockError(browser, error));
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== ACTIVE_TAB_HARD_RESET_KEY || !event.newValue) return;
    try {
      void handleHardResetRequest(state, dependencies, hardResetSourceTabId(event.newValue)).catch((error) => deferActiveTabLockError(browser, error));
    } catch (error) {
      deferActiveTabLockError(browser, error);
    }
  };
  browser.addStorageListener(onStorage);
  state.activeStorageHandler = onStorage;
  return { tabId, onStorage };
};

const cleanupCoordination = (
  state: ActiveTabLockControllerState,
  browser: ActiveTabLockBrowser,
  onStorage: (event: StorageEvent) => void,
): void => {
  browser.removeStorageListener(onStorage);
  state.activeChannel?.close();
  state.activeChannel = null;
  state.onLoseLockHandler = null;
  if (state.activeStorageHandler === onStorage) state.activeStorageHandler = null;
};

const createRelease = (
  state: ActiveTabLockControllerState,
  dependencies: ActiveTabLockControllerDependencies,
  browser: ActiveTabLockBrowser,
  tabId: string,
  onStorage: (event: StorageEvent) => void,
): (() => void) => () => {
  cleanupCoordination(state, browser, onStorage);
  state.ownsWebLock = false;
  browser.session.removeItem(ACTIVE_TAB_OWNED_KEY);
  dependencies.publishState({ tabId, ownerTabId: null, isOwner: false });
  releaseWebLock(state);
};

const initializeLock = async (
  state: ActiveTabLockControllerState,
  dependencies: ActiveTabLockControllerDependencies,
  onLoseLock: () => void | Promise<void>,
): Promise<() => void> => {
  const browser = dependencies.readBrowser();
  if (!browser) return () => {};
  if (state.activeChannel || state.releaseHeldLock || state.ownsWebLock) {
    throw new Error('ACTIVE_TAB_LOCK_ALREADY_INITIALIZED');
  }
  const { tabId, onStorage } = installCoordination(state, dependencies, browser, onLoseLock);
  const takeoverRequest = { type: 'takeover-request', tabId } satisfies ActiveTabLockChannelMessage;
  postChannelMessage(state, takeoverRequest);
  state.acquireInFlight = true;
  try {
    await acquireWebLock(state, dependencies, browser, tabId);
  } catch (error) {
    cleanupCoordination(state, browser, onStorage);
    throw error;
  } finally {
    state.acquireInFlight = false;
  }
  return createRelease(state, dependencies, browser, tabId, onStorage);
};

const tryInitializeLock = async (
  state: ActiveTabLockControllerState,
  dependencies: ActiveTabLockControllerDependencies,
  onLoseLock: () => void | Promise<void>,
): Promise<(() => void) | null> => {
  const browser = dependencies.readBrowser();
  if (!browser) return () => {};
  if (state.activeChannel && !state.acquireInFlight && !state.releaseHeldLock && !state.ownsWebLock && state.activeStorageHandler) {
    cleanupCoordination(state, browser, state.activeStorageHandler);
  } else if (state.activeChannel || state.releaseHeldLock || state.ownsWebLock) {
    throw new Error('ACTIVE_TAB_LOCK_ALREADY_INITIALIZED');
  }
  const { tabId, onStorage } = installCoordination(state, dependencies, browser, onLoseLock);
  try {
    if (!await tryAcquireWebLock(state, dependencies, browser, tabId)) {
      cleanupCoordination(state, browser, onStorage);
      return null;
    }
  } catch (error) {
    cleanupCoordination(state, browser, onStorage);
    throw error;
  }
  return createRelease(state, dependencies, browser, tabId, onStorage);
};

const adoptLock = (
  state: ActiveTabLockControllerState,
  dependencies: ActiveTabLockControllerDependencies,
  onLoseLock: () => void | Promise<void>,
): (() => void) | null => {
  const browser = dependencies.readBrowser();
  if (!browser || !state.ownsWebLock || !state.activeChannel || !state.releaseHeldLock || !state.activeStorageHandler) return null;
  state.onLoseLockHandler = onLoseLock;
  return createRelease(state, dependencies, browser, browser.getTabId(), state.activeStorageHandler);
};

export const createActiveTabLockController = (
  options: ActiveTabLockControllerOptions,
): ActiveTabLockController => {
  const state = createControllerState();
  const dependencies = {
    publishState: options.publishState,
    readBrowser: options.readBrowser ?? readDefaultActiveTabLockBrowser,
  };
  const readBrowser = (): ActiveTabLockBrowser | null => dependencies.readBrowser();
  return {
    isInactiveTabStandby: () => readBrowser()?.session.getItem(INACTIVE_TAB_STANDBY_KEY) === '1',
    ownsActiveTabLock: () => state.ownsWebLock,
    waitForActiveTabLockLoss: async () => { await state.lossInFlight; },
    enterInactiveTabStandby: () => { const browser = readBrowser(); if (browser) setActiveTabStandby(browser, true); },
    clearInactiveTabStandby: () => { const browser = readBrowser(); if (browser) setActiveTabStandby(browser, false); },
    broadcastHardResetRequest: () => { const browser = readBrowser(); if (browser) browser.publishHardReset(state.activeChannel ?? undefined); },
    initializeActiveTabLock: (handler) => initializeLock(state, dependencies, handler),
    tryInitializeActiveTabLock: (handler) => tryInitializeLock(state, dependencies, handler),
    adoptActiveTabLock: (handler) => adoptLock(state, dependencies, handler),
  };
};
