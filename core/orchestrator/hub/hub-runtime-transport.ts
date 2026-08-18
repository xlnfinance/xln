import type { DirectWebSocket } from '../../network/p2p/direct-runtime-bun';
import { createDirectRuntimeWsRoute } from '../../network/p2p/direct-runtime-bun';
import { safeStringify } from '../../protocol/serialization';
import { decodeRuntimeAdapterRequest } from '../../api/runtime-adapter/codec';
import { resolveRuntimeAdapterRead } from '../../api/runtime-adapter/resolve';
import {
  closeInvalidRuntimeAdapterMessage,
  handleRuntimeAdapterMessage,
  type RuntimeAdapterSocket,
} from '../../api/runtime-adapter/server';
import type { createRuntimeIngressReceiptStore } from '../../runtime/mempool/ingress-receipts';
import { assertRuntimeEntityInputsEnvelopeSource } from '../../runtime/admit/entity-input-envelope-auth.ts';
import {
  enqueueRuntimeInput,
  handleInboundP2PEntityInputs,
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
} from '../../runtime';
import type { RuntimeReplica } from '../../runtime/types';
import type { BrainVaultOwnerController } from '../../api/server/ownership/brainvault';
import { resolveRuntimeAdminControl } from '../../api/server/control/runtime-admin';

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
  env: RuntimeReplica,
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
        assertRuntimeEntityInputsEnvelopeSource(env, from, envelope);
        handleInboundP2PEntityInputs(env, from, envelope, ingressTimestamp, {
          envelopeSourceVerified: true,
          entityInputsValidated: true,
        });
      } catch (error) {
        debug.lastError = {
          ...entry,
          error: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
    },
  });
  env.infrastructure = env.infrastructure ?? {};
  // Output routing falls back to P2P when the direct peer is unavailable.
  env.infrastructure.directEntityInputsDispatch = (
    targetRuntimeId,
    envelope,
    ingressTimestamp,
  ) => route.sendEntityInputsDelivery(
    targetRuntimeId,
    envelope,
    ingressTimestamp,
  );
  return route;
};

export const createHubRadapterMessageHandler = (
  env: RuntimeReplica,
  receipts: ReturnType<typeof createRuntimeIngressReceiptStore>,
  isIngressReady: () => boolean,
  brainVaultOwner: BrainVaultOwnerController,
  isBrainVaultReady: () => boolean,
): ((
  ws: HubServerSocket,
  raw: string | Buffer | ArrayBuffer,
) => void) =>
  (ws, raw) => {
    let message: import('../../api/runtime-adapter/types').RuntimeAdapterRequest;
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
        controlRuntime: resolveRuntimeAdminControl,
        isMutatingIngressReady: isIngressReady,
        deriveBrainVault: async (targetEnv, input, options) => {
          if (!isBrainVaultReady()) throw new Error('BRAINVAULT_OWNER_STARTUP_PENDING');
          return brainVaultOwner.deriveAndInstall(targetEnv, input, options);
        },
        // Intentional recovery boundary: a trusted node owner may explicitly
        // reveal its own mnemonic over an authenticated admin capability.
        // Ordinary derive is public-only, and /api/runtime-import must never
        // mint that capability for an untrusted caller. Removing this hook
        // would destroy node-owner recovery rather than improve isolation.
        revealBrainVaultMnemonic: async () => {
          if (!isBrainVaultReady()) throw new Error('BRAINVAULT_OWNER_STARTUP_PENDING');
          return brainVaultOwner.revealMnemonic();
        },
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
