import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import type { AccountReplica, AccountTx } from '../../../types/account';
import type { AccountConsensusContext } from '../context';
import { cloneAccountReplica } from '../../state/state-clone';
import { isLeftEntity } from '../../utils';
import { HEAVY_LOGS } from '../../../infra/debug-flags';
import { applyAccountTx } from '../../tx/apply';
import { createStructuredLogger, shortHash } from '../../../infra/logger';
import {
  assertNoUnilateralSettlementMutation,
  captureSettlementVector,
  getAccountStateDomain,
} from '../helpers';
import { createAccountJClaimSession } from '../../j-claims/j-claim-session';
import { prepareAccountJClaimTx } from '../../j-claims/j-claim-transition';
import type { AccountJClaimNodeStore } from '../../../types/finance/account-j-claims';
import { getNextSettlementNonce } from '../../../protocol/settlement/operations';
import type { AccountFailedHtlcLock, AccountSwapOfferCreated } from '../types';
import {
  ACCOUNT_TX_FAILURE_DISPOSITIONS,
  type AccountTxFailureDisposition,
  type AccountTxRejection,
} from '../../tx/apply-types';
import { accountTxRejectionMessage, assertNever } from '../../tx/apply-result';

const accountLog = createStructuredLogger('account');

export type ProposalTransactionEffects = {
  events: string[];
  revealedSecrets: Array<{ secret: string; hashlock: string }>;
  swapOffersCreated: AccountSwapOfferCreated[];
  swapCancelRequests: Array<{ offerId: string; accountId: string }>;
  swapOffersCancelled: Array<{ offerId: string; accountId: string }>;
  failedHtlcLocks: AccountFailedHtlcLock[];
};

export type ValidatedProposalTransactions = ProposalTransactionEffects & {
  clonedMachine: AccountReplica;
  validTxs: AccountTx[];
  validMempoolTxs: AccountTx[];
  txsToRemove: AccountTx[];
  deferredTxCount: number;
  optimisticBatch: boolean;
};

type ProposalTransactionContext = {
  consensusContext: AccountConsensusContext;
  account: AccountReplica;
  proposalWindow: readonly AccountTx[];
  frameTimestamp: number;
  frameJHeight: number;
  jClaimNodeStore?: AccountJClaimNodeStore;
};

type AppliedProposalTx = {
  tx: AccountTx;
  preparedTx: AccountTx;
  result: Awaited<ReturnType<typeof applyAccountTx>>;
};

const createTransactionEffects = (): ProposalTransactionEffects => ({
  events: [],
  revealedSecrets: [],
  swapOffersCreated: [],
  swapCancelRequests: [],
  swapOffersCancelled: [],
  failedHtlcLocks: [],
});

const shouldUseOptimisticProposalBatch = (txs: readonly AccountTx[]): boolean =>
  txs.length > 1 &&
  txs.every(tx =>
    tx.type === 'swap_resolve' ||
    tx.type === 'cross_swap_fill_ack' ||
    tx.type === 'cross_pull_lock' ||
    tx.type === 'swap_offer');

const isRefreshableStaleSettlementSeal = (
  account: AccountReplica,
  tx: AccountTx,
  rejection: AccountTxRejection,
): boolean => {
  if (tx.type !== 'settle_transition' || tx.data.kind !== 'seal') return false;
  if (
    rejection.kind !== 'settlement_seal_nonce_mismatch' ||
    rejection.basis !== 'account'
  ) {
    return false;
  }
  const workspace = account.state.settlementWorkspace;
  const requiredNonce = getNextSettlementNonce(account);
  return Boolean(
    workspace &&
    workspace.nonceAtSign === undefined &&
    tx.data.revision === workspace.revision &&
    tx.data.workspaceHash.toLowerCase() === workspace.workspaceHash.toLowerCase() &&
    rejection.suppliedNonce === tx.data.settlementNonce &&
    rejection.requiredNonce === requiredNonce &&
    rejection.suppliedNonce !== requiredNonce,
  );
};

