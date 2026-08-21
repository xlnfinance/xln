/** Multiplexed process host for sovereign HLT user Runtimes. */

import type { ServerWebSocket } from 'bun';
import { listLocalControlEntities } from '../../../../api/server/control/entities';
import { parseTaggedControlBody, requireDaemonControlAuth } from '../../../../api/server/control/auth';
import { handleP2PControl } from '../../../../api/server/control/p2p';
import { handleGossipProfileCounterparties } from '../../../../api/server/control/gossip-counterparties';
import { resolveRuntimeAdminControl } from '../../../../api/server/control/runtime-admin';
import { handleSignerRegistration } from '../../../../api/server/control/signer';
import { handleRuntimeInputControl } from '../../../../api/server/control/runtime-input';
import { decodeRuntimeAdapterRequest, runtimeAdapterMaxMessageBytes } from '../../../../api/runtime-adapter/codec';
import {
  attachRuntimeAdapterTicker,
  closeInvalidRuntimeAdapterMessage,
  forgetRuntimeAdapterClient,
  handleRuntimeAdapterMessage,
} from '../../../../api/runtime-adapter/server';
import { registerRuntimeAdapterAuthSeed } from '../../../../api/runtime-adapter/security/auth';
import { serializeTaggedJson, safeStringify, safeParse } from '../../../../protocol/serialization';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';
import { loadJurisdictions } from '../../../../jurisdiction/adapter/kernel/jurisdiction-loader';
import {
  closeInfraDb,
  closeRuntimeDb,
  ensureGossipProfiles,
  listPersistedCheckpointHeights,
  listPersistedEntityIdsAtHeight,
  loadEntityAccountDocFromStorageDb,
  loadEntityStateFromStorageDb,
  loadEntityViewPageFromStorageDb,
  main,
  readPersistedStorageFrameRecord,
  readPersistedStorageHead,
  startP2P,
  startRuntimeLoop,
  stopP2PAndWait,
  stopRuntimeLoopAndWait,
  validateRuntimeInputAdmission,
} from '../../../../runtime';
import { registerEnvChangeCallback } from '../../../../runtime/loop/loop-environment';
import { enqueueRuntimeInput } from '../../../../runtime/mempool/input-queue';
import { decodeRuntimeInput } from '../../../../runtime/decode';
import type { RuntimeReplica } from '../../../../runtime/types';
import type { JReplica } from '../../../../types/jurisdiction-runtime';
import { startParentLivenessWatch } from '../../../../support/process/parent-watch';
import { readInheritedChildSecrets } from '../../../../support/process/child-secrets';

type HostSocketData = Readonly<{ type: 'rpc'; runtimeId: string }>;
type HostSocket = ServerWebSocket<HostSocketData>;

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const HLT_HOST_BATCH_MAX_BODY_BYTES = 8 * 1024 * 1024;
const firstPort = Number(process.argv[process.argv.indexOf('--first-port') + 1]);
if (!Number.isSafeInteger(firstPort) || firstPort < 1 || firstPort > 65_535) {
  throw new Error(`HLT_SOVEREIGN_HOST_FIRST_PORT_INVALID:${String(firstPort)}`);
}

const secrets = readInheritedChildSecrets();
const authSeed = String(secrets['authSeed'] || '').trim();
if (!authSeed) throw new Error('HLT_SOVEREIGN_HOST_AUTH_SEED_MISSING');
registerRuntimeAdapterAuthSeed(authSeed);
const relayUrl = String(secrets['relayUrl'] || '').trim();
if (!/^wss?:\/\//.test(relayUrl)) throw new Error('HLT_SOVEREIGN_HOST_RELAY_URL_INVALID');

const decodeLaneSeeds = (raw: string | undefined): string[] => {
  const parsed = safeParse(String(raw || ''));
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 1_000) {
    throw new Error('HLT_SOVEREIGN_HOST_LANE_SEEDS_INVALID');
  }
  return parsed.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`HLT_SOVEREIGN_HOST_LANE_SEED_INVALID:${index}`);
    }
    return value.trim();
  });
};

const laneSeeds = decodeLaneSeeds(secrets['laneSeedsJson']);
if (firstPort + laneSeeds.length - 1 > 65_535) {
  throw new Error(`HLT_SOVEREIGN_HOST_PORT_RANGE_INVALID:${firstPort}:${laneSeeds.length}`);
}
const runtimes = new Map<string, RuntimeReplica>();
const runtimeSlots: Array<Readonly<{ env: RuntimeReplica; runtimeId: string; port: number }>> = [];

