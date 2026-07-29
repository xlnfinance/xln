import type { AccountFrame, AccountPeerInput, AccountTx, EntityCandidateEffect, HankoString } from '../../types';
import type { AccountJClaimNodeChanges } from '../../types/account-j-claims';
import type { AccountDisputeFinalityResult } from '../j-finality';
import type { AccountTxRejection } from '../tx/apply-types';

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
  txRejection?: AccountTxRejection;
  revealedSecrets?: Array<{ secret: string; hashlock: string }>;
  swapOffersCreated?: AccountSwapOfferCreated[];
  swapCancelRequests?: Array<{ offerId: string; accountId: string }>;
  swapOffersCancelled?: Array<{ offerId: string; accountId: string }>;
  hashesToSign?: AccountConsensusHashToSign[];
  candidateEffects?: EntityCandidateEffect[];
};

export type ProposeAccountFrameResult = AccountConsensusFrameResult & {
  accountChanged?: true;
  accountInput?: AccountPeerInput;
  failedHtlcLocks?: Array<{ hashlock: string; reason: string }>;
};

export type HandleAccountInputResult = AccountConsensusFrameResult & {
  /** Number of local AccountTxs admitted to the next-frame mempool. */
  admittedAccountTxCount?: number;
  /** Result of an authenticated unilateral J-finality transition. */
  externalFinality?: AccountDisputeFinalityResult;
  /** Validator-computed CAS delta for Account frames committed by this input. */
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  response?: AccountPeerInput;
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
