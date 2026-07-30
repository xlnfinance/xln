import type { RuntimeState } from '../types';
import { inferRuntimeLifecyclePhase } from '../lifecycle';
import { ensureRuntimeState } from '../runtime-state';

type RuntimeLifecycleState = NonNullable<RuntimeState['runtimeState']>;

export const assertRuntimeWriterAcceptingIngress = (state: RuntimeLifecycleState): void => {
  if (inferRuntimeLifecyclePhase(state) === 'halted') {
    throw new Error('RUNTIME_PROCESS_HALTED');
  }
};

const waitForCommittedReaders = async (
  state: RuntimeLifecycleState,
): Promise<void> => {
  while ((state.activeCommittedReaders ?? 0) > 0) {
    const drained = state.committedReadersDrained;
    if (!drained) throw new Error('RUNTIME_READ_BARRIER_PROMISE_MISSING');
    await drained;
  }
};

/**
 * Hold a stable committed view across asynchronous API/storage reads.
 *
 * JavaScript's single event loop serializes the final check and increment, so
 * a writer cannot appear between them. The writer performs the symmetric
 * check before installing processingPromise.
 */
export const acquireRuntimeCommittedRead = async (
  env: RuntimeState,
): Promise<() => void> => {
  // The barrier belongs to the live Runtime replica. A detached fallback
  // object would let a writer miss an already-active reader on a fresh Runtime.
  const state = ensureRuntimeState(env);
  while (state.processingPromise) await state.processingPromise;
  if (state.stateMutationInFlight) {
    throw new Error('RUNTIME_COMMITTED_STATE_UNAVAILABLE_RELOAD_REQUIRED');
  }
  state.activeCommittedReaders = (state.activeCommittedReaders ?? 0) + 1;
  if (state.activeCommittedReaders === 1) {
    let resolve!: () => void;
    state.committedReadersDrained = new Promise<void>(done => {
      resolve = done;
    });
    state.resolveCommittedReadersDrained = resolve;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.activeCommittedReaders = Math.max(
      0,
      (state.activeCommittedReaders ?? 1) - 1,
    );
    if (state.activeCommittedReaders !== 0) return;
    state.resolveCommittedReadersDrained?.();
    state.committedReadersDrained = null;
    state.resolveCommittedReadersDrained = null;
  };
};

/**
 * Run an external read while the Runtime's published State is durable.
 *
 * Callers that return references into Runtime State must keep the lease until
 * those references have been projected into an owned response. A lease must
 * never escape through the returned value.
 */
export const withRuntimeCommittedRead = async <T>(
  env: RuntimeState,
  read: () => T | Promise<T>,
): Promise<T> => {
  const release = await acquireRuntimeCommittedRead(env);
  try {
    return await read();
  } finally {
    release();
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
  for (;;) {
    assertRuntimeWriterAcceptingIngress(state);
    while (state.processingPromise) await state.processingPromise;
    if ((state.activeCommittedReaders ?? 0) === 0) break;
    await waitForCommittedReaders(state);
    // Several writers may have awaited the same reader drain. Loop back so
    // only the first installs processingPromise; every other writer queues
    // behind it instead of overwriting its ownership token.
  }
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
