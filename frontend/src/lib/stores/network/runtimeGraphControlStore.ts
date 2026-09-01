import {
  GRAPH3D_CANONICITY_OPTIONS,
  type Graph3dViewportCanonicity,
} from '../../../../packages/runtime-client/src/graph3d-viewport-view';
import { createObservableStore } from '$lib/utils/observableStore';

const CANONICITY_KEY = 'xln-graph-canonicity';
const validCanonicity = new Set<Graph3dViewportCanonicity>(
  GRAPH3D_CANONICITY_OPTIONS.map(({ value }) => value),
);

const initialCanonicity = (): Graph3dViewportCanonicity => {
  if (typeof localStorage === 'undefined') return 'timestamp';
  const stored = localStorage.getItem(CANONICITY_KEY) as Graph3dViewportCanonicity | null;
  return stored && validCanonicity.has(stored) ? stored : 'timestamp';
};

export const runtimeGraphScope = createObservableStore<string>('merged');
export const runtimeGraphCanonicity = createObservableStore<Graph3dViewportCanonicity>(initialCanonicity());

export const runtimeGraphControlOperations = {
  setScope(value: string): string {
    const scope = String(value || '').trim().toLowerCase() || 'merged';
    runtimeGraphScope.set(scope);
    return scope;
  },

  setCanonicity(value: Graph3dViewportCanonicity): Graph3dViewportCanonicity {
    if (!validCanonicity.has(value)) throw new Error(`RUNTIME_GRAPH_CANONICITY_INVALID:${value}`);
    runtimeGraphCanonicity.set(value);
    if (typeof localStorage !== 'undefined') localStorage.setItem(CANONICITY_KEY, value);
    return value;
  },
};
