import type { AccountReplica, AccountTx } from '../../../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../../../types/cross-jurisdiction';
import type { ApplyAccountTxResult } from '../../../apply-types';

export type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;
type CrossSwapOffer = NonNullable<AccountReplica['state']['swapOffers']> extends Map<string, infer Offer> ? Offer : never;

export type CrossSwapFillAckResult = ApplyAccountTxResult;

export type PreparedCrossSwapFillAck = {
  account: AccountReplica;
  tx: CrossSwapFillAckTx;
  offer: CrossSwapOffer;
  route: CrossJurisdictionSwapRoute;
  events: string[];
  currentRatio: number;
  currentFillSeq: number;
};

export type CrossSwapFillAckAdmission =
  { ok: true; prepared: PreparedCrossSwapFillAck } | { ok: false; result: CrossSwapFillAckResult };