const resolveHltJurisdiction = (): JReplica => {
  const entries = Object.values(loadJurisdictions().jurisdictions);
  const configured = entries.find(entry => entry.primary === true && entry.status === 'active')
    ?? entries.find(entry => entry.status === 'active');
  if (!configured) throw new Error('HLT_SOVEREIGN_JURISDICTION_ACTIVE_MISSING');
  return {
    name: configured.name,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 300,
    blockTimeMs: configured.blockTimeMs,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 50, z: 0 },
    ...(configured.entityProviderDeploymentBlock === undefined
      ? {}
      : { entityProviderDeploymentBlock: configured.entityProviderDeploymentBlock }),
    contracts: { ...configured.contracts },
    rpcs: [configured.rpc],
    chainId: configured.chainId,
  };
};

const hltJurisdiction = resolveHltJurisdiction();

const installHltJurisdiction = (env: RuntimeReplica): void => {
  const replica: JReplica = {
    ...hltJurisdiction,
    mempool: [],
    contracts: { ...hltJurisdiction.contracts },
    rpcs: [...(hltJurisdiction.rpcs ?? [])],
    lastBlockTimestamp: env.state.timestamp,
  };
  env.state.jReplicas.set(replica.name, replica);
  env.activeJurisdiction = replica.name;
};

const response = (payload: unknown, status = 200): Response =>
  new Response(serializeTaggedJson(payload), { status, headers: JSON_HEADERS });

type PendingHostBatch = Readonly<{
  entries: ReadonlyArray<Readonly<{ env: RuntimeReplica; input: ReturnType<typeof decodeRuntimeInput> }>>;
  resolve: (value: Response) => void;
  wave: number;
}>;

const pendingHostBatches = new Map<number, PendingHostBatch>();
let nextHostBatchWave = 0;

const drainHostBatches = (): void => {
  while (true) {
    const batch = pendingHostBatches.get(nextHostBatchWave);
    if (!batch) return;
    pendingHostBatches.delete(nextHostBatchWave);
    try {
      // Validate the complete host wave before mutating any Runtime queue.
      // Queue acceptance is not a protocol receipt: bilateral Account state
      // and ACK drain remain the only financial completion evidence.
      for (const entry of batch.entries) validateRuntimeInputAdmission(entry.env, entry.input);
      for (const entry of batch.entries) enqueueRuntimeInput(entry.env, entry.input);
      batch.resolve(response({ ok: true, wave: batch.wave, accepted: batch.entries.length }));
    } catch (error) {
      batch.resolve(response({
        ok: false,
        wave: batch.wave,
        error: error instanceof Error ? error.message : String(error),
      }, 400));
    }
    nextHostBatchWave += 1;
  }
};

const handleHostRuntimeInputBatch = async (
  request: Request,
  authEnv: RuntimeReplica,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, authEnv);
  if (authError) return authError;
  try {
    const root = requireBoundaryRecord(
      await parseTaggedControlBody(request, HLT_HOST_BATCH_MAX_BODY_BYTES),
      'HLT_HOST_RUNTIME_INPUT_BATCH_INVALID',
    );
    requireExactBoundaryKeys(
      root,
      ['wave', 'entries'],
      [],
      'HLT_HOST_RUNTIME_INPUT_BATCH_FIELDS_INVALID',
    );
    const wave = requireBoundaryInteger(root['wave'], 'HLT_HOST_RUNTIME_INPUT_BATCH_WAVE_INVALID');
    const rawEntries = root['entries'];
    if (!Number.isSafeInteger(wave) || wave < 0) {
      throw new Error(`HLT_HOST_RUNTIME_INPUT_BATCH_WAVE_INVALID:${wave}`);
    }
    if (!Array.isArray(rawEntries)) {
      throw new Error(`HLT_HOST_RUNTIME_INPUT_BATCH_CARDINALITY_INVALID:${typeof rawEntries}`);
    }
    if (rawEntries.length < 1 || rawEntries.length > runtimes.size) {
      throw new Error(`HLT_HOST_RUNTIME_INPUT_BATCH_CARDINALITY_INVALID:${rawEntries.length}`);
    }
    const seen = new Set<string>();
    const entries = rawEntries.map((value, index) => {
      const entry = requireBoundaryRecord(value, `HLT_HOST_RUNTIME_INPUT_BATCH_ENTRY_INVALID:${index}`);
      requireExactBoundaryKeys(
        entry,
        ['runtimeId', 'input'],
        [],
        `HLT_HOST_RUNTIME_INPUT_BATCH_ENTRY_FIELDS_INVALID:${index}`,
      );
      const runtimeId = String(entry['runtimeId'] || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(runtimeId)) {
        throw new Error(`HLT_HOST_RUNTIME_INPUT_BATCH_RUNTIME_ID_INVALID:${index}:${runtimeId}`);
      }
      if (seen.has(runtimeId)) {
        throw new Error(`HLT_HOST_RUNTIME_INPUT_BATCH_RUNTIME_DUPLICATE:${runtimeId}`);
      }
      seen.add(runtimeId);
      const env = runtimes.get(runtimeId);
      if (!env) throw new Error(`HLT_HOST_RUNTIME_INPUT_BATCH_RUNTIME_UNKNOWN:${runtimeId}`);
      const input = decodeRuntimeInput(entry['input'], `HLT_HOST_RUNTIME_INPUT_BATCH_INPUT_${index}`);
      if (input.runtimeTxs.length === 0 && input.entityInputs.length === 0 && (input.jInputs?.length ?? 0) === 0) {
        throw new Error(`HLT_HOST_RUNTIME_INPUT_BATCH_INPUT_EMPTY:${index}`);
      }
      return { env, input };
    });
    if (wave < nextHostBatchWave || pendingHostBatches.has(wave)) {
      throw new Error(
        `HLT_HOST_RUNTIME_INPUT_BATCH_WAVE_REPLAY:wave=${wave}:next=${nextHostBatchWave}`,
      );
    }
    return await new Promise<Response>(resolve => {
      pendingHostBatches.set(wave, { entries, resolve, wave });
      // A later HTTP request may finish parsing first. Hold it until every
      // earlier wave arrives so each sovereign Runtime sees exact user order.
      drainHostBatches();
    });
  } catch (error) {
    return response({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 400);
  }
};

