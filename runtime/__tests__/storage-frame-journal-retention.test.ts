import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getFrameDb,
  getRuntimeStorageDb,
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
import { readFrameDbRuntimeActivity, readStorageFrameRecord, readStorageHead, verifyStorageTailIntegrity } from '../storage';
import { decodeBuffer, encodeBuffer } from '../storage/codec';
import { readRawOrNull } from '../storage/level';
import { KEY_HEAD, keyDiff, keyFrame, keySnapshotEntity, keySnapshotManifest } from '../storage/keys';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { generateLazyEntityId } from '../entity-factory';
import type { StorageFrameRecord } from '../storage/types';
import type { JReplica, JurisdictionConfig } from '../types';

describe('storage frame journal retention', () => {
  const cleanupRuntimeStorage = (dbRoot: string, runtimeId: string): void => {
    const namespacePath = join(dbRoot, runtimeId);
    rmSync(namespacePath, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
    rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
    rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
    rmSync(`${namespacePath}-events`, { recursive: true, force: true });
    rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
    mkdirSync(dbRoot, { recursive: true });
  };

  const createSavedEmptyEnv = async (seedPrefix: string) => {
    const seed = `${seedPrefix} ${Date.now()} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    cleanupRuntimeStorage(dbRoot, runtimeId);

    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.height = 1;
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
    return env;
  };

  const installTestJurisdiction = (env: ReturnType<typeof createEmptyEnv>, jurisdiction: JurisdictionConfig): void => {
    env.activeJurisdiction = jurisdiction.name;
    env.jReplicas.set(jurisdiction.name, {
      name: jurisdiction.name,
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      rpcs: [jurisdiction.address || `jreplica://${jurisdiction.name}`],
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
      entityProviderAddress: jurisdiction.entityProviderAddress,
      position: { x: 0, y: 0, z: 0 },
      contracts: {
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
      },
    } as JReplica);
  };

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

  test('stores replay frames and diffs only in the history frame DB', async () => {
    const env = await createSavedEmptyEnv('storage-history-db-split');
    const currentDb = getRuntimeStorageDb(env);
    const historyDb = getFrameDb(env);

    expect(await readRawOrNull(currentDb, keyFrame(1))).toBeNull();
    expect(await readRawOrNull(currentDb, keyDiff(1))).toBeNull();
    expect(await readRawOrNull(historyDb, keyFrame(1))).toBeTruthy();
    expect(await readRawOrNull(historyDb, keyDiff(1))).toBeTruthy();

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('canonical frame hash fails restore when snapshot body loses state', async () => {
    const seed = `canonical-snapshot-restore ${Date.now()} alpha beta gamma`;
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
        materializePeriodFrames: 1,
        canonicalHashPeriodFrames: 1,
      },
    };

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(signer, deriveSignerKeySync(seed, '1'));
    registerSignerKey(signer.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const jurisdiction = {
      name: 'canonical-snapshot-restore-test',
      address: 'browservm://canonical-snapshot-restore-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    installTestJurisdiction(env, jurisdiction);

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

    const latestHeight = await getPersistedLatestHeight(env);
    const frame = await readStorageFrameRecord(getFrameDb(env), latestHeight);
    expect(frame?.canonicalStateHash).toMatch(/^0x[0-9a-f]{64}$/);

    const snapshotKey = keySnapshotEntity(latestHeight, entityId);
    const raw = await getFrameDb(env).get(snapshotKey);
    const corrupted = decodeBuffer<any>(raw);
    corrupted.messages = [...(Array.isArray(corrupted.messages) ? corrupted.messages : []), 'corrupted snapshot body'];
    await getFrameDb(env).put(snapshotKey, encodeBuffer(corrupted));

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    await expect(loadEnvFromDB(runtimeId, seed)).rejects.toThrow('STORAGE_RESTORE_CANONICAL_HASH_MISMATCH');
  });

  test('rotates current storage epoch after byte-threshold snapshot and keeps frame tail usable', async () => {
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
        snapshotPeriodFrames: 1000,
        epochMaxBytes: 1,
      },
    };

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(signer, deriveSignerKeySync(seed, '1'));
    registerSignerKey(signer.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const jurisdiction = {
      name: 'epoch-rotation-tail-test',
      address: 'browservm://epoch-rotation-tail-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    installTestJurisdiction(env, jurisdiction);

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
    expect(existsSync(`${namespacePath}-storage-current`)).toBe(true);
    expect(existsSync(`${namespacePath}-storage-previous`)).toBe(true);

    const currentHead = await readStorageHead(getRuntimeStorageDb(env));
    const historyHead = await readStorageHead(getFrameDb(env));
    const snapshotHeight = historyHead?.latestSnapshotHeight ?? 0;
    expect(snapshotHeight).toBe(latestAfterRotation);
    expect(currentHead?.latestHeight).toBe(historyHead?.latestHeight);
    expect(currentHead?.latestMaterializedHeight).toBe(snapshotHeight);
    expect(currentHead?.latestSnapshotHeight).toBe(snapshotHeight);
    expect(currentHead?.retainedHistoryBytes).toBe(0);
    expect(historyHead?.retainedHistoryBytes ?? 0).toBeGreaterThan(0);
    expect(await readRawOrNull(getFrameDb(env), keySnapshotManifest(snapshotHeight))).toBeTruthy();
    expect(await readRawOrNull(getFrameDb(env), keyFrame(snapshotHeight))).toBeTruthy();
    expect(await readRawOrNull(getFrameDb(env), keyDiff(snapshotHeight))).toBeNull();
    expect(await readRawOrNull(getRuntimeStorageDb(env), keyFrame(snapshotHeight))).toBeNull();

    env.height = latestAfterRotation + 1;
    env.timestamp += 1;
    env.runtimeConfig.storage.epochMaxBytes = 1_000_000;
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

  test('fails closed when the primary history frame DB is lost', async () => {
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
      address: 'browservm://storage-crash-frame-db-loss-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    installTestJurisdiction(env, jurisdiction);

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

    // The frame DB is the primary history/replay store. Losing it must fail
    // closed instead of silently rebuilding from current-state rows.
    rmSync(`${namespacePath}-frames`, { recursive: true, force: true });

    const restored = await loadEnvFromDB(runtimeId, seed);
    expect(restored).toBeNull();
    if (restored) {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }

    await expect(verifyRuntimeChain(runtimeId, seed, { fromSnapshotHeight: replayFromHeight }))
      .rejects.toThrow('no persisted runtime state');
  }, 10_000);

  test('rejects a torn snapshot head that points at a missing manifest', async () => {
    const seed = `storage-crash-missing-snapshot-manifest ${Date.now()} alpha beta gamma`;
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

    const db = getFrameDb(env);
    const head = await readStorageHead(db);
    if (!head) throw new Error('TEST_HEAD_MISSING');
    const batch = db.batch();
    batch.put(KEY_HEAD, encodeBuffer({
      ...head,
      latestSnapshotHeight: 1,
      latestMaterializedHeight: 1,
    }));
    await batch.write({ sync: true });

    await expect(verifyStorageTailIntegrity(db)).rejects.toThrow('STORAGE_VERIFY_SNAPSHOT_MANIFEST_MISSING');

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('rejects a snapshot head that points past the latest frame', async () => {
    const env = await createSavedEmptyEnv('storage-crash-snapshot-after-head');
    const db = getFrameDb(env);
    const head = await readStorageHead(db);
    if (!head) throw new Error('TEST_HEAD_MISSING');
    const batch = db.batch();
    batch.put(KEY_HEAD, encodeBuffer({
      ...head,
      latestSnapshotHeight: head.latestHeight + 1,
    }));
    await batch.write({ sync: true });

    await expect(verifyStorageTailIntegrity(db)).rejects.toThrow('STORAGE_VERIFY_SNAPSHOT_AFTER_HEAD');

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('rejects a snapshot manifest with the wrong height', async () => {
    const env = await createSavedEmptyEnv('storage-crash-snapshot-manifest-height');
    const db = getFrameDb(env);
    const head = await readStorageHead(db);
    if (!head) throw new Error('TEST_HEAD_MISSING');
    const batch = db.batch();
    batch.put(KEY_HEAD, encodeBuffer({
      ...head,
      latestSnapshotHeight: 1,
      latestMaterializedHeight: 1,
    }));
    batch.put(keySnapshotManifest(1), encodeBuffer({ height: 2, createdAt: 1_000, docCount: 0 }));
    await batch.write({ sync: true });

    await expect(verifyStorageTailIntegrity(db)).rejects.toThrow('STORAGE_VERIFY_SNAPSHOT_MANIFEST_HEIGHT_MISMATCH');

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('rejects a snapshot manifest when the materialized frame is missing', async () => {
    const env = await createSavedEmptyEnv('storage-crash-snapshot-frame-missing');
    const db = getFrameDb(env);
    const head = await readStorageHead(db);
    if (!head) throw new Error('TEST_HEAD_MISSING');
    const batch = db.batch();
    batch.put(KEY_HEAD, encodeBuffer({
      ...head,
      latestSnapshotHeight: 1,
      latestMaterializedHeight: 1,
    }));
    batch.put(keySnapshotManifest(1), encodeBuffer({ height: 1, createdAt: 1_000, docCount: 0 }));
    batch.del?.(keyFrame(1));
    await batch.write({ sync: true });

    await expect(verifyStorageTailIntegrity(db)).rejects.toThrow('STORAGE_VERIFY_SNAPSHOT_FRAME_MISSING');

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('rejects a snapshot manifest when the frame was not materialized', async () => {
    const env = await createSavedEmptyEnv('storage-crash-snapshot-not-materialized');
    const db = getFrameDb(env);
    const head = await readStorageHead(db);
    if (!head) throw new Error('TEST_HEAD_MISSING');
    const frame = decodeBuffer<StorageFrameRecord>(await db.get(keyFrame(1)));
    const batch = db.batch();
    batch.put(KEY_HEAD, encodeBuffer({
      ...head,
      latestSnapshotHeight: 1,
      latestMaterializedHeight: 1,
    }));
    batch.put(keySnapshotManifest(1), encodeBuffer({ height: 1, createdAt: 1_000, docCount: 0 }));
    batch.put(keyFrame(1), encodeBuffer({ ...frame, materializedState: false }));
    await batch.write({ sync: true });

    await expect(verifyStorageTailIntegrity(db)).rejects.toThrow('STORAGE_VERIFY_SNAPSHOT_NOT_MATERIALIZED');

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('rejects a snapshot manifest whose copied docs were torn', async () => {
    const seed = `storage-crash-torn-snapshot-docs ${Date.now()} alpha beta gamma`;
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
        retainSnapshots: 2,
      },
    };

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(signer, deriveSignerKeySync(seed, '1'));
    registerSignerKey(signer.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const jurisdiction = {
      name: 'storage-crash-torn-snapshot-docs-test',
      address: 'browservm://storage-crash-torn-snapshot-docs-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    installTestJurisdiction(env, jurisdiction);

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

    const db = getFrameDb(env);
    const head = await readStorageHead(db);
    const snapshotHeight = Number(head?.latestSnapshotHeight ?? 0);
    expect(snapshotHeight).toBeGreaterThan(0);

    const batch = db.batch();
    batch.del?.(keySnapshotEntity(snapshotHeight, entityId));
    await batch.write({ sync: true });

    await expect(verifyStorageTailIntegrity(db)).rejects.toThrow('STORAGE_VERIFY_SNAPSHOT_DOC_COUNT_MISMATCH');

    await closeRuntimeDb(env);
    await closeInfraDb(env);
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
      },
    };

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(signer, deriveSignerKeySync(seed, '1'));
    registerSignerKey(signer.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const jurisdiction = {
      name: 'storage-overlay-restart-test',
      address: 'browservm://storage-overlay-restart-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    installTestJurisdiction(env, jurisdiction);

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
