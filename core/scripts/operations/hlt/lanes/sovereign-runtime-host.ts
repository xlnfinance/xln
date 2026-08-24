/** Multiplexed process host for sovereign HLT user Runtimes. */

import type { ServerWebSocket } from 'bun';
import { isMainThread, parentPort } from 'node:worker_threads';
import { LIMITS } from '../../../../config/constants';
import { listLocalControlEntities } from '../../../../api/server/control/entities';
import { parseTaggedControlBody, requireDaemonControlAuth } from '../../../../api/server/control/auth';
import { handleP2PControl } from '../../../../api/server/control/p2p';
import { handleGossipProfileCounterparties } from '../../../../api/server/control/gossip-counterparties';
import { resolveRuntimeAdminControl } from '../../../../api/server/control/runtime-admin';
import { handleSignerRegistration } from '../../../../api/server/control/signer';
import { handleRuntimeInputControl } from '../../../../api/server/control/runtime-input';
import {
  gossipProfileEntityId,
  handleKnownProfileRequest,
} from '../../../../api/server/network/gossip-profiles';
import { decodeRuntimeAdapterRequest, runtimeAdapterMaxMessageBytes } from '../../../../api/runtime-adapter/codec';
import {
  attachRuntimeAdapterTicker,
  closeInvalidRuntimeAdapterMessage,
  countRuntimeAdapterClients,
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
import {
  dumpRuntimeSamplingProfile,
  startRuntimeSamplingProfiler,
} from '../../../../support/performance/sampling-profiler';
import { readInheritedChildSecrets } from '../../../../support/process/child-secrets';
import {
  dumpOpCounters,
  installGlobalOpCounters,
  resetOpCounters,
  snapshotOpCounters,
} from '../../../../support/performance/op-counters';
import { SOVEREIGN_RUNTIMES_PER_WORKER } from './sovereign-runtime-sharding';
import { deriveDelta, isLeftEntity } from '../../../../account/utils';
import { getEntityReplicaById } from '../../../../entity/replica/replica-lookup';
import { startIdleShutdownWatch } from '../../../../support/process/idle-shutdown';

type HostSocketData = Readonly<{ type: 'rpc'; runtimeId: string }>;
type HostSocket = ServerWebSocket<HostSocketData>;

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const HLT_HOST_BATCH_MAX_BODY_BYTES = LIMITS.MAX_HLT_HOST_BATCH_BODY_BYTES;
const lanePersistenceEnabled = (() => {
  const raw = String(process.env['XLN_HLT_LANE_PERSISTENCE'] ?? '0').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`HLT_LANE_PERSISTENCE_INVALID:${raw}`);
})();
const isShardWorker = !isMainThread;
const processFirstPort = isShardWorker
  ? 0
  : Number(process.argv[process.argv.indexOf('--first-port') + 1]);
if (!isShardWorker && (
  !Number.isSafeInteger(processFirstPort) || processFirstPort < 1 || processFirstPort > 65_535
)) {
  throw new Error(`HLT_SOVEREIGN_HOST_FIRST_PORT_INVALID:${String(processFirstPort)}`);
}
let firstPort = processFirstPort;
let opCounterLabel = `load-host-${firstPort}`;
let authSeed = '';

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

let laneSeeds: string[] = [];
let processRuntimeCount = 0;
let hostReady = false;
const runtimes = new Map<string, RuntimeReplica>();
const runtimeSlots: Array<Readonly<{ env: RuntimeReplica; runtimeId: string; port: number }>> = [];
const activeServers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

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

