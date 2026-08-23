/**
 * Sovereign load-user Runtimes.
 *
 * Every user owns a unique RuntimeReplica, runtimeId, signer scope, WAL,
 * queues and P2P relay session. Several replicas may share one Bun process and
 * listener; no Runtime, Entity, Account or transport state is shared.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
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
import {
  assertSocketCounterCoverage,
  summarizeHltIoCounters,
  type HltOpCounter,
  connectRuntime,
  decodeHltOpCounterSnapshot,
  type ConnectedRuntime,
} from '../worker-runtime';
import { sovereignRuntimeWorkerStart } from './sovereign-runtime-sharding';

export type LaneRuntimeHostIngress = Readonly<{
  authKey: string;
  baseUrl: string;
  id: string;
  sequence: { nextWave: number };
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
  await Promise.all([...groups.values()].map(group => {
    // Sequence is host-local because a fresh sovereign host starts at wave 0.
    // Allocation happens synchronously before I/O, so concurrent open-loop
    // callers retain deterministic admission order without setup-specific
    // offsets or a second ingress path.
    const hostWave = group.host.sequence.nextWave;
    group.host.sequence.nextWave += 1;
    return postHostRuntimeInputBatch(group.host, hostWave, group.entries);
  }));
};

/** Reset optional process counters after setup so reports cover economic work only. */
export const resetLaneHostOpCounters = async (lanes: readonly LaneRuntime[]): Promise<void> => {
  const hosts = new Map(lanes.map(lane => [lane.hostIngress.id, lane.hostIngress]));
  await Promise.all([...hosts.values()].map(async host => {
    const response = await fetch(`${host.baseUrl}/api/hlt/op-counters/reset`, {
      method: 'POST',
      headers: { authorization: `Bearer ${host.authKey}` },
    });
    const raw = await response.text();
    const decoded = requireBoundaryRecord(
      raw.trim() ? deserializeTaggedJson(raw) : {},
      'HLT_HOST_OP_COUNTER_RESET_RESPONSE_INVALID',
    );
    requireExactBoundaryKeys(decoded, ['ok'], [], 'HLT_HOST_OP_COUNTER_RESET_RESPONSE_FIELDS_INVALID');
    if (!response.ok || decoded['ok'] !== true) {
      throw new Error(`HLT_HOST_OP_COUNTER_RESET_FAILED:host=${host.id}:body=${safeStringify(decoded)}`);
    }
  }));
};

export const assertLaneHostSocketCounterCoverage = async (
  lanes: readonly LaneRuntime[],
): Promise<Readonly<Record<string, Readonly<Record<string, HltOpCounter>>>>> => {
  const hosts = new Map(lanes.map(lane => [lane.hostIngress.id, lane.hostIngress]));
  const snapshots = await Promise.all([...hosts.values()].map(async host => {
    const response = await fetch(`${host.baseUrl}/api/hlt/op-counters`, {
      headers: { authorization: `Bearer ${host.authKey}` },
    });
    const raw = await response.text();
    const decoded = raw.trim() ? deserializeTaggedJson(raw) : {};
    if (!response.ok) throw new Error(`HLT_HOST_OP_COUNTER_SNAPSHOT_FAILED:host=${host.id}:status=${response.status}`);
    const counters = decodeHltOpCounterSnapshot(decoded, host.id);
    assertSocketCounterCoverage(counters, host.id);
    return [host.id, summarizeHltIoCounters(counters)] as const;
  }));
  return Object.fromEntries(snapshots);
};

