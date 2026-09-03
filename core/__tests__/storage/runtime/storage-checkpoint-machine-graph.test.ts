import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import { deriveSignerAddressSync } from '../../../account/crypto';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  getRuntimeWalDb,
  loadEnvFromDB,
  saveEnvToDB,
} from '../../../runtime';
import { computeCanonicalStateHashFromEnv } from '../../../storage/canonical-hash';
import { decodeBuffer, encodeBuffer } from '../../../storage/codec/codec';
import { iterateKeys } from '../../../storage/database/level';
import {
  KEY_RUNTIME_MACHINE_BRANCH,
  KEY_RUNTIME_MACHINE_LEAF,
  keyRuntimeMachineTreePrefix,
} from '../../../storage/keys';
import {
  readStorageFramePayloads,
  readStorageFrameRecord,
  readStorageHead,
} from '../../../storage/read/read';
import { verifyStorageTailIntegrity } from '../../../storage/read/verify';
import {
  prepareRuntimeMachineGraphRows,
} from '../../../storage/wal/runtime-machine-graph';
import {
  buildStorageRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../../../storage/wal/snapshot';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';

const cleanupRuntimeStorage = (dbRoot: string, runtimeId: string): void => {
  const namespacePath = join(dbRoot, runtimeId);
  for (const suffix of [
    '',
    '-storage-current',
    '-storage-previous',
    '-wal',
    '-history-views',
    '-events',
    '-infra',
  ]) rmSync(`${namespacePath}${suffix}`, { recursive: true, force: true });
  mkdirSync(dbRoot, { recursive: true });
};

test('canonical frames materialize the Runtime-machine graph only at a barrier', async () => {
  const seed = `checkpoint-machine-graph ${Date.now()} alpha beta gamma`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
  cleanupRuntimeStorage(dbRoot, runtimeId);
  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = {
    ...(env.runtimeConfig || {}),
    storage: {
      canonicalHashPeriodFrames: 1,
      materializePeriodFrames: 100,
      snapshotPeriodFrames: 100,
    },
  };

  const countRuntimeMachineRows = async (): Promise<number> => {
    let count = 0;
    for (const family of [KEY_RUNTIME_MACHINE_BRANCH, KEY_RUNTIME_MACHINE_LEAF] as const) {
      for await (const key of iterateKeys(getRuntimeWalDb(env), {
        prefix: keyRuntimeMachineTreePrefix(family),
      })) {
        void key;
        count += 1;
      }
    }
    return count;
  };

  const runtimeMachineKeys = async (): Promise<Set<string>> => {
    const keys = new Set<string>();
    for (const family of [KEY_RUNTIME_MACHINE_BRANCH, KEY_RUNTIME_MACHINE_LEAF] as const) {
      for await (const key of iterateKeys(getRuntimeWalDb(env), {
        prefix: keyRuntimeMachineTreePrefix(family),
      })) keys.add(key.toString('hex'));
    }
    return keys;
  };

  try {
    env.state.height = 1;
    env.state.timestamp = 1_001;
    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], new Map());
    expect(env.persistenceLastMaterializedHeight).toBe(1);
    const firstMaterializedKeys = await runtimeMachineKeys();
    expect(firstMaterializedKeys.size).toBeGreaterThan(0);

    env.state.height = 2;
    env.state.timestamp = 1_002;
    const expectedNonmaterializedHash = computeCanonicalStateHashFromEnv(env);
    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], new Map());
    expect(env.persistenceLastMaterializedHeight).toBe(1);
    const nonmaterialized = await readStorageFrameRecord(getRuntimeWalDb(env), 2);
    expect(nonmaterialized?.materializedState).toBe(false);
    expect(nonmaterialized?.canonicalStateHash).toBe(expectedNonmaterializedHash);
    expect(nonmaterialized?.runtimeMachineRoot).toBeUndefined();
    expect(await countRuntimeMachineRows()).toBe(firstMaterializedKeys.size);
    expect(await runtimeMachineKeys()).toEqual(firstMaterializedKeys);
    expect(await verifyStorageTailIntegrity(getRuntimeWalDb(env))).toEqual({
      latestHeight: 2,
      checkedFrames: 2,
    });

    env.state.height = 3;
    env.state.timestamp = 1_003;
    env.infrastructure = {
      ...env.infrastructure,
      entityEncryptionSeeds: new Map([[`0x${'12'.repeat(32)}`, `0x${'34'.repeat(64)}`]]),
    };
    await saveEnvToDB(env, {
      runtimeTxs: [{ type: 'checkpointBarrier', data: {} }],
      entityInputs: [],
    }, [], new Map());
    expect(env.persistenceLastMaterializedHeight).toBe(3);
    const materialized = await readStorageFrameRecord(getRuntimeWalDb(env), 3);
    expect(materialized?.materializedState).toBe(true);
    expect(materialized?.runtimeMachineRoot).toBeDefined();
    expect(await countRuntimeMachineRows()).toBeGreaterThan(0);
    if (!materialized) throw new Error('TEST_MATERIALIZED_FRAME_MISSING');
    const payloads = await readStorageFramePayloads(getRuntimeWalDb(env), materialized);
    expect(payloads.runtimeMachine).toBeDefined();
    const restored = createEmptyEnv(`${seed} restored`);
    restoreDurableRuntimeSnapshot(restored, payloads.runtimeMachine!);
    expect(restored.runtimeId).toBe(runtimeId);
    expect(restored.runtimeConfig).toEqual(env.runtimeConfig);

    const oldKeys = await runtimeMachineKeys();
    expect(keyRuntimeMachineTreePrefix(KEY_RUNTIME_MACHINE_BRANCH).toString('hex')).toBe('15');
    expect(keyRuntimeMachineTreePrefix(KEY_RUNTIME_MACHINE_LEAF).toString('hex')).toBe('16');

    const adjacentSentinelKey = Buffer.from([0x17, 0xaa, 0xbb]);
    const adjacentSentinelValue = Buffer.from('adjacent-namespace-sentinel');
    await getRuntimeWalDb(env).put(adjacentSentinelKey, adjacentSentinelValue);

    env.infrastructure = {
      ...env.infrastructure,
      entityEncryptionSeeds: new Map([[`0x${'ab'.repeat(32)}`, `0x${'cd'.repeat(64)}`]]),
    };
    env.state.height = 4;
    env.state.timestamp = 1_004;
    const nextRows = prepareRuntimeMachineGraphRows(buildStorageRuntimeMachineSnapshot(env));
    const nextKeys = new Set(nextRows.rows.map(row => row.key.toString('hex')));
    const obsoleteKeys = [...oldKeys].filter(key => !nextKeys.has(key));
    const novelKeys = [...nextKeys].filter(key => !oldKeys.has(key));
    expect(obsoleteKeys.length).toBeGreaterThan(0);
    expect(novelKeys.length).toBeGreaterThan(0);

    await saveEnvToDB(env, {
      runtimeTxs: [{ type: 'checkpointBarrier', data: {} }],
      entityInputs: [],
    }, [], new Map());
    expect(env.persistenceLastMaterializedHeight).toBe(4);
    expect(await runtimeMachineKeys()).toEqual(nextKeys);
    expect(await getRuntimeWalDb(env).get(adjacentSentinelKey)).toEqual(adjacentSentinelValue);
    expect((await readStorageFramePayloads(getRuntimeWalDb(env), materialized)).runtimeMachine)
      .toBeUndefined();
    await expect(readStorageFramePayloads(
      getRuntimeWalDb(env),
      materialized,
      { includeRuntimeMachine: true },
    )).rejects.toThrow('STORAGE_RUNTIME_MACHINE_NOT_CURRENT:requested=3:current=4');

    const current = await readStorageFrameRecord(getRuntimeWalDb(env), 4);
    if (!current) throw new Error('TEST_CURRENT_MATERIALIZED_FRAME_MISSING');
    expect((await readStorageFramePayloads(getRuntimeWalDb(env), current)).runtimeMachine)
      .toBeDefined();
    expect(await readStorageHead(getRuntimeWalDb(env))).toMatchObject({
      latestHeight: 4,
      latestMaterializedHeight: 4,
      latestSnapshotHeight: 1,
    });
    expect(await verifyStorageTailIntegrity(getRuntimeWalDb(env))).toEqual({
      latestHeight: 4,
      checkedFrames: 4,
    });

    await closeRuntimeDb(env);
    await closeInfraDb(env);
    const restarted = await loadEnvFromDB(runtimeId, seed);
    expect(restarted?.state.height).toBe(4);
    expect(restarted?.persistenceLastMaterializedHeight).toBe(4);
    expect(Reflect.get(restarted ?? {}, '__replayMeta')).toMatchObject({
      checkpointHeight: 4,
      replayedFrameCount: 0,
    });
    if (restarted) {
      await closeRuntimeDb(restarted);
      await closeInfraDb(restarted);
    }

    let corruptedCurrentLeaf = false;
    for await (const key of iterateKeys(getRuntimeWalDb(env), {
      prefix: keyRuntimeMachineTreePrefix(KEY_RUNTIME_MACHINE_LEAF),
    })) {
      const value = decodeBuffer(await getRuntimeWalDb(env).get(key));
      if (!value || typeof value !== 'object' || Reflect.get(value, 'kind') !== 'atom') continue;
      await getRuntimeWalDb(env).put(key, encodeBuffer({ kind: 'atom', value: 'corrupt-current-machine' }));
      corruptedCurrentLeaf = true;
      break;
    }
    expect(corruptedCurrentLeaf).toBe(true);
    await expect(verifyStorageTailIntegrity(getRuntimeWalDb(env)))
      .rejects.toThrow('PERSISTENT_RADIX_EDGE_HASH_MISMATCH');
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    cleanupRuntimeStorage(dbRoot, runtimeId);
  }
});

