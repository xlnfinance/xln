import type { AccountFrame, AccountTx, EntityState, Env, HtlcNoteKey, HtlcRoute } from '../../../../types';
import { HEAVY_LOGS } from '../../../../utils';
import { swapKey } from '../../../../swap-execution';
import { cancelHook as cancelScheduledHook } from '../../../../entity-crontab';
import { pruneSettledOriginatedHtlcRoutes, terminateHtlcRoute } from '../../htlc-route-lifecycle';
import { buildHtlcFinalizedEventPayload } from '../../../../htlc-events';
import {
  buildLendingLoanId,
  ensureLendingState,
  getAccountOutCapacity,
  getCreditGrantedByAccountOwner,
  LENDING_TERM_MS,
  selectBestLendingPool,
  computeLendingInterest,
} from '../../../../lending';
import { createStructuredLogger } from '../../../../logger';
import type { MempoolOp } from './orderbook-queue';

const accountFollowupLog = createStructuredLogger('account.followup');
const normalizeEntityRef = (value: unknown): string => String(value || '').toLowerCase();

const jurisdictionIdFor = (state: EntityState, env?: Env): string =>
  String(state.config?.jurisdiction?.name || env?.activeJurisdiction || '').trim();

function emitOriginatedHtlcFinalized(
  env: Env | undefined,
  state: EntityState,
  route: HtlcRoute,
  accountTx: Extract<AccountTx, { type: 'htlc_resolve' }>,
): void {
  if (!env?.emit || accountTx.data.outcome !== 'secret') return;
  if (route.inboundEntity || route.outboundLockId !== accountTx.data.lockId) return;
  const description =
    state.htlcNotes?.get(`lock:${accountTx.data.lockId}` as HtlcNoteKey)
    ?? state.htlcNotes?.get(`hashlock:${route.hashlock}` as HtlcNoteKey)
    ?? undefined;
  env.emit('HtlcFinalized', {
    ...buildHtlcFinalizedEventPayload({
      entityId: state.entityId,
      fromEntity: state.entityId,
      ...(route.outboundEntity ? { toEntity: route.outboundEntity } : {}),
      hashlock: route.hashlock,
      ...(accountTx.data.secret ? { secret: accountTx.data.secret } : {}),
      lockId: accountTx.data.lockId,
      ...(route.amount !== undefined ? { amount: route.amount } : {}),
      ...(route.tokenId !== undefined ? { tokenId: route.tokenId } : {}),
      ...(description ? { description } : {}),
      ...(route.startedAtMs !== undefined ? { startedAtMs: route.startedAtMs } : {}),
      ...(jurisdictionIdFor(state, env) ? { jurisdictionId: jurisdictionIdFor(state, env) } : {}),
      finalizedAtMs: state.timestamp,
    }),
  });
}

const lendingCreditOp = (
  accountId: string,
  data: Extract<AccountTx, { type: 'lending_credit' }>['data'],
): MempoolOp => ({
  accountId,
  tx: {
    type: 'lending_credit',
    data,
  },
});

