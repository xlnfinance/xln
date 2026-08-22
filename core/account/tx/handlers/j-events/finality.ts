import type { AccountReplica } from '../../../../types/account';
import type { AccountDraftReplica } from '../../../state/account-state-draft';
import type { JurisdictionEvent } from '../../../../types/jurisdiction-events';
import { clearFinalizedSettlementWorkspace } from '../settlement/transition';
import { buildAccountProofBody } from '../../../../protocol/dispute/proof-builder';
import { createSettlementDeltaValue } from '../../../settlement/settlement-projection';
import { commitDeltaDraft } from '../../delta-utils';
import { assertAccountDeltaCapacity } from '../../../state/delta';
import { assertSettlementTokenId } from '../../../../protocol/settlement/operations';
import {
  accountTransitionView,
  beginAccountTransition,
  countAccountTransitionNodeChanges,
  discardAccountTransition,
  publishAccountTransition,
} from '../../../state/candidate-overlay';
import { createStructuredLogger } from '../../../../support/logger';

const jEventFinalityLog = createStructuredLogger('account.j_event.finality');

const normalizedEntityId = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const assertAccountSettledEvent = (
  account: Readonly<{
    state: Readonly<{ leftEntity: string; rightEntity: string }>;
  }>,
  event: Extract<JurisdictionEvent, { type: 'AccountSettled' }>,
): number => {
  const left = normalizedEntityId(event.data.leftEntity);
  const right = normalizedEntityId(event.data.rightEntity);
  if (left !== account.state.leftEntity.toLowerCase() || right !== account.state.rightEntity.toLowerCase()) {
    throw new Error(
      `ACCOUNT_SETTLED_PAIR_MISMATCH:${left}:${right}:${account.state.leftEntity.toLowerCase()}:${account.state.rightEntity.toLowerCase()}`,
    );
  }
  const nonce = event.data.nonce;
  if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) {
    throw new Error(`ACCOUNT_SETTLED_NONCE_INVALID:${String(nonce)}`);
  }
  assertSettlementTokenId(event.data.tokenId, 'AccountSettled');
  return nonce;
};

const applyAccountSettledEvent = (account: AccountDraftReplica, event: JurisdictionEvent): void => {
  if (event.type !== 'AccountSettled') return;
  const { tokenId, collateral, ondelta } = event.data;
  const tokenIdNum = assertSettlementTokenId(tokenId, 'AccountSettled');
  if (!account.state.deltas.has(tokenIdNum)) {
    assertAccountDeltaCapacity(account.state.deltas.size + 1, 'insert');
  }
  const delta = createSettlementDeltaValue(account, tokenIdNum);
  const previousCollateral = delta.collateral;
  delta.collateral = BigInt(collateral);
  delta.ondelta = BigInt(ondelta);
  commitDeltaDraft(account.state, delta);
  const requested = account.state.requestedRebalance?.get(tokenIdNum) ?? 0n;
  const increase = delta.collateral > previousCollateral ? delta.collateral - previousCollateral : 0n;
  if (requested > 0n && increase > 0n) {
    const remaining = requested > increase ? requested - increase : 0n;
    if (remaining > 0n) account.state.requestedRebalance.put(tokenIdNum, remaining);
    else {
      account.state.requestedRebalance.del(tokenIdNum);
      account.state.requestedRebalanceFeeState.del(tokenIdNum);
    }
    account.shadow.rebalance.submittedAtByToken.del(tokenIdNum);
  }
};

