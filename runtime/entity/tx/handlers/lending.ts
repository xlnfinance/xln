import type { AccountTx, EntityInput, EntityState, EntityTx } from '../../../types';
import { normalizeInterestBps, normalizeLendingTerm } from '../../../extensions/lending';
import { addMessage, cloneEntityState } from '../../../state-helpers';
import type { MempoolOp } from './account';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

type LendingResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

const INTENT_ID_RE = /^(?:lend|borrow|loan)-[0-9a-f]{16}$/;

const normalized = (value: unknown): string => String(value || '').trim().toLowerCase();

const processingTrigger = (state: EntityState): EntityInput[] => {
  const firstValidator = state.config.validators[0];
  return firstValidator
    ? [{ entityId: state.entityId, signerId: firstValidator, entityTxs: [] }]
    : [];
};

const requireIntentId = (value: string, prefix: 'lend' | 'borrow' | 'loan'): void => {
  const id = normalized(value);
  if (!INTENT_ID_RE.test(id) || !id.startsWith(`${prefix}-`)) {
    throw new Error(`LENDING_INTENT_ID_INVALID:${value}`);
  }
};

const requirePositiveAmount = (amount: bigint, context: string): void => {
  if (amount <= 0n) throw new Error(`${context}_AMOUNT_MUST_BE_POSITIVE`);
};

const requireHubAccount = (state: EntityState, hubEntityId: string): string => {
  const hub = normalized(hubEntityId);
  if (!hub || !state.accounts.has(hub)) {
    throw new Error(`LENDING_HUB_ACCOUNT_MISSING:${hub || 'missing'}`);
  }
  return hub;
};

const queueAccountTx = (
  state: EntityState,
  hubEntityId: string,
  tx: AccountTx,
  message: string,
): LendingResult => {
  const newState = cloneEntityState(state);
  addMessage(newState, message);
  return {
    newState,
    outputs: processingTrigger(state),
    mempoolOps: [{ accountId: hubEntityId, tx }],
  };
};

export const handleLendingOfferEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'lendingOffer'>,
): LendingResult => {
  const hubEntityId = requireHubAccount(entityState, entityTx.data.hubEntityId);
  requireIntentId(entityTx.data.positionId, 'lend');
  requirePositiveAmount(entityTx.data.amount, 'LENDING_FUND');
  const termId = normalizeLendingTerm(entityTx.data.termId);
  const interestBps = normalizeInterestBps(entityTx.data.interestBps);
  const account = entityState.accounts.get(hubEntityId)!;
  if (!account.deltas.has(entityTx.data.tokenId)) {
    throw new Error(`LENDING_TOKEN_NOT_ENABLED:${entityTx.data.tokenId}`);
  }
  return queueAccountTx(entityState, hubEntityId, {
    type: 'lending_fund',
    data: {
      positionId: normalized(entityTx.data.positionId),
      hubEntityId,
      lenderEntityId: normalized(entityState.entityId),
      tokenId: entityTx.data.tokenId,
      amount: entityTx.data.amount,
      termId,
      interestBps,
    },
  }, `Lending pool funding requested: ${entityTx.data.amount} token=${entityTx.data.tokenId}`);
};

export const handleLendingBorrowEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'lendingBorrow'>,
): LendingResult => {
  const hubEntityId = requireHubAccount(entityState, entityTx.data.hubEntityId);
  requireIntentId(entityTx.data.requestId, 'borrow');
  requirePositiveAmount(entityTx.data.amount, 'LENDING_BORROW');
  const termId = normalizeLendingTerm(entityTx.data.termId);
  const maxInterestBps = normalizeInterestBps(entityTx.data.maxInterestBps ?? 10_000);
  return queueAccountTx(entityState, hubEntityId, {
    type: 'lending_borrow_request',
    data: {
      requestId: normalized(entityTx.data.requestId),
      hubEntityId,
      borrowerEntityId: normalized(entityState.entityId),
      tokenId: entityTx.data.tokenId,
      amount: entityTx.data.amount,
      termId,
      maxInterestBps,
    },
  }, `Loan requested: ${entityTx.data.amount} token=${entityTx.data.tokenId}`);
};

export const handleLendingRepayEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'lendingRepay'>,
): LendingResult => {
  const hubEntityId = requireHubAccount(entityState, entityTx.data.hubEntityId);
  requireIntentId(entityTx.data.loanId, 'loan');
  requirePositiveAmount(entityTx.data.amount, 'LENDING_REPAY');
  return queueAccountTx(entityState, hubEntityId, {
    type: 'lending_repay',
    data: {
      loanId: normalized(entityTx.data.loanId),
      hubEntityId,
      borrowerEntityId: normalized(entityState.entityId),
      tokenId: entityTx.data.tokenId,
      amount: entityTx.data.amount,
    },
  }, `Loan repayment requested: ${entityTx.data.loanId}`);
};

export const handleLendingClosePositionEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'lendingClosePosition'>,
): LendingResult => {
  const hubEntityId = requireHubAccount(entityState, entityTx.data.hubEntityId);
  requireIntentId(entityTx.data.positionId, 'lend');
  return queueAccountTx(entityState, hubEntityId, {
    type: 'lending_close_request',
    data: {
      positionId: normalized(entityTx.data.positionId),
      hubEntityId,
      lenderEntityId: normalized(entityState.entityId),
    },
  }, `Lending position close requested: ${entityTx.data.positionId}`);
};
