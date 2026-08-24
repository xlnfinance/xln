import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import type { AccountOutput, AccountReplica, AccountTx } from '../../../types/account';
import type { AccountDraftReplica } from '../../state/account-state-draft';
import type { AccountConsensusContext } from '../context';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
  discardAccountTransition,
} from '../../state/candidate-overlay';
import { isLeftEntity } from '../../utils';
import { HEAVY_LOGS } from '../../../support/debug-flags';
import { applyAccountTx } from '../../tx/apply';
import { createStructuredLogger, shortHash } from '../../../support/logger';
import {
  getAccountStateDomain,
} from '../helpers';
import { createAccountJClaimSession } from '../../j-claims/j-claim-session';
import { prepareAccountJClaimTx } from '../../j-claims/j-claim-transition';
import type { AccountJClaimNodeStore } from '../../../types/finance/account-j-claims';
import { getNextSettlementNonce } from '../../../protocol/settlement/operations';
import type { AccountFailedHtlcLock, AccountSwapOfferCreated } from '../types';
import {
  ACCOUNT_TX_FAILURE_DISPOSITIONS,
  type ApplyAccountTxOk,
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
  /** Commit-time effects of the validated txs, kept for the prepared ACK commit. */
  candidateEffects: AccountOutput[];
  /** Exact successful result for each committed tx, in AccountFrame order. */
  txResults: ApplyAccountTxOk[];
  timedOutHashlocks: string[];
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
  candidateEffects: [],
  txResults: [],
  timedOutHashlocks: [],
});

/**
 * One overlay for a multi-tx Account proposal. Mixed HLT sequences swap then
 * payment per user adapter; Hub may still see both in one Entity proposal.
 * If both txs share a proposal window, keep one overlay; the old swap-only
 * predicate fell back to begin/commit per tx.
 * A failed tx still discards the whole overlay and retries per-tx.
 */
const OPTIMISTIC_ACCOUNT_TX_TYPES = new Set<AccountTx['type']>([
  'swap_resolve',
  'cross_swap_fill_ack',
  'cross_pull_lock',
  'swap_offer',
  'htlc_lock',
  'htlc_resolve',
  'direct_payment',
]);

export const proposalWindowCanUseOptimisticBatch = (txs: readonly AccountTx[]): boolean =>
  txs.length > 1 && txs.every(tx => OPTIMISTIC_ACCOUNT_TX_TYPES.has(tx.type));

const shouldUseOptimisticProposalBatch = (txs: readonly AccountTx[]): boolean =>
  proposalWindowCanUseOptimisticBatch(txs);

const isRefreshableStaleSettlementHanko = (
  account: AccountReplica,
  tx: AccountTx,
  rejection: AccountTxRejection,
): boolean => {
  if (tx.type !== 'settle_transition' || tx.data.kind !== 'hanko') return false;
  if (
    rejection.kind !== 'settlement_hanko_nonce_mismatch' ||
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
  machine: AccountDraftReplica,
  tx: AccountTx,
  jClaimSession: ReturnType<typeof createAccountJClaimSession>,
): Promise<AppliedProposalTx> => {
  const preparedTx = tx.type === 'j_event_claim'
    ? prepareAccountJClaimTx(machine.state, tx, getAccountStateDomain(machine.state), jClaimSession)
    : tx;
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
  effects.txResults.push(result);
  effects.events.push(...result.events);
  effects.candidateEffects.push(...(result.candidateEffects ?? []));
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
      effects.timedOutHashlocks.push(result.hashlock);
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
  // swap_resolve is emitted only by the deterministic matcher. Rejecting it
  // as ordinary user input would commit the already-matched book while
  // silently discarding its bilateral settlement, permanently diverging the
  // cache from Account authority. Fail the isolated Entity candidate instead.
  if (tx.type === 'swap_resolve') {
    throw haltRuntimeFailure(
      'SWAP_RESOLVE_PROPOSAL_FAILED',
      `SWAP_RESOLVE_PROPOSAL_FAILED: offer=${tx.data.offerId} error=${reason}`,
    );
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
    rejection.kind === 'htlc_lock_capacity' ||
    isRefreshableStaleSettlementHanko(account, tx, rejection)
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
  accountLog.warn('frame.validation_failed', {
    txType: tx.type,
    rejection: result.rejection,
  });
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
  const transition = beginAccountTransition(context.account);
  const machine = accountTransitionView(transition);
  const applied: AppliedProposalTx[] = [];
  try {
    for (const tx of context.proposalWindow) {
      if (HEAVY_LOGS) accountLog.debug('batch.optimistic_tx', { type: tx.type });
      const result = await applyProposalTransaction(context, machine, tx, jClaimSession);
      if (!result.result.ok) {
        discardAccountTransition(transition);
        return null;
      }
      applied.push(result);
    }
    return { machine: commitAccountTransition(transition, 'proposalBatch').account, applied };
  } catch (error) {
    discardAccountTransition(transition);
    throw error;
  }
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

  let clonedMachine = context.account;
  for (const tx of context.proposalWindow) {
    if (HEAVY_LOGS) accountLog.debug('tx.process', { type: tx.type });
    const transition = beginAccountTransition(clonedMachine);
    const txMachine = accountTransitionView(transition);
    let applied: AppliedProposalTx;
    try {
      applied = await applyProposalTransaction(context, txMachine, tx, jClaimSession);
    } catch (error) {
      discardAccountTransition(transition);
      throw error;
    }
    if (!applied.result.ok) {
      discardAccountTransition(transition);
      const disposition = classifyFailedTransaction(clonedMachine, applied, effects);
      if (disposition === 'deferred') deferredTxCount += 1;
      else txsToRemove.push(tx);
      continue;
    }
    clonedMachine = commitAccountTransition(transition, 'proposalTx').account;
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
