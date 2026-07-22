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
import { cloneEntityState, addMessage } from '../../../state-helpers';
import { safeStringify } from '../../../protocol/serialization';
import type { CrossJurisdictionSwapRoute, EntityInput, EntityState, EntityTx, Env } from '../../../types';
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
  const sourceAccountId = findAccountKey(newState, publicPreparedRoute.source.entityId);
  if (!sourceAccountId) throw new Error(`CROSS_J_SOURCE_ACCOUNT_MISSING:${publicPreparedRoute.orderId}`);
  const readyRoute = {
    ...cloneCrossJurisdictionRoute(publicPreparedRoute),
    status: 'resting' as const,
  };

  pushCrossJOutput(env, outputs, readyRoute.target.entityId, [
    { type: 'registerCrossJurisdictionSwap', data: { route: readyRoute } },
    {
      type: 'pullLock',
      data: {
        counterpartyEntityId: readyRoute.target.counterpartyEntityId,
        pullId: readyRoute.targetPull!.pullId,
        tokenId: readyRoute.targetPull!.tokenId,
        amount: readyRoute.targetPull!.signedAmount,
          revealedUntilTimestamp: readyRoute.targetPull!.revealedUntilTimestamp,
          fullHash: readyRoute.targetPull!.fullHash,
          partialRoot: readyRoute.targetPull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(readyRoute, 'target'),
          crossJurisdictionRoute: cloneCrossJurisdictionRoute(readyRoute),
          description: readyRoute.memo || `Cross-j target pull ${readyRoute.orderId}`,
        },
      },
  ], readyRoute.targetHubSignerId);
  addMessage(newState, `🌉 Cross-j swap ${preparedRoute.orderId} paired source and target proposals requested by hub`);
  return {
    newState,
    outputs,
    mempoolOps: [
      {
        accountId: sourceAccountId,
        tx: {
          type: 'pull_lock',
          data: {
            pullId: readyRoute.sourcePull!.pullId,
            tokenId: readyRoute.sourcePull!.tokenId,
            amount: readyRoute.sourcePull!.signedAmount,
            revealedUntilTimestamp: readyRoute.sourcePull!.revealedUntilTimestamp,
            fullHash: readyRoute.sourcePull!.fullHash,
            partialRoot: readyRoute.sourcePull!.partialRoot,
            crossJurisdiction: buildCrossJurisdictionPullBinding(readyRoute, 'source'),
            crossJurisdictionRoute: cloneCrossJurisdictionRoute(readyRoute),
          },
        },
      },
      {
        accountId: sourceAccountId,
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
            crossJurisdiction: cloneCrossJurisdictionRoute(readyRoute),
          },
        },
      },
    ],
  };
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
