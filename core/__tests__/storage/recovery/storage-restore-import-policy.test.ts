import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';

import {
  buildPersistedRuntimeRecording,
  importRuntimeRecoveryRecording,
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeWalDb,
  loadEnvFromDB,
  persistRestoredEnvToDB,
  processRuntime,
  readPersistedRuntimeActivityJournal,
  readPersistedFrameJournal,
  registerSignerKey,
} from '../../../runtime';
import { computeCanonicalRuntimeStateHash, computeCanonicalStateHashFromEnv } from '../../../storage/canonical-hash';
import { replaceRestoredStorageBase } from '../../../storage/database/restore-import';
import { STORAGE_SCHEMA_VERSION } from '../../../storage/keys';
import { verifyStorageTailIntegrity } from '../../../storage/read/verify';
import { buildStorageRuntimeMachineSnapshot } from '../../../storage/wal/snapshot';
import { MemoryRuntimeDb } from '../../fixtures/storage/memory-runtime-db';
import { createCheckpointBarrierRuntimeTx } from '../../../runtime/checkpoint/barrier';
import { readRuntimeActivityViewStatus, resetRuntimeActivityViewAtFloor } from '../../../storage/history/runtime-activity-view';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  clearSignerKeys,
} from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { readStorageFrameRecord, readStorageHead } from '../../../storage';
import { resolveDbPath } from '../../../storage/runtime-dbs';
import type { EntityReplica, JurisdictionConfig } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';

type RecoveryEnv = { env: RuntimeReplica; entityId: string; signerId: string; replica: EntityReplica };
const cleanupPaths: string[] = [];

const cleanup = (base: string): void => {
  for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-history-views', '-events', '-infra']) {
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
    storage: {
      ...env.runtimeConfig?.storage,
      enabled: saveDuringProcess,
      ...(saveDuringProcess ? { canonicalHashPeriodFrames: 1 } : {}),
    },
  };
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, {
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
    runtimeTxs: [createTestEntityImportRuntimeTx(env, {
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
    })],
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
  const replica = Array.from(env.state.eReplicas.values())[0];
  if (!replica) throw new Error('restore import policy replica missing');
  return { env, entityId, signerId, replica };
};

const closeRecoveryEnv = async (env: RuntimeReplica): Promise<void> => {
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
    expect(restored.state.height).toBe(expected.height);
    const replica = Array.from(restored.state.eReplicas.values())[0];
    expect(replica?.lastConsensusProgressAt).toBe(expected.progress);
    expect(replica?.state.profile.name).toBe(expected.profileName);
  } finally {
    await closeRecoveryEnv(restored);
  }
};

