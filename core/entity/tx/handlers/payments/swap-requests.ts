import type { AccountState, AccountTx } from '../../../../types/account';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import type { AccountTxTarget } from '../account';
import type { ApplyEntityTxOptions } from '../../apply';
import { haltRuntimeFailure } from '../../../../protocol/errors/failure-taxonomy';

type SwapRequestResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
};

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
    throw haltRuntimeFailure(
      'SWAP_REQUEST_ACCOUNT_MISSING',
      `SWAP_REQUEST_ACCOUNT_MISSING:${action}:entity=${state.entityId}:counterparty=${counterpartyEntityId}`,
    );
  }
  return account.state;
};

export const handlePlaceSwapOfferRequest = (
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'placeSwapOffer' }>,
  options?: ApplyEntityTxOptions,
): SwapRequestResult => {
  const newState = stateForEntityTx(entityState, options);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];
  const { counterpartyEntityId, offerId, giveTokenId, giveTokenDecimals, giveAmount, wantTokenId, wantTokenDecimals, wantAmount, maxFee, minNetReceive, priceTicks, timeInForce } =
    entityTx.data;

  requireSwapAccount(newState, counterpartyEntityId, 'placeSwapOffer');

  const accountTx: AccountTx = {
    type: 'swap_offer',
    data: {
      offerId,
      giveTokenId,
      giveTokenDecimals,
      giveAmount,
      wantTokenId,
      wantTokenDecimals,
      wantAmount,
      maxFee,
      minNetReceive,
      ...(priceTicks !== undefined ? { priceTicks } : {}),
      ...(timeInForce !== undefined ? { timeInForce } : {}),
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