const applyProposalTransaction = async (
  context: ProposalTransactionContext,
  machine: AccountReplica,
  tx: AccountTx,
  jClaimSession: ReturnType<typeof createAccountJClaimSession>,
): Promise<AppliedProposalTx> => {
  const preparedTx = tx.type === 'j_event_claim'
    ? prepareAccountJClaimTx(machine.state, tx, getAccountStateDomain(machine.state), jClaimSession)
    : tx;
  const beforeSettlement = captureSettlementVector(machine);
  const result = await applyAccountTx(
    machine,
    preparedTx,
    isLeftEntity(context.account.proofHeader.fromEntity, context.account.proofHeader.toEntity),
    context.frameTimestamp,
    context.frameJHeight,
    true,
    context.consensusContext,
    jClaimSession,
  );
  if (result.ok) {
    assertNoUnilateralSettlementMutation(machine, beforeSettlement, preparedTx, 'propose/validate');
  }
  return { tx, preparedTx, result };
};

const collectSuccessfulTransaction = (
  account: AccountReplica,
  effects: ProposalTransactionEffects,
  validTxs: AccountTx[],
  validMempoolTxs: AccountTx[],
  applied: AppliedProposalTx,
): void => {
  const { tx, preparedTx, result } = applied;
  if (!result.ok) throw new Error('ACCOUNT_TX_COLLECT_REJECTED');
  validTxs.push(preparedTx);
  validMempoolTxs.push(tx);
  effects.events.push(...result.events);
  if (HEAVY_LOGS) {
    accountLog.debug('tx.result', {
      type: tx.type,
      outcome: result.outcome,
    });
  }
  switch (result.outcome) {
    case 'applied':
      return;
    case 'htlc_secret':
      effects.revealedSecrets.push({ secret: result.secret, hashlock: result.hashlock });
      return;
    case 'htlc_error':
      return;
    case 'swap_offer_created':
      effects.swapOffersCreated.push(result.swapOfferCreated);
      return;
    case 'swap_cancel_requested':
      effects.swapCancelRequests.push({
        ...result.swapOfferCancelRequested,
        accountId: account.proofHeader.toEntity,
      });
      return;
    case 'swap_cancelled':
      effects.swapOffersCancelled.push(result.swapOfferCancelled);
      return;
    default:
      assertNever(result);
  }
};

const throwCriticalProposalFailure = (
  tx: AccountTx,
  rejection: AccountTxRejection,
): void => {
  const reason = accountTxRejectionMessage(rejection);
  if (tx.type === 'settle_transition') {
    throw new Error(`SETTLEMENT_TRANSITION_PROPOSAL_FAILED:${tx.data.kind}:${reason}`);
  }
  if (tx.type === 'cross_swap_fill_ack') {
    throw haltRuntimeFailure("CROSS_J_FILL_ACK_PROPOSAL_FAILED", `CROSS_J_FILL_ACK_PROPOSAL_FAILED: offer=${tx.data.offerId} ` +
      `seq=${tx.data.fillSeq} error=${reason}`);
  }
  if (tx.type === 'cross_pull_lock') {
    throw haltRuntimeFailure("CROSS_J_PULL_LOCK_PROPOSAL_FAILED", `CROSS_J_PULL_LOCK_PROPOSAL_FAILED: pull=${tx.data.pullId} ` +
      `order=${tx.data.crossJurisdiction.orderId} error=${reason}`);
  }
  if (tx.type === 'swap_offer' && tx.data.crossJurisdiction) {
    throw haltRuntimeFailure("CROSS_J_SWAP_OFFER_PROPOSAL_FAILED", `CROSS_J_SWAP_OFFER_PROPOSAL_FAILED: offer=${tx.data.offerId} error=${reason}`);
  }
  if (tx.type === 'cross_pull_close') {
    throw haltRuntimeFailure("CROSS_J_PULL_CLOSE_PROPOSAL_FAILED", `CROSS_J_PULL_CLOSE_PROPOSAL_FAILED: pull=${tx.data.pullId} error=${reason}`);
  }
  if (tx.type === 'cross_pull_progress') {
    throw haltRuntimeFailure("CROSS_J_PULL_PROGRESS_PROPOSAL_FAILED", `CROSS_J_PULL_PROGRESS_PROPOSAL_FAILED: pull=${tx.data.pullId} error=${reason}`);
  }
};

