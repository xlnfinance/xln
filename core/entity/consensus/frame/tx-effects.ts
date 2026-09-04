import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import type { AccountReplica, AccountTx } from '../../../types/account';
import { canProcessAccountTxForDisputeStatus } from '../../../account/consensus/dispute/policy';
import type { EntityState } from '../../types';
import type { EntityTx } from '../../../types/entity-tx';
import { getPerfMs } from '../../../support/time';
import { normalizeEntityRef } from '../../../orderbook/cross-j/orderbook';
import { shortId } from '../../../support/logger';
import { accountHasProposableMempool } from '../account/mempool-eligibility';
import { applyAccountInput } from '../../../account/consensus';
import { getEntityAccountForWrite } from '../../state/persistent-account-map';
import { entityLog } from '../entity-log';
import type { ApplyEntityTxsInOrderContext } from './application-types';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from '../../tx/handlers/account';
import { markProposableAccount } from '../account/canonical-worklist';

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

const applyLocalAccountEffects = async (
  context: ApplyEntityTxsInOrderContext,
  state: EntityState,
  accountTxs: Array<{ accountId: string; tx: AccountTx }>,
): Promise<void> => {
  for (const { accountId, tx } of accountTxs) {
    const visible = state.accounts.get(accountId);
    if (!visible) {
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
    if (shouldSuppressReturnedAccountTx(visible)) {
      entityLog.info('account_tx.suppressed_non_active', {
        account: shortId(accountId, 8),
        status: visible.status,
        tx: tx.type,
      });
      continue;
    }
    const account = getEntityAccountForWrite(state.accounts, accountId);
    if (!account) {
      throw haltRuntimeFailure(
        'ACCOUNT_TX_WRITE_ACCOUNT_MISSING',
        `ACCOUNT_TX_WRITE_ACCOUNT_MISSING: account=${accountId} entity=${state.entityId}`,
      );
    }
    const admission = await applyAccountInput(
      context.accountConsensusContext,
      account,
      { kind: 'enqueue', txs: [tx] },
    );
    if (!admission.ok || admission.admittedAccountTxCount === 0) continue;
    markProposableAccount(context.proposableAccounts, accountId);
    recordAccountChange(context, state, accountId);
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
      markProposableAccount(context.proposableAccounts, accountId);
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
    await applyLocalAccountEffects(context, state, effects.accountTxs);
  }
  collectSwapEvents(
    context,
    state,
    effects.swapOffersCreated,
    effects.swapCancelRequests,
    effects.swapOffersCancelled,
  );
  markTxAccountsProposable(context, state, entityTx);
  const elapsedMs = Math.round(getPerfMs() - txProfileStartMs);
  const profile = context.frameProfileTxTotals.get(entityTx.type) ?? {
    count: 0,
    elapsedMs: 0,
  };
  profile.count += 1;
  profile.elapsedMs += elapsedMs;
  context.frameProfileTxTotals.set(entityTx.type, profile);
};
