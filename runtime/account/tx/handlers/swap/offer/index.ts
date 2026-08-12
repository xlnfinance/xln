/**
 * Swap-offer Account transition.
 *
 * The coordinator keeps the financial order visible:
 * admission → deterministic quantization → cross-J lock binding → commit.
 */

import type { AccountReplica, AccountTx } from '../../../../../types/account';
import type { SwapOfferEvent } from '../../../apply-types';
import { validateSwapOfferAdmission } from './admission';
import { prepareSwapOfferAmounts } from './quantization';
import { validateCrossJurisdictionSourceBinding } from './cross-j-binding';
import { commitSwapOffer } from './commit';

type SwapOfferResult = {
  success: boolean;
  events: string[];
  error?: string;
  swapOfferCreated?: SwapOfferEvent;
};

export const handleSwapOffer = async (
  account: AccountReplica,
  tx: Extract<AccountTx, { type: 'swap_offer' }>,
  byLeft: boolean,
  currentHeight: number,
  _isValidation = false,
): Promise<SwapOfferResult> => {
  // Preserve the canonical empty map even when admission rejects. Both Account
  // frame validation and commit execute this same transition.
  account.state.swapOffers ??= new Map();
  const admissionResult = validateSwapOfferAdmission(account.state, tx, byLeft);
  if (!admissionResult.admission) {
    return { success: false, error: admissionResult.error!, events: [] };
  }
  const amountResult = prepareSwapOfferAmounts(tx);
  if (!amountResult.prepared) {
    return { success: false, error: amountResult.error!, events: [] };
  }
  const bindingError = validateCrossJurisdictionSourceBinding(account.state, tx);
  if (bindingError) {
    return { success: false, error: bindingError, events: [] };
  }
  return commitSwapOffer(account, tx, admissionResult.admission, amountResult.prepared, currentHeight);
};
