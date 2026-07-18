import { expect, test } from 'bun:test';
import { createEmptyEnv, restoreEnvFromCheckpointSnapshot } from '../runtime';
import { buildRuntimeCheckpointSnapshot } from '../wal/snapshot';

test('recovery rejects timestamp normalization instead of clamping durable state', async () => {
  const snapshot = buildRuntimeCheckpointSnapshot(createEmptyEnv('recovery-timestamp-reject'));

  await expect(restoreEnvFromCheckpointSnapshot({
    ...snapshot,
    timestamp: -1,
  })).rejects.toThrow('RECOVERY_CHECKPOINT_TIMESTAMP_INVALID');

  await expect(restoreEnvFromCheckpointSnapshot({
    ...snapshot,
    timestamp: 10.9,
  })).rejects.toThrow('RECOVERY_CHECKPOINT_TIMESTAMP_INVALID');
});
