import type { DirectWebSocket } from '../networking/direct-runtime-bun';
import { createDirectRuntimeWsRoute } from '../networking/direct-runtime-bun';
import { requireDeliveryDelivered } from '../protocol/payments/delivery-result';
import { safeStringify } from '../protocol/serialization';
import { decodeRuntimeAdapterRequest } from '../radapter/codec';
import { resolveRuntimeAdapterRead } from '../radapter/resolve';
import {
  closeInvalidRuntimeAdapterMessage,
  handleRuntimeAdapterMessage,
  type RuntimeAdapterSocket,
} from '../radapter/server';
import type { createRuntimeIngressReceiptStore } from '../server/ingress-receipts';
import {
  enqueueRuntimeInput,
  handleInboundP2PEntityInputs,
  handleInboundReliableReceipt,
  listPersistedCheckpointHeights,
  listPersistedEntityIdsAtHeight,
  loadEntityAccountDocFromStorageDb,
  loadEntityStateFromStorageDb,
  loadEntityViewPageFromStorageDb,
  readPersistedRuntimeActivityPage,
  readPersistedStorageFrameRecord,
  readPersistedStorageHead,
  submitCrossJurisdictionIntent,
  validateRuntimeInputAdmission,
} from '../runtime.ts';
import type { RuntimeState } from '../runtime/types';

export type HubServerSocket = DirectWebSocket &
  RuntimeAdapterSocket & { data?: { type?: string } };

export type DirectEntityInputDebug = {
  at: number;
  fromRuntimeId: string;
  entityIds: string[];
  signerIds: string[];
  txTypes: string[];
  error?: string;
};

export type DirectInputDebugState = {
  lastSeen: DirectEntityInputDebug | null;
  lastError: DirectEntityInputDebug | null;
};

export const runtimeInputStatusUrl = (id: string): string =>
  `/api/control/runtime-input/${encodeURIComponent(id)}/status`;

export const createHubDirectRuntimeRoute = (
  env: RuntimeState,
  runtimeSeed: string,
  isIngressReady: () => boolean,
  debug: DirectInputDebugState,
): ReturnType<typeof createDirectRuntimeWsRoute> => {
  let route: ReturnType<typeof createDirectRuntimeWsRoute>;
  route = createDirectRuntimeWsRoute({
    runtimeId: String(env.runtimeId || ''),
    runtimeSeed,
    onRecoveryBundleRequest: async (_from, lookupKey) =>
      resolveRuntimeAdapterRead(
        { env },
        `recovery/bundles/${encodeURIComponent(lookupKey)}`,
      ),
    onEntityInputs: async (from, envelope, ingressTimestamp) => {
      if (!isIngressReady()) {
        throw new Error('RUNTIME_STARTUP_J_CATCHUP_PENDING');
      }
      const entry: DirectEntityInputDebug = {
        at: Date.now(),
        fromRuntimeId: String(from || ''),
        entityIds: envelope.entityInputs.map(input =>
          String(input.entityId || ''),
        ),
        signerIds: envelope.entityInputs.map(input =>
          String(input.signerId || ''),
        ),
        txTypes: envelope.entityInputs.flatMap(input =>
          (input.entityTxs || []).map(tx => String(tx?.type || '')),
        ),
      };
      debug.lastSeen = entry;
      try {
        const inbound = handleInboundP2PEntityInputs(
          env,
          from,
          envelope,
          ingressTimestamp,
        );
        for (const receipt of inbound.receipts) {
          requireDeliveryDelivered(
            route.sendReliableReceiptDelivery(from, receipt),
            delivery =>
              `DIRECT_RELIABLE_RECEIPT_NOT_DELIVERED:${delivery.code}`,
          );
        }
      } catch (error) {
        debug.lastError = {
          ...entry,
          error: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
    },
    onReliableReceipt: (from, receipt) => {
      if (!isIngressReady()) {
        throw new Error('RUNTIME_STARTUP_J_CATCHUP_PENDING');
      }
      handleInboundReliableReceipt(env, from, receipt);
    },
  });
  env.runtimeState = env.runtimeState ?? {};
  // Both payload and receipt use one authenticated socket so account ACK
  // ordering cannot be inverted. Durable output routing still retains the
  // input and falls back to P2P when the direct peer is unavailable.
  env.runtimeState.directEntityInputsDispatch = (
    targetRuntimeId,
    envelope,
    ingressTimestamp,
  ) => route.sendEntityInputsDelivery(
    targetRuntimeId,
    envelope,
    ingressTimestamp,
  );
  env.runtimeState.directReliableReceiptDispatch = (
    targetRuntimeId,
    receipt,
  ) => route.sendReliableReceiptDelivery(targetRuntimeId, receipt);
  return route;
};

export const createHubRadapterMessageHandler = (
  env: RuntimeState,
  receipts: ReturnType<typeof createRuntimeIngressReceiptStore>,
  isIngressReady: () => boolean,
): ((
  ws: HubServerSocket,
  raw: string | Buffer | ArrayBuffer,
) => void) =>
  (ws, raw) => {
    let message: import('../radapter/types').RuntimeAdapterRequest;
    try {
      message = decodeRuntimeAdapterRequest(raw);
    } catch (error) {
      closeInvalidRuntimeAdapterMessage(ws, error);
      return;
    }
    void Promise.resolve(
      handleRuntimeAdapterMessage(ws, message, env, {
        enqueueRuntimeInput,
        submitCrossJurisdictionIntent: async (targetEnv, route) => {
          await submitCrossJurisdictionIntent(targetEnv, route);
        },
        validateRuntimeInputAdmission,
        registerReceipt: receipt => receipts.register(receipt),
        readReceipt: id => receipts.get(id),
        buildRuntimeInputStatusUrl: runtimeInputStatusUrl,
        isMutatingIngressReady: isIngressReady,
        readHead: targetEnv => readPersistedStorageHead(targetEnv),
        readFrame: (targetEnv, height) =>
          readPersistedStorageFrameRecord(targetEnv, height),
        listCheckpoints: targetEnv =>
          listPersistedCheckpointHeights(targetEnv),
        loadEntityState: (targetEnv, entityId, height) =>
          loadEntityStateFromStorageDb(targetEnv, entityId, height),
        loadEntityAccountDoc: (
          targetEnv,
          entityId,
          counterpartyId,
          height,
        ) => loadEntityAccountDocFromStorageDb(
          targetEnv,
          entityId,
          counterpartyId,
          height,
        ),
        loadEntityViewPage: (targetEnv, entityId, height, query) =>
          loadEntityViewPageFromStorageDb(
            targetEnv,
            entityId,
            height,
            query,
          ),
        listEntityIdsAtHeight: (targetEnv, height) =>
          listPersistedEntityIdsAtHeight(targetEnv, height),
        readActivityPage: (targetEnv, options) =>
          readPersistedRuntimeActivityPage(targetEnv, options),
      }),
    ).catch(error => {
      ws.send(
        safeStringify({
          type: 'error',
          error: `Runtime adapter failed: ${(error as Error).message}`,
        }),
      );
    });
  };
