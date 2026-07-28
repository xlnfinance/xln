import type { Env } from '../../types';
import { inferRuntimeLifecyclePhase } from '../lifecycle';

type RuntimeState = NonNullable<Env['runtimeState']>;

const assertRuntimeNotHalted = (state: RuntimeState): void => {
  if (inferRuntimeLifecyclePhase(state) === 'halted') {
    throw new Error('RUNTIME_PROCESS_HALTED');
  }
};

/**
 * Serializes Runtime frame construction around one process-local writer.
 * Rechecking halt after the wait is essential: the preceding writer may have
 * discovered an ambiguous WAL outcome while this caller was queued.
 */
export const acquireRuntimeFrameWriter = async (
  state: RuntimeState,
): Promise<() => void> => {
  assertRuntimeNotHalted(state);
  while (state.processingPromise) await state.processingPromise;
  assertRuntimeNotHalted(state);

  let unlock!: () => void;
  state.processingPromise = new Promise<void>(resolve => {
    unlock = resolve;
  });
  return () => {
    state.processingPromise = null;
    unlock();
  };
};
