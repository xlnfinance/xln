#!/usr/bin/env bun

/** Build phase finalizer: turn the closed H1 WAL into one signed replay artifact. */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { safeParse } from '../../../../protocol/serialization';
import type { HltHubRecording } from './recording';

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
const users = positiveIntegerArgument('users');
const workload = argument('workload');
const requireCompleteAuthorityEvidence = process.argv.includes('--require-complete-authority-evidence');
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
  readPersistedFrameJournals,
  validateRuntimeRecoveryBundle,
} = runtime;
const {
  HLT_HUB_RECORDING_SCHEMA,
  summarizeHltHubFrames,
  writeHltHubRecording,
} = recordingApi;
const {
  buildHltAuthorityEvidence,
  assertCompleteHltAuthorityEvidence,
} = await import('./authority-evidence');
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
if ((snapshot.kind ?? 'snapshot') !== 'snapshot' || snapshot.runtimeId !== runtimeId) {
  throw new Error(
    `HLT_HUB_RECORDING_SNAPSHOT_IDENTITY_INVALID:expected=${runtimeId}:actual=${snapshot.runtimeId}:` +
    `kind=${String(snapshot.kind || 'snapshot')}`,
  );
}
const baseHeight = snapshot.runtimeHeight;
if (!Number.isSafeInteger(baseHeight) || baseHeight < 1 || !snapshot.checkpointHash) {
  throw new Error(`HLT_HUB_RECORDING_SNAPSHOT_BASE_INVALID:${baseHeight}`);
}

const env = createEmptyEnv(runtimeSeed);
env.runtimeId = runtimeId;
env.dbNamespace = runtimeId;
env.quietRuntimeLogs = true;

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
  env.state.height = targetHeight;
  env.state.timestamp = frames.at(-1)!.timestamp;
  const signers = [{ index: 1, address: runtimeId, name: 'H1 Runtime' }];
  const recordingCreatedAt = frames.at(-1)!.timestamp;
  const tail = buildRuntimeRecoveryBundle(env, {
    kind: 'journal_tail',
    signers,
    createdAt: recordingCreatedAt,
    baseCheckpoint: { height: baseHeight, hash: snapshot.checkpointHash },
    frames,
  });
  const recording = buildRuntimeRecording([snapshot, tail], recordingCreatedAt);
  const authorityEvidence = buildHltAuthorityEvidence(frames);
  if (requireCompleteAuthorityEvidence) assertCompleteHltAuthorityEvidence(authorityEvidence);
  const artifact: HltHubRecording = {
    schema: HLT_HUB_RECORDING_SCHEMA,
    createdAt: frames.at(-1)!.timestamp,
    source: { workDir, users, workload },
    recording,
    totals: summarizeHltHubFrames(frames),
    featurePolicy: {
      hubRebalance: 'disabled',
      crossJ: 'disabled',
      disputes: 'disabled',
      lending: 'disabled',
    },
    authorityEvidence,
  };
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeHltHubRecording(outputPath, artifact);
  console.log(
    `HLT_BUILD_RECORDING_OK path=${outputPath} runtime=${runtimeId} ` +
    `heights=${baseHeight}-${targetHeight} frames=${frames.length} ` +
    `entityInputs=${artifact.totals.runtimeEntityInputs} outbox=${artifact.totals.outboxEnvelopes} ` +
    `runtimeRoots=${authorityEvidence.expectations.runtimeFrames.length}`,
  );
} finally {
  await closeRuntimeDb(env);
  await closeInfraDb(env);
}
