import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { enqueueRuntimeInputs } from '../runtime-input-queue';
import type { Env, RuntimeInput } from '../types';

const makeEnv = (): Env => ({
  eReplicas: new Map(),
  jReplicas: new Map(),
  height: 0,
  timestamp: 1000,
  runtimeId: 'runtime-a',
  runtimeInput: { runtimeTxs: [], entityInputs: [] },
} as Env);

test('runtime input queue debug diagnostics use structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/runtime-input-queue.ts'), 'utf8');

  expect(source).toContain("const runtimeInputQueueLog = createStructuredLogger('runtime.input_queue');");
  expect(source).toContain("runtimeInputQueueLog.info('interesting_entity_inputs'");
  expect(source).not.toContain('console.');
  expect(source).not.toContain('[enqueueRuntimeInput]');
});

test('enqueueRuntimeInputs primes clock and wakes loop for meaningful entity input', () => {
  const env = makeEnv();
  let wakeCount = 0;

  enqueueRuntimeInputs(
    env,
    {
      ensureRuntimeState: (targetEnv) => {
        targetEnv.runtimeState ??= {};
        return targetEnv.runtimeState;
      },
      requestRuntimeLoopWake: () => {
        wakeCount += 1;
      },
    },
    [{
      entityId: 'entity-a',
      signerId: 'signer-a',
      entityTxs: [{ type: 'j_broadcast' } as never],
    }],
    undefined,
    undefined,
    900,
  );

  expect(wakeCount).toBe(1);
  expect(env.runtimeMempool).toBe(env.runtimeInput);
  expect((env.runtimeInput as RuntimeInput).entityInputs).toHaveLength(1);
  expect(env.runtimeInput.queuedAt).toBe(1000);
  expect(env.runtimeState?.clockPrimed).toBe(true);
});
