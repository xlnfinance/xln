import type { AccountFrame, AccountPeerInput, AccountTx } from '../../types/account';
import type { AccountOutput } from '../../types/account';
import type { HankoString } from '../../types/hanko';
import type { AccountJClaimNodeChanges } from '../../types/finance/account-j-claims';
import type { AccountDisputeFinalityResult } from '../settlement/j-finality';
import type { AccountTxRejection } from '../tx/apply-types';
import type { AccountPeerRejectionCode } from '../input/peer-rejection';

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

export type AccountCommittedFrame = {
  frame: AccountFrame;
  committedViaNewFrame: boolean;
};

export type AccountFailedHtlcLock = {
  hashlock: string;
  reason: string;
};

export type AccountInputDisputeRequired = Readonly<{
  reason: string;
  evidenceSecrets: Array<{ hashlock: string; secret: string }>;
  signedFrame?: {
    frame: AccountFrame;
    frameHanko: HankoString;
  };
}>;

export type HandleAccountInputRejection =
  | Readonly<{ kind: 'peer'; code: AccountPeerRejectionCode; message: string }>
  | Readonly<{ kind: 'tx'; tx: AccountTxRejection; message: string }>
  | Readonly<{ kind: 'validation'; message: string }>;

type AccountConsensusOkEffects = {
  events: string[];
  revealedSecrets?: Array<{ secret: string; hashlock: string }>;
  swapOffersCreated?: AccountSwapOfferCreated[];
  swapCancelRequests?: Array<{ offerId: string; accountId: string }>;
  swapOffersCancelled?: Array<{ offerId: string; accountId: string }>;
  hashesToSign?: AccountConsensusHashToSign[];
  candidateEffects?: AccountOutput[];
};

export type HandleAccountInputApplied = Readonly<AccountConsensusOkEffects & {
  ok: true;
  admittedAccountTxCount?: number;
  externalFinality?: AccountDisputeFinalityResult;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  response?: AccountPeerInput;
  approvalNeeded?: AccountTx;
  timedOutHashlocks?: string[];
  committedFrames?: AccountCommittedFrame[];
}>;

export type HandleAccountInputRejected = Readonly<{
  ok: false;
  disposition: 'rejected';
  rejection: HandleAccountInputRejection;
  events: string[];
}>;

export type HandleAccountInputDispute = Readonly<{
  ok: false;
  disposition: 'dispute';
  disputeRequired: AccountInputDisputeRequired;
  events: string[];
}>;

export type HandleAccountInputResult =
  | HandleAccountInputApplied
  | HandleAccountInputRejected
  | HandleAccountInputDispute;

export type ProposeAccountFrameProposed = Readonly<AccountConsensusOkEffects & {
  ok: true;
  outcome: 'proposed';
  accountChanged: true;
  accountInput: AccountPeerInput;
  failedHtlcLocks?: AccountFailedHtlcLock[];
}>;

export type ProposeAccountFrameIdle = Readonly<{
  ok: true;
  outcome: 'idle';
  message: string;
  events: string[];
  accountChanged?: true;
  failedHtlcLocks?: AccountFailedHtlcLock[];
}>;

export type ProposeAccountFrameRejected = Readonly<{
  ok: false;
  rejection: Readonly<{ message: string }>;
  events: string[];
}>;

export type ProposeAccountFrameResult =
  | ProposeAccountFrameProposed
  | ProposeAccountFrameIdle
  | ProposeAccountFrameRejected;
