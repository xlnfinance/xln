import { haltRuntimeFailure } from "../../../../protocol/errors/failure-taxonomy";

import { deterministicEntityTimestamp } from '../../../../orderbook/cross-j/orderbook';
import {
  CROSS_J_MAX_FILL_RATIO,
  buildCrossJurisdictionCloseProof,
  cloneCrossJurisdictionRoute,
  getCrossJurisdictionCommittedFillAmounts,
  transitionCrossJurisdictionRouteStatus,
  withCanonicalCrossJurisdictionRouteHash,
  cloneCrossJurisdictionCloseProof,
} from '../../../../extensions/cross-j/index';
import { verifyHashLadderBinary } from '../../../../protocol/htlc/hash-ladder';
import { buildCrossJurisdictionCancelAck } from '../../../../extensions/cross-j/orderbook';
import { removeBookOrderById } from '../../../../orderbook/cross-j';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import type { CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import type { RuntimeOverlayRecord } from '../../../../types/account';
import { findAccountKey, normalizeEntityRef } from '../../account-key';
import {
  accountHasCrossSwapAckQueued,
  accountHasCrossPullCloseQueued,
  findCrossJurisdictionOfferRoute,
  mergeCrossJurisdictionRoute,
} from '../../j-events-htlc/cross-jurisdiction-helpers';
import { pushCrossJurisdictionEntityOutput } from '../../j-events-htlc/cross-j-outputs';
import type { AccountTxTarget } from '../account';

type CrossJurisdictionClearTx = Extract<EntityTx, { type: 'requestCrossJurisdictionClear' }>;
type CrossJurisdictionClearMaterializationTx = Extract<EntityTx, { type: 'materializeCrossJurisdictionClear' }>;

type CrossJurisdictionClearResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
};


const cancelOrderbookOfferIfPresent = (
  state: EntityState,
  accountId: string,
  offerId: string,
  storageChanges: RuntimeOverlayRecord[],
): boolean => removeBookOrderById(state, `${accountId}:${offerId}`, storageChanges);

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

type ClearContext = {
  env: EntityRuntimeContext;
  entityState: EntityState;
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs: AccountTxTarget[];
  orderId: string;
  cancelRemainder: boolean;
};

