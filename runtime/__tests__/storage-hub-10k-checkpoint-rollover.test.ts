import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { runtimeAdapterOwnerCommandLaneId } from '../radapter/command-frontier';
import { markLocalRuntimeAdapterCommandTx } from '../radapter/command-frontier-auth';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getFrameDb,
  listPersistedCheckpointHeights,
  loadEnvFromDB,
  process as processRuntime,
  readPersistedStorageHead,
  verifyRuntimeChain,
} from '../runtime';
import { readStorageFrameRecord, verifyStorageTailIntegrity } from '../storage';
import type { JurisdictionConfig } from '../types';

const FINAL_HEIGHT = 20_050;
const MATERIALIZE_PERIOD = 100;
const SNAPSHOT_PERIOD = 10_000;
const RETAIN_SNAPSHOTS = 2;
const INPUT_HASH = `0x${'42'.repeat(32)}`;

const percentile = (sorted: readonly number[], fraction: number): number => (
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
);

const cleanupRuntimeStorage = (dbRoot: string, runtimeId: string): void => {
  const namespacePath = join(dbRoot, runtimeId);
  for (const suffix of ['', '-storage-current', '-storage-previous', '-frames', '-events', '-infra']) {
    rmSync(`${namespacePath}${suffix}`, { recursive: true, force: true });
  }
  mkdirSync(dbRoot, { recursive: true });
};

