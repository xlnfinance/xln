/**
 * Load user Runtimes.
 *
 * By default every maker and taker owns its own `core/api/server/index.ts`
 * daemon: its own seed, key store, database and relay session, so every
 * bilateral message to the Hub crosses the real P2P/relay path with signatures
 * and encryption. That process-per-user shape costs a fixed ~0.2 core of
 * ambient work per user (adapter polling, gossip, J watcher, parent watch) and
 * caps a stand at a few hundred users.
 *
 * `XLN_HLT_USERS_PER_RUNTIME=N` hosts N user Entities in one daemon instead —
 * the custody shape: one Runtime, one WAL, one relay session, many hosted
 * Entities with their own signers. Each user still keeps its own identity and
 * Account with the Hub; only the process boundary between users disappears.
 * A `LaneRuntime` is still one user; lanes of one daemon share `child`,
 * `control` and `runtime` and list each other in `hostedEntityIds`.
 */

import { randomBytes } from 'node:crypto';
import { cpus } from 'node:os';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
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
  /** Unique per user even when several users share one daemon port. */
  laneKey: string;
  port: number;
  child: ManagedChild;
  control: DaemonControlClient;
  runtime: ConnectedRuntime;
  relayUrl: string;
  /** Every user Entity hosted by this lane's daemon, this one included. */
  hostedEntityIds: readonly string[];
}>;

const USERS_PER_RUNTIME = (() => {
  const raw = process.env['XLN_HLT_USERS_PER_RUNTIME'];
  if (!raw) return 1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 4_096) {
    throw new Error(`HLT_USERS_PER_RUNTIME_INVALID:${raw}`);
  }
  return value;
})();

/**
 * Lane daemons live outside the 20-port smoke slot. One slot reserves enough
 * ports for a four-figure population, because the harness spawns one daemon
 * per user and a ladder keeps adding lanes on top of the previous stage.
 */
export const LANE_PORTS_PER_SLOT = 4_096;
const LANE_PORT_FLOOR = 21_000;
const MAX_TCP_PORT = 65_535;

export const laneRuntimePortBase = (portBase: number): number =>
  LANE_PORT_FLOOR + Math.floor((portBase - 20_000) / 20) * LANE_PORTS_PER_SLOT;

/**
 * A port that silently wraps past the TCP range would bind some unrelated
 * listener instead of failing, so the arithmetic is checked at the call site.
 */
export const laneRuntimePort = (portBase: number, laneIndex: number): number => {
  if (!Number.isSafeInteger(laneIndex) || laneIndex < 0) {
    throw new Error(`HLT_LANE_INDEX_INVALID:${laneIndex}`);
  }
  if (laneIndex >= LANE_PORTS_PER_SLOT) {
    throw new Error(`HLT_LANE_INDEX_EXCEEDS_SLOT:${laneIndex}:${LANE_PORTS_PER_SLOT}`);
  }
  const port = laneRuntimePortBase(portBase) + laneIndex;
  if (port > MAX_TCP_PORT) throw new Error(`HLT_LANE_PORT_OUT_OF_RANGE:${port}`);
  return port;
};

/**
 * Daemon startup is dominated by waiting on health, not by CPU, so the spawn
 * fan-out is wider than the core count. It stays bounded because a thousand
 * simultaneous LevelDB opens would fail on file descriptors, not on time.
 */
