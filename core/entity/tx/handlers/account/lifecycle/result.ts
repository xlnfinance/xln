import type { EntityCandidateEffect, EntityInput, EntityState } from '../../../../types';
import type { AccountJClaimNodeChanges } from '../../../../../types/finance/account-j-claims';
import type { AccountTxTarget } from '../orderbook/queue';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from '../orderbook/offers';
import type { CommittedAccountEffects } from '../committed-input';

export interface AccountHandlerResult {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs: AccountTxTarget[];
  swapOffersCreated: SwapOfferEvent[];
  swapCancelRequests: SwapCancelRequestEvent[];
  swapOffersCancelled: SwapCancelEvent[];
  /** Channel.ts-style forced final flush after accepting/replaying a peer frame. */
  forceAccountFlush?: boolean;
  /** Hashes that still require the Entity validator quorum. */
  hashesToSign?: Array<{
    hash: string;
    type: 'accountFrame' | 'dispute' | 'settlement';
    context: string;
  }>;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  candidateEffects: EntityCandidateEffect[];
}

export const buildAccountHandlerResult = (
  newState: EntityState,
  effects: CommittedAccountEffects,
  forceAccountFlush?: boolean,
  accountJClaimNodeChanges?: AccountJClaimNodeChanges,
): AccountHandlerResult => ({
  newState,
  outputs: effects.outputs,
  accountTxs: effects.accountTxs,
  swapOffersCreated: effects.swapOffersCreated,
  swapCancelRequests: effects.swapCancelRequests,
  swapOffersCancelled: effects.swapOffersCancelled,
  candidateEffects: effects.candidateEffects,
  ...(forceAccountFlush === undefined ? {} : { forceAccountFlush }),
  ...(effects.hashesToSign.length > 0 ? { hashesToSign: effects.hashesToSign } : {}),
  ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
});
