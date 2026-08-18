import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import type { AccountReplica, AccountTx } from '../../../types/account';
import { prependUniqueMempoolTxs } from '../helpers';
import { discardPendingProposalReplica } from '../../state/pending-proposal-replica';
import { createStructuredLogger } from '../../../support/logger';

const disputePolicyLog = createStructuredLogger('account.dispute-policy');

/**
 * Account dispute freeze policy.
 *
 * The prepare-dispute phase is a local-only quarantine before any on-chain
 * dispute hash is committed. Account consensus is already frozen: optional
 * evidence remains in the Account mempool and never creates another Account
 * frame on top of the last mutually signed ProofBody.
 *
 * Once disputeStart is queued or observed on-chain, calldata hashes are already
 * committed. From that point even evidence updates must stop changing account
 * state; only jurisdiction-event bookkeeping is allowed. Finalized disputed
 * Accounts remain permanently closed; recovery requires a future, separately
 * domain-separated bilateral protocol rather than ordinary Account traffic.
 */

const isAccountControlTx = (txType: string): boolean =>
  txType === 'j_event_claim';

const isEvidenceBearingAccountTx = (tx: AccountTx): boolean => {
  if (tx.type === 'cross_pull_close') return typeof tx.data.binary === 'string' && Boolean(tx.data.proof);
  return false;
};

const isDisputeEvidenceAccountTx = (txOrType: AccountTx | string): boolean => {
  if (typeof txOrType === 'string') {
    return txOrType === 'cross_pull_close' || txOrType === 'swap_resolve';
  }
  return txOrType.type === 'swap_resolve' || isEvidenceBearingAccountTx(txOrType);
};

export const freezeAccountForDispute = (
  account: AccountReplica,
  retainOptionalEvidence: boolean,
): void => {
  const retainDeferredClaims = account.status === 'dispute_preparing';
  const pendingRetained = (account.pendingFrame?.accountTxs ?? []).filter((tx) => (
    (retainDeferredClaims && isAccountControlTx(tx.type)) ||
    (retainOptionalEvidence && isDisputeEvidenceAccountTx(tx))
  ));
  account.mempool = (account.mempool || []).filter((tx) => (
    (retainDeferredClaims && isAccountControlTx(tx.type)) ||
    (retainOptionalEvidence && isDisputeEvidenceAccountTx(tx))
  ));
  // A locally proposed frame is not mutually signed state, but a unilateral
  // resolve inside it is still valid transformer evidence. A J claim is also
  // restored only while preparation can return to active; after the Account is
  // permanently disputed, on-chain finality owns the economics and retaining
  // an unprocessable claim would prevent Runtime quiescence.
  prependUniqueMempoolTxs(account, pendingRetained);
  disputePolicyLog.info('freeze', {
    leftEntity: account.state.leftEntity,
    rightEntity: account.state.rightEntity,
    status: account.status,
    retainOptionalEvidence,
    retainDeferredClaims,
    restoredPendingEvidence: pendingRetained.map(tx => tx.type),
    retainedMempool: account.mempool.map(tx => tx.type),
  });
  // The candidate is not mutually committed state. Dispute always starts from
  // the last signed ProofBody; late proposal/ACK traffic is rejected at ingress.
  delete account.pendingFrame;
  delete account.pendingAccountInput;
  discardPendingProposalReplica(account);
  account.rollbackCount = 0;
  delete account.lastRollbackFrameHash;
};

export const returnPreparedAccountToActive = (account: AccountReplica): void => {
  if (account.status !== 'dispute_preparing') {
    throw new Error(`ACCOUNT_DISPUTE_PREPARATION_RETURN_INVALID:${account.status ?? 'active'}`);
  }
  // Preserve deferred J claims while the preparation fence still owns them,
  // then reopen the ordinary proposal lane. Reversing this order would make
  // freezeAccountForDispute classify the claims as terminal and drop them.
  freezeAccountForDispute(account, false);
  account.status = 'active';
  delete account.disputePrepare;
};

export const isDisputeStartedByLeft = (
  starterEntityId: string,
  leftEntityId: string,
  rightEntityId: string,
): boolean => {
  const starter = String(starterEntityId || '').toLowerCase();
  const left = String(leftEntityId || '').toLowerCase();
  const right = String(rightEntityId || '').toLowerCase();
  if (!starter || !left || !right) throw haltRuntimeFailure("DISPUTE_PARTY_ID_MISSING", 'DISPUTE_PARTY_ID_MISSING');
  if (starter === left) return true;
  if (starter === right) return false;
  // Depository disputes are bilateral. Inferring a side for a third-party id
  // creates a second ordering rule unrelated to the signed Account parties.
  throw haltRuntimeFailure("DISPUTE_STARTER_NOT_A_PARTY", `DISPUTE_STARTER_NOT_A_PARTY:${starter}`);
};

export const canProcessAccountTxForDisputeStatus = (
  status: string | undefined,
): boolean => {
  const normalized = status ?? 'active';
  if (normalized === 'active') return true;
  // Local preparation has no peer ACK path. J claims remain durable in the
  // Account mempool and become proposable only if preparation returns active.
  // Once DisputeStarted is final, no Account transaction has a consumer.
  return false;
};
