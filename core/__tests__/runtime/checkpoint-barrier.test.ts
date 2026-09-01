import { expect, test } from 'bun:test';

import { createEmptyEnv } from '../../runtime';
import {
  createCheckpointBarrierRuntimeTx,
} from '../../runtime/checkpoint/barrier';
import { validateRuntimeInputShapeAndLimits } from '../../runtime/mempool/input-validation';
import { applyRuntimeTx } from '../../runtime/tx/tx-handlers';
import { validateRuntimeTx } from '../../runtime/decode/runtime-tx';

test('checkpoint barrier is exact, local-only, replayable, and input-isolated', async () => {
  const env = createEmptyEnv(null);
  const local = createCheckpointBarrierRuntimeTx();
  const decoded = validateRuntimeTx(
    { type: 'checkpointBarrier', data: {} },
    'TEST_CHECKPOINT_BARRIER',
  );

  await expect(applyRuntimeTx(env, decoded)).rejects.toThrow(
    'CHECKPOINT_BARRIER_EXTERNAL_RUNTIME_TX_REJECTED',
  );
  await expect(applyRuntimeTx(env, local)).resolves.toEqual([]);
  await expect(applyRuntimeTx(env, decoded, { isReplay: true })).resolves.toEqual([]);
  expect(() => validateRuntimeTx(
    { type: 'checkpointBarrier', data: { hidden: true } },
    'TEST_CHECKPOINT_BARRIER',
  )).toThrow('TEST_CHECKPOINT_BARRIER_DATA_FIELDS');

  const reject = (message: string): never => {
    throw new Error(message);
  };
  expect(() => validateRuntimeInputShapeAndLimits(env, {
    runtimeTxs: [local],
    entityInputs: [{ entityId: 'x', signerId: 'y', entityTxs: [] }],
  }, reject)).toThrow('Checkpoint barrier must be the only item');
});
