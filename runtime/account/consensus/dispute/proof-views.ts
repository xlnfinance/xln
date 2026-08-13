import type { AccountReplica } from '../../../types/account';

export type LocalUnsignedDisputeProof = AccountReplica & {
  currentDisputeHash: string;
  currentDisputeProofBodyHash: string;
  currentDisputeProofNonce: number;
  currentDisputeProofProposerIsLeft: boolean;
  currentDisputeProofHanko?: never;
};

export type LocalCertifiedDisputeProof = AccountReplica & {
  currentDisputeHash: string;
  currentDisputeProofBodyHash: string;
  currentDisputeProofNonce: number;
  currentDisputeProofProposerIsLeft: boolean;
  currentDisputeProofHanko: string;
};

export type CounterpartyCertifiedDisputeProof = AccountReplica & {
  counterpartyDisputeHash: string;
  counterpartyDisputeProofBodyHash: string;
  counterpartyDisputeProofNonce: number;
  counterpartyDisputeProofProposerIsLeft: boolean;
  counterpartyDisputeProofHanko: string;
};

const hasText = (value: string | undefined): value is string =>
  typeof value === 'string' && value.length > 0;

const hasNonce = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && value! > 0;

export const hasLocalUnsignedDisputeProof = (
  account: AccountReplica,
): account is LocalUnsignedDisputeProof => hasText(account.currentDisputeHash)
  && hasText(account.currentDisputeProofBodyHash)
  && hasNonce(account.currentDisputeProofNonce)
  && typeof account.currentDisputeProofProposerIsLeft === 'boolean'
  && account.currentDisputeProofHanko === undefined;

export const hasLocalCertifiedDisputeProof = (
  account: AccountReplica,
): account is LocalCertifiedDisputeProof => hasText(account.currentDisputeHash)
  && hasText(account.currentDisputeProofBodyHash)
  && hasNonce(account.currentDisputeProofNonce)
  && typeof account.currentDisputeProofProposerIsLeft === 'boolean'
  && hasText(account.currentDisputeProofHanko);

export const hasCounterpartyCertifiedDisputeProof = (
  account: AccountReplica,
): account is CounterpartyCertifiedDisputeProof => hasText(account.counterpartyDisputeHash)
  && hasText(account.counterpartyDisputeProofBodyHash)
  && hasNonce(account.counterpartyDisputeProofNonce)
  && typeof account.counterpartyDisputeProofProposerIsLeft === 'boolean'
  && hasText(account.counterpartyDisputeProofHanko);

export const getDisputeProofTupleError = (account: AccountReplica): string | null => {
  const localFields = [
    account.currentDisputeHash,
    account.currentDisputeProofBodyHash,
    account.currentDisputeProofNonce,
    account.currentDisputeProofProposerIsLeft,
  ];
  const peerFields = [
    account.counterpartyDisputeHash,
    account.counterpartyDisputeProofBodyHash,
    account.counterpartyDisputeProofNonce,
    account.counterpartyDisputeProofProposerIsLeft,
  ];
  const localPresent = localFields.filter(value => value !== undefined).length;
  const peerPresent = peerFields.filter(value => value !== undefined).length;
  if (localPresent !== 0 && localPresent !== localFields.length) return 'LOCAL_DISPUTE_PROOF_PARTIAL';
  if (account.currentDisputeProofHanko !== undefined && localPresent !== localFields.length) {
    return 'LOCAL_DISPUTE_HANKO_WITHOUT_PROOF';
  }
  if (peerPresent !== 0 && peerPresent !== peerFields.length) return 'COUNTERPARTY_DISPUTE_PROOF_PARTIAL';
  if (account.counterpartyDisputeProofHanko !== undefined && peerPresent !== peerFields.length) {
    return 'COUNTERPARTY_DISPUTE_HANKO_WITHOUT_PROOF';
  }
  return null;
};
