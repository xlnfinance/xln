import type { AccountReplica } from '../../../types/account';
import { createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';
import {
  buildAccountProofBodyFromJurisdictions,
  getAccountStateDomain,
  isEntityId32,
  type AccountJurisdictionView,
} from '../helpers';
import {
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../../../protocol/dispute/arguments';
import type { ProposeAccountFrameResult } from '../types';
import { proposeAccountFrameRejected } from '../result';
import { replaceLocalDisputeDraft } from '../dispute/seal';

type DisputeProjection = {
  proof: ReturnType<typeof buildAccountProofBodyFromJurisdictions>;
  hash?: string;
  nonce: number;
  proposerIsLeft: boolean;
};

export type PreparedProposalProof = {
  ok: true;
  signingEntityId: string;
  disputeHash?: string;
  signedProofNonce: number;
  proposerIsLeft: boolean;
  proof: ReturnType<typeof buildAccountProofBodyFromJurisdictions>;
};

export type ProposalProofResult =
  | PreparedProposalProof
  | { ok: false; result: ProposeAccountFrameResult };

const buildDisputeProjection = (
  jurisdictions: AccountJurisdictionView,
  account: AccountReplica,
  candidate: AccountReplica,
): DisputeProjection => {
  try {
    const proof = buildAccountProofBodyFromJurisdictions(jurisdictions, candidate);
    const bodyChanged =
      proof.proofBodyHash.toLowerCase() !==
      account.currentDisputeProofBodyHash?.toLowerCase();
    const nonceConsumed =
      Number(account.currentDisputeProofNonce ?? 0) <= Number(candidate.state.jNonce ?? 0);
    const proposerIsLeft =
      account.proofHeader.fromEntity.toLowerCase() === candidate.state.leftEntity.toLowerCase();
    if (!bodyChanged && !nonceConsumed) return { proof, nonce: 0, proposerIsLeft };
    const nonce = Math.max(
      Number(candidate.proofHeader.nextProofNonce ?? 0),
      Number(candidate.state.jNonce ?? 0) + 1,
    );
    return {
      proof,
      nonce,
      proposerIsLeft,
      hash: createDisputeProofHashWithNonce(
        candidate.state,
        proof.proofBodyHash,
        getAccountStateDomain(account.state),
        nonce,
        proposerIsLeft,
      ),
    };
  } catch (error) {
    // Failure here is an invariant fault, not a rejected user transaction:
    // committing without the promised recovery proof would make funds unsafe.
    throw new Error(`DISPUTE_PROOF_BUILD_FAILED: ${(error as Error).message}`, { cause: error });
  }
};

const persistDisputeProjection = (
  account: AccountReplica,
  candidate: AccountReplica,
  projection: DisputeProjection,
): void => {
  if (!projection.hash) return;
  replaceLocalDisputeDraft(account, {
    hash: projection.hash,
    nonce: projection.nonce,
    proofBodyHash: projection.proof.proofBodyHash,
    proposerIsLeft: projection.proposerIsLeft,
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
      projection.proposerIsLeft,
      projection.proof.proofBodyStruct,
    ),
  );
};

export const prepareProposalProof = async (
  jurisdictions: AccountJurisdictionView,
  account: AccountReplica,
  candidate: AccountReplica,
  events: string[],
  checkpointProfile: (label: string) => void,
): Promise<ProposalProofResult> => {
  const signingEntityId = account.proofHeader.fromEntity;
  if (!isEntityId32(candidate.state.leftEntity) || !isEntityId32(candidate.state.rightEntity)) {
    return {
      ok: false,
      result: proposeAccountFrameRejected(
        `INVALID_ACCOUNT_ENTITY_ID: left=${String(candidate.state.leftEntity)} ` +
          `right=${String(candidate.state.rightEntity)}`,
        events,
      ),
    };
  }

  const projection = buildDisputeProjection(jurisdictions, account, candidate);
  checkpointProfile('disputeProof');
  // Account consensus is deliberately signer-blind. It commits the exact
  // hashes that require authority; Entity consensus later creates either a
  // single-validator or quorum Hanko and seals the Account output. Keeping one
  // path prevents single-signer accounts from having stronger privileges than
  // otherwise identical multi-validator entities.
  persistDisputeProjection(account, candidate, projection);
  return {
    ok: true,
    signingEntityId,
    ...(projection.hash ? { disputeHash: projection.hash } : {}),
    signedProofNonce: projection.nonce,
    proposerIsLeft: projection.proposerIsLeft,
    proof: projection.proof,
  };
};
