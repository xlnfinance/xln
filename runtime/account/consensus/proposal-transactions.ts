import type { AccountState, AccountTx, RuntimeState } from '../../types';
import { cloneAccountState } from '../../state-helpers';
import { isLeft } from '../utils';
import { HEAVY_LOGS } from '../../utils';
import { applyAccountTx } from '../tx/apply';
import { createStructuredLogger, shortHash } from '../../infra/logger';
import {
  assertNoUnilateralSettlementMutation,
  captureSettlementVector,
  getAccountStateDomain,
} from './helpers';
import { createAccountJClaimSession } from '../j-claim-session';
import { prepareAccountJClaimTx } from '../j-claim-transition';
import type { AccountJClaimNodeStore } from '../../types/account-j-claims';
import { getNextSettlementNonce } from '../../protocol/settlement/operations';
import type { AccountSwapOfferCreated } from './types';

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
  clonedMachine: AccountState;
  validTxs: AccountTx[];
  validMempoolTxs: AccountTx[];
  txsToRemove: AccountTx[];
  deferredTxCount: number;
  optimisticBatch: boolean;
};

type ProposalTransactionContext = {
  env: RuntimeState;
  account: AccountState;
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
    tx.type === 'pull_lock' ||
    tx.type === 'swap_offer');

const isCrossJurisdictionPullResolveTx = (
  account: AccountState,
  tx: AccountTx,
): tx is Extract<AccountTx, { type: 'pull_resolve' }> => {
  if (tx.type !== 'pull_resolve') return false;
  if (account.pulls?.get(tx.data.pullId)?.crossJurisdiction) return true;
  for (const offer of account.swapOffers?.values() ?? []) {
    const route = offer.crossJurisdiction;
    if (
      route?.sourcePull?.pullId === tx.data.pullId ||
      route?.targetPull?.pullId === tx.data.pullId
    ) return true;
  }
  return false;
};

const isRefreshableStaleSettlementSeal = (
  account: AccountState,
  tx: AccountTx,
  error: string | undefined,
): boolean => {
  if (tx.type !== 'settle_transition' || tx.data.kind !== 'seal') return false;
  if (!error?.startsWith(`SETTLEMENT_SEAL_NONCE_MISMATCH:${tx.data.settlementNonce}:`)) {
    return false;
  }
  const workspace = account.settlementWorkspace;
  return Boolean(
    workspace &&
    workspace.nonceAtSign === undefined &&
    tx.data.version === workspace.version &&
    tx.data.workspaceHash.toLowerCase() === workspace.workspaceHash.toLowerCase() &&
    tx.data.settlementNonce !== getNextSettlementNonce(account),
  );
};

const applyProposalTransaction = async (
  context: ProposalTransactionContext,
  machine: AccountState,
  tx: AccountTx,
  jClaimSession: ReturnType<typeof createAccountJClaimSession>,
): Promise<AppliedProposalTx> => {
  const preparedTx = tx.type === 'j_event_claim'
    ? prepareAccountJClaimTx(machine, tx, getAccountStateDomain(machine), jClaimSession)
    : tx;
  const beforeSettlement = captureSettlementVector(machine);
  const result = await applyAccountTx(
    machine,
    preparedTx,
    isLeft(context.account.proofHeader.fromEntity, context.account.proofHeader.toEntity),
    context.frameTimestamp,
    context.frameJHeight,
    true,
    context.env,
    jClaimSession,
  );
  if (result.success) {
    assertNoUnilateralSettlementMutation(machine, beforeSettlement, preparedTx, 'propose/validate');
  }
  return { tx, preparedTx, result };
};

const collectSuccessfulTransaction = (
  account: AccountState,
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
  account: AccountState,
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
  if (tx.type === 'pull_lock' && tx.data.crossJurisdiction) {
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
  if (isCrossJurisdictionPullResolveTx(account, tx)) {
    throw new Error(`CROSS_J_PULL_RESOLVE_PROPOSAL_FAILED: pull=${tx.data.pullId} error=${reason}`);
  }
  if (tx.type === 'cross_pull_close') {
    throw new Error(`CROSS_J_PULL_CLOSE_PROPOSAL_FAILED: pull=${tx.data.pullId} error=${reason}`);
  }
};

const classifyFailedTransaction = (
  context: ProposalTransactionContext,
  machine: AccountState,
  applied: AppliedProposalTx,
  effects: ProposalTransactionEffects,
): 'deferred' | 'remove' => {
  const { tx, result } = applied;
  if (
    result.error?.startsWith('SETTLEMENT_SIGNED_ACCOUNT_FROZEN:') ||
    isRefreshableStaleSettlementSeal(machine, tx, result.error)
  ) {
    effects.events.push(...result.events);
    accountLog.info('tx.deferred', { type: tx.type, reason: result.error });
    return 'deferred';
  }
  throwCriticalProposalFailure(context.account, tx, result.error);
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
): Promise<{ machine: AccountState; applied: AppliedProposalTx[] } | null> => {
  if (!shouldUseOptimisticProposalBatch(context.proposalWindow)) return null;
  const machine = cloneAccountState(context.account);
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
  const effects = createTransactionEffects();
  const validTxs: AccountTx[] = [];
  const validMempoolTxs: AccountTx[] = [];
  const txsToRemove: AccountTx[] = [];
  let deferredTxCount = 0;
  const jClaimSession = createAccountJClaimSession(context.env, context.jClaimNodeStore);
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

  let clonedMachine = cloneAccountState(context.account);
  for (const tx of context.proposalWindow) {
    if (HEAVY_LOGS) accountLog.debug('tx.process', { type: tx.type });
    const txMachine = cloneAccountState(clonedMachine);
    const applied = await applyProposalTransaction(context, txMachine, tx, jClaimSession);
    if (!applied.result.success) {
      const disposition = classifyFailedTransaction(context, clonedMachine, applied, effects);
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
