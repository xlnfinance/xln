import type {
  AccountTx,
  EntityState,
  EntityTx,
} from '../../types';
import { getPerfMs } from '../../utils';
import { normalizeEntityRef } from '../../orderbook/cross-j-orderbook';
import { shortId, shortOrder } from '../../infra/logger';
import { cancelHook, scheduleHook } from '../scheduler';
import { accountHasProposableMempool } from './account-mempool-eligibility';
import { queueAccountMempoolTx } from './account-mempool-queue';
import {
  buildCrossJurisdictionFillNoticeOutput,
  drainCommittedCrossJurisdictionCancelAcks,
  drainPendingCrossJurisdictionFillAcks,
  entityLog,
  ownsSourceHubRouteForFillAck,
  stashPendingCrossJurisdictionFillAck,
} from './shared';
import type { ApplyEntityTxsInOrderContext } from './frame-application-types';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from '../tx/handlers/account';

const recordAccountChange = (
  context: ApplyEntityTxsInOrderContext,
  state: EntityState,
  accountId: string,
): void => {
  context.storageChanges.push({
    family: 'account',
    entityId: state.entityId,
    counterpartyId: accountId,
  });
};

const applyReturnedMempoolOps = (
  context: ApplyEntityTxsInOrderContext,
  state: EntityState,
  mempoolOps: Array<{ accountId: string; tx: AccountTx }>,
): void => {
  for (const { accountId, tx } of mempoolOps) {
    const account = state.accounts.get(accountId);
    if (tx.type === 'cross_swap_fill_ack' && !account?.swapOffers?.has(tx.data.offerId)) {
      const routed = buildCrossJurisdictionFillNoticeOutput(state, accountId, tx);
      if (!routed) {
        if (ownsSourceHubRouteForFillAck(state, tx)) {
          stashPendingCrossJurisdictionFillAck(
            context.env,
            state,
            accountId,
            tx,
            account ? 'source_offer_not_committed' : 'source_account_not_committed',
          );
          continue;
        }
        throw new Error(
          `CROSS_J_FILL_ACK_ACCOUNT_OFFER_MISSING: account=${accountId} ` +
          `offer=${tx.data.offerId} entity=${state.entityId}`,
        );
      }
      context.allOutputs.push(routed);
      entityLog.info('crossj.sibling_fill_notice_routed', {
        owner: shortId(routed.entityId, 8),
        account: shortId(accountId, 8),
        offer: shortOrder(tx.data.offerId, 8),
      });
      continue;
    }
    if (!account) {
      if (tx.type === 'cross_swap_fill_ack') {
        throw new Error(
          `CROSS_J_FILL_ACK_ACCOUNT_MISSING: account=${accountId} ` +
          `offer=${tx.data.offerId} entity=${state.entityId}`,
        );
      }
      entityLog.warn('mempool_op.account_missing', {
        account: shortId(accountId, 8),
        tx: tx.type,
      });
      continue;
    }
    if (!queueAccountMempoolTx(account, tx)) continue;
    context.proposableAccounts.add(accountId);
    recordAccountChange(context, state, accountId);
    if (tx.type === 'htlc_lock' && tx.data.timelock && tx.data.lockId && state.crontabState) {
      scheduleHook(state.crontabState, {
        id: `htlc-timeout:${tx.data.lockId}`,
        triggerAt: Number(tx.data.timelock),
        type: 'htlc_timeout',
        data: { accountId, lockId: tx.data.lockId },
      });
    }
    if (tx.type === 'htlc_resolve' && tx.data.lockId && state.crontabState) {
      cancelHook(state.crontabState, `htlc-timeout:${tx.data.lockId}`);
    }
  }
};

const collectSwapEvents = (
  context: ApplyEntityTxsInOrderContext,
  state: EntityState,
  created: SwapOfferEvent[] | undefined,
  cancelRequests: SwapCancelRequestEvent[] | undefined,
  cancelled: SwapCancelEvent[] | undefined,
): void => {
  if (created) context.allSwapOffersCreated.push(...created);
  if (cancelRequests) {
    for (const cancel of cancelRequests) {
      const offer = state.accounts.get(cancel.accountId)?.swapOffers?.get(cancel.offerId);
      if (
        offer?.crossJurisdiction &&
        normalizeEntityRef(state.entityId) !==
          normalizeEntityRef(offer.crossJurisdiction.source.counterpartyEntityId)
      ) {
        continue;
      }
      context.allSwapCancelRequests.push(cancel);
    }
  }
  if (cancelled) context.allSwapOffersCancelled.push(...cancelled);
};

const markTxAccountsProposable = (
  context: ApplyEntityTxsInOrderContext,
  state: EntityState,
  entityTx: EntityTx,
): void => {
  const addIfReady = (accountId: string): void => {
    const account = state.accounts.get(accountId);
    if (account && accountHasProposableMempool(account, state)) {
      context.proposableAccounts.add(accountId);
    }
  };
  if (entityTx.type === 'accountInput') {
    addIfReady(entityTx.data.fromEntityId);
  } else if (entityTx.type === 'directPayment') {
    for (const accountId of state.accounts.keys()) addIfReady(accountId);
  } else if (entityTx.type === 'openAccount') {
    addIfReady(entityTx.data.targetEntityId);
  } else if (entityTx.type === 'extendCredit') {
    addIfReady(entityTx.data.counterpartyEntityId);
  }
};

export const applyEntityTxReturnedEffects = (
  context: ApplyEntityTxsInOrderContext,
  state: EntityState,
  entityTx: EntityTx,
  txProfileStartMs: number,
  effects: {
    mempoolOps?: Array<{ accountId: string; tx: AccountTx }>;
    swapOffersCreated?: SwapOfferEvent[];
    swapCancelRequests?: SwapCancelRequestEvent[];
    swapOffersCancelled?: SwapCancelEvent[];
  },
): void => {
  if (effects.mempoolOps?.length) {
    applyReturnedMempoolOps(context, state, effects.mempoolOps);
  }
  collectSwapEvents(
    context,
    state,
    effects.swapOffersCreated,
    effects.swapCancelRequests,
    effects.swapOffersCancelled,
  );
  markTxAccountsProposable(context, state, entityTx);
  drainPendingCrossJurisdictionFillAcks(
    context.env,
    state,
    context.proposableAccounts,
    context.storageChanges,
  );
  drainCommittedCrossJurisdictionCancelAcks(
    state,
    context.proposableAccounts,
    context.storageChanges,
  );
  const elapsedMs = Math.round(getPerfMs() - txProfileStartMs);
  const profile = context.frameProfileTxTotals.get(entityTx.type) ?? {
    count: 0,
    elapsedMs: 0,
  };
  profile.count += 1;
  profile.elapsedMs += elapsedMs;
  context.frameProfileTxTotals.set(entityTx.type, profile);
};
