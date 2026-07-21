import type { AccountMachine, JurisdictionEvent } from '../../types';
import { getDefaultCreditLimit } from '../../account/utils';
import {
  canonicalJurisdictionEventKey,
  compareCanonicalJurisdictionEvents,
  normalizeJurisdictionEvents,
} from '../../jurisdiction/event-normalization';
import type { JEventClaimTx, JEventMempoolOp } from './j-events-types';
import { clearFinalizedSettlementWorkspace } from '../../account/tx/handlers/settle-transition';
import { buildAccountProofBody } from '../../protocol/dispute/proof-builder';
import { invalidateAccountMapCommitment } from '../../account/map-commitment';

const isJEventClaimOp = (op: JEventMempoolOp): op is { accountId: string; tx: JEventClaimTx } =>
  op.tx.type === 'j_event_claim';

const normalizedEntityId = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const assertAccountSettledEvent = (
  account: AccountMachine,
  event: Extract<JurisdictionEvent, { type: 'AccountSettled' }>,
): number => {
  const left = normalizedEntityId(event.data.leftEntity);
  const right = normalizedEntityId(event.data.rightEntity);
  if (left !== account.leftEntity.toLowerCase() || right !== account.rightEntity.toLowerCase()) {
    throw new Error(
      `ACCOUNT_SETTLED_PAIR_MISMATCH:${left}:${right}:${account.leftEntity.toLowerCase()}:${account.rightEntity.toLowerCase()}`,
    );
  }
  const nonce = event.data.nonce;
  if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) {
    throw new Error(`ACCOUNT_SETTLED_NONCE_INVALID:${String(nonce)}`);
  }
  const tokenId = Number(event.data.tokenId);
  if (!Number.isSafeInteger(tokenId) || tokenId < 0) {
    throw new Error(`ACCOUNT_SETTLED_TOKEN_INVALID:${String(event.data.tokenId)}`);
  }
  return nonce;
};

const applyAccountSettledEvent = (account: AccountMachine, event: JurisdictionEvent): void => {
  if (event.type !== 'AccountSettled') return;
  const { tokenId, collateral, ondelta } = event.data;
  const tokenIdNum = Number(tokenId);
  let delta = account.deltas.get(tokenIdNum);
  if (!delta) {
    const limit = getDefaultCreditLimit(tokenIdNum);
    delta = {
      tokenId: tokenIdNum,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: limit,
      rightCreditLimit: limit,
      leftAllowance: 0n,
      rightAllowance: 0n,
    };
    account.deltas.set(tokenIdNum, delta);
  }
  const previousCollateral = delta.collateral;
  delta.collateral = BigInt(collateral);
  delta.ondelta = BigInt(ondelta);
  const requested = account.requestedRebalance?.get(tokenIdNum) ?? 0n;
  const increase = delta.collateral > previousCollateral ? delta.collateral - previousCollateral : 0n;
  if (requested > 0n && increase > 0n) {
    const remaining = requested > increase ? requested - increase : 0n;
    if (remaining > 0n) account.requestedRebalance.set(tokenIdNum, remaining);
    else {
      account.requestedRebalance.delete(tokenIdNum);
      account.requestedRebalanceFeeState?.delete(tokenIdNum);
    }
    account.shadow.rebalance.submittedAtByToken.delete(tokenIdNum);
  }
  invalidateAccountMapCommitment(account, 'deltas', tokenIdNum);
};

