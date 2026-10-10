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
import { safeStringify } from '../../../../protocol/serialization';
import { countOp } from '../../../../support/performance/op-counters';
import { MalformedEntityFrameInputError } from '../../processing/invariant-errors';
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

/**
 * A counterparty's authenticated Account frame failed inside the Account
 * transition (a tx rejected on replay, a state-root/hanko mismatch, or an
 * input carrying no consensus action at all). The decision is typed here,
 * without reading process env; the Runtime loop alone applies the reject
 * policy (fail-fast halt in tests/dev, log-and-drop in production) once it
 * evicts the exact parent Entity transaction (docs/reject-policy.md).
 */
export class AccountFrameRejectionError extends MalformedEntityFrameInputError {
  constructor(rejection: string) {
    super('accountInput', rejection);
    this.name = 'AccountFrameRejectionError';
  }
}

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

type AccountConsensusOutcome = {
  forceAccountFlush?: boolean;
  forcedAccountInput?: AccountInput;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  terminalResult?: AccountHandlerResult;
};

export type PreparedAccountConsensusRun = Readonly<{
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
  throw new AccountFrameRejectionError(error);
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
    accountHandlerLog.debug('frame.input_rejected', {
      from: shortId(input.fromEntityId),
      code: accountInputPeerRejectionCode(result),
      error: result.rejection.message,
      dump,
    });
    addMessage(state, `❌ Rejected account frame: ${result.rejection.message}`);
    countOp(`account.input.rejected.${result.rejection.code}`);
    // Account inputs are authenticated peer evidence. Reject the exact parent
    // Entity transaction so the proposer evicts it and validators reject a
    // frame containing it. Unknown verifier/reducer failures still propagate
    // through the fail-stop branches below.
    throw new MalformedEntityFrameInputError(
      'accountInput',
      `ACCOUNT_INPUT_INPUT_REJECTED:${result.rejection.code}:${result.rejection.message}`,
    );
  }
  if (result.rejection.kind === 'tx' || result.rejection.kind === 'validation') {
    const failureMessage = accountInputFailureMessage(result);
    accountHandlerLog.error('frame.consensus_failed', {
      from: shortId(input.fromEntityId),
      error: failureMessage,
    });
    addMessage(state, `❌ ${failureMessage}`);
    // Owner canon: a peer can never take the Runtime down. The transition only
    // types the rejection; the Runtime loop evicts the exact parent Entity
    // transaction and applies fail-fast or log-and-drop outside this machine.
    throw new AccountFrameRejectionError(
      `ACCOUNT_INPUT_FRAME_REJECTED:${result.rejection.kind}:${failureMessage || 'unknown'}`,
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
