import { isAbsolute } from 'node:path';
import type { createExternalWalletApi } from '../../../api/public/external-wallet-api';
import { handleGossipProfilesSendReady } from '../../../api/server/control/gossip-send-ready';
import { requiresLocalNodeOperator } from '../../../api/server/control/node-http-access';
import type { StackManagerController } from '../../../api/server/control/stack-manager';
import { handleLendingStateRequest } from '../../../api/server/entities/lending';
import { handleOffchainFaucet } from '../../../api/server/faucet/offchain';
import { enforceFaucetPolicy } from '../../../api/server/faucet/policy';
import { handleReserveFaucet } from '../../../api/server/faucet/reserve';
import { handleRuntimeActivityRequest } from '../../../api/server/health/activity';
import { handleKnownProfileRequest } from '../../../api/server/network/gossip-profiles';
import { JSON_HEADERS } from '../../../api/server/utils';
import type { JAdapter, JTokenInfo } from '../../../jurisdiction/adapter/types';
import type { DirectRuntimeSessionState } from '../../../network/p2p/direct-runtime-bun';
import {
  buildMarketSnapshotForReplica,
  normalizeMarketEntityId,
  normalizeMarketPairId,
  RPC_MARKET_DEFAULT_DEPTH,
  RPC_MARKET_MAX_DEPTH,
} from '../../../network/relay/market/snapshot';
import type { createRelayStore } from '../../../network/relay/store';
import { safeStringify, serializeTaggedJson } from '../../../protocol/serialization';
import {
  buildRuntimeRecoveryBundle,
  enqueueRuntimeInput,
  validateRuntimeInputAdmission,
} from '../../../runtime';
import { ensureRuntimeInfrastructure } from '../../../runtime/envelope/replica-envelope';
import { withRuntimeCommittedRead } from '../../../runtime/frame/lifecycle/writer-lock';
import { pauseJurisdictionWatchersAndWait } from '../../../runtime/loop/loop-watchers';
import type { RuntimeReplica } from '../../../runtime/types';
import { writeDurableFile } from '../../../storage/fs-durability';
import { exportConcreteCheckpointSource } from '../../../storage/read/concrete-checkpoint-source';
import { getRuntimeWalDb, getStorageDb } from '../../../storage/runtime-dbs';
import { resetOpCounters, snapshotOpCounters } from '../../../support/performance/op-counters';
import {
  getAccountReplica,
  getCreditGrantedByEntity,
  getEntityOutCapacity,
  getEntityReplicaById,
  hasAccount,
  serializeAccountDelta,
} from '../../mesh/mesh-common';
import { checkpointNodeRuntime, quiesceNodeRuntime } from '../../process/node-runtime-quiesce';
import type { DirectEntityInputDebug } from '../hub-runtime-transport';
import { handleMarketPairCatalogRequest } from '../market-catalog-http';
import { requireJAdapterForDebugReserve } from './hub-jurisdiction-binding';
import type { HubBootstrapEntry } from './hub-node-types';

const summarizeRecentRuntimeInputs = (
  inputs:
    | Array<{
        entityId?: string;
        entityTxs?: Array<{ type?: string }>;
      }>
    | undefined,
): Array<{ entityId: string; txs: string[] }> =>
  (inputs || []).slice(-10).map(input => ({
    entityId: String(input.entityId || '').slice(-8),
    txs: (input.entityTxs || []).map(tx => String(tx?.type || '')),
  }));

