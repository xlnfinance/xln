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
  readPersistedRuntimeActivityJournal,
  readPersistedStorageFrameRecord,
  readPersistedStorageHead,
  submitCrossJurisdictionIntent,
  verifyLiveRuntimeStorage,
} from '../runtime.ts';
import { handleRuntimeAdapterMessage } from '../radapter/server';
import { RuntimeAdapterError } from '../radapter/errors';
import type {
  RuntimeAdapterFrameReceiptResponse,
  RuntimeAdapterPaymentRoutesResponse,
  RuntimeAdapterReadQuery,
} from '../radapter/types';
import type { RuntimeAdapterRequest } from '../radapter/types';
import type { Env } from '../types';
import type { RelaySocket } from './relay-direct';
import type { RegisterReceiptOptions, RuntimeIngressReceipt } from './ingress-receipts';

type ServerRpcHandlerDeps = {
  validateRuntimeInputAdmission?: (env: Env, input: Parameters<typeof enqueueRuntimeInput>[1]) => void;
  registerRuntimeInputReceipt?: (input: RegisterReceiptOptions) => RuntimeIngressReceipt;
  readRuntimeInputReceipt?: (id: string) => RuntimeIngressReceipt | null;
  buildRuntimeInputStatusUrl?: (id: string) => string;
};

const stringList = (value: string[] | string | undefined): string[] =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map(entry => entry.trim())
    .filter(Boolean);

export const readFrameReceipts = async (
  env: Env,
  query: RuntimeAdapterReadQuery = {},
): Promise<RuntimeAdapterFrameReceiptResponse> => {
  const latestHeight = await getPersistedLatestHeight(env);
  const fromHeight = Math.max(1, Math.floor(Number(query.fromHeight ?? 1)));
  const requestedToHeight = Math.max(fromHeight, Math.floor(Number(query.toHeight ?? latestHeight)));
  const toHeight = latestHeight > 0 ? Math.min(latestHeight, requestedToHeight) : 0;
  const limit = Math.max(1, Math.min(500, Math.floor(Number(query.limit ?? 200))));
  const pageToHeight = toHeight >= fromHeight ? Math.min(toHeight, fromHeight + limit - 1) : 0;
  const entityId = String(query.entityId || '').trim().toLowerCase();
  if (entityId && !/^0x[0-9a-f]{64}$/.test(entityId)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'frame receipt entityId must be a 32-byte entity id');
  }
  const eventNames = new Set(stringList(query.eventNames));
  const receipts = [];
  if (pageToHeight > 0) {
    for (let height = fromHeight; height <= pageToHeight; height += 1) {
      const activity = await readPersistedRuntimeActivityJournal(env, height);
      if (!activity) {
        throw new RuntimeAdapterError(
          'E_NOT_FOUND',
          `frame receipt history is unavailable for contiguous range ${fromHeight}-${pageToHeight}`,
        );
      }
      receipts.push({ height, timestamp: activity.timestamp, logs: activity.logs });
    }
  }
  const filtered = receipts.flatMap(receipt => {
    const logs = receipt.logs.filter(log => {
      if (eventNames.size > 0 && !eventNames.has(log.message)) return false;
      if (!entityId) return true;
      const hintedEntityId = String(log.entityId ?? log.data?.['entityId'] ?? '').trim().toLowerCase();
      return hintedEntityId === entityId;
    });
    if ((entityId || eventNames.size > 0) && logs.length === 0) return [];
    return [{ height: receipt.height, timestamp: receipt.timestamp, logs }];
  });
  // A caught-up reader starts one height beyond the durable head. Report that
  // head as the scanned watermark instead of zero, or durable consumers would
  // rewind their cursors and rescan the full journal on every idle poll.
  const scannedThroughHeight = pageToHeight > 0 ? pageToHeight : toHeight;
  return { fromHeight, toHeight: scannedThroughHeight, returned: filtered.length, receipts: filtered };
};

const findPaymentRoutes = async (
  env: Env,
  query: RuntimeAdapterReadQuery = {},
): Promise<RuntimeAdapterPaymentRoutesResponse> => {
  const sourceEntityId = String(query.sourceEntityId || '').trim().toLowerCase();
  const targetEntityId = String(query.targetEntityId || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(sourceEntityId) || !/^0x[0-9a-f]{64}$/.test(targetEntityId)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'payment route endpoints must be 32-byte entity ids');
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

  if (env.runtimeState?.p2p?.syncProfiles) await env.runtimeState.p2p.syncProfiles();
  const profilesReady = await ensureGossipProfiles(env, [sourceEntityId, targetEntityId]);
  if (!profilesReady) {
    throw new RuntimeAdapterError('E_INTERNAL', 'payment route profiles are unavailable', true);
  }
  const routes = await env.gossip.getNetworkGraph().findPaths(sourceEntityId, targetEntityId, amount, tokenId);
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

export const createServerRpcMessageHandler = ({
  validateRuntimeInputAdmission,
  registerRuntimeInputReceipt,
  readRuntimeInputReceipt,
  buildRuntimeInputStatusUrl,
}: ServerRpcHandlerDeps) =>
  async (ws: RelaySocket, request: RuntimeAdapterRequest, env: Env | null): Promise<void> => {
    await handleRuntimeAdapterMessage(ws, request, env, {
      enqueueRuntimeInput,
      submitCrossJurisdictionIntent: async (targetEnv, route) => {
        await submitCrossJurisdictionIntent(targetEnv, route);
      },
      controlRuntime: (targetEnv, action) => {
        if (action !== 'verify-chain') throw new RuntimeAdapterError('E_BAD_QUERY', `unsupported runtime control: ${action}`);
        return verifyLiveRuntimeStorage(targetEnv);
      },
      ...(validateRuntimeInputAdmission ? { validateRuntimeInputAdmission } : {}),
      ...(registerRuntimeInputReceipt ? { registerReceipt: registerRuntimeInputReceipt } : {}),
      ...(readRuntimeInputReceipt ? { readReceipt: readRuntimeInputReceipt } : {}),
      ...(buildRuntimeInputStatusUrl ? { buildRuntimeInputStatusUrl } : {}),
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
      readFrameReceipts,
      findPaymentRoutes,
    });
  };
