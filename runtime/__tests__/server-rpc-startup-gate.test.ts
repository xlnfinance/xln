import { expect, test } from 'bun:test';

import { dispatchRuntimeRpcAfterStartup } from '../api/server/rpc-startup-gate';
import type { RuntimeReplica } from '../runtime/types';

const runtimeFixture = { runtimeId: 'startup-gate-runtime' } as RuntimeReplica;

test('RPC startup gate resolves the Runtime only after recovery completes', async () => {
  let releaseStartup!: () => void;
  const startupBarrier = new Promise<void>(resolve => { releaseStartup = resolve; });
  let readyEnv: RuntimeReplica | null = null;
  const events: string[] = [];
  const pending = dispatchRuntimeRpcAfterStartup(
    startupBarrier,
    () => readyEnv,
    env => { events.push(`attach:${env.runtimeId}`); },
    async env => { events.push(`dispatch:${env?.runtimeId ?? 'null'}`); },
  );

  await Promise.resolve();
  expect(events).toEqual([]);
  readyEnv = runtimeFixture;
  releaseStartup();
  await pending;
  expect(events).toEqual([
    'attach:startup-gate-runtime',
    'dispatch:startup-gate-runtime',
  ]);
});

test('RPC startup gate cannot expose a stale Runtime after failed startup', async () => {
  const events: string[] = [];
  await dispatchRuntimeRpcAfterStartup(
    Promise.resolve(),
    () => null,
    () => { events.push('attach'); },
    async env => { events.push(`dispatch:${env?.runtimeId ?? 'null'}`); },
  );

  expect(events).toEqual(['dispatch:null']);
});
