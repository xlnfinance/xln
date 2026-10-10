import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeStorageDb,
  getRuntimeWalDb,
  processRuntime,
} from '../../../../runtime';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../../account/crypto';
import { generateLazyEntityId } from '../../../../entity/factory';
import { createTestEntityImportRuntimeTx } from '../../../../qa/entity-creation-fixture';
import { exportConcreteCheckpointSource } from '../../../../storage/read/concrete-checkpoint-source';
import {
  RSCORE_ACCOUNT_TREE_NAMESPACES,
  keyLiveEntity,
  keyRscoreAccountJClaimPathNode,
  keyRscoreAccountRadixBranchNode,
  keyRscoreAccountRadixLeafNode,
  keyRscoreCheckpoint,
} from '../../../../storage/keys';
import { encodeBuffer } from '../../../../storage/codec/codec';
import { resolveDbPath } from '../../../../storage/runtime-db-path';
import { createCheckpointBarrierRuntimeTx } from '../../../../runtime/checkpoint/barrier';

test('checkpoint before the first Entity exports an empty owner forest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-empty-checkpoint-'));
  const seed = `empty checkpoint ${directory}`;
  const env = createEmptyEnv(seed);
  env.runtimeId = deriveSignerAddressSync(seed, 'runtime').toLowerCase();
  env.dbNamespace = env.runtimeId;
  try {
    enqueueRuntimeInput(env, { runtimeTxs: [createCheckpointBarrierRuntimeTx()], entityInputs: [] });
    await processRuntime(env);
    expect(env.state.eReplicas.size).toBe(0);
    const checkpoint = await exportConcreteCheckpointSource(env, {
      getStorageDb: getRuntimeStorageDb, getRuntimeWalDb,
    });
    expect(checkpoint.height).toBe(1);
    expect(checkpoint.runtimeMachineLeaves.length).toBeGreaterThan(0);
    expect(checkpoint.stateRows).toEqual([]);
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    for (const suffix of ['', '-wal', '-storage-current', '-storage-previous', '-infra', '-events', '-history-views']) {
      rmSync(`${resolveDbPath(env)}${suffix}`, { recursive: true, force: true });
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('multi-Entity checkpoint exports each Account authority and rejects orphan or missing owners', async () => {
  const dbRoot = mkdtempSync(join(tmpdir(), 'xln-checkpoint-owners-'));
  const seed = `concrete checkpoint owner regression ${dbRoot}`;
  const env = createEmptyEnv(seed);
  env.runtimeId = deriveSignerAddressSync(seed, 'runtime').toLowerCase();
  env.dbNamespace = env.runtimeId;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = { ...env.runtimeConfig, storage: { materializePeriodFrames: 1, snapshotPeriodFrames: 1 } };
  const jurisdiction = {
    name: 'checkpoint-owners',
    address: 'browservm://checkpoint-owners',
    chainId: 31337,
    depositoryAddress: `0x${'11'.repeat(20)}`,
    entityProviderAddress: `0x${'12'.repeat(20)}`,
  };
  env.state.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    chainId: jurisdiction.chainId,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
    rpcs: [jurisdiction.address],
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
    },
  });
  const owners: string[] = [];
  const deps = { getStorageDb: getRuntimeStorageDb, getRuntimeWalDb };
  try {
    for (const label of ['first', 'second']) {
      const signer = deriveSignerAddressSync(seed, label).toLowerCase();
      registerSignerKey(env, signer, deriveSignerKeySync(seed, label));
      const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
      owners.push(entityId);
      enqueueRuntimeInput(env, {
        runtimeTxs: [
          createTestEntityImportRuntimeTx(env, {
            entityId,
            signerId: signer,
            data: {
              isProposer: true,
              config: {
                mode: 'proposer-based',
                threshold: 1n,
                validators: [signer],
                shares: { [signer]: 1n },
                jurisdiction,
              },
            },
          }),
        ],
        entityInputs: [],
      });
      await processRuntime(env);
    }
    const checkpoint = await exportConcreteCheckpointSource(env, deps);
    expect(checkpoint.height).toBe(env.state.height);
    expect(
      checkpoint.stateRows
        .filter(([key]) => key.startsWith('0x17'))
        .map(([key]) => `0x${key.slice(4)}`)
        .sort(),
    ).toEqual([...owners].sort());
    const [owner] = owners;
    if (!owner) throw new Error('TEST_OWNER_MISSING');
    const db = getRuntimeStorageDb(env);
    const key = keyLiveEntity(owner);
    const value = await db.get(key);
    const foreign = `0x${'ff'.repeat(32)}`;
    await db.put(keyLiveEntity(foreign), value);
    await expect(exportConcreteCheckpointSource(env, deps)).rejects.toThrow(
      `CHECKPOINT_STATE_OWNER_UNDECLARED:${foreign}`,
    );
    await db.del(keyLiveEntity(foreign));
    await db.del(key);
    await expect(exportConcreteCheckpointSource(env, deps)).rejects.toThrow(`CHECKPOINT_STATE_OWNER_MISSING:${owner}`);
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    for (const suffix of ['', '-wal', '-storage-current', '-storage-previous', '-infra', '-events', '-history-views']) {
      rmSync(`${resolveDbPath(env)}${suffix}`, { recursive: true, force: true });
    }
    rmSync(dbRoot, { recursive: true, force: true });
  }
});

