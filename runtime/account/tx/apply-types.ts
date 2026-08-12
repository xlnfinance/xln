import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { AccountOutput, AccountTx } from '../../types/account';

// Account transitions own these outputs. Entity consumes them to update its
// orderbook projection, but must not redefine the financial result shape.
export interface SwapOfferEvent {
  offerId: string;
  makerIsLeft: boolean;
  fromEntity: string;
  toEntity: string;
  accountId?: string;
  createdHeight?: number;
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  maxFee: bigint;
  minNetReceive: bigint;
  priceTicks?: bigint | undefined;
  timeInForce?: 0 | 1 | 2 | undefined;
  crossJurisdiction?: CrossJurisdictionSwapRoute;
}

export interface SwapCancelEvent {
  offerId: string;
  accountId: string;
}

export interface SwapCancelRequestEvent {
  offerId: string;
  accountId: string;
}

export type AccountTxRejection =
  | {
      kind: 'settlement_seal_nonce_mismatch';
      suppliedNonce: number;
      requiredNonce: number;
      basis: 'workspace' | 'account';
    }
  | {
      kind: 'settlement_signed_account_frozen';
      txType: AccountTx['type'];
    };

export type ApplyAccountTxResult = {
  success: boolean;
  events: string[];
  error?: string;
  rejection?: AccountTxRejection;
  secret?: string;
  hashlock?: string;
  timedOutHashlock?: string;
  amount?: bigint;
  tokenId?: number;
  swapOfferCreated?: SwapOfferEvent;
  swapOfferCancelRequested?: { offerId: string };
  swapOfferCancelled?: { offerId: string; accountId: string; makerId?: string };
  candidateEffects?: AccountOutput[];
};