const activatePostSettlementProof = (
  account: AccountMachine,
  counterpartyId: string,
  finalizedNonce: number,
  deltaTransformerAddress: string,
): void => {
  const workspace = account.settlementWorkspace;
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

  const localIsLeft = account.proofHeader.fromEntity.toLowerCase() === account.leftEntity.toLowerCase();
  const localHanko = localIsLeft ? proof.leftHanko : proof.rightHanko;
  const counterpartyHanko = localIsLeft ? proof.rightHanko : proof.leftHanko;
  const localNonce = Number(account.currentDisputeProofNonce ?? 0);
  const counterpartyNonce = Number(account.counterpartyDisputeProofNonce ?? 0);
  if (localNonce === proof.nonce) {
    if (
      account.currentDisputeProofBodyHash?.toLowerCase() !== proof.proofBodyHash.toLowerCase() ||
      account.currentDisputeHash?.toLowerCase() !== proof.disputeHash.toLowerCase()
    ) throw new Error(`POST_SETTLEMENT_LOCAL_PROOF_EQUIVOCATION:${proof.nonce}`);
  } else if (localNonce < proof.nonce) {
    account.currentDisputeProofHanko = localHanko;
    account.currentDisputeProofNonce = proof.nonce;
    account.currentDisputeProofBodyHash = proof.proofBodyHash;
    account.currentDisputeHash = proof.disputeHash;
  }
  if (counterpartyNonce === proof.nonce) {
    if (
      account.counterpartyDisputeProofBodyHash?.toLowerCase() !== proof.proofBodyHash.toLowerCase() ||
      account.counterpartyDisputeHash?.toLowerCase() !== proof.disputeHash.toLowerCase()
    ) throw new Error(`POST_SETTLEMENT_COUNTERPARTY_PROOF_EQUIVOCATION:${proof.nonce}`);
  } else if (counterpartyNonce < proof.nonce) {
    account.counterpartyDisputeProofHanko = counterpartyHanko;
    account.counterpartyDisputeProofNonce = proof.nonce;
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
  account.disputeProofNoncesByHash ??= {};
  account.disputeProofNoncesByHash[proof.proofBodyHash] = proof.nonce;
  clearFinalizedSettlementWorkspace(account);
};

export const applyFinalizedAccountJEvents = (
  account: AccountMachine,
  counterpartyId: string,
  events: readonly JurisdictionEvent[],
  deltaTransformerAddress: string,
): void => {
  const settledEvents = events.filter(
    (event): event is Extract<JurisdictionEvent, { type: 'AccountSettled' }> => event.type === 'AccountSettled',
  );
  if (settledEvents.length === 0) return;

  let previousNonce = account.jNonce ?? 0;
  let finalizedNonce = previousNonce;
  for (const event of settledEvents) {
    const nonce = assertAccountSettledEvent(account, event);
    if (nonce < previousNonce) {
      throw new Error(`ACCOUNT_SETTLED_NONCE_REGRESSION:${previousNonce}:${nonce}`);
    }
    previousNonce = nonce;
    finalizedNonce = Math.max(finalizedNonce, nonce);
  }

  // J-claim finality is atomic: malformed structural proof data must not leave
  // reserves changed while the workspace/proof transition is rejected.
  const staged = structuredClone(account);
  for (const event of settledEvents) applyAccountSettledEvent(staged, event);
  activatePostSettlementProof(staged, counterpartyId, finalizedNonce, deltaTransformerAddress);
  staged.jNonce = finalizedNonce;
  Object.assign(account, staged);
  if (!staged.settlementWorkspace) delete account.settlementWorkspace;
};

export function mergeJEventClaimOps(ops: JEventMempoolOp[]): void {
  const groups = new Map<string, number>();
  for (let index = 0; index < ops.length;) {
    const op = ops[index];
    if (!op) {
      ops.splice(index, 1);
      continue;
    }
    if (!isJEventClaimOp(op)) {
      index += 1;
      continue;
    }
    const key = `${op.accountId.toLowerCase()}:${op.tx.data.jHeight}:${op.tx.data.jBlockHash.toLowerCase()}`;
    const targetIndex = groups.get(key);
    if (targetIndex === undefined) {
      groups.set(key, index);
      index += 1;
      continue;
    }
    const target = ops[targetIndex];
    if (!target || !isJEventClaimOp(target)) throw new Error(`ACCOUNT_J_CLAIM_MERGE_TARGET_MISSING:${key}`);
    target.tx.data.events.push(...normalizeJurisdictionEvents(op.tx.data.events));
    ops.splice(index, 1);
  }
  for (const op of ops) {
    if (!isJEventClaimOp(op)) continue;
    const events = normalizeJurisdictionEvents(op.tx.data.events).sort(compareCanonicalJurisdictionEvents);
    const keys = events.map(canonicalJurisdictionEventKey);
    if (new Set(keys).size !== keys.length) throw new Error('ACCOUNT_J_CLAIM_EVENT_DUPLICATE');
    op.tx.data.events = events;
  }
  const claims = ops.filter(isJEventClaimOp).sort((left, right) => (
    left.accountId.localeCompare(right.accountId)
      || left.tx.data.jHeight - right.tx.data.jHeight
      || left.tx.data.jBlockHash.localeCompare(right.tx.data.jBlockHash)
  ));
  let claimIndex = 0;
  for (let index = 0; index < ops.length; index += 1) {
    if (isJEventClaimOp(ops[index]!)) ops[index] = claims[claimIndex++]!;
  }
}
