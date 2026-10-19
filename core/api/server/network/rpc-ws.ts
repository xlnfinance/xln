import { findPaymentRoutes } from '../../runtime-adapter/read/payment-routes';
import { readRuntimeFrameReceipts } from '../../runtime-adapter/frame-receipts';
import {
  enqueueRuntimeInput,
  getPersistedLatestHeight,
  listPersistedCheckpointHeights,
  listPersistedEntityIdsAtHeight,
  loadEntityAccountDocFromStorageDb,
  loadEntityStateFromStorageDb,
  loadEntityViewPageFromStorageDb,
  loadEntityViewPagesFromStorageDb,
  readPersistedRuntimeActivityPage,
  readPersistedRuntimeActivityJournals,
  readPersistedAccountFrameHistory,
  readPersistedAccountSwapHistoryPage,
  readPersistedStorageFrameRecord,
  readPersistedStorageHead,
  submitCrossJurisdictionIntent,
} from '../../../runtime.ts';
import { handleRuntimeAdapterMessage } from '../../runtime-adapter/server';
import type { RuntimeAdapterServerDeps } from '../../runtime-adapter/session/context';
import { resolveRuntimeAdminControl } from '../control/runtime-admin';
import type {
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
      loadEntityViewPages: loadEntityViewPagesFromStorageDb,
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
