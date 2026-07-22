import type { AccountFrame, AccountInput, AccountTx, HankoString } from '../../types';
import type { AccountJClaimNodeChanges } from '../../types/account-j-claims';

export type AccountConsensusHashToSign = {
  hash: string;
  type: 'accountFrame' | 'dispute';
  context: string;
};

export type AccountSwapOfferCreated = {
  offerId: string;
  makerIsLeft: boolean;
  fromEntity: string;
  toEntity: string;
  accountId?: string;
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  priceTicks?: bigint | undefined;
  timeInForce?: 0 | 1 | 2 | undefined;
};

export type AccountConsensusFrameResult = {
  success: boolean;
  events: string[];
  error?: string;
  revealedSecrets?: Array<{ secret: string; hashlock: string }>;
  swapOffersCreated?: AccountSwapOfferCreated[];
  swapCancelRequests?: Array<{ offerId: string; accountId: string }>;
  swapOffersCancelled?: Array<{ offerId: string; accountId: string }>;
  hashesToSign?: AccountConsensusHashToSign[];
};

export type ProposeAccountFrameResult = AccountConsensusFrameResult & {
  accountChanged?: true;
  accountInput?: AccountInput;
  failedHtlcLocks?: Array<{ hashlock: string; reason: string }>;
};

export type HandleAccountInputResult = AccountConsensusFrameResult & {
  /** Validator-computed CAS delta for Account frames committed by this input. */
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  response?: AccountInput;
  approvalNeeded?: AccountTx;
  timedOutHashlocks?: string[];
  committedFrames?: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }>;
  disputeRequired?: {
    reason: string;
    evidenceSecrets: Array<{ hashlock: string; secret: string }>;
    signedFrame?: {
      frame: AccountFrame;
      frameHanko: HankoString;
    };
  };
  rejected?: { reason: string };
};
