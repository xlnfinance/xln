import type { AccountTx } from '../../../../types/account';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import { getCreditRequestCapForToken } from '../../../../account/config/defaults';
import { deriveDelta } from '../../../../account/utils';
import type { AccountTxTarget } from './orderbook/queue';

const CREDIT_REQUEST_ID_RE = /^credit-[0-9a-f]{16}$/;

const normalized = (value: unknown): string => String(value || '').trim().toLowerCase();

type CreditRequestResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs: AccountTxTarget[];
};

const processingTrigger = (state: EntityState): EntityInput[] => {
  const firstValidator = state.config.validators[0];
  return firstValidator
    ? [{ entityId: state.entityId, signerId: firstValidator, entityTxs: [] }]
    : [];
};

/**
 * Local admission of the requester's `credit_request`. The Account handler
 * owns the binding checks (requester = frame proposer, token lane, replay);
 * this only refuses work that can never commit.
 */
export const handleRequestCreditEntityTx = (
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'requestCredit' }>,
  mutableFrameState = false,
): CreditRequestResult => {
  const counterpartyId = normalized(entityTx.data.counterpartyEntityId);
  if (!counterpartyId || !entityState.accounts.has(counterpartyId)) {
    throw new Error(`CREDIT_REQUEST_ACCOUNT_MISSING:${counterpartyId || 'missing'}`);
  }
  const { requestId, tokenId, amount } = entityTx.data;
  if (!CREDIT_REQUEST_ID_RE.test(requestId)) throw new Error(`CREDIT_REQUEST_ID_INVALID:${requestId}`);
  if (amount <= 0n) throw new Error('CREDIT_REQUEST_AMOUNT_MUST_BE_POSITIVE');
  const tx: AccountTx = {
    type: 'credit_request',
    data: { requestId, requesterEntityId: normalized(entityState.entityId), tokenId, amount },
  };
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  addMessage(newState, `Credit requested: ${amount} token=${tokenId}`);
  return {
    newState,
    outputs: processingTrigger(entityState),
    accountTxs: [{ accountId: counterpartyId, tx }],
  };
};

/**
 * Hub answer to a committed counterparty `credit_request`.
 *
 * Authority: only a hub (`profile.isHub`) answers, and only a request the
 * counterparty proposed; the hub's own request to a peer hub is answered by
 * that peer. The answer is the hub's own `set_credit_limit` raising its line
 * to `max(projected line, min(requested, cap))`: it never lowers a larger
 * existing grant, and a replayed request cannot reach here (Account intent
 * ledger). A token without canonical metadata has no cap and gets no grant.
 */
export function applyCommittedCreditRequestFollowup(
  state: EntityState,
  counterpartyIdRaw: string,
  tx: AccountTx,
  proposerIsLeft: boolean,
  accountTxs: AccountTxTarget[],
): void {
  if (tx.type !== 'credit_request' || state.profile?.isHub !== true) return;
  const counterpartyId = normalized(counterpartyIdRaw);
  const account = state.accounts.get(counterpartyId);
  if (!account) throw new Error(`CREDIT_REQUEST_ACCOUNT_MISSING:${counterpartyIdRaw}`);
  const proposer = normalized(proposerIsLeft ? account.state.leftEntity : account.state.rightEntity);
  if (proposer !== counterpartyId) return;
  const cap = getCreditRequestCapForToken(tx.data.tokenId);
  if (cap === undefined) return;
  const target = tx.data.amount < cap ? tx.data.amount : cap;
  const delta = account.state.deltas.get(tx.data.tokenId);
  if (!delta) throw new Error('CREDIT_REQUEST_TOKEN_NOT_ENABLED:' + tx.data.tokenId);
  let current = deriveDelta(delta, account.state.leftEntity === state.entityId).peerCreditLimit;
  const include = (tx: AccountTx): void => {
    if (tx.type === 'set_credit_limit' && tx.data.tokenId === delta.tokenId) current = tx.data.amount;
  };
  const ownerIsLeft = account.state.leftEntity === state.entityId;
  if (account.pendingFrame && (account.proofHeader.fromEntity === account.state.leftEntity) === ownerIsLeft) {
    account.pendingFrame.accountTxs.forEach(include);
  }
  account.mempool.forEach(include);
  for (const queued of accountTxs) {
    if (queued.accountId === counterpartyId && queued.tx.type === 'set_credit_limit' && queued.tx.data.tokenId === tx.data.tokenId) {
      current = queued.tx.data.amount;
    }
  }
  if (current >= target) return;
  accountTxs.push({
    accountId: counterpartyId,
    tx: { type: 'set_credit_limit', data: { tokenId: tx.data.tokenId, amount: target } },
  });
}
