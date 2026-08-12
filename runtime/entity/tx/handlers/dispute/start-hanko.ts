import type { AccountReplica } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import { addMessage } from '../../../frame-events';
import { createDisputeProofHashWithNonce } from '../../../../protocol/dispute/proof-builder';
import { buildAccountProofBodyFromJurisdictions } from '../../../../account/consensus/helpers';
import { verifyHankoForHash } from '../../../../hanko/signing';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../../jurisdiction/machine/board-registry';
import { disputeLog, resolveDepositoryHankoDomain } from './shared';
import type { StartEvidence } from './start-evidence';

export const verifyStartHanko = async (
  sourceState: EntityState,
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  evidence: StartEvidence,
  env: EntityRuntimeContext,
): Promise<boolean> => {
  const domain = resolveDepositoryHankoDomain(sourceState);
  if (!domain) {
    addMessage(state, '❌ disputeStart blocked: missing jurisdiction depository address');
    return false;
  }
  const disputeHash = createDisputeProofHashWithNonce(
    account.state,
    evidence.proofBodyHash,
    domain,
    evidence.signedNonce,
    evidence.proposerIsLeft,
  );
  if (
    evidence.storedDisputeHash?.startsWith('0x') &&
    evidence.storedDisputeHash.toLowerCase() !== disputeHash.toLowerCase()
  ) {
    throw new Error(
      `DISPUTE_STORED_HASH_MISMATCH:${counterpartyId}:` +
      `${evidence.storedDisputeHash}:${disputeHash}`,
    );
  }
  const boardHash = resolveObserverCertifiedBoardHash(
    sourceState,
    getCertifiedBoardNodeStore(env),
    counterpartyId,
  );
  const verification = await verifyHankoForHash(
    evidence.counterpartyHanko,
    disputeHash,
    counterpartyId,
    env,
    {
      ...(boardHash ? { registeredBoardHash: boardHash } : {}),
      observerState: sourceState,
    },
  );
  if (verification.valid) return true;
  const currentProof = buildAccountProofBodyFromJurisdictions(env.state, account);
  addMessage(
    state,
    `❌ Counterparty dispute proof invalid for current account snapshot; ` +
    `nonce=${evidence.signedNonce} onChain=${evidence.jNonce} source=${evidence.nonceSource}`,
  );
  disputeLog.error('start.preflight_failed', {
    entityId: sourceState.entityId,
    counterpartyEntityId: counterpartyId,
    signedNonce: evidence.signedNonce,
    nonceSource: evidence.nonceSource,
    jNonce: evidence.jNonce,
    proofHeaderNonce: account.proofHeader.nextProofNonce,
    counterpartyDisputeProofNonce: account.counterpartyDisputeProofNonce,
    storedProofBodyHash: evidence.proofBodyHash,
    storedDisputeHash: evidence.storedDisputeHash,
    currentProofBodyHash: currentProof.proofBodyHash,
    storedHashMatchesCurrent: evidence.proofBodyHash === currentProof.proofBodyHash,
    pendingFrameHeight: account.pendingFrame?.height ?? null,
    currentFrameHeight: account.currentFrame?.height ?? null,
    currentHeight: account.currentHeight,
    lockCount: account.state.locks?.size ?? 0,
    swapOfferCount: account.state.swapOffers?.size ?? 0,
    knownDisputeProofHashes: Object.keys(account.disputeProofNoncesByHash ?? {}),
    disputeHashSource: evidence.storedDisputeHash ? 'stored+recomputed' : 'recomputed',
    disputeHash,
    depositoryAddress: domain.depositoryAddress,
    recoveredEntityId: verification.entityId,
    hankoBytes: Math.max(evidence.counterpartyHanko.length - 2, 0) / 2,
  });
  return false;
};
