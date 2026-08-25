import {
  ACTIVE_TAB_CHANNEL_NAME,
  getOrCreateBrowserTabId,
  publishBrowserHardResetRequest,
} from './hard-reset-request';

export const ACTIVE_TAB_WEB_LOCK_NAME = 'xln-active-runtime';
export const INACTIVE_TAB_STANDBY_KEY = 'xln-inactive-tab-standby';

export type ActiveTabLockState = Readonly<{
  tabId: string;
  ownerTabId: string | null;
  isOwner: boolean;
}>;

export type ActiveTabLockController = Readonly<{
  isInactiveTabStandby: () => boolean;
  ownsActiveTabLock: () => boolean;
  waitForActiveTabLockLoss: () => Promise<void>;
  enterInactiveTabStandby: () => void;
  clearInactiveTabStandby: () => void;
  broadcastHardResetRequest: () => void;
  initializeActiveTabLock: (onLoseLock: () => void | Promise<void>) => Promise<() => void>;
  tryInitializeActiveTabLock: (onLoseLock: () => void | Promise<void>) => Promise<(() => void) | null>;
  adoptActiveTabLock: (onLoseLock: () => void | Promise<void>) => (() => void) | null;
}>;

export type ActiveTabChannel = Pick<BroadcastChannel, 'onmessage' | 'postMessage' | 'close'>;

export type ActiveTabLockBrowser = Readonly<{
  session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  createChannel: () => ActiveTabChannel;
  requestLock: (
    name: string,
    options: Readonly<{ mode: 'exclusive'; ifAvailable?: boolean }>,
    callback: (lock: Lock | null) => Promise<void>,
  ) => Promise<unknown>;
  addStorageListener: (handler: (event: StorageEvent) => void) => void;
  removeStorageListener: (handler: (event: StorageEvent) => void) => void;
  defer: (callback: () => void, delayMs: number) => void;
  replaceLocation: (url: string) => void;
  getTabId: () => string;
  publishHardReset: (channel?: Pick<BroadcastChannel, 'postMessage'>) => void;
}>;

export type ActiveTabLockControllerOptions = Readonly<{
  publishState: (state: ActiveTabLockState) => void;
  readBrowser?: () => ActiveTabLockBrowser | null;
}>;

export type ActiveTabLockControllerState = {
  activeChannel: ActiveTabChannel | null;
  onLoseLockHandler: (() => void | Promise<void>) | null;
  releaseHeldLock: (() => void) | null;
  ownsWebLock: boolean;
  lossInFlight: Promise<void> | null;
  activeStorageHandler: ((event: StorageEvent) => void) | null;
  acquireInFlight: boolean;
};

export type ActiveTabLockControllerDependencies = Readonly<{
  publishState: (state: ActiveTabLockState) => void;
  readBrowser: () => ActiveTabLockBrowser | null;
}>;

export type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}>;

export const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

export const readDefaultActiveTabLockBrowser = (): ActiveTabLockBrowser | null => {
  if (typeof window === 'undefined') return null;
  return {
    session: sessionStorage,
    createChannel: () => new BroadcastChannel(ACTIVE_TAB_CHANNEL_NAME),
    requestLock: (name, options, callback) => {
      if (!navigator.locks?.request) {
        return Promise.reject(new Error('ACTIVE_TAB_WEB_LOCKS_UNAVAILABLE'));
      }
      return navigator.locks.request(name, options, callback);
    },
    addStorageListener: (handler) => window.addEventListener('storage', handler),
    removeStorageListener: (handler) => window.removeEventListener('storage', handler),
    defer: (callback, delayMs) => { window.setTimeout(callback, delayMs); },
    replaceLocation: (url) => window.location.replace(url),
    getTabId: getOrCreateBrowserTabId,
    publishHardReset: publishBrowserHardResetRequest,
  };
};

export const deferActiveTabLockError = (
  browser: ActiveTabLockBrowser,
  error: unknown,
): void => {
  browser.defer(() => {
    throw error instanceof Error ? error : new Error(String(error));
  }, 0);
};

export const setActiveTabStandby = (
  browser: ActiveTabLockBrowser,
  standby: boolean,
): void => {
  if (standby) browser.session.setItem(INACTIVE_TAB_STANDBY_KEY, '1');
  else browser.session.removeItem(INACTIVE_TAB_STANDBY_KEY);
};

export const hardResetSourceTabId = (raw: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('ACTIVE_TAB_RESET_JSON_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ACTIVE_TAB_RESET_PAYLOAD_INVALID');
  }
  const tabId = (value as Record<string, unknown>)['tabId'];
  return typeof tabId === 'string' ? tabId : '';
};
