/**
 * Sovereign load-user Runtimes.
 *
 * Every user owns a unique RuntimeReplica, runtimeId, signer scope, WAL,
 * queues and P2P relay session. Several replicas may share one Bun process and
 * listener; no Runtime, Entity, Account or transport state is shared.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { deriveRuntimeAdapterCapabilityToken } from '../../../../api/runtime-adapter/security/auth';
import { resolveJurisdictionsJsonPath } from '../../../../jurisdiction/adapter/jurisdictions-path';
import type { ManagedEntityIdentity } from '../../../../orchestrator/daemon-control';
import {
  spawnBunChild,
  stopManagedChild,
  waitForHttpReady,
  type ManagedChild,
} from '../../../../orchestrator/bootstrap/custody-bootstrap';
import {
  deserializeTaggedJson,
  safeStringify,
  serializeTaggedJson,
} from '../../../../protocol/serialization';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';
import { deriveRuntimeIdFromSeed } from '../../../../storage/runtime-dbs';
import type { RuntimeInput } from '../../../../runtime/types';
import { connectRuntime, type ConnectedRuntime } from '../worker-runtime';

export type LaneRuntimeHostIngress = Readonly<{
  authKey: string;
  baseUrl: string;
  id: string;
}>;

export type LaneRuntime = Readonly<{
  identity: ManagedEntityIdentity;
  laneKey: string;
  port: number;
  child: ManagedChild;
  runtime: ConnectedRuntime;
  runtimeId: string;
  relayUrl: string;
  hostIngress: LaneRuntimeHostIngress;
  /** A sovereign user Runtime owns exactly one user Entity. */
  hostedEntityIds: readonly [string];
}>;

export type LaneRuntimeInputSubmission = Readonly<{
  input: RuntimeInput;
  lane: LaneRuntime;
}>;

