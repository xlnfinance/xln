import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getFrameDb,
  loadEnvFromDB,
  persistRestoredEnvToDB,
  process as processRuntime,
  registerSignerKey,
} from '../runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
} from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { readStorageFrameRecord } from '../storage';
import { resolveDbPath } from '../storage/runtime-dbs';
import type { EntityReplica, Env, JReplica, JurisdictionConfig } from '../types';

type RecoveryEnv = { env: Env; entityId: string; signerId: string; replica: EntityReplica };
const cleanupPaths: string[] = [];

const cleanup = (base: string): void => {
  for (const suffix of ['', '-storage-current', '-storage-previous', '-frames', '-events', '-infra']) {
    rmSync(`${base}${suffix}`, { recursive: true, force: true });
  }
};

afterEach(() => {
  while (cleanupPaths.length > 0) cleanup(cleanupPaths.pop()!);
});

const createRecoveryEnv = async (
  seed: string,
  saveDuringProcess = false,
  committedProfileName?: string,
  dbNamespaceSuffix?: string,
): Promise<RecoveryEnv> => {
  const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const jurisdiction: JurisdictionConfig = {
    name: 'restore-import-policy',
    address: 'browservm://restore-import-policy',
    depositoryAddress: '0x000000000000000000000000000000000000dead',
    entityProviderAddress: '0x000000000000000000000000000000000000beef',
    chainId: 31337,
  };
  const env = createEmptyEnv(seed);
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, '1'));
  env.runtimeId = signerId;
  env.dbNamespace = dbNamespaceSuffix ? `${signerId}-${dbNamespaceSuffix}` : signerId;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = {
    ...env.runtimeConfig,
    storage: { ...env.runtimeConfig?.storage, enabled: saveDuringProcess },
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    ...jurisdiction,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    rpcs: [jurisdiction.address!],
    position: { x: 0, y: 0, z: 0 },
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: '0x000000000000000000000000000000000000ac01',
      deltaTransformer: '0x000000000000000000000000000000000000de17',
    },
  } as JReplica);
  enqueueRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importReplica',
      entityId,
      signerId,
      data: {
        isProposer: true,
        config: {
          mode: 'proposer-based',
          threshold: 1n,
          validators: [signerId],
          shares: { [signerId]: 1n },
          jurisdiction,
        },
      },
    }],
    entityInputs: [],
  });
  await processRuntime(env, []);
  if (committedProfileName) {
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'profile-update',
          data: { profile: { entityId, name: committedProfileName } },
        }],
      }],
    });
    await processRuntime(env, []);
  }
  const replica = Array.from(env.eReplicas.values())[0];
  if (!replica) throw new Error('restore import policy replica missing');
  return { env, entityId, signerId, replica };
};

const closeRecoveryEnv = async (env: Env): Promise<void> => {
  await closeRuntimeDb(env);
  await closeInfraDb(env);
};

const assertFreshState = async (
  seed: string,
  expected: { height: number; progress: number; profileName: string },
): Promise<void> => {
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const restored = await loadEnvFromDB(runtimeId, seed);
  if (!restored) throw new Error('restore import policy lost authoritative state');
  try {
    expect(restored.height).toBe(expected.height);
    const replica = Array.from(restored.eReplicas.values())[0];
    expect(replica?.lastConsensusProgressAt).toBe(expected.progress);
    expect(replica?.state.profile.name).toBe(expected.profileName);
  } finally {
    await closeRecoveryEnv(restored);
  }
};

