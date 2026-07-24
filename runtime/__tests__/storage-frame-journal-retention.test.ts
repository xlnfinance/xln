import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Level } from 'level';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getFrameDb,
  getRuntimeStorageDb,
  getPersistedLatestHeight,
  listPersistedEntityIdsAtHeight,
  listPersistedCheckpointHeights,
  loadEntityStateFromStorageDb,
  loadEnvFromDB,
  process as processRuntime,
  readPersistedAccountFrameHistory,
  readPersistedCheckpointSnapshot,
  readPersistedFrameJournal,
  saveEnvToDB,
  verifyRuntimeChain,
} from '../runtime.ts';
import {
  computeStorageFrameHash,
  readFrameDbRuntimeActivity,
  readStorageFrameRecord,
  readStorageHead,
  listStorageSnapshotReplicaMetas,
  readStorageOverlayRecordsFromDiffs,
  saveRuntimeFrameToStorage,
  verifyStorageTailIntegrity,
} from '../storage';
import { getPerfMs } from '../utils';
import { decodeBuffer, encodeBuffer, writeBatch } from '../storage/codec';
import { readRawOrNull } from '../storage/level';
import {
  KEY_HEAD,
  keyDiff,
  keyFrame,
  keyLiveReplicaMeta,
  keySnapshotEntity,
  keySnapshotManifest,
  keySnapshotReplicaMeta,
} from '../storage/keys';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { buildRouteOutputKey } from '../machine/output-routing';
import { computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';
import type { StorageEntityCoreDoc, StorageFrameRecord } from '../storage/types';
import type { DeliverableEntityInput, JReplica, JurisdictionConfig } from '../types';
import {
  resolveFrameDbPath,
  resolveStorageWriterLockPath,
  STORAGE_WRITER_LOCK_TTL_MS,
  withStorageWriterLock,
} from '../storage/runtime-dbs';
import { buildCryptographicProfileFixture } from './helpers/cryptographic-profile';

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

  test('replay rejects a validly rechained divergent post-state at its first height', async () => {
    const seed = `post-state-divergence ${Date.now()} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    cleanupRuntimeStorage(dbRoot, runtimeId);
    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.height = 1;
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    let envClosed = false;
    try {
      const jurisdiction: JurisdictionConfig = {
        name: 'post-state-divergence',
        chainId: 31337,
        depositoryAddress: '0x0000000000000000000000000000000000000011',
        entityProviderAddress: '0x0000000000000000000000000000000000000012',
      };
      installTestJurisdiction(env, jurisdiction);
      await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
      for (const signerIndex of [2, 3]) {
        const signer = deriveSignerAddressSync(seed, String(signerIndex)).toLowerCase();
        registerSignerKey(env, signer, deriveSignerKeySync(seed, String(signerIndex)));
        const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
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
      }
      await closeRuntimeDb(env);
      await closeInfraDb(env);
      envClosed = true;
      expect((await verifyRuntimeChain(runtimeId, seed, { fromSnapshotHeight: 1 })).ok).toBe(true);

      const historyDb = new Level<Buffer, Buffer>(`${join(dbRoot, runtimeId)}-frames`, {
        keyEncoding: 'buffer',
        valueEncoding: 'buffer',
      });
      await historyDb.open();
      try {
        let previousFrameHash = (await readStorageFrameRecord(historyDb, 1))?.frameHash;
        if (!previousFrameHash) throw new Error('TEST_POST_STATE_BASE_FRAME_MISSING');
        for (const height of [2, 3]) {
          const persisted = await readStorageFrameRecord(historyDb, height);
          if (!persisted) throw new Error(`TEST_POST_STATE_FRAME_MISSING:${height}`);
          const rechained = {
            ...persisted,
            prevFrameHash: previousFrameHash,
            ...(height === 2 ? { postStateHash: `0x${'99'.repeat(32)}` } : {}),
            frameHash: undefined,
          };
          const frameHash = computeStorageFrameHash(rechained);
          await historyDb.put(keyFrame(height), encodeBuffer({ ...rechained, frameHash }));
          previousFrameHash = frameHash;
        }
      } finally {
        await historyDb.close();
      }

      await expect(verifyRuntimeChain(runtimeId, seed, { fromSnapshotHeight: 1 }))
        .rejects.toThrow('RECOVERY_JOURNAL_POST_STATE_HASH_MISMATCH:height=2');
    } finally {
      if (!envClosed) {
        await closeRuntimeDb(env);
        await closeInfraDb(env);
      }
    }
  });

  test('accounts full authoritative frame journals in retained history bytes', async () => {
    const env = await createSavedEmptyEnv('frame-byte-accounting');
    const db = getFrameDb(env);
    const frameKey = keyFrame(1);
    const diffKey = keyDiff(1);
    const manifestKey = keySnapshotManifest(1);
    const frame = await readRawOrNull(db, frameKey);
    const diff = await readRawOrNull(db, diffKey);
    const manifest = await readRawOrNull(db, manifestKey);
    const head = await readStorageHead(db);
    if (!frame || !diff || !manifest || !head) throw new Error('TEST_STORAGE_RECORD_MISSING');

    expect(head.retainedHistoryBytes).toBe(
      frameKey.byteLength + frame.byteLength +
      diffKey.byteLength + diff.byteLength +
      manifestKey.byteLength + manifest.byteLength,
    );

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('stores only the chained R-frame between sparse canonical checkpoints', async () => {
    const seed = `sparse-canonical-wal ${Date.now()} alpha beta gamma`;
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
        canonicalHashPeriodFrames: 3,
        materializePeriodFrames: 100,
        snapshotPeriodFrames: 100,
      },
    };

    for (let height = 1; height <= 3; height += 1) {
      env.height = height;
      env.timestamp = 1_000 + height;
      await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
    }

    const first = await readStorageFrameRecord(getFrameDb(env), 1);
    const middle = await readStorageFrameRecord(getFrameDb(env), 2);
    const checkpoint = await readStorageFrameRecord(getFrameDb(env), 3);
    expect(first?.runtimeStateHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(middle?.runtimeStateHash).toBeUndefined();
    expect(middle?.canonicalStateHash).toBeUndefined();
    expect(middle?.canonicalEntityHashes).toBeUndefined();
    expect(middle?.entityHashes).toBeUndefined();
    expect(middle?.runtimeMachine).toBeUndefined();
    expect(middle?.frameHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(checkpoint?.runtimeStateHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(checkpoint?.prevFrameHash).toBe(middle?.frameHash);
    expect((await verifyStorageTailIntegrity(getFrameDb(env))).checkedFrames).toBe(3);

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('returns null for a checkpoint view that was legitimately pruned by a newer snapshot', async () => {
    const seed = `checkpoint-view-pruned ${Date.now()} alpha beta gamma`;
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
        ...(env.runtimeConfig?.storage || {}),
        snapshotPeriodFrames: 1,
        retainSnapshots: 1,
      },
    };

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const jurisdiction = {
      name: 'checkpoint-view-pruned-test',
      address: 'browservm://checkpoint-view-pruned-test',
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
    const prunedHeight = await getPersistedLatestHeight(env);

    env.height = prunedHeight + 1;
    env.timestamp += 1;
    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
    const retainedHeight = env.height;

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    expect(await readPersistedCheckpointSnapshot(env, prunedHeight)).toBeNull();
    expect(await readPersistedCheckpointSnapshot(env, retainedHeight)).toBeTruthy();
  });

  test('retained snapshots keep every replay diff after the oldest retained base', async () => {
    const seed = `retained-snapshot-replay-window ${Date.now()} alpha beta gamma`;
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
        ...(env.runtimeConfig?.storage || {}),
        snapshotPeriodFrames: 3,
        retainSnapshots: 2,
      },
    };

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const jurisdiction = {
      name: 'retained-snapshot-replay-window-test',
      address: 'browservm://retained-snapshot-replay-window-test',
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

    const namesByHeight = new Map<number, string>();
    for (let index = 0; index < 8; index += 1) {
      const name = `retained-at-${env.height + 1}`;
      enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [{
          entityId,
          signerId: signer,
          entityTxs: [{
            type: 'profile-update',
            data: { profile: { entityId, name } },
          }],
        }],
      });
      await processRuntime(env, []);
      namesByHeight.set(env.height, name);
    }

    const checkpoints = await listPersistedCheckpointHeights(env);
    expect(checkpoints).toHaveLength(2);
    const oldestRetained = checkpoints[0]!;
    const newestRetained = checkpoints[1]!;
    const replayHeight = oldestRetained + 1;
    expect(replayHeight).toBeLessThan(newestRetained);
    const restored = await loadEntityStateFromStorageDb(env, entityId, replayHeight);
    expect(restored?.profile.name).toBe(namesByHeight.get(replayHeight));

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('historical entity listing keeps remote Account endpoints out of the local Entity keyspace', async () => {
    const seed = `historical-local-entities-only ${Date.now()} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    cleanupRuntimeStorage(dbRoot, runtimeId);

    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.quietRuntimeLogs = true;
    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
    const localEntityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const remoteEntityId = `0x${'ab'.repeat(32)}`;
    const jurisdiction: JurisdictionConfig = {
      name: 'historical-local-entities-only',
      address: 'browservm://historical-local-entities-only',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    installTestJurisdiction(env, jurisdiction);
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId: localEntityId,
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
    const remoteSignerId = deriveSignerAddressSync(seed, '2').toLowerCase();
    env.gossip.profiles.set(remoteEntityId, buildCryptographicProfileFixture({
      entityId: remoteEntityId,
      signingSeed: seed,
      signerId: '2',
      runtimeId: remoteSignerId,
      name: 'Remote counterparty',
      lastUpdated: env.timestamp,
    }));
    enqueueRuntimeInput(env, {
      timestamp: env.timestamp,
      runtimeTxs: [],
      entityInputs: [{
        entityId: localEntityId,
        signerId: signer,
        entityTxs: [{
          type: 'openAccount',
          data: { targetEntityId: remoteEntityId, creditAmount: 1_000n, tokenId: 1 },
        }],
      }],
    });
    await processRuntime(env, []);

    expect(await listPersistedEntityIdsAtHeight(env, env.height)).toEqual([localEntityId]);

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('retained checkpoint preserves replica lineage metadata after the live head advances', async () => {
    const seed = `checkpoint-replica-lineage ${Date.now()} alpha beta gamma`;
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
        ...(env.runtimeConfig?.storage || {}),
        snapshotPeriodFrames: 1,
        retainSnapshots: 3,
      },
    };
    const jurisdiction = {
      name: 'checkpoint-replica-lineage-test',
      address: 'browservm://checkpoint-replica-lineage-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    installTestJurisdiction(env, jurisdiction);

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
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
    await processRuntime(env, []);
    const checkpointHeight = env.height;
    expect(env.eReplicas.get(`${entityId}:${signer.toLowerCase()}`)?.state.height).toBeGreaterThan(0);

    const secondSigner = deriveSignerAddressSync(seed, '2');
    registerSignerKey(env, secondSigner, deriveSignerKeySync(seed, '2'));
    const secondEntityId = generateLazyEntityId([secondSigner], 1n).toLowerCase();
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId: secondEntityId,
        signerId: secondSigner,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [secondSigner],
            shares: { [secondSigner]: 1n },
            jurisdiction,
          },
        },
      }],
      entityInputs: [],
    });
    await processRuntime(env, []);
    expect(env.height).toBeGreaterThan(checkpointHeight);

    await closeRuntimeDb(env);
    await closeInfraDb(env);
    const checkpoint = await readPersistedCheckpointSnapshot(env, checkpointHeight);
    expect(checkpoint).toBeTruthy();
    const replicas = checkpoint?.['eReplicas'];
    expect(replicas).toBeInstanceOf(Array);
    const restoredReplica = (replicas as Array<[string, { certifiedFrameAnchor?: unknown }]>).find(
      ([key]) => key.toLowerCase() === `${entityId}:${signer.toLowerCase()}`,
    )?.[1];
    expect(restoredReplica?.certifiedFrameAnchor).toBeTruthy();

    const historyDb = new Level(resolveFrameDbPath(env), {
      valueEncoding: 'buffer',
      keyEncoding: 'binary',
    }) as unknown as Level<Buffer, Buffer>;
    await historyDb.open();
    const snapshotMetaKey = keySnapshotReplicaMeta(checkpointHeight, entityId, signer);
    const validMeta = await historyDb.get(snapshotMetaKey);
    const corruptedMeta = decodeBuffer<Record<string, unknown>>(validMeta);
    corruptedMeta['lastConsensusProgressAt'] = 987_654;
    await historyDb.put(snapshotMetaKey, encodeBuffer(corruptedMeta));
    await historyDb.close();

    await expect(readPersistedCheckpointSnapshot(env, checkpointHeight)).rejects.toThrow(
      'STORAGE_VERIFY_SNAPSHOT_REPLICA_META_DIGEST_MISMATCH',
    );
  });

  test('preserves both the frame write failure and authoritative probe failure', async () => {
    const seed = `frame-write-probe-double-failure ${process.pid} deterministic seed`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    cleanupRuntimeStorage(dbRoot, runtimeId);

    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.height = 1;
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    const competingHistoryDb = new Level(resolveFrameDbPath(env), {
      valueEncoding: 'buffer',
      keyEncoding: 'binary',
    }) as unknown as Level<Buffer, Buffer>;
    await competingHistoryDb.open();

    let failure: unknown;
    try {
      await withStorageWriterLock(env, async () => {
        try {
          await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
        } catch (error) {
          failure = error;
        }
      });
    } finally {
      await competingHistoryDb.close();
      await closeRuntimeDb(env);
      await closeInfraDb(env);
    }

    expect(failure).toBeInstanceOf(Error);
    const combined = (failure as Error & { cause?: unknown }).cause;
    expect(combined).toBeInstanceOf(AggregateError);
    const errors = (combined as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(String((errors[0] as Error).message)).toContain('STORAGE_WRITER_LOCK_HELD');
    expect(`${(errors[1] as Error).name}: ${(errors[1] as Error).message}`)
      .toMatch(/LEVEL_LOCKED|Database (?:failed to open|is not open)|IO error.*lock/i);
  });

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
        account: '0x000000000000000000000000000000000000ac01',
        deltaTransformer: '0x000000000000000000000000000000000000de17',
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

    const firstSave = await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
    const persistence = firstSave.persistencePerfMs;
    expect(persistence).toBeTruthy();
    expect(Object.keys(persistence?.planningStages ?? {})).toEqual(['overlay', 'lineage', 'remainder']);
    expect(Object.keys(persistence?.prepareStages ?? {})).toEqual([
      'historyRead',
      'pendingNodes',
      'materializedHashes',
      'runtimeMachine',
      'canonicalHashes',
      'replicaCommitment',
      'replicaHistoryScan',
      'frameEncode',
      'batchPlan',
      'remainder',
    ]);
    const prepareStageTotal = Object.values(persistence?.prepareStages ?? {})
      .reduce((sum, durationMs) => sum + durationMs, 0);
    expect(prepareStageTotal).toBeLessThanOrEqual((persistence?.prepare ?? 0) + 0.01);
    const planningStageTotal = Object.values(persistence?.planningStages ?? {})
      .reduce((sum, durationMs) => sum + durationMs, 0);
    expect(planningStageTotal).toBeLessThanOrEqual((persistence?.planning ?? 0) + 0.01);
    await expect(saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [])).rejects.toThrow(
      'STORAGE_APPEND_INVARIANT_FAILED',
    );

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('stale same-height writer stops when the frame is already persisted', async () => {
    const seed = `frame-stale-same-height ${Date.now()} alpha beta gamma`;
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
    const beforeFrame = await readStorageFrameRecord(getFrameDb(env), 1);
    expect(beforeFrame).toBeTruthy();

    const result = await saveRuntimeFrameToStorage({
      env,
      tryOpenDb: async (targetEnv) => {
        await getRuntimeStorageDb(targetEnv).open();
        return true;
      },
      getRuntimeDb: getRuntimeStorageDb,
      tryOpenFrameDb: async (targetEnv) => {
        await getFrameDb(targetEnv).open();
        return true;
      },
      getFrameDb,
      getPerfMs,
      formatPerfMs: (value) => value.toFixed(2),
      stopStaleWriterOnHeadAhead: true,
    });

    expect(result.staleWriterStopped).toBe(true);
    expect(result.frameDbCommitted).toBe(false);
    const head = await readStorageHead(getFrameDb(env));
    const afterFrame = await readStorageFrameRecord(getFrameDb(env), 1);
    expect(head?.latestHeight).toBe(1);
    expect(afterFrame?.frameHash).toBe(beforeFrame?.frameHash);

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('stale lower-height writer can be stopped without appending or corrupting head', async () => {
    const seed = `frame-stale-writer ${Date.now()} alpha beta gamma`;
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
    env.height = 2;
    env.timestamp = 2_000;
    await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);

    env.height = 1;
    env.timestamp = 3_000;
    const result = await saveRuntimeFrameToStorage({
      env,
      tryOpenDb: async (targetEnv) => {
        await getRuntimeStorageDb(targetEnv).open();
        return true;
      },
      getRuntimeDb: getRuntimeStorageDb,
      tryOpenFrameDb: async (targetEnv) => {
        await getFrameDb(targetEnv).open();
        return true;
      },
      getFrameDb,
      getPerfMs,
      formatPerfMs: (value) => value.toFixed(2),
      stopStaleWriterOnHeadAhead: true,
    });

    expect(result.staleWriterStopped).toBe(true);
    expect(result.frameDbCommitted).toBe(false);
    const head = await readStorageHead(getFrameDb(env));
    expect(head?.latestHeight).toBe(2);

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('server writer fencing rejects an already held namespace lock before appending', async () => {
    const env = await createSavedEmptyEnv('storage-writer-lock-held');
    const lockPath = resolveStorageWriterLockPath(env);
    writeFileSync(lockPath, `${JSON.stringify({
      owner: 'test-writer',
      pid: process.pid,
      runtimeId: env.runtimeId,
      frameHeight: 2,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + STORAGE_WRITER_LOCK_TTL_MS,
    })}\n`, 'utf8');

    env.height = 2;
    env.timestamp = 2_000;
    await expect(saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [])).rejects.toThrow(
      'STORAGE_WRITER_LOCK_HELD',
    );

    expect(await readStorageFrameRecord(getFrameDb(env), 2)).toBeNull();
    const head = await readStorageHead(getFrameDb(env));
    expect(head?.latestHeight).toBe(1);

    rmSync(lockPath, { force: true });
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('server writer fencing does not steal an expired lock while its pid is still alive', async () => {
    const env = await createSavedEmptyEnv('storage-writer-live-expired-lock');
    const lockPath = resolveStorageWriterLockPath(env);
    writeFileSync(lockPath, `${JSON.stringify({
      owner: 'test-live-writer',
      pid: process.pid,
      runtimeId: env.runtimeId,
      frameHeight: 2,
      acquiredAt: Date.now() - STORAGE_WRITER_LOCK_TTL_MS - 1_000,
      expiresAt: Date.now() - 1_000,
    })}\n`, 'utf8');

    env.height = 2;
    env.timestamp = 2_000;
    await expect(saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [])).rejects.toThrow(
      'STORAGE_WRITER_LOCK_HELD',
    );

    expect(await readStorageFrameRecord(getFrameDb(env), 2)).toBeNull();
    const head = await readStorageHead(getFrameDb(env));
    expect(head?.latestHeight).toBe(1);

    rmSync(lockPath, { force: true });
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('latest restore trusts authoritative history meta and rejects its deletion against the frame digest', async () => {
    const seed = `storage-restore-missing-multisig-meta ${Date.now()} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    cleanupRuntimeStorage(dbRoot, runtimeId);

    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.quietRuntimeLogs = true;
    const signerA = deriveSignerAddressSync(seed, '1').toLowerCase();
    const signerB = deriveSignerAddressSync(seed, '2').toLowerCase();
    registerSignerKey(env, signerA, deriveSignerKeySync(seed, '1'));
    registerSignerKey(env, signerB, deriveSignerKeySync(seed, '2'));
    const entityId = generateLazyEntityId([signerA, signerB], 2n).toLowerCase();
    const jurisdiction = {
      name: 'storage-restore-missing-multisig-meta',
      address: 'browservm://storage-restore-missing-multisig-meta',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    installTestJurisdiction(env, jurisdiction);

    enqueueRuntimeInput(env, {
      runtimeTxs: [signerA, signerB].map((signerId, index) => ({
          type: 'importReplica' as const,
          entityId,
          signerId,
          data: {
            isProposer: index === 0,
            config: {
              mode: 'proposer-based' as const,
              threshold: 2n,
              validators: [signerA, signerB],
              shares: { [signerA]: 1n, [signerB]: 1n },
              jurisdiction,
            },
          },
        })),
      entityInputs: [],
    });
    await processRuntime(env, []);
    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const restored = await loadEnvFromDB(runtimeId, seed);
    if (!restored) throw new Error('test fixture failed to restore multi-validator runtime');
    const restoredReplicas = Array.from(restored.eReplicas.values())
      .filter((replica) => replica.entityId === entityId)
      .sort((left, right) => left.signerId.localeCompare(right.signerId));
    const expectedReplicas = [
      [signerA, true],
      [signerB, false],
    ].sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    expect(restoredReplicas.map(({ signerId, isProposer }) => [signerId, isProposer])).toEqual(expectedReplicas);

    expect(await readRawOrNull(getRuntimeStorageDb(restored), keyLiveReplicaMeta(entityId, signerA))).toBeNull();
    expect(await readRawOrNull(getRuntimeStorageDb(restored), keyLiveReplicaMeta(entityId, signerB))).toBeNull();
    await closeRuntimeDb(restored);
    await closeInfraDb(restored);

    const restoredFromHistory = await loadEnvFromDB(runtimeId, seed);
    if (!restoredFromHistory) throw new Error('test fixture failed to restore from authoritative history meta');
    const identitiesFromHistory = Array.from(restoredFromHistory.eReplicas.values())
      .filter((replica) => replica.entityId === entityId)
      .map(({ signerId, isProposer }) => [signerId, isProposer])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    expect(identitiesFromHistory).toEqual(expectedReplicas);
    await getFrameDb(restoredFromHistory).del(keyLiveReplicaMeta(entityId, signerA));
    await getFrameDb(restoredFromHistory).del(keyLiveReplicaMeta(entityId, signerB));
    await closeRuntimeDb(restoredFromHistory);
    await closeInfraDb(restoredFromHistory);

    await expect(loadEnvFromDB(runtimeId, seed)).rejects.toThrow('STORAGE_VERIFY_REPLICA_META_DIGEST_MISMATCH');
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

  test('restores the bounded transport outbox from the latest committed frame', async () => {
    const seed = `storage-transport-outbox ${Date.now()} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    cleanupRuntimeStorage(dbRoot, runtimeId);
    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.quietRuntimeLogs = true;
    const signer = deriveSignerAddressSync(seed, '1').toLowerCase();
    registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
    const localEntityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const jurisdiction = {
      name: 'storage-transport-outbox',
      address: 'browservm://storage-transport-outbox',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    installTestJurisdiction(env, jurisdiction);
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId: localEntityId,
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

    const pendingOutput = {
      runtimeId: `0x${'71'.repeat(20)}`,
      entityId: `0x${'72'.repeat(32)}`,
      signerId: `0x${'73'.repeat(20)}`,
      sourceRuntimeFrame: { height: env.height, timestamp: env.timestamp },
      proposedFrame: {
        height: 22,
        parentFrameHash: `0x${'74'.repeat(32)}`,
        stateRoot: `0x${'75'.repeat(32)}`,
        authorityRoot: `0x${'76'.repeat(32)}`,
        timestamp: 22,
        hash: `0x${'77'.repeat(32)}`,
        txs: [],
        leader: { proposerSignerId: `0x${'73'.repeat(20)}`, view: 0 },
        collectedSigs: new Map(),
      },
    } satisfies DeliverableEntityInput;
    const retryKey = buildRouteOutputKey(pendingOutput);
    const persistedFutureRetryAt = 8_000_000_000_000;
    env.pendingNetworkOutputs = [pendingOutput];
    env.runtimeState ??= {};
    env.runtimeState.deferredNetworkMeta = new Map([[
      retryKey,
      { attempts: 6, nextRetryAt: persistedFutureRetryAt },
    ]]);
    const secondSigner = deriveSignerAddressSync(seed, '2').toLowerCase();
    registerSignerKey(env, secondSigner, deriveSignerKeySync(seed, '2'));
    const secondEntityId = generateLazyEntityId([secondSigner], 1n).toLowerCase();
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId: secondEntityId,
        signerId: secondSigner,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [secondSigner],
            shares: { [secondSigner]: 1n },
            jurisdiction,
          },
        },
      }],
      entityInputs: [],
    });
    await processRuntime(env, []);
    const journal = await readPersistedFrameJournal(env, env.height);
    expect(journal?.runtimeOutputs).toEqual([pendingOutput]);
    expect(journal?.runtimeMachine).toBeUndefined();
    expect(journal?.runtimeStateHash).toBeUndefined();
    const liveCanonicalStateHash = computeCanonicalStateHashFromEnv(env);
    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const verification = await verifyRuntimeChain(runtimeId, seed);
    expect(verification.ok).toBe(true);
    const restored = await loadEnvFromDB(runtimeId, seed);
    expect(restored?.pendingNetworkOutputs).toEqual([pendingOutput]);
    expect(restored?.runtimeState?.deferredNetworkMeta?.get(retryKey)).toEqual({
      attempts: 6,
      nextRetryAt: persistedFutureRetryAt,
    });
    if (restored) {
      expect(computeCanonicalStateHashFromEnv(restored)).toBe(liveCanonicalStateHash);
      await processRuntime(restored, []);
      expect(restored.runtimeState?.deferredNetworkMeta?.get(retryKey)?.attempts).toBe(7);
      expect(restored.runtimeState?.deferredNetworkMeta?.get(retryKey)?.nextRetryAt)
        .toBeLessThan(persistedFutureRetryAt);
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
  });

  test('production refuses storage safety override flags', async () => {
    const env = await createSavedEmptyEnv('storage-production-safety-flags');
    const runtimeId = env.runtimeId!;
    const seed = env.runtimeSeed!;

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const previousNodeEnv = process.env['NODE_ENV'];
    const previousSkip = process.env['XLN_STORAGE_SKIP_VERIFY_ON_OPEN'];
    const previousForce = process.env['XLN_STORAGE_FORCE_RESTORE'];

    try {
      process.env['NODE_ENV'] = 'production';
      for (const flag of ['XLN_STORAGE_SKIP_VERIFY_ON_OPEN', 'XLN_STORAGE_FORCE_RESTORE'] as const) {
        delete process.env['XLN_STORAGE_SKIP_VERIFY_ON_OPEN'];
        delete process.env['XLN_STORAGE_FORCE_RESTORE'];
        process.env[flag] = '1';

        await expect(loadEnvFromDB(runtimeId, seed)).rejects.toThrow(
          `STORAGE_SAFETY_OVERRIDE_FORBIDDEN_IN_PRODUCTION: flags=${flag}`,
        );
      }
    } finally {
      if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousNodeEnv;
      if (previousSkip === undefined) delete process.env['XLN_STORAGE_SKIP_VERIFY_ON_OPEN'];
      else process.env['XLN_STORAGE_SKIP_VERIFY_ON_OPEN'] = previousSkip;
      if (previousForce === undefined) delete process.env['XLN_STORAGE_FORCE_RESTORE'];
      else process.env['XLN_STORAGE_FORCE_RESTORE'] = previousForce;
    }
  });

  test('production chains every WAL frame without rebuilding the canonical replay oracle by default', async () => {
    const previousNodeEnv = process.env['NODE_ENV'];
    const previousPeriod = process.env['XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES'];
    const previousVerify = process.env['XLN_STORAGE_VERIFY_CANONICAL'];
    const env = createEmptyEnv(`storage-prod-canonical-default ${Date.now()}`);

    try {
      process.env['NODE_ENV'] = 'production';
      delete process.env['XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES'];
      delete process.env['XLN_STORAGE_VERIFY_CANONICAL'];
      env.quietRuntimeLogs = true;
      env.runtimeId = deriveSignerAddressSync(env.runtimeSeed!, '1').toLowerCase();
      env.dbNamespace = env.runtimeId;
      env.height = 1;
      env.timestamp = 1_000;

      await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
      const frame = await readStorageFrameRecord(getFrameDb(env), 1);
      expect(frame?.stateHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(frame?.frameHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(frame?.canonicalStateHash).toBeUndefined();
      expect(frame?.canonicalEntityHashes).toBeUndefined();
    } finally {
      await closeRuntimeDb(env);
      await closeInfraDb(env);
      if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousNodeEnv;
      if (previousPeriod === undefined) delete process.env['XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES'];
      else process.env['XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES'] = previousPeriod;
      if (previousVerify === undefined) delete process.env['XLN_STORAGE_VERIFY_CANONICAL'];
      else process.env['XLN_STORAGE_VERIFY_CANONICAL'] = previousVerify;
    }
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
    registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
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
    const corrupted = decodeBuffer<StorageEntityCoreDoc>(raw);
    corrupted.messages = [...(Array.isArray(corrupted.messages) ? corrupted.messages : []), 'corrupted snapshot body'];
    await getFrameDb(env).put(snapshotKey, encodeBuffer(corrupted));

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    await expect(loadEnvFromDB(runtimeId, seed)).rejects.toThrow('STORAGE_ENTITY_HASH_MISMATCH');
  });

  test('fails closed when a replay diff is missing after the latest snapshot', async () => {
    const seed = `storage-missing-replay-diff ${Date.now()} alpha beta gamma`;
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
        materializePeriodFrames: 100,
        snapshotPeriodFrames: 100,
      },
    };

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
    const jurisdiction = {
      name: 'storage-missing-replay-diff-test',
      address: 'browservm://storage-missing-replay-diff-test',
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

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId: signer,
        entityTxs: [{
          type: 'profile-update',
          data: { profile: { entityId, name: 'requires replay diff' } },
        }],
      }],
    });
    await processRuntime(env, []);
    expect(env.height).toBe(2);

    const historyDb = getFrameDb(env);
    expect(await readRawOrNull(historyDb, keyDiff(2))).toBeTruthy();
    const batch = historyDb.batch();
    batch.del?.(keyDiff(2));
    await batch.write({ sync: true });

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    await expect(loadEnvFromDB(runtimeId, seed)).rejects.toThrow('STORAGE_DIFF_MISSING: height=2');
  });

  test('fails closed when overlay replay diff is missing', async () => {
    const env = await createSavedEmptyEnv('storage-missing-overlay-diff');
    const frameDb = getFrameDb(env);

    expect(await readRawOrNull(frameDb, keyDiff(1))).toBeTruthy();
    const batch = frameDb.batch();
    batch.del?.(keyDiff(1));
    await batch.write({ sync: true });

    await expect(readStorageOverlayRecordsFromDiffs(frameDb, 1, 1))
      .rejects.toThrow('STORAGE_DIFF_MISSING: height=1 scope=overlay');

    await closeRuntimeDb(env);
    await closeInfraDb(env);
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
        retainSnapshots: 1,
        epochMaxBytes: 1_000_000,
      },
    };

    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
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

    // Production reaches the byte threshold after the live Env already owns
    // open LevelDB handles. Force that exact boundary without shrinking the
    // configured epoch below one ordinary frame: after rotation the unchanged
    // threshold must allow the next frame instead of rotating forever.
    const preRotationHistoryHead = await readStorageHead(getFrameDb(env));
    if (!preRotationHistoryHead) throw new Error('rotation test history head missing');
    const forcedEpochHead = {
      ...preRotationHistoryHead,
      epochReplayBytes: preRotationHistoryHead.epochMaxBytes,
    };
    const forceHistory = getFrameDb(env).batch();
    forceHistory.put(KEY_HEAD, encodeBuffer(forcedEpochHead));
    await writeBatch(forceHistory);
    const forceCurrent = getRuntimeStorageDb(env).batch();
    forceCurrent.put(KEY_HEAD, encodeBuffer(forcedEpochHead));
    await writeBatch(forceCurrent);
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId: signer,
        entityTxs: [{
          type: 'profile-update',
          data: { profile: { entityId, name: 'rotation-trigger' } },
        }],
      }],
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
    expect(currentHead?.epochReplayBytes).toBe(0);
    expect(historyHead?.epochReplayBytes).toBe(0);
    expect(currentHead?.retainedHistoryBytes).toBe(0);
    expect(historyHead?.retainedHistoryBytes ?? 0).toBeGreaterThan(0);
    expect(await readRawOrNull(getFrameDb(env), keySnapshotManifest(snapshotHeight))).toBeTruthy();
    expect(await readRawOrNull(getFrameDb(env), keyFrame(snapshotHeight))).toBeTruthy();
    expect(await readRawOrNull(getFrameDb(env), keyDiff(snapshotHeight))).toBeNull();
    expect(await readRawOrNull(getRuntimeStorageDb(env), keyFrame(snapshotHeight))).toBeNull();

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId: signer,
        entityTxs: [{
          type: 'profile-update',
          data: { profile: { entityId, name: 'post-rotation-live-frame' } },
        }],
      }],
    });
    await processRuntime(env, []);
    expect(await getPersistedLatestHeight(env)).toBe(latestAfterRotation + 1);
    const postRotationHistoryHead = await readStorageHead(getFrameDb(env));
    expect(postRotationHistoryHead?.latestSnapshotHeight).toBe(snapshotHeight);
    expect(postRotationHistoryHead?.epochReplayBytes ?? 0).toBeGreaterThan(0);
    expect(postRotationHistoryHead?.epochReplayBytes ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(preRotationHistoryHead.epochMaxBytes);

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const restored = await loadEnvFromDB(runtimeId, seed);
    expect(restored?.height).toBe(latestAfterRotation + 1);
    if (restored) {
      enqueueRuntimeInput(restored, {
        runtimeTxs: [],
        entityInputs: [{
          entityId,
          signerId: signer,
          entityTxs: [{
            type: 'profile-update',
            data: { profile: { entityId, name: 'post-rotation-restored-frame' } },
          }],
        }],
      });
      await processRuntime(restored, []);
      expect(restored.height).toBe(latestAfterRotation + 2);
      expect(await getPersistedLatestHeight(restored)).toBe(latestAfterRotation + 2);
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
  });

  test('prunes finalized frame journals while compact account activity remains readable', async () => {
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
    env.runtimeConfig = {
      ...(env.runtimeConfig || {}),
      snapshotIntervalFrames: 1,
      storage: {
        ...(env.runtimeConfig?.storage || {}),
        snapshotPeriodFrames: 1,
      },
    };
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;

    const signerA = deriveSignerAddressSync(seed, '1');
    const signerB = deriveSignerAddressSync(seed, '2');
    registerSignerKey(env, signerA, deriveSignerKeySync(seed, '1'));
    registerSignerKey(env, signerB, deriveSignerKeySync(seed, '2'));

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
        account: '0x000000000000000000000000000000000000ac01',
        deltaTransformer: '0x000000000000000000000000000000000000de17',
      },
    } as never);

    enqueueRuntimeInput(env, {
      timestamp: env.timestamp,
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
      timestamp: env.timestamp,
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

    const checkpointHeights = await listPersistedCheckpointHeights(env);
    expect(checkpointHeights.length).toBeGreaterThan(0);
    expect(await readPersistedFrameJournal(env, 1)).toBeNull();
    expect(await readPersistedFrameJournal(env, checkpointHeights.at(-1)!)).toBeTruthy();

    env.runtimeConfig = {
      ...(env.runtimeConfig || {}),
      storage: {
        ...(env.runtimeConfig?.storage || {}),
        snapshotPeriodFrames: latestHeight + 100,
      },
    };
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: entityA,
        signerId: signerA,
        entityTxs: [{
          type: 'profile-update',
          data: { profile: { entityId: entityA, name: 'retention-replay-tail' } },
        }],
      }],
    });
    await processRuntime(env, []);
    const replayTailHeight = env.height;
    expect(await readPersistedFrameJournal(env, replayTailHeight)).toBeTruthy();

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const restored = await loadEnvFromDB(runtimeId, seed);
    expect(restored).toBeTruthy();
    expect(restored?.height).toBe(replayTailHeight);
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
    registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
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

    for (let signerIndex = 2; signerIndex <= 5; signerIndex += 1) {
      const height = env.height + 1;
      env.frameLogs = [{
        id: height,
        timestamp: env.timestamp,
        level: 'info',
        category: 'system',
        message: `storage-crash-frame-db-loss-${height}`,
      }];
      const nextSigner = deriveSignerAddressSync(seed, String(signerIndex));
      registerSignerKey(env, nextSigner, deriveSignerKeySync(seed, String(signerIndex)));
      const nextEntityId = generateLazyEntityId([nextSigner], 1n).toLowerCase();
      enqueueRuntimeInput(env, {
        runtimeTxs: [{
          type: 'importReplica',
          entityId: nextEntityId,
          signerId: nextSigner,
          data: {
            isProposer: true,
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [nextSigner],
              shares: { [nextSigner]: 1n },
              jurisdiction,
            },
          },
        }],
        entityInputs: [],
      });
      await processRuntime(env, []);
    }

    const latestHeight = await getPersistedLatestHeight(env);
    const checkpointHeights = await listPersistedCheckpointHeights(env);
    const replayFromHeight = checkpointHeights.at(-1) ?? latestHeight;

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
    batch.del(keySnapshotManifest(1));
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
    await expect(readPersistedCheckpointSnapshot(env, 1))
      .rejects.toThrow('STORAGE_VERIFY_SNAPSHOT_FRAME_MISSING');
  });

  test('rejects a snapshot manifest when the frame was not materialized', async () => {
    const env = await createSavedEmptyEnv('storage-crash-snapshot-not-materialized');
    const db = getFrameDb(env);
    const head = await readStorageHead(db);
    if (!head) throw new Error('TEST_HEAD_MISSING');
    const frame = decodeBuffer<StorageFrameRecord>(await db.get(keyFrame(1)));
    const { entityHashes: _entityHashes, ...nonMaterializedFrame } = frame;
    const batch = db.batch();
    batch.put(KEY_HEAD, encodeBuffer({
      ...head,
      latestSnapshotHeight: 1,
      latestMaterializedHeight: 1,
    }));
    batch.put(keySnapshotManifest(1), encodeBuffer({ height: 1, createdAt: 1_000, docCount: 0 }));
    batch.put(keyFrame(1), encodeBuffer({ ...nonMaterializedFrame, materializedState: false }));
    await batch.write({ sync: true });

    await expect(verifyStorageTailIntegrity(db)).rejects.toThrow('STORAGE_VERIFY_SNAPSHOT_NOT_MATERIALIZED');

    await closeRuntimeDb(env);
    await closeInfraDb(env);
  });

  test('rejects corrupted or torn replica metadata in a published snapshot', async () => {
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
    registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
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
    const snapshotMetaKey = keySnapshotReplicaMeta(snapshotHeight, entityId, signer);
    expect(await readRawOrNull(getRuntimeStorageDb(env), keyLiveReplicaMeta(entityId, signer))).toBeNull();
    const validMeta = await db.get(snapshotMetaKey);
    const corruptedMeta = decodeBuffer<Record<string, unknown>>(validMeta);
    corruptedMeta['hankoWitness'] = 'not-a-map';
    await db.put(snapshotMetaKey, encodeBuffer(corruptedMeta));
    await expect(listStorageSnapshotReplicaMetas(db, snapshotHeight, entityId))
      .rejects.toThrow('hankoWitness must be a Map');

    const missingMempoolMeta = decodeBuffer<Record<string, unknown>>(validMeta);
    delete missingMempoolMeta['mempool'];
    await db.put(snapshotMetaKey, encodeBuffer(missingMempoolMeta));
    await expect(listStorageSnapshotReplicaMetas(db, snapshotHeight, entityId))
      .rejects.toThrow('mempool must be an array');

    const digestCorruptedMeta = decodeBuffer<Record<string, unknown>>(validMeta);
    digestCorruptedMeta['lastConsensusProgressAt'] = 123_456;
    await db.put(snapshotMetaKey, encodeBuffer(digestCorruptedMeta));

    await expect(verifyStorageTailIntegrity(db)).rejects.toThrow(
      'STORAGE_VERIFY_SNAPSHOT_REPLICA_META_DIGEST_MISMATCH',
    );

    await db.put(snapshotMetaKey, validMeta);

    const snapshotEntityKey = keySnapshotEntity(snapshotHeight, entityId);
    const validEntity = await db.get(snapshotEntityKey);
    const corruptedEntity = decodeBuffer<Record<string, unknown>>(validEntity);
    corruptedEntity['timestamp'] = Number(corruptedEntity['timestamp'] ?? 0) + 1;
    await db.put(snapshotEntityKey, encodeBuffer(corruptedEntity));
    await expect(verifyStorageTailIntegrity(db)).rejects.toThrow(
      'STORAGE_ENTITY_HASH_MISMATCH',
    );
    await db.put(snapshotEntityKey, validEntity);

    const batch = db.batch();
    batch.del?.(snapshotMetaKey);
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
    registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
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

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId: signer,
        entityTxs: [{
          type: 'profile-update',
          data: { profile: { entityId, name: 'non-materialized-message' } },
        }],
      }],
    });
    await processRuntime(env, []);
    expect(env.height).toBe(2);
    expect(env.overlay?.length ?? 0).toBeGreaterThan(0);

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const restoredAtTwo = await loadEnvFromDB(runtimeId, seed);
    expect(restoredAtTwo?.height).toBe(2);
    const restoredReplica = Array.from(restoredAtTwo?.eReplicas.values() ?? [])
      .find((item) => item.entityId === entityId);
    expect(restoredReplica?.state.profile.name).toBe('non-materialized-message');
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
    enqueueRuntimeInput(restoredAtTwo, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId: signer,
        entityTxs: [{
          type: 'profile-update',
          data: { profile: { entityId, name: 'non-materialized-message' } },
        }],
      }],
    });
    await processRuntime(restoredAtTwo, []);
    expect(restoredAtTwo.height).toBe(3);
    expect(restoredAtTwo.overlay?.length ?? 0).toBe(0);
    const materializedFrame = await readStorageFrameRecord(getFrameDb(restoredAtTwo), 3);
    expect(materializedFrame?.replicaMetaStateMode).toBe('shared-entity-state');
    const compactMeta = decodeBuffer<Record<string, unknown>>(
      await getFrameDb(restoredAtTwo).get(keyLiveReplicaMeta(entityId, signer)),
    );
    expect(compactMeta['state']).toBeUndefined();
    expect(compactMeta['localEntityState']).toBeDefined();
    expect((await verifyStorageTailIntegrity(getFrameDb(restoredAtTwo))).checkedFrames).toBe(3);

    await closeRuntimeDb(restoredAtTwo);
    await closeInfraDb(restoredAtTwo);

    const restoredAfterMaterialize = await loadEnvFromDB(runtimeId, seed);
    const materializedReplica = Array.from(restoredAfterMaterialize?.eReplicas.values() ?? [])
      .find((item) => item.entityId === entityId);
    expect(restoredAfterMaterialize?.height).toBe(3);
    expect(materializedReplica?.state.profile.name).toBe('non-materialized-message');
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
