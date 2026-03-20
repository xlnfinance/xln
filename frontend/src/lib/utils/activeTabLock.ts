import { writable } from 'svelte/store';

const ACTIVE_TAB_LOCK_KEY = 'xln-active-tab-lock';
const ACTIVE_TAB_CHANNEL_NAME = 'xln-active-tab-lock';
const INACTIVE_TAB_STANDBY_KEY = 'xln-inactive-tab-standby';
const TAKEOVER_APPROVAL_TIMEOUT_MS = 3000;

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
const approvalWaiters = new Map<string, Set<() => void>>();

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

function resolveApprovalWaiters(tabId: string): void {
  const waiters = approvalWaiters.get(tabId);
  if (!waiters) return;
  approvalWaiters.delete(tabId);
  for (const resolve of waiters) {
    resolve();
  }
}

function postChannelMessage(message: ActiveTabLockChannelMessage): void {
  try {
    activeChannel?.postMessage(message);
  } catch {
    // ignore channel errors
  }
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

function waitForTakeoverApproval(tabId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const waiters = approvalWaiters.get(tabId);
      if (waiters) {
        waiters.delete(onApproved);
        if (waiters.size === 0) {
          approvalWaiters.delete(tabId);
        }
      }
      clearTimeout(timeoutId);
      resolve();
    };
    const onApproved = () => {
      finish();
    };
    const timeoutId = window.setTimeout(finish, timeoutMs);
    const waiters = approvalWaiters.get(tabId) ?? new Set<() => void>();
    waiters.add(onApproved);
    approvalWaiters.set(tabId, waiters);
  });
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
            resolveApprovalWaiters(tabId);
            return;
          }
          if (message.type === 'claim') {
            const ownerTabId = typeof message.tabId === 'string' ? message.tabId : '';
            if (ownerTabId) {
              void handleExternalOwner(ownerTabId);
            }
            return;
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

  if (previousOwnerTabId) {
    postChannelMessage({
      type: 'takeover-request',
      tabId,
      targetOwnerTabId: previousOwnerTabId,
      timestamp: Date.now(),
      pathname: typeof window !== 'undefined' ? window.location.pathname : '/app',
    });
    await waitForTakeoverApproval(tabId, TAKEOVER_APPROVAL_TIMEOUT_MS);
  }

  writeLockRecord(tabId, previousOwnerTabId);

  return () => {
    releaseCallback?.();
    releaseCallback = null;
  };
}
