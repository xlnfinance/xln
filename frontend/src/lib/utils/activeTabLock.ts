import { writable } from 'svelte/store';

const ACTIVE_TAB_LOCK_KEY = 'xln-active-tab-lock';
const ACTIVE_TAB_CHANNEL_NAME = 'xln-active-tab-lock';
const INACTIVE_TAB_STANDBY_KEY = 'xln-inactive-tab-standby';
const ACTIVE_TAB_HARD_RESET_KEY = 'xln-hard-reset';

type ActiveTabLockRecord = {
  tabId: string;
  timestamp: number;
  pathname: string;
};

type ActiveTabLockChannelMessage =
  | {
    type: 'takeover-request';
    tabId: string;
    targetOwnerTabId: string;
    timestamp: number;
    pathname: string;
  }
  | {
    type: 'takeover-approved';
    tabId: string;
    requesterTabId: string;
    timestamp: number;
  }
  | {
    type: 'claim';
    tabId: string;
    previousOwnerTabId: string | null;
    timestamp: number;
    pathname: string;
  }
  | {
    type: 'released';
    tabId: string;
    timestamp: number;
  }
  | {
    type: 'hard-reset';
    tabId: string;
    timestamp: number;
  };

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
let releaseCallback: (() => void) | null = null;
let installed = false;
let onLoseLockHandler: (() => void | Promise<void>) | null = null;
let lockLost = false;
let lockMonitorTimer: ReturnType<typeof setInterval> | null = null;
export function isInactiveTabStandby(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem(INACTIVE_TAB_STANDBY_KEY) === '1';
  } catch {
    return false;
  }
}

export function enterInactiveTabStandby(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(INACTIVE_TAB_STANDBY_KEY, '1');
  } catch {
    // ignore storage errors
  }
}

export function clearInactiveTabStandby(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(INACTIVE_TAB_STANDBY_KEY);
  } catch {
    // ignore storage errors
  }
}

function getOrCreateTabId(): string {
  if (currentTabId) return currentTabId;
  try {
    const existing = sessionStorage.getItem('xln-tab-id');
    if (existing) {
      currentTabId = existing;
      return currentTabId;
    }
  } catch {
    // ignore storage errors
  }
  currentTabId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    sessionStorage.setItem('xln-tab-id', currentTabId);
  } catch {
    // ignore storage errors
  }
  return currentTabId;
}