const SPAWN_CONCURRENCY = Math.max(
  8,
  Math.min(
    128,
    Number(process.env['XLN_HLT_SPAWN_CONCURRENCY'] || '') || cpus().length * 2,
  ),
);
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
  identities: readonly ManagedEntityIdentity[];
  laneSeeds: readonly string[];
  laneIndex: number;
  jurisdictionsPath: string;
  jurisdictionKey: string;
}): Promise<LaneRuntime[]> => {
  const port = laneRuntimePort(options.portBase, options.laneIndex);
  const runtimeSeed = options.laneSeeds[0]!;
  const rpcUrl = `http://127.0.0.1:${options.portBase}`;
  const relayUrl = `ws://127.0.0.1:${options.portBase + 4}/relay`;
  const authSeed = randomBytes(32).toString('hex');
  const audience = `load-lane-${port}`;
  const dbRoot = join(options.workDir, 'prod-mesh', 'load-lanes', `lane-${String(options.laneIndex).padStart(4, '0')}`);
  mkdirSync(dbRoot, { recursive: true });
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
      XLN_RUNTIME_SEED: `${runtimeSeed}:runtime`,
      XLN_DB_PATH: join(dbRoot, 'db'),
      // Storage health state is per process; fifty daemons must not share one file.
      XLN_RDB_ROOT: dbRoot,
      XLN_STORAGE_HISTORY_PATH: join(dbRoot, 'storage-health-history.json'),
      XLN_JURISDICTIONS_PATH: options.jurisdictionsPath,
      XLN_LOG_LEVEL: process.env['XLN_LOAD_LANE_LOG_LEVEL'] || 'warn',
      // Profiling flags are opt-in on the parent and must reach the lane, or a
      // per-user frame profile can only ever be measured on the mesh daemons.
      ...(process.env['XLN_RUNTIME_FRAME_LOG'] ? { XLN_RUNTIME_FRAME_LOG: '1' } : {}),
      ...(process.env['XLN_RUNTIME_APPLY_PROFILE'] ? { XLN_RUNTIME_APPLY_PROFILE: '1' } : {}),
      // Unbounded by default: a runtime frame must absorb every queued input at
      // once (10k+); set XLN_HLT_LANE_MAX_ENTITY_INPUTS_PER_FRAME only for experiments.
      ...(process.env['XLN_HLT_LANE_MAX_ENTITY_INPUTS_PER_FRAME']
        ? { XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME: process.env['XLN_HLT_LANE_MAX_ENTITY_INPUTS_PER_FRAME'] }
        : {}),
      // The load worker is the only client of these loopback daemons and polls
      // settlement evidence from every lane concurrently; the public per-client
      // budget would rate-limit the harness itself, not the system under test.
      XLN_RADAPTER_SEND_BURST: String(200 * options.identities.length),
      XLN_RADAPTER_SEND_PER_SEC: String(100 * options.identities.length),
      XLN_RADAPTER_READ_BURST: String(200 * options.identities.length),
      XLN_RADAPTER_READ_PER_SEC: String(100 * options.identities.length),
      XLN_RADAPTER_CONTROL_BURST: String(200 * options.identities.length),
      XLN_RADAPTER_CONTROL_PER_SEC: String(100 * options.identities.length),
      // Same budget hlt-run.ts gives the mesh: a 1000-user barrier asks each
      // daemon about every receiver, and the default 30 lookups / 60s 429s
      // the worker (1000b: GOSSIP_PROFILE_LOOKUP_RATE_LIMITED).
      XLN_GOSSIP_PROFILE_LOOKUP_PER_CLIENT_LIMIT: String(Math.max(64, Number(process.env['XLN_HLT_USERS'] || '0') || 64)),
      XLN_GOSSIP_PROFILE_LOOKUP_GLOBAL_LIMIT: String(Math.max(1_000, (Number(process.env['XLN_HLT_USERS'] || '0') || 64) * 4)),
    },
    {
      startupSignersJson: safeStringify(
        options.laneSeeds.map((seed, index) => ({ seed, label: index === 0 ? 'owner' : `owner-${index}` })),
      ),
    },
  );
  // A lane daemon that halts mid-run is otherwise silent: spawnBunChild keeps
  // only a bounded in-memory tail that is surfaced on startup failure. A load
  // run that dies at round fifty needs that daemon's own log on disk.
  const daemonLog = createWriteStream(join(dbRoot, 'daemon.log'), { flags: 'a' });
  child.proc.stdout.on('data', (chunk: Buffer) => daemonLog.write(chunk));
  child.proc.stderr.on('data', (chunk: Buffer) => daemonLog.write(chunk));
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
  const hostedEntityIds = options.identities.map(identity => identity.entityId);
  // Adapter commands are sequenced per capability lane (keyId, tokenId). Users
  // sharing one daemon submit rounds concurrently, so each user gets its own
  // token and connection: an own command lane, exactly as in its own process.
  return Promise.all(options.identities.map(async (identity, index) => {
    const userToken = index === 0
      ? token
      : deriveRuntimeAdapterCapabilityToken(authSeed, 'full', Date.now() + 60 * 60_000, {
          audience,
          keyId: 'load-lane',
          tokenId: randomBytes(16).toString('hex'),
        });
    const runtime = await connectRuntime({
      label: `load-lane-${options.laneIndex + index}`,
      wsUrl: `ws://127.0.0.1:${port}/rpc`,
      token: userToken,
    });
    return {
      identity,
      laneKey: `${port}-${identity.entityId.slice(-8)}`,
      port,
      child,
      control,
      runtime,
      relayUrl,
      hostedEntityIds,
    };
  }));
};