test('a non-quiescent due frame cannot advance the checkpoint cursor', async () => {
  const seed = `checkpoint-non-quiescent ${Date.now()} alpha beta gamma`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
  cleanupRuntimeStorage(dbRoot, runtimeId);
  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = {
    ...(env.runtimeConfig || {}),
    storage: {
      canonicalHashPeriodFrames: 1,
      materializePeriodFrames: 2,
      snapshotPeriodFrames: 100,
    },
  };
  let checkpointsPrepared = 0;
  const materializedCompletions: boolean[] = [];
  const accountAuthority = {
    prepareCheckpoint: async () => {
      checkpointsPrepared += 1;
      return [];
    },
    validateCheckpointMaterialization: async () => {},
    afterWalCommit: async (materialized: boolean) => {
      materializedCompletions.push(materialized);
    },
  };

  try {
    env.state.height = 1;
    env.state.timestamp = 1_001;
    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], new Map());
    expect(env.persistenceLastMaterializedHeight).toBe(1);

    env.state.height = 2;
    env.state.timestamp = 1_002;
    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], new Map());
    expect(env.persistenceLastMaterializedHeight).toBe(1);

    const fixture = createEntityProposalFixture(`${seed}:entity`, 1n, ['1']);
    const { replica, signerId } = fixture.createValidator('1');
    replica.mempool = [{ type: 'chat', data: { from: signerId, message: 'pending' } }];
    env.state.eReplicas = new Map([[`${replica.entityId}:${signerId}`, replica]]);

    env.state.height = 3;
    env.state.timestamp = 1_003;
    await saveEnvToDB(
      env,
      { runtimeTxs: [], entityInputs: [] },
      [],
      new Map(),
      accountAuthority,
    );
    expect(checkpointsPrepared).toBe(0);
    expect(materializedCompletions).toEqual([false]);
    expect(env.persistenceLastMaterializedHeight).toBe(1);
    expect(await readStorageHead(getRuntimeWalDb(env))).toMatchObject({
      latestHeight: 3,
      latestMaterializedHeight: 1,
    });

    replica.mempool = [];
    env.state.height = 4;
    env.state.timestamp = 1_004;
    await saveEnvToDB(
      env,
      { runtimeTxs: [], entityInputs: [] },
      [],
      new Map(),
      accountAuthority,
    );
    expect(checkpointsPrepared).toBe(1);
    expect(materializedCompletions).toEqual([false, true]);
    expect(env.persistenceLastMaterializedHeight).toBe(4);
    expect(await readStorageHead(getRuntimeWalDb(env))).toMatchObject({
      latestHeight: 4,
      latestMaterializedHeight: 4,
    });
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    cleanupRuntimeStorage(dbRoot, runtimeId);
  }
});
