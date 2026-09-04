import type { AccountInput } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import { createStructuredLogger, shortId } from '../../../../support/logger';
import {
  accountInputAck,
  accountInputProposal,
  accountInputReferenceHeight,
} from '../../../../account/consensus/flush';
import type { ApplyEntityTxOptions } from '../../apply';
import type { AccountConsensusContext } from '../../../../account/consensus/context';
import { cumulativeMarksToPhases } from '../../../../support/performance/profile';
import { getPerfMs } from '../../../../support/time';
import { AccountInputEvidenceError } from '../../../../account/input/input-rejection';
import { resolveInboundAccount } from './inbound-account';
import { rejectFrozenAccountInput } from './frozen-input';
import type { CommittedAccountEffects } from './committed-input';
import {
  finishAccountConsensusInput,
  prepareAccountConsensusRun,
  completeAccountConsensusRun,
  type AccountInputPhaseContext,
  type PreparedAccountConsensusRun,
} from './input-phases';
import { applyAccountInput } from '../../../../account/consensus';
import { requireAccountDeltaTransformerAddress } from '../../../../account/consensus/helpers';
import {
  buildAccountHandlerResult,
  type AccountHandlerResult,
} from './lifecycle/result';
import { addMessage } from '../../../frame-events';
import { safeStringify } from '../../../../protocol/serialization';
import { countOp } from '../../../../support/performance/op-counters';
import { MalformedEntityFrameInputError } from '../../processing/invariant-errors';
import { traceAccountApplyHop } from '../../../../support/performance/account-delivery-trace';
import {
  authorityRecordEnabled,
  noteAuthorityAccountCreate,
} from '../../../../rscore/authority-wave';
import { normalizeEntityRef } from '../../account-key';

export {
  canProcessFrozenAccountInput,
  frozenAccountInputLogLevel,
} from './frozen-input';
export type { AccountHandlerResult } from './lifecycle/result';
export type { AccountTxTarget } from './orderbook/queue';
export {
  processOrderbookCancels,
  routeRemoteCrossJurisdictionBookCancels,
} from './orderbook/cancels';
export { processOrderbookSwaps } from './orderbook';
export type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './orderbook/offers';
export { applyCommittedAccountFrameFollowups } from './committed-frame-followups';

const accountHandlerLog = createStructuredLogger('account.handler');
const ACCOUNT_INPUT_PROFILE = typeof process !== 'undefined' && (
  process.env?.['XLN_ACCOUNT_INPUT_PROFILE'] === '1' ||
  process.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1'
);
const ACCOUNT_INPUT_SLOW_MS = Math.max(
  0,
  Number(typeof process !== 'undefined'
    ? process.env?.['XLN_ACCOUNT_INPUT_SLOW_MS'] || '250'
    : '250'),
);
const accountInputProfileEnabled = (): boolean =>
  ACCOUNT_INPUT_PROFILE ||
  process.env?.['XLN_ACCOUNT_INPUT_PROFILE'] === '1' ||
  process.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';
