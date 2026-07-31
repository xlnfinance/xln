import type { AccountPeerInput, AccountReplica } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { AccountConsensusContext } from '../../../../account/consensus/context';
import { applyAccountInput } from '../../../../account/consensus';
import {
  accountInputAck,
  accountInputProposal,
  accountInputReferenceHeight,
} from '../../../../account/consensus/flush';
import { addMessage } from '../../../frame-events';
import { createStructuredLogger, shortId } from '../../../../infra/logger';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../../jurisdiction/machine/board-registry';
import { verifyHankoForHash } from '../../../../hanko/signing';
import type { AccountJClaimNodeChanges } from '../../../../types/account-j-claims';
import type { ApplyEntityTxOptions } from '../../apply';
import {
  applySuccessfulAccountInput,
  type CommittedAccountEffects,
} from './committed-input';
import { handleUnsafeAccountFrame } from './dispute-input';
import {
  buildAccountHandlerResult,
  type AccountHandlerResult,
} from './result';

const accountHandlerLog = createStructuredLogger('account.handler');

export type AccountInputPhaseContext = {
  env: EntityRuntimeContext;
  accountConsensusContext: AccountConsensusContext;
  state: EntityState;
  input: AccountPeerInput;
  account: AccountReplica;
  counterpartyId: string;
  createdAccount: boolean;
  effects: CommittedAccountEffects;
  options?: ApplyEntityTxOptions;
  checkpointProfile(label: string): void;
};

export type AccountConsensusOutcome = {
  requiredAccountResponse?: AccountPeerInput;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  terminalResult?: AccountHandlerResult;
};

const logCrossFillAckResult = (
  context: AccountInputPhaseContext,
  result: Awaited<ReturnType<typeof applyAccountInput>>,
  pendingBeforeTxs: string[],
  inputFrameTxs: string[],
): void => {
  const { state, input, account, counterpartyId } = context;
  const touchesCrossFillAck =
    pendingBeforeTxs.includes('cross_swap_fill_ack') ||
    inputFrameTxs.includes('cross_swap_fill_ack') ||
    (result.committedFrames ?? []).some(({ frame }) =>
      frame.accountTxs.some(tx => tx.type === 'cross_swap_fill_ack'));
  if (!touchesCrossFillAck) return;
  accountHandlerLog.debug('cross_fill_ack.input_result', {
    entity: shortId(state.entityId),
    counterparty: shortId(counterpartyId),
    inputHeight: accountInputReferenceHeight(input),
    hasPrevHanko: Boolean(accountInputAck(input)),
    inputFrameTxs,
    pendingBeforeTxs,
    pendingAfter: account.pendingFrame?.accountTxs.map(tx => tx.type) ?? [],
    currentHeight: account.currentHeight,
    committedTxs: (result.committedFrames ?? []).map(({ frame }) =>
      frame.accountTxs.map(tx => tx.type)),
    events: result.events,
    success: result.success,
    error: result.success ? undefined : result.error,
  });
};

const rejectEmptyAccountInput = (context: AccountInputPhaseContext): never => {
  const { state, input } = context;
  const error =
    `ACCOUNT_INPUT_EMPTY: from=${shortId(input.fromEntityId)} ` +
    `to=${shortId(input.toEntityId)}`;
  accountHandlerLog.error('input.empty', {
    from: shortId(input.fromEntityId),
    to: shortId(input.toEntityId),
  });
  addMessage(state, `❌ ${error}`);
  throw new Error(error);
};

export const applyAccountConsensusInput = async (context: AccountInputPhaseContext): Promise<AccountConsensusOutcome> => {
  const { env, accountConsensusContext, state, input, account } = context;
  const { counterpartyId, createdAccount, effects, options } = context;
  const incomingAck = accountInputAck(input);
  const incomingProposal = accountInputProposal(input);
  const hasConsensusInput =
    Boolean(incomingAck) ||
    Boolean(incomingProposal) ||
    input.kind === 'dispute' ||
    input.kind === 'board_reseal';
  if (!hasConsensusInput) {
    rejectEmptyAccountInput(context);
  }

  const pendingBeforeTxs = account.pendingFrame?.accountTxs.map(tx => tx.type) ?? [];
  const inputFrameTxs = incomingProposal?.frame.accountTxs.map(tx => tx.type) ?? [];
  accountHandlerLog.debug('frame.process', {
    from: shortId(input.fromEntityId),
    pending: account.pendingFrame?.height ?? null,
  });
  const boardHash = resolveObserverCertifiedBoardHash(
    state,
    getCertifiedBoardNodeStore(env),
    input.fromEntityId,
  );
  const result = await applyAccountInput(accountConsensusContext, account, input, {
    entityTimestamp: state.timestamp,
    finalizedJHeight: state.lastFinalizedJHeight ?? 0,
    owningEntityIsHub: Boolean(state.hubRebalanceConfig),
    verifyHanko: (hanko, hash, expectedEntityId, authority) =>
      verifyHankoForHash(hanko, hash, expectedEntityId, env, authority),
    ...(boardHash ? { counterpartyCertifiedBoardHash: boardHash } : {}),
  });
  context.checkpointProfile('consensus');
  logCrossFillAckResult(context, result, pendingBeforeTxs, inputFrameTxs);

  if (result.success) {
    const response = await applySuccessfulAccountInput({
      env,
      state,
      input,
      account,
      counterpartyId,
      createdAccount,
      result,
      effects,
      ...(options ? { options } : {}),
      checkpointProfile: context.checkpointProfile,
    });
    context.checkpointProfile('postConsensus');
    return {
      ...(response ? { requiredAccountResponse: response } : {}),
      ...(result.accountJClaimNodeChanges
        ? { accountJClaimNodeChanges: result.accountJClaimNodeChanges }
        : {}),
    };
  }
  if (result.disputeRequired) {
    const unsafe = await handleUnsafeAccountFrame({
      env,
      state,
      input,
      account,
      counterpartyId,
      createdAccount,
      dispute: result.disputeRequired,
      effects,
    });
    return {
      terminalResult: buildAccountHandlerResult(
        unsafe.newState,
        { ...effects, outputs: unsafe.outputs },
        undefined,
        result.accountJClaimNodeChanges,
      ),
    };
  }
  if (result.rejected) {
    accountHandlerLog.warn('frame.rejected', {
      from: shortId(input.fromEntityId),
      error: result.rejected.reason,
    });
    addMessage(state, `⚠️ Rejected account frame: ${result.rejected.reason}`);
    return {
      terminalResult: buildAccountHandlerResult(
        state,
        effects,
        undefined,
        result.accountJClaimNodeChanges,
      ),
    };
  }
  accountHandlerLog.error('frame.consensus_failed', {
    from: shortId(input.fromEntityId),
    error: result.error,
  });
  addMessage(state, `❌ ${result.error}`);
  throw new Error(`FRAME_CONSENSUS_FAILED: ${result.error || 'unknown'}`);
};
