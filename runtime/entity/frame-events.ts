import type { EntityFrameEvent, EntityState } from '../types';
import { ENTITY_FRAME_EVENT_COLLECTOR } from './frame-event-collector';

type EntityStateWithFrameEvents = EntityState & {
  [ENTITY_FRAME_EVENT_COLLECTOR]?: EntityFrameEvent[];
};

const mutableEntityFrameEvents = (state: EntityState): EntityFrameEvent[] => {
  const transient = state as EntityStateWithFrameEvents;
  if (!transient[ENTITY_FRAME_EVENT_COLLECTOR]) {
    /*
     * This frame-local field is deliberately enumerable while a reducer runs.
     * Entity handlers use ordinary immutable object spreads; a Symbol or
     * non-enumerable property would silently disappear at those boundaries and
     * let validators derive different signed event lists. Explicit state-root
     * and storage projections exclude the collector, and the next frame clears
     * it before apply, so it never becomes durable EntityState.
     */
    transient[ENTITY_FRAME_EVENT_COLLECTOR] = [];
  }
  return transient[ENTITY_FRAME_EVENT_COLLECTOR]!;
};

export const readEntityFrameEvents = (
  state: EntityState,
): EntityFrameEvent[] => structuredClone(mutableEntityFrameEvents(state));

export const clearEntityFrameEvents = (state: EntityState): void => {
  const events =
    (state as EntityStateWithFrameEvents)[ENTITY_FRAME_EVENT_COLLECTOR];
  if (events) events.length = 0;
};

export const copyEntityFrameEvents = (
  source: EntityState,
  target: EntityState,
): void => {
  const events =
    (source as EntityStateWithFrameEvents)[ENTITY_FRAME_EVENT_COLLECTOR];
  if (!events) return;
  (target as EntityStateWithFrameEvents)[ENTITY_FRAME_EVENT_COLLECTOR] =
    structuredClone(events);
};

/**
 * Record a signed frame event without retaining an ever-growing log in state.
 *
 * Validators certify these events as part of the Entity frame. Runtime writes
 * them to Activity history only after the enclosing frame commits.
 */
export const addMessage = (state: EntityState, message: string): void => {
  mutableEntityFrameEvents(state).push({ type: 'status', message });
};

export const addTextMessage = (
  state: EntityState,
  validatorId: string,
  message: string,
): void => {
  mutableEntityFrameEvents(state).push({
    type: 'text',
    validatorId: validatorId.trim().toLowerCase(),
    message,
  });
};

export const readEntityFrameEventMessages = (
  state: EntityState,
): string[] => readEntityFrameEvents(state).map(event =>
  event.type === 'text'
    ? `${event.validatorId}: ${event.message}`
    : event.message
);

export const addMessages = (
  state: EntityState,
  messages: readonly string[],
): void => {
  for (const message of messages) addMessage(state, message);
};