const activatePostSettlementProof = (
  account: AccountDraftReplica,
  counterpartyId: string,
  finalizedNonce: number,
  deltaTransformerAddress: string,
): void => {
  const workspace = account.state.settlementWorkspace;
  if (!workspace) return;
  const isSigned = Boolean(
    workspace.settlementHash || workspace.leftHanko || workspace.rightHanko || workspace.postSettlementDisputeProof,
  );
  if (!isSigned) {
    clearFinalizedSettlementWorkspace(account);
    return;
  }
  const signedNonce = workspace.nonceAtSign;
  if (typeof signedNonce !== 'number' || !Number.isSafeInteger(signedNonce) || signedNonce < 1) {
    throw new Error(`SETTLEMENT_SIGNED_NONCE_MISSING:${String(signedNonce)}`);
  }
  if (finalizedNonce < signedNonce) return;
  if (finalizedNonce > signedNonce) {
    clearFinalizedSettlementWorkspace(account);
    return;
  }

  const proof = workspace.postSettlementDisputeProof;
  if (!proof) throw new Error(`POST_SETTLEMENT_PROOF_MISSING:${counterpartyId}`);
  if (proof.nonce !== signedNonce + 1) {
    throw new Error(`POST_SETTLEMENT_PROOF_NONCE_MISMATCH:${proof.nonce}:${signedNonce + 1}`);
  }
  if (!proof.leftHanko || !proof.rightHanko) throw new Error(`POST_SETTLEMENT_PROOF_HANKO_MISSING:${counterpartyId}`);
  if (!proof.disputeHash) throw new Error(`POST_SETTLEMENT_DISPUTE_HASH_MISSING:${counterpartyId}`);
  if (!proof.proofBodyHash) throw new Error(`POST_SETTLEMENT_PROOF_BODY_HASH_MISSING:${counterpartyId}`);
  const finalizedProofBodyHash = buildAccountProofBody(account, deltaTransformerAddress).proofBodyHash;
  if (finalizedProofBodyHash.toLowerCase() !== proof.proofBodyHash.toLowerCase()) {
    throw new Error(
      `POST_SETTLEMENT_FINALIZED_PROOF_BODY_MISMATCH:${proof.proofBodyHash}:${finalizedProofBodyHash}`,
    );
  }

  const localIsLeft = account.proofHeader.fromEntity.toLowerCase() === account.state.leftEntity.toLowerCase();
  const localHanko = localIsLeft ? proof.leftHanko : proof.rightHanko;
  const counterpartyHanko = localIsLeft ? proof.rightHanko : proof.leftHanko;
  const localNonce = Number(account.currentDisputeProofNonce ?? 0);
  const counterpartyNonce = Number(account.counterpartyDisputeProofNonce ?? 0);
  if (localNonce === proof.nonce) {
    if (
      account.currentDisputeProofBodyHash?.toLowerCase() !== proof.proofBodyHash.toLowerCase() ||
      account.currentDisputeProofProposerIsLeft !== proof.proposerIsLeft ||
      account.currentDisputeHash?.toLowerCase() !== proof.disputeHash.toLowerCase()
    ) throw new Error(`POST_SETTLEMENT_LOCAL_PROOF_EQUIVOCATION:${proof.nonce}`);
  } else if (localNonce < proof.nonce) {
    account.currentDisputeProofHanko = localHanko;
    account.currentDisputeProofNonce = proof.nonce;
    account.currentDisputeProofProposerIsLeft = proof.proposerIsLeft;
    account.currentDisputeProofBodyHash = proof.proofBodyHash;
    account.currentDisputeHash = proof.disputeHash;
  }
  if (counterpartyNonce === proof.nonce) {
    if (
      account.counterpartyDisputeProofBodyHash?.toLowerCase() !== proof.proofBodyHash.toLowerCase() ||
      account.counterpartyDisputeProofProposerIsLeft !== proof.proposerIsLeft ||
      account.counterpartyDisputeHash?.toLowerCase() !== proof.disputeHash.toLowerCase()
    ) throw new Error(`POST_SETTLEMENT_COUNTERPARTY_PROOF_EQUIVOCATION:${proof.nonce}`);
  } else if (counterpartyNonce < proof.nonce) {
    account.counterpartyDisputeProofHanko = counterpartyHanko;
    account.counterpartyDisputeProofNonce = proof.nonce;
    account.counterpartyDisputeProofProposerIsLeft = proof.proposerIsLeft;
    account.counterpartyDisputeProofBodyHash = proof.proofBodyHash;
    account.counterpartyDisputeHash = proof.disputeHash;
  }
  // Account settlement and dispute proofs share one on-chain nonce namespace.
  // Once the N+1 recovery proof becomes active, no later settlement may reuse
  // N+1 or an older locally reserved value.
  account.proofHeader.nextProofNonce = Math.max(
    Number(account.proofHeader.nextProofNonce ?? 0),
    proof.nonce + 1,
    Number(account.currentDisputeProofNonce ?? 0) + 1,
    Number(account.counterpartyDisputeProofNonce ?? 0) + 1,
    finalizedNonce + 1,
  );
  clearFinalizedSettlementWorkspace(account);
};

