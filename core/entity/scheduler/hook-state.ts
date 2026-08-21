import type {
  CrontabState,
  ScheduledHook,
} from './types';
import { createStructuredLogger, shortHash } from '../../support/logger';
import {
  EntityCollectionCandidateMap,
  PersistentEntityCollectionMap,
} from '../state/persistent-collection-map';

const crontabLog = createStructuredLogger('entity.crontab');

/** Replace-or-create a deterministic one-shot hook. */
export const scheduleHook = (
  state: CrontabState,
  hook: ScheduledHook,
): void => {
  if (state.hooks instanceof PersistentEntityCollectionMap) {
    state.hooks = state.hooks.updated(hook.id, hook);
  } else {
    state.hooks.set(hook.id, hook);
  }
  crontabLog.debug('hook.scheduled', {
    type: hook.type,
    id: shortHash(hook.id),
    triggerAt: hook.triggerAt,
  });
};

export const cancelHook = (
  state: CrontabState,
  hookId: string,
): void => {
  const existed = state.hooks.has(hookId);
  if (state.hooks instanceof PersistentEntityCollectionMap) {
    state.hooks = state.hooks.removed(hookId);
  } else if (state.hooks instanceof EntityCollectionCandidateMap) {
    state.hooks.delete(hookId);
  } else {
    // Plain maps are accepted only at construction/test boundaries. A frame
    // candidate replaces them with a typed Patricia overlay before commit.
    state.hooks.delete(hookId);
  }
  if (existed) {
    crontabLog.debug('hook.cancelled', { id: shortHash(hookId) });
  }
};
