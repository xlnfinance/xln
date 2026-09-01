#!/usr/bin/env bun

/** Run the live sovereign workload. Offline replay fixtures have their own builder. */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  classifyHltLivePaymentRun,
  classifyRustLiveSameRun,
  parseHltEngineSelection,
} from './rust/rust-h1';
import { hltLanePortsPerSlot } from './lanes/lane-port-capacity';
import { hltLiveReportPath } from './live-report-path';
import { runParityGatedHltChild } from './controller/live-economic-controller';
import {
  AUTHORITY_EVIDENCE_GATE_BUDGET_MS,
} from './replay/evidence/gate-support';

const workDirRaw = String(process.env['XLN_LOCAL_PROD_SMOKE_DIR'] || '').trim();
if (!workDirRaw) throw new Error('HLT_BUILD_WORK_DIR_MISSING');
const workDir = resolve(workDirRaw);
const users = Number(process.env['XLN_HLT_USERS'] || '0');
if (!Number.isSafeInteger(users) || users < 2) throw new Error(`HLT_BUILD_USERS_INVALID:${String(users)}`);
const workload = String(process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE'] || '').trim();
if (!['payments', 'same', 'mixed', 'cross'].includes(workload)) {
  throw new Error(`HLT_BUILD_WORKLOAD_INVALID:${workload}`);
}
const authorityEvidence = process.env['XLN_HLT_AUTHORITY_EVIDENCE'] === '1';
const authorityDeadline = performance.now() + AUTHORITY_EVIDENCE_GATE_BUDGET_MS;
const remainingAuthorityBudget = (phase: string): number => {
  const remaining = Math.floor(authorityDeadline - performance.now());
  if (remaining <= 0) throw new Error(`HLT_AUTHORITY_EVIDENCE_BUDGET_EXHAUSTED:${phase}`);
  return remaining;
};
if (authorityEvidence && (workload !== 'mixed' || process.env['XLN_MM_CROSS_J'] !== '0')) {
  throw new Error('HLT_AUTHORITY_EVIDENCE_REQUIRES_MIXED_SAME_J');
}
const selection = parseHltEngineSelection(process.env);
if (selection.engine === 'rust' && workload !== 'payments' && workload !== 'same' && workload !== 'mixed') {
  throw new Error(`HLT_RUST_LIVE_WORKLOAD_UNSUPPORTED:${workload}`);
}
const rustRatePerUser = Number(process.env['XLN_HLT_RATE_PER_USER'] || '1');
const rustDurationSeconds = Number(process.env['XLN_HLT_DURATION_S'] || '20');
if (selection.engine === 'rust') {
  const offeredPayments = users * rustRatePerUser;
  const submittedPayments = offeredPayments * rustDurationSeconds;
  if (!Number.isSafeInteger(rustRatePerUser) || rustRatePerUser < 1) throw new Error(`HLT_RATE_PER_USER_INVALID:${rustRatePerUser}`);
  if (!Number.isSafeInteger(rustDurationSeconds) || rustDurationSeconds < 1) throw new Error(`HLT_DURATION_INVALID:${rustDurationSeconds}`);
  if (workload === 'payments') {
    classifyHltLivePaymentRun({
      users,
      payments: submittedPayments,
      offeredPerSecond: offeredPayments,
      durationSeconds: rustDurationSeconds,
    });
  } else if (workload === 'same') {
    classifyRustLiveSameRun({
      users,
      orders: submittedPayments,
      offeredOrdersPerSecond: offeredPayments,
      durationSeconds: rustDurationSeconds,
    });
  }
}

const snapshotPath = join(workDir, 'hlt-h1-base-snapshot.json');
const buildEnv = {
  ...process.env,
  // Every sovereign Runtime owns one direct listener. The ordinary 4096-port
  // lease is enough for normal HLT; expand only the isolated high-cardinality
  // run, never by reducing the number of actual users.
  XLN_HLT_LANE_PORTS_PER_SLOT: String(hltLanePortsPerSlot(users)),
  XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_SMOKE: '1',
  ...(selection.engine === 'ts' ? { XLN_RUNTIME_SNAPSHOT_EXPORT_PATH: snapshotPath } : {}),
  ...(selection.engine === 'rust' ? {
    // Pin the exact plan already validated above. The child must not derive a
    // second default that could drift from the launcher's cardinality gate.
    XLN_HLT_RATE_PER_USER: String(rustRatePerUser),
    XLN_HLT_DURATION_S: String(rustDurationSeconds),
    // H2/H3, market maker and custody own no stage of the single-H1 payment
    // authority path. Keep production orchestrator/relay/H1, but do not spend
    // the 30-second live gate booting unrelated products.
    XLN_HLT_H1_ONLY: '1',
    XLN_HUB_COUNT: '1',
    XLN_MM_CROSS_J: '0',
    XLN_MESH_PRIMARY_JURISDICTION_ONLY: '1',
  } : {}),
  ...(authorityEvidence ? { XLN_MESH_PRIMARY_JURISDICTION_ONLY: '1' } : {}),
};
const economicGateDir = String(process.env['XLN_HLT_ECONOMIC_GATE_DIR'] ?? '').trim();
const smokeStatus = economicGateDir
  ? await runParityGatedHltChild({
      gateDir: economicGateDir,
      parityCommand: process.execPath,
      parityArgs: ['core/scripts/operations/hlt/replay/commands/run-mixed-ts-rust-parity.ts'],
      command: process.execPath,
      args: ['core/scripts/operations/production/local-prod-smoke.ts'],
      env: buildEnv,
    })
  : spawnSync(process.execPath, ['core/scripts/operations/production/local-prod-smoke.ts'], {
      cwd: process.cwd(),
      env: buildEnv,
      stdio: 'inherit',
      timeout: authorityEvidence ? remainingAuthorityBudget('live') : 30_000,
    }).status;
if (smokeStatus !== 0) throw new Error(`HLT_BUILD_SMOKE_FAILED:${String(smokeStatus)}`);

const reportPath = hltLiveReportPath({
  workDir,
  engine: selection.engine,
  workload,
});
if (!existsSync(reportPath)) throw new Error(`HLT_BUILD_WORKLOAD_REPORT_MISSING:${reportPath}`);
if (selection.engine === 'ts' && authorityEvidence && !existsSync(`${snapshotPath}.concrete-checkpoint.json`)) {
  throw new Error(`HLT_BUILD_CONCRETE_CHECKPOINT_MISSING:${snapshotPath}.concrete-checkpoint.json`);
}
const output = resolve(
  String(process.env['XLN_HLT_RECORDING_OUTPUT'] || join(workDir, 'hlt-hub-recording.json')),
);
if (selection.engine === 'rust') {
  const liveReport = join(workDir, 'hlt-rust-h1-live.json');
  const nativeDb = join(workDir, 'prod-mesh', 'h1', 'rscore-native');
  if (!existsSync(liveReport)) throw new Error(`HLT_RUST_H1_LIVE_REPORT_MISSING:${liveReport}`);
  if (!existsSync(nativeDb)) throw new Error(`HLT_RUST_H1_NATIVE_DB_MISSING:${nativeDb}`);
  // Rust owns every economic frame after cutover. Reading the retired TS H1
  // database here produced a plausible but stale recording. The canonical
  // replay source is the native checkpoint + ordered native WAL itself.
  console.log(`HLT_BUILD_CHAINS_OK_RUST_H1 nativeDb=${nativeDb} live=${liveReport}`);
} else {
  if (!authorityEvidence) {
    console.log(`HLT_BUILD_CHAINS_OK_TS report=${reportPath}`);
  } else {
    const builder = spawnSync(process.execPath, [
      'core/scripts/operations/hlt/replay/build-hub-recording.ts',
      '--work-dir', workDir,
      '--output', output,
      '--checkpoint', `${snapshotPath}.concrete-checkpoint.json`,
      '--users', String(users),
      '--workload', workload,
      '--require-complete-authority-evidence',
    ], {
      cwd: process.cwd(),
      env: buildEnv,
      stdio: 'inherit',
      timeout: remainingAuthorityBudget('artifact'),
    });
    if (builder.status !== 0) throw new Error(`HLT_BUILD_RECORDING_FAILED:${String(builder.status)}`);
    console.log(`HLT_BUILD_CHAINS_OK recording=${output}`);
  }
}
