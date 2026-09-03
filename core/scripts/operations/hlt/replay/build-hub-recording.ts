#!/usr/bin/env bun

/** Build phase finalizer: turn the closed H1 WAL into one signed replay artifact. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { safeParse, safeStringify } from '../../../../protocol/serialization';
import type { ConcreteCheckpointSourceExport } from '../../../../storage/read/concrete-checkpoint-source';
import type { HltHubRecordingArtifact } from './recording';

const argument = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
  if (!value) throw new Error(`HLT_HUB_RECORDING_ARGUMENT_MISSING:${name}`);
  return value;
};

const positiveIntegerArgument = (name: string): number => {
  const raw = argument(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`HLT_HUB_RECORDING_ARGUMENT_INVALID:${name}:${raw}`);
  return value;
};

const workDir = resolve(argument('work-dir'));
const outputPath = resolve(argument('output'));
const snapshotPath = resolve(argument('snapshot'));
const checkpointPath = resolve(argument('checkpoint'));
const users = positiveIntegerArgument('users');
const workload = argument('workload');
const requireCompleteAuthorityEvidence = process.argv.includes('--require-complete-authority-evidence');
if (dirname(outputPath) !== workDir) {
  throw new Error(`HLT_HUB_RECORDING_OUTPUT_NOT_PORTABLE:${dirname(outputPath)}:${workDir}`);
}
if (process.env['XLN_MM_CROSS_J'] !== '0') {
  throw new Error('HLT_AUTHORITY_RECORDING_MM_CROSS_J_MUST_BE_ZERO');
}
// Runtime DB paths are module constants. Set the exact H1 root before loading
// any Runtime/storage module; changing process.env after an ESM import silently
// opens the default DB and makes a populated WAL look empty.
process.env['XLN_DB_PATH'] = join(workDir, 'prod-mesh', 'h1');
process.env['XLN_RDB_ROOT'] = join(workDir, 'prod-mesh', 'h1');
process.env['XLN_JURISDICTIONS_PATH'] = join(workDir, 'prod-mesh', 'jurisdictions.json');
const [meshSeeds, runtime, { deriveRuntimeIdFromSeed }, recordingApi] = await Promise.all([
  import('../../../../orchestrator/mesh/mesh-seeds'),
  import('../../../../runtime'),
  import('../../../../storage/runtime-dbs'),
  import('./recording'),
]);
const { prewarmSignerLabels } = await import('../../../../account/crypto');
const { deriveMeshChildSeed } = meshSeeds;
const {
  buildRuntimeRecording,
  buildRuntimeRecoveryBundle,
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  getPersistedLatestHeight,
  loadEnvFromStorageByReplay,
  readPersistedFrameJournals,
  readPersistedStorageFramePayloads,
  readPersistedStorageFrameRecord,
  validateRuntimeRecoveryBundle,
  verifyRuntimeChain,
} = runtime;
const {
  HLT_HUB_RECORDING_SCHEMA,
  writeHltHubRecording,
} = recordingApi;
const { summarizeHltHubFrames } = await import('./recording-wal');
const {
  buildHltAuthorityEvidence,
  assertCompleteHltAuthorityEvidence,
  assertCanonicalMixedCoverage,
} = await import('./authority-evidence');
const { HLT_AUTHORITY_CHECKPOINT_PERIOD_FRAMES } = await import('../authority-evidence-policy');
const { buildHltAuthoritySourceBinding } = await import('./source-binding');
const meshRootSeed = readFileSync(join(workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
if (!meshRootSeed) throw new Error('HLT_HUB_RECORDING_MESH_ROOT_SEED_MISSING');
const runtimeSeed = deriveMeshChildSeed(meshRootSeed, 'runtime:h1');
const runtimeId = deriveRuntimeIdFromSeed(runtimeSeed);
if (!runtimeId) throw new Error('HLT_HUB_RECORDING_RUNTIME_ID_MISSING');
// Detached replay executes the same Entity consensus transitions as the live
// H1. Its signer cache is process-local and therefore is not part of a
// recovery bundle; restore the deterministic H1 label before replaying any
// frame that may create J-prefix or Entity Hanko evidence.
prewarmSignerLabels(runtimeSeed, ['h1-hub']);
const snapshot = validateRuntimeRecoveryBundle(safeParse(readFileSync(snapshotPath, 'utf8')));
const checkpoint = safeParse(readFileSync(checkpointPath, 'utf8')) as ConcreteCheckpointSourceExport;
const baseHeight = checkpoint.height;
if (!Number.isSafeInteger(baseHeight) || baseHeight < 1 || !/^0x[0-9a-f]{64}$/.test(checkpoint.rootHash)) {
  throw new Error(`HLT_HUB_RECORDING_SNAPSHOT_BASE_INVALID:${baseHeight}`);
}
if (snapshot.kind !== 'snapshot' || snapshot.runtimeHeight !== baseHeight ||
    snapshot.runtimeId !== runtimeId || !snapshot.checkpointHash) {
  throw new Error('HLT_HUB_RECORDING_SNAPSHOT_BUNDLE_INVALID');
}

const env = createEmptyEnv(runtimeSeed);
env.runtimeId = runtimeId;
env.dbNamespace = runtimeId;
env.quietRuntimeLogs = true;

let databasesClosed = false;
try {
  const targetHeight = await getPersistedLatestHeight(env);
  if (targetHeight <= baseHeight) {
    throw new Error(`HLT_HUB_RECORDING_TAIL_EMPTY:base=${baseHeight}:target=${targetHeight}`);
  }
  const expectedFrames = targetHeight - baseHeight;
  const frames = await readPersistedFrameJournals(env, {
    fromHeight: baseHeight + 1,
    toHeight: targetHeight,
    limit: expectedFrames,
    // Replay proves these checkpoints from canonicalStateHash/postStateHash.
    // Repeating the full 1000-user Runtime machine in every materialized
    // journal frame makes a bounded 420 MB WAL expand to tens of GB in RAM.
    includeRuntimeMachine: false,
  });
  if (
    frames.length !== expectedFrames ||
    frames[0]?.height !== baseHeight + 1 ||
    frames.at(-1)?.height !== targetHeight
  ) {
    throw new Error(
      `HLT_HUB_RECORDING_JOURNAL_INCOMPLETE:base=${baseHeight}:target=${targetHeight}:` +
      `expected=${expectedFrames}:actual=${frames.length}`,
    );
  }
  const periodicCheckpointHeight = baseHeight + HLT_AUTHORITY_CHECKPOINT_PERIOD_FRAMES;
  const periodicCheckpoint = await readPersistedStorageFrameRecord(env, periodicCheckpointHeight);
  const periodicCheckpointPayloads = periodicCheckpoint?.materializedState === true
    ? await readPersistedStorageFramePayloads(env, periodicCheckpoint)
    : null;
  if (
    periodicCheckpoint?.materializedState !== true ||
    periodicCheckpoint.runtimeMachineRoot === undefined ||
    periodicCheckpointPayloads?.runtimeMachine === undefined
  ) {
    throw new Error(
      `HLT_HUB_RECORDING_PERIODIC_CHECKPOINT_MISSING:` +
      `base=${baseHeight}:expected=${periodicCheckpointHeight}:target=${targetHeight}`,
    );
  }
  env.state.height = targetHeight;
  env.state.timestamp = frames.at(-1)!.timestamp;
  const signers = [{ index: 1, address: runtimeId, name: 'H1 Runtime' }];
  const recordingCreatedAt = frames.at(-1)!.timestamp;
  const tail = buildRuntimeRecoveryBundle(env, {
    kind: 'journal_tail',
    signers,
    createdAt: recordingCreatedAt,
    // Recovery tails bind the signed portable snapshot. The concrete radix
    // checkpoint has an independent root/leaves proof and is a different hash
    // domain; overloading this field would make canonical RuntimeRecording
    // validation impossible and could mix checkpoints from different runs.
    baseCheckpoint: { height: baseHeight, hash: snapshot.checkpointHash },
    frames,
  });
  if (tail.kind !== 'journal_tail' || tail.baseRuntimeHeight === undefined ||
      tail.baseCheckpointHash === undefined) {
    throw new Error('HLT_HUB_RECORDING_TAIL_BUILD_INVALID');
  }
  const authorityEvidence = buildHltAuthorityEvidence(frames);
  if (requireCompleteAuthorityEvidence) {
    assertCompleteHltAuthorityEvidence(authorityEvidence);
    assertCanonicalMixedCoverage(frames);
  }
  // Bind only a closed WAL. Opening LevelDB may update its LOG/LOCK files;
  // hashing before close would bind bytes that no replay can later observe.
  await closeRuntimeDb(env);
  await closeInfraDb(env);
  databasesClosed = true;
  const checkpointRestartStartedAt = performance.now();
  const checkpointRestart = await loadEnvFromStorageByReplay(
    runtimeId,
    runtimeSeed,
    undefined,
    { readOnly: true },
  );
  if (!checkpointRestart) throw new Error('HLT_CHECKPOINT_RESTART_MISSING');
  const checkpointRestartMs = performance.now() - checkpointRestartStartedAt;
  const replayMeta = Reflect.get(checkpointRestart.env, '__replayMeta') as
    | Record<string, unknown>
    | undefined;
  const checkpointReplayFrames = Number(replayMeta?.['replayedFrameCount']);
  if (
    checkpointRestart.env.state.height !== targetHeight ||
    checkpointRestart.checkpointHeight !== periodicCheckpointHeight ||
    checkpointRestart.env.persistenceLastMaterializedHeight !== periodicCheckpointHeight ||
    checkpointReplayFrames !== targetHeight - periodicCheckpointHeight
  ) {
    throw new Error(
      `HLT_CHECKPOINT_RESTART_INVALID:` +
      `height=${checkpointRestart.env.state.height}:checkpoint=${checkpointRestart.checkpointHeight}:` +
      `cursor=${String(checkpointRestart.env.persistenceLastMaterializedHeight)}:` +
      `replayed=${String(checkpointReplayFrames)}`,
    );
  }
  await closeRuntimeDb(checkpointRestart.env);
  await closeInfraDb(checkpointRestart.env);
  const fullRestartStartedAt = performance.now();
  const fullRestart = await verifyRuntimeChain(runtimeId, runtimeSeed, { fromSnapshotHeight: 1 });
  const fullRestartMs = performance.now() - fullRestartStartedAt;
  if (!fullRestart.ok || fullRestart.restoredHeight !== targetHeight) {
    throw new Error(`HLT_FULL_RESTART_INVALID:${safeStringify(fullRestart)}`);
  }
  const fullReplayFrames = targetHeight - fullRestart.selectedSnapshotHeight;
  if (checkpointReplayFrames >= fullReplayFrames) {
    throw new Error(`HLT_CHECKPOINT_RESTART_NOT_BOUNDED:${checkpointReplayFrames}:${fullReplayFrames}`);
  }
  const recoveryReportPath = join(workDir, 'checkpoint-recovery-report.json');
  writeFileSync(recoveryReportPath, `${safeStringify({
    schema: 'xln-hlt-checkpoint-recovery-v1',
    runtimeId,
    targetHeight,
    checkpointHeight: periodicCheckpointHeight,
    checkpointReplayFrames,
    fullReplayFrames,
    checkpointRestartMs,
    fullRestartMs,
  }, 2)}\n`, { mode: 0o600 });
  console.log(
    `HLT_CHECKPOINT_RECOVERY_OK checkpoint=${periodicCheckpointHeight} ` +
    `checkpointFrames=${checkpointReplayFrames} fullFrames=${fullReplayFrames} ` +
    `checkpointMs=${checkpointRestartMs.toFixed(1)} fullMs=${fullRestartMs.toFixed(1)} ` +
    `report=${recoveryReportPath}`,
  );
  const walPath = join(workDir, 'prod-mesh', 'h1', `${runtimeId}-wal`);
  const binding = await buildHltAuthoritySourceBinding(walPath, runtimeSeed);
  const totals = summarizeHltHubFrames(frames);
  const runtimeRecordingManifestHash = buildRuntimeRecording(
    [snapshot, tail],
    recordingCreatedAt,
  ).manifestHash;
  const compactTail: HltHubRecordingArtifact['tail'] = {
    version: 1,
    kind: 'journal_tail',
    runtimeId: tail.runtimeId,
    runtimeHeight: tail.runtimeHeight,
    runtimeTimestamp: tail.runtimeTimestamp,
    createdAt: tail.createdAt,
    signers: tail.signers,
    baseRuntimeHeight: tail.baseRuntimeHeight,
    baseCheckpointHash: tail.baseCheckpointHash,
    signature: tail.signature,
    ...(tail.meta === undefined ? {} : { meta: tail.meta }),
  };
  const artifact: HltHubRecordingArtifact = {
    schema: HLT_HUB_RECORDING_SCHEMA,
    createdAt: frames.at(-1)!.timestamp,
    source: {
      engine: 'ts',
      hubWalDir: join('prod-mesh', 'h1', `${runtimeId}-wal`),
      meshSeedFile: join('secrets', 'mesh-root.seed'),
      users,
      workload,
      binding,
    },
    snapshot,
    checkpoint,
    tail: compactTail,
    totals,
    runtimeRecordingManifestHash,
    authorityEvidence,
  };
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeHltHubRecording(outputPath, artifact);
  console.log(
    `HLT_BUILD_RECORDING_OK path=${outputPath} runtime=${runtimeId} ` +
    `heights=${baseHeight}-${targetHeight} frames=${frames.length} ` +
    `periodicCheckpoint=${periodicCheckpointHeight} ` +
    `entityInputs=${totals.runtimeEntityInputs} outbox=${totals.outboxEnvelopes} ` +
    `runtimeRoots=${authorityEvidence.expectations.runtimeFrames.length}`,
  );
} finally {
  if (!databasesClosed) {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  }
}

// This one-shot finalizer imports the full Runtime composition, whose Bun
// native worker pool can keep the CLI event loop alive after every owned DB
// handle has been closed. All artifact writes above are synchronous and the
// storage handles are closed in the try/finally, so terminate only the
// successful CLI path after the final evidence line has been emitted.
process.exit(0);
