import type {
  CrontabState,
  ScheduledHook,
} from '../scheduler-types';
import { createStructuredLogger, shortHash } from '../../infra/logger';

const crontabLog = createStructuredLogger('entity.crontab');

/** Replace-or-create a deterministic one-shot hook. */
export const scheduleHook = (
  state: CrontabState,
  hook: ScheduledHook,
): void => {
  state.hooks ??= new Map();
  state.hooks.set(hook.id, hook);
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
  if (!state.hooks) return;
  if (state.hooks.delete(hookId)) {
    crontabLog.debug('hook.cancelled', { id: shortHash(hookId) });
  }
};

export const getEarliestHookTime = (state: CrontabState): number => {
  if (!state.hooks || state.hooks.size === 0) return Infinity;
  let earliest = Infinity;
  for (const hook of state.hooks.values()) {
    if (hook.triggerAt < earliest) earliest = hook.triggerAt;
  }
  return earliest;
};
