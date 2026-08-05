import {
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
} from '../../runtime.ts';
import { handleRuntimeAdapterMessage, type RuntimeAdapterServerDeps } from '../runtime-adapter/server';
import { RuntimeAdapterError } from '../runtime-adapter/errors';
import { findRuntimePaymentRoutes } from '../runtime-adapter/payment-routes';
import type {
  RuntimeAdapterFrameReceiptResponse,
  RuntimeAdapterReadQuery,
} from '../runtime-adapter/types';
import type { RuntimeAdapterRequest } from '../runtime-adapter/types';
import type { RuntimeReplica } from '../../runtime/types';
import type { RelaySocket } from './relay-direct';
import type { RegisterReceiptOptions, RuntimeIngressReceipt } from '../../runtime/ingress-receipts';

type ServerRpcHandlerDeps = {
  validateRuntimeInputAdmission?: (env: RuntimeReplica, input: Parameters<typeof enqueueRuntimeInput>[1]) => void;
  registerRuntimeInputReceipt?: (input: RegisterReceiptOptions) => RuntimeIngressReceipt;
  readRuntimeInputReceipt?: (id: string) => RuntimeIngressReceipt | null;
  buildRuntimeInputStatusUrl?: (id: string) => string;
  deriveBrainVault?: RuntimeAdapterServerDeps['deriveBrainVault'];
  revealBrainVaultMnemonic?: RuntimeAdapterServerDeps['revealBrainVaultMnemonic'];
};

const stringList = (value: string[] | string | undefined): string[] =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map(entry => entry.trim())
    .filter(Boolean);

export const readFrameReceipts = async (
  env: RuntimeReplica,
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

export const createServerRpcMessageHandler = ({
  validateRuntimeInputAdmission,
  registerRuntimeInputReceipt,
  readRuntimeInputReceipt,
  buildRuntimeInputStatusUrl,
  deriveBrainVault,
  revealBrainVaultMnemonic,
}: ServerRpcHandlerDeps) =>
  async (ws: RelaySocket, request: RuntimeAdapterRequest, env: RuntimeReplica | null): Promise<void> => {
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
      readFrameReceipts,
      findPaymentRoutes: findRuntimePaymentRoutes,
    });
  };
