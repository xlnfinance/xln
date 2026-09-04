import type {
  AccountFrame,
  AccountOutput,
  AccountInput,
  AccountReplica,
  AccountSwapOfferSnapshot,
  AccountTx,
} from '../../../../types/account';
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
  applyDirectPaymentForwardFollowups,
} from './committed-htlc-followups';
import type { AccountTxTarget } from './orderbook/queue';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './orderbook/offers';

const accountHandlerLog = createStructuredLogger('account.handler');

type DirectPaymentForward = Extract<AccountOutput, { kind: 'directPaymentForward' }>;
type SameJurisdictionSwapOutput = Extract<
  AccountOutput,
  { kind: 'swapOfferUpsert' | 'swapOfferRemove' | 'swapCancelRequest' }
>;
type CommittedAccountOutputs = Readonly<{
  directPaymentForwards: readonly DirectPaymentForward[];
  sameJurisdictionSwaps: readonly SameJurisdictionSwapOutput[];
}>;
type SameJurisdictionSwapCursor = {
  outputs: readonly SameJurisdictionSwapOutput[];
  index: number;
};

type AccountHashToSign = {
  hash: string;
  type: 'accountFrame' | 'dispute' | 'settlement';
  context: string;
};

type HubRebalanceConfig = NonNullable<EntityState['hubRebalanceConfig']>;

export type CommittedAccountEffects = {
  outputs: EntityInput[];
  accountTxs: AccountTxTarget[];
  swapOffersCreated: SwapOfferEvent[];
  swapCancelRequests: SwapCancelRequestEvent[];
  swapOffersCancelled: SwapCancelEvent[];
  candidateEffects: EntityCandidateEffect[];
  hashesToSign: AccountHashToSign[];
};

export type AccountInputFlushWork = Readonly<{
  force: boolean;
  /** Exact response emitted by the Account machine; never reconstructed by Entity. */
  response?: AccountInput;
}>;

type SuccessfulAccountInputContext = {
  env: EntityRuntimeContext;
  state: EntityState;
  input: AccountInput;
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

const buildSameJurisdictionSwapOfferEvent = (
  counterpartyId: string,
  offer: AccountSwapOfferSnapshot,
): SwapOfferEvent => ({
  offerId: offer.offerId,
  accountId: counterpartyId,
  makerIsLeft: offer.makerIsLeft,
  fromEntity: offer.leftEntity,
  toEntity: offer.rightEntity,
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
  ...(offer.accountOutputVerified ? { accountOutputVerified: true as const } : {}),
});

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
  if ((result.committedFrames?.length ?? 0) > 0) {
    effects.candidateEffects.push({
      kind: 'accountFrameCommitted',
      entityId: account.proofHeader.fromEntity,
      counterpartyId: input.fromEntityId,
    });
  }
};

const sameJurisdictionSwapOutputOfferId = (
  output: SameJurisdictionSwapOutput,
): string => output.kind === 'swapOfferUpsert' ? output.offer.offerId : output.offerId;

const takeSameJurisdictionSwapOutput = (
  cursor: SameJurisdictionSwapCursor,
  offerId: string,
  allowedKinds: readonly SameJurisdictionSwapOutput['kind'][],
): SameJurisdictionSwapOutput => {
  const output = cursor.outputs[cursor.index];
  if (!output) throw new Error(`ACCOUNT_SWAP_OUTPUT_MISSING:${offerId}`);
  if (!allowedKinds.includes(output.kind)) {
    throw new Error(`ACCOUNT_SWAP_OUTPUT_KIND_MISMATCH:${offerId}:${output.kind}`);
  }
  const outputOfferId = sameJurisdictionSwapOutputOfferId(output);
  if (outputOfferId !== offerId) {
    throw new Error(`ACCOUNT_SWAP_OUTPUT_ID_MISMATCH:${offerId}:${outputOfferId}`);
  }
  cursor.index += 1;
  return output;
};

