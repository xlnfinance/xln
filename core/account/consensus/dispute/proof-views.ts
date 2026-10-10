import type { AccountReplica } from '../../../types/account';

export type LocalCertifiedDisputeProof = AccountReplica & {
  currentDisputeHash: string;
  currentDisputeProofBodyHash: string;
  currentDisputeProofNonce: number;
  currentDisputeProofProposerIsLeft: boolean;
  currentDisputeProofHanko: string;
};

const hasText = (value: string | undefined): value is string =>
  typeof value === 'string' && value.length > 0;

const hasNonce = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export const hasLocalCertifiedDisputeProof = (
  account: AccountReplica,
): account is LocalCertifiedDisputeProof => hasText(account.currentDisputeHash)
  && hasText(account.currentDisputeProofBodyHash)
  && hasNonce(account.currentDisputeProofNonce)
  && typeof account.currentDisputeProofProposerIsLeft === 'boolean'
  && hasText(account.currentDisputeProofHanko);
