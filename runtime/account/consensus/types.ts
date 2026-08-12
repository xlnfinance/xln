import type { AccountFrame, AccountPeerInput, AccountTx } from '../../types/account';
import type { AccountOutput } from '../../types/account';
import type { HankoString } from '../../types/hanko';
import type { AccountJClaimNodeChanges } from '../../types/finance/account-j-claims';
import type { AccountDisputeFinalityResult } from '../settlement/j-finality';
import type { AccountTxRejection } from '../tx/apply-types';
import type { AccountPeerRejection } from '../input/peer-rejection';

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
  maxFee: bigint;
  minNetReceive: bigint;
  priceTicks?: bigint | undefined;
  timeInForce?: 0 | 1 | 2 | undefined;
};

type AccountConsensusFrameResult = {
  success: boolean;
  events: string[];
  error?: string;
  txRejection?: AccountTxRejection;
  revealedSecrets?: Array<{ secret: string; hashlock: string }>;
  swapOffersCreated?: AccountSwapOfferCreated[];
  swapCancelRequests?: Array<{ offerId: string; accountId: string }>;
  swapOffersCancelled?: Array<{ offerId: string; accountId: string }>;
  hashesToSign?: AccountConsensusHashToSign[];
  candidateEffects?: AccountOutput[];
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
  rejected?: AccountPeerRejection;
};
