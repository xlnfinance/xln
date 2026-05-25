import { expect, test } from 'bun:test';

import { createEmptyEnv, process as processRuntime, registerRecoveryBackupBarrier } from '../runtime.ts';

test('recovery backup barrier holds remote outputs until backup succeeds', async () => {
  const env = createEmptyEnv('recovery-barrier-seed');
  env.runtimeId = '0x1111111111111111111111111111111111111111';
  env.dbNamespace = `recovery-barrier-${Date.now()}`;
  env.quietRuntimeLogs = true;
  env.timestamp = 1_000;

  const targetEntityId = `0x${'ab'.repeat(32)}`;
  env.pendingNetworkOutputs = [{ entityId: targetEntityId }];
  env.runtimeState = {
    ...(env.runtimeState || {}),
    loopActive: false,
    wakeRequested: false,
    clockPrimed: true,
    entityRuntimeHints: new Map([[targetEntityId, { runtimeId: '0x2222222222222222222222222222222222222222', seenAt: Date.now() }]]),
    directEntityInputDispatch: () => {
      dispatchCount += 1;
      return true;
    },
  };

  let barrierAttempts = 0;
  let dispatchCount = 0;
  registerRecoveryBackupBarrier(env, async () => {
    barrierAttempts += 1;
    if (barrierAttempts === 1) {
      throw new Error('tower unavailable');
    }
  });

  await processRuntime(env);
  expect(barrierAttempts).toBe(1);
  expect(dispatchCount).toBe(0);
  expect(env.pendingNetworkOutputs.length).toBe(1);

  env.timestamp += 6_000;
  await processRuntime(env);
  expect(barrierAttempts).toBe(2);
  expect(dispatchCount).toBe(1);
  expect(env.pendingNetworkOutputs.length).toBe(0);
});