const applySameJurisdictionSwapOutput = (
  context: SuccessfulAccountInputContext,
  output: SameJurisdictionSwapOutput,
): void => {
  const { counterpartyId, effects } = context;
  if (output.kind === 'swapOfferUpsert') {
    effects.swapOffersCreated.push(
      buildSameJurisdictionSwapOfferEvent(counterpartyId, output.offer),
    );
  } else if (output.kind === 'swapOfferRemove') {
    effects.swapOffersCancelled.push({ offerId: output.offerId, accountId: counterpartyId });
  } else {
    effects.swapCancelRequests.push({ offerId: output.offerId, accountId: counterpartyId });
  }
};

const consumeSameJurisdictionSwapOutput = (
  context: SuccessfulAccountInputContext,
  accountTx: AccountTx,
  cursor: SameJurisdictionSwapCursor,
  sameJurisdictionCancel: boolean | undefined,
): boolean => {
  let output: SameJurisdictionSwapOutput;
  if (accountTx.type === 'swap_offer' && !accountTx.data.crossJurisdiction) {
    output = takeSameJurisdictionSwapOutput(cursor, accountTx.data.offerId, ['swapOfferUpsert']);
  } else if (accountTx.type === 'swap_resolve') {
    output = takeSameJurisdictionSwapOutput(
      cursor,
      accountTx.data.offerId,
      ['swapOfferUpsert', 'swapOfferRemove'],
    );
  } else if (accountTx.type === 'swap_cancel_request') {
    if (sameJurisdictionCancel === undefined) {
      throw new Error(`ACCOUNT_SWAP_CANCEL_SCOPE_MISSING:${accountTx.data.offerId}`);
    }
    if (!sameJurisdictionCancel) return false;
    output = takeSameJurisdictionSwapOutput(cursor, accountTx.data.offerId, ['swapCancelRequest']);
  } else {
    return false;
  }
  applySameJurisdictionSwapOutput(context, output);
  return true;
};

const finalSwapCancelScope = (
  account: AccountReplica,
  offerId: string,
): boolean => {
  const offer = account.state.swapOffers.get(offerId);
  if (!offer) throw new Error(`ACCOUNT_SWAP_CANCEL_SCOPE_UNRESOLVED:${offerId}`);
  return !offer.crossJurisdiction;
};

const classifyCommittedSwapCancels = (
  account: AccountReplica,
  accountTxs: readonly AccountTx[],
): readonly (boolean | undefined)[] => {
  // `swap_cancel_request` deliberately carries only offerId. Never infer its
  // jurisdiction from whether a typed output happens to exist: a missing
  // same-j output would then silently enter the cross-j projection path. Walk
  // backward from committed state instead. A later resolver/ACK identifies an
  // offer removed after the request; otherwise the still-live committed offer
  // is the authority. If neither exists, the committed sequence is malformed.
  const sameJurisdictionByIndex: Array<boolean | undefined> = Array(accountTxs.length);
  const futureScopeByOffer = new Map<string, boolean>();
  for (let index = accountTxs.length - 1; index >= 0; index -= 1) {
    const tx = accountTxs[index];
    if (!tx) throw new Error(`ACCOUNT_COMMITTED_TX_INDEX_MISSING:${index}`);
    if (tx.type === 'swap_cancel_request') {
      sameJurisdictionByIndex[index] = futureScopeByOffer.get(tx.data.offerId) ??
        finalSwapCancelScope(account, tx.data.offerId);
    } else if (tx.type === 'swap_resolve') {
      futureScopeByOffer.set(tx.data.offerId, true);
    } else if (tx.type === 'swap_offer') {
      futureScopeByOffer.set(tx.data.offerId, !tx.data.crossJurisdiction);
    }
  }
  return sameJurisdictionByIndex;
};