const requestClearThroughSourceAccount = (
  context: ClearContext,
  route: CrossJurisdictionSwapRoute,
): CrossJurisdictionClearResult | undefined => {
  const { env, newState, outputs, accountTxs, orderId, cancelRemainder } = context;
  const sourceHubId = normalizeEntityRef(route.source.counterpartyEntityId);
  if (normalizeEntityRef(newState.entityId) === sourceHubId) return undefined;

  const sourceUserId = normalizeEntityRef(route.source.entityId);
  if (normalizeEntityRef(newState.entityId) !== sourceUserId) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_SOURCE_PARTICIPANT_REQUIRED", `CROSS_J_CLEAR_SOURCE_PARTICIPANT_REQUIRED:${orderId}:${newState.entityId}:${sourceUserId}`);
  }
  const sourceAccountId = findAccountKey(newState, sourceHubId);
  const sourceAccount = sourceAccountId ? newState.accounts.get(sourceAccountId) : undefined;
  const sourceOffer = sourceAccount?.state.swapOffers?.get(orderId);
  if (!sourceAccountId || !sourceAccount || !sourceOffer?.crossJurisdiction) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_SOURCE_OFFER_MISSING", `CROSS_J_CLEAR_SOURCE_OFFER_MISSING:${orderId}:${newState.entityId}:${sourceHubId}`);
  }
  if (!cancelRemainder && getCrossJurisdictionCommittedFillAmounts(route).fillRatio <= 0) {
    addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: no pending fill`);
    return { newState, outputs, accountTxs };
  }

  // The user cannot address the remote hub diagonally. Committing this request
  // through the bilateral Account lets the source hub close the exact offer.
  accountTxs.push({
    accountId: sourceAccountId,
    tx: { type: 'swap_cancel_request', data: { offerId: orderId } },
  });
  const requestedAt = deterministicEntityTimestamp(newState, env);
  transitionCrossJurisdictionRouteStatus(route, 'clear_requested', requestedAt);
  route.pendingClearRequestedAt = requestedAt;
  route.clearingPolicy = cancelRemainder ? 'cancel_and_clear' : 'manual';
  newState.crossJurisdictionSwaps?.set(orderId, route);
  addMessage(newState, `🌉 Cross-j clear ${orderId} queued through source Account`);
  return { newState, outputs, accountTxs };
};

const closeLiveSourceOffer = (
  context: ClearContext,
  route: CrossJurisdictionSwapRoute,
  accountId: string | null,
  storageChanges: RuntimeOverlayRecord[],
): CrossJurisdictionClearResult | undefined => {
  const { env, entityState, newState, outputs, accountTxs, orderId, cancelRemainder } = context;
  const account = accountId ? newState.accounts.get(accountId) : undefined;
  const liveOffer = account?.state.swapOffers?.get(orderId);
  const ratio = getCrossJurisdictionCommittedFillAmounts(route).fillRatio;
  if (!liveOffer?.crossJurisdiction || (!cancelRemainder && ratio <= 0)) return undefined;
  if (!accountId || !account) {
    addMessage(newState, `❌ Cross-j clear ${orderId} blocked: no source account with ${route.source.entityId}`);
    return { newState, outputs, accountTxs };
  }
  if (accountHasCrossSwapAckQueued(account, orderId)) {
    addMessage(newState, `🌉 Cross-j clear ${orderId} waiting for account offer close ack`);
    return { newState, outputs, accountTxs };
  }

  const removedFromBook = cancelOrderbookOfferIfPresent(newState, accountId, orderId, storageChanges);
  accountTxs.push({ accountId, tx: buildCrossJurisdictionCancelAck(orderId, route) });
  const requestedAt = deterministicEntityTimestamp(newState, env);
  transitionCrossJurisdictionRouteStatus(route, 'clear_requested', requestedAt);
  route.pendingClearRequestedAt = requestedAt;
  route.clearingPolicy = 'cancel_and_clear';
  newState.crossJurisdictionSwaps?.set(orderId, route);
  const firstValidator = entityState.config.validators[0];
  if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
  addMessage(
    newState,
    removedFromBook
      ? `🌉 Cross-j clear ${orderId} removed live book order and queued account offer close before pull reveal`
      : `🌉 Cross-j clear ${orderId} queued account offer close before pull reveal`,
  );
  return { newState, outputs, accountTxs };
};

const requestPureCancel = (
  context: ClearContext,
  route: CrossJurisdictionSwapRoute,
  accountId: string | null,
): CrossJurisdictionClearResult => {
  const { env, entityState, newState, outputs, accountTxs, orderId, cancelRemainder } = context;
  const account = accountId ? newState.accounts.get(accountId) : undefined;
  if (!cancelRemainder) {
    addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: no pending fill`);
    return { newState, outputs, accountTxs };
  }
  const proof = buildCrossJurisdictionCloseProof(route, '0x');
  if (!accountId || !account?.state.pulls?.has(route.sourcePull!.pullId)) {
    addMessage(newState, `🌉 Cross-j clear ${orderId} waiting for source close proof`);
    return { newState, outputs, accountTxs };
  }
  accountTxs.push({
    accountId,
    tx: { type: 'cross_pull_close', data: { pullId: route.sourcePull!.pullId, binary: '0x', proof } },
  });
  const requestedAt = deterministicEntityTimestamp(newState, env);
  const targetCommandRoute = cloneCrossJurisdictionRoute(route);
  targetCommandRoute.sourceCloseProof = cloneCrossJurisdictionCloseProof(proof);
  transitionCrossJurisdictionRouteStatus(targetCommandRoute, 'clearing', requestedAt);
  pushCrossJurisdictionEntityOutput(
    outputs,
    route.target.entityId,
    [{
      type: 'crossPullClose',
      data: {
        counterpartyEntityId: route.target.counterpartyEntityId,
        pullId: route.targetPull!.pullId,
        binary: '0x',
        proof,
        route: targetCommandRoute,
        description: `Cross-j ${orderId} paired pure-cancel target close`,
      },
    }],
    route.targetHubSignerId,
  );
  route.sourceCloseProof = cloneCrossJurisdictionCloseProof(proof);
  transitionCrossJurisdictionRouteStatus(route, 'clearing', requestedAt);
  route.pendingClearRequestedAt = requestedAt;
  route.clearingPolicy = 'cancel_and_clear';
  newState.crossJurisdictionSwaps?.set(orderId, route);
  const firstValidator = entityState.config.validators[0];
  if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
  addMessage(newState, `🌉 Cross-j clear ${orderId} queued atomic Hub pure-cancel close`);
  return { newState, outputs, accountTxs };
};

