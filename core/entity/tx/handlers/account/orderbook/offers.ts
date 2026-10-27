import { haltRuntimeFailure } from '../../../../../protocol/errors/failure-taxonomy';
import type { AccountState } from '../../../../../types/account';
import type { SwapCancelEvent, SwapCancelRequestEvent, SwapOfferEvent } from '../../../../../account/tx/apply-types';
import type { BookState } from '../../../../../swapbook';
import type { CrossJurisdictionFillInstruction } from '../../../../../extensions/cross-j/orderbook';
import type { AccountTxTarget } from './queue';

export const resolveStoredOfferEntityRefs = (
  account: AccountState,
): { fromEntity: string; toEntity: string } => {
  if (!account.leftEntity || !account.rightEntity) {
    throw haltRuntimeFailure('ORDERBOOK_ACCOUNT_ENDPOINTS_MISSING');
  }
  return {
    fromEntity: account.leftEntity,
    toEntity: account.rightEntity,
  };
};

export type { SwapCancelEvent, SwapCancelRequestEvent, SwapOfferEvent };

export interface MatchResult {
  accountTxs: AccountTxTarget[];
  crossJurisdictionFills: CrossJurisdictionFillInstruction[];
  bookUpdates: {
    pairId: string;
    book: BookState;
  }[];
}
