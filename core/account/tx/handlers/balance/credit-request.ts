import type { AccountTx } from '../../../../types/account';
import type { AccountDraftReplica } from '../../../state/account-state-draft';
import type { ApplyAccountTxResult } from '../../apply-types';
import { accountTxApplied } from '../../apply-result';
import { consumeIntent } from './lending';

const CREDIT_REQUEST_ID_RE = /^credit-[0-9a-f]{16}$/;

/**
 * `credit_request`: the proposer asks its counterparty to extend credit to it.
 *
 * - Signer/authority: the frame proposer (`byLeft`, bound by the frame Hanko)
 *   is the only party that may name itself as requester. A forged requester
 *   (the counterparty or any third entity) throws before any state write.
 * - Nonce: `credit:<requestId>` in the shared Account intent ledger. A replay
 *   of the same id — even with a different amount — throws, so one signed
 *   request can trigger at most one counterparty answer.
 * - Old/new state: only that intent entry is added; deltas are untouched. The
 *   credit line moves only when the counterparty later proposes its own
 *   `set_credit_limit` (see the committed hub follow-up).
 * - Counterexample: a wallet re-submitting `credit-0000000000000001` after the
 *   hub answered would otherwise re-raise a line the hub has since lowered.
 */
export const handleCreditRequest = (
  account: AccountDraftReplica,
  tx: Extract<AccountTx, { type: 'credit_request' }>,
  byLeft: boolean,
): ApplyAccountTxResult => {
  const { requestId, requesterEntityId, tokenId, amount } = tx.data;
  if (!CREDIT_REQUEST_ID_RE.test(requestId)) {
    throw new Error(`CREDIT_REQUEST_ID_INVALID:${requestId}`);
  }
  const proposer = (byLeft ? account.state.leftEntity : account.state.rightEntity).toLowerCase();
  if (requesterEntityId !== proposer) {
    throw new Error(`CREDIT_REQUEST_REQUESTER_NOT_PROPOSER: claimed=${requesterEntityId} proposer=${proposer}`);
  }
  if (amount <= 0n) throw new Error('CREDIT_REQUEST_AMOUNT_MUST_BE_POSITIVE');
  if (!account.state.deltas.has(tokenId)) {
    throw new Error(`CREDIT_REQUEST_TOKEN_NOT_ENABLED:${tokenId}`);
  }
  consumeIntent(account, `credit:${requestId}`, 'credit-request');
  return accountTxApplied([`Credit request ${requestId} committed`]);
};
