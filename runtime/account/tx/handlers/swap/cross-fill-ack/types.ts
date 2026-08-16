import type { AccountTx, SwapOffer } from '../../../../../types/account';
import type { AccountDraftReplica } from '../../../../state/account-state-draft';
import type { CrossJurisdictionSwapRoute } from '../../../../../types/cross-jurisdiction';
import type { ApplyAccountTxResult } from '../../../apply-types';

export type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;

export type CrossSwapFillAckResult = ApplyAccountTxResult;

export type PreparedCrossSwapFillAck = {
  account: AccountDraftReplica;
  tx: CrossSwapFillAckTx;
  offer: SwapOffer;
  route: CrossJurisdictionSwapRoute;
  events: string[];
  currentRatio: number;
  currentFillSeq: number;
};

export type CrossSwapFillAckAdmission =
  { ok: true; prepared: PreparedCrossSwapFillAck } | { ok: false; result: CrossSwapFillAckResult };