const handleHostReadiness = async (
  request: Request,
  authEnv: RuntimeReplica,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, authEnv);
  if (authError) return authError;
  try {
    const body = requireBoundaryRecord(
      await parseTaggedControlBody(request, HLT_HOST_BATCH_MAX_BODY_BYTES),
      'HLT_HOST_READINESS_INVALID',
    );
    requireExactBoundaryKeys(
      body,
      ['hubEntityId', 'hubRuntimeId', 'runtimeIds'],
      [],
      'HLT_HOST_READINESS_FIELDS_INVALID',
    );
    const hubEntityId = String(body['hubEntityId'] || '').trim().toLowerCase();
    const hubRuntimeId = String(body['hubRuntimeId'] || '').trim().toLowerCase();
    const rawRuntimeIds = body['runtimeIds'];
    if (!/^0x[0-9a-f]{64}$/.test(hubEntityId) || !/^0x[0-9a-f]{40}$/.test(hubRuntimeId)) {
      throw new Error('HLT_HOST_READINESS_HUB_ID_INVALID');
    }
    if (!Array.isArray(rawRuntimeIds) || rawRuntimeIds.length < 1 || rawRuntimeIds.length > runtimes.size) {
      throw new Error('HLT_HOST_READINESS_RUNTIME_IDS_INVALID');
    }
    const runtimeIds = rawRuntimeIds.map((value, index) => {
      const runtimeId = String(value || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(runtimeId) || !runtimes.has(runtimeId)) {
        throw new Error(`HLT_HOST_READINESS_RUNTIME_ID_INVALID:${index}:${runtimeId}`);
      }
      return runtimeId;
    });
    if (new Set(runtimeIds).size !== runtimeIds.length) {
      throw new Error('HLT_HOST_READINESS_RUNTIME_ID_DUPLICATE');
    }
    const ready = await Promise.all(runtimeIds.map(async runtimeId => {
      const env = runtimes.get(runtimeId);
      if (!env) throw new Error(`HLT_HOST_READINESS_RUNTIME_MISSING:${runtimeId}`);
      const p2p = startP2P(env);
      if (!p2p || !(await p2p.bootstrapDirectEntityRoutes([hubEntityId], 10_000))) return false;
      const profile = env.gossip.profiles.get(hubEntityId);
      return profile?.runtimeId?.toLowerCase() === hubRuntimeId &&
        /^0x[0-9a-f]{64}$/.test(String(profile.runtimeEncPubKey || ''));
    }));
    const missing = runtimeIds.filter((_runtimeId, index) => !ready[index]);
    return response({ ok: true, ready: missing.length === 0, missing });
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

const handleHostDiagnostics = (request: Request, authEnv: RuntimeReplica): Response => {
  const authError = requireDaemonControlAuth(request, authEnv);
  if (authError) return authError;
  const memory = process.memoryUsage();
  const totals = [...runtimes.values()].reduce((result, env) => {
    const directPeers = env.infrastructure?.p2p?.getDirectPeerState() ?? [];
    result.runtimeEntityInputs += env.runtimeMempool.entityInputs.length;
    result.inFlightEntityInputs += env.infrastructure?.inFlightEntityInputs ?? 0;
    result.pendingOutputs += env.pendingOutputs?.length ?? 0;
    result.networkInbox += env.networkInbox?.length ?? 0;
    result.pendingNetworkOutputs += env.pendingNetworkOutputs?.length ?? 0;
    result.entityReplicas += env.state.eReplicas.size;
    result.accountReplicas += [...env.state.eReplicas.values()]
      .reduce((count, replica) => count + replica.state.accounts.size, 0);
    result.gossipProfiles += env.gossip.profiles.size;
    result.relayClients += env.infrastructure?.p2p?.getRelayClientCount() ?? 0;
    result.directClients += directPeers.length;
    result.openDirectClients += directPeers.filter(peer => peer.open).length;
    result.radapterClients += countRuntimeAdapterClients(env);
    return result;
  }, {
    runtimeEntityInputs: 0,
    inFlightEntityInputs: 0,
    pendingOutputs: 0,
    networkInbox: 0,
    pendingNetworkOutputs: 0,
    entityReplicas: 0,
    accountReplicas: 0,
    gossipProfiles: 0,
    relayClients: 0,
    directClients: 0,
    openDirectClients: 0,
    radapterClients: 0,
  });
  return response({
    ok: true,
    processFirstPort,
    workerFirstPort: firstPort,
    runtimes: runtimes.size,
    memory: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    },
    totals,
  });
};

