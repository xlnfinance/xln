import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  ACTIVE_TAB_WEB_LOCK_NAME,
  INACTIVE_TAB_STANDBY_KEY,
  createActiveTabLockController,
  type ActiveTabLockBrowser,
  type ActiveTabLockState,
} from '../../../frontend/packages/browser/src/active-tab-lock';
import {
  ACTIVE_TAB_HARD_RESET_KEY,
  ACTIVE_TAB_OWNED_KEY,
} from '../../../frontend/packages/browser/src/hard-reset-request';

type MemoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Readonly<{
  entries: () => Readonly<Record<string, string>>;
}>;

type TestChannel = Pick<BroadcastChannel, 'onmessage' | 'postMessage' | 'close'> & {
  sent: unknown[];
  closed: boolean;
};

type DeferredTask = Readonly<{ callback: () => void; delayMs: number }>;

const createMemoryStorage = (): MemoryStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    entries: () => Object.fromEntries(values),
  };
};

const createChannel = (): TestChannel => ({
  onmessage: null,
  sent: [],
  closed: false,
  postMessage(message): void {
    this.sent.push(message);
  },
  close(): void {
    this.closed = true;
  },
});

type LockHarness = Readonly<{
  browser: ActiveTabLockBrowser;
  channel: TestChannel;
  session: MemoryStorage;
  states: ActiveTabLockState[];
  storageListeners: Set<(event: StorageEvent) => void>;
  deferredTasks: DeferredTask[];
  replacements: string[];
  publishedHardResets: number[];
  lockRequests: Array<Readonly<{ name: string; ifAvailable: boolean }>>;
  setLockAvailable: (available: boolean) => void;
  wasLockReleased: () => boolean;
  waitForLockRelease: () => Promise<void>;
}>;

const createLockHarness = (): LockHarness => {
  const channel = createChannel();
  const session = createMemoryStorage();
  const states: ActiveTabLockState[] = [];
  const storageListeners = new Set<(event: StorageEvent) => void>();
  const deferredTasks: DeferredTask[] = [];
  const replacements: string[] = [];
  const publishedHardResets: number[] = [];
  const lockRequests: Array<Readonly<{ name: string; ifAvailable: boolean }>> = [];
  let lockAvailable = true;
  let lockReleased = false;
  let resolveLockReleased!: () => void;
  const lockRelease = new Promise<void>((resolve) => { resolveLockReleased = resolve; });
  const browser: ActiveTabLockBrowser = {
    session,
    createChannel: () => channel,
    requestLock: async (name, options, callback) => {
      lockRequests.push({ name, ifAvailable: options.ifAvailable === true });
      const lock = lockAvailable
        ? ({ name, mode: 'exclusive' } as Lock)
        : null;
      try {
        await callback(lock);
      } finally {
        if (lock) {
          lockReleased = true;
          resolveLockReleased();
        }
      }
    },
    addStorageListener: (handler) => { storageListeners.add(handler); },
    removeStorageListener: (handler) => { storageListeners.delete(handler); },
    defer: (callback, delayMs) => { deferredTasks.push({ callback, delayMs }); },
    replaceLocation: (url) => { replacements.push(url); },
    getTabId: () => 'tab-a',
    publishHardReset: () => { publishedHardResets.push(1); },
  };
  return {
    browser,
    channel,
    session,
    states,
    storageListeners,
    deferredTasks,
    replacements,
    publishedHardResets,
    lockRequests,
    setLockAvailable: (available) => { lockAvailable = available; },
    wasLockReleased: () => lockReleased,
    waitForLockRelease: () => lockRelease,
  };
};

const createController = (harness: LockHarness) => createActiveTabLockController({
  publishState: (state) => { harness.states.push(state); },
  readBrowser: () => harness.browser,
});

