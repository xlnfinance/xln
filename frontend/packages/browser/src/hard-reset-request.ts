export const ACTIVE_TAB_CHANNEL_NAME = 'xln-active-tab-lock';
export const ACTIVE_TAB_ID_KEY = 'xln-tab-id';
export const ACTIVE_TAB_OWNED_KEY = 'xln-active-tab-owned';
export const ACTIVE_TAB_HARD_RESET_KEY = 'xln-hard-reset';

export type ActiveTabLockChannelMessage =
  | { type: 'takeover-request'; tabId: string }
  | { type: 'hard-reset'; tabId: string; timestamp: number };

let currentTabId = '';

export const getOrCreateBrowserTabId = (): string => {
  if (currentTabId) return currentTabId;
  currentTabId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  sessionStorage.setItem(ACTIVE_TAB_ID_KEY, currentTabId);
  sessionStorage.removeItem(ACTIVE_TAB_OWNED_KEY);
  return currentTabId;
};

type HardResetChannel = Pick<BroadcastChannel, 'postMessage'>;

export const publishBrowserHardResetRequest = (existingChannel?: HardResetChannel): void => {
  const tabId = getOrCreateBrowserTabId();
  const timestamp = Date.now();
  const message = { type: 'hard-reset', tabId, timestamp } satisfies ActiveTabLockChannelMessage;
  localStorage.setItem(ACTIVE_TAB_HARD_RESET_KEY, JSON.stringify({ tabId, timestamp }));
  if (existingChannel) {
    existingChannel.postMessage(message);
    return;
  }
  const channel = new BroadcastChannel(ACTIVE_TAB_CHANNEL_NAME);
  channel.postMessage(message);
  channel.close();
};