const proposalFailureDisposition = (
  account: AccountReplica,
  tx: AccountTx,
  rejection: AccountTxRejection,
): Extract<AccountTxFailureDisposition, 'retry' | 'reject'> => {
  if (
    rejection.kind === 'settlement_signed_account_frozen' ||
    isRefreshableStaleSettlementSeal(account, tx, rejection)
  ) {
    return ACCOUNT_TX_FAILURE_DISPOSITIONS.retry;
  }
  return ACCOUNT_TX_FAILURE_DISPOSITIONS.reject;
};

const classifyFailedTransaction = (
  machine: AccountReplica,
  applied: AppliedProposalTx,
  effects: ProposalTransactionEffects,
): 'deferred' | 'remove' => {
  const { tx, result } = applied;
  if (result.ok) throw new Error('ACCOUNT_TX_PROPOSAL_CLASSIFY_OK');
  const disposition = proposalFailureDisposition(machine, tx, result.rejection);
  if (disposition === ACCOUNT_TX_FAILURE_DISPOSITIONS.retry) {
    effects.events.push(...result.events);
    accountLog.info('tx.deferred', { type: tx.type, reason: result.rejection.message });
    return 'deferred';
  }
  throwCriticalProposalFailure(tx, result.rejection);
  accountLog.debug('tx.skipped', { type: tx.type, error: result.rejection.message });
  if (tx.type === 'htlc_lock') {
    effects.failedHtlcLocks.push({
      hashlock: tx.data.hashlock,
      reason: result.rejection.message,
    });
    accountLog.debug('htlc_lock.cancel_queued', { hashlock: shortHash(tx.data.hashlock) });
  }
  return 'remove';
};

const validateOptimisticBatch = async (
  context: ProposalTransactionContext,
  jClaimSession: ReturnType<typeof createAccountJClaimSession>,
): Promise<{ machine: AccountReplica; applied: AppliedProposalTx[] } | null> => {
  if (!shouldUseOptimisticProposalBatch(context.proposalWindow)) return null;
  const machine = cloneAccountReplica(context.account);
  const applied: AppliedProposalTx[] = [];
  for (const tx of context.proposalWindow) {
    if (HEAVY_LOGS) accountLog.debug('batch.optimistic_tx', { type: tx.type });
    const result = await applyProposalTransaction(context, machine, tx, jClaimSession);
    if (!result.result.ok) return null;
    applied.push(result);
  }
  return { machine, applied };
};

export const validateProposalTransactions = async (
  context: ProposalTransactionContext,
): Promise<ValidatedProposalTransactions> => {
  if (!context.jClaimNodeStore) {
    throw new Error('ACCOUNT_J_CLAIM_NODE_STORE_REQUIRED');
  }
  const effects = createTransactionEffects();
  const validTxs: AccountTx[] = [];
  const validMempoolTxs: AccountTx[] = [];
  const txsToRemove: AccountTx[] = [];
  let deferredTxCount = 0;
  const jClaimSession = createAccountJClaimSession(context.jClaimNodeStore);
  const optimistic = await validateOptimisticBatch(context, jClaimSession);
  if (optimistic) {
    for (const applied of optimistic.applied) {
      collectSuccessfulTransaction(
        context.account,
        effects,
        validTxs,
        validMempoolTxs,
        applied,
      );
    }
    return {
      ...effects,
      clonedMachine: optimistic.machine,
      validTxs,
      validMempoolTxs,
      txsToRemove,
      deferredTxCount,
      optimisticBatch: true,
    };
  }

  let clonedMachine = cloneAccountReplica(context.account);
  for (const tx of context.proposalWindow) {
    if (HEAVY_LOGS) accountLog.debug('tx.process', { type: tx.type });
    const txMachine = cloneAccountReplica(clonedMachine);
    const applied = await applyProposalTransaction(context, txMachine, tx, jClaimSession);
    if (!applied.result.ok) {
      const disposition = classifyFailedTransaction(clonedMachine, applied, effects);
      if (disposition === 'deferred') deferredTxCount += 1;
      else txsToRemove.push(tx);
      continue;
    }
    clonedMachine = txMachine;
    collectSuccessfulTransaction(
      context.account,
      effects,
      validTxs,
      validMempoolTxs,
      applied,
    );
  }
  return {
    ...effects,
    clonedMachine,
    validTxs,
    validMempoolTxs,
    txsToRemove,
    deferredTxCount,
    optimisticBatch: false,
  };
};