const requestFilledRouteReveal = (
  context: ClearContext,
  route: CrossJurisdictionSwapRoute,
  accountId: string | null,
  ratio: number,
): CrossJurisdictionClearResult => {
  const { env, entityState, newState, outputs, accountTxs, orderId, cancelRemainder } = context;
  const account = accountId ? newState.accounts.get(accountId) : undefined;
  if (!accountId || !account) {
    addMessage(newState, `❌ Cross-j clear ${orderId} blocked: no source account with ${route.source.entityId}`);
    return { newState, outputs, accountTxs };
  }
  if (!account.state.pulls?.has(route.sourcePull!.pullId)) {
    addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: source pull already closed`);
    return { newState, outputs, accountTxs };
  }
  if (accountHasCrossPullCloseQueued(account, route.sourcePull!.pullId)) {
    addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: source pull close already queued`);
    return { newState, outputs, accountTxs };
  }

  const requestedAt = deterministicEntityTimestamp(newState, env);
  transitionCrossJurisdictionRouteStatus(route, 'clear_requested', requestedAt);
  route.pendingClearRequestedAt = requestedAt;
  route.clearingPolicy = cancelRemainder || ratio < CROSS_J_MAX_FILL_RATIO ? 'cancel_and_clear' : 'full_fill';
  newState.crossJurisdictionSwaps?.set(orderId, route);
  const firstValidator = entityState.config.validators[0];
  if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
  addMessage(newState, `🌉 Cross-j clear ${orderId} awaiting proposer reveal ratio=${ratio}/${CROSS_J_MAX_FILL_RATIO}`);
  return { newState, outputs, accountTxs };
};

export const handleRequestCrossJurisdictionClearEntityTx = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: CrossJurisdictionClearTx,
  storageChanges: RuntimeOverlayRecord[] = [],
  mutableFrameState = false,
): CrossJurisdictionClearResult => {
  const { orderId, cancelRemainder = false } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];
  let route = newState.crossJurisdictionSwaps?.get(orderId);
  if (!route) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_ROUTE_MISSING", `CROSS_J_CLEAR_ROUTE_MISSING:${orderId}`);
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

  const context = { env, entityState, newState, outputs, accountTxs, orderId, cancelRemainder };
  const sourceUserResult = requestClearThroughSourceAccount(context, route);
  if (sourceUserResult) return sourceUserResult;

  const canonicalRoute: CrossJurisdictionSwapRoute = withCanonicalCrossJurisdictionRouteHash(route);
  if (!canonicalRoute.sourcePull || !canonicalRoute.targetPull) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_CORRUPT_ROUTE", `CROSS_J_CLEAR_CORRUPT_ROUTE: order=${orderId} pull commitments missing`);
  }

  const committedFill = getCrossJurisdictionCommittedFillAmounts(canonicalRoute);
  const ratio = committedFill.fillRatio;
  const accountId = findAccountKey(newState, canonicalRoute.source.entityId);
  const liveOfferResult = closeLiveSourceOffer(context, canonicalRoute, accountId, storageChanges);
  if (liveOfferResult) return liveOfferResult;
  if (ratio <= 0) return requestPureCancel(context, canonicalRoute, accountId);
  return requestFilledRouteReveal(context, canonicalRoute, accountId, ratio);
};

