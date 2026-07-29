import { extractEntityId } from '../ids';
import { createStructuredLogger } from '../infra/logger';
import { normalizeRuntimeId } from '../networking/runtime-id';
import { safeStringify } from '../protocol/serialization';
import { runtimeInputRequiresOutboxCapacity } from './admission';
import {
  createRuntimeOutputRoutingDeps,
  registerEntityRuntimeHintWithDeps,
  routeInboundP2PEntityInput,
  routeInboundP2PEntityInputs,
  type RuntimeInboundEntityInputOptions,
  type RuntimeInboundEntityInputsResult,
  type RuntimeEntityRoutingDeps,
} from './entity-routing';
import { enqueueRuntimeInputs } from './loop-infrastructure';
import {
  ensureRuntimeGossipProfiles,
  getRuntimeP2P,
  getRuntimeP2PState,
  refreshRuntimeGossip,
  startPendingRuntimeP2PIfReady,
  startRuntimeP2P,
  stopRuntimeP2P,
  stopRuntimeP2PAndWait,
  type P2PConfig,
  type RuntimeP2PLifecycleDeps,
} from './p2p-lifecycle';
import { registerReliableReceiptIngress } from './reliable-delivery';
import { ensureRuntimeState } from './runtime-state';
import { assertScheduledWakeTxAuthorized } from './scheduled-wake';
import { assertRuntimeCommandReady } from './lifecycle';
import {
  MAX_RUNTIME_J_INPUT_BYTES,
  MAX_RUNTIME_J_INPUTS,
  MAX_RUNTIME_J_TXS,
  MAX_RUNTIME_J_TXS_PER_JURISDICTION,
  validateRuntimeInputShapeAndLimits,
} from './input-validation';
import { MAX_PENDING_NETWORK_OUTPUTS, sendEntityInputWithRouting } from './output-routing';
import { normalizeDbNamespace } from '../storage/runtime-dbs';
import { decodeRoutedEntityInput } from '../validation-utils';
import type {
  EntityInput,
  RuntimeState,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
  RuntimeEntityInputsEnvelope,
  RuntimeInput,
} from '../types';
import { clearRuntimeGossip } from './loop-gossip';
import {
  deriveRuntimeId,
  getLocalSignerIdsForEntity,
  getRuntimeEnv,
  hasLocalSignerForEntity,
  hasLocalSignerForEntitySigner,
  resolveSoleLocalSignerForEntity,
} from './loop-identity';

const routingLog = createStructuredLogger('runtime.routing');

export type RuntimeRoutingApiDeps = {
  notifyEnvChange(env: RuntimeState): void;
};

const normalizeRuntimeEntityInput = (
  _env: RuntimeState,
  input: EntityInput,
  _context: string,
): RoutedEntityInput => {
  const signerId = input.signerId.trim();
  if (!signerId) {
    throw new Error(
      `RUNTIME_ENTITY_INPUT_SIGNER_MISSING: EntityInput signerId must be resolved before enqueue/process ` +
      safeStringify({ entityId: input.entityId }),
    );
  }
  return { ...input, signerId };
};

const getRuntimeEntityRoutingDeps = (
  apiDeps: RuntimeRoutingApiDeps,
): RuntimeEntityRoutingDeps => ({
  ensureRuntimeState,
  enqueueRuntimeInputs: (env, inputs, runtimeTxs, jInputs, ingressTimestamp, options) =>
    enqueueRuntimeInputs(env, inputs, runtimeTxs, jInputs, ingressTimestamp, undefined, options),
  extractEntityId,
  hasLocalSignerForEntity,
  hasLocalSignerForEntitySigner,
  resolveSoleLocalSignerForEntity,
  getP2P: env => getRuntimeP2P(env, getRuntimeP2PLifecycleDeps(apiDeps)),
});

const handleInboundP2PEntityInput = (
  apiDeps: RuntimeRoutingApiDeps,
  env: RuntimeState,
  from: string,
  input: RoutedEntityInput,
  ingressTimestamp?: number,
) => {
  const deps = getRuntimeEntityRoutingDeps(apiDeps);
  return routeInboundP2PEntityInput(env, from, input, deps, ingressTimestamp);
};

