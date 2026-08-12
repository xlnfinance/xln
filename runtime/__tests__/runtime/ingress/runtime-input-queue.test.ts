import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { enqueueRuntimeInputsWithDeps } from '../../../runtime/input-pipeline/input-queue';
import { LIMITS } from '../../../config/constants';
import type { RuntimeReplica } from '../../../runtime/types';

const makeEnv = (): RuntimeReplica => ({
  state: {
  eReplicas: new Map(),
  jReplicas: new Map(),
  height: 0,
  timestamp: 1000,
  },
  runtimeId: 'runtime-a',
  runtimeMempool: { runtimeTxs: [], entityInputs: [] },
} as RuntimeReplica);

test('runtime input queue debug diagnostics use structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/runtime/input-pipeline/input-queue.ts'), 'utf8');

  expect(source).toContain("const runtimeInputQueueLog = createStructuredLogger('runtime.input_queue');");
  expect(source).toContain("runtimeInputQueueLog.info('interesting_entity_inputs'");
  expect(source).not.toContain('console.');
  expect(source).not.toContain('[enqueueRuntimeInput]');
});

test('enqueueRuntimeInputs timestamps work and wakes the loop', () => {
  const env = makeEnv();
  let wakeCount = 0;

  enqueueRuntimeInputsWithDeps(
    env,
    {
      ensureRuntimeInfrastructure: (targetEnv) => {
        targetEnv.infrastructure ??= {};
        return targetEnv.infrastructure;
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
  expect(env.runtimeMempool.entityInputs).toHaveLength(1);
  expect(env.runtimeMempool.queuedAt).toBe(1000);
});

test('enqueueRuntimeInputs preserves already accepted internal continuations during durable pause', () => {
  const env = makeEnv();
  env.infrastructure = {
    lifecyclePhase: 'quiescing',
    persistenceQuiescing: true,
    persistencePaused: true,
  };
  let wakeCount = 0;

  enqueueRuntimeInputsWithDeps(
    env,
    {
      ensureRuntimeInfrastructure: () => env.infrastructure!,
      requestRuntimeLoopWake: () => { wakeCount += 1; },
    },
    undefined,
    [{ type: 'importReplica' } as never],
    undefined,
    undefined,
    undefined,
    { acceptedBeforeQuiesce: true },
  );
  expect(env.runtimeMempool.runtimeTxs).toHaveLength(1);
  expect(wakeCount).toBe(1);
});

test('enqueueRuntimeInputs rejects work after quiesce has paused durable persistence', () => {
  const env = makeEnv();
  env.infrastructure = {
    lifecyclePhase: 'quiescing',
    persistenceQuiescing: true,
    persistencePaused: true,
  };

  expect(() => enqueueRuntimeInputsWithDeps(
    env,
    {
      ensureRuntimeInfrastructure: () => env.infrastructure!,
      requestRuntimeLoopWake: () => {
        throw new Error('POST_PAUSE_INGRESS_MUST_NOT_WAKE');
      },
    },
    undefined,
    [{ type: 'observeJRange' } as never],
  )).toThrow(
    'RUNTIME_INPUT_INGRESS_AFTER_PERSISTENCE_PAUSE:runtime=runtime-a:runtimeTxs=observeJRange',
  );
  expect(env.runtimeMempool.runtimeTxs).toHaveLength(0);
});

test('runtime input queue rejects an oversized batch atomically', () => {
  const env = makeEnv();
  const oversized = Array.from(
    { length: LIMITS.MAX_RUNTIME_MEMPOOL_ENTITY_INPUTS + 1 },
    (_, index) => ({
      entityId: `entity-${index}`,
      signerId: `signer-${index}`,
      entityTxs: [],
    }),
  );

  expect(() => enqueueRuntimeInputsWithDeps(
    env,
    {
      ensureRuntimeInfrastructure: (targetEnv) => {
        targetEnv.infrastructure ??= {};
        return targetEnv.infrastructure;
      },
      requestRuntimeLoopWake: () => {
        throw new Error('OVERSIZED_BATCH_MUST_NOT_WAKE');
      },
    },
    oversized,
  )).toThrow(
    `RUNTIME_MEMPOOL_CAPACITY_EXCEEDED:entityInputs:` +
    `${LIMITS.MAX_RUNTIME_MEMPOOL_ENTITY_INPUTS + 1}:` +
    `${LIMITS.MAX_RUNTIME_MEMPOOL_ENTITY_INPUTS}`,
  );
  expect(env.runtimeMempool.entityInputs).toHaveLength(0);
});
