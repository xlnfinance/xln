import type {
  EntityInput,
  Env,
  JInput,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
  RuntimeTx,
} from '../types';
import type { Profile } from '../networking/gossip';
import type { RuntimeOutputRoutingDeps } from './output-routing';
import { extractCrossJurisdictionRouteFromTx } from '../extensions/cross-j/boundary';
import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';
import { normalizeRuntimeId } from '../networking/runtime-id';
import { registerReliableIngress } from './reliable-delivery';
import { advanceEntityCommandNonce, assertSignedEntityCommand } from '../entity/command';

type RuntimeState = NonNullable<Env['runtimeState']>;

export type RuntimeInboundEntityInputOptions = {
  /** The transport accepted this exact input before persistence quiescing began. */
  acceptedBeforeQuiesce?: boolean;
};

export type RuntimeEntityRoutingDeps = {
  ensureRuntimeState(env: Env): RuntimeState;
  enqueueRuntimeInputs(
    env: Env,
    inputs?: EntityInput[],
    runtimeTxs?: RuntimeTx[],
    jInputs?: JInput[],
    ingressTimestamp?: number,
    options?: RuntimeInboundEntityInputOptions,
  ): void;
  extractEntityId(replicaKey: string): string;
  hasLocalSignerForEntity(env: Env, entityId: string): boolean;
  hasLocalSignerForEntitySigner(env: Env, entityId: string, signerId: string): boolean;
  resolveSoleLocalSignerForEntity(env: Env, entityId: string): string | null;
  getP2P: RuntimeOutputRoutingDeps['getP2P'];
};

export type RuntimeInboundEntityInputResult =
  | { kind: 'queued' }
  | { kind: 'pending' }
  | { kind: 'ignored' }
  | { kind: 'receipt'; receipt: ReliableDeliveryReceipt };

export type RuntimeInboundEntityInputValidation =
  | { kind: 'accepted' }
  | { kind: 'ignored' };

const normalizeEntityKey = (value: string): string => String(value || '').toLowerCase();
const RUNTIME_HINT_TTL_MS = 60_000;

const runtimeRoutingTimestamp = (env: Env): number => {
  const timestamp = Math.floor(Number(env.timestamp ?? 0));
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
};

const resolveRuntimeIdFromProfile = (profile: Profile | undefined): string | null => {
  const runtimeId = normalizeRuntimeId(String(profile?.runtimeId || ''));
  return runtimeId || null;
};

export const resolveRuntimeIdForEntity = (
  env: Env,
  entityId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'ensureRuntimeState'>,
): string | null => {
  const target = normalizeEntityKey(entityId);
  const state = deps.ensureRuntimeState(env);
  if (!state.entityRuntimeHints) {
    state.entityRuntimeHints = new Map();
  }
  const hints = state.entityRuntimeHints;
  const now = runtimeRoutingTimestamp(env);

  const hinted = hints?.get(target);
  const hintAge = Number.isFinite(hinted?.seenAt)
    ? (now >= Number(hinted?.seenAt) ? now - Number(hinted?.seenAt) : Number.POSITIVE_INFINITY)
    : Number.POSITIVE_INFINITY;
  if (
    hinted &&
    typeof hinted.runtimeId === 'string' &&
    hinted.runtimeId.length > 0 &&
    hintAge <= RUNTIME_HINT_TTL_MS
  ) {
    const normalizedHint = normalizeRuntimeId(hinted.runtimeId);
    if (normalizedHint) return normalizedHint;
  }

  // This is routing metadata, not consensus state. Gossip can only decide where
  // to send the next encrypted entity_input; local REA still rejects unknown
  // entities and cross-j topology is validated again before remote dispatch.
  if (env.gossip?.getProfiles) {
    const profiles = env.gossip.getProfiles() as Profile[];
    const profile = profiles.find((p: Profile) => normalizeEntityKey(String(p.entityId || '')) === target);
    const resolved = resolveRuntimeIdFromProfile(profile);
    if (resolved) {
      hints?.set(target, { runtimeId: resolved, seenAt: now });
      return resolved;
    }
  }
  return null;
};

export const hasLocalEntityReplica = (
  env: Env,
  entityId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'extractEntityId'>,
): boolean => {
  const target = normalizeEntityKey(entityId);
  return Array.from(env.eReplicas.keys()).some(key => {
    try {
      return normalizeEntityKey(deps.extractEntityId(key)) === target;
    } catch {
      return false;
    }
  });
};

export const resolveRuntimeIdForCrossJurisdictionEntity = (
  env: Env,
  entityId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'ensureRuntimeState' | 'extractEntityId' | 'hasLocalSignerForEntity'>,
): string | null => {
  const localRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
  if (localRuntimeId && deps.hasLocalSignerForEntity(env, entityId)) return localRuntimeId;
  return resolveRuntimeIdForEntity(env, entityId, deps);
};