const collectSettledEvents = (
  account: AccountReplica,
  events: readonly JurisdictionEvent[],
): {
  settledEvents: Extract<JurisdictionEvent, { type: 'AccountSettled' }>[];
  finalizedNonce: number;
} | undefined => {
  const settledEvents = events.filter(
    (event): event is Extract<JurisdictionEvent, { type: 'AccountSettled' }> => event.type === 'AccountSettled',
  );
  if (settledEvents.length === 0) return undefined;

  let previousNonce = account.state.jNonce ?? 0;
  let finalizedNonce = previousNonce;
  for (const event of settledEvents) {
    const nonce = assertAccountSettledEvent(account, event);
    if (nonce < previousNonce) {
      throw new Error(`ACCOUNT_SETTLED_NONCE_REGRESSION:${previousNonce}:${nonce}`);
    }
    previousNonce = nonce;
    finalizedNonce = Math.max(finalizedNonce, nonce);
  }
  return { settledEvents, finalizedNonce };
};

const applySettledEventsOnView = (
  account: AccountDraftReplica,
  counterpartyId: string,
  settledEvents: readonly Extract<JurisdictionEvent, { type: 'AccountSettled' }>[],
  finalizedNonce: number,
  deltaTransformerAddress: string,
): void => {
  for (const event of settledEvents) applyAccountSettledEvent(account, event);
  activatePostSettlementProof(account, counterpartyId, finalizedNonce, deltaTransformerAddress);
  account.state.jNonce = finalizedNonce;
};

export const applyFinalizedAccountJEventsOnView = (
  account: AccountDraftReplica,
  counterpartyId: string,
  events: readonly JurisdictionEvent[],
  deltaTransformerAddress: string,
): void => {
  const collected = collectSettledEvents(account, events);
  if (!collected) return;
  applySettledEventsOnView(
    account,
    counterpartyId,
    collected.settledEvents,
    collected.finalizedNonce,
    deltaTransformerAddress,
  );
};

export const applyFinalizedAccountJEvents = (
  account: AccountReplica,
  counterpartyId: string,
  events: readonly JurisdictionEvent[],
  deltaTransformerAddress: string,
): void => {
  const collected = collectSettledEvents(account, events);
  if (!collected) return;

  // J-claim finality is atomic: malformed structural proof data must not leave
  // reserves changed while the workspace/proof transition is rejected.
  const overlay = beginAccountTransition(account);
  try {
    applySettledEventsOnView(
      accountTransitionView(overlay),
      counterpartyId,
      collected.settledEvents,
      collected.finalizedNonce,
      deltaTransformerAddress,
    );
    const committed = publishAccountTransition(account, overlay, 'jFinality');
    jEventFinalityLog.debug('finality.overlay_committed', {
      changedPatriciaNodes: countAccountTransitionNodeChanges(committed.nodeChanges),
      jNonce: collected.finalizedNonce,
    });
  } catch (error) {
    if (overlay.lifecycle.status === 'active') discardAccountTransition(overlay);
    throw error;
  }
};
