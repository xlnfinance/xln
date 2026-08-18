/**
 * One isolated Runtime process per load user.
 *
 * Production users never share a Runtime: every maker and taker owns its own
 * process, seed, key store, database and relay session, and every bilateral
 * message to the Hub crosses the real P2P/relay path with signatures and
 * encryption. Hosting fifty lane Entities inside one Custody Runtime measured
 * that Runtime's frame time, not the Hub's, so the harness spawns exactly one
 * `core/api/server/index.ts` daemon per lane and drives each through its
 * own authenticated adapter.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveRuntimeAdapterCapabilityToken } from '../../../../api/runtime-adapter/security/auth';
import {
  DaemonControlClient,
  type ManagedEntityIdentity,
} from '../../../../orchestrator/daemon-control';
import {
  isPublicDaemonHealthReady,
  spawnBunChild,
  stopManagedChild,
  waitForHttpReady,
  type ManagedChild,
} from '../../../../orchestrator/bootstrap/custody-bootstrap';
import { safeStringify } from '../../../../protocol/serialization';
import { connectRuntime, type ConnectedRuntime } from '../worker-runtime';

export type LaneRuntime = Readonly<{
  identity: ManagedEntityIdentity;
  port: number;
  child: ManagedChild;
  control: DaemonControlClient;
  runtime: ConnectedRuntime;
  relayUrl: string;
}>;

/** Lane daemons live outside the 20-port smoke slot: 200 ports per slot from 21000. */
export const laneRuntimePortBase = (portBase: number): number => 21_000 + Math.floor((portBase - 20_000) / 20) * 200;

const SPAWN_CONCURRENCY = 16;
const READY_TIMEOUT_MS = 180_000;

const resolveJurisdictionKey = (path: string): string => {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { jurisdictions?: Record<string, { chainId?: number }> };
  const entries = Object.entries(parsed.jurisdictions ?? {});
  const primary = entries.find(([, value]) => value.chainId === 31_337) ?? entries[0];
  if (!primary) throw new Error('PRODUCTION_SWAP_LOAD_JURISDICTION_KEY_MISSING');
  return primary[0];
};

const spawnLaneRuntime = async (options: {
  workDir: string;
  portBase: number;
  identity: ManagedEntityIdentity;
  laneSeed: string;
  laneIndex: number;
  jurisdictionsPath: string;
  jurisdictionKey: string;
}): Promise<LaneRuntime> => {
  const port = laneRuntimePortBase(options.portBase) + options.laneIndex;
  const rpcUrl = `http://127.0.0.1:${options.portBase}`;
  const relayUrl = `ws://127.0.0.1:${options.portBase + 4}/relay`;
  const authSeed = randomBytes(32).toString('hex');
  const audience = `load-lane-${port}`;
  const dbRoot = join(options.workDir, 'prod-mesh', 'load-lanes', `lane-${String(options.laneIndex).padStart(4, '0')}`);
  const child = spawnBunChild(
    `load-lane-${options.laneIndex}`,
    ['core/api/server/index.ts', '--port', String(port), '--host', '127.0.0.1', '--server-id', `load-lane-${port}`],
    {
      USE_ANVIL: 'true',
      XLN_USE_PREDEPLOYED_ADDRESSES: 'true',
      XLN_PREDEPLOYED_JURISDICTION_KEY: options.jurisdictionKey,
      BOOTSTRAP_LOCAL_HUBS: '0',
      XLN_SKIP_SERVER_BOOTSTRAP: '1',
      XLN_EARLY_HTTP_BIND: '1',
      XLN_RADAPTER_AUTH_SEED: authSeed,
      XLN_RADAPTER_AUDIENCE: audience,
      XLN_RADAPTER_REQUIRE_STRONG_AUTH_SEED: '1',
      ANVIL_RPC: rpcUrl,
      PUBLIC_RPC: rpcUrl,
      RELAY_URL: relayUrl,
      XLN_RUNTIME_SEED: `${options.laneSeed}:runtime`,
      XLN_DB_PATH: join(dbRoot, 'db'),
      // Storage health state is per process; fifty daemons must not share one file.
      XLN_RDB_ROOT: dbRoot,
      XLN_STORAGE_HISTORY_PATH: join(dbRoot, 'storage-health-history.json'),
      XLN_JURISDICTIONS_PATH: options.jurisdictionsPath,
      XLN_LOG_LEVEL: process.env['XLN_LOAD_LANE_LOG_LEVEL'] || 'warn',
      // The load worker is the only client of these loopback daemons and polls
      // settlement evidence from every lane concurrently; the public per-client
      // budget would rate-limit the harness itself, not the system under test.
      XLN_RADAPTER_SEND_BURST: '200',
      XLN_RADAPTER_SEND_PER_SEC: '100',
      XLN_RADAPTER_READ_BURST: '200',
      XLN_RADAPTER_READ_PER_SEC: '100',
      XLN_RADAPTER_CONTROL_BURST: '200',
      XLN_RADAPTER_CONTROL_PER_SEC: '100',
    },
    { startupSignersJson: safeStringify([{ seed: options.laneSeed, label: 'owner' }]) },
  );
  const token = deriveRuntimeAdapterCapabilityToken(authSeed, 'full', Date.now() + 60 * 60_000, {
    audience,
    keyId: 'load-lane',
    tokenId: randomBytes(16).toString('hex'),
  });
  await waitForHttpReady(
    `http://127.0.0.1:${port}/api/health`,
    child,
    READY_TIMEOUT_MS,
    (_response, bodyText) => {
      try { return isPublicDaemonHealthReady(JSON.parse(bodyText)); } catch { return false; }
    },
  );
  const control = new DaemonControlClient({ baseUrl: `http://127.0.0.1:${port}`, authKey: token, timeoutMs: 30_000 });
  const runtime = await connectRuntime(
    { label: `load-lane-${options.laneIndex}`, wsUrl: `ws://127.0.0.1:${port}/rpc`, token },
  );
  return { identity: options.identity, port, child, control, runtime, relayUrl };
};

/** Spawn one daemon per identity; `laneIndexOffset` keeps maker/taker ports disjoint. */
export const spawnLaneRuntimes = async (options: {
  workDir: string;
  portBase: number;
  identities: readonly ManagedEntityIdentity[];
  laneSeeds: readonly string[];
  laneIndexOffset: number;
}): Promise<LaneRuntime[]> => {
  const jurisdictionsPath = join(options.workDir, 'prod-mesh', 'custody', 'jurisdictions.json');
  const jurisdictionKey = resolveJurisdictionKey(jurisdictionsPath);
  const lanes: LaneRuntime[] = [];
  try {
    for (let offset = 0; offset < options.identities.length; offset += SPAWN_CONCURRENCY) {
      const batch = options.identities.slice(offset, offset + SPAWN_CONCURRENCY);
      lanes.push(...await Promise.all(batch.map((identity, index) => spawnLaneRuntime({
        workDir: options.workDir,
        portBase: options.portBase,
        identity,
        laneSeed: options.laneSeeds[offset + index]!,
        laneIndex: options.laneIndexOffset + offset + index,
        jurisdictionsPath,
        jurisdictionKey,
      }))));
    }
    return lanes;
  } catch (error) {
    await stopLaneRuntimes(lanes);
    throw error;
  }
};

export const stopLaneRuntimes = async (lanes: readonly LaneRuntime[]): Promise<void> => {
  for (const lane of lanes) lane.runtime.adapter.disconnect();
  await Promise.allSettled(lanes.map(lane => stopManagedChild(lane.child)));
};