const handleInboundP2PEntityInputs = (
  apiDeps: RuntimeRoutingApiDeps,
  env: RuntimeState,
  from: string,
  envelope: RuntimeEntityInputsEnvelope,
  ingressTimestamp?: number,
): RuntimeInboundEntityInputsResult => {
  const deps = getRuntimeEntityRoutingDeps(apiDeps);
  return routeInboundP2PEntityInputs(env, from, envelope, deps, ingressTimestamp);
};

const handleInboundReliableReceipt = (
  env: RuntimeState,
  from: string,
  receipt: ReliableDeliveryReceipt,
  options: RuntimeInboundEntityInputOptions = {},
): 'queued' | 'duplicate' | 'deferred' => {
  const sourceRuntimeId = normalizeRuntimeId(from);
  if (!sourceRuntimeId || sourceRuntimeId !== receipt.body.receiverRuntimeId) {
    throw new Error('RELIABLE_RECEIPT_TRANSPORT_SOURCE_MISMATCH');
  }
  if (env.runtimeState?.persistenceQuiescing && !env.scenarioMode && !options.acceptedBeforeQuiesce) {
    env.info('network', 'RELIABLE_RECEIPT_DEFERRED_QUIESCING', {
      sourceRuntimeId,
      receiverRuntimeId: receipt.body.receiverRuntimeId,
      identity: receipt.body.identity,
    });
    return 'deferred';
  }
  const registration = registerReliableReceiptIngress(env, receipt);
  if (receipt.body.identity.kind === 'account-ack') {
    routingLog.info('reliable.account_receipt.ingress', {
      fromRuntimeId: sourceRuntimeId,
      height: receipt.body.identity.height,
      coverage: receipt.body.coverage,
      registration,
    });
  }
  if (registration === 'duplicate') return 'duplicate';
  enqueueRuntimeInputs(env, undefined, undefined, undefined, env.timestamp, [receipt], options);
  return 'queued';
};

const getRuntimeP2PLifecycleDeps = (
  apiDeps: RuntimeRoutingApiDeps,
): RuntimeP2PLifecycleDeps => ({
  ensureRuntimeState,
  notifyEnvChange: apiDeps.notifyEnvChange,
  enqueueRuntimeInputs: (env, inputs) => enqueueRuntimeInputs(env, inputs),
  handleInboundP2PEntityInputs: (env, from, envelope, timestamp) =>
    handleInboundP2PEntityInputs(apiDeps, env, from, envelope, timestamp),
  handleInboundReliableReceipt,
});

const setRuntimeId = (
  apiDeps: RuntimeRoutingApiDeps,
  env: RuntimeState,
  id: string | null,
): void => {
  const runtimeId = normalizeRuntimeId(id);
  if (runtimeId) {
    env.runtimeId = runtimeId;
    env.dbNamespace = normalizeDbNamespace(runtimeId);
  } else {
    delete env.runtimeId;
  }
  startPendingRuntimeP2PIfReady(env, getRuntimeP2PLifecycleDeps(apiDeps));
};

