export type GraphGestureOutcome = 'none' | 'select' | 'open' | 'drag-end';

export type GraphGestureState = {
  active: Record<string, { entityId: string; startedAt: number }>;
  lastTap: Record<string, { entityId: string; endedAt: number }>;
};

export const emptyGraphGestureState = (): GraphGestureState => ({ active: {}, lastTap: {} });

const source = (value: string): string => String(value || '').trim().toLowerCase();
const entity = (value: string): string => String(value || '').trim().toLowerCase();
const time = (value: number): number => Math.max(0, Number(value) || 0);

export const beginGraphGesture = (
  state: GraphGestureState,
  input: { sourceId: string; entityId: string; at: number },
): GraphGestureState => {
  const sourceId = source(input.sourceId);
  const entityId = entity(input.entityId);
  if (!sourceId || !entityId) throw new Error('GRAPH_GESTURE_SOURCE_AND_ENTITY_REQUIRED');
  return { ...state, active: { ...state.active, [sourceId]: { entityId, startedAt: time(input.at) } } };
};

export const endGraphGesture = (
  state: GraphGestureState,
  input: { sourceId: string; entityId: string; at: number; moved: boolean; doubleSelectMs?: number },
): { state: GraphGestureState; outcome: GraphGestureOutcome } => {
  const sourceId = source(input.sourceId);
  const entityId = entity(input.entityId);
  const active = state.active[sourceId];
  if (!active || active.entityId !== entityId) return { state, outcome: 'none' };
  const activeNext = { ...state.active };
  delete activeNext[sourceId];
  if (input.moved) {
    const lastTap = { ...state.lastTap };
    delete lastTap[sourceId];
    return { state: { active: activeNext, lastTap }, outcome: 'drag-end' };
  }
  const endedAt = time(input.at);
  const previous = state.lastTap[sourceId];
  const doubleSelectMs = Math.max(100, Math.floor(Number(input.doubleSelectMs ?? 450)));
  if (previous?.entityId === entityId && endedAt >= previous.endedAt && endedAt - previous.endedAt <= doubleSelectMs) {
    const lastTap = { ...state.lastTap };
    delete lastTap[sourceId];
    return { state: { active: activeNext, lastTap }, outcome: 'open' };
  }
  return {
    state: { active: activeNext, lastTap: { ...state.lastTap, [sourceId]: { entityId, endedAt } } },
    outcome: 'select',
  };
};

