import type { AccountReplica, AccountTx } from '../../../types/account';
import { canProcessAccountTxForDisputeStatus } from '../../../account/consensus/dispute/policy';
import type { EntityState } from '../../types';
import type { EntityTx } from '../../../types/entity-tx';
import { getPerfMs } from '../../../infra/time';
import { normalizeEntityRef } from '../../../orderbook/cross-j/orderbook';
import { shortId, shortOrder } from '../../../infra/logger';
import { cancelHook, scheduleHook } from '../../scheduler';
import { accountHasProposableMempool } from '../account/mempool-eligibility';
import { applyAccountInput } from '../../../account/consensus';
import { createLocalAccountInput } from '../../../account/input';
import { entityLog } from '../entity-log';
import {
  buildCrossJurisdictionFillNoticeOutput,
  drainCommittedCrossJurisdictionCancelAcks,
  drainPendingCrossJurisdictionFillAcks,
  ownsSourceHubRouteForFillAck,
  stashPendingCrossJurisdictionFillAck,
} from '../account/cross-j-fill-ack';
import { appendCrossJurisdictionTargetProgressAfterAdmission } from '../../tx/cross-j-outputs';
import type { ApplyEntityTxsInOrderContext } from './application-types';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from '../../tx/handlers/account';

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

export const shouldSuppressReturnedAccountTx = (
  account: Pick<AccountReplica, 'status'>,
): boolean => !canProcessAccountTxForDisputeStatus(account.status);

const applyReturnedAccountTxs = async (
  context: ApplyEntityTxsInOrderContext,
  state: EntityState,
  accountTxs: Array<{ accountId: string; tx: AccountTx }>,
): Promise<void> => {
  for (const { accountId, tx } of accountTxs) {
    const account = state.accounts.get(accountId);
    if (tx.type === 'cross_swap_fill_ack' && !account?.state.swapOffers?.has(tx.data.offerId)) {
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
    // Returned effects are admitted after their EntityTx mutates status. This
    // catches both ordinary commands issued after a freeze and a certified J
    // range containing AccountSettled before DisputeStarted. Never reintroduce
    // work after the canonical Account policy has closed the proposal lane.
    if (shouldSuppressReturnedAccountTx(account)) {
      entityLog.info('account_tx.suppressed_non_active', {
        account: shortId(accountId, 8),
        status: account.status,
        tx: tx.type,
      });
      continue;
    }
    const admission = await applyAccountInput(
      context.accountConsensusContext,
      account,
      createLocalAccountInput(account.state, state.entityId, [tx]),
    );
    if (admission.admittedAccountTxCount === 0) continue;
    if (tx.type === 'cross_swap_fill_ack') {
      appendCrossJurisdictionTargetProgressAfterAdmission(state, tx, context.allOutputs);
    }
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
      const offer = state.accounts.get(cancel.accountId)?.state.swapOffers?.get(cancel.offerId);
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
  } else if (entityTx.type === 'openAccount') {
    addIfReady(entityTx.data.targetEntityId);
  } else if (entityTx.type === 'extendCredit') {
    addIfReady(entityTx.data.counterpartyEntityId);
  }
};

export const applyEntityTxReturnedEffects = async (
  context: ApplyEntityTxsInOrderContext,
  state: EntityState,
  entityTx: EntityTx,
  txProfileStartMs: number,
  effects: {
    accountTxs?: Array<{ accountId: string; tx: AccountTx }>;
    swapOffersCreated?: SwapOfferEvent[];
    swapCancelRequests?: SwapCancelRequestEvent[];
    swapOffersCancelled?: SwapCancelEvent[];
  },
): Promise<void> => {
  if (effects.accountTxs?.length) {
    await applyReturnedAccountTxs(context, state, effects.accountTxs);
  }
  collectSwapEvents(
    context,
    state,
    effects.swapOffersCreated,
    effects.swapCancelRequests,
    effects.swapOffersCancelled,
  );
  markTxAccountsProposable(context, state, entityTx);
  await drainPendingCrossJurisdictionFillAcks(
    context.env,
    context.accountConsensusContext,
    state,
    context.proposableAccounts,
    context.storageChanges,
    context.candidateEffects,
    context.allOutputs,
  );
  await drainCommittedCrossJurisdictionCancelAcks(
    context.accountConsensusContext,
    state,
    context.proposableAccounts,
    context.storageChanges,
    context.allOutputs,
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
