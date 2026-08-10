import { writable } from 'svelte/store';

const ACTIVE_TAB_WEB_LOCK_NAME = 'xln-active-runtime';
const ACTIVE_TAB_CHANNEL_NAME = 'xln-active-tab-lock';
const ACTIVE_TAB_ID_KEY = 'xln-tab-id';
const ACTIVE_TAB_OWNED_KEY = 'xln-active-tab-owned';
const INACTIVE_TAB_STANDBY_KEY = 'xln-inactive-tab-standby';
const ACTIVE_TAB_HARD_RESET_KEY = 'xln-hard-reset';

type ActiveTabLockChannelMessage =
  | { type: 'takeover-request'; tabId: string }
  | { type: 'hard-reset'; tabId: string; timestamp: number };

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

let currentTabId = '';
let activeChannel: BroadcastChannel | null = null;
let onLoseLockHandler: (() => void | Promise<void>) | null = null;
let releaseHeldLock: (() => void) | null = null;
let ownsWebLock = false;
let lossInFlight: Promise<void> | null = null;

export function isInactiveTabStandby(): boolean {
  return typeof window !== 'undefined' && sessionStorage.getItem(INACTIVE_TAB_STANDBY_KEY) === '1';
}

export function enterInactiveTabStandby(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(INACTIVE_TAB_STANDBY_KEY, '1');
}

export function clearInactiveTabStandby(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(INACTIVE_TAB_STANDBY_KEY);
}

const getOrCreateTabId = (): string => {
  if (currentTabId) return currentTabId;
  currentTabId = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  sessionStorage.setItem(ACTIVE_TAB_ID_KEY, currentTabId);
  sessionStorage.removeItem(ACTIVE_TAB_OWNED_KEY);
  return currentTabId;
};

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
  const tabId = getOrCreateTabId();
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
  const tabId = getOrCreateTabId();
  if (!sourceTabId || sourceTabId === tabId) return;
  await loseWebLockTo(sourceTabId);
  window.setTimeout(() => window.location.replace('about:blank'), 50);
}

export function broadcastHardResetRequest(): void {
  if (typeof window === 'undefined') return;
  const tabId = getOrCreateTabId();
  const timestamp = Date.now();
  localStorage.setItem(ACTIVE_TAB_HARD_RESET_KEY, JSON.stringify({ tabId, timestamp }));
  postChannelMessage({ type: 'hard-reset', tabId, timestamp });
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

export async function initializeActiveTabLock(onLoseLock: () => void | Promise<void>): Promise<() => void> {
  if (typeof window === 'undefined') return () => {};
  if (activeChannel || releaseHeldLock || ownsWebLock) throw new Error('ACTIVE_TAB_LOCK_ALREADY_INITIALIZED');

  const tabId = getOrCreateTabId();
  onLoseLockHandler = onLoseLock;
  activeChannel = new BroadcastChannel(ACTIVE_TAB_CHANNEL_NAME);
  activeChannel.onmessage = (event: MessageEvent<ActiveTabLockChannelMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'takeover-request') {
      void loseWebLockTo(String(message.tabId || '')).catch(failAsync);
    } else if (message.type === 'hard-reset') {
      void handleHardResetRequest(String(message.tabId || '')).catch(failAsync);
    }
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== ACTIVE_TAB_HARD_RESET_KEY || !event.newValue) return;
    const payload = JSON.parse(event.newValue) as { tabId?: unknown };
    void handleHardResetRequest(typeof payload.tabId === 'string' ? payload.tabId : '').catch(failAsync);
  };
  window.addEventListener('storage', onStorage);

  postChannelMessage({ type: 'takeover-request', tabId });
  try {
    await acquireWebLock(tabId);
  } catch (error) {
    window.removeEventListener('storage', onStorage);
    activeChannel.close();
    activeChannel = null;
    onLoseLockHandler = null;
    throw error;
  }

  return () => {
    window.removeEventListener('storage', onStorage);
    activeChannel?.close();
    activeChannel = null;
    onLoseLockHandler = null;
    ownsWebLock = false;
    sessionStorage.removeItem(ACTIVE_TAB_OWNED_KEY);
    activeTabLock.set({ tabId, ownerTabId: null, isOwner: false });
    releaseWebLock();
  };
}
