import type { AccountInput, AccountReplica } from '../../../types/account';
import { createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';
import { safeStringify } from '../../../protocol/serialization';
import { shortId } from '../../../support/logger';
import type { AccountInputSecurityContext } from './deadline-policy';
import {
  accountInputAck,
  accountInputDisputeHanko,
  accountInputProposal,
} from '../flush';
import { getAccountStateDomain } from '../helpers';
import { AccountInputEvidenceError } from '../../input/input-rejection';

export type ValidatedCounterpartyDisputeHanko = {
  hanko: string;
  nonce: number;
  hash: string;
  proofBodyHash: string;
  proposerIsLeft: boolean;
};

export type LocalDisputeDraft = {
  hash: string;
  nonce: number;
  proofBodyHash: string;
  proposerIsLeft: boolean;
};

/**
 * Replace the unsigned local dispute draft as one transition.
 *
 * A Hanko certifies one exact hash. Keeping the previous witness while
 * replacing its hash/body/nonce would make the Account state claim that an old
 * signature authorizes a new proof. Entity consensus attaches the replacement
 * witness only after the new draft reaches quorum.
 */
export const replaceLocalDisputeDraft = (
  account: AccountReplica,
  draft: LocalDisputeDraft,
): void => {
  delete account.currentDisputeProofHanko;
  account.currentDisputeHash = draft.hash;
  account.currentDisputeProofBodyHash = draft.proofBodyHash;
  account.currentDisputeProofNonce = draft.nonce;
  account.currentDisputeProofProposerIsLeft = draft.proposerIsLeft;
};

/**
 * Verify the peer witness against the exact Solidity dispute message.
 *
 * Verifying a peer-provided hash alone is unsafe: a valid signature over an
 * unrelated hash would look authentic off-chain but fail when submitted to
 * Depository.sol. Rebuilding the message here binds the Account, proof body,
 * domain and nonce before any witness is retained.
 */
export const validateCounterpartyDisputeHanko = async (
  account: AccountReplica,
  input: AccountInput,
  disputeHanko: ReturnType<typeof accountInputDisputeHanko>,
  context: string,
  securityContext: AccountInputSecurityContext,
  allowPreviousBoard = true,
): Promise<ValidatedCounterpartyDisputeHanko | undefined> => {
  if (!disputeHanko) return undefined;
  if (!disputeHanko.hanko) {
    throw new AccountInputEvidenceError(
      'ACCOUNT_INPUT_DISPUTE_HANKO_INVALID',
      `${context}:DISPUTE_HANKO_HANKO_MISSING`,
    );
  }
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(disputeHanko.hash)
    || !/^0x[0-9a-fA-F]{64}$/.test(disputeHanko.proofBodyHash)
    || !Number.isSafeInteger(disputeHanko.proofNonce)
    || disputeHanko.proofNonce < 0
    || typeof disputeHanko.proposerIsLeft !== 'boolean'
  ) {
    throw new AccountInputEvidenceError(
      'ACCOUNT_INPUT_DISPUTE_HANKO_INVALID',
      `${context}:DISPUTE_HANKO_SHAPE_INVALID`,
    );
  }

  const expectedHash = createDisputeProofHashWithNonce(
    account.state,
    disputeHanko.proofBodyHash,
    getAccountStateDomain(account.state),
    disputeHanko.proofNonce,
    disputeHanko.proposerIsLeft,
  );
  if (String(disputeHanko.hash).toLowerCase() !== expectedHash.toLowerCase()) {
    throw new AccountInputEvidenceError(
      'ACCOUNT_INPUT_DISPUTE_HANKO_INVALID',
      `${context}:DISPUTE_HANKO_HASH_MISMATCH:${safeStringify({
        kind: input.kind,
        currentHeight: account.currentHeight,
        pendingHeight: account.pendingFrame?.height ?? null,
        inputHeight: accountInputAck(input)?.height ?? null,
        newFrameHeight: accountInputProposal(input)?.frame.height ?? null,
        localNonce: account.proofHeader.nextProofNonce,
        signedNonce: disputeHanko.proofNonce,
        proofBodyHash: disputeHanko.proofBodyHash,
        expected: expectedHash,
        received: disputeHanko.hash,
        from: shortId(input.fromEntityId),
        to: shortId(input.toEntityId),
      })}`,
    );
  }

  const { valid } = await securityContext.verifyHanko(
    disputeHanko.hanko,
    expectedHash,
    input.fromEntityId,
    {
      ...(securityContext.counterpartyCertifiedBoard
        ? { registeredBoardHash: securityContext.counterpartyCertifiedBoard.boardHash }
        : {}),
      allowPreviousBoard,
    },
  );
  if (!valid) {
    throw new AccountInputEvidenceError(
      'ACCOUNT_INPUT_DISPUTE_HANKO_INVALID',
      `${context}:DISPUTE_HANKO_HANKO_INVALID`,
    );
  }

  return {
    hanko: disputeHanko.hanko,
    nonce: disputeHanko.proofNonce,
    hash: expectedHash,
    proofBodyHash: disputeHanko.proofBodyHash,
    proposerIsLeft: disputeHanko.proposerIsLeft,
  };
};

