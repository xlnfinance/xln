import type { AccountState, AccountTx, EntityInput, EntityState, EntityTx, RuntimeState } from '../../../types';
import { prepareEntityTxState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import {
  cloneCrossJurisdictionRoute,
  isCrossJurisdictionRouteExpired,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j/index';
import type { AccountTxTarget } from './account';
import {
  mergeCrossJurisdictionRoute,
  validateCrossJurisdictionRouteTransition,
} from '../cross-jurisdiction-helpers';
import type { ApplyEntityTxOptions } from '../apply';

type SwapRequestResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
};

const deterministicEntityTimestamp = (state: EntityState, env: RuntimeState): number =>
  Number(state.timestamp || env.timestamp || 0);

const stateForEntityTx = (entityState: EntityState, options?: ApplyEntityTxOptions): EntityState =>
  prepareEntityTxState(entityState, options?.mutableFrameState);

const wakeEntity = (state: EntityState, outputs: EntityInput[]): void => {
  const firstValidator = state.config.validators[0];
  if (firstValidator) {
    outputs.push({ entityId: state.entityId, signerId: firstValidator, entityTxs: [] });
  }
};

const requireSwapAccount = (
  state: EntityState,
  counterpartyEntityId: string,
  action: string,
): AccountState => {
  const account = state.accounts.get(counterpartyEntityId);
  if (!account) {
    throw new Error(
      `SWAP_REQUEST_ACCOUNT_MISSING:${action}:entity=${state.entityId}:counterparty=${counterpartyEntityId}`,
    );
  }
  return account;
};

export const handlePlaceSwapOfferRequest = (
  env: RuntimeState,
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'placeSwapOffer' }>,
  options?: ApplyEntityTxOptions,
): SwapRequestResult => {
  const newState = stateForEntityTx(entityState, options);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];
  const { counterpartyEntityId, offerId, giveTokenId, giveAmount, wantTokenId, wantAmount, priceTicks, timeInForce, crossJurisdiction } =
    entityTx.data;

  requireSwapAccount(newState, counterpartyEntityId, 'placeSwapOffer');
  const publicCrossJurisdiction = crossJurisdiction
    ? cloneCrossJurisdictionRoute(withCanonicalCrossJurisdictionRouteHash(crossJurisdiction))
    : undefined;
  if (publicCrossJurisdiction) {
    const route = publicCrossJurisdiction;
    if (route.makerEntityId.toLowerCase() !== newState.entityId.toLowerCase()) {
      throw new Error(
        `CROSS_J_SWAP_MAKER_NOT_PROPOSER: maker=${route.makerEntityId} proposer=${newState.entityId}`,
      );
    }
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
      ...(publicCrossJurisdiction ? { crossJurisdiction: publicCrossJurisdiction } : {}),
    },
  };

  accountTxs.push({ accountId: counterpartyEntityId, tx: accountTx });
  wakeEntity(entityState, outputs);

  return { newState, outputs, accountTxs };
};

export const handleResolveSwapRequest = (
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'resolveSwap' }>,
  options?: ApplyEntityTxOptions,
): SwapRequestResult => {
  const newState = stateForEntityTx(entityState, options);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];
  const {
    counterpartyEntityId,
    offerId,
    fillRatio,
    fillNumerator,
    fillDenominator,
    cancelRemainder,
    comment,
    feeTokenId,
    feeAmount,
    executionGiveAmount,
    executionWantAmount,
  } = entityTx.data;

  const account = requireSwapAccount(newState, counterpartyEntityId, 'resolveSwap');
  if (account.swapOffers.get(offerId)?.crossJurisdiction) {
    addMessage(newState, `❌ Cross-j offer ${offerId} cannot be resolved through plain swap_resolve`);
    return { newState, outputs, accountTxs };
  }

  const accountTx: AccountTx = {
    type: 'swap_resolve',
    data: {
      offerId,
      fillRatio,
      ...(fillNumerator !== undefined ? { fillNumerator } : {}),
      ...(fillDenominator !== undefined ? { fillDenominator } : {}),
      cancelRemainder: cancelRemainder || fillRatio <= 0,
      ...(comment !== undefined
        ? { comment }
        : fillRatio <= 0
          ? { comment: 'zero_fill_cancel' }
          : {}),
      ...(feeTokenId !== undefined ? { feeTokenId } : {}),
      ...(feeAmount !== undefined ? { feeAmount } : {}),
      ...(executionGiveAmount !== undefined ? { executionGiveAmount } : {}),
      ...(executionWantAmount !== undefined ? { executionWantAmount } : {}),
    },
  };

  accountTxs.push({ accountId: counterpartyEntityId, tx: accountTx });
  wakeEntity(entityState, outputs);

  return { newState, outputs, accountTxs };
};

export const handleCancelSwapRequest = (
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'proposeCancelSwap' }>,
  options?: ApplyEntityTxOptions,
): SwapRequestResult => {
  const newState = stateForEntityTx(entityState, options);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];
  const { counterpartyEntityId, offerId } = entityTx.data;

  requireSwapAccount(newState, counterpartyEntityId, 'proposeCancelSwap');

  accountTxs.push({
    accountId: counterpartyEntityId,
    tx: {
      type: 'swap_cancel_request',
      data: { offerId },
    },
  });
  wakeEntity(entityState, outputs);

  return { newState, outputs, accountTxs };
};