function applyCommittedLendingFollowup(
  newState: EntityState,
  counterpartyId: string,
  accountTx: AccountTx,
  committedFrame: AccountFrame,
  mempoolOps: MempoolOp[],
): void {
  const hubEntityId = normalizeEntityRef(newState.entityId);
  if (newState.profile?.isHub !== true) return;
  if (!('hubEntityId' in accountTx.data) || normalizeEntityRef(accountTx.data.hubEntityId) !== hubEntityId) return;
  const account = newState.accounts.get(normalizeEntityRef(counterpartyId));
  if (!account) throw new Error(`LENDING_ACCOUNT_MISSING:${counterpartyId}`);
  const proposer = normalizeEntityRef(committedFrame.byLeft ? account.leftEntity : account.rightEntity);
  const lending = ensureLendingState(newState);
  const now = Math.max(
    Math.floor(Number(committedFrame.timestamp || 0)),
    Math.floor(Number(newState.timestamp || 0)),
  );

  if (accountTx.type === 'lending_fund') {
    if (proposer !== normalizeEntityRef(accountTx.data.lenderEntityId) || proposer !== normalizeEntityRef(counterpartyId)) {
      throw new Error(`LENDING_FUND_PROPOSER_MISMATCH:${accountTx.data.positionId}`);
    }
    const existing = lending.pools.get(accountTx.data.positionId);
    if (existing) throw new Error(`LENDING_POSITION_ALREADY_EXISTS:${accountTx.data.positionId}`);
    lending.pools.set(accountTx.data.positionId, {
      positionId: accountTx.data.positionId,
      hubEntityId,
      lenderEntityId: proposer,
      tokenId: accountTx.data.tokenId,
      principalAmount: accountTx.data.amount,
      availableAmount: accountTx.data.amount,
      borrowedAmount: 0n,
      interestBps: accountTx.data.interestBps,
      termId: accountTx.data.termId,
      termMs: LENDING_TERM_MS[accountTx.data.termId],
      createdAt: now,
      updatedAt: now,
      status: 'open',
    });
    return;
  }

  if (accountTx.type === 'lending_borrow_request') {
    if (proposer !== normalizeEntityRef(accountTx.data.borrowerEntityId) || proposer !== normalizeEntityRef(counterpartyId)) {
      throw new Error(`LENDING_BORROW_PROPOSER_MISMATCH:${accountTx.data.requestId}`);
    }
    const pool = selectBestLendingPool(
      lending,
      accountTx.data.tokenId,
      accountTx.data.amount,
      accountTx.data.termId,
      accountTx.data.maxInterestBps,
    );
    if (!pool) throw new Error(`LENDING_LIQUIDITY_UNAVAILABLE:${accountTx.data.requestId}`);
    const loanId = buildLendingLoanId({
      hubEntityId,
      borrowerEntityId: proposer,
      tokenId: accountTx.data.tokenId,
      amount: accountTx.data.amount,
      termId: accountTx.data.termId,
      openedAt: now,
      requestId: accountTx.data.requestId,
    });
    if (lending.loans.has(loanId)) throw new Error(`LENDING_LOAN_ALREADY_EXISTS:${loanId}`);
    const interestAmount = computeLendingInterest(accountTx.data.amount, pool.interestBps);
    pool.availableAmount -= accountTx.data.amount;
    pool.borrowedAmount += accountTx.data.amount;
    pool.updatedAt = now;
    lending.loans.set(loanId, {
      requestId: accountTx.data.requestId,
      loanId,
      hubEntityId,
      borrowerEntityId: proposer,
      lenderEntityId: pool.lenderEntityId,
      positionId: pool.positionId,
      tokenId: accountTx.data.tokenId,
      principalAmount: accountTx.data.amount,
      interestAmount,
      repaymentAmount: accountTx.data.amount + interestAmount,
      repaidAmount: 0n,
      interestBps: pool.interestBps,
      termId: pool.termId,
      termMs: pool.termMs,
      openedAt: now,
      dueAt: now + pool.termMs,
      updatedAt: now,
      status: 'opening',
    });
    const currentLimit = getCreditGrantedByAccountOwner(account, hubEntityId, accountTx.data.tokenId);
    mempoolOps.push(lendingCreditOp(proposer, {
      action: 'grant',
      loanId,
      hubEntityId,
      borrowerEntityId: proposer,
      tokenId: accountTx.data.tokenId,
      creditLimit: currentLimit + accountTx.data.amount,
    }));
    return;
  }

  if (accountTx.type === 'lending_credit') {
    if (proposer !== hubEntityId) throw new Error(`LENDING_CREDIT_PROPOSER_MISMATCH:${accountTx.data.loanId}`);
    const loan = lending.loans.get(accountTx.data.loanId);
    if (!loan) throw new Error(`LENDING_CREDIT_LOAN_MISSING:${accountTx.data.loanId}`);
    if (accountTx.data.action === 'grant') {
      if (loan.status !== 'opening') throw new Error(`LENDING_GRANT_STATUS_INVALID:${loan.loanId}:${loan.status}`);
      loan.status = 'active';
      loan.updatedAt = now;
      return;
    }
    if (loan.status !== 'closing') throw new Error(`LENDING_REVOKE_STATUS_INVALID:${loan.loanId}:${loan.status}`);
    const pool = lending.pools.get(loan.positionId);
    if (!pool) throw new Error(`LENDING_POOL_MISSING_FOR_LOAN:${loan.loanId}`);
    if (pool.borrowedAmount < loan.principalAmount) throw new Error(`LENDING_POOL_BORROWED_UNDERFLOW:${pool.positionId}`);
    loan.repaidAmount = loan.repaymentAmount;
    loan.status = 'repaid';
    loan.updatedAt = now;
    pool.borrowedAmount -= loan.principalAmount;
    pool.availableAmount += loan.repaymentAmount;
    pool.updatedAt = now;
    return;
  }

  if (accountTx.type === 'lending_repay') {
    if (proposer !== normalizeEntityRef(accountTx.data.borrowerEntityId) || proposer !== normalizeEntityRef(counterpartyId)) {
      throw new Error(`LENDING_REPAY_PROPOSER_MISMATCH:${accountTx.data.loanId}`);
    }
    const loan = lending.loans.get(accountTx.data.loanId);
    if (!loan || loan.status !== 'active') throw new Error(`LENDING_REPAY_LOAN_NOT_ACTIVE:${accountTx.data.loanId}`);
    const remaining = loan.repaymentAmount - loan.repaidAmount;
    if (loan.borrowerEntityId !== proposer || loan.tokenId !== accountTx.data.tokenId || accountTx.data.amount !== remaining) {
      throw new Error(`LENDING_REPAYMENT_MISMATCH:${accountTx.data.loanId}`);
    }
    loan.status = 'closing';
    loan.updatedAt = now;
    const currentLimit = getCreditGrantedByAccountOwner(account, hubEntityId, loan.tokenId);
    mempoolOps.push(lendingCreditOp(proposer, {
      action: 'revoke',
      loanId: loan.loanId,
      hubEntityId,
      borrowerEntityId: proposer,
      tokenId: loan.tokenId,
      creditLimit: currentLimit > loan.principalAmount ? currentLimit - loan.principalAmount : 0n,
    }));
    return;
  }

  if (accountTx.type === 'lending_close_request') {
    if (proposer !== normalizeEntityRef(accountTx.data.lenderEntityId) || proposer !== normalizeEntityRef(counterpartyId)) {
      throw new Error(`LENDING_CLOSE_PROPOSER_MISMATCH:${accountTx.data.positionId}`);
    }
    const pool = lending.pools.get(accountTx.data.positionId);
    if (!pool || pool.status !== 'open' || pool.lenderEntityId !== proposer) {
      throw new Error(`LENDING_CLOSE_POSITION_NOT_OPEN:${accountTx.data.positionId}`);
    }
    if (pool.borrowedAmount !== 0n) throw new Error(`LENDING_CLOSE_ACTIVE_LOANS:${pool.positionId}`);
    if (pool.availableAmount === 0n) {
      pool.status = 'closed';
      pool.updatedAt = now;
      return;
    }
    const payoutCapacity = getAccountOutCapacity(account, hubEntityId, pool.tokenId);
    if (payoutCapacity < pool.availableAmount) {
      throw new Error(`LENDING_CLOSE_PAYOUT_CAPACITY: available=${payoutCapacity} required=${pool.availableAmount}`);
    }
    pool.status = 'closing';
    pool.updatedAt = now;
    mempoolOps.push({
      accountId: proposer,
      tx: {
        type: 'lending_close_payout',
        data: {
          positionId: pool.positionId,
          hubEntityId,
          lenderEntityId: proposer,
          tokenId: pool.tokenId,
          amount: pool.availableAmount,
        },
      },
    });
    return;
  }

  if (accountTx.type !== 'lending_close_payout') return;
  if (proposer !== hubEntityId) throw new Error(`LENDING_PAYOUT_PROPOSER_MISMATCH:${accountTx.data.positionId}`);
  const pool = lending.pools.get(accountTx.data.positionId);
  if (!pool || pool.status !== 'closing') throw new Error(`LENDING_PAYOUT_POSITION_NOT_CLOSING:${accountTx.data.positionId}`);
  if (pool.lenderEntityId !== normalizeEntityRef(accountTx.data.lenderEntityId) || pool.tokenId !== accountTx.data.tokenId || pool.availableAmount !== accountTx.data.amount) {
    throw new Error(`LENDING_PAYOUT_MISMATCH:${accountTx.data.positionId}`);
  }
  pool.availableAmount = 0n;
  pool.status = 'closed';
  pool.updatedAt = now;
}

