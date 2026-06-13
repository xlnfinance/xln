import { expect, test } from 'bun:test';

import { createEmptyEnv, process as processRuntime, registerRecoveryBackupBarrier, sendEntityInput } from '../runtime.ts';

test('stale pending network outputs fail fast instead of retrying after backup recovery', async () => {
  const env = createEmptyEnv('recovery-barrier-seed');
  env.runtimeId = '0x1111111111111111111111111111111111111111';
  env.dbNamespace = `recovery-barrier-${Date.now()}`;
  env.quietRuntimeLogs = true;
  env.timestamp = 1_000;

  const targetEntityId = `0x${'ab'.repeat(32)}`;
  const targetSignerId = `0x${'01'.repeat(20)}`;
  env.pendingNetworkOutputs = [{ entityId: targetEntityId, signerId: targetSignerId }];
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

  let dispatchCount = 0;
  registerRecoveryBackupBarrier(env, async () => {});

  await expect(processRuntime(env)).rejects.toThrow('PENDING_NETWORK_OUTPUTS_FATAL');
  expect(dispatchCount).toBe(0);
  expect(env.pendingNetworkOutputs.length).toBe(1);
});

test('direct remote sends fail closed while recovery backup barrier is active', () => {
  const env = createEmptyEnv('recovery-barrier-direct-send');
  env.runtimeId = '0x1111111111111111111111111111111111111111';
  env.dbNamespace = `recovery-barrier-direct-${Date.now()}`;
  env.quietRuntimeLogs = true;
  env.timestamp = 1_000;

  const targetEntityId = `0x${'cd'.repeat(32)}`;
  const targetSignerId = `0x${'02'.repeat(20)}`;
  let dispatchCount = 0;
  env.runtimeState = {
    ...(env.runtimeState || {}),
    entityRuntimeHints: new Map([[targetEntityId, { runtimeId: '0x2222222222222222222222222222222222222222', seenAt: Date.now() }]]),
    directEntityInputDispatch: () => {
      dispatchCount += 1;
      return true;
    },
  };

  registerRecoveryBackupBarrier(env, async () => {});

  expect(() => sendEntityInput(env, { entityId: targetEntityId, signerId: targetSignerId })).toThrow(
    'DIRECT_NETWORK_SEND_REQUIRES_COMMITTED_RECOVERY_BACKUP',
  );
  expect(dispatchCount).toBe(0);
  expect(env.pendingNetworkOutputs?.length ?? 0).toBe(0);
});
