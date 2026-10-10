import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { enqueueRuntimeInputsWithDeps } from '../../../runtime/mempool/input-queue';
import { LIMITS } from '../../../config/constants';
import { safeStringify } from '../../../protocol/serialization';
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
  const source = readFileSync(join(process.cwd(), 'core/runtime/mempool/input-queue.ts'), 'utf8');

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

const poolUrl = new URL('../../../protocol/crypto/crypto-pool.ts', import.meta.url).href;
const primingUrl = new URL('../../../runtime/admit/ingress-priming.ts', import.meta.url).href;

test('a malformed queued input never escapes ingress priming as an uncaught exception', () => {
  // Priming runs from a timer with a live crypto pool. A malformed
  // accountInput threw there; the server's uncaughtException handler exits
  // the whole process, taking every Runtime in it down.
  const child = Bun.spawnSync({
    cmd: [process.execPath, '--eval', `
      import { configureCryptoPoolEntry } from ${safeStringify(poolUrl)};
      import { primeEntityInputsAtIngress } from ${safeStringify(primingUrl)};
      configureCryptoPoolEntry(new URL(${safeStringify(poolUrl)}));
      // The API server's handler (core/api/server/index.ts) exits like this.
      process.on('uncaughtException', () => process.exit(1));
      const env = { state: { eReplicas: new Map() } };
      primeEntityInputsAtIngress(env, [{
        entityId: '0x${'11'.repeat(32)}',
        signerId: '0x${'22'.repeat(20)}',
        entityTxs: [{ type: 'accountInput', data: null }],
      }]);
      await new Promise(resolve => setTimeout(resolve, 50));
      console.log('PRIMING_ALIVE');
      process.exit(0);
    `],
    cwd: process.cwd(),
    env: { ...process.env, XLN_CRYPTO_POOL_WORKERS: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  expect(child.stdout.toString()).toContain('PRIMING_ALIVE');
  expect(child.exitCode).toBe(0);
});
