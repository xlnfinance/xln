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
import type { AccountSwapOfferCreated } from '../types';
import type { AccountTxRejection } from '../../tx/apply-types';

const accountLog = createStructuredLogger('account');

export type ProposalTransactionEffects = {
  events: string[];
  revealedSecrets: Array<{ secret: string; hashlock: string }>;
  swapOffersCreated: AccountSwapOfferCreated[];
  swapCancelRequests: Array<{ offerId: string; accountId: string }>;
  swapOffersCancelled: Array<{ offerId: string; accountId: string }>;
  failedHtlcLocks: Array<{ hashlock: string; reason: string }>;
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
  rejection: AccountTxRejection | undefined,
): boolean => {
  if (tx.type !== 'settle_transition' || tx.data.kind !== 'seal') return false;
  if (
    rejection?.kind !== 'settlement_seal_nonce_mismatch' ||
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
  if (result.success) {
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
  validTxs.push(preparedTx);
  validMempoolTxs.push(tx);
  effects.events.push(...result.events);
  if (HEAVY_LOGS) {
    accountLog.debug('tx.result', {
      type: tx.type,
      hasSecret: Boolean(result.secret),
      hasHashlock: Boolean(result.hashlock),
    });
  }
  if (result.secret && result.hashlock) {
    effects.revealedSecrets.push({ secret: result.secret, hashlock: result.hashlock });
  }
  if (result.swapOfferCreated) effects.swapOffersCreated.push(result.swapOfferCreated);
  if (result.swapOfferCancelRequested) {
    effects.swapCancelRequests.push({
      ...result.swapOfferCancelRequested,
      accountId: account.proofHeader.toEntity,
    });
  }
  if (result.swapOfferCancelled) effects.swapOffersCancelled.push(result.swapOfferCancelled);
};

const throwCriticalProposalFailure = (
  tx: AccountTx,
  error: string | undefined,
): void => {
  const reason = error || 'validation_failed';
  if (tx.type === 'settle_transition') {
    throw new Error(`SETTLEMENT_TRANSITION_PROPOSAL_FAILED:${tx.data.kind}:${reason}`);
  }
  if (tx.type === 'cross_swap_fill_ack') {
    throw new Error(
      `CROSS_J_FILL_ACK_PROPOSAL_FAILED: offer=${tx.data.offerId} ` +
      `seq=${tx.data.fillSeq} error=${reason}`,
    );
  }
  if (tx.type === 'cross_pull_lock') {
    throw new Error(
      `CROSS_J_PULL_LOCK_PROPOSAL_FAILED: pull=${tx.data.pullId} ` +
      `order=${tx.data.crossJurisdiction.orderId} error=${reason}`,
    );
  }
  if (tx.type === 'swap_offer' && tx.data.crossJurisdiction) {
    throw new Error(
      `CROSS_J_SWAP_OFFER_PROPOSAL_FAILED: offer=${tx.data.offerId} error=${reason}`,
    );
  }
  if (tx.type === 'cross_pull_close') {
    throw new Error(`CROSS_J_PULL_CLOSE_PROPOSAL_FAILED: pull=${tx.data.pullId} error=${reason}`);
  }
  if (tx.type === 'cross_pull_progress') {
    throw new Error(`CROSS_J_PULL_PROGRESS_PROPOSAL_FAILED: pull=${tx.data.pullId} error=${reason}`);
  }
};

const classifyFailedTransaction = (
  machine: AccountReplica,
  applied: AppliedProposalTx,
  effects: ProposalTransactionEffects,
): 'deferred' | 'remove' => {
  const { tx, result } = applied;
  if (
    result.rejection?.kind === 'settlement_signed_account_frozen' ||
    isRefreshableStaleSettlementSeal(machine, tx, result.rejection)
  ) {
    effects.events.push(...result.events);
    accountLog.info('tx.deferred', { type: tx.type, reason: result.error });
    return 'deferred';
  }
  throwCriticalProposalFailure(tx, result.error);
  accountLog.debug('tx.skipped', { type: tx.type, error: result.error || 'unknown' });
  if (tx.type === 'htlc_lock') {
    effects.failedHtlcLocks.push({
      hashlock: tx.data.hashlock,
      reason: result.error || 'validation_failed',
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
    if (!result.result.success) return null;
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
    if (!applied.result.success) {
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