const profileResponse = async (request: Request, env: RuntimeReplica): Promise<Response> => {
  const entityId = String(new URL(request.url).searchParams.get('entityId') || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(entityId)) return response({ ok: false, error: 'entityId is required' }, 400);
  if (!env.gossip.profiles.has(entityId)) await ensureGossipProfiles(env, [entityId]);
  const profile = env.gossip.profiles.get(entityId) ?? null;
  return response({ ok: true, entityId, found: profile !== null, profile, peers: [] });
};

const handleControl = async (request: Request, env: RuntimeReplica, suffix: string): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, env);
  if (authError) return authError;
  if (suffix === '/api/control/entities' && request.method === 'GET') {
    return response({
      ok: true,
      runtimeId: env.runtimeId ?? null,
      entities: listLocalControlEntities(env, () => undefined),
    });
  }
  if (suffix === '/api/control/signers/register' && request.method === 'POST') {
    return handleSignerRegistration(request, JSON_HEADERS, { parseTaggedControlBody, env });
  }
  if (suffix === '/api/control/runtime-input' && request.method === 'POST') {
    // HLT user actions enter through the same queue-only control boundary as
    // production. Do not route load through RuntimeAdapter `send`: its
    // recordRuntimeAdapterCommand frontier serializes independent user
    // actions behind a synthetic WAL marker that is not part of Runtime,
    // Entity, or Account consensus.
    return handleRuntimeInputControl(request, JSON_HEADERS, env, {
      enqueueRuntimeInput,
      validateRuntimeInputAdmission,
      parseTaggedControlBody,
    });
  }
  if (suffix === '/api/control/p2p' && request.method === 'POST') {
    return handleP2PControl(request, JSON_HEADERS, env, { parseTaggedControlBody, startP2P });
  }
  if (suffix === '/api/control/gossip-profile-counterparties' && request.method === 'POST') {
    return handleGossipProfileCounterparties(request, env, JSON_HEADERS);
  }
  if (suffix === '/api/gossip/profile' && request.method === 'GET') {
    return profileResponse(request, env);
  }
  return response({ ok: false, error: 'Not found' }, 404);
};

const adapterDeps = {
  enqueueRuntimeInput,
  validateRuntimeInputAdmission,
  controlRuntime: resolveRuntimeAdminControl,
  readHead: (env: RuntimeReplica) => readPersistedStorageHead(env),
  readFrame: (env: RuntimeReplica, height: number) => readPersistedStorageFrameRecord(env, height),
  listCheckpoints: (env: RuntimeReplica) => listPersistedCheckpointHeights(env),
  loadEntityState: (env: RuntimeReplica, entityId: string, height: number) =>
    loadEntityStateFromStorageDb(env, entityId, height),
  loadEntityAccountDoc: (env: RuntimeReplica, entityId: string, counterpartyId: string, height: number) =>
    loadEntityAccountDocFromStorageDb(env, entityId, counterpartyId, height),
  loadEntityViewPage: (env: RuntimeReplica, entityId: string, height: number, query?: Parameters<typeof loadEntityViewPageFromStorageDb>[3]) =>
    loadEntityViewPageFromStorageDb(env, entityId, height, query),
  listEntityIdsAtHeight: (env: RuntimeReplica, height: number) => listPersistedEntityIdsAtHeight(env, height),
};

