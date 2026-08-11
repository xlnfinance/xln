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