/**
 * Spawn the user daemons; `laneIndexOffset` keeps maker/taker ports disjoint.
 * With `XLN_HLT_USERS_PER_RUNTIME=N` every daemon hosts N consecutive users;
 * daemon k of a role takes the port slot of that role's lane `k * N`, so the
 * two roles' slots stay disjoint exactly as they do one-per-user.
 */
export const spawnLaneRuntimes = async (options: {
  workDir: string;
  portBase: number;
  identities: readonly ManagedEntityIdentity[];
  laneSeeds: readonly string[];
  laneIndexOffset: number;
}): Promise<LaneRuntime[]> => {
  const jurisdictionsPath = join(options.workDir, 'prod-mesh', 'custody', 'jurisdictions.json');
  const jurisdictionKey = resolveJurisdictionKey(jurisdictionsPath);
  if (options.laneSeeds.length !== options.identities.length) {
    throw new Error('HLT_LANE_SEED_CARDINALITY_INVALID');
  }
  const groups: Array<{ start: number; identities: ManagedEntityIdentity[]; seeds: string[] }> = [];
  for (let start = 0; start < options.identities.length; start += USERS_PER_RUNTIME) {
    groups.push({
      start,
      identities: [...options.identities.slice(start, start + USERS_PER_RUNTIME)],
      seeds: [...options.laneSeeds.slice(start, start + USERS_PER_RUNTIME)],
    });
  }
  const lanes: LaneRuntime[] = [];
  try {
    for (let offset = 0; offset < groups.length; offset += SPAWN_CONCURRENCY) {
      const batch = groups.slice(offset, offset + SPAWN_CONCURRENCY);
      const spawned = await Promise.all(batch.map(group => spawnLaneRuntime({
        workDir: options.workDir,
        portBase: options.portBase,
        identities: group.identities,
        laneSeeds: group.seeds,
        laneIndex: options.laneIndexOffset + group.start,
        jurisdictionsPath,
        jurisdictionKey,
      })));
      lanes.push(...spawned.flat());
    }
    return lanes;
  } catch (error) {
    await stopLaneRuntimes(lanes);
    throw error;
  }
};

/** Distinct daemons behind a lane list (several lanes may share one). */
export const laneDaemons = (lanes: readonly LaneRuntime[]): LaneRuntime[] => {
  const seen = new Set<ManagedChild>();
  const daemons: LaneRuntime[] = [];
  for (const lane of lanes) {
    if (seen.has(lane.child)) continue;
    seen.add(lane.child);
    daemons.push(lane);
  }
  return daemons;
};

export const stopLaneRuntimes = async (lanes: readonly LaneRuntime[]): Promise<void> => {
  for (const lane of lanes) lane.runtime.adapter.disconnect();
  await Promise.allSettled(laneDaemons(lanes).map(lane => stopManagedChild(lane.child)));
};