const readHostReadiness = async (
  host: LaneRuntimeHostIngress,
  runtimeIds: readonly string[],
  hubEntityId: string,
  hubRuntimeId: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  const response = await fetch(`${host.baseUrl}/api/hlt/readiness`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.authKey}`,
      'content-type': 'application/json',
    },
    body: serializeTaggedJson({ hubEntityId, hubRuntimeId, runtimeIds }),
    ...(signal ? { signal } : {}),
  });
  const raw = await response.text();
  const decoded = requireBoundaryRecord(
    raw.trim() ? deserializeTaggedJson(raw) : {},
    'HLT_HOST_READINESS_RESPONSE_INVALID',
  );
  if (!response.ok) {
    throw new Error(`HLT_HOST_READINESS_REJECTED:host=${host.id}:status=${response.status}:body=${safeStringify(decoded)}`);
  }
  requireExactBoundaryKeys(decoded, ['ok', 'ready', 'missing'], [], 'HLT_HOST_READINESS_RESPONSE_FIELDS_INVALID');
  if (decoded['ok'] !== true || typeof decoded['ready'] !== 'boolean' || !Array.isArray(decoded['missing'])) {
    throw new Error(`HLT_HOST_READINESS_RESPONSE_INVALID:host=${host.id}`);
  }
  const missing = decoded['missing'].map(value => String(value).trim().toLowerCase());
  if (missing.some(runtimeId => !/^0x[0-9a-f]{40}$/.test(runtimeId))) {
    throw new Error(`HLT_HOST_READINESS_MISSING_INVALID:host=${host.id}`);
  }
  return missing;
};

/** Five host-wide polls for 1,000 users; no per-port HTTP readiness storm. */
export const waitForLaneHostReadiness = async (
  lanes: readonly LaneRuntime[],
  hubEntityId: string,
  hubRuntimeId: string,
  timeoutMs: number,
): Promise<void> => {
  const groups = new Map<string, { host: LaneRuntimeHostIngress; runtimeIds: string[] }>();
  for (const lane of lanes) {
    const group = groups.get(lane.hostIngress.id) ?? { host: lane.hostIngress, runtimeIds: [] };
    group.runtimeIds.push(lane.runtimeId);
    groups.set(lane.hostIngress.id, group);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('HLT_HOST_READINESS_TIMEOUT'), timeoutMs);
  try {
    const missing = (await Promise.all([...groups.values()].map(group => readHostReadiness(
      group.host,
      group.runtimeIds,
      hubEntityId,
      hubRuntimeId,
      controller.signal,
    )))).flat();
    if (missing.length > 0) {
      throw new Error(`HLT_HOST_READINESS_INCOMPLETE:missing=${missing.length}:runtimeIds=${missing.join(',')}`);
    }
  } finally {
    clearTimeout(timer);
  }
};

export type LaneFinancialReadinessTarget = Readonly<{
  lane: LaneRuntime;
  hubEntityId: string;
  windows: readonly Readonly<{ tokenId: number; minimum: bigint }>[];
}>;

export const waitForLaneFinancialReadiness = async (
  targets: readonly LaneFinancialReadinessTarget[],
  perspective: 'user' | 'hub',
  requireProfile: boolean,
): Promise<void> => {
  const groups = new Map<string, { host: LaneRuntimeHostIngress; targets: LaneFinancialReadinessTarget[] }>();
  for (const target of targets) {
    const group = groups.get(target.lane.hostIngress.id) ?? { host: target.lane.hostIngress, targets: [] };
    group.targets.push(target);
    groups.set(target.lane.hostIngress.id, group);
  }
  const results = await Promise.all([...groups.values()].map(async group => {
    const response = await fetch(`${group.host.baseUrl}/api/hlt/financial-readiness`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${group.host.authKey}`,
        'content-type': 'application/json',
      },
      body: serializeTaggedJson({
        perspective,
        requireProfile,
        targets: group.targets.map(target => ({
          runtimeId: target.lane.runtimeId,
          entityId: target.lane.identity.entityId,
          hubEntityId: target.hubEntityId,
          windows: target.windows,
        })),
      }),
    });
    const raw = await response.text();
    const decoded = requireBoundaryRecord(raw.trim() ? deserializeTaggedJson(raw) : {}, 'HLT_HOST_FINANCIAL_READINESS_RESPONSE_INVALID');
    if (!response.ok) throw new Error(`HLT_HOST_FINANCIAL_READINESS_REJECTED:${group.host.id}:${safeStringify(decoded)}`);
    requireExactBoundaryKeys(decoded, ['ok', 'ready', 'missing', 'details'], [], 'HLT_HOST_FINANCIAL_READINESS_RESPONSE_FIELDS_INVALID');
    if (decoded['ok'] !== true || typeof decoded['ready'] !== 'boolean' || !Array.isArray(decoded['missing']) || !Array.isArray(decoded['details'])) {
      throw new Error('HLT_HOST_FINANCIAL_READINESS_RESPONSE_INVALID');
    }
    return {
      missing: decoded['missing'].map(value => String(value)),
      details: decoded['details'],
    };
  }));
  const missing = results.flatMap(result => result.missing);
  if (missing.length > 0) {
    throw new Error(`HLT_HOST_FINANCIAL_READINESS_INCOMPLETE:missing=${missing.length}:details=${safeStringify(results.flatMap(result => result.details))}`);
  }
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

const READY_TIMEOUT_MS = 180_000;