const applyCommittedCrossJurisdictionSwapFollowup = (
  context: SuccessfulAccountInputContext,
  accountTx: AccountTx,
): void => {
  const { account, counterpartyId, effects } = context;
  if (accountTx.type === 'swap_offer') {
    if (!accountTx.data.crossJurisdiction) {
      throw new Error(`ACCOUNT_SAME_J_SWAP_OUTPUT_BYPASSED:${accountTx.data.offerId}`);
    }
    const event = buildCommittedSwapOfferEvent(account, counterpartyId, accountTx.data.offerId);
    if (event) effects.swapOffersCreated.push(event);
  } else if (accountTx.type === 'swap_cancel_request') {
    effects.swapCancelRequests.push({ offerId: accountTx.data.offerId, accountId: counterpartyId });
  }
};

const applyCommittedFrameTransactions = async (
  context: SuccessfulAccountInputContext,
  swapCursor: SameJurisdictionSwapCursor,
): Promise<void> => {
  const { env, state, input, account, counterpartyId, result, effects, options } = context;
  const bookIntentSlot = options?.bookIntentSlot;
  const consumedPreparedHtlcBindings = new Set<string>();
  const committedAccountTxs = (result.committedFrames ?? [])
    .flatMap(({ frame }) => frame.accountTxs ?? []);
  const sameJurisdictionCancels = classifyCommittedSwapCancels(account, committedAccountTxs);
  let committedAccountTxIndex = 0;
  for (const { frame, proposerIsLeft, committedViaNewFrame } of result.committedFrames ?? []) {
    applyCommittedAccountFrameFollowups(
      state,
      counterpartyId,
      frame,
      proposerIsLeft,
      effects.accountTxs,
      env,
      effects.candidateEffects,
      bookIntentSlot,
    );
    for (const accountTx of frame.accountTxs ?? []) {
      const settlement = await processCommittedSettlementTransitionFollowup(
        account,
        accountTx,
        frame,
        proposerIsLeft,
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
            ...(bookIntentSlot ? { bookIntentSlot } : {}),
            ...(options?.infraContext ? { infraContext: options.infraContext } : {}),
            ...(options?.preparedHtlcEntriesByBinding
              ? { preparedHtlcEntriesByBinding: options.preparedHtlcEntriesByBinding }
              : {}),
            consumedPreparedHtlcBindings,
          },
          accountTx,
          frame,
          proposerIsLeft,
          committedViaNewFrame,
        );
      }
      if (!consumeSameJurisdictionSwapOutput(
        context,
        accountTx,
        swapCursor,
        sameJurisdictionCancels[committedAccountTxIndex],
      )) {
        applyCommittedCrossJurisdictionSwapFollowup(context, accountTx);
      }
      committedAccountTxIndex += 1;
    }
  }
  const unconsumed = swapCursor.outputs.length - swapCursor.index;
  if (unconsumed !== 0) throw new Error(`ACCOUNT_SWAP_OUTPUT_UNCONSUMED:${unconsumed}`);
};

export const buildInitialHubPolicyTargets = (
  counterpartyId: string,
  config: HubRebalanceConfig,
  committedInboundGenesis: Pick<AccountFrame, 'accountTxs'>,
): AccountTxTarget[] => {
  const tokenIds = new Set(committedInboundGenesis.accountTxs
    .filter(tx => tx.type === 'add_delta')
    .map(tx => tx.data.tokenId));
  return [...tokenIds]
    .sort((left, right) => left - right)
    .map(tokenId => ({
      accountId: counterpartyId,
      tx: buildHubRebalancePolicyTx(config, tokenId),
    }));
};

const queueInitialHubPolicies = (
  context: SuccessfulAccountInputContext,
  committedInboundGenesis: AccountFrame | undefined,
): void => {
  const { state, counterpartyId, createdAccount, effects } = context;
  if (!createdAccount || !committedInboundGenesis || !state.hubRebalanceConfig) return;
  effects.accountTxs.push(...buildInitialHubPolicyTargets(
    counterpartyId,
    state.hubRebalanceConfig,
    committedInboundGenesis,
  ));
};

