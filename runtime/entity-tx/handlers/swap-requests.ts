import type { AccountTx, EntityInput, EntityState, EntityTx, Env } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import {
  cloneCrossJurisdictionRoute,
  isCrossJurisdictionRouteExpired,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../cross-jurisdiction';
import type { MempoolOp } from './account';
import {
  mergeCrossJurisdictionRoute,
  validateCrossJurisdictionRouteTransition,
} from '../cross-jurisdiction-helpers';

type SwapRequestResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

const deterministicEntityTimestamp = (state: EntityState, env: Env): number =>
  Number(state.timestamp || env.timestamp || 0);

const wakeEntity = (state: EntityState, outputs: EntityInput[]): void => {
  const firstValidator = state.config.validators[0];
  if (firstValidator) {
    outputs.push({ entityId: state.entityId, signerId: firstValidator, entityTxs: [] });
  }
};

export const handlePlaceSwapOfferRequest = (
  env: Env,
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'placeSwapOffer' }>,
): SwapRequestResult => {
  console.log(
    `📊 PLACE-SWAP-OFFER: ${entityState.entityId.slice(-4)} placing offer with ${entityTx.data.counterpartyEntityId.slice(-4)}`,
  );

  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];
  const { counterpartyEntityId, offerId, giveTokenId, giveAmount, wantTokenId, wantAmount, priceTicks, timeInForce, minFillRatio, crossJurisdiction } =
    entityTx.data;

  const accountMachine = newState.accounts.get(counterpartyEntityId);
  if (!accountMachine) {
    console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for swap offer`);
    return { newState: entityState, outputs: [] };
  }
  const publicCrossJurisdiction = crossJurisdiction
    ? cloneCrossJurisdictionRoute(withCanonicalCrossJurisdictionRouteHash(crossJurisdiction))
    : undefined;
  if (publicCrossJurisdiction) {
    const route = publicCrossJurisdiction;
    const existing = newState.crossJurisdictionSwaps?.get(route.orderId);
    const transitionError = validateCrossJurisdictionRouteTransition(existing, route);
    if (transitionError || isCrossJurisdictionRouteExpired(route, deterministicEntityTimestamp(newState, env))) {
      addMessage(newState, `❌ Cross-j offer ${route.orderId} blocked: ${transitionError || 'expired'}`);
      return { newState, outputs: [] };
    }
    newState.crossJurisdictionSwaps ||= new Map();
    newState.crossJurisdictionSwaps.set(route.orderId, mergeCrossJurisdictionRoute(existing, route));
  }

  const accountTx: AccountTx = {
    type: 'swap_offer',
    data: {
      offerId,
      giveTokenId,
      giveAmount,
      wantTokenId,
      wantAmount,
      ...(priceTicks !== undefined ? { priceTicks } : {}),
      ...(timeInForce !== undefined ? { timeInForce } : {}),
      minFillRatio,
      ...(publicCrossJurisdiction ? { crossJurisdiction: publicCrossJurisdiction } : {}),
    },
  };

  mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });
  console.log(`📊 Added swap_offer to mempoolOps for account with ${counterpartyEntityId.slice(-4)}`);
  wakeEntity(entityState, outputs);

  return { newState, outputs, mempoolOps };
};

export const handleResolveSwapRequest = (
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'resolveSwap' }>,
): SwapRequestResult => {
  console.log(
    `💱 RESOLVE-SWAP: ${entityState.entityId.slice(-4)} resolving offer with ${entityTx.data.counterpartyEntityId.slice(-4)}`,
  );

  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];
  const {
    counterpartyEntityId,
    offerId,
    fillRatio,
    cancelRemainder,
    comment,
    feeTokenId,
    feeAmount,
    executionGiveAmount,
    executionWantAmount,
  } = entityTx.data;

  const accountMachine = newState.accounts.get(counterpartyEntityId);
  if (!accountMachine) {
    console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for swap resolve`);
    return { newState: entityState, outputs: [] };
  }
  if (accountMachine.swapOffers.get(offerId)?.crossJurisdiction) {
    addMessage(newState, `❌ Cross-j offer ${offerId} cannot be resolved through plain swap_resolve`);
    return { newState, outputs, mempoolOps };
  }

  const accountTx: AccountTx = {
    type: 'swap_resolve',
    data: {
      offerId,
      fillRatio,
      cancelRemainder,
      ...(comment !== undefined ? { comment } : {}),
      ...(feeTokenId !== undefined ? { feeTokenId } : {}),
      ...(feeAmount !== undefined ? { feeAmount } : {}),
      ...(executionGiveAmount !== undefined ? { executionGiveAmount } : {}),
      ...(executionWantAmount !== undefined ? { executionWantAmount } : {}),
    },
  };

  mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });
  console.log(`💱 Added swap_resolve to mempoolOps for account with ${counterpartyEntityId.slice(-4)}`);
  wakeEntity(entityState, outputs);

  return { newState, outputs, mempoolOps };
};

export const handleCancelSwapRequest = (
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'cancelSwapOffer' | 'cancelSwap' | 'proposeCancelSwap' }>,
): SwapRequestResult => {
  console.log(
    `📊 CANCEL-SWAP-REQUEST: ${entityState.entityId.slice(-4)} requesting cancel with ${entityTx.data.counterpartyEntityId.slice(-4)}`,
  );

  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];
  const { counterpartyEntityId, offerId } = entityTx.data;

  const accountMachine = newState.accounts.get(counterpartyEntityId);
  if (!accountMachine) {
    console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for swap cancel`);
    return { newState: entityState, outputs: [] };
  }

  mempoolOps.push({
    accountId: counterpartyEntityId,
    tx: {
      type: 'swap_cancel_request',
      data: { offerId },
    },
  });
  console.log(`📊 Added swap_cancel_request to mempoolOps for account with ${counterpartyEntityId.slice(-4)}`);
  wakeEntity(entityState, outputs);

  return { newState, outputs, mempoolOps };
};