const validateClearMaterialization = (
  state: EntityState,
  entityTx: CrossJurisdictionClearMaterializationTx,
): Readonly<{
  route: CrossJurisdictionSwapRoute;
  accountId: string;
  fillRatio: number;
  proof: CrossJurisdictionClearMaterializationTx['data']['proof'];
}> => {
  const { orderId, binary, proof } = entityTx.data;
  const expectedProposer = normalizeEntityRef(state.config.validators[0] || '');
  const claimedProposer = normalizeEntityRef(entityTx.data.proposerSignerId);
  if (!expectedProposer || claimedProposer !== expectedProposer) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_MATERIALIZE_PROPOSER_INVALID", `CROSS_J_CLEAR_MATERIALIZE_PROPOSER_INVALID:${claimedProposer || 'missing'}:${expectedProposer || 'missing'}`);
  }
  const storedRoute = state.crossJurisdictionSwaps?.get(orderId);
  if (!storedRoute || storedRoute.status !== 'clear_requested') {
    throw haltRuntimeFailure("CROSS_J_CLEAR_MATERIALIZE_INTENT_MISSING", `CROSS_J_CLEAR_MATERIALIZE_INTENT_MISSING:${orderId}`);
  }
  const route = withCanonicalCrossJurisdictionRouteHash(storedRoute);
  if (!route.sourcePull || !route.targetPull) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_MATERIALIZE_PULLS_MISSING", `CROSS_J_CLEAR_MATERIALIZE_PULLS_MISSING:${orderId}`);
  }
  if (normalizeEntityRef(route.source.counterpartyEntityId) !== normalizeEntityRef(state.entityId)) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_MATERIALIZE_SOURCE_HUB_MISMATCH", `CROSS_J_CLEAR_MATERIALIZE_SOURCE_HUB_MISMATCH:${orderId}`);
  }
  const { fillRatio } = getCrossJurisdictionCommittedFillAmounts(route);
  if (fillRatio <= 0) throw haltRuntimeFailure("CROSS_J_CLEAR_MATERIALIZE_FILL_MISSING", `CROSS_J_CLEAR_MATERIALIZE_FILL_MISSING:${orderId}`);
  let decodedRatio: number;
  try {
    decodedRatio = verifyHashLadderBinary({
      fullHash: route.sourcePull.fullHash,
      partialRoot: route.sourcePull.partialRoot,
    }, binary).fillRatio;
  } catch (error) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_MATERIALIZE_BINARY_INVALID", `CROSS_J_CLEAR_MATERIALIZE_BINARY_INVALID:${orderId}:` +
        `${error instanceof Error ? error.message : String(error)}`);
  }
  if (decodedRatio !== fillRatio) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_MATERIALIZE_RATIO_MISMATCH", `CROSS_J_CLEAR_MATERIALIZE_RATIO_MISMATCH:${orderId}:${decodedRatio}:${fillRatio}`);
  }
  const expectedProof = buildCrossJurisdictionCloseProof(route, binary);
  if (!closeProofMatches(proof, expectedProof)) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_MATERIALIZE_PROOF_MISMATCH", `CROSS_J_CLEAR_MATERIALIZE_PROOF_MISMATCH:${orderId}`);
  }
  const accountId = findAccountKey(state, route.source.entityId);
  const account = accountId ? state.accounts.get(accountId) : undefined;
  if (!accountId || !account?.state.pulls?.has(route.sourcePull.pullId)) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_MATERIALIZE_SOURCE_PULL_MISSING", `CROSS_J_CLEAR_MATERIALIZE_SOURCE_PULL_MISSING:${orderId}`);
  }
  if (account.state.swapOffers?.has(orderId)) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_MATERIALIZE_OFFER_STILL_OPEN", `CROSS_J_CLEAR_MATERIALIZE_OFFER_STILL_OPEN:${orderId}`);
  }
  if (accountHasCrossPullCloseQueued(account, route.sourcePull.pullId)) {
    throw haltRuntimeFailure("CROSS_J_CLEAR_MATERIALIZE_ALREADY_QUEUED", `CROSS_J_CLEAR_MATERIALIZE_ALREADY_QUEUED:${orderId}`);
  }
  return { route, accountId, fillRatio, proof: expectedProof };
};