function readLockRecord(): ActiveTabLockRecord | null {
  try {
    const raw = localStorage.getItem(ACTIVE_TAB_LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveTabLockRecord>;
    if (typeof parsed.tabId !== 'string' || typeof parsed.timestamp !== 'number') return null;
    return {
      tabId: parsed.tabId,
      timestamp: parsed.timestamp,
      pathname: typeof parsed.pathname === 'string' ? parsed.pathname : '/app',
    };
  } catch {
    return null;
  }
}

function postChannelMessage(message: ActiveTabLockChannelMessage): void {
  try {
    activeChannel?.postMessage(message);
  } catch {
    // ignore channel errors
  }
}

async function handleHardResetRequest(sourceTabId: string): Promise<void> {
  const tabId = getOrCreateTabId();
  if (!sourceTabId || sourceTabId === tabId) return;
  enterInactiveTabStandby();
  try {
    await onLoseLockHandler?.();
  } finally {
    maybeReleaseLock();
    window.setTimeout(() => {
      window.location.replace('about:blank');
    }, 50);
  }
}

export function broadcastHardResetRequest(): void {
  if (typeof window === 'undefined') return;
  const tabId = getOrCreateTabId();
  const timestamp = Date.now();
  try {
    localStorage.setItem(
      ACTIVE_TAB_HARD_RESET_KEY,
      JSON.stringify({
        tabId,
        timestamp,
      }),
    );
  } catch {
    // ignore storage errors
  }
  postChannelMessage({
    type: 'hard-reset',
    tabId,
    timestamp,
  });
}

function writeLockRecord(tabId: string, previousOwnerTabId: string | null): ActiveTabLockRecord {
  const record: ActiveTabLockRecord = {
    tabId,
    timestamp: Date.now(),
    pathname: typeof window !== 'undefined' ? window.location.pathname : '/app',
  };
  try {
    localStorage.setItem(ACTIVE_TAB_LOCK_KEY, JSON.stringify(record));
  } catch {
    // ignore storage errors
  }
  postChannelMessage({
    type: 'claim',
    tabId,
    previousOwnerTabId,
    timestamp: record.timestamp,
    pathname: record.pathname,
  });
  activeTabLock.set({
    tabId,
    ownerTabId: tabId,
    isOwner: true,
  });
  return record;
}

async function handleExternalOwner(ownerTabId: string): Promise<void> {
  const tabId = getOrCreateTabId();
  if (!ownerTabId) return;
  if (ownerTabId === tabId) {
    activeTabLock.set({ tabId, ownerTabId, isOwner: true });
    return;
  }
  activeTabLock.set({ tabId, ownerTabId, isOwner: false });
  if (lockLost) return;
  lockLost = true;
  enterInactiveTabStandby();
  try {
    await onLoseLockHandler?.();
  } finally {
    postChannelMessage({
      type: 'takeover-approved',
      tabId,
      requesterTabId: ownerTabId,
      timestamp: Date.now(),
    });
  }
}

function maybeReleaseLock(): void {
  const tabId = getOrCreateTabId();
  const current = readLockRecord();
  if (!current || current.tabId !== tabId) return;
  try {
    localStorage.removeItem(ACTIVE_TAB_LOCK_KEY);
  } catch {
    // ignore storage errors
  }
}

export async function initializeActiveTabLock(onLoseLock: () => void | Promise<void>): Promise<() => void> {
  if (typeof window === 'undefined') return () => {};

  const tabId = getOrCreateTabId();
  const previousOwner = readLockRecord();
  const previousOwnerTabId = previousOwner?.tabId && previousOwner.tabId !== tabId ? previousOwner.tabId : null;
  onLoseLockHandler = onLoseLock;
  lockLost = false;
  clearInactiveTabStandby();

  if (!installed) {
    installed = true;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        activeChannel = new BroadcastChannel(ACTIVE_TAB_CHANNEL_NAME);
        activeChannel.onmessage = (event: MessageEvent<ActiveTabLockChannelMessage>) => {
          const message = event.data;
          if (!message || typeof message !== 'object') return;
          if (
            message.type === 'takeover-request' &&
            typeof message.tabId === 'string' &&
            typeof message.targetOwnerTabId === 'string' &&
            message.targetOwnerTabId === tabId
          ) {
            void handleExternalOwner(message.tabId);
            return;
          }
          if (
            message.type === 'takeover-approved' &&
            typeof message.requesterTabId === 'string' &&
            message.requesterTabId === tabId
          ) {
            return;
          }
          if (message.type === 'claim') {
            const ownerTabId = typeof message.tabId === 'string' ? message.tabId : '';
            if (ownerTabId) {
              void handleExternalOwner(ownerTabId);
            }
            return;
          }
          if (message.type === 'hard-reset') {
            void handleHardResetRequest(typeof message.tabId === 'string' ? message.tabId : '');
            return;
          }
        };
      }
    } catch {
      activeChannel = null;
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_TAB_LOCK_KEY && event.newValue) {
        const current = readLockRecord();
        if (current?.tabId) {
          void handleExternalOwner(current.tabId);
        }
        return;
      }
      if (event.key === ACTIVE_TAB_HARD_RESET_KEY && event.newValue) {
        try {
          const payload = JSON.parse(event.newValue) as { tabId?: unknown };
          const sourceTabId = typeof payload?.tabId === 'string' ? payload.tabId : '';
          void handleHardResetRequest(sourceTabId);
        } catch {
          // ignore malformed payload
        }
      }
    };

    const onUnload = () => {
      maybeReleaseLock();
    };

    const checkCurrentOwner = () => {
      const current = readLockRecord();
      if (!current?.tabId) return;
      void handleExternalOwner(current.tabId);
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
    lockMonitorTimer = window.setInterval(checkCurrentOwner, 500);

    releaseCallback = () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
      if (lockMonitorTimer) {
        clearInterval(lockMonitorTimer);
        lockMonitorTimer = null;
      }
      try {
        activeChannel?.close();
      } catch {
        // ignore channel errors
      }
      activeChannel = null;
      installed = false;
    };
  }

  writeLockRecord(tabId, previousOwnerTabId);

  return () => {
    releaseCallback?.();
    releaseCallback = null;
  };
}
