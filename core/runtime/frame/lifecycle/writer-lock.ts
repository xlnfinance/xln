import type { RuntimeReplica } from '../../types';
import { inferRuntimeLifecyclePhase } from '../../replica/lifecycle';
import { ensureRuntimeInfrastructure } from '../../envelope/replica-envelope';

type RuntimeLifecycleState = NonNullable<RuntimeReplica['infrastructure']>;

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

const queueFrameWriter = (state: RuntimeLifecycleState): number => {
  if (!state.frameWritersDrained) {
    let resolve!: () => void;
    state.frameWritersDrained = new Promise<void>(done => {
      resolve = done;
    });
    state.resolveFrameWritersDrained = resolve;
  }
  state.queuedFrameWriters = (state.queuedFrameWriters ?? 0) + 1;
  return (state.frameWriterTicket = (state.frameWriterTicket ?? 0) + 1);
};

const resolveFrameWriterGateIfIdle = (state: RuntimeLifecycleState): void => {
  if ((state.queuedFrameWriters ?? 0) > 0 || state.processingPromise) return;
  state.resolveFrameWritersDrained?.();
  state.frameWritersDrained = null;
  state.resolveFrameWritersDrained = null;
};

const finishFrameWriterQueueEntry = (state: RuntimeLifecycleState): void => {
  state.queuedFrameWriters = Math.max(0, (state.queuedFrameWriters ?? 1) - 1);
  resolveFrameWriterGateIfIdle(state);
};

/**
 * Broadcast that one ticketed writer fully released its frame, waking any
 * committed reader whose target ticket that completion satisfies. Readers
 * re-check their own ticket after waking rather than trusting a single
 * "drained" flag, so a reader never waits past the writers it actually
 * arrived behind.
 */
const markFrameWriterCompleted = (state: RuntimeLifecycleState): void => {
  state.completedFrameWriters = (state.completedFrameWriters ?? 0) + 1;
  const resolvePrevious = state.resolveFrameWriterProgress;
  let resolve!: () => void;
  state.frameWriterProgress = new Promise<void>(done => {
    resolve = done;
  });
  state.resolveFrameWriterProgress = resolve;
  resolvePrevious?.();
};

/**
 * Hold a stable committed view across asynchronous API/storage reads.
 *
 * JavaScript's single event loop serializes the final check and increment, so
 * a writer cannot appear between them. The writer performs the symmetric
 * check before installing processingPromise.
 */
export const acquireRuntimeCommittedRead = async (
  env: RuntimeReplica,
): Promise<() => void> => {
  // The barrier belongs to the live Runtime replica. A detached substitute
  // object would let a writer miss an already-active reader on a fresh Runtime.
  const state = ensureRuntimeInfrastructure(env);
  // Only wait for writers already ticketed ahead of this read. Waiting on the
  // whole queue draining to zero (the prior behavior) starves reads
  // indefinitely once writers arrive back-to-back under continuous load.
  const admitAfterTicket = state.frameWriterTicket ?? 0;
  while ((state.completedFrameWriters ?? 0) < admitAfterTicket) {
    // Lazily install the wake promise: it only otherwise exists once a writer
    // has completed at least once, but a reader can arrive behind a still
    // in-flight first-ever writer.
    if (!state.frameWriterProgress) {
      let resolve!: () => void;
      state.frameWriterProgress = new Promise<void>(done => {
        resolve = done;
      });
      state.resolveFrameWriterProgress = resolve;
    }
    await state.frameWriterProgress;
  }
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
  env: RuntimeReplica,
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
  queueFrameWriter(state);
  let queueEntryFinished = false;
  const finishQueueEntry = (): void => {
    if (queueEntryFinished) return;
    queueEntryFinished = true;
    finishFrameWriterQueueEntry(state);
  };
  try {
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
    finishQueueEntry();
    return () => {
      state.processingPromise = null;
      unlock();
      resolveFrameWriterGateIfIdle(state);
      markFrameWriterCompleted(state);
    };
  } catch (error) {
    // This ticket will never reach the processing-and-release path above, so
    // a committed read waiting on it would hang forever without this.
    markFrameWriterCompleted(state);
    finishQueueEntry();
    throw error;
  }
};