describe('restored checkpoint conflict policy', () => {
  test('rejects lower-height rollback and preserves the higher base', async () => {
    const seed = `restore rollback ${process.pid} deterministic seed`;
    const base = await createRecoveryEnv(seed, false, 'higher-base');
    cleanupPaths.push(resolveDbPath(base.env, 'core'));
    base.env.timestamp = 2_000;
    base.replica.lastConsensusProgressAt = 2_222;
    await persistRestoredEnvToDB(base.env);
    await closeRecoveryEnv(base.env);

    const stale = await createRecoveryEnv(seed);
    stale.env.timestamp = 1_000;
    stale.replica.lastConsensusProgressAt = 1_111;
    await expect(persistRestoredEnvToDB(stale.env)).rejects.toThrow('RECOVERY_IMPORT_ROLLBACK_REJECTED');
    await closeRecoveryEnv(stale.env);
    await assertFreshState(seed, { height: 2, progress: 2_222, profileName: 'higher-base' });
  });

  test('rejects conflicting same-height truth and preserves forensic history', async () => {
    const seed = `restore same height conflict ${process.pid} deterministic seed`;
    const base = await createRecoveryEnv(seed, false, 'candidate-A');
    cleanupPaths.push(resolveDbPath(base.env, 'core'));
    base.env.timestamp = 2_000;
    base.replica.lastConsensusProgressAt = 2_222;
    await persistRestoredEnvToDB(base.env);
    await closeRecoveryEnv(base.env);

    const conflicting = await createRecoveryEnv(seed, false, 'candidate-B');
    conflicting.env.timestamp = 2_000;
    conflicting.replica.lastConsensusProgressAt = 2_222;
    await expect(persistRestoredEnvToDB(conflicting.env))
      .rejects.toThrow('RECOVERY_IMPORT_SAME_HEIGHT_CONFLICT');
    await closeRecoveryEnv(conflicting.env);
    await assertFreshState(seed, { height: 2, progress: 2_222, profileName: 'candidate-A' });
  });

  test('rejects divergent validator replicas before touching the old head', async () => {
    const seed = `restore replica divergence ${process.pid} deterministic seed`;
    const base = await createRecoveryEnv(seed, false, 'canonical-base');
    cleanupPaths.push(resolveDbPath(base.env, 'core'));
    base.env.timestamp = 1_000;
    base.replica.lastConsensusProgressAt = 1_111;
    await persistRestoredEnvToDB(base.env);

    const fork = await createRecoveryEnv(seed, false, 'validator-conflict', 'validator-fork');
    cleanupPaths.push(resolveDbPath(fork.env, 'core'));
    const conflicting = structuredClone(fork.replica);
    conflicting.signerId = deriveSignerAddressSync(seed, '2').toLowerCase();
    base.env.eReplicas.set(`${base.entityId}:${conflicting.signerId}`, conflicting);
    await expect(persistRestoredEnvToDB(base.env))
      .rejects.toThrow('STORAGE_ENTITY_REPLICA_STATE_DIVERGENCE');
    await closeRecoveryEnv(base.env);
    await closeRecoveryEnv(fork.env);
    await assertFreshState(seed, { height: 2, progress: 1_111, profileName: 'canonical-base' });
  });

  test('treats an exact same-height canonical frame as idempotent', async () => {
    const seed = `restore idempotent ${process.pid} deterministic seed`;
    const current = await createRecoveryEnv(seed, true);
    cleanupPaths.push(resolveDbPath(current.env, 'core'));
    const before = await readStorageFrameRecord(getFrameDb(current.env), current.env.height);
    expect(before?.canonicalStateHash).toBeString();
    await persistRestoredEnvToDB(current.env);
    const after = await readStorageFrameRecord(getFrameDb(current.env), current.env.height);
    expect(after?.frameHash).toBe(before?.frameHash);
    await closeRecoveryEnv(current.env);
  });

  test('rejects non-canonical height and timestamp before persistence mutation', async () => {
    const seed = `restore position validation ${process.pid} deterministic seed`;
    const current = await createRecoveryEnv(seed, false, 'valid-base');
    cleanupPaths.push(resolveDbPath(current.env, 'core'));
    current.env.timestamp = 1_000;
    current.replica.lastConsensusProgressAt = 1_111;
    await persistRestoredEnvToDB(current.env);
    for (const invalidHeight of [0, -1, 1.9, Number.NaN]) {
      current.env.height = invalidHeight;
      await expect(persistRestoredEnvToDB(current.env)).rejects.toThrow('RECOVERY_PERSIST_HEIGHT_REQUIRED');
    }
    current.env.height = 2;
    for (const invalidTimestamp of [-1, 1.9, Number.NaN]) {
      current.env.timestamp = invalidTimestamp;
      await expect(persistRestoredEnvToDB(current.env)).rejects.toThrow('RECOVERY_PERSIST_TIMESTAMP_INVALID');
    }
    await closeRecoveryEnv(current.env);
    await assertFreshState(seed, { height: 2, progress: 1_111, profileName: 'valid-base' });
  });
});
