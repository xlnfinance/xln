import type { AccountReplica, AccountTx } from '../../types/account';
import type { AccountOutput } from '../../types/account';
import type { AccountConsensusContext } from '../consensus/context';
import { getAccountPerspective } from '../perspective';
import type { AccountJClaimSession } from '../j-claim-session';
import { canProcessAccountTxForDisputeStatus } from '../consensus/dispute-policy';
import { createStructuredLogger } from '../../infra/logger';
import type { ApplyAccountTxResult } from './apply-types';
import { handleAddDelta } from './handlers/add-delta';
import { handleSetCreditLimit } from './handlers/set-credit-limit';
import { handleDirectPayment } from './handlers/direct-payment';
import { handleReserveToCollateral } from './handlers/reserve-to-collateral';
import { handleRequestCollateral } from './handlers/request-collateral';
import { handleRebalancePolicy } from './handlers/rebalance-policy';
import { handleRebalanceRefund } from './handlers/rebalance-refund';
import { handleReopenDisputed } from './handlers/reopen-disputed';
import { handleHtlcLock } from './handlers/htlc-lock';
import { handleHtlcResolve } from './handlers/htlc-resolve';
import {
  handleCrossPullClose,
  handlePullCancel,
  handlePullLock,
  handlePullResolve,
} from './handlers/pull';
import { handleSwapOffer } from './handlers/swap-offer';
import { handleSwapResolve } from './handlers/swap-resolve';
import { handleCrossSwapFillAck } from './handlers/cross-swap-fill-ack';
import { handleSwapCancelRequest } from './handlers/swap-cancel';
import {
  getSignedSettlementWorkspaceTxError,
  handleSettleTransition,
} from './handlers/settle-transition';
import { handleJEventClaim } from './handlers/j-event-claim';
import { handleLendingAccountTx } from './handlers/lending';

const accountTxLog = createStructuredLogger('account.tx');

type MutationContext = {
  account: AccountReplica;
  tx: AccountTx;
  byLeft: boolean;
  timestamp: number;
  height: number;
  isValidation: boolean;
  consensusContext?: AccountConsensusContext;
  jClaimSession?: AccountJClaimSession;
  counterpartyCertifiedBoardHash?: string;
  candidateEffects: AccountOutput[];
  myEntityId: string;
  counterparty: string;
};

const applyCollateralRequest = (context: MutationContext): ApplyAccountTxResult => {
  if (context.tx.type !== 'request_collateral') {
    throw new Error('ACCOUNT_TX_ROUTE_MISMATCH:request_collateral');
  }
  const result = handleRequestCollateral(
    context.account,
    context.tx,
    context.byLeft,
    context.timestamp,
  );
  const tokenId = Number(context.tx.data.tokenId);
  const feeState = context.account.requestedRebalanceFeeState?.get(tokenId);
  const debug = (payload: Record<string, unknown>): void => {
    context.candidateEffects.push({
      kind: 'debug',
      payload: {
        level: 'info',
        code: 'REB_STEP',
        accountId: context.counterparty,
        ...payload,
      },
    });
  };
  if (!result.success) {
    debug({
      step: 1,
      status: 'error',
      event: 'request_collateral_rejected',
      reason: result.error || 'unknown',
      tokenId,
    });
    return result;
  }
  const requested = context.account.requestedRebalance.get(tokenId) ?? 0n;
  const committed = {
    step: 1,
    status: 'ok',
    event: 'request_collateral_committed',
    tokenId,
    requestedAmount: requested.toString(),
    prepaidFee: String(feeState?.feePaidUpfront ?? 0n),
    requestedAt: Number(feeState?.requestedAt ?? context.timestamp),
  };
  if (context.consensusContext?.emitRuntimeEvents && !context.isValidation) {
    context.candidateEffects.push({
      kind: 'runtimeEvent',
      eventName: 'request_collateral_committed',
      data: {
        entityId: context.myEntityId,
        accountId: context.counterparty,
        tokenId,
        requestedAmount: committed.requestedAmount,
        prepaidFee: committed.prepaidFee,
        requestedAt: committed.requestedAt,
      },
    });
  }
  debug(committed);
  return result;
};

const applyHtlcResolve = async (context: MutationContext): Promise<ApplyAccountTxResult> => {
  if (context.tx.type !== 'htlc_resolve') {
    throw new Error('ACCOUNT_TX_ROUTE_MISMATCH:htlc_resolve');
  }
  const result = await handleHtlcResolve(
    context.account,
    context.tx,
    context.byLeft,
    context.height,
    context.timestamp,
  );
  return {
    success: result.success,
    events: result.events,
    ...(result.error ? { error: result.error } : {}),
    ...(result.secret ? { secret: result.secret } : {}),
    ...(result.hashlock ? { hashlock: result.hashlock } : {}),
    ...(result.amount !== undefined ? { amount: result.amount } : {}),
    ...(result.tokenId !== undefined ? { tokenId: result.tokenId } : {}),
    ...(result.outcome === 'error' && result.hashlock
      ? { timedOutHashlock: result.hashlock }
      : {}),
  };
};

