import { writable } from 'svelte/store';
import { parseJsonUnknown, requireUnknownRecord } from '$lib/utils/boundary';
import {
  ACTIVE_TAB_CHANNEL_NAME,
  ACTIVE_TAB_HARD_RESET_KEY,
  ACTIVE_TAB_OWNED_KEY,
  getOrCreateBrowserTabId,
  publishBrowserHardResetRequest,
  type ActiveTabLockChannelMessage,
} from '../../../../packages/browser/src/hard-reset-request';

const ACTIVE_TAB_WEB_LOCK_NAME = 'xln-active-runtime';
const INACTIVE_TAB_STANDBY_KEY = 'xln-inactive-tab-standby';

export type ActiveTabLockState = {
  tabId: string;
  ownerTabId: string | null;
  isOwner: boolean;
};

export const activeTabLock = writable<ActiveTabLockState>({
  tabId: '',
  ownerTabId: null,
  isOwner: false,
});

let activeChannel: BroadcastChannel | null = null;
let onLoseLockHandler: (() => void | Promise<void>) | null = null;
let releaseHeldLock: (() => void) | null = null;
let ownsWebLock = false;
let lossInFlight: Promise<void> | null = null;
let activeStorageHandler: ((event: StorageEvent) => void) | null = null;
let acquireInFlight = false;

export function isInactiveTabStandby(): boolean {
  return typeof window !== 'undefined' && sessionStorage.getItem(INACTIVE_TAB_STANDBY_KEY) === '1';
}

export function ownsActiveTabLock(): boolean {
  return ownsWebLock;
}

export async function waitForActiveTabLockLoss(): Promise<void> {
  await lossInFlight;
}

export function enterInactiveTabStandby(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(INACTIVE_TAB_STANDBY_KEY, '1');
}

export function clearInactiveTabStandby(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(INACTIVE_TAB_STANDBY_KEY);
}

const postChannelMessage = (message: ActiveTabLockChannelMessage): void => {
  activeChannel?.postMessage(message);
};

const releaseWebLock = (): void => {
  if (!releaseHeldLock) return;
  const release = releaseHeldLock;
  releaseHeldLock = null;
  release();
};

const failAsync = (error: unknown): void => {
  window.setTimeout(() => {
    throw error instanceof Error ? error : new Error(String(error));
  }, 0);
};

const loseWebLockTo = async (requesterTabId: string): Promise<void> => {
  const tabId = getOrCreateBrowserTabId();
  if (!ownsWebLock || !requesterTabId || requesterTabId === tabId) return;
  if (lossInFlight) return lossInFlight;
  lossInFlight = (async () => {
    enterInactiveTabStandby();
    await onLoseLockHandler?.();
    ownsWebLock = false;
    sessionStorage.removeItem(ACTIVE_TAB_OWNED_KEY);
    activeTabLock.set({ tabId, ownerTabId: requesterTabId, isOwner: false });
    releaseWebLock();
  })();
  try {
    await lossInFlight;
  } finally {
    lossInFlight = null;
  }
};

async function handleHardResetRequest(sourceTabId: string): Promise<void> {
  const tabId = getOrCreateBrowserTabId();
  if (!sourceTabId || sourceTabId === tabId) return;
  await loseWebLockTo(sourceTabId);
  window.setTimeout(() => window.location.replace('about:blank'), 50);
}

export function broadcastHardResetRequest(): void {
  if (typeof window === 'undefined') return;
  publishBrowserHardResetRequest(activeChannel ?? undefined);
}

const acquireWebLock = async (tabId: string): Promise<void> => {
  if (!navigator.locks?.request) throw new Error('ACTIVE_TAB_WEB_LOCKS_UNAVAILABLE');
  let resolveAcquired!: () => void;
  let rejectAcquired!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  let acquiredLock = false;
  void navigator.locks.request(ACTIVE_TAB_WEB_LOCK_NAME, { mode: 'exclusive' }, async (lock) => {
    if (!lock) throw new Error('ACTIVE_TAB_WEB_LOCK_MISSING');
    acquiredLock = true;
    ownsWebLock = true;
    clearInactiveTabStandby();
    sessionStorage.setItem(ACTIVE_TAB_OWNED_KEY, tabId);
    activeTabLock.set({ tabId, ownerTabId: tabId, isOwner: true });
    resolveAcquired();
    await new Promise<void>((resolve) => {
      releaseHeldLock = resolve;
    });
  }).catch((error) => {
    if (!acquiredLock) rejectAcquired(error);
    else failAsync(error);
  });
  await acquired;
};

