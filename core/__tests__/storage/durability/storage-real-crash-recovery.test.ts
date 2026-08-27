import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  getRuntimeWalDb,
  getHistoryViewDb,
  getRuntimeStorageDb,
  loadEnvFromDB,
  saveEnvToDB,
  tryOpenStorageDb,
} from '../../../runtime';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { requireEntityEncryptionPrivateKey } from '../../../entity/auth/crypto';
import { provisionTestEntityEncryptionKey } from '../../../qa/entity-creation-fixture';
import { ENTITY_FRAME_EVENT_COLLECTOR } from '../../../entity/frame-events';
import { getEntityLeaderState } from '../../../entity/consensus/leader';
import { buildJPrefixCertificate } from '../../../jurisdiction/machine/history/j-prefix-consensus';
import { generateNumberedEntityId } from '../../../entity/factory';
import { verifyHankoForHash } from '../../../hanko/signing';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../jurisdiction/machine/board-registry';
import type { CertifiedBoardPatriciaNode } from '../../../types/entity-board-registry';
import { dbRootPath } from '../../../runtime/replica/platform';
import { computeCanonicalStateHashFromEnv } from '../../../storage/canonical-hash';
import { buildCertifiedEntityHeadPlan } from '../../../storage/replica/entity-head';
import {
  readStorageHead,
  readHistoryViewHead,
  resolveStorageRuntimeConfig,
  readStorageFrameRecord,
  loadEntityStateFromStorage,
  recoverStorageDbFromHistory,
  type StoragePersistenceBoundary,
} from '../../../storage';
import { decodeBuffer, encodeBuffer } from '../../../storage/codec/codec';
import { createSnapshot } from '../../../storage/database/lifecycle';
import { createSnapshotEntityGraphView } from '../../../storage/database/snapshot-graph-view';
import { iterateKeys, readRawOrNull } from '../../../storage/database/level';
import { readEntityStorageLayout } from '../../../storage/schema/entity/layout';
import { validatePersistedCertifiedBoardPathNode } from '../../../storage/schema/authoritative-schema';
import {
  KEY_HEAD,
  keyCertifiedBoardNodePrefix,
  keyLiveEntity,
  keyLiveReplicaMeta,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntityPrefix,
  keySnapshotManifest,
  keySnapshotGraphPrefix,
  keySnapshotReplicaMetaPrefix,
} from '../../../storage/keys';
import type {
  StorageReplicaMeta,
  StorageRuntimeConfig,
} from '../../../storage/types';

const fixture = join(import.meta.dir, '..', '..', 'fixtures/storage/storage-crash-boundary-child.ts');
const namespaces: Array<{ dbRoot: string; runtimeId: string }> = [];
const config: Required<StorageRuntimeConfig> = {
  enabled: true,
  snapshotPeriodFrames: 1,
  retainSnapshots: 1,
  epochMaxBytes: 1_000_000_000,
  historyViewMaxBytes: 1,
  historyViewRetainFrames: 1,
  materializePeriodFrames: 1_000,
  canonicalHashPeriodFrames: 1,
  accountMerkleRadix: 16,
};