const applyJEventClaim = (context: MutationContext): ApplyAccountTxResult => {
  if (context.tx.type !== 'j_event_claim') {
    throw new Error('ACCOUNT_TX_ROUTE_MISMATCH:j_event_claim');
  }
  if (!context.consensusContext || !context.jClaimSession) {
    throw new Error('ACCOUNT_J_CLAIM_EXECUTION_CONTEXT_REQUIRED');
  }
  return handleJEventClaim(
    context.account,
    context.tx,
    context.byLeft,
    context.timestamp,
    context.isValidation,
    context.myEntityId,
    context.candidateEffects,
    context.consensusContext,
    context.jClaimSession,
  );
};

const rejectFrameOnlyTx = (context: MutationContext): ApplyAccountTxResult => {
  accountTxLog.debug('account_frame.rejected', {
    account: context.counterparty,
    nonce: context.account.proofHeader.nextProofNonce,
  });
  return {
    success: false,
    error: 'account_frame is not a transaction type',
    events: [],
  };
};

/**
 * This is the only transaction router inside Account consensus. Each handler
 * receives the same frame-controlled time/height and mutates only this Account.
 */
export const applyAccountTxMutation = async (
  account: AccountReplica,
  tx: AccountTx,
  byLeft: boolean,
  timestamp: number,
  height: number,
  isValidation: boolean,
  consensusContext: AccountConsensusContext | undefined,
  jClaimSession: AccountJClaimSession | undefined,
  counterpartyCertifiedBoardHash: string | undefined,
  candidateEffects: AccountOutput[],
): Promise<ApplyAccountTxResult> => {
  const myEntityId = account.proofHeader.fromEntity;
  const { counterparty } = getAccountPerspective(account, myEntityId);
  const context: MutationContext = {
    account,
    tx,
    byLeft,
    timestamp,
    height,
    isValidation,
    ...(consensusContext ? { consensusContext } : {}),
    ...(jClaimSession ? { jClaimSession } : {}),
    ...(counterpartyCertifiedBoardHash ? { counterpartyCertifiedBoardHash } : {}),
    candidateEffects,
    myEntityId,
    counterparty,
  };
  if (!canProcessAccountTxForDisputeStatus(account.status, tx.type)) {
    const error =
      `Account is ${account.status}; tx ${tx.type} rejected until ` +
      'dispute/reopen flow completes';
    return { success: false, events: [error], error };
  }
  const freezeError = getSignedSettlementWorkspaceTxError(account, tx);
  if (freezeError) return { success: false, events: [freezeError], error: freezeError };

  switch (tx.type) {
    case 'add_delta': return handleAddDelta(account, tx);
    case 'set_credit_limit': return handleSetCreditLimit(account, tx, byLeft);
    case 'direct_payment': return handleDirectPayment(account, tx, byLeft);
    case 'lending_fund':
    case 'lending_borrow_request':
    case 'lending_repay':
    case 'lending_credit':
    case 'lending_close_request':
    case 'lending_close_payout':
      return handleLendingAccountTx(account, tx, byLeft);
    case 'account_settle':
      return {
        success: false,
        events: ['❌ account_settle must not be processed here'],
        error: 'account_settle handled externally',
      };
    case 'reserve_to_collateral': return handleReserveToCollateral(account, tx);
    case 'request_collateral': return applyCollateralRequest(context);
    case 'rebalance_refund': return handleRebalanceRefund(account, tx, byLeft);
    case 'rebalance_policy': return handleRebalancePolicy(account, tx, byLeft, timestamp);
    case 'reopen_disputed': return handleReopenDisputed(account, tx);
    case 'j_event_claim': return applyJEventClaim(context);
    case 'htlc_lock':
      return handleHtlcLock(account, tx, byLeft, timestamp, height, isValidation);
    case 'htlc_resolve': return applyHtlcResolve(context);
    case 'pull_lock': return handlePullLock(account, tx, byLeft, height, timestamp);
    case 'pull_resolve': return handlePullResolve(account, tx, byLeft, timestamp);
    case 'pull_cancel': return handlePullCancel(account, tx, byLeft, timestamp);
    case 'cross_pull_close': return handleCrossPullClose(account, tx, byLeft, timestamp);
    case 'swap_offer': return handleSwapOffer(account, tx, byLeft, height, isValidation);
    case 'swap_resolve': return handleSwapResolve(account, tx, byLeft, height, isValidation);
    case 'cross_swap_fill_ack':
      return handleCrossSwapFillAck(account, tx, byLeft, timestamp, height);
    case 'swap_cancel_request':
      return handleSwapCancelRequest(account, tx, byLeft, height, isValidation);
    case 'settle_transition':
      return handleSettleTransition(
        account,
        tx,
        byLeft,
        timestamp,
        consensusContext,
        counterpartyCertifiedBoardHash,
      );
    case 'account_frame': return rejectFrameOnlyTx(context);
  }
};
