import type { AccountExternalFinalityInput, AccountReplica } from '../../types/account';
import {
  freezeAccountForDispute,
  isDisputeStartedByLeft,
} from '../consensus/dispute/policy';
import { clearFinalizedSettlementWorkspace } from '../tx/handlers/settlement/transition';
import { requirePersistentAccountStateMap } from '../state/persistent-state-map';
export type AccountDisputeFinalityResult = {
  hadActiveDispute: boolean;
  hadSettlementWorkspace: boolean;
  removedSettlementTxs: number;
};

type DisputeStartedFinality = Extract<
  AccountExternalFinalityInput['finality'],
  { kind: 'dispute_started' }
>;

const requireSafeNonce = (value: number, code: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${code}:${String(value)}`);
  }
};

/**
 * Apply an authenticated Depository DisputeStarted event inside Account.
 *
 * Entity owns event authentication and follow-up routing, but it must not
 * duplicate Account policy by writing dispute fields itself. Like finalized
 * settlement, this transition is unilateral external consensus: waiting for
 * a peer ACK would let the peer ignore an already-final on-chain freeze.
 */
export const applyAccountDisputeStarted = (
  account: AccountReplica,
  finality: DisputeStartedFinality,
): void => {
  requireSafeNonce(finality.initialNonce, 'ACCOUNT_DISPUTE_INITIAL_NONCE_INVALID');
  requireSafeNonce(finality.jNonce, 'ACCOUNT_DISPUTE_J_NONCE_INVALID');
  requireSafeNonce(
    finality.observedBlockNumber,
    'ACCOUNT_DISPUTE_OBSERVED_BLOCK_INVALID',
  );
  // disputeTimeout / disputeStartTimestamp are absolute unix seconds on L1.
  if (
    !Number.isSafeInteger(finality.disputeTimeout) ||
    !Number.isSafeInteger(finality.disputeStartTimestamp) ||
    finality.disputeStartTimestamp <= 0 ||
    finality.disputeTimeout < finality.disputeStartTimestamp
  ) {
    throw new Error(
      `ACCOUNT_DISPUTE_TIMEOUT_INVALID:` +
      `${finality.disputeStartTimestamp}:${finality.disputeTimeout}`,
    );
  }
  const accountClock = account.state.disputeConfig;
  if (
    finality.leftResponseSeconds !== accountClock.leftResponseSeconds ||
    finality.rightResponseSeconds !== accountClock.rightResponseSeconds ||
    finality.disputeTimeout !==
      finality.disputeStartTimestamp +
        finality.leftResponseSeconds +
        finality.rightResponseSeconds
  ) {
    throw new Error(
      `ACCOUNT_DISPUTE_CLOCK_MISMATCH:` +
        `${finality.disputeStartTimestamp}:${finality.disputeTimeout}:` +
        `${finality.leftResponseSeconds}:${finality.rightResponseSeconds}:` +
        `${accountClock.leftResponseSeconds}:${accountClock.rightResponseSeconds}`,
    );
  }

  const startedByLeft = isDisputeStartedByLeft(
    finality.starterEntityId,
    account.state.leftEntity,
    account.state.rightEntity,
  );
  account.status = 'disputed';
  freezeAccountForDispute(account, true);
  const preparedRecovery = account.disputePrepare?.crossJurisdictionRecovery;
  account.activeDispute = {
    startedByLeft,
    initialProofbodyHash: finality.initialProofbodyHash,
    initialNonce: finality.initialNonce,
    initialProposerIsLeft: finality.initialProposerIsLeft,
    disputeTimeout: finality.disputeTimeout,
    disputeStartTimestamp: finality.disputeStartTimestamp,
    jNonce: finality.jNonce,
    starterInitialArguments: finality.starterInitialArguments,
    starterCounterArguments: finality.starterCounterArguments,
    starterCounterProofCommitment: finality.starterCounterProofCommitment,
    observedOnChain: true,
    observedBlockNumber: finality.observedBlockNumber,
    ...(finality.batchNonce !== undefined
      ? { batchNonce: finality.batchNonce }
      : {}),
    ...(preparedRecovery !== undefined
      ? { crossJurisdictionRecovery: preparedRecovery }
      : {}),
    finalizeQueued: false,
  };
  delete account.disputePrepare;
  account.state.jNonce = Math.max(account.state.jNonce, finality.jNonce);
};

const reconcileFinalizedDeltas = (
  account: AccountReplica,
  finalizedTokenIds: readonly number[],
): void => {
  const finalized = new Set(finalizedTokenIds);
  let deltas = requirePersistentAccountStateMap(account.state.deltas, 'deltas');
  for (const [tokenId, delta] of account.state.deltas) {
    const tokenWasFinalized = finalized.has(tokenId);
    // Solidity touches collateral/ondelta only for tokenIds in the winning
    // ProofBody. A valid older proof can omit a row added later, so preserve
    // those on-chain balances while discarding every newer off-chain field.
    const changed =
      (tokenWasFinalized && (delta.collateral !== 0n || delta.ondelta !== 0n)) ||
      delta.offdelta !== 0n ||
      delta.leftHold !== 0n ||
      delta.rightHold !== 0n ||
      delta.leftAllowance !== 0n ||
      delta.rightAllowance !== 0n;
    if (!changed) continue;
    deltas = deltas.updated(tokenId, {
      ...delta,
      ...(tokenWasFinalized ? { collateral: 0n, ondelta: 0n } : {}),
      offdelta: 0n,
      leftHold: 0n,
      rightHold: 0n,
      leftAllowance: 0n,
      rightAllowance: 0n,
    });
  }
  account.state.deltas = deltas;
};

const clearFinalizedCollections = (account: AccountReplica): void => {
  if (account.state.swapOffers.size > 0) {
    account.state.swapOffers = requirePersistentAccountStateMap(
      account.state.swapOffers,
      'swapOffers',
    ).emptied();
  }
  if (account.state.locks.size > 0) {
    account.state.locks = requirePersistentAccountStateMap(account.state.locks, 'locks').emptied();
  }
  if (account.state.pulls && account.state.pulls.size > 0) {
    account.state.pulls = requirePersistentAccountStateMap(account.state.pulls, 'pulls').emptied();
  }
  delete account.disputeProofBodiesByHash;
  delete account.disputeProofNoncesByHash;
  delete account.disputeArgumentSnapshotsByHash;
};

/**
 * Apply the Account-owned state transition authorized by a finalized
 * Depository dispute event.
 *
 * This is deliberately not an Account proposal or bilateral acknowledgement.
 * Depository finality is unilateral external consensus: both replicas consume
 * the same certified J event and deterministically converge. Requiring the
 * counterparty to acknowledge the already-final result could let that party
 * veto or indefinitely delay on-chain settlement.
 */
export const applyAccountDisputeFinality = (
  account: AccountReplica,
  finalizedJNonce: number,
  finalizedTokenIds: readonly number[],
): AccountDisputeFinalityResult => {
  const hadActiveDispute = Boolean(account.activeDispute);
  const hadSettlementWorkspace = Boolean(account.state.settlementWorkspace);
  if (hadSettlementWorkspace) clearFinalizedSettlementWorkspace(account);
  const removedSettlementTxs = account.mempool.filter(
    tx => tx.type === 'settle_transition',
  ).length;
  account.mempool = account.mempool.filter(tx => tx.type !== 'settle_transition');

  account.state.jNonce = finalizedJNonce;
  delete account.activeDispute;
  if (account.proofHeader.nextProofNonce <= finalizedJNonce) {
    account.proofHeader.nextProofNonce = finalizedJNonce + 1;
  }
  account.status = 'disputed';
  freezeAccountForDispute(account, false);
  delete account.counterpartyDisputeProofHanko;
  delete account.counterpartyDisputeProofNonce;
  delete account.counterpartyDisputeProofBodyHash;
  reconcileFinalizedDeltas(account, finalizedTokenIds);
  clearFinalizedCollections(account);

  return {
    hadActiveDispute,
    hadSettlementWorkspace,
    removedSettlementTxs,
  };
};
