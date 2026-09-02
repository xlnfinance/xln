#!/usr/bin/env bun

/** Prove one bound production TS transcript with isolated TS/Rust W1/W4 replays. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { safeParse, safeStringify } from '../../../../../protocol/serialization';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../../protocol/boundary-validation';
import { deriveMeshChildSeed } from '../../../../../orchestrator/mesh/mesh-seeds';
import {
  AUTHORITY_EVIDENCE_GATE_BUDGET_MS,
  authorityEvidenceBinary,
} from '../evidence/gate-support';
import { readHltHubRecording } from '../recording';
import {
  assertHltAuthoritySourceBinding,
  copyBoundAuthorityWal,
} from '../source-binding';

const parityDeadline = performance.now() + AUTHORITY_EVIDENCE_GATE_BUDGET_MS;
const parityStartedAt = performance.now();
const parityStage = (stage: string): void => {
  console.error(`HLT_MIXED_PARITY_STAGE stage=${stage} elapsedMs=${Math.ceil(performance.now() - parityStartedAt)}`);
};

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

const recordingArgument = (): string => {
  const index = process.argv.indexOf('--recording');
  if (index < 0) throw new Error('HLT_MIXED_PARITY_RECORDING_ARGUMENT_REQUIRED');
  const path = String(process.argv[index + 1] ?? '').trim();
  if (!path) throw new Error('HLT_MIXED_PARITY_RECORDING_ARGUMENT_MISSING');
  return path;
};

// Recording and replay are separate bounded commands. Requiring the immutable
// artifact prevents a failed replay retry from silently producing a new WAL.
const recordingPath = recordingArgument();
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
    XLN_RUNTIME_OP_COUNTERS_DIR: join(dbRoot, 'op-counters'),
  };
  for (const key of [
    'XLN_RSCORE_AUTHORITY', 'XLN_RSCORE_AUTHORITY_REPLAY',
    'XLN_RSCORE_AUTHORITY_IMPORT', 'XLN_RSCORE_AUTHORITY_RECORD',
  ]) delete env[key];
  return env;
};

const typescriptReportPath = (workers: 1 | 4): string => join(replayRoot, `ts-w${workers}.json`);

const replayTypescript = (workers: 1 | 4): void => {
  parityStage(`ts-w${workers}:start`);
  const dbRoot = join(replayRoot, `ts-w${workers}`);
  run(process.execPath, [
    'core/scripts/operations/hlt/replay/replay-hub-recording.ts',
    '--recording', recordingPath,
    '--output', typescriptReportPath(workers),
    '--runtime-seed-file', runtimeSeedPath,
    '--entity-signer-label', 'h1-hub',
    '--mode', 'max',
    '--ts-account-workers', String(workers),
    '--require-complete-authority-evidence',
    '--parity-evidence',
  ], remainingParityBudget(`ts-w${workers}`), replayEnvironment(dbRoot));
  parityStage(`ts-w${workers}:done`);
};

const AUTHORITY_EXPECTATION_FIELDS = [
  'runtimeFrames',
  'effects',
  'entityEffects',
  'entityFrameEvents',
  'localContinuations',
] as const;

type TsParityReport = Readonly<{
  authorityExpectations: Record<(typeof AUTHORITY_EXPECTATION_FIELDS)[number], readonly unknown[]>;
}>;

const decodeAuthorityExpectations = (
  workers: 1 | 4,
  value: unknown,
): TsParityReport['authorityExpectations'] => {
  const expectations = requireBoundaryRecord(
    value,
    `HLT_MIXED_PARITY_TS_W${workers}_EXPECTATIONS_INVALID`,
  );
  requireExactBoundaryKeys(
    expectations,
    AUTHORITY_EXPECTATION_FIELDS,
    [],
    `HLT_MIXED_PARITY_TS_W${workers}_EXPECTATIONS`,
  );
  const field = (name: (typeof AUTHORITY_EXPECTATION_FIELDS)[number]): readonly unknown[] => {
    const entries = expectations[name];
    if (!Array.isArray(entries)) {
      throw new Error(`HLT_MIXED_PARITY_TS_W${workers}_EXPECTATIONS_${name}`);
    }
    if (entries.length !== artifact.totals.runtimeFrames) {
      throw new Error(
        `HLT_MIXED_PARITY_TS_W${workers}_EXPECTATIONS_${name}_COUNT:` +
        `${entries.length}:${artifact.totals.runtimeFrames}`,
      );
    }
    return entries;
  };
  return {
    runtimeFrames: field('runtimeFrames'),
    effects: field('effects'),
    entityEffects: field('entityEffects'),
    entityFrameEvents: field('entityFrameEvents'),
    localContinuations: field('localContinuations'),
  };
};

const decodeTsParityReport = (workers: 1 | 4): TsParityReport => {
  const path = typescriptReportPath(workers);
  const root = requireBoundaryRecord(
    safeParse(readFileSync(path, 'utf8')),
    `HLT_MIXED_PARITY_TS_W${workers}_REPORT_INVALID`,
  );
  if (root['schema'] !== 'xln-hlt-hub-replay-report-v1') {
    throw new Error(`HLT_MIXED_PARITY_TS_W${workers}_REPORT_SCHEMA`);
  }
  if (root['recordingPath'] !== recordingPath) {
    throw new Error(`HLT_MIXED_PARITY_TS_W${workers}_REPORT_RECORDING`);
  }
  if (root['recordingManifestHash'] !== artifact.recording.manifestHash) {
    throw new Error(`HLT_MIXED_PARITY_TS_W${workers}_REPORT_MANIFEST`);
  }
  if (safeStringify(root['recordingSourceBinding']) !== safeStringify(artifact.source.binding)) {
    throw new Error(`HLT_MIXED_PARITY_TS_W${workers}_REPORT_SOURCE_BINDING`);
  }
  if (root['accountAuthority'] !== `typescript-workers:${workers}`) {
    throw new Error(`HLT_MIXED_PARITY_TS_W${workers}_REPORT_AUTHORITY`);
  }
  return { authorityExpectations: decodeAuthorityExpectations(workers, root['authorityExpectations']) };
};

const assertTsParityReportsEqual = (w1: TsParityReport, w4: TsParityReport): void => {
  for (const field of AUTHORITY_EXPECTATION_FIELDS) {
    if (safeStringify(w1.authorityExpectations[field]) !== safeStringify(w4.authorityExpectations[field])) {
      throw new Error(`HLT_MIXED_PARITY_TS_W1_W4_AUTHORITY_EXPECTATIONS:${field}`);
    }
  }
  for (const field of ['runtimeFrames', 'effects'] as const) {
    if (
      safeStringify(w1.authorityExpectations[field]) !==
      safeStringify(artifact.authorityEvidence.expectations[field])
    ) {
      throw new Error(`HLT_MIXED_PARITY_TS_SOURCE_AUTHORITY_EXPECTATIONS:${field}`);
    }
  }
};

type RustParityReport = Readonly<{
  frames: number;
  ingress: number;
  egress: number;
  directPayments: number;
  effectDigestsCompared: number;
  eventDigestsCompared: number;
  localContinuationsCompared: number;
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
    localContinuationsCompared: count('localContinuationsCompared'),
    outboxDigestsCompared: count('outboxDigestsCompared'),
    postStateHashesCompared: count('postStateHashesCompared'),
    runtimeRootsCompared: count('runtimeRootsCompared'),
    accountsRoot,
  };
};

const replayRust = async (workers: 1 | 4, tsParityReport: string): Promise<RustParityReport> => {
  const wal = join(replayRoot, `rust-w${workers}-wal`);
  parityStage(`rust-w${workers}:copy-start`);
  await copyBoundAuthorityWal(boundWal, wal, artifact.source.binding, runtimeSeed);
  parityStage(`rust-w${workers}:run-start`);
  const output = run(binary, [
    'runtime-replay',
    '--wal', wal,
    '--recording', recordingPath,
    '--ts-parity-report', tsParityReport,
    '--recording-manifest-hash', artifact.recording.manifestHash,
    '--runtime-seed-file', runtimeSeedPath,
    '--runtime-signer-label', '1',
    '--entity-signer-label', 'h1-hub',
    '--native-db', join(replayRoot, `w${workers}`),
    '--workers', String(workers),
  ], remainingParityBudget(`rust-w${workers}`));
  parityStage(`rust-w${workers}:done`);
  const line = output.trim().split('\n').at(-1);
  return decodeRustParityReport(safeParse(line ?? ''));
};

replayTypescript(1);
replayTypescript(4);
const tsW1 = decodeTsParityReport(1);
const tsW4 = decodeTsParityReport(4);
assertTsParityReportsEqual(tsW1, tsW4);
const tsW1ReportPath = typescriptReportPath(1);
const w1 = await replayRust(1, tsW1ReportPath);
const w4 = await replayRust(4, tsW1ReportPath);
const frames = artifact.totals.runtimeFrames;
const frameCountFields = [
  'frames', 'effectDigestsCompared', 'eventDigestsCompared',
  'localContinuationsCompared',
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