const validateRuntimeInputAdmission = (
  env: RuntimeState,
  runtimeInput: RuntimeInput,
): void => {
  assertRuntimeCommandReady(env);
  validateRuntimeInputShapeAndLimits(env, runtimeInput, message => {
    throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: ${message}`);
  });
  const pendingOutputs = env.pendingNetworkOutputs?.length ?? 0;
  if (
    pendingOutputs >= MAX_PENDING_NETWORK_OUTPUTS &&
    runtimeInputRequiresOutboxCapacity(runtimeInput.entityInputs)
  ) {
    throw new Error(
      `RUNTIME_INPUT_ADMISSION_REJECTED: NETWORK_OUTBOX_BACKPRESSURE ` +
      `pending=${pendingOutputs} max=${MAX_PENDING_NETWORK_OUTPUTS}`,
    );
  }
  const importedSigners = new Map<string, Set<string>>();
  for (const tx of runtimeInput.runtimeTxs) {
    if (tx.type !== 'importReplica') continue;
    const entityId = String(tx.entityId || '').toLowerCase();
    const signerId = String(tx.signerId || '').trim();
    if (!entityId || !signerId) continue;
    const signers = importedSigners.get(entityId) ?? new Set<string>();
    signers.add(signerId);
    importedSigners.set(entityId, signers);
  }
  runtimeInput.entityInputs.forEach((input, index) => {
    for (const tx of input.entityTxs ?? []) assertScheduledWakeTxAuthorized(tx, false);
    const validated = normalizeRuntimeEntityInput(env, decodeRoutedEntityInput(input), `runtimeInput[${index}]`);
    const localSignerIds = [
      ...getLocalSignerIdsForEntity(env, validated.entityId),
      ...(importedSigners.get(String(validated.entityId).toLowerCase()) ?? []),
    ];
    if (localSignerIds.length === 0) {
      throw new Error(
        `RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET: Entity input target does not exist in local runtime ` +
        safeStringify({
          index,
          entityId: validated.entityId,
          signerId: validated.signerId,
          txTypes: (validated.entityTxs || []).map(tx => tx.type),
        }),
      );
    }
    const exactSigner = localSignerIds.some(
      signerId => signerId.toLowerCase() === validated.signerId.toLowerCase(),
    );
    if (exactSigner || (localSignerIds.length === 1 && !validated.entityTxs?.length)) return;
    throw new Error(
      `RUNTIME_REPLICA_NOT_FOUND: Entity input target replica missing for exact signerId ` +
      safeStringify({
        index,
        entityId: validated.entityId,
        inputSignerId: validated.signerId,
        localSignerIds,
        txTypes: (validated.entityTxs || []).map(tx => tx.type),
      }),
    );
  });
};

export const createRuntimeRoutingApi = (deps: RuntimeRoutingApiDeps) => {
  const entityRoutingDeps = () => getRuntimeEntityRoutingDeps(deps);
  const outputRoutingDeps = () => createRuntimeOutputRoutingDeps(entityRoutingDeps());
  const p2pDeps = () => getRuntimeP2PLifecycleDeps(deps);
  return {
    getEnv: getRuntimeEnv,
    setRuntimeId: (env: RuntimeState, id: string | null) => setRuntimeId(deps, env, id),
    deriveRuntimeId,
    registerEntityRuntimeHint: (env: RuntimeState, entityId: string, runtimeId: string) =>
      registerEntityRuntimeHintWithDeps(env, entityId, runtimeId, entityRoutingDeps()),
    handleInboundP2PEntityInput: (
      env: RuntimeState,
      from: string,
      input: RoutedEntityInput,
      timestamp?: number,
    ) => handleInboundP2PEntityInput(deps, env, from, input, timestamp),
    handleInboundP2PEntityInputs: (
      env: RuntimeState,
      from: string,
      envelope: RuntimeEntityInputsEnvelope,
      timestamp?: number,
    ) => handleInboundP2PEntityInputs(deps, env, from, envelope, timestamp),
    handleInboundReliableReceipt,
    normalizeRuntimeEntityInput,
    validateRuntimeInputAdmission,
    getRuntimeEntityRoutingDeps: entityRoutingDeps,
    getRuntimeOutputRoutingDeps: outputRoutingDeps,
    sendEntityInput: (env: RuntimeState, input: RoutedEntityInput) =>
      sendEntityInputWithRouting(env, input, outputRoutingDeps()),
    startP2P: (env: RuntimeState, config: P2PConfig = {}) => startRuntimeP2P(env, config, p2pDeps()),
    stopP2P: (env: RuntimeState) => stopRuntimeP2P(env, p2pDeps()),
    stopP2PAndWait: (env: RuntimeState, timeoutMs?: number) =>
      stopRuntimeP2PAndWait(env, p2pDeps(), timeoutMs),
    getP2P: (env: RuntimeState) => getRuntimeP2P(env, p2pDeps()),
    getP2PState: (env: RuntimeState) => getRuntimeP2PState(env, p2pDeps()),
    refreshGossip: (env: RuntimeState) => refreshRuntimeGossip(env, p2pDeps()),
    ensureGossipProfiles: (env: RuntimeState, entityIds: string[]) =>
      ensureRuntimeGossipProfiles(env, p2pDeps(), entityIds),
    clearGossip: (env: RuntimeState, options: { runtimeId?: string } = {}) =>
      clearRuntimeGossip(env, deps.notifyEnvChange, options),
    MAX_RUNTIME_J_INPUTS,
    MAX_RUNTIME_J_TXS,
    MAX_RUNTIME_J_TXS_PER_JURISDICTION,
    MAX_RUNTIME_J_INPUT_BYTES,
  };
};
