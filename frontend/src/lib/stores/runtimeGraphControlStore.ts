import { writable } from 'svelte/store';
import type { RuntimeGraphCanonicity } from '$lib/network3d/runtimeGraphProjection';

const CANONICITY_KEY = 'xln-graph-canonicity';
const validCanonicity = new Set<RuntimeGraphCanonicity>(['timestamp', 'height', 'left', 'right', 'hub']);

const initialCanonicity = (): RuntimeGraphCanonicity => {
  if (typeof localStorage === 'undefined') return 'timestamp';
  const stored = localStorage.getItem(CANONICITY_KEY) as RuntimeGraphCanonicity | null;
  return stored && validCanonicity.has(stored) ? stored : 'timestamp';
};

export const runtimeGraphScope = writable<string>('merged');
export const runtimeGraphCanonicity = writable<RuntimeGraphCanonicity>(initialCanonicity());

export const runtimeGraphControlOperations = {
  setScope(value: string): string {
    const scope = String(value || '').trim().toLowerCase() || 'merged';
    runtimeGraphScope.set(scope);
    return scope;
  },

  setCanonicity(value: RuntimeGraphCanonicity): RuntimeGraphCanonicity {
    if (!validCanonicity.has(value)) throw new Error(`RUNTIME_GRAPH_CANONICITY_INVALID:${value}`);
    runtimeGraphCanonicity.set(value);
    if (typeof localStorage !== 'undefined') localStorage.setItem(CANONICITY_KEY, value);
    return value;
  },
};
