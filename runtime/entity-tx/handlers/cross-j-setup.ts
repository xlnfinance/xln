import {
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
  cloneCrossJurisdictionRoute,
  isCrossJurisdictionPullExpired,
  isCrossJurisdictionRouteExpired,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../cross-jurisdiction';
import { getCrossJurisdictionBookReceiptError } from '../../cross-jurisdiction-orderbook';
import { requireRuntimeJurisdictionDisputeDelayMs } from '../../j-height';
import { pushCrossJurisdictionEntityOutput } from '../cross-j-outputs';
import {
  canonicalizeCrossJurisdictionRouteForKnownEntities,
  isCrossJurisdictionRouteParticipant,
  mergeCrossJurisdictionRoute,
  validateCrossJurisdictionLocalBinding,
  validateCrossJurisdictionRouteTransition,
} from '../cross-jurisdiction-helpers';
import { normalizeEntityRef } from '../account-key';
import { cloneEntityState, addMessage } from '../../state-helpers';
import type { CrossJurisdictionSwapRoute, EntityInput, EntityState, EntityTx, Env } from '../../types';
import { formatEntityId } from '../../utils';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

type CrossJSetupResult = {
  newState: EntityState;
  outputs: EntityInput[];
};

const deterministicEntityTimestamp = (state: EntityState, env: Env): number =>
  Number(state.timestamp || env.timestamp || 0);

const pushCrossJOutput = (
  env: Env,
  outputs: EntityInput[],
  entityId: string,
  entityTxs: EntityTx[],
): void => {
  pushCrossJurisdictionEntityOutput(env, outputs, entityId, entityTxs);
};

export const handleRequestCrossJurisdictionSwapEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'requestCrossJurisdictionSwap'>,
): CrossJSetupResult => {
  let route: CrossJurisdictionSwapRoute;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  try {
    route = withCanonicalCrossJurisdictionRouteHash(
      canonicalizeCrossJurisdictionRouteForKnownEntities(env, newState, entityTx.data.route),
    );
  } catch (error) {
    addMessage(newState, `❌ Cross-j request invalid route: ${error instanceof Error ? error.message : String(error)}`);
    return { newState, outputs };
  }
  const now = deterministicEntityTimestamp(newState, env);
  if (isCrossJurisdictionRouteExpired(route, now)) {
    addMessage(newState, `❌ Cross-j request ${route.orderId} expired`);
    return { newState, outputs };
  }
  const bindingError = validateCrossJurisdictionLocalBinding(env, newState, route);
  if (bindingError) {
    addMessage(newState, `❌ Cross-j request ${route.orderId} blocked: ${bindingError}`);
    return { newState, outputs };
  }
  if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.entityId)) {
    addMessage(newState, `❌ Cross-j request ${route.orderId} routed to wrong source entity`);
    return { newState, outputs };
  }
  if (!newState.accounts.has(normalizeEntityRef(route.source.counterpartyEntityId))) {
    addMessage(newState, `❌ Cross-j request ${route.orderId} blocked: no source account with ${formatEntityId(route.source.counterpartyEntityId)}`);
    return { newState, outputs };
  }
  newState.crossJurisdictionSwaps ||= new Map();
  const existing = newState.crossJurisdictionSwaps.get(route.orderId);
  if (existing) {
    addMessage(newState, `❌ Cross-j request ${route.orderId} already exists (${existing.status})`);
    return { newState, outputs };
  }
  const intentRoute = {
    ...route,
    status: 'intent' as const,
    updatedAt: newState.timestamp || env.timestamp,
  };
  newState.crossJurisdictionSwaps.set(intentRoute.orderId, intentRoute);
  pushCrossJOutput(env, outputs, intentRoute.source.counterpartyEntityId, [{
    type: 'prepareCrossJurisdictionSwap',
    data: { route: intentRoute },
  }]);
  addMessage(newState, `🌉 Cross-j swap ${intentRoute.orderId} requested`);
  return { newState, outputs };
};

export const handlePrepareCrossJurisdictionSwapEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'prepareCrossJurisdictionSwap'>,
): CrossJSetupResult => {
  let route: CrossJurisdictionSwapRoute;
  const newState = cloneEntityState(entityState);
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
  const preparedRoute = buildPreparedCrossJurisdictionRoute(route, {
    runtimeSeed: (env as { runtimeSeed?: string }).runtimeSeed,
    sourceDisputeDelayMs: requireRuntimeJurisdictionDisputeDelayMs(env, route.source.jurisdiction),
    now: newState.timestamp || env.timestamp,
  });
  if (!preparedRoute.targetPull || !preparedRoute.sourcePull) {
    addMessage(newState, `❌ Cross-j prepare ${route.orderId} failed: pull commitments missing`);
    return { newState, outputs };
  }
  newState.crossJurisdictionSwaps ||= new Map();
  const existing = newState.crossJurisdictionSwaps.get(preparedRoute.orderId);
  const transitionError = validateCrossJurisdictionRouteTransition(existing, preparedRoute);
  if (transitionError) {
    addMessage(newState, `❌ Cross-j prepare ${route.orderId} blocked: ${transitionError}`);
    return { newState, outputs };
  }
  newState.crossJurisdictionSwaps.set(preparedRoute.orderId, mergeCrossJurisdictionRoute(existing, preparedRoute));
  const publicPreparedRoute = cloneCrossJurisdictionRoute(preparedRoute);

  pushCrossJOutput(env, outputs, publicPreparedRoute.target.entityId, [
    { type: 'registerCrossJurisdictionSwap', data: { route: publicPreparedRoute } },
    {
      type: 'pullLock',
      data: {
        counterpartyEntityId: publicPreparedRoute.target.counterpartyEntityId,
        pullId: publicPreparedRoute.targetPull!.pullId,
        tokenId: publicPreparedRoute.targetPull!.tokenId,
        amount: publicPreparedRoute.targetPull!.signedAmount,
          revealedUntilTimestamp: publicPreparedRoute.targetPull!.revealedUntilTimestamp,
          fullHash: publicPreparedRoute.targetPull!.fullHash,
          partialRoot: publicPreparedRoute.targetPull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(publicPreparedRoute, 'target'),
          description: publicPreparedRoute.memo || `Cross-j target pull ${publicPreparedRoute.orderId}`,
        },
      },
    ]);
  pushCrossJOutput(env, outputs, publicPreparedRoute.target.counterpartyEntityId, [
    { type: 'registerCrossJurisdictionSwap', data: { route: publicPreparedRoute } },
  ]);
  addMessage(newState, `🌉 Cross-j swap ${preparedRoute.orderId} target lock requested by hub`);
  return { newState, outputs };
};

export const handleCommitCrossJurisdictionSwapEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'commitCrossJurisdictionSwap'>,
): CrossJSetupResult => {
  let route: CrossJurisdictionSwapRoute;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  try {
    route = withCanonicalCrossJurisdictionRouteHash(
      canonicalizeCrossJurisdictionRouteForKnownEntities(env, newState, entityTx.data.route),
    );
  } catch (error) {
    addMessage(newState, `❌ Cross-j commit invalid route: ${error instanceof Error ? error.message : String(error)}`);
    return { newState, outputs };
  }
  const now = deterministicEntityTimestamp(newState, env);
  if (isCrossJurisdictionRouteExpired(route, now) || isCrossJurisdictionPullExpired(route, 'source', now)) {
    addMessage(newState, `❌ Cross-j commit ${route.orderId} expired`);
    return { newState, outputs };
  }
  if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.entityId)) {
    addMessage(newState, `❌ Cross-j commit ${route.orderId} routed to wrong source entity`);
    return { newState, outputs };
  }
  const bindingError = validateCrossJurisdictionLocalBinding(env, newState, route);
  if (bindingError) {
    addMessage(newState, `❌ Cross-j commit ${route.orderId} blocked: ${bindingError}`);
    return { newState, outputs };
  }
  if (!route.sourcePull || !route.targetPull) {
    addMessage(newState, `❌ Cross-j commit ${route.orderId} missing pull commitments`);
    return { newState, outputs };
  }
  const targetReceipt = entityTx.data.targetReceipt ?? route.targetReceipt;
  if (!targetReceipt || targetReceipt.leg !== 'target') {
    addMessage(newState, `❌ Cross-j commit ${route.orderId} blocked: target receipt missing`);
    return { newState, outputs };
  }
  const receiptError = getCrossJurisdictionBookReceiptError(route, targetReceipt);
  if (receiptError) {
    addMessage(newState, `❌ Cross-j commit ${route.orderId} blocked: ${receiptError}`);
    return { newState, outputs };
  }
  const sourcePull = route.sourcePull;
  const targetPull = route.targetPull;
  const restingRoute = {
    ...cloneCrossJurisdictionRoute(route),
    sourcePull,
    targetPull,
    targetReceipt,
    status: 'resting' as const,
    updatedAt: newState.timestamp || env.timestamp,
  };
  newState.crossJurisdictionSwaps ||= new Map();
  const existing = newState.crossJurisdictionSwaps.get(restingRoute.orderId);
  const transitionError = validateCrossJurisdictionRouteTransition(existing, restingRoute);
  if (transitionError) {
    addMessage(newState, `❌ Cross-j commit ${route.orderId} blocked: ${transitionError}`);
    return { newState, outputs };
  }
  newState.crossJurisdictionSwaps.set(restingRoute.orderId, mergeCrossJurisdictionRoute(existing, restingRoute));
  const firstValidator = entityState.config.validators[0];
  outputs.push({
    entityId: newState.entityId,
    ...(firstValidator ? { signerId: firstValidator } : {}),
    entityTxs: [
      {
        type: 'pullLock',
        data: {
          counterpartyEntityId: restingRoute.source.counterpartyEntityId,
          pullId: sourcePull.pullId,
          tokenId: sourcePull.tokenId,
          amount: sourcePull.signedAmount,
            revealedUntilTimestamp: sourcePull.revealedUntilTimestamp,
            fullHash: sourcePull.fullHash,
            partialRoot: sourcePull.partialRoot,
            crossJurisdiction: buildCrossJurisdictionPullBinding(restingRoute, 'source'),
            description: restingRoute.memo || `Cross-j source pull ${restingRoute.orderId}`,
          },
        },
      {
        type: 'placeSwapOffer',
        data: {
          counterpartyEntityId: restingRoute.source.counterpartyEntityId,
          offerId: restingRoute.orderId,
          giveTokenId: restingRoute.source.tokenId,
          giveAmount: restingRoute.source.amount,
          wantTokenId: restingRoute.target.tokenId,
          wantAmount: restingRoute.target.amount,
          ...(restingRoute.priceTicks !== undefined ? { priceTicks: restingRoute.priceTicks } : {}),
          timeInForce: 0,
          minFillRatio: 0,
          crossJurisdiction: cloneCrossJurisdictionRoute(restingRoute),
        },
      },
    ],
  });
  addMessage(newState, `🌉 Cross-j swap ${restingRoute.orderId} committed by source`);
  return { newState, outputs };
};

export const handleRegisterCrossJurisdictionSwapEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'registerCrossJurisdictionSwap'>,
): CrossJSetupResult => {
  let route: CrossJurisdictionSwapRoute;
  const newState = cloneEntityState(entityState);
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
  return { newState, outputs: [] };
};