const tryAcquireWebLock = async (tabId: string): Promise<boolean> => {
  if (!navigator.locks?.request) throw new Error('ACTIVE_TAB_WEB_LOCKS_UNAVAILABLE');
  let resolveAttempt!: (acquired: boolean) => void;
  let rejectAttempt!: (error: unknown) => void;
  const attempted = new Promise<boolean>((resolve, reject) => {
    resolveAttempt = resolve;
    rejectAttempt = reject;
  });
  let acquiredLock = false;
  void navigator.locks.request(
    ACTIVE_TAB_WEB_LOCK_NAME,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) {
        resolveAttempt(false);
        return;
      }
      acquiredLock = true;
      ownsWebLock = true;
      clearInactiveTabStandby();
      sessionStorage.setItem(ACTIVE_TAB_OWNED_KEY, tabId);
      activeTabLock.set({ tabId, ownerTabId: tabId, isOwner: true });
      resolveAttempt(true);
      await new Promise<void>((resolve) => {
        releaseHeldLock = resolve;
      });
    },
  ).catch((error) => {
    if (!acquiredLock) rejectAttempt(error);
    else failAsync(error);
  });
  return attempted;
};

const installActiveTabCoordination = (
  handler: () => void | Promise<void>,
): { tabId: string; onStorage: (event: StorageEvent) => void } => {
  const tabId = getOrCreateBrowserTabId();
  onLoseLockHandler = handler;
  activeChannel = new BroadcastChannel(ACTIVE_TAB_CHANNEL_NAME);
  activeChannel.onmessage = (event: MessageEvent<ActiveTabLockChannelMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'takeover-request') void loseWebLockTo(String(message.tabId || '')).catch(failAsync);
    else if (message.type === 'hard-reset') void handleHardResetRequest(String(message.tabId || '')).catch(failAsync);
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== ACTIVE_TAB_HARD_RESET_KEY || !event.newValue) return;
    try {
      const payload = requireUnknownRecord(parseJsonUnknown(event.newValue, 'ACTIVE_TAB_RESET_JSON_INVALID'), 'ACTIVE_TAB_RESET_PAYLOAD_INVALID');
      void handleHardResetRequest(typeof payload['tabId'] === 'string' ? payload['tabId'] : '').catch(failAsync);
    } catch (error) {
      failAsync(error);
    }
  };
  window.addEventListener('storage', onStorage);
  activeStorageHandler = onStorage;
  return { tabId, onStorage };
};

const cleanupActiveTabCoordination = (onStorage: (event: StorageEvent) => void): void => {
  window.removeEventListener('storage', onStorage);
  activeChannel?.close();
  activeChannel = null;
  onLoseLockHandler = null;
  if (activeStorageHandler === onStorage) activeStorageHandler = null;
};

const createActiveTabLockRelease = (
  tabId: string,
  onStorage: (event: StorageEvent) => void,
): (() => void) => () => {
  cleanupActiveTabCoordination(onStorage);
  ownsWebLock = false;
  sessionStorage.removeItem(ACTIVE_TAB_OWNED_KEY);
  activeTabLock.set({ tabId, ownerTabId: null, isOwner: false });
  releaseWebLock();
};

export async function initializeActiveTabLock(onLoseLock: () => void | Promise<void>): Promise<() => void> {
  if (typeof window === 'undefined') return () => {};
  if (activeChannel || releaseHeldLock || ownsWebLock) throw new Error('ACTIVE_TAB_LOCK_ALREADY_INITIALIZED');

  const { tabId, onStorage } = installActiveTabCoordination(onLoseLock);

  postChannelMessage({ type: 'takeover-request', tabId });
  acquireInFlight = true;
  try {
    await acquireWebLock(tabId);
  } catch (error) {
    cleanupActiveTabCoordination(onStorage);
    throw error;
  } finally {
    acquireInFlight = false;
  }

  return createActiveTabLockRelease(tabId, onStorage);
}

/**
 * Projection routes may inspect an embedded Runtime only when no other tab
 * owns it. They must never evict an active wallet merely because a background
 * address or health link was opened.
 */
export async function tryInitializeActiveTabLock(
  onLoseLock: () => void | Promise<void>,
): Promise<(() => void) | null> {
  if (typeof window === 'undefined') return () => {};
  if (activeChannel && !acquireInFlight && !releaseHeldLock && !ownsWebLock && activeStorageHandler) {
    cleanupActiveTabCoordination(activeStorageHandler);
  } else if (activeChannel || releaseHeldLock || ownsWebLock) {
    throw new Error('ACTIVE_TAB_LOCK_ALREADY_INITIALIZED');
  }
  const { tabId, onStorage } = installActiveTabCoordination(onLoseLock);
  try {
    if (!await tryAcquireWebLock(tabId)) {
      cleanupActiveTabCoordination(onStorage);
      return null;
    }
  } catch (error) {
    cleanupActiveTabCoordination(onStorage);
    throw error;
  }
  return createActiveTabLockRelease(tabId, onStorage);
}

/** Transfer an already-held same-document lease between projection and app layouts. */
export function adoptActiveTabLock(
  onLoseLock: () => void | Promise<void>,
): (() => void) | null {
  if (!ownsWebLock || !activeChannel || !releaseHeldLock || !activeStorageHandler) return null;
  onLoseLockHandler = onLoseLock;
  return createActiveTabLockRelease(getOrCreateBrowserTabId(), activeStorageHandler);
}
