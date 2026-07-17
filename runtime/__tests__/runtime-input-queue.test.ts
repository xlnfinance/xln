import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { enqueueRuntimeInputs } from '../machine/input-queue';
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
  const source = readFileSync(join(process.cwd(), 'runtime/machine/input-queue.ts'), 'utf8');

  expect(source).toContain("const runtimeInputQueueLog = createStructuredLogger('runtime.input_queue');");
  expect(source).toContain("runtimeInputQueueLog.info('interesting_entity_inputs'");
  expect(source).not.toContain('console.');
  expect(source).not.toContain('[enqueueRuntimeInput]');
});

test('enqueueRuntimeInputs timestamps work and wakes the loop', () => {
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
});

test('enqueueRuntimeInputs preserves already accepted internal continuations during durable pause', () => {
  const env = makeEnv();
  env.runtimeState = {
    lifecyclePhase: 'quiescing',
    persistenceQuiescing: true,
    persistencePaused: true,
  };
  let wakeCount = 0;

  enqueueRuntimeInputs(
    env,
    {
      ensureRuntimeState: () => env.runtimeState!,
      requestRuntimeLoopWake: () => { wakeCount += 1; },
    },
    undefined,
    [{ type: 'importReplica' } as never],
    undefined,
    undefined,
    undefined,
    { acceptedBeforeQuiesce: true },
  );
  expect(env.runtimeInput.runtimeTxs).toHaveLength(1);
  expect(wakeCount).toBe(1);
});

test('enqueueRuntimeInputs rejects work after quiesce has paused durable persistence', () => {
  const env = makeEnv();
  env.runtimeState = {
    lifecyclePhase: 'quiescing',
    persistenceQuiescing: true,
    persistencePaused: true,
  };

  expect(() => enqueueRuntimeInputs(
    env,
    {
      ensureRuntimeState: () => env.runtimeState!,
      requestRuntimeLoopWake: () => {
        throw new Error('POST_PAUSE_INGRESS_MUST_NOT_WAKE');
      },
    },
    undefined,
    [{ type: 'observeJRange' } as never],
  )).toThrow(
    'RUNTIME_INPUT_INGRESS_AFTER_PERSISTENCE_PAUSE:runtime=runtime-a:runtimeTxs=observeJRange',
  );
  expect(env.runtimeInput.runtimeTxs).toHaveLength(0);
});
