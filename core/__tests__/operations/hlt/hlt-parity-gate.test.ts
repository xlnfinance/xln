import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertHltAuthoritySourceBinding,
  buildHltAuthoritySourceBinding,
  copyBoundAuthorityWal,
} from '../../../scripts/operations/hlt/replay/source-binding';
import { hltLiveReportPath } from '../../../scripts/operations/hlt/live-report-path';
import { offlineParityEnv } from '../../../scripts/operations/hlt/controller/live-economic-controller';

const repoRoot = join(import.meta.dir, '../../../..');

test('binds one closed WAL and runtime seed before creating pristine replay copies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-authority-binding-'));
  const wal = join(root, 'wal');
  const copy = join(root, 'copy');
  mkdirSync(join(wal, 'nested'), { recursive: true });
  writeFileSync(join(wal, 'CURRENT'), 'MANIFEST-000001\n');
  writeFileSync(join(wal, 'nested', '000001.ldb'), Buffer.from([1, 2, 3, 4]));
  try {
    const binding = await buildHltAuthoritySourceBinding(wal, 'runtime-seed');
    await expect(assertHltAuthoritySourceBinding(binding, wal, 'runtime-seed')).resolves.toBeUndefined();
    await copyBoundAuthorityWal(wal, copy, binding, 'runtime-seed');
    await expect(assertHltAuthoritySourceBinding(binding, copy, 'runtime-seed')).resolves.toBeUndefined();
    writeFileSync(join(copy, 'nested', '000001.ldb'), Buffer.from([1, 2, 3, 5]));
    await expect(assertHltAuthoritySourceBinding(binding, copy, 'runtime-seed'))
      .rejects.toThrow('HLT_AUTHORITY_SOURCE_WAL_TREE_HASH');
    await expect(assertHltAuthoritySourceBinding(binding, wal, 'different-seed'))
      .rejects.toThrow('HLT_AUTHORITY_SOURCE_RUNTIME_SEED_HASH');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one-artifact gate runs four isolated exact replays inside one three-minute budget', () => {
  const gatePath = join(
    repoRoot,
    'core/scripts/operations/hlt/replay/commands/run-mixed-ts-rust-parity.ts',
  );
  const gate = readFileSync(gatePath, 'utf8');
  const replay = readFileSync(join(
    repoRoot,
    'core/scripts/operations/hlt/replay/replay-hub-recording.ts',
  ), 'utf8');
  const build = readFileSync(join(
    repoRoot,
    'core/scripts/operations/hlt/build-chains.ts',
  ), 'utf8');
  const workerMixed = readFileSync(join(
    repoRoot,
    'core/scripts/operations/hlt/workload/worker-mixed.ts',
  ), 'utf8');
  const liveController = readFileSync(join(
    repoRoot,
    'core/scripts/operations/hlt/controller/live-economic-controller.ts',
  ), 'utf8');
  expect(gate).toContain('performance.now() + AUTHORITY_EVIDENCE_GATE_BUDGET_MS');
  expect(gate).toContain('HLT_MIXED_PARITY_RECORDING_ARGUMENT_REQUIRED');
  expect(gate).toContain('remainingParityBudget(`ts-w${workers}`)');
  expect(gate).toContain('replayTypescript(1)');
  expect(gate).toContain('replayTypescript(4)');
  expect(gate).toContain('await replayRust(1, tsW1ReportPath)');
  expect(gate).toContain('await replayRust(4, tsW1ReportPath)');
  expect(gate).toContain('copyBoundAuthorityWal(boundWal, wal');
  expect(gate).toContain("'--parity-evidence'");
  expect(replay).toContain('HLT_REPLAY_PARITY_EQUIVALENT');
  expect(replay).toContain('trials: parityEvidence ? trials.map(parityTrial) : trials');
  expect(build).toContain('hltLiveReportPath({');
  expect(build).toContain('HLT_PARITY_RECORDING_REQUIRED');
  expect(build).toContain('resolve(parityRecording)');
  expect(liveController).toContain('timeout: AUTHORITY_EVIDENCE_GATE_BUDGET_MS');
  expect(liveController).toContain('const PHASE_TIMEOUT_MS = 120_000');
  expect(liveController).toContain('const RUN_PHASE_TIMEOUT_MS = AUTHORITY_EVIDENCE_GATE_BUDGET_MS');
  expect(liveController).toContain(
    "new Error('HLT_ECONOMIC_GATE_RUN_TIMEOUT')), RUN_PHASE_TIMEOUT_MS",
  );
  const paritySmoke = /HLT_MIXED_PARITY_SMOKE[\s\S]*?\}\)\}`\);/.exec(workerMixed)?.[0];
  expect(paritySmoke).toBeDefined();
  expect(paritySmoke).not.toMatch(/tps|rate|perSecond/i);
  const missingRecording = Bun.spawnSync([process.execPath, gatePath], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(missingRecording.exitCode).not.toBe(0);
  expect(missingRecording.stderr.toString()).toContain(
    'HLT_MIXED_PARITY_RECORDING_ARGUMENT_REQUIRED',
  );
});

test('offline parity cannot inherit live population, engine, workload or worker switches', () => {
  expect(offlineParityEnv({
    PATH: '/bin',
    XLN_HLT_ENGINE: 'rust',
    XLN_HLT_USERS: '1000',
    XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE: 'payments',
    XLN_RSCORE_AUTHORITY_WORKERS: '4',
    XLN_TS_ACCOUNT_WORKERS: '4',
    XLN_STORAGE_WAL_SYNC: '1',
    XLN_MM_CROSS_J: '0',
    XLN_RSCORE_BINARY: '/tmp/xlnrs',
  })).toEqual({
    PATH: '/bin',
    XLN_RSCORE_BINARY: '/tmp/xlnrs',
  });
});

test('selects the functional TS mixed artifact for smoke and authority recording', () => {
  expect(hltLiveReportPath({
    workDir: '/tmp/run',
    engine: 'ts',
    workload: 'mixed',
  })).toBe('/tmp/run/hlt-ts-h1-live.json');
  expect(hltLiveReportPath({
    workDir: '/tmp/run',
    engine: 'ts',
    workload: 'same',
  })).toBe('/tmp/run/production-swap-load-report.json');
  expect(hltLiveReportPath({
    workDir: '/tmp/run',
    engine: 'rust',
    workload: 'mixed',
  })).toBe('/tmp/run/hlt-rust-h1-live.json');
});