export const registerEntityRuntimeHint = (
  env: Env,
  entityId: string,
  runtimeId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'ensureRuntimeState'>,
): void => {
  if (!entityId || !runtimeId) return;
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) return;
  const state = deps.ensureRuntimeState(env);
  const hints = state.entityRuntimeHints!;
  hints.set(normalizeEntityKey(entityId), {
    runtimeId: normalizedRuntimeId,
    seenAt: runtimeRoutingTimestamp(env),
  });
};

export const collectCrossJurisdictionRemoteEntityHints = (
  env: Env,
  input: RoutedEntityInput,
  fromRuntimeId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'extractEntityId' | 'hasLocalSignerForEntity'>,
): string[] => {
  const localRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
  const from = normalizeRuntimeId(fromRuntimeId);
  if (!localRuntimeId || !from || localRuntimeId === from) return [];
  const hints = new Set<string>();
  for (const tx of getEffectiveEntityInputTxs(input)) {
    const route = extractCrossJurisdictionRouteFromTx(tx);
    if (!route) continue;
    const sourceUserId = String(route.source?.entityId || '').toLowerCase();
    const targetUserId = String(route.target?.counterpartyEntityId || '').toLowerCase();
    const sourceHubId = String(route.source?.counterpartyEntityId || '').toLowerCase();
    const targetHubId = String(route.target?.entityId || '').toLowerCase();
    const localIsHubSide = [sourceHubId, targetHubId].some(entityId => entityId && deps.hasLocalSignerForEntity(env, entityId));
    const localIsUserSide = [sourceUserId, targetUserId].some(entityId => entityId && deps.hasLocalSignerForEntity(env, entityId));
    const remoteIds = localIsHubSide && !localIsUserSide
      ? [sourceUserId, targetUserId]
      : localIsUserSide && !localIsHubSide
        ? [sourceHubId, targetHubId]
        : [];
    for (const entityId of remoteIds) {
      if (entityId) hints.add(entityId);
    }
  }
  return [...hints];
};

export const validateInboundP2PEntityInput = (
  env: Env,
  from: string,
  input: RoutedEntityInput,
  deps: RuntimeEntityRoutingDeps,
  options: RuntimeInboundEntityInputOptions = {},
): RuntimeInboundEntityInputValidation => {
  const txTypes = input.entityTxs?.map(tx => tx.type).join(',') || 'none';
  const targetEntityId = String(input.entityId || '').toLowerCase();
  const localReplicaExists = Array.from(env.eReplicas.keys()).some(key => {
    const [entityKey] = String(key).split(':');
    return String(entityKey || '').toLowerCase() === targetEntityId;
  });
  if (!localReplicaExists) {
    const payload = {
      fromRuntimeId: from,
      entityId: input.entityId,
      txTypes,
    };
    if ((input.entityTxs?.length ?? 0) > 0) {
      env.error?.('network', 'INBOUND_ENTITY_UNKNOWN_TARGET', payload, input.entityId);
      throw new Error(
        `INBOUND_ENTITY_UNKNOWN_TARGET: entity=${input.entityId} signer=${input.signerId} txTypes=${txTypes}`,
      );
    }
    env.warn('network', 'INBOUND_ENTITY_UNKNOWN_TARGET', payload, input.entityId);
    return { kind: 'ignored' };
  }
  if (!deps.hasLocalSignerForEntitySigner(env, input.entityId, input.signerId)) {
    if ((input.entityTxs?.length ?? 0) > 0) {
      env.error?.(
        'network',
        'INBOUND_ENTITY_SIGNER_MISMATCH',
        {
          fromRuntimeId: from,
          entityId: input.entityId,
          signerId: input.signerId,
          txTypes,
        },
        input.entityId,
      );
      throw new Error(
        `INBOUND_ENTITY_SIGNER_MISMATCH: entity=${input.entityId} signer=${input.signerId} txTypes=${txTypes}`,
      );
    }
    env.warn(
      'network',
      'INBOUND_ENTITY_SIGNER_MISMATCH',
      {
        fromRuntimeId: from,
        entityId: input.entityId,
        signerId: input.signerId,
        txTypes,
      },
      input.entityId,
    );
    return { kind: 'ignored' };
  }

  const runtimeState = deps.ensureRuntimeState(env);
  if (runtimeState.halted && !env.scenarioMode) {
    const payload = { fromRuntimeId: from, entityId: input.entityId, txTypes };
    if ((input.entityTxs?.length ?? 0) > 0) {
      env.error?.('network', 'INBOUND_ENTITY_RUNTIME_HALTED', payload, input.entityId);
      throw new Error(
        `INBOUND_ENTITY_RUNTIME_HALTED: entity=${input.entityId} signer=${input.signerId} txTypes=${txTypes}`,
      );
    }
    env.warn?.('network', 'INBOUND_ENTITY_RUNTIME_HALTED', payload, input.entityId);
    return { kind: 'ignored' };
  }

  if (
    runtimeState.persistenceQuiescing &&
    !env.scenarioMode &&
    options.acceptedBeforeQuiesce !== true
  ) {
    const payload = { fromRuntimeId: from, entityId: input.entityId, txTypes };
    if ((input.entityTxs?.length ?? 0) > 0) {
      // Persistence quiesce is bounded transport backpressure, not state
      // corruption. The sender receives the explicit failure and its durable
      // lane retries the same input after publication completes.
      env.info?.('network', 'INBOUND_ENTITY_RUNTIME_QUIESCING', payload, input.entityId);
      throw new Error(
        `INBOUND_ENTITY_RUNTIME_QUIESCING: entity=${input.entityId} signer=${input.signerId} txTypes=${txTypes}`,
      );
    }
    env.warn?.('network', 'INBOUND_ENTITY_RUNTIME_QUIESCING', payload, input.entityId);
    return { kind: 'ignored' };
  }

  const targetReplica = Array.from(env.eReplicas.values()).find(replica =>
    String(replica.entityId || '').toLowerCase() === targetEntityId &&
    String(replica.signerId || '').toLowerCase() === String(input.signerId || '').toLowerCase());
  let commandState = targetReplica?.state;
  for (const tx of input.entityTxs ?? []) {
    if (tx.type === 'consensusOutput') continue;
    if (tx.type === 'runtimeOutput') {
      throw new Error(`INBOUND_RUNTIME_OUTPUT_FORBIDDEN:entity=${input.entityId}:from=${from}`);
    }
    if (tx.type !== 'entityCommand') {
      const payload = { fromRuntimeId: from, entityId: input.entityId, txType: tx.type };
      env.error?.('network', 'INBOUND_ENTITY_UNSIGNED_USER_COMMAND', payload, input.entityId);
      throw new Error(`INBOUND_ENTITY_UNSIGNED_USER_COMMAND:entity=${input.entityId}:txType=${tx.type}`);
    }
    if (!commandState) throw new Error(`INBOUND_ENTITY_COMMAND_STATE_MISSING:${input.entityId}:${input.signerId}`);
    const command = assertSignedEntityCommand(env, commandState, tx.data);
    commandState = advanceEntityCommandNonce(commandState, command);
  }

  // Never learn sender routes from raw payload fields. The authenticated
  // account/entity transition registers them only after successful apply.

  return { kind: 'accepted' };
};

