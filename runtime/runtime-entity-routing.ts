import type { EntityInput, Env, JInput, RoutedEntityInput, RuntimeTx } from './types';
import type { Profile } from './networking/gossip';
import type { RuntimeOutputRoutingDeps } from './runtime-output-routing';
import { extractCrossJurisdictionRouteFromTx } from './cross-jurisdiction-boundary';
import { normalizeRuntimeId } from './networking/runtime-id';

type RuntimeState = NonNullable<Env['runtimeState']>;

export type RuntimeEntityRoutingDeps = {
  ensureRuntimeState(env: Env): RuntimeState;
  enqueueRuntimeInputs(
    env: Env,
    inputs?: EntityInput[],
    runtimeTxs?: RuntimeTx[],
    jInputs?: JInput[],
    ingressTimestamp?: number,
  ): void;
  extractEntityId(replicaKey: string): string;
  hasLocalSignerForEntity(env: Env, entityId: string): boolean;
  getP2P: RuntimeOutputRoutingDeps['getP2P'];
  startRuntimeLoop(env: Env): void;
  processRuntime(env: Env): Promise<unknown>;
};

const normalizeEntityKey = (value: string): string => String(value || '').toLowerCase();
const RUNTIME_HINT_TTL_MS = 60_000;

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
  const hints = state.entityRuntimeHints;
  const now = Date.now();

  const hinted = hints?.get(target);
  if (
    hinted &&
    typeof hinted.runtimeId === 'string' &&
    hinted.runtimeId.length > 0 &&
    Number.isFinite(hinted.seenAt) &&
    now - hinted.seenAt <= RUNTIME_HINT_TTL_MS
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
    if (resolved && hints) {
      hints.set(target, { runtimeId: resolved, seenAt: now });
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
    seenAt: Date.now(),
  });
};

const collectSenderEntityHints = (input: RoutedEntityInput): string[] => {
  const hints = new Set<string>();
  for (const tx of input.entityTxs || []) {
    const data = tx.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object') continue;
    const fromEntityId = data['fromEntityId'];
    if (typeof fromEntityId === 'string' && fromEntityId.length > 0) {
      hints.add(fromEntityId);
    }
  }
  return [...hints];
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
  for (const tx of input.entityTxs || []) {
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

export const handleInboundP2PEntityInput = (
  env: Env,
  from: string,
  input: RoutedEntityInput,
  deps: RuntimeEntityRoutingDeps,
  ingressTimestamp?: number,
): void => {
  const txTypes = input.entityTxs?.map(tx => tx.type).join(',') || 'none';
  const targetEntityId = String(input.entityId || '').toLowerCase();
  const localReplicaExists = Array.from(env.eReplicas.keys()).some(key => {
    const [entityKey] = String(key).split(':');
    return String(entityKey || '').toLowerCase() === targetEntityId;
  });
  if (!localReplicaExists) {
    env.warn(
      'network',
      'INBOUND_ENTITY_UNKNOWN_TARGET',
      {
        fromRuntimeId: from,
        entityId: input.entityId,
        txTypes,
      },
      input.entityId,
    );
    return;
  }

  for (const hintedEntityId of collectSenderEntityHints(input)) {
    registerEntityRuntimeHint(env, hintedEntityId, from, deps);
  }

  // Do not learn cross-j sibling topology at raw network ingress. The route may
  // still be untrusted here; applyRuntimeInput registers these hints only after
  // the strict two-runtime topology check passes.

  deps.enqueueRuntimeInputs(env, [input], undefined, undefined, ingressTimestamp);
  env.info('network', 'INBOUND_ENTITY_INPUT', { fromRuntimeId: from, entityId: input.entityId }, input.entityId);

  const runtimeState = deps.ensureRuntimeState(env) as RuntimeState & {
    inboundP2PProcessScheduled?: boolean;
  };
  if (!runtimeState.loopActive && !env.scenarioMode) {
    deps.startRuntimeLoop(env);
  }
  if (!runtimeState.inboundP2PProcessScheduled && !env.scenarioMode) {
    runtimeState.inboundP2PProcessScheduled = true;
    queueMicrotask(() => {
      runtimeState.inboundP2PProcessScheduled = false;
      void deps.processRuntime(env).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        env.error?.('network', 'INBOUND_ENTITY_PROCESS_FAILED', { message }, input.entityId);
      });
    });
  }
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
  resolveRuntimeIdForEntity: (env, entityId) => resolveRuntimeIdForEntity(env, entityId, deps),
  resolveRuntimeIdForCrossJurisdictionEntity: (env, entityId) =>
    resolveRuntimeIdForCrossJurisdictionEntity(env, entityId, deps),
});
