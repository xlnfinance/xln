import React, { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createExternalStore, type ExternalStore } from '../../client-core/external-store';
import { useExternalStore } from '../use-external-store';

export type ExternalStoreHarnessResult = Readonly<{
  activeAfterMount: number;
  maxActiveSubscriptions: number;
  subscribeCount: number;
  cleanupCount: number;
  renderedAfterUpdate: string;
  rendersBeforeNoOp: number;
  rendersAfterNoOp: number;
  activeAfterUnmount: number;
}>;

export const runExternalStoreHarness = (
  container: HTMLElement,
): ExternalStoreHarnessResult => {
  const binding = createExternalStore(0);
  let activeSubscriptions = 0;
  let maxActiveSubscriptions = 0;
  let subscribeCount = 0;
  let cleanupCount = 0;
  let renderCount = 0;

  const trackedStore: ExternalStore<number> = {
    getSnapshot: binding.store.getSnapshot,
    subscribe: (listener) => {
      subscribeCount += 1;
      activeSubscriptions += 1;
      maxActiveSubscriptions = Math.max(maxActiveSubscriptions, activeSubscriptions);
      const unsubscribe = binding.store.subscribe(listener);
      return () => {
        cleanupCount += 1;
        activeSubscriptions -= 1;
        unsubscribe();
      };
    },
  };

  const Probe = () => {
    const snapshot = useExternalStore(trackedStore);
    renderCount += 1;
    return <output data-testid="external-store-value">{snapshot}</output>;
  };

  const root = createRoot(container);
  flushSync(() => root.render(<StrictMode><Probe /></StrictMode>));
  const activeAfterMount = activeSubscriptions;
  flushSync(() => binding.controller.set(1));
  const renderedAfterUpdate = container.textContent ?? '';
  const rendersBeforeNoOp = renderCount;
  flushSync(() => binding.controller.set(1));
  const rendersAfterNoOp = renderCount;
  flushSync(() => root.unmount());

  return Object.freeze({
    activeAfterMount,
    maxActiveSubscriptions,
    subscribeCount,
    cleanupCount,
    renderedAfterUpdate,
    rendersBeforeNoOp,
    rendersAfterNoOp,
    activeAfterUnmount: activeSubscriptions,
  });
};
