#!/usr/bin/env bun

/**
 * Canonical HLT L2: real Rust H1 live socket milestone (smoke profile).
 *
 * Stages, each fail-loud:
 *   1. Require an existing engine=ts HLT workDir (signed snapshot + mesh
 *      secrets). The native base is the one-time offline TS DB import of
 *      that snapshot; there is no synthetic fixture path.
 *   2. Seal the snapshot into the frozen path-keyed native base.
 *   3. Spawn real sovereign TS user Runtime lanes (canonical load-lane
 *      seeds/identities) and take their live runtimeId/port/identity.
 *   4. Derive the H1 route table from those live lanes and start the real
 *      zero-JS rscore-runtime as H1 (native WAL/DB, encrypted direct socket
 *      ingress); wait for the ready line.
 *   5. Report socket/crypto evidence, then shut down H1 and the lanes.
 *
 * Financial delivery (payment -> Account ACK drain) is only claimed when the
 * lane host points user Runtimes' outbound peering at the Rust H1 ingress;
 * until that wiring exists this harness reports the exact stage boundary.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { deriveManagedEntityIdentity } from '../../../../orchestrator/daemon-control';
import { deriveMeshChildSeed } from '../../../../orchestrator/mesh/mesh-seeds';
import { safeStringify } from '../../../../protocol/serialization';
import { spawnLaneRuntimes, stopLaneRuntimes } from '../lanes/lane-runtimes';
import { deriveLoadLaneIdentities, deriveLoadLaneSeeds } from '../lanes/worker-lanes';
import { spawnRustH1, type HltEntityRoute } from './rust-h1';

const argument = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
};

const workDirRaw = argument('work-dir');
if (!workDirRaw) throw new Error('HLT_RUST_LIVE_WORK_DIR_MISSING: --work-dir <hlt engine=ts workDir>');
const workDir = resolve(workDirRaw);
const usersRaw = argument('users') || '1';
const laneCount = Number(usersRaw);
if (!Number.isSafeInteger(laneCount) || laneCount < 1 || laneCount > 10) {
  throw new Error(`HLT_RUST_LIVE_USERS_INVALID:${usersRaw}`);
}
const lanePortBase = Number(argument('lane-port-base') || '20020');
const bindHost = argument('bind-host') || '127.0.0.1';
const bindPort = Number(argument('bind-port') || '25091');

const snapshotPath = join(workDir, 'hlt-h1-base-snapshot.json');
const meshRootSeedPath = join(workDir, 'secrets', 'mesh-root.seed');
if (!existsSync(snapshotPath)) {
  throw new Error(`HLT_RUST_LIVE_SNAPSHOT_MISSING:${snapshotPath}: run engine=ts HLT build first`);
}
if (!existsSync(meshRootSeedPath)) {
  throw new Error(`HLT_RUST_LIVE_MESH_ROOT_SEED_MISSING:${meshRootSeedPath}`);
}
const meshRootSeed = readFileSync(meshRootSeedPath, 'utf8').trim();

// Stage 2: one-time offline TS DB import.
const base = spawnSync(process.execPath, [
  'core/scripts/operations/hlt/replay/commands/prepare-native-base.ts',
  '--work-dir', workDir,
  '--snapshot', snapshotPath,
], { cwd: process.cwd(), stdio: 'inherit' });
if (base.status !== 0) throw new Error(`HLT_RUST_LIVE_NATIVE_BASE_FAILED:${String(base.status)}`);

const runtimeSeed = deriveMeshChildSeed(meshRootSeed, 'runtime:h1');
const h1Identity = deriveManagedEntityIdentity({ name: 'H1', seed: runtimeSeed, signerLabel: 'h1-hub' });

// Stage 3: real sovereign TS user lanes.
const laneSeeds = deriveLoadLaneSeeds(meshRootSeed, laneCount, 'taker', 0);
const laneIdentities = deriveLoadLaneIdentities(meshRootSeed, laneCount, 'taker', 0);
const lanes = await spawnLaneRuntimes({
  workDir,
  portBase: lanePortBase,
  identities: laneIdentities,
  laneSeeds,
  laneIndexOffset: 0,
});

try {
  // Stage 4: routes from the live lanes, then the real Rust H1.
  const routes: HltEntityRoute[] = lanes.map(lane => ({
    targetEntityId: lane.identity.entityId,
    targetRuntimeId: lane.runtimeId,
    targetSignerId: lane.identity.signerId,
    websocketUrl: `ws://${bindHost}:${String(lane.port)}/ws`,
  }));
  const h1 = await spawnRustH1({
    workDir,
    runtimeSeed,
    routes,
    bindHost,
    bindPort,
    runtimeSignerLabel: 'h1-hub',
    entitySignerLabel: 'h1-hub',
    offlineTsImport: true,
  });
  const result = {
    engine: 'rust' as const,
    profile: 'smoke' as const,
    h1: {
      runtimeId: h1.ready.runtimeId,
      listen: h1.ready.listen,
      workers: h1.ready.workers,
      pid: h1.pid,
      entityId: h1Identity.entityId,
      signerId: h1Identity.signerId,
      dialUrl: `ws://${h1.ready.listen}`,
    },
    userLanes: lanes.map(lane => ({
      runtimeId: lane.runtimeId,
      entityId: lane.identity.entityId,
      port: lane.port,
    })),
    routeCount: routes.length,
    // Financial stage boundary: no payment is submitted until the lane host
    // points user peering at the Rust H1 ingress; see report blocker below.
    deliveredPayments: 0,
    pendingAccountAcks: 0,
  };
  writeFileSync(join(workDir, 'hlt-rust-h1-live.json'), `${safeStringify(result, 2)}\n`);
  console.log(`HLT_RUST_LIVE_OK listen=${h1.ready.listen} runtimeId=${h1.ready.runtimeId} lanes=${String(lanes.length)}`);
  console.log(
    'HLT_RUST_LIVE_PAYMENT_STAGE_BLOCKED: lane host outbound peering must dial ' +
    `ws://${h1.ready.listen} for the user Runtimes before a payment can traverse ` +
    'the encrypted socket into the Rust H1; no payment is claimed.',
  );
  await h1.stop();
} finally {
  await stopLaneRuntimes(lanes);
}
