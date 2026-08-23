import { expect, test } from 'bun:test';
import {
  applyRuntimeAdapterCommandMarker,
  readRuntimeAdapterCommandFrontier,
  runtimeAdapterCommandLaneId,
} from '../../../runtime/command/frontier';
import { markLocalRuntimeAdapterCommandTx } from '../../../runtime/command/frontier-auth';
import { applyRuntimeTx } from '../../../runtime/tx/tx-handlers';
import { prepareRuntimeFrameInput } from '../../../runtime/frame/lifecycle/prepare';
import { createFrameExecutionState } from '../../../runtime/frame/intake/execution-state';
import { createRuntimeProcessProfile } from '../../../runtime/frame/process-profile';
import { buildDurableRuntimeMachineSnapshot, restoreDurableRuntimeSnapshot } from '../../../storage/wal/snapshot';
import { createEmptyEnv } from '../../../runtime';
import type { RuntimeInput } from '../../../runtime/types';

const laneId = runtimeAdapterCommandLaneId('device-key', 'short-lived-capability');
const inputHash = `0x${'42'.repeat(32)}`;

const marker = (sequence: number) => ({
  laneId,
  sequence,
  commandId: `runtime-command:${String(sequence).padStart(16, '0')}`,
  inputHash,
  expiresAtMs: 9_999_999_999_999,
});

test('runtime adapter command marker is local-only and survives durable restore', async () => {
  const env = createEmptyEnv('radapter-frontier-restore');
  env.state.height = 7;
  env.state.timestamp = 700;
  const tx = { type: 'recordRuntimeAdapterCommand' as const, data: marker(1) };

  await expect(applyRuntimeTx(env, tx)).rejects.toThrow('RADAPTER_COMMAND_RUNTIME_TX_UNAUTHORIZED');
  await applyRuntimeTx(env, markLocalRuntimeAdapterCommandTx(tx));
  expect(env.infrastructure?.runtimeAdapterCommandFrontiers?.get(laneId)).toMatchObject({
    lastContiguousSequence: 1,
    lastInputHash: inputHash,
    observedHeight: 8,
  });

  const restored = createEmptyEnv('radapter-frontier-restore');
  restoreDurableRuntimeSnapshot(restored, buildDurableRuntimeMachineSnapshot(env));
  expect(restored.infrastructure?.runtimeAdapterCommandFrontiers).toEqual(
    env.infrastructure?.runtimeAdapterCommandFrontiers,
  );
});

test('accepted adapter command remains durable after its capability expires', () => {
  const env = createEmptyEnv('radapter-frontier-expired');
  env.state.timestamp = 100;
  applyRuntimeAdapterCommandMarker(env, { ...marker(1), expiresAtMs: 1_000 });
  expect(env.infrastructure?.runtimeAdapterCommandFrontiers?.get(laneId)?.lastContiguousSequence).toBe(1);
  env.state.timestamp = 2_000;
  expect(() => applyRuntimeAdapterCommandMarker(env, { ...marker(2), expiresAtMs: 1_000 })).not.toThrow();
  expect(env.infrastructure?.runtimeAdapterCommandFrontiers?.get(laneId)?.lastContiguousSequence).toBe(2);
  expect(readRuntimeAdapterCommandFrontier(env, laneId)).toBeUndefined();
});

test('one expired accepted marker cannot delete independent work batched into the Runtime frame', async () => {
  const env = createEmptyEnv('radapter-frontier-batch-isolation');
  env.state.timestamp = 2_000;
  const entityInput = {
    entityId: 'entity-b',
    signerId: 'signer-b',
    entityTxs: [],
  };
  const jInput = { type: 'independent-j-input' } as never;
  const input: RuntimeInput = {
    runtimeTxs: [markLocalRuntimeAdapterCommandTx({
      type: 'recordRuntimeAdapterCommand',
      data: { ...marker(1), expiresAtMs: 1_000 },
    })],
    entityInputs: [entityInput],
    jInputs: [jInput],
  };
  const liveMempool: RuntimeInput = { runtimeTxs: [], entityInputs: [], jInputs: [] };

  const result = await prepareRuntimeFrameInput(
    env,
    env.infrastructure ??= {},
    input,
    liveMempool,
    1_500,
    createFrameExecutionState(),
    createRuntimeProcessProfile(env, 'expired-command-isolation'),
    {
      prioritizeJEventFrame: () => false,
      applyEntityTxFrameCap: () => false,
      applyEntityInputFrameCap: () => false,
    },
  );

  expect(result.hasInput).toBe(true);
  expect(input.runtimeTxs).toHaveLength(1);
  expect(input.entityInputs).toEqual([entityInput]);
  expect(input.jInputs).toEqual([jInput]);
});

test('one million committed commands keep one bounded lane frontier', () => {
  const env = createEmptyEnv('radapter-frontier-million');
  env.state.timestamp = 1;
  for (let sequence = 1; sequence <= 1_000_000; sequence += 1) {
    applyRuntimeAdapterCommandMarker(env, marker(sequence));
  }
  expect(env.infrastructure?.runtimeAdapterCommandFrontiers?.size).toBe(1);
  expect(env.infrastructure?.runtimeAdapterCommandFrontiers?.get(laneId)?.lastContiguousSequence)
    .toBe(1_000_000);
});
