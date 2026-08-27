#!/usr/bin/env bun

/** HLT phase 1: run real sovereign nodes once, then seal H1 checkpoint + WAL tail. */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { deriveMeshChildSeed } from '../../../orchestrator/mesh/mesh-seeds';
import { deriveManagedEntityIdentity } from '../../../orchestrator/daemon-control';
import { safeStringify } from '../../../protocol/serialization';
import { laneRuntimePort } from './lanes/lane-runtimes';
import { deriveLoadLaneSeeds } from './lanes/worker-lanes';
import {
  parseHltEngineSelection,
  spawnRustH1,
  deriveUserNodeRoute,
} from './rust/rust-h1';

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

const snapshotPath = join(workDir, 'hlt-h1-base-snapshot.json');
const buildEnv = {
  ...process.env,
  XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_SMOKE: '1',
  XLN_RUNTIME_SNAPSHOT_EXPORT_PATH: snapshotPath,
  // The RRS MVP owns one H1 Entity. Cross-J is separately disabled below;
  // booting a second local Entity would silently turn this into a multi-Entity gate.
  ...(authorityEvidence ? { XLN_MESH_PRIMARY_JURISDICTION_ONLY: '1' } : {}),
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
  ...(authorityEvidence ? ['--require-complete-authority-evidence'] : []),
], { cwd: process.cwd(), env: buildEnv, stdio: 'inherit' });
if (builder.status !== 0) throw new Error(`HLT_BUILD_RECORDING_FAILED:${String(builder.status)}`);

const selection = parseHltEngineSelection(process.env);
if (selection.engine === 'rust') {
  // One-time offline TS DB import: seal the signed snapshot into the frozen
  // path-keyed native base, then boot the real rscore-runtime as H1 from it.
  const base = spawnSync(process.execPath, [
    'core/scripts/operations/hlt/replay/commands/prepare-native-base.ts',
    '--work-dir', workDir,
    '--snapshot', snapshotPath,
  ], { cwd: process.cwd(), env: buildEnv, stdio: 'inherit' });
  if (base.status !== 0) throw new Error(`HLT_RUST_H1_NATIVE_BASE_FAILED:${String(base.status)}`);
  const bindHost = String(process.env['XLN_HLT_RUST_H1_BIND_HOST'] || '127.0.0.1');
  const bindPort = Number(process.env['XLN_HLT_RUST_H1_BIND_PORT'] || '0');
  const meshRootSeed = readFileSync(join(workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
  const runtimeSeed = deriveMeshChildSeed(meshRootSeed, 'runtime:h1');
  // Canonical identity: identical derivation to prepare-native-base, so the
  // transport encryption key and signer ids match the sealed native state.
  const identity = deriveManagedEntityIdentity({
    name: 'H1',
    seed: runtimeSeed,
    signerLabel: 'h1-hub',
  });
  // H1 outbound route table over the real HLT user topology: canonical load
  // lane seeds/identities (`production-swap-load:lane:N`) and the lane port
  // formula. User Runtimes dial H1 inbound; H1 pushes Account outputs/ACKs
  // back to them over exactly these routes. No scaffolding: every row is
  // derived from the mesh root seed and validated before H1 starts.
  const lanePortBase = Number(process.env['XLN_HLT_RUST_H1_LANE_PORT_BASE'] || '20020');
  const laneCount = Math.max(1, users);
  const laneSeeds = deriveLoadLaneSeeds(meshRootSeed, laneCount, 'taker', 0);
  const h1Routes = laneSeeds.map((seed, index) => deriveUserNodeRoute({
    name: `Load Taker ${String(index + 1).padStart(4, '0')}`,
    runtimeSeed: seed,
    signerLabel: 'owner',
    listenHost: bindHost,
    listenPort: laneRuntimePort(lanePortBase, index),
  }));
  const handle = await spawnRustH1({
    workDir,
    runtimeSeed,
    routes: h1Routes,
    bindHost,
    bindPort,
    runtimeSignerLabel: 'h1-hub',
    entitySignerLabel: 'h1-hub',
    offlineTsImport: true,
  });
  const result = {
    engine: selection.engine,
    profile: selection.profile,
    runtimeId: handle.ready.runtimeId,
    listen: handle.ready.listen,
    workers: handle.ready.workers,
    pid: handle.pid,
    entityId: identity.entityId,
    signerId: identity.signerId,
    routes: h1Routes,
    // TS user nodes dial H1 with this URL through the same encrypted direct
    // socket protocol they use for a TS H1.
    dialUrl: `ws://${handle.ready.listen}`,
  };
  await handle.stop();
  writeFileSync(join(workDir, 'hlt-rust-h1.json'), `${safeStringify(result)}\n`);
  console.log(`HLT_BUILD_CHAINS_OK_RUST_H1 recording=${output} listen=${handle.ready.listen} runtimeId=${handle.ready.runtimeId}`);
} else {
  console.log(`HLT_BUILD_CHAINS_OK recording=${output}`);
}