const connectSovereignRuntimeAdapters = async <T>(
  values: readonly T[],
  connect: (value: T, index: number) => Promise<LaneRuntime>,
): Promise<LaneRuntime[]> => Promise.all(values.map(connect));

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
      // The local-prod runner creates a fresh workDir for every HLT. Opening
      // 200 empty restore/infra stores per host is pure setup overhead and can
      // accidentally admit stale state if an operator reuses a failed run.
      XLN_DISABLE_RUNTIME_RESTORE: '1',
      XLN_STORAGE_HISTORY_PATH: join(dbRoot, 'storage-health-history.json'),
      XLN_JURISDICTIONS_PATH: jurisdictionsPath,
      XLN_LOG_LEVEL: process.env['XLN_LOAD_LANE_LOG_LEVEL'] || 'warn',
      XLN_HLT_DIRECT_ONLY: '1',
      ...(process.env['XLN_ACCOUNT_DISPUTE_SEALS'] !== undefined
        ? { XLN_ACCOUNT_DISPUTE_SEALS: process.env['XLN_ACCOUNT_DISPUTE_SEALS'] }
        : {}),
      ...(process.env['XLN_STORAGE_CERTIFIED_HISTORY'] !== undefined
        ? { XLN_STORAGE_CERTIFIED_HISTORY: process.env['XLN_STORAGE_CERTIFIED_HISTORY'] }
        : {}),
      // Lane (user) Runtimes only: the Hub under test keeps its WAL fsync.
      ...(process.env['XLN_HLT_LANE_WAL_SYNC'] !== undefined
        ? { XLN_STORAGE_WAL_SYNC: process.env['XLN_HLT_LANE_WAL_SYNC'] }
        : {}),
      ...(process.env['XLN_P2P_DELIVERY_TRACE'] === '1' ? { XLN_P2P_DELIVERY_TRACE: '1' } : {}),
      ...(process.env['XLN_HEAVY_LOGS'] ? { XLN_HEAVY_LOGS: '1' } : {}),
      ...(process.env['XLN_RUNTIME_FRAME_LOG'] ? { XLN_RUNTIME_FRAME_LOG: '1' } : {}),
      ...(process.env['XLN_RUNTIME_APPLY_PROFILE'] ? { XLN_RUNTIME_APPLY_PROFILE: '1' } : {}),
      ...(process.env['XLN_HLT_LANE_NICE'] ? { XLN_CHILD_NICE: process.env['XLN_HLT_LANE_NICE'] } : {}),
      ...(process.env['XLN_RUNTIME_OP_COUNTERS'] ? { XLN_RUNTIME_OP_COUNTERS: '1' } : {}),
      ...(process.env['XLN_RUNTIME_SAMPLING_PROFILE'] === '1'
        ? {
            XLN_RUNTIME_SAMPLING_PROFILE: '1',
            XLN_RUNTIME_SAMPLING_PROFILE_DIR: process.env['XLN_RUNTIME_SAMPLING_PROFILE_DIR'] || '/tmp/xln-sampling-profile',
          }
        : {}),
      ...(process.env['XLN_RUNTIME_OP_COUNTERS_DIR']
        ? { XLN_RUNTIME_OP_COUNTERS_DIR: process.env['XLN_RUNTIME_OP_COUNTERS_DIR'] }
        : {}),
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
    { authSeed, laneSeedsJson: safeStringify(options.laneSeeds) },
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
  const workerIngress = new Map<number, LaneRuntimeHostIngress>();
  const ingressForRuntime = (index: number): LaneRuntimeHostIngress => {
    const workerStart = sovereignRuntimeWorkerStart(index);
    const existing = workerIngress.get(workerStart);
    if (existing) return existing;
    const workerRuntimeId = deriveRuntimeIdFromSeed(`${options.laneSeeds[workerStart]!}:runtime`);
    if (!workerRuntimeId) {
      throw new Error(`HLT_SOVEREIGN_WORKER_RUNTIME_ID_MISSING:${workerStart}`);
    }
    const ingress: LaneRuntimeHostIngress = {
      id: `${child.name}:worker-${workerStart}:${workerRuntimeId}`,
      baseUrl: `http://127.0.0.1:${firstPort + workerStart}`,
      sequence: { nextWave: 0 },
      authKey: deriveRuntimeAdapterCapabilityToken(authSeed, 'full', Date.now() + 60 * 60_000, {
        audience: workerRuntimeId,
        keyId: 'load-host-worker-batch',
        tokenId: randomBytes(16).toString('hex'),
      }),
    };
    workerIngress.set(workerStart, ingress);
    return ingress;
  };
  return connectSovereignRuntimeAdapters(options.identities, async (identity, index) => {
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
      hostIngress: ingressForRuntime(index),
      hostedEntityIds: [identity.entityId],
    };
  });
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
    const spawned = await Promise.all(groups.map(group => spawnSovereignRuntimeHost({
      workDir: options.workDir,
      portBase: options.portBase,
      identities: group.identities,
      laneSeeds: group.seeds,
      laneIndex: options.laneIndexOffset + group.start,
    })));
    lanes.push(...spawned.flat());
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
  // The settlement gate has already proved every Account/Runtime queue empty,
  // and a fresh HLT never restores these ephemeral load-user databases. Waiting
  // for one host to close hundreds of independent LevelDB handles added ~30 s
  // after the measured run without producing stronger financial evidence.
  await Promise.all(laneDaemons(lanes).map(lane => stopManagedChild(lane.child, {
    terminateTimeoutMs: 250,
    killTimeoutMs: 2_000,
  })));
};
