export type RuntimeCommandLifecyclePhase =
  | 'requested'
  | 'journaled'
  | 'submitted'
  | 'acknowledged'
  | 'committed'
  | 'failed';

export type RuntimeCommandLifecycle = Readonly<{
  commandId: string;
  durable: boolean;
  phase: RuntimeCommandLifecyclePhase;
  revision: number;
  acknowledgedAtHeight: number | null;
  committedAtHeight: number | null;
  retryable: boolean;
}>;

export type RuntimeCommandLifecycleEvent =
  | Readonly<{ type: 'journaled'; commandId: string }>
  | Readonly<{ type: 'submitted'; commandId: string }>
  | Readonly<{ type: 'acknowledged'; commandId: string; height: number | null }>
  | Readonly<{ type: 'committed'; commandId: string; height: number | null }>
  | Readonly<{ type: 'failed'; commandId: string; retryable: boolean }>;

const transitionError = (
  snapshot: RuntimeCommandLifecycle,
  event: RuntimeCommandLifecycleEvent,
): Error => new Error(`RUNTIME_COMMAND_TRANSITION_INVALID:${snapshot.phase}->${event.type}`);

const assertHeight = (height: number | null): void => {
  if (height !== null && (!Number.isSafeInteger(height) || height < 0)) {
    throw new Error(`RUNTIME_COMMAND_TRANSITION_HEIGHT_INVALID:${String(height)}`);
  }
};

export const createRuntimeCommandLifecycle = (options: {
  commandId: string;
  durable: boolean;
}): RuntimeCommandLifecycle => Object.freeze({
  commandId: options.commandId,
  durable: options.durable,
  phase: 'requested',
  revision: 0,
  acknowledgedAtHeight: null,
  committedAtHeight: null,
  retryable: false,
});

export const transitionRuntimeCommandLifecycle = (
  snapshot: RuntimeCommandLifecycle,
  event: RuntimeCommandLifecycleEvent,
): RuntimeCommandLifecycle => {
  if (event.commandId !== snapshot.commandId) {
    throw new Error(`RUNTIME_COMMAND_TRANSITION_ID_MISMATCH:${snapshot.commandId}:${event.commandId}`);
  }

  if (event.type === 'journaled') {
    if (!snapshot.durable || snapshot.phase !== 'requested') throw transitionError(snapshot, event);
    return Object.freeze({ ...snapshot, phase: 'journaled', revision: snapshot.revision + 1 });
  }

  if (event.type === 'submitted') {
    const initialSubmission = snapshot.phase === (snapshot.durable ? 'journaled' : 'requested');
    const retry = snapshot.phase === 'failed' && snapshot.retryable;
    if (!initialSubmission && !retry) throw transitionError(snapshot, event);
    return Object.freeze({
      ...snapshot,
      phase: 'submitted',
      revision: snapshot.revision + 1,
      retryable: false,
    });
  }

  if (event.type === 'acknowledged') {
    assertHeight(event.height);
    if (snapshot.phase !== 'submitted' && snapshot.phase !== 'acknowledged') {
      throw transitionError(snapshot, event);
    }
    return Object.freeze({
      ...snapshot,
      phase: 'acknowledged',
      revision: snapshot.revision + 1,
      acknowledgedAtHeight: event.height ?? snapshot.acknowledgedAtHeight,
    });
  }

  if (event.type === 'committed') {
    assertHeight(event.height);
    if (snapshot.phase !== 'acknowledged') throw transitionError(snapshot, event);
    return Object.freeze({
      ...snapshot,
      phase: 'committed',
      revision: snapshot.revision + 1,
      committedAtHeight: event.height ?? snapshot.committedAtHeight ?? snapshot.acknowledgedAtHeight,
    });
  }

  if (snapshot.phase === 'requested' || snapshot.phase === 'failed') {
    throw transitionError(snapshot, event);
  }
  return Object.freeze({
    ...snapshot,
    phase: 'failed',
    revision: snapshot.revision + 1,
    retryable: event.retryable,
  });
};