const postHostRuntimeInputBatch = async (
  host: LaneRuntimeHostIngress,
  wave: number,
  entries: ReadonlyArray<Readonly<{ runtimeId: string; input: RuntimeInput }>>,
): Promise<void> => {
  const payload = { wave, entries };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`HLT host batch timed out: ${host.id}:${wave}`), 30_000);
  try {
    const response = await fetch(`${host.baseUrl}/api/hlt/runtime-input-batch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${host.authKey}`,
        'content-type': 'application/json',
      },
      body: serializeTaggedJson(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    const decoded = requireBoundaryRecord(
      raw.trim() ? deserializeTaggedJson(raw) : {},
      'HLT_HOST_RUNTIME_INPUT_BATCH_RESPONSE_INVALID',
    );
    if (!response.ok) {
      throw new Error(
        `HLT_HOST_RUNTIME_INPUT_BATCH_REJECTED:status=${response.status}:body=${safeStringify(decoded)}`,
      );
    }
    requireExactBoundaryKeys(
      decoded,
      ['ok', 'wave', 'accepted'],
      [],
      'HLT_HOST_RUNTIME_INPUT_BATCH_RESPONSE_FIELDS_INVALID',
    );
    const accepted = requireBoundaryInteger(
      decoded['accepted'],
      'HLT_HOST_RUNTIME_INPUT_BATCH_RESPONSE_ACCEPTED_INVALID',
    );
    const acceptedWave = requireBoundaryInteger(
      decoded['wave'],
      'HLT_HOST_RUNTIME_INPUT_BATCH_RESPONSE_WAVE_INVALID',
    );
    if (decoded['ok'] !== true || acceptedWave !== wave || accepted !== entries.length) {
      throw new Error(
        `HLT_HOST_RUNTIME_INPUT_BATCH_RESPONSE_MISMATCH:${safeStringify(decoded)}`,
      );
    }
  } catch (error) {
    // Never retry an ambiguous queue admission. The HLT stops with the exact
    // host, wave and input dump; a fresh run starts from a fresh Runtime/WAL.
    throw new Error(
      `HLT_HOST_RUNTIME_INPUT_BATCH_TRANSPORT_FAILED:host=${host.id}:wave=${wave}:` +
      `payload=${safeStringify(payload)}:cause=${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
};

/** One authenticated transport write per OS host; every target Runtime stays sovereign. */
export const queueLaneRuntimeInputWave = async (
  wave: number,
  submissions: readonly LaneRuntimeInputSubmission[],
): Promise<void> => {
  if (!Number.isSafeInteger(wave) || wave < 0) throw new Error(`HLT_RUNTIME_INPUT_WAVE_INVALID:${wave}`);
  if (submissions.length < 1) throw new Error('HLT_RUNTIME_INPUT_WAVE_EMPTY');
  const seenRuntimeIds = new Set<string>();
  const groups = new Map<string, {
    host: LaneRuntimeHostIngress;
    entries: Array<Readonly<{ runtimeId: string; input: RuntimeInput }>>;
  }>();
  for (const { lane, input } of submissions) {
    if (seenRuntimeIds.has(lane.runtimeId)) {
      throw new Error(`HLT_RUNTIME_INPUT_WAVE_RUNTIME_DUPLICATE:${lane.runtimeId}`);
    }
    seenRuntimeIds.add(lane.runtimeId);
    const group = groups.get(lane.hostIngress.id) ?? { host: lane.hostIngress, entries: [] };
    group.entries.push({ runtimeId: lane.runtimeId, input });
    groups.set(lane.hostIngress.id, group);
  }
  await Promise.all([...groups.values()].map(group =>
    postHostRuntimeInputBatch(group.host, wave, group.entries)));
};

const RUNTIMES_PER_PROCESS = (() => {
  const raw = process.env['XLN_HLT_RUNTIMES_PER_PROCESS'];
  if (!raw) return 200;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error(`HLT_RUNTIMES_PER_PROCESS_INVALID:${raw}`);
  }
  return value;
})();

export const LANE_PORTS_PER_SLOT = 4_096;
const LANE_PORT_FLOOR = 21_000;
const MAX_TCP_PORT = 65_535;

export const laneRuntimePortBase = (portBase: number): number =>
  LANE_PORT_FLOOR + Math.floor((portBase - 20_000) / 20) * LANE_PORTS_PER_SLOT;

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

const SPAWN_CONCURRENCY = Math.max(
  4,
  Math.min(32, Number(process.env['XLN_HLT_SPAWN_CONCURRENCY'] || '') || cpus().length),
);
const READY_TIMEOUT_MS = 180_000;

const spawnSovereignRuntimeHost = async (options: {
  workDir: string;
  portBase: number;
  identities: readonly ManagedEntityIdentity[];
  laneSeeds: readonly string[];
  laneIndex: number;
}): Promise<LaneRuntime[]> => {
  const firstPort = laneRuntimePort(options.portBase, options.laneIndex);
  const relayUrl = `ws://127.0.0.1:${options.portBase + 4}/relay`;
  const authSeed = randomBytes(32).toString('hex');
  const dbRoot = join(
    options.workDir,
    'prod-mesh',
    'load-lanes',
    `host-${String(options.laneIndex).padStart(4, '0')}`,
  );
  const meshJurisdictionsPath = join(options.workDir, 'prod-mesh', 'custody', 'jurisdictions.json');
  const jurisdictionsPath = existsSync(meshJurisdictionsPath)
    ? meshJurisdictionsPath
    : resolveJurisdictionsJsonPath();
  mkdirSync(dbRoot, { recursive: true });
  const child = spawnBunChild(
    `load-host-${options.laneIndex}`,
    ['core/scripts/operations/hlt/lanes/sovereign-runtime-host.ts', '--first-port', String(firstPort)],
    {
      XLN_RADAPTER_REQUIRE_STRONG_AUTH_SEED: '1',
      XLN_DB_PATH: join(dbRoot, 'db'),
      XLN_RDB_ROOT: dbRoot,
      XLN_STORAGE_HISTORY_PATH: join(dbRoot, 'storage-health-history.json'),
      XLN_JURISDICTIONS_PATH: jurisdictionsPath,
      XLN_LOG_LEVEL: process.env['XLN_LOAD_LANE_LOG_LEVEL'] || 'warn',
      ...(process.env['XLN_HEAVY_LOGS'] ? { XLN_HEAVY_LOGS: '1' } : {}),
      ...(process.env['XLN_RUNTIME_FRAME_LOG'] ? { XLN_RUNTIME_FRAME_LOG: '1' } : {}),
      ...(process.env['XLN_RUNTIME_APPLY_PROFILE'] ? { XLN_RUNTIME_APPLY_PROFILE: '1' } : {}),
      ...(process.env['XLN_HLT_LANE_MAX_ENTITY_INPUTS_PER_FRAME']
        ? { XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME: process.env['XLN_HLT_LANE_MAX_ENTITY_INPUTS_PER_FRAME'] }
        : {}),
      XLN_RADAPTER_SEND_BURST: '200',
      XLN_RADAPTER_SEND_PER_SEC: '100',
      XLN_RADAPTER_READ_BURST: '200',
      XLN_RADAPTER_READ_PER_SEC: '100',
      XLN_RADAPTER_CONTROL_BURST: '200',
      XLN_RADAPTER_CONTROL_PER_SEC: '100',
      XLN_GOSSIP_PROFILE_LOOKUP_PER_CLIENT_LIMIT: String(
        Math.max(64, Number(process.env['XLN_HLT_USERS'] || '0') || 64),
      ),
      XLN_GOSSIP_PROFILE_LOOKUP_GLOBAL_LIMIT: String(
        Math.max(1_000, (Number(process.env['XLN_HLT_USERS'] || '0') || 64) * 4),
      ),
    },
    { authSeed, laneSeedsJson: safeStringify(options.laneSeeds), relayUrl },
  );
  const daemonLog = createWriteStream(join(dbRoot, 'daemon.log'), { flags: 'a' });
  child.proc.stdout.on('data', (chunk: Buffer) => daemonLog.write(chunk));
  child.proc.stderr.on('data', (chunk: Buffer) => daemonLog.write(chunk));
  await waitForHttpReady(
    `http://127.0.0.1:${firstPort}/health`,
    child,
    READY_TIMEOUT_MS,
    (_response, bodyText) => {
      try {
        const body = JSON.parse(bodyText) as { ready?: unknown; runtimes?: unknown; expected?: unknown };
        return body.ready === true && body.runtimes === options.identities.length && body.expected === options.identities.length;
      } catch {
        return false;
      }
    },
  );
  const firstRuntimeId = deriveRuntimeIdFromSeed(`${options.laneSeeds[0]!}:runtime`);
  if (!firstRuntimeId) throw new Error('HLT_SOVEREIGN_HOST_FIRST_RUNTIME_ID_MISSING');
  const hostIngress: LaneRuntimeHostIngress = {
    id: `${child.name}:${firstRuntimeId}`,
    baseUrl: `http://127.0.0.1:${firstPort}`,
    authKey: deriveRuntimeAdapterCapabilityToken(authSeed, 'full', Date.now() + 60 * 60_000, {
      audience: firstRuntimeId,
      keyId: 'load-host-batch',
      tokenId: randomBytes(16).toString('hex'),
    }),
  };
  return Promise.all(options.identities.map(async (identity, index) => {
    const port = firstPort + index;
    const runtimeId = deriveRuntimeIdFromSeed(`${options.laneSeeds[index]!}:runtime`);
    if (!runtimeId) throw new Error(`HLT_SOVEREIGN_RUNTIME_ID_MISSING:${index}`);
    const token = deriveRuntimeAdapterCapabilityToken(authSeed, 'full', Date.now() + 60 * 60_000, {
      audience: runtimeId,
      keyId: 'load-lane',
      tokenId: randomBytes(16).toString('hex'),
    });
    const runtime = await connectRuntime({
      label: `load-runtime-${options.laneIndex}-${index}`,
      wsUrl: `ws://127.0.0.1:${port}/rpc`,
      token,
    });
    return {
      identity,
      laneKey: `${runtimeId}-${identity.entityId.slice(-8)}`,
      port,
      child,
      runtime,
      runtimeId,
      relayUrl,
      hostIngress,
      hostedEntityIds: [identity.entityId],
    };
  }));
};

export const spawnLaneRuntimes = async (options: {
  workDir: string;
  portBase: number;
  identities: readonly ManagedEntityIdentity[];
  laneSeeds: readonly string[];
  laneIndexOffset: number;
}): Promise<LaneRuntime[]> => {
  if (options.laneSeeds.length !== options.identities.length) {
    throw new Error('HLT_LANE_SEED_CARDINALITY_INVALID');
  }
  const groups: Array<{ start: number; identities: ManagedEntityIdentity[]; seeds: string[] }> = [];
  for (let start = 0; start < options.identities.length; start += RUNTIMES_PER_PROCESS) {
    groups.push({
      start,
      identities: [...options.identities.slice(start, start + RUNTIMES_PER_PROCESS)],
      seeds: [...options.laneSeeds.slice(start, start + RUNTIMES_PER_PROCESS)],
    });
  }
  const lanes: LaneRuntime[] = [];
  try {
    for (let offset = 0; offset < groups.length; offset += SPAWN_CONCURRENCY) {
      const spawned = await Promise.all(groups.slice(offset, offset + SPAWN_CONCURRENCY).map(group =>
        spawnSovereignRuntimeHost({
          workDir: options.workDir,
          portBase: options.portBase,
          identities: group.identities,
          laneSeeds: group.seeds,
          laneIndex: options.laneIndexOffset + group.start,
        })));
      lanes.push(...spawned.flat());
    }
    return lanes;
  } catch (error) {
    await stopLaneRuntimes(lanes);
    throw error;
  }
};

/** Distinct OS processes behind a sovereign Runtime list. */
export const laneDaemons = (lanes: readonly LaneRuntime[]): LaneRuntime[] => {
  const seen = new Set<ManagedChild>();
  return lanes.filter(lane => {
    if (seen.has(lane.child)) return false;
    seen.add(lane.child);
    return true;
  });
};

export const stopLaneRuntimes = async (lanes: readonly LaneRuntime[]): Promise<void> => {
  for (const lane of lanes) lane.runtime.adapter.disconnect();
  await Promise.allSettled(laneDaemons(lanes).map(lane => stopManagedChild(lane.child)));
};
