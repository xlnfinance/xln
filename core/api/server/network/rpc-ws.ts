import { readRuntimeFrameReceipts } from '../../runtime-adapter/frame-receipts';
import {
  ensureGossipProfiles,
  enqueueRuntimeInput,
  getPersistedLatestHeight,
  listPersistedCheckpointHeights,
  listPersistedEntityIdsAtHeight,
  loadEntityAccountDocFromStorageDb,
  loadEntityStateFromStorageDb,
  loadEntityViewPageFromStorageDb,
  readPersistedRuntimeActivityPage,
  readPersistedRuntimeActivityJournals,
  readPersistedAccountFrameHistory,
  readPersistedAccountSwapHistoryPage,
  readPersistedStorageFrameRecord,
  readPersistedStorageHead,
  submitCrossJurisdictionIntent,
} from '../../../runtime.ts';
import { handleRuntimeAdapterMessage, type RuntimeAdapterServerDeps } from '../../runtime-adapter/server';
import { RuntimeAdapterError } from '../../runtime-adapter/errors';
import { resolveRuntimeAdminControl } from '../control/runtime-admin';
import type {
  RuntimeAdapterPaymentRoutesResponse,
  RuntimeAdapterReadQuery,
  RuntimeAdapterRequest,
} from '../../runtime-adapter/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { RelaySocket } from './relay-direct';

type ServerRpcHandlerDeps = {
  validateRuntimeInputAdmission?: (env: RuntimeReplica, input: Parameters<typeof enqueueRuntimeInput>[1]) => void;
  deriveBrainVault?: RuntimeAdapterServerDeps['deriveBrainVault'];
  revealBrainVaultMnemonic?: RuntimeAdapterServerDeps['revealBrainVaultMnemonic'];
};

export const readFrameReceipts = (env: RuntimeReplica, query?: RuntimeAdapterReadQuery) =>
  readRuntimeFrameReceipts(
    {
      latestHeight: () => getPersistedLatestHeight(env),
      journals: (from, to) => readPersistedRuntimeActivityJournals(env, from, to),
    },
    query,
  );

export const findPaymentRoutes = async (
  env: RuntimeReplica,
  query: RuntimeAdapterReadQuery = {},
): Promise<RuntimeAdapterPaymentRoutesResponse> => {
  const sourceEntityId = String(query.sourceEntityId || '')
    .trim()
    .toLowerCase();
  const targetEntityId = String(query.targetEntityId || '')
    .trim()
    .toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(sourceEntityId) || !/^0x[0-9a-f]{64}$/.test(targetEntityId)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'payment route endpoints must be 32-byte entity ids');
  }
  const fundingAccountId = query.fundingAccountId?.trim().toLowerCase();
  if (fundingAccountId !== undefined && !/^0x[0-9a-f]{64}$/.test(fundingAccountId)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'funding account must be a 32-byte entity id');
  }
  const tokenId = Number(query.tokenId);
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'payment route tokenId must be a positive integer');
  }
  let amount: bigint;
  try {
    amount = BigInt(String(query.amount || ''));
  } catch {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'payment route amount must be an integer string');
  }
  if (amount <= 0n) throw new RuntimeAdapterError('E_BAD_QUERY', 'payment route amount must be positive');

  if (env.infrastructure?.p2p?.syncProfiles) await env.infrastructure.p2p.syncProfiles();
  const profilesReady = await ensureGossipProfiles(env, [sourceEntityId, targetEntityId]);
  if (!profilesReady) {
    throw new RuntimeAdapterError('E_INTERNAL', 'payment route profiles are unavailable', true);
  }
  let routes = await env.gossip
    .getNetworkGraph()
    .findPaths(sourceEntityId, targetEntityId, amount, tokenId, fundingAccountId);
  if (routes.length === 0 && env.infrastructure?.p2p?.ensureRoutes) {
    // Pull-only gossip: ask the relay for the profile chains that route here.
    await env.infrastructure.p2p.ensureRoutes(sourceEntityId, targetEntityId, amount, tokenId);
    routes = await env.gossip
      .getNetworkGraph()
      .findPaths(sourceEntityId, targetEntityId, amount, tokenId, fundingAccountId);
  }
  if (routes.length === 0) {
    throw new RuntimeAdapterError('E_NOT_FOUND', `no payment route from ${sourceEntityId} to ${targetEntityId}`);
  }
  return {
    routes: routes.map(route => ({
      path: route.path,
      hops: route.hops.map(hop => ({
        from: hop.from,
        to: hop.to,
        fee: hop.fee.toString(),
        feePPM: hop.feePPM,
      })),
      totalFee: route.totalFee.toString(),
      senderAmount: route.totalAmount.toString(),
      recipientAmount: amount.toString(),
      probability: route.probability,
    })),
  };
};

export const createServerRpcMessageHandler =
  ({ validateRuntimeInputAdmission, deriveBrainVault, revealBrainVaultMnemonic }: ServerRpcHandlerDeps) =>
  async (ws: RelaySocket, request: RuntimeAdapterRequest, env: RuntimeReplica | null): Promise<void> => {
    await handleRuntimeAdapterMessage(ws, request, env, {
      enqueueRuntimeInput,
      submitCrossJurisdictionIntent: async (targetEnv, route) => {
        await submitCrossJurisdictionIntent(targetEnv, route);
      },
      controlRuntime: resolveRuntimeAdminControl,
      ...(validateRuntimeInputAdmission ? { validateRuntimeInputAdmission } : {}),
      ...(deriveBrainVault ? { deriveBrainVault } : {}),
      ...(revealBrainVaultMnemonic ? { revealBrainVaultMnemonic } : {}),
      readHead: targetEnv => readPersistedStorageHead(targetEnv),
      readFrame: (targetEnv, height) => readPersistedStorageFrameRecord(targetEnv, height),
      listCheckpoints: targetEnv => listPersistedCheckpointHeights(targetEnv),
      loadEntityState: (targetEnv, entityId, height) => loadEntityStateFromStorageDb(targetEnv, entityId, height),
      loadEntityAccountDoc: (targetEnv, entityId, counterpartyId, height) =>
        loadEntityAccountDocFromStorageDb(targetEnv, entityId, counterpartyId, height),
      loadEntityViewPage: (targetEnv, entityId, height, query) =>
        loadEntityViewPageFromStorageDb(targetEnv, entityId, height, query),
      listEntityIdsAtHeight: (targetEnv, height) => listPersistedEntityIdsAtHeight(targetEnv, height),
      readActivityPage: (targetEnv, options) => readPersistedRuntimeActivityPage(targetEnv, options),
      readAccountSwapHistoryPage: (targetEnv, entityId, counterpartyId, options) =>
        readPersistedAccountSwapHistoryPage(targetEnv, entityId, counterpartyId, options),
      readAccountFrameHistory: (targetEnv, entityId, counterpartyId, limit) =>
        readPersistedAccountFrameHistory(targetEnv, entityId, counterpartyId, limit),
      readFrameReceipts,
      findPaymentRoutes,
    });
  };