const bootRuntime = async (laneSeed: string, index: number): Promise<void> => {
  const env = await main(`${laneSeed}:runtime`, {
    localSigners: [{ label: 'owner', seed: laneSeed }],
  });
  installHltJurisdiction(env);
  const runtimeId = String(env.runtimeId || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(runtimeId) || runtimes.has(runtimeId)) {
    throw new Error(`HLT_SOVEREIGN_RUNTIME_ID_INVALID:${runtimeId}`);
  }
  env.quietRuntimeLogs = true;
  startRuntimeLoop(env, {
    onFatal: async payload => {
      console.error(`HLT_SOVEREIGN_RUNTIME_FATAL ${safeStringify({ runtimeId, payload })}`);
      await stop(1);
    },
  });
  // User devices pull only hubs by default and fetch counterparties/routes on
  // demand. Keeping this policy per Runtime prevents an O(N²) profile fanout.
  startP2P(env, { relayUrls: [relayUrl], gossipSet: 'hubs' });
  runtimes.set(runtimeId, env);
  runtimeSlots[index] = { env, runtimeId, port: firstPort + index };
};

const bootAll = async (): Promise<void> => {
  const concurrency = Math.min(16, laneSeeds.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < laneSeeds.length) {
      const index = cursor++;
      await bootRuntime(laneSeeds[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
};

let stopping = false;
const stop = async (exitCode: number): Promise<void> => {
  if (stopping) return;
  stopping = true;
  const envs = [...runtimes.values()];
  await Promise.allSettled(envs.map(env => stopP2PAndWait(env, 5_000)));
  await Promise.allSettled(envs.map(env => stopRuntimeLoopAndWait(env, 5_000)));
  await Promise.allSettled(envs.flatMap(env => [closeRuntimeDb(env), closeInfraDb(env)]));
  process.exit(exitCode);
};

const run = async (): Promise<void> => {
  await bootAll();
  const servers = runtimeSlots.map(({ env, runtimeId, port }) => Bun.serve<HostSocketData>({
    port,
    hostname: '127.0.0.1',
    fetch: async (request, server) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/health') {
        return response({ ok: true, ready: true, runtimes: runtimes.size, expected: laneSeeds.length, runtimeId });
      }
      if (pathname === '/rpc') {
        if (!server.upgrade(request, { data: { type: 'rpc', runtimeId } })) {
          return response({ ok: false, error: 'WebSocket upgrade failed' }, 400);
        }
        return undefined;
      }
      if (pathname === '/api/hlt/runtime-input-batch' && request.method === 'POST') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        return handleHostRuntimeInputBatch(request, env);
      }
      return handleControl(request, env, pathname);
    },
    websocket: {
      maxPayloadLength: runtimeAdapterMaxMessageBytes(),
      open() {
        attachRuntimeAdapterTicker(env, registerEnvChangeCallback);
      },
      message(ws: HostSocket, raw) {
        try {
          const request = decodeRuntimeAdapterRequest(raw);
          void handleRuntimeAdapterMessage(ws, request, env, adapterDeps).catch(error => {
            console.error(`HLT_SOVEREIGN_RADAPTER_FATAL ${safeStringify({ runtimeId, error })}`);
            closeInvalidRuntimeAdapterMessage(ws, error);
          });
        } catch (error) {
          closeInvalidRuntimeAdapterMessage(ws, error);
        }
      },
      close(ws: HostSocket) {
        forgetRuntimeAdapterClient(ws);
      },
    },
  }));
  const stopParentWatch = startParentLivenessWatch(
    'hlt-sovereign-runtime-host',
    process.env['XLN_MANAGED_PARENT_PID'],
    () => void stop(1),
    250,
  );
  process.once('exit', () => {
    stopParentWatch();
    for (const server of servers) server.stop(true);
  });
  process.once('SIGTERM', () => void stop(0));
  console.log(`HLT_SOVEREIGN_HOST_READY ports=${firstPort}-${firstPort + runtimeSlots.length - 1} runtimes=${runtimes.size}`);
};

void run().catch(error => {
  console.error(`HLT_SOVEREIGN_HOST_FATAL ${safeStringify(error)}`);
  process.exit(1);
});