describe('restored checkpoint conflict policy', () => {
  test('atomic recording import preserves checkpoint and verified tail through reopening', async () => {
    const seed = `restore recorded tail ${process.pid} deterministic seed`;
    const source = await createRecoveryEnv(seed, true, 'recorded-profile', 'source');
    cleanupPaths.push(resolveDbPath(source.env, 'core'));
    const recording = await buildPersistedRuntimeRecording(source.env, {
      signers: [{ index: 0, derivationIndex: 0, address: source.signerId, name: 'Signer' }],
    });
    const tail = recording.bundles.find(bundle => bundle.kind === 'journal_tail');
    expect(tail?.frames?.length).toBeGreaterThan(0);
    const expectedHash = computeCanonicalStateHashFromEnv(source.env);
    clearSignerKeys(seed);
    const restored = await importRuntimeRecoveryRecording(recording, seed);
    cleanupPaths.push(resolveDbPath(restored, 'core'));
    try {
      expect(computeCanonicalStateHashFromEnv(restored)).toBe(expectedHash);
      expect(await readRuntimeActivityViewStatus(restored)).toMatchObject({
        latestHeight: recording.targetHeight,
        unavailableThroughHeight: recording.targetHeight,
      });
    } finally {
      await closeRecoveryEnv(restored);
      await closeRecoveryEnv(source.env);
    }
    // A disposable activity index cannot serve as the recovery authority.
    rmSync(`${resolveDbPath(restored, 'core')}-history-views`, { recursive: true, force: true });
    const reopened = await loadEnvFromDB(source.signerId, seed);
    expect(reopened).toBeTruthy();
    let checkpointHash = '';
    try {
      expect(computeCanonicalStateHashFromEnv(reopened!)).toBe(expectedHash);
      const journal = await readPersistedFrameJournal(reopened!, recording.targetHeight);
      expect(journal!.runtimeInput).toEqual(tail!.frames!.at(-1)!.runtimeInput);
      expect(await readPersistedRuntimeActivityJournal(reopened!, recording.targetHeight)).toBeTruthy();
      enqueueRuntimeInput(reopened!, { runtimeTxs: [createCheckpointBarrierRuntimeTx()], entityInputs: [] });
      await processRuntime(reopened!);
      expect(reopened!.state.height).toBe(recording.targetHeight + 1);
      expect([...reopened!.state.eReplicas.values()][0]!.state.profile.name).toBe('recorded-profile');
      checkpointHash = computeCanonicalStateHashFromEnv(reopened!);
    } finally {
      await closeRecoveryEnv(reopened!);
    }
    const materialized = await loadEnvFromDB(source.signerId, seed);
    expect(computeCanonicalStateHashFromEnv(materialized!)).toBe(checkpointHash);
    await closeRecoveryEnv(materialized!);
    await expect(importRuntimeRecoveryRecording(recording, seed)).rejects.toThrow('RECOVERY_IMPORT_DESTINATION_NOT_EMPTY');
  });

  test.each(['before-publish', 'after-publish'] as const)('recording interruption at %s exposes no partial tip', async boundary => {
    const seed = `restore publication ${boundary} ${process.pid}`;
    const source = await createRecoveryEnv(seed, true, 'complete-archive', 'source');
    const target = createEmptyEnv(seed);
    cleanupPaths.push(resolveDbPath(source.env, 'core'), resolveDbPath(target, 'core'));
    const recording = await buildPersistedRuntimeRecording(source.env, {
      signers: [{ index: 0, address: source.signerId, name: 'Signer' }],
    });
    const expectedHash = computeCanonicalStateHashFromEnv(source.env);
    await expect(importRuntimeRecoveryRecording(recording, seed, {
      onPublicationBoundary: point => { if (point === boundary) throw new Error(`INTERRUPTED:${point}`); },
    })).rejects.toThrow(`INTERRUPTED:${boundary}`);
    await closeRecoveryEnv(source.env);
    const reopened = await loadEnvFromDB(source.signerId, seed);
    if (boundary === 'before-publish') expect(reopened).toBeNull();
    else {
      expect(reopened!.state.height).toBe(recording.targetHeight);
      expect(computeCanonicalStateHashFromEnv(reopened!)).toBe(expectedHash);
      await closeRecoveryEnv(reopened!);
    }
  });

  test('recording import rejects leftover activity on an otherwise empty destination', async () => {
    const seed = `restore stale activity ${process.pid}`;
    const source = await createRecoveryEnv(seed, true, 'complete-archive', 'source');
    const target = createEmptyEnv(seed);
    cleanupPaths.push(resolveDbPath(source.env, 'core'), resolveDbPath(target, 'core'));
    await resetRuntimeActivityViewAtFloor(target, 1);
    await closeRecoveryEnv(target);
    const recording = await buildPersistedRuntimeRecording(source.env, {
      signers: [{ index: 0, address: source.signerId, name: 'Signer' }],
    });
    await expect(importRuntimeRecoveryRecording(recording, seed)).rejects.toThrow('RECOVERY_IMPORT_ACTIVITY_NOT_EMPTY');
    await closeRecoveryEnv(source.env);
    expect(await loadEnvFromDB(source.signerId, seed)).toBeNull();
  });

  test('atomically advances an older complete recovery base', async () => {
    const seed = `restore advance ${process.pid} deterministic seed`;
    const base = await createRecoveryEnv(seed);
    cleanupPaths.push(resolveDbPath(base.env, 'core'));
    base.env.state.timestamp = 1_000;
    base.replica.lastConsensusProgressAt = 1_111;
    await persistRestoredEnvToDB(base.env);
    expect(await readRuntimeActivityViewStatus(base.env)).toMatchObject({
      latestHeight: 1,
      unavailableThroughHeight: 1,
    });
    await expect(readPersistedRuntimeActivityJournal(base.env, 1)).rejects.toThrow(
      'RUNTIME_ACTIVITY_VIEW_UNAVAILABLE:height=1:through=1',
    );
    await closeRecoveryEnv(base.env);

    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const restored = await loadEnvFromDB(runtimeId, seed);
    if (!restored) throw new Error('restore advance lost initial recovery base');
    restored.runtimeConfig = {
      ...restored.runtimeConfig,
      storage: { ...restored.runtimeConfig?.storage, enabled: false },
    };
    registerSignerKey(restored, base.signerId, deriveSignerKeySync(seed, '1'));
    enqueueRuntimeInput(restored, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: base.entityId,
        signerId: base.signerId,
        entityTxs: [{
          type: 'profile-update',
          data: { profile: { entityId: base.entityId, name: 'advanced-base' } },
        }],
      }],
    });
    await processRuntime(restored, []);
    const advancedReplica = Array.from(restored.state.eReplicas.values())[0];
    if (!advancedReplica) throw new Error('restore advance replica missing');
    advancedReplica.lastConsensusProgressAt = 2_222;
    await persistRestoredEnvToDB(restored);
    expect(await readPersistedRuntimeActivityJournal(restored, 1)).toBeNull();
    await expect(readPersistedRuntimeActivityJournal(restored, 2)).rejects.toThrow(
      'RUNTIME_ACTIVITY_VIEW_UNAVAILABLE:height=2:through=2',
    );
    await closeRecoveryEnv(restored);

    await assertFreshState(seed, { height: 2, progress: 2_222, profileName: 'advanced-base' });
  });

  test('rejects lower-height rollback and preserves the higher base', async () => {
    const seed = `restore rollback ${process.pid} deterministic seed`;
    const base = await createRecoveryEnv(seed, false, 'higher-base');
    cleanupPaths.push(resolveDbPath(base.env, 'core'));
    base.env.state.timestamp = 2_000;
    base.replica.lastConsensusProgressAt = 2_222;
    await persistRestoredEnvToDB(base.env);
    await closeRecoveryEnv(base.env);

    const stale = await createRecoveryEnv(seed);
    stale.env.state.timestamp = 1_000;
    stale.replica.lastConsensusProgressAt = 1_111;
    await expect(persistRestoredEnvToDB(stale.env)).rejects.toThrow('RECOVERY_IMPORT_ROLLBACK_REJECTED');
    await closeRecoveryEnv(stale.env);
    await assertFreshState(seed, { height: 2, progress: 2_222, profileName: 'higher-base' });
  });

  test('rejects conflicting same-height truth and preserves forensic history', async () => {
    const seed = `restore same height conflict ${process.pid} deterministic seed`;
    const base = await createRecoveryEnv(seed, false, 'candidate-A');
    cleanupPaths.push(resolveDbPath(base.env, 'core'));
    base.env.state.timestamp = 2_000;
    base.replica.lastConsensusProgressAt = 2_222;
    await persistRestoredEnvToDB(base.env);
    await closeRecoveryEnv(base.env);

    const conflicting = await createRecoveryEnv(seed, false, 'candidate-B');
    conflicting.env.state.timestamp = 2_000;
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
    base.env.state.timestamp = 1_000;
    base.replica.lastConsensusProgressAt = 1_111;
    await persistRestoredEnvToDB(base.env);

    const fork = await createRecoveryEnv(seed, false, 'validator-conflict', 'validator-fork');
    cleanupPaths.push(resolveDbPath(fork.env, 'core'));
    // Preserve the exact persistent graph roots; only validator-local identity
    // differs for this divergence fixture.
    const conflicting = { ...fork.replica };
    conflicting.signerId = deriveSignerAddressSync(seed, '2').toLowerCase();
    base.env.state.eReplicas.set(`${base.entityId}:${conflicting.signerId}`, conflicting);
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
    const before = await readStorageFrameRecord(getRuntimeWalDb(current.env), current.env.state.height);
    expect(before?.canonicalStateHash).toBeString();
    await persistRestoredEnvToDB(current.env);
    const after = await readStorageFrameRecord(getRuntimeWalDb(current.env), current.env.state.height);
    expect(after?.frameHash).toBe(before?.frameHash);
    await closeRecoveryEnv(current.env);
  });

  test('a committed profile kind and sectors survive a restart', async () => {
    // profile-update commits entityKind and sectors (consensus state, also in
    // the Rust EntityProfile), but the Entity document schema accepted only
    // name/isHub/avatar/bio/website, so the next restart refused the document.
    const seed = `restore profile kind ${process.pid} deterministic seed`;
    const current = await createRecoveryEnv(seed, true);
    cleanupPaths.push(resolveDbPath(current.env, 'core'));
    enqueueRuntimeInput(current.env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: current.entityId,
        signerId: current.signerId,
        entityTxs: [{
          type: 'profile-update',
          data: { profile: { entityId: current.entityId, entityKind: 'company', sectors: ['commerce', 'finance'] } },
        }],
      }],
    });
    await processRuntime(current.env, []);
    enqueueRuntimeInput(current.env, { runtimeTxs: [createCheckpointBarrierRuntimeTx()], entityInputs: [] });
    await processRuntime(current.env, []);
    await closeRecoveryEnv(current.env);
    const restored = await loadEnvFromDB(current.signerId, seed);
    if (!restored) throw new Error('restore profile kind lost authoritative state');
    try {
      expect(Array.from(restored.state.eReplicas.values())[0]?.state.profile)
        .toMatchObject({ entityKind: 'company', sectors: ['commerce', 'finance'] });
    } finally {
      await closeRecoveryEnv(restored);
    }
  });

  test('a new base that fails verification never replaces the previous WAL', async () => {
    // The swap deleted every WAL key and wrote the new base before verifying
    // it, so a failed check left the device with no loadable WAL.
    const db = new MemoryRuntimeDb();
    const seed = `restore verify before swap ${process.pid} deterministic seed`;
    const base = (height: number, canonicalStateHash: string) => ({
      currentDb: new MemoryRuntimeDb(), walDb: db, height, timestamp: height * 1_000,
      docs: [], replicaMetas: [], canonicalEntityHashes: [], canonicalStateHash,
      headConfig: {
        schemaVersion: STORAGE_SCHEMA_VERSION, snapshotPeriodFrames: 100, retainSnapshots: 1,
        epochMaxBytes: Number.MAX_SAFE_INTEGER, accountMerkleRadix: 16 as const,
      },
      runtimeMachine: buildStorageRuntimeMachineSnapshot(createEmptyEnv(seed)),
      runtimeOutputs: [], certifiedBoardNodes: [], accountJClaimNodes: [],
    });
    await replaceRestoredStorageBase(base(1, computeCanonicalRuntimeStateHash(1, 1_000, [])));
    await expect(replaceRestoredStorageBase(base(2, `0x${'99'.repeat(32)}`)))
      .rejects.toThrow('STORAGE_VERIFY_SNAPSHOT_CANONICAL_HASH_MISMATCH');
    expect(await readStorageHead(db)).toMatchObject({ latestHeight: 1, latestSnapshotHeight: 1 });
    expect(await verifyStorageTailIntegrity(db)).toMatchObject({ latestHeight: 1 });
  });

  test('rejects non-canonical height and timestamp before persistence mutation', async () => {
    const seed = `restore position validation ${process.pid} deterministic seed`;
    const current = await createRecoveryEnv(seed, false, 'valid-base');
    cleanupPaths.push(resolveDbPath(current.env, 'core'));
    current.env.state.timestamp = 1_000;
    current.replica.lastConsensusProgressAt = 1_111;
    await persistRestoredEnvToDB(current.env);
    for (const invalidHeight of [0, -1, 1.9, Number.NaN]) {
      current.env.state.height = invalidHeight;
      await expect(persistRestoredEnvToDB(current.env)).rejects.toThrow('RECOVERY_PERSIST_HEIGHT_REQUIRED');
    }
    current.env.state.height = 2;
    for (const invalidTimestamp of [-1, 1.9, Number.NaN]) {
      current.env.state.timestamp = invalidTimestamp;
      await expect(persistRestoredEnvToDB(current.env)).rejects.toThrow('RECOVERY_PERSIST_TIMESTAMP_INVALID');
    }
    await closeRecoveryEnv(current.env);
    await assertFreshState(seed, { height: 2, progress: 1_111, profileName: 'valid-base' });
  });
});
