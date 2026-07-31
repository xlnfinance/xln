import type { AccountPeerInput, AccountReplica } from '../../../../types/account';
import type { EntityCandidateEffect, EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { HandleAccountInputResult } from '../../../../account/consensus/types';
import {
  accountInputAck,
  accountInputProposal,
  accountInputReferenceHeight,
} from '../../../../account/consensus/flush';
import { emitScopedEvents } from '../../../../infra/scoped-events';
import { addMessages } from '../../../frame-events';
import { createStructuredLogger, shortId } from '../../../../infra/logger';
import { scheduleHook } from '../../../scheduler';
import { upsertSortedStringMapEntry } from '../../../../infra/sorted-map-index';
import { pruneUnreachableDisputeEvidence } from '../../../../account/dispute/evidence-retention';
import type { ApplyEntityTxOptions } from '../../apply';
import { buildHubRebalancePolicyTx } from '../account-admin';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../account-cross-j-followups';
import { processCommittedSettlementTransitionFollowup } from '../settle';
import { applyCommittedAccountFrameFollowups } from './committed-frame-followups';
import {
  applyCommittedHtlcLockFollowup,
  applyHtlcSecretFollowups,
  applyHtlcTimeoutFollowups,
  applyPendingForwardFollowup,
} from './committed-htlc-followups';
import type { AccountTxTarget } from './orderbook-queue';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './orderbook-offers';

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
  result: HandleAccountInputResult;
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
    giveAmount: offer.giveAmount,
    wantTokenId: offer.wantTokenId,
    wantAmount: offer.wantAmount,
    ...(offer.priceTicks !== undefined ? { priceTicks: offer.priceTicks } : {}),
    ...(offer.timeInForce !== undefined ? { timeInForce: offer.timeInForce } : {}),
    ...(offer.crossJurisdiction ? { crossJurisdiction: offer.crossJurisdiction } : {}),
  };
};

const scheduleCommittedAccountWork = (
  state: EntityState,
  counterpartyId: string,
): void => {
  if (!state.hubRebalanceConfig || !state.crontabState) return;
  // Rebalance stays global across all Accounts, but any newly committed frame
  // must wake the scheduler promptly rather than waiting for a periodic scan.
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
      frame: structuredClone(frame),
    });
  }
};

const applyCommittedSwapFollowup = (
  context: SuccessfulAccountInputContext,
  accountTx: NonNullable<HandleAccountInputResult['committedFrames']>[number]['frame']['accountTxs'][number],
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
          },
          accountTx,
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
): Promise<AccountPeerInput | undefined> => {
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
  scheduleCommittedAccountWork(state, counterpartyId);
  effects.hashesToSign.push(...(result.hashesToSign ?? []));
  recordCommittedFrames(context);

  const committedFrames = result.committedFrames ?? [];
  const committedInboundGenesis = committedFrames.some(({ frame }) => frame.height === 1);
  if (createdAccount) {
    if (!committedInboundGenesis) {
      throw new Error(`ACCOUNT_GENESIS_COMMIT_REQUIRED:${counterpartyId}`);
    }
    upsertSortedStringMapEntry(state.accounts, counterpartyId, account);
    accountHandlerLog.debug('machine.created', { counterparty: shortId(counterpartyId) });
  }

  await applyCommittedFrameTransactions(context);
  queueInitialHubPolicies(context, committedInboundGenesis);
  applyCommittedHtlcFollowups(context);
  if (committedFrames.length > 0) {
    pruneUnreachableDisputeEvidence(account, state.jBatchState);
  }
  context.checkpointProfile('committedFollowups');
  logCommittedSwapEffects(effects);

  if (!result.response) return undefined;
  const response = structuredClone(result.response);
  accountHandlerLog.debug('response.deferred_to_entity_flush', {
    from: shortId(state.entityId),
    to: shortId(response.toEntityId),
    height: accountInputReferenceHeight(response),
    prevHanko: Boolean(accountInputAck(response)),
  });
  context.checkpointProfile('responseDeferred');
  return response;
};
