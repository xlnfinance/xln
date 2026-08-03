import { afterAll, beforeEach, expect, test } from 'bun:test';
import { appState, appStateOperations } from '../../frontend/src/lib/stores/appStateStore';
import { errorLog } from '../../frontend/src/lib/stores/errorLogStore';
import { runtimeAdapterHeight, runtimeControllerHandle } from '../../frontend/src/lib/stores/runtimeControllerStore';
import { createRuntimeQueryStore } from '../../frontend/src/lib/stores/runtimeQueryClient';
import { runtimes, runtimeOperations, type Runtime } from '../../frontend/src/lib/stores/runtimeStore';
import { settings, settingsOperations } from '../../frontend/src/lib/stores/settingsStore';
import { activeTabId, tabOperations } from '../../frontend/src/lib/stores/tabStore';
import { loadXlnRuntimeModule } from '../../frontend/src/lib/stores/xlnRuntimeLoader';

const get = <T>(store: { subscribe(run: (value: T) => void): () => void }): T => {
  let snapshot!: T;
  const unsubscribe = store.subscribe((value) => {
    snapshot = value;
  });
  unsubscribe();
  return snapshot;
};

const originalLocalStorage = globalThis.localStorage;

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
};

const runtime = (id: string): Runtime => ({
  id,
  type: 'local',
  label: id,
  env: null,
  permissions: 'write',
  status: 'connected',
});

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: createMemoryStorage(),
  });
  errorLog.clear();
  tabOperations.clearAllTabs();
  runtimes.set(new Map());
  runtimeControllerHandle.set({
    id: 'embedded',
    runtimeId: 'embedded',
    pendingRuntimeId: '',
    mode: 'embedded',
    endpoint: 'embedded',
    permissions: 'write',
    status: 'disconnected',
    height: 0,
    authLevel: null,
    commandReady: false,
    commandReadyReason: 'adapter-disconnected',
  });
});

afterAll(() => {
  if (originalLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, 'localStorage');
    return;
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: originalLocalStorage,
  });
});

test('settings normalize persisted values and clear corrupt storage loudly', () => {
  localStorage.setItem('xln-settings', JSON.stringify({
    liteMode: true,
    tokenPrecision: 99,
    barColorMode: 'invalid',
    balanceRefreshMs: 99_999,
  }));
  settingsOperations.loadFromStorage();

  expect(get(settings)).toMatchObject({
    liteMode: true,
    tokenPrecision: 18,
    barColorMode: 'rgy',
    balanceRefreshMs: 1_000,
  });

  localStorage.setItem('xln-settings', '{broken');
  settingsOperations.loadFromStorage();
  expect(localStorage.getItem('xln-settings')).toBeNull();
  expect(get(errorLog).at(-1)?.message).toContain('Failed to load settings');
});

test('app navigation clears downstream selections and persists supported state', () => {
  appStateOperations.setMode('user');
  appStateOperations.setViewMode('home');
  appStateOperations.resetNavigation();
  appStateOperations.navigate('jurisdiction', 'alpha');
  appStateOperations.navigate('signer', 'signer-a');
  appStateOperations.navigate('entity', 'entity-a');
  appStateOperations.navigate('account', 'account-a');

  appStateOperations.navigate('signer', 'signer-b');
  appStateOperations.openDockPanel('runtime-diagnostics');

  expect(get(appState)).toMatchObject({
    mode: 'dev',
    viewMode: 'home',
    requestedDockPanel: 'runtime-diagnostics',
    navigation: {
      runtime: 'local',
      jurisdiction: 'alpha',
      signer: 'signer-b',
      entity: null,
      account: null,
    },
  });
  expect(localStorage.getItem('xln-app-mode')).toBe('dev');
  expect(localStorage.getItem('xln-view-mode')).toBe('home');
});

test('tabs persist exact selection and choose a remaining tab after removal', () => {
  const first = tabOperations.addTab('entity-a', 'signer-a', 'alpha');
  const second = tabOperations.addTab('entity-b', 'signer-b', 'beta');
  expect(get(activeTabId)).toBe(second.id);

  tabOperations.closeTab(second.id);
  expect(get(activeTabId)).toBe(first.id);
  expect(tabOperations.getActiveTab()?.id).toBe(first.id);

  const persisted = JSON.parse(localStorage.getItem('xln-entity-tabs') ?? '{}');
  expect(persisted.activeTabId).toBe(first.id);
  expect(persisted.tabs).toHaveLength(1);
});

test('runtime removal clears an active pending selection without replacing state ownership', async () => {
  runtimes.set(new Map([
    ['runtime-a', runtime('runtime-a')],
    ['runtime-b', runtime('runtime-b')],
  ]));
  runtimeOperations.setActiveRuntimeId('runtime-a');

  await runtimeOperations.disconnect('runtime-a');

  expect(Array.from(get(runtimes).keys())).toEqual(['runtime-b']);
  expect(get(runtimeControllerHandle).pendingRuntimeId).toBe('');
});

test('runtime loader preserves transport failures and rejects malformed modules', async () => {
  await expect(loadXlnRuntimeModule({
    runtimeUrl: () => 'https://xln.test/runtime.js',
    load: async () => {
      throw new Error('runtime transport failed');
    },
  })).rejects.toThrow('runtime transport failed');

  await expect(loadXlnRuntimeModule({
    runtimeUrl: () => 'https://xln.test/runtime.js',
    load: async () => ({}),
  })).rejects.toThrow('RUNTIME_API_MISMATCH');
});

test('runtime query store initializes once and tears down adapter subscriptions', async () => {
  runtimeAdapterHeight.set(0);
  let reads = 0;
  const query = createRuntimeQueryStore(async () => ++reads);
  await Promise.resolve();
  await Promise.resolve();

  expect(reads).toBe(1);
  expect(get(query)).toMatchObject({ loading: false, data: 1, height: 0 });

  runtimeAdapterHeight.set(1);
  await Promise.resolve();
  await Promise.resolve();
  expect(reads).toBe(2);

  query.destroy();
  runtimeAdapterHeight.set(2);
  await Promise.resolve();
  expect(reads).toBe(2);
});
