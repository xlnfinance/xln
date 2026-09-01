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
import { serializeTaggedJson, safeStringify } from '../../../../protocol/serialization';
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
  startJurisdictionWatchers,
  startRuntimeLoop,
  stopP2PAndWait,
  stopRuntimeLoopAndWait,
  validateRuntimeInputAdmission,
} from '../../../../runtime';
import { registerEnvChangeCallback } from '../../../../runtime/loop/loop-environment';
import { ensureLiveJAdapterForReplica } from '../../../../runtime/recovery/j-adapter-restore';
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
import {
  decodeSovereignRuntimeSeeds,
  SOVEREIGN_RUNTIMES_PER_WORKER,
} from './sovereign-runtime-sharding';
import { deriveDelta, isLeftEntity } from '../../../../account/utils';
import { getEntityReplicaById } from '../../../../entity/replica/replica-lookup';
import { startIdleShutdownWatch } from '../../../../support/process/idle-shutdown';
import { summarizeRuntimeQuiescence } from '../../../../orchestrator/mesh/mesh-common';
import { parseProfile } from '../../../../entity/profile';
import { toEntityId } from '../../../../protocol/identity';
import {
  resetHltPaymentOperationLedger,
  snapshotHltPaymentOperationLedger,
} from '../../../../support/performance/account-delivery-trace';
import { hltAuthorityEvidenceRelayUrls } from '../authority-evidence-policy';

type HostSocketData = Readonly<{ type: 'rpc'; runtimeId: string }>;
type HostSocket = ServerWebSocket<HostSocketData>;

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const HLT_HOST_BATCH_MAX_BODY_BYTES = LIMITS.MAX_HLT_HOST_BATCH_BODY_BYTES;
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

let laneSeeds: string[] = [];
let processRuntimeCount = 0;
let hostReady = false;
const runtimes = new Map<string, RuntimeReplica>();
const runtimeSlots: Array<Readonly<{ env: RuntimeReplica; runtimeId: string; port: number }>> = [];
const activeServers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

const traceLaneProgress = (): void => {
  if (process.env['XLN_HLT_TRACE_LANE_PROGRESS'] !== '1') return;
  const quiescence = [...runtimes.values()].reduce((total, env) => {
    const current = summarizeRuntimeQuiescence(env);
    total.pendingRuntimeWork += current.pendingRuntimeWork;
    total.pendingAccountFrames += current.pendingAccountFrames;
    total.accountMempoolTxs += current.accountMempoolTxs;
    return total;
  }, {
    runtimes: runtimes.size,
    pendingRuntimeWork: 0,
    pendingAccountFrames: 0,
    accountMempoolTxs: 0,
  });
  const ledger = snapshotHltPaymentOperationLedger();
  const paymentStages = Object.fromEntries(Object.entries(ledger.stages).map(([stage, row]) => [
    stage,
    {
      operations: row.operationAppearances,
      locks: row.lockIds.length,
      resolves: row.resolveIds.length,
      outcomes: row.outcomes,
    },
  ]));
  console.log(`HLT_LANE_PROGRESS ${safeStringify({
    firstPort,
    ...quiescence,
    paymentStages,
  })}`);
};

const resolveHltJurisdiction = (): JReplica => {
  const entries = Object.values(loadJurisdictions().jurisdictions);
  const configured = entries.find(entry => entry.primary === true && entry.status === 'active')
    ?? entries.find(entry => entry.status === 'active');
  if (!configured) throw new Error('HLT_SOVEREIGN_JURISDICTION_ACTIVE_MISSING');
  const portBase = Number(process.env['XLN_PORT_BASE']);
  if (configured.rpc.startsWith('/') && (!Number.isSafeInteger(portBase) || portBase < 1)) {
    throw new Error(`HLT_SOVEREIGN_JURISDICTION_RPC_PORT_BASE_INVALID:${String(portBase)}`);
  }
  const rpc = configured.rpc.startsWith('/')
    ? new URL(configured.rpc, `http://127.0.0.1:${portBase + 4}`).toString()
    : configured.rpc;
  if (!URL.canParse(rpc)) {
    throw new Error(`HLT_SOVEREIGN_JURISDICTION_RPC_INVALID:${configured.rpc}`);
  }
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
    rpcs: [rpc],
    chainId: configured.chainId,
    watcherConfirmationDepth: 0,
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
  waitForCommit: boolean;
  wave: number;
}>;

const pendingHostBatches = new Map<number, PendingHostBatch>();
let nextHostBatchWave = 0;
let drainingHostBatches = false;

