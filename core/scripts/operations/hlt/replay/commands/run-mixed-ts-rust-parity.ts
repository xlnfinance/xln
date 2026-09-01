#!/usr/bin/env bun

/** Record one production TS transcript, then prove it with independent Rust W1/W4 DBs. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { safeParse } from '../../../../../protocol/serialization';
import { deriveMeshChildSeed } from '../../../../../orchestrator/mesh/mesh-seeds';
import {
  AUTHORITY_EVIDENCE_RECORD_BUDGET_MS,
  authorityEvidenceBinary,
} from '../evidence/gate-support';
import { readHltHubRecording } from '../recording';

const run = (
  command: string,
  args: readonly string[],
  timeoutMs = 30_000,
  env = process.env,
): string => {
  const result = spawnSync(command, [...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`HLT_MIXED_PARITY_CHILD_FAILED:${command}:${String(result.status)}:${result.stderr.slice(-2_000)}`);
  }
  return result.stdout;
};

const recordingArgument = (): string | null => {
  const index = process.argv.indexOf('--recording');
  if (index < 0) return null;
  const path = String(process.argv[index + 1] ?? '').trim();
  if (!path) throw new Error('HLT_MIXED_PARITY_RECORDING_ARGUMENT_MISSING');
  return path;
};

const record = (): string => {
  const output = run(process.execPath, [
    'core/scripts/operations/hlt/replay/commands/run-authority-evidence-record.ts',
  ], AUTHORITY_EVIDENCE_RECORD_BUDGET_MS);
  const match = /HLT_RUNTIME_REPLAY_V1 path=([^\s]+)/.exec(output);
  if (!match?.[1]) throw new Error('HLT_MIXED_PARITY_RECORDING_PATH_MISSING');
  return match[1];
};

// A supplied immutable artifact is replayed directly; recording is never
// repeated merely to obtain fresh native DBs for another worker-count trial.
const recordingPath = recordingArgument() ?? record();
const artifact = readHltHubRecording(recordingPath);
if (artifact.source.engine !== 'ts') throw new Error('HLT_MIXED_PARITY_SOURCE_NOT_TS');
const meshRoot = readFileSync(join(artifact.source.workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
if (!meshRoot) throw new Error('HLT_MIXED_PARITY_MESH_SEED_MISSING');
const replayRoot = mkdtempSync(join(tmpdir(), 'xln-runtime-parity-'));
const runtimeSeedPath = join(replayRoot, 'h1-runtime.seed');
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
    '--native-db', join(replayRoot, `w${workers}`),
    '--workers', String(workers),
  ], AUTHORITY_EVIDENCE_RECORD_BUDGET_MS);
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
