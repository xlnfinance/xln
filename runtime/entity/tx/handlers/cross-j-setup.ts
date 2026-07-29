import {
  buildCrossJurisdictionPullBinding,
  cloneCrossJurisdictionRoute,
  isCrossJurisdictionRouteExpired,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j/index';
import {
  committedCrossJSourceDisputeDelayMs,
  validatePreparedCrossJurisdictionRoute,
} from '../../../extensions/cross-j/prepared-route';
import { pushCrossJurisdictionEntityOutput } from '../cross-j-outputs';
import {
  canonicalizeCrossJurisdictionRouteForKnownEntities,
  isCrossJurisdictionRouteParticipant,
  mergeCrossJurisdictionRoute,
  validateCrossJurisdictionLocalBinding,
  validateCrossJurisdictionRouteTransition,
} from '../cross-jurisdiction-helpers';
import { normalizeEntityRef } from '../account-key';
import { prepareEntityTxState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import { safeStringify } from '../../../protocol/serialization';
import type { CrossJurisdictionSwapRoute, EntityInput, EntityState, EntityTx, RuntimeState } from '../../../types';
import type { ApplyEntityTxOptions } from '../apply';
import type { AccountTxTarget } from './account';
import { findAccountKey } from '../account-key';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

type CrossJSetupResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
};

const deterministicEntityTimestamp = (state: EntityState, env: RuntimeState): number =>
  Number(state.timestamp || env.timestamp || 0);

const stateForEntityTx = (entityState: EntityState, options?: ApplyEntityTxOptions): EntityState =>
  prepareEntityTxState(entityState, options?.mutableFrameState);

const exactRouteBytes = (route: CrossJurisdictionSwapRoute): string =>
  safeStringify(cloneCrossJurisdictionRoute(route));

const materializedIntentBytes = (
  route: CrossJurisdictionSwapRoute,
  existing: CrossJurisdictionSwapRoute,
): string => {
  const intent = cloneCrossJurisdictionRoute(route);
  delete intent.sourcePull;
  delete intent.targetPull;
  intent.status = existing.status;
  intent.updatedAt = existing.updatedAt;
  return exactRouteBytes(intent);
};

const pushCrossJOutput = (
  env: RuntimeState,
  outputs: EntityInput[],
  entityId: string,
  entityTxs: EntityTx[],
  signerIdHint?: string | null,
): void => {
  pushCrossJurisdictionEntityOutput(env, outputs, entityId, entityTxs, signerIdHint);
};

const prepareRawCrossJurisdictionIntent = (
  env: RuntimeState,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  outputs: EntityInput[],
): CrossJSetupResult => {
  if (route.status !== 'intent') {
    throw new Error(`CROSS_J_RAW_PREPARE_STATUS_INVALID:${route.orderId}:${route.status}`);
  }
  if (isCrossJurisdictionRouteExpired(route, deterministicEntityTimestamp(state, env))) {
    addMessage(state, `❌ Cross-j prepare ${route.orderId} expired`);
    return { newState: state, outputs };
  }
  const sameJurisdiction =
    String(route.source.jurisdiction).trim().toLowerCase() ===
    String(route.target.jurisdiction).trim().toLowerCase();
  if (sameJurisdiction && Number(route.source.tokenId) === Number(route.target.tokenId)) {
    addMessage(state, `❌ Cross-j prepare ${route.orderId} must cross a jurisdiction or asset boundary`);
    return { newState: state, outputs };
  }
  try {
    // Validate every public prerequisite before making the intent durable.
    // The private seed remains untouched until the default proposer signs
    // the later materialization command.
    committedCrossJSourceDisputeDelayMs(state, route);
  } catch (error) {
    addMessage(
      state,
      `❌ Cross-j prepare ${route.orderId} blocked: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { newState: state, outputs };
  }
  state.crossJurisdictionSwaps ||= new Map();
  const existing = state.crossJurisdictionSwaps.get(route.orderId);
  if (existing?.sourcePull || existing?.targetPull) {
    throw new Error(`CROSS_J_RAW_PREPARE_AFTER_MATERIALIZATION:${route.orderId}`);
  }
  if (existing) {
    if (exactRouteBytes(existing) !== exactRouteBytes(route)) {
      throw new Error(`CROSS_J_RAW_PREPARE_CONFLICT:${route.orderId}`);
    }
    return { newState: state, outputs };
  }
  state.crossJurisdictionSwaps.set(route.orderId, cloneCrossJurisdictionRoute(route));
  const firstValidator = state.config.validators[0];
  if (!firstValidator) throw new Error(`CROSS_J_SOURCE_HUB_PROPOSER_MISSING:${route.orderId}`);
  outputs.push({ entityId: state.entityId, signerId: firstValidator, entityTxs: [] });
  addMessage(state, `🌉 Cross-j swap ${route.orderId} awaiting source-hub proposer commitments`);
  return { newState: state, outputs };
};

const prepareMaterializedCrossJurisdictionRoute = (
  env: RuntimeState,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  outputs: EntityInput[],
): CrossJSetupResult => {
  const preparedRoute = validatePreparedCrossJurisdictionRoute(state, route);
  state.crossJurisdictionSwaps ||= new Map();
  const existing = state.crossJurisdictionSwaps.get(preparedRoute.orderId);
  const transitionError = validateCrossJurisdictionRouteTransition(existing, preparedRoute);
  if (transitionError) {
    addMessage(state, `❌ Cross-j prepare ${route.orderId} blocked: ${transitionError}`);
    return { newState: state, outputs };
  }
  const publicPreparedRoute = cloneCrossJurisdictionRoute(preparedRoute);
  state.crossJurisdictionSwaps.set(
    publicPreparedRoute.orderId,
    mergeCrossJurisdictionRoute(existing, publicPreparedRoute),
  );
  const readyRoute = { ...cloneCrossJurisdictionRoute(publicPreparedRoute), status: 'resting' as const };
  // Both Account legs originate in one committed Entity frame. Routing them
  // together prevents one sibling from observing a half-created swap.
  pushCrossJOutput(env, outputs, readyRoute.source.counterpartyEntityId, [
    { type: 'registerCrossJurisdictionSwap', data: { route: readyRoute } },
  ], readyRoute.sourceHubSignerId);
  pushCrossJOutput(env, outputs, readyRoute.target.entityId, [
    { type: 'registerCrossJurisdictionSwap', data: { route: readyRoute } },
  ], readyRoute.targetHubSignerId);
  addMessage(state, `🌉 Cross-j swap ${preparedRoute.orderId} paired source and target proposals requested by hub`);
  return { newState: state, outputs };
};

export const handlePrepareCrossJurisdictionSwapEntityTx = (
  env: RuntimeState,
  entityState: EntityState,
  entityTx: EntityTxOf<'prepareCrossJurisdictionSwap'>,
  options?: ApplyEntityTxOptions,
): CrossJSetupResult => {
  let route: CrossJurisdictionSwapRoute;
  const newState = stateForEntityTx(entityState, options);
  const outputs: EntityInput[] = [];
  try {
    route = withCanonicalCrossJurisdictionRouteHash(
      canonicalizeCrossJurisdictionRouteForKnownEntities(env, newState, entityTx.data.route),
    );
  } catch (error) {
    addMessage(newState, `❌ Cross-j prepare invalid route: ${error instanceof Error ? error.message : String(error)}`);
    return { newState, outputs };
  }
  if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.counterpartyEntityId)) {
    addMessage(newState, `❌ Cross-j prepare ${route.orderId} wrong source hub`);
    return { newState, outputs };
  }
  const bindingError = validateCrossJurisdictionLocalBinding(env, newState, route);
  if (bindingError) {
    addMessage(newState, `❌ Cross-j prepare ${route.orderId} blocked: ${bindingError}`);
    return { newState, outputs };
  }
  const hasSourcePull = route.sourcePull !== undefined;
  const hasTargetPull = route.targetPull !== undefined;
  if (hasSourcePull !== hasTargetPull) {
    throw new Error(`CROSS_J_PREPARED_PAYLOAD_PARTIAL:${route.orderId}`);
  }
  return hasSourcePull
    ? prepareMaterializedCrossJurisdictionRoute(env, newState, route, outputs)
    : prepareRawCrossJurisdictionIntent(env, newState, route, outputs);
};

export const handleMaterializeCrossJurisdictionSwapEntityTx = (
  env: RuntimeState,
  entityState: EntityState,
  entityTx: EntityTxOf<'materializeCrossJurisdictionSwap'>,
  options?: ApplyEntityTxOptions,
): CrossJSetupResult => {
  const expectedProposer = normalizeEntityRef(entityState.config.validators[0] || '');
  const claimedProposer = normalizeEntityRef(entityTx.data.proposerSignerId);
  if (!expectedProposer || claimedProposer !== expectedProposer) {
    throw new Error(
      `CROSS_J_MATERIALIZE_PROPOSER_INVALID:${claimedProposer || 'missing'}:${expectedProposer || 'missing'}`,
    );
  }
  const existing = entityState.crossJurisdictionSwaps?.get(entityTx.data.route.orderId);
  if (!existing || existing.sourcePull || existing.targetPull || existing.status !== 'intent') {
    throw new Error(`CROSS_J_MATERIALIZE_INTENT_MISSING:${entityTx.data.route.orderId}`);
  }
  if (materializedIntentBytes(entityTx.data.route, existing) !== exactRouteBytes(existing)) {
    throw new Error(`CROSS_J_MATERIALIZE_INTENT_MISMATCH:${entityTx.data.route.orderId}`);
  }
  return handlePrepareCrossJurisdictionSwapEntityTx(env, entityState, {
    type: 'prepareCrossJurisdictionSwap',
    data: { route: entityTx.data.route },
  }, options);
};

const buildSourceRegistrationTxs = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): AccountTxTarget[] => {
  const sourcePull = route.sourcePull;
  if (!sourcePull) throw new Error(`CROSS_J_REGISTER_SOURCE_PULL_MISSING:${route.orderId}`);
  const accountId = findAccountKey(state, route.source.entityId);
  if (!accountId) throw new Error(`CROSS_J_SOURCE_ACCOUNT_MISSING:${route.orderId}`);
  return [
    {
      accountId,
      tx: {
        type: 'pull_lock',
        data: {
          pullId: sourcePull.pullId,
          tokenId: sourcePull.tokenId,
          amount: sourcePull.signedAmount,
          revealedUntilTimestamp: sourcePull.revealedUntilTimestamp,
          fullHash: sourcePull.fullHash,
          partialRoot: sourcePull.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
          crossJurisdictionRoute: cloneCrossJurisdictionRoute(route),
        },
      },
    },
    {
      accountId,
      tx: {
        type: 'swap_offer',
        data: {
          offerId: route.orderId,
          giveTokenId: route.source.tokenId,
          giveAmount: route.source.amount,
          wantTokenId: route.target.tokenId,
          wantAmount: route.target.amount,
          ...(route.priceTicks !== undefined ? { priceTicks: route.priceTicks } : {}),
          timeInForce: 0,
          crossJurisdiction: cloneCrossJurisdictionRoute(route),
        },
      },
    },
  ];
};

const buildTargetRegistrationTxs = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): AccountTxTarget[] => {
  const targetPull = route.targetPull;
  if (!targetPull) throw new Error(`CROSS_J_REGISTER_TARGET_PULL_MISSING:${route.orderId}`);
  const accountId = findAccountKey(state, route.target.counterpartyEntityId);
  if (!accountId) throw new Error(`CROSS_J_TARGET_ACCOUNT_MISSING:${route.orderId}`);
  return [{
    accountId,
    tx: {
      type: 'pull_lock',
      data: {
        pullId: targetPull.pullId,
        tokenId: targetPull.tokenId,
        amount: targetPull.signedAmount,
        revealedUntilTimestamp: targetPull.revealedUntilTimestamp,
        fullHash: targetPull.fullHash,
        partialRoot: targetPull.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
        crossJurisdictionRoute: cloneCrossJurisdictionRoute(route),
      },
    },
  }];
};

export const handleRegisterCrossJurisdictionSwapEntityTx = (
  env: RuntimeState,
  entityState: EntityState,
  entityTx: EntityTxOf<'registerCrossJurisdictionSwap'>,
  options?: ApplyEntityTxOptions,
): CrossJSetupResult => {
  let route: CrossJurisdictionSwapRoute;
  const newState = stateForEntityTx(entityState, options);
  try {
    route = withCanonicalCrossJurisdictionRouteHash(
      canonicalizeCrossJurisdictionRouteForKnownEntities(env, newState, entityTx.data.route),
    );
  } catch (error) {
    addMessage(newState, `❌ Cross-j register invalid route: ${error instanceof Error ? error.message : String(error)}`);
    return { newState, outputs: [] };
  }
  if (!isCrossJurisdictionRouteParticipant(newState.entityId, route)) {
    addMessage(newState, `❌ Cross-j register ${route.orderId} routed to non-participant entity`);
    return { newState, outputs: [] };
  }
  const bindingError = validateCrossJurisdictionLocalBinding(env, newState, route);
  if (bindingError) {
    addMessage(newState, `❌ Cross-j register ${route.orderId} blocked: ${bindingError}`);
    return { newState, outputs: [] };
  }
  newState.crossJurisdictionSwaps ||= new Map();
  const existing = newState.crossJurisdictionSwaps.get(route.orderId);
  const transitionError = validateCrossJurisdictionRouteTransition(existing, route);
  if (transitionError) {
    addMessage(newState, `❌ Cross-j swap ${route.orderId} register blocked: ${transitionError}`);
    return { newState, outputs: [] };
  }
  newState.crossJurisdictionSwaps.set(route.orderId, mergeCrossJurisdictionRoute(existing, route));
  addMessage(newState, `🌉 Cross-j swap ${route.orderId} registered`);
  const openingTransition =
    !existing || existing.status === 'intent' || existing.status === 'target_prepared';
  if (!openingTransition || route.status !== 'resting') return { newState, outputs: [] };
  if (!route.sourcePull || !route.targetPull) {
    throw new Error(`CROSS_J_REGISTER_OPENING_PULLS_MISSING:${route.orderId}`);
  }

  const localEntityId = normalizeEntityRef(newState.entityId);
  const sourceHubEntityId = normalizeEntityRef(route.source.counterpartyEntityId);
  const targetHubEntityId = normalizeEntityRef(route.target.entityId);
  if (localEntityId === sourceHubEntityId) {
    return { newState, outputs: [], accountTxs: buildSourceRegistrationTxs(newState, route) };
  }
  if (localEntityId === targetHubEntityId) {
    return { newState, outputs: [], accountTxs: buildTargetRegistrationTxs(newState, route) };
  }
  return { newState, outputs: [] };
};
