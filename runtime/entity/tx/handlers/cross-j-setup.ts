import { deterministicEntityTimestamp } from '../../../orderbook/cross-j-orderbook';
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
import {
  pushCrossJurisdictionEntityOutput,
} from '../cross-j-outputs';
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
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityInput, EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import type { ApplyEntityTxOptions } from '../apply';
import type { AccountTxTarget } from './account';
import { findAccountKey } from '../account-key';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

type CrossJSetupResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
};


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

const authorizeCrossJurisdictionIntent = (
  env: EntityRuntimeContext,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  outputs: EntityInput[],
  role: 'source' | 'target',
): CrossJSetupResult => {
  if (route.status !== 'intent' || route.sourcePull || route.targetPull) {
    throw new Error(`CROSS_J_USER_AUTH_INTENT_INVALID:${route.orderId}`);
  }
  if (isCrossJurisdictionRouteExpired(route, deterministicEntityTimestamp(state, env))) {
    throw new Error(`CROSS_J_USER_AUTH_EXPIRED:${route.orderId}`);
  }
  if (role === 'source') committedCrossJSourceDisputeDelayMs(state, route);
  const sourceHubSignerId = normalizeEntityRef(route.sourceHubSignerId || '');
  if (role === 'source' && !sourceHubSignerId) {
    throw new Error(`CROSS_J_SOURCE_HUB_SIGNER_MISSING:${route.orderId}`);
  }
  state.crossJurisdictionAuthorizations ||= new Map();
  const existing = state.crossJurisdictionAuthorizations.get(route.orderId);
  if (existing) {
    if (exactRouteBytes(existing) !== exactRouteBytes(route)) {
      throw new Error(`CROSS_J_USER_AUTH_CONFLICT:${route.orderId}`);
    }
    return { newState: state, outputs };
  }
  state.crossJurisdictionAuthorizations.set(
    route.orderId,
    cloneCrossJurisdictionRoute(route),
  );
  if (role === 'source') {
    const accountId = findAccountKey(state, route.source.counterpartyEntityId);
    if (!accountId) throw new Error(`CROSS_J_SOURCE_ACCOUNT_MISSING:${route.orderId}`);
    addMessage(state, `🌉 Cross-j swap ${route.orderId} authorized by ${role} user`);
    return {
      newState: state,
      outputs,
      accountTxs: [{
        accountId,
        tx: {
          type: 'cross_j_intent',
          data: { route: cloneCrossJurisdictionRoute(route) },
        },
      }],
    };
  }
  addMessage(state, `🌉 Cross-j swap ${route.orderId} authorized by ${role} user`);
  return { newState: state, outputs };
};

export const prepareRawCrossJurisdictionIntent = (
  env: EntityRuntimeContext,
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
    // A duplicate raw intent for a route this hub already materialized is an
    // honest retry, not an attack: the submitter cannot observe our
    // materialization until the account-level offer surfaces, so it resends
    // while its own view still says "in flight". Throwing here fails the whole
    // Runtime input, which killed the hub process outright
    // (RUNTIME_ENTITY_INPUT_APPLY_FAILED -> RUNTIME_LOOP_ERROR) and took the
    // mesh down with it. Absorb the replay when it names the same route.
    //
    // `exactRouteBytes` cannot be used for this comparison: materialization
    // mutates the stored route (pulls attached, status advanced), so a stale
    // but legitimate intent never matches it byte for byte. The route hash is
    // the stable identity, and a mismatch still means a different route
    // reusing one orderId, which stays fatal.
    const storedHash = normalizeEntityRef(existing.routeHash || '');
    const replayHash = normalizeEntityRef(route.routeHash || '');
    if (storedHash && replayHash && storedHash === replayHash) {
      // Absorb the honest retry as a no-op and emit nothing. Re-announcing the
      // route here looked like the right way to converge the submitter's view,
      // but `appendDefaultProposerCrossJMaterializations` skips materialization
      // for any wake whose txs contain a registerCrossJurisdictionSwap - that
      // is its commit-phase guard. With the submitter retrying every
      // MARKET_MAKER_BOOTSTRAP_INTENT_RETRY_MS, the re-announcement landed in
      // nearly every wake and the route never left `intent` at all.
      //
      // The submitter does not need to be told: bootstrap progress is judged on
      // a route that actually advanced past `intent`, so it keeps retrying on
      // its own, and each retry is now a cheap no-op instead of a poisoned
      // commit phase.
      addMessage(state, `🌉 Cross-j prepare ${route.orderId} already materialized; replay ignored`);
      return { newState: state, outputs };
    }
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
  pushCrossJurisdictionEntityOutput(outputs, readyRoute.source.counterpartyEntityId, [
    { type: 'registerCrossJurisdictionSwap', data: { route: readyRoute } },
  ], readyRoute.sourceHubSignerId);
  pushCrossJurisdictionEntityOutput(outputs, readyRoute.target.entityId, [
    { type: 'registerCrossJurisdictionSwap', data: { route: readyRoute } },
  ], readyRoute.targetHubSignerId);
  addMessage(state, `🌉 Cross-j swap ${preparedRoute.orderId} paired source and target proposals requested by hub`);
  return { newState: state, outputs };
};

export const handlePrepareCrossJurisdictionSwapEntityTx = (
  env: EntityRuntimeContext,
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
  const localEntityId = normalizeEntityRef(newState.entityId);
  const sourceUserId = normalizeEntityRef(route.source.entityId);
  const targetUserId = normalizeEntityRef(route.target.counterpartyEntityId);
  const sourceHubId = normalizeEntityRef(route.source.counterpartyEntityId);
  if (localEntityId !== sourceUserId && localEntityId !== targetUserId && localEntityId !== sourceHubId) {
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
  if (localEntityId === sourceUserId || localEntityId === targetUserId) {
    if (hasSourcePull) throw new Error(`CROSS_J_USER_AUTH_PREPARED_FORBIDDEN:${route.orderId}`);
    return authorizeCrossJurisdictionIntent(
      env,
      newState,
      route,
      outputs,
      localEntityId === sourceUserId ? 'source' : 'target',
    );
  }
  return hasSourcePull
    ? prepareMaterializedCrossJurisdictionRoute(newState, route, outputs)
    : prepareRawCrossJurisdictionIntent(env, newState, route, outputs);
};

export const handleMaterializeCrossJurisdictionSwapEntityTx = (
  env: EntityRuntimeContext,
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
        type: 'cross_pull_lock',
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
      type: 'cross_pull_lock',
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
  env: EntityRuntimeContext,
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
    validatePreparedCrossJurisdictionRoute(newState, {
      ...cloneCrossJurisdictionRoute(route),
      status: 'target_prepared',
    });
    return { newState, outputs: [], accountTxs: buildSourceRegistrationTxs(newState, route) };
  }
  if (localEntityId === targetHubEntityId) {
    return { newState, outputs: [], accountTxs: buildTargetRegistrationTxs(newState, route) };
  }
  return { newState, outputs: [] };
};
