/**
 * Swap-offer Account transition.
 *
 * The coordinator keeps the financial order visible:
 * admission → deterministic quantization → cross-J lock binding → commit.
 */

import type { AccountTx } from '../../../../../types/account';
import type { AccountDraftReplica } from '../../../../state/account-state-draft';
import type { ApplyAccountTxResult } from '../../../apply-types';
import { accountTxValidationRejected } from '../../../apply-result';
import { validateSwapOfferAdmission } from './admission';
import { prepareSwapOfferAmounts } from './quantization';
import { validateCrossJurisdictionSourceBinding } from './cross-j-binding';
import { commitSwapOffer } from './commit';

export const handleSwapOffer = async (
  account: AccountDraftReplica,
  tx: Extract<AccountTx, { type: 'swap_offer' }>,
  byLeft: boolean,
  currentHeight: number,
  _isValidation = false,
): Promise<ApplyAccountTxResult> => {
  const admissionResult = validateSwapOfferAdmission(account.state, tx, byLeft);
  if (!admissionResult.ok) {
    return accountTxValidationRejected(admissionResult.message, []);
  }
  const amountResult = prepareSwapOfferAmounts(tx);
  if (!amountResult.ok) {
    return accountTxValidationRejected(amountResult.message, []);
  }
  const bindingError = validateCrossJurisdictionSourceBinding(account.state, tx);
  if (bindingError) {
    return accountTxValidationRejected(bindingError, []);
  }
  return commitSwapOffer(account, tx, admissionResult.admission, amountResult.prepared, currentHeight);
};
