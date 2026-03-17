import { writable } from 'svelte/store';

const ACTIVE_TAB_LOCK_KEY = 'xln-active-tab-lock';
const ACTIVE_TAB_CHANNEL_NAME = 'xln-active-tab-lock';

type ActiveTabLockRecord = {
  tabId: string;
  timestamp: number;
  pathname: string;
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

function writeLockRecord(tabId: string): ActiveTabLockRecord {
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
  try {
    activeChannel?.postMessage(record);
  } catch {
    // ignore channel errors
  }
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
  await onLoseLockHandler?.();
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

export function initializeActiveTabLock(onLoseLock: () => void | Promise<void>): () => void {
  if (typeof window === 'undefined') return () => {};

  const tabId = getOrCreateTabId();
  onLoseLockHandler = onLoseLock;
  lockLost = false;

  if (!installed) {
    installed = true;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        activeChannel = new BroadcastChannel(ACTIVE_TAB_CHANNEL_NAME);
        activeChannel.onmessage = (event: MessageEvent<ActiveTabLockRecord>) => {
          const ownerTabId = typeof event.data?.tabId === 'string' ? event.data.tabId : '';
          if (ownerTabId) {
            void handleExternalOwner(ownerTabId);
          }
        };
      }
    } catch {
      activeChannel = null;
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== ACTIVE_TAB_LOCK_KEY || !event.newValue) return;
      const current = readLockRecord();
      if (current?.tabId) {
        void handleExternalOwner(current.tabId);
      }
    };

    const onUnload = () => {
      maybeReleaseLock();
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);

    releaseCallback = () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
      try {
        activeChannel?.close();
      } catch {
        // ignore channel errors
      }
      activeChannel = null;
      installed = false;
    };
  }

  writeLockRecord(tabId);

  return () => {
    releaseCallback?.();
    releaseCallback = null;
  };
}
