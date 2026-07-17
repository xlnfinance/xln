import { expect, test } from 'bun:test';
import {
  applyRuntimeAdapterCommandMarker,
  runtimeAdapterCommandLaneId,
} from '../radapter/command-frontier';
import { markLocalRuntimeAdapterCommandTx } from '../radapter/command-frontier-auth';
import { applyRuntimeTx } from '../machine/tx-handlers';
import { buildDurableRuntimeMachineSnapshot, restoreDurableRuntimeSnapshot } from '../wal/snapshot';
import { createEmptyEnv } from '../runtime';

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
  env.height = 7;
  env.timestamp = 700;
  const tx = { type: 'recordRuntimeAdapterCommand' as const, data: marker(1) };

  await expect(applyRuntimeTx(env, tx)).rejects.toThrow('RADAPTER_COMMAND_RUNTIME_TX_UNAUTHORIZED');
  await applyRuntimeTx(env, markLocalRuntimeAdapterCommandTx(tx));
  expect(env.runtimeState?.runtimeAdapterCommandFrontiers?.get(laneId)).toMatchObject({
    lastContiguousSequence: 1,
    lastInputHash: inputHash,
    observedHeight: 8,
  });

  const restored = createEmptyEnv('radapter-frontier-restore');
  restoreDurableRuntimeSnapshot(restored, buildDurableRuntimeMachineSnapshot(env));
  expect(restored.runtimeState?.runtimeAdapterCommandFrontiers).toEqual(
    env.runtimeState?.runtimeAdapterCommandFrontiers,
  );
});

test('one million committed commands keep one bounded lane frontier', () => {
  const env = createEmptyEnv('radapter-frontier-million');
  env.timestamp = 1;
  for (let sequence = 1; sequence <= 1_000_000; sequence += 1) {
    applyRuntimeAdapterCommandMarker(env, marker(sequence));
  }
  expect(env.runtimeState?.runtimeAdapterCommandFrontiers?.size).toBe(1);
  expect(env.runtimeState?.runtimeAdapterCommandFrontiers?.get(laneId)?.lastContiguousSequence)
    .toBe(1_000_000);
});
