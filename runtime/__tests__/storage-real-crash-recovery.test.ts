import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  getFrameDb,
  getRuntimeStorageDb,
  loadEnvFromDB,
  saveEnvToDB,
  tryOpenStorageDb,
} from '../runtime';
import { deriveSignerAddressSync } from '../account/crypto';
import { deriveLocalEntityCryptoKeys } from '../entity/crypto';
import { getEntityLeaderState } from '../entity/consensus/leader';
import { buildJPrefixCertificate } from '../jurisdiction/j-prefix-consensus';
import { generateNumberedEntityId } from '../entity/factory';
import { verifyHankoForHash } from '../hanko/signing';
import {
  collectReachableCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../jurisdiction/board-registry';
import type { CertifiedBoardPatriciaNode } from '../types/entity-board-registry';
import { dbRootPath } from '../machine/platform';
import { computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';
import { buildCertifiedEntityLineagePlan } from '../storage/entity-lineage';
import {
  readStorageHead,
  readStorageFrameRecord,
  loadEntityStateFromStorage,
  recoverStorageDbFromHistory,
  type StoragePersistenceBoundary,
} from '../storage';
import { decodeBuffer, encodeBuffer } from '../storage/codec';
import { createSnapshot } from '../storage/lifecycle';
import { iterateKeys, readRawOrNull } from '../storage/level';
import {
  KEY_HEAD,
  keyCertifiedBoardNode,
  keyLiveReplicaMeta,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntity,
  keySnapshotEntityPrefix,
  keySnapshotManifest,
  keySnapshotReplicaMetaPrefix,
} from '../storage/keys';
import type {
  StorageEntityCoreDoc,
  StorageReplicaMeta,
  StorageRuntimeConfig,
} from '../storage/types';

const fixture = join(import.meta.dir, 'fixtures/storage-crash-boundary-child.ts');
const namespaces: Array<{ dbRoot: string; runtimeId: string }> = [];
const config: Required<StorageRuntimeConfig> = {
  enabled: true,
  snapshotPeriodFrames: 1,
  retainSnapshots: 1,
  epochMaxBytes: 1_000_000_000,
  frameDbMaxBytes: 1,
  frameDbRetainFrames: 1,
  materializePeriodFrames: 1_000,
  canonicalHashPeriodFrames: 1,
  accountMerkleRadix: 16,
};

const cleanupRuntimeStorage = (dbRoot: string, runtimeId: string): void => {
  const namespacePath = join(dbRoot, runtimeId);
  rmSync(namespacePath, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
  rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
  rmSync(`${namespacePath}-events`, { recursive: true, force: true });
  rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
};

const countSnapshotBodyKeys = async (db: ReturnType<typeof getFrameDb>, height: number): Promise<number> => {
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
  test('recovery import retains board DAG nodes needed only by a lagging replica root', async () => {
    const dbRoot = dbRootPath;
    mkdirSync(dbRoot, { recursive: true });
    const seed = `storage recovery board root lag ${process.pid} deterministic seed`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    namespaces.push({ dbRoot, runtimeId });
    cleanupRuntimeStorage(dbRoot, runtimeId);

    const child = Bun.spawn({
      cmd: [process.execPath, fixture, seed, 'restore-certified-board-root-lag'],
      cwd: join(import.meta.dir, '..', '..'),
      env: { ...process.env, XLN_DB_PATH: dbRoot },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

    const restored = await loadEnvFromDB(runtimeId, seed);
    if (!restored) throw new Error('board-root lag fixture did not restore');
    try {
      const roots = Array.from(restored.eReplicas.values(), (replica) => (
        replica.state.certifiedBoardState?.boardRegistryRoot
      )).filter((root): root is string => Boolean(root));
      expect(new Set(roots).size).toBe(2);
      const reachable = collectReachableCertifiedBoardNodes(
        getCertifiedBoardNodeStore(restored),
        roots,
      );
      expect(reachable.size).toBeGreaterThan(0);
    } finally {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
  }, 30_000);

  test('recovery import materializes the highest certified replica independent of Map order', async () => {
    const dbRoot = dbRootPath;
    mkdirSync(dbRoot, { recursive: true });
    const seed = `storage recovery certified lag ${process.pid} deterministic seed`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    namespaces.push({ dbRoot, runtimeId });
    cleanupRuntimeStorage(dbRoot, runtimeId);

    const child = Bun.spawn({
      cmd: [process.execPath, fixture, seed, 'restore-certified-lineage-lag'],
      cwd: join(import.meta.dir, '..', '..'),
      env: { ...process.env, XLN_DB_PATH: dbRoot },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

    const restored = await loadEnvFromDB(runtimeId, seed);
    if (!restored) throw new Error('recovery lag fixture did not restore');
    try {
      const entityId = generateNumberedEntityId(2).toLowerCase();
      const selected = buildCertifiedEntityLineagePlan(restored).lookup.get(entityId)?.state;
      expect(selected?.height).toBe(1);
      expect(selected?.prevFrameHash).toMatch(/^0x[0-9a-f]{64}$/);
    } finally {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
  }, 30_000);

  for (const boundary of [
    'after-authoritative-history-commit',
    'after-current-cache-commit',
    'after-frame-db-prune',
    'after-snapshot-body-batch',
    'after-snapshot-manifest',
    'after-snapshot-history-publish',
    'after-snapshot-retention-prune',
    'after-replay-prune',
    'after-snapshot-history-head',
    'after-snapshot-current-head',
  ] satisfies StoragePersistenceBoundary[]) {
    test(`restores exact replica progress after SIGKILL ${boundary}`, async () => {
      const dbRoot = dbRootPath;
      mkdirSync(dbRoot, { recursive: true });
      const seed = `storage real crash ${process.pid} ${boundary} deterministic seed`;
      const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
      namespaces.push({ dbRoot, runtimeId });
      cleanupRuntimeStorage(dbRoot, runtimeId);

      const child = Bun.spawn({
        cmd: [process.execPath, fixture, seed, boundary],
        cwd: join(import.meta.dir, '..', '..'),
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
        expect(restored.height).toBe(2);
        const signerA = deriveSignerAddressSync(seed, '1').toLowerCase();
        const signerB = deriveSignerAddressSync(seed, '2').toLowerCase();
        const entityId = generateNumberedEntityId(2).toLowerCase();
        const expectedKeysA = deriveLocalEntityCryptoKeys(restored, entityId, signerA);
        const expectedKeysB = deriveLocalEntityCryptoKeys(restored, entityId, signerB);
        const replica = Array.from(restored.eReplicas.values()).find((candidate) => (
          candidate.entityId === entityId && candidate.signerId === signerB
        ));
        expect(replica?.state.height).toBe(0);
        expect(replica?.state.messages).toEqual([]);
        expect(replica?.state.entityEncPubKey).toBe(expectedKeysB.publicKey);
        expect(replica?.state.entityEncPrivKey).toBe(expectedKeysB.privateKey);
        expect(replica?.state.htlcNotes).toEqual(new Map([
          [`lock:0x${'ef'.repeat(32)}`, `private-note:${signerB}`],
        ]));
        expect(replica?.state.leaderState).toBeUndefined();
        expect(replica?.certifiedFrameLineage ?? []).toHaveLength(0);
        expect(replica?.certifiedFrameAnchor?.height).toBe(0);
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
        expect(replica?.jPrefixRound?.targetEntityHeight).toBe(1);
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
          blockHashes: new Map(Array.from({ length: 7 }, (_, index) => {
            const height = index + 1;
            return [
              height,
              height === 7
                ? `0x${'ab'.repeat(32)}`
                : `0x${height.toString(16).padStart(2, '0').repeat(32)}`,
            ];
          })),
        });

        const submitReplica = Array.from(restored.eReplicas.values()).find((candidate) => (
          candidate.entityId === entityId && candidate.signerId === signerA
        ));
        expect(submitReplica?.state.height).toBe(1);
        // Checkpointing retains full lineage by default (pruning is a
        // separate, explicit operator action) — this replica committed one
        // frame since genesis, so that one certified link survives restore.
        expect(submitReplica?.certifiedFrameLineage ?? []).toHaveLength(1);
        expect(submitReplica?.certifiedFrameAnchor?.height).toBe(1);
        expect(submitReplica?.certifiedFrameAnchor?.runtimeCheckpoint)
          .toEqual(replica?.certifiedFrameAnchor?.runtimeCheckpoint);
        expect(submitReplica?.state.messages).toEqual([
          '🔐 BOARD AUTHORITY: FoundationBootstrapped | Block 1',
          '🔐 BOARD AUTHORITY: EntityRegistered | Block 2',
          '📊 RESERVE: USDC = 0.0001 | Block 3 | Tx 0x23232323...',
          '📦 Queued R→R: 7 token 1 to cdcd (use jBroadcast to commit)',
          '📤 Batch (1 ops) → hashesToSign [nonce=1]',
          'certified-height-one',
        ]);
        expect(submitReplica?.state.entityEncPubKey).toBe(expectedKeysA.publicKey);
        expect(submitReplica?.state.entityEncPrivKey).toBe(expectedKeysA.privateKey);
        expect(submitReplica?.state.htlcNotes).toEqual(new Map([
          [`lock:0x${'ef'.repeat(32)}`, `private-note:${signerA}`],
        ]));
        expect(expectedKeysA).not.toEqual(expectedKeysB);
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
        expect(restored.runtimeState?.pendingCommittedJOutbox).toHaveLength(1);
        const pendingBatch = restored.runtimeState?.pendingCommittedJOutbox?.[0]?.jTxs[0];
        expect(pendingBatch?.type).toBe('batch');
        expect(pendingBatch?.type === 'batch' ? pendingBatch.data.runtimeSubmitAttempt : undefined)
          .toMatchObject({
            attemptNumber: 1,
            attemptedAt: submitReplica?.jSubmitState?.lastSubmittedAt,
          });

        const historyDb = getFrameDb(restored);
        const currentDb = getRuntimeStorageDb(restored);
        const historyHead = await readStorageHead(historyDb);
        expect(historyHead?.latestHeight).toBe(2);
        const frame = await readStorageFrameRecord(historyDb, 2);
        expect(frame?.canonicalStateHash).toBe(computeCanonicalStateHashFromEnv(restored));
        await recoverStorageDbFromHistory({ db: currentDb, historyDb, config });
        expect(await readStorageHead(currentDb)).toEqual(historyHead);
        expect(await readRawOrNull(currentDb, keyLiveReplicaMeta(entityId, signerB))).toBeNull();
        expect(await readRawOrNull(currentDb, keyLiveReplicaMeta(entityId, signerA))).toBeNull();
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
      cwd: join(import.meta.dir, '..', '..'),
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
      const historyDb = getFrameDb(restored);
      const currentDb = getRuntimeStorageDb(restored);
      const head = await readStorageHead(historyDb);
      if (!head) throw new Error('published orphan corruption head missing');
      expect(await countSnapshotBodyKeys(historyDb, 2)).toBeGreaterThan(0);
      expect(await readRawOrNull(historyDb, keySnapshotManifest(2))).toBeNull();
      await historyDb.put(KEY_HEAD, encodeBuffer({ ...head, latestSnapshotHeight: 2 }));

      await expect(createSnapshot(currentDb, historyDb, 3, restored.timestamp + 1))
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
        cwd: join(import.meta.dir, '..', '..'),
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
        const historyDb = getFrameDb(restored);
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
        restored.height += 1;
        restored.timestamp += 1;
        await saveEnvToDB(restored, { runtimeTxs: [], entityInputs: [] }, []);

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
      cwd: join(import.meta.dir, '..', '..'),
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
      const historyDb = getFrameDb(restored);
      const currentDb = getRuntimeStorageDb(restored);
      const recovery = await recoverStorageDbFromHistory({ db: currentDb, historyDb, config });
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
      const restoredState = buildCertifiedEntityLineagePlan(restored).lookup.get(entityId)?.state;
      const expectedSharedState = restoredState ? { ...restoredState } : restoredState;
      if (expectedSharedState) {
        expectedSharedState.entityEncPubKey = '';
        expectedSharedState.entityEncPrivKey = '';
        delete expectedSharedState.htlcNotes;
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
      cwd: join(import.meta.dir, '..', '..'),
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
    const historyDb = getFrameDb(probe);
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
        cwd: join(import.meta.dir, '..', '..'),
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
      const historyDb = getFrameDb(probe);
      await historyDb.open();
      const core = decodeBuffer<StorageEntityCoreDoc>(await historyDb.get(keySnapshotEntity(2, entityId)));
      const root = core.certifiedBoardState?.boardRegistryRoot;
      if (!root) throw new Error('certified-board corruption fixture root missing');
      const rootKey = keyCertifiedBoardNode(root);
      if (corruption === 'missing') {
        await historyDb.del(rootKey, { sync: true });
      } else {
        const node = decodeBuffer<CertifiedBoardPatriciaNode>(await historyDb.get(rootKey));
        const tampered: CertifiedBoardPatriciaNode = node.type === 'branch'
          ? { ...node, left: node.right, right: node.left }
          : {
              ...node,
              record: { ...node.record, transactionHash: `0x${'99'.repeat(32)}` },
            };
        await historyDb.put(rootKey, encodeBuffer(tampered), { sync: true });
      }
      await closeRuntimeDb(probe);
      await closeInfraDb(probe);

      // Remove the rebuildable cache so no stale current-only node can mask an
      // authoritative history failure during the new restore attempt.
      rmSync(`${join(dbRoot, runtimeId)}-storage-current`, { recursive: true, force: true });
      await expect(loadEnvFromDB(runtimeId, seed)).rejects.toThrow(
        corruption === 'missing'
          ? 'CERTIFIED_BOARD_NODE_MISSING'
          : 'CERTIFIED_BOARD_NODE_CORRUPT',
      );
    }, 30_000);
  }
});
