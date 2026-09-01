#!/usr/bin/env bun

/** Record one production TS transcript, then prove it with independent Rust W1/W4 DBs. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { safeParse } from '../../../../../protocol/serialization';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
} from '../../../../../protocol/boundary-validation';
import { deriveMeshChildSeed } from '../../../../../orchestrator/mesh/mesh-seeds';
import {
  authorityEvidenceBinary,
} from '../evidence/gate-support';
import { readHltHubRecording } from '../recording';
import {
  assertHltAuthoritySourceBinding,
  copyBoundAuthorityWal,
} from '../source-binding';

const PARITY_GATE_TIMEOUT_MS = 30_000;
const parityDeadline = performance.now() + PARITY_GATE_TIMEOUT_MS;

const remainingParityBudget = (phase: string): number => {
  const remaining = Math.floor(parityDeadline - performance.now());
  if (remaining <= 0) throw new Error(`HLT_MIXED_PARITY_BUDGET_EXHAUSTED:${phase}`);
  return remaining;
};

const run = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
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
  ], remainingParityBudget('record'));
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
const runtimeSeed = deriveMeshChildSeed(meshRoot, 'runtime:h1');
writeFileSync(runtimeSeedPath, `${runtimeSeed}\n`, { mode: 0o600 });
const boundWal = join(artifact.source.workDir, 'prod-mesh', 'h1', `${artifact.tail.runtimeId}-wal`);
const binary = authorityEvidenceBinary();

await assertHltAuthoritySourceBinding(artifact.source.binding, boundWal, runtimeSeed);

const replayEnvironment = (dbRoot: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XLN_DB_PATH: dbRoot,
    XLN_RDB_ROOT: dbRoot,
  };
  for (const key of [
    'XLN_RSCORE_AUTHORITY', 'XLN_RSCORE_AUTHORITY_REPLAY',
    'XLN_RSCORE_AUTHORITY_IMPORT', 'XLN_RSCORE_AUTHORITY_RECORD',
  ]) delete env[key];
  return env;
};

const replayTypescript = (workers: 1 | 4): void => {
  const dbRoot = join(replayRoot, `ts-w${workers}`);
  run(process.execPath, [
    'core/scripts/operations/hlt/replay/replay-hub-recording.ts',
    '--recording', recordingPath,
    '--output', join(replayRoot, `ts-w${workers}.json`),
    '--runtime-seed-file', runtimeSeedPath,
    '--entity-signer-label', 'h1-hub',
    '--mode', 'max',
    '--ts-account-workers', String(workers),
    '--require-complete-authority-evidence',
    '--parity-evidence',
  ], remainingParityBudget(`ts-w${workers}`), replayEnvironment(dbRoot));
};

type RustParityReport = Readonly<{
  frames: number;
  ingress: number;
  egress: number;
  directPayments: number;
  effectDigestsCompared: number;
  eventDigestsCompared: number;
  outboxDigestsCompared: number;
  postStateHashesCompared: number;
  runtimeRootsCompared: number;
  accountsRoot: string;
}>;

const decodeRustParityReport = (value: unknown): RustParityReport => {
  const report = requireBoundaryRecord(value, 'HLT_MIXED_PARITY_RUST_REPORT_INVALID');
  const count = (field: keyof Omit<RustParityReport, 'accountsRoot'>): number => (
    requireBoundaryInteger(report[field], `HLT_MIXED_PARITY_RUST_REPORT_${field}`)
  );
  const accountsRoot = report['accountsRoot'];
  if (typeof accountsRoot !== 'string' || !/^0x[0-9a-f]{64}$/.test(accountsRoot)) {
    throw new Error(`HLT_MIXED_PARITY_RUST_REPORT_ACCOUNTS_ROOT:${String(accountsRoot)}`);
  }
  return {
    frames: count('frames'),
    ingress: count('ingress'),
    egress: count('egress'),
    directPayments: count('directPayments'),
    effectDigestsCompared: count('effectDigestsCompared'),
    eventDigestsCompared: count('eventDigestsCompared'),
    outboxDigestsCompared: count('outboxDigestsCompared'),
    postStateHashesCompared: count('postStateHashesCompared'),
    runtimeRootsCompared: count('runtimeRootsCompared'),
    accountsRoot,
  };
};

const replayRust = async (workers: 1 | 4): Promise<RustParityReport> => {
  const wal = join(replayRoot, `rust-w${workers}-wal`);
  await copyBoundAuthorityWal(boundWal, wal, artifact.source.binding, runtimeSeed);
  const output = run(binary, [
    'runtime-replay',
    '--wal', wal,
    '--recording', recordingPath,
    '--runtime-seed-file', runtimeSeedPath,
    '--runtime-signer-label', '1',
    '--entity-signer-label', 'h1-hub',
    '--native-db', join(replayRoot, `w${workers}`),
    '--workers', String(workers),
  ], remainingParityBudget(`rust-w${workers}`));
  const line = output.trim().split('\n').at(-1);
  return decodeRustParityReport(safeParse(line ?? ''));
};

replayTypescript(1);
replayTypescript(4);
const w1 = await replayRust(1);
const w4 = await replayRust(4);
const frames = artifact.totals.runtimeFrames;
const frameCountFields = [
  'frames', 'effectDigestsCompared', 'eventDigestsCompared',
  'outboxDigestsCompared', 'postStateHashesCompared',
] as const;
for (const [label, report] of [['w1', w1], ['w4', w4]] as const) {
  for (const field of frameCountFields) {
    if (report[field] !== frames) throw new Error(`HLT_MIXED_PARITY_COUNTER:${label}:${field}:${String(report[field])}:${frames}`);
  }
  if (report['runtimeRootsCompared'] !== frames + 1) {
    throw new Error(`HLT_MIXED_PARITY_RUNTIME_ROOTS:${label}:${String(report['runtimeRootsCompared'])}:${frames + 1}`);
  }
}
for (const field of ['frames', 'ingress', 'egress', 'directPayments', 'accountsRoot'] as const) {
  if (w1[field] !== w4[field]) throw new Error(`HLT_MIXED_PARITY_W1_W4:${field}:${String(w1[field])}:${String(w4[field])}`);
}
console.log(
  `HLT_MIXED_TS_RUST_PARITY_OK recording=${recordingPath} frames=${frames} ` +
  `engines=ts-w1,ts-w4,rust-w1,rust-w4 accountsRoot=${String(w1['accountsRoot'])}`,
);
