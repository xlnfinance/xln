#!/usr/bin/env bun

/** Record one production TS transcript, then prove it with independent Rust W1/W4 DBs. */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeParse } from '../../../../../protocol/serialization';
import { deriveMeshChildSeed } from '../../../../../orchestrator/mesh/mesh-seeds';
import { authorityEvidenceBinary } from '../evidence/gate-support';
import { readHltHubRecording } from '../recording';

const run = (command: string, args: readonly string[], env = process.env): string => {
  const result = spawnSync(command, [...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`HLT_MIXED_PARITY_CHILD_FAILED:${command}:${String(result.status)}:${result.stderr.slice(-2_000)}`);
  }
  return result.stdout;
};

const recordOutput = run(process.execPath, [
  'core/scripts/operations/hlt/replay/commands/run-authority-evidence-record.ts',
]);
const match = /HLT_RUNTIME_REPLAY_V1 path=([^\s]+)/.exec(recordOutput);
if (!match?.[1]) throw new Error('HLT_MIXED_PARITY_RECORDING_PATH_MISSING');
const recordingPath = match[1];
const artifact = readHltHubRecording(recordingPath);
if (artifact.source.engine !== 'ts') throw new Error('HLT_MIXED_PARITY_SOURCE_NOT_TS');
const meshRoot = readFileSync(join(artifact.source.workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
if (!meshRoot) throw new Error('HLT_MIXED_PARITY_MESH_SEED_MISSING');
const runtimeSeedPath = join(artifact.source.workDir, 'h1-runtime.seed');
writeFileSync(runtimeSeedPath, `${deriveMeshChildSeed(meshRoot, 'runtime:h1')}\n`, { mode: 0o600 });
const wal = join(artifact.source.workDir, 'prod-mesh', 'h1', `${artifact.tail.runtimeId}-wal`);
const binary = authorityEvidenceBinary();

const replay = (workers: 1 | 4): Record<string, unknown> => {
  const output = run(binary, [
    'runtime-replay',
    '--wal', wal,
    '--recording', recordingPath,
    '--runtime-seed-file', runtimeSeedPath,
    '--runtime-signer-label', '1',
    '--entity-signer-label', 'h1-hub',
    '--native-db', join(artifact.source.workDir, `runtime-replay-w${workers}`),
    '--workers', String(workers),
  ]);
  const line = output.trim().split('\n').at(-1);
  return safeParse(line ?? '') as Record<string, unknown>;
};

const w1 = replay(1);
const w4 = replay(4);
const frames = artifact.totals.runtimeFrames;
for (const [label, report] of [['w1', w1], ['w4', w4]] as const) {
  for (const field of [
    'frames', 'effectDigestsCompared', 'eventDigestsCompared',
    'outboxDigestsCompared', 'postStateHashesCompared',
  ]) {
    if (report[field] !== frames) throw new Error(`HLT_MIXED_PARITY_COUNTER:${label}:${field}:${String(report[field])}:${frames}`);
  }
  if (report['runtimeRootsCompared'] !== frames + 1) {
    throw new Error(`HLT_MIXED_PARITY_RUNTIME_ROOTS:${label}:${String(report['runtimeRootsCompared'])}:${frames + 1}`);
  }
}
for (const field of ['frames', 'ingress', 'egress', 'directPayments', 'accountsRoot'] as const) {
  if (w1[field] !== w4[field]) throw new Error(`HLT_MIXED_PARITY_W1_W4:${field}:${String(w1[field])}:${String(w4[field])}`);
}
console.log(`HLT_MIXED_TS_RUST_PARITY_OK recording=${recordingPath} frames=${frames} accountsRoot=${String(w1['accountsRoot'])}`);
