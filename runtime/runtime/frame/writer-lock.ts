import type { RuntimeState } from '../../types';
import { inferRuntimeLifecyclePhase } from '../lifecycle';

type RuntimeLifecycleState = NonNullable<RuntimeState['runtimeState']>;

export const assertRuntimeWriterAcceptingIngress = (state: RuntimeLifecycleState): void => {
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
  state: RuntimeLifecycleState,
): Promise<() => void> => {
  assertRuntimeWriterAcceptingIngress(state);
  while (state.processingPromise) await state.processingPromise;
  assertRuntimeWriterAcceptingIngress(state);

  let unlock!: () => void;
  state.processingPromise = new Promise<void>(resolve => {
    unlock = resolve;
  });
  return () => {
    state.processingPromise = null;
    unlock();
  };
};
