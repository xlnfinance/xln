import type {
  AccountMachine,
  AccountTx,
  CrossJurisdictionSwapRoute,
} from '../../../types';
import type { SwapOfferEvent } from '../../../entity/tx/handlers/account';

export type CrossSwapFillAckTx = Extract<
  AccountTx,
  { type: 'cross_swap_fill_ack' }
>;
export type CrossSwapOffer = NonNullable<AccountMachine['swapOffers']> extends Map<
  string,
  infer Offer
>
  ? Offer
  : never;

export type CrossSwapFillAckResult = {
  success: boolean;
  events: string[];
  error?: string;
  swapOfferCreated?: SwapOfferEvent;
  swapOfferCancelled?: { offerId: string; accountId: string };
};

export type PreparedCrossSwapFillAck = {
  account: AccountMachine;
  tx: CrossSwapFillAckTx;
  offer: CrossSwapOffer;
  route: CrossJurisdictionSwapRoute;
  events: string[];
  currentRatio: number;
  currentFillSeq: number;
};

export type CrossSwapFillAckAdmission =
  | { ok: true; prepared: PreparedCrossSwapFillAck }
  | { ok: false; result: CrossSwapFillAckResult };
