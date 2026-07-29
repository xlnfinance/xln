import type { AccountState, RuntimeState } from '../../types';
import { createDisputeProofHashWithNonce } from '../../protocol/dispute/proof-builder';
import {
  buildAccountProofBodyFromEnv,
  getAccountStateDomain,
  isEntityId32,
} from './helpers';
import {
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../../protocol/dispute/arguments';
import type { ProposeAccountFrameResult } from './types';
import { replaceLocalDisputeDraft } from './dispute-seal';

type DisputeProjection = {
  proof: ReturnType<typeof buildAccountProofBodyFromEnv>;
  hash?: string;
  nonce: number;
};

export type PreparedProposalProof = {
  success: true;
  signingEntityId: string;
  disputeHash?: string;
  signedProofNonce: number;
  proof: ReturnType<typeof buildAccountProofBodyFromEnv>;
};

export type ProposalProofResult =
  | PreparedProposalProof
  | { success: false; result: ProposeAccountFrameResult };

const buildDisputeProjection = (
  env: RuntimeState,
  account: AccountState,
  candidate: AccountState,
): DisputeProjection => {
  try {
    const proof = buildAccountProofBodyFromEnv(env, candidate);
    const bodyChanged =
      proof.proofBodyHash.toLowerCase() !==
      account.currentDisputeProofBodyHash?.toLowerCase();
    const nonceConsumed =
      Number(account.currentDisputeProofNonce ?? 0) <= Number(candidate.jNonce ?? 0);
    if (!bodyChanged && !nonceConsumed) return { proof, nonce: 0 };
    const nonce = Math.max(
      Number(candidate.proofHeader.nextProofNonce ?? 0),
      Number(candidate.jNonce ?? 0) + 1,
    );
    return {
      proof,
      nonce,
      hash: createDisputeProofHashWithNonce(
        candidate,
        proof.proofBodyHash,
        getAccountStateDomain(account),
        nonce,
      ),
    };
  } catch (error) {
    // Failure here is an invariant fault, not a rejected user transaction:
    // committing without the promised recovery proof would make funds unsafe.
    throw new Error(`DISPUTE_PROOF_BUILD_FAILED: ${(error as Error).message}`, { cause: error });
  }
};

const persistDisputeProjection = (
  account: AccountState,
  candidate: AccountState,
  projection: DisputeProjection,
): void => {
  if (!projection.hash) return;
  replaceLocalDisputeDraft(account, {
    hash: projection.hash,
    nonce: projection.nonce,
    proofBodyHash: projection.proof.proofBodyHash,
  });
  account.disputeProofNoncesByHash ??= {};
  account.disputeProofNoncesByHash[projection.proof.proofBodyHash] = projection.nonce;
  account.disputeProofBodiesByHash ??= {};
  account.disputeProofBodiesByHash[projection.proof.proofBodyHash] =
    projection.proof.proofBodyStruct;
  storeDisputeArgumentSnapshot(
    account,
    captureDisputeArgumentSnapshot(
      candidate,
      projection.proof.proofBodyHash,
      projection.nonce,
      projection.proof.proofBodyStruct,
    ),
  );
};

export const prepareProposalProof = async (
  env: RuntimeState,
  account: AccountState,
  candidate: AccountState,
  events: string[],
  checkpointProfile: (label: string) => void,
): Promise<ProposalProofResult> => {
  const signingEntityId = account.proofHeader.fromEntity;
  if (!isEntityId32(candidate.leftEntity) || !isEntityId32(candidate.rightEntity)) {
    return {
      success: false,
      result: {
        success: false,
        error:
          `INVALID_ACCOUNT_ENTITY_ID: left=${String(candidate.leftEntity)} ` +
          `right=${String(candidate.rightEntity)}`,
        events,
      },
    };
  }

  const projection = buildDisputeProjection(env, account, candidate);
  checkpointProfile('disputeProof');
  // Account consensus is deliberately signer-blind. It commits the exact
  // hashes that require authority; Entity consensus later creates either a
  // single-validator or quorum Hanko and seals the Account output. Keeping one
  // path prevents single-signer accounts from having stronger privileges than
  // otherwise identical multi-validator entities.
  persistDisputeProjection(account, candidate, projection);
  return {
    success: true,
    signingEntityId,
    ...(projection.hash ? { disputeHash: projection.hash } : {}),
    signedProofNonce: projection.nonce,
    proof: projection.proof,
  };
};