test('Rust Account node rows export in every namespace the writer uses', async () => {
  // The export table parsed namespace 6 as a J-claim key and rejected 7-9,
  // while the writer and Rust valid_path_key use trees 1-6, 8, 9 and J-claims
  // 7: a WAL holding such Rust-authority rows could not export a checkpoint.
  const dbRoot = mkdtempSync(join(tmpdir(), 'xln-checkpoint-rscore-ns-'));
  const seed = `concrete checkpoint rscore namespaces ${dbRoot}`;
  const env = createEmptyEnv(seed);
  env.runtimeId = deriveSignerAddressSync(seed, 'runtime').toLowerCase();
  env.dbNamespace = env.runtimeId;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = { ...env.runtimeConfig, storage: { materializePeriodFrames: 1, snapshotPeriodFrames: 1 } };
  const jurisdiction = {
    name: 'checkpoint-rscore-ns', address: 'browservm://checkpoint-rscore-ns', chainId: 31337,
    depositoryAddress: `0x${'11'.repeat(20)}`, entityProviderAddress: `0x${'12'.repeat(20)}`,
  };
  env.state.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name, chainId: jurisdiction.chainId, blockNumber: 0n, stateRoot: null, mempool: [],
    blockDelayMs: 0, lastBlockTimestamp: 0, position: { x: 0, y: 0, z: 0 }, rpcs: [jurisdiction.address],
    contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress },
  });
  try {
    const signer = deriveSignerAddressSync(seed, 'owner').toLowerCase();
    registerSignerKey(env, signer, deriveSignerKeySync(seed, 'owner'));
    const owner = generateLazyEntityId([signer], 1n).toLowerCase();
    enqueueRuntimeInput(env, {
      runtimeTxs: [createTestEntityImportRuntimeTx(env, {
        entityId: owner, signerId: signer,
        data: {
          isProposer: true,
          config: { mode: 'proposer-based', threshold: 1n, validators: [signer], shares: { [signer]: 1n }, jurisdiction },
        },
      })],
      entityInputs: [],
    });
    await processRuntime(env);
    const account = `0x${'ab'.repeat(32)}`;
    const nodeKeys = [
      ...RSCORE_ACCOUNT_TREE_NAMESPACES.map(namespace =>
        keyRscoreAccountRadixLeafNode(owner, account, namespace, Buffer.from([namespace]))),
      keyRscoreAccountRadixBranchNode(owner, account, 9, [1, 2]),
      keyRscoreAccountJClaimPathNode(owner, account, 1, { kind: 'leaf', key: `0x${'cd'.repeat(32)}` }),
    ];
    const walDb = getRuntimeWalDb(env);
    await walDb.put(keyRscoreCheckpoint(owner), encodeBuffer({ owner }));
    for (const key of nodeKeys) await walDb.put(key, encodeBuffer({ key: key.toString('hex') }));
    const checkpoint = await exportConcreteCheckpointSource(env, { getStorageDb: getRuntimeStorageDb, getRuntimeWalDb });
    const exported = new Set(checkpoint.stateRows.map(([key]) => key));
    expect(nodeKeys.filter(key => !exported.has(`0x${key.toString('hex')}`))).toEqual([]);
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    for (const suffix of ['', '-wal', '-storage-current', '-storage-previous', '-infra', '-events', '-history-views']) {
      rmSync(`${resolveDbPath(env)}${suffix}`, { recursive: true, force: true });
    }
    rmSync(dbRoot, { recursive: true, force: true });
  }
});