test('hub persists 20k non-empty R-frames across 10k checkpoint rollover and cold replay', async () => {
  const seed = 'hub ten thousand checkpoint rollover alpha beta gamma';
  const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const runtimeId = signerId;
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const laneId = runtimeAdapterOwnerCommandLaneId(runtimeId);
  const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
  cleanupRuntimeStorage(dbRoot, runtimeId);

  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.quietRuntimeLogs = true;
  env.scenarioMode = true;
  env.runtimeConfig = {
    ...(env.runtimeConfig || {}),
    storage: {
      canonicalHashPeriodFrames: MATERIALIZE_PERIOD,
      materializePeriodFrames: MATERIALIZE_PERIOD,
      snapshotPeriodFrames: SNAPSHOT_PERIOD,
      retainSnapshots: RETAIN_SNAPSHOTS,
    },
  };
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, '1'));

  const jurisdiction: JurisdictionConfig = {
    name: 'hub-10k-checkpoint-test',
    address: 'browservm://hub-10k-checkpoint-test',
    rpcs: ['browservm://hub-10k-checkpoint-test'],
    chainId: 31_337,
    depositoryAddress: '0x000000000000000000000000000000000000dEaD',
    entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    ...jurisdiction,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: '0x000000000000000000000000000000000000ac01',
      deltaTransformer: '0x000000000000000000000000000000000000de17',
    },
  } as never);

  const frameDurations: number[] = [];
  const sparseDurations: number[] = [];
  const materializeDurations: number[] = [];
  const snapshotDurations: number[] = [];
  let peakRssBytes = process.memoryUsage.rss();
  let restored: Awaited<ReturnType<typeof loadEnvFromDB>> = null;
  let progressStartedAt = performance.now();
  try {
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          isProposer: true,
          profileName: 'H10K',
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
    expect(env.height).toBe(1);

    for (let sequence = 1; env.height < FINAL_HEIGHT; sequence += 1) {
      enqueueRuntimeInput(env, {
        runtimeTxs: [markLocalRuntimeAdapterCommandTx({
          type: 'recordRuntimeAdapterCommand',
          data: {
            laneId,
            sequence,
            commandId: `hub-10k-command:${String(sequence).padStart(8, '0')}`,
            inputHash: INPUT_HASH,
            expiresAtMs: null,
          },
        })],
        entityInputs: [],
      });
      const startedAt = performance.now();
      await processRuntime(env, []);
      const durationMs = performance.now() - startedAt;
      frameDurations.push(durationMs);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
      if (env.height % SNAPSHOT_PERIOD === 0) snapshotDurations.push(durationMs);
      else if (env.height % MATERIALIZE_PERIOD === 0) materializeDurations.push(durationMs);
      else sparseDurations.push(durationMs);
      if (env.height % 1_000 === 0) {
        const now = performance.now();
        console.log('[HUB_10K_PROGRESS]', {
          height: env.height,
          last1kMs: Math.round(now - progressStartedAt),
          rssMiB: Number((process.memoryUsage.rss() / 1024 / 1024).toFixed(1)),
        });
        progressStartedAt = now;
      }
    }

    expect(env.height).toBe(FINAL_HEIGHT);
    expect(env.runtimeState?.runtimeAdapterCommandFrontiers?.size).toBe(1);
    expect(env.runtimeState?.runtimeAdapterCommandFrontiers?.get(laneId)?.lastContiguousSequence)
      .toBe(FINAL_HEIGHT - 1);

    const db = getFrameDb(env);
    const frame19_900 = await readStorageFrameRecord(db, 19_900);
    const frame19_901 = await readStorageFrameRecord(db, 19_901);
    const frame20_000 = await readStorageFrameRecord(db, 20_000);
    const frame20_001 = await readStorageFrameRecord(db, 20_001);
    const frame20_050 = await readStorageFrameRecord(db, 20_050);
    expect(frame19_900?.materializedState).not.toBe(false);
    expect(frame19_900?.runtimeStateHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(frame19_901?.materializedState).toBe(false);
    expect(frame19_901?.runtimeStateHash).toBeUndefined();
    expect(frame19_901?.prevFrameHash).toBe(frame19_900?.frameHash);
    expect(frame20_000?.materializedState).not.toBe(false);
    expect(frame20_000?.runtimeStateHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(frame20_001?.materializedState).toBe(false);
    expect(frame20_001?.prevFrameHash).toBe(frame20_000?.frameHash);
    expect(frame20_050?.materializedState).toBe(false);
    expect(frame20_050?.runtimeStateHash).toBeUndefined();

    const head = await readPersistedStorageHead(env);
    expect(head?.latestHeight).toBe(FINAL_HEIGHT);
    expect(head?.latestMaterializedHeight).toBe(20_000);
    expect(head?.latestSnapshotHeight).toBe(20_000);
    expect(await listPersistedCheckpointHeights(env)).toEqual([10_000, 20_000]);
    const tail = await verifyStorageTailIntegrity(db);
    expect(tail.latestHeight).toBe(FINAL_HEIGHT);

    const sorted = frameDurations.toSorted((left, right) => left - right);
    const sortedSparse = sparseDurations.toSorted((left, right) => left - right);
    const sortedMaterialize = materializeDurations.toSorted((left, right) => left - right);
    const sortedSnapshot = snapshotDurations.toSorted((left, right) => left - right);
    console.log('[HUB_10K_PROFILE]', {
      frames: frameDurations.length + 1,
      totalMs: Math.round(frameDurations.reduce((sum, value) => sum + value, 0)),
      p50Ms: Number(percentile(sorted, 0.50).toFixed(2)),
      p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
      p99Ms: Number(percentile(sorted, 0.99).toFixed(2)),
      sparseP50Ms: Number(percentile(sortedSparse, 0.50).toFixed(2)),
      materializeP50Ms: Number(percentile(sortedMaterialize, 0.50).toFixed(2)),
      materializeP95Ms: Number(percentile(sortedMaterialize, 0.95).toFixed(2)),
      snapshotP50Ms: Number(percentile(sortedSnapshot, 0.50).toFixed(2)),
      snapshotP95Ms: Number(percentile(sortedSnapshot, 0.95).toFixed(2)),
      peakRssMiB: Number((peakRssBytes / 1024 / 1024).toFixed(1)),
    });

    await closeRuntimeDb(env);
    await closeInfraDb(env);
    console.log('[HUB_10K_STAGE]', { stage: 'cold-restore-head', height: FINAL_HEIGHT });
    restored = await loadEnvFromDB(runtimeId, seed);
    expect(restored?.height).toBe(FINAL_HEIGHT);
    expect(Array.from(restored?.eReplicas.values() ?? []).some(replica => replica.entityId === entityId))
      .toBe(true);
    expect(restored?.runtimeState?.runtimeAdapterCommandFrontiers?.get(laneId)?.lastContiguousSequence)
      .toBe(FINAL_HEIGHT - 1);
    await closeRuntimeDb(restored!);
    await closeInfraDb(restored!);
    restored = null;

    console.log('[HUB_10K_STAGE]', { stage: 'replay-newest-snapshot', height: 20_000 });
    const replay = await verifyRuntimeChain(runtimeId, seed, { fromSnapshotHeight: 20_000 });
    expect(replay).toMatchObject({
      ok: true,
      latestHeight: FINAL_HEIGHT,
      selectedSnapshotHeight: 20_000,
      restoredHeight: FINAL_HEIGHT,
    });
    console.log('[HUB_10K_STAGE]', { stage: 'replay-oldest-retained-snapshot', height: 10_000 });
    const retainedReplay = await verifyRuntimeChain(runtimeId, seed, { fromSnapshotHeight: 10_000 });
    expect(retainedReplay).toMatchObject({
      ok: true,
      latestHeight: FINAL_HEIGHT,
      selectedSnapshotHeight: 10_000,
      restoredHeight: FINAL_HEIGHT,
    });
  } finally {
    if (restored) {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    cleanupRuntimeStorage(dbRoot, runtimeId);
  }
}, 300_000);
