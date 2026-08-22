import type { AccountPeerInput, AccountReplica, AccountTx } from '../../../../types/account';
import type { EntityCandidateEffect, EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { HandleAccountInputApplied } from '../../../../account/consensus/types';
import {
  accountInputAck,
  accountInputProposal,
  accountInputReferenceHeight,
} from '../../../../account/consensus/flush';
import { emitScopedEvents } from '../../../../support/scoped-events';
import { addMessages } from '../../../frame-events';
import { createStructuredLogger, shortId } from '../../../../support/logger';
import { scheduleHook } from '../../../scheduler';
import { getRebalanceAccountIds } from '../../../consensus/account/work-index';
import { putEntityAccountCandidate } from '../../../state/persistent-account-map';
import type { ApplyEntityTxOptions } from '../../apply';
import { buildHubRebalancePolicyTx } from './lifecycle/admin';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../account-cross-j-followups';
import { processCommittedSettlementTransitionFollowup } from '../payments/settle';
import { applyCommittedAccountFrameFollowups } from './committed-frame-followups';
import {
  applyCommittedHtlcLockFollowup,
  applyHtlcSecretFollowups,
  applyHtlcTimeoutFollowups,
  applyPendingForwardFollowup,
} from './committed-htlc-followups';
import type { AccountTxTarget } from './orderbook/queue';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './orderbook/offers';

const accountHandlerLog = createStructuredLogger('account.handler');

type AccountHashToSign = {
  hash: string;
  type: 'accountFrame' | 'dispute' | 'settlement';
  context: string;
};

export type CommittedAccountEffects = {
  outputs: EntityInput[];
  accountTxs: AccountTxTarget[];
  swapOffersCreated: SwapOfferEvent[];
  swapCancelRequests: SwapCancelRequestEvent[];
  swapOffersCancelled: SwapCancelEvent[];
  candidateEffects: EntityCandidateEffect[];
  hashesToSign: AccountHashToSign[];
};

type SuccessfulAccountInputContext = {
  env: EntityRuntimeContext;
  state: EntityState;
  input: AccountPeerInput;
  account: AccountReplica;
  counterpartyId: string;
  createdAccount: boolean;
  result: HandleAccountInputApplied;
  effects: CommittedAccountEffects;
  options?: ApplyEntityTxOptions;
  checkpointProfile(label: string): void;
};

const buildCommittedSwapOfferEvent = (
  account: AccountReplica,
  counterpartyId: string,
  offerId: string,
): SwapOfferEvent | null => {
  const offer = account.state.swapOffers?.get(offerId);
  if (!offer) return null;
  return {
    offerId,
    accountId: counterpartyId,
    makerIsLeft: offer.makerIsLeft,
    fromEntity: account.state.leftEntity,
    toEntity: account.state.rightEntity,
    createdHeight: offer.createdHeight,
    giveTokenId: offer.giveTokenId,
    giveTokenDecimals: offer.giveTokenDecimals,
    giveAmount: offer.giveAmount,
    wantTokenId: offer.wantTokenId,
    wantTokenDecimals: offer.wantTokenDecimals,
    wantAmount: offer.wantAmount,
    maxFee: offer.maxFee,
    minNetReceive: offer.minNetReceive,
    priceTicks: offer.priceTicks,
    ...(offer.timeInForce !== undefined ? { timeInForce: offer.timeInForce } : {}),
    ...(offer.crossJurisdiction ? { crossJurisdiction: offer.crossJurisdiction } : {}),
  };
};

export const hubRebalanceTaskAlreadyRanAtTimestamp = (
  state: Pick<EntityState, 'timestamp' | 'crontabState'>,
): boolean => {
  const task = state.crontabState?.tasks.get('hubRebalance');
  return task !== undefined && task.lastRun >= state.timestamp;
};

const shouldScheduleCommittedAccountWork = (
  state: EntityState,
  counterpartyId: string,
): boolean => {
  if (!state.hubRebalanceConfig || !state.crontabState) return false;
  // A committed Account frame is not itself rebalance work. Scheduling an
  // immediate hook for every payment/swap creates a second signed Entity frame
  // and WAL commit with no output. The Patricia Account work index is the
  // canonical readiness projection; only a leaf classified as runnable may
  // wake the global rebalance task.
  if (!getRebalanceAccountIds(state).has(counterpartyId)) return false;
  // A wake runs before the remaining Entity transactions in its frame. Those
  // transactions can leave another runnable Account leaf behind, but rearming
  // the same-timestamp kick would create an unbounded one-wake/one-WAL-frame
  // loop. The task has already inspected this logical tick; its canonical
  // periodic deadline owns any remaining work.
  return !hubRebalanceTaskAlreadyRanAtTimestamp(state);
};

const scheduleCommittedAccountWork = (
  state: EntityState,
  counterpartyId: string,
): void => {
  if (!shouldScheduleCommittedAccountWork(state, counterpartyId)) return;
  if (!state.crontabState) throw new Error('HUB_REBALANCE_CRONTAB_MISSING');
  scheduleHook(state.crontabState, {
    id: 'hub-rebalance-kick',
    triggerAt: state.timestamp,
    type: 'hub_rebalance_kick',
    data: { reason: 'account_frame_committed', counterpartyId },
  });
};

const recordCommittedFrames = (
  context: SuccessfulAccountInputContext,
): void => {
  const { account, input, result, effects } = context;
  for (const { frame, committedViaNewFrame } of result.committedFrames ?? []) {
    effects.candidateEffects.push({
      kind: 'accountFrameHistory',
      entityId: account.proofHeader.fromEntity,
      counterpartyId: input.fromEntityId,
      accountHeight: frame.height,
      source: committedViaNewFrame ? 'peerCommit' : 'ackCommit',
      // The committed frame is sealed (deep-frozen) with the Account on
      // commit; history keeps the same immutable value instead of a copy.
      frame,
    });
  }
};

const applyCommittedSwapFollowup = (
  context: SuccessfulAccountInputContext,
  accountTx: AccountTx,
): void => {
  const { account, counterpartyId, effects } = context;
  if (accountTx.type === 'swap_offer') {
    const event = buildCommittedSwapOfferEvent(account, counterpartyId, accountTx.data.offerId);
    if (event) effects.swapOffersCreated.push(event);
  } else if (accountTx.type === 'swap_resolve' || accountTx.type === 'cross_swap_fill_ack') {
    const event = buildCommittedSwapOfferEvent(account, counterpartyId, accountTx.data.offerId);
    if (event) {
      effects.swapOffersCreated.push(event);
    } else {
      effects.swapOffersCancelled.push({ offerId: accountTx.data.offerId, accountId: counterpartyId });
    }
  } else if (accountTx.type === 'swap_cancel_request') {
    effects.swapCancelRequests.push({ offerId: accountTx.data.offerId, accountId: counterpartyId });
  }
};

const applyCommittedFrameTransactions = async (
  context: SuccessfulAccountInputContext,
): Promise<void> => {
  const { env, state, input, account, counterpartyId, result, effects, options } = context;
  const consumedPreparedHtlcBindings = new Set<string>();
  for (const { frame, committedViaNewFrame } of result.committedFrames ?? []) {
    applyCommittedAccountFrameFollowups(
      state,
      counterpartyId,
      frame,
      effects.accountTxs,
      env,
      effects.candidateEffects,
    );
    for (const accountTx of frame.accountTxs ?? []) {
      const settlement = await processCommittedSettlementTransitionFollowup(
        account,
        accountTx,
        frame,
        counterpartyId,
        state,
        env,
      );
      effects.outputs.push(...settlement.outputs);
      effects.accountTxs.push(...settlement.accountTxs);
      effects.hashesToSign.push(...settlement.hashesToSign);
      const crossJurisdictionHandled = applyCommittedCrossJurisdictionAccountTxFollowup(
        env,
        state,
        counterpartyId,
        accountTx,
        effects.outputs,
        frame.timestamp,
        effects.swapOffersCreated,
        options?.storageChanges ?? [],
        effects.candidateEffects,
      );
      if (!crossJurisdictionHandled) {
        await applyCommittedHtlcLockFollowup(
          {
            env,
            state: context.state,
            newState: state,
            input,
            account: account,
            outputs: effects.outputs,
            accountTxs: effects.accountTxs,
            candidateEffects: effects.candidateEffects,
            ...(options?.infraContext ? { infraContext: options.infraContext } : {}),
            ...(options?.preparedHtlcEntriesByBinding
              ? { preparedHtlcEntriesByBinding: options.preparedHtlcEntriesByBinding }
              : {}),
            consumedPreparedHtlcBindings,
          },
          accountTx,
          frame,
          committedViaNewFrame,
        );
      }
      applyCommittedSwapFollowup(context, accountTx);
    }
  }
};

const queueInitialHubPolicies = (
  context: SuccessfulAccountInputContext,
  committedInboundGenesis: boolean,
): void => {
  const { state, account, counterpartyId, createdAccount, effects } = context;
  if (!createdAccount || !committedInboundGenesis || !state.hubRebalanceConfig) return;
  const localSide = state.entityId.toLowerCase() === account.state.leftEntity.toLowerCase()
    ? 'left'
    : 'right';
  for (const tokenId of [...account.state.deltas.keys()].sort((left, right) => left - right)) {
    const policy = account.state.rebalanceFeePolicies?.get(tokenId)?.[localSide];
    if (policy?.policyVersion === state.hubRebalanceConfig.policyVersion) continue;
    effects.accountTxs.push({
      accountId: counterpartyId,
      tx: buildHubRebalancePolicyTx(state.hubRebalanceConfig, tokenId),
    });
  }
};

const applyCommittedHtlcFollowups = (
  context: SuccessfulAccountInputContext,
): void => {
  const { env, state, input, account, result, effects } = context;
  const followupContext = {
    env,
    state: context.state,
    newState: state,
    input,
    account: account,
    outputs: effects.outputs,
    accountTxs: effects.accountTxs,
    candidateEffects: effects.candidateEffects,
  };
  applyPendingForwardFollowup(followupContext);
  applyHtlcTimeoutFollowups(followupContext, result.timedOutHashlocks ?? []);
  applyHtlcSecretFollowups(followupContext, result.revealedSecrets ?? []);
};

const logCommittedSwapEffects = (effects: CommittedAccountEffects): void => {
  if (effects.swapOffersCreated.length > 0) {
    accountHandlerLog.debug('swap.offers_committed', { count: effects.swapOffersCreated.length });
  }
  if (effects.swapCancelRequests.length > 0) {
    accountHandlerLog.debug('swap.cancel_requests_committed', {
      count: effects.swapCancelRequests.length,
    });
  }
  if (effects.swapOffersCancelled.length > 0) {
    accountHandlerLog.debug('swap.offers_cancelled_committed', {
      count: effects.swapOffersCancelled.length,
    });
  }
};

export const applySuccessfulAccountInput = async (
  context: SuccessfulAccountInputContext,
): Promise<boolean | undefined> => {
  const { env, state, input, account, counterpartyId, createdAccount, result, effects } = context;
  effects.candidateEffects.push(...(result.candidateEffects ?? []));
  addMessages(state, result.events);
  emitScopedEvents(
    env,
    'account',
    `E/A/${state.entityId.slice(-4)}:${counterpartyId.slice(-4)}/consensus`,
    result.events,
    {
      entityId: state.entityId,
      counterpartyId,
      frameHeight: accountInputReferenceHeight(input),
      hasNewFrame: Boolean(accountInputProposal(input)),
    },
    state.entityId,
  );
  effects.hashesToSign.push(...(result.hashesToSign ?? []));
  recordCommittedFrames(context);

  const committedFrames = result.committedFrames ?? [];
  const committedInboundGenesis = committedFrames.some(({ frame }) => frame.height === 1);
  if (createdAccount) {
    if (!committedInboundGenesis) {
      throw new Error(`ACCOUNT_GENESIS_COMMIT_REQUIRED:${counterpartyId}`);
    }
    putEntityAccountCandidate(state.accounts, counterpartyId, account);
    accountHandlerLog.debug('machine.created', { counterparty: shortId(counterpartyId) });
  }

  await applyCommittedFrameTransactions(context);
  queueInitialHubPolicies(context, committedInboundGenesis);
  applyCommittedHtlcFollowups(context);
  scheduleCommittedAccountWork(state, counterpartyId);
  context.checkpointProfile('committedFollowups');
  logCommittedSwapEffects(effects);

  if (!result.response) {
    // Only the pure ACK that actually commits our pending frame may clear a
    // previous forced response in this Entity batch. Stale/duplicate no-op
    // ACKs preserve it; otherwise [duplicate frame, stale ACK] loses the exact
    // re-answer and deadlocks the bilateral lane.
    const committedOurPending = !accountInputProposal(input)
      && (result.committedFrames ?? []).some(frame => !frame.committedViaNewFrame);
    return committedOurPending ? false : undefined;
  }
  accountHandlerLog.debug('response.deferred_to_entity_flush', {
    from: shortId(state.entityId),
    to: shortId(result.response.toEntityId),
    height: accountInputReferenceHeight(result.response),
    prevHanko: Boolean(accountInputAck(result.response)),
  });
  context.checkpointProfile('responseDeferred');
  return true;
};