const handleAccountStatusRequest = (
  env: RuntimeReplica,
  request: Request,
  url: URL,
  defaultHubEntityId: string | null,
  directInput: {
    lastSeen: DirectEntityInputDebug | null;
    lastError: DirectEntityInputDebug | null;
  },
): Response | null => {
  if (
    url.pathname !== '/api/account/status' ||
    request.method !== 'GET'
  ) {
    return null;
  }
  const hubEntityId = String(
    url.searchParams.get('hubEntityId') || defaultHubEntityId || '',
  ).toLowerCase();
  const counterpartyEntityId = String(
    url.searchParams.get('counterpartyEntityId') || '',
  ).toLowerCase();
  if (!hubEntityId || !counterpartyEntityId) {
    return new Response(
      safeStringify({
        success: false,
        code: 'ACCOUNT_STATUS_BAD_REQUEST',
        error: 'hubEntityId and counterpartyEntityId are required',
      }),
      { status: 400, headers: JSON_HEADERS },
    );
  }
  const account = getAccountReplica(env, hubEntityId, counterpartyEntityId);
  const replica = getEntityReplicaById(env, hubEntityId);
  const tokenIds = String(url.searchParams.get('tokenIds') || '')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isInteger(value) && value > 0);
  return new Response(
    safeStringify({
      success: true,
      hubEntityId,
      counterpartyEntityId,
      hasAccount:
        hasAccount(env, hubEntityId, counterpartyEntityId) || Boolean(account),
      ready: Boolean(
        account?.currentFrame &&
          Number(account.currentHeight ?? 0) > 0 &&
          !account.pendingFrame &&
          Number(account.mempool?.length ?? 0) === 0,
      ),
      currentHeight: Number(account?.currentHeight ?? 0),
      pendingFrameHeight: account?.pendingFrame
        ? Number(account.pendingFrame.height ?? 0)
        : null,
      mempool: Number(account?.mempool?.length ?? 0),
      tokens: tokenIds.map(tokenId => ({
        tokenId,
        hasDelta: Boolean(account?.state.deltas?.has(tokenId)),
        hubGranted: account
          ? getCreditGrantedByEntity(account, hubEntityId, tokenId).toString()
          : '0',
        peerGranted: account
          ? getCreditGrantedByEntity(account, counterpartyEntityId, tokenId).toString()
          : '0',
        hubOutCapacity: account
          ? getEntityOutCapacity(account, hubEntityId, tokenId).toString()
          : '0',
        delta: serializeAccountDelta(account?.state.deltas?.get(tokenId)),
      })),
      runtime: {
        height: Number(env.state.height ?? 0),
        timestamp: Number(env.state.timestamp ?? 0),
        halted: Boolean(env.infrastructure?.halted),
        operatorStatus: env.infrastructure?.operatorStatus ?? null,
        fatalDebugPayload: env.infrastructure?.fatalDebugPayload ?? null,
        loopActive: Boolean(env.infrastructure?.loopActive),
        framePhase: env.infrastructure?.runtimeFramePhase ?? null,
        inFlightEntityInputs: env.infrastructure?.inFlightEntityInputs ?? 0,
        activeStep: env.activeProcessProgressStep ?? null,
        pendingNetworkOutputs: env.pendingNetworkOutputs?.length ?? 0,
        pendingOutputs: env.pendingOutputs?.length ?? 0,
        networkInbox: env.networkInbox?.length ?? 0,
        runtimeMempool: summarizeRecentRuntimeInputs(
          env.runtimeMempool?.entityInputs,
        ),
      },
      replica: replica
        ? {
            key: `${String(replica.entityId || '').toLowerCase()}:${String(
              replica.signerId || '',
            ).toLowerCase()}`,
            entityId: replica.entityId,
            signerId: replica.signerId,
            mempool: (replica.mempool || []).map(tx => String(tx?.type || '')),
            proposalTxs: (replica.proposal?.txs || []).map(tx =>
              String(tx?.type || ''),
            ),
            lockedFrameTxs: (replica.lockedFrame?.txs || []).map(tx =>
              String(tx?.type || ''),
            ),
          }
        : null,
      directInput,
    }),
    { headers: JSON_HEADERS },
  );
};