export const storeCounterpartyDisputeHanko = (
  account: AccountReplica,
  disputeHanko: ValidatedCounterpartyDisputeHanko | undefined,
): void => {
  if (!disputeHanko) return;
  account.counterpartyDisputeProofHanko = disputeHanko.hanko;
  account.counterpartyDisputeProofNonce = disputeHanko.nonce;
  account.counterpartyDisputeProofProposerIsLeft = disputeHanko.proposerIsLeft;
  account.counterpartyDisputeHash = disputeHanko.hash;
  account.counterpartyDisputeProofBodyHash = disputeHanko.proofBodyHash;
};

export const getDisputeHankoRequirementError = (
  expectedProofBodyHash: string | undefined,
  previousCounterpartyProofBodyHash: string | undefined,
  previousCounterpartyProofNonce: number | undefined,
  jNonce: number,
  disputeHanko: ValidatedCounterpartyDisputeHanko | undefined,
): string | undefined => {
  if (!expectedProofBodyHash) {
    return disputeHanko ? 'DISPUTE_HANKO_UNEXPECTED_WITHOUT_LOCAL_PROOF' : undefined;
  }
  if (disputeHanko && disputeHanko.nonce <= jNonce) {
    return `DISPUTE_HANKO_NONCE_ALREADY_FINALIZED: received=${disputeHanko.nonce} jNonce=${jNonce}`;
  }
  if (
    disputeHanko
    && previousCounterpartyProofNonce !== undefined
    && disputeHanko.nonce < previousCounterpartyProofNonce
  ) {
    return `DISPUTE_HANKO_NONCE_REGRESSION: received=${disputeHanko.nonce} previous=${previousCounterpartyProofNonce}`;
  }
  if (
    disputeHanko
    && previousCounterpartyProofNonce !== undefined
    && disputeHanko.nonce === previousCounterpartyProofNonce
    && previousCounterpartyProofBodyHash !== undefined
    && disputeHanko.proofBodyHash.toLowerCase() !== previousCounterpartyProofBodyHash.toLowerCase()
  ) {
    return `DISPUTE_HANKO_NONCE_REUSE: nonce=${disputeHanko.nonce}`;
  }
  if (disputeHanko && disputeHanko.proofBodyHash.toLowerCase() !== expectedProofBodyHash.toLowerCase()) {
    return `DISPUTE_HANKO_PROOFBODY_MISMATCH: expected=${expectedProofBodyHash} received=${disputeHanko.proofBodyHash}`;
  }
  const proofChanged = expectedProofBodyHash.toLowerCase()
    !== previousCounterpartyProofBodyHash?.toLowerCase();
  const proofNonceConsumed = Number(previousCounterpartyProofNonce ?? 0) <= jNonce;
  if ((proofChanged || proofNonceConsumed) && !disputeHanko) {
    return `DISPUTE_HANKO_REQUIRED: proofBodyHash=${expectedProofBodyHash} jNonce=${jNonce}`;
  }
  return undefined;
};
