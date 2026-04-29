import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getFrameDb,
  getPersistedLatestHeight,
  listPersistedCheckpointHeights,
  loadEnvFromDB,
  process as processRuntime,
  readPersistedAccountFrameHistory,
  readPersistedFrameJournal,
  saveEnvToDB,
  verifyRuntimeChain,
} from '../runtime.ts';
import { markStorageEntityDirty } from '../env-events';
import { readFrameDbRuntimeActivity } from '../storage';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { generateLazyEntityId } from '../entity-factory';

describe('storage frame journal retention', () => {
  test('refuses to overwrite an already persisted runtime frame', async () => {
    const seed = `frame-monotonic ${Date.now()} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    const namespacePath = join(dbRoot, runtimeId);

    rmSync(namespacePath, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
    rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
    rmSync(`${namespacePath}-events`, { recursive: true, force: true });
    rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
    mkdirSync(dbRoot, { recursive: true });

    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.height = 1;
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;

    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
    await expect(saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [])).rejects.toThrow(
      'STORAGE_APPEND_INVARIANT_FAILED',
    );

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('keeps frame tail usable after storage epoch rotation', async () => {
    const seed = `epoch-rotation-tail ${Date.now()} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    const namespacePath = join(dbRoot, runtimeId);

    rmSync(namespacePath, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
    rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
    rmSync(`${namespacePath}-events`, { recursive: true, force: true });
    rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
    mkdirSync(dbRoot, { recursive: true });

    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.quietRuntimeLogs = true;
    env.runtimeConfig = {
      ...(env.runtimeConfig || {}),
      storage: {
        ...(env.runtimeConfig?.storage || {}),
        snapshotPeriodFrames: 1,
        epochMaxBytes: 1,
      },
    };

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(signer, deriveSignerKeySync(seed, '1'));
    registerSignerKey(signer.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const jurisdiction = {
      name: 'epoch-rotation-tail-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
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
      }],
      entityInputs: [],
    });
    await processRuntime(env, []);

    const latestAfterRotation = await getPersistedLatestHeight(env);
    expect(latestAfterRotation).toBeGreaterThan(0);
    expect(existsSync(`${namespacePath}-storage-previous`)).toBe(true);

    env.height = latestAfterRotation + 1;
    env.timestamp += 1;
    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
    expect(await getPersistedLatestHeight(env)).toBe(latestAfterRotation + 1);

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const restored = await loadEnvFromDB(runtimeId, seed);
    expect(restored?.height).toBe(latestAfterRotation + 1);
    if (restored) {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
  });

  test('keeps early frame journals readable after snapshots prune replay layers', async () => {
    const seed = `frame-retention ${Date.now()} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    const namespacePath = join(dbRoot, runtimeId);

    rmSync(namespacePath, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
    rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
    rmSync(`${namespacePath}-events`, { recursive: true, force: true });
    rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
    mkdirSync(dbRoot, { recursive: true });

    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.runtimeConfig = { ...(env.runtimeConfig || {}), snapshotIntervalFrames: 1 };
    env.quietRuntimeLogs = true;

    const signerA = deriveSignerAddressSync(seed, '1');
    const signerB = deriveSignerAddressSync(seed, '2');
    registerSignerKey(signerA, deriveSignerKeySync(seed, '1'));
    registerSignerKey(signerA.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
    registerSignerKey(signerB, deriveSignerKeySync(seed, '2'));
    registerSignerKey(signerB.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '2'));

    const entityA = generateLazyEntityId([signerA], 1n).toLowerCase();
    const entityB = generateLazyEntityId([signerB], 1n).toLowerCase();
    const jurisdiction = {
      name: 'frame-retention-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    env.activeJurisdiction = jurisdiction.name;
    env.jReplicas.set(jurisdiction.name, {
      name: jurisdiction.name,
      depositoryAddress: jurisdiction.depositoryAddress,
      entityProviderAddress: jurisdiction.entityProviderAddress,
      chainId: jurisdiction.chainId,
      contracts: {
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
      },
    } as never);

    enqueueRuntimeInput(env, {
      runtimeTxs: [
        {
          type: 'importReplica',
          entityId: entityA,
          signerId: signerA,
          data: {
            isProposer: true,
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerA],
              shares: { [signerA]: 1n },
              jurisdiction,
            },
          },
        },
        {
          type: 'importReplica',
          entityId: entityB,
          signerId: signerB,
          data: {
            isProposer: true,
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerB],
              shares: { [signerB]: 1n },
              jurisdiction,
            },
          },
        },
      ],
      entityInputs: [],
    });
    await processRuntime(env, []);

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [
        {
          entityId: entityA,
          signerId: signerA,
          entityTxs: [
            {
              type: 'openAccount',
              data: {
                targetEntityId: entityB,
                creditAmount: 1000n,
                tokenId: 1,
              },
            },
          ],
        },
      ],
    });

    for (let i = 0; i < 6; i += 1) {
      await processRuntime(env, []);
    }

    const latestHeight = await getPersistedLatestHeight(env);
    expect(latestHeight).toBeGreaterThanOrEqual(3);

    const firstFrame = await readPersistedFrameJournal(env, 1);
    expect(firstFrame).toBeTruthy();
    expect(firstFrame?.height).toBe(1);

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const restored = await loadEnvFromDB(runtimeId, seed);
    expect(restored).toBeTruthy();
    let restoredHistoryFrames = 0;
    for (const replica of restored?.eReplicas.values() ?? []) {
      for (const [counterpartyId, account] of replica.state.accounts.entries()) {
        const frames = restored
          ? await readPersistedAccountFrameHistory(
              restored,
              replica.entityId,
              counterpartyId,
              50,
              { maxRuntimeHeight: restored.height, maxAccountHeight: account.currentHeight },
            )
          : [];
        restoredHistoryFrames = Math.max(
          restoredHistoryFrames,
          frames.length,
        );
      }
    }
    expect(restoredHistoryFrames).toBeGreaterThan(0);
    if (restored) {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
  });

  test('restores state from snapshot/replay journal when the secondary frame DB is lost', async () => {
    const seed = `storage-crash-frame-db-loss ${Date.now()} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    const namespacePath = join(dbRoot, runtimeId);

    rmSync(namespacePath, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
    rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
    rmSync(`${namespacePath}-events`, { recursive: true, force: true });
    rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
    mkdirSync(dbRoot, { recursive: true });

    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.quietRuntimeLogs = true;
    env.runtimeConfig = {
      ...(env.runtimeConfig || {}),
      storage: {
        ...(env.runtimeConfig?.storage || {}),
        packPeriodFrames: 2,
        snapshotPeriodFrames: 2,
        retainSnapshots: 2,
      },
    };

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(signer, deriveSignerKeySync(seed, '1'));
    registerSignerKey(signer.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const jurisdiction = {
      name: 'storage-crash-frame-db-loss-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
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
      }],
      entityInputs: [],
    });
    await processRuntime(env, []);

    const firstManualHeight = env.height + 1;
    const lastManualHeight = env.height + 4;
    for (let height = firstManualHeight; height <= lastManualHeight; height += 1) {
      env.height = height;
      env.timestamp += 1;
      env.frameLogs = [{
        id: height,
        timestamp: env.timestamp,
        level: 'info',
        category: 'system',
        message: `storage-crash-frame-db-loss-${height}`,
      }];
      await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
    }

    const latestHeight = await getPersistedLatestHeight(env);
    const checkpointHeights = await listPersistedCheckpointHeights(env);
    const replayFromHeight = checkpointHeights.find((height) => height > 0 && height < latestHeight) ?? 1;

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const beforeCrashVerify = await verifyRuntimeChain(runtimeId, seed, { fromSnapshotHeight: replayFromHeight });
    expect(beforeCrashVerify.ok).toBe(true);

    // Simulates a crash after the source-of-truth state DB commit but before
    // the secondary UI/activity frame DB is durable. State recovery must not
    // depend on this optional index.
    rmSync(`${namespacePath}-frames`, { recursive: true, force: true });

    const restored = await loadEnvFromDB(runtimeId, seed);
    expect(restored?.height).toBe(latestHeight);
    expect(restored?.eReplicas.size).toBe(1);
    if (restored) {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }

    const afterCrashVerify = await verifyRuntimeChain(runtimeId, seed, { fromSnapshotHeight: replayFromHeight });
    expect(afterCrashVerify.ok).toBe(true);
  });

  test('rebuilds materialization overlay after restart between checkpoints', async () => {
    const seed = `storage-overlay-restart ${Date.now()} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    const namespacePath = join(dbRoot, runtimeId);

    rmSync(namespacePath, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
    rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
    rmSync(`${namespacePath}-events`, { recursive: true, force: true });
    rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
    mkdirSync(dbRoot, { recursive: true });

    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.quietRuntimeLogs = true;
    env.runtimeConfig = {
      ...(env.runtimeConfig || {}),
      storage: {
        ...(env.runtimeConfig?.storage || {}),
        materializePeriodFrames: 3,
        snapshotPeriodFrames: 100,
        packPeriodFrames: 100,
      },
    };

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(signer, deriveSignerKeySync(seed, '1'));
    registerSignerKey(signer.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const jurisdiction = {
      name: 'storage-overlay-restart-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
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
      }],
      entityInputs: [],
    });
    await processRuntime(env, []);

    const replica = Array.from(env.eReplicas.values()).find((item) => item.entityId === entityId);
    if (!replica) throw new Error('TEST_REPLICA_MISSING');
    env.height = 2;
    env.timestamp += 1;
    replica.state.messages.push('non-materialized-message');
    markStorageEntityDirty(env, entityId);
    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
    expect(env.overlay?.length ?? 0).toBeGreaterThan(0);

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const restoredAtTwo = await loadEnvFromDB(runtimeId, seed);
    expect(restoredAtTwo?.height).toBe(2);
    const restoredReplica = Array.from(restoredAtTwo?.eReplicas.values() ?? [])
      .find((item) => item.entityId === entityId);
    expect(restoredReplica?.state.messages).toContain('non-materialized-message');
    expect(restoredAtTwo?.overlay?.length ?? 0).toBeGreaterThan(0);
    if (!restoredAtTwo || !restoredReplica) throw new Error('TEST_RESTORE_MISSING');

    restoredAtTwo.runtimeConfig = {
      ...(restoredAtTwo.runtimeConfig || {}),
      storage: {
        ...(restoredAtTwo.runtimeConfig?.storage || {}),
        materializePeriodFrames: 3,
        snapshotPeriodFrames: 100,
        packPeriodFrames: 100,
      },
    };
    restoredAtTwo.height = 3;
    restoredAtTwo.timestamp += 1;
    await saveEnvToDB(restoredAtTwo, { runtimeTxs: [], entityInputs: [] }, []);
    expect(restoredAtTwo.overlay?.length ?? 0).toBe(0);

    await closeRuntimeDb(restoredAtTwo);
    await closeInfraDb(restoredAtTwo);

    const restoredAfterMaterialize = await loadEnvFromDB(runtimeId, seed);
    const materializedReplica = Array.from(restoredAfterMaterialize?.eReplicas.values() ?? [])
      .find((item) => item.entityId === entityId);
    expect(restoredAfterMaterialize?.height).toBe(3);
    expect(materializedReplica?.state.messages).toContain('non-materialized-message');
    if (restoredAfterMaterialize) {
      await closeRuntimeDb(restoredAfterMaterialize);
      await closeInfraDb(restoredAfterMaterialize);
    }
  });

	test('prunes old frame DB activity without pruning replay frames', async () => {
	  const seed = `frame-db-prune ${Date.now()} alpha beta gamma`;
	  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
	  const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
	  const namespacePath = join(dbRoot, runtimeId);

	  rmSync(namespacePath, { recursive: true, force: true });
	  rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
	  rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
	  rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
	  rmSync(`${namespacePath}-events`, { recursive: true, force: true });
	  rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
	  mkdirSync(dbRoot, { recursive: true });

	  const env = createEmptyEnv(seed);
	  env.runtimeId = runtimeId;
	  env.dbNamespace = runtimeId;
	  env.quietRuntimeLogs = true;
	  env.runtimeConfig = {
	    ...(env.runtimeConfig || {}),
	    storage: {
	      ...(env.runtimeConfig?.storage || {}),
	      frameDbMaxBytes: 1,
	      frameDbRetainFrames: 1,
	    },
	  };

	  for (let height = 1; height <= 4; height += 1) {
	    env.height = height;
	    env.timestamp = 2_000 + height;
	    env.frameLogs = [{
	      id: height,
	      timestamp: env.timestamp,
	      level: 'info',
	      category: 'system',
	      message: `frame-db-prune-${height}`,
	    }];
	    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
	  }

	  expect(await readFrameDbRuntimeActivity(getFrameDb(env), 1)).toBeNull();
	  const latestActivity = await readFrameDbRuntimeActivity(getFrameDb(env), 4);
	  expect(latestActivity?.logs?.[0]?.message).toBe('frame-db-prune-4');
	  const replayFrame = await readPersistedFrameJournal(env, 1);
	  expect(replayFrame?.height).toBe(1);

	  await closeRuntimeDb(env);
	  await closeInfraDb(env);
	});
});
