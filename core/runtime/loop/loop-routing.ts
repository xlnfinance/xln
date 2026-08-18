import { extractEntityId } from '../../protocol/identity';
import { createStructuredLogger } from '../../support/logger.ts';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id.ts';
import { safeStringify } from '../../protocol/serialization';
import { runtimeInputRequiresOutboxCapacity } from '../mempool/admission.ts';
import {
  createRuntimeOutputRoutingDeps,
  registerEntityRuntimeHintWithDeps,
  routeInboundP2PEntityInput,
  routeInboundP2PEntityInputs,
  type RuntimeInboundEntityInputsResult,
  type RuntimeEntityRoutingDeps,
} from '../delivery/topology/entity-routing.ts';
import { enqueueRuntimeInputs } from './loop-envelope.ts';
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
} from '../envelope/p2p-lifecycle.ts';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope.ts';
import { assertScheduledWakeTxAuthorized } from '../mempool/scheduled-wake.ts';
import { assertRuntimeCommandReady } from '../replica/lifecycle.ts';
import {
  MAX_RUNTIME_J_INPUT_BYTES,
  MAX_RUNTIME_J_INPUTS,
  MAX_RUNTIME_J_TXS,
  MAX_RUNTIME_J_TXS_PER_JURISDICTION,
  validateRuntimeInputShapeAndLimits,
} from '../mempool/input-validation.ts';
import { MAX_PENDING_NETWORK_OUTPUTS, sendEntityInputWithRouting } from '../delivery/topology/output-routing.ts';
import { normalizeDbNamespace } from '../../storage/runtime-dbs.ts';
import { decodeRoutedEntityInput } from '../delivery/topology/routing-validation.ts';
import type { EntityInput } from '../../entity/types.ts';
import type { RuntimeReplica, RoutedEntityInput, RuntimeEntityInputsEnvelope, RuntimeInput } from '../types.ts';
import { clearRuntimeGossip } from '../envelope/gossip.ts';
import { assertRuntimeInputCapabilitiesAuthorized } from '../tx/internal-tx-auth.ts';
import {
  deriveRuntimeId,
  getLocalSignerIdsForEntity,
  getRuntimeEnv,
  hasLocalSignerForEntity,
  hasLocalSignerForEntitySigner,
  resolveSoleLocalSignerForEntity,
} from './loop-identity.ts';

const routingLog = createStructuredLogger('runtime.routing');
const INGRESS_PROFILE = process.env['XLN_P2P_INGRESS_PROFILE'] === '1';

export type RuntimeRoutingApiDeps = {
  notifyEnvChange(env: RuntimeReplica): void;
};

const normalizeRuntimeEntityInput = (
  _env: RuntimeReplica,
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
  // Every frame re-validates the whole pending mempool. Returning the same
  // object for an already-normalized input keeps identity-keyed memos (reliable
  // identity, decoded evidence) warm instead of re-deriving them per frame.
  return signerId === input.signerId ? input : { ...input, signerId };
};

const getRuntimeEntityRoutingDeps = (
  apiDeps: RuntimeRoutingApiDeps,
): RuntimeEntityRoutingDeps => ({
  ensureRuntimeInfrastructure,
  enqueueRuntimeInputs: (env, inputs, runtimeTxs, jInputs, ingressTimestamp, options) =>
    enqueueRuntimeInputs(env, inputs, runtimeTxs, jInputs, ingressTimestamp, options),
  extractEntityId,
  hasLocalSignerForEntity,
  hasLocalSignerForEntitySigner,
  resolveSoleLocalSignerForEntity,
  getP2P: env => getRuntimeP2P(env, getRuntimeP2PLifecycleDeps(apiDeps)),
});

const handleInboundP2PEntityInput = (
  apiDeps: RuntimeRoutingApiDeps,
  env: RuntimeReplica,
  from: string,
  input: RoutedEntityInput,
  ingressTimestamp?: number,
) => {
  const deps = getRuntimeEntityRoutingDeps(apiDeps);
  return routeInboundP2PEntityInput(env, from, input, deps, ingressTimestamp);
};

