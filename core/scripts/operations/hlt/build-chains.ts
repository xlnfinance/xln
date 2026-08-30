#!/usr/bin/env bun

/** HLT phase 1: run real sovereign nodes once, then seal H1 checkpoint + WAL tail. */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  assertRustLivePaymentCardinality,
  parseHltEngineSelection,
} from './rust/rust-h1';
import { hltLanePortsPerSlot } from './lanes/lane-port-capacity';

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
if (authorityEvidence && workload !== 'mixed') {
  throw new Error(`HLT_AUTHORITY_EVIDENCE_REQUIRES_MIXED:${workload}`);
}
if (authorityEvidence && process.env['XLN_MM_CROSS_J'] !== '0') {
  throw new Error('HLT_AUTHORITY_EVIDENCE_REQUIRES_MM_CROSS_J_DISABLED');
}
const selection = parseHltEngineSelection(process.env);
if (selection.engine === 'rust' && workload !== 'payments' && workload !== 'mixed') {
  throw new Error(`HLT_RUST_LIVE_WORKLOAD_UNSUPPORTED:${workload}`);
}
const rustRatePerUser = Number(process.env['XLN_HLT_RATE_PER_USER'] || '1');
const rustDurationSeconds = Number(process.env['XLN_HLT_DURATION_S'] || '20');
if (selection.engine === 'rust') {
  const offeredPayments = users * rustRatePerUser;
  const submittedPayments = offeredPayments * rustDurationSeconds;
  if (!Number.isSafeInteger(rustRatePerUser) || rustRatePerUser < 1) throw new Error(`HLT_RATE_PER_USER_INVALID:${rustRatePerUser}`);
  if (!Number.isSafeInteger(rustDurationSeconds) || rustDurationSeconds < 1) throw new Error(`HLT_DURATION_INVALID:${rustDurationSeconds}`);
  if (workload !== 'mixed') {
    assertRustLivePaymentCardinality({
      users,
      payments: submittedPayments,
      offeredPerSecond: offeredPayments,
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
  // The RRS MVP owns one H1 Entity. Cross-J is separately disabled below;
  // booting a second local Entity would silently turn this into a multi-Entity gate.
  ...(authorityEvidence ? { XLN_MESH_PRIMARY_JURISDICTION_ONLY: '1' } : {}),
};
const smoke = spawnSync(process.execPath, ['core/scripts/operations/production/local-prod-smoke.ts'], {
  cwd: process.cwd(),
  env: buildEnv,
  stdio: 'inherit',
  // A gated HLT is already owned by the launcher in two bounded phases:
  // setup ends at `ready`, then the launcher writes `start` and owns the
  // 20-second offer plus drain deadline. A wall clock here would include
  // setup and kill a healthy live stack during its economic drain.
  timeout: process.env['XLN_HLT_ECONOMIC_GATE_DIR'] ? undefined : 30_000,
});
if (smoke.status !== 0) throw new Error(`HLT_BUILD_SMOKE_FAILED:${String(smoke.status)}`);

const reportPath = selection.engine === 'rust'
  ? join(workDir, 'hlt-rust-h1-live.json')
  : workload === 'payments'
  ? join(workDir, 'hlt-payment-load-report.json')
  : workload === 'cross'
    ? join(workDir, 'production-cross-swap-load-report.json')
    : join(workDir, 'production-swap-load-report.json');
if (!existsSync(reportPath)) throw new Error(`HLT_BUILD_WORKLOAD_REPORT_MISSING:${reportPath}`);
if (selection.engine === 'ts' && !existsSync(snapshotPath)) {
  throw new Error(`HLT_BUILD_BASE_SNAPSHOT_MISSING:${snapshotPath}`);
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
  const builder = spawnSync(process.execPath, [
    'core/scripts/operations/hlt/replay/build-hub-recording.ts',
    '--work-dir', workDir,
    '--output', output,
    '--snapshot', snapshotPath,
    '--users', String(users),
    '--workload', workload,
    ...(authorityEvidence ? ['--require-complete-authority-evidence'] : []),
  ], { cwd: process.cwd(), env: buildEnv, stdio: 'inherit', timeout: 20_000 });
  if (builder.status !== 0) throw new Error(`HLT_BUILD_RECORDING_FAILED:${String(builder.status)}`);
  console.log(`HLT_BUILD_CHAINS_OK recording=${output}`);
}
