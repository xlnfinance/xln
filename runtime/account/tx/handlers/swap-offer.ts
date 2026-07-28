/**
 * Swap-offer Account transition.
 *
 * The coordinator keeps the financial order visible:
 * admission → deterministic quantization → cross-J lock binding → commit.
 */

import type {
  AccountState,
  AccountTx,
} from '../../../types';
import type { SwapOfferEvent } from '../../../entity/tx/handlers/account';
import { validateSwapOfferAdmission } from './swap-offer/admission';
import { prepareSwapOfferAmounts } from './swap-offer/quantization';
import { validateCrossJurisdictionSourceBinding } from './swap-offer/cross-j-binding';
import { commitSwapOffer } from './swap-offer/commit';

type SwapOfferResult = {
  success: boolean;
  events: string[];
  error?: string;
  swapOfferCreated?: SwapOfferEvent;
};

export const handleSwapOffer = async (
  account: AccountState,
  tx: Extract<AccountTx, { type: 'swap_offer' }>,
  byLeft: boolean,
  currentHeight: number,
  _isValidation = false,
): Promise<SwapOfferResult> => {
  // Preserve the canonical empty map even when admission rejects. Both Account
  // frame validation and commit execute this same transition.
  account.swapOffers ??= new Map();
  const admissionResult = validateSwapOfferAdmission(account, tx, byLeft);
  if (!admissionResult.admission) {
    return { success: false, error: admissionResult.error!, events: [] };
  }
  const amountResult = prepareSwapOfferAmounts(tx);
  if (!amountResult.prepared) {
    return { success: false, error: amountResult.error!, events: [] };
  }
  const bindingError = validateCrossJurisdictionSourceBinding(account, tx);
  if (bindingError) {
    return { success: false, error: bindingError, events: [] };
  }
  return commitSwapOffer(
    account,
    tx,
    admissionResult.admission,
    amountResult.prepared,
    currentHeight,
  );
};