describe('browser active-tab lock boundary', () => {
  test('stores inactive standby state only in the current tab session', () => {
    const harness = createLockHarness();
    const controller = createController(harness);

    expect(controller.isInactiveTabStandby()).toBe(false);
    controller.enterInactiveTabStandby();
    expect(controller.isInactiveTabStandby()).toBe(true);
    expect(harness.session.entries()).toEqual({ [INACTIVE_TAB_STANDBY_KEY]: '1' });
    controller.clearInactiveTabStandby();
    expect(controller.isInactiveTabStandby()).toBe(false);
  });

  test('acquires exclusive ownership and releases every installed resource', async () => {
    const harness = createLockHarness();
    const controller = createController(harness);
    const release = await controller.initializeActiveTabLock(() => {});

    expect(controller.ownsActiveTabLock()).toBe(true);
    expect(harness.lockRequests).toEqual([{ name: ACTIVE_TAB_WEB_LOCK_NAME, ifAvailable: false }]);
    expect(harness.channel.sent).toEqual([{ type: 'takeover-request', tabId: 'tab-a' }]);
    expect(harness.session.getItem(ACTIVE_TAB_OWNED_KEY)).toBe('tab-a');
    expect(harness.states.at(-1)).toEqual({ tabId: 'tab-a', ownerTabId: 'tab-a', isOwner: true });

    release();
    await harness.waitForLockRelease();
    expect(controller.ownsActiveTabLock()).toBe(false);
    expect(harness.channel.closed).toBe(true);
    expect(harness.storageListeners.size).toBe(0);
    expect(harness.session.getItem(ACTIVE_TAB_OWNED_KEY)).toBeNull();
    expect(harness.wasLockReleased()).toBe(true);
  });

  test('non-evicting projection acquisition returns null and cleans listeners', async () => {
    const harness = createLockHarness();
    harness.setLockAvailable(false);
    const controller = createController(harness);

    expect(await controller.tryInitializeActiveTabLock(() => {})).toBeNull();
    expect(harness.lockRequests).toEqual([{ name: ACTIVE_TAB_WEB_LOCK_NAME, ifAvailable: true }]);
    expect(harness.channel.sent).toEqual([]);
    expect(harness.channel.closed).toBe(true);
    expect(harness.storageListeners.size).toBe(0);
    expect(controller.ownsActiveTabLock()).toBe(false);
  });

  test('takeover waits for quiesce before releasing ownership', async () => {
    const harness = createLockHarness();
    const controller = createController(harness);
    let finishQuiesce!: () => void;
    const quiesced = new Promise<void>((resolve) => { finishQuiesce = resolve; });
    await controller.initializeActiveTabLock(async () => quiesced);

    harness.channel.onmessage?.({
      data: { type: 'takeover-request', tabId: 'tab-b' },
    } as MessageEvent<unknown>);
    await Promise.resolve();
    expect(controller.ownsActiveTabLock()).toBe(true);
    expect(harness.session.getItem(INACTIVE_TAB_STANDBY_KEY)).toBe('1');
    expect(harness.wasLockReleased()).toBe(false);

    finishQuiesce();
    await controller.waitForActiveTabLockLoss();
    await Promise.resolve();
    expect(controller.ownsActiveTabLock()).toBe(false);
    expect(harness.states.at(-1)).toEqual({ tabId: 'tab-a', ownerTabId: 'tab-b', isOwner: false });
    expect(harness.wasLockReleased()).toBe(true);
  });

  test('hard reset quiesces the lock before scheduling document replacement', async () => {
    const harness = createLockHarness();
    const controller = createController(harness);
    await controller.initializeActiveTabLock(() => {});

    harness.channel.onmessage?.({
      data: { type: 'hard-reset', tabId: 'tab-b', timestamp: 1 },
    } as MessageEvent<unknown>);
    await controller.waitForActiveTabLockLoss();
    await Promise.resolve();
    expect(harness.deferredTasks.at(-1)?.delayMs).toBe(50);
    harness.deferredTasks.at(-1)?.callback();
    expect(harness.replacements).toEqual(['about:blank']);
  });

  test('malformed storage reset payload fails asynchronously and loudly', async () => {
    const harness = createLockHarness();
    const controller = createController(harness);
    const release = await controller.tryInitializeActiveTabLock(() => {});
    const listener = Array.from(harness.storageListeners)[0]!;

    listener({ key: ACTIVE_TAB_HARD_RESET_KEY, newValue: '{' } as StorageEvent);
    const failure = harness.deferredTasks.at(-1);
    expect(failure?.delayMs).toBe(0);
    expect(() => failure?.callback()).toThrow('ACTIVE_TAB_RESET_JSON_INVALID');
    release?.();
    await harness.waitForLockRelease();
  });

  test('broadcast delegates to the canonical hard-reset publisher', () => {
    const harness = createLockHarness();
    const controller = createController(harness);
    controller.broadcastHardResetRequest();
    expect(harness.publishedHardResets).toHaveLength(1);
  });

  test('keeps the Svelte module as a thin state adapter', () => {
    const boundary = readFileSync('frontend/packages/browser/src/active-tab-lock.ts', 'utf8');
    const adapter = readFileSync('frontend/src/lib/utils/control/activeTabLock.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(adapter).toContain('createActiveTabLockController');
    expect(adapter).toContain('publishState: (state) => activeTabLock.set(state)');
    expect(adapter).not.toContain('navigator.locks.request');
    expect(adapter).not.toContain('new BroadcastChannel');
  });
});