const cleanupRuntimeStorage = (dbRoot: string, runtimeId: string): void => {
  const namespacePath = join(dbRoot, runtimeId);
  rmSync(namespacePath, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
  rmSync(`${namespacePath}-wal`, { recursive: true, force: true });
  rmSync(`${namespacePath}-history-views`, { recursive: true, force: true });
  rmSync(`${namespacePath}-events`, { recursive: true, force: true });
  rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
};

const countSnapshotBodyKeys = async (db: ReturnType<typeof getRuntimeWalDb>, height: number): Promise<number> => {
  let count = 0;
  for (const prefix of [
    keySnapshotEntityPrefix(height),
    keySnapshotAccountPrefix(height),
    keySnapshotBookPrefix(height),
    keySnapshotReplicaMetaPrefix(height),
  ]) {
    for await (const _key of iterateKeys(db, { prefix })) count += 1;
  }
  return count;
};

afterEach(() => {
  while (namespaces.length > 0) {
    const namespace = namespaces.pop()!;
    cleanupRuntimeStorage(namespace.dbRoot, namespace.runtimeId);
  }
});

describe('real process storage crash recovery', () => {
  test('restores frame one from the authoritative materialized graph before snapshot publication', async () => {
    const dbRoot = dbRootPath;
    mkdirSync(dbRoot, { recursive: true });
    const boundary: StoragePersistenceBoundary = 'after-authoritative-history-commit';
    const seed = `storage first frame crash ${process.pid} deterministic seed`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    namespaces.push({ dbRoot, runtimeId });
    cleanupRuntimeStorage(dbRoot, runtimeId);

    const child = Bun.spawn({
      cmd: [process.execPath, fixture, seed, boundary],
      cwd: join(import.meta.dir, '..', '..', '..', '..'),
      env: {
        ...process.env,
        XLN_DB_PATH: dbRoot,
        XLN_STORAGE_CRASH_ON_FIRST_FRAME: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(137);
    expect(child.signalCode, stderr).toBe('SIGKILL');

    const restored = await loadEnvFromDB(runtimeId, seed);
    if (!restored) throw new Error('frame-one crash fixture did not restore');
    try {
      expect(restored.state.height).toBe(1);
      expect(restored.state.eReplicas.size).toBe(2);
      const entityId = generateNumberedEntityId(2).toLowerCase();
      const signerB = deriveSignerAddressSync(seed, '2').toLowerCase();
      const replica = Array.from(restored.state.eReplicas.values()).find(candidate =>
        candidate.entityId === entityId && candidate.signerId === signerB,
      );
      expect(replica?.state.height).toBe(1);
      expect(replica?.htlcNotes).toEqual(
        new Map([['hashlock:0x01', 'crash-recovery-note']]),
      );
      const head = await readStorageHead(getRuntimeWalDb(restored));
      expect(head?.latestSnapshotHeight).toBe(0);
      expect(head?.latestMaterializedHeight).toBe(1);
    } finally {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
  }, 30_000);

  for (const boundary of [
    'after-authoritative-history-commit',
    'after-history-view-commit',
    'after-current-cache-commit',
    'after-history-view-prune',
    'after-snapshot-body-batch',
    'after-snapshot-manifest',
    'after-snapshot-history-publish',
    'after-snapshot-retention-prune',
    'after-replay-prune',
    'after-snapshot-history-head',
    'after-snapshot-current-head',
  ] satisfies StoragePersistenceBoundary[]) {
    test(`restores exact replica progress after SIGKILL during forced epoch rotation ${boundary}`, async () => {
      const dbRoot = dbRootPath;
      mkdirSync(dbRoot, { recursive: true });
      const seed = `storage real crash ${process.pid} ${boundary} deterministic seed`;
      const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
      namespaces.push({ dbRoot, runtimeId });
      cleanupRuntimeStorage(dbRoot, runtimeId);

      const child = Bun.spawn({
        cmd: [process.execPath, fixture, seed, boundary],
        cwd: join(import.meta.dir, '..', '..', '..', '..'),
        env: { ...process.env, XLN_DB_PATH: dbRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(exitCode, stderr).toBe(137);
      expect(child.signalCode, stderr).toBe('SIGKILL');

      const restored = await loadEnvFromDB(runtimeId, seed);
      if (!restored) throw new Error('real crash fixture did not restore');
      try {
        expect(restored.state.height).toBe(2);
        expect(
          (await readHistoryViewHead(
            getHistoryViewDb(restored),
            resolveStorageRuntimeConfig(restored),
          )).latestHeight,
        ).toBe(2);
        const signerA = deriveSignerAddressSync(seed, '1').toLowerCase();
        const signerB = deriveSignerAddressSync(seed, '2').toLowerCase();
        const entityId = generateNumberedEntityId(2).toLowerCase();
        const expectedKeys = provisionTestEntityEncryptionKey(restored, entityId);
        const replica = Array.from(restored.state.eReplicas.values()).find((candidate) => (
          candidate.entityId === entityId && candidate.signerId === signerB
        ));
        expect(replica?.state.height).toBe(1);
        expect(replica && Object.hasOwn(replica.state, 'messages')).toBeFalse();
        expect(replica?.state.entityEncryptionPublicKey).toBe(expectedKeys.publicKey);
        expect(requireEntityEncryptionPrivateKey(restored, entityId))
          .toBe(expectedKeys.privateKey);
        expect(replica && Object.hasOwn(replica, 'entityEncPrivKey')).toBeFalse();
        expect(replica?.htlcNotes).toEqual(
          new Map([['hashlock:0x01', 'crash-recovery-note']]),
        );
        expect(replica?.certifiedFrameHead).toBeUndefined();
        expect(replica?.certifiedFrameAnchor?.height).toBe(1);
        expect(replica?.certifiedFrameAnchor?.runtimeCheckpoint?.replicaSetRoot)
          .toMatch(/^0x[0-9a-f]{64}$/);
        expect(replica ? getEntityLeaderState(replica.state) : undefined).toEqual({
          activeValidatorId: signerA,
          view: 0,
          changedAtHeight: 0,
        });
        expect(replica?.leaderVotes?.size).toBe(2);
        expect(replica?.pendingLeaderCertificate?.toView).toBe(1);
        expect(replica?.pendingLeaderCertificate?.votes.size).toBe(2);
        expect(replica?.lastConsensusProgressAt).toBe(12_345);
        expect(replica?.jPrefixRound?.targetEntityHeight).toBe(2);
        expect(replica?.jPrefixRound?.attestations.size).toBe(2);
        const rebuiltJPrefixCertificate = replica
          ? buildJPrefixCertificate(replica.state, replica.jPrefixRound!.attestations)
          : null;
        expect(rebuiltJPrefixCertificate).not.toBeNull();
        expect(replica?.jPrefixRound?.certificate).toEqual(rebuiltJPrefixCertificate!);
        expect([...replica!.jPrefixRound!.certificate!.attestations.keys()])
          .toEqual([signerA, signerB].sort());
        expect(replica?.jPrefixRound?.certificate?.selected.scannedThroughHeight).toBe(7);
        expect(replica?.jHistory).toEqual({
          jurisdictionRef: 'stack:31337:0x000000000000000000000000000000000000dead',
          scannedThroughHeight: 7,
          contiguousThroughHeight: 7,
          tipBlockHash: `0x${'ab'.repeat(32)}`,
          eventBlocks: new Map(),
          // Finalized H1-H2 are already committed by Entity consensus and are
          // not duplicated in validator-local pending history.
          blockHashes: new Map(Array.from({ length: 5 }, (_, index) => {
            const height = index + 3;
            return [
              height,
              height === 7
                ? `0x${'ab'.repeat(32)}`
                : `0x${height.toString(16).padStart(2, '0').repeat(32)}`,
            ];
          })),
        });

        const submitReplica = Array.from(restored.state.eReplicas.values()).find((candidate) => (
          candidate.entityId === entityId && candidate.signerId === signerA
        ));
        expect(submitReplica?.state.height).toBe(1);
        // The synced Runtime checkpoint is the durable anchor. Recovery keeps
        // that endpoint and rebuilds only links certified after it, so a
        // checkpoint exactly at H1 restores with an empty in-memory tail.
        expect(submitReplica?.certifiedFrameAnchor?.height).toBe(1);
        expect(submitReplica?.certifiedFrameHead).toBeUndefined();
        expect(submitReplica?.certifiedFrameAnchor?.height).toBe(1);
        expect(submitReplica?.certifiedFrameAnchor?.runtimeCheckpoint)
          .toEqual(replica?.certifiedFrameAnchor?.runtimeCheckpoint);
        expect(submitReplica?.state.entityEncryptionPublicKey).toBe(expectedKeys.publicKey);
        expect(requireEntityEncryptionPrivateKey(restored, entityId))
          .toBe(expectedKeys.privateKey);
        expect(submitReplica && Object.hasOwn(submitReplica, 'entityEncPrivKey'))
          .toBeFalse();
        expect(submitReplica?.htlcNotes).toBeUndefined();
        const certifiedBoardHash = submitReplica
          ? resolveObserverCertifiedBoardHash(
              submitReplica.state,
              getCertifiedBoardNodeStore(restored),
              entityId,
            )
          : null;
        expect(certifiedBoardHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(getCertifiedBoardNodeStore(restored).size).toBeGreaterThanOrEqual(3);
        const witness = submitReplica?.hankoWitness?.values().next().value;
        expect(witness?.type).toBe('jBatch');
        expect(witness && certifiedBoardHash
          ? (await verifyHankoForHash(
              witness.hanko,
              submitReplica!.hankoWitness!.keys().next().value!,
              entityId,
              restored,
              { registeredBoardHash: certifiedBoardHash },
            )).valid
          : false).toBe(true);
        expect(submitReplica?.jSubmitState).toMatchObject({
          entityNonce: 1,
          submitAttempts: 1,
        });
        expect(restored.infrastructure?.pendingCommittedJOutbox).toHaveLength(1);
        const pendingBatch = restored.infrastructure?.pendingCommittedJOutbox?.[0]?.jTxs[0];
        expect(pendingBatch?.type).toBe('batch');
        expect(pendingBatch?.type === 'batch' ? pendingBatch.data.runtimeSubmitAttempt : undefined)
          .toMatchObject({
            attemptNumber: 1,
            attemptedAt: submitReplica?.jSubmitState?.lastSubmittedAt,
          });

        const historyDb = getRuntimeWalDb(restored);
        const currentDb = getRuntimeStorageDb(restored);
        const historyHead = await readStorageHead(historyDb);
        expect(historyHead?.latestHeight).toBe(2);
        const frame = await readStorageFrameRecord(historyDb, 2);
        expect(frame?.canonicalStateHash).toBe(computeCanonicalStateHashFromEnv(restored));
        await recoverStorageDbFromHistory({ db: currentDb, walDb: historyDb, config });
        expect(await readStorageHead(currentDb)).toEqual(historyHead);
        expect(await readRawOrNull(currentDb, keyLiveReplicaMeta(entityId, signerB))).toBeNull();
        expect(await readRawOrNull(currentDb, keyLiveReplicaMeta(entityId, signerA))).toBeNull();

        restored.state.height += 1;
        restored.state.timestamp += 1;
        await saveEnvToDB(restored, { runtimeTxs: [], entityInputs: [] }, [], undefined, new Map());
        const committedHead = await readStorageHead(getRuntimeWalDb(restored));
        expect(committedHead?.latestHeight).toBe(3);
        const committedFrame = await readStorageFrameRecord(getRuntimeWalDb(restored), 3);
        expect(committedFrame?.canonicalStateHash).toBe(computeCanonicalStateHashFromEnv(restored));
        expect(await tryOpenStorageDb(restored, 'current')).toBe(true);
        const liveCurrentDb = getRuntimeStorageDb(restored, 'current');
        expect(liveCurrentDb.status).toBe('open');
        if (await tryOpenStorageDb(restored, 'previous')) {
          const livePreviousDb = getRuntimeStorageDb(restored, 'previous');
          expect(livePreviousDb).not.toBe(liveCurrentDb);
          expect(livePreviousDb.status).toBe('open');
        }
      } finally {
        await closeRuntimeDb(restored);
        await closeInfraDb(restored);
      }
    }, 30_000);
  }

  test('snapshot cleanup fails loud when HEAD publishes a manifest-less body', async () => {
    const dbRoot = dbRootPath;
    mkdirSync(dbRoot, { recursive: true });
    const boundary: StoragePersistenceBoundary = 'after-snapshot-body-batch';
    const seed = `storage published orphan corruption ${process.pid} deterministic seed`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    namespaces.push({ dbRoot, runtimeId });
    cleanupRuntimeStorage(dbRoot, runtimeId);

    const child = Bun.spawn({
      cmd: [process.execPath, fixture, seed, boundary],
      cwd: join(import.meta.dir, '..', '..', '..', '..'),
      env: { ...process.env, XLN_DB_PATH: dbRoot },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(137);
    expect(child.signalCode, stderr).toBe('SIGKILL');

    const restored = await loadEnvFromDB(runtimeId, seed);
    if (!restored) throw new Error('published orphan corruption fixture did not restore');
    try {
      const historyDb = getRuntimeWalDb(restored);
      const currentDb = getRuntimeStorageDb(restored);
      const head = await readStorageHead(historyDb);
      if (!head) throw new Error('published orphan corruption head missing');
      expect(await countSnapshotBodyKeys(historyDb, 2)).toBeGreaterThan(0);
      expect(await readRawOrNull(historyDb, keySnapshotManifest(2))).toBeNull();
      await historyDb.put(KEY_HEAD, encodeBuffer({ ...head, latestSnapshotHeight: 2 }));

      await expect(createSnapshot(currentDb, historyDb, 3, restored.state.timestamp + 1))
        .rejects.toThrow('STORAGE_VERIFY_SNAPSHOT_MANIFEST_MISSING: height=2');
      expect(await countSnapshotBodyKeys(historyDb, 2)).toBeGreaterThan(0);
    } finally {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
  }, 30_000);

  for (const boundary of [
    'after-snapshot-body-batch',
    'after-snapshot-manifest',
  ] satisfies StoragePersistenceBoundary[]) {
    test(`next writer collects the unpublished snapshot after SIGKILL ${boundary}`, async () => {
      const dbRoot = dbRootPath;
      mkdirSync(dbRoot, { recursive: true });
      const seed = `storage orphan cleanup ${process.pid} ${boundary} deterministic seed`;
      const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
      namespaces.push({ dbRoot, runtimeId });
      cleanupRuntimeStorage(dbRoot, runtimeId);

      const child = Bun.spawn({
        cmd: [process.execPath, fixture, seed, boundary],
        cwd: join(import.meta.dir, '..', '..', '..', '..'),
        env: { ...process.env, XLN_DB_PATH: dbRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(exitCode, stderr).toBe(137);
      expect(child.signalCode, stderr).toBe('SIGKILL');

      const restored = await loadEnvFromDB(runtimeId, seed);
      if (!restored) throw new Error('snapshot orphan cleanup fixture did not restore');
      try {
        const historyDb = getRuntimeWalDb(restored);
        const beforeHead = await readStorageHead(historyDb);
        expect(beforeHead?.latestHeight).toBe(2);
        expect(beforeHead?.latestSnapshotHeight).toBe(1);
        expect(await countSnapshotBodyKeys(historyDb, 2)).toBeGreaterThan(0);
        expect(Boolean(await readRawOrNull(historyDb, keySnapshotManifest(2))))
          .toBe(boundary === 'after-snapshot-manifest');

        restored.runtimeConfig.storage = {
          ...restored.runtimeConfig.storage,
          snapshotPeriodFrames: 1,
          retainSnapshots: 3,
        };
        restored.state.height += 1;
        restored.state.timestamp += 1;
        await saveEnvToDB(restored, { runtimeTxs: [], entityInputs: [] }, [], undefined, new Map());

        expect((await readStorageHead(historyDb))?.latestSnapshotHeight).toBe(3);
        expect(await countSnapshotBodyKeys(historyDb, 1)).toBeGreaterThan(0);
        expect(await readRawOrNull(historyDb, keySnapshotManifest(1))).toBeTruthy();
        expect(await countSnapshotBodyKeys(historyDb, 2)).toBe(0);
        expect(await readRawOrNull(historyDb, keySnapshotManifest(2))).toBeNull();
      } finally {
        await closeRuntimeDb(restored);
        await closeInfraDb(restored);
      }
    }, 30_000);
  }

  test('rebuilds a completely deleted current cache from published history', async () => {
    const dbRoot = dbRootPath;
    mkdirSync(dbRoot, { recursive: true });
    const boundary: StoragePersistenceBoundary = 'after-snapshot-current-head';
    const seed = `storage cache rebuild ${process.pid} deterministic seed`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    namespaces.push({ dbRoot, runtimeId });
    cleanupRuntimeStorage(dbRoot, runtimeId);

    const child = Bun.spawn({
      cmd: [process.execPath, fixture, seed, boundary],
      cwd: join(import.meta.dir, '..', '..', '..', '..'),
      env: { ...process.env, XLN_DB_PATH: dbRoot },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(137);
    expect(child.signalCode, stderr).toBe('SIGKILL');
    rmSync(`${join(dbRoot, runtimeId)}-storage-current`, { recursive: true, force: true });

    const restored = await loadEnvFromDB(runtimeId, seed);
    if (!restored) throw new Error('deleted-cache fixture did not restore from history');
    try {
      const historyDb = getRuntimeWalDb(restored);
      const currentDb = getRuntimeStorageDb(restored);
      const recovery = await recoverStorageDbFromHistory({ db: currentDb, walDb: historyDb, config });
      expect(recovery.recovered).toBe(true);
      expect(await readStorageHead(currentDb)).toEqual(await readStorageHead(historyDb));

      const entityId = generateNumberedEntityId(2).toLowerCase();
      const rebuiltState = await loadEntityStateFromStorage({
        env: restored,
        tryOpenDb: tryOpenStorageDb,
        getRuntimeDb: getRuntimeStorageDb,
        entityId,
      });
      // Shared storage materializes the certified Entity lineage, not an
      // arbitrary validator-local replica selected by Map insertion order.
      const restoredState = buildCertifiedEntityHeadPlan(restored).lookup.get(entityId)?.state;
      const expectedSharedState = restoredState ? { ...restoredState } : restoredState;
      if (expectedSharedState) {
        delete (expectedSharedState as Record<string, unknown>)[ENTITY_FRAME_EVENT_COLLECTOR];
      }
      expect(rebuiltState).toEqual(expectedSharedState);
      expect(rebuiltState
        ? resolveObserverCertifiedBoardHash(
            rebuiltState,
            getCertifiedBoardNodeStore(restored),
            entityId,
          )
        : null).toMatch(/^0x[0-9a-f]{64}$/);
      expect(await readRawOrNull(currentDb, keyLiveReplicaMeta(
        entityId,
        deriveSignerAddressSync(seed, '1').toLowerCase(),
      ))).toBeNull();
    } finally {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
  }, 30_000);

  test('rejects replica metadata mutated outside the atomic frame commit', async () => {
    const dbRoot = dbRootPath;
    mkdirSync(dbRoot, { recursive: true });
    const boundary: StoragePersistenceBoundary = 'after-snapshot-current-head';
    const seed = `storage meta digest corruption ${process.pid} deterministic seed`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    namespaces.push({ dbRoot, runtimeId });
    cleanupRuntimeStorage(dbRoot, runtimeId);

    const child = Bun.spawn({
      cmd: [process.execPath, fixture, seed, boundary],
      cwd: join(import.meta.dir, '..', '..', '..', '..'),
      env: { ...process.env, XLN_DB_PATH: dbRoot },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(137);
    expect(child.signalCode, stderr).toBe('SIGKILL');

    const signerA = deriveSignerAddressSync(seed, '1').toLowerCase();
    const signerB = deriveSignerAddressSync(seed, '2').toLowerCase();
    const entityId = generateNumberedEntityId(2).toLowerCase();
    const probe = createEmptyEnv(seed);
    probe.runtimeId = runtimeId;
    probe.dbNamespace = runtimeId;
    const historyDb = getRuntimeWalDb(probe);
    await historyDb.open();
    const key = keyLiveReplicaMeta(entityId, signerB);
    const meta = decodeBuffer<StorageReplicaMeta>(await historyDb.get(key));
    await historyDb.put(key, encodeBuffer({ ...meta, lastConsensusProgressAt: 99_999 }), { sync: true });
    await closeRuntimeDb(probe);
    await closeInfraDb(probe);

    await expect(loadEnvFromDB(runtimeId, seed)).rejects.toThrow(
      'STORAGE_VERIFY_REPLICA_META_DIGEST_MISMATCH',
    );
  }, 30_000);

  for (const corruption of ['missing', 'tampered'] as const) {
    test(`halts fresh restore on ${corruption} authoritative certified-board node`, async () => {
      const dbRoot = dbRootPath;
      mkdirSync(dbRoot, { recursive: true });
      const boundary: StoragePersistenceBoundary = 'after-snapshot-current-head';
      const seed = `storage certified board ${corruption} ${process.pid} deterministic seed`;
      const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
      namespaces.push({ dbRoot, runtimeId });
      cleanupRuntimeStorage(dbRoot, runtimeId);

      const child = Bun.spawn({
        cmd: [process.execPath, fixture, seed, boundary],
        cwd: join(import.meta.dir, '..', '..', '..', '..'),
        env: { ...process.env, XLN_DB_PATH: dbRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(exitCode, stderr).toBe(137);
      expect(child.signalCode, stderr).toBe('SIGKILL');

      const entityId = generateNumberedEntityId(2).toLowerCase();
      const probe = createEmptyEnv(seed);
      probe.runtimeId = runtimeId;
      probe.dbNamespace = runtimeId;
      const historyDb = getRuntimeWalDb(probe);
      await historyDb.open();
      const stored = await readEntityStorageLayout(
        createSnapshotEntityGraphView(historyDb, 2),
        entityId,
        keyLiveEntity(entityId),
      );
      if (!stored) throw new Error('certified-board corruption Entity graph missing');
      const core = stored.doc;
      const root = core.certifiedBoardState?.boardRegistryRoot;
      if (!root) throw new Error('certified-board corruption fixture root missing');
      const boardPrefixes = [
        keyCertifiedBoardNodePrefix(entityId),
        keySnapshotGraphPrefix(2, keyCertifiedBoardNodePrefix(entityId)),
      ];
      const rootKeys: Buffer[] = [];
      let rootRow: ReturnType<typeof validatePersistedCertifiedBoardPathNode> | undefined;
      for (const prefix of boardPrefixes) {
        for await (const key of iterateKeys(historyDb, { prefix })) {
          const row = validatePersistedCertifiedBoardPathNode(decodeBuffer(await historyDb.get(key)));
          if (row.hash === root) {
            rootKeys.push(key);
            rootRow ??= row;
          }
        }
      }
      if (rootKeys.length === 0 || !rootRow) throw new Error('certified-board corruption root row missing');
      if (corruption === 'missing') {
        for (const key of rootKeys) await historyDb.del(key, { sync: true });
      } else {
        const node: CertifiedBoardPatriciaNode = rootRow.node;
        const tampered: CertifiedBoardPatriciaNode = node.type === 'branch'
          ? { ...node, left: node.right, right: node.left }
          : {
              ...node,
              record: { ...node.record, transactionHash: `0x${'99'.repeat(32)}` },
            };
        for (const key of rootKeys) {
          await historyDb.put(key, encodeBuffer({ ...rootRow, node: tampered }), { sync: true });
        }
      }
      await closeRuntimeDb(probe);
      await closeInfraDb(probe);

      // Remove the rebuildable cache so no stale current-only node can mask an
      // authoritative history failure during the new restore attempt.
      rmSync(`${join(dbRoot, runtimeId)}-storage-current`, { recursive: true, force: true });
      await expect(loadEnvFromDB(runtimeId, seed)).rejects.toThrow(
        corruption === 'missing'
          ? /(?:CERTIFIED_BOARD_PATH_NODE_MISSING|STORAGE_VERIFY_SNAPSHOT_DOC_COUNT_MISMATCH)/
          : 'CERTIFIED_BOARD_PATH_NODE_CORRUPT',
      );
    }, 30_000);
  }
});
