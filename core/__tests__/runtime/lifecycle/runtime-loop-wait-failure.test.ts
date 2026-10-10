import { expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { createRuntimeLifecycleApi } from '../../../runtime/loop/loop-lifecycle';

test('a throw while the loop waits for work is a reported halt, never a silent stop', async () => {
  // waitForNextRuntimeWork ran outside the loop's try: a throw there ended the
  // loop as "stopped" with no fatal report and an unobserved rejection.
  const env = createEmptyEnv('runtime-loop-wait-failure');
  const errors: string[] = [];
  env.error = (_scope: string, code: string) => { errors.push(code); };
  const lifecycle = createRuntimeLifecycleApi({
    processRuntime: async () => undefined,
    waitForRuntimeProcessingIdle: async () => true,
    hasRuntimeWork: () => false,
    getNextWallClockWakeTimestamp: () => {
      throw new Error('RUNTIME_WAKE_INDEX_BROKEN');
    },
  });

  lifecycle.startRuntimeLoop(env);
  await env.infrastructure?.loopPromise;

  expect(env.infrastructure?.halted).toBe(true);
  expect(errors).toContain('RUNTIME_LOOP_HALTED');
});
