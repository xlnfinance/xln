// Toast notification store
import { writable } from 'svelte/store';

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  duration?: number; // ms, 0 = persistent
}

function createToastStore() {
  const { subscribe, update } = writable<Toast[]>([]);

  let idCounter = 0;

  function add(type: Toast['type'], message: string, duration = 4000) {
    const id = `toast-${++idCounter}`;
    const toast: Toast = { id, type, message, duration };

    update(toasts => [...toasts, toast]);

    if (duration > 0) {
      setTimeout(() => remove(id), duration);
    }

    return id;
  }

  function remove(id: string) {
    update(toasts => toasts.filter(t => t.id !== id));
  }

  return {
    subscribe,
    success: (msg: string, duration?: number) => add('success', msg, duration),
    error: (msg: string, duration?: number) => add('error', msg, duration ?? 8000), // 8 sec for errors
    info: (msg: string, duration?: number) => add('info', msg, duration),
    warning: (msg: string, duration?: number) => add('warning', msg, duration),
    remove
  };
}

export const toasts = createToastStore();
