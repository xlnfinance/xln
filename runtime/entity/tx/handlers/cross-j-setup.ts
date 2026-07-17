import {
  buildCrossJurisdictionPullBinding,
  cloneCrossJurisdictionRoute,
  isCrossJurisdictionPullExpired,
  isCrossJurisdictionRouteExpired,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j/index';
import { getCrossJurisdictionBookReceiptError } from '../../../extensions/cross-j/orderbook';
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
import { cloneEntityState, addMessage } from '../../../state-helpers';
import { safeStringify } from '../../../protocol/serialization';
import type { CrossJurisdictionSwapRoute, EntityInput, EntityState, EntityTx, Env } from '../../../types';
import { formatEntityId } from '../../../utils';
import type { ApplyEntityTxOptions } from '../apply';
import type { MempoolOp } from './account';
import { findAccountKey } from '../account-key';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

type CrossJSetupResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

const deterministicEntityTimestamp = (state: EntityState, env: Env): number =>
  Number(state.timestamp || env.timestamp || 0);

const stateForEntityTx = (entityState: EntityState, options?: ApplyEntityTxOptions): EntityState =>
  options?.mutableFrameState ? entityState : cloneEntityState(entityState);

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
  env: Env,
  outputs: EntityInput[],
  entityId: string,
  entityTxs: EntityTx[],
  signerIdHint?: string | null,
): void => {
  pushCrossJurisdictionEntityOutput(env, outputs, entityId, entityTxs, signerIdHint);
};

export const handleRequestCrossJurisdictionSwapEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'requestCrossJurisdictionSwap'>,
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
  const sourceAccountId = findAccountKey(newState, route.source.counterpartyEntityId);
  if (!sourceAccountId) {
    addMessage(newState, `❌ Cross-j request ${route.orderId} blocked: no source account with ${formatEntityId(route.source.counterpartyEntityId)}`);
    return { newState, outputs };
  }
  if (route.sourcePull || route.targetPull) {
    addMessage(newState, `❌ Cross-j request ${route.orderId} must not contain proposer commitments`);
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
  addMessage(newState, `🌉 Cross-j swap ${intentRoute.orderId} requested`);
  return {
    newState,
    outputs,
    mempoolOps: [{
      accountId: sourceAccountId,
      tx: { type: 'cross_j_intent', data: { route: cloneCrossJurisdictionRoute(intentRoute) } },
    }],
  };
};