const handleMarketSnapshotsRequest = (
  env: RuntimeReplica,
  request: Request,
  url: URL,
  defaultHubEntityId: string,
): Response | null => {
  if (
    url.pathname !== '/api/market/snapshots' ||
    request.method !== 'GET'
  ) {
    return null;
  }
  const pairIds = Array.from(
    new Set(
      url.searchParams
        .getAll('pair')
        .concat(url.searchParams.getAll('pairId'))
        .map(normalizeMarketPairId)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (pairIds.length === 0) {
    return new Response(
      safeStringify({ error: 'Missing valid pair query parameters' }),
      { status: 400, headers: JSON_HEADERS },
    );
  }
  const depthRaw = Number(
    url.searchParams.get('depth') || String(RPC_MARKET_DEFAULT_DEPTH),
  );
  const depth = Number.isFinite(depthRaw)
    ? Math.max(1, Math.min(Math.floor(depthRaw), RPC_MARKET_MAX_DEPTH))
    : RPC_MARKET_DEFAULT_DEPTH;
  const requestedRaw =
    url.searchParams.get('hubEntityId') ||
    url.searchParams.get('hub') ||
    '';
  const hubEntityId = requestedRaw
    ? normalizeMarketEntityId(requestedRaw)
    : defaultHubEntityId;
  if (!hubEntityId) {
    return new Response(
      safeStringify({
        error: 'Invalid hubEntityId query parameter',
        code: 'E_BAD_QUERY',
      }),
      { status: 400, headers: JSON_HEADERS },
    );
  }
  const replica = getEntityReplicaById(env, hubEntityId);
  if (!replica) {
    return new Response(
      safeStringify({
        error: `Unknown market hub: ${hubEntityId}`,
        code: 'E_UNKNOWN_HUB',
        hubEntityId,
      }),
      { status: 404, headers: JSON_HEADERS },
    );
  }
  const snapshots = pairIds.map(pairId =>
    buildMarketSnapshotForReplica(
      replica,
      hubEntityId,
      pairId,
      depth,
    ),
  );
  return new Response(
    safeStringify({ hubEntityId, depth, snapshots }),
    { headers: JSON_HEADERS },
  );
};

const handleDebugReserveRequest = async (
  env: RuntimeReplica,
  request: Request,
  url: URL,
): Promise<Response | null> => {
  if (url.pathname !== '/api/debug/reserve' || request.method !== 'GET') {
    return null;
  }
  const entityId = String(url.searchParams.get('entityId') || '').trim();
  const tokenId = Number(url.searchParams.get('tokenId') || '1');
  const jurisdictionRef = String(
    url.searchParams.get('jurisdiction') || '',
  ).trim();
  if (!entityId) {
    return new Response(safeStringify({ error: 'Missing entityId' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return new Response(safeStringify({ error: 'Invalid tokenId' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }
  try {
    const adapter = requireJAdapterForDebugReserve(
      env,
      entityId,
      jurisdictionRef,
    );
    const reserve = await adapter.getReserves(entityId, tokenId);
    return new Response(
      safeStringify({
        ok: true,
        entityId,
        tokenId,
        ...(jurisdictionRef ? { jurisdiction: jurisdictionRef } : {}),
        reserve: reserve.toString(),
      }),
      { headers: JSON_HEADERS },
    );
  } catch (error) {
    return new Response(
      safeStringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};

export const createHubControlRequestHandler = (dependencies: {
  state: RuntimeReplica;
  nodeName: string;
  pauseBootstrap: () => Promise<() => void>;
  markShuttingDown: () => void;
}): ((request: Request, url: URL) => Promise<Response | null>) =>
  async (request, url) => {
    if (request.method === 'GET' && url.pathname === '/api/control/performance/op-counters') {
      return new Response(safeStringify({ counters: snapshotOpCounters() }), { headers: JSON_HEADERS });
    }
    if (request.method !== 'POST') return null;
    if (url.pathname === '/api/control/performance/background-io/stop') {
      if (process.env['XLN_HLT_DIRECT_ONLY'] !== '1') {
        return new Response(safeStringify({ ok: false, error: 'HLT_ONLY' }), {
          status: 403,
          headers: JSON_HEADERS,
        });
      }
      await pauseJurisdictionWatchersAndWait(dependencies.state);
      dependencies.state.infrastructure?.p2p?.pauseBackgroundIo();
      return new Response(safeStringify({ ok: true }), { headers: JSON_HEADERS });
    }
    if (url.pathname === '/api/control/performance/op-counters/reset') {
      resetOpCounters();
      return new Response(safeStringify({ ok: true }), { headers: JSON_HEADERS });
    }
    if (url.pathname === '/api/control/runtime/snapshot') {
      const outputPath = String(process.env['XLN_RUNTIME_SNAPSHOT_EXPORT_PATH'] || '').trim();
      if (!outputPath || !isAbsolute(outputPath)) {
        return new Response(
          safeStringify({ ok: false, error: 'RUNTIME_SNAPSHOT_EXPORT_PATH_NOT_CONFIGURED' }),
          { status: 409, headers: JSON_HEADERS },
        );
      }
      try {
        if (
          process.env['XLN_HLT_AUTHORITY_EVIDENCE'] === '1' &&
          process.env['XLN_HLT_ENGINE'] !== 'ts'
        ) throw new Error('HLT_PARITY_CHECKPOINT_TS_ENGINE_REQUIRED');
        const releaseBootstrapPause = await dependencies.pauseBootstrap();
        try {
          const snapshotResult: {
            value?: Readonly<{
              runtimeId: string;
              height: number;
              checkpointHash: string;
            }>;
          } = {};
          await checkpointNodeRuntime(dependencies.state, {
            workTimeoutMs: 20_000,
            loopTimeoutMs: 5_000,
            quietMs: 750,
            resumePersistenceAfterCheckpoint: true,
            persist: async () => {
            const concreteCheckpoint = process.env['XLN_HLT_AUTHORITY_EVIDENCE'] === '1'
              ? await exportConcreteCheckpointSource(dependencies.state, {
                  getStorageDb: (env, role) => getStorageDb(
                    env,
                    { ensureRuntimeInfrastructure },
                    role,
                  ),
                  getRuntimeWalDb: env => getRuntimeWalDb(
                    env,
                    { ensureRuntimeInfrastructure },
                  ),
                })
              : null;
            const bundle = await withRuntimeCommittedRead(dependencies.state, async () => {
              const { readPersistedFrameJournal } = await import('../../../runtime');
              const tip = dependencies.state.state.height > 0
                ? await readPersistedFrameJournal(dependencies.state, dependencies.state.state.height)
                : null;
              if (dependencies.state.state.height > 0 && !tip) throw new Error('RECOVERY_BUNDLE_CHECKPOINT_FRAME_MISSING');
              return buildRuntimeRecoveryBundle(dependencies.state, {
                kind: 'snapshot',
                frames: tip ? [tip] : [],
                signers: [{
                  index: 1,
                  address: String(dependencies.state.runtimeId || '').toLowerCase(),
                  name: `${dependencies.nodeName} Runtime`,
                }],
              });
            });
            await writeDurableFile(outputPath, `${serializeTaggedJson(bundle)}\n`);
            if (concreteCheckpoint) {
              await writeDurableFile(
                `${outputPath}.concrete-checkpoint.json`,
                `${safeStringify(concreteCheckpoint)}\n`,
              );
            }
            const checkpointHash = bundle.checkpointHash;
            if (!checkpointHash) throw new Error('RUNTIME_SNAPSHOT_CHECKPOINT_HASH_MISSING');
            snapshotResult.value = {
              runtimeId: bundle.runtimeId,
              height: bundle.runtimeHeight,
              checkpointHash,
            };
            },
          });
          const snapshotSummary = snapshotResult.value;
          if (!snapshotSummary) throw new Error('RUNTIME_SNAPSHOT_EXPORT_MISSING');
          return new Response(safeStringify({
            ok: true,
            ...snapshotSummary,
          }), { headers: JSON_HEADERS });
        } finally {
          // A checkpoint fences producers only while its root and WAL boundary
          // are captured. Keeping bootstrap paused afterwards stranded Accounts
          // opened by support peers after the base snapshot.
          releaseBootstrapPause();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Response(
          safeStringify({ ok: false, error: message }),
          { status: 503, headers: JSON_HEADERS },
        );
      }
    }
    const stopP2P = url.pathname === '/api/control/p2p/stop';
    const quiesceRuntime =
      url.pathname === '/api/control/core/quiesce';
    if (!stopP2P && !quiesceRuntime) return null;
    dependencies.markShuttingDown();
    try {
      await dependencies.pauseBootstrap();
      const result = await quiesceNodeRuntime(dependencies.state, {
        workTimeoutMs: stopP2P ? 10_000 : 20_000,
        loopTimeoutMs: 5_000,
        ...(quiesceRuntime ? { quietMs: 750 } : {}),
      });
      return new Response(safeStringify({ ok: true, ...result }), {
        headers: JSON_HEADERS,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const operation = stopP2P ? 'p2p stop' : 'runtime quiesce';
      console.error(
        `[${dependencies.nodeName}] ${operation} failed: ${message}`,
      );
      return new Response(
        safeStringify({ ok: false, error: message }),
        { status: 503, headers: JSON_HEADERS },
      );
    }
  };

const currentRuntimeHeight = (env: RuntimeReplica | null): number =>
  Math.max(0, Math.floor(Number(env?.state.height ?? 0)));

export type HubHttpContext = {
  env: RuntimeReplica;
  hubBootstraps: HubBootstrapEntry[];
  externalWalletApi: ReturnType<typeof createExternalWalletApi>;
  faucetRelayStore: ReturnType<typeof createRelayStore>;
  getBootstrap: () => { entityId: string; signerId: string } | null;
  getJAdapter: () => JAdapter | null;
  ensureTokenCatalog: () => Promise<JTokenInfo[]>;
  getDirectInputDebug: () => {
    lastSeen: DirectEntityInputDebug | null;
    lastError: DirectEntityInputDebug | null;
  };
  getDirectRuntimeSessions: () => DirectRuntimeSessionState[];
  handleStatus: (url: URL, operatorAuthorized: boolean) => Response | null;
  handleControl: (request: Request, url: URL) => Promise<Response | null>;
  handleJurisdictions: (url: URL) => Response | null;
  stackManagerController: StackManagerController;
};

export const handleHubHttpRequest = async (
  context: HubHttpContext,
  request: Request,
  url: URL,
  operatorAuthorized: boolean,
): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: JSON_HEADERS });
  }
  if (requiresLocalNodeOperator(url) && !operatorAuthorized) {
    return new Response(
      safeStringify({ error: 'Operator access required' }),
      { status: 403, headers: JSON_HEADERS },
    );
  }
  const faucetPolicyResponse = await enforceFaucetPolicy(request, operatorAuthorized, process.env, JSON_HEADERS);
  if (faucetPolicyResponse) return faucetPolicyResponse;
  const statusResponse = context.handleStatus(url, operatorAuthorized);
  if (statusResponse) return statusResponse;
  if (url.pathname === '/api/control/p2p/direct-sessions' && request.method === 'GET') {
    return new Response(safeStringify({
      ok: true,
      runtimeId: String(context.env.runtimeId || '').toLowerCase(),
      sessions: context.getDirectRuntimeSessions(),
    }), { headers: JSON_HEADERS });
  }
  if (url.pathname === '/api/gossip/profile' && request.method === 'GET') {
    // Expose this Hub Runtime's admitted profile view. HLT and operators must
    // verify the encrypted return route before opening a bilateral Account.
    return handleKnownProfileRequest({
      request,
      env: context.env,
      relayStore: null,
      headers: JSON_HEADERS,
    });
  }
  if (url.pathname === '/api/control/gossip-profiles-send-ready' && request.method === 'POST') {
    return handleGossipProfilesSendReady(request, context.env, JSON_HEADERS);
  }
  if (url.pathname === '/api/stack-manager/status' && request.method === 'GET') {
    return context.stackManagerController.status(request, context.env);
  }
  if (url.pathname === '/api/control/stack-manager/deploy' && request.method === 'POST') {
    return context.stackManagerController.deploy(request, context.env);
  }
  const accountStatusResponse = handleAccountStatusRequest(
    context.env,
    request,
    url,
    context.getBootstrap()?.entityId ?? null,
    context.getDirectInputDebug(),
  );
  if (accountStatusResponse) return accountStatusResponse;
  const controlResponse = await context.handleControl(request, url);
  if (controlResponse) return controlResponse;
  const jurisdictionsResponse = context.handleJurisdictions(url);
  if (jurisdictionsResponse) return jurisdictionsResponse;

  const bootstrap = context.getBootstrap();
  const jadapter = context.getJAdapter();
  if (!bootstrap || !jadapter) {
    return new Response(safeStringify({ error: 'HUB_NOT_READY' }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }
  const marketCatalogResponse = handleMarketPairCatalogRequest(
    context.env,
    request,
    url,
    bootstrap.entityId,
  );
  if (marketCatalogResponse) return marketCatalogResponse;
  const marketResponse = handleMarketSnapshotsRequest(
    context.env,
    request,
    url,
    bootstrap.entityId,
  );
  if (marketResponse) return marketResponse;
  if (url.pathname === '/api/lending/state' && request.method === 'GET') {
    return handleLendingStateRequest({
      req: request,
      env: context.env,
      headers: JSON_HEADERS,
      activeHubEntityIds: context.hubBootstraps.map(entry => entry.entityId),
    });
  }
  if (url.pathname === '/api/tokens' && request.method === 'GET') {
    return context.externalWalletApi.handleTokens();
  }
  if (
    url.pathname === '/api/external-wallet/snapshot' &&
    request.method === 'POST'
  ) {
    return context.externalWalletApi.handleWalletSnapshot(request);
  }
  if (url.pathname === '/api/faucet/erc20' && request.method === 'POST') {
    return context.externalWalletApi.handleErc20Faucet(request);
  }
  if (url.pathname === '/api/faucet/gas' && request.method === 'POST') {
    return context.externalWalletApi.handleGasFaucet(request);
  }
  if (url.pathname === '/api/faucet/reserve' && request.method === 'POST') {
    return handleReserveFaucet({
      req: request,
      env: context.env,
      headers: JSON_HEADERS,
      relayStore: { activeHubEntityIds: [bootstrap.entityId] },
      getJAdapter: () => jadapter,
      ensureTokenCatalog: context.ensureTokenCatalog,
      validateRuntimeInputAdmission,
      enqueueRuntimeInput,
    });
  }
  if (url.pathname === '/api/faucet/offchain' && request.method === 'POST') {
    context.faucetRelayStore.activeHubEntityIds =
      context.hubBootstraps.map(entry => entry.entityId);
    return handleOffchainFaucet({
      req: request,
      env: context.env,
      headers: JSON_HEADERS,
      relayStore: context.faucetRelayStore,
      enqueueRuntimeInput,
      validateRuntimeInputAdmission,
      getCurrentRuntimeHeight: currentRuntimeHeight,
    });
  }
  const debugReserveResponse = await handleDebugReserveRequest(
    context.env,
    request,
    url,
  );
  if (debugReserveResponse) return debugReserveResponse;
  if (
    url.pathname === '/api/debug/activity' &&
    request.method === 'GET'
  ) {
    return handleRuntimeActivityRequest(context.env, url, JSON_HEADERS);
  }
  return new Response(safeStringify({ error: 'Not found' }), {
    status: 404,
    headers: JSON_HEADERS,
  });
};
