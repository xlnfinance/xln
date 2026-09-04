/**
 * Set Credit Limit Handler
 * Channel.ts pattern: proposer sets the counterparty's credit grant.
 * A lower grant applies prospectively; deriveDelta preserves already-drawn
 * exposure so revocation cannot erase a receivable or block cure/netting.
 * Uses byLeft (frame property, same on both sides) — NOT perspective-dependent.
 */

import type { AccountTx } from '../../../../types/account';
import type { AccountDraftState } from '../../../state/account-state-draft';
import { AccountDeltaError } from '../../../state/delta';
import { FINANCIAL } from '../../../../config/constants';
import { commitDeltaDraft, createDeltaDraft } from '../../delta-utils';
import type { ApplyAccountTxResult } from '../../apply-types';
import {
  accountTxApplied,
  accountTxRejected,
  accountTxValidationRejected,
  rejectionFromDeltaError,
} from '../../apply-result';

export function handleSetCreditLimit(
  account: AccountDraftState,
  accountTx: Extract<AccountTx, { type: 'set_credit_limit' }>,
  byLeft: boolean
): ApplyAccountTxResult {
  const { tokenId, amount } = accountTx.data;
  const events: string[] = [];

  if (amount < 0n) {
    return accountTxValidationRejected(`Credit limit cannot be negative: ${amount}`, events);
  }
  if (amount > FINANCIAL.MAX_CREDIT_LIMIT) {
    return accountTxValidationRejected(
      `Credit limit exceeds maximum: ${amount} > ${FINANCIAL.MAX_CREDIT_LIMIT}`,
      events,
    );
  }

  // Channel.ts pattern (Transition.ts:358-362):
  //   if (!block.isLeft) { delta.leftCreditLimit = amount; }  // RIGHT proposer → sets LEFT limit
  //   else { delta.rightCreditLimit = amount; }                // LEFT proposer → sets RIGHT limit
  // Proposer extends credit → set counterparty's credit limit field
  const side = byLeft ? 'right' : 'left';

  const deltaExisted = account.deltas.has(tokenId);
  let delta: ReturnType<typeof createDeltaDraft>;
  try {
    delta = createDeltaDraft(account, tokenId);
  } catch (error) {
    if (!(error instanceof AccountDeltaError)) throw error;
    return accountTxRejected(rejectionFromDeltaError(error, tokenId), [error.message]);
  }
  if (!deltaExisted) {
    events.push(`📊 Created delta for token ${tokenId}`);
  }

  if (side === 'left') {
    delta.leftCreditLimit = amount;
    events.push(`💳 Left credit limit = ${amount.toString()} for token ${tokenId}`);
  } else {
    delta.rightCreditLimit = amount;
    events.push(`💳 Right credit limit = ${amount.toString()} for token ${tokenId}`);
  }
  commitDeltaDraft(account, delta);

  return accountTxApplied(events);
}