const drainHostBatches = async (): Promise<void> => {
  if (drainingHostBatches) return;
  drainingHostBatches = true;
  try {
    while (true) {
      const batch = pendingHostBatches.get(nextHostBatchWave);
      if (!batch) return;
      pendingHostBatches.delete(nextHostBatchWave);
      try {
      // Validate the complete host wave before mutating any Runtime queue.
      // Queue acceptance is not a protocol receipt: bilateral Account state
      // and ACK drain remain the only financial completion evidence.
      for (const entry of batch.entries) {
        try {
          validateRuntimeInputAdmission(entry.env, entry.input);
        } catch (error) {
          throw new Error(
            `HLT_HOST_RUNTIME_INPUT_ADMISSION_FAILED:runtime=${entry.env.runtimeId}:` +
            `cause=${error instanceof Error ? error.message : String(error)}:` +
            `fatal=${safeStringify(entry.env.infrastructure?.fatalDebugPayload ?? null)}`,
          );
        }
      }
        if (batch.waitForCommit) {
          // Preparation is explicitly outside the offered window. Limit each
          // worker to a bounded bootstrap group and do not admit the next group
          // until these canonical Runtime transitions have committed in RAM.
          const commitStartedAt = performance.now();
          const priorHeights = batch.entries.map(entry => Number(entry.env.state.height));
          for (const entry of batch.entries) enqueueRuntimeInput(entry.env, entry.input);
          const phaseProbe = setTimeout(() => {
            const phases = new Map<string, number>();
            for (const entry of batch.entries) {
              const phase = entry.env.infrastructure?.runtimeFramePhase ?? 'idle';
              phases.set(phase, (phases.get(phase) ?? 0) + 1);
            }
            console.log(
              `HLT_HOST_SETUP_PHASE wave=${batch.wave} elapsedMs=${Math.ceil(performance.now() - commitStartedAt)} ` +
              `phases=${safeStringify(Object.fromEntries([...phases].sort()))}`,
            );
          }, 3_000);
          const committed = await Promise.all(batch.entries.map((entry, index) => waitForCommittedCondition(
            entry.env,
            () => {
              return entry.env.infrastructure?.stateMutationInFlight !== true &&
                Number(entry.env.state.height) > priorHeights[index]!;
            },
            20_000,
          ))).finally(() => clearTimeout(phaseProbe));
          if (committed.some(value => !value)) {
            const heights = batch.entries.map((entry, index) => ({
              runtimeId: entry.env.runtimeId,
              before: priorHeights[index],
              after: Number(entry.env.state.height),
              lifecycle: entry.env.infrastructure?.lifecyclePhase ?? null,
              loopActive: entry.env.infrastructure?.loopActive ?? null,
              loopPromise: Boolean(entry.env.infrastructure?.loopPromise),
              processing: Boolean(entry.env.infrastructure?.processingPromise),
              phase: entry.env.infrastructure?.runtimeFramePhase ?? null,
              stateMutationInFlight: entry.env.infrastructure?.stateMutationInFlight ?? false,
              inFlightEntityInputs: entry.env.infrastructure?.inFlightEntityInputs ?? 0,
              wakeRequested: entry.env.infrastructure?.wakeRequested ?? null,
              hasWakeWaiter: Boolean(entry.env.infrastructure?.wakeLoop),
              watchersPaused: entry.env.infrastructure?.jurisdictionWatchersPaused ?? false,
              queuedAt: entry.env.runtimeMempool.queuedAt ?? null,
              runtimeTxs: entry.env.runtimeMempool.runtimeTxs.length,
              entityInputs: entry.env.runtimeMempool.entityInputs.length,
              jInputs: entry.env.runtimeMempool.jInputs?.length ?? 0,
              fatal: entry.env.infrastructure?.fatalDebugPayload ?? null,
            }));
            throw new Error(
              `HLT_HOST_RUNTIME_INPUT_COMMIT_TIMEOUT:wave=${batch.wave}:heights=${safeStringify(heights)}`,
            );
          }
          console.log(
            `HLT_HOST_SETUP_BATCH_COMMITTED wave=${batch.wave} entries=${batch.entries.length} ` +
            `elapsedMs=${Math.ceil(performance.now() - commitStartedAt)}`,
          );
          batch.resolve(response({ ok: true, wave: batch.wave, accepted: batch.entries.length }));
        } else {
          // Offered load measures queue admission separately from financial
          // completion, which is proven by the Account ledger and ACK drain.
          batch.resolve(response({ ok: true, wave: batch.wave, accepted: batch.entries.length }));
          setTimeout(() => {
            try {
              for (const entry of batch.entries) enqueueRuntimeInput(entry.env, entry.input);
            } catch (error) {
              const message = `HLT_HOST_ACCEPTED_BATCH_ENQUEUE_FATAL:wave=${batch.wave}:` +
                (error instanceof Error ? error.message : String(error));
              console.error(message);
              if (isShardWorker) postShardStatus({ type: 'fatal', error: message });
              void stop(1);
            }
          }, 0);
        }
      } catch (error) {
        batch.resolve(response({
          ok: false,
          wave: batch.wave,
          error: error instanceof Error ? error.message : String(error),
        }, 400));
      }
      nextHostBatchWave += 1;
    }
  } finally {
    drainingHostBatches = false;
    if (pendingHostBatches.has(nextHostBatchWave)) void drainHostBatches();
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
      ['wave', 'entries', 'waitForCommit'],
      [],
      'HLT_HOST_RUNTIME_INPUT_BATCH_FIELDS_INVALID',
    );
    const wave = requireBoundaryInteger(root['wave'], 'HLT_HOST_RUNTIME_INPUT_BATCH_WAVE_INVALID');
    if (typeof root['waitForCommit'] !== 'boolean') {
      throw new Error('HLT_HOST_RUNTIME_INPUT_BATCH_WAIT_FOR_COMMIT_INVALID');
    }
    const waitForCommit = root['waitForCommit'];
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
      pendingHostBatches.set(wave, { entries, resolve, waitForCommit, wave });
      // A later HTTP request may finish parsing first. Hold it until every
      // earlier wave arrives so each sovereign Runtime sees exact user order.
      void drainHostBatches();
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
      ['hubProfile'],
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
    const sourceEnv = runtimes.get(runtimeIds[0]!)!;
    const sourceP2P = startP2P(sourceEnv);
    const suppliedProfile = body['hubProfile'] === undefined ? null : parseProfile(body['hubProfile']);
    if (
      suppliedProfile &&
      (suppliedProfile.entityId !== hubEntityId || suppliedProfile.runtimeId !== hubRuntimeId)
    ) {
      throw new Error('HLT_HOST_READINESS_PROFILE_IDENTITY_INVALID');
    }
    if (suppliedProfile && sourceP2P) await sourceP2P.admitSharedProfiles([suppliedProfile]);
    let hubProfile = sourceEnv.gossip.getProfile(hubEntityId);
    const cachedProfileReady = hubProfile?.runtimeId?.toLowerCase() === hubRuntimeId &&
      /^0x[0-9a-f]{64}$/.test(String(hubProfile.runtimeEncPubKey || ''));
    if (!cachedProfileReady && sourceP2P) {
      const refreshed = await sourceP2P.refreshSeedProfilesAndWait([hubEntityId], 4_000);
      hubProfile = refreshed ? sourceEnv.gossip.getProfile(hubEntityId) : undefined;
    }
    if (
      !hubProfile ||
      hubProfile.runtimeId?.toLowerCase() !== hubRuntimeId ||
      !/^0x[0-9a-f]{64}$/.test(String(hubProfile.runtimeEncPubKey || ''))
    ) return response({ ok: true, ready: false, missing: runtimeIds });
    const ready = await Promise.all(runtimeIds.map(async runtimeId => {
      const env = runtimes.get(runtimeId);
      if (!env) throw new Error(`HLT_HOST_READINESS_RUNTIME_MISSING:${runtimeId}`);
      // Population configuration owns transport startup. Readiness only
      // observes it; restarting 50 transports per poll starves this worker.
      const p2p = env.infrastructure?.p2p ?? null;
      if (!p2p) return false;
      if (!env.gossip.profiles.has(hubEntityId)) await p2p.admitSharedProfiles([hubProfile]);
      const directReady = p2p.prepareDirectEntityRoutes([hubEntityId]);
      const profile = env.gossip.profiles.get(hubEntityId);
      const ready = directReady && profile?.runtimeId?.toLowerCase() === hubRuntimeId &&
        /^0x[0-9a-f]{64}$/.test(String(profile.runtimeEncPubKey || ''));
      return ready;
    }));
    const missing = runtimeIds.filter((_runtimeId, index) => !ready[index]);
    return response({ ok: true, ready: missing.length === 0, missing });
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

/** Commit barrier plus P2P configuration for every Runtime packed into this
 * host. This replaces one control request and one read request per user; each
 * Runtime still owns and starts its own independent P2P instance. */
const handleHostPopulationConfigure = async (
  request: Request,
  authEnv: RuntimeReplica,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, authEnv);
  if (authError) return authError;
  try {
    const body = requireBoundaryRecord(
      await parseTaggedControlBody(request, HLT_HOST_BATCH_MAX_BODY_BYTES),
      'HLT_HOST_POPULATION_CONFIGURE_INVALID',
    );
    requireExactBoundaryKeys(
      body,
      ['targets', 'announceProfiles'],
      [],
      'HLT_HOST_POPULATION_CONFIGURE_FIELDS_INVALID',
    );
    if (typeof body['announceProfiles'] !== 'boolean') {
      throw new Error('HLT_HOST_POPULATION_CONFIGURE_ANNOUNCE_PROFILES_INVALID');
    }
    const announceProfiles = body['announceProfiles'];
    if (!Array.isArray(body['targets']) || body['targets'].length < 1 || body['targets'].length > runtimes.size) {
      throw new Error('HLT_HOST_POPULATION_CONFIGURE_TARGETS_INVALID');
    }
    const targets = body['targets'].map((value, index) => {
      const target = requireBoundaryRecord(value, `HLT_HOST_POPULATION_CONFIGURE_TARGET_INVALID:${index}`);
      requireExactBoundaryKeys(target, ['runtimeId', 'entityId'], [], `HLT_HOST_POPULATION_CONFIGURE_TARGET_FIELDS_INVALID:${index}`);
      const runtimeId = String(target['runtimeId'] || '').trim().toLowerCase();
      const entityId = String(target['entityId'] || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(runtimeId) || !/^0x[0-9a-f]{64}$/.test(entityId) || !runtimes.has(runtimeId)) {
        throw new Error(`HLT_HOST_POPULATION_CONFIGURE_TARGET_ID_INVALID:${index}:${runtimeId}:${entityId}`);
      }
      return { runtimeId, entityId };
    });
    if (new Set(targets.map(target => target.runtimeId)).size !== targets.length) {
      throw new Error('HLT_HOST_POPULATION_CONFIGURE_RUNTIME_DUPLICATE');
    }
    const committed = await Promise.all(targets.map(target => {
      const env = runtimes.get(target.runtimeId)!;
      return waitForCommittedCondition(
        env,
        () => env.infrastructure?.stateMutationInFlight !== true &&
          getEntityReplicaById(env, target.entityId) !== undefined,
        10_000,
      );
    }));
    const missing = targets.filter((_target, index) => !committed[index]);
    if (missing.length > 0) {
      throw new Error(`HLT_HOST_POPULATION_CONFIGURE_ENTITY_NOT_COMMITTED:${safeStringify(missing)}`);
    }
    // Start transport in bounded host turns so Bun can flush this response and
    // continue servicing Runtime frame I/O between groups.
    let next = 0;
    const startNext = (): void => {
      try {
        const end = Math.min(targets.length, next + 5);
        for (; next < end; next += 1) {
          const target = targets[next]!;
          const env = runtimes.get(target.runtimeId)!;
          startP2P(env, {
            relayUrls: [...hltAuthorityEvidenceRelayUrls(process.env)],
            advertiseEntityIds: announceProfiles ? [target.entityId] : [],
          });
        }
        if (next < targets.length) setTimeout(startNext, 0);
      } catch (error) {
        const message = `HLT_HOST_POPULATION_P2P_FATAL:${error instanceof Error ? error.message : String(error)}`;
        console.error(message);
        if (isShardWorker) postShardStatus({ type: 'fatal', error: message });
        void stop(1);
      }
    };
    setTimeout(startNext, 0);
    return response({ ok: true, configured: targets.length });
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

/** Operator-planned transport drain for TS Hub -> Rust Hub ownership transfer.
 * This is process infrastructure only: no ACK, cursor or receipt enters state. */
const handleHostPopulationP2PStop = async (
  request: Request,
  authEnv: RuntimeReplica,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, authEnv);
  if (authError) return authError;
  try {
    const body = requireBoundaryRecord(
      await parseTaggedControlBody(request, HLT_HOST_BATCH_MAX_BODY_BYTES),
      'HLT_HOST_POPULATION_P2P_STOP_INVALID',
    );
    requireExactBoundaryKeys(body, ['runtimeIds'], [], 'HLT_HOST_POPULATION_P2P_STOP_FIELDS_INVALID');
    if (!Array.isArray(body['runtimeIds']) || body['runtimeIds'].length < 1 || body['runtimeIds'].length > runtimes.size) {
      throw new Error('HLT_HOST_POPULATION_P2P_STOP_RUNTIME_IDS_INVALID');
    }
    const runtimeIds = body['runtimeIds'].map((value, index) => {
      const runtimeId = String(value || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(runtimeId) || !runtimes.has(runtimeId)) {
        throw new Error(`HLT_HOST_POPULATION_P2P_STOP_RUNTIME_ID_INVALID:${index}:${runtimeId}`);
      }
      return runtimeId;
    });
    if (new Set(runtimeIds).size !== runtimeIds.length) {
      throw new Error('HLT_HOST_POPULATION_P2P_STOP_RUNTIME_ID_DUPLICATE');
    }
    for (const runtimeId of runtimeIds) {
      const pending = summarizeRuntimeQuiescence(runtimes.get(runtimeId)!);
      if (pending.pendingRuntimeWork !== 0 || pending.pendingAccountFrames !== 0 || pending.accountMempoolTxs !== 0) {
        throw new Error(`HLT_HOST_POPULATION_P2P_STOP_NOT_QUIESCENT:${runtimeId}:${safeStringify(pending)}`);
      }
    }
    await Promise.all(runtimeIds.map(runtimeId => stopP2PAndWait(runtimes.get(runtimeId)!, 5_000)));
    return response({ ok: true, stopped: runtimeIds.length });
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

const handleHostRouteReadiness = async (
  request: Request,
  authEnv: RuntimeReplica,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, authEnv);
  if (authError) return authError;
  try {
    const body = requireBoundaryRecord(
      await parseTaggedControlBody(request, HLT_HOST_BATCH_MAX_BODY_BYTES),
      'HLT_HOST_ROUTE_READINESS_INVALID',
    );
    requireExactBoundaryKeys(body, ['hubEntityId', 'targets', 'profiles'], [], 'HLT_HOST_ROUTE_READINESS_FIELDS_INVALID');
    const hubEntityId = String(body['hubEntityId'] || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hubEntityId)) throw new Error('HLT_HOST_ROUTE_READINESS_HUB_INVALID');
    if (!Array.isArray(body['targets']) || body['targets'].length < 1 || body['targets'].length > runtimes.size) {
      throw new Error('HLT_HOST_ROUTE_READINESS_TARGETS_INVALID');
    }
    const targets = body['targets'].map((value, index) => {
      const target = requireBoundaryRecord(value, `HLT_HOST_ROUTE_READINESS_TARGET_INVALID:${index}`);
      requireExactBoundaryKeys(target, ['runtimeId', 'receiverEntityIds'], [], `HLT_HOST_ROUTE_READINESS_TARGET_FIELDS_INVALID:${index}`);
      const runtimeId = String(target['runtimeId'] || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(runtimeId) || !runtimes.has(runtimeId)) {
        throw new Error(`HLT_HOST_ROUTE_READINESS_RUNTIME_INVALID:${index}:${runtimeId}`);
      }
      if (!Array.isArray(target['receiverEntityIds']) || target['receiverEntityIds'].length < 1 || target['receiverEntityIds'].length > 1_000) {
        throw new Error(`HLT_HOST_ROUTE_READINESS_RECEIVERS_INVALID:${index}`);
      }
      const receiverEntityIds = target['receiverEntityIds'].map((raw, receiverIndex) => {
        const entityId = String(raw || '').trim().toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(entityId)) {
          throw new Error(`HLT_HOST_ROUTE_READINESS_RECEIVER_INVALID:${index}:${receiverIndex}`);
        }
        return entityId;
      });
      return { runtimeId, receiverEntityIds: [...new Set(receiverEntityIds)] };
    });
    if (new Set(targets.map(target => target.runtimeId)).size !== targets.length) {
      throw new Error('HLT_HOST_ROUTE_READINESS_RUNTIME_DUPLICATE');
    }
    if (!Array.isArray(body['profiles']) || body['profiles'].length < 1 || body['profiles'].length > 1_000) {
      throw new Error('HLT_HOST_ROUTE_READINESS_PROFILES_INVALID');
    }
    const suppliedProfiles = new Map(body['profiles'].map((raw, index) => {
      const profile = parseProfile(raw);
      if (profile.entityId === hubEntityId) {
        throw new Error(`HLT_HOST_ROUTE_READINESS_PROFILE_IS_HUB:${index}`);
      }
      return [profile.entityId, profile] as const;
    }));
    if (suppliedProfiles.size !== body['profiles'].length) {
      throw new Error('HLT_HOST_ROUTE_READINESS_PROFILE_DUPLICATE');
    }
    // Fetch the worker-wide union over one authenticated Runtime session.
    // Each receiving Runtime then independently sanitizes and verifies those
    // exact public profile bytes before installing them in its own RAM cache.
    // This removes one network round-trip per sender without sharing financial
    // state, signer keys, Runtime inputs or transport authority.
    const union = [...new Set(targets.flatMap(target => target.receiverEntityIds).map(toEntityId))];
    const sourceEnv = runtimes.get(targets[0]!.runtimeId)!;
    const absentUnion = union.filter(entityId => !sourceEnv.gossip.profiles.has(entityId));
    const sourceP2P = sourceEnv.infrastructure?.p2p;
    if (!sourceP2P) throw new Error('HLT_HOST_ROUTE_READINESS_SOURCE_P2P_MISSING');
    const absentProfiles = absentUnion.map(entityId => suppliedProfiles.get(entityId) ?? (() => {
      throw new Error(`HLT_HOST_ROUTE_READINESS_PROFILE_MISSING:${entityId}`);
    })());
    if (absentProfiles.length > 0) await sourceP2P.admitSharedProfiles(absentProfiles);
    const fetchedProfiles = new Map(union.flatMap(entityId => {
      const profile = sourceEnv.gossip.getProfile(entityId);
      return profile ? [[entityId, profile] as const] : [];
    }));
    const rows = await Promise.all(targets.map(async target => {
      const env = runtimes.get(target.runtimeId)!;
      const absentProfiles = target.receiverEntityIds.map(toEntityId).flatMap(entityId => {
        if (env.gossip.profiles.has(entityId)) return [];
        const profile = fetchedProfiles.get(entityId);
        return profile ? [profile] : [];
      });
      if (absentProfiles.length > 0) {
        const p2p = env.infrastructure?.p2p;
        if (!p2p) throw new Error(`HLT_HOST_ROUTE_READINESS_P2P_MISSING:${target.runtimeId}`);
        await p2p.admitSharedProfiles(absentProfiles);
      }
      return target.receiverEntityIds.flatMap(receiverEntityId => {
        const profile = env.gossip.profiles.get(receiverEntityId);
        const routable = profile?.accounts.some(account => account.counterpartyId.toLowerCase() === hubEntityId) === true;
        return routable ? [] : [`${target.runtimeId}:${receiverEntityId}`];
      });
    }));
    const missing = rows.flat();
    return response({ ok: true, ready: missing.length === 0, missing });
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

const handleHostLocalProfiles = async (
  request: Request,
  authEnv: RuntimeReplica,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, authEnv);
  if (authError) return authError;
  try {
    const body = requireBoundaryRecord(
      await parseTaggedControlBody(request, HLT_HOST_BATCH_MAX_BODY_BYTES),
      'HLT_HOST_LOCAL_PROFILES_INVALID',
    );
    requireExactBoundaryKeys(body, ['targets'], [], 'HLT_HOST_LOCAL_PROFILES_FIELDS_INVALID');
    if (!Array.isArray(body['targets']) || body['targets'].length < 1 || body['targets'].length > runtimes.size) {
      throw new Error('HLT_HOST_LOCAL_PROFILES_TARGETS_INVALID');
    }
    const profiles = body['targets'].map((raw, index) => {
      const target = requireBoundaryRecord(raw, `HLT_HOST_LOCAL_PROFILE_TARGET_INVALID:${index}`);
      requireExactBoundaryKeys(target, ['runtimeId', 'entityId'], [], `HLT_HOST_LOCAL_PROFILE_TARGET_FIELDS_INVALID:${index}`);
      const runtimeId = String(target['runtimeId'] || '').toLowerCase();
      const entityId = String(target['entityId'] || '').toLowerCase();
      const env = runtimes.get(runtimeId);
      if (!env || !/^0x[0-9a-f]{64}$/.test(entityId)) {
        throw new Error(`HLT_HOST_LOCAL_PROFILE_TARGET_ID_INVALID:${index}`);
      }
      const profile = parseProfile(env.gossip.getProfile(entityId));
      if (profile.runtimeId !== runtimeId || profile.entityId !== entityId) {
        throw new Error(`HLT_HOST_LOCAL_PROFILE_IDENTITY_INVALID:${index}`);
      }
      return profile;
    });
    return response({ ok: true, profiles });
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

/** One resident scan per OS host after the measured phase. This proves every
 * sovereign user Runtime and Account drained without 1,000 HTTP/RPC reads. */
const handleHostQuiescence = async (
  request: Request,
  authEnv: RuntimeReplica,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, authEnv);
  if (authError) return authError;
  try {
    const body = requireBoundaryRecord(
      await parseTaggedControlBody(request, HLT_HOST_BATCH_MAX_BODY_BYTES),
      'HLT_HOST_QUIESCENCE_INVALID',
    );
    requireExactBoundaryKeys(body, ['hubRuntimeId', 'runtimeIds'], [], 'HLT_HOST_QUIESCENCE_FIELDS_INVALID');
    const hubRuntimeId = String(body['hubRuntimeId'] || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(hubRuntimeId)) throw new Error('HLT_HOST_QUIESCENCE_HUB_INVALID');
    if (!Array.isArray(body['runtimeIds']) || body['runtimeIds'].length < 1 || body['runtimeIds'].length > runtimes.size) {
      throw new Error('HLT_HOST_QUIESCENCE_RUNTIME_IDS_INVALID');
    }
    const runtimeIds = body['runtimeIds'].map((value, index) => {
      const runtimeId = String(value || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(runtimeId) || !runtimes.has(runtimeId)) {
        throw new Error(`HLT_HOST_QUIESCENCE_RUNTIME_ID_INVALID:${index}:${runtimeId}`);
      }
      return runtimeId;
    });
    if (new Set(runtimeIds).size !== runtimeIds.length) throw new Error('HLT_HOST_QUIESCENCE_RUNTIME_ID_DUPLICATE');
    const totals = runtimeIds.reduce((result, runtimeId) => {
      const env = runtimes.get(runtimeId)!;
      const current = summarizeRuntimeQuiescence(env);
      result.pendingRuntimeWork += current.pendingRuntimeWork;
      result.pendingAccountFrames += current.pendingAccountFrames;
      result.accountMempoolTxs += current.accountMempoolTxs;
      const open = env.infrastructure?.p2p?.getDirectPeerState()
        .some(peer => peer.runtimeId.toLowerCase() === hubRuntimeId && peer.open) ?? false;
      if (open) result.openHubPeers += 1;
      return result;
    }, {
      runtimes: runtimeIds.length,
      openHubPeers: 0,
      pendingRuntimeWork: 0,
      pendingAccountFrames: 0,
      accountMempoolTxs: 0,
    });
    const details = runtimeIds.flatMap(runtimeId => {
      const env = runtimes.get(runtimeId)!;
      return [...env.state.eReplicas.values()].flatMap(entity =>
        [...entity.state.accounts.entries()].flatMap(([counterpartyId, account]) => {
          if (!account.pendingFrame && !account.activeDispute) return [];
          return [{
            runtimeId,
            entityId: entity.entityId,
            counterpartyId,
            currentHeight: account.currentHeight,
            status: account.status,
            activeDisputeObservedOnChain: account.activeDispute?.observedOnChain === true,
            pendingFrameHeight: account.pendingFrame?.height ?? null,
            pendingFrameStateHash: account.pendingFrame?.stateHash ?? null,
            pendingFrameTxTypes: account.pendingFrame?.accountTxs.map(tx => tx.type) ?? [],
            pendingInputKind: account.pendingAccountInput?.kind ?? null,
            lastOutboundAckHeight: account.lastOutboundAckFrame?.height ?? null,
            accountMempoolTxTypes: account.mempool.map(tx =>
              tx.type === 'settle_transition' ? `${tx.type}:${tx.data.kind}` : tx.type
            ),
            settlementWorkspaceStatus: account.state.settlementWorkspace?.status ?? null,
            settlementHankos: {
              left: account.state.settlementWorkspace?.leftHanko !== undefined,
              right: account.state.settlementWorkspace?.rightHanko !== undefined,
            },
            postSettlementProofHankos: {
              left: account.state.settlementWorkspace?.postSettlementDisputeProof?.leftHanko !== undefined,
              right: account.state.settlementWorkspace?.postSettlementDisputeProof?.rightHanko !== undefined,
            },
          }];
        }));
    });
    return response({ ok: true, ...totals, ...(details.length > 0 ? { details } : {}) });
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
};

/** Enable the real production watcher for one sovereign Runtime. Payment-only
 * HLT keeps the other 999 watchers paused so they cannot stampede one Anvil. */
const handleHostJurisdictionWatcherStart = async (
  request: Request,
  authEnv: RuntimeReplica,
): Promise<Response> => {
  const authError = requireDaemonControlAuth(request, authEnv);
  if (authError) return authError;
  try {
    const body = requireBoundaryRecord(
      await parseTaggedControlBody(request, HLT_HOST_BATCH_MAX_BODY_BYTES),
      'HLT_HOST_JURISDICTION_WATCHER_START_INVALID',
    );
    requireExactBoundaryKeys(
      body,
      ['runtimeId'],
      [],
      'HLT_HOST_JURISDICTION_WATCHER_START_FIELDS_INVALID',
    );
    const runtimeId = String(body['runtimeId'] || '').trim().toLowerCase();
    const env = runtimes.get(runtimeId);
    if (!env) throw new Error(`HLT_HOST_JURISDICTION_WATCHER_RUNTIME_UNKNOWN:${runtimeId}`);
    const jurisdictionName = String(env.activeJurisdiction || '').trim();
    if (!jurisdictionName) throw new Error('HLT_HOST_JURISDICTION_WATCHER_ACTIVE_J_MISSING');
    const adapter = await ensureLiveJAdapterForReplica(env, jurisdictionName, {
      allowBrowserVm: false,
      attempts: 1,
      context: `hlt-settlement:${runtimeId}`,
    });
    if (!adapter) throw new Error('HLT_HOST_JURISDICTION_WATCHER_ADAPTER_MISSING');
    (env.infrastructure ??= {}).jurisdictionWatchersPaused = false;
    startJurisdictionWatchers(env);
    if (!adapter.isWatching()) throw new Error('HLT_HOST_JURISDICTION_WATCHER_NOT_RUNNING');
    return response({ ok: true, runtimeId, jurisdictionName });
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
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
      // Runtime mutates H+1 in place before WAL publication. Never let the
      // HLT treat that unpublished candidate as committed financial state.
      if (env.infrastructure?.stateMutationInFlight === true) return false;
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
      return waitForCommittedCondition(env, () => targetReady(target), 1_000);
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
        lastOutboundAckHeight: account?.lastOutboundAckFrame?.height ?? null,
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
    numericSignerPrewarmCount: 1,
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
      enabled: false,
    },
  };
  // A primary-jurisdiction-only HLT has no user-side J event workload. Starting
  // one RPC watcher per co-located sovereign Runtime would create 1,000
  // identical pollers against one local Anvil and starve their Runtime loops.
  // H1 keeps its production J watcher; cross-j HLT leaves user watchers enabled.
  if (
    process.env['XLN_MESH_PRIMARY_JURISDICTION_ONLY'] === '1' &&
    process.env['XLN_MM_CROSS_J'] === '0'
  ) {
    (env.infrastructure ??= {}).jurisdictionWatchersPaused = true;
  }
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
  if (process.env['XLN_HLT_TRACE_LANE_PROGRESS'] === '1') {
    setInterval(traceLaneProgress, 1_000).unref();
  }
  // The production traffic path is each Runtime's own authenticated outbound
  // P2P socket. When per-user diagnostics are disabled, one authenticated
  // host control endpoint is sufficient; opening thousands of unused HTTP/RPC
  // listeners only measures HLT setup overhead.
  const controlSlots = process.env['XLN_HLT_PER_RUNTIME_CONTROL'] === '1'
    ? runtimeSlots
    : runtimeSlots.slice(0, 1);
  const servers = controlSlots.map(({ env, runtimeId, port }) => Bun.serve<HostSocketData>({
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
          runtimeIds: runtimeSlots.map(slot => slot.runtimeId),
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
      if (pathname === '/api/hlt/population-configure' && request.method === 'POST') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        return handleHostPopulationConfigure(request, env);
      }
      if (pathname === '/api/hlt/population-p2p-stop' && request.method === 'POST') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        return handleHostPopulationP2PStop(request, env);
      }
      if (pathname === '/api/hlt/route-readiness' && request.method === 'POST') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        return handleHostRouteReadiness(request, env);
      }
      if (pathname === '/api/hlt/local-profiles' && request.method === 'POST') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        return handleHostLocalProfiles(request, env);
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
        resetHltPaymentOperationLedger();
        return response({ ok: true });
      }
      if (pathname === '/api/hlt/op-counters' && request.method === 'GET') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        const authError = requireDaemonControlAuth(request, env);
        if (authError) return authError;
        return response({ counters: snapshotOpCounters() });
      }
      if (pathname === '/api/hlt/payment-ledger' && request.method === 'GET') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        const authError = requireDaemonControlAuth(request, env);
        if (authError) return authError;
        return response(snapshotHltPaymentOperationLedger());
      }
      if (pathname === '/api/hlt/financial-readiness' && request.method === 'POST') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        return handleHostFinancialReadiness(request, env);
      }
      if (pathname === '/api/hlt/quiescence' && request.method === 'POST') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        return handleHostQuiescence(request, env);
      }
      if (pathname === '/api/hlt/jurisdiction-watcher-start' && request.method === 'POST') {
        if (port !== firstPort) return response({ ok: false, error: 'Not found' }, 404);
        return handleHostJurisdictionWatcherStart(request, env);
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
  console.log(
    `HLT_SOVEREIGN_WORKER_READY controls=${servers.length} runtimes=${runtimes.size}`,
  );
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
  const processLaneSeeds = decodeSovereignRuntimeSeeds(secrets['laneSeedsBase64']);
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
