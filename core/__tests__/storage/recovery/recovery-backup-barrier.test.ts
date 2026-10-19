import { expect, test } from 'bun:test';

import { createEmptyEnv, processRuntime, registerRecoveryBackupBarrier, sendEntityInput } from '../../../runtime.ts';
import { deliveryAccepted } from '../../../protocol/payments/delivery-result';

test('verified recovery outbox republishes behind the backup barrier without a new financial frame', async () => {
  const env = createEmptyEnv('recovery-barrier-seed');
  env.dbNamespace = `recovery-barrier-${Date.now()}`;
  env.quietRuntimeLogs = true;
  env.state.timestamp = 1_000;

  const targetEntityId = `0x${'ab'.repeat(32)}`;
  const targetSignerId = `0x${'01'.repeat(20)}`;
  env.pendingNetworkOutputs = [
    {
      runtimeId: '0x2222222222222222222222222222222222222222',
      entityId: targetEntityId,
      signerId: targetSignerId,
      entityTxs: [],
      sourceRuntimeFrame: { height: env.state.height, timestamp: env.state.timestamp },
    },
  ];
  env.infrastructure = {
    ...(env.infrastructure || {}),
    loopActive: false,
    wakeRequested: false,
    entityRuntimeHints: new Map([
      [targetEntityId, { runtimeId: '0x2222222222222222222222222222222222222222', seenAt: env.state.timestamp }],
    ]),
    directEntityInputsDispatch: () => {
      expect(barrierCompleted).toBe(true);
      dispatchCount += 1;
      return deliveryAccepted('ROUTE_DIRECT_DELIVERED');
    },
  };

  let dispatchCount = 0;
  let barrierCompleted = false;
  registerRecoveryBackupBarrier(env, async () => {
    barrierCompleted = true;
  });

  const height = env.state.height;
  await processRuntime(env);
  expect(dispatchCount).toBe(1);
  expect(env.pendingNetworkOutputs.length).toBe(0);
  expect(env.state.height).toBe(height);
});

test('direct remote sends fail closed while recovery backup barrier is active', () => {
  const env = createEmptyEnv('recovery-barrier-direct-send');
  env.dbNamespace = `recovery-barrier-direct-${Date.now()}`;
  env.quietRuntimeLogs = true;
  env.state.timestamp = 1_000;

  const targetEntityId = `0x${'cd'.repeat(32)}`;
  const targetSignerId = `0x${'02'.repeat(20)}`;
  let dispatchCount = 0;
  env.infrastructure = {
    ...(env.infrastructure || {}),
    entityRuntimeHints: new Map([
      [targetEntityId, { runtimeId: '0x2222222222222222222222222222222222222222', seenAt: env.state.timestamp }],
    ]),
    directEntityInputsDispatch: () => {
      dispatchCount += 1;
      return deliveryAccepted('ROUTE_DIRECT_DELIVERED');
    },
  };

  registerRecoveryBackupBarrier(env, async () => {});

  expect(() => sendEntityInput(env, { entityId: targetEntityId, signerId: targetSignerId })).toThrow(
    'DIRECT_NETWORK_SEND_REQUIRES_COMMITTED_RECOVERY_BACKUP',
  );
  expect(dispatchCount).toBe(0);
  expect(env.pendingNetworkOutputs?.length ?? 0).toBe(0);
});