const handleInboundP2PEntityInputs = (
  apiDeps: RuntimeRoutingApiDeps,
  env: RuntimeReplica,
  from: string,
  envelope: RuntimeEntityInputsEnvelope,
  ingressTimestamp?: number,
): RuntimeInboundEntityInputsResult => {
  const deps = getRuntimeEntityRoutingDeps(apiDeps);
  if (INGRESS_PROFILE) {
    routingLog.info('ingress.entity_inputs', {
      wallMs: Date.now(),
      from: normalizeRuntimeId(from).slice(0, 12),
      inputs: envelope.entityInputs.length,
      entities: envelope.entityInputs.map(input => String(input.entityId).slice(-8)),
      sourceRuntimeHeight: envelope.sourceRuntimeHeight,
    });
  }
  return routeInboundP2PEntityInputs(env, from, envelope, deps, ingressTimestamp);
};

const getRuntimeP2PLifecycleDeps = (
  apiDeps: RuntimeRoutingApiDeps,
): RuntimeP2PLifecycleDeps => ({
  ensureRuntimeInfrastructure,
  notifyEnvChange: apiDeps.notifyEnvChange,
  enqueueRuntimeInputs: (env, inputs) => enqueueRuntimeInputs(env, inputs),
  handleInboundP2PEntityInputs: (env, from, envelope, timestamp) =>
    handleInboundP2PEntityInputs(apiDeps, env, from, envelope, timestamp),
});

const setRuntimeId = (
  apiDeps: RuntimeRoutingApiDeps,
  env: RuntimeReplica,
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
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
): void => {
  assertRuntimeCommandReady(env);
  validateRuntimeInputShapeAndLimits(env, runtimeInput, message => {
    throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: ${message}`);
  });
  assertRuntimeInputCapabilitiesAuthorized(runtimeInput);
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
    setRuntimeId: (env: RuntimeReplica, id: string | null) => setRuntimeId(deps, env, id),
    deriveRuntimeId,
    registerEntityRuntimeHint: (env: RuntimeReplica, entityId: string, runtimeId: string) =>
      registerEntityRuntimeHintWithDeps(env, entityId, runtimeId, entityRoutingDeps()),
    handleInboundP2PEntityInput: (
      env: RuntimeReplica,
      from: string,
      input: RoutedEntityInput,
      timestamp?: number,
    ) => handleInboundP2PEntityInput(deps, env, from, input, timestamp),
    handleInboundP2PEntityInputs: (
      env: RuntimeReplica,
      from: string,
      envelope: RuntimeEntityInputsEnvelope,
      timestamp?: number,
    ) => handleInboundP2PEntityInputs(deps, env, from, envelope, timestamp),
    normalizeRuntimeEntityInput,
    validateRuntimeInputAdmission,
    getRuntimeEntityRoutingDeps: entityRoutingDeps,
    getRuntimeOutputRoutingDeps: outputRoutingDeps,
    sendEntityInput: (env: RuntimeReplica, input: RoutedEntityInput) =>
      sendEntityInputWithRouting(env, input, outputRoutingDeps()),
    startP2P: (env: RuntimeReplica, config: P2PConfig = {}) => startRuntimeP2P(env, config, p2pDeps()),
    stopP2P: (env: RuntimeReplica) => stopRuntimeP2P(env, p2pDeps()),
    stopP2PAndWait: (env: RuntimeReplica, timeoutMs?: number) =>
      stopRuntimeP2PAndWait(env, p2pDeps(), timeoutMs),
    getP2P: (env: RuntimeReplica) => getRuntimeP2P(env, p2pDeps()),
    getP2PState: (env: RuntimeReplica) => getRuntimeP2PState(env, p2pDeps()),
    refreshGossip: (env: RuntimeReplica) => refreshRuntimeGossip(env, p2pDeps()),
    ensureGossipProfiles: (env: RuntimeReplica, entityIds: string[]) =>
      ensureRuntimeGossipProfiles(env, p2pDeps(), entityIds),
    clearGossip: (env: RuntimeReplica, options: { runtimeId?: string } = {}) =>
      clearRuntimeGossip(env, deps.notifyEnvChange, options),
    MAX_RUNTIME_J_INPUTS,
    MAX_RUNTIME_J_TXS,
    MAX_RUNTIME_J_TXS_PER_JURISDICTION,
    MAX_RUNTIME_J_INPUT_BYTES,
  };
};
