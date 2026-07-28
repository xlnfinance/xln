import type {
  AccountFrame,
  AccountInput,
  AccountMachine,
  AccountTx,
} from '../../types';
import {
  cloneAccountFrame,
  removeCommittedTxsFromMempool,
} from '../../state-helpers';
import { cloneIsolatedAccountInput } from '../../protocol/account-input-clone';
import { stageAccountCommitmentCache } from '../map-commitment';
import type {
  AccountConsensusHashToSign,
  ProposeAccountFrameResult,
} from './types';
import type {
  PreparedProposalProof,
} from './proposal-proof';
import type {
  ProposalTransactionEffects,
} from './proposal-transactions';

type DisputeSeal = NonNullable<
  Extract<AccountInput, { kind: 'frame' | 'frame_ack' }>['proposal']['disputeSeal']
>;

const resolveDisputeSeal = (
  account: AccountMachine,
  candidate: AccountMachine,
  proof: PreparedProposalProof,
): DisputeSeal | undefined => {
  if (proof.disputeHash) {
    return {
      ...(proof.disputeHanko ? { hanko: proof.disputeHanko } : {}),
      hash: proof.disputeHash,
      proofBodyHash: proof.proof.proofBodyHash,
      proofNonce: proof.signedProofNonce,
    };
  }
  if (
    account.currentDisputeProofHanko &&
    account.currentDisputeHash &&
    account.currentDisputeProofBodyHash?.toLowerCase() ===
      proof.proof.proofBodyHash.toLowerCase() &&
    Number(account.currentDisputeProofNonce ?? 0) > Number(candidate.jNonce ?? 0)
  ) {
    return {
      hanko: account.currentDisputeProofHanko,
      hash: account.currentDisputeHash,
      proofBodyHash: account.currentDisputeProofBodyHash,
      proofNonce: account.currentDisputeProofNonce!,
    };
  }
  return undefined;
};

const buildOutboundAccountInput = (
  account: AccountMachine,
  candidate: AccountMachine,
  frame: AccountFrame,
  proof: PreparedProposalProof,
): Extract<AccountInput, { kind: 'frame' | 'frame_ack' }> => {
  const reusableAck = account.lastOutboundFrameAck;
  const bundleAck =
    Boolean(reusableAck) &&
    reusableAck!.counterpartyEntityId.toLowerCase() === account.proofHeader.toEntity.toLowerCase() &&
    Number(reusableAck!.height) === Number(frame.height) - 1 &&
    Number(account.currentHeight) === Number(reusableAck!.height);
  const disputeSeal = resolveDisputeSeal(account, candidate, proof);
  const proposal = {
    frame: cloneAccountFrame(frame),
    ...(proof.frameHanko ? { frameHanko: proof.frameHanko } : {}),
    ...(disputeSeal ? { disputeSeal } : {}),
  };
  const shared = {
    fromEntityId: account.proofHeader.fromEntity,
    toEntityId: account.proofHeader.toEntity,
    domain: structuredClone(account.domain),
    watchSeed: account.watchSeed,
    proposal,
  };
  if (bundleAck) {
    return {
      kind: 'frame_ack',
      ...shared,
      ack: structuredClone(reusableAck!.response.ack),
    };
  }
  if (reusableAck && Number(reusableAck.height) < Number(account.currentHeight)) {
    delete account.lastOutboundFrameAck;
  }
  return { kind: 'frame', ...shared };
};

export const finalizeAccountProposal = (
  account: AccountMachine,
  candidate: AccountMachine,
  frame: AccountFrame,
  proof: PreparedProposalProof,
  counterparty: string,
  validMempoolTxs: readonly AccountTx[],
  txsToRemove: readonly AccountTx[],
  effects: ProposalTransactionEffects,
  events: string[],
  checkpointProfile: (label: string) => void,
): ProposeAccountFrameResult => {
  // Pending commitment and frame install are one Account-candidate mutation.
  // Late mempool arrivals survive because removal is by exact transaction
  // multiplicity, never by the proposal window's old array position.
  stageAccountCommitmentCache(account, candidate);
  account.pendingFrame = frame;
  account.mempool = removeCommittedTxsFromMempool(
    account.mempool,
    [...txsToRemove, ...validMempoolTxs],
  );
  events.push(`🚀 Proposed frame ${frame.height} with ${frame.accountTxs.length} transactions`);
  const accountInput = buildOutboundAccountInput(account, candidate, frame, proof);
  if (proof.disputeHash) {
    account.proofHeader.nextProofNonce = proof.signedProofNonce + 1;
  }
  account.pendingAccountInput = cloneIsolatedAccountInput(accountInput);
  checkpointProfile('finalize');

  const hashesToSign: AccountConsensusHashToSign[] = [{
    hash: frame.stateHash,
    type: 'accountFrame',
    context: `account:${counterparty.slice(-8)}:frame:${frame.height}`,
  }];
  if (proof.disputeHash) {
    hashesToSign.push({
      hash: proof.disputeHash,
      type: 'dispute',
      context: `account:${counterparty.slice(-8)}:dispute`,
    });
  }
  const result: ProposeAccountFrameResult = {
    success: true,
    accountChanged: true,
    accountInput,
    events,
    revealedSecrets: effects.revealedSecrets,
    swapOffersCreated: effects.swapOffersCreated,
    swapCancelRequests: effects.swapCancelRequests,
    swapOffersCancelled: effects.swapOffersCancelled,
    hashesToSign,
  };
  if (effects.failedHtlcLocks.length > 0) {
    result.failedHtlcLocks = effects.failedHtlcLocks;
  }
  return result;
};