export const handleInboundP2PEntityInput = (
  env: Env,
  from: string,
  input: RoutedEntityInput,
  deps: RuntimeEntityRoutingDeps,
  ingressTimestamp?: number,
  options: RuntimeInboundEntityInputOptions = {},
): RuntimeInboundEntityInputResult => {
  const validation = validateInboundP2PEntityInput(env, from, input, deps, options);
  if (validation.kind === 'ignored') return validation;

  const reliableIngress = registerReliableIngress(env, from, input);
  if (reliableIngress.kind === 'pending') return { kind: 'pending' };
  if (reliableIngress.kind === 'receipt') {
    return { kind: 'receipt', receipt: reliableIngress.receipt };
  }
  // `from` is trusted transport provenance. Never retain a peer-supplied value.
  deps.enqueueRuntimeInputs(
    env,
    [{ ...input, from }],
    undefined,
    undefined,
    ingressTimestamp,
    options,
  );
  env.info('network', 'INBOUND_ENTITY_INPUT', { fromRuntimeId: from, entityId: input.entityId }, input.entityId);
  return { kind: 'queued' };
};

export const createRuntimeOutputRoutingDeps = (
  deps: RuntimeEntityRoutingDeps,
): RuntimeOutputRoutingDeps => ({
  ensureRuntimeState: deps.ensureRuntimeState,
  getP2P: deps.getP2P,
  enqueueRuntimeInputs: (env, inputs, _runtimeTxs, _jInputs, ingressTimestamp) => {
    deps.enqueueRuntimeInputs(env, inputs, undefined, undefined, ingressTimestamp);
  },
  extractEntityId: deps.extractEntityId,
  hasLocalSignerForEntity: deps.hasLocalSignerForEntity,
  hasLocalSignerForEntitySigner: deps.hasLocalSignerForEntitySigner,
  resolveSoleLocalSignerForEntity: deps.resolveSoleLocalSignerForEntity,
  resolveRuntimeIdForEntity: (env, entityId) => resolveRuntimeIdForEntity(env, entityId, deps),
  resolveRuntimeIdForCrossJurisdictionEntity: (env, entityId) =>
    resolveRuntimeIdForCrossJurisdictionEntity(env, entityId, deps),
});