const accountInputSlowMs = (): number => {
  const configured = Number(process.env?.['XLN_ACCOUNT_INPUT_SLOW_MS'] ?? ACCOUNT_INPUT_SLOW_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : ACCOUNT_INPUT_SLOW_MS;
};

const precisePerfMs = (value: number): number => Math.round(value * 1_000) / 1_000;

const createCommittedAccountEffects = (): CommittedAccountEffects => ({
  outputs: [],
  accountTxs: [],
  swapOffersCreated: [],
  swapCancelRequests: [],
  swapOffersCancelled: [],
  candidateEffects: [],
  hashesToSign: [],
});

type AccountInputCheckpoint = (label: string) => void;

type AccountInputProfileScope = Readonly<{
  checkpoint: AccountInputCheckpoint;
  complete(outcome: string): void;
}>;

const createAccountInputProfileScope = (
  state: EntityState,
  input: AccountInput,
): AccountInputProfileScope => {
  const startedAt = getPerfMs();
  const marks: Record<string, number> = {};
  traceAccountApplyHop('account-apply-start', input, {
    entityId: state.entityId,
    entityHeight: state.height,
  });
  return {
    checkpoint: label => {
      marks[label] = precisePerfMs(getPerfMs() - startedAt);
    },
    complete: outcome => {
      traceAccountApplyHop('account-apply-done', input, {
        entityId: state.entityId,
        entityHeight: state.height,
        outcome,
      });
      logAccountInputProfile(state, input, outcome, startedAt, marks);
    },
  };
};

type PreparedEntityAccountInput = Readonly<{
  context: AccountInputPhaseContext;
  consensus: PreparedAccountConsensusRun;
}>;

type PreparedEntityAccountInputResult =
  | Readonly<{ kind: 'terminal'; result: AccountHandlerResult }>
  | Readonly<{ kind: 'ready'; prepared: PreparedEntityAccountInput }>;

const logIncomingAccountInput = (
  input: AccountInput,
  incomingAck: unknown,
  incomingProposal: unknown,
): void => {
  accountHandlerLog.debug('input.apply', {
    // 12 chars: at 1000+ concurrent accounts, the default 4-char shortId
    // collides often enough (birthday paradox over a 65536 namespace) to
    // make this log useless for tracing one specific stuck account.
    from: shortId(input.fromEntityId, 12),
    to: shortId(input.toEntityId, 12),
    height: accountInputReferenceHeight(input),
    frame: Boolean(incomingProposal),
    prevHanko: Boolean(incomingAck),
  });
};

type PreparedInboundResolution = ReturnType<typeof resolveInboundAccount> & Readonly<{
  /** Rust already consumed the H=0 genesis and returned the authenticated H=1 replica. */
  preparedByAuthority: boolean;
}>;

const resolvePreparedInboundAccount = (
  state: EntityState,
  input: AccountInput,
  accountConsensusContext: AccountConsensusContext,
  hasAck: boolean,
  hasProposal: boolean,
): PreparedInboundResolution => {
  try {
    const authorityScope = accountConsensusContext.accountAuthorityExecutionScope;
    const preparedGenesis = authorityScope?.preparedInboundGenesis?.(
      input.fromEntityId,
      input,
    ) ?? null;
    if (preparedGenesis !== null) {
      return {
        account: preparedGenesis,
        counterpartyId: normalizeEntityRef(input.fromEntityId),
        createdAccount: true,
        preparedByAuthority: true,
      };
    }
    return {
      ...resolveInboundAccount(
      state,
      input,
      hasAck,
      hasProposal,
      authorityScope?.hasPreparedAccountInput?.(input.fromEntityId, input) === true,
      ),
      preparedByAuthority: false,
    };
  } catch (error) {
    if (!(error instanceof AccountInputEvidenceError)) throw error;
    const dump = safeStringify({
      input,
      entityId: state.entityId,
      entityHeight: state.height,
      rejection: { code: error.code, message: error.message },
    });
    accountHandlerLog.debug('input.evidence_rejected', {
      code: error.code,
      from: shortId(input.fromEntityId),
      error: error.message,
      dump,
    });
    addMessage(state, `❌ Rejected account input: ${error.message}`);
    countOp(`account.input.rejected.${error.code}`);
    throw new MalformedEntityFrameInputError(
      'accountInput',
      `ACCOUNT_INPUT_EVIDENCE_REJECTED:${error.code}:${error.message}`,
    );
  }
};

const prepareAccountInputToEntity = (
  state: EntityState,
  input: AccountInput,
  env: EntityRuntimeContext,
  accountConsensusContext: AccountConsensusContext,
  options: ApplyEntityTxOptions | undefined,
  checkpointProfile: AccountInputCheckpoint,
): PreparedEntityAccountInputResult => {
  const incomingAck = accountInputAck(input);
  const incomingProposal = accountInputProposal(input);
  logIncomingAccountInput(input, incomingAck, incomingProposal);

  // Entity-frame isolation already cloned state. Every phase mutates this
  // candidate and records effects; none may publish transport or storage.
  const effects = createCommittedAccountEffects();
  const resolution = resolvePreparedInboundAccount(
    state,
    input,
    accountConsensusContext,
    Boolean(incomingAck),
    Boolean(incomingProposal),
  );
  const { account, counterpartyId, createdAccount, preparedByAuthority } = resolution;
  if (createdAccount && !preparedByAuthority && authorityRecordEnabled()) {
    // The inbound H=0 replica is complete here but has not consumed the peer's
    // H=1 input yet. Create must occupy the immediately preceding wave slot;
    // seeding the post-input replica would hide the very transition Rust owns.
    noteAuthorityAccountCreate(
      accountConsensusContext.accountAuthorityFrameId,
      state.entityId,
      counterpartyId,
      account,
      requireAccountDeltaTransformerAddress(accountConsensusContext, account.state),
    );
  }
  checkpointProfile('accountResolve');
  if (rejectFrozenAccountInput(state, account, input, counterpartyId)) {
    return { kind: 'terminal', result: buildAccountHandlerResult(state, effects) };
  }

  const context: AccountInputPhaseContext = {
    env,
    accountConsensusContext,
    state,
    input,
    account: account,
    counterpartyId,
    createdAccount,
    effects,
    ...(options ? { options } : {}),
    checkpointProfile,
  };
  checkpointProfile('preConsensus');
  return {
    kind: 'ready',
    prepared: {
      context,
      consensus: prepareAccountConsensusRun(context),
    },
  };
};

const finishPreparedAccountInput = async (
  prepared: PreparedEntityAccountInput,
  result: Awaited<ReturnType<typeof applyAccountInput>>,
): Promise<AccountHandlerResult> => {
  const { context, consensus: consensusRun } = prepared;
  completeAccountConsensusRun(context, consensusRun, result);
  const consensus = await finishAccountConsensusInput(context, result);
  if (consensus.terminalResult) return consensus.terminalResult;

  context.checkpointProfile('finalize');
  return buildAccountHandlerResult(
    context.state,
    context.effects,
    consensus.forceAccountFlush,
    consensus.accountJClaimNodeChanges,
    consensus.forcedAccountInput,
  );
};

const applyAccountInputPhases = async (
  state: EntityState,
  input: AccountInput,
  env: EntityRuntimeContext,
  accountConsensusContext: AccountConsensusContext,
  options: ApplyEntityTxOptions | undefined,
  checkpointProfile: AccountInputCheckpoint,
): Promise<AccountHandlerResult> => {
  const resolution = prepareAccountInputToEntity(
    state,
    input,
    env,
    accountConsensusContext,
    options,
    checkpointProfile,
  );
  if (resolution.kind === 'terminal') return resolution.result;
  const { context, consensus } = resolution.prepared;
  const result = await applyAccountInput(
    context.accountConsensusContext,
    context.account,
    context.input,
    consensus.securityContext,
  );
  return finishPreparedAccountInput(resolution.prepared, result);
};

const logAccountInputProfile = (
  state: EntityState,
  input: AccountInput,
  outcome: string,
  startedAt: number,
  marks: Record<string, number>,
): void => {
  const elapsedMs = precisePerfMs(getPerfMs() - startedAt);
  if (!accountInputProfileEnabled() && elapsedMs < accountInputSlowMs()) return;
  accountHandlerLog.info('input.profile', {
    entity: shortId(state.entityId, 8),
    counterparty: shortId(input.fromEntityId, 8),
    kind: input.kind,
    height: accountInputReferenceHeight(input) ?? null,
    proposalTxs: accountInputProposal(input)?.frame.accountTxs.length ?? 0,
    outcome,
    elapsedMs,
    phases: cumulativeMarksToPhases(marks, elapsedMs),
  });
};

export async function applyAccountInputToEntity(
  state: EntityState,
  input: AccountInput,
  env: EntityRuntimeContext,
  accountConsensusContext: AccountConsensusContext,
  options?: ApplyEntityTxOptions,
): Promise<AccountHandlerResult> {
  const profile = createAccountInputProfileScope(state, input);
  let outcome = 'returned';
  try {
    return await applyAccountInputPhases(
      state,
      input,
      env,
      accountConsensusContext,
      options,
      profile.checkpoint,
    );
  } catch (error) {
    outcome = 'threw';
    throw error;
  } finally {
    profile.complete(outcome);
  }
}
