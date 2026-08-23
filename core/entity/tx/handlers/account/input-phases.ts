import type { AccountPeerInput, AccountReplica } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { AccountConsensusContext } from '../../../../account/consensus/context';
import {
  applyAccountInput,
  type AccountInputSecurityContext,
} from '../../../../account/consensus';
import {
  accountInputFailureMessage,
  accountInputPeerRejectionCode,
  assertNeverAccountResult,
  isAccountInputDispute,
} from '../../../../account/consensus/result';
import {
  accountInputAck,
  accountInputProposal,
  accountInputReferenceHeight,
} from '../../../../account/consensus/flush';
import { addMessage } from '../../../frame-events';
import { createStructuredLogger, shortId } from '../../../../support/logger';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from '../../../../jurisdiction/machine/board-registry';
import { verifyHankoForHash } from '../../../../hanko/signing';
import type { AccountJClaimNodeChanges } from '../../../../types/finance/account-j-claims';
import type { ApplyEntityTxOptions } from '../../apply';
import { haltRuntimeFailure } from '../../../../protocol/errors/failure-taxonomy';
import { safeStringify } from '../../../../protocol/serialization';
import {
  applySuccessfulAccountInput,
  type CommittedAccountEffects,
} from './committed-input';
import { handleUnsafeAccountFrame } from './dispute-input';
import {
  buildAccountHandlerResult,
  type AccountHandlerResult,
} from './lifecycle/result';

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
  forceAccountFlush?: boolean;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  terminalResult?: AccountHandlerResult;
};

