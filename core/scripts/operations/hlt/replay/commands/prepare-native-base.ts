#!/usr/bin/env bun

/** Materialize one signed HLT snapshot as the frozen path-keyed Rust import base. */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { safeParse, safeStringify } from '../../../../../protocol/serialization';

const argument = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
  if (!value) throw new Error(`HLT_NATIVE_BASE_ARGUMENT_MISSING:${name}`);
  return value;
};

const workDir = resolve(argument('work-dir'));
const snapshotPath = resolve(argument('snapshot'));
const namespaceSuffix = 'rscore-native-base';
const nativeDbPath = join(workDir, 'prod-mesh', 'h1', 'rscore-native');
const nativeImporterPath = resolve('rscore/target/release/xlnrs');
const startedAt = performance.now();
const phase = (name: string): void => console.log(
  `HLT_NATIVE_BASE_PHASE phase=${name} elapsedMs=${Math.ceil(performance.now() - startedAt)}`,
);
process.env['XLN_DB_PATH'] = join(workDir, 'prod-mesh', 'h1');
process.env['XLN_RDB_ROOT'] = join(workDir, 'prod-mesh', 'h1');
process.env['XLN_JURISDICTIONS_PATH'] = join(workDir, 'prod-mesh', 'jurisdictions.json');

const [runtime, dbPaths, meshSeeds, daemon] = await Promise.all([
  import('../../../../../runtime'),
  import('../../../../../storage/runtime-dbs'),
  import('../../../../../orchestrator/mesh/mesh-seeds'),
  import('../../../../../orchestrator/daemon-control'),
]);
phase('modules-loaded');
const { importRscoreCheckpointIntoFrozenState } = await import('../import-rscore-checkpoint');
const meshRootSeed = readFileSync(join(workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
const runtimeSeed = meshSeeds.deriveMeshChildSeed(meshRootSeed, 'runtime:h1');
const runtimeId = dbPaths.deriveRuntimeIdFromSeed(runtimeSeed);
if (!runtimeId) throw new Error('HLT_NATIVE_BASE_RUNTIME_ID_MISSING');
const snapshot = runtime.validateRuntimeRecoveryBundle(safeParse(readFileSync(snapshotPath, 'utf8')));
phase('snapshot-decoded');
if (snapshot.runtimeId !== runtimeId || (snapshot.kind ?? 'snapshot') !== 'snapshot') {
  throw new Error(`HLT_NATIVE_BASE_SNAPSHOT_IDENTITY:${snapshot.runtimeId}:${runtimeId}`);
}

const adapter = runtime.openDetachedRuntimeRecording(runtime.buildRuntimeRecording([snapshot]), runtimeSeed);
const base = await adapter.readAtHeight(snapshot.runtimeHeight);
phase('snapshot-materialized');
base.dbNamespace = `${runtimeId}-${namespaceSuffix}`;
const walPath = dbPaths.resolveRuntimeWalDbPath(base);
const statePath = dbPaths.resolveStorageDbPath(base, 'current');
if (existsSync(walPath) || existsSync(statePath)) {
  throw new Error(`HLT_NATIVE_BASE_ALREADY_EXISTS:${walPath}:${statePath}`);
}
if (existsSync(nativeDbPath)) throw new Error(`HLT_NATIVE_DB_ALREADY_EXISTS:${nativeDbPath}`);
if (!existsSync(nativeImporterPath)) {
  throw new Error(`HLT_NATIVE_CHECKPOINT_IMPORTER_MISSING:${nativeImporterPath}`);
}

try {
  await runtime.persistRestoredEnvToDB(base);
  phase('ts-base-persisted');
  const [frame] = await runtime.readPersistedFrameJournals(base, {
    fromHeight: snapshot.runtimeHeight,
    toHeight: snapshot.runtimeHeight,
    limit: 1,
    includeRuntimeMachine: false,
  });
  phase('ts-base-verified');
  if (!frame || frame.height !== snapshot.runtimeHeight || frame.materializedState !== true) {
    throw new Error(`HLT_NATIVE_BASE_FRAME_INVALID:${frame?.height}:${frame?.materializedState}`);
  }
  const replicas = [...base.state.eReplicas.values()];
  if (replicas.length !== 1) throw new Error(`HLT_NATIVE_BASE_ENTITY_COUNT:${replicas.length}`);
  const identity = daemon.deriveManagedEntityIdentity({
    name: 'H1',
    seed: runtimeSeed,
    signerLabel: 'h1-hub',
  });
  const entity = replicas[0]!;
  if (entity.entityId !== identity.entityId || entity.signerId !== identity.signerId) {
    throw new Error(`HLT_NATIVE_BASE_ENTITY_IDENTITY:${entity.entityId}:${identity.entityId}`);
  }
  await runtime.closeRuntimeDb(base);
  const imported = await importRscoreCheckpointIntoFrozenState({
    mode: 'offline-pre-authority-import',
    env: base,
    entity,
    identity,
    stateDbPath: statePath,
    timestamp: base.state.timestamp,
    expectedReplicaMetaDigest: frame.replicaMetaDigest,
  });
  phase('rscore-checkpoint-imported');
  const nativeImport = spawnSync(nativeImporterPath, ['import',
    '--wal', walPath,
    '--state-db', statePath,
    '--native-db', nativeDbPath,
    '--height', String(snapshot.runtimeHeight),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (nativeImport.status !== 0) {
    throw new Error(
      `HLT_NATIVE_CHECKPOINT_IMPORT_FAILED:status=${String(nativeImport.status)}:` +
      `signal=${String(nativeImport.signal)}:${String(nativeImport.stderr).slice(-2_000)}`,
    );
  }
  phase('native-checkpoint-imported');
  console.log(safeStringify({
    runtimeId,
    height: snapshot.runtimeHeight,
    walPath,
    statePath,
    nativeDbPath,
    accounts: imported.accountCount,
    accountsRoot: imported.accountsRoot,
  }));
} finally {
  await runtime.closeRuntimeDb(base).catch(() => undefined);
  await runtime.closeInfraDb(base).catch(() => undefined);
  await adapter.close();
}
