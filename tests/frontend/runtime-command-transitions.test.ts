import { expect, test } from 'bun:test';
import {
  createRuntimeCommandLifecycle,
  transitionRuntimeCommandLifecycle,
  type RuntimeCommandLifecycleEvent,
} from '../../frontend/packages/runtime-client/runtime-command-transitions';

const COMMAND_ID = 'runtime-command:00000000-0000-4000-8000-000000000001';

const replay = (events: readonly RuntimeCommandLifecycleEvent[]) =>
  events.reduce(
    transitionRuntimeCommandLifecycle,
    createRuntimeCommandLifecycle({ commandId: COMMAND_ID, durable: true }),
  );

test('durable runtime command lifecycle replays deterministically from explicit evidence', () => {
  const events: RuntimeCommandLifecycleEvent[] = [
    { type: 'journaled', commandId: COMMAND_ID },
    { type: 'submitted', commandId: COMMAND_ID },
    { type: 'acknowledged', commandId: COMMAND_ID, height: 41 },
    { type: 'committed', commandId: COMMAND_ID, height: 42 },
  ];

  expect(replay(events)).toEqual(replay(structuredClone(events)));
  expect(replay(events)).toEqual({
    commandId: COMMAND_ID,
    durable: true,
    phase: 'committed',
    revision: 4,
    acknowledgedAtHeight: 41,
    committedAtHeight: 42,
    retryable: false,
  });
});

test('runtime command lifecycle rejects skips, duplicate completion, stale acknowledgments, and wrong IDs', () => {
  const requested = createRuntimeCommandLifecycle({ commandId: COMMAND_ID, durable: true });
  expect(() => transitionRuntimeCommandLifecycle(requested, {
    type: 'committed', commandId: COMMAND_ID, height: 1,
  })).toThrow('requested->committed');
  expect(() => transitionRuntimeCommandLifecycle(requested, {
    type: 'journaled', commandId: `${COMMAND_ID}-other`,
  })).toThrow('RUNTIME_COMMAND_TRANSITION_ID_MISMATCH');

  const committed = replay([
    { type: 'journaled', commandId: COMMAND_ID },
    { type: 'submitted', commandId: COMMAND_ID },
    { type: 'acknowledged', commandId: COMMAND_ID, height: 1 },
    { type: 'committed', commandId: COMMAND_ID, height: 2 },
  ]);
  expect(() => transitionRuntimeCommandLifecycle(committed, {
    type: 'committed', commandId: COMMAND_ID, height: 2,
  })).toThrow('committed->committed');
  expect(() => transitionRuntimeCommandLifecycle(committed, {
    type: 'acknowledged', commandId: COMMAND_ID, height: 1,
  })).toThrow('committed->acknowledged');
});

test('retryable failure resubmits the same durable command identity only', () => {
  const failed = replay([
    { type: 'journaled', commandId: COMMAND_ID },
    { type: 'submitted', commandId: COMMAND_ID },
    { type: 'failed', commandId: COMMAND_ID, retryable: true },
  ]);
  const retried = transitionRuntimeCommandLifecycle(failed, {
    type: 'submitted', commandId: COMMAND_ID,
  });
  expect(retried).toMatchObject({ commandId: COMMAND_ID, phase: 'submitted', retryable: false });

  const terminal = transitionRuntimeCommandLifecycle(retried, {
    type: 'failed', commandId: COMMAND_ID, retryable: false,
  });
  expect(() => transitionRuntimeCommandLifecycle(terminal, {
    type: 'submitted', commandId: COMMAND_ID,
  })).toThrow('failed->submitted');
});
