import type { AccountPeerInput, AccountReplica } from '../../types/account';
import { createDisputeProofHashWithNonce } from '../../protocol/dispute/proof-builder';
import { safeStringify } from '../../protocol/serialization';
import { shortId } from '../../infra/logger';
import type { AccountInputSecurityContext } from './deadline-policy';
import {
  accountInputAck,
  accountInputDisputeSeal,
  accountInputProposal,
} from './flush';
import { getAccountStateDomain } from './helpers';

export type ValidatedCounterpartyDisputeSeal = {
  hanko: string;
  nonce: number;
  hash: string;
  proofBodyHash: string;
};

export type LocalDisputeDraft = {
  hash: string;
  nonce: number;
  proofBodyHash: string;
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
};

/**
 * Verify the peer witness against the exact Solidity dispute message.
 *
 * Verifying a peer-provided hash alone is unsafe: a valid signature over an
 * unrelated hash would look authentic off-chain but fail when submitted to
 * Depository.sol. Rebuilding the message here binds the Account, proof body,
 * domain and nonce before any witness is retained.
 */
export const validateCounterpartyDisputeSeal = async (
  account: AccountReplica,
  input: AccountPeerInput,
  seal: ReturnType<typeof accountInputDisputeSeal>,
  context: string,
  securityContext: AccountInputSecurityContext,
  allowPreviousBoard = true,
): Promise<ValidatedCounterpartyDisputeSeal | undefined> => {
  if (!seal) return undefined;
  if (!seal.hanko) throw new Error(`${context}:DISPUTE_SEAL_HANKO_MISSING`);

  const expectedHash = createDisputeProofHashWithNonce(
    account.state,
    seal.proofBodyHash,
    getAccountStateDomain(account.state),
    seal.proofNonce,
  );
  if (String(seal.hash).toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`${context}:DISPUTE_SEAL_HASH_MISMATCH:${safeStringify({
      kind: input.kind,
      currentHeight: account.currentHeight,
      pendingHeight: account.pendingFrame?.height ?? null,
      inputHeight: accountInputAck(input)?.height ?? null,
      newFrameHeight: accountInputProposal(input)?.frame.height ?? null,
      localNonce: account.proofHeader.nextProofNonce,
      signedNonce: seal.proofNonce,
      proofBodyHash: seal.proofBodyHash,
      expected: expectedHash,
      received: seal.hash,
      from: shortId(input.fromEntityId),
      to: shortId(input.toEntityId),
    })}`);
  }

  const { valid } = await securityContext.verifyHanko(
    seal.hanko,
    expectedHash,
    input.fromEntityId,
    securityContext.counterpartyCertifiedBoardHash
      ? {
          registeredBoardHash: securityContext.counterpartyCertifiedBoardHash,
          allowPreviousBoard,
        }
      : undefined,
  );
  if (!valid) throw new Error(`${context}:DISPUTE_SEAL_HANKO_INVALID`);

  return {
    hanko: seal.hanko,
    nonce: seal.proofNonce,
    hash: expectedHash,
    proofBodyHash: seal.proofBodyHash,
  };
};

export const storeCounterpartyDisputeSeal = (
  account: AccountReplica,
  seal: ValidatedCounterpartyDisputeSeal | undefined,
): void => {
  if (!seal) return;
  account.counterpartyDisputeProofHanko = seal.hanko;
  account.counterpartyDisputeProofNonce = seal.nonce;
  account.counterpartyDisputeHash = seal.hash;
  account.counterpartyDisputeProofBodyHash = seal.proofBodyHash;
  account.disputeProofNoncesByHash ??= {};
  account.disputeProofNoncesByHash[seal.proofBodyHash] = seal.nonce;
};

export const getDisputeSealRequirementError = (
  expectedProofBodyHash: string | undefined,
  previousCounterpartyProofBodyHash: string | undefined,
  previousCounterpartyProofNonce: number | undefined,
  jNonce: number,
  seal: ValidatedCounterpartyDisputeSeal | undefined,
): string | undefined => {
  if (!expectedProofBodyHash) {
    return seal ? 'DISPUTE_SEAL_UNEXPECTED_WITHOUT_LOCAL_PROOF' : undefined;
  }
  if (seal && seal.proofBodyHash.toLowerCase() !== expectedProofBodyHash.toLowerCase()) {
    return `DISPUTE_SEAL_PROOFBODY_MISMATCH: expected=${expectedProofBodyHash} received=${seal.proofBodyHash}`;
  }
  const proofChanged = expectedProofBodyHash.toLowerCase()
    !== previousCounterpartyProofBodyHash?.toLowerCase();
  const proofNonceConsumed = Number(previousCounterpartyProofNonce ?? 0) <= jNonce;
  if ((proofChanged || proofNonceConsumed) && !seal) {
    return `DISPUTE_SEAL_REQUIRED: proofBodyHash=${expectedProofBodyHash} jNonce=${jNonce}`;
  }
  return undefined;
};
