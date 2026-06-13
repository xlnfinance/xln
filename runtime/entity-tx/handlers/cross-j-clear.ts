import {
  buildCrossJurisdictionPullReveal,
  cloneCrossJurisdictionRoute,
  getCrossJurisdictionPrivateSeed,
  transitionCrossJurisdictionRouteStatus,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../cross-jurisdiction';
import { buildCrossJurisdictionCancelAck } from '../../cross-jurisdiction-orderbook';
import { removeBookOrderById } from '../../orderbook/cross-j';
import { cloneEntityState, addMessage } from '../../state-helpers';
import type { CrossJurisdictionSwapRoute, EntityInput, EntityState, EntityTx, Env } from '../../types';
import { formatEntityId } from '../../utils';
import { findAccountKey, normalizeEntityRef } from '../account-key';
import {
  accountHasCrossSwapAckQueued,
  accountHasPullResolveQueued,
  findCrossJurisdictionOfferRoute,
  mergeCrossJurisdictionRoute,
} from '../cross-jurisdiction-helpers';
import { pushCrossJurisdictionEntityOutput } from '../cross-j-outputs';
import type { MempoolOp } from './account';

type CrossJurisdictionClearTx = Extract<EntityTx, { type: 'requestCrossJurisdictionClear' }>;

type CrossJurisdictionClearResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

const deterministicEntityTimestamp = (state: EntityState, env: Env): number =>
  Number(state.timestamp || env.timestamp || 0);

const cancelOrderbookOfferIfPresent = (
  env: Env,
  state: EntityState,
  accountId: string,
  offerId: string,
): boolean => removeBookOrderById(env, state, `${accountId}:${offerId}`);

const pushCrossJOutput = (
  env: Env,
  outputs: EntityInput[],
  entityId: string,
  entityTxs: EntityTx[],
  signerIdHint?: string | null,
): void => {
  pushCrossJurisdictionEntityOutput(env, outputs, entityId, entityTxs, signerIdHint);
};

export const handleRequestCrossJurisdictionClearEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: CrossJurisdictionClearTx,
): CrossJurisdictionClearResult => {
  const { orderId, cancelRemainder = false } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];
  let route = newState.crossJurisdictionSwaps?.get(orderId);
  if (!route) {
    addMessage(newState, `❌ Cross-j clear ${orderId} missing route`);
    return { newState, outputs, mempoolOps };
  }

  const offerRoute = findCrossJurisdictionOfferRoute(newState, orderId);
  if (offerRoute) {
    // Cross-j clear is money movement. The account offer snapshot and entity
    // route mirror must agree exactly; falling back to either side would be
    // rehydration and could reveal a pull for stale economics.
    route = mergeCrossJurisdictionRoute(route, withCanonicalCrossJurisdictionRouteHash(offerRoute.route));
    newState.crossJurisdictionSwaps ||= new Map();
    newState.crossJurisdictionSwaps.set(orderId, route);
  }

  const sourceHubId = normalizeEntityRef(route.source.counterpartyEntityId);
  if (normalizeEntityRef(newState.entityId) !== sourceHubId) {
    pushCrossJOutput(env, outputs, route.source.counterpartyEntityId, [{
      type: 'requestCrossJurisdictionClear',
      data: { orderId, cancelRemainder, route: cloneCrossJurisdictionRoute(route) },
    }], route.sourceHubSignerId);
    const requestedAt = deterministicEntityTimestamp(newState, env);
    transitionCrossJurisdictionRouteStatus(route, 'clear_requested', requestedAt);
    route.pendingClearRequestedAt = requestedAt;
    route.clearingPolicy = cancelRemainder ? 'cancel_and_clear' : 'manual';
    newState.crossJurisdictionSwaps?.set(orderId, route);
    addMessage(newState, `🌉 Cross-j clear ${orderId} requested from source hub`);
    return { newState, outputs, mempoolOps };
  }

  const canonicalRoute: CrossJurisdictionSwapRoute = withCanonicalCrossJurisdictionRouteHash(route);
  if (!canonicalRoute.sourcePull || !canonicalRoute.targetPull) {
    throw new Error(`CROSS_J_CLEAR_CORRUPT_ROUTE: order=${orderId} pull commitments missing`);
  }

  const ratio = Math.max(
    0,
    Math.min(65_535, Math.floor(Number(canonicalRoute.cumulativeFillRatio ?? canonicalRoute.claimedRatio ?? 0) || 0)),
  );
  const accountId = findAccountKey(newState, canonicalRoute.source.entityId);
  const account = accountId ? newState.accounts.get(accountId) : undefined;
  const liveOffer = account?.swapOffers?.get(orderId);

  if (liveOffer?.crossJurisdiction && (cancelRemainder || ratio > 0)) {
    if (!accountId || !account) {
      addMessage(newState, `❌ Cross-j clear ${orderId} blocked: no source account with ${formatEntityId(canonicalRoute.source.entityId)}`);
      return { newState, outputs, mempoolOps };
    }
    if (accountHasCrossSwapAckQueued(account, orderId)) {
      addMessage(newState, `🌉 Cross-j clear ${orderId} waiting for account offer close ack`);
      return { newState, outputs, mempoolOps };
    }
    const removedFromBook = cancelOrderbookOfferIfPresent(env, newState, accountId, orderId);
    mempoolOps.push({
      accountId,
      tx: buildCrossJurisdictionCancelAck(orderId, canonicalRoute),
    });
    const requestedAt = deterministicEntityTimestamp(newState, env);
    transitionCrossJurisdictionRouteStatus(canonicalRoute, 'clear_requested', requestedAt);
    canonicalRoute.pendingClearRequestedAt = requestedAt;
    canonicalRoute.clearingPolicy = 'cancel_and_clear';
    newState.crossJurisdictionSwaps?.set(orderId, canonicalRoute);
    const firstValidator = entityState.config.validators[0];
    if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
    addMessage(
      newState,
      removedFromBook
        ? `🌉 Cross-j clear ${orderId} removed live book order and queued account offer close before pull reveal`
        : `🌉 Cross-j clear ${orderId} queued account offer close before pull reveal`,
    );
    return { newState, outputs, mempoolOps };
  }

  if (ratio <= 0) {
    if (!cancelRemainder) {
      addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: no pending fill`);
      return { newState, outputs, mempoolOps };
    }
    if (accountId && account?.pulls?.has(canonicalRoute.sourcePull.pullId)) {
      mempoolOps.push({
        accountId,
        tx: {
          type: 'pull_cancel',
          data: {
            pullId: canonicalRoute.sourcePull.pullId,
            reason: 'cross_j_cancel_no_fill',
          },
        },
      });
    }
    pushCrossJOutput(env, outputs, canonicalRoute.target.counterpartyEntityId, [{
      type: 'cancelPull',
      data: {
        counterpartyEntityId: canonicalRoute.target.entityId,
        pullId: canonicalRoute.targetPull.pullId,
        description: `Cross-j ${orderId} cancel target pull without fill`,
      },
    }], canonicalRoute.targetSignerId);
    const requestedAt = deterministicEntityTimestamp(newState, env);
    transitionCrossJurisdictionRouteStatus(canonicalRoute, 'cancelled', requestedAt);
    canonicalRoute.pendingClearRequestedAt = requestedAt;
    canonicalRoute.clearingPolicy = 'cancel_and_clear';
    newState.crossJurisdictionSwaps?.set(orderId, canonicalRoute);
    const firstValidator = entityState.config.validators[0];
    if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
    addMessage(newState, `🌉 Cross-j clear ${orderId} cancelled without fill`);
    return { newState, outputs, mempoolOps };
  }

  if (!accountId || !account) {
    addMessage(newState, `❌ Cross-j clear ${orderId} blocked: no source account with ${formatEntityId(canonicalRoute.source.entityId)}`);
    return { newState, outputs, mempoolOps };
  }
  if (!account.pulls?.has(canonicalRoute.sourcePull.pullId)) {
    addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: source pull already closed`);
    return { newState, outputs, mempoolOps };
  }
  if (accountHasPullResolveQueued(account, canonicalRoute.sourcePull.pullId)) {
    addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: source pull resolve already queued`);
    return { newState, outputs, mempoolOps };
  }

  let reveal;
  try {
    reveal = buildCrossJurisdictionPullReveal(
      canonicalRoute,
      ratio,
      getCrossJurisdictionPrivateSeed(env, canonicalRoute),
    );
  } catch (error) {
    throw new Error(
      `CROSS_J_CLEAR_REVEAL_FAILED: order=${orderId} ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  mempoolOps.push({
    accountId,
    tx: {
      type: 'pull_resolve',
      data: {
        pullId: canonicalRoute.sourcePull.pullId,
        binary: reveal.binary,
      },
    },
  });

  const sourceSavingsAmount = canonicalRoute.priceImprovementSourceAmount ?? 0n;
  if (sourceSavingsAmount > 0n) {
    mempoolOps.push({
      accountId,
      tx: {
        type: 'direct_payment',
        data: {
          tokenId: Number(canonicalRoute.source.tokenId),
          amount: sourceSavingsAmount,
          route: [],
          description: `cross-j-source-savings:${orderId}`,
          fromEntityId: canonicalRoute.source.counterpartyEntityId,
          toEntityId: canonicalRoute.source.entityId,
        },
      },
    });
  }

  const closeRemainder = cancelRemainder || ratio < 65_535;
  const requestedAt = deterministicEntityTimestamp(newState, env);
  transitionCrossJurisdictionRouteStatus(canonicalRoute, 'clearing', requestedAt);
  canonicalRoute.pendingClearRequestedAt = requestedAt;
  canonicalRoute.clearingPolicy = closeRemainder ? 'cancel_and_clear' : ratio >= 65_535 ? 'full_fill' : 'manual';
  newState.crossJurisdictionSwaps?.set(orderId, canonicalRoute);
  const firstValidator = entityState.config.validators[0];
  if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
  addMessage(newState, `🌉 Cross-j clear ${orderId} queued ratio=${ratio}/65535`);
  return { newState, outputs, mempoolOps };
};