export const handlePrepareCrossJurisdictionSwapEntityTx = (
  env: Env,
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
  if (!hasSourcePull) {
    if (route.status !== 'intent') {
      throw new Error(`CROSS_J_RAW_PREPARE_STATUS_INVALID:${route.orderId}:${route.status}`);
    }
    const now = deterministicEntityTimestamp(newState, env);
    if (isCrossJurisdictionRouteExpired(route, now)) {
      addMessage(newState, `❌ Cross-j prepare ${route.orderId} expired`);
      return { newState, outputs };
    }
    if (
      String(route.source.jurisdiction).trim().toLowerCase() ===
        String(route.target.jurisdiction).trim().toLowerCase() &&
      Number(route.source.tokenId) === Number(route.target.tokenId)
    ) {
      addMessage(newState, `❌ Cross-j prepare ${route.orderId} must cross a jurisdiction or asset boundary`);
      return { newState, outputs };
    }
    try {
      // Validate every public prerequisite before making the intent durable.
      // The private seed remains untouched until the default proposer signs
      // the later materialization command.
      committedCrossJSourceDisputeDelayMs(newState, route);
    } catch (error) {
      addMessage(
        newState,
        `❌ Cross-j prepare ${route.orderId} blocked: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { newState, outputs };
    }
    newState.crossJurisdictionSwaps ||= new Map();
    const existing = newState.crossJurisdictionSwaps.get(route.orderId);
    if (existing?.sourcePull || existing?.targetPull) {
      throw new Error(`CROSS_J_RAW_PREPARE_AFTER_MATERIALIZATION:${route.orderId}`);
    }
    if (existing) {
      if (exactRouteBytes(existing) !== exactRouteBytes(route)) {
        throw new Error(`CROSS_J_RAW_PREPARE_CONFLICT:${route.orderId}`);
      }
      return { newState, outputs };
    }
    newState.crossJurisdictionSwaps.set(route.orderId, cloneCrossJurisdictionRoute(route));
    const firstValidator = newState.config.validators[0];
    if (!firstValidator) throw new Error(`CROSS_J_SOURCE_HUB_PROPOSER_MISSING:${route.orderId}`);
    outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
    addMessage(newState, `🌉 Cross-j swap ${route.orderId} awaiting source-hub proposer commitments`);
    return { newState, outputs };
  }
  const preparedRoute = validatePreparedCrossJurisdictionRoute(newState, route);
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
          crossJurisdictionRoute: cloneCrossJurisdictionRoute(publicPreparedRoute),
          description: publicPreparedRoute.memo || `Cross-j target pull ${publicPreparedRoute.orderId}`,
        },
      },
    ], publicPreparedRoute.targetHubSignerId);
  addMessage(newState, `🌉 Cross-j swap ${preparedRoute.orderId} target lock requested by hub`);
  return { newState, outputs };
};

export const handleMaterializeCrossJurisdictionSwapEntityTx = (
  env: Env,
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

export const handleCommitCrossJurisdictionSwapEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'commitCrossJurisdictionSwap'>,
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
  const readyRoute = {
    ...cloneCrossJurisdictionRoute(route),
    sourcePull,
    targetPull,
    targetReceipt,
    status: 'target_locked' as const,
    updatedAt: newState.timestamp || env.timestamp,
  };
  newState.crossJurisdictionSwaps ||= new Map();
  const existing = newState.crossJurisdictionSwaps.get(readyRoute.orderId);
  const transitionError = validateCrossJurisdictionRouteTransition(existing, readyRoute);
  if (transitionError) {
    addMessage(newState, `❌ Cross-j commit ${route.orderId} blocked: ${transitionError}`);
    return { newState, outputs };
  }
  newState.crossJurisdictionSwaps.set(readyRoute.orderId, mergeCrossJurisdictionRoute(existing, readyRoute));
  const accountId = findAccountKey(newState, readyRoute.source.counterpartyEntityId);
  if (!accountId) throw new Error(`CROSS_J_SOURCE_ACCOUNT_MISSING:${readyRoute.orderId}`);
  const restingAccountRoute = { ...cloneCrossJurisdictionRoute(readyRoute), status: 'resting' as const };
  const mempoolOps: MempoolOp[] = [
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
          crossJurisdiction: buildCrossJurisdictionPullBinding(restingAccountRoute, 'source'),
          crossJurisdictionRoute: cloneCrossJurisdictionRoute(restingAccountRoute),
        },
      },
    },
    {
      accountId,
      tx: {
        type: 'swap_offer',
        data: {
          offerId: readyRoute.orderId,
          giveTokenId: readyRoute.source.tokenId,
          giveAmount: readyRoute.source.amount,
          wantTokenId: readyRoute.target.tokenId,
          wantAmount: readyRoute.target.amount,
          ...(readyRoute.priceTicks !== undefined ? { priceTicks: readyRoute.priceTicks } : {}),
          timeInForce: 0,
          minFillRatio: 0,
          crossJurisdiction: cloneCrossJurisdictionRoute(restingAccountRoute),
        },
      },
    },
  ];
  addMessage(newState, `🌉 Cross-j swap ${readyRoute.orderId} target lock observed; source Account queued`);
  return { newState, outputs, mempoolOps };
};

export const handleRegisterCrossJurisdictionSwapEntityTx = (
  env: Env,
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
  return { newState, outputs: [] };
};
