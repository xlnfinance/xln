import { expect, test } from 'bun:test';
import { createEmptyEnv, restoreEnvFromCheckpointSnapshot } from '../../../runtime';
import { buildRuntimeCheckpointSnapshot } from '../../../storage/wal/snapshot';

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

test('recovery rejects missing or malformed replica collections', async () => {
  const snapshot = buildRuntimeCheckpointSnapshot(createEmptyEnv('recovery-replica-reject'));
  const { eReplicas: _missingEntities, ...withoutEntities } = snapshot;

  await expect(restoreEnvFromCheckpointSnapshot(withoutEntities))
    .rejects.toThrow('RECOVERY_CHECKPOINT_ENTITY_REPLICAS_INVALID');
  await expect(restoreEnvFromCheckpointSnapshot({
    ...snapshot,
    eReplicas: [['only-a-key']],
  })).rejects.toThrow('RUNTIME_SNAPSHOT_EREPLICAS_ENTRY_INVALID:0');
  await expect(restoreEnvFromCheckpointSnapshot({
    ...snapshot,
    jReplicas: [['duplicate', {}], ['duplicate', {}]],
  })).rejects.toThrow('RECOVERY_CHECKPOINT_J_REPLICAS_INVALID:duplicate_key');
});

test('recovery rejects malformed optional Runtime-machine fields', async () => {
  const snapshot = buildRuntimeCheckpointSnapshot(createEmptyEnv('recovery-runtime-machine-reject'));

  await expect(restoreEnvFromCheckpointSnapshot({
    ...snapshot,
    runtimeConfig: 'corrupt',
  })).rejects.toThrow('RECOVERY_CHECKPOINT_RUNTIME_MACHINE_RUNTIME_CONFIG');

  await expect(restoreEnvFromCheckpointSnapshot({
    ...snapshot,
    infrastructure: 'corrupt',
  })).rejects.toThrow('RECOVERY_CHECKPOINT_RUNTIME_MACHINE_RUNTIME_STATE');
});
