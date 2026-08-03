import { createExternalStore } from '../../../packages/client-core/external-store';
import { toSvelteReadable } from './adapters/svelteExternalStore';

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  duration?: number; // ms, 0 = persistent
}

export interface ToastScheduler {
  schedule(delayMs: number, task: () => void): void;
}

export function createToastStore(scheduler: ToastScheduler) {
  const binding = createExternalStore<Toast[]>([]);
  const readable = toSvelteReadable(binding.store);

  let idCounter = 0;

  function add(type: Toast['type'], message: string, duration = 4000) {
    const id = `toast-${++idCounter}`;
    const toast: Toast = { id, type, message, duration };

    binding.controller.update(toasts => [...toasts, toast]);

    if (duration > 0) {
      scheduler.schedule(duration, () => remove(id));
    }

    return id;
  }

  function remove(id: string) {
    binding.controller.update(toasts => toasts.filter(t => t.id !== id));
  }

  return {
    externalStore: binding.store,
    subscribe: readable.subscribe,
    success: (msg: string, duration?: number) => add('success', msg, duration),
    error: (msg: string, duration?: number) => add('error', msg, duration ?? 8000), // 8 sec for errors
    info: (msg: string, duration?: number) => add('info', msg, duration),
    warning: (msg: string, duration?: number) => add('warning', msg, duration),
    remove
  };
}

const toastStore = createToastStore({
  schedule: (delayMs, task) => {
    setTimeout(task, delayMs);
  },
});

export const toastsExternalStore = toastStore.externalStore;
export const toasts = toastStore;
