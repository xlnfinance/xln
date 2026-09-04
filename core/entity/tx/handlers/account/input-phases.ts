import type { AccountInput, AccountReplica } from '../../../../types/account';
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
  input: AccountInput;
  account: AccountReplica;
  counterpartyId: string;
  createdAccount: boolean;
  effects: CommittedAccountEffects;
  options?: ApplyEntityTxOptions;
  checkpointProfile(label: string): void;
};

export type AccountConsensusOutcome = {
  forceAccountFlush?: boolean;
  forcedAccountInput?: AccountInput;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  terminalResult?: AccountHandlerResult;
};

export type PreparedAccountConsensusRun = Readonly<{
  pendingBeforeTxs: string[];
  inputFrameTxs: string[];
  securityContext: AccountInputSecurityContext;
}>;

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
  const flushWork = await applySuccessfulAccountInput({
    env, state, input, account, counterpartyId, createdAccount, result, effects,
    ...(options ? { options } : {}),
    checkpointProfile: context.checkpointProfile,
  });
  context.checkpointProfile('postConsensus');
  return {
    ...(flushWork === undefined ? {} : { forceAccountFlush: flushWork.force }),
    ...(flushWork?.response === undefined ? {} : { forcedAccountInput: flushWork.response }),
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
  const bookIntentSlot = context.options?.bookIntentSlot;
  const unsafe = await handleUnsafeAccountFrame({
    env, state, input, account, counterpartyId, createdAccount,
    dispute: result.disputeRequired,
    effects,
    ...(bookIntentSlot ? { bookIntentSlot } : {}),
  });
  return {
    terminalResult: buildAccountHandlerResult(
      unsafe.newState,
      { ...effects, outputs: unsafe.outputs },
      undefined,
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
  if (result.rejection.kind === 'input') {
    const dump = safeStringify({
      input,
      account: context.account,
      entityId: state.entityId,
      entityHeight: state.height,
      rejection: result.rejection,
    });
    accountHandlerLog.error('frame.input_rejected', {
      from: shortId(input.fromEntityId),
      code: accountInputPeerRejectionCode(result),
      error: result.rejection.message,
      dump,
    });
    addMessage(state, `❌ Rejected account frame: ${result.rejection.message}`);
    throw haltRuntimeFailure(
      'FRAME_CONSENSUS_FAILED',
      `ACCOUNT_INPUT_INPUT_REJECTED:${result.rejection.code}:` +
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
  _prepared: PreparedAccountConsensusRun,
  _result: Awaited<ReturnType<typeof applyAccountInput>>,
): void => {
  context.checkpointProfile('consensus');
};
