import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  RuntimeQueryObserver,
  type RuntimeQueryObserverDependencies,
} from '../../../frontend/packages/runtime-client/src/runtime-query-observer';

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}>;

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const createSources = (initialHeight = 7) => {
  let height = initialHeight;
  let heightTeardowns = 0;
  let adapterTeardowns = 0;
  const heightListeners = new Set<() => void>();
  const adapterListeners = new Set<() => void>();
  const dependencies: RuntimeQueryObserverDependencies = {
    readHeight: () => height,
    subscribeHeight: (listener) => {
      heightListeners.add(listener);
      return () => {
        heightTeardowns += 1;
        heightListeners.delete(listener);
      };
    },
    subscribeAdapter: (listener) => {
      adapterListeners.add(listener);
      return () => {
        adapterTeardowns += 1;
        adapterListeners.delete(listener);
      };
    },
  };
  return {
    dependencies,
    setHeight: (value: number) => { height = value; },
    emitHeight: () => { for (const listener of heightListeners) listener(); },
    emitAdapter: () => { for (const listener of adapterListeners) listener(); },
    teardownCounts: () => ({ height: heightTeardowns, adapter: adapterTeardowns }),
  };
};

describe('runtime-client query observer boundary', () => {
  test('publishes an initial loading snapshot and the latest successful read', async () => {
    const sources = createSources(7);
    let reads = 0;
    const observer = new RuntimeQueryObserver(
      async () => `value-${++reads}`,
      sources.dependencies,
    );

    expect(observer.getSnapshot()).toEqual({
      loading: true,
      data: null,
      error: null,
      height: 7,
    });
    await observer.refresh();
    expect(observer.getSnapshot()).toEqual({
      loading: false,
      data: 'value-2',
      error: null,
      height: 7,
    });
    observer.destroy();
  });

  test('prevents an older successful read from replacing a newer result', async () => {
    const sources = createSources();
    const first = deferred<string>();
    const second = deferred<string>();
    let reads = 0;
    const observer = new RuntimeQueryObserver(
      () => (++reads === 1 ? first.promise : second.promise),
      sources.dependencies,
    );
    const refresh = observer.refresh();

    second.resolve('newer');
    await refresh;
    first.resolve('older');
    await settle();

    expect(observer.getSnapshot().data).toBe('newer');
    observer.destroy();
  });

  test('ignores an older failure after a newer read succeeds', async () => {
    const sources = createSources();
    const first = deferred<string>();
    const second = deferred<string>();
    let reads = 0;
    const observer = new RuntimeQueryObserver(
      () => (++reads === 1 ? first.promise : second.promise),
      sources.dependencies,
    );
    const refresh = observer.refresh();

    second.resolve('current');
    await refresh;
    first.reject(new Error('STALE_FAILURE'));
    await settle();

    expect(observer.getSnapshot()).toMatchObject({ data: 'current', error: null });
    observer.destroy();
  });

  test('publishes the current read failure with the latest height', async () => {
    const sources = createSources(5);
    const observer = new RuntimeQueryObserver<string>(
      async () => { throw new Error('QUERY_FAILED'); },
      sources.dependencies,
    );
    sources.setHeight(6);

    await observer.refresh();
    expect(observer.getSnapshot()).toEqual({
      loading: false,
      data: null,
      error: 'QUERY_FAILED',
      height: 6,
    });
    observer.destroy();
  });

  test('clears an earlier error when a later refresh succeeds', async () => {
    const sources = createSources();
    let failing = true;
    const observer = new RuntimeQueryObserver(
      async () => {
        if (failing) throw new Error('QUERY_FAILED');
        return 'recovered';
      },
      sources.dependencies,
    );

    await observer.refresh();
    expect(observer.getSnapshot().error).toBe('QUERY_FAILED');
    failing = false;
    await observer.refresh();
    expect(observer.getSnapshot()).toMatchObject({
      loading: false,
      data: 'recovered',
      error: null,
    });
    observer.destroy();
  });

  test('refreshes from injected height and adapter notifications', async () => {
    const sources = createSources(3);
    let reads = 0;
    const observer = new RuntimeQueryObserver(async () => ++reads, sources.dependencies);
    await observer.refresh();
    const baseline = reads;

    sources.setHeight(4);
    sources.emitHeight();
    await settle();
    expect(reads).toBe(baseline + 1);
    expect(observer.getSnapshot().height).toBe(4);

    sources.emitAdapter();
    await settle();
    expect(reads).toBe(baseline + 2);
    observer.destroy();
  });

  test('notifies every subscriber and honors individual unsubscription', async () => {
    const sources = createSources();
    const observer = new RuntimeQueryObserver(async () => 'value', sources.dependencies);
    await observer.refresh();
    let firstNotifications = 0;
    let secondNotifications = 0;
    const unsubscribeFirst = observer.subscribe(() => { firstNotifications += 1; });
    observer.subscribe(() => { secondNotifications += 1; });

    await observer.refresh();
    expect([firstNotifications, secondNotifications]).toEqual([2, 2]);
    unsubscribeFirst();
    await observer.refresh();
    expect([firstNotifications, secondNotifications]).toEqual([2, 4]);
    observer.destroy();
  });

  test('keeps snapshot identity stable until a publication occurs', async () => {
    const sources = createSources();
    const pending = deferred<string>();
    const observer = new RuntimeQueryObserver(() => pending.promise, sources.dependencies);
    const initial = observer.getSnapshot();

    expect(observer.getSnapshot()).toBe(initial);
    const refresh = observer.refresh();
    expect(observer.getSnapshot()).not.toBe(initial);
    const loading = observer.getSnapshot();
    expect(observer.getSnapshot()).toBe(loading);
    pending.resolve('ready');
    await refresh;
    observer.destroy();
  });

  test('tears down sources and blocks in-flight or post-destroy publication', async () => {
    const sources = createSources();
    const pending = deferred<string>();
    let reads = 0;
    const observer = new RuntimeQueryObserver(() => {
      reads += 1;
      return pending.promise;
    }, sources.dependencies);
    let notifications = 0;
    observer.subscribe(() => { notifications += 1; });
    const beforeDestroy = observer.getSnapshot();

    observer.destroy();
    pending.resolve('too-late');
    await settle();
    await observer.refresh();
    sources.emitHeight();
    sources.emitAdapter();
    await settle();

    expect(observer.getSnapshot()).toBe(beforeDestroy);
    expect(notifications).toBe(0);
    expect(reads).toBe(1);
    expect(sources.teardownCounts()).toEqual({ height: 1, adapter: 1 });
  });

  test('keeps Svelte adaptation and Runtime source wiring outside the observer', () => {
    const boundary = readFileSync(
      'frontend/packages/runtime-client/src/runtime-query-observer.ts',
      'utf8',
    );
    const store = readFileSync('frontend/src/lib/stores/runtimeQueryClient.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/core');
    expect(boundary).not.toContain('runtimeAdapterHeight');
    expect(boundary).not.toContain('runtimeAdapter.subscribe');
    expect(store).toContain('new RuntimeQueryObserver(() => reader(runtimeQueryClient), {');
    expect(store).toContain('runtimeAdapterHeight.subscribe(() => listener())');
    expect(store).toContain('runtimeAdapter.subscribe(() => listener())');
    expect(store).toContain('run(observer.getSnapshot());');
    expect(store).not.toContain('let version = 0');
  });
});