export type PreparedAccountConsensusRun = Readonly<{
  pendingBeforeTxs: string[];
  inputFrameTxs: string[];
  securityContext: AccountInputSecurityContext;
}>;

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
    (result.ok ? result.committedFrames ?? [] : []).some(({ frame }) =>
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
    committedTxs: (result.ok ? result.committedFrames ?? [] : []).map(({ frame }) =>
      frame.accountTxs.map(tx => tx.type)),
    events: result.events,
    ok: result.ok,
    error: result.ok ? undefined : accountInputFailureMessage(result),
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

const finishAppliedAccountInput = async (
  context: AccountInputPhaseContext,
  result: Extract<Awaited<ReturnType<typeof applyAccountInput>>, { ok: true }>,
): Promise<AccountConsensusOutcome> => {
  const { env, state, input, account, counterpartyId, createdAccount, effects, options } = context;
  const forceAccountFlush = await applySuccessfulAccountInput({
    env, state, input, account, counterpartyId, createdAccount, result, effects,
    ...(options ? { options } : {}),
    checkpointProfile: context.checkpointProfile,
  });
  context.checkpointProfile('postConsensus');
  return {
    ...(forceAccountFlush === undefined ? {} : { forceAccountFlush }),
    ...(result.accountJClaimNodeChanges
      ? { accountJClaimNodeChanges: result.accountJClaimNodeChanges }
      : {}),
  };
};

const finishDisputedAccountInput = async (
  context: AccountInputPhaseContext,
  result: Extract<Awaited<ReturnType<typeof applyAccountInput>>, { disposition: 'dispute' }>,
): Promise<AccountConsensusOutcome> => {
  const { env, state, input, account, counterpartyId, createdAccount, effects } = context;
  const unsafe = await handleUnsafeAccountFrame({
    env, state, input, account, counterpartyId, createdAccount,
    dispute: result.disputeRequired,
    effects,
  });
  return {
    terminalResult: buildAccountHandlerResult(
      unsafe.newState,
      { ...effects, outputs: unsafe.outputs },
      undefined,
      undefined,
    ),
  };
};

const finishRejectedAccountInput = (
  context: AccountInputPhaseContext,
  result: Extract<Awaited<ReturnType<typeof applyAccountInput>>, { disposition: 'rejected' }>,
): AccountConsensusOutcome => {
  const { state, input } = context;
  if (result.rejection.kind === 'peer') {
    const dump = safeStringify({
      input,
      account: context.account,
      entityId: state.entityId,
      entityHeight: state.height,
      rejection: result.rejection,
    });
    accountHandlerLog.error('frame.peer_rejected', {
      from: shortId(input.fromEntityId),
      code: accountInputPeerRejectionCode(result),
      error: result.rejection.message,
      dump,
    });
    addMessage(state, `❌ Rejected account frame: ${result.rejection.message}`);
    throw haltRuntimeFailure(
      'FRAME_CONSENSUS_FAILED',
      `ACCOUNT_PEER_INPUT_REJECTED:${result.rejection.code}:` +
        `${result.rejection.message}:dump=${dump}`,
    );
  }
  if (result.rejection.kind === 'tx' || result.rejection.kind === 'validation') {
    const failureMessage = accountInputFailureMessage(result);
    accountHandlerLog.error('frame.consensus_failed', {
      from: shortId(input.fromEntityId),
      error: failureMessage,
    });
    addMessage(state, `❌ ${failureMessage}`);
    throw haltRuntimeFailure(
      'FRAME_CONSENSUS_FAILED',
      `FRAME_CONSENSUS_FAILED: ${failureMessage || 'unknown'}`,
    );
  }
  return assertNeverAccountResult(result.rejection);
};

export const finishAccountConsensusInput = async (
  context: AccountInputPhaseContext,
  result: Awaited<ReturnType<typeof applyAccountInput>>,
): Promise<AccountConsensusOutcome> => {
  if (result.ok) return finishAppliedAccountInput(context, result);
  if (isAccountInputDispute(result)) return finishDisputedAccountInput(context, result);
  if (result.disposition === 'rejected') return finishRejectedAccountInput(context, result);
  return assertNeverAccountResult(result);
};

export const prepareAccountConsensusRun = (
  context: AccountInputPhaseContext,
): PreparedAccountConsensusRun => {
  const { env, state, input, account } = context;
  const incomingAck = accountInputAck(input);
  const incomingProposal = accountInputProposal(input);
  const hasConsensusInput =
    Boolean(incomingAck) ||
    Boolean(incomingProposal) ||
    input.kind === 'dispute' ||
    input.kind === 'board_hanko_refresh';
  if (!hasConsensusInput) {
    rejectEmptyAccountInput(context);
  }

  const pendingBeforeTxs = account.pendingFrame?.accountTxs.map(tx => tx.type) ?? [];
  const inputFrameTxs = incomingProposal?.frame.accountTxs.map(tx => tx.type) ?? [];
  accountHandlerLog.debug('frame.process', {
    from: shortId(input.fromEntityId),
    pending: account.pendingFrame?.height ?? null,
  });
  const certifiedBoard = resolveObserverCertifiedBoardRecord(
    state,
    getCertifiedBoardNodeStore(env),
    input.fromEntityId,
  );
  return {
    pendingBeforeTxs,
    inputFrameTxs,
    securityContext: {
      entityTimestamp: state.timestamp,
      finalizedJHeight: state.lastFinalizedJHeight ?? 0,
      owningEntityIsHub: Boolean(state.hubRebalanceConfig),
      verifyHanko: (hanko, hash, expectedEntityId, authority) =>
      verifyHankoForHash(hanko, hash, expectedEntityId, env, {
        ...authority,
        observerState: state,
      }),
      ...(certifiedBoard
        ? {
            counterpartyCertifiedBoard: {
              boardHash: certifiedBoard.boardHash,
              activatedAtJHeight: certifiedBoard.activatedAtJHeight,
              logIndex: certifiedBoard.logIndex,
            },
          }
        : {}),
    },
  };
};

export const completeAccountConsensusRun = (
  context: AccountInputPhaseContext,
  prepared: PreparedAccountConsensusRun,
  result: Awaited<ReturnType<typeof applyAccountInput>>,
): void => {
  context.checkpointProfile('consensus');
  logCrossFillAckResult(
    context,
    result,
    prepared.pendingBeforeTxs,
    prepared.inputFrameTxs,
  );
};
