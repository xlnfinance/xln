#!/usr/bin/env bun

/** HLT phase 1: run real sovereign nodes once, then seal H1 checkpoint + WAL tail. */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const workDirRaw = String(process.env['XLN_LOCAL_PROD_SMOKE_DIR'] || '').trim();
if (!workDirRaw) throw new Error('HLT_BUILD_WORK_DIR_MISSING');
const workDir = resolve(workDirRaw);
const users = Number(process.env['XLN_HLT_USERS'] || '0');
if (!Number.isSafeInteger(users) || users < 2) throw new Error(`HLT_BUILD_USERS_INVALID:${String(users)}`);
const workload = String(process.env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE'] || '').trim();
if (!['payments', 'same', 'mixed', 'cross'].includes(workload)) {
  throw new Error(`HLT_BUILD_WORKLOAD_INVALID:${workload}`);
}

const snapshotPath = join(workDir, 'hlt-h1-base-snapshot.json');
const buildEnv = {
  ...process.env,
  XLN_RUNTIME_SNAPSHOT_EXPORT_PATH: snapshotPath,
};
const smoke = spawnSync(process.execPath, ['core/scripts/operations/production/local-prod-smoke.ts'], {
  cwd: process.cwd(),
  env: buildEnv,
  stdio: 'inherit',
});
if (smoke.status !== 0) throw new Error(`HLT_BUILD_SMOKE_FAILED:${String(smoke.status)}`);

const reportPath = workload === 'payments'
  ? join(workDir, 'hlt-payment-load-report.json')
  : workload === 'cross'
    ? join(workDir, 'production-cross-swap-load-report.json')
    : join(workDir, 'production-swap-load-report.json');
if (!existsSync(reportPath)) throw new Error(`HLT_BUILD_WORKLOAD_REPORT_MISSING:${reportPath}`);
if (!existsSync(snapshotPath)) throw new Error(`HLT_BUILD_BASE_SNAPSHOT_MISSING:${snapshotPath}`);

const output = resolve(
  String(process.env['XLN_HLT_RECORDING_OUTPUT'] || join(workDir, 'hlt-hub-recording.json')),
);
const builder = spawnSync(process.execPath, [
  'core/scripts/operations/hlt/replay/build-hub-recording.ts',
  '--work-dir', workDir,
  '--output', output,
  '--snapshot', snapshotPath,
  '--users', String(users),
  '--workload', workload,
], { cwd: process.cwd(), env: buildEnv, stdio: 'inherit' });
if (builder.status !== 0) throw new Error(`HLT_BUILD_RECORDING_FAILED:${String(builder.status)}`);
console.log(`HLT_BUILD_CHAINS_OK recording=${output}`);
