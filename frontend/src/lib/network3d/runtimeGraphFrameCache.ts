import { get, writable } from 'svelte/store';
import type { RuntimeAdapterViewFrame } from '@xln/runtime/xln-api';
import { runtimeView } from '$lib/stores/runtimeViewStore';

export const runtimeGraphLiveFrameCache = writable<Map<string, RuntimeAdapterViewFrame>>(new Map());

runtimeView.subscribe((view) => {
  const runtimeId = String(view.runtimeId || '').trim().toLowerCase();
  if (!runtimeId || !view.frame || view.atHeight !== null || view.loading || view.error) return;
  runtimeGraphLiveFrameCache.update((current) => {
    const previous = current.get(runtimeId);
    if (previous === view.frame) return current;
    const next = new Map(current);
    next.set(runtimeId, view.frame!);
    return next;
  });
});

export const clearRuntimeGraphFrameCache = (runtimeId?: string): void => {
  const normalized = String(runtimeId || '').trim().toLowerCase();
  if (!normalized) {
    runtimeGraphLiveFrameCache.set(new Map());
    return;
  }
  const current = get(runtimeGraphLiveFrameCache);
  if (!current.has(normalized)) return;
  const next = new Map(current);
  next.delete(normalized);
  runtimeGraphLiveFrameCache.set(next);
};
