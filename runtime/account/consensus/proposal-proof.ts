import type { AccountFrame, AccountMachine, Env } from '../../types';
import { createDisputeProofHashWithNonce } from '../../protocol/dispute/proof-builder';
import { signEntityHashes } from '../../hanko/signing';
import {
  buildAccountProofBodyFromEnv,
  getAccountStateDomain,
  isEntityId32,
} from './helpers';
import {
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../../protocol/dispute/arguments';
import { getReplicaByEntityId } from '../../entity/replica';
import { createStructuredLogger, shortId } from '../../infra/logger';
import type { ProposeAccountFrameResult } from './types';

const accountLog = createStructuredLogger('account');

type DisputeProjection = {
  proof: ReturnType<typeof buildAccountProofBodyFromEnv>;
  hash?: string;
  nonce: number;
};

export type PreparedProposalProof = {
  success: true;
  signingEntityId: string;
  frameHanko?: string;
  disputeHanko?: string;
  disputeHash?: string;
  signedProofNonce: number;
  proof: ReturnType<typeof buildAccountProofBodyFromEnv>;
};

export type ProposalProofResult =
  | PreparedProposalProof
  | { success: false; result: ProposeAccountFrameResult };

const buildDisputeProjection = (
  env: Env,
  account: AccountMachine,
  candidate: AccountMachine,
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
  account: AccountMachine,
  candidate: AccountMachine,
  projection: DisputeProjection,
  disputeHanko: string | undefined,
): void => {
  if (!projection.hash) return;
  if (disputeHanko) account.currentDisputeProofHanko = disputeHanko;
  account.currentDisputeProofNonce = projection.nonce;
  account.currentDisputeProofBodyHash = projection.proof.proofBodyHash;
  account.currentDisputeHash = projection.hash;
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
  env: Env,
  account: AccountMachine,
  candidate: AccountMachine,
  frame: AccountFrame,
  events: string[],
  quiet: boolean,
  checkpointProfile: (label: string) => void,
): Promise<ProposalProofResult> => {
  const signingEntityId = account.proofHeader.fromEntity;
  const signingReplica = getReplicaByEntityId(env, signingEntityId);
  if (!signingReplica) {
    return {
      success: false,
      result: {
        success: false,
        error: `Cannot find replica for entity ${signingEntityId.slice(-4)}`,
        events,
      },
    };
  }
  const signerId = signingReplica.state.config.validators[0];
  if (!signerId) {
    return {
      success: false,
      result: {
        success: false,
        error: `Entity ${signingEntityId.slice(-4)} has no validators`,
        events,
      },
    };
  }
  const directSigner =
    signingReplica.state.config.validators.length === 1 ? signerId : undefined;
  if (!quiet) {
    accountLog.debug(directSigner ? 'hanko.sign' : 'hanko.defer_to_entity_quorum', {
      entity: shortId(signingEntityId),
      ...(directSigner ? { signer: shortId(directSigner) } : {}),
    });
  }
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
  let frameHanko: string | undefined;
  let disputeHanko: string | undefined;
  if (directSigner) {
    [frameHanko, disputeHanko] = await signEntityHashes(
      env,
      signingEntityId,
      directSigner,
      [frame.stateHash, ...(projection.hash ? [projection.hash] : [])],
    );
    if (!frameHanko) {
      return {
        success: false,
        result: { success: false, error: 'Failed to build frame hanko', events },
      };
    }
    if (projection.hash && !disputeHanko) {
      return {
        success: false,
        result: { success: false, error: 'Failed to build dispute hanko', events },
      };
    }
    account.currentFrameHanko = frameHanko;
  }
  checkpointProfile('signatures');
  persistDisputeProjection(account, candidate, projection, disputeHanko);
  return {
    success: true,
    signingEntityId,
    ...(frameHanko ? { frameHanko } : {}),
    ...(disputeHanko ? { disputeHanko } : {}),
    ...(projection.hash ? { disputeHash: projection.hash } : {}),
    signedProofNonce: projection.nonce,
    proof: projection.proof,
  };
};
