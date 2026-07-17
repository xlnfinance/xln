import {
  CROSS_J_MAX_FILL_RATIO,
  buildCrossJurisdictionCloseProof,
  cloneCrossJurisdictionRoute,
  getCrossJurisdictionCommittedFillAmounts,
  transitionCrossJurisdictionRouteStatus,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j/index';
import { verifyHashLadderBinary } from '../../../protocol/htlc/hash-ladder';
import { buildCrossJurisdictionCancelAck } from '../../../extensions/cross-j/orderbook';
import { removeBookOrderById } from '../../../orderbook/cross-j';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import type { CrossJurisdictionSwapRoute, EntityInput, EntityState, EntityTx, Env } from '../../../types';
import { formatEntityId } from '../../../utils';
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
type CrossJurisdictionClearMaterializationTx = Extract<EntityTx, { type: 'materializeCrossJurisdictionClear' }>;

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

const closeProofMatches = (
  left: CrossJurisdictionClearMaterializationTx['data']['proof'],
  right: CrossJurisdictionClearMaterializationTx['data']['proof'],
): boolean => left.orderId === right.orderId &&
  left.routeHash.toLowerCase() === right.routeHash.toLowerCase() &&
  left.sourcePullId === right.sourcePullId &&
  left.targetPullId === right.targetPullId &&
  left.fillRatio === right.fillRatio &&
  left.cumulativeSourceAmount === right.cumulativeSourceAmount &&
  left.cumulativeTargetAmount === right.cumulativeTargetAmount &&
  left.binaryHash.toLowerCase() === right.binaryHash.toLowerCase() &&
  left.closeMode === right.closeMode;

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

  const committedFill = getCrossJurisdictionCommittedFillAmounts(canonicalRoute);
  const ratio = committedFill.fillRatio;
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
    const proof = buildCrossJurisdictionCloseProof(canonicalRoute, '0x');
    if (accountId && account?.pulls?.has(canonicalRoute.sourcePull.pullId)) {
      mempoolOps.push({
        accountId,
        tx: {
          type: 'cross_pull_close',
          data: {
            pullId: canonicalRoute.sourcePull.pullId,
            binary: '0x',
            proof,
          },
        },
      });
    } else {
      addMessage(newState, `🌉 Cross-j clear ${orderId} waiting for source close proof`);
      return { newState, outputs, mempoolOps };
    }
    const requestedAt = deterministicEntityTimestamp(newState, env);
    transitionCrossJurisdictionRouteStatus(canonicalRoute, 'clearing', requestedAt);
    canonicalRoute.pendingClearRequestedAt = requestedAt;
    canonicalRoute.clearingPolicy = 'cancel_and_clear';
    newState.crossJurisdictionSwaps?.set(orderId, canonicalRoute);
    const firstValidator = entityState.config.validators[0];
    if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
    addMessage(newState, `🌉 Cross-j clear ${orderId} queued pure cancel close`);
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

  const closeRemainder = cancelRemainder || ratio < CROSS_J_MAX_FILL_RATIO;
  const requestedAt = deterministicEntityTimestamp(newState, env);
  transitionCrossJurisdictionRouteStatus(canonicalRoute, 'clear_requested', requestedAt);
  canonicalRoute.pendingClearRequestedAt = requestedAt;
  canonicalRoute.clearingPolicy = closeRemainder ? 'cancel_and_clear' : ratio >= CROSS_J_MAX_FILL_RATIO ? 'full_fill' : 'manual';
  newState.crossJurisdictionSwaps?.set(orderId, canonicalRoute);
  const firstValidator = entityState.config.validators[0];
  if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
  addMessage(newState, `🌉 Cross-j clear ${orderId} awaiting proposer reveal ratio=${ratio}/${CROSS_J_MAX_FILL_RATIO}`);
  return { newState, outputs, mempoolOps };
};

/**
 * Apply only proposer-authored public reveal bytes. The private ladder seed is
 * deliberately absent from deterministic replay; every validator verifies the
 * exact binary and proof against the already-committed source pull hashes.
 */
export const handleMaterializeCrossJurisdictionClearEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: CrossJurisdictionClearMaterializationTx,
): CrossJurisdictionClearResult => {
  const { orderId, binary, proof } = entityTx.data;
  const expectedProposer = normalizeEntityRef(entityState.config.validators[0] || '');
  const claimedProposer = normalizeEntityRef(entityTx.data.proposerSignerId);
  if (!expectedProposer || claimedProposer !== expectedProposer) {
    throw new Error(
      `CROSS_J_CLEAR_MATERIALIZE_PROPOSER_INVALID:${claimedProposer || 'missing'}:${expectedProposer || 'missing'}`,
    );
  }
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];
  const storedRoute = newState.crossJurisdictionSwaps?.get(orderId);
  if (!storedRoute || storedRoute.status !== 'clear_requested') {
    throw new Error(`CROSS_J_CLEAR_MATERIALIZE_INTENT_MISSING:${orderId}`);
  }
  const route = withCanonicalCrossJurisdictionRouteHash(storedRoute);
  if (!route.sourcePull || !route.targetPull) {
    throw new Error(`CROSS_J_CLEAR_MATERIALIZE_PULLS_MISSING:${orderId}`);
  }
  if (normalizeEntityRef(route.source.counterpartyEntityId) !== normalizeEntityRef(newState.entityId)) {
    throw new Error(`CROSS_J_CLEAR_MATERIALIZE_SOURCE_HUB_MISMATCH:${orderId}`);
  }
  const { fillRatio } = getCrossJurisdictionCommittedFillAmounts(route);
  if (fillRatio <= 0) throw new Error(`CROSS_J_CLEAR_MATERIALIZE_FILL_MISSING:${orderId}`);
  let decodedRatio: number;
  try {
    decodedRatio = verifyHashLadderBinary({
      fullHash: route.sourcePull.fullHash,
      partialRoot: route.sourcePull.partialRoot,
    }, binary).fillRatio;
  } catch (error) {
    throw new Error(
      `CROSS_J_CLEAR_MATERIALIZE_BINARY_INVALID:${orderId}:` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (decodedRatio !== fillRatio) {
    throw new Error(`CROSS_J_CLEAR_MATERIALIZE_RATIO_MISMATCH:${orderId}:${decodedRatio}:${fillRatio}`);
  }
  const expectedProof = buildCrossJurisdictionCloseProof(route, binary);
  if (!closeProofMatches(proof, expectedProof)) {
    throw new Error(`CROSS_J_CLEAR_MATERIALIZE_PROOF_MISMATCH:${orderId}`);
  }
  const accountId = findAccountKey(newState, route.source.entityId);
  const account = accountId ? newState.accounts.get(accountId) : undefined;
  if (!accountId || !account?.pulls?.has(route.sourcePull.pullId)) {
    throw new Error(`CROSS_J_CLEAR_MATERIALIZE_SOURCE_PULL_MISSING:${orderId}`);
  }
  if (account.swapOffers?.has(orderId)) {
    throw new Error(`CROSS_J_CLEAR_MATERIALIZE_OFFER_STILL_OPEN:${orderId}`);
  }
  if (accountHasPullResolveQueued(account, route.sourcePull.pullId)) {
    throw new Error(`CROSS_J_CLEAR_MATERIALIZE_ALREADY_QUEUED:${orderId}`);
  }

  mempoolOps.push({
    accountId,
    tx: {
      type: 'cross_pull_close',
      data: { pullId: route.sourcePull.pullId, binary, proof: expectedProof },
    },
  });
  const sourceSavingsAmount = route.priceImprovementSourceAmount ?? 0n;
  if (sourceSavingsAmount > 0n) {
    mempoolOps.push({
      accountId,
      tx: {
        type: 'direct_payment',
        data: {
          tokenId: Number(route.source.tokenId),
          amount: sourceSavingsAmount,
          route: [],
          description: `cross-j-source-savings:${orderId}`,
          fromEntityId: route.source.counterpartyEntityId,
          toEntityId: route.source.entityId,
        },
      },
    });
  }
  transitionCrossJurisdictionRouteStatus(route, 'clearing', deterministicEntityTimestamp(newState, env));
  newState.crossJurisdictionSwaps?.set(orderId, route);
  const firstValidator = entityState.config.validators[0];
  if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
  addMessage(newState, `🌉 Cross-j clear ${orderId} queued verified ratio=${fillRatio}/${CROSS_J_MAX_FILL_RATIO}`);
  return { newState, outputs, mempoolOps };
};