const applyCommittedHtlcFollowups = (
  context: SuccessfulAccountInputContext,
  directPaymentForwards: readonly DirectPaymentForward[],
): void => {
  const { env, state, input, account, result, effects } = context;
  const bookIntentSlot = context.options?.bookIntentSlot;
  const followupContext = {
    env,
    state: context.state,
    newState: state,
    input,
    account: account,
    outputs: effects.outputs,
    accountTxs: effects.accountTxs,
    candidateEffects: effects.candidateEffects,
    ...(bookIntentSlot ? { bookIntentSlot } : {}),
  };
  applyDirectPaymentForwardFollowups(followupContext, directPaymentForwards);
  applyHtlcTimeoutFollowups(followupContext, result.timedOutHashlocks ?? []);
  applyHtlcSecretFollowups(followupContext, result.revealedSecrets ?? []);
};

const collectCommittedAccountOutputs = (
  effects: CommittedAccountEffects,
  outputs: readonly AccountOutput[],
): CommittedAccountOutputs => {
  const directPaymentForwards: DirectPaymentForward[] = [];
  const sameJurisdictionSwaps: SameJurisdictionSwapOutput[] = [];
  for (const output of outputs) {
    switch (output.kind) {
      case 'directPaymentForward':
        directPaymentForwards.push(output);
        break;
      case 'swapOfferUpsert':
      case 'swapOfferRemove':
      case 'swapCancelRequest':
        sameJurisdictionSwaps.push(output);
        break;
      case 'runtimeEvent':
      case 'debug':
        effects.candidateEffects.push(output);
        break;
      default: {
        const unhandled: never = output;
        throw new Error(`ACCOUNT_OUTPUT_UNHANDLED:${String(unhandled)}`);
      }
    }
  }
  return { directPaymentForwards, sameJurisdictionSwaps };
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
): Promise<AccountInputFlushWork | undefined> => {
  const { env, state, input, account, counterpartyId, createdAccount, result, effects } = context;
  const accountOutputs = collectCommittedAccountOutputs(
    effects,
    result.candidateEffects ?? [],
  );
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
  const committedInboundGenesis = committedFrames.find(
    ({ frame, committedViaNewFrame }) => frame.height === 1 && committedViaNewFrame,
  )?.frame;
  if (createdAccount) {
    if (!committedInboundGenesis) {
      throw new Error(`ACCOUNT_GENESIS_COMMIT_REQUIRED:${counterpartyId}`);
    }
    putEntityAccountCandidate(state.accounts, counterpartyId, account);
    accountHandlerLog.debug('machine.created', { counterparty: shortId(counterpartyId) });
  }

  await applyCommittedFrameTransactions(context, {
    outputs: accountOutputs.sameJurisdictionSwaps,
    index: 0,
  });
  queueInitialHubPolicies(context, committedInboundGenesis);
  applyCommittedHtlcFollowups(context, accountOutputs.directPaymentForwards);
  scheduleCommittedAccountWork(state, counterpartyId);
  context.checkpointProfile('committedFollowups');
  logCommittedSwapEffects(effects);

  if (!result.response) {
    // Only the pure ACK that actually commits our pending frame may clear a
    // previous forced response in this Entity batch. Exact repeated ACKs
    // preserve it; otherwise a duplicate frame can lose the required
    // re-answer and deadlock the bilateral lane.
    const committedOurPending = !accountInputProposal(input)
      && (result.committedFrames ?? []).some(frame => !frame.committedViaNewFrame);
    return committedOurPending ? { force: false } : undefined;
  }
  accountHandlerLog.debug('response.deferred_to_entity_flush', {
    from: shortId(state.entityId),
    to: shortId(result.response.toEntityId),
    height: accountInputReferenceHeight(result.response),
    prevHanko: Boolean(accountInputAck(result.response)),
  });
  context.checkpointProfile('responseDeferred');
  return { force: true, response: result.response };
};