const waitForCommittedCondition = (
  env: RuntimeReplica,
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> => {
  if (condition()) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregister();
      resolve(ready);
    };
    const unregister = registerEnvChangeCallback(env, () => {
      if (condition()) finish(true);
    });
    const timer = setTimeout(() => finish(condition()), timeoutMs);
    if (condition()) finish(true);
  });
};

const handleHostFinancialReadiness = async (
  request: Request,
  authEnv: RuntimeReplica,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, authEnv);
  if (authError) return authError;
  try {
    const body = requireBoundaryRecord(
      await parseTaggedControlBody(request, HLT_HOST_BATCH_MAX_BODY_BYTES),
      'HLT_HOST_FINANCIAL_READINESS_INVALID',
    );
    requireExactBoundaryKeys(body, ['perspective', 'requireProfile', 'targets'], [], 'HLT_HOST_FINANCIAL_READINESS_FIELDS_INVALID');
    const perspective = body['perspective'];
    const requireProfile = body['requireProfile'];
    if ((perspective !== 'user' && perspective !== 'hub') || typeof requireProfile !== 'boolean') {
      throw new Error('HLT_HOST_FINANCIAL_READINESS_MODE_INVALID');
    }
    if (!Array.isArray(body['targets']) || body['targets'].length < 1 || body['targets'].length > runtimes.size) {
      throw new Error('HLT_HOST_FINANCIAL_READINESS_TARGETS_INVALID');
    }
    const targets = body['targets'].map((value, index) => {
      const target = requireBoundaryRecord(value, `HLT_HOST_FINANCIAL_READINESS_TARGET_INVALID:${index}`);
      requireExactBoundaryKeys(target, ['runtimeId', 'entityId', 'hubEntityId', 'windows'], [], `HLT_HOST_FINANCIAL_READINESS_TARGET_FIELDS_INVALID:${index}`);
      const runtimeId = String(target['runtimeId'] || '').toLowerCase();
      const entityId = String(target['entityId'] || '').toLowerCase();
      const hubEntityId = String(target['hubEntityId'] || '').toLowerCase();
      if (!runtimes.has(runtimeId) || !/^0x[0-9a-f]{64}$/.test(entityId) || !/^0x[0-9a-f]{64}$/.test(hubEntityId)) {
        throw new Error(`HLT_HOST_FINANCIAL_READINESS_TARGET_ID_INVALID:${index}`);
      }
      if (!Array.isArray(target['windows']) || target['windows'].length < 1) {
        throw new Error(`HLT_HOST_FINANCIAL_READINESS_WINDOWS_INVALID:${index}`);
      }
      const windows = target['windows'].map((windowValue, windowIndex) => {
        const window = requireBoundaryRecord(windowValue, `HLT_HOST_FINANCIAL_READINESS_WINDOW_INVALID:${index}:${windowIndex}`);
        requireExactBoundaryKeys(window, ['tokenId', 'minimum'], [], `HLT_HOST_FINANCIAL_READINESS_WINDOW_FIELDS_INVALID:${index}:${windowIndex}`);
        const tokenId = requireBoundaryInteger(window['tokenId'], `HLT_HOST_FINANCIAL_READINESS_TOKEN_INVALID:${index}:${windowIndex}`, 1);
        const minimum = BigInt(String(window['minimum']));
        if (minimum < 1n) throw new Error(`HLT_HOST_FINANCIAL_READINESS_MINIMUM_INVALID:${index}:${windowIndex}`);
        return { tokenId, minimum };
      });
      return { runtimeId, entityId, hubEntityId, windows };
    });
    const targetReady = (target: (typeof targets)[number]): boolean => {
      const env = runtimes.get(target.runtimeId)!;
      const account = getEntityReplicaById(env, target.entityId)?.state.accounts.get(target.hubEntityId);
      if (!account) return false;
      const viewer = perspective === 'user' ? target.entityId : target.hubEntityId;
      const counterparty = perspective === 'user' ? target.hubEntityId : target.entityId;
      const creditReady = target.windows.every(window => {
        const delta = account.state.deltas.get(window.tokenId);
        return !!delta && deriveDelta(delta, isLeftEntity(viewer, counterparty)).outCapacity >= window.minimum;
      });
      if (!creditReady || !requireProfile) return creditReady;
      return env.gossip.profiles.get(target.entityId)?.publicAccounts.includes(target.hubEntityId) === true;
    };
    const ready = await Promise.all(targets.map(target => {
      const env = runtimes.get(target.runtimeId)!;
      return waitForCommittedCondition(env, () => targetReady(target), 120_000);
    }));
    const missing = targets.filter((_target, index) => !ready[index]).map(target => target.runtimeId);
    const details = targets.flatMap((target, index) => {
      if (ready[index]) return [];
      const env = runtimes.get(target.runtimeId)!;
      const entity = getEntityReplicaById(env, target.entityId);
      const account = entity?.state.accounts.get(target.hubEntityId);
      const viewer = perspective === 'user' ? target.entityId : target.hubEntityId;
      const counterparty = perspective === 'user' ? target.hubEntityId : target.entityId;
      const profile = env.gossip.profiles.get(target.entityId);
      return [{
        runtimeId: target.runtimeId,
        entityId: target.entityId,
        entityHeight: entity?.state.height ?? null,
        accountHeight: account?.currentHeight ?? null,
        mempoolTxTypes: account?.mempool.map(tx => tx.type) ?? [],
        pendingFrameHeight: account?.pendingFrame?.height ?? null,
        pendingFrameTxTypes: account?.pendingFrame?.accountTxs.map(tx => tx.type) ?? [],
        pendingInputKind: account?.pendingAccountInput?.kind ?? null,
        lastOutboundAckHeight: account?.lastOutboundFrameAck?.height ?? null,
        profileKnown: profile !== undefined,
        profileHasHub: profile?.publicAccounts.includes(target.hubEntityId) ?? false,
        windows: target.windows.map(window => {
          const delta = account?.state.deltas.get(window.tokenId);
          const derived = delta ? deriveDelta(delta, isLeftEntity(viewer, counterparty)) : null;
          return {
            tokenId: window.tokenId,
            minimum: window.minimum,
            outCapacity: derived?.outCapacity ?? null,
            inCapacity: derived?.inCapacity ?? null,
          };
        }),
      }];
    });
    return response({ ok: true, ready: missing.length === 0, missing, details });
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

const profileResponse = async (request: Request, env: RuntimeReplica): Promise<Response> => {
  const entityId = gossipProfileEntityId(request);
  if (!/^0x[0-9a-f]{64}$/.test(entityId)) return response({ ok: false, error: 'entityId is required' }, 400);
  if (!env.gossip.profiles.has(entityId)) await ensureGossipProfiles(env, [entityId]);
  return handleKnownProfileRequest({ request, env, relayStore: null, headers: JSON_HEADERS });
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
  env.runtimeConfig = {
    ...env.runtimeConfig,
    storage: {
      ...env.runtimeConfig?.storage,
      enabled: lanePersistenceEnabled,
    },
  };
  startRuntimeLoop(env, {
    onFatal: async payload => {
      console.error(`HLT_SOVEREIGN_RUNTIME_FATAL ${safeStringify({ runtimeId, payload })}`);
      if (isShardWorker) {
        postShardStatus({
          type: 'fatal',
          error: `HLT_SOVEREIGN_RUNTIME_FATAL:${runtimeId}:${safeStringify(payload)}`,
        });
      }
      await stop(1);
    },
  });
  // Do not stampede the relay while the sovereign Runtime population is still
  // booting. The driver starts P2P through the authenticated control boundary
  // in bounded batches after every WAL, loop and control endpoint is ready.
  // This changes only orchestration order: each Runtime still owns its P2P
  // client and later receives the same relay URL and hub-only gossip policy.
  runtimes.set(runtimeId, env);
  runtimeSlots[index] = { env, runtimeId, port: firstPort + index };
};

const bootAll = async (): Promise<void> => {
  // A host is only process packing: every Runtime owns independent state,
  // loop and transport. Persistence is explicit per load Runtime; the default
  // in-memory mode avoids making one machine emulate 1,000 unrelated disks.
  await Promise.all(laneSeeds.map((laneSeed, index) => bootRuntime(laneSeed, index)));
};

let stopping = false;
const stop = async (exitCode: number): Promise<void> => {
  if (stopping) return;
  stopping = true;
  for (const server of activeServers) server.stop(true);
  activeServers.length = 0;
  const envs = [...runtimes.values()];
  await Promise.allSettled(envs.map(env => stopP2PAndWait(env, 5_000)));
  await Promise.allSettled(envs.map(env => stopRuntimeLoopAndWait(env, 5_000)));
  await Promise.allSettled(envs.flatMap(env => [closeRuntimeDb(env), closeInfraDb(env)]));
  dumpOpCounters(opCounterLabel, 'shutdown');
  dumpRuntimeSamplingProfile('shutdown');
  if (isShardWorker) {
    postShardStatus({ type: 'stopped', firstPort, runtimes: runtimes.size });
    // End the worker by closing its control port after every owned N-API
    // resource has drained. `process.exit()` and coordinator `terminate()`
    // both tore down Bun workers while LevelDB/WebSocket finalizers were live.
    globalThis.onmessage = null;
    parentPort?.close();
    return;
  }
  process.exitCode = exitCode;
};

/**
 * A lane host whose driver stopped talking to it is dead weight: it keeps its
 * ports, its LevelDB handles and its Rust engine children alive for as long as
 * the machine runs. Every request and every adapter message counts as life.
 */
const idleWatch = startIdleShutdownWatch(
  `hlt-sovereign-runtime-host:${String(processFirstPort)}`,
  idleMs => {
    const reason = `HLT_SOVEREIGN_HOST_IDLE_EXIT:idleMs=${String(idleMs)}:pid=${String(process.pid)}`;
    console.error(reason);
    if (isShardWorker) {
      // The coordinator owns the process; it tears every worker down and then
      // exits, so one idle lane cannot leave the rest of the host running.
      postShardStatus({ type: 'fatal', error: reason });
      return;
    }
    void stop(0).finally(() => process.exit(0));
  },
);

const run = async (): Promise<void> => {
  await installGlobalOpCounters(opCounterLabel);
  if (await startRuntimeSamplingProfiler(opCounterLabel)) {
    // Workers rarely reach a clean stop under the harness; each dump is a
    // superset of the previous one, so a periodic dump loses nothing.
    setInterval(() => dumpRuntimeSamplingProfile('interval'), 5_000).unref();
  }
  await bootAll();
  const servers = runtimeSlots.map(({ env, runtimeId, port }) => Bun.serve<HostSocketData>({
    port,
    hostname: '127.0.0.1',
    fetch: async (request, server) => {
      idleWatch.noteActivity();
      const pathname = new URL(request.url).pathname;
      if (pathname === '/health') {
        return response({
          ok: true,
          ready: hostReady,
          runtimes: hostReady ? processRuntimeCount : runtimes.size,
          expected: processRuntimeCount,
          runtimeId,
        });
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
      if (pathname === '/api/hlt/readiness' && request.method === 'POST') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        return handleHostReadiness(request, env);
      }
      if (pathname === '/api/hlt/diagnostics' && request.method === 'GET') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        return handleHostDiagnostics(request, env);
      }
      if (pathname === '/api/hlt/op-counters/reset' && request.method === 'POST') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        const authError = requireDaemonControlAuth(request, env);
        if (authError) return authError;
        resetOpCounters();
        return response({ ok: true });
      }
      if (pathname === '/api/hlt/op-counters' && request.method === 'GET') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        const authError = requireDaemonControlAuth(request, env);
        if (authError) return authError;
        return response({ counters: snapshotOpCounters() });
      }
      if (pathname === '/api/hlt/financial-readiness' && request.method === 'POST') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        return handleHostFinancialReadiness(request, env);
      }
      return handleControl(request, env, pathname);
    },
    websocket: {
      maxPayloadLength: runtimeAdapterMaxMessageBytes(),
      open() {
        attachRuntimeAdapterTicker(env, registerEnvChangeCallback);
      },
      message(ws: HostSocket, raw) {
        idleWatch.noteActivity();
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
  activeServers.push(...servers);
  console.log(`HLT_SOVEREIGN_WORKER_READY ports=${firstPort}-${firstPort + runtimeSlots.length - 1} runtimes=${runtimes.size}`);
};

type ShardInitMessage = Readonly<{
  type: 'init';
  authSeed: string;
  firstPort: number;
  laneSeeds: readonly string[];
  processRuntimeCount: number;
}>;

type ShardControlMessage = ShardInitMessage | Readonly<{ type: 'activate' }> | Readonly<{ type: 'stop' }>;
type ShardStatusMessage = Readonly<{
  type: 'ready' | 'stopped';
  firstPort: number;
  runtimes: number;
}> | Readonly<{ type: 'fatal'; error: string }>;

const postShardStatus = (message: ShardStatusMessage): void => {
  globalThis.postMessage(message);
};

const initializeShard = async (message: ShardInitMessage): Promise<void> => {
  firstPort = message.firstPort;
  processRuntimeCount = message.processRuntimeCount;
  laneSeeds = [...message.laneSeeds];
  authSeed = message.authSeed.trim();
  opCounterLabel = `load-host-${processFirstPort}-worker-${firstPort}`;
  if (!authSeed) throw new Error('HLT_SOVEREIGN_HOST_AUTH_SEED_MISSING');
  if (laneSeeds.length < 1 || laneSeeds.length > SOVEREIGN_RUNTIMES_PER_WORKER) {
    throw new Error(`HLT_SOVEREIGN_WORKER_CARDINALITY_INVALID:${laneSeeds.length}`);
  }
  if (firstPort + laneSeeds.length - 1 > 65_535) {
    throw new Error(`HLT_SOVEREIGN_HOST_PORT_RANGE_INVALID:${firstPort}:${laneSeeds.length}`);
  }
  registerRuntimeAdapterAuthSeed(authSeed);
  await run();
  postShardStatus({ type: 'ready', firstPort, runtimes: runtimes.size });
};

const runShardWorker = (): void => {
  let initialized = false;
  globalThis.onmessage = event => {
    const message = event.data as ShardControlMessage;
    if (message.type === 'init') {
      if (initialized) throw new Error('HLT_SOVEREIGN_WORKER_INIT_REPLAY');
      initialized = true;
      void initializeShard(message).catch(error => {
        postShardStatus({
          type: 'fatal',
          error: error instanceof Error ? error.stack || error.message : String(error),
        });
        void stop(1);
      });
      return;
    }
    if (!initialized) throw new Error('HLT_SOVEREIGN_WORKER_CONTROL_BEFORE_INIT');
    if (message.type === 'activate') {
      hostReady = true;
      return;
    }
    if (message.type === 'stop') void stop(0);
  };
};

const waitForShardReady = (
  worker: Worker,
  config: ShardInitMessage,
): Promise<void> => new Promise((resolve, reject) => {
  worker.onmessage = event => {
    const message = event.data as ShardStatusMessage;
    if (message.type === 'fatal') {
      reject(new Error(`HLT_SOVEREIGN_WORKER_FATAL:${message.error}`));
      return;
    }
    if (message.type !== 'ready') return;
    if (message.firstPort !== config.firstPort || message.runtimes !== config.laneSeeds.length) {
      reject(new Error(`HLT_SOVEREIGN_WORKER_READY_MISMATCH:${safeStringify(message)}`));
      return;
    }
    resolve();
  };
  worker.onerror = error => reject(new Error(
    `HLT_SOVEREIGN_WORKER_BOOT_ERROR:${error.message}:` +
    `${error.filename}:${error.lineno}:${error.colno}`,
  ));
  worker.postMessage(config);
});

const runCoordinator = async (): Promise<void> => {
  const secrets = readInheritedChildSecrets();
  const processAuthSeed = String(secrets['authSeed'] || '').trim();
  const processLaneSeeds = decodeLaneSeeds(secrets['laneSeedsJson']);
  if (!processAuthSeed) throw new Error('HLT_SOVEREIGN_HOST_AUTH_SEED_MISSING');
  if (processFirstPort + processLaneSeeds.length - 1 > 65_535) {
    throw new Error(`HLT_SOVEREIGN_HOST_PORT_RANGE_INVALID:${processFirstPort}:${processLaneSeeds.length}`);
  }
  const workers: Worker[] = [];
  const ready: Promise<void>[] = [];
  for (let start = 0; start < processLaneSeeds.length; start += SOVEREIGN_RUNTIMES_PER_WORKER) {
    const worker = new Worker(new URL(import.meta.url));
    const config: ShardInitMessage = {
      type: 'init',
      authSeed: processAuthSeed,
      firstPort: processFirstPort + start,
      laneSeeds: processLaneSeeds.slice(start, start + SOVEREIGN_RUNTIMES_PER_WORKER),
      processRuntimeCount: processLaneSeeds.length,
    };
    workers.push(worker);
    ready.push(waitForShardReady(worker, config));
  }
  await Promise.all(ready);
  let coordinatorStopping = false;
  let stopParentWatch = (): void => {};
  const stopWorkers = async (exitCode: number, reason: string): Promise<void> => {
    if (coordinatorStopping) return;
    coordinatorStopping = true;
    stopParentWatch();
    const stopped = workers.map(worker => new Promise<void>(resolve => {
      worker.onmessage = event => {
        const message = event.data as ShardStatusMessage;
        if (message.type === 'stopped') {
          resolve();
        }
      };
      worker.onerror = error => {
        console.error(`HLT_SOVEREIGN_WORKER_STOP_ERROR:${error.message}`);
        resolve();
      };
    }));
    for (const worker of workers) worker.postMessage({ type: 'stop' } satisfies ShardControlMessage);
    const graceful = Promise.all(stopped).then(() => true);
    const timedOut = Bun.sleep(10_000).then(() => false);
    if (!(await Promise.race([graceful, timedOut]))) {
      console.error(`HLT_SOVEREIGN_WORKER_STOP_TIMEOUT:${reason}`);
      for (const worker of workers) worker.terminate();
    }
    process.exitCode = exitCode;
  };
  for (const worker of workers) {
    worker.onmessage = event => {
      const message = event.data as ShardStatusMessage;
      if (message.type !== 'fatal') return;
      console.error(`HLT_SOVEREIGN_WORKER_POST_READY_FATAL:${message.error}`);
      void stopWorkers(1, message.error);
    };
    worker.onerror = error => {
      const reason = `HLT_SOVEREIGN_WORKER_POST_READY_ERROR:${error.message}`;
      console.error(reason);
      void stopWorkers(1, reason);
    };
  }
  for (const worker of workers) worker.postMessage({ type: 'activate' } satisfies ShardControlMessage);
  stopParentWatch = startParentLivenessWatch(
    'hlt-sovereign-runtime-host-coordinator',
    process.env['XLN_MANAGED_PARENT_PID'],
    () => void stopWorkers(1, 'managed-parent-lost'),
    250,
  );
  process.once('exit', stopParentWatch);
  process.once('SIGTERM', () => void stopWorkers(0, 'sigterm'));
  console.log(
    `HLT_SOVEREIGN_HOST_READY ports=${processFirstPort}-${processFirstPort + processLaneSeeds.length - 1} ` +
    `runtimes=${processLaneSeeds.length} workers=${workers.length} pid=${process.pid}`,
  );
};

if (isShardWorker) {
  runShardWorker();
} else {
  void runCoordinator().catch(error => {
    console.error(
      `HLT_SOVEREIGN_HOST_FATAL ${error instanceof Error ? error.stack || error.message : safeStringify(error)}`,
    );
    process.exit(1);
  });
}
