import type {
  AccountInput,
  EntityCandidateEffect,
  EntityInput,
  EntityState,
} from '../../../../types';
import type { AccountJClaimNodeChanges } from '../../../../types/account-j-claims';
import type { MempoolOp } from './orderbook-queue';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './orderbook-offers';
import type { CommittedAccountEffects } from './committed-input';

export interface AccountHandlerResult {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps: MempoolOp[];
  swapOffersCreated: SwapOfferEvent[];
  swapCancelRequests: SwapCancelRequestEvent[];
  swapOffersCancelled: SwapCancelEvent[];
  /** Exact consensus response that the final Entity flush must preserve. */
  requiredAccountResponse?: AccountInput;
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
  requiredAccountResponse?: AccountInput,
  accountJClaimNodeChanges?: AccountJClaimNodeChanges,
): AccountHandlerResult => ({
  newState,
  outputs: effects.outputs,
  mempoolOps: effects.mempoolOps,
  swapOffersCreated: effects.swapOffersCreated,
  swapCancelRequests: effects.swapCancelRequests,
  swapOffersCancelled: effects.swapOffersCancelled,
  candidateEffects: effects.candidateEffects,
  ...(requiredAccountResponse ? { requiredAccountResponse } : {}),
  ...(effects.hashesToSign.length > 0 ? { hashesToSign: effects.hashesToSign } : {}),
  ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
});