const buildSourceCloseAccountTxs = (
  route: CrossJurisdictionSwapRoute,
  accountId: string,
  binary: string,
  proof: CrossJurisdictionClearMaterializationTx['data']['proof'],
): AccountTxTarget[] => {
  const sourcePull = route.sourcePull;
  if (!sourcePull) throw haltRuntimeFailure("CROSS_J_CLEAR_SOURCE_PULL_MISSING", `CROSS_J_CLEAR_SOURCE_PULL_MISSING:${route.orderId}`);
  const accountTxs: AccountTxTarget[] = [{
    accountId,
    tx: {
      type: 'cross_pull_close',
      data: { pullId: sourcePull.pullId, binary, proof },
    },
  }];
  const sourceSavingsAmount = route.priceImprovementSourceAmount ?? 0n;
  if (sourceSavingsAmount <= 0n) return accountTxs;
  accountTxs.push({
    accountId,
    tx: {
      type: 'direct_payment',
      data: {
        tokenId: Number(route.source.tokenId),
        amount: sourceSavingsAmount,
        route: [route.source.entityId],
        deliveryMode: 'direct',
        description: `cross-j-source-savings:${route.orderId}`,
        fromEntityId: route.source.counterpartyEntityId,
        toEntityId: route.source.entityId,
      },
    },
  });
  return accountTxs;
};

/**
 * Apply only proposer-authored public reveal bytes. The private ladder seed is
 * deliberately absent from deterministic replay; every validator verifies the
 * exact binary and proof against the already-committed source pull hashes.
 */
export const handleMaterializeCrossJurisdictionClearEntityTx = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: CrossJurisdictionClearMaterializationTx,
  mutableFrameState = false,
): CrossJurisdictionClearResult => {
  const { orderId, binary } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const { route, accountId, fillRatio, proof } = validateClearMaterialization(newState, entityTx);
  const accountTxs = buildSourceCloseAccountTxs(route, accountId, binary, proof);
  const targetPull = route.targetPull;
  if (!targetPull) throw haltRuntimeFailure("CROSS_J_CLEAR_TARGET_PULL_MISSING", `CROSS_J_CLEAR_TARGET_PULL_MISSING:${orderId}`);
  const targetCommandRoute = cloneCrossJurisdictionRoute(route);
  targetCommandRoute.sourceCloseProof = cloneCrossJurisdictionCloseProof(proof);
  transitionCrossJurisdictionRouteStatus(
    targetCommandRoute,
    'clearing',
    deterministicEntityTimestamp(newState, env),
  );
  pushCrossJurisdictionEntityOutput(
    outputs,
    route.target.entityId,
    [{
      type: 'crossPullClose',
      data: {
        counterpartyEntityId: route.target.counterpartyEntityId,
        pullId: targetPull.pullId,
        binary,
        proof,
        route: targetCommandRoute,
        description: `Cross-j ${route.orderId} paired target close ${fillRatio}/${CROSS_J_MAX_FILL_RATIO}`,
      },
    }],
    route.targetHubSignerId,
  );
  route.sourceCloseProof = cloneCrossJurisdictionCloseProof(proof);
  transitionCrossJurisdictionRouteStatus(route, 'clearing', deterministicEntityTimestamp(newState, env));
  newState.crossJurisdictionSwaps?.set(orderId, route);
  const firstValidator = entityState.config.validators[0];
  if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
  addMessage(
    newState,
    `🌉 Cross-j clear ${orderId} queued atomic Hub source+target close ratio=${fillRatio}/${CROSS_J_MAX_FILL_RATIO}`,
  );
  return { newState, outputs, accountTxs };
};