export function applyCommittedAccountFrameFollowups(
  newState: EntityState,
  counterpartyId: string,
  committedFrame: AccountFrame,
  mempoolOps: MempoolOp[] = [],
  env?: Env,
): void {
  if (HEAVY_LOGS) {
    accountFollowupLog.debug('frame.commit', {
      height: committedFrame.height,
      txs: committedFrame.accountTxs.length,
    });
  }

  for (const accountTx of committedFrame.accountTxs) {
    if (HEAVY_LOGS) accountFollowupLog.debug('frame.tx', { type: accountTx.type });
    applyCommittedLendingFollowup(newState, counterpartyId, accountTx, committedFrame, mempoolOps);

    // Account frames are canonical once committed; keep entity-local indexes in
    // sync here instead of mutating them while the account proposal is still tentative.
    if (accountTx.type === 'htlc_resolve') {
      const account = newState.accounts.get(counterpartyId);
      if (account?.mempool?.length) {
        account.mempool = account.mempool.filter((mempoolTx) =>
          !(mempoolTx.type === 'htlc_lock' && mempoolTx.data.lockId === accountTx.data.lockId)
        );
      }
      newState.lockBook.delete(accountTx.data.lockId);
      if (newState.crontabState) {
        cancelScheduledHook(newState.crontabState, `htlc-timeout:${accountTx.data.lockId}`);
      }
      if (accountTx.data.outcome === 'secret') {
        for (const [hashlock, route] of newState.htlcRoutes.entries()) {
          const resolvesInbound = route.inboundLockId === accountTx.data.lockId;
          const resolvesOriginatedOutbound =
            route.outboundLockId === accountTx.data.lockId && !route.inboundEntity;
          if (!resolvesInbound && !resolvesOriginatedOutbound) continue;
          emitOriginatedHtlcFinalized(env, newState, route, accountTx);
          terminateHtlcRoute(newState, hashlock, newState.timestamp);
        }
      }
    }

    if (accountTx.type === 'j_event_claim') continue;

    if (accountTx.type === 'swap_resolve') {
      const key = swapKey(counterpartyId, accountTx.data.offerId);
      newState.pendingSwapFillRatios?.delete(key);
    }
  }
  pruneSettledOriginatedHtlcRoutes(newState, newState.timestamp);
}
